use touba_compiler::{
    AirDiagnosticCode, air::AirFlowNodeKind, compile_project_sources, compile_source_to_air,
};

const SOURCE: &str =
    include_str!("../../../grammar/tree-sitter-touba/examples/parallel-v1/positive/diagnostics.tb");

#[test]
fn parallel_is_a_typed_bounded_fork_join_node() {
    let result = compile_source_to_air("parallel.tb", SOURCE);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let air = result.document.unwrap();
    let node = &air.execution_graphs[0].nodes[0];
    assert_eq!(node.kind, AirFlowNodeKind::ParallelCall);
    assert_eq!(node.collection_ref.as_deref(), Some("value:incidents"));
    assert_eq!(node.item_binding.as_deref(), Some("value:incident"));
    assert_eq!(node.max_concurrency, Some(4));
    assert_eq!(node.max_items, Some(32));
    assert_eq!(node.arguments, ["value:incident"]);
}

#[test]
fn malformed_parallel_source_is_rejected() {
    for invalid in [
        SOURCE.replace("            max_items 32\n", ""),
        SOURCE.replace("            max_concurrency 4\n", ""),
        SOURCE.replace("            into diagnoses\n", ""),
        SOURCE.replace("            each incident in incidents\n", ""),
        SOURCE.replace("max_concurrency 4", "max_concurrency 0"),
        SOURCE.replace("max_concurrency 4", "max_concurrency 33"),
        SOURCE.replace("max_concurrency 4", "max_concurrency 1.5"),
        SOURCE.replace(
            "max_concurrency 4",
            "max_concurrency 4\n            max_concurrency 2",
        ),
        SOURCE.replace("with request as incident", "with request as 3"),
        SOURCE.replace("takes incidents as List of Text", "takes incidents as Text"),
        SOURCE.replace("        give diagnoses", "        give incident"),
        SOURCE.replace("strategy Run", "function Run"),
        SOURCE.replace("    callable_by strategy Run\n", ""),
    ] {
        let result = compile_source_to_air("invalid.tb", &invalid);
        assert!(
            result.document.is_none(),
            "accepted invalid source: {invalid}"
        );
    }
}

#[test]
fn parallel_imported_agents_preserve_interfaces_and_caller_authority() {
    let coordinator = "module batches\nimport agent Specialist from specialists\nstrategy Run\n    takes values as List of Text\n    gives List of Text\n    uses Specialist\n    do\n        parallel Specialist\n            each value in values\n            with request as value\n            max_concurrency 2\n            max_items 8\n            into results\n        give results\n";
    let specialist = "module specialists\nagent Specialist\n    takes request as Text\n    gives Text\n    responsibility \"Review each request.\"\n    callable_by strategy batches.Run\n";
    for allowed in [true, false] {
        let other = specialist.replace("batches.Run", "other.Run");
        let result = compile_project_sources(
            "batches.tb",
            &[
                ("batches.tb".into(), coordinator.into()),
                (
                    "specialists.tb".into(),
                    if allowed { specialist.into() } else { other },
                ),
            ],
        );
        assert_eq!(
            result.document.is_some(),
            allowed,
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn zero_argument_parallel_spelling_cannot_omit_required_tool_inputs() {
    let authorized = SOURCE
        .replace("parallel Specialist", "parallel Diagnose")
        .replace("    uses Specialist\n", "    uses Diagnose\n");
    let nominal = compile_source_to_air("with-argument.tb", &authorized);
    assert!(nominal.document.is_some(), "{:?}", nominal.diagnostics);

    let source = authorized.replace("            with request as incident\n", "");
    let refused = compile_source_to_air("missing.tb", &source);
    assert!(refused.document.is_none());
    assert!(
        refused.diagnostics.iter().any(|diagnostic| {
            diagnostic.code == AirDiagnosticCode::MissingExplicitCallArgument
                && diagnostic.message.contains("`request`")
        }),
        "{:?}",
        refused.diagnostics
    );
}
