import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, closeSync, copyFileSync, existsSync, fsyncSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { acquireStateLease } from './state-maintenance.mjs';
import { currentStateBuild, inspectStateOrigin, validateStateOrigin } from './state-origin.mjs';
import { auditNativeTraceJournal } from './native-trace-journal.mjs';
import { createSqliteTraceStore } from '../../../runtime/touba-runtime/src/sqlite-trace-store.mjs';
import { validateTraceMachineStream } from '../../../contracts/machine/contracts.mjs';

const STORES = new Set(['sandbox-checkpoints.sqlite', 'approval-checkpoints.sqlite', 'human-requests.sqlite',
  'human-decisions.sqlite', 'project-change-proposals.sqlite', 'project.effect-journal.sqlite',
  'interaction-sessions.sqlite', 'interaction-assets.sqlite', 'trigger-scheduler.sqlite', 'project-validation.sqlite',
  'project-webhooks.sqlite', 'trigger-queue.sqlite', 'triggers.sqlite', 'traces.sqlite', 'native-traces.sqlite']);
const EVIDENCE_DIRECTORIES = new Set(['interaction-assets', 'evidence']);
const FILES = new Set([...STORES, ...EVIDENCE_DIRECTORIES, 'state', 'project-events.jsonl', 'current-run-summary.json',
  'cloud-notifications.cursor.json', 'current-trace-timeline.json', 'trigger-status.json', 'cost-observatory.json', 'state-origin.json']);
// Known non-state paths remain untouched. Unknown files require an adapter review.
const EXCLUDED = new Set(['build', 'sdk', 'packages', 'cache', 'state-archives', 'state-adoptions', 'server-state.lock',
  'product-identity.json', 'handler-sandbox-status.json', 'package-hosts.json', 'registry.json']);
