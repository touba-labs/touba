const governanceEdges = new Set(['uses', 'callable_by', 'memory_scope', 'memory_access', 'requires', 'approval_site']);
const architectureEdges = new Set(['imports', 'invokes', 'dispatches', 'contains', 'context_link']);
export function viewForNode(node) {
  return node?.graph ? 'flow' : ['capability', 'secret_handle'].includes(node?.kind) ? 'governance' : 'architecture';
}
export function visibleGraph(graph, options) {
  if (!graph) return { nodes: [], edges: [], total: 0 };
  const flowEndpoints = new Set(graph.edges.flatMap(e => e.kind === 'entry' ? [e.from] : e.kind === 'calls' ? [e.to] : []));
  let nodes = graph.nodes.filter(n => options.view === 'flow' ? Boolean(n.graph || flowEndpoints.has(n.id)) : !n.graph && !['capability', 'secret_handle'].includes(n.kind));
  let edges = graph.edges.filter(e => options.view === 'flow' ? ['flow', 'entry', 'calls', 'recovery'].includes(e.kind) : options.view === 'governance' ? governanceEdges.has(e.kind) : architectureEdges.has(e.kind));
  if (options.view === 'governance') {
    const related = new Set(edges.flatMap(e => [e.from, e.to]));
    nodes = graph.nodes.filter(n => related.has(n.id) || n.kind === 'agent' || n.kind === 'human_approval');
  }
  nodes = nodes.filter(n => (!options.kind || n.kind === options.kind) && (!options.module || n.module === options.module) && (!options.package || n.package === options.package) && (!options.search || `${n.name} ${n.id}`.toLowerCase().includes(options.search.toLowerCase())));
  if (options.diagnosticOnly) nodes = nodes.filter(n => options.diagnosticFiles?.includes(n.source_ref?.source_id));
  if (options.direction !== 'all' && options.selected) {
    const seen = new Set([options.selected]); let frontier = new Set(seen);
    for (let i = 0; i < options.depth; i++) {
      const next = new Set();
      for (const e of edges) {
        if (options.direction !== 'incoming' && frontier.has(e.from)) next.add(e.to);
        if (options.direction !== 'outgoing' && frontier.has(e.to)) next.add(e.from);
      }
      frontier = new Set([...next].filter(id => !seen.has(id))); for (const id of frontier) seen.add(id);
    }
    nodes = nodes.filter(n => seen.has(n.id));
  }
  if (options.group && options.view === 'architecture' && !options.kind && !options.search && options.direction === 'all') {
    const groups = new Map();
    const groupId = n => options.module ? n.id : n.package && !options.package ? `package:${n.package}` : n.module ?? n.id;
    const byId = new Map(graph.nodes.map(n => [n.id, n]));
    for (const n of nodes) { const id = groupId(n); if (!groups.has(id)) groups.set(id, { ...(byId.get(id) ?? n), count: 0 }); groups.get(id).count++; }
    const grouped = new Map();
    for (const e of edges) {
      const a = byId.get(e.from), b = byId.get(e.to); if (!a || !b) continue;
      const from = groupId(a), to = groupId(b); if (from === to) continue;
      const id = JSON.stringify(['group', e.kind, from, to]);
      if (!grouped.has(id)) grouped.set(id, { ...e, id, from, to, count: 0, aggregated: true });
      grouped.get(id).count++;
    }
    nodes = [...groups.values()]; edges = [...grouped.values()];
  }
  const ids = new Set(nodes.map(n => n.id));
  edges = edges.filter(e => ids.has(e.from) && ids.has(e.to));
  return { nodes, edges, total: nodes.length };
}

// Strongly connected components keep loops together; the component DAG gives stable ranks.
export function layoutGraph(nodes, edges) {
  const adjacency = new Map(nodes.map(n => [n.id, []]));
  for (const e of edges) if (adjacency.has(e.from) && adjacency.has(e.to)) adjacency.get(e.from).push(e.to);
  const indices = new Map(), low = new Map(), stack = [], active = new Set(), components = [];
  let index = 0;
  function visit(id) {
    indices.set(id, index); low.set(id, index++); stack.push(id); active.add(id);
    for (const next of adjacency.get(id)) {
      if (!indices.has(next)) { visit(next); low.set(id, Math.min(low.get(id), low.get(next))); }
      else if (active.has(next)) low.set(id, Math.min(low.get(id), indices.get(next)));
    }
    if (low.get(id) === indices.get(id)) {
      const component = []; let next;
      do { next = stack.pop(); active.delete(next); component.push(next); } while (next !== id);
      components.push(component.sort());
    }
  }
  for (const n of nodes) if (!indices.has(n.id)) visit(n.id);
  const componentOf = new Map(components.flatMap((c, i) => c.map(id => [id, i])));
  const incoming = components.map(() => new Set());
  for (const e of edges) { const a = componentOf.get(e.from), b = componentOf.get(e.to); if (a !== b && a !== undefined && b !== undefined) incoming[b].add(a); }
  const ranks = new Map();
  function rank(i) { if (!ranks.has(i)) ranks.set(i, Math.max(0, ...[...incoming[i]].map(p => rank(p) + 1))); return ranks.get(i); }
  const rows = new Map(), positions = new Map();
  for (let i = 0; i < components.length; i++) {
    const r = rank(i);
    for (const id of components[i]) { const row = rows.get(r) ?? 0; positions.set(id, { x: 40 + row * 280, y: 40 + r * 160 }); rows.set(r, row + 1); }
  }
  const columns = Math.max(1, ...rows.values());
  for (const [id, position] of positions) position.x += (columns - rows.get(rank(componentOf.get(id)))) * 140;
  return { positions, width: 40 + columns * 280, height: (Math.max(0, ...ranks.values()) + 1) * 160 };
}
