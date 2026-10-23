use touba_compiler::{AirDiagnosticCode, compile_source_to_air};

const SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/approval-policy.tb"
);

#[test]
fn approval_constraints_and_terminal_expiration_lower_explicitly() {
    let result = compile_source_to_air("approval.tb", SOURCE);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let value = serde_json::to_value(result.document.unwrap()).unwrap();
    let graphs = value["execution_graphs"].as_array().unwrap();
    let graph = graphs
        .iter()
        .find(|g| g["owner_ref"] == "strategy:approval_policy/Escalate")
        .unwrap();
    assert!(
        graph["edges"]
            .as_array()
            .unwrap()
            .iter()
            .any(|edge| edge["role"] == "expired")
    );
    let node = graph["nodes"]
        .as_array()
        .unwrap()
        .iter()
        .find(|n| n["approval_policy"]["role"] == "finance")
        .unwrap();
    assert_eq!(node["approval_policy"]["timeout_ms"], 20);
}

#[test]
fn source_policies_cannot_be_computed_or_silently_weakened() {
    for replacement in [
        "with role as dossier",
        "with role as \"\"",
        "with timeout_ms as 0",
        "with timeout_ms as 2592000001",
        "with distinct_from as \"nobody\"",
    ] {
        let source = format!(
            "module test\nstrategy Review\n    takes dossier as Text\n    gives Text\n    do\n        human.approve\n            with context as dossier\n            {replacement}\n            into approval\n        give dossier\n"
        );
        let result = compile_source_to_air("approval.tb", &source);
        assert!(result.document.is_none(), "{replacement}");
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.code == AirDiagnosticCode::InvalidHumanApprovalPolicy),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn expiration_cannot_fall_through_to_the_protected_continuation() {
    let source = SOURCE.replace(
        "give \"escalation approved\"",
        "bind pending as Text = \"pending\"",
    );
    let result = compile_source_to_air("approval.tb", &source);
    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == AirDiagnosticCode::HumanApprovalExpirationMustTerminate),
        "{:?}",
        result.diagnostics
    );
}
