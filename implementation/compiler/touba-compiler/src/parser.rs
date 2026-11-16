use tree_sitter::{Language, Node, Parser};

use crate::ast::SourceRef;
use crate::cst_to_ast::{AstBuildResult, build_ast, parse_error_message};
use crate::diagnostics::{AstDiagnostic, AstDiagnosticCode};

unsafe extern "C" {
    fn tree_sitter_touba() -> *const tree_sitter::ffi::TSLanguage;
}

pub fn touba_language() -> Language {
    unsafe { Language::from_raw(tree_sitter_touba()) }
}

pub fn parse_source(source_id: impl Into<String>, source: &str) -> AstBuildResult {
    let source_id = source_id.into();
    let mut parser = Parser::new();
    parser
        .set_language(&touba_language())
        .expect("Touba Tree-sitter language should load");

    let Some(tree) = parser.parse(source, None) else {
        return AstBuildResult::parser_failure(source_id);
    };

    let root = tree.root_node();
    if let Some(diagnostic) = recovered_cst_diagnostic(&source_id, source, root) {
        return AstBuildResult {
            document: None,
            diagnostics: vec![diagnostic],
        };
    }

    build_ast(source_id, source, root)
}

fn recovered_cst_diagnostic(
    source_id: &str,
    source: &str,
    root: Node<'_>,
) -> Option<AstDiagnostic> {
    let recovered = first_recovered_node(root)?;
    let kind = if recovered.is_missing() {
        "MISSING"
    } else {
        recovered.kind()
    };
    let recovered_text = source.get(recovered.byte_range()).unwrap_or("").trim();
    let has_text_parameter = source.lines().any(|line| {
        line.split_whitespace().take(3).eq(["takes", "text", "as"])
    });
    // A failed interpolation may be recovered as one ERROR node rather than
    // an inner bare identifier. Recognize only this precise conversion shape;
    // the presence of an unrelated parameter must not relabel other errors.
    let expression = recovered_text.strip_prefix('{').and_then(|value| value.strip_suffix('}'))
        .unwrap_or(recovered_text);
    let compact_expression: String = expression.chars().filter(|value| !value.is_whitespace()).collect();
    let base_message = if has_text_parameter && (recovered_text == "text" || compact_expression == "text(text)") {
        "`text` starts the built-in conversion `text(value)` and cannot be used as a bare parameter expression here. Rename the parameter, for example `takes value as Text`, and use `value` in its body.".to_string()
    } else {
        parse_error_message(source)
    };
    let message = if base_message == "Tree-sitter CST contains a syntax error" {
        format!(
            "Touba compiler rejects recovered Tree-sitter syntax node `{kind}`; source must parse without ERROR or MISSING nodes"
        )
    } else {
        format!("{base_message} Tree-sitter recovery node: `{kind}`.")
    };
    Some(AstDiagnostic::error(
        AstDiagnosticCode::ParseError,
        message,
        Some(source_ref(source_id, recovered)),
    ))
}

fn first_recovered_node(node: Node<'_>) -> Option<Node<'_>> {
    // Prefer the earliest nested recovery site over a whole declaration that
    // Tree-sitter wrapped in ERROR. Never accept the recovered tree itself.
    let mut cursor = node.walk();
    for child in node.children(&mut cursor) {
        if let Some(recovered) = first_recovered_node(child) {
            return Some(recovered);
        }
    }
    if node.is_error() || node.is_missing() {
        Some(node)
    } else {
        None
    }
}

fn source_ref(source_id: &str, node: Node<'_>) -> SourceRef {
    let start = node.start_position();
    let end = node.end_position();
    SourceRef {
        source_id: source_id.to_string(),
        start_byte: node.start_byte(),
        end_byte: node.end_byte(),
        start_line: start.row,
        start_column: start.column,
        end_line: end.row,
        end_column: end.column,
    }
}
