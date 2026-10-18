use touba_compiler::{AirDiagnosticCode, compile_source_to_air};

#[test]
fn a_type_name_is_not_a_returned_value_and_the_diagnostic_has_a_position() {
    let source = "module example\ntype Result\n    message is Text\nstrategy Run\n    gives Result\n    do\n        give Result\n";
    let result = compile_source_to_air("example.tb", source);
    assert!(result.document.is_none());
    let diagnostic = result.diagnostics.iter().find(|d| d.code == AirDiagnosticCode::InvalidGiveValue).unwrap();
    assert!(diagnostic.message.contains("record Result"));
    assert_eq!(diagnostic.source_ref.as_ref().unwrap().start_line, 6);
}

#[test]
fn named_constants_and_constructed_records_remain_returnable() {
    for expression in ["Greeting", "record Result { message as Greeting }"] {
        let output = if expression == "Greeting" { "Text" } else { "Result" };
        let source = format!("module example\ndefine Greeting as Text = \"Hello\"\ntype Result\n    message is Text\nstrategy Run\n    gives {output}\n    do\n        give {expression}\n");
        let result = compile_source_to_air("example.tb", &source);
        assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    }
}
