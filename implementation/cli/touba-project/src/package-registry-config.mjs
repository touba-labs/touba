import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { packageError } from './package-contract.mjs';
import { assertAuthorWritable, assertPlainDirectory, findPackageWorkspace } from './package-store.mjs';
import { publicationUrl } from './package-identity.mjs';
import { registryTrustState, trustedKeys } from './registry-trust-state.mjs';

const CONFIG = 'registry.json';
function regularJson(path, maximum) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw packageError('RegistryConfigurationInvalid', 'registry configuration must be a bounded regular file');
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw packageError('RegistryConfigurationInvalid', 'invalid registry configuration'); }
}

export function configuredRegistry(root = process.cwd()) {
  root = findPackageWorkspace(root);
  const folder = join(root, '.touba'); assertPlainDirectory(folder);
  const path = join(folder, CONFIG);
  let value;
  try { value = regularJson(path, 8192); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
  if (!value || Object.keys(value).sort().join(',') !== 'registry,schema_version,trust' || value.schema_version !== 'touba-registry-configuration-v1'
    || typeof value.registry !== 'string' || publicationUrl(value.registry) !== value.registry || typeof value.trust !== 'string' || resolve(value.trust) !== value.trust) {
    throw packageError('RegistryConfigurationInvalid', 'run touba package registry with the reviewed registry and trust file');
  }
  return { registry: value.registry, trust: value.trust };
}

export function configureRegistry(registry, { root = process.cwd(), trust } = {}) {
  root = findPackageWorkspace(root); assertAuthorWritable(root);
  registry = publicationUrl(registry);
  if (!trust || /^https?:/.test(trust)) throw packageError('RegistryTrustRequired', 'select a local key file verified through a trusted channel with --trust');
  trust = resolve(trust);
  const keys = trustedKeys(regularJson(trust, 65536), registry);
  trust = realpathSync(trust);
  // Reuse the exact continuity store used for installation. Reconfiguration
  // does not reset index revisions or resurrect revoked keys.
  registryTrustState(trust + '.sqlite', registry).observe(keys);
  const folder = join(root, '.touba'); assertPlainDirectory(folder);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = join(folder, CONFIG);
  try { regularJson(path, 8192); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = mkdtempSync(join(folder, '.registry-'));
  try {
    writeFileSync(join(staging, CONFIG), JSON.stringify({ schema_version: 'touba-registry-configuration-v1', registry, trust }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(join(staging, CONFIG), path);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return { command: 'package registry', status: 'success', registry, trust,
    fingerprints: keys.map(key => ({ id: key.id, sha256: key.fingerprint, status: key.status })),
    notes: ['Registry configured for this workspace. Keep the reviewed trust file and its continuity database. Install with touba package add organization.package@version.'] };
}

export function registryOptions(options) {
  const configured = configuredRegistry(options.root);
  if (!configured) return options;
  const registry = options.registry ?? configured.registry;
  return { ...options, registry, ...(options.trust || registry !== configured.registry ? {} : { trust: configured.trust }) };
}
