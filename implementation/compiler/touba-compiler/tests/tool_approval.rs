use touba_compiler::{compile_project_sources, compile_source_to_air};

const SOURCE: &str = "module approval\ntool Pay\n    takes amount as Int\n    gives Int\n    human.approve\n        with role as \"finance\"\n        with timeout_ms as 3600000\n        with distinct_from as \"initiator\"\n";

#[test]
fn tool_requirement_is_preserved_in_air() {
    let result = compile_source_to_air("approval.tb", SOURCE);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let air = serde_json::to_value(result.document.unwrap()).unwrap();
    assert_eq!(
        air["definitions"]["tools"][0]["approval_policy"]["role"],
        "finance"
    );
    let simple = compile_source_to_air(
        "approval.tb",
        "module approval\ntool Pay\n    gives Int\n    human.approve\n",
    );
    assert!(simple.diagnostics.is_empty(), "{:?}", simple.diagnostics);
    assert_eq!(
        serde_json::to_value(simple.document.unwrap()).unwrap()["definitions"]["tools"][0]["approval_policy"],
        serde_json::json!({})
    );
}

#[test]
fn imports_keep_operation_policy_and_required_feature() {
    let result = compile_project_sources("main.tb", &[
        ("approval.tb".into(), SOURCE.into()),
        ("main.tb".into(), "module consumer\nimport tool Pay from approval\nstrategy Execute\n    gives Int\n    uses Pay\n    do\n        Pay\n            with amount as 7\n            into paid\n        give paid\n".into()),
    ]);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let air = result.document.unwrap();
    assert_eq!(air.required_features, ["tool_operation_approval"]);
    assert!(air.definitions.tools[0].approval_policy.is_some());
}

#[test]
fn tool_requirement_rejects_dynamic_or_continuation_fields() {
    for clause in [
        "human.review",
        "human.approve\n        with context as amount",
        "human.approve\n        into approval",
        "human.approve\n        with role as amount",
        "human.approve\n        with role as \"\"",
        "human.approve\n        with timeout_ms as 0",
        "human.approve\n    human.approve",
        "human.approve\n        on rejected\n            stop",
    ] {
        let source = format!(
            "module approval\ntool Pay\n    takes amount as Int\n    gives Int\n    {clause}\n"
        );
        let result = compile_source_to_air("approval.tb", &source);
        assert!(result.document.is_none(), "accepted: {clause}");
        assert!(!result.diagnostics.is_empty());
    }
}
