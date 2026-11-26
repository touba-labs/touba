use touba_compiler::{AirDiagnosticCode, compile_project_sources, compile_source_to_air};

#[test]
fn composition_calls_require_explicit_uses_in_all_paths() {
    for owner in ["skill", "strategy"] {
        for body in [
            "        Echo\n            into result\n        give result",
            "        if true\n            Echo\n                into result\n            give result\n        else\n            give \"no\"",
        ] {
            let source = format!(
                "module scope\ntool Echo\n    gives Text\n{owner} Main\n    gives Text\n    do\n{body}\n"
            );
            let refused = compile_source_to_air("scope.tb", &source);
            assert!(refused.document.is_none());
            assert!(
                refused
                    .diagnostics
                    .iter()
                    .any(|d| d.code == AirDiagnosticCode::CapabilityNotDeclaredInUses)
            );
            let accepted = compile_source_to_air(
                "scope.tb",
                &source.replace("    do", "    uses Echo\n    do"),
            );
            assert!(accepted.document.is_some(), "{:?}", accepted.diagnostics);
        }
    }
}

#[test]
fn pure_function_calls_do_not_require_uses() {
    let source = "module scope\nfunction Pure\n    gives Text\n    do\n        give \"yes\"\nstrategy Main\n    gives Text\n    do\n        Pure\n            into value\n        give value\n";
    let result = compile_source_to_air("scope.tb", source);
    assert!(result.document.is_some(), "{:?}", result.diagnostics);
}

#[test]
fn imports_do_not_grant_composition_authority() {
    let sources = vec![("tools.tb".into(), "module tools\ntool Echo\n    gives Text\n".into()),
        ("main.tb".into(), "module main\nimport tool Echo from tools\nstrategy Main\n    gives Text\n    do\n        Echo\n            into value\n        give value\n".into())];
    let result = compile_project_sources("main.tb", &sources);
    assert!(result.document.is_none());
    assert!(
        result
            .diagnostics
            .iter()
            .any(|d| d.code == AirDiagnosticCode::CapabilityNotDeclaredInUses),
        "{:?}",
        result.diagnostics
    );
}
