use touba_compiler::{AirDiagnosticCode, compile_source_to_air};

fn function(expression: &str) -> String {
    format!(
        "module limits.example\nfunction Main\n    gives Int\n    do\n        give {expression}\n"
    )
}

#[test]
fn excessive_expressions_are_diagnosed_before_recursive_lowering() {
    for expression in [
        vec!["1"; 1_000].join(" + "),
        format!("{}1{}", "(".repeat(1_000), ")".repeat(1_000)),
    ] {
        let result = compile_source_to_air("large.tb", &function(&expression));
        assert!(result.document.is_none());
        assert_eq!(
            result.diagnostics[0].code,
            AirDiagnosticCode::SourceComplexityExceeded
        );
        assert!(result.diagnostics[0].source_ref.is_some());
    }
    for expression in [
        vec!["1"; 32].join(" + "),
        format!("{}1{}", "(".repeat(32), ")".repeat(32)),
    ] {
        let result = compile_source_to_air("small.tb", &function(&expression));
        assert!(result.document.is_some(), "{:?}", result.diagnostics);
    }
}

#[test]
fn excessive_flat_modules_are_bounded_independently_of_depth() {
    let mut source = String::from("module limits.flat\n");
    for index in 0..20_000 {
        source.push_str(&format!(
            "function F{index}\n    gives Int\n    do\n        give 1\n"
        ));
    }
    let result = compile_source_to_air("flat.tb", &source);
    assert!(result.document.is_none());
    assert_eq!(
        result.diagnostics[0].code,
        AirDiagnosticCode::SourceComplexityExceeded
    );
}

#[test]
fn raw_direction_controls_are_rejected_but_explicit_data_and_unicode_work() {
    for character in ['\u{202a}', '\u{202e}', '\u{2066}', '\u{2069}'] {
        for source in [
            format!("module limits.text\n# comment {character}\n"),
            format!("module limits.text\ndefine Label as Text = \"data{character}\"\n"),
        ] {
            let result = compile_source_to_air("text.tb", &source);
            assert!(result.document.is_none());
            assert_eq!(
                result.diagnostics[0].code,
                AirDiagnosticCode::SourceTextDirectionInvalid
            );
            let location = result.diagnostics[0].source_ref.as_ref().unwrap();
            assert_eq!(
                &source[location.start_byte..location.end_byte],
                character.to_string()
            );
        }
    }
    for value in ["\"مرحبا\"", "\"Été\"", "\"a\\u202eb\""] {
        let source = format!("module limits.text\ndefine Label as Text = {value}\n");
        let result = compile_source_to_air("text.tb", &source);
        assert!(result.document.is_some(), "{:?}", result.diagnostics);
    }
}
