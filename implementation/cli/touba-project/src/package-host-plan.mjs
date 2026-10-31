import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { readPackage, packageFile, packageError } from './package-contract.mjs';
import { readPackageWorkspace, verifyInstalledPackages } from './package-store.mjs';
import { resolvePackageHost } from './package-hosts.mjs';

export const PACKAGE_HOST_PLAN = 'touba.hosts.json';
const kinds = ['human_approval', 'decision_provider'];
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const fail = message => { throw packageError('PackageHostPlanInvalid', message); };

/** Metadata only. Inspecting, reviewing or installing never imports host code. */
export function packageHostInventory(root) {
  const workspace = readPackageWorkspace(root);
  const lock = verifyInstalledPackages(root, workspace.records);
  const identities = lock.packages.map(({ name, version, digest }) => [name, version, digest])
    .sort((a, b) => a[0].localeCompare(b[0]));
  const package_lock_digest = `sha256:${createHash('sha256').update(JSON.stringify(identities)).digest('hex')}`;
  const hosts = lock.packages.flatMap(item => {
    const pkg = readPackage(packageFile(root, `packages/${item.name}/touba.package.json`));
    return (pkg.document.hosts ?? []).map(host => ({
      ref: `pkg:${item.name}/${host.id}`, kind: host.kind,
      language: host.path.endsWith('.py') ? 'python' : 'javascript',
      package: item.name, version: item.version, digest: item.digest,
    }));
  });
  return { package_lock_digest, hosts };
}

export function validatePackageHostPlan(document, root, inventory = packageHostInventory(root)) {
  if (!object(document) || Object.keys(document).some(key => !['schema_version', 'package_lock_digest', 'hosts'].includes(key))
    || document.schema_version !== 'touba-package-host-plan-v1' || !object(document.hosts)
    || Object.keys(document.hosts).some(kind => !kinds.includes(kind))) fail('invalid host plan; select declared package hosts only');
  if (document.package_lock_digest !== inventory.package_lock_digest) fail('installed packages changed; review the host plan again');
  for (const [kind, ref] of Object.entries(document.hosts)) {
    if (!inventory.hosts.some(host => host.ref === ref && host.kind === kind)) fail('host selection does not match the installed package role');
    resolvePackageHost(ref, kind, root);
  }
  return document;
}

export function readPackageHostPlan(root, { required = false, inventory } = {}) {
  if (!existsSync(join(root, PACKAGE_HOST_PLAN))) {
    if (required) fail('review touba.hosts.json before starting with --package-hosts');
    return null;
  }
  const path = packageFile(root, PACKAGE_HOST_PLAN);
  if (statSync(path).size > 16384) fail('host plan exceeds 16 KiB');
  let document;
  try { document = JSON.parse(readFileSync(path, 'utf8')); } catch { fail('host plan must be valid JSON'); }
  return validatePackageHostPlan(document, root, inventory);
}
