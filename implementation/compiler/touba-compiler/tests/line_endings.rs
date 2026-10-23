use touba_compiler::{compile_source_to_air, parse_source};

const PROGRAM: &str = "module examples.vscode_run\n\nstrategy RunSmoke\n    do\n        show\n            with message as \"Touba VS Code run ok\"\n";

#[test]
fn inline_comments_keep_indentation_strings_and_source_positions() {
    let program = "module comments.inline # module\n\ndefine Label as Text = \"#not a comment\" # value\nfunction Read # declaration\n    gives Text # signature\n    do # block\n        if true # branch\n            give Label # result\n        else # other\n            give \"#still text\" # end\n";
    for source in [program.to_string(), program.replace('\n', "\r\n"), program.trim_end().to_string()] {
        let compiled = compile_source_to_air("inline.tb", &source);
        assert!(compiled.document.is_some(), "{:?}", compiled.diagnostics);
        let ast = parse_source("inline.tb", &source).document.unwrap();
        assert_eq!(ast.declarations[1].source_ref().start_byte, source.find("function").unwrap());
    }
}

#[test]
fn compiles_lf_crlf_and_mixed_line_endings_without_rewriting_source_positions() {
    for source in [
        PROGRAM.to_string(),
        PROGRAM.replace('\n', "\r\n"),
        PROGRAM.replacen('\n', "\r\n", 3),
        PROGRAM.trim_end().replace('\n', "\r\n"),
    ] {
        let compiled = compile_source_to_air("line-endings.tb", &source);
        assert!(compiled.document.is_some(), "{:?}", compiled.diagnostics);
        let ast = parse_source("line-endings.tb", &source).document.unwrap();
        let declaration = ast.declarations.first().unwrap();
        assert_eq!(declaration.name(), "RunSmoke");
        let location = declaration.source_ref();
        assert_eq!(location.start_byte, source.find("strategy").unwrap());
        assert_eq!((location.start_line, location.start_column), (2, 0));
        assert!(source[location.start_byte..location.end_byte].starts_with("strategy RunSmoke"));
    }
}

#[test]
fn crlf_preserves_nested_blocks_blank_lines_comments_and_eof_dedents() {
    let source = "\n# header\nmodule newline.comments\n\nstrategy Run\n    do\n\n        # before the nested block\n        if true\n            show\n                with message as \"visible\"\n        else\n            stop\n\n        # after dedent\n        show\n            with message as \"done\"\n# end\n";
    for source in [source.to_string(), source.replace('\n', "\r\n")] {
        let compiled = compile_source_to_air("comments.tb", &source);
        assert!(compiled.document.is_some(), "{:?}", compiled.diagnostics);
    }
}

#[test]
fn crlf_never_relaxes_indentation_or_syntax_validation() {
    for source in [
        "module newline.bad\nstrategy Run\n  do\n        stop\n",
        "module newline.bad\nstrategy Run\n\tdo\n        stop\n",
        "module newline.bad\nstrategy Run\n    do\n        ???\n",
        "module newline.bad\ndefine Broken as Text = \"raw\nnewline\"\n",
    ] {
        for source in [source.to_string(), source.replace('\n', "\r\n")] {
            let compiled = compile_source_to_air("bad.tb", &source);
            assert!(
                compiled.document.is_none(),
                "invalid source was accepted: {source:?}"
            );
            assert!(!compiled.diagnostics.is_empty());
        }
    }
}

#[test]
fn a_bare_carriage_return_is_not_a_line_ending_or_ignored_whitespace() {
    for source in [
        "module newline.bad\rstrategy Run\n    do\n        stop\n",
        "module newline.bad\r",
        "module newline.bad\nstrategy Run\n    do\n        stop\r",
    ] {
        assert!(
            parse_source("bare-cr.tb", source).document.is_none(),
            "{source:?}"
        );
    }
}

#[test]
fn crlf_diagnostics_retain_the_original_error_byte_and_line() {
    let source = "module newline.bad\r\n\r\nstrategy Run\r\n    do\r\n        ???\r\n";
    let parsed = parse_source("bad.tb", source);
    assert!(parsed.document.is_none());
    let location = parsed.diagnostics[0].source_ref.as_ref().unwrap();
    assert_eq!(location.start_byte, source.find('?').unwrap());
    assert_eq!((location.start_line, location.start_column), (4, 8));
}

#[test]
fn every_grammar_fixture_keeps_its_compilation_result_in_crlf() {
    fn collect(directory: &std::path::Path, paths: &mut Vec<std::path::PathBuf>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                collect(&path, paths);
            } else if path.extension().is_some_and(|extension| extension == "tb") {
                paths.push(path);
            }
        }
    }
    let root = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../grammar/tree-sitter-touba/examples");
    let mut fixtures = Vec::new();
    collect(&root, &mut fixtures);
    fixtures.sort();
    assert!(!fixtures.is_empty());
    for fixture in &fixtures {
        let source = std::fs::read_to_string(fixture)
            .unwrap()
            .replace("\r\n", "\n");
        let lf = compile_source_to_air("fixture.tb", &source);
        let crlf = compile_source_to_air("fixture.tb", &source.replace('\n', "\r\n"));
        assert_eq!(
            lf.document.is_some(),
            crlf.document.is_some(),
            "{}: {:?}",
            fixture.display(),
            crlf.diagnostics
        );
        assert_eq!(
            lf.diagnostics.iter().map(|d| &d.code).collect::<Vec<_>>(),
            crlf.diagnostics.iter().map(|d| &d.code).collect::<Vec<_>>(),
            "{}",
            fixture.display(),
        );
    }
    println!(
        "LF/CRLF compilation parity verified for {} fixtures",
        fixtures.len()
    );
}
