use touba_compiler::{AirDiagnosticCode, compile_project_sources};

const COMMON: &str = "module examples.common\n\ntype Request\n    query is Text\n\nfunction Decorate\n    takes suffix as Text\n    takes value as Text\n    gives Text\n    do\n        give value ++ suffix\n";
const SEARCH: &str = "module examples.search\nimport type Request from examples.common\nimport function Decorate from examples.common\n\nfunction Label\n    takes request as Request\n    gives Text\n    do\n        Decorate\n            with value as request.query\n            with suffix as \"!\"\n            into label\n        give label ++ \" done\"\n";

const SPECIALIST: &str = "module incident.specialist\nimport type Request from examples.common\nagent Diagnose\n    takes attempt as Int\n    takes request as Request\n    gives Text\n    responsibility \"Diagnose the supplied incident using the authorized context.\"\n    callable_by strategy incident.coordinator.Resolve\n";
const COORDINATOR: &str = "module incident.coordinator\nimport type Request from examples.common\nimport agent Diagnose from incident.specialist\nstrategy Resolve\n    takes request as Request\n    gives Text\n    uses Diagnose\n    do\n        Diagnose\n            with request as request\n            with attempt as 1\n            into diagnosis\n        give diagnosis\n";

#[test]
fn imported_typed_agent_keeps_signature_identity_and_named_argument_order() {
    let result = compile_project_sources(
        "coordinator.tb",
        &[
            ("coordinator.tb".into(), COORDINATOR.into()),
            ("specialist.tb".into(), SPECIALIST.into()),
            ("common.tb".into(), COMMON.into()),
        ],
    );
    assert_eq!(result.diagnostics, []);
    let air = result.document.unwrap();
    let agent = air
        .definitions
        .agents
        .iter()
        .find(|a| a.id == "agent:incident.specialist/Diagnose")
        .unwrap();
    assert!(agent.signature.is_some());
    let graph = air
        .execution_graphs
        .iter()
        .find(|g| g.owner_ref == "strategy:incident.coordinator/Resolve")
        .unwrap();
    let call = graph
        .nodes
        .iter()
        .find(|n| n.target_ref.as_deref() == Some("agent:incident.specialist/Diagnose"))
        .unwrap();
    assert_eq!(call.arguments[0], "literal:int:1");
    assert_eq!(call.arguments.len(), 2);
    assert!(call.result_binding.is_some());
}

#[test]
fn imported_typed_agent_refuses_wrong_types_missing_inputs_and_unauthorized_callers() {
    for (entry, specialist, expected) in [
        (
            COORDINATOR.replace("with attempt as 1", "with attempt as true"),
            SPECIALIST.to_string(),
            AirDiagnosticCode::IncompatibleExpressionType,
        ),
        (
            COORDINATOR.replace("            with attempt as 1\n", ""),
            SPECIALIST.to_string(),
            AirDiagnosticCode::MissingExplicitCallArgument,
        ),
        (
            COORDINATOR.to_string(),
            SPECIALIST.replace("incident.coordinator.Resolve", "incident.other.Resolve"),
            AirDiagnosticCode::AgentCallerNotAllowed,
        ),
        (
            COORDINATOR.to_string(),
            SPECIALIST.replace(
                "    takes attempt as Int\n    takes request as Request\n    gives Text\n",
                "",
            ),
            AirDiagnosticCode::EnrichedAgentCallBlocked,
        ),
    ] {
        let result = compile_project_sources(
            "coordinator.tb",
            &[
                ("coordinator.tb".into(), entry),
                ("specialist.tb".into(), specialist),
                ("common.tb".into(), COMMON.into()),
            ],
        );
        assert!(result.document.is_none());
        assert!(
            result.diagnostics.iter().any(|d| d.code == expected),
            "{expected:?}: {:?}",
            result.diagnostics
        );
    }
}

