import { createHash, randomUUID } from "node:crypto";
import { closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Deliberate allowlist: credentials, manifests, handlers, AIR and SDKs stay put.
const STATE_FILES = Object.freeze([
  "sandbox-checkpoints.sqlite", "approval-checkpoints.sqlite", "human-requests.sqlite", "human-decisions.sqlite",
  "project-change-proposals.sqlite",
  "traces.sqlite", "native-traces.sqlite",
  "project.effect-journal.sqlite", "interaction-sessions.sqlite", "interaction-assets.sqlite",
  "interaction-assets", "project-events.jsonl", "current-run-summary.json",
  "cloud-notifications.cursor.json",
  "trigger-scheduler.sqlite",
  "project-validation.sqlite",
  "current-trace-timeline.json", "native-traces", "trigger-status.json", "cost-observatory.json", "state-origin.json",
]);
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const heldLeases = new WeakMap();
// Admission history stays active so archival cannot reset trigger replay protection or quotas.
const RETAINED_STATE_FILES = Object.freeze(['triggers.sqlite', 'trigger-queue.sqlite', 'project-webhooks.sqlite']);
function syncPath(path) {
  const fd = openSync(path, 'r');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}
function durableJson(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  syncPath(path);
}
function fileDigest(path) {
  const file = openSync(path, "r"), buffer = Buffer.alloc(64 * 1024), hash = createHash("sha256");
  try { let size; while ((size = readSync(file, buffer)) > 0) hash.update(buffer.subarray(0, size)); return hash.digest("hex"); }
  finally { closeSync(file); }
}

function stateRoot(projectRoot) {
  const root = realpathSync(resolve(projectRoot));
  const directory = join(root, ".touba");
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  const stat = lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("ToubaStatePathInvalid");
  return directory;
}

export function acquireStateLease(projectRoot, { recovery = false } = {}) {
  const root = stateRoot(projectRoot), file = join(root, "server-state.lock");
  if (!recovery && lstatSync(join(root, 'state-archive.pending.json'), { throwIfNoEntry: false })) fail("ToubaStateArchiveInterrupted", "restore the pending state archive before serving");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      const release = () => {
        if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file);
        heldLeases.delete(release);
      };
      heldLeases.set(release, root);
      return release;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      const stat = lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) fail("ToubaStateLockInvalid");
      let owner;
      try { owner = JSON.parse(readFileSync(file, "utf8")); } catch { fail("ToubaStateLockInvalid"); }
      if (!Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.token !== "string") fail("ToubaStateLockInvalid");
      try { process.kill(owner.pid, 0); }
      catch (cause) {
        if (cause.code === "ESRCH") { unlinkSync(file); continue; }
      }
      fail("ToubaStateInUse", `project state is in use by process ${owner.pid}; stop that process cleanly before restarting or maintaining the project`);
    }
  }
  fail("ToubaStateInUse");
}

function inventory(root, names = STATE_FILES) {
  const files = [];
  function visit(name) {
    const file = join(root, name);
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) fail("ToubaStatePathInvalid");
    if (stat.isDirectory()) {
      for (const child of readdirSync(file).sort()) visit(`${name}/${child}`);
    } else if (stat.isFile()) {
      if (stat.nlink !== 1) fail('ToubaStatePathInvalid');
      if (["-wal", "-shm", "-journal"].some(suffix => existsSync(file + suffix))) fail("ToubaServeStateSnapshotRequired");
      files.push({ path: name, bytes: stat.size, sha256: fileDigest(file) });
    } else fail("ToubaStatePathInvalid");
  }
  for (const name of names) if (lstatSync(join(root, name), { throwIfNoEntry: false })) visit(name);
  return files;
}

function archiveRoot(root) {
  const directory = join(root, "state-archives");
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) fail("ToubaStatePathInvalid");
  return directory;
}