const PENDING = 'state-adoption.pending.json';
const fail = (code, message = code) => { throw Object.assign(new Error(message), { code }); };
const unsupported = store => {
  const safe = typeof store === 'string' && store.length <= 240 && /^(?:state\/)?[A-Za-z0-9_.-]+$/.test(store)
    && !store.split('/').some(part => part === '.' || part === '..');
  throw Object.assign(new Error('A state adapter review is required; preserve this store and use the previous build until compatibility is established'),
    { code: 'ToubaStateAdoptionStoreUnsupported', ...(safe ? { store } : {}) });
};
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
function fileDigest(path) {
  const fd = openSync(path, 'r'), hash = createHash('sha256'), buffer = Buffer.alloc(65536);
  try { let n; while ((n = readSync(fd, buffer))) hash.update(buffer.subarray(0, n)); return hash.digest('hex'); }
  finally { closeSync(fd); }
}
function sync(path) {
  if (process.platform === 'win32' && lstatSync(path).isDirectory()) return;
  const fd = openSync(path, 'r'); try { fsyncSync(fd); } finally { closeSync(fd); }
}
function jsonFile(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 }); sync(path);
}
function readJson(path, maxBytes = 256 * 1024) {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size > maxBytes) fail('ToubaStatePathInvalid');
  try { return JSON.parse(readFileSync(path, 'utf8')); } catch { fail('ToubaStateAdoptionInvalid'); }
}
function directory(path) {
  if (!existsSync(path)) mkdirSync(path, { mode: 0o700 });
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail('ToubaStatePathInvalid');
}
function inventory(root, maxBytes, recovering = false) {
  const rows = []; let bytes = 0;
  function visit(name) {
    const path = join(root, name), stat = lstatSync(path);
    if (stat.isSymbolicLink()) fail('ToubaStatePathInvalid');
    if (stat.isDirectory()) {
      // The default local secret configuration is copied privately, never loaded
      // or returned. Other stores in state/ need an explicit compatibility adapter.
      if (name === 'state') {
        for (const child of readdirSync(path).sort()) {
          if (child !== 'secrets.local.json') unsupported(`state/${child}`);
          visit(`state/${child}`);
        }
        return;
      }
      if (![...EVIDENCE_DIRECTORIES].some(prefix => name === prefix || name.startsWith(prefix + '/'))) fail('ToubaStatePathInvalid');
      for (const child of readdirSync(path).sort()) visit(`${name}/${child}`);
    } else {
      if (!stat.isFile() || stat.nlink !== 1) fail('ToubaStatePathInvalid');
      bytes += stat.size;
      if (bytes > maxBytes || rows.length >= 100000) fail('ToubaStateAdoptionCapacityExceeded');
      if (name.endsWith('.sqlite') && ['-wal', '-journal', '-shm'].some(s => existsSync(path + s))) fail('ToubaServeStateSnapshotRequired');
      rows.push({ path: name, bytes: stat.size, sha256: fileDigest(path) });
    }
  }
  for (const name of readdirSync(root).sort()) {
    if (recovering && [PENDING, 'state-origin.next.json'].includes(name)) continue;
    if (EXCLUDED.has(name)) {
      if (lstatSync(join(root, name)).isSymbolicLink()) fail('ToubaStatePathInvalid');
      continue;
    }
    if (!FILES.has(name)) unsupported(name);
    visit(name);
  }
  return rows;
}
function lockStores(root, files) {
  const held = new Map();
  try {
    for (const row of files.filter(row => STORES.has(row.path))) {
      const db = new DatabaseSync(join(root, row.path), { timeout: 0, allowExtension: false }); held.set(row.path, db);
      db.exec('PRAGMA trusted_schema=OFF; PRAGMA busy_timeout=0;');
      if (db.prepare('PRAGMA journal_mode').get().journal_mode !== 'delete') fail('ToubaServeStateSnapshotRequired');
      db.exec('BEGIN EXCLUSIVE');
      if (db.prepare('PRAGMA integrity_check').get().integrity_check !== 'ok') fail('ToubaStateAdoptionStoreInvalid');
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' LIMIT 1").get()) fail('ToubaStateAdoptionStoreInvalid');
      const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all().map(row => row.name);
      if (tables.includes('metadata') && (tables.length !== 2 || !tables.includes('records'))) unsupported(row.path);
      if (row.path === 'traces.sqlite' && tables.some(name => !['touba_trace_storage', 'touba_trace_segments', 'touba_trace_events', 'touba_trace_origins'].includes(name))) unsupported(row.path);
    }
    return held;
  } catch (error) { releaseStores(held); if (error.errcode === 5 || error.errcode === 6) fail('ToubaStateInUse'); throw error; }
}
function releaseStores(held) { for (const db of [...held.values()].reverse()) { try { if (db.isTransaction) db.exec('ROLLBACK'); } finally { db.close(); } } }
function copyFiles(root, destination, files) {
  const directories = new Set([destination]);
  for (const row of files) {
    const path = join(destination, row.path); mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    for (let parent = dirname(path); parent !== destination; parent = dirname(parent)) directories.add(parent);
    copyFileSync(join(root, row.path), path); chmodSync(path, 0o600); sync(path);
    if (fileDigest(path) !== row.sha256) fail('ToubaStateReviewStale');
  }
  for (const path of [...directories].sort((a, b) => b.length - a.length)) sync(path);
}
function extraAudits(root, held) {
  if (existsSync(join(root, 'trigger-status.json'))) {
    const status = readJson(join(root, 'trigger-status.json'), 4 * 1024 ** 2);
    if (!Array.isArray(status?.triggers) || status.triggers.some(trigger =>
      !trigger?.queue || ['pending', 'processing', 'dead_letter'].some(key => trigger.queue[key] !== 0))) {
      fail('ToubaStateNotQuiescent', 'Drain or reconcile trigger queues before adoption');
    }
  }
  const active = (name, sql) => {
    if (held.get(name)?.prepare(sql).get()) fail('ToubaStateNotQuiescent', `Unfinished state in ${name}`);
  };
  // A ready custody row is an outstanding approval even without its projection.
  active('approval-checkpoints.sqlite', "SELECT 1 FROM records WHERE json_extract(body,'$.state')!='consumed' LIMIT 1");
  active('project-change-proposals.sqlite', "SELECT 1 FROM records WHERE json_extract(body,'$.status')='proposed' LIMIT 1");
  const requests = held.get('human-requests.sqlite'), checkpoints = held.get('sandbox-checkpoints.sqlite');
  if (requests) for (const row of requests.prepare('SELECT body FROM records').iterate()) {
    const id = JSON.parse(row.body).request.request_id;
    if (!checkpoints?.prepare("SELECT 1 FROM records WHERE json_extract(body,'$.request_id')=? AND json_extract(body,'$.status') IN ('completed','superseded','expired','cancelled') LIMIT 1").get(id)) fail('ToubaStateNotQuiescent', 'An approval request has no terminal checkpoint');
  }
  const assets = held.get('interaction-assets.sqlite');
  if (assets) for (const row of assets.prepare('SELECT body FROM records').iterate()) {
    const asset = JSON.parse(row.body), path = join(root, 'interaction-assets', asset.storage_name);
    const stat = lstatSync(path, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== asset.size_bytes
      || `sha256:${fileDigest(path)}` !== asset.digest) fail('ToubaServeInteractionAssetCorrupt');
  }
  const traces = held.get('traces.sqlite');
  if (traces) {
    active('traces.sqlite', 'SELECT 1 FROM touba_trace_segments WHERE closed!=1 LIMIT 1');
    if (traces.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='touba_trace_exports'").get()) fail('ToubaStateAdoptionStoreUnsupported', 'Trace export compatibility requires a separate review');
  }
  const temporary = mkdtempSync(join(tmpdir(), 'touba-state-adoption-audit-'));
  try {
    const target = join(temporary, '.touba'); mkdirSync(target, { mode: 0o700 });
    for (const name of ['traces.sqlite', 'native-traces.sqlite']) if (held.has(name)) copyFileSync(join(root, name), join(target, name));
    if (traces) {
      const journal = createSqliteTraceStore({ filename: join(target, 'traces.sqlite'), readOnly: true });
      try {
        for (const row of traces.prepare('SELECT id FROM touba_trace_segments ORDER BY id').iterate()) {
          const reader = journal.snapshot(row.id); validateTraceMachineStream(reader.header, reader.events());
          journal.origin(reader.header.run.run_id);
        }
      } finally { journal.close(); }
    }
    if (held.has('native-traces.sqlite') && auditNativeTraceJournal(temporary).active_operations) fail('ToubaStateNotQuiescent', 'A native run has not completed');
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}
function optionsOf(options) {
  if (Object.keys(options).some(key => !['projectRoot', 'reason', 'accept', 'maxBackupBytes', 'recover'].includes(key))) fail('ToubaStateOptionsInvalid');
  const projectRoot = realpathSync(resolve(options.projectRoot ?? process.cwd())), root = join(projectRoot, '.touba');
  const maxBytes = options.maxBackupBytes ?? 2 * 1024 ** 3;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) fail('ToubaStateOptionsInvalid');
  return { projectRoot, root, maxBytes };
}

export function adoptProjectState(options, checkState) {
  const { projectRoot, root, maxBytes } = optionsOf(options);
  if (typeof options.reason !== 'string' || !options.reason.trim() || options.reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(options.reason)) fail('ToubaStateRecoveryReasonRequired');
  const release = acquireStateLease(projectRoot); let held = new Map();
  try {
    if (inspectStateOrigin(projectRoot).status !== 'different_build') fail('ToubaStateAdoptionOriginRequired', 'A recorded, different origin build is required');
    const from = validateStateOrigin(readJson(join(root, 'state-origin.json')), projectRoot), to = currentStateBuild();
    if ((from.transitions?.length ?? 0) >= 128) fail('ToubaStateAdoptionCapacityExceeded');
    const files = inventory(root, maxBytes); held = lockStores(root, files);
    const checked = checkState({ projectRoot, adoptState: true });
    const error = checked.diagnostics.find(row => row.code !== 'ToubaServeStateBuildMismatch');
    if (error) fail(error.code, 'Stored state is incompatible; no migration was performed');
    if (checked.origin.build_id !== from.build_id || checked.candidate_build_id !== to) fail('ToubaStateReviewStale');
    if (checked.stores.some(row => (row.active_waits ?? 0) + (row.active_operations ?? 0) > 0)) fail('ToubaStateNotQuiescent');
    extraAudits(root, held);
    if (!same(files, inventory(root, maxBytes))) fail('ToubaStateReviewStale');
    const review = { schema_version: 'touba-state-adoption-v1', project_root: projectRoot,
      from_build_id: from.build_id, to_build_id: to, reason: options.reason.trim(), files,
      bytes: files.reduce((sum, row) => sum + row.bytes, 0) };
    const reviewDigest = digest(review), preview = { ...review, status: 'preview', review_digest: reviewDigest };
    if (options.accept === undefined) return preview;
    if (options.accept !== reviewDigest) fail('ToubaStateReviewStale');
    const id = randomUUID(), parent = join(root, 'state-adoptions'), backup = join(parent, id);
    directory(parent); directory(backup); directory(join(backup, 'files'));
    copyFiles(root, join(backup, 'files'), files);
    const next = { schema_version: 'touba-serve-state-origin-v2', project_root: projectRoot, build_id: to,
      initial_build_id: from.initial_build_id ?? from.build_id, transitions: [...(from.transitions ?? []), {
        from_build_id: from.build_id, to_build_id: to, review_digest: reviewDigest, backup_id: id,
        recorded_at: new Date().toISOString(), reason: review.reason }] };
    validateStateOrigin(next, projectRoot);
    const receipt = { ...preview, status: 'adopted', backup_id: id, origin_before: from, origin_after: next };
    jsonFile(join(backup, 'receipt.json'), receipt); sync(backup); sync(parent);
    if (!same(files, inventory(root, maxBytes))) fail('ToubaStateReviewStale');
    jsonFile(join(root, PENDING), { backup_id: id }); sync(root);
    jsonFile(join(root, 'state-origin.next.json'), next);
    renameSync(join(root, 'state-origin.next.json'), join(root, 'state-origin.json')); sync(root);
    unlinkSync(join(root, PENDING)); sync(root);
    return receipt;
  } finally { releaseStores(held); release(); }
}

export function recoverStateAdoption(options) {
  const { projectRoot, root, maxBytes } = optionsOf(options);
  const release = acquireStateLease(projectRoot, { adoptionRecovery: true }); let held = new Map();
  try {
    if (existsSync(join(root, 'state-archive.pending.json'))) fail('ToubaStateArchiveInterrupted');
    const pending = readJson(join(root, PENDING));
    if (typeof pending.backup_id !== 'string' || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(pending.backup_id) || Object.keys(pending).length !== 1) fail('ToubaStateAdoptionInvalid');
    const parent = join(root, 'state-adoptions'), backup = join(parent, pending.backup_id);
    for (const path of [parent, backup, join(backup, 'files')]) if (!lstatSync(path).isDirectory() || lstatSync(path).isSymbolicLink()) fail('ToubaStatePathInvalid');
    const receipt = readJson(join(backup, 'receipt.json'), 32 * 1024 ** 2);
    if (receipt.schema_version !== 'touba-state-adoption-v1' || receipt.backup_id !== pending.backup_id || receipt.project_root !== projectRoot) fail('ToubaStateAdoptionInvalid');
    validateStateOrigin(receipt.origin_before, projectRoot); validateStateOrigin(receipt.origin_after, projectRoot);
    const { status, review_digest, backup_id, origin_before, origin_after, ...review } = receipt;
    if (digest(review) !== review_digest || status !== 'adopted' || origin_after.transitions.at(-1).review_digest !== review_digest
      || origin_after.transitions.at(-1).backup_id !== backup_id || review.from_build_id !== origin_before.build_id || review.to_build_id !== origin_after.build_id) fail('ToubaStateAdoptionInvalid');
    if (!same(inventory(join(backup, 'files'), maxBytes), review.files)) fail('ToubaStateArchiveIntegrityMismatch');
    const files = inventory(root, maxBytes, true); held = lockStores(root, files);
    const withoutOrigin = rows => rows.filter(row => row.path !== 'state-origin.json');
    if (!same(withoutOrigin(files), withoutOrigin(review.files))) fail('ToubaStateReviewStale', 'State changed after interruption; reconcile before recovery');
    const current = readJson(join(root, 'state-origin.json'));
    const result = same(current, origin_after) ? 'adopted' : same(current, origin_before) ? 'not_adopted' : null;
    if (!result) fail('ToubaStateReviewStale');
    if (existsSync(join(root, 'state-origin.next.json'))) {
      if (!same(readJson(join(root, 'state-origin.next.json')), origin_after)) fail('ToubaStateReviewStale');
      unlinkSync(join(root, 'state-origin.next.json'));
    }
    unlinkSync(join(root, PENDING)); sync(root);
    return { schema_version: 'touba-state-adoption-recovery-v1', status: result, backup_id, restored_stores: 0 };
  } finally { releaseStores(held); release(); }
}
