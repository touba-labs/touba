use std::path::Path;
use std::process::Command;

#[test]
fn text_diagnostics_locate_the_same_source_span_as_json_diagnostics() {
    let source = Path::new(env!("CARGO_MANIFEST_DIR")).join(
        "../../grammar/tree-sitter-touba/examples/user-interaction-v1/negative/semantic/tb-user-v1-n02-show-in-function.tb",
    );
    let json = Command::new(env!("CARGO_BIN_EXE_touba-compile"))
        .arg("--json")
        .arg(&source)
        .output()
        .expect("compiler starts");
    assert_eq!(json.status.code(), Some(1));
    let envelope: serde_json::Value = serde_json::from_slice(&json.stdout).unwrap();
    assert_eq!(envelope["ok"], false);
    let text = Command::new(env!("CARGO_BIN_EXE_touba-compile"))
        .arg(&source)
        .output()
        .expect("compiler starts");
    assert_eq!(text.status.code(), Some(1));
    assert!(text.stdout.is_empty());
    let stderr = String::from_utf8(text.stderr).unwrap();
    let diagnostics = envelope["diagnostics"].as_array().unwrap();
    assert!(!diagnostics.is_empty());
    for diagnostic in diagnostics {
        let span = &diagnostic["source_ref"];
        let location = format!(
            "{}:{}:{}-{}:{}:",
            span["source_id"].as_str().unwrap(),
            span["start_line"].as_u64().unwrap() + 1,
            span["start_column"].as_u64().unwrap() + 1,
            span["end_line"].as_u64().unwrap() + 1,
            span["end_column"].as_u64().unwrap() + 1,
        );
        assert!(stderr.contains(&location), "missing {location}: {stderr}");
        assert!(stderr.contains(diagnostic["code"].as_str().unwrap()));
    }
}
