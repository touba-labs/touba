use touba_compiler::{air::AirDiagnosticCode, compile_source_to_air, parse_source};

#[test]
fn text_escapes_decode_once_and_invalid_literals_never_produce_air() {
    let valid = r#"module text.check
function Read
    gives Text
    do
        give "first\nsecond\t\"quoted\"\\literal\u000A\uD83D\uDE00"
"#;
    let compiled = compile_source_to_air("text.tb", valid);
    assert!(compiled.document.is_some(), "{:?}", compiled.diagnostics);
    let serialized = serde_json::to_value(compiled.document.unwrap()).unwrap();
    assert!(serialized.to_string().contains("😀"));
    for literal in [
        r#""bad\q""#,
        r#""\uD800""#,
        r#""\uDC00""#,
        r#""\uXY00""#,
        "\"raw\tcontrol\"",
    ] {
        let source = format!(
            "module text.check\nfunction Read\n    gives Text\n    do\n        give {literal}\n"
        );
        let compiled = compile_source_to_air("text.tb", &source);
        assert!(compiled.document.is_none(), "{literal}");
        assert!(
            compiled
                .diagnostics
                .iter()
                .any(|d| d.code == AirDiagnosticCode::InvalidTextLiteral),
            "{:?}",
            compiled.diagnostics
        );
    }
    assert!(
        parse_source(
            "text.tb",
            "module text.check\ndefine Broken as Text = \"raw\nnewline\"\n"
        )
        .document
        .is_none()
    );
}

#[test]
fn nested_controls_compile_without_syntax_recovery() {
    for outer in ["if true", "for item in items", "while ready"] {
        for inner in ["if true", "for other in items", "while ready"] {
            let source = format!(
                "module flow.check\nstrategy Run\n    takes items as List of Int\n    takes ready as Boolean\n    do\n        {outer}\n            {inner}\n                stop\n"
            );
            let compiled = compile_source_to_air("nested.tb", &source);
            assert!(
                compiled.document.is_some(),
                "{outer}/{inner}: {:?}",
                compiled.diagnostics
            );
        }
    }
    let source = "module flow.check\nstrategy Run\n    do\n        if true\n            stop\n        else\n            if true\n                stop\n";
    assert!(compile_source_to_air("else.tb", source).document.is_some());
    // Keywords in comments or quoted strings must not masquerade as controls.
    let source = "module flow.check\nstrategy Run\n    do\n        if true\n            show\n                with message as \"if true\"\n        ???\n";
    assert!(
        compile_source_to_air("not-nested.tb", source)
            .document
            .is_none()
    );
}

#[test]
fn duplicate_single_clauses_are_reported_at_the_repeated_source() {
    let cases = [
        (
            "do",
            "function Read\n    gives Text\n    do\n        give \"first\"\n    do\n        give \"second\"\n",
        ),
        (
            "gives",
            "agent Read\n    responsibility \"Read the input\"\n    gives Int\n    gives Text\n",
        ),
        (
            "description",
            "tool Read\n    description \"\"\n    description \"Read the input\"\n    gives Text\n",
        ),
        (
            "on failure",
            "skill Read\n    gives Text\n    do\n        give \"first\"\n    on failure handler\n        stop\n    on failure business\n        stop\n",
        ),
        (
            "do",
            "strategy Read\n    do\n        stop\n    do\n        stop\n",
        ),
        (
            "on",
            "trigger Clock\n    on schedule \"every 1h\"\n    on schedule \"every 2h\"\n    runs strategy Read\n    limits\n        max_runs_per_day as 10\n        timeout_ms as 1000\n",
        ),
        (
            "runs",
            "trigger Clock\n    on schedule \"every 1h\"\n    runs strategy Read\n    runs strategy Read\n    limits\n        max_runs_per_day as 10\n        timeout_ms as 1000\n",
        ),
        (
            "limits",
            "trigger Clock\n    on schedule \"every 1h\"\n    runs strategy Read\n    limits\n        max_runs_per_day as 10\n        timeout_ms as 1000\n    limits\n        max_runs_per_day as 11\n        timeout_ms as 2000\n",
        ),
    ];
    for (clause, declaration) in cases {
        let source = if declaration.starts_with("trigger") {
            format!("module duplicate.clauses\nstrategy Read\n    do\n        stop\n{declaration}")
        } else {
            format!("module duplicate.clauses\n{declaration}")
        };
        let result = compile_source_to_air("clauses.tb", &source);
        assert!(result.document.is_none(), "{source}");
        let diagnostic = result
            .diagnostics
            .iter()
            .find(|diagnostic| diagnostic.code == AirDiagnosticCode::DuplicateDeclarationClause)
            .unwrap_or_else(|| panic!("expected duplicate `{clause}`: {:?}", result.diagnostics));
        assert!(
            diagnostic.message.contains(&format!("`{clause}`")),
            "{:?}",
            diagnostic
        );
        let offset = source.rfind(&format!("    {clause}")).unwrap() + 4;
        assert_eq!(diagnostic.source_ref.as_ref().unwrap().start_byte, offset);
    }
}
