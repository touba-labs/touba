use touba_compiler::compile_source_to_air;

#[test]
fn typed_and_inferred_lists_compile_with_nested_empty_contexts() {
    let result = compile_source_to_air(
        "lists.tb",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/list-literals.tb"
        ),
    );
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert!(
        serde_json::to_string(&result.document.unwrap())
            .unwrap()
            .contains("construct_list")
    );
}

#[test]
fn heterogeneous_unknown_and_untyped_empty_lists_are_rejected() {
    for body in [
        "give [1, true]",
        "give [\"text\"]",
        "give [1, 2.5]",
        "give [[1]]",
        "for item in []\n            give [item]\n        give []",
    ] {
        let source = format!(
            "module invalid\nfunction Test\n    gives List of Int\n    do\n        {body}\n"
        );
        let result = compile_source_to_air("invalid.tb", &source);
        assert!(result.document.is_none(), "unexpected success: {source}");
        assert!(!result.diagnostics.is_empty());
    }
}

#[test]
fn comprehensions_concat_and_join_are_typed_and_scoped() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/list-transformations.tb"
    );
    let result = compile_source_to_air("lists.tb", source);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let json = serde_json::to_string(&result.document.unwrap()).unwrap();
    for kind in ["list_comprehension", "list_concat", "text_join"] {
        assert!(json.contains(kind));
    }
    for body in [
        "give [value for value in 1]",
        "give [value for value in [1] if value]",
        "give [value for value in [true]]",
        "give concat([1], [true])",
        "give concat(1, 2)",
        "give join([1], \",\")",
        "give join([\"x\"], 1)",
        "bind items as List of Int = [value for value in [1]]\n        give [value]",
    ] {
        let source = format!(
            "module invalid\nfunction Test\n    gives List of Int\n    do\n        {body}\n"
        );
        let result = compile_source_to_air("invalid.tb", &source);
        assert!(result.document.is_none(), "unexpected success: {source}");
        assert!(
            result
                .diagnostics
                .iter()
                .all(|diagnostic| !diagnostic.message.contains("recovered Tree-sitter")),
            "invalid test syntax: {source}"
        );
    }
}
