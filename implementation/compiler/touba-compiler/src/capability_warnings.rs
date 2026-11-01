use crate::air::{AirDiagnostic, AirDiagnosticCode, AirDocument};
use std::collections::HashMap;

/// Catalogue metadata is required by decision providers, not by deterministic
/// execution. Report a warning without changing the accepted source language.
pub fn capability_description_warnings(document: &AirDocument) -> Vec<AirDiagnostic> {
    let mut descriptions = HashMap::new();
    let present = |text: &Option<String>| text.as_ref().is_some_and(|s| !s.trim().is_empty());
    for value in &document.definitions.tools {
        descriptions.insert(&value.id, present(&value.description));
    }
    for value in &document.definitions.skills {
        descriptions.insert(&value.id, present(&value.description));
    }
    for value in &document.definitions.functions {
        descriptions.insert(&value.id, present(&value.description));
    }
    for value in &document.definitions.agents {
        descriptions.insert(
            &value.id,
            present(&value.description)
                || (!value.responsibility.trim().is_empty()
                    && value.responsibility.trim() != value.name),
        );
    }
    let mut warnings = Vec::new();
    for agent in &document.definitions.agents {
        for target in &agent.uses {
            if descriptions.get(target) == Some(&false) {
                warnings.push(AirDiagnostic::new(AirDiagnosticCode::AgentCapabilityDescriptionRequired,
                    format!("Add a description to `{target}` before exposing it to a decision provider through `{}`", agent.id),
                    Some(agent.source_ref.clone())));
            }
        }
    }
    warnings
}