// Called with the offline validator injected, keeping host code out of this path.
export function archiveProjectState(options, checkState, lease) {
  const root = stateRoot(options.projectRoot ?? process.cwd());
  if (lease && heldLeases.get(lease) !== root) fail('ToubaStateLeaseInvalid');
  const release = lease ? () => {} : acquireStateLease(options.projectRoot ?? process.cwd());
  try {
    if (Object.keys(options).some(key => key.endsWith("Path") && options[key] !== undefined)) fail("ToubaStateCustomPathsUnsupported", "state archival uses the standard project state paths");
    if (options.abandonWaits && (typeof options.stateReason !== 'string' || !options.stateReason.trim()
      || options.stateReason.length > 500 || /[\u0000-\u001f\u007f]/u.test(options.stateReason))) {
      fail('ToubaStateRecoveryReasonRequired', 'provide a short reason without secrets or control characters');
    }
    const files = inventory(root);
    const retained = options.abandonWaits ? inventory(root, RETAINED_STATE_FILES) : [];
    const report = checkState(options);
    const errors = report.diagnostics.filter(d => d.code !== "ToubaServeStateBuildMismatch");
    if (options.abandonWaits && errors.length) fail(errors[0].code, errors[0].message ?? `Offline recovery requires reconciliation of ${errors[0].store ?? 'project state'}`);
    const reviewedStores = new Set(['sandboxCheckpointsPath', 'interactionSessionsPath', 'schedulerPath']);
    const activeStores = report.stores.filter(s => (!options.abandonWaits || !reviewedStores.has(s.store))
      && (s.active_waits ?? 0) + (s.active_operations ?? 0) > 0);
    if (errors.length || options.abandonWaits && !report.recovery
      || activeStores.length) {
      fail("ToubaStateNotQuiescent", activeStores.length
        ? `Reconcile active state before archiving: ${activeStores.map(s => `${s.store} (${(s.active_waits ?? 0) + (s.active_operations ?? 0)})`).join(', ')}`
        : "resolve state diagnostics before archiving");
    }
    const triggers = join(root, "trigger-status.json");
    if (existsSync(triggers)) {
      const status = JSON.parse(readFileSync(triggers, "utf8"));
      const retainedDeadLetters = options.abandonOperations && options.abandonWaits
        && Number.isSafeInteger(report.recovery?.retained_dead_letters) ? report.recovery.retained_dead_letters : 0;
      if (!Array.isArray(status.triggers) || status.triggers.some(trigger =>
        !trigger.queue || ["pending", "processing"].some(key => trigger.queue[key] !== 0)
        || !Number.isSafeInteger(trigger.queue.dead_letter) || trigger.queue.dead_letter < 0)
        || status.triggers.reduce((sum, trigger) => sum + trigger.queue.dead_letter, 0) !== retainedDeadLetters) {
        fail("ToubaStateNotQuiescent", "drain trigger queues before state archival");
      }
    }
    if (JSON.stringify(files) !== JSON.stringify(inventory(root))
      || options.abandonWaits && JSON.stringify(retained) !== JSON.stringify(inventory(root, RETAINED_STATE_FILES))) fail('ToubaStateReviewStale');
    const recovery = options.abandonWaits ? { mode: 'abandon_waits', reason: options.stateReason.trim(),
      original_build_id: report.origin.build_id, candidate_build_id: report.candidate_build_id,
      ...report.recovery } : undefined;
    const reviewDigest = recovery ? createHash('sha256').update(JSON.stringify({ root, files, retained, recovery })).digest('hex') : undefined;
    const preview = { schema_version: "touba-state-archive-v1", status: "preview", files,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0),
      ...(recovery ? { recovery, review_digest: reviewDigest, retained_files: retained } : {}) };
    if (!options.applyState || !files.length) return preview;
    if (recovery && options.stateReviewDigest !== reviewDigest) fail('ToubaStateReviewStale', 'review the current preview and confirm its exact review_digest');
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const destination = join(archiveRoot(root), id);
    mkdirSync(destination, { mode: 0o700 });
    if (retained.length) {
      mkdirSync(join(destination, 'retained'), { mode: 0o700 });
      for (const file of retained) {
        const copy = join(destination, 'retained', file.path);
        copyFileSync(join(root, file.path), copy); syncPath(copy);
        if (fileDigest(copy) !== file.sha256) fail('ToubaStateReviewStale');
      }
    }
    const names = STATE_FILES.filter(name => existsSync(join(root, name)));
    const manifest = { ...preview, status: "archived", archive_id: id, names,
      ...(recovery ? { recovery: { ...recovery, abandoned_at: new Date().toISOString(),
        waits: recovery.waits.map(wait => ({ ...wait, status: 'abandoned' })) } } : {}) };
    durableJson(join(destination, 'archive.json'), manifest);
    for (const file of files) syncPath(join(root, file.path));
    // A crash between renames blocks server startup; restore handles both sides.
    durableJson(join(root, 'state-archive.pending.json'), { archive_id: id });
    if (process.platform !== 'win32') { syncPath(destination); syncPath(archiveRoot(root)); syncPath(root); }
    for (const name of names) renameSync(join(root, name), join(destination, name));
    if (JSON.stringify(inventory(destination, names)) !== JSON.stringify(files)) fail('ToubaStateArchiveIntegrityMismatch');
    if (recovery && JSON.stringify(retained) !== JSON.stringify(inventory(root, RETAINED_STATE_FILES))) fail('ToubaStateReviewStale');
    if (process.platform !== 'win32') { syncPath(destination); syncPath(root); }
    unlinkSync(join(root, "state-archive.pending.json"));
    if (process.platform !== 'win32') syncPath(root);
    return manifest;
  } finally { release(); }
}

