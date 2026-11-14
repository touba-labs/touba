// A route belongs to one trigger, even when its AIR occurs in several plans.
export function requestRouteConflicts(documents, enabledRefs = null) {
  const routes = new Map();
  for (const document of documents) {
    for (const trigger of document.definitions?.triggers ?? []) {
      if (trigger.event?.kind !== 'request' || enabledRefs && !enabledRefs.has(trigger.id)) continue;
      const value = trigger.event.value;
      if (typeof value !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE) \/\S*$/.test(value)) continue;
      const refs = routes.get(value) ?? new Set();
      refs.add(trigger.id); routes.set(value, refs);
    }
  }
  return [...routes].filter(([, refs]) => refs.size > 1).map(([route, refs]) => ({
    severity: 'error', code: 'TriggerRouteConflict',
    message: `Multiple triggers declare ${route}: ${[...refs].sort().join(', ')}`,
    details: { route, trigger_refs: [...refs].sort() },
  }));
}
