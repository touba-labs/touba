const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };

export function projectActivityKind(method, path) {
  if (method === 'POST' && ['/ownership/apply', '/ownership/reviews/apply'].includes(path)) return 'mutation';
  if (method !== 'POST') return null;
  if (path === '/integrations/mcp/discover') return 'mutation';
  if (['/changes/apply', '/project/prepare', '/project/prepare/apply', '/packages/apply', '/packages/remove/apply', '/integrations/import/apply'].includes(path)) return 'mutation';
  if (['/runs/sandbox', '/runs/sandbox/resume', '/triggers/fire', '/triggers/webhooks/review', '/decisions', '/validation/runs'].includes(path)
    || /^\/interactions\/sessions\/[^/]+\/(messages|resume)$/.test(path)) return 'execution';
  return null;
}

// Server-local exclusion, in addition to durable operation/custody checks.
// Acquire after authorization and keep through asynchronous preparation.
export function createProjectActivityGate(blockers) {
  let mutation = false, executions = 0;
  function assertMutationAllowed() {
    if (mutation) fail('ToubaServeProjectMutationBusy', 'Project preparation or package update is in progress');
    const references = blockers();
    if (executions || references.length) fail('ToubaServeProjectOperationsActive',
      `Resolve pending or interrupted operations before modifying the project${references.length ? ': ' + references.slice(0, 8).join(', ') : ''}`);
  }
  return {
    get mutating() { return mutation; },
    assertMutationAllowed,
    enter(kind) {
      if (!kind) return () => {};
      if (mutation) fail('ToubaServeProjectMutationBusy', 'Project preparation or package update is in progress');
      if (kind === 'mutation') {
        assertMutationAllowed();
        mutation = true;
      } else executions++;
      let released = false;
      return () => { if (released) return; released = true; if (kind === 'mutation') mutation = false; else executions--; };
    },
  };
}

// Preview remains read-only and available while operations wait. Applying the
// proposal still reacquires the gate and rechecks all durable blockers.
export function authoringReadiness({ gate, policy, policies = policy ? [policy] : [], host = {} }) {
  const warnings = [];
  try { gate.assertMutationAllowed(); }
  catch (error) {
    if (!['ToubaServeProjectOperationsActive', 'ToubaServeProjectMutationBusy'].includes(error.code)) throw error;
    warnings.push({ severity: 'warning', code: error.code, message: error.message });
  }
  if (policies.length) {
    if (typeof host.humanApprovalAuthority !== 'function') warnings.push({
      severity: 'warning', code: 'ToubaServeApprovalHostRequired',
      message: 'Configure the host attestation provider before using this approval policy.',
    });
    if (host.identityControlPlaneUrl === undefined && policies.some(item => item.distinct_from?.includes('initiator')) && typeof host.humanApprovalInitiator !== 'function'
      && !(typeof host.humanApprovalInitiator === 'string' && host.humanApprovalInitiator.trim())) warnings.push({
      severity: 'warning', code: 'HumanApprovalInitiatorRequired',
      message: 'This separation requires a trusted initiator supplied by the host.',
    });
  }
  return warnings;
}
