use touba_compiler::air::AirExpressionKind;
use touba_compiler::{compile_project_sources, compile_source_to_air};

const SOURCE: &str = include_str!(
    "../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/optional-business.tb"
);

#[test]
fn optional_guards_constructors_lists_and_records_compile() {
    let output = compile_source_to_air("contacts.tb", SOURCE);
    assert!(output.diagnostics.is_empty(), "{:?}", output.diagnostics);
    let air = output.document.unwrap();
    assert_eq!(
        air.definitions
            .types
            .iter()
            .find(|value| value.name == "Envelope")
            .unwrap()
            .fields[0]
            .type_ref,
        "optional:type:contacts/Contact"
    );
    for kind in [
        AirExpressionKind::OptionalSome,
        AirExpressionKind::OptionalNone,
        AirExpressionKind::OptionalPresent,
        AirExpressionKind::OptionalValue,
    ] {
        assert!(
            air.execution_graphs.iter().any(|graph| {
                graph
                    .expressions
                    .iter()
                    .any(|expression| expression.kind == kind)
            }),
            "missing {kind:?}"
        );
    }
}

#[test]
fn optional_absence_access_and_implicit_conversions_are_rejected() {
    for body in [
        "function Test\n    takes value as Optional of Text\n    gives Text\n    do\n        give value\n",
        "function Test\n    takes value as Optional of Text\n    gives Text\n    do\n        give value.value\n",
        "function Test\n    gives Optional of Text\n    do\n        give \"\"\n",
        "function Test\n    gives Optional of Text\n    do\n        give none(Int)\n",
        "function Test\n    gives Optional of Text\n    do\n        give some(3)\n",
        "function Test\n    gives Boolean\n    do\n        give none(Text) == none(Text)\n",
        "function Test\n    gives Optional of Text\n    do\n        give none(Missing)\n",
        "function Test\n    takes value as Text\n    gives Text\n    do\n        if present value as item\n            give item\n        else\n            give \"absent\"\n",
        "function Test\n    takes value as Optional of Text\n    gives Text\n    do\n        if present value as item\n            bind copy as Text = item\n        give item\n",
        "function Test\n    takes value as Optional of Text\n    gives Text\n    do\n        if present value as value\n            give value\n        else\n            give \"absent\"\n",
    ] {
        let output = compile_source_to_air("negative.tb", &format!("module negative\n{body}"));
        assert!(output.document.is_none(), "unexpected success: {body}");
        assert!(!output.diagnostics.is_empty());
    }
}

#[test]
fn optional_import_includes_its_underlying_nominal_type() {
    let consumer = "module consumer\nimport type Contact from contacts\nfunction Empty\n    gives Optional of Contact\n    do\n        give none(Contact)\n";
    let result = compile_project_sources(
        "consumer.tb",
        &[
            ("contacts.tb".into(), SOURCE.into()),
            ("consumer.tb".into(), consumer.into()),
        ],
    );
    assert!(result.diagnostics.is_empty(), "{:?}", result.diagnostics);
    let air = result.document.unwrap();
    assert!(
        air.definitions
            .types
            .iter()
            .any(|value| value.id == "type:contacts/Contact")
    );
    assert!(
        air.definitions
            .types
            .iter()
            .any(|value| value.id == "type:contacts/Channel")
    );
}
