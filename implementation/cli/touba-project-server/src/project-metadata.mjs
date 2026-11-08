// Presentation metadata only. Canonical artifacts, traces, user values and
// durable stores keep their exact bytes. Authority still uses the real root.
const responses = new WeakMap();
const surfaces = new Set(['touba-project-refresh-v1', 'touba-project-inspection-v1',
  'touba-workspace-summary-v1', 'touba-authority-graph-v1', 'touba-trigger-status-v1',
  'touba-trigger-queue-health-v1', 'touba-supply-chain-status-v1',
  'touba-governance-readiness-v1', 'touba-cost-observatory-v1',
  'touba-handler-sandbox-status-v1']);

export function projectMetadataScope(identity, root) {
  if (identity === null || identity?.permissions?.some(permission => ['*', 'projects.manage'].includes(permission))) return null;
  const audience = typeof identity?.audience === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(identity.audience) ? identity.audience : 'current';
  return { root, reference: `project:${audience}` };
}
export function setProjectMetadataScope(response, identity, root) {
  responses.set(response, projectMetadataScope(identity, root));
}
export function projectMetadataResponse(response, value) {
  return projectMetadata(value, responses.get(response));
}
export function projectMetadata(value, scope) {
  if (!scope || !value || typeof value !== 'object') return value;
  if (value.schema_version === 'touba-project-live-state-v1') {
    const result = { ...value, project_server: { ...value.project_server,
      project_root: scope.reference, refresh: projectMetadata(value.project_server?.refresh, scope) } };
    for (const key of ['project', 'authority_graph', 'trigger_status', 'trigger_queue_health',
      'supply_chain_status', 'governance_readiness', 'cost_observatory', 'handler_sandbox_status']) result[key] = projectMetadata(value[key], scope);
    return result;
  }
  if (!surfaces.has(value.schema_version)) return value;
  const result = { ...value };
  if (value.project_root === scope.root) result.project_root = scope.reference;
  if (value.project?.root === scope.root) result.project = { ...value.project, root: scope.reference };
  return result;
}
export function projectMetadataEvent(response, type, event) {
  if (!['project.changed', 'artifact.changed'].includes(type)) return event;
  return { ...event, payload: projectMetadataResponse(response, event.payload) };
}
