use std::path::Path;
use std::process::Command;

#[test]
fn unsupported_clauses_have_actionable_diagnostics() {
    let root =
        std::env::temp_dir().join(format!("touba-clause-diagnostics-{}", std::process::id()));
    std::fs::create_dir_all(&root).unwrap();
    for (source, expected) in [
        (
            "function Bad\n    gives Text\n\n    uses Bad\n    do\n        give \"bad\"\n",
            "`function` is pure",
        ),
        (
            "strategy Bad\n    do\n        give \"bad\"\n    on failure\n        stop\n",
            "`on failure` belongs to a `skill`",
        ),
        (
            "skill Bad\n    callable_by Bad\n    do\n        give \"bad\"\n",
            "`callable_by` declares agent invocation authority",
        ),
    ] {
        let file = root.join("invalid.tb");
        std::fs::write(&file, format!("module diagnostics\n{source}")).unwrap();
        let output = Command::new(env!("CARGO_BIN_EXE_touba-compile"))
            .arg("--json")
            .arg(file)
            .output()
            .unwrap();
        assert_eq!(output.status.code(), Some(1));
        let result: serde_json::Value = serde_json::from_slice(&output.stdout).unwrap();
        assert!(
            result["diagnostics"]
                .as_array()
                .unwrap()
                .iter()
                .any(|d| d["message"].as_str().unwrap_or("").contains(expected)
                    && d["source_ref"].is_object()),
            "{result}"
        );
    }
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn air_source_identities_are_portable_across_project_locations() {
    let root = std::env::temp_dir().join(format!(
        "touba-source-paths-{}-{}",
        std::process::id(),
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos()
    ));
    let mut outputs = Vec::new();
    for folder in ["first", "relocated"] {
        let project = root.join(folder);
        let sources = project.join("src/examples");
        std::fs::create_dir_all(&sources).unwrap();
        std::fs::write(
            sources.join("common.tb"),
            "module examples.common\nfunction Value\n    gives Text\n    do\n        give \"ok\"\n",
        )
        .unwrap();
        std::fs::write(sources.join("app.tb"), "module examples.app\nimport function Value from examples.common\nstrategy Run\n    uses Value\n    do\n        Value\n            into result\n        give result\n").unwrap();
        let result = Command::new(env!("CARGO_BIN_EXE_touba-compile"))
            .arg(sources.join("app.tb"))
            .output()
            .unwrap();
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        let output = String::from_utf8(result.stdout).unwrap();
        assert!(!output.contains(&root.to_string_lossy().to_string()));
        assert!(output.contains("src/examples/app.tb"));
        assert!(output.contains("src/examples/common.tb"));
        outputs.push(output);
    }
    assert_eq!(
        outputs[0], outputs[1],
        "moving a project must not change its AIR identity"
    );
    std::fs::remove_dir_all(root).unwrap();
}

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
