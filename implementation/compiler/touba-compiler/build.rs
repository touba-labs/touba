use std::path::PathBuf;

fn main() {
    let manifest_dir =
        PathBuf::from(std::env::var("CARGO_MANIFEST_DIR").expect("CARGO_MANIFEST_DIR"));
    let grammar_dir = manifest_dir.join("../../grammar/tree-sitter-touba");
    let parser_c = grammar_dir.join("src/parser.c");
    let scanner_c = grammar_dir.join("src/scanner.c");

    if !parser_c.exists() {
        panic!(
            "missing generated Tree-sitter parser at {}; run `corepack pnpm --dir grammar/tree-sitter-touba exec tree-sitter generate` from touba/implementation",
            parser_c.display()
        );
    }

    println!(
        "cargo:rerun-if-changed={}",
        grammar_dir.join("grammar.js").display()
    );
    println!(
        "cargo:rerun-if-changed={}",
        grammar_dir.join("tree-sitter.json").display()
    );
    println!("cargo:rerun-if-changed={}", parser_c.display());
    println!("cargo:rerun-if-changed={}", scanner_c.display());
    println!(
        "cargo:rerun-if-changed={}",
        grammar_dir.join("src/tree_sitter").display()
    );

    let mut build = cc::Build::new();
    build.include(grammar_dir.join("src")).file(parser_c);

    if scanner_c.exists() {
        build.file(scanner_c);
    }

    build.compile("tree-sitter-touba");
}
