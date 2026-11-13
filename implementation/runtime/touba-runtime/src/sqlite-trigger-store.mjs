import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { migrateJsonState } from "./sqlite-state-migration.mjs";

const FORMAT = "touba-trigger-storage-v1";
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
function integer(value, name, min = 1) {
  if (!Number.isSafeInteger(value) || value < min) throw new TypeError(`${name} must be an integer >= ${min}`);
  return value;
}
function text(value, name) {
  if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 2048) throw new TypeError(`${name} must be nonempty text of at most 2048 bytes`);
  return value;
}
function identity(triggerRef, eventId) {
  if (!text(triggerRef, "triggerRef").startsWith("trigger:")) throw new TypeError("triggerRef must identify a trigger");
  text(eventId, "eventId");
}

/** Admission is durable before dispatch. Claims survive failed/interrupted runs;
 * only an explicitly owned, newer service attempt can reuse its own claim.
 * This ledger does not grant authority or replace effect-journal recovery.
 */
export function createSqliteTriggerStore({ filename, maxBytes = 512 * 1024 * 1024, readOnly = false, clock = () => new Date() } = {}) {
  text(filename, "filename"); integer(maxBytes, "maxBytes", 65536);
  const requested = resolve(filename);
  if (!requested.endsWith(".sqlite")) fail("TriggerStatePathInvalid", "trigger state must use .sqlite; migrate old JSON explicitly with touba trigger migrate-state");
  if (!readOnly) mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  const parent = realpathSync(dirname(requested));
  if (process.platform !== "win32" && (lstatSync(parent).mode & 0o022)) fail("TriggerStatePathInvalid", "trigger state directory must not be writable by other users");
  const path = join(parent, basename(requested));
  if (!readOnly) {
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    let stat;
    try { stat = lstatSync(path + suffix); }
    catch (error) { if (suffix && error.code === "ENOENT") continue; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || process.platform !== "win32" && (stat.mode & 0o077)) {
      fail("TriggerStatePathInvalid", "trigger state must be a private regular file without links");
    }
  }
  const db = new DatabaseSync(path, { readOnly });
  let closed = false;
  function transaction(fn) {
    if (closed) fail("TriggerStateClosed", "trigger state is closed");
    if (readOnly) fail("TriggerStateReadOnly", "trigger state is read-only");
    db.exec("BEGIN IMMEDIATE");
    try { const result = fn(); db.exec("COMMIT"); return result; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  function schema() {
    const row = db.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").get();
    if (!row.n) return false;
    if (row.n !== 5 || db.prepare("SELECT format FROM trigger_meta WHERE singleton=1").get()?.format !== FORMAT) {
      fail("TriggerStateSchemaMismatch", "not a Touba trigger state database");
    }
    return true;
  }
  try {
    db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF; PRAGMA cache_size=-2048;");
    const exists = schema();
    if (readOnly && !exists) fail("TriggerStateSchemaMismatch", "trigger state is empty");
    if (!readOnly) {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON;");
      const pageSize = db.prepare("PRAGMA page_size").get().page_size;
      const pages = Math.floor(maxBytes / pageSize);
      if (db.prepare("PRAGMA page_count").get().page_count > pages) fail("TriggerStateLimitExceeded", "trigger database exceeds its configured storage quota");
      db.exec(`PRAGMA max_page_count=${pages};`);
      transaction(() => {
        if (schema()) return;
        db.exec(`CREATE TABLE trigger_meta(singleton INTEGER PRIMARY KEY CHECK(singleton=1), format TEXT NOT NULL);
          CREATE TABLE trigger_claims(trigger_ref TEXT NOT NULL, event_id TEXT NOT NULL, owner_id TEXT NOT NULL,
            attempt INTEGER NOT NULL, day_key TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL,
            PRIMARY KEY(trigger_ref,event_id));
          CREATE TABLE trigger_days(trigger_ref TEXT NOT NULL, day_key TEXT NOT NULL, accepted INTEGER NOT NULL,
            PRIMARY KEY(trigger_ref,day_key));
          CREATE TABLE trigger_summary(trigger_ref TEXT PRIMARY KEY, accepted_count INTEGER NOT NULL DEFAULT 0,
            refused_count INTEGER NOT NULL DEFAULT 0, last_event_id TEXT, last_status TEXT, updated_at TEXT);
          CREATE TABLE trigger_events(id INTEGER PRIMARY KEY AUTOINCREMENT, trigger_ref TEXT NOT NULL,
            event_id TEXT NOT NULL, source_kind TEXT NOT NULL, status TEXT NOT NULL, reason TEXT,
            observed_at TEXT NOT NULL, day_key TEXT NOT NULL, run_id TEXT NOT NULL);
          CREATE INDEX trigger_events_page ON trigger_events(trigger_ref,id);`);
        db.prepare("INSERT INTO trigger_meta VALUES(1,?)").run(FORMAT);
      });
    }
  } catch (error) { db.close(); throw error; }

  function append({ triggerRef, eventId, sourceKind, runId, status, reason = null, observedAt = clock().toISOString() }) {
    identity(triggerRef, eventId); text(sourceKind, "sourceKind"); text(runId, "runId");
    db.prepare("INSERT INTO trigger_events(trigger_ref,event_id,source_kind,status,reason,observed_at,day_key,run_id) VALUES(?,?,?,?,?,?,?,?)")
      .run(triggerRef, eventId, sourceKind, status, reason, observedAt, observedAt.slice(0, 10), runId);
    db.prepare(`INSERT INTO trigger_summary VALUES(?,?,?,?,?,?) ON CONFLICT(trigger_ref) DO UPDATE SET
      accepted_count=accepted_count+excluded.accepted_count, refused_count=refused_count+excluded.refused_count,
      last_event_id=excluded.last_event_id, last_status=excluded.last_status, updated_at=excluded.updated_at`)
      .run(triggerRef, Number(status === "accepted"), Number(status === "refused"), eventId, status, observedAt);
  }
  function count(triggerRef, day = clock().toISOString().slice(0, 10)) {
    return db.prepare("SELECT accepted FROM trigger_days WHERE trigger_ref=? AND day_key=?").get(triggerRef, day)?.accepted ?? 0;
  }
  function admit(request) {
    const { triggerRef, eventId, sourceKind, runId, maxRunsPerDay, ownerId = runId, attempt = 1 } = request;
    identity(triggerRef, eventId); text(ownerId, "ownerId"); text(runId, "runId"); text(sourceKind, "sourceKind");
    integer(attempt, "attempt"); integer(maxRunsPerDay, "maxRunsPerDay", 0);
    return transaction(() => {
      const known = db.prepare("SELECT * FROM trigger_claims WHERE trigger_ref=? AND event_id=?").get(triggerRef, eventId);
      if (known) {
        if (request.retry === true && known.owner_id === ownerId && attempt === known.attempt + 1
            && !["success", "pending"].includes(known.status)) {
          db.prepare("UPDATE trigger_claims SET attempt=?,run_id=?,status='active' WHERE trigger_ref=? AND event_id=?")
            .run(attempt, runId, triggerRef, eventId);
          return { accepted: true, retry: true };
        }
        return { accepted: false, reason: "event_replay" };
      }
      const observedAt = clock().toISOString(), day = observedAt.slice(0, 10);
      const observedCount = count(triggerRef, day);
      if (observedCount >= maxRunsPerDay) return { accepted: false, reason: "max_runs_per_day_reached", observedCount };
      db.prepare("INSERT INTO trigger_claims VALUES(?,?,?,?,?,?, 'active')").run(triggerRef, eventId, ownerId, attempt, day, runId);
      db.prepare("INSERT INTO trigger_days VALUES(?,?,1) ON CONFLICT(trigger_ref,day_key) DO UPDATE SET accepted=accepted+1").run(triggerRef, day);
      append({ triggerRef, eventId, sourceKind, runId, status: "accepted", observedAt });
      return { accepted: true };
    });
  }
  function recordResult(event, result) {
    const triggerRef = event.trigger_ref ?? event.triggerRef, eventId = event.event_id ?? event.eventId;
    if (!triggerRef || !eventId) return;
    const trace = result.traceReader?.header ?? result.trace;
    let accepted = false, refusal;
    for (const item of result.traceReader?.events() ?? trace?.events ?? []) {
      if (item.payload?.trigger_ref !== triggerRef) continue;
      if (item.kind === "trigger_event_accepted") accepted = true;
      if (item.kind === "trigger_event_refused") refusal = item.payload;
    }
    transaction(() => {
      if (accepted) {
        db.prepare("UPDATE trigger_claims SET status=? WHERE trigger_ref=? AND event_id=? AND run_id=?")
          .run(result.status, triggerRef, eventId, trace.run.run_id);
      } else append({ triggerRef, eventId, sourceKind: event.source_kind ?? event.sourceKind ?? "unknown",
        runId: trace?.run?.run_id ?? "admission-refused", status: "refused", reason: refusal?.reason ?? "execution_failed" });
    });
  }
  function archive({ before, destination, apply = false } = {}) {
    if (typeof before !== "string" || !Number.isFinite(Date.parse(before))) throw new TypeError("before must be an ISO timestamp");
    before = new Date(before).toISOString();
    const eligible = `observed_at < ? AND (status='refused' OR EXISTS (
      SELECT 1 FROM trigger_claims c WHERE c.trigger_ref=trigger_events.trigger_ref
      AND c.event_id=trigger_events.event_id AND c.status='success'))`;
    const summary = db.prepare(`SELECT count(*) AS event_count FROM trigger_events WHERE ${eligible}`).get(before);
    if (!apply) return { before, ...summary, applied: false };
    text(destination, "destination"); destination = resolve(destination);
    if (destination === path || !destination.endsWith(".sqlite")) fail("TriggerStateArchiveInvalid", "archive requires a new .sqlite destination");
    // Claims, counters and active/uncertain events remain in the live ledger.
    // Copy and verify the selected rows while holding the admission write lock.
    return transaction(() => {
      mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
      closeSync(openSync(destination, "wx", 0o600));
      const archived = createSqliteTriggerStore({ filename: destination, maxBytes });
      const digest = createHash("sha256");
      let copied = 0;
      const canonical = row => ({ triggerRef: row.trigger_ref, eventId: row.event_id,
        sourceKind: row.source_kind, runId: row.run_id, status: row.status, reason: row.reason,
        observedAt: row.observed_at });
      try {
        archived.importEvents((function* () {
          for (const row of db.prepare(`SELECT * FROM trigger_events WHERE ${eligible} ORDER BY id`).iterate(before)) {
            const event = canonical(row);
            digest.update(JSON.stringify(event) + "\n"); copied++;
            yield event;
          }
        })());
        const expected = digest.digest("hex"), actual = createHash("sha256");
        let after = 0, verified = 0;
        for (;;) {
          const page = archived.page({ after });
          if (!page.items.length) break;
          for (const row of page.items) { actual.update(JSON.stringify(canonical(row)) + "\n"); verified++; }
          after = page.next;
        }
        if (verified !== copied || actual.digest("hex") !== expected) fail("TriggerStateArchiveInvalid", "archive verification failed; live events retained");
        archived.close();
        const fd = openSync(destination, "r");
        try { fsyncSync(fd); } finally { closeSync(fd); }
        if (process.platform !== "win32") {
          const dir = openSync(dirname(destination), "r");
          try { fsyncSync(dir); } finally { closeSync(dir); }
        }
        db.prepare(`DELETE FROM trigger_events WHERE ${eligible}`).run(before);
        return { before, destination, event_count: copied, sha256: expected, applied: true };
      } finally { archived.close(); }
    });
  }
  return {
    path, admit, recordResult, count, archive,
    // Offline audit; an exact human wait can be abandoned without a new admission.
    audit({ pendingWaits = [] } = {}) {
      let entry_count = 0, active_operations = 0;
      for (const row of db.prepare('SELECT trigger_ref,event_id,run_id,status FROM trigger_claims').iterate()) {
        identity(row.trigger_ref, row.event_id); text(row.run_id, 'runId');
        entry_count++;
        if (['success', 'failure', 'stopped', 'cancelled'].includes(row.status)) continue;
        if (row.status === 'pending' && pendingWaits.some(wait => wait.target_ref === row.trigger_ref && wait.run_id === row.run_id)) continue;
        active_operations++;
      }
      return { entry_count, active_operations };
    },
    consumed: (triggerRef, eventId) => Boolean(db.prepare("SELECT 1 FROM trigger_claims WHERE trigger_ref=? AND event_id=?").get(triggerRef, eventId)),
    summary: triggerRef => ({ ...db.prepare("SELECT * FROM trigger_summary WHERE trigger_ref=?").get(triggerRef) }),
    page({ triggerRef, after = 0, limit = 100 } = {}) {
      integer(after, "after", 0); integer(limit, "limit");
      if (limit > 1000) throw new TypeError("limit must be <= 1000");
      const rows = triggerRef === undefined
        ? db.prepare("SELECT * FROM trigger_events WHERE id>? ORDER BY id LIMIT ?").all(after, limit)
        : db.prepare("SELECT * FROM trigger_events WHERE trigger_ref=? AND id>? ORDER BY id LIMIT ?").all(triggerRef, after, limit);
      return { items: rows.map(row => ({ ...row })), next: rows.at(-1)?.id ?? null };
    },
    close() { if (!closed) { db.close(); closed = true; } },
    // Used only by the explicit, bounded migration, never on ordinary open.
    importEvents(events) {
      transaction(() => {
        if (db.prepare("SELECT count(*) AS n FROM trigger_events").get().n) fail("TriggerStateMigrationConflict", "migration target is not empty");
        for (const event of events) {
          if (event.status === "accepted") {
            db.prepare("INSERT INTO trigger_claims VALUES(?,?,?,?,?,?,?)").run(event.triggerRef, event.eventId,
              `migrated:${event.runId}`, 1, event.observedAt.slice(0, 10), event.runId, "unknown");
            db.prepare("INSERT INTO trigger_days VALUES(?,?,1) ON CONFLICT(trigger_ref,day_key) DO UPDATE SET accepted=accepted+1")
              .run(event.triggerRef, event.observedAt.slice(0, 10));
          }
          append(event);
        }
      });
    },
  };
}

export function migrateTriggerState(options) {
  const result = migrateJsonState({ ...options, validate: validateLegacyTriggerState,
    build(filename, events) {
      const store = createSqliteTriggerStore({ filename });
      try { store.importEvents(events); } finally { store.close(); }
    },
  });
  return { ...result, event_count: result.record_count };
}

function validateLegacyTriggerState(document) {
  if (document.trigger_state_schema_version !== "touba-trigger-state-v1" || !document.triggers
      || typeof document.triggers !== "object" || Array.isArray(document.triggers)) {
    fail("TriggerStateSchemaMismatch", "expected a Touba trigger-state JSON document");
  }
  const events = [];
  for (const [triggerRef, state] of Object.entries(document.triggers)) {
    if (!Array.isArray(state.events)) fail("TriggerStateSchemaMismatch", "trigger events must be an array");
    const consumed = new Set();
    for (const event of state.events) {
      identity(triggerRef, event.event_id);
      if (!["accepted", "refused"].includes(event.status) || !/^\d{4}-\d{2}-\d{2}T/.test(event.observed_at)
          || !Number.isFinite(Date.parse(event.observed_at)) || event.day_key && event.day_key !== event.observed_at.slice(0, 10)) {
        fail("TriggerStateSchemaMismatch", "invalid historical trigger event");
      }
      text(event.source_kind, "source_kind"); text(event.run_id, "run_id");
      if (event.status === "accepted") {
        if (consumed.has(event.event_id)) fail("TriggerStateSchemaMismatch", "duplicate accepted event in migration source");
        consumed.add(event.event_id);
      }
      events.push({ triggerRef, eventId: event.event_id, sourceKind: event.source_kind, runId: event.run_id,
        status: event.status, reason: event.reason ?? null, observedAt: event.observed_at });
    }
    if (state.consumed_event_ids?.some(id => !consumed.has(id))) fail("TriggerStateSchemaMismatch", "consumed identifiers missing from historical events");
  }
  return events;
}
