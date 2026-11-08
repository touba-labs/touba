import { mkdtempSync, readFileSync, writeFileSync, rmSync, existsSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { addPackage, updatePackage, removePackage, isNewerPackageVersion, checkPackageArchive, snapshotPackage, resolveRegistryArchive } from "../../touba-project/src/packages.mjs";
import { readPackageWorkspace, verifyInstalledPackages } from "../../touba-project/src/package-store.mjs";
import { PACKAGE_LIMITS, PACKAGE_NAME, packageFile } from "../../touba-project/src/package-contract.mjs";
import { packageHostInventory, readPackageHostPlan } from "../../touba-project/src/package-host-plan.mjs";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;
const summary = ({ name, version, digest }) => ({ name, version, digest });
export const PACKAGE_UPLOAD_LIMIT = PACKAGE_LIMITS.totalBytes;

/** Preview owns an immutable upload; apply delegates every installation check to Core. */
export function createProjectPackageSurface(root, { now = Date.now, registry, trust } = {}) {
  const pending = new Map();
  const resolutions = new Map();
  if (Boolean(registry) !== Boolean(trust)) fail('ToubaServePackageInvalid', 'configure both package registry and local trust file');
  let registryRoot = null;
  if (registry) {
    const url = new URL(registry);
    if ((url.protocol !== 'https:' && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))
      || url.username || url.password || url.search || url.hash) fail('ToubaServePackageInvalid', 'invalid package registry URL');
    registryRoot = url.href.replace(/\/$/, '');
  }
  let working = false, receiving = false, closed = false;
  const revision = () => {
    const workspace = readPackageWorkspace(root);
    return hash(Buffer.concat([workspace.bytes, existsSync(join(root, "touba.packages.lock.json"))
      ? readFileSync(join(root, "touba.packages.lock.json")) : Buffer.alloc(0)]));
  };
  function discard(id) {
    const item = pending.get(id);
    if (item) { pending.delete(id); if (item.directory) rmSync(item.directory, { recursive: true, force: true }); }
  }
  function expire() {
    for (const [id, item] of pending) if (item.expires <= now()) discard(id);
    for (const [id, item] of resolutions) if (item.expires <= now()) resolutions.delete(id);
  }
  async function verifyResolution(proof) {
    if (!registryRoot) fail('ToubaServePackageInvalid', 'operator has not configured a trusted registry');
    if (!proof || Object.keys(proof).some(key => !['name', 'version', 'index_jwt', 'metadata'].includes(key))
      || typeof proof.index_jwt !== 'string' || Buffer.byteLength(proof.index_jwt) > 8 * 1024 * 1024
      || typeof proof.metadata !== 'string' || Buffer.byteLength(proof.metadata) > 1024 * 1024) fail('ToubaServePackageInvalid', 'invalid signed registry evidence');
    // The browser carries bytes, never credentials or a fetch instruction.
    // Core verifies the signature and canonical metadata digest. No server-side
    // network or contributor-supplied path can be reached by this callback.
    return resolveRegistryArchive(proof.name, { registry: registryRoot, trust, version: proof.version }, async (location, limit) => {
      const url = new URL(location), base = new URL(registryRoot + '/');
      if (url.origin !== base.origin || !url.pathname.startsWith(base.pathname) || url.search || url.hash || url.username || url.password) fail('ToubaServePackageInvalid', 'registry reference outside selected origin');
      const value = url.href === new URL('index.jwt', base).href ? proof.index_jwt : proof.metadata;
      const bytes = Buffer.from(value);
      if (bytes.length > limit) fail('ToubaServePackageInvalid', 'registry evidence exceeds limit');
      return bytes;
    });
  }
  const timer = setInterval(expire, 30000); timer.unref?.();
  async function preview(principal, source) {
    expire();
    if (closed || working) fail("ToubaServePackageBusy", "A package operation is in progress");
    if (pending.size + resolutions.size >= 2) fail("ToubaServePackageCapacity", "Cancel or finish a pending package preview");
    working = true;
    const directory = realpathSync(mkdtempSync(join(tmpdir(), "touba-studio-package-")));
    try {
      const archive = join(directory, "package.tar.gz"), before = revision();
      let bytes;
      if (source.proof) {
        const verified = await verifyResolution(source.proof);
        if (hash(source.bytes) !== verified.artifact.digest) fail('PackageIntegrityMismatch', 'registry archive digest mismatch');
      }
      if (source.name !== undefined) {
        if (typeof source.name !== "string" || !PACKAGE_NAME.test(source.name)) fail("ToubaServePackageInvalid", "Select an exact package name under packages/");
        // No arbitrary host path and no directory/symlink escape. Selection is
        // relative to this project's managed directory, as in `package add`.
        const path = packageFile(root, `packages/${source.name}`);
        await snapshotPackage(path, { output: archive, projectRoot: root });
        bytes = readFileSync(archive);
      } else {
        bytes = source.bytes;
        if (!Buffer.isBuffer(bytes) || bytes.length > PACKAGE_UPLOAD_LIMIT) fail("ToubaServePackageInvalid", "Invalid package archive");
        writeFileSync(archive, bytes, { flag: "wx", mode: 0o600 });
      }
      const checked = await checkPackageArchive(archive, { projectRoot: root, inspectContracts: true });
      const existing = verifyInstalledPackages(root, readPackageWorkspace(root).records).packages.find(item => item.name === checked.package);
      if (existing?.version === checked.version && existing.digest !== checked.packages.find(item => item.name === checked.package)?.digest) fail("PackageVersionConflict", "an existing version cannot be replaced with different content");
      const updating = existing && existing.version !== checked.version;
      if (updating && !isNewerPackageVersion(checked.version, existing.version)) fail("PackageVersionConflict", "an update requires a newer version");
      if (source.name !== undefined && checked.package !== source.name) fail("ToubaServePackageInvalid", "Folder and package identities differ");
      if (source.proof && (checked.package !== source.proof.name || checked.version !== source.proof.version)) fail('PackageDependencyConflict', 'archive identity differs from the signed registry selection');
      if (closed || before !== revision()) fail("ToubaServePackageConflict", "Project changed during preview");
      const id = randomUUID(), expires = now() + 300000;
      pending.set(id, { principal, directory, archive, digest: hash(bytes), revision: before, expires, proof: source.proof, updating: updating ? checked.package : null });
      return { schema_version: "touba-project-package-preview-v1", id, revision: before, archive_digest: hash(bytes),
        expires_at: new Date(expires).toISOString(), name: checked.package, version: checked.version,
        operation: updating ? "update" : "install", previous_version: existing?.version ?? null,
        contracts: checked.contracts,
        packages: checked.packages.map(summary), validation: "source_contracts" };
    } catch (error) { rmSync(directory, { recursive: true, force: true }); throw error; }
    finally { working = false; }
  }
  return {
    async receive(operation) {
      if (closed || receiving || working) fail('ToubaServePackageBusy', 'a package transfer is in progress');
      receiving = true;
      try { return await operation(); } finally { receiving = false; }
    },
    registry() { return { registry: registryRoot, configured: Boolean(registryRoot) }; },
    async resolveRegistry(principal, proof) {
      expire();
      if (closed || working) fail('ToubaServePackageBusy', 'a package operation is in progress');
      if (pending.size + resolutions.size >= 2) fail('ToubaServePackageCapacity', 'finish or cancel a pending preview');
      working = true;
      try {
        const verified = await verifyResolution(proof);
        if (closed) fail('ToubaServePackageBusy', 'package surface is closed');
        const id = randomUUID(), expires = now() + 300000;
        resolutions.set(id, { principal, proof, expires });
        return { id, archive: verified.location, archive_digest: verified.artifact.digest, expires_at: new Date(expires).toISOString() };
      } finally { working = false; }
    },
    async previewRegistry(principal, id, bytes) {
      expire();
      const item = resolutions.get(id);
      if (!item || item.principal !== principal) fail('ToubaServePackagePreviewMissing', 'registry resolution is unavailable');
      resolutions.delete(id);
      return preview(principal, { bytes, proof: item.proof });
    },
    inventory() {
      const workspace = readPackageWorkspace(root);
      const lock = verifyInstalledPackages(root, workspace.records);
      const inventory = packageHostInventory(root);
      let host_plan = null, host_plan_error = null;
      try { host_plan = readPackageHostPlan(root, { inventory }); }
      catch (error) { host_plan_error = { code: error.code ?? 'PackageHostPlanInvalid', message: error.message }; }
      return { schema_version: "touba-project-packages-v1", revision: revision(), packages: lock.packages.map(summary),
        ...inventory, host_plan, host_plan_error };
    },
    preview: (principal, bytes) => preview(principal, { bytes }),
    previewLocal: (principal, name) => preview(principal, { name }),
    previewRemoval(principal, name) {
      expire();
      if (closed || working) fail("ToubaServePackageBusy", "A package operation is in progress");
      if (pending.size + resolutions.size >= 2) fail("ToubaServePackageCapacity", "Cancel or finish a pending package preview");
      if (!PACKAGE_NAME.test(name ?? "")) fail("ToubaServePackageInvalid", "Select an installed package name");
      const lock = verifyInstalledPackages(root, readPackageWorkspace(root).records);
      const entry = lock.packages.find(item => item.name === name);
      if (!entry) fail("PackageNotInstalled", "Select an installed package");
      const id = randomUUID(), expires = now() + 300000, before = revision();
      pending.set(id, { principal, removal: name, digest: entry.digest, revision: before, expires });
      return { schema_version: "touba-project-package-removal-v1", id, revision: before, package_digest: entry.digest,
        name, version: entry.version, expires_at: new Date(expires).toISOString() };
    },
    applyRemoval(principal, request) {
      expire();
      if (closed || working) fail("ToubaServePackageBusy", "A package operation is in progress");
      const item = pending.get(request?.id);
      if (!item?.removal || item.principal !== principal) fail("ToubaServePackagePreviewMissing", "Removal preview is unavailable");
      if (request.revision !== item.revision || revision() !== item.revision || request.package_digest !== item.digest) fail("ToubaServePackageConflict", "Project changed; preview again");
      pending.delete(request.id); working = true;
      try { return { ...removePackage(item.removal, { root }), package_digest: item.digest }; }
      finally { working = false; }
    },
    cancel(principal, id) {
      const resolution = resolutions.get(id);
      if (resolution) {
        if (resolution.principal !== principal) fail('ToubaServePackagePreviewMissing', 'registry resolution is unavailable');
        resolutions.delete(id); return { status: 'cancelled' };
      }
      const item = pending.get(id);
      if (!item || item.principal !== principal) fail("ToubaServePackagePreviewMissing", "Package preview is unavailable");
      discard(id); return { status: "cancelled" };
    },
    async apply(principal, request) {
      expire();
      if (closed || working) fail("ToubaServePackageBusy", "A package operation is in progress");
      const item = pending.get(request?.id);
      if (!item || item.removal || item.principal !== principal) fail("ToubaServePackagePreviewMissing", "Package preview is unavailable");
      if (request.revision !== item.revision || revision() !== item.revision || request.archive_digest !== item.digest
        || hash(readFileSync(item.archive)) !== item.digest) fail("ToubaServePackageConflict", "Package or project changed; preview again");
      working = true;
      // Claim once, including failed installation. Core rolls back its own transaction.
      pending.delete(request.id);
      try {
        if (item.proof) await verifyResolution(item.proof);
        return await (item.updating ? updatePackage(item.archive, { root, name: item.updating }) : addPackage(item.archive, { root }));
      }
      finally { rmSync(item.directory, { recursive: true, force: true }); working = false; }
    },
    close() { closed = true; clearInterval(timer); resolutions.clear(); for (const id of pending.keys()) discard(id); },
  };
}
