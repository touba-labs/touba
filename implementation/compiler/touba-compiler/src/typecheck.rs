//! Pure V1 type and label compatibility rules used by AIR lowering.

pub(crate) const BUILTIN_TEXT: &str = "builtin:Text";
pub(crate) const BUILTIN_BOOLEAN: &str = "builtin:Boolean";
pub(crate) const BUILTIN_INT: &str = "builtin:Int";
pub(crate) const BUILTIN_FLOAT: &str = "builtin:Float";

pub(crate) fn builtin_text() -> String {
    BUILTIN_TEXT.to_string()
}

pub(crate) fn builtin_boolean() -> String {
    BUILTIN_BOOLEAN.to_string()
}

pub(crate) fn builtin_int() -> String {
    BUILTIN_INT.to_string()
}

pub(crate) fn builtin_float() -> String {
    BUILTIN_FLOAT.to_string()
}

pub(crate) fn is_numeric_type(type_ref: Option<&str>) -> bool {
    matches!(type_ref, Some(BUILTIN_INT | BUILTIN_FLOAT))
}

pub(crate) fn is_numeric_pair(left_type: Option<&str>, right_type: Option<&str>) -> bool {
    is_numeric_type(left_type) && is_numeric_type(right_type)
}

pub(crate) fn is_text_renderable_type(type_ref: &str) -> bool {
    matches!(
        type_ref,
        BUILTIN_TEXT | BUILTIN_BOOLEAN | BUILTIN_INT | BUILTIN_FLOAT
    )
}

pub(crate) fn are_equality_compatible(left_type: Option<&str>, right_type: Option<&str>) -> bool {
    match (left_type, right_type) {
        (Some(left_type), Some(right_type)) if left_type == right_type => true,
        (left_type, right_type) => is_numeric_pair(left_type, right_type),
    }
}

pub(crate) fn is_assignable_to(actual_type: &str, expected_type: &str) -> bool {
    actual_type == expected_type || (actual_type == BUILTIN_INT && expected_type == BUILTIN_FLOAT)
}

pub(crate) fn is_builtin_type_ref(raw: &str) -> bool {
    matches!(raw, "Text" | "Boolean" | "Int" | "Float")
}

pub(crate) fn is_v1_capability_label(label: &str) -> bool {
    matches!(
        label,
        "network"
            | "filesystem_read"
            | "filesystem_write"
            | "process"
            | "external_api"
            | "secret_read"
            | "human_approval"
            | "memory_read"
            | "memory_write"
    )
}

pub(crate) fn is_memory_access_label(label: &str) -> bool {
    matches!(label, "read" | "write")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn preserves_v1_numeric_compatibility() {
        assert!(is_assignable_to(BUILTIN_INT, BUILTIN_FLOAT));
        assert!(!is_assignable_to(BUILTIN_FLOAT, BUILTIN_INT));
        assert!(are_equality_compatible(
            Some(BUILTIN_INT),
            Some(BUILTIN_FLOAT)
        ));
        assert!(!are_equality_compatible(
            Some(BUILTIN_TEXT),
            Some(BUILTIN_INT)
        ));
    }

    #[test]
    fn recognizes_only_governed_v1_labels() {
        assert!(is_v1_capability_label("human_approval"));
        assert!(!is_v1_capability_label("shell_everything"));
        assert!(is_memory_access_label("read"));
        assert!(!is_memory_access_label("admin"));
    }
}
