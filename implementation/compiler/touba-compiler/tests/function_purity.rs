use touba_compiler::{air::AirDiagnosticCode, compile_source_to_air};

#[test]
fn rejects_local_effects_even_behind_a_function_call_or_unreachable_branch() {
    for (name, declarations, body) in [
        (
            "tool",
            "tool External\n    gives Text",
            "External\n            into answer\n        give answer",
        ),
        (
            "skill",
            "tool Write\n    gives Text\n\nskill External\n    gives Text\n    uses Write\n    do\n        Write\n            into value\n        give value",
            "External\n            into answer\n        give answer",
        ),
        (
            "branch",
            "tool External\n    gives Text",
            "if false\n            External\n                into answer\n            give answer\n        else\n            give \"pure\"",
        ),
    ] {
        let source = format!(
            "module purity.check\n\n{declarations}\n\nfunction Inner\n    gives Text\n    do\n        {body}\n\nfunction Outer\n    gives Text\n    do\n        Inner\n            into result\n        give result\n"
        );
        let result = compile_source_to_air(name, &source);
        assert!(
            result.document.is_none(),
            "{name} must not produce executable AIR"
        );
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|d| d.code == AirDiagnosticCode::FunctionNotPure)
            .unwrap_or_else(|| panic!("{name}: {:?}", result.diagnostics));
        assert!(
            diagnostic.source_ref.is_some(),
            "diagnostic must locate the effect"
        );
    }
}

#[test]
fn admits_pure_function_composition_and_repeated_calls() {
    let source = "module purity.allowed\n\nfunction Increment\n    takes value as Int\n    gives Int\n    do\n        give value + 1\n\nfunction Twice\n    takes value as Int\n    gives Int\n    do\n        Increment\n            with value as value\n            into first\n        Increment\n            with value as first\n            into second\n        give second\n";
    let result = compile_source_to_air("pure-composition", source);
    assert_eq!(result.diagnostics, []);
    assert!(result.document.is_some());
}
