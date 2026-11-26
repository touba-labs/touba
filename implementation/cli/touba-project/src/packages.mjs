import { copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { gunzipSync } from "node:zlib";
import * as tar from "tar";
import semver from "semver";
export const isNewerPackageVersion = (next, current) => Boolean(semver.valid(next) && semver.valid(current) && semver.gt(next, current));
export const packageRuntimeCompatibility = required => ({ runtime: runtimeVersion, required, compatible: semver.satisfies(runtimeVersion, required) });
import { PACKAGE_LIMITS, PACKAGE_MANIFEST, PACKAGE_NAME, PACKAGE_RUNTIME_VERSION as runtimeVersion, assertPackageUnchanged, packageDigest, packageError, packageFile, packagePath, readPackage } from "./package-contract.mjs";
import { PACKAGE_LOCK, PACKAGE_LOCK_SCHEMA, PACKAGE_TRANSACTION, acquirePackageTransaction, assertAuthorWritable, assertOnlyInventory, assertPlainDirectory, assertPackageDirectory, findPackageWorkspace, inspectInstalledPackages, packageDependencyRecords, readPackageWorkspace, setWorkspacePackages, verifyInstalledPackages } from "./package-store.mjs";
export { newPackage } from "./package-author.mjs";
import { resolveRegistryPackage } from "./registry.mjs";
import { createRegistryReader } from "./package-fetch.mjs";
import { toolContract } from "./package-governance.mjs";
import { satisfiesPackageConstraint } from '../../../runtime/touba-handler-sdk/src/package-constraints.mjs';
import { selectPackageClosure } from './package-selection.mjs';
import { packageLocale } from './package-diagnostics.mjs';
import { assertPackageModuleOwnership } from './package-contract.mjs';
import { exactPackageVersion } from './package-contract.mjs';

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

// Exact resolved closure, supplied inside the root package or already present in the
// consuming project. No ambient workspace search, latest selection or network.
export function packageClosure(path, { projectRoot, publishing = false } = {}) {
  const first = readPackage(path, { runtimeVersion, publishing });
  const packages = new Map();
  const active = new Set();
  function visit(pkg, chain = []) {
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
      const candidates = [join(pkg.root, "packages", dependency), join(first.root, "packages", dependency)];
      let found = [...new Set(candidates)].filter(candidate => existsSync(join(candidate, PACKAGE_MANIFEST)));
      // An explicitly supplied closure owns its candidates. The consumer is a
      // fallback, not a competing source that can replace reviewed archive bytes.
      if (!found.length && projectRoot && existsSync(join(projectRoot, 'packages', dependency, PACKAGE_MANIFEST))) found = [join(projectRoot, 'packages', dependency)];
      if (!found.length && !packages.has(dependency)) throw packageError("PackageDependencyMissing", `${name} requires ${dependency}@${expected}; supply it under packages/${dependency}`);
      for (const candidate of found) {
        const child = readPackage(candidate, { runtimeVersion, publishing });
        if (child.document.name !== dependency || !satisfiesPackageConstraint(child.document.version, expected, pkg.document.package_schema_version)) throw packageError("PackageDependencyConflict", `${[...chain, name, dependency].join(' -> ')} requires ${expected}; selected ${child.document.version}`);
        visit(child, [...chain, name]);
      }
      if (!satisfiesPackageConstraint(packages.get(dependency).document.version, expected, pkg.document.package_schema_version)) throw packageError("PackageDependencyConflict", `${[...chain, name, dependency].join(' -> ')} requires ${expected}; selected ${packages.get(dependency).document.version}`);
    }
    active.delete(name);
  }
  visit(first);
  return { first, packages: [...packages.values()] };
}

export async function addRegistryPackage(name, options) {
  if (!PACKAGE_NAME.test(name)) throw packageError('PackageNameInvalid', 'select a canonical qualified package name');
  if (!options.version) throw packageError('PackageExactVersionRequired', 'select name@version explicitly');
  if (!options.registry) throw packageError("PackageRegistryOptionMissing", "select a registry");
  if (!exactPackageVersion(options.version)) throw packageError('PackageExactVersionRequired', 'select an exact semantic version');
  const reader = createRegistryReader(options.registry, { noBrowser: options['no-browser'] === true, sessionOnly: options['session-only'] === true });
  try { return await installRegistryPackage(name, options, reader.readBytes); }
  finally { await reader.close(); }
}

export async function updateRegistryPackage(name, options) {
  return addRegistryPackage(name, { ...options, updating: true });
}

