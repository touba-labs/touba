use touba_compiler::{compile_project_sources, compile_source_to_air};
const SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/field-contracts.tb"
);

#[test]
fn defaults_constraints_and_copies_compile_and_survive_imports() {
    let result = compile_source_to_air("fields.tb", SOURCE);
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let exact_bound = compile_source_to_air(
        "bounds.tb",
        "module bounds\ntype Item\n    value is Int max 9007199254740991.0\n",
    );
    assert!(
        exact_bound.document.is_some(),
        "{:?}",
        exact_bound.diagnostics
    );
    let source = "module consumer\nimport type Status from fields\nfunction New\n    gives Status\n    do\n        bind original as Status = record Status { id as \"ok\" }\n        give copy original { code as 2 }\n";
    let imported = compile_project_sources(
        "consumer.tb",
        &[
            ("consumer.tb".into(), source.into()),
            ("fields.tb".into(), SOURCE.into()),
        ],
    );
    assert!(
        imported.diagnostics.is_empty(),
        "{:?}",
        imported.diagnostics
    );
}
#[test]
fn invalid_field_contracts_fail_even_without_construction() {
    for field in [
        "Text format \"iban\"",
        "Int format \"digits\"",
        "Text min 0",
        "Int length 2",
        "Text length 5..2",
        "Text length -1",
        "Int min 10 max 2",
        "Int min 1.5",
        "Int min 0.99999999999999999",
        "Int max 9007199254740990.5",
        "Int min 9007199254740992",
        "Text length 2 length 3",
        "Text format \"digits\" default \"abc\"",
        "Int min 1 default 0",
        "Text default 0",
        "Date default date(\"2023-02-29\")",
        "Optional of Int default none(Text)",
        "List of Text length 1..3 default []",
        "Text default unknown",
    ] {
        let source = format!(
            "module invalid\ntype Item\n    value is {field}\nfunction Run\n    gives Text\n    do\n        give \"ok\"\n"
        );
        let result = compile_source_to_air("invalid.tb", &source);
        assert!(result.document.is_none(), "unexpected success: {field}");
    }
}
#[test]
fn bad_record_literals_and_copy_fields_fail() {
    for expression in [
        "record Status { id as \"\" }",
        "record Status { id as \"id\", code as 1000 }",
        "copy original { missing as 1 }",
        "copy original { code as \"text\" }",
        "copy original { code as 1, code as 2 }",
        "copy 3 { code as 1 }",
    ] {
        let source = format!(
            "{SOURCE}\nfunction Invalid\n    takes original as Status\n    gives Status\n    do\n        give {expression}\n"
        );
        let result = compile_source_to_air("fields.tb", &source);
        assert!(
            result.document.is_none(),
            "unexpected success: {expression}"
        );
    }
}
