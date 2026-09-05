//! Control-flow fragments and deterministic edge construction.

use crate::air::{AirFlowEdge, AirFlowEdgeRole};
use crate::ast::SourceRef;

#[derive(Debug)]
pub(crate) struct FlowFragment {
    pub(crate) entry_node_id: Option<String>,
    pub(crate) exits: Vec<PendingExit>,
    pub(crate) terminal_reason: Option<&'static str>,
}

impl FlowFragment {
    pub(crate) fn empty() -> Self {
        Self {
            entry_node_id: None,
            exits: Vec::new(),
            terminal_reason: None,
        }
    }

    pub(crate) fn linear(node_id: String) -> Self {
        Self {
            entry_node_id: Some(node_id.clone()),
            exits: vec![PendingExit {
                node_id,
                role: AirFlowEdgeRole::Next,
            }],
            terminal_reason: None,
        }
    }

    pub(crate) fn terminal(node_id: String, reason: &'static str) -> Self {
        Self {
            entry_node_id: Some(node_id),
            exits: Vec::new(),
            terminal_reason: Some(reason),
        }
    }
}

#[derive(Debug)]
pub(crate) struct SequenceFragment {
    pub(crate) exits: Vec<PendingExit>,
    pub(crate) terminal_reason: Option<&'static str>,
    pub(crate) external_effect_possible: bool,
}

#[derive(Debug, Clone)]
pub(crate) struct PendingExit {
    pub(crate) node_id: String,
    pub(crate) role: AirFlowEdgeRole,
}

pub(crate) fn connect_pending_exits(
    exits: &mut Vec<PendingExit>,
    entry_node_id: &str,
    source_ref: SourceRef,
) -> Vec<AirFlowEdge> {
    exits
        .drain(..)
        .map(|exit| AirFlowEdge {
            from_node_id: exit.node_id,
            to_node_id: entry_node_id.to_string(),
            role: exit.role,
            source_ref: Some(source_ref.clone()),
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn connects_pending_exits_in_original_order() {
        let mut exits = vec![
            PendingExit {
                node_id: "node-1".to_string(),
                role: AirFlowEdgeRole::True,
            },
            PendingExit {
                node_id: "node-2".to_string(),
                role: AirFlowEdgeRole::False,
            },
        ];
        let source_ref = SourceRef {
            source_id: "test.tb".to_string(),
            start_byte: 2,
            end_byte: 3,
            start_line: 1,
            start_column: 3,
            end_line: 1,
            end_column: 4,
        };
        let edges = connect_pending_exits(&mut exits, "node-3", source_ref.clone());

        assert!(exits.is_empty());
        assert_eq!(edges.len(), 2);
        assert_eq!(edges[0].from_node_id, "node-1");
        assert_eq!(edges[0].to_node_id, "node-3");
        assert_eq!(edges[0].role, AirFlowEdgeRole::True);
        assert_eq!(edges[1].role, AirFlowEdgeRole::False);
        assert_eq!(edges[1].source_ref, Some(source_ref));
    }
}
