use touba_compiler::{
    capability_description_warnings, compile_project_sources, compile_source_to_air,
    AirDiagnosticCode,
};

#[test]
fn warnings_apply_to_agent_catalogues_not_deterministic_calls() {
    let source = "module catalogue\ntool Read\n    gives Text\nagent Reader\n    responsibility \"Read a note\"\n    uses Read\n";
    let document = compile_source_to_air("catalogue.tb", source)
        .document
        .unwrap();
    let warnings = capability_description_warnings(&document);
    assert_eq!(warnings.len(), 1);
    assert_eq!(
        warnings[0].code,
        AirDiagnosticCode::AgentCapabilityDescriptionRequired
    );
    assert!(warnings[0].source_ref.is_some());
    let described = source.replace(
        "tool Read\n",
        "tool Read\n    description \"Read a local note\"\n",
    );
    assert!(capability_description_warnings(
        &compile_source_to_air("catalogue.tb", &described)
            .document
            .unwrap()
    )
    .is_empty());
    let direct = "module direct\ntool Read\n    gives Text\nstrategy Run\n    uses Read\n    do\n        Read\n";
    assert!(capability_description_warnings(
        &compile_source_to_air("direct.tb", direct).document.unwrap()
    )
    .is_empty());
}

#[test]
fn imported_contracts_keep_catalogue_warnings() {
    let sources = vec![("tools.tb".into(), "module tools\ntool Read\n    gives Text\n".into()),
        ("main.tb".into(), "module main\nimport tool Read from tools\nagent Reader\n    responsibility \"Read notes\"\n    uses Read\n".into())];
    let document = compile_project_sources("main.tb", &sources)
        .document
        .unwrap();
    let warnings = capability_description_warnings(&document);
    assert_eq!(warnings.len(), 1);
    assert!(warnings[0].message.contains("tool:tools/Read"));
}
