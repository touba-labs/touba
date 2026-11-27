use std::collections::HashSet;
use std::path::PathBuf;

use touba_compiler::{
    AirDiagnosticCode, PackageInterface, compile_project_sources,
    compile_sources_with_package_interfaces,
};

#[test]
fn a_public_module_can_use_its_own_packages_internal_module() {
    let package_root = PathBuf::from("workspace").join("catalog").join("src");
    let sources = [
        (
            "main.tb".into(),
            "module main\nimport function Title from example.catalog\n".into(),
        ),
        (
            package_root.join("catalog.tb").to_string_lossy().into_owned(),
            "module example.catalog\nimport define DraftTitle from example.draft\nfunction Title\n    gives Text\n    do\n        give DraftTitle\n".into(),
        ),
        (
            package_root.join("draft.tb").to_string_lossy().into_owned(),
            "module example.draft\ndefine DraftTitle as Text = \"Catalog\"\n".into(),
        ),
    ];
    let interface = PackageInterface {
        name: "example.catalog".into(),
        source_root: package_root,
        exports: HashSet::from(["function:example.catalog/Title".into()]),
    };
    let project = compile_sources_with_package_interfaces(
        "main.tb",
        &sources,
        true,
        std::slice::from_ref(&interface),
    );
    let ordinary = compile_project_sources("main.tb", &sources);
    assert!(project.diagnostics.is_empty(), "{:?}", project.diagnostics);
    assert!(project.document.is_some());
    assert_eq!(project.document, ordinary.document);

    let draft = PackageInterface {
        name: "example.draft".into(),
        source_root: PathBuf::from("workspace").join("draft").join("src"),
        exports: HashSet::new(),
    };
    let mut boundary_sources = sources;
    boundary_sources[2].0 = draft
        .source_root
        .join("draft.tb")
        .to_string_lossy()
        .into_owned();
    let result = compile_sources_with_package_interfaces(
        "main.tb",
        &boundary_sources,
        true,
        &[draft, interface],
    );
    assert!(result.document.is_none());
    assert_eq!(result.diagnostics.len(), 1);
    assert_eq!(
        result.diagnostics[0].code,
        AirDiagnosticCode::PackageExportMissing
    );
}
