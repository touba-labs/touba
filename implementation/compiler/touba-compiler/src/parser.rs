use tree_sitter::{Language, Parser};

use crate::cst_to_ast::{AstBuildResult, build_ast};

unsafe extern "C" {
    fn tree_sitter_touba() -> *const tree_sitter::ffi::TSLanguage;
}

pub fn touba_language() -> Language {
    unsafe { Language::from_raw(tree_sitter_touba()) }
}

pub fn parse_source(source_id: impl Into<String>, source: &str) -> AstBuildResult {
    let mut parser = Parser::new();
    parser
        .set_language(&touba_language())
        .expect("Touba Tree-sitter language should load");

    let Some(tree) = parser.parse(source, None) else {
        return AstBuildResult::parser_failure(source_id.into());
    };

    build_ast(source_id.into(), source, tree.root_node())
}
