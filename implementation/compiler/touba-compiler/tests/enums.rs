use touba_compiler::{AirDiagnosticCode, compile_project_sources, compile_source_to_air};

const SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/enum-business.tb"
);

#[test]
fn text_accepts_imported_enums_but_not_wrapped_or_structured_values() {
    let result = compile_project_sources("label.tb", &[
        ("orders.tb".into(), SOURCE.into()),
        ("label.tb".into(), "module label\nimport type Priority from orders\nfunction Label\n    takes value as Priority\n    gives Text\n    do\n        give text(value)\n".into()),
    ]);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    for declared in ["List of Priority", "Optional of Priority"] {
        let source = format!("module label\nenum Priority\n    high\nfunction Label\n    takes value as {declared}\n    gives Text\n    do\n        give text(value)\n");
        let result = compile_source_to_air("label.tb", &source);
        assert!(result.document.is_none());
        assert!(result.diagnostics.iter().any(|d| d.code == AirDiagnosticCode::InvalidExpressionOperandType), "{:?}", result.diagnostics);
    }
}

#[test]
fn enum_members_keep_nominal_types_in_air() {
    let result = compile_source_to_air("orders.tb", SOURCE);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let air = result.document.unwrap();
    assert_eq!(
        air.definitions.types[0]
            .variants
            .iter()
            .map(|v| v.name.as_str())
            .collect::<Vec<_>>(),
        vec!["low", "normal", "high"]
    );
    assert!(air.definitions.types[0].fields.is_empty());
    assert_eq!(
        air.definitions.constants[0].type_ref,
        "type:orders/Priority"
    );
    assert_eq!(
        air.definitions.constants[0].literal_text.as_deref(),
        Some("normal")
    );
}

#[test]
fn enum_rejects_unknown_duplicate_and_incompatible_members() {
    for (body, code) in [
        (
            "enum Priority\n    high\n    high\n",
            AirDiagnosticCode::DuplicateEnumVariant,
        ),
        (
            "enum Priority\n    high\nfunction Test\n    gives Priority\n    do\n        give Priority.hihg\n",
            AirDiagnosticCode::UnknownEnumVariant,
        ),
        (
            "enum Priority\n    high\nfunction Test\n    gives Priority\n    do\n        give \"high\"\n",
            AirDiagnosticCode::IncompatibleExpressionType,
        ),
        (
            "enum Priority\n    high\nenum Other\n    high\nfunction Test\n    gives Boolean\n    do\n        give Priority.high == Other.high\n",
            AirDiagnosticCode::InvalidExpressionOperandType,
        ),
        (
            "enum Priority\n    high\nfunction Test\n    gives Priority\n    do\n        give record Priority { high as true }\n",
            AirDiagnosticCode::UnknownRecordType,
        ),
    ] {
        let result = compile_source_to_air("negative.tb", &format!("module negative\n{body}"));
        assert!(result.document.is_none());
        assert!(
            result.diagnostics.iter().any(|d| d.code == code),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn enum_imports_resolve_the_declared_type_and_not_an_unimported_namesake() {
    let module = "module delivery\nimport type Priority from orders\nfunction PriorityForShipping\n    gives Priority\n    do\n        give Priority.high\n";
    let result = compile_project_sources(
        "delivery.tb",
        &[
            ("orders.tb".into(), SOURCE.into()),
            ("delivery.tb".into(), module.into()),
        ],
    );
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let result = compile_project_sources(
        "delivery.tb",
        &[
            ("orders.tb".into(), SOURCE.into()),
            (
                "delivery.tb".into(),
                module.replace("import type Priority from orders\n", ""),
            ),
        ],
    );
    assert!(result.document.is_none());
}
