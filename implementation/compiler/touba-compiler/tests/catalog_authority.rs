use touba_compiler::{AirDiagnosticCode, compile_project_sources};

#[test]
fn agent_catalog_requires_subagent_call_authority_before_selection() {
    let source = "module catalog\nagent Child\n    responsibility \"Review the request.\"\n    callable_by strategy Run\nagent Parent\n    responsibility \"Coordinate the review.\"\n    uses Child\n    callable_by strategy Run\nstrategy Run\n    uses Parent\n    do\n        Parent\n";
    let denied = compile_project_sources("catalog.tb", &[("catalog.tb".into(), source.into())]);
    assert!(denied.document.is_none());
    assert!(denied.diagnostics.iter().any(|d| d.code == AirDiagnosticCode::AgentCallerNotAllowed));
    let authorized = source.replacen("callable_by strategy Run", "callable_by agent Parent", 1);
    let allowed = compile_project_sources("catalog.tb", &[("catalog.tb".into(), authorized)]);
    assert_eq!(allowed.diagnostics, []);
}

#[test]
fn imported_tool_catalog_requires_an_explicit_agent_memory_scope() {
    let library = "module library\nmemory Notes\ntool Read\n    gives Text\n    uses memory Notes read\n    requires memory_read\n";
    let source = "module app\nimport tool Read from library\nimport memory Notes from library\nagent Reader\n    responsibility \"Read the notes.\"\n    uses Read\n    callable_by strategy Run\nstrategy Run\n    uses Reader\n    do\n        Reader\n";
    for (input, expected) in [(source.to_string(), false),
        (source.replace("uses Read\n", "uses Read\n    memory Notes read\n"), true)] {
        let result = compile_project_sources("app.tb", &[("app.tb".into(), input), ("library.tb".into(), library.into())]);
        if expected { assert_eq!(result.diagnostics, []); }
        else {
            assert!(result.document.is_none());
            assert!(result.diagnostics.iter().any(|d| d.code == AirDiagnosticCode::OwnerMemoryScopeMissing));
        }
    }
}

#[test]
fn imported_skill_does_not_lend_its_memory_scope_to_the_selecting_agent() {
    let library = "module library\nmemory Notes\ntool Read\n    gives Text\n    uses memory Notes read\n    requires memory_read\nskill ReadNotes\n    gives Text\n    uses Read\n    memory Notes read\n    do\n        Read\n            into note\n        give note\n";
    let source = "module app\nimport skill ReadNotes from library\nimport memory Notes from library\nagent Reader\n    gives Text\n    responsibility \"Read the notes.\"\n    uses ReadNotes\n    callable_by strategy Run\nstrategy Run\n    uses Reader\n    do\n        Reader\n";
    for authorized in [false, true] {
        let input = if authorized {
            source.replace("uses ReadNotes\n", "uses ReadNotes\n    memory Notes read\n")
        } else { source.to_string() };
        let result = compile_project_sources("app.tb", &[("app.tb".into(), input), ("library.tb".into(), library.into())]);
        if authorized { assert_eq!(result.diagnostics, []); }
        else {
            assert!(result.document.is_none());
            assert!(result.diagnostics.iter().any(|d| d.code == AirDiagnosticCode::OwnerMemoryScopeMissing));
        }
    }
}
