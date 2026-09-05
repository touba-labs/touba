//! Deterministic AIR identifiers and inter-module caller resolution.
//!
//! This module is deliberately pure: it never reads or mutates symbol tables.

pub(crate) fn module_id(name: &str) -> String {
    format!("module:{name}")
}

macro_rules! qualified_id_fn {
    ($name:ident, $kind:literal) => {
        pub(crate) fn $name(module_name: &str, name: &str) -> String {
            qualified_id($kind, module_name, name)
        }
    };
}

qualified_id_fn!(constant_id, "constant");
qualified_id_fn!(type_id, "type");
qualified_id_fn!(memory_id, "memory");
qualified_id_fn!(function_id, "function");
qualified_id_fn!(tool_id, "tool");
qualified_id_fn!(skill_id, "skill");
qualified_id_fn!(agent_id, "agent");
qualified_id_fn!(strategy_id, "strategy");
qualified_id_fn!(trigger_id, "trigger");

pub(crate) fn graph_id(owner_ref: &str) -> String {
    format!("graph:{owner_ref}")
}

pub(crate) fn qualified_id(kind: &str, module_name: &str, name: &str) -> String {
    format!("{kind}:{module_name}/{name}")
}

pub(crate) fn inter_module_caller_ref(caller_kind: &str, caller: &str) -> Option<String> {
    let (module_name, name) = caller.rsplit_once('.')?;
    match caller_kind {
        "strategy" => Some(strategy_id(module_name, name)),
        "agent" => Some(agent_id(module_name, name)),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_stable_qualified_identifiers() {
        assert_eq!(module_id("org.billing"), "module:org.billing");
        assert_eq!(tool_id("org.billing", "Pay"), "tool:org.billing/Pay");
        assert_eq!(
            graph_id("skill:org.billing/Review"),
            "graph:skill:org.billing/Review"
        );
    }

    #[test]
    fn resolves_only_supported_inter_module_callers() {
        assert_eq!(
            inter_module_caller_ref("strategy", "org.ops.Review"),
            Some("strategy:org.ops/Review".to_string())
        );
        assert_eq!(
            inter_module_caller_ref("agent", "org.ops.Reviewer"),
            Some("agent:org.ops/Reviewer".to_string())
        );
        assert_eq!(inter_module_caller_ref("skill", "org.ops.Review"), None);
        assert_eq!(inter_module_caller_ref("agent", "Reviewer"), None);
    }
}
