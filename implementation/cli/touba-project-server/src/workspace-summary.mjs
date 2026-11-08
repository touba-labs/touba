import { eventVisibleToIdentity } from "./event-clients.mjs";

// Fleet reads must never forward arbitrary event payloads (arguments, comments,
// provider output or credentials). Categories share the live stream's ACL.
export function workspaceActivity(events, identity, limit = 100) {
  return events.filter(event => eventVisibleToIdentity(event.type, identity))
    .filter(event => /^(change|element|package|deployment|human_decision|human_wait|interaction|sandbox_run|trigger|project|validation)\./u.test(event.type))
    .sort((a, b) => b.sequence - a.sequence).slice(0, limit).map(event => {
      const category = /^(change|element|package)\./u.test(event.type) ? "change"
        : /^human_/u.test(event.type) ? "decision"
        : event.type.startsWith("deployment.") ? "deployment"
        : event.type.startsWith("trigger.") ? "trigger" : "event";
      const payload = event.payload ?? {};
      const reference = [payload.proposal_id, payload.request_id, payload.operation_id,
        payload.target_ref, payload.trigger_ref, payload.run_id].find(value =>
        typeof value === "string" && /^[a-zA-Z0-9_:/.-]{1,256}$/u.test(value));
      return { id: event.event_id, category, type: event.type, occurred_at: event.emitted_at,
        source_ref: reference ?? event.event_id };
    });
}

export function buildWorkspaceSummary({ identity, project, reads, generatedAt = new Date().toISOString() }) {
  const permits = permission => identity === null || identity?.active === true
    && (identity.permissions?.includes("*") || identity.permissions?.includes(permission));
  const failures = [];
  function read(name, permission) {
    if (!permits(permission)) return null;
    try { return reads[name](); } catch { failures.push(name); return null; }
  }
  const run = read("run", "executions.read");
  const triggers = read("triggers", "executions.read");
  const supply = read("supply", "projects.read");
  const decisions = read("decisions", "decisions.read");
  const activity = read("activity", "projects.read");
  return {
    schema_version: "touba-workspace-summary-v1", generated_at: generatedAt, project,
    run_status: run?.status ?? null,
    attention: { decisions, drift: supply?.summary?.drift ?? null,
      triggers: triggers ? triggers.summary.pending + triggers.summary.dead_letter : null },
    activity: activity ?? [], activity_limit: 100, failures,
  };
}
