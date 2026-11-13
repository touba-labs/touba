import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { migrateJsonState } from "../../../runtime/touba-runtime/src/sqlite-state-migration.mjs";

const FORMAT = "touba-trigger-queue-storage-v1";
const statuses = new Set(["queued", "processing", "awaiting_human", "continuing", "interrupted", "succeeded", "failed", "dead_lettered"]);
const error = (code, message) => Object.assign(new Error(message), { code });
const alive = pid => {
  if (!Number.isSafeInteger(pid) || pid < 1) return false;
  try { process.kill(pid, 0); return true; }
  catch (cause) { return cause.code !== "ESRCH"; }
};

// Queue ownership is per attempt. Every write uses a fresh revision and a
// worker PID; a timeout alone cannot reclaim a still-running local worker.
export function createSqliteTriggerQueue({ filename, maxEntries = 10000, maxBytes = 512 * 1024 * 1024, readOnly = false } = {}) {
  if (typeof filename !== "string" || !filename.endsWith(".sqlite")) throw error("TriggerQueuePathInvalid", "queue path must end with .sqlite");
  for (const [name, value, min] of [["maxEntries", maxEntries, 1], ["maxBytes", maxBytes, 65536]]) {
    if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`${name} must be an integer >= ${min}`);
  }
  const requested = resolve(filename);
  if (!readOnly) mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  const parent = realpathSync(dirname(requested)), path = join(parent, basename(requested));
  if (process.platform !== "win32" && (lstatSync(parent).mode & 0o022)) throw error("TriggerQueuePathInvalid", "queue directory must not be writable by other users");
  if (!readOnly) {
    try { closeSync(openSync(path, "wx", 0o600)); } catch (cause) { if (cause.code !== "EEXIST") throw cause; }
  }
  for (const suffix of ["", "-journal", "-wal", "-shm"]) {
    let stat;
    try { stat = lstatSync(path + suffix); } catch (cause) { if (suffix && cause.code === "ENOENT") continue; throw cause; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== "win32" && (stat.mode & 0o077)) {
      throw error("TriggerQueuePathInvalid", "queue storage must be a private regular file without links");
    }
  }
  const db = new DatabaseSync(path, { readOnly });
  const versions = new WeakMap();
  let closed = false;
  function transaction(fn) {
    if (readOnly) throw error("TriggerQueueReadOnly", "queue is read-only");
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (cause) { if (db.isTransaction) db.exec("ROLLBACK"); throw cause; }
  }
  function schema() {
    const count = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get().n;
    if (!count) return false;
    if (count !== 2 || db.prepare("SELECT format FROM queue_meta WHERE singleton=1").get()?.format !== FORMAT) throw error("TriggerQueueSchemaMismatch", "not a Touba trigger queue");
    return true;
  }
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048;");
    const exists = schema();
    if (readOnly && !exists) throw error("TriggerQueueSchemaMismatch", "queue database is empty");
    if (!readOnly) {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON;");
      const pages = Math.floor(maxBytes / db.prepare("PRAGMA page_size").get().page_size);
      if (db.prepare("PRAGMA page_count").get().page_count > pages) throw error("TriggerQueueCapacityExceeded", "queue exceeds its configured storage limit");
      db.exec(`PRAGMA max_page_count=${pages};`);
      transaction(() => {
        if (schema()) return;
        db.exec(`CREATE TABLE queue_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1),format TEXT NOT NULL);
          CREATE TABLE queue_entries(id TEXT PRIMARY KEY, trigger_ref TEXT NOT NULL, event_id TEXT NOT NULL,
            status TEXT NOT NULL, due_ms INTEGER NOT NULL, received_ms INTEGER NOT NULL,
            worker_pid INTEGER, revision INTEGER NOT NULL, body TEXT NOT NULL,
            UNIQUE(trigger_ref,event_id));
          CREATE INDEX queue_due ON queue_entries(status,due_ms,received_ms,id);
          CREATE INDEX queue_trigger_status ON queue_entries(trigger_ref,status);`);
        db.prepare("INSERT INTO queue_meta VALUES(1,?)").run(FORMAT);
      });
    }
  } catch (cause) { db.close(); throw cause; }
  function decode(row) {
    if (!row) return undefined;
    const entry = JSON.parse(row.body); validate(entry);
    if (entry.queue_id !== row.id || entry.status !== row.status || entry.trigger_ref !== row.trigger_ref || entry.event_id !== row.event_id) throw error("TriggerQueueEntryInvalid", "queue indexes disagree with stored entry");
    versions.set(entry, row.revision); return entry;
  }
  function update(entry, workerPid) {
    const body = validate(entry), revision = versions.get(entry);
    if (revision === undefined) throw error("TriggerQueueWriteConflict", "queue update requires a fresh snapshot");
    const due = ["processing", "continuing"].includes(entry.status) ? Date.parse(entry.started_at) : Date.parse(entry.next_attempt_at ?? entry.received_at);
    if (!Number.isFinite(due)) throw error("TriggerQueueEntryInvalid", "invalid processing date");
    const result = db.prepare("UPDATE queue_entries SET status=?,due_ms=?,worker_pid=?,body=?,revision=revision+1 WHERE id=? AND revision=?")
      .run(entry.status, due, workerPid ?? null, body, entry.queue_id, revision);
    if (result.changes !== 1) throw error("TriggerQueueWriteConflict", "queue entry changed; stale worker cannot acknowledge it");
    versions.set(entry, revision + 1);
  }
  function insert(entry) {
    const body = validate(entry);
    if (db.prepare("SELECT count(*) AS n FROM queue_entries").get().n >= maxEntries) throw error("TriggerQueueCapacityExceeded", "queue capacity reached; archive completed entries before accepting new work");
    const due = Date.parse(entry.status === "processing" ? entry.started_at : entry.next_attempt_at ?? entry.received_at);
    if (!Number.isFinite(due)) throw error("TriggerQueueEntryInvalid", "invalid entry date");
    db.prepare("INSERT INTO queue_entries VALUES(?,?,?,?,?,?,NULL,1,?)")
      .run(entry.queue_id, entry.trigger_ref, entry.event_id, entry.status, due, Date.parse(entry.received_at), body);
  }
  function page({ after = "", limit = 100, states = [] } = {}) {
    if (typeof after !== "string" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw error("TriggerQueueQueryInvalid", "invalid page cursor or limit");
    if (!Array.isArray(states) || states.length > statuses.size || states.some(value => !statuses.has(value))) throw error('TriggerQueueQueryInvalid', 'invalid status filter');
    const entries = [];
    let bytes = 0;
    const filter = states.length ? ` AND status IN (${states.map(() => '?').join(',')})` : '';
    for (const row of db.prepare(`SELECT * FROM queue_entries WHERE id>?${filter} ORDER BY id LIMIT ?`).iterate(after, ...states, limit)) {
      const size = Buffer.byteLength(row.body);
      if (size > 1024 * 1024) throw error("TriggerQueueEntryInvalid", "stored queue entry exceeds its byte limit");
      if (bytes + size > 16 * 1024 * 1024) break;
      bytes += size; entries.push(decode(row));
    }
    return { entries, next: entries.at(-1)?.queue_id ?? null };
  }
  return {
    path,
    find(triggerRef, eventId) { return decode(db.prepare("SELECT * FROM queue_entries WHERE trigger_ref=? AND event_id=?").get(triggerRef, eventId)); },
    get(id) { return decode(db.prepare("SELECT * FROM queue_entries WHERE id=?").get(id)); },
    enqueue(entry, { beforeInsert } = {}) {
      transaction(() => {
        if (beforeInsert) beforeInsert(db.prepare("SELECT trigger_ref,event_id FROM queue_entries WHERE status IN ('queued','processing','continuing','awaiting_human')").all());
        insert(entry);
      });
    },
    claim(processingTimeoutMs, now = Date.now(), { guardUnknown = false } = {}) {
      return transaction(() => {
        for (const row of db.prepare("SELECT * FROM queue_entries WHERE status IN ('processing','continuing') AND due_ms<=? ORDER BY due_ms,id").iterate(now - processingTimeoutMs)) {
          if (alive(row.worker_pid)) continue;
          const entry = decode(row);
          // A continuation or an explicitly guarded worker can have performed
          // effects before a crash. Never start its strategy again automatically.
          entry.status = guardUnknown || row.status === "continuing" || entry.guarded_execution ? "interrupted" : "queued";
          entry.recovered_at = new Date(now).toISOString();
          entry.recovery_reason = "processing_timeout"; entry.recovery_effect_outcome = "unknown";
          update(entry);
        }
        const entry = decode(db.prepare("SELECT * FROM queue_entries WHERE status='queued' AND due_ms<=? ORDER BY due_ms,received_ms,id LIMIT 1").get(now));
        if (!entry) return undefined;
        entry.status = "processing"; entry.started_at = new Date(now).toISOString();
        if (guardUnknown) entry.guarded_execution = true;
        entry.attempt_count = (entry.attempt_count ?? 0) + 1; delete entry.next_attempt_at;
        update(entry, process.pid); return entry;
      });
    },
    finish(entry) { transaction(() => update(entry)); },
    progress(entry) {
      if (!['processing','continuing'].includes(entry.status)) throw error('TriggerQueueWriteConflict', 'only an active worker may persist progress');
      transaction(() => {
        if (db.prepare('SELECT worker_pid FROM queue_entries WHERE id=?').get(entry.queue_id)?.worker_pid !== process.pid) throw error('TriggerQueueWriteConflict', 'worker ownership changed');
        update(entry, process.pid);
      });
    },
    continue(id, requestId) {
      return transaction(() => {
        const entry = decode(db.prepare("SELECT * FROM queue_entries WHERE id=?").get(id));
        const checkpoint = entry?.checkpoint;
        if (entry?.status !== "awaiting_human" || !checkpoint
          || checkpoint.approval_state?.requests?.[checkpoint.approval_ref]?.request_id !== requestId) {
          throw error("TriggerApprovalConflict", "the pending approval changed or is already being continued");
        }
        entry.status = "continuing"; entry.started_at = new Date().toISOString();
        entry.continuation_count = (entry.continuation_count ?? 0) + 1;
        update(entry, process.pid); return entry;
      });
    },
    nextWake(processingTimeoutMs, now = Date.now()) {
      const row = db.prepare("SELECT min(CASE WHEN status IN ('processing','continuing') THEN due_ms+? ELSE due_ms END) AS due FROM queue_entries WHERE status IN ('queued','processing','continuing')").get(processingTimeoutMs);
      // Avoid a tight timer loop while another live worker owns an overdue run.
      return row.due === null ? undefined : Math.max(25, row.due - now);
    },
    counts(triggerRef) {
      const result = { pending: 0, processing: 0, dead_letter: 0, awaiting_human: 0, interrupted: 0 };
      for (const row of db.prepare("SELECT status,count(*) AS n FROM queue_entries WHERE trigger_ref=? GROUP BY status").all(triggerRef)) {
        const key = { queued: "pending", processing: "processing", continuing: "processing", dead_lettered: "dead_letter", awaiting_human: "awaiting_human", interrupted: "interrupted" }[row.status];
        if (key) result[key] += row.n;
      }
      return result;
    },
    page,
    retries(triggerRef) {
      return db.prepare("SELECT count(*) AS n FROM queue_entries WHERE trigger_ref=? AND status='queued' AND json_extract(body,'$.attempt_count')>0").get(triggerRef).n;
    },
    metadata() {
      // Deliberately exclude private payloads, checkpoints and tool arguments.
      return db.prepare(`SELECT id AS queue_id,trigger_ref,status,
        json_extract(body,'$.execution_owner') AS execution_owner,
        json_extract(body,'$.review.action') AS review_action
        FROM queue_entries ORDER BY id`).all();
    },
    importEntries(entries) {
      transaction(() => {
        if (db.prepare("SELECT count(*) AS n FROM queue_entries").get().n) throw error("TriggerQueueMigrationConflict", "migration requires an empty queue");
        for (const entry of entries) insert(entry);
      });
    },
    archive({ before, destination, apply = false } = {}) {
      if (typeof before !== "string" || !Number.isFinite(Date.parse(before))) throw error("TriggerQueueArchiveInvalid", "before must be an ISO timestamp");
      before = new Date(before).toISOString();
      const eligible = "status='succeeded' AND json_extract(body, '$.completed_at') < ?";
      const summary = db.prepare(`SELECT count(*) AS entry_count FROM queue_entries WHERE ${eligible}`).get(before);
      if (!apply) return { before, ...summary, applied: false };
      if (typeof destination !== "string" || !destination.endsWith(".sqlite") || resolve(destination) === path) throw error("TriggerQueueArchiveInvalid", "archive requires a new .sqlite destination");
      destination = resolve(destination);
      return transaction(() => {
        mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
        closeSync(openSync(destination, "wx", 0o600));
        const archived = createSqliteTriggerQueue({ filename: destination, maxBytes, maxEntries });
        let copied = 0;
        const hash = createHash("sha256");
        try {
          archived.importEntries((function* () {
            for (const row of db.prepare(`SELECT * FROM queue_entries WHERE ${eligible} ORDER BY id`).iterate(before)) {
              const entry = decode(row); hash.update(JSON.stringify(entry) + "\n"); copied++; yield entry;
            }
          })());
          const expected = hash.digest("hex"), actual = createHash("sha256");
          let after = "", verified = 0;
          for (;;) {
            const result = archived.page({ after });
            if (!result.entries.length) break;
            for (const entry of result.entries) { actual.update(JSON.stringify(entry) + "\n"); verified++; }
            after = result.next;
          }
          if (copied !== verified || actual.digest("hex") !== expected) throw error("TriggerQueueArchiveInvalid", "archive verification failed; live queue retained");
          archived.close();
          const output = openSync(destination, "r");
          try { fsyncSync(output); } finally { closeSync(output); }
          if (process.platform !== "win32") {
            const directory = openSync(dirname(destination), "r");
            try { fsyncSync(directory); } finally { closeSync(directory); }
          }
          db.prepare(`DELETE FROM queue_entries WHERE ${eligible}`).run(before);
          return { before, destination, entry_count: copied, sha256: expected, applied: true };
        } finally { archived.close(); }
      });
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
}

function validate(entry) {
  if (!entry || typeof entry.queue_id !== "string" || !entry.queue_id || !entry.trigger_ref?.startsWith("trigger:")
      || typeof entry.event_id !== "string" || !entry.event_id || !statuses.has(entry.status)
      || !Number.isFinite(Date.parse(entry.received_at))) throw error("TriggerQueueEntryInvalid", "invalid queue identity, status or reception date");
  if (entry.next_attempt_at !== undefined && !Number.isFinite(Date.parse(entry.next_attempt_at))) throw error("TriggerQueueEntryInvalid", "invalid retry date");
  const body = JSON.stringify(entry);
  if (Buffer.byteLength(body) > 1024 * 1024) throw error("TriggerQueueEntryInvalid", "queue entry exceeds 1 MiB");
  return body;
}

export function migrateTriggerQueue(options) {
  return migrateJsonState({ ...options,
    validate(document) {
      if (document.trigger_queue_schema_version !== "touba-trigger-queue-v1" || !Array.isArray(document.entries)) throw error("TriggerQueueSchemaMismatch", "expected a Touba trigger queue JSON document");
      const ids = new Set(), events = new Set();
      for (const entry of document.entries) {
        validate(entry);
        if (entry.status === "processing" && !Number.isFinite(Date.parse(entry.started_at))) throw error("TriggerQueueEntryInvalid", "processing entry requires its start date");
        const identity = JSON.stringify([entry.trigger_ref, entry.event_id]);
        if (ids.has(entry.queue_id) || events.has(identity)) throw error("TriggerQueueEntryInvalid", "duplicate queue or event identity");
        ids.add(entry.queue_id); events.add(identity);
      }
      return document.entries;
    },
    build(filename, entries) {
      const queue = createSqliteTriggerQueue({ filename });
      try { queue.importEntries(entries); } finally { queue.close(); }
    },
  });
}
