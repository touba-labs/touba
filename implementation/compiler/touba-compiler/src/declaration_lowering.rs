//! Lowering of declarations that do not own an executable graph.

use crate::air::{AirMemory, AirType, AirTypeField};
use crate::ast::{AstMemoryDeclaration, AstTypeDeclaration};
use crate::resolution::{memory_id, type_id};

pub(crate) fn lower_memory_declaration(
    module_name: &str,
    declaration: &AstMemoryDeclaration,
) -> AirMemory {
    AirMemory {
        id: memory_id(module_name, &declaration.name),
        name: declaration.name.clone(),
        source_ref: declaration.source_ref.clone(),
    }
}

pub(crate) fn lower_type_declaration(
    module_name: &str,
    declaration: &AstTypeDeclaration,
    fields: Vec<AirTypeField>,
) -> AirType {
    AirType {
        id: type_id(module_name, &declaration.name),
        name: declaration.name.clone(),
        fields,
        source_ref: declaration.source_ref.clone(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ast::SourceRef;

    fn source_ref() -> SourceRef {
        SourceRef {
            source_id: "test.tb".to_string(),
            start_byte: 0,
            end_byte: 1,
            start_line: 1,
            start_column: 1,
            end_line: 1,
            end_column: 2,
        }
    }

    #[test]
    fn lowers_simple_declarations_without_graph_state() {
        let memory = lower_memory_declaration(
            "test",
            &AstMemoryDeclaration {
                name: "History".to_string(),
                source_ref: source_ref(),
            },
        );
        assert_eq!(memory.id, "memory:test/History");

        let r#type = lower_type_declaration(
            "test",
            &AstTypeDeclaration {
                name: "Decision".to_string(),
                fields: Vec::new(),
                source_ref: source_ref(),
            },
            Vec::new(),
        );
        assert_eq!(r#type.id, "type:test/Decision");
        assert!(r#type.fields.is_empty());
    }
}
