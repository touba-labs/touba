use std::env;
use std::fs;
use std::process;
use touba_compiler::{compile_source_to_air, serialize_air_to_json};

fn main() {
    let args: Vec<String> = env::args().collect();
    let json_mode = args.iter().any(|a| a == "--json");
    let files: Vec<&String> = args[1..].iter().filter(|a| !a.starts_with("--")).collect();

    if files.len() != 1 {
        eprintln!("usage: touba-compile [--json] <source.tb>");
        process::exit(2);
    }
    let path = files[0];
    let source = match fs::read_to_string(path) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: cannot read {path}: {e}");
            process::exit(2);
        }
    };

    let result = compile_source_to_air(path.as_str(), &source);

    if json_mode {
        let diag_json =
            serde_json::to_value(&result.diagnostics).unwrap_or(serde_json::Value::Null);
        let air_json = result
            .document
            .as_ref()
            .and_then(|doc| serde_json::to_value(doc).ok())
            .unwrap_or(serde_json::Value::Null);
        let envelope = serde_json::json!({
            "ok": result.document.is_some(),
            "diagnostics": diag_json,
            "air": air_json,
        });
        println!("{}", serde_json::to_string_pretty(&envelope).unwrap());
        process::exit(if result.document.is_some() { 0 } else { 1 });
    }

    for diag in &result.diagnostics {
        eprintln!("{path}: {:?}: {}", diag.code, diag.message);
    }

    match result.document {
        Some(doc) => match serialize_air_to_json(&doc) {
            Ok(json) => {
                println!("{json}");
            }
            Err(e) => {
                eprintln!("error: AIR serialization failed: {e}");
                process::exit(1);
            }
        },
        None => {
            if result.diagnostics.is_empty() {
                eprintln!("error: compilation produced no document");
            }
            process::exit(1);
        }
    }
}
