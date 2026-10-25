import { createHash, randomUUID } from "node:crypto";

const digest = value => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
const identifier = value => typeof value === "string" && /^[a-zA-Z0-9_.:-]{1,200}$/.test(value);

// The host supplies a node-postgres compatible pool, credentials and TLS policy.
// Transactions always use one checked-out connection. The schema is dedicated
// to trace evidence; no application code or provider credentials are executed.
export async function createPostgresTraceDestination({ pool, schema = "touba_traces", leaseMs = 30000 }) {
  if (!pool || typeof pool.connect !== "function" || !/^[a-z][a-z0-9_]{0,62}$/.test(schema)) throw new TypeError("a PostgreSQL pool and a simple schema name are required");
  if (!Number.isSafeInteger(leaseMs) || leaseMs < 1000 || leaseMs > 300000) throw new TypeError("leaseMs must be between 1000 and 300000");
  const prefix = `"${schema}".`;
  async function transaction(work) {
    const client = await pool.connect();
    let discard = false;
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL lock_timeout='5s'; SET LOCAL statement_timeout='10s'; SET LOCAL idle_in_transaction_session_timeout='15s'");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      discard = true;
      try { await client.query("ROLLBACK"); } catch { /* retain original failure */ }
      throw error;
    } finally { client.release(discard); }
  }
  const destinationId = await transaction(async client => {
    // Serializes first-time initialization without relying on IF NOT EXISTS races.
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`touba-traces:${schema}`]);
    await client.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";
      CREATE TABLE IF NOT EXISTS ${prefix}metadata(singleton integer PRIMARY KEY CHECK(singleton=1), format text NOT NULL, id text NOT NULL);
      CREATE TABLE IF NOT EXISTS ${prefix}leases(source_id text PRIMARY KEY, owner text NOT NULL, epoch bigint NOT NULL, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS ${prefix}segments(source_id text NOT NULL, id text NOT NULL, header text NOT NULL, header_digest text NOT NULL,
        start_index bigint NOT NULL, next_index bigint NOT NULL, closed boolean NOT NULL DEFAULT false, PRIMARY KEY(source_id,id));
      CREATE TABLE IF NOT EXISTS ${prefix}events(source_id text NOT NULL, segment_id text NOT NULL, sequence_index bigint NOT NULL,
        event_id text NOT NULL, body text NOT NULL, digest text NOT NULL, PRIMARY KEY(source_id,segment_id,sequence_index),
        UNIQUE(source_id,segment_id,event_id), FOREIGN KEY(source_id,segment_id) REFERENCES ${prefix}segments(source_id,id));`);
    await client.query(`INSERT INTO ${prefix}metadata VALUES(1,'touba-postgres-trace-v1',$1) ON CONFLICT DO NOTHING`, [randomUUID()]);
    const { rows: [meta] } = await client.query(`SELECT * FROM ${prefix}metadata WHERE singleton=1`);
    if (meta.format !== "touba-postgres-trace-v1") fail("TraceExportDestinationInvalid", "incompatible PostgreSQL trace schema");
    return meta.id;
  });

  async function assertLease(client, sourceId, lease) {
    const { rows } = await client.query(`SELECT 1 FROM ${prefix}leases
      WHERE source_id=$1 AND owner=$2 AND epoch=$3 AND expires_at>clock_timestamp() FOR UPDATE`, [sourceId, lease.owner, lease.epoch]);
    if (!rows.length) fail("TraceExportLeaseStale", "trace export lease expired or was replaced");
  }
  function validateIdentity(sourceId, lease) {
    if (!identifier(sourceId) || !identifier(lease?.owner) || !Number.isSafeInteger(lease?.epoch) || lease.epoch < 1) throw new TypeError("invalid export identity");
  }
  return Object.freeze({ destinationId,
    async acquire(sourceId, owner) {
      if (!identifier(sourceId) || !identifier(owner)) throw new TypeError("invalid export identity");
      return transaction(async client => {
        const { rows } = await client.query(`INSERT INTO ${prefix}leases VALUES($1,$2,1,clock_timestamp()+$3*interval '1 millisecond')
          ON CONFLICT(source_id) DO UPDATE SET owner=excluded.owner, epoch=${prefix}leases.epoch+1, expires_at=excluded.expires_at
          WHERE ${prefix}leases.expires_at<=clock_timestamp() RETURNING epoch`, [sourceId, owner, leaseMs]);
        if (!rows.length) return null;
        const epoch = Number(rows[0].epoch);
        if (!Number.isSafeInteger(epoch)) fail("TraceExportLeaseInvalid", "export epoch exceeds the safe range");
        return { owner, epoch };
      });
    },
    async renew(sourceId, lease) {
      validateIdentity(sourceId, lease);
      return transaction(async client => {
        await assertLease(client, sourceId, lease);
        await client.query(`UPDATE ${prefix}leases SET expires_at=clock_timestamp()+$4*interval '1 millisecond' WHERE source_id=$1 AND owner=$2 AND epoch=$3`, [sourceId, lease.owner, lease.epoch, leaseMs]);
      });
    },
    async release(sourceId, lease) {
      validateIdentity(sourceId, lease);
      await transaction(client => client.query(`UPDATE ${prefix}leases SET expires_at=clock_timestamp()
        WHERE source_id=$1 AND owner=$2 AND epoch=$3`, [sourceId, lease.owner, lease.epoch]));
    },
    async deliver(sourceId, lease, batch) {
      validateIdentity(sourceId, lease);
      if (!identifier(batch?.segmentId) || !Array.isArray(batch.events) || batch.events.length < 1 || batch.events.length > 1000
          || Buffer.byteLength(JSON.stringify(batch)) > 2 * 1024 * 1024 || digest(batch.header) !== batch.headerDigest
          || !Number.isSafeInteger(batch.startIndex) || batch.startIndex < 0
          || !Number.isSafeInteger(batch.after) || batch.after < batch.startIndex - 1
          || batch.through !== batch.after + batch.events.length || typeof batch.complete !== "boolean") throw new TypeError("invalid bounded export batch");
      for (const [i, event] of batch.events.entries()) {
        if (event.sequence_index !== batch.after + i + 1 || event.run_id !== batch.header.run?.run_id
            || event.event_id !== `event:${event.run_id}:${event.sequence_index + 1}`
            || event.kind === "run_completed" && i !== batch.events.length - 1) throw new TypeError("invalid trace sequence");
      }
      if (batch.complete !== (batch.events.at(-1).kind === "run_completed")) throw new TypeError("invalid trace terminal marker");
      return transaction(async client => {
        await assertLease(client, sourceId, lease);
        const header = JSON.stringify(batch.header);
        await client.query(`INSERT INTO ${prefix}segments(source_id,id,header,header_digest,start_index,next_index)
          VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING`, [sourceId, batch.segmentId, header, batch.headerDigest, batch.startIndex]);
        const { rows: [stored] } = await client.query(`SELECT * FROM ${prefix}segments WHERE source_id=$1 AND id=$2 FOR UPDATE`, [sourceId, batch.segmentId]);
        if (stored.header !== header || stored.header_digest !== batch.headerDigest || Number(stored.start_index) !== batch.startIndex) fail("TraceExportConflict", "trace segment identity has different content");
        let next = Number(stored.next_index), closed = stored.closed;
        for (const event of batch.events) {
          const body = JSON.stringify(event), hash = digest(event);
          if (event.sequence_index < next) {
            const { rows: [previous] } = await client.query(`SELECT body,digest FROM ${prefix}events WHERE source_id=$1 AND segment_id=$2 AND sequence_index=$3`, [sourceId, batch.segmentId, event.sequence_index]);
            if (previous?.body !== body || previous?.digest !== hash) fail("TraceExportConflict", "trace event identity has different content");
            continue;
          }
          if (closed || event.sequence_index !== next) fail("TraceExportSequenceInvalid", "trace export contains a gap or extends a completed segment");
          await client.query(`INSERT INTO ${prefix}events VALUES($1,$2,$3,$4,$5,$6)`, [sourceId, batch.segmentId, event.sequence_index, event.event_id, body, hash]);
          next++; closed = event.kind === "run_completed";
        }
        await client.query(`UPDATE ${prefix}segments SET next_index=$3,closed=$4 WHERE source_id=$1 AND id=$2`, [sourceId, batch.segmentId, next, closed]);
        await assertLease(client, sourceId, lease);
        return { segmentId: batch.segmentId, through: batch.through, headerDigest: batch.headerDigest };
      });
    },
  });
}
