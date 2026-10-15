use std::env;
use std::process;
use touba_compiler::{compile_module_sources, compile_project_sources, serialize_air_to_json};

mod source_inputs;

fn main() {
    let inputs = match source_inputs::load(env::args().skip(1)) {
        Ok(inputs) => inputs,
        Err(message) => {
            eprintln!("error: {message}");
            process::exit(2);
        }
    };
    let path = &inputs.entry;
    let result = if inputs.module_only {
        compile_module_sources(path, &inputs.sources)
    } else {
        compile_project_sources(path, &inputs.sources)
    };
    if inputs.json {
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
        if let Some(source) = &diag.source_ref {
            eprintln!(
                "{}:{}:{}-{}:{}: {:?}: {}",
                source.source_id,
                source.start_line + 1,
                source.start_column + 1,
                source.end_line + 1,
                source.end_column + 1,
                diag.code,
                diag.message
            );
        } else {
            eprintln!("{path}: {:?}: {}", diag.code, diag.message);
        }
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
