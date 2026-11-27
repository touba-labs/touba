use touba_compiler::air::AirExpressionKind;
use touba_compiler::{AirDiagnosticCode, compile_source_to_air};
const SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/list-aggregates.tb"
);

#[test]
fn typed_sum_sort_and_empty_lists_lower_to_structured_air() {
    let result = compile_source_to_air("lists.tb", SOURCE);
    assert_eq!(result.diagnostics, []);
    let document = result.document.unwrap();
    for (function, kind, output) in [
        ("Total", AirExpressionKind::ListSum, "builtin:Int"),
        ("TotalFloat", AirExpressionKind::ListSum, "builtin:Float"),
        ("Ordered", AirExpressionKind::ListSort, "list:builtin:Int"),
        (
            "OrderedText",
            AirExpressionKind::ListSort,
            "list:builtin:Text",
        ),
        ("Empty", AirExpressionKind::ListSum, "builtin:Int"),
        (
            "EmptySort",
            AirExpressionKind::ListSort,
            "list:builtin:Text",
        ),
    ] {
        let graph = document
            .execution_graphs
            .iter()
            .find(|graph| graph.owner_ref == format!("function:aggregates/{function}"))
            .unwrap();
        let operation = graph
            .expressions
            .iter()
            .find(|expression| expression.kind == kind)
            .unwrap();
        assert_eq!(operation.type_ref.as_deref(), Some(output), "{function}");
        assert_eq!(operation.operands.len(), 1, "{function}");
    }
}

#[test]
fn list_operations_refuse_wrong_types_before_runtime() {
    for (output, expression, code, detail) in [
        (
            "Int",
            "sum([\"text\"])",
            AirDiagnosticCode::IncompatibleExpressionType,
            "expects `builtin:Int`, got `builtin:Text`",
        ),
        (
            "List of Int",
            "sort([true])",
            AirDiagnosticCode::IncompatibleExpressionType,
            "expects `builtin:Int`, got `builtin:Boolean`",
        ),
        (
            "Text",
            "sum([])",
            AirDiagnosticCode::InvalidExpressionOperandType,
            "sum requires a numeric list",
        ),
    ] {
        let source = format!(
            "module invalid\nfunction Run\n    gives {output}\n    do\n        give {expression}\n"
        );
        let result = compile_source_to_air("invalid.tb", &source);
        assert!(result.document.is_none());
        assert!(
            result.diagnostics.iter().any(|diagnostic| {
                diagnostic.code == code && diagnostic.message.contains(detail)
            }),
            "{expression}: {:?}",
            result.diagnostics
        );
    }
}
