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
    assert_eq!(limits["max_steps"].value, 100);
    assert_eq!(limits["max_steps"].source_ref.source_id, "main.tb");
    assert_eq!(limits["max_tool_calls"].source_ref.source_id, "main.tb");
    assert!(!limits.contains_key("max_provider_calls"));
}

#[test]
fn executable_imports_keep_their_limits_but_type_only_dependencies_do_not() {
    let entry = "module job.main\nimport skill Read from job.worker\nlimits run\n    max_steps as 100\nstrategy Run\n    gives Text\n    uses Read\n    do\n        Read\n            into answer\n        give answer\n";
    let worker = "module job.worker\nimport type Request from job.types\nlimits run\n    max_steps as 25\nskill Read\n    gives Text\n    do\n        give \"ready\"\n";
    let types = "module job.types\nimport tool Dangerous from job.unrelated\nlimits run\n    max_steps as 1\ntype Request\n    text is Text\n";
    let unrelated = "module job.unrelated\nlimits run\n    max_provider_calls as 1\ntool Dangerous\n    gives Text\n";
    let sources = vec![
        ("main.tb".into(), entry.into()),
        ("worker.tb".into(), worker.into()),
        ("types.tb".into(), types.into()),
        ("unrelated.tb".into(), unrelated.into()),
    ];
    let result = compile_project_sources("main.tb", &sources);
    assert_eq!(result.diagnostics, []);
    let document = result.document.unwrap();
    assert!(document.definitions.tools.is_empty());
    let limits = document.budgets.unwrap().run;
    assert_eq!(limits["max_steps"].value, 25);
    assert_eq!(limits["max_steps"].source_ref.source_id, "worker.tb");
    assert!(!limits.contains_key("max_provider_calls"));
}

#[test]
fn selected_record_constructors_retain_their_imported_field_constants() {
    let entry = "module job.main\nimport function Draft from job.records\nfunction Run\n    gives Text\n    do\n        give \"ready\"\n";
    let records = "module job.records\nimport define Label from job.labels\ntype Item\n    label is Text\nfunction Draft\n    gives Item\n    do\n        give record Item { label as Label }\n";
    let labels =
        "module job.labels\nlimits run\n    max_steps as 1\ndefine Label as Text = \"label\"\n";
    let result = compile_project_sources(
        "main.tb",
        &[
            ("main.tb".into(), entry.into()),
            ("records.tb".into(), records.into()),
            ("labels.tb".into(), labels.into()),
        ],
    );
    assert_eq!(result.diagnostics, []);
    let document = result.document.unwrap();
    assert!(
        document
            .definitions
            .constants
            .iter()
            .any(|constant| constant.id == "constant:job.labels/Label")
    );
    assert!(document.budgets.is_none());
}

#[test]
fn zero_call_budgets_are_preserved_but_time_and_steps_stay_positive() {
    for kind in [
        "max_tool_calls",
        "max_agent_invocations",
        "max_provider_calls",
    ] {
        let source = format!(
            "module zero\nlimits run\n    {kind} as 0\nfunction Ready\n    gives Int\n    do\n        give 1\n"
        );
        let result = compile_source("zero.tb", &source);
        assert_eq!(result.diagnostics, []);
        assert_eq!(result.document.unwrap().budgets.unwrap().run[kind].value, 0);
    }
    for kind in ["max_steps", "max_run_ms"] {
        let source = format!("module zero\nlimits run\n    {kind} as 0\n");
        let result = compile_source("zero.tb", &source);
        assert!(result.document.is_none());
        assert!(
            result
                .diagnostics
                .iter()
                .any(|d| d.code == AirDiagnosticCode::InvalidRunLimits)
        );
    }
}
