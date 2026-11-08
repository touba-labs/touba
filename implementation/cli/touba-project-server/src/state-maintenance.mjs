import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readSync, readFileSync, readdirSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

// Deliberate allowlist: credentials, manifests, handlers, AIR and SDKs stay put.
const STATE_FILES = Object.freeze([
  "sandbox-checkpoints.sqlite", "human-requests.sqlite", "human-decisions.sqlite",
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
  if (!recovery && existsSync(join(root, "state-archive.pending.json"))) fail("ToubaStateArchiveInterrupted", "restore the pending state archive before serving");
  const token = randomUUID();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(file, JSON.stringify({ pid: process.pid, token }), { flag: "wx", mode: 0o600 });
      return () => {
        if (existsSync(file) && JSON.parse(readFileSync(file, "utf8")).token === token) unlinkSync(file);
      };
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
      fail("ToubaStateInUse", "stop the project server before state maintenance");
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
      if (["-wal", "-shm", "-journal"].some(suffix => existsSync(file + suffix))) fail("ToubaServeStateSnapshotRequired");
      files.push({ path: name, bytes: stat.size, sha256: fileDigest(file) });
    } else fail("ToubaStatePathInvalid");
  }
  for (const name of names) if (existsSync(join(root, name))) visit(name);
  return files;
}

function archiveRoot(root) {
  const directory = join(root, "state-archives");
  if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
  if (lstatSync(directory).isSymbolicLink() || !lstatSync(directory).isDirectory()) fail("ToubaStatePathInvalid");
  return directory;
}

// Called with the offline validator injected, keeping host code out of this path.
export function archiveProjectState(options, checkState) {
  const root = stateRoot(options.projectRoot ?? process.cwd());
  const release = acquireStateLease(options.projectRoot ?? process.cwd());
  try {
    if (Object.keys(options).some(key => key.endsWith("Path") && options[key] !== undefined)) fail("ToubaStateCustomPathsUnsupported", "state archival uses the standard project state paths");
    const report = checkState(options);
    const errors = report.diagnostics.filter(d => d.code !== "ToubaServeStateBuildMismatch");
    if (errors.length || report.stores.some(s => (s.active_waits ?? 0) + (s.active_operations ?? 0) > 0)) {
      fail("ToubaStateNotQuiescent", "resolve active operations and state diagnostics before archiving");
    }
    const files = inventory(root);
    const triggers = join(root, "trigger-status.json");
    if (existsSync(triggers)) {
      const status = JSON.parse(readFileSync(triggers, "utf8"));
      if (!Array.isArray(status.triggers) || status.triggers.some(trigger =>
        !trigger.queue || ["pending", "processing", "dead_letter"].some(key => trigger.queue[key] !== 0))) {
        fail("ToubaStateNotQuiescent", "drain trigger queues before state archival");
      }
    }
    const preview = { schema_version: "touba-state-archive-v1", status: "preview", files,
      bytes: files.reduce((sum, file) => sum + file.bytes, 0) };
    if (!options.applyState || !files.length) return preview;
    const id = `${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
    const destination = join(archiveRoot(root), id);
    mkdirSync(destination, { mode: 0o700 });
    const names = STATE_FILES.filter(name => existsSync(join(root, name)));
    const manifest = { ...preview, status: "archived", archive_id: id, names };
    writeFileSync(join(destination, "archive.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    // A crash between renames blocks server startup; restore handles both sides.
    writeFileSync(join(root, "state-archive.pending.json"), JSON.stringify({ archive_id: id }), { flag: "wx", mode: 0o600 });
    for (const name of names) renameSync(join(root, name), join(destination, name));
    unlinkSync(join(root, "state-archive.pending.json"));
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
    if (interrupted && (lstatSync(pending).isSymbolicLink() || !lstatSync(pending).isFile())) fail("ToubaStatePathInvalid");
    if (interrupted && JSON.parse(readFileSync(pending, "utf8")).archive_id !== id) fail("ToubaStateArchiveInterrupted");
    if (STATE_FILES.some(name => !manifest.names.includes(name) && existsSync(join(root, name)))) fail("ToubaStateRestoreConflict");
    const observed = [];
    for (const name of manifest.names) {
      const archived = existsSync(join(source, name)), current = existsSync(join(root, name));
      if (archived && current || !archived && !current || current && !interrupted) fail("ToubaStateRestoreConflict", "restore never overwrites current state");
      observed.push(...inventory(archived ? source : root, [name]));
    }
    if (JSON.stringify(observed) !== JSON.stringify(manifest.files)) fail("ToubaStateArchiveIntegrityMismatch");
    if (!options.applyState) return { ...manifest, status: "restore_preview" };
    if (!interrupted) writeFileSync(pending, JSON.stringify({ archive_id: id }), { flag: "wx", mode: 0o600 });
    for (const name of manifest.names) if (existsSync(join(source, name))) renameSync(join(source, name), join(root, name));
    unlinkSync(pending);
    return { ...manifest, status: "restored" };
  } finally { release(); }
}
