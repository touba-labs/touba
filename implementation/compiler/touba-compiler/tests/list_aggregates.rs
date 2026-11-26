use touba_compiler::compile_source_to_air;
const SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/list-aggregates.tb"
);

#[test]
fn typed_sum_sort_and_empty_lists_lower_to_structured_air() {
    let result = compile_source_to_air("lists.tb", SOURCE);
    assert_eq!(result.diagnostics, []);
    let value = serde_json::to_value(result.document.unwrap()).unwrap();
    let json = value.to_string();
    assert!(json.contains("list_sum"));
    assert!(json.contains("list_sort"));
}

#[test]
fn list_operations_refuse_wrong_types_before_runtime() {
    for source in [
        SOURCE.replace("give sum(values)", "give sum([\"text\"])"),
        SOURCE.replace("give sort(values)", "give sort([true])"),
        SOURCE.replace(
            "gives Int\n    do\n        give sum([])",
            "gives Text\n    do\n        give sum([])",
        ),
    ] {
        let result = compile_source_to_air("invalid.tb", &source);
        assert!(result.document.is_none());
        assert!(!result.diagnostics.is_empty());
    }
}
