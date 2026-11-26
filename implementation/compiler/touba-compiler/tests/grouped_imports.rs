use touba_compiler::compile_project_sources;
#[test]
fn grouped_imports_keep_each_identity_and_detect_collisions() {
    let shared = "module shared\nfunction First\n    gives Int\n    do\n        give 1\nfunction Second\n    gives Int\n    do\n        give 2\n";
    let main = "module main\nimport function First, Second from shared\nfunction Run\n    gives Int\n    do\n        First\n            into first\n        Second\n            into second\n        give first + second\n";
    let compile = |text: &str| {
        compile_project_sources(
            "main.tb",
            &[
                ("main.tb".into(), text.into()),
                ("shared.tb".into(), shared.into()),
            ],
        )
    };
    let result = compile(main);
    assert_eq!(result.diagnostics, []);
    assert_eq!(result.document.unwrap().imports.len(), 2);
    assert!(
        compile(&main.replace("First, Second", "First, First"))
            .document
            .is_none()
    );
    assert!(
        compile(&main.replace("First, Second", "First, Missing"))
            .document
            .is_none()
    );
}
