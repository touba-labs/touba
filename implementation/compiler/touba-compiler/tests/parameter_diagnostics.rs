use touba_compiler::compile_source_to_air;

#[test]
fn text_parameter_has_an_actionable_parse_error() {
    let source = "module example.echo\nstrategy Echo\n    takes text as Text\n    gives Text\n    do\n        give text\n";
    let result = compile_source_to_air("reserved-parameter.tb", source);
    assert!(result.document.is_none());
    assert!(result.diagnostics.iter().any(|d| d.message.contains("built-in") && d.message.contains("takes value as Text")), "{:?}", result.diagnostics);
    let valid = source.replace("takes text as", "takes value as").replace("give text", "give value");
    assert!(compile_source_to_air("valid-parameter.tb", &valid).document.is_some());
    // The declaration itself is legal. The ambiguity is its bare expression,
    // not a new global ban on this identifier.
    let unused = source.replace("give text", "give \"constant\"");
    assert!(compile_source_to_air("unused-parameter.tb", &unused).document.is_some());
}
