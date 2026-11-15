import { constants, existsSync, lstatSync, openSync, fstatSync, readSync, closeSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { satisfiesPackageConstraint } from './package-constraints.mjs';

const MANIFEST = 'touba.package.json';
const NAME = /^[a-z_][a-z0-9_-]*(\.[a-z_][a-z0-9_-]*)+$/;
const HASH = /^sha256:[a-f0-9]{64}$/;
const hash = bytes => 'sha256:' + createHash('sha256').update(bytes).digest('hex');

export class PackageDependencyError extends Error {
  constructor(code) { super(code + ': verify the declared dependency, its installation lock and file inventory'); this.code = code; }
}
const fail = code => { throw new PackageDependencyError(code); };
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);

function resourcePath(root, resource) {
  if (typeof resource !== 'string' || resource.length > 240 || !/^[A-Za-z0-9_./@+ -]+$/.test(resource)
      || resource.split('/').some(part => !part || part === '.' || part === '..' || /[. ]$/.test(part))) fail('PackagePathInvalid');
  let path = root;
  for (const part of resource.split('/')) {
    path = join(path, part);
    if (lstatSync(path).isSymbolicLink()) fail('PackageSymlinkForbidden');
  }
  return path;
}

function bytes(path, limit) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.size > limit) fail('PackageIntegrityMismatch');
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = fstatSync(fd);
    if (!opened.isFile() || opened.size > limit) fail('PackageIntegrityMismatch');
    const buffer = Buffer.alloc(Math.min(limit + 1, 65536)), chunks = [];
    let size = 0, count;
    while ((count = readSync(fd, buffer, 0, Math.min(buffer.length, limit + 1 - size))) > 0) {
      size += count;
      if (size > limit) fail('PackageIntegrityMismatch');
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
    return Buffer.concat(chunks, size);
  } finally { closeSync(fd); }
}

function verify(root, entry) {
  if (!Array.isArray(entry.files) || entry.files.length < 1 || entry.files.length > 4096 || !HASH.test(entry.digest ?? '')) fail('PackageLockInvalid');
  const known = new Set(), inventory = [];
  let total = 0;
  for (const item of entry.files) {
    if (!object(item) || Object.keys(item).sort().join(',') !== 'digest,path,size'
        || !Number.isSafeInteger(item.size) || item.size < 0 || item.size > 16 * 1024 * 1024
        || !HASH.test(item.digest ?? '') || typeof item.path !== 'string' || known.has(item.path.toLowerCase())) fail('PackageLockInvalid');
    total += item.size;
    if (total > 64 * 1024 * 1024) fail('PackageLockInvalid');
    known.add(item.path.toLowerCase());
    const content = bytes(resourcePath(root, item.path), item.size);
    if (content.length !== item.size || hash(content) !== item.digest) fail('PackageIntegrityMismatch');
    inventory.push({ path: item.path, size: item.size, digest: item.digest });
  }
  if (hash(JSON.stringify(inventory)) !== entry.digest || !known.has(MANIFEST)) fail('PackageIntegrityMismatch');
  const manifest = JSON.parse(bytes(resourcePath(root, MANIFEST), 1024 * 1024));
  if (manifest.name !== entry.name || manifest.version !== entry.version) fail('PackageIntegrityMismatch');
}

/** Resolve an inventoried resource, never execute it or grant access to it.
 * The caller supplies its own manifest explicitly (usually relative to import.meta.url).
 * Both layouts are fixed: author/packages/<name> or workspace/packages/<name>.
 * Confinement must separately allow the lock, manifests and inventoried files.
 */
export function resolvePackageResource(manifestPath, dependency, resource) {
  try {
    if (manifestPath instanceof URL) manifestPath = fileURLToPath(manifestPath);
    if (typeof manifestPath !== 'string' || !isAbsolute(manifestPath) || basename(manifestPath) !== MANIFEST || !NAME.test(dependency ?? '')) fail('PackageDependencyInvalid');
    if (lstatSync(dirname(manifestPath)).isSymbolicLink()) fail('PackageSymlinkForbidden');
    const root = realpathSync(dirname(manifestPath));
    const owner = JSON.parse(bytes(resourcePath(root, MANIFEST), 1024 * 1024));
    if (!['touba-package-v1', 'touba-package-v2'].includes(owner.package_schema_version) || !NAME.test(owner.name ?? '')
        || !object(owner.dependencies) || !Object.hasOwn(owner.dependencies, dependency)) fail('PackageDependencyUndeclared');
    const installed = basename(dirname(root)) === 'packages';
    const workspace = installed ? dirname(dirname(root)) : root;
    if (existsSync(join(workspace, '.touba-package-installing'))) fail('PackageInstallationIncomplete');
    const lock = JSON.parse(bytes(resourcePath(workspace, 'touba.packages.lock.json'), 8 * 1024 * 1024));
    if (lock.lock_schema_version !== 'touba-package-lock-v1' || !Array.isArray(lock.packages) || lock.packages.length > 1024) fail('PackageLockInvalid');
    const names = new Set();
    for (const entry of lock.packages) {
      if (!object(entry) || !NAME.test(entry.name ?? '') || names.has(entry.name)
          || entry.manifest !== `packages/${entry.name}/${MANIFEST}` || typeof entry.version !== 'string') fail('PackageLockInvalid');
      names.add(entry.name);
    }
    if (installed) {
      const own = lock.packages.find(entry => entry.name === owner.name);
      if (!own || basename(root) !== owner.name) fail('PackageLockInvalid');
      verify(root, own);
    }
    const entry = lock.packages.find(entry => entry.name === dependency);
    if (!entry || !satisfiesPackageConstraint(entry.version, owner.dependencies[dependency], owner.package_schema_version)) fail('PackageDependencyMissing');
    const target = dirname(resourcePath(workspace, entry.manifest));
    verify(target, entry);
    if (!entry.files.some(item => item.path === resource)) fail('PackageResourceUndeclared');
    return resourcePath(target, resource);
  } catch (error) {
    if (error instanceof PackageDependencyError) throw error;
    fail('PackageDependencyInvalid');
  }
}
