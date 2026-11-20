import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { PACKAGE_MANIFEST, PACKAGE_NAME, exactPackageVersion, inspectInstalledPackage, isWithin, packageError, packageFile, readPackage } from "./package-contract.mjs";
import { satisfiesPackageConstraint } from '../../../runtime/touba-handler-sdk/src/package-constraints.mjs';

export const PACKAGE_LOCK = "touba.packages.lock.json";
export const PACKAGE_TRANSACTION = ".touba-package-installing";
export const PACKAGE_LOCK_SCHEMA = "touba-package-lock-v1";

export function acquirePackageTransaction(root, record) {
  try { writeFileSync(join(root, PACKAGE_TRANSACTION), JSON.stringify(record) + '\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) {
    if (error.code === 'EEXIST') throw packageError('PackageInstallationIncomplete', 'another package operation owns the transaction marker');
    throw error;
  }
}

export function assertPackageDirectory(root) {
  if (existsSync(root)) {
    for (const name of readdirSync(root)) {
      if (name.toLowerCase() === "packages" && name !== "packages") throw packageError("PackagePathCollision", "packages is reserved; remove the case-conflicting entry before continuing");
    }
  }
  // The user-selected workspace may itself use an OS alias (/var on macOS).
  // Resolve only that boundary, never the managed packages directory.
  let ancestor = resolve(root);
  const missing = [];
  while (!existsSync(ancestor)) {
    try { if (lstatSync(ancestor).isSymbolicLink()) throw packageError("PackageSymlinkForbidden", "workspace traverses a dangling link"); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    missing.unshift(ancestor.slice(dirname(ancestor).length + 1));
    ancestor = dirname(ancestor);
  }
  assertPlainDirectory(join(realpathSync(ancestor), ...missing, "packages"));
}

export function findPackageWorkspace(start = process.cwd(), { author = false } = {}) {
  let current;
  try { current = realpathSync(start); }
  catch (error) {
    if (!['ENOENT', 'ENOTDIR', 'EACCES', 'EPERM'].includes(error.code)) throw error;
    throw packageError(author ? 'PackageAuthorRequired' : 'PackageProjectRequired', 'select an accessible existing project directory');
  }
  if (!lstatSync(current).isDirectory()) current = dirname(current);
  for (;;) {
    if (existsSync(join(current, PACKAGE_MANIFEST))) return current;
    if (existsSync(join(current, "touba.project.json"))) {
      if (!author) return current;
      break;
    }
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  throw packageError(author ? "PackageAuthorRequired" : "PackageProjectRequired", author ? "run this command inside a package author project" : "run touba init or enter a Touba project first");
}

export function assertAuthorWritable(root) {
  for (let current = existsSync(root) ? realpathSync(root) : resolve(root); dirname(current) !== current; current = dirname(current)) {
    const parent = dirname(current), workspace = dirname(parent);
    if (parent.split(/[\\/]/).at(-1) === "packages" &&
        [PACKAGE_MANIFEST, "touba.project.json"].some(file => existsSync(join(workspace, file)))) {
      throw packageError("PackageInstalledReadOnly", "develop in a separate author project, not inside managed packages/");
    }
  }
}

export function readPackageWorkspace(root) {
  assertPackageDirectory(root);
  const author = existsSync(join(root, PACKAGE_MANIFEST));
  if (author && existsSync(join(root, "touba.project.json"))) throw packageError("PackageWorkspaceAmbiguous", "keep one workspace manifest: author package or application, not both");
  const path = join(root, author ? PACKAGE_MANIFEST : "touba.project.json");
  if (!existsSync(path) || !lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw packageError("PackageProjectRequired", "workspace manifest must be a regular file");
  const bytes = readFileSync(path), document = JSON.parse(bytes);
  if (author) {
    assertAuthorWritable(root);
    readPackage(path);
  } else if (document.project_version !== "touba-project-v1" || !Array.isArray(document.packages ?? [])) throw packageError("PackageProjectRequired", "invalid Touba project");
  const records = author ? packageDependencyRecords(root, document) : document.packages ?? [];
  return { path, bytes, document, records, author };
}

// The author declares direct dependencies; the lock inventories all managed
// packages, including transitives and retained, currently unused installations.
export function packageDependencyRecords(root, document) {
  const lock = readPackageLock(root);
  const records = Object.entries(document.dependencies ?? {}).map(([name, constraint]) => {
    const locked = lock.packages.find(entry => entry.name === name);
    if (!locked && !exactPackageVersion(constraint)) throw Object.assign(packageError('PackageDependencyConflict', 'dependency range has no exact installed selection'), {
      reason: 'PackageDependencySelectionMissing', packageName: name,
    });
    const selected = locked?.version ?? constraint;
    if (!satisfiesPackageConstraint(selected, constraint, document.package_schema_version)) throw packageError('PackageDependencyConflict', `${document.name} requires ${name}@${constraint}; select and lock an exact compatible version`);
    return { manifest: `packages/${name}/${PACKAGE_MANIFEST}`, version: selected };
  });
  for (const entry of lock.packages) {
    if (!records.some(record => record.manifest === entry.manifest)) records.push({ manifest: entry.manifest, version: entry.version });
  }
  return records;
}

export function setWorkspacePackages(workspace, records, { direct } = {}) {
  if (workspace.author) {
    const selected = new Set([...Object.keys(workspace.document.dependencies ?? {}), ...(Array.isArray(direct) ? direct : direct ? [direct] : [])]);
    workspace.document.dependencies = Object.fromEntries(records.filter(record => selected.has(record.manifest.split("/")[1])).map(record => {
      const name = record.manifest.split('/')[1], constraint = workspace.document.dependencies?.[name];
      return [name, constraint && !exactPackageVersion(constraint) ? constraint : record.version];
    }));
  }
  else workspace.document.packages = records;
}

export function assertPlainDirectory(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    let stat;
    try { stat = lstatSync(current); } catch (error) { if (error.code !== "ENOENT") throw error; }
    if (stat?.isSymbolicLink()) {
      throw packageError("PackageSymlinkForbidden", `package directory must not traverse a link: ${current}`);
    }
    if (stat && !stat.isDirectory()) throw packageError("PackageDirectoryRequired", `expected a directory, found a file: ${current}`);
    if (dirname(current) === current) break;
  }
}

export function readPackageLock(root) {
  const path = join(root, PACKAGE_LOCK);
  if (!existsSync(path)) return { lock_schema_version: PACKAGE_LOCK_SCHEMA, packages: [] };
  if (lstatSync(path).isSymbolicLink()) throw packageError("PackageSymlinkForbidden", "installation lock cannot be a link");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw packageError("PackageLockInvalid", "package installation lock is unreadable or invalid JSON"); }
  if (value.lock_schema_version !== PACKAGE_LOCK_SCHEMA || !Array.isArray(value.packages)) throw packageError("PackageLockInvalid", "invalid package installation lock");
  const names = new Set();
  for (const item of value.packages) {
    if (!item || !PACKAGE_NAME.test(item.name ?? "") || !exactPackageVersion(item.version) || !/^sha256:[a-f0-9]{64}$/.test(item.digest ?? "") || names.has(item.name) || item.manifest !== `packages/${item.name}/${PACKAGE_MANIFEST}` || !Array.isArray(item.files)) throw packageError("PackageLockInvalid", "invalid or duplicate package lock entry");
    names.add(item.name);
  }
  return value;
}

export function verifyInstalledPackages(root, records, options) {
  return verifyInstalledInventory(root, records, readPackage, options).lock;
}

export function inspectInstalledPackages(root, records, options) {
  return verifyInstalledInventory(root, records, inspectInstalledPackage, options);
}

function verifyInstalledInventory(root, records, read, { allowMissing = false } = {}) {
  root = realpathSync(root);
  assertPackageDirectory(root);
  if (existsSync(join(root, PACKAGE_TRANSACTION))) throw packageError("PackageInstallationIncomplete", "package installation is active or was interrupted; inspect .touba-package-installing before recovery");
  const lock = readPackageLock(root);
  const packages = new Map();
  const manifests = new Set();
  for (const record of records) {
    if (typeof record?.manifest !== "string") throw packageError("PackageLockMismatch", "project package needs a manifest path");
    const manifest = resolve(root, record.manifest);
    if (manifests.has(manifest)) throw packageError("PackageNameConflict", `duplicate project package ${record.manifest}`);
    manifests.add(manifest);
  }
  for (const entry of lock.packages) {
    if (!records.some(record => resolve(root, record.manifest) === resolve(root, entry.manifest) && record.version === entry.version && record.editable !== true)) throw packageError("PackageLockMismatch", `project and installation lock disagree on ${entry.name}; an installed package cannot be editable`);
  }
  for (const record of records) {
    if (typeof record?.manifest !== "string") continue;
    const manifest = resolve(root, record.manifest);
    if (record.editable === true) {
      if (isWithin(join(root, "packages"), manifest)) throw packageError("PackageInstalledReadOnly", "editable sources must be outside managed packages/");
      continue;
    }
    if (!isWithin(join(root, "packages"), manifest)) continue;
    const entry = lock.packages.find(p => resolve(root, p.manifest) === manifest);
    if (!entry) throw packageError("PackageNotInstalled", `run touba package add ${relative(root, dirname(manifest))} to verify and register this package`);
    assertPlainDirectory(dirname(manifest));
    if (allowMissing && !existsSync(dirname(manifest))) {
      packages.set(manifest, { document: { name: entry.name, version: entry.version },
        restrictions: [{ code: 'PackageInstalledContentMissing' }], missing: true });
      continue;
    }
    let pkg;
    try { pkg = read(manifest); }
    catch (error) {
      if (error.code === 'ENOENT') error = packageError('PackageInstalledContentMissing', 'locked package content is missing');
      error.installedPackageContext = true; error.packageName = entry.name; throw error;
    }
    if (pkg.document.name !== entry.name || pkg.document.version !== entry.version || record.version !== entry.version || pkg.digest !== entry.digest || JSON.stringify(pkg.files) !== JSON.stringify(entry.files)) throw Object.assign(packageError("PackageIntegrityMismatch", `installed package ${entry.name} differs from its lock`), { packageName: entry.name });
    assertOnlyInventory(pkg);
    packages.set(manifest, pkg);
  }
  return { lock, packages };
}

export function assertOnlyInventory(pkg) {
  const known = new Set(pkg.files.map(file => file.path));
  function walk(dir, prefix = "") {
    for (const name of readdirSync(dir)) {
      const path = prefix ? `${prefix}/${name}` : name;
      const absolute = packageFile(pkg.root, path);
      if (lstatSync(absolute).isDirectory()) walk(absolute, path);
      else if (!known.has(path)) throw packageError("PackageUnexpectedFile", `undeclared installed file ${path}`);
    }
  }
  walk(pkg.root);
}
