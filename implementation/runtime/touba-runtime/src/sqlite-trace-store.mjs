import { createHash, randomUUID } from "node:crypto";
import { closeSync, fsyncSync, lstatSync, mkdirSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createTraceReference, traceJsonDigest, validateTraceReference } from "../../../contracts/trace-reference.mjs";
import { traceExportState } from "./sqlite-trace-export-state.mjs";

const FORMAT = "touba-trace-storage-v1";
const hash = text => createHash("sha256").update(text).digest("hex");
function fail(code, message) { throw Object.assign(new Error(message), { code }); }
function positive(value, name) {
  if (!Number.isSafeInteger(value) || value < 1) throw new TypeError(`${name} must be a positive safe integer`);
  return value;
}

/** Local append-only trace segments. A commit acknowledges durable storage.
 * The caller owns the connection lifecycle, retention and storage directory.
 * Full document materialization is explicit and independently bounded.
 */
export function createSqliteTraceStore({ filename, maxBytes = 512 * 1024 * 1024,
  maxEventBytes = 1024 * 1024, maxDocumentBytes = 16 * 1024 * 1024, readOnly = false } = {}) {
  if (typeof filename !== "string" || !filename.trim()) throw new TypeError("filename is required");
  if (typeof readOnly !== "boolean") throw new TypeError("readOnly must be a boolean");
  positive(maxBytes, "maxBytes"); positive(maxEventBytes, "maxEventBytes"); positive(maxDocumentBytes, "maxDocumentBytes");
  const requested = resolve(filename);
  if (!readOnly) mkdirSync(dirname(requested), { recursive: true, mode: 0o700 });
  const parent = realpathSync(dirname(requested));
  if (process.platform !== "win32" && (lstatSync(parent).mode & 0o022) !== 0) {
    fail("TraceStoragePathInvalid", "trace database directory must not be writable by other users");
  }
  const path = join(parent, basename(requested));
  if (!readOnly) {
    try { closeSync(openSync(path, "wx", 0o600)); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
  }
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) fail("TraceStoragePathInvalid", "trace database must be a regular unlinked file");
  if (process.platform !== "win32" && (stat.mode & 0o077) !== 0) fail("TraceStoragePathInvalid", "trace database must be private (0600)");
  const db = new DatabaseSync(path, { readOnly });
  let closed = false;
  function transaction(fn) {
    if (closed) fail("TraceStorageClosed", "trace database is closed");
    if (readOnly) fail("TraceStorageReadOnly", "trace journal was opened for reading only");
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (error) { if (db.isTransaction) db.exec("ROLLBACK"); throw error; }
  }
  function existingSchema() {
    const schema = db.prepare("SELECT coalesce(sum(CASE WHEN type='table' AND name IN ('touba_trace_storage','touba_trace_segments','touba_trace_events') THEN 1 ELSE 0 END),0) AS n, count(*) AS objects FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'").get();
    const count = schema.n;
    if (count !== 0 && count !== 3) fail("TraceStorageCorrupt", "trace schema is incomplete");
    if (count === 0 && schema.objects !== 0) {
      fail("TraceStorageFormatInvalid", "trace storage requires an empty database or an existing Touba trace journal");
    }
    return count;
  }
  try {
    // The first schema inspection can race another process creating this same
    // default project journal. Install the connection-local wait before reads.
    db.exec("PRAGMA busy_timeout=5000; PRAGMA trusted_schema=OFF;");
    // Do not change another application's journal mode or schema when the host
    // accidentally points --trace-store at its business database.
    const existing = existingSchema();
    if (existing === 3) {
      const meta = db.prepare("SELECT * FROM touba_trace_storage WHERE singleton=1").get();
      if (!meta) fail("TraceStorageCorrupt", "trace storage accounting is missing");
      if (meta.format !== FORMAT) fail("TraceStorageFormatInvalid", "unsupported trace storage format");
    } else if (readOnly) fail("TraceStorageFormatInvalid", "trace journal does not exist in this database");
    db.exec("PRAGMA cache_size=-2048;");
    if (!readOnly) {
      db.exec("PRAGMA journal_mode=DELETE; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON;");
      transaction(() => {
      const existing = existingSchema();
      db.exec(`CREATE TABLE IF NOT EXISTS touba_trace_storage (
        singleton INTEGER PRIMARY KEY CHECK(singleton=1), format TEXT NOT NULL, bytes INTEGER NOT NULL CHECK(bytes>=0));`);
      const meta = db.prepare("SELECT * FROM touba_trace_storage WHERE singleton=1").get();
      if (existing && !meta) fail("TraceStorageCorrupt", "trace storage accounting is missing");
      if (meta && meta.format !== FORMAT) fail("TraceStorageFormatInvalid", "unsupported trace storage format");
      db.prepare("INSERT OR IGNORE INTO touba_trace_storage VALUES (1, ?, 0)").run(FORMAT);
      db.exec(`CREATE TABLE IF NOT EXISTS touba_trace_segments (
        id TEXT PRIMARY KEY, run_id TEXT NOT NULL, header TEXT NOT NULL, header_hash TEXT NOT NULL,
        start_index INTEGER NOT NULL, event_count INTEGER NOT NULL DEFAULT 0,
        bytes INTEGER NOT NULL, closed INTEGER NOT NULL DEFAULT 0 CHECK(closed IN (0,1)));
        CREATE INDEX IF NOT EXISTS touba_trace_runs ON touba_trace_segments(run_id, id);
        CREATE TABLE IF NOT EXISTS touba_trace_events (
        segment_id TEXT NOT NULL, sequence_index INTEGER NOT NULL, event_id TEXT NOT NULL,
        kind TEXT NOT NULL, body TEXT NOT NULL, digest TEXT NOT NULL,
        PRIMARY KEY(segment_id, sequence_index), UNIQUE(segment_id, event_id));`);
      });
    }
  } catch (error) { db.close(); throw error; }
  function segment(id) {
    if (closed) fail("TraceStorageClosed", "trace database is closed");
    const row = db.prepare("SELECT * FROM touba_trace_segments WHERE id=?").get(id);
    if (!row) fail("TraceSegmentMissing", "trace segment does not exist");
    if (hash(row.header) !== row.header_hash) fail("TraceStorageCorrupt", "trace header digest mismatch");
    return row;
  }
  function reserve(bytes) {
    const used = db.prepare("SELECT bytes FROM touba_trace_storage WHERE singleton=1").get().bytes;
    if (bytes > maxBytes - used) fail("TraceStorageLimitExceeded", "trace storage quota reached; archive completed traces before admitting more work");
    db.prepare("UPDATE touba_trace_storage SET bytes=bytes+? WHERE singleton=1").run(bytes);
  }
  function decode(row) {
    if (hash(row.body) !== row.digest) fail("TraceStorageCorrupt", "trace event digest mismatch");
    const event = JSON.parse(row.body);
    if (event.sequence_index !== row.sequence_index || event.event_id !== row.event_id || event.kind !== row.kind) fail("TraceStorageCorrupt", "trace event index mismatch");
    return event;
  }
  function* readEvents(row, { after = row.start_index - 1 } = {}) {
    if (!Number.isSafeInteger(after) || after < -1) throw new TypeError("after must be an integer >= -1");
    // Use this exact snapshot's upper bound even if another writer appends.
    after = Math.max(after, row.start_index - 1);
    let remaining = row.start_index + row.event_count - after - 1;
    while (remaining > 0) {
      const page = store.page(row.id, { after, limit: Math.min(remaining, 100) });
      if (!page.events.length) fail("TraceStorageCorrupt", "trace events are missing");
      yield* page.events;
      remaining -= page.events.length; after = page.next;
    }
  }
  function snapshot(id) {
    // Capture now, not on first iteration: an async checkpoint observer may
    // consume this reader after other branches have appended to the segment.
    const row = segment(id);
    const reader = {
      segmentId: id, startIndex: row.start_index, eventCount: row.event_count,
      nextSequenceIndex: row.start_index + row.event_count,
      complete: Boolean(row.closed),
      get header() { return JSON.parse(row.header); },
      events(options) { return readEvents(row, options); },
      *json() {
        yield row.header.slice(0, -1) + ',"events":[';
        let separator = "";
        for (const event of readEvents(row)) { yield separator + JSON.stringify(event); separator = ","; }
        yield "]}";
      },
      document() {
        const jsonBytes = row.bytes + Buffer.byteLength(',"events":[]') + Math.max(0, row.event_count - 1);
        if (jsonBytes > maxDocumentBytes) fail("TraceMaterializationLimitExceeded", "use paginated trace reads or a streaming export");
        return { ...JSON.parse(row.header), events: [...readEvents(row)] };
      },
    };
    return Object.freeze(reader);
  }
  const store = {
    maxBatchBytes: maxEventBytes,
    openSegment(header, startIndex = 0) {
      if (!Number.isSafeInteger(startIndex) || startIndex < 0) throw new TypeError("startIndex must be non-negative");
      if (!header || typeof header.run?.run_id !== "string" || !header.run.run_id || "events" in header) throw new TypeError("a trace header without events is required");
      const body = JSON.stringify(header), bytes = Buffer.byteLength(body);
      if (bytes > maxEventBytes) fail("TraceStorageLimitExceeded", "trace header exceeds the event size limit");
      const id = randomUUID();
      transaction(() => {
        reserve(bytes);
        db.prepare("INSERT INTO touba_trace_segments(id,run_id,header,header_hash,start_index,bytes) VALUES(?,?,?,?,?,?)")
          .run(id, header.run.run_id, body, hash(body), startIndex, bytes);
      });
      return id;
    },
    append(id, event) { return store.appendBatch(id, [event]) === 1; },
    appendBatch(id, events) {
      if (!Array.isArray(events) || events.length < 1 || events.length > 64) throw new TypeError("a batch requires 1 to 64 events");
      let total = 0;
      const batch = events.map(event => {
        const body = JSON.stringify(event), bytes = Buffer.byteLength(body);
        total += bytes;
        if (total > maxEventBytes) fail("TraceStorageLimitExceeded", "trace batch exceeds the configured size limit");
        return { event, body, bytes };
      });
      return transaction(() => {
        let appended = 0;
        for (const { event, body, bytes } of batch) {
          const row = segment(id);
          if (!Number.isSafeInteger(event.sequence_index) || !Number.isSafeInteger(event.sequence_index + 1) || event.sequence_index < 0 || event.run_id !== row.run_id
            || event.event_id !== `event:${row.run_id}:${event.sequence_index + 1}` || typeof event.kind !== "string") {
            fail("TraceEventIdentityInvalid", "trace event identity does not match its segment");
          }
          const previous = db.prepare("SELECT * FROM touba_trace_events WHERE segment_id=? AND sequence_index=?").get(id, event.sequence_index);
          if (previous) {
            decode(previous);
            if (previous.body !== body) fail("TraceEventConflict", "trace sequence already contains a different event");
            continue;
          }
          if (row.closed) fail("TraceSegmentClosed", "cannot append to a completed trace segment");
          if (event.sequence_index !== row.start_index + row.event_count) fail("TraceSequenceInvalid", "trace events must be appended in order");
          reserve(bytes);
          db.prepare("INSERT INTO touba_trace_events VALUES(?,?,?,?,?,?)").run(id, event.sequence_index, event.event_id, event.kind, body, hash(body));
          db.prepare("UPDATE touba_trace_segments SET event_count=event_count+1,bytes=bytes+?,closed=? WHERE id=?")
            .run(bytes, event.kind === "run_completed" ? 1 : 0, id);
          appended++;
        }
        return appended;
      });
    },
    page(id, { after = -1, limit = 100 } = {}) {
      if (!Number.isSafeInteger(after) || after < -1) throw new TypeError("after must be an integer >= -1");
      positive(limit, "limit"); if (limit > 1000) throw new RangeError("page limit must be <= 1000");
      const row = segment(id);
      const events = [];
      let pageBytes = 0;
      for (const event of db.prepare("SELECT * FROM touba_trace_events WHERE segment_id=? AND sequence_index>? ORDER BY sequence_index LIMIT ?").iterate(id, after, limit)) {
        const size = Buffer.byteLength(event.body);
        if (size > maxEventBytes) fail("TraceStorageLimitExceeded", "stored event exceeds the configured size limit");
        if (events.length && pageBytes + size > maxEventBytes) break;
        events.push(decode(event)); pageBytes += size;
      }
      const expected = Math.max(row.start_index, after + 1);
      for (let i = 0; i < events.length; i++) if (events[i].sequence_index !== expected + i || events[i].run_id !== row.run_id) fail("TraceStorageCorrupt", "trace sequence contains a gap");
      if (events.length === 0 && expected < row.start_index + row.event_count) fail("TraceStorageCorrupt", "trace events are missing");
      return { events, next: events.at(-1)?.sequence_index ?? after,
        complete: Boolean(row.closed), eventCount: row.event_count };
    },
    snapshot,
    readReference(reference, { after = reference?.start_index - 1, limit = 100 } = {}) {
      validateTraceReference(reference);
      const reader = snapshot(reference.segment_id);
      const last = reference.start_index + reference.event_count - 1;
      if (!Number.isSafeInteger(after) || after < reference.start_index - 1 || after > last) throw new RangeError("trace cursor is outside the referenced segment");
      positive(limit, "limit"); if (limit > 1000) throw new RangeError("page limit must be <= 1000");
      if (!reader.complete || reader.startIndex !== reference.start_index || reader.eventCount !== reference.event_count
        || reader.header.run.run_id !== reference.run_id || traceJsonDigest(reader.header) !== reference.header_digest) {
        fail("TraceReferenceMismatch", "trace reference does not match the stored segment");
      }
      const terminal = store.page(reference.segment_id, { after: last - 1, limit: 1 }).events[0];
      if (terminal?.kind !== "run_completed" || terminal.event_id !== reference.terminal.event_id
        || traceJsonDigest(terminal) !== reference.terminal.digest || terminal.payload?.status !== reference.terminal.status
        || terminal.payload?.reason !== reference.terminal.reason) fail("TraceReferenceMismatch", "trace terminal does not match its reference");
      // Verify the complete digest at the start of a traversal, in bounded
      // memory. Later pages check their stored event digests and sequence;
      // they do not rescan the whole segment for each cursor.
      if (after === reference.start_index - 1 && createTraceReference(reader).trace_digest !== reference.trace_digest) {
        fail("TraceReferenceMismatch", "trace content does not match its reference");
      }
      const page = store.page(reference.segment_id, { after, limit });
      return { schema_version: "touba-trace-page-v1", reference: structuredClone(reference), header: reader.header,
        events: page.events, next: page.next, done: page.next === last };
    },
    document(id) { return snapshot(id).document(); },
    header(id) { return JSON.parse(segment(id).header); },
    *events(id) {
      // Capture the upper bound once: a reader does not chase a growing run.
      yield* readEvents(segment(id));
    },
    *json(id) {
      // Same JSON document as document(), one bounded page in memory.
      yield* snapshot(id).json();
    },
    *segments({ runId, after = "", limit = 100 } = {}) {
      positive(limit, "limit"); if (limit > 1000) throw new RangeError("page limit must be <= 1000");
      const rows = runId === undefined
        ? db.prepare("SELECT id FROM touba_trace_segments WHERE id>? ORDER BY id LIMIT ?").all(after, limit)
        : db.prepare("SELECT id FROM touba_trace_segments WHERE run_id=? AND id>? ORDER BY id LIMIT ?").all(runId, after, limit);
      for (const { id } of rows) { const row = segment(id); yield { id, runId: row.run_id, eventCount: row.event_count, bytes: row.bytes, complete: Boolean(row.closed) }; }
    },
    archive({ destination, apply = false, protectedRunIds = [] } = {}) {
      if (readOnly) fail("TraceStorageReadOnly", "archival requires a writable journal");
      if (typeof apply !== "boolean" || !Array.isArray(protectedRunIds)
        || protectedRunIds.some(id => typeof id !== "string" || !id)) throw new TypeError("invalid retention options");
      const protectedRuns = new Set(protectedRunIds);
      // Only runs whose latest segment succeeded are automatically reclaimable.
      // Pauses, interrupted writers and failed continuations remain available.
      function eligible(runId) {
        if (protectedRuns.has(runId)) return false;
        if (exportState.exportProtectsRun(runId)) return false;
        if (db.prepare("SELECT 1 FROM touba_trace_segments WHERE run_id=? AND closed=0 LIMIT 1").get(runId)) return false;
        const latest = db.prepare("SELECT id FROM touba_trace_segments WHERE run_id=? ORDER BY rowid DESC LIMIT 1").get(runId);
        if (!latest) return false;
        const row = segment(latest.id);
        const terminal = store.page(row.id, { after: row.start_index + row.event_count - 2, limit: 1 }).events[0];
        return terminal?.kind === "run_completed" && terminal.payload?.status === "success";
      }
      let segments = 0, bytes = 0;
      for (const row of db.prepare("SELECT id,run_id,bytes FROM touba_trace_segments").iterate()) {
        if (eligible(row.run_id)) { segments++; bytes += row.bytes; }
      }
      const report = { schema_version: "touba-trace-retention-v1", status: "preview", segments, bytes };
      if (!apply || !segments) return report;
      if (typeof destination !== "string" || !destination) throw new TypeError("a new archive filename is required");
      const archivePath = resolve(destination);
      const archiveParent = realpathSync(dirname(archivePath));
      if (process.platform !== "win32" && (lstatSync(archiveParent).mode & 0o022) !== 0) fail("TraceStoragePathInvalid", "archive directory must be private");
      // Exclusive creation refuses overwrites and symlinks. VACUUM INTO takes a
      // consistent snapshot without loading the database into JavaScript memory.
      closeSync(openSync(archivePath, "wx", 0o600));
      db.prepare("VACUUM INTO ?").run(archivePath);
      const archived = createSqliteTraceStore({ filename: archivePath, readOnly: true, maxEventBytes });
      try {
        for (const { id } of db.prepare("SELECT id FROM touba_trace_segments").iterate()) {
          // A concurrently created segment need not belong to the snapshot.
          let reader;
          try { reader = archived.snapshot(id); }
          catch (error) { if (error.code === "TraceSegmentMissing") continue; throw error; }
          for (const event of reader.events()) void event;
        }
        const file = openSync(archivePath, "r");
        try { fsyncSync(file); } finally { closeSync(file); }
        if (process.platform !== "win32") {
          const directory = openSync(archiveParent, "r");
          try { fsyncSync(directory); } finally { closeSync(directory); }
        }
        // Recheck eligibility under the writer lock. A new continuation, or
        // an unarchived segment, protects the entire run from reclamation.
        return transaction(() => {
          let removed = 0, reclaimed = 0;
          db.exec("CREATE TEMP TABLE touba_retention_runs AS SELECT DISTINCT run_id FROM touba_trace_segments");
          for (const candidate of db.prepare("SELECT run_id FROM touba_retention_runs").iterate()) {
            if (!eligible(candidate.run_id)) continue;
            let safe = true;
            for (const item of db.prepare("SELECT id FROM touba_trace_segments WHERE run_id=?").iterate(candidate.run_id)) {
              const current = snapshot(item.id);
              try {
                const saved = archived.snapshot(item.id);
                if (createTraceReference(current).trace_digest !== createTraceReference(saved).trace_digest) safe = false;
              } catch (error) {
                if (error.code !== "TraceSegmentMissing") throw error;
                safe = false;
              }
            }
            if (!safe) continue;
            const counts = db.prepare("SELECT count(*) AS n,sum(bytes) AS bytes FROM touba_trace_segments WHERE run_id=?").get(candidate.run_id);
            exportState.removeExportCursors(candidate.run_id);
            db.prepare("DELETE FROM touba_trace_events WHERE segment_id IN (SELECT id FROM touba_trace_segments WHERE run_id=?)").run(candidate.run_id);
            db.prepare("DELETE FROM touba_trace_segments WHERE run_id=?").run(candidate.run_id);
            removed += counts.n; reclaimed += counts.bytes;
          }
          db.exec("DROP TABLE touba_retention_runs");
          db.prepare("UPDATE touba_trace_storage SET bytes=bytes-? WHERE singleton=1").run(reclaimed);
          return { ...report, status: "archived", segments: removed, bytes: reclaimed, archive: archivePath };
        });
      } finally { archived.close(); }
    },
    close() { if (!closed) { db.close(); closed = true; } },
  };
  const exportState = traceExportState({ db, transaction, segment, page: store.page, hash });
  Object.assign(store, { configureExport: exportState.configureExport, exportLease: exportState.exportLease,
    nextExport: exportState.nextExport, acknowledgeExport: exportState.acknowledgeExport, exportStatus: exportState.exportStatus });
  return store;
}
