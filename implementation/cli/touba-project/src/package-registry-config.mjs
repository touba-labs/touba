import { lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { packageError, packagePath } from './package-contract.mjs';
import { assertAuthorWritable, assertPlainDirectory, findPackageWorkspace } from './package-store.mjs';
import { publicationUrl } from './package-identity.mjs';
import { registryTrustState, trustedKeys } from './registry-trust-state.mjs';
import { packageLocale } from './package-diagnostics.mjs';

const CONFIG = 'registry.json';
const SHARED = 'touba.registry.json';
function ignoreLocalRegistryState(root, portable) {
  const path = join(root, '.gitignore');
  let current = '';
  if (present(path)) {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 65536) throw packageError('RegistryConfigurationInvalid', '.gitignore must be a bounded regular file');
    current = readFileSync(path, 'utf8');
  }
  const literal = '/' + portable.replace(/[\\[\]*?!# ]/g, '\\$&');
  const entries = ['.sqlite', '.status.sqlite'].flatMap(suffix => ['', '-wal', '-shm'].map(sidecar => literal + suffix + sidecar));
  const lines = new Set(current.split(/\r?\n/));
  const missing = entries.filter(entry => !lines.has(entry));
  if (missing.length) writeFileSync(path, current + (current && !current.endsWith('\n') ? '\n' : '') + missing.join('\n') + '\n');
}
function present(path) {
  try { lstatSync(path); return true; } catch (error) { if (error.code === 'ENOENT') return false; throw error; }
}
function regularJson(path, maximum) {
  const info = lstatSync(path);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maximum) throw packageError('RegistryConfigurationInvalid', 'registry configuration must be a bounded regular file');
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw packageError('RegistryConfigurationInvalid', 'invalid registry configuration'); }
}

export function configuredRegistry(root = process.cwd()) {
  root = findPackageWorkspace(root);
  // A reviewed portable configuration takes precedence over old local setup.
  // Only the registry URL and a relative public-key path are shared, never
  // tokens, user identity, cached signed responses or mutable continuity state.
  if (present(join(root, SHARED))) {
    const value = regularJson(join(root, SHARED), 8192);
    if (!value || Object.keys(value).sort().join(',') !== 'registry,schema_version,trust'
      || value.schema_version !== 'touba-registry-project-v1' || typeof value.registry !== 'string'
      || publicationUrl(value.registry) !== value.registry || typeof value.trust !== 'string') throw packageError('RegistryConfigurationInvalid', 'invalid shared registry configuration');
    packagePath(value.trust); assertPlainDirectory(dirname(join(root, value.trust)));
    regularJson(join(root, value.trust), 65536);
    return { registry: value.registry, trust: join(root, value.trust) };
  }
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

export function configureRegistry(registry, { root = process.cwd(), trust, shared = false } = {}) {
  root = findPackageWorkspace(root); assertAuthorWritable(root);
  registry = publicationUrl(registry);
  if (!trust || /^https?:/.test(trust)) throw packageError('RegistryTrustRequired', 'select a local key file verified through a trusted channel with --trust');
  trust = resolve(trust);
  let document;
  try { document = regularJson(trust, 65536); }
  catch (error) {
    if (error.code === 'RegistryConfigurationInvalid') throw error;
    throw packageError('RegistryTrustInvalid', 'select a readable bounded local registry trust file');
  }
  const keys = trustedKeys(document, registry);
  trust = realpathSync(trust);
  let portable;
  if (shared) {
    portable = relative(root, trust).replaceAll('\\', '/'); packagePath(portable);
    assertPlainDirectory(dirname(join(root, portable)));
    ignoreLocalRegistryState(root, portable);
  } else if (present(join(root, SHARED))) throw packageError('RegistrySharedConfigurationPresent', 'review the shared configuration with --shared or pass a per-command --registry override');
  // Reuse the exact continuity store used for installation. Reconfiguration
  // does not reset index revisions or resurrect revoked keys.
  registryTrustState(trust + '.sqlite', registry).observe(keys);
  const folder = join(root, '.touba'); assertPlainDirectory(folder);
  mkdirSync(folder, { recursive: true, mode: 0o700 });
  const path = shared ? join(root, SHARED) : join(folder, CONFIG);
  try { regularJson(path, 8192); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  const staging = mkdtempSync(join(folder, '.registry-'));
  try {
    writeFileSync(join(staging, CONFIG), JSON.stringify({ schema_version: shared ? 'touba-registry-project-v1' : 'touba-registry-configuration-v1', registry, trust: portable ?? trust }) + '\n', { flag: 'wx', mode: 0o600 });
    renameSync(join(staging, CONFIG), path);
  } finally { rmSync(staging, { recursive: true, force: true }); }
  return { command: 'package registry', status: 'success', registry, trust, ...(shared ? { shared: SHARED } : {}),
    fingerprints: keys.map(key => ({ id: key.id, sha256: key.fingerprint, status: key.status })),
    notes: [packageLocale() === 'fr' ? 'Registre configuré pour ce projet. Conservez le fichier de confiance revu et sa base de continuité. Installez avec touba package add organisation.package@version.' : 'Registry configured for this workspace. Keep the reviewed trust file and its continuity database. Install with touba package add organization.package@version.',
      ...(shared ? [packageLocale() === 'fr' ? 'Versionnez touba.registry.json et le fichier de clés publiques revu. Excluez de Git les fichiers de cache/continuité .sqlite et leurs annexes, mais conservez-les localement : ils empêchent les retours à un ancien état signé.' : 'Version touba.registry.json and the reviewed public-key file. Exclude the .sqlite cache/continuity files and their sidecars from Git, but retain them locally: they prevent rollback to an older signed state.'] : [])] };
}

export function registryOptions(options) {
  const configured = configuredRegistry(options.root);
  if (!configured) return options;
  const registry = options.registry ?? configured.registry;
  return { ...options, registry, ...(options.trust || registry !== configured.registry ? {} : { trust: configured.trust }) };
}
