use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

use serde::Deserialize;

use crate::air::{AirDiagnostic, AirDiagnosticCode, AirDocument};

/// The host supplies the verified package interface independently of its sources.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct PackageInterface {
    pub name: String,
    pub source_root: PathBuf,
    pub exports: HashSet<String>,
}

pub(crate) fn validate_package_imports(
    modules: &[AirDocument],
    packages: &[PackageInterface],
) -> Vec<AirDiagnostic> {
    if packages.is_empty() {
        return Vec::new();
    }

    let owners: HashMap<_, _> = modules
        .iter()
        .filter_map(|module| {
            let source = Path::new(&module.module.source_ref.source_id);
            let owner = packages
                .iter()
                .filter(|package| source.starts_with(&package.source_root))
                .max_by_key(|package| package.source_root.components().count())?;
            Some((module.module.name.as_str(), owner))
        })
        .collect();

    let mut diagnostics = Vec::new();
    for module in modules {
        let importer = owners.get(module.module.name.as_str());
        for import in &module.imports {
            if let Some(provider) = owners.get(import.from_module.as_str())
                && importer.is_none_or(|owner| owner.source_root != provider.source_root)
                && !provider.exports.contains(&import.target_ref)
            {
                diagnostics.push(AirDiagnostic::new(
                    AirDiagnosticCode::PackageExportMissing,
                    format!(
                        "import `{}` references `{}`, but package `{}` does not export it",
                        import.name, import.target_ref, provider.name
                    ),
                    Some(import.source_ref.clone()),
                ));
            }
        }
    }
    diagnostics
}
