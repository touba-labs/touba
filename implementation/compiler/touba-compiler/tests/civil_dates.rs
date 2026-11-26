use touba_compiler::compile_source_to_air;

#[test]
fn module_date_constants_require_valid_literals() {
    let source = "module dates\ndefine Closing as Date = date(\"2024-02-29\")\nfunction Read\n    gives Date\n    do\n        give Closing\n";
    let result = compile_source_to_air("dates.tb", source);
    assert!(result.document.is_some(), "{:?}", result.diagnostics);
    for expression in [
        "date(\"2023-02-29\")",
        "date(Other)",
        "\"2024-02-29\"",
        "date(3)",
    ] {
        let invalid = source.replace("date(\"2024-02-29\")", expression);
        assert!(
            compile_source_to_air("dates.tb", &invalid)
                .document
                .is_none(),
            "accepted {expression}"
        );
    }
}

#[test]
fn dates_are_typed_and_compared() {
    let result = compile_source_to_air(
        "calendar.tb",
        include_str!(
            "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/civil-dates.tb"
        ),
    );
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    assert!(result.document.is_some());
}
#[test]
fn invalid_literal_dates_and_implicit_conversions_fail() {
    for value in [
        "0000-01-01",
        "2023-02-29",
        "1900-02-29",
        "2026-04-31",
        "2026-13-01",
        "2026-01-00",
        "2026-1-1",
        "💥💥-💥",
    ] {
        let source = format!(
            "module invalid\nfunction Test\n    gives Date\n    do\n        give date(\"{value}\")\n"
        );
        assert!(
            compile_source_to_air("invalid.tb", &source)
                .document
                .is_none(),
            "accepted {value}"
        );
    }
    for (output, expression) in [
        ("Date", "\"2026-01-01\""),
        ("Text", "date(\"2026-01-01\")"),
        ("Boolean", "date(\"2026-01-01\") < \"2026-01-01\""),
        ("Date", "date(3)"),
    ] {
        let source = format!(
            "module invalid\nfunction Test\n    gives {output}\n    do\n        give {expression}\n"
        );
        assert!(
            compile_source_to_air("invalid.tb", &source)
                .document
                .is_none(),
            "accepted {expression}"
        );
    }
}