#[test]
fn imports_fields_and_return_types_before_lowering_and_orders_named_arguments() {
    let result = compile_project_sources(
        "search.tb",
        &[
            ("search.tb".into(), SEARCH.into()),
            ("common.tb".into(), COMMON.into()),
        ],
    );
    assert_eq!(result.diagnostics, []);
    let air = result.document.unwrap();
    let graph = air
        .execution_graphs
        .iter()
        .find(|g| g.owner_ref == "function:examples.search/Label")
        .unwrap();
    let call = graph
        .nodes
        .iter()
        .find(|n| n.target_ref.as_deref() == Some("function:examples.common/Decorate"))
        .unwrap();
    assert_eq!(call.arguments[0], "literal:string:!");
    assert!(
        air.definitions
            .types
            .iter()
            .any(|t| t.id == "type:examples.common/Request")
    );
}

#[test]
fn missing_import_has_one_primary_diagnostic_without_operator_cascades() {
    let result = compile_project_sources(
        "search.tb",
        &[(
            "search.tb".into(),
            SEARCH.replace("import function Decorate from examples.common\n", ""),
        )],
    );
    assert!(result.document.is_none());
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(
        result.diagnostics[0].code,
        AirDiagnosticCode::ImportModuleNotFound
    );
    assert_eq!(
        result.diagnostics[0]
            .source_ref
            .as_ref()
            .unwrap()
            .start_line,
        1
    );
}

#[test]
fn imported_signature_rejects_wrong_argument_types_and_unknown_fields() {
    for (source, expected) in [
        (
            SEARCH.replace("request.query", "request.missing"),
            AirDiagnosticCode::UnknownExpressionField,
        ),
        (
            SEARCH.replace("with suffix as \"!\"", "with suffix as 7"),
            AirDiagnosticCode::IncompatibleExpressionType,
        ),
    ] {
        let result = compile_project_sources(
            "search.tb",
            &[
                ("search.tb".into(), source),
                ("common.tb".into(), COMMON.into()),
            ],
        );
        assert!(result.document.is_none());
        assert!(
            result.diagnostics.iter().any(|d| d.code == expected),
            "{:?}",
            result.diagnostics
        );
    }
}

#[test]
fn unknown_field_does_not_cascade_but_independent_operand_error_remains() {
    let source = "module examples.search\nimport type Request from examples.common\nfunction Label\n    takes request as Request\n    gives Text\n    do\n        give request.missing ++ \"!\" ++ \" done\"\nfunction Invalid\n    gives Text\n    do\n        give true ++ \"!\"\n";
    let result = compile_project_sources(
        "search.tb",
        &[
            ("search.tb".into(), source.into()),
            ("common.tb".into(), COMMON.into()),
        ],
    );
    assert!(result.document.is_none());
    assert_eq!(
        result
            .diagnostics
            .iter()
            .filter(|d| d.code == AirDiagnosticCode::UnknownExpressionField)
            .count(),
        1
    );
    let operands: Vec<_> = result
        .diagnostics
        .iter()
        .filter(|d| d.code == AirDiagnosticCode::InvalidExpressionOperandType)
        .collect();
    assert_eq!(operands.len(), 1, "{:?}", result.diagnostics);
    assert_eq!(operands[0].source_ref.as_ref().unwrap().start_line, 10);
}

#[test]
fn transitive_imports_keep_declaring_type_identity() {
    let middle = "module examples.middle\nimport type Request from examples.common\nimport function Decorate from examples.common\nfunction Label\n    takes request as Request\n    gives Text\n    do\n        Decorate\n            with suffix as \"!\"\n            with value as request.query\n            into label\n        give label\n";
    let entry = "module examples.entry\nimport type Request from examples.common\nimport function Label from examples.middle\nfunction Run\n    takes request as Request\n    gives Text\n    do\n        Label\n            with request as request\n            into result\n        give result ++ \" done\"\n";
    let sources = vec![
        ("entry.tb".into(), entry.into()),
        ("middle.tb".into(), middle.into()),
        ("common.tb".into(), COMMON.into()),
    ];
    let result = compile_project_sources("entry.tb", &sources);
    assert_eq!(result.diagnostics, []);
    assert!(
        result
            .document
            .unwrap()
            .definitions
            .functions
            .iter()
            .any(|f| f.id == "function:examples.common/Decorate")
    );
    let mut incompatible = sources;
    incompatible[0].1 = entry
        .replace("import type Request from examples.common\n", "")
        .replace(
            "function Run",
            "type Request\n    query is Text\nfunction Run",
        );
    let result = compile_project_sources("entry.tb", &incompatible);
    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == AirDiagnosticCode::IncompatibleExpressionType)
    );
}

