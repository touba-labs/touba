use touba_compiler::compile_source_to_air;
const SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/typed-approval.tb"
);
#[test]
fn approval_has_static_fields_and_separate_terminal_outcomes() {
    let result = compile_source_to_air("approval.tb", SOURCE);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let cross_run = SOURCE.replace(
        "with role as \"finance\"",
        "with role as \"finance\"\n            with exclude_signers as \"invoice_approvers\"",
    );
    let result = compile_source_to_air("approval.tb", &cross_run);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    for expression in [
        "receipt.decided_by",
        "receipt.missing",
        "receipt.subject_ref.value",
    ] {
        let source = SOURCE.replace("give receipt.decision", &format!("give {expression}"));
        assert!(
            compile_source_to_air("approval.tb", &source)
                .document
                .is_none()
        );
    }
}
#[test]
fn rejection_must_terminate_and_cannot_bind_as_text() {
    for body in [
        "bind label as Text = \"no\"",
        "if true\n                    give \"no\"",
    ] {
        let source = format!(
            "module invalid\nstrategy Run\n    gives Text\n    do\n        human.approve\n            with context as \"dossier\"\n            into receipt\n            on rejected\n                {body}\n        give \"authorized\"\n"
        );
        let result = compile_source_to_air("invalid.tb", &source);
        assert!(result.document.is_none(), "accepted {body}");
    }
}
