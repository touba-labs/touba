const fail = (code, details = {}) => { throw Object.assign(new Error(code), { code, details }); };

// Resolve maintenance responsibilities from exact compiled membership. This
// never copies reviews or changes execution permissions.
export function resolveOwnershipInheritance({ document, owners, knownTargets, modules, packages }) {
  const selected = document.inherit_owners ?? [];
  if (!Array.isArray(selected) || selected.length > 256 || new Set(selected).size !== selected.length
    || selected.some(ref => typeof ref !== 'string' || !/^(module|package):[^*\s]+$/.test(ref))) {
    fail('OwnershipInheritanceInvalid');
  }
  const result = new Map([...owners].map(([ref, teams]) => [ref, { target_ref: ref,
    teams: [...new Set(teams)].sort(), origin_refs: [ref], inherited: false }]));
  const candidates = new Map();
  for (const from of selected) {
    if (!knownTargets.has(from) || !owners.has(from) || !owners.get(from).length) fail('OwnershipInheritanceSourceMissing', { target_ref: from });
    const members = from.startsWith('module:') ? modules.get(from) : packages.get(from);
    if (!members) fail('OwnershipInheritanceSourceMissing', { target_ref: from });
    for (const ref of members) {
      if (!knownTargets.has(ref) || owners.has(ref)) continue;
      const list = candidates.get(ref) ?? [];
      list.push({ from, teams: [...new Set(owners.get(from))].sort() }); candidates.set(ref, list);
    }
  }
  for (const [ref, list] of candidates) {
    if (list.some(item => JSON.stringify(item.teams) !== JSON.stringify(list[0].teams))) {
      fail('OwnershipInheritanceConflict', { target_ref: ref, origin_refs: list.map(item => item.from).sort() });
    }
    result.set(ref, { target_ref: ref, teams: list[0].teams, origin_refs: list.map(item => item.from).sort(), inherited: true });
  }
  if (result.size > 4096) fail('OwnershipInheritanceLimit');
  return [...result.values()].sort((a, b) => a.target_ref.localeCompare(b.target_ref));
}

export function ownershipMembership(documents, packageEntries = []) {
  const modules = new Map(), packages = new Map();
  for (const doc of documents) {
    const module = doc.module?.id;
    if (typeof module !== 'string') continue;
    const members = modules.get(module) ?? new Set();
    for (const collection of ['tools', 'skills', 'strategies', 'agents', 'memories', 'triggers']) {
      for (const item of doc.definitions?.[collection] ?? []) if (typeof item.id === 'string') members.add(item.id);
    }
    modules.set(module, members);
  }
  for (const entry of packageEntries) {
    if (typeof entry.name !== 'string' || !Array.isArray(entry.modules)) continue;
    packages.set(`package:${entry.name}`, new Set(entry.modules.flatMap(name => {
      const ref = `module:${name}`;
      return modules.has(ref) ? [ref, ...modules.get(ref)] : [];
    })));
  }
  return { modules, packages };
}
