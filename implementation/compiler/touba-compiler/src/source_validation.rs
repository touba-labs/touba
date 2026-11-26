use tree_sitter::Node;

use crate::ast::SourceRef;
use crate::diagnostics::{AstDiagnostic, AstDiagnosticCode};

const MAX_SYNTAX_DEPTH: usize = 256;
const MAX_SYNTAX_NODES: usize = 100_000;

pub(crate) fn validate_source_tree(
    source_id: &str,
    source: &str,
    root: Node<'_>,
) -> Option<AstDiagnostic> {
    if let Some((offset, value)) = source
        .char_indices()
        .find(|(_, value)| matches!(*value, '\u{202a}'..='\u{202e}' | '\u{2066}'..='\u{2069}'))
    {
        let prefix = &source[..offset];
        let line_start = prefix.rfind('\n').map_or(0, |index| index + 1);
        let line = prefix.bytes().filter(|value| *value == b'\n').count();
        return Some(AstDiagnostic::error(
            AstDiagnosticCode::SourceTextDirectionInvalid,
            format!(
                "raw text direction control U+{:04X} is not allowed in source; use an explicit JSON Unicode escape when this character is data",
                value as u32
            ),
            Some(SourceRef {
                source_id: source_id.to_string(),
                start_byte: offset,
                end_byte: offset + value.len_utf8(),
                start_line: line,
                end_line: line,
                start_column: offset - line_start,
                end_column: offset - line_start + value.len_utf8(),
            }),
        ));
    }

    // Walk without recursion before AST construction, typing or serialization.
    let mut cursor = root.walk();
    let mut depth = 0;
    let mut count = 0;
    loop {
        count += 1;
        if depth > MAX_SYNTAX_DEPTH || count > MAX_SYNTAX_NODES {
            let node = cursor.node();
            let start = node.start_position();
            let end = node.end_position();
            return Some(AstDiagnostic::error(
                AstDiagnosticCode::SourceComplexityExceeded,
                format!(
                    "source exceeds the compiler syntax limit ({MAX_SYNTAX_DEPTH} levels or {MAX_SYNTAX_NODES} nodes); split the expression or module"
                ),
                Some(SourceRef {
                    source_id: source_id.to_string(),
                    start_byte: node.start_byte(),
                    end_byte: node.end_byte(),
                    start_line: start.row,
                    end_line: end.row,
                    start_column: start.column,
                    end_column: end.column,
                }),
            ));
        }
        if cursor.goto_first_child() {
            depth += 1;
            continue;
        }
        while !cursor.goto_next_sibling() {
            if !cursor.goto_parent() {
                return None;
            }
            depth -= 1;
        }
    }
}
