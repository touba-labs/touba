use touba_compiler::{air::AirDiagnosticCode, compile_source_to_air};

#[test]
fn structured_controls_and_typed_list_items_compile() {
    let source = include_str!(
        "../../../grammar/tree-sitter-touba/examples/control-flow-v1/positive/nested-controls.tb"
    );
    let result = compile_source_to_air("nested.tb", source);
    assert!(result.document.is_some(), "{:?}", result.diagnostics);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

#[test]
fn lexical_scopes_reject_leaks_shadowing_and_wrong_item_types() {
    for body in [
        "if ready\n            bind label as Int = 1\n        give label",
        "for item in items\n            bind label as Int = item\n        give item",
        "for item in items\n            for item in items\n                give item\n        give 0",
        "for items in items\n            give 1\n        give 0",
        "if ready\n            bind ready as Int = 1\n        give 0",
        "for item in items\n            bind label as Text = item\n        give 0",
    ] {
        let source = format!(
            "module scope.check\nfunction Run\n    takes ready as Boolean\n    takes items as List of Int\n    gives Int\n    do\n        {body}\n"
        );
        let result = compile_source_to_air("scope.tb", &source);
        assert!(result.document.is_none(), "accepted invalid scope: {body}");
        assert!(
            !result
                .diagnostics
                .iter()
                .any(|d| d.code == AirDiagnosticCode::AstError),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn malformed_else_chains_and_indentation_never_produce_air() {
    for body in [
        "if true\n            give 1\n        else if\n            give 2",
        "else if true\n            give 1",
        "if true\n            give 1\n        else\n            give 2\n        else if false\n            give 3",
        "if true\n          if false\n                give 1",
    ] {
        let source =
            format!("module scope.check\nfunction Run\n    gives Int\n    do\n        {body}\n");
        assert!(
            compile_source_to_air("broken.tb", &source)
                .document
                .is_none(),
            "{body}"
        );
    }
}
