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
    let mut result = if inputs.module_only {
        compile_module_sources(path, &inputs.sources)
    } else {
        compile_project_sources(path, &inputs.sources)
    };
    if let Some(document) = result.document.take() {
        let mut value = serde_json::to_value(document).expect("AIR serializes");
        portable_source_ids(&mut value, &inputs.source_root);
        result.document =
            Some(serde_json::from_value(value).expect("source identities preserve AIR shape"));
    }
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
            // Tooling-only location hint; never embedded in AIR or runtime traces.
            "source_root": inputs.source_root,
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

fn portable_source_ids(value: &mut serde_json::Value, root: &std::path::Path) {
    match value {
        serde_json::Value::Object(fields) => {
            if let Some(serde_json::Value::String(id)) = fields
                .get_mut("source_ref")
                .and_then(|reference| reference.get_mut("source_id"))
            {
                if let Ok(relative) = std::path::Path::new(id).strip_prefix(root) {
                    *id = relative.to_string_lossy().replace('\\', "/");
                }
            }
            for child in fields.values_mut() {
                portable_source_ids(child, root);
            }
        }
        serde_json::Value::Array(items) => {
            for child in items {
                portable_source_ids(child, root);
            }
        }
        _ => {}
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn portable_provenance_does_not_rewrite_business_source_id_fields() {
        let root = std::env::temp_dir().join("touba-source-identity");
        let original = root.join("source.tb").to_string_lossy().into_owned();
        let mut value = serde_json::json!({
            "source_ref": { "source_id": original },
            "business_value": { "source_id": original },
        });
        super::portable_source_ids(&mut value, &root);
        assert_eq!(value["source_ref"]["source_id"], "source.tb");
        assert_eq!(value["business_value"]["source_id"], original);
    }
}
