import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import * as tar from "tar";
import semver from "semver";
import { PACKAGE_LIMITS, PACKAGE_MANIFEST, PACKAGE_NAME, PACKAGE_RUNTIME_VERSION as runtimeVersion, assertPackageUnchanged, packageDigest, packageError, packageFile, packagePath, readPackage } from "./package-contract.mjs";
import { PACKAGE_LOCK, PACKAGE_TRANSACTION, assertAuthorWritable, assertOnlyInventory, assertPlainDirectory, assertPackageDirectory, findPackageWorkspace, readPackageWorkspace, setWorkspacePackages, verifyInstalledPackages } from "./package-store.mjs";
export { newPackage } from "./package-author.mjs";
import { resolveRegistryPackage } from "./registry.mjs";
import { createRegistryReader } from "./package-fetch.mjs";

const json = value => JSON.stringify(value, null, 2) + "\n";

// Validate a distribution without installing it or running contributor code.
// The archive and its bounded extraction use the same checks as installation.
export async function checkPackageArchive(archive, options = {}) {
  const staging = mkdtempSync(join(tmpdir(), "touba-package-check-"));
  try {
    const stat = lstatSync(archive);
    if (!stat.isFile() || stat.isSymbolicLink()) throw packageError("PackageArchiveInvalid", "archive must be a regular file");
    if (stat.size > PACKAGE_LIMITS.totalBytes) throw packageError("PackageTooLarge", "archive exceeds limit");
    const bytes = readFileSync(archive);
    if (bytes.length > PACKAGE_LIMITS.totalBytes) throw packageError("PackageTooLarge", "archive exceeds limit");
    const snapshot = join(staging, "package.tar.gz");
    writeFileSync(snapshot, bytes, { flag: "wx", mode: 0o600 });
    const path = unpackPackage(snapshot, join(staging, "contents"));
    const checked = await checkPackage(path, options);
    const manifest = checked.closure.first.document;
    const readme = manifest.readme ? readFileSync(packageFile(path, manifest.readme), "utf8") : "";
    delete checked.closure;
    return { ...checked, manifest, readme: readme.slice(0, 65536), readme_truncated: readme.length > 65536,
      archive_digest: packageDigest(bytes) };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

// Exact closure, supplied inside the root package or already present in the
// consuming project. No ambient workspace search, latest selection or network.
export function packageClosure(path, { projectRoot, publishing = false } = {}) {
  const first = readPackage(path, { runtimeVersion, publishing });
  const packages = new Map();
  const active = new Set();
  function visit(pkg) {
    const { name, version } = pkg.document;
    if (active.has(name)) throw packageError("PackageDependencyCycle", `dependency cycle at ${name}`);
    const previous = packages.get(name);
    if (previous) {
      if (previous.document.version !== version || previous.digest !== pkg.digest) throw packageError("PackageDependencyConflict", `conflicting package ${name}`);
      return;
    }
    if (!pkg.requirements.compatible) throw packageError("PackageRequirementMissing", pkg.requirements.missing.join("; "));
    packages.set(name, pkg); active.add(name);
    if (packages.size > 128 || [...packages.values()].reduce((sum, item) => sum + item.files.reduce((n, file) => n + file.size, 0), 0) > PACKAGE_LIMITS.totalBytes) throw packageError("PackageTooLarge", "dependency closure exceeds limits");
    for (const [dependency, expected] of Object.entries(pkg.document.dependencies ?? {})) {
      if (active.has(dependency)) throw packageError("PackageDependencyCycle", `dependency cycle at ${dependency}`);
      const candidates = [join(pkg.root, "packages", dependency), join(first.root, "packages", dependency), ...(projectRoot ? [join(projectRoot, "packages", dependency)] : [])];
      const found = [...new Set(candidates)].filter(candidate => existsSync(join(candidate, PACKAGE_MANIFEST)));
      if (!found.length && !packages.has(dependency)) throw packageError("PackageDependencyMissing", `${name} requires ${dependency}@${expected}; supply it under packages/${dependency}`);
      for (const candidate of found) {
        const child = readPackage(candidate, { runtimeVersion, publishing });
        if (child.document.name !== dependency || child.document.version !== expected) throw packageError("PackageDependencyConflict", `expected ${dependency}@${expected}`);
        visit(child);
      }
      if (packages.get(dependency).document.version !== expected) throw packageError("PackageDependencyConflict", `expected ${dependency}@${expected}`);
    }
    active.delete(name);
  }
  visit(first);
  return { first, packages: [...packages.values()] };
}

export async function addRegistryPackage(name, options) {
  if (!PACKAGE_NAME.test(name) || !options.registry || !options.version) throw packageError("PackageRegistryOptionMissing", "use a qualified package name, --version and --registry");
  const reader = createRegistryReader(options.registry, { noBrowser: options['no-browser'] === true });
  try { return await installRegistryPackage(name, options, reader.readBytes); }
  finally { await reader.close(); }
}

async function installRegistryPackage(name, options, readBytes) {
  const resolution = await resolveRegistryPackage({ registry: options.registry, trust: options.trust, version: options.version, packageRef: `pkg:${name}`, allowDraft: options["allow-draft"] === true, readBytes });
  if (!semver.satisfies(runtimeVersion, resolution.compatibility.touba)) throw packageError("PackageVersionIncompatible", `registry requires Touba ${resolution.compatibility.touba}; installed ${runtimeVersion}`);
  if (resolution.package.kind !== "touba_package") throw packageError("PackageSchemaMismatch", "registry entry must describe a Touba package");
  const archives = resolution.artifacts.filter(artifact => artifact.kind === "package_archive");
  if (archives.length !== 1) throw packageError("PackageArchiveInvalid", "registry must supply exactly one package_archive artifact");
  const artifact = archives[0]; packagePath(artifact.path);
  const index = resolution.registry.index_ref;
  const location = /^https?:\/\//.test(index) ? new URL(artifact.path, new URL("./", index)).href : packageFile(dirname(resolve(index)), artifact.path);
  const bytes = await readBytes(location, PACKAGE_LIMITS.totalBytes);
  if (packageDigest(bytes) !== artifact.digest) throw packageError("PackageIntegrityMismatch", "registry archive digest mismatch");
  const staging = mkdtempSync(join(tmpdir(), "touba-package-fetch-"));
  try {
    const archive = join(staging, "artifact.tar.gz"); writeFileSync(archive, bytes);
    const path = unpackPackage(archive, join(staging, "extracted"));
    const pkg = readPackage(path, { runtimeVersion });
    if (pkg.document.name !== name || pkg.document.version !== options.version) throw packageError("PackageDependencyConflict", "archive identity differs from selected registry entry");
    return await addPackage(path, options);
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export async function checkPackage(path, options = {}) {
  path ??= findPackageWorkspace(options.root, { author: true });
  if (lstatSync(path).isFile()) path = dirname(path);
  assertPackageDirectory(realpathSync(path));
  if (existsSync(join(path, PACKAGE_TRANSACTION))) throw packageError("PackageInstallationIncomplete", "package workspace has an active or interrupted transaction");
  if (existsSync(join(path, PACKAGE_LOCK))) {
    const document = readPackage(path).document;
    verifyInstalledPackages(path, Object.entries(document.dependencies ?? {}).map(([name, version]) => ({ manifest: `packages/${name}/${PACKAGE_MANIFEST}`, version })));
  }
  const closure = packageClosure(path, options);
  const { validatePackageSources } = await import("./project.mjs");
  const diagnostics = await validatePackageSources(closure.packages, options);
  if (diagnostics.length) throw packageError("PackageSourceInvalid", diagnostics.map(d => `${d.code}: ${d.message}`).join("\n"));
  const missing = ["description", "publisher", "license"].filter(field => !closure.first.document[field]);
  return { status: "success", command: "package check", package: closure.first.document.name, version: closure.first.document.version, publishing: { ready: missing.length === 0, missing, name_availability: "not_checked" }, notes: missing.length ? [`Before sharing, complete ${missing.join(", ")} in ${PACKAGE_MANIFEST}.`] : [], packages: closure.packages.map(pkg => ({ name: pkg.document.name, version: pkg.document.version, digest: pkg.digest, files: pkg.files.length, requirements: pkg.requirements })), tests: "Source contracts checked. Author tests are not executed automatically.", closure };
}

function copyPackage(pkg, destination) {
  assertPackageUnchanged(pkg);
  mkdirSync(destination, { recursive: true });
  for (const file of pkg.files) {
    const target = join(destination, file.path);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(pkg.root, file.path), target);
  }
  const copied = readPackage(destination, { runtimeVersion });
  if (copied.digest !== pkg.digest) throw packageError("PackageIntegrityMismatch", `${pkg.document.name} changed while copying`);
  assertOnlyInventory(copied);
}

export async function packPackage(path, { output, ...options } = {}) {
  const checked = await checkPackage(path, { ...options, publishing: true });
  const author = checked.closure.first;
  assertAuthorWritable(author.root);
  output = output ? resolve(output) : join(author.root, "dist", `${author.document.name}-${author.document.version}.tar.gz`);
  assertPlainDirectory(dirname(output));
  if (existsSync(output)) throw packageError("PackageAlreadyExists", "refusing to overwrite archive");
  const staging = mkdtempSync(join(tmpdir(), "touba-package-pack-"));
  try {
    copyPackage(checked.closure.first, join(staging, "package"));
    for (const pkg of checked.closure.packages.slice(1)) copyPackage(pkg, join(staging, "package/packages", pkg.document.name));
    const archive = join(staging, "artifact.tar.gz");
    tar.c({ cwd: staging, file: archive, sync: true, gzip: true, portable: true, noMtime: true }, ["package"]);
    const bytes = readFileSync(archive);
    if (bytes.length > PACKAGE_LIMITS.totalBytes) throw packageError("PackageTooLarge", "archive exceeds limit");
    mkdirSync(dirname(output), { recursive: true });
    writeFileSync(output, bytes, { flag: "wx", mode: 0o644 });
    return { status: "success", command: "package pack", output, digest: packageDigest(bytes), packages: checked.packages };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

export function unpackPackage(archive, destination) {
  if (lstatSync(archive).size > PACKAGE_LIMITS.totalBytes) throw packageError("PackageTooLarge", "compressed archive exceeds limit");
  const bytes = readFileSync(archive);
  let buffer;
  try { buffer = gunzipSync(bytes, { maxOutputLength: PACKAGE_LIMITS.totalBytes * 2 }); }
  catch { throw packageError("PackageArchiveInvalid", "invalid or oversized gzip archive"); }
  const seen = new Set(); let total = 0; let count = 0;
  const parser = tar.t({ sync: true, strict: true, onReadEntry(entry) {
    if (!["File", "Directory"].includes(entry.type)) throw packageError("PackageArchiveInvalid", `unsupported archive entry type ${entry.type}`);
    const path = entry.path.replace(/\/$/, "");
    if (path !== "package" && !path.startsWith("package/")) throw packageError("PackagePathInvalid", "archive entries must be under package/");
    packagePath(path);
    if (path.split("/").length > PACKAGE_LIMITS.depth || seen.has(path.toLowerCase())) throw packageError("PackagePathCollision", "duplicate, deep or case-colliding archive path");
    seen.add(path.toLowerCase()); count++; total += entry.size;
    if (entry.size > PACKAGE_LIMITS.fileBytes || total > PACKAGE_LIMITS.totalBytes || count > PACKAGE_LIMITS.files) throw packageError("PackageTooLarge", "archive exceeds content limits");
  } });
  parser.end(buffer);
  // Parse once before writing anything. destination must be a fresh private dir.
  if (existsSync(destination)) throw packageError("PackageAlreadyExists", "archive extraction needs a new directory");
  mkdirSync(destination, { mode: 0o700 });
  const extractor = tar.x({ cwd: destination, sync: true, strict: true, noChmod: true, noMtime: true, preserveOwner: false });
  extractor.end(buffer);
  return join(destination, "package");
}

export async function addPackage(path, { root = process.cwd(), ...options } = {}) {
  root = findPackageWorkspace(root);
  const workspace = readPackageWorkspace(root);
  const { path: configPath, bytes: configBytes, document: config } = workspace;
  const records = [...workspace.records];
  const lock = verifyInstalledPackages(root, records);
  const oldLock = existsSync(join(root, PACKAGE_LOCK)) ? readFileSync(join(root, PACKAGE_LOCK)) : undefined;
  assertPlainDirectory(join(root, "packages"));
  const staging = mkdtempSync(join(root, ".touba-package-stage-"));
  const installed = [];
  let transaction = false;
  let metadataChanged = false;
  let settled = false;
  try {
    const requestedName = PACKAGE_NAME.test(path) ? path : undefined;
    path = requestedName ? join(root, "packages", requestedName) : resolve(path);
    if (!existsSync(path)) throw packageError("PackageSourceMissing", "supply a package directory/archive, or place the package in packages/<organization.name> before adding by name; remote installation requires --registry");
    if (!lstatSync(path).isDirectory() && !path.endsWith(PACKAGE_MANIFEST)) path = unpackPackage(path, join(staging, "extracted"));
    const checked = await checkPackage(path, { ...options, projectRoot: root });
    const packages = checked.closure.packages;
    if (requestedName && checked.package !== requestedName) throw packageError("PackageNameConflict", "folder identity differs from the requested package");
    if (workspace.author && packages.some(pkg => pkg.document.name === config.name)) throw packageError("PackageDependencyCycle", "a package cannot depend on itself");
    const updates = [];
    const previousRecords = [...records];
    for (const pkg of packages) {
      const destination = join(root, "packages", pkg.document.name);
      const manifest = `packages/${pkg.document.name}/${PACKAGE_MANIFEST}`;
      const existing = lock.packages.find(entry => entry.name === pkg.document.name);
      if (existing && (existing.version !== pkg.document.version || existing.digest !== pkg.digest)) throw packageError("PackageDependencyConflict", `different package already installed: ${pkg.document.name}`);
      const aliases = records.filter(record => resolve(root, record.manifest) === resolve(root, manifest));
      if (aliases.length > 1) throw packageError("PackageNameConflict", `duplicate project entry ${manifest}`);
      for (const record of previousRecords) {
        if (resolve(root, record.manifest) !== resolve(root, manifest) && readPackage(resolve(root, record.manifest)).document.name === pkg.document.name) throw packageError("PackageNameConflict", `another project path already declares ${pkg.document.name}`);
      }
      if (existsSync(destination)) {
        const current = readPackage(destination, { runtimeVersion });
        assertOnlyInventory(current);
        if (current.digest !== pkg.digest) throw packageError("PackageAlreadyExists", `refusing to replace ${destination}`);
      } else {
        copyPackage(pkg, join(staging, pkg.document.name));
        updates.push({ source: join(staging, pkg.document.name), destination });
      }
      if (!existing) lock.packages.push({ name: pkg.document.name, version: pkg.document.version, manifest, digest: pkg.digest, files: pkg.files });
      if (!aliases.length) records.push({ manifest, version: pkg.document.version });
      else { aliases[0].version = pkg.document.version; delete aliases[0].editable; }
    }
    if (!readFileSync(configPath).equals(configBytes)) throw packageError("PackageProjectChanged", "project changed during validation; retry");
    const nowLock = existsSync(join(root, PACKAGE_LOCK)) ? readFileSync(join(root, PACKAGE_LOCK)) : undefined;
    if (oldLock?.toString() !== nowLock?.toString()) throw packageError("PackageProjectChanged", "lock changed during validation; retry");
    writeFileSync(join(root, PACKAGE_TRANSACTION), json({ pid: process.pid, staging, packages: packages.map(p => p.document.name) }), { flag: "wx", mode: 0o600 });
    transaction = true;
    // Recheck after acquiring the exclusive marker: another installation may
    // have completed between the earlier snapshot check and this acquisition.
    if (!readFileSync(configPath).equals(configBytes) || oldLock?.toString() !== (existsSync(join(root, PACKAGE_LOCK)) ? readFileSync(join(root, PACKAGE_LOCK), "utf8") : undefined)) throw packageError("PackageProjectChanged", "project changed before commit; retry");
    mkdirSync(join(root, "packages"), { recursive: true });
    for (const update of updates) {
      if (existsSync(update.destination)) throw packageError("PackageAlreadyExists", "destination changed during validation");
      renameSync(update.source, update.destination); installed.push(update.destination);
    }
    lock.packages.sort((a, b) => a.name.localeCompare(b.name));
    setWorkspacePackages(workspace, records);
    writeFileSync(join(staging, "lock.json"), json(lock));
    writeFileSync(join(staging, "project.json"), json(config));
    renameSync(join(staging, "lock.json"), join(root, PACKAGE_LOCK));
    metadataChanged = true;
    renameSync(join(staging, "project.json"), configPath);
    settled = true;
    return { status: "success", command: "package add", packages: checked.packages, notes: ["Installed and registered. Execution permissions remain in the consuming project."] };
  } catch (error) {
    if (transaction) {
      if (metadataChanged) {
        writeFileSync(configPath, configBytes);
        if (oldLock) writeFileSync(join(root, PACKAGE_LOCK), oldLock);
        else rmSync(join(root, PACKAGE_LOCK), { force: true });
      }
      for (const path of installed.reverse()) rmSync(path, { recursive: true, force: true });
      settled = true;
    }
    throw error;
  } finally {
    if (transaction && settled) rmSync(join(root, PACKAGE_TRANSACTION), { force: true });
    if (!transaction || settled) rmSync(staging, { recursive: true, force: true });
  }
}

export function removePackage(name, { root = process.cwd() } = {}) {
  if (!PACKAGE_NAME.test(name)) throw packageError("PackageNameInvalid", "use the installed qualified package name");
  root = findPackageWorkspace(root);
  const workspace = readPackageWorkspace(root);
  const { path: configPath, bytes: configBytes, document: config, records } = workspace;
  const lock = verifyInstalledPackages(root, records);
  const entry = lock.packages.find(item => item.name === name);
  if (!entry) throw packageError("PackageNotInstalled", `${name} is not an installed package`);
  for (const record of records) {
    const pkg = readPackage(resolve(root, record.manifest));
    if (pkg.document.name !== name && Object.hasOwn(pkg.document.dependencies ?? {}, name)) throw packageError("PackageInUse", `${pkg.document.name} depends on ${name}`);
  }
  const lockBytes = readFileSync(join(root, PACKAGE_LOCK));
  const staging = mkdtempSync(join(root, ".touba-package-stage-"));
  const destination = dirname(resolve(root, entry.manifest)), saved = join(staging, "removed");
  let transaction = false, moved = false, settled = false;
  try {
    writeFileSync(join(root, PACKAGE_TRANSACTION), json({ pid: process.pid, staging, remove: name }), { flag: "wx", mode: 0o600 }); transaction = true;
    if (!readFileSync(configPath).equals(configBytes) || !readFileSync(join(root, PACKAGE_LOCK)).equals(lockBytes)) throw packageError("PackageProjectChanged", "project changed during validation; retry");
    renameSync(destination, saved); moved = true;
    setWorkspacePackages(workspace, records.filter(record => resolve(root, record.manifest) !== resolve(root, entry.manifest)));
    lock.packages = lock.packages.filter(item => item.name !== name);
    writeFileSync(join(staging, "project.json"), json(config));
    writeFileSync(join(staging, "lock.json"), json(lock));
    renameSync(join(staging, "lock.json"), join(root, PACKAGE_LOCK));
    renameSync(join(staging, "project.json"), configPath);
    settled = true;
    return { status: "success", command: "package remove", package: name, notes: ["Removed installed package and its lock entry. Project source imports are unchanged; prepare again before running."] };
  } catch (error) {
    if (transaction && moved) {
      renameSync(saved, destination);
      writeFileSync(configPath, configBytes); writeFileSync(join(root, PACKAGE_LOCK), lockBytes);
    }
    settled = true;
    throw error;
  } finally {
    if (transaction && settled) rmSync(join(root, PACKAGE_TRANSACTION), { force: true });
    if (!transaction || settled) rmSync(staging, { recursive: true, force: true });
  }
}
