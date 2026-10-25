import { randomUUID } from "node:crypto";

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const text = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);

// Export metadata shares the durable trace journal. Events themselves are the
// bounded outbox: no second in-memory or on-disk copy is queued by the runtime.
export function traceExportState({ db, transaction, segment, page, hash }) {
  const exists = () => Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='touba_trace_exports'").get());
  function settings(name) {
    if (!exists()) fail("TraceExportNotConfigured", "configure a trace destination first");
    const row = db.prepare("SELECT * FROM touba_trace_exports WHERE name=?").get(name);
    if (!row) fail("TraceExportNotConfigured", "unknown trace destination");
    return row;
  }
  function fence(name, lease) {
    const row = settings(name);
    if (row.owner !== lease?.owner || row.epoch !== lease?.epoch || !Number.isSafeInteger(lease?.epoch) || lease.epoch < 1) {
      fail("TraceExportLeaseStale", "trace export worker has been replaced");
    }
    return row;
  }
  return {
    configureExport({ name = "primary", destinationId }) {
      if (!text(name) || !text(destinationId)) throw new TypeError("invalid export identity");
      return transaction(() => {
        db.exec(`CREATE TABLE IF NOT EXISTS touba_trace_exports (
          name TEXT PRIMARY KEY, destination_id TEXT NOT NULL, source_id TEXT NOT NULL,
          owner TEXT, epoch INTEGER NOT NULL DEFAULT 0);
          CREATE TABLE IF NOT EXISTS touba_trace_export_cursors (
          name TEXT NOT NULL, segment_id TEXT NOT NULL, last_index INTEGER NOT NULL,
          PRIMARY KEY(name, segment_id));`);
        const current = db.prepare("SELECT * FROM touba_trace_exports WHERE name=?").get(name);
        if (current && current.destination_id !== destinationId) fail("TraceExportDestinationChanged", "destination identity changed; existing acknowledgements cannot be reused");
        if (!current) {
          if (db.prepare("SELECT count(*) AS n FROM touba_trace_exports").get().n >= 8) fail("TraceExportLimitExceeded", "at most eight destinations are supported per journal");
          db.prepare("INSERT INTO touba_trace_exports(name,destination_id,source_id) VALUES(?,?,?)").run(name, destinationId, randomUUID());
        }
        const row = settings(name);
        return { name, destinationId: row.destination_id, sourceId: row.source_id };
      });
    },
    exportLease(name, lease) {
      if (!text(lease?.owner) || !Number.isSafeInteger(lease?.epoch) || lease.epoch < 1) throw new TypeError("invalid export lease");
      return transaction(() => {
        const row = settings(name);
        if (lease.epoch < row.epoch || lease.epoch === row.epoch && row.owner !== lease.owner) fail("TraceExportLeaseStale", "trace export worker has been replaced");
        db.prepare("UPDATE touba_trace_exports SET owner=?,epoch=? WHERE name=?").run(lease.owner, lease.epoch, name);
      });
    },
    nextExport(name, lease, limit = 100) {
      fence(name, lease);
      const next = db.prepare(`SELECT s.id,coalesce(c.last_index,s.start_index-1) AS last_index
        FROM touba_trace_segments s LEFT JOIN touba_trace_export_cursors c ON c.name=? AND c.segment_id=s.id
        WHERE coalesce(c.last_index,s.start_index-1)<s.start_index+s.event_count-1
        ORDER BY s.rowid LIMIT 1`).get(name);
      if (!next) return null;
      const row = segment(next.id), batch = page(next.id, { after: next.last_index, limit });
      return { segmentId: row.id, header: JSON.parse(row.header), headerDigest: row.header_hash,
        startIndex: row.start_index, after: next.last_index, through: batch.next,
        events: batch.events, complete: Boolean(row.closed) && batch.next === row.start_index + row.event_count - 1 };
    },
    acknowledgeExport(name, lease, batch) {
      return transaction(() => {
        fence(name, lease);
        const row = segment(batch.segmentId);
        if (!Number.isSafeInteger(batch.after) || !Number.isSafeInteger(batch.through)
            || batch.after < row.start_index - 1 || batch.through <= batch.after
            || batch.through >= row.start_index + row.event_count || batch.headerDigest !== row.header_hash) fail("TraceExportAckInvalid", "invalid export acknowledgement");
        const previous = db.prepare("SELECT last_index FROM touba_trace_export_cursors WHERE name=? AND segment_id=?").get(name, row.id)?.last_index ?? row.start_index - 1;
        if (previous >= batch.through) return;
        if (previous !== batch.after) fail("TraceExportAckInvalid", "export acknowledgement has a gap");
        // Verify the exact batch still matches durable bytes before releasing it.
        const saved = page(row.id, { after: batch.after, limit: batch.events.length });
        if (saved.next !== batch.through || hash(JSON.stringify(saved.events)) !== hash(JSON.stringify(batch.events))) fail("TraceExportAckInvalid", "exported events do not match durable evidence");
        db.prepare(`INSERT INTO touba_trace_export_cursors VALUES(?,?,?) ON CONFLICT(name,segment_id)
          DO UPDATE SET last_index=excluded.last_index`).run(name, row.id, batch.through);
      });
    },
    exportStatus(name) {
      const row = settings(name);
      const pending = db.prepare(`SELECT coalesce(sum(s.start_index+s.event_count-1-coalesce(c.last_index,s.start_index-1)),0) AS events
        FROM touba_trace_segments s LEFT JOIN touba_trace_export_cursors c ON c.name=? AND c.segment_id=s.id`).get(name);
      return { name, destinationId: row.destination_id, sourceId: row.source_id, pendingEvents: pending.events, epoch: row.epoch };
    },
    exportProtectsRun(runId) {
      if (!exists()) return false;
      return Boolean(db.prepare(`SELECT 1 FROM touba_trace_segments s CROSS JOIN touba_trace_exports e
        LEFT JOIN touba_trace_export_cursors c ON c.name=e.name AND c.segment_id=s.id
        WHERE s.run_id=? AND coalesce(c.last_index,s.start_index-1)<s.start_index+s.event_count-1 LIMIT 1`).get(runId));
    },
    removeExportCursors(runId) {
      if (exists()) db.prepare("DELETE FROM touba_trace_export_cursors WHERE segment_id IN (SELECT id FROM touba_trace_segments WHERE run_id=?)").run(runId);
    },
  };
}
