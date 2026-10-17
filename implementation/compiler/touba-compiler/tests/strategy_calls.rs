use touba_compiler::air::AirFlowNodeKind;
use touba_compiler::{compile_project_sources, compile_source_to_air};

#[test]
fn strategy_calls_are_typed_and_linked_across_modules() {
    let sources = [
        ("workflow.tb".into(), include_str!("../../../grammar/tree-sitter-touba/examples/imports-im2/agent/typed/incident/workflow.tb").into()),
        ("coordinator.tb".into(), include_str!("../../../grammar/tree-sitter-touba/examples/imports-im2/agent/typed/incident/coordinator.tb").into()),
        ("specialist.tb".into(), include_str!("../../../grammar/tree-sitter-touba/examples/imports-im2/agent/typed/incident/specialist.tb").into()),
        ("contracts.tb".into(), include_str!("../../../grammar/tree-sitter-touba/examples/imports-im2/agent/typed/incident/contracts.tb").into()),
    ];
    let result = compile_project_sources("workflow.tb", &sources);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let document = result.document.unwrap();
    let graph = document
        .execution_graphs
        .iter()
        .find(|g| g.owner_ref == "strategy:incident.workflow/Run")
        .unwrap();
    let calls: Vec<_> = graph
        .nodes
        .iter()
        .filter(|n| n.kind == AirFlowNodeKind::CallStrategy)
        .collect();
    assert_eq!(calls.len(), 2);
    for call in calls {
        assert_eq!(
            call.target_ref.as_deref(),
            Some("strategy:incident.coordinator/Resolve")
        );
        assert_eq!(call.arguments, ["value:request"]);
    }
}

#[test]
fn strategy_call_rejects_missing_interface_arguments_types_and_impure_function_use() {
    let source = "module nested\nstrategy Child\n    takes count as Int\n    gives Int\n    do\n        give count\nstrategy Parent\n    gives Int\n    do\n        Child\n            with count as 1\n            into result\n        give result\n";
    assert!(
        compile_source_to_air("valid.tb", source)
            .diagnostics
            .is_empty()
    );
    for invalid in [
        source.replacen("    gives Int\n", "", 1),
        source.replace("            with count as 1\n", ""),
        source.replace("with count as 1", "with count as \"invalid\""),
        source.replace("strategy Parent", "function Parent"),
        source.replace("with count as 1", "with other as 1"),
    ] {
        let result = compile_source_to_air("invalid.tb", &invalid);
        assert!(result.document.is_none(), "{invalid}");
        assert!(!result.diagnostics.is_empty());
    }
}
