use touba_compiler::{air::AirFlowEdgeRole, compile_source_to_air};

#[test]
fn syntax_recovery_points_to_the_local_error_in_a_long_declaration() {
    let source = format!("module syntax.local\nstrategy Run\n    uses One, Two\n    do\n{}\n",
        "        show\n            with message as \"Inspect the case\"\n".repeat(20));
    let result = touba_compiler::parse_source("local.tb", &source);
    assert!(result.document.is_none());
    let diagnostic = &result.diagnostics[0];
    let span = diagnostic.source_ref.as_ref().unwrap();
    assert_eq!(span.start_line, 2, "{:?}", diagnostic);
    assert!(span.end_line <= 3, "{:?}", diagnostic);
    assert!(diagnostic.message.contains("one capability per line"), "{:?}", diagnostic);
}

#[test]
fn omitted_else_reaches_the_following_statement() {
    let source = "module flow.check\n\nfunction Pick\n    takes x as Int\n    gives Int\n    do\n        if x == 1\n            give 10\n        give 20\n";
    let compiled = compile_source_to_air("fallthrough.tb", source);
    assert!(compiled.diagnostics.is_empty(), "{:?}", compiled.diagnostics);
    let document = compiled.document.unwrap();
    let graph = &document.execution_graphs[0];
    assert_eq!(graph.edges.len(), 2);
    let false_edge = graph.edges.iter().find(|edge| edge.role == AirFlowEdgeRole::False).unwrap();
    assert_eq!(false_edge.from_node_id, graph.nodes[0].id);
    assert_eq!(false_edge.to_node_id, graph.nodes[2].id);
    assert!(!graph.edges.iter().any(|edge| edge.from_node_id == graph.nodes[1].id));
}
