use touba_compiler::{AirDiagnosticCode, compile_project_sources, compile_source_to_air};

const SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/match-templates.tb"
);

#[test]
fn exhaustive_matches_templates_and_integer_division_lower_to_air() {
    let result = compile_source_to_air("selection.tb", SOURCE);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let json = serde_json::to_string(&result.document.unwrap()).unwrap();
    assert!(json.contains("integer_divide"));
    assert!(json.contains("text_concat"));
    assert!(json.contains("match:temporary:"));
}

#[test]
fn enum_cases_are_nominal_unique_and_exhaustive() {
    let prefix = "module test\nenum Status\n    ready\n    waiting\nenum Other\n    ready\nfunction Label\n    takes status as Status\n    gives Text\n    do\n        match status\n";
    for (cases, code) in [
        (
            "            case Status.ready\n                give \"ok\"\n",
            AirDiagnosticCode::NonExhaustiveMatch,
        ),
        (
            "            case Status.ready\n                give \"ok\"\n            case Status.ready\n                give \"duplicate\"\n",
            AirDiagnosticCode::DuplicateMatchCase,
        ),
        (
            "            case Other.ready\n                give \"wrong\"\n",
            AirDiagnosticCode::MatchCaseTypeMismatch,
        ),
        (
            "            case Status.unknown\n                give \"wrong\"\n",
            AirDiagnosticCode::UnknownEnumVariant,
        ),
    ] {
        let result = compile_source_to_air("test.tb", &format!("{prefix}{cases}"));
        assert!(result.document.is_none());
        assert!(
            result.diagnostics.iter().any(|d| d.code == code),
            "{:?}",
            result.diagnostics
        );
    }
    let result = compile_source_to_air(
        "test.tb",
        &format!("{prefix}            case Status.ready\n                give \"ok\"\n")
            .replace("takes status as Status", "takes status as Text"),
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == AirDiagnosticCode::MatchRequiresEnum)
    );
}

#[test]
fn imported_enum_matches_use_the_exported_variants() {
    let source = "module consumer\nimport type Status from selection\nfunction Label\n    takes status as Status\n    gives Text\n    do\n        match status\n            case Status.ready\n                give \"ready\"\n            case Status.waiting\n                give \"waiting\"\n            case Status.refused\n                give \"refused\"\n";
    let result = compile_project_sources(
        "consumer.tb",
        &[
            ("selection.tb".into(), SOURCE.into()),
            ("consumer.tb".into(), source.into()),
        ],
    );
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
}

#[test]
fn templates_require_text_and_quotients_require_integers() {
    for (expression, output, code) in [
        (
            "f\"{1}\"",
            "Text",
            AirDiagnosticCode::InvalidExpressionOperandType,
        ),
        (
            "5.0 // 2",
            "Int",
            AirDiagnosticCode::InvalidExpressionOperandType,
        ),
        (
            "5 // 2.0",
            "Int",
            AirDiagnosticCode::InvalidExpressionOperandType,
        ),
        (
            "5 // 0",
            "Int",
            AirDiagnosticCode::StaticExpressionDivisionByZero,
        ),
    ] {
        let result = compile_source_to_air(
            "invalid.tb",
            &format!(
                "module invalid\nfunction Test\n    gives {output}\n    do\n        give {expression}\n"
            ),
        );
        assert!(result.document.is_none());
        assert!(
            result.diagnostics.iter().any(|d| d.code == code),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn all_terminal_cases_make_following_statements_unreachable() {
    let source = "module test\nenum Status\n    ready\nfunction Label\n    takes status as Status\n    gives Text\n    do\n        match status\n            case Status.ready\n                give \"ok\"\n        give \"unreachable\"\n";
    let result = compile_source_to_air("test.tb", source);
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == AirDiagnosticCode::UnreachableStatement)
    );
}

#[test]
fn templates_validate_escapes_and_keep_original_diagnostic_positions() {
    for expression in [r#"f"{1}""#, r#"f"broken {""#, r#"f"broken }""#, r#"f"\q""#] {
        let result = compile_source_to_air(
            "message.tb",
            &format!(
                "module message\nfunction Message\n    gives Text\n    do\n        give {expression}\n"
            ),
        );
        assert!(result.document.is_none(), "{expression}");
        assert!(!result.diagnostics.is_empty());
        if expression == r#"f"{1}""# {
            let diagnostic = result
                .diagnostics
                .iter()
                .find(|d| d.code == AirDiagnosticCode::InvalidExpressionOperandType)
                .unwrap();
            assert_eq!(diagnostic.source_ref.as_ref().unwrap().start_line, 4);
            assert!(diagnostic.message.contains("interpolation"));
            assert!(diagnostic.message.contains("text(value)"));
            assert!(!diagnostic.message.contains("++"));
        }
    }
    for expression in [
        r#"f"Échéance 📦 {text(5 // 2)}""#,
        r#"f"{f"nested"}""#,
        r#"f"{text(1)}{text(2)}""#,
    ] {
        let result = compile_source_to_air(
            "message.tb",
            &format!(
                "module message\nfunction Message\n    gives Text\n    do\n        give {expression}\n"
            ),
        );
        assert!(
            result.diagnostics.is_empty(),
            "{expression}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn match_does_not_hide_effects_or_leak_case_local_values() {
    let effect = "module test\nenum Status\n    ready\ntool Write\n    gives Text\nfunction Test\n    takes status as Status\n    gives Text\n    uses Write\n    do\n        match status\n            case Status.ready\n                Write\n                    into output\n                give output\n";
    assert!(compile_source_to_air("test.tb", effect).document.is_none());
    let scope = "module test\nenum Status\n    ready\nfunction Test\n    takes status as Status\n    gives Text\n    do\n        match status\n            case Status.ready\n                bind label as Text = \"local\"\n        give label\n";
    assert!(compile_source_to_air("test.tb", scope).document.is_none());
}
