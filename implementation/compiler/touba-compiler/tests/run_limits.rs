use touba_compiler::{
    AirDiagnosticCode, compile_project_sources, compile_source_to_air as compile_source,
};

const SOURCE: &str =
    include_str!("../../../grammar/tree-sitter-touba/examples/budgets-bq1/source-limits.tb");

#[test]
fn source_limits_lower_with_exact_value_and_source_location() {
    let result = compile_source("source-limits.tb", SOURCE);
    assert_eq!(result.diagnostics, []);
    let air = result.document.unwrap();
    let limits = air.budgets.unwrap().run;
    assert_eq!(limits.len(), 5);
    assert_eq!(limits["max_tool_calls"].value, 2);
    let location = &limits["max_tool_calls"].source_ref;
    assert_eq!(
        &SOURCE[location.start_byte..location.end_byte],
        "max_tool_calls as 2"
    );
    assert_eq!(location.source_id, "source-limits.tb");
}

#[test]
fn invalid_limits_are_refused_without_emitting_air() {
    for invalid in [
        "0",
        "-1",
        "1.5",
        "true",
        "\"2\"",
        "1 + 1",
        "Budget",
        "9007199254740992",
        "18446744073709551616",
    ] {
        let source = SOURCE.replace("max_steps as 100", &format!("max_steps as {invalid}"));
        let result = compile_source("invalid.tb", &source);
        assert!(result.document.is_none(), "{invalid}");
        let expected = if invalid == "-1" {
            AirDiagnosticCode::AstError
        } else {
            AirDiagnosticCode::InvalidRunLimits
        };
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.code == expected && d.source_ref.is_some()),
            "{invalid}: {:?}",
            result.diagnostics
        );
    }
    for clause in ["max_tokens as 2", "max_runs_per_day as 2", "max_steps as 2"] {
        let source = SOURCE.replace(
            "max_steps as 100",
            &format!("max_steps as 100\n    {clause}"),
        );
        let result = compile_source("invalid.tb", &source);
        assert!(result.document.is_none());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.code == AirDiagnosticCode::InvalidRunLimits)
        );
    }
}

#[test]
fn run_limits_have_one_unambiguous_module_position() {
    let block = "limits run\n    max_steps as 10\n";
    for source in [
        format!("{block}{SOURCE}"),
        format!("{SOURCE}\n{block}"),
        SOURCE.replace("tool Normalize", &format!("{block}\ntool Normalize")),
        SOURCE.replace(
            "tool Normalize",
            "import type Request from other.module\ntool Normalize",
        ),
        "module empty\nlimits run\n".to_string(),
    ] {
        let result = compile_source("invalid.tb", &source);
        assert!(result.document.is_none(), "{source}");
        assert!(!result.diagnostics.is_empty());
    }
    let result = compile_source(
        "max.tb",
        &SOURCE.replace("max_steps as 100", "max_steps as 9007199254740991"),
    );
    assert_eq!(result.diagnostics, []);
}

#[test]
fn linked_limits_take_minimum_without_importing_unrelated_constraints() {
    let entry = "module job.main\nimport type Request from job.types\nlimits run\n    max_steps as 100\n    max_tool_calls as 4\nfunction Ready\n    gives Text\n    do\n        give \"ready\"\n";
    let types = "module job.types\nimport type Note from job.common\nlimits run\n    max_steps as 25\n    max_tool_calls as 4\ntype Request\n    note is Note\n";
    let common = "module job.common\nlimits run\n    max_steps as 25\n    max_provider_calls as 3\ntype Note\n    text is Text\n";
    let unrelated = "module job.unused\nlimits run\n    max_steps as 1\n";
    let result = compile_project_sources(
        "main.tb",
        &[
            ("main.tb".into(), entry.into()),
            ("types.tb".into(), types.into()),
            ("common.tb".into(), common.into()),
            ("unused.tb".into(), unrelated.into()),
        ],
    );
    assert_eq!(result.diagnostics, []);
    let limits = result.document.unwrap().budgets.unwrap().run;
    assert_eq!(limits["max_steps"].value, 25);
    assert_eq!(limits["max_steps"].source_ref.source_id, "common.tb");
    assert_eq!(limits["max_tool_calls"].source_ref.source_id, "main.tb");
    assert_eq!(limits["max_provider_calls"].value, 3);
}