#[test]
fn invalid_imports_never_produce_linkable_air() {
    for source in [
        SEARCH.replace("import function Decorate", "import function Missing"),
        SEARCH.replace("import function Decorate", "import tool Decorate"),
        SEARCH.replace(
            "import function Decorate from",
            "import function Decorate as Alias from",
        ),
        format!(
            "{SEARCH}\nfunction Decorate\n    gives Text\n    do\n        give \"collision\"\n"
        ),
    ] {
        let result = compile_project_sources(
            "search.tb",
            &[
                ("search.tb".into(), source),
                ("common.tb".into(), COMMON.into()),
            ],
        );
        assert!(result.document.is_none());
        assert!(!result.diagnostics.is_empty());
        assert!(
            !result
                .diagnostics
                .iter()
                .any(|d| d.code == AirDiagnosticCode::EmptyFlowGraph)
        );
    }
}

#[test]
fn missing_contract_does_not_hide_an_independent_module_error() {
    let result = compile_project_sources(
        "search.tb",
        &[
            ("search.tb".into(), SEARCH.into()),
            (
                "broken.tb".into(),
                "module examples.broken\nfunction Broken\n    gives Text\n    do\n        give 4\n"
                    .into(),
            ),
        ],
    );
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == AirDiagnosticCode::ImportModuleNotFound)
    );
    assert!(result.diagnostics.iter().any(|d| {
        d.source_ref
            .as_ref()
            .is_some_and(|r| r.source_id == "broken.tb")
    }));
}

fn fixture(path: &str) -> String {
    std::fs::read_to_string(
        std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../grammar/tree-sitter-touba/examples")
            .join(path),
    )
    .unwrap()
}

#[test]
fn contextual_compilation_preserves_cycles_purity_and_agent_authority_checks() {
    for (entry, dependency, expected) in [
        (
            "imports-im1/project/tb-im1-project-cycle-a.tb",
            "imports-im1/project/tb-im1-project-cycle-b.tb",
            AirDiagnosticCode::ImportCycleDetected,
        ),
        (
            "imports-im1/project/tb-im1-project-impure-importer.tb",
            "imports-im1/project/tb-im1-project-impure-source.tb",
            AirDiagnosticCode::FunctionNotPure,
        ),
        (
            "imports-im2/agent/project/tb-im2c-project-agent-app-unauthorized.tb",
            "imports-im2/agent/project/tb-im2c-project-agent-pool.tb",
            AirDiagnosticCode::AgentCallerNotAllowed,
        ),
    ] {
        let result = compile_project_sources(
            entry,
            &[
                (entry.into(), fixture(entry)),
                (dependency.into(), fixture(dependency)),
            ],
        );
        assert!(result.document.is_none());
        assert!(
            result.diagnostics.iter().any(|d| d.code == expected),
            "{entry}: {:?}",
            result.diagnostics
        );
    }
    let entry = "imports-im2/agent/project/tb-im2c-project-agent-app.tb";
    let dependency = "imports-im2/agent/project/tb-im2c-project-agent-pool.tb";
    let result = compile_project_sources(
        entry,
        &[
            (entry.into(), fixture(entry)),
            (dependency.into(), fixture(dependency)),
        ],
    );
    assert_eq!(result.diagnostics, []);
}
