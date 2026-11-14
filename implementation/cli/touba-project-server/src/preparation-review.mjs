// Expose contract fields and Core's redacted fragment deltas, never a raw plan
// containing host paths, handler arguments or credentials.
export function preparationChanges(actions) {
  const changes = [];
  const value = item => item === undefined || item === null ? null : JSON.stringify(item);
  for (const action of actions) {
    if (["review_package_contract", "adopt_package_contract"].includes(action.kind)) {
      const before = action.before?.tools ?? {}, after = action.after?.tools ?? {};
      changes.push({ kind: action.kind, subject: action.package, field: "version",
        before: value(action.before?.version), after: value(action.after?.version) });
      for (const tool of new Set([...Object.keys(before), ...Object.keys(after)])) {
        for (const field of ["approval_policy", "required_capabilities", "required_secrets", "memory_accesses", "signature"]) {
          const a = value(before[tool]?.[field]), b = value(after[tool]?.[field]);
          if (a !== b) changes.push({ kind: action.kind, subject: tool, field, before: a, after: b });
        }
      }
    } else if (["would_update_fragment_binding", "update_fragment_binding", "restore_fragment_binding"].includes(action.kind)) {
      changes.push({ kind: action.kind === 'restore_fragment_binding' ? action.kind : "update_fragment_binding", subject: action.tool_ref, field: action.field,
        before: value(action.before), after: value(action.after) });
    } else if (action.kind === "review_fragment_binding") {
      changes.push({ kind: action.kind, subject: action.tool_ref, field: "fragment",
        before: value(action.before), after: value(action.after) });
    } else if (["would_apply_host_decision", "apply_host_decision"].includes(action.kind)
      && action.target_ref?.startsWith("trigger:") && ["enabled", "limits"].includes(action.field)) {
      changes.push({ kind: "update_trigger", subject: action.target_ref, field: action.field, before: value(action.before), after: value(action.after) });
    }
  }
  if (changes.length > 512 || changes.some(item => JSON.stringify(item).length > 16384)) {
    throw Object.assign(new Error("Preparation review exceeds the interactive limit; use the CLI"), { code: "ToubaServePreparationLimit" });
  }
  return changes;
}

export function preparationDecisions(actions) {
  const decisions = { review_packages: {}, review_fragments: {}, restore_fragments: {}, triggers: {} };
  for (const action of actions) {
    if (["review_package_contract", "adopt_package_contract"].includes(action.kind)) decisions.review_packages[action.package] = action.digest;
    if (action.kind === "review_fragment_binding") decisions.review_fragments[action.tool_ref] = action.digest;
    if (action.kind === 'restore_fragment_binding') decisions.restore_fragments[action.tool_ref] = { digest: action.digest, reason: 'Preview of recorded projection' };
    if (action.kind === "review_trigger_limits") decisions.triggers[action.target_ref] = { limits: structuredClone(action.after) };
  }
  return decisions;
}
