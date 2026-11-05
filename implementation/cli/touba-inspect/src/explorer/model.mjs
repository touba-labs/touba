import { validateAirMachineContract } from '../../../../contracts/machine/contracts.mjs';
import { expressionFormatter } from './expressions.mjs';
import { combineToolApprovalPolicies } from '../../../../contracts/tool-approval-policy.mjs';

export const EXPLORER_VERSION = 'touba-project-explorer-v1';
const collections = { types: 'type', constants: 'constant', functions: 'function', tools: 'tool', memories: 'memory', skills: 'skill', agents: 'agent', strategies: 'strategy', triggers: 'trigger' };
// This is a display projection. AIR remains the authority for every relationship.
export function projectExplorer(airs, { name, revision, files, packages = [], entrypoints = [], toolPolicies = {} }) {
  const nodes = new Map(), edges = new Map();
  const add = node => { if (!nodes.has(node.id)) nodes.set(node.id, node); };
  const edge = (kind, from, to, source_ref, extra = {}) => {
    if (!from || !to) return;
    const id = JSON.stringify([kind, from, to, extra.role ?? '', source_ref?.start_byte ?? '']);
    edges.set(id, { id, kind, from, to, source_ref, ...extra });
  };
  for (const pkg of packages) {
    const id = `package:${pkg.name}`;
    const details = Object.fromEntries(['version', 'description', 'publisher', 'license', 'touba', 'exports', 'dependencies', 'engines', 'hosts'].filter(key => pkg[key] !== undefined).map(key => [key, pkg[key]]));
    add({ id, kind:'package', name:pkg.name, package:pkg.name, details });
    for (const context of pkg.contexts) {
      const contextId = `context:${pkg.name}/${context.id}`;
      add({ id:contextId, name:context.id, kind:'context', package:pkg.name, details:{ description:context.description, activation:context.activation } });
      edge('contains',id,contextId);
      for (const link of context.execution_links ?? []) edge('context_link',contextId,link.target_ref,undefined);
    }
  }
  for (const air of airs) {
    validateAirMachineContract(air);
    const module = air.module.id;
    const packageName = files.find(f => f.path === air.module.source_ref?.source_id)?.package ?? null;
    const common = { module, package: packageName };
    if (packageName) {
      add({ id: `package:${packageName}`, kind: 'package', name: packageName, package: packageName });
      edge('contains', `package:${packageName}`, module);
    }
    const moduleEntries = entrypoints.filter(ref => Object.values(air.definitions).some(list => list.some(d => d.id === ref && d.source_ref?.source_id === air.module.source_ref?.source_id)));
    add({ ...common, ...air.module, kind: 'module', details: { budgets: air.budgets?.run, ...(moduleEntries.length ? { entrypoints: moduleEntries } : {}) } });
    const formatConstant = expressionFormatter({}, air.definitions.constants);
    for (const [collection, kind] of Object.entries(collections)) {
      for (const d of air.definitions[collection] ?? []) {
        const details = {};
        for (const key of ['signature', 'description', 'responsibility', 'fields', 'variants', 'type_ref', 'limits', 'memory_scopes', 'memory_accesses', 'event', 'payload', 'required_capabilities', 'required_secrets']) {
          if (d[key] !== undefined) details[key] = d[key];
        }
        if (kind === 'tool') {
          details.boundary = 'External handler (JavaScript or Python)';
          const effectivePolicy = combineToolApprovalPolicies(d.approval_policy, toolPolicies[d.id] ?? undefined);
          if (effectivePolicy !== undefined) {
            details.approval_required = true;
            details.approval_policy = effectivePolicy;
            details.approval_origin = d.approval_policy !== undefined
              ? (toolPolicies[d.id] != null ? 'source_and_consumer' : 'source') : 'consumer';
          }
        }
        if (kind === 'constant') details.value = { expression: formatConstant(d.id) };
        if (d.arguments?.length) details.arguments = Object.fromEntries(d.arguments.map(arg => [arg.input, { expression: formatConstant(arg.value_ref) }]));
        if (entrypoints.includes(d.id)) details.entrypoint = true;
        add({ ...common, id: d.id, name: d.name, kind, source_ref: d.source_ref, details });
        edge('contains', module, d.id, d.source_ref);
        for (const target of d.uses ?? []) edge('uses', d.id, target, d.use_refs?.find(r => r.target_ref === target)?.source_ref ?? d.source_ref);
        for (const caller of d.callable_by ?? []) edge('callable_by', caller.caller_ref, d.id, caller.source_ref);
        for (const scope of d.memory_scopes ?? []) edge('memory_scope', d.id, scope.memory_ref, scope.source_ref, { role: scope.access });
        for (const access of d.memory_accesses ?? []) edge('memory_access', d.id, access.memory_ref, access.source_ref, { role: access.access });
        for (const [key, resourceKind] of [['required_capabilities', 'capability'], ['required_secrets', 'secret_handle']]) {
          for (const requirement of d[key] ?? []) {
            const label = typeof requirement === 'string' ? requirement : requirement.name ?? requirement.handle ?? requirement.capability;
            if (!label) continue;
            const id = `${resourceKind}:${label}`;
            add({ id, name: label, kind: resourceKind });
            edge('requires', d.id, id, requirement.source_ref ?? d.source_ref);
          }
        }
        if (d.target_ref) edge('dispatches', d.id, d.target_ref, d.source_ref);
      }
    }
    for (const i of air.imports ?? []) {
      edge('imports', module, `module:${i.from_module}`, i.source_ref, { target_ref: i.target_ref });
    }
    for (const graph of air.execution_graphs ?? []) {
      const format = expressionFormatter(graph, air.definitions.constants);
      for (const n of graph.nodes) {
        const details = {};
        for (const key of ['target_ref', 'result_binding', 'condition_ref', 'collection_ref', 'item_binding', 'max_concurrency', 'max_items', 'approval_policy', 'interaction_mode']) {
          if (n[key] !== undefined) details[key] = n[key];
        }
        for (const key of ['condition_ref', 'collection_ref']) if (n[key]) details[key] = { expression: format(n[key]) };
        if (n.context_refs?.length) details.context = n.context_refs.map(ref => ({ expression: format(ref) }));
        if (n.arguments?.length) {
          const target = Object.values(air.definitions).flat().find(d => d.id === n.target_ref);
          details.arguments = Object.fromEntries(n.arguments.map((arg, index) => [target?.signature?.inputs?.[index]?.name ?? String(index + 1), { expression: format(arg) }]));
        }
        add({ ...common, id: n.id, kind: n.kind, name: n.kind, owner: graph.owner_ref, graph: graph.id, source_ref: n.source_ref, details });
        if (n.kind === 'human_approval') edge('approval_site', graph.owner_ref, n.id, n.source_ref);
        if (n.id === graph.entry_node_id) edge('entry', graph.owner_ref, n.id, n.source_ref);
        if (n.target_ref) {
          edge('calls', n.id, n.target_ref, n.source_ref);
          edge('invokes', graph.owner_ref, n.target_ref, n.source_ref, { operation: n.kind });
        }
      }
      for (const e of graph.edges) edge('flow', e.from_node_id, e.to_node_id, e.source_ref, { role: e.role });
      for (const f of graph.failure_paths ?? []) edge('recovery', f.trigger_node_id, f.target_node_id, f.source_ref, { role: f.mode });
    }
  }
  // Imported declarations have their own source module, even when included in an entry AIR.
  const moduleForSource = new Map([...nodes.values()].filter(n => n.kind === 'module').map(n => [n.source_ref?.source_id, n.id]));
  for (const node of nodes.values()) {
    if (!node.source_ref || node.kind === 'module') continue;
    const actual = moduleForSource.get(node.source_ref.source_id);
    if (actual) node.module = actual;
    node.package = files.find(f => f.path === node.source_ref.source_id)?.package ?? null;
  }
  const validEdges = [...edges.values()].filter(e => nodes.has(e.from) && nodes.has(e.to) && (e.kind !== 'contains' || nodes.get(e.to).module === e.from || nodes.get(e.from).kind === 'package'));
  return { schema_version: EXPLORER_VERSION, name, revision, nodes: [...nodes.values()], edges: validEdges, files: files.map(({ path, digest, package: pkg }) => ({ path, digest, package: pkg })) };
}
