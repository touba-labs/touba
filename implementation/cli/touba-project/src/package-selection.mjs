import { packageError } from './package-contract.mjs';
import { satisfiesPackageConstraint } from '../../../runtime/touba-handler-sdk/src/package-constraints.mjs';

// Resolve only supplied and already verified installed candidates. Author
// archives remain unchanged; the resulting application graph is reviewed.
export function selectPackageClosure(roots, checks, installed, { preferInstalled = false } = {}) {
  const candidates = new Map(), identities = new Map();
  for (const pkg of [...installed.values(), ...checks.flatMap(check => check.closure.packages)]) {
    const { name, version } = pkg.document, identity = `${name}@${version}`;
    if (identities.has(identity) && identities.get(identity) !== pkg.digest) {
      throw Object.assign(packageError('PackageVersionConflict', `${identity} has different content; equal versions are immutable`), { reason: 'package_version_immutable' });
    }
    identities.set(identity, pkg.digest);
  }
  for (const check of checks) for (const pkg of check.closure.packages) {
    const name = pkg.document.name;
    if (roots.has(name)) continue;
    if (!candidates.has(name)) candidates.set(name, new Map());
    candidates.get(name).set(pkg.digest, pkg);
  }
  const selected = new Map(roots), reconsider = new Set();
  function bundled(name) {
    const choices = candidates.get(name);
    if (choices?.size !== 1) throw packageError('PackageDependencyConflict', `ambiguous bundled dependency ${name}; select its exact replacement explicitly`);
    return choices.values().next().value;
  }
  function reachable() {
    const closure = new Map(), active = new Set();
    function visit(name) {
      if (active.has(name)) throw packageError('PackageDependencyCycle', `dependency cycle at ${name}`);
      if (closure.has(name)) return;
      if (!selected.has(name) && candidates.has(name)) {
        if (preferInstalled && installed.has(name)) {
          selected.set(name, installed.get(name)); reconsider.add(name);
        } else selected.set(name, bundled(name));
      }
      const pkg = selected.get(name) ?? installed.get(name);
      if (!pkg) throw packageError('PackageDependencyMissing', `select an exact source for ${name}`);
      active.add(name);
      for (const child of Object.keys(pkg.document.dependencies ?? {}).sort()) visit(child);
      active.delete(name); closure.set(name, pkg);
    }
    for (const name of [...roots.keys()].sort()) visit(name);
    return closure;
  }
  // Only reachable candidates constrain the proposal. An unused bundled
  // parent must not displace an installed child or create an ambiguity.
  // Existing packages remain consumers because this operation removes none.
  // Each installed candidate falls back at most once, bounding this selection.
  for (;;) {
    const closure = reachable(), consumers = new Map([...installed, ...closure]);
    const fallback = [...reconsider].filter(name => closure.has(name) && [...consumers.values()].some(pkg =>
      Object.hasOwn(pkg.document.dependencies ?? {}, name)
      && !satisfiesPackageConstraint(installed.get(name).document.version, pkg.document.dependencies[name], pkg.document.package_schema_version))).sort();
    if (!fallback.length) return [...closure.values()].sort((a, b) => a.document.name.localeCompare(b.document.name));
    for (const name of fallback) { selected.set(name, bundled(name)); reconsider.delete(name); }
  }
}