async function installRegistryPackage(name, options, readBytes) {
  const trustBytes = options.trust ? readFileSync(options.trust) : null;
  const { artifact, location } = await resolveRegistryArchive(name, options, readBytes);
  const bytes = await readBytes(location, PACKAGE_LIMITS.totalBytes);
  if (packageDigest(bytes) !== artifact.digest) throw packageError("PackageIntegrityMismatch", "registry archive digest mismatch");
  const staging = mkdtempSync(join(tmpdir(), "touba-package-fetch-"));
  try {
    const archive = join(staging, "artifact.tar.gz"); writeFileSync(archive, bytes);
    const path = unpackPackage(archive, join(staging, "extracted"));
    const pkg = readPackage(path, { runtimeVersion });
    if (pkg.document.name !== name || pkg.document.version !== options.version) throw packageError("PackageDependencyConflict", "archive identity differs from selected registry entry");
    if (trustBytes && !trustBytes.equals(readFileSync(options.trust))) throw packageError('PackageReviewChanged', 'registry trust changed during verification');
    return await (options.updating ? reviewPackageUpdate : addPackage)(path, { ...options, name,
      sourceReviews: [{ registry: options.registry, version: options.version, expected_name: name,
        archive_digest: artifact.digest, trust_digest: trustBytes ? packageDigest(trustBytes) : null }] });
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Shared signed resolution for clients; no installation or host execution. */
export async function resolveRegistryArchive(name, options, readBytes) {
  if (!PACKAGE_NAME.test(name) || !options.registry || !options.version) throw packageError("PackageRegistryOptionMissing", "select a qualified package and exact version");
  const resolution = await resolveRegistryPackage({ registry: options.registry, trust: options.trust, version: options.version, packageRef: `pkg:${name}`, allowDraft: options["allow-draft"] === true, readBytes });
  if (!semver.satisfies(runtimeVersion, resolution.compatibility.touba)) throw packageError("PackageVersionIncompatible", `${name}@${options.version} requires Touba ${resolution.compatibility.touba}; installed ${runtimeVersion}${semver.prerelease(runtimeVersion) ? '; prereleases require explicit compatibility in the package' : ''}`);
  if (resolution.package.kind !== "touba_package") throw packageError("PackageSchemaMismatch", "registry entry must describe a Touba package");
  const archives = resolution.artifacts.filter(artifact => artifact.kind === "package_archive");
  if (archives.length !== 1) throw packageError("PackageArchiveInvalid", "registry must supply exactly one package_archive artifact");
  const artifact = archives[0]; packagePath(artifact.path);
  const index = resolution.registry.index_ref;
  const location = /^https?:\/\//.test(index) ? new URL(artifact.path, new URL("./", index)).href : packageFile(dirname(resolve(index)), artifact.path);
  return { resolution, artifact, location };
}

export async function checkPackage(path, options = {}) {
  path ??= findPackageWorkspace(options.root, { author: true });
  if (lstatSync(path).isFile()) path = dirname(path);
  assertPackageDirectory(realpathSync(path));
  if (existsSync(join(path, PACKAGE_TRANSACTION))) throw packageError("PackageInstallationIncomplete", "package workspace has an active or interrupted transaction");
  if (existsSync(join(path, PACKAGE_LOCK))) {
    const local = readPackage(path);
    if (local.files.some(file => file.path === PACKAGE_LOCK)) throw packageError("PackageLockDistributionConflict", "remove touba.packages.lock.json from package files and repack a new version; dependency locks are archive workspace metadata");
    const document = local.document;
    verifyInstalledPackages(path, packageDependencyRecords(path, document));
  }
  const closure = packageClosure(path, options);
  return checkPackageClosure(closure, options);
}

async function checkPackageClosure(closure, options = {}) {
  assertPackageModuleOwnership(closure.packages);
  const { validatePackageSources } = await import("./project.mjs");
  let contracts;
  const diagnostics = await validatePackageSources(closure.packages, { ...options,
    onPackageContracts: options.inspectContracts ? entries => {
      contracts = closure.packages.map(pkg => ({ name: pkg.document.name,
        tools: Object.fromEntries(entries.filter(entry => entry.packageName === pkg.document.name)
          .flatMap(entry => (entry.document.definitions?.tools ?? []).filter(tool => tool.id.startsWith(`tool:${entry.document.module.name}/`)))
          .map(tool => [tool.id, toolContract(tool, pkg.document.handlers?.find(handler => handler.tool === tool.id), pkg.root)])),
        handlers: (pkg.document.handlers ?? []).map(handler => ({ tool: handler.tool, entrypoint: handler.path,
          ...(handler.effect_contract ? { recommended_effect: handler.effect_contract } : {}) })),
      }));
    } : undefined });
  if (diagnostics.length) {
    // Only inventory-backed paths become public package-relative locations.
    // Never infer a source location from an arbitrary host path.
    const locations = new Map(closure.packages.flatMap(pkg => pkg.files.map(file =>
      [resolve(pkg.root, file.path), `${pkg === closure.first ? '' : `${pkg.document.name}@${pkg.document.version}/`}${file.path}`])));
    const location = d => typeof d.source_path === 'string' ? locations.get(resolve(d.source_path)) ?? '' : '';
    throw Object.assign(packageError("PackageSourceInvalid",
      diagnostics.map(d => `${location(d)}${d.source_ref ? `:${d.source_ref.start_line + 1}:${d.source_ref.start_column + 1}` : ""} ${d.code}: ${d.message}`.trim()).join("\n")), { diagnostics });
  }
  const missing = ["description", "publisher", "license"].filter(field => !closure.first.document[field]);
  const fr = packageLocale(options.lang) === 'fr';
  const initial = closure.first.document;
  const templateFields = [];
  if ([`Package réutilisable ${initial.name}.`, `Reusable ${initial.name} package.`].includes(initial.description)) templateFields.push('description');
  if (initial.readme && /Le skill Echo et son test forment un exemple de départ|The Echo skill and its test are a starting example|Add tests for your procedure’s acceptance criteria|Ajoutez des tests pour les critères de votre procédure/.test(readFileSync(packageFile(closure.first.root, initial.readme), 'utf8'))) templateFields.push('readme');
  const warnings = templateFields.length ? [{ code: 'PackageScaffoldUnchanged', fields: templateFields }] : [];
  const effectNotes = closure.packages.flatMap(pkg => (pkg.document.handlers ?? [])
    .filter(handler => !handler.effect_contract)
    .map(handler => fr ? `Le handler ${handler.tool} ne recommande aucun contrat d’effet. Vérifiez ses effets et testez le protocole de reçu ; un accès réseau ne signifie pas à lui seul une écriture externe.` : `Handler ${handler.tool} has no recommended effect contract. Review its side effects and test the receipt protocol; network access alone does not imply an external write.`));
  const resolvedVersions = new Map(closure.packages.map(pkg => [pkg.document.name, pkg.document.version]));
  const packages = closure.packages.map(pkg => ({ name: pkg.document.name, version: pkg.document.version,
    digest: pkg.digest, files: pkg.files.length, requirements: pkg.requirements,
    // Evidence uses the exact resolved closure, independently of author constraints.
    dependencies: Object.fromEntries(Object.keys(pkg.document.dependencies ?? {}).sort()
      .map(name => [name, resolvedVersions.get(name)])) }));
  return { status: "success", command: "package check", package: closure.first.document.name, version: closure.first.document.version, publishing: { ready: missing.length === 0, missing, name_availability: "not_checked" }, warnings, notes: [...(missing.length ? [fr ? `Avant le partage, complétez ${missing.join(", ")} dans ${PACKAGE_MANIFEST}.` : `Before sharing, complete ${missing.join(", ")} in ${PACKAGE_MANIFEST}.`] : []), ...effectNotes,
    ...(warnings.length ? [fr ? `Exemple de départ encore présent (${templateFields.join(', ')}). Adaptez la présentation et vérifiez le comportement avant publication ; cet avertissement n’est pas une certification de qualité.` : `Starter example still present (${templateFields.join(', ')}). Adapt the presentation and verify behavior before publication; this warning is not quality certification.`] : [])], packages, tests: fr ? "Contrats source vérifiés. Les tests de l’auteur ne sont pas exécutés automatiquement." : "Source contracts checked. Author tests are not executed automatically.", closure, ...(contracts ? { contracts } : {}) };
}

export function copyPackage(pkg, destination) {
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
  return writeCheckedArchive(checked, output);
}

// Private transport snapshot, not a publication. Local consumers do not need
// publisher metadata; content, closure, compiler and integrity checks still run.
export async function snapshotPackage(path, { output, ...options } = {}) {
  if (!output) throw packageError("PackageOutputRequired", "snapshot needs an explicit destination");
  return writeCheckedArchive(await checkPackage(path, options), resolve(output));
}

function writeCheckedArchive(checked, output) {
  assertPlainDirectory(dirname(output));
  if (existsSync(output)) throw packageError("PackageAlreadyExists", "refusing to overwrite archive");
  const staging = mkdtempSync(join(tmpdir(), "touba-package-pack-"));
  try {
    if (checked.closure.packages.some(pkg => pkg.files.some(file => file.path === PACKAGE_LOCK))) {
      throw packageError("PackageLockDistributionConflict", "remove touba.packages.lock.json from package files; the archive generates its own verified dependency lock");
    }
    copyPackage(checked.closure.first, join(staging, "package"));
    for (const pkg of checked.closure.packages.slice(1)) copyPackage(pkg, join(staging, "package/packages", pkg.document.name));
    // Transport metadata belongs to the archive workspace, not to the root
    // package inventory. Installation reconstructs the consumer's own lock.
    if (checked.closure.packages.length > 1) {
      const packages = checked.closure.packages.slice(1).map(pkg => ({ name: pkg.document.name, version: pkg.document.version,
        manifest: `packages/${pkg.document.name}/${PACKAGE_MANIFEST}`, digest: pkg.digest, files: pkg.files })).sort((a, b) => a.name.localeCompare(b.name));
      writeFileSync(join(staging, "package", PACKAGE_LOCK), json({ lock_schema_version: PACKAGE_LOCK_SCHEMA, packages }), { flag: "wx" });
    }
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
  if (options.accept !== undefined || options.review === true) return reviewPackageInstallation(path, { root, ...options });
  return installPackage(path, { root, ...options });
}

export async function reviewPackageInstallation(path, { root = process.cwd(), ...options } = {}) {
  root = findPackageWorkspace(root);
  const source = PACKAGE_NAME.test(path) ? join(root, 'packages', path) : path;
  return reviewPackageUpdates([source], { root, ...options, preferInstalled: true, installing: true, command: 'package add' });
}

export async function updatePackage(path, { root = process.cwd(), name, ...options } = {}) {
  if (!PACKAGE_NAME.test(name ?? "")) throw packageError("PackageNameInvalid", "select the installed package to update");
  if (options['allow-downgrade'] === true && !options.reviewDigest) throw packageError('PackageReviewRequired', 'a downgrade requires an exact accepted review');
  return installPackage(path, { root, ...options }, name);
}

function updateDirection(version, previous, allowDowngrade) {
  if (semver.gt(version, previous)) return 'upgrade';
  if (semver.lt(version, previous) && allowDowngrade === true) return 'downgrade';
  throw Object.assign(packageError('PackageVersionConflict', semver.eq(version, previous)
    ? 'an existing version cannot contain different bytes'
    : 'review an older dependency selection with touba package update-set --allow-downgrade'),
  { reason: semver.eq(version, previous) ? 'package_version_immutable' : 'package_downgrade_review_required' });
}

async function updateReview(workspace, lock, checked, allowDowngrade = false) {
  const previous = lock.packages.find(item => item.name === checked.package);
  if (!previous && !checked.composition) throw packageError('PackageNotInstalled', 'only an installed package can be updated');
  const describeDirection = (prior, next) => !prior ? 'add'
    : checked.composition && prior.digest === next.digest ? 'keep'
    : updateDirection(next.document.version, prior.version, allowDowngrade);
  const graph = candidateUpdateGraph(workspace, lock, checked, allowDowngrade);
  const direction = describeDirection(previous, checked.closure.first);
  const roots = (checked.updateRoots ?? [checked.package]).map(name => {
    const prior = lock.packages.find(item => item.name === name);
    const next = checked.closure.packages.find(pkg => pkg.document.name === name);
    if ((!prior && !checked.composition) || !next) throw packageError('PackageNotInstalled', 'every requested root must be installed');
    return { name, previous: prior?.version ?? null, version: next.document.version,
      direction: describeDirection(prior, next) };
  });
  const after = checked.closure.first;
  const oldContracts = new Map();
  const oldPackages = new Map();
  const replacedNames = new Set(checked.closure.packages.map(pkg => pkg.document.name));
  for (const candidate of checked.closure.packages) {
    const old = lock.packages.find(entry => entry.name === candidate.document.name);
    if (!old) continue;
    const installed = readPackage(resolve(dirname(workspace.path), old.manifest));
    oldPackages.set(old.name, installed);
    const previousCheck = await checkPackage(installed.root, { projectRoot: dirname(workspace.path), inspectContracts: true });
    // Dependencies dropped by the new root remain installed until an explicit
    // removal. Do not describe their unchanged contracts as removed authority.
    for (const pkg of previousCheck.contracts) if (replacedNames.has(pkg.name)) oldContracts.set(pkg.name, pkg.tools);
  }
  const newContracts = new Map((checked.contracts ?? []).map(pkg => [pkg.name, pkg.tools]));
  const contractChanges = [...new Set([...oldContracts.keys(), ...newContracts.keys()])].sort().flatMap(name => {
    const oldTools = oldContracts.get(name) ?? {}, newTools = newContracts.get(name) ?? {};
    return [...new Set([...Object.keys(oldTools), ...Object.keys(newTools)])].sort().flatMap(tool => {
      const before = oldTools[tool] ?? null, after = newTools[tool] ?? null;
      return JSON.stringify(before) === JSON.stringify(after) ? [] : [{ package: name, tool, before, after }];
    });
  });
  const handlers = checked.closure.packages.flatMap(after => {
    const before = oldPackages.get(after.document.name);
    return [...new Set([...(before?.document.handlers ?? []), ...(after.document.handlers ?? [])].map(h => h.tool))].sort().map(tool => {
    const describe = pkg => {
      const h = pkg?.document.handlers?.find(h => h.tool === tool);
      return h ? { path: h.path, digest: pkg.files.find(file => file.path === h.path)?.digest } : null;
    };
    return { tool, before: describe(before), after: describe(after) };
  }).filter(h => JSON.stringify(h.before) !== JSON.stringify(h.after));
  });
  const plan = { schema_version: roots.some(row => ['add', 'keep'].includes(row.direction)) ? 'touba-package-update-review-v2' : 'touba-package-update-review-v1',
    workspace_digest: packageDigest(Buffer.concat([workspace.bytes, Buffer.from(json(lock))])),
    package: checked.package, previous: previous?.version ?? null, version: checked.version, direction,
    previous_digest: previous?.digest ?? null, package_digest: after.digest, handlers,
    packages: checked.packages, changes: graph.changes, constraints: graph.constraints,
    contracts: checked.contracts ?? [], contract_changes: contractChanges };
  if (checked.updateRoots) plan.roots = roots;
  if (checked.updateSources) plan.sources = checked.updateSources;
  if (checked.resolutions) plan.resolutions = checked.resolutions;
  return { ...plan, review_digest: packageDigest(Buffer.from(JSON.stringify(plan))) };
}

function candidateUpdateGraph(workspace, lock, checked, allowDowngrade) {
  const root = dirname(workspace.path);
  const selected = new Map(lock.packages.map(entry => [entry.name, readPackage(resolve(root, entry.manifest))]));
  const changes = [];
  for (const pkg of checked.closure.packages) {
    const before = selected.get(pkg.document.name);
    if (before && before.digest !== pkg.digest) {
      // Different bytes at an equal version are always refused. Diagnose graph
      // incompatibilities before asking for a downgrade that cannot satisfy them.
      if (semver.eq(pkg.document.version, before.document.version)) updateDirection(pkg.document.version, before.document.version, allowDowngrade);
      changes.push({ name: pkg.document.name, before: { version: before.document.version, digest: before.digest }, after: { version: pkg.document.version, digest: pkg.digest } });
    } else if (!before) changes.push({ name: pkg.document.name, before: null, after: { version: pkg.document.version, digest: pkg.digest } });
    selected.set(pkg.document.name, pkg);
  }
  assertPackageModuleOwnership(selected.values());
  const constraints = [], conflicts = [];
  for (const pkg of [...selected.values(), ...(workspace.author ? [{ document: workspace.document }] : [])]) {
    for (const [name, constraint] of Object.entries(pkg.document.dependencies ?? {})) {
      const version = selected.get(name)?.document.version;
      // An author's explicit direct exact pin follows its requested update;
      // ranges and every installed package's constraints remain authoritative.
      const directPin = workspace.author && pkg.document === workspace.document && (checked.updateRoots ?? [checked.package]).includes(name) && /^\d+\.\d+\.\d+(?:[-+].*)?$/.test(constraint);
      const blocking = !directPin && !satisfiesPackageConstraint(version, constraint, pkg.document.package_schema_version);
      if (blocking) conflicts.push({ consumer: pkg.document.name, dependency: name, constraint, version: version ?? null });
      constraints.push({ consumer: pkg.document.name, dependency: name, constraint: directPin ? version : constraint, version, blocking });
    }
  }
  const relatedConstraints = names => constraints.filter(row => names.has(row.dependency))
    .map(row => ({ ...row, version: row.version ?? null,
      current_version: lock.packages.find(pkg => pkg.name === row.dependency)?.version ?? null,
      origin: workspace.author && row.consumer === workspace.document.name ? 'author'
        : (checked.updateRoots ?? [checked.package]).includes(row.consumer)
          || selected.get(row.consumer)?.digest !== lock.packages.find(pkg => pkg.name === row.consumer)?.digest ? 'selected' : 'installed' }))
    .sort((a, b) => `${a.consumer}/${a.dependency}`.localeCompare(`${b.consumer}/${b.dependency}`));
  if (conflicts.length) throw Object.assign(packageError('PackageInUse', conflicts
    .sort((a, b) => `${a.consumer}/${a.dependency}`.localeCompare(`${b.consumer}/${b.dependency}`))
    .map(row => `${row.consumer} -> ${row.dependency} requires ${row.constraint}; selected ${row.version ?? 'absent'}`).join('; ')),
  { constraints: relatedConstraints(new Set(conflicts.map(row => row.dependency))) });
  for (const change of changes) if (change.before) {
    try { updateDirection(change.after.version, change.before.version, allowDowngrade); }
    catch (error) {
      error.constraints = relatedConstraints(new Set([change.name]));
      throw error;
    }
  }
  const active = new Set(), visited = new Set();
  const visit = name => {
    if (active.has(name)) throw packageError('PackageDependencyCycle', `dependency cycle at ${name}`);
    if (visited.has(name)) return;
    active.add(name);
    for (const dependency of Object.keys(selected.get(name)?.document.dependencies ?? {})) visit(dependency);
    active.delete(name); visited.add(name);
  };
  for (const name of selected.keys()) visit(name);
  return { changes: changes.sort((a, b) => a.name.localeCompare(b.name)), constraints: constraints.sort((a, b) => `${a.consumer}/${a.dependency}`.localeCompare(`${b.consumer}/${b.dependency}`)) };
}

/** Explicit roots are selected together; ambiguous bundled alternatives are never guessed. */
export async function reviewPackageUpdates(paths, { root = process.cwd(), accept, ...options } = {}) {
  if (!Array.isArray(paths) || paths.length < 1 || paths.length > 32 || paths.some(path => typeof path !== 'string' || !path)) throw packageError('PackageUpdateSetInvalid', 'select between 1 and 32 package sources');
  root = findPackageWorkspace(root);
  const staging = realpathSync(mkdtempSync(join(tmpdir(), 'touba-package-update-set-')));
  try {
    const checks = [], sourceDigests = []; let bytes = 0;
    for (const [index, path] of paths.entries()) {
      let source = resolve(path);
      if (lstatSync(source).isFile() && !source.endsWith(PACKAGE_MANIFEST)) source = unpackPackage(source, join(staging, `source-${index}`));
      const archive = join(staging, `${index}.tar.gz`);
      await snapshotPackage(source, { output: archive, projectRoot: root });
      sourceDigests.push(packageDigest(readFileSync(archive)));
      bytes += lstatSync(archive).size;
      if (bytes > PACKAGE_LIMITS.totalBytes) throw packageError('PackageTooLarge', 'package update sources exceed the total byte limit');
      source = unpackPackage(archive, join(staging, `review-${index}`));
      checks.push(await checkPackage(source, { projectRoot: root }));
    }
    const roots = new Map();
    for (const [index, check] of checks.entries()) {
      const expected = options.sourceReviews?.[index];
      if (expected?.expected_name && (check.package !== expected.expected_name || check.version !== expected.version)) throw packageError('PackageDependencyConflict', 'archive identity differs from its selected registry entry');
      if (roots.has(check.package)) throw packageError('PackageUpdateSetInvalid', `duplicate explicit root ${check.package}`);
      roots.set(check.package, check.closure.first);
    }
    const workspace = readPackageWorkspace(root), lock = verifyInstalledPackages(root, workspace.records);
    const installed = new Map(lock.packages.map(entry => [entry.name, readPackage(resolve(root, entry.manifest))]));
    if (options.installing) for (const [name, pkg] of roots) {
      if (installed.has(name) && installed.get(name).digest !== pkg.digest) {
        const consumers = [...installed.values(), ...(workspace.author ? [{ document: workspace.document }] : [])];
        throw Object.assign(packageError('PackageDependencyConflict', `different package already installed: ${name}; review an update explicitly`), {
          reason: 'PackageUpdateReviewRequired', packageName: name,
          constraints: consumers.filter(item => Object.hasOwn(item.document.dependencies ?? {}, name)).map(item => ({
            consumer: item.document.name, dependency: name, constraint: item.document.dependencies[name],
            current_version: installed.get(name).document.version, version: pkg.document.version,
            origin: item.document === workspace.document ? 'author' : 'installed',
            blocking: !satisfiesPackageConstraint(pkg.document.version, item.document.dependencies[name], item.document.package_schema_version),
          })),
        });
      }
    }
    const preferInstalled = options.preferInstalled ?? [...roots.keys()].some(name => !installed.has(name));
    const packages = selectPackageClosure(roots, checks, installed, { preferInstalled });
    if (packages.length > 128 || packages.reduce((sum, pkg) => sum + pkg.files.reduce((n, file) => n + file.size, 0), 0) > PACKAGE_LIMITS.totalBytes) throw packageError('PackageTooLarge', 'combined closure exceeds limits');
    const first = roots.get([...roots.keys()].sort()[0]);
    const combined = { package: first.document.name, version: first.document.version,
      composition: true, updateRoots: [...roots.keys()].sort(), closure: { first, packages } };
    // Check every consumer and the combined graph before compiling these sources.
    candidateUpdateGraph(workspace, lock, combined, options['allow-downgrade']);
    const sources = checks.map((check, index) => ({ name: check.package, digest: check.closure.first.digest,
      ...(options.sourceReviews?.[index] ?? { path: resolve(paths[index]), archive_digest: sourceDigests[index] }) })).sort((a, b) => a.name.localeCompare(b.name));
    const resolutions = checks.map(check => ({ package: check.package, author_closure: check.packages.map(({ name, version, digest }) => ({ name, version, digest })) })).sort((a, b) => a.package.localeCompare(b.package));
    const checked = { ...await checkPackageClosure(combined.closure, { projectRoot: root, inspectContracts: true }), composition: true,
      updateRoots: combined.updateRoots, updateSources: sources, resolutions };
    const review = await updateReview(workspace, lock, checked, options['allow-downgrade']);
    if (accept !== undefined && accept !== review.review_digest) throw packageError('PackageReviewChanged', 'package set or workspace changed; review again');
    if (accept === undefined) return { ...review, command: options.command ?? 'package update-set', status: 'review_required', exitCode: 0,
      notes: [`${packageLocale(options.lang) === 'fr' ? 'Revue' : 'Review'} ${review.review_digest}`,
        packageLocale(options.lang) === 'fr' ? 'Relisez chaque package, dépendance et contrat. Appliquez cette sélection exacte avec --accept <review_digest>. Détails machine : --json.'
          : 'Review every root, dependency and contract. Apply this exact selection using --accept <review_digest>. Machine details: --json.'] };
    return { ...await installPackage(first.root, { root, reviewDigest: accept, 'allow-downgrade': options['allow-downgrade'] }, first.document.name, checked), command: options.command ?? 'package update-set', review };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

/** Review frozen bytes, then apply only that review to the unchanged workspace. */
export async function reviewPackageUpdate(path, { root = process.cwd(), accept, ...options } = {}) {
  root = findPackageWorkspace(root);
  const staging = realpathSync(mkdtempSync(join(tmpdir(), 'touba-package-update-')));
  try {
    let source = resolve(path);
    if (lstatSync(source).isFile() && !source.endsWith(PACKAGE_MANIFEST)) source = unpackPackage(source, join(staging, 'source'));
    const archive = join(staging, 'review.tar.gz');
    await snapshotPackage(source, { output: archive, projectRoot: root });
    source = unpackPackage(archive, join(staging, 'review'));
    const workspace = readPackageWorkspace(root), lock = verifyInstalledPackages(root, workspace.records);
    const checked = await checkPackage(source, { ...options, projectRoot: root, inspectContracts: true });
    if (options.name && checked.package !== options.name) throw packageError('PackageNameConflict', 'replacement identity differs from the selected package');
    const review = await updateReview(workspace, lock, checked, options['allow-downgrade']);
    if (accept !== undefined && accept !== review.review_digest) throw packageError('PackageReviewChanged', 'package or workspace changed; review the update again');
    if (accept !== undefined) return { ...await updatePackage(source, { root, name: checked.package, reviewDigest: accept, 'allow-downgrade': options['allow-downgrade'] }), review };
    return { ...review, command: 'package update', status: 'review_required', exitCode: 0,
      notes: packageLocale(options.lang) === 'fr' ? [`Revue ${review.review_digest}`,
        ...(review.direction === 'downgrade' ? ['Une version antérieure est sélectionnée explicitement. Les effets externes et les données d’exécution ne sont pas restaurés. La gouvernance du consommateur reste active.'] : []),
        'Relisez les contrats et dépendances. Confirmez cette revue exacte avec --accept <review_digest>. Les permissions d’exécution restent à revoir par l’application.']
        : [`Review ${review.review_digest}`, ...(review.direction === 'downgrade' ? ['Older code selected explicitly. This does not undo external effects or restore execution data. Consumer governance remains in force.'] : []),
          'Review contracts and dependencies. Apply this exact review using --accept <review_digest>. Execution permissions still require application review.'] };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

async function installPackage(path, { root, ...options }, replacing, frozenCheck) {
  root = findPackageWorkspace(root);
  const workspace = readPackageWorkspace(root);
  const { path: configPath, bytes: configBytes, document: config } = workspace;
  const records = [...workspace.records];
  const lock = verifyInstalledPackages(root, records);
  if (replacing && !frozenCheck?.composition && !lock.packages.some(entry => entry.name === replacing)) throw packageError("PackageNotInstalled", "only an installed package can be updated");
  const oldLock = existsSync(join(root, PACKAGE_LOCK)) ? readFileSync(join(root, PACKAGE_LOCK)) : undefined;
  assertPlainDirectory(join(root, "packages"));
  const staging = mkdtempSync(join(root, ".touba-package-stage-"));
  const installed = [];
  const replaced = [];
  let transaction = false;
  let metadataChanged = false;
  let settled = false;
  try {
    const requestedName = PACKAGE_NAME.test(path) ? path : undefined;
    path = requestedName ? join(root, "packages", requestedName) : resolve(path);
    const selectedSource = path;
    if (!existsSync(path)) throw packageError("PackageSourceMissing", "supply a package directory/archive, or place the package in packages/<organization.name> before adding by name; remote installation requires --registry");
    if (!lstatSync(path).isDirectory() && !path.endsWith(PACKAGE_MANIFEST)) path = unpackPackage(path, join(staging, "extracted"));
    const checked = frozenCheck ?? await checkPackage(path, { ...options, projectRoot: root, inspectContracts: Boolean(options.reviewDigest) });
    const packages = checked.closure.packages;
    const candidateNames = new Set(packages.map(pkg => pkg.document.name));
    assertPackageModuleOwnership([
      ...lock.packages.filter(pkg => !candidateNames.has(pkg.name)).map(pkg => readPackage(resolve(root, pkg.manifest))),
      ...packages,
      ...(workspace.author ? [{ document: workspace.document }] : []),
    ]);
    if (!replacing && !frozenCheck && packages.some(pkg => lock.packages.some(entry => entry.name === pkg.document.name && entry.digest !== pkg.digest))) {
      return await reviewPackageInstallation(selectedSource, { root, ...options });
    }
    if (replacing && checked.package !== replacing) throw packageError("PackageNameConflict", "replacement identity differs from the selected package");
    if (options.reviewDigest && (await updateReview(workspace, lock, checked, options['allow-downgrade'])).review_digest !== options.reviewDigest) throw packageError('PackageReviewChanged', 'package or workspace changed; review the update again');
    if (replacing) {
      const previous = lock.packages.find(entry => entry.name === replacing);
      if (!checked.composition) updateDirection(checked.version, previous.version, options['allow-downgrade']);
      candidateUpdateGraph(workspace, lock, checked, options['allow-downgrade']);
    }
    if (requestedName && checked.package !== requestedName) throw packageError("PackageNameConflict", "folder identity differs from the requested package");
    if (workspace.author && packages.some(pkg => pkg.document.name === config.name)) throw packageError("PackageDependencyCycle", "a package cannot depend on itself");
    const updates = [];
    const previousRecords = [...records];
    for (const pkg of packages) {
      const destination = join(root, "packages", pkg.document.name);
      const manifest = `packages/${pkg.document.name}/${PACKAGE_MANIFEST}`;
      const existing = lock.packages.find(entry => entry.name === pkg.document.name);
      const replacement = existing && replacing && (pkg.document.name === replacing || (options.reviewDigest && existing.digest !== pkg.digest));
      if (existing && !replacement && (existing.version !== pkg.document.version || existing.digest !== pkg.digest)) throw packageError("PackageDependencyConflict", `different package already installed: ${pkg.document.name}`);
      const aliases = records.filter(record => resolve(root, record.manifest) === resolve(root, manifest));
      if (aliases.length > 1) throw packageError("PackageNameConflict", `duplicate project entry ${manifest}`);
      for (const record of previousRecords) {
        if (resolve(root, record.manifest) !== resolve(root, manifest) && readPackage(resolve(root, record.manifest)).document.name === pkg.document.name) throw packageError("PackageNameConflict", `another project path already declares ${pkg.document.name}`);
      }
      if (existsSync(destination)) {
        const current = readPackage(destination, { runtimeVersion });
        assertOnlyInventory(current);
        if (current.digest !== pkg.digest && !replacement) throw packageError("PackageAlreadyExists", `refusing to replace ${destination}`);
        if (replacement) {
          copyPackage(pkg, join(staging, pkg.document.name));
          updates.push({ source: join(staging, pkg.document.name), destination, backup: join(staging, `previous-${pkg.document.name}`) });
        }
      } else {
        copyPackage(pkg, join(staging, pkg.document.name));
        updates.push({ source: join(staging, pkg.document.name), destination });
      }
      if (!existing) lock.packages.push({ name: pkg.document.name, version: pkg.document.version, manifest, digest: pkg.digest, files: pkg.files });
      else if (replacement) Object.assign(existing, { version: pkg.document.version, digest: pkg.digest, files: pkg.files });
      if (!aliases.length) records.push({ manifest, version: pkg.document.version });
      else { aliases[0].version = pkg.document.version; delete aliases[0].editable; }
    }
    if (!readFileSync(configPath).equals(configBytes)) throw packageError("PackageProjectChanged", "project changed during validation; retry");
    const nowLock = existsSync(join(root, PACKAGE_LOCK)) ? readFileSync(join(root, PACKAGE_LOCK)) : undefined;
    if (oldLock?.toString() !== nowLock?.toString()) throw packageError("PackageProjectChanged", "lock changed during validation; retry");
    acquirePackageTransaction(root, { pid: process.pid, staging, replacing, packages: packages.map(p => p.document.name) });
    transaction = true;
    // Recheck after acquiring the exclusive marker: another installation may
    // have completed between the earlier snapshot check and this acquisition.
    if (!readFileSync(configPath).equals(configBytes) || oldLock?.toString() !== (existsSync(join(root, PACKAGE_LOCK)) ? readFileSync(join(root, PACKAGE_LOCK), "utf8") : undefined)) throw packageError("PackageProjectChanged", "project changed before commit; retry");
    mkdirSync(join(root, "packages"), { recursive: true });
    for (const update of updates) {
      if (update.backup) { renameSync(update.destination, update.backup); replaced.push(update); }
      else if (existsSync(update.destination)) throw packageError("PackageAlreadyExists", "destination changed during validation");
      renameSync(update.source, update.destination); installed.push(update.destination);
    }
    lock.packages.sort((a, b) => a.name.localeCompare(b.name));
    setWorkspacePackages(workspace, records, { direct: checked.updateRoots ?? checked.package });
    writeFileSync(join(staging, "lock.json"), json(lock));
    writeFileSync(join(staging, "project.json"), json(config));
    renameSync(join(staging, "lock.json"), join(root, PACKAGE_LOCK));
    metadataChanged = true;
    renameSync(join(staging, "project.json"), configPath);
    settled = true;
    return { status: "success", command: replacing ? "package update" : "package add", packages: checked.packages, notes: [packageLocale() === 'fr' ? 'Installé et enregistré. Les permissions d’exécution restent dans le projet consommateur.' : 'Installed and registered. Execution permissions remain in the consuming project.'] };
  } catch (error) {
    if (transaction) {
      if (metadataChanged) {
        writeFileSync(configPath, configBytes);
        if (oldLock) writeFileSync(join(root, PACKAGE_LOCK), oldLock);
        else rmSync(join(root, PACKAGE_LOCK), { force: true });
      }
      for (const path of installed.reverse()) rmSync(path, { recursive: true, force: true });
      for (const update of replaced.reverse()) renameSync(update.backup, update.destination);
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
  const { lock, packages: inspected } = inspectInstalledPackages(root, records);
  const entry = lock.packages.find(item => item.name === name);
  if (!entry) throw packageError("PackageNotInstalled", `${name} is not an installed package`);
  const removedExports = new Set(Object.values(inspected.get(resolve(root, entry.manifest)).document.exports ?? {}).flat());
  const orphanedEntrypoints = (config.entrypoints ?? []).filter(value => typeof value === 'string' && removedExports.has(value));
  for (const record of records) {
    const pkg = inspected.get(resolve(root, record.manifest)) ?? readPackage(resolve(root, record.manifest));
    if (pkg.document.name !== name && Object.hasOwn(pkg.document.dependencies ?? {}, name)) throw Object.assign(packageError("PackageInUse", `${pkg.document.name} depends on ${name}`), { packageName: pkg.document.name });
  }
  const lockBytes = readFileSync(join(root, PACKAGE_LOCK));
  const staging = mkdtempSync(join(root, ".touba-package-stage-"));
  const destination = dirname(resolve(root, entry.manifest)), saved = join(staging, "removed");
  let transaction = false, moved = false, settled = false;
  try {
    acquirePackageTransaction(root, { pid: process.pid, staging, remove: name }); transaction = true;
    if (!readFileSync(configPath).equals(configBytes) || !readFileSync(join(root, PACKAGE_LOCK)).equals(lockBytes)) throw packageError("PackageProjectChanged", "project changed during validation; retry");
    renameSync(destination, saved); moved = true;
    setWorkspacePackages(workspace, records.filter(record => resolve(root, record.manifest) !== resolve(root, entry.manifest)));
    lock.packages = lock.packages.filter(item => item.name !== name);
    writeFileSync(join(staging, "project.json"), json(config));
    writeFileSync(join(staging, "lock.json"), json(lock));
    renameSync(join(staging, "lock.json"), join(root, PACKAGE_LOCK));
    renameSync(join(staging, "project.json"), configPath);
    settled = true;
    return { status: "success", command: "package remove", package: name, orphaned_entrypoints: orphanedEntrypoints,
      notes: [packageLocale() === 'fr' ? "Package installé et entrée du verrou retirés. Les imports sources restent inchangés ; préparez de nouveau le projet avant exécution." : "Removed installed package and its lock entry. Project source imports are unchanged; prepare again before running.",
        ...(orphanedEntrypoints.length ? [(packageLocale() === 'fr' ? 'Points d’entrée à revoir : ' : 'Entrypoints to review: ') + orphanedEntrypoints.join(', ')] : [])] };
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
