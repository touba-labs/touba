use std::collections::HashSet;
use std::env;
use std::fs;
use std::io::{self, Read};
use std::path::{Path, PathBuf};
use touba_compiler::parse_source;

pub struct Inputs {
    pub json: bool,
    pub module_only: bool,
    pub entry: String,
    pub sources: Vec<(String, String)>,
    pub source_root: PathBuf,
}

// Resolve source modules, never runtime handlers, configuration or secrets.
// Explicit roots support packages; an ordinary src/<module>.tb needs no flags.
pub fn load(args: impl Iterator<Item = String>) -> Result<Inputs, String> {
    let mut args = args.peekable();
    let mut json = false;
    let mut module_only = false;
    let mut stdin = false;
    let mut entry = None;
    let mut paths = Vec::new();
    let mut roots = Vec::new();
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--json" => json = true,
            "--module" => module_only = true,
            "--stdin" => stdin = true,
            "--module-source" => paths.push(PathBuf::from(
                args.next().ok_or("--module-source requires a path")?,
            )),
            "--source-root" => roots.push(absolute(&PathBuf::from(
                args.next().ok_or("--source-root requires a path")?,
            ))?),
            flag if flag.starts_with('-') => return Err(format!("unknown compiler option {flag}")),
            _ if entry.is_none() => entry = Some(absolute(Path::new(&arg))?),
            _ => {
                return Err(
                    "only one entry source is allowed; use --module-source for dependencies".into(),
                );
            }
        }
    }
    let entry = entry.ok_or("usage: touba-compile [--json] [--stdin] [--source-root <directory>] [--module-source <file.tb>] <source.tb>")?;
    if let Some(root) = entry
        .ancestors()
        .find(|p| p.file_name().is_some_and(|name| name == "src"))
    {
        roots.push(root.to_path_buf());
    } else if let Some(parent) = entry.parent() {
        roots.push(parent.to_path_buf());
    }
    let text = if stdin {
        let mut text = String::new();
        io::stdin()
            .read_to_string(&mut text)
            .map_err(|e| e.to_string())?;
        text
    } else {
        read(&entry)?
    };
    let mut source_root = entry
        .ancestors()
        .find(|p| p.file_name().is_some_and(|name| name == "src"))
        .and_then(Path::parent)
        .or_else(|| entry.parent())
        .ok_or("source has no parent directory")?
        .to_path_buf();
    let entry = entry.to_string_lossy().into_owned();
    let mut sources = vec![(entry.clone(), text)];
    let mut seen_paths = HashSet::from([entry.clone()]);
    for path in paths {
        let path = absolute(&path)?;
        let id = path.to_string_lossy().into_owned();
        if seen_paths.insert(id.clone()) {
            sources.push((id, read(&path)?));
        }
    }
    let mut modules = HashSet::new();
    for (id, text) in &sources {
        if let Some(document) = parse_source(id.clone(), text).document {
            modules.insert(document.module.name);
        }
    }
    let mut index = 0;
    while index < sources.len() {
        let (id, text) = &sources[index];
        let imports = parse_source(id.clone(), text)
            .document
            .map(|d| d.imports)
            .unwrap_or_default();
        for import in imports {
            if modules.contains(&import.from_module) {
                continue;
            }
            let relative = PathBuf::from(import.from_module.replace('.', "/")).with_extension("tb");
            let candidates: Vec<_> = roots
                .iter()
                .map(|r| r.join(&relative))
                .filter(|p| p.is_file())
                .collect();
            for path in candidates {
                let path = fs::canonicalize(&path).map_err(|e| e.to_string())?;
                let id = path.to_string_lossy().into_owned();
                if seen_paths.insert(id.clone()) {
                    let text = read(&path)?;
                    if let Some(document) = parse_source(id.clone(), &text).document {
                        modules.insert(document.module.name);
                    }
                    sources.push((id, text));
                }
            }
        }
        index += 1;
    }
    // One common source root keeps imports unambiguous and paths portable.
    // Only explicitly loaded source modules participate, never host configs.
    for (id, _) in &sources {
        while !Path::new(id).starts_with(&source_root) {
            if !source_root.pop() {
                return Err("source files must share a filesystem root".into());
            }
        }
    }
    Ok(Inputs {
        json,
        module_only,
        entry,
        sources,
        source_root,
    })
}

fn absolute(path: &Path) -> Result<PathBuf, String> {
    let path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        env::current_dir().map_err(|e| e.to_string())?.join(path)
    };
    Ok(fs::canonicalize(&path).unwrap_or(path))
}

fn read(path: &Path) -> Result<String, String> {
    fs::read_to_string(path).map_err(|e| format!("cannot read {}: {e}", path.display()))
}
