// Applications never inherit client's human role or the server's shared key.
export function servicePrincipal(result, expectedProjectRoot) {
  if (result?.principal?.kind !== 'service') return null;
  const scopes = result.scopes;
  const targets = result.targets;
  if (result.user !== undefined || typeof expectedProjectRoot !== 'string'
    || result.project_root !== expectedProjectRoot || !/^[a-zA-Z0-9_-]{1,80}$/.test(result.principal.id ?? '')
    || !Array.isArray(scopes) || !scopes.length || scopes.length > 3
    || scopes.some(scope => !['executions.invoke', 'executions.read-own', 'executions.cancel-own'].includes(scope))
    || !Array.isArray(targets) || !targets.length || targets.length > 100
    || targets.some(target => typeof target !== 'string' || !/^(agent|function|skill|strategy|tool|trigger):[A-Za-z_][A-Za-z0-9_.]*\/[A-Za-z_][A-Za-z0-9_]*$/.test(target))) return null;
  const name = result.principal.name;
  if (name !== undefined && (typeof name !== 'string' || !name.trim() || name.length > 120 || /[\u0000-\u001f\u007f]/u.test(name))) return null;
  return { principal: { kind: 'service', id: result.principal.id, ...(name ? { name } : {}) }, scopes, targets };
}

function refuse() { throw Object.assign(new Error('application access is limited to its own sessions and allowed targets'), { code: 'ToubaServeApplicationPermissionDenied', statusCode: 403 }); }

export function createApplicationAdmission({ now = Date.now, maxWritesPerMinute = 60 } = {}) {
  const windows = new Map();
  return (identity, method) => {
    if (identity?.principal?.kind !== 'service' || method !== 'POST') return;
    const time = now();
    for (const [key, entry] of windows) if (time >= entry.until) windows.delete(key);
    const id = identity.principal.id, current = windows.get(id) ?? { until: time + 60000, count: 0 };
    if (current.count >= maxWritesPerMinute || (!windows.has(id) && windows.size >= 1024)) {
      throw Object.assign(new Error('application write rate exceeded; retry after the current minute'), { code: 'ToubaServeApplicationRateLimited' });
    }
    current.count++; windows.set(id, current);
  };
}

export function assertApplicationTarget(identity, target) {
  if (!identity.targets?.includes(target)) refuse();
}

export function assertApplicationRoute(identity, method, pathname, readSession) {
  if (identity?.principal?.kind !== 'service') return;
  if (method === 'POST' && pathname === '/interactions/sessions') {
    if (!identity.scopes.includes('executions.invoke')) refuse();
    return;
  }
  const match = /^\/interactions\/sessions\/([a-zA-Z0-9_-]+)(?:\/(messages|operations\/[a-zA-Z0-9_-]+(?:\/cancel)?))?$/.exec(pathname);
  if (!match) refuse();
  const scope = method === 'GET' && (!match[2] || /^operations\/[^/]+$/.test(match[2])) ? 'executions.read-own'
    : method === 'POST' && match[2] === 'messages' ? 'executions.invoke'
    : method === 'POST' && /^operations\/[^/]+\/cancel$/.test(match[2] ?? '') ? 'executions.cancel-own' : null;
  if (!scope || !identity.scopes.includes(scope)) refuse();
  let session;
  try { session = readSession(match[1]); } catch { refuse(); }
  if (session?.created_by?.kind !== 'service' || session.created_by.id !== identity.principal.id) refuse();
  assertApplicationTarget(identity, session.target_ref);
}
