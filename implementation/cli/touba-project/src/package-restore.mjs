// Explicit restoration of absent managed directories from the exact lock.
// Never overwrite a present directory, execute handlers, rewrite a lock, or
// fall back to a newer/withdrawn version.
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { PACKAGE_LIMITS, PACKAGE_NAME, packageDigest, packageError, readPackage } from './package-contract.mjs';
import { PACKAGE_LOCK, PACKAGE_TRANSACTION, acquirePackageTransaction, assertAuthorWritable, assertPlainDirectory,
  findPackageWorkspace, readPackageLock, readPackageWorkspace, verifyInstalledPackages } from './package-store.mjs';
import { copyPackage, resolveRegistryArchive, unpackPackage } from './packages.mjs';
import { createRegistryReader } from './package-fetch.mjs';

export async function restorePackages(name, options = {}) {
  if (name && !PACKAGE_NAME.test(name)) throw packageError('PackageNameInvalid', 'select an exact installed package name');
  const root = findPackageWorkspace(options.root); assertAuthorWritable(root);
  const workspace = readPackageWorkspace(root), lock = readPackageLock(root);
  const lockBytes = readFileSync(join(root, PACKAGE_LOCK));
  const targets = lock.packages.filter(entry => (!name || entry.name === name) && !existsSync(join(root, dirname(entry.manifest))));
  if (name && !lock.packages.some(entry => entry.name === name)) throw packageError('PackageNotInstalled', 'package is not in the lock');
  if (targets.length > 128) throw packageError('PackageTooLarge', 'restore at most 128 packages');
  for (const entry of lock.packages) assertPlainDirectory(join(root, dirname(entry.manifest)));
  // Keep strict verification for everything not selected for restoration.
  // Missing entries remain visible; no hidden bypass is used by execution.
  verifyInstalledPackages(root, workspace.records, { allowMissing: true });
  if (!targets.length) return { command: 'package restore', status: 'success', packages: [] };
  if (!options.registry) throw packageError('RegistryConfigurationRequired', 'select the trusted original registry');
  const trustBytes = options.trust ? readFileSync(options.trust) : null;
  const reader = createRegistryReader(options.registry, { noBrowser: options['no-browser'], sessionOnly: options['session-only'] });
  const staging = mkdtempSync(join(root, '.touba-package-restore-'));
  const installed = []; let transaction = false, total = 0;
  try {
    for (const [index, entry] of targets.entries()) {
      const { artifact, location } = await resolveRegistryArchive(entry.name, { ...options, version: entry.version }, reader.readBytes);
      const bytes = await reader.readBytes(location, PACKAGE_LIMITS.totalBytes);
      total += bytes.length;
      if (total > PACKAGE_LIMITS.totalBytes) throw packageError('PackageTooLarge', 'restore batch exceeds the byte limit');
      if (packageDigest(bytes) !== artifact.digest) throw Object.assign(packageError('PackageIntegrityMismatch', 'archive differs from registry'), { packageName: entry.name });
      const archive = join(staging, `${index}.tar.gz`); writeFileSync(archive, bytes, { flag: 'wx', mode: 0o600 });
      const unpacked = unpackPackage(archive, join(staging, `unpack-${index}`));
      const pkg = readPackage(unpacked);
      if (pkg.document.name !== entry.name || pkg.document.version !== entry.version || pkg.digest !== entry.digest
        || JSON.stringify(pkg.files) !== JSON.stringify(entry.files)) throw Object.assign(packageError('PackageIntegrityMismatch', 'restoration source differs from the exact lock'), { packageName: entry.name });
      copyPackage(pkg, join(staging, entry.name));
    }
    acquirePackageTransaction(root, { pid: process.pid, staging, restore: targets.map(entry => entry.name) }); transaction = true;
    if (!readFileSync(workspace.path).equals(workspace.bytes) || !readFileSync(join(root, PACKAGE_LOCK)).equals(lockBytes)
      || trustBytes && !readFileSync(options.trust).equals(trustBytes)) throw packageError('PackageProjectChanged', 'project, lock or trust changed during restoration');
    // The marker excludes other Touba package writers. Recheck all targets,
    // including dangling links, before making any directory visible.
    for (const entry of targets) {
      const destination = join(root, dirname(entry.manifest)); assertPlainDirectory(destination);
      try { lstatSync(destination); throw packageError('PackageAlreadyExists', 'restore destination appeared during validation'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    mkdirSync(join(root, 'packages'), { recursive: true });
    for (const entry of targets) {
      const destination = join(root, dirname(entry.manifest));
      renameSync(join(staging, entry.name), destination); installed.push(destination);
    }
    return { command: 'package restore', status: 'success', packages: targets.map(({ name, version }) => ({ name, version })),
      lock_unchanged: true, project_unchanged: true };
  } catch (error) {
    for (const path of installed.reverse()) rmSync(path, { recursive: true, force: true });
    throw error;
  } finally {
    if (transaction) rmSync(join(root, PACKAGE_TRANSACTION));
    rmSync(staging, { recursive: true, force: true });
    await reader.close();
  }
}