export function restoreProjectState(options) {
  const root = stateRoot(options.projectRoot ?? process.cwd()), id = options.restoreState;
  if (typeof id !== "string" || !/^\d{4}-\d{2}-\d{2}T[\d-]+Z-[a-f0-9]{8}$/.test(id)) fail("ToubaStateArchiveIdInvalid");
  const release = acquireStateLease(options.projectRoot ?? process.cwd(), { recovery: true });
  try {
    const source = join(archiveRoot(root), id);
    if (lstatSync(source).isSymbolicLink() || !lstatSync(source).isDirectory()) fail("ToubaStatePathInvalid");
    const manifestPath = join(source, "archive.json");
    if (lstatSync(manifestPath).isSymbolicLink()) fail("ToubaStatePathInvalid");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    if (manifest.schema_version !== "touba-state-archive-v1" || manifest.archive_id !== id
      || !Array.isArray(manifest.names) || new Set(manifest.names).size !== manifest.names.length
      || !manifest.names.every(name => STATE_FILES.includes(name)) || !Array.isArray(manifest.files)) fail("ToubaStateArchiveInvalid");
    const pending = join(root, "state-archive.pending.json");
    const interrupted = existsSync(pending);
    if (manifest.recovery && !interrupted) fail('ToubaStateAbandonedArchive', 'completed abandonment archives are evidence; their waits cannot be reactivated by restore');
    if (interrupted && (lstatSync(pending).isSymbolicLink() || !lstatSync(pending).isFile())) fail("ToubaStatePathInvalid");
    if (interrupted && JSON.parse(readFileSync(pending, "utf8")).archive_id !== id) fail("ToubaStateArchiveInterrupted");
    if (manifest.recovery) {
      if (manifest.recovery.mode !== 'abandon_waits' || !Array.isArray(manifest.retained_files)) fail('ToubaStateArchiveInvalid');
      if (JSON.stringify(inventory(root, RETAINED_STATE_FILES)) !== JSON.stringify(manifest.retained_files)) fail('ToubaStateRestoreConflict');
      if (manifest.retained_files.length) {
        const retainedRoot = join(source, 'retained');
        if (lstatSync(retainedRoot).isSymbolicLink() || !lstatSync(retainedRoot).isDirectory()) fail('ToubaStatePathInvalid');
        if (JSON.stringify(inventory(retainedRoot, RETAINED_STATE_FILES)) !== JSON.stringify(manifest.retained_files)) fail('ToubaStateArchiveIntegrityMismatch');
      }
    }
    if (STATE_FILES.some(name => !manifest.names.includes(name) && existsSync(join(root, name)))) fail("ToubaStateRestoreConflict");
    const observed = [];
    for (const name of manifest.names) {
      const archived = existsSync(join(source, name)), current = existsSync(join(root, name));
      if (archived && current || !archived && !current || current && !interrupted) fail("ToubaStateRestoreConflict", "restore never overwrites current state");
      observed.push(...inventory(archived ? source : root, [name]));
    }
    if (JSON.stringify(observed) !== JSON.stringify(manifest.files)) fail("ToubaStateArchiveIntegrityMismatch");
    if (!options.applyState) return { ...manifest, status: "restore_preview" };
    if (!interrupted) durableJson(pending, { archive_id: id });
    if (process.platform !== 'win32') syncPath(root);
    for (const name of manifest.names) if (existsSync(join(source, name))) renameSync(join(source, name), join(root, name));
    if (process.platform !== 'win32') { syncPath(source); syncPath(root); }
    unlinkSync(pending);
    if (process.platform !== 'win32') syncPath(root);
    return { ...manifest, status: "restored" };
  } finally { release(); }
}
