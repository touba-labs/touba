import { closeSync, constants, existsSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const FORMAT = "touba-indexed-record-store-v1";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const snapshots = new WeakMap();

// Shared local persistence. Callers own record validation and authorization.
// No connection, payload or authorization cache survives an operation.
/**
 * @typedef {string | number | null} IndexValue
 * @typedef {Record<string, IndexValue | IndexValue[]>[]} Filter
 * @typedef {{after?: string | number | undefined, limit: number, order: string, direction: string}} Page
 * @param {{path: string, schemaVersion: string, keyOf: (row: any) => string,
 * validate: (row: any, index: number) => void, parseValidated?: (body: string, index: number) => any,
 * indexes?: Record<string, string>, checkTransaction?: (db: DatabaseSync) => void,
 * maxBytes?: number, maxRecordBytes?: number, readOnly?: boolean}} options
 */
export function indexedStore({ path, schemaVersion, keyOf, validate, parseValidated, indexes = {}, checkTransaction,
  maxBytes = 512 * 1024 * 1024, maxRecordBytes = 16 * 1024 * 1024, readOnly = false }) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 65536 || !Number.isSafeInteger(maxRecordBytes) || maxRecordBytes < 1) {
    throw storeError("ToubaStoreConfigurationInvalid", "invalid storage or record byte limit");
  }
  const absolutePath = resolve(path);
  const names = Object.keys(indexes);
  if (names.some(name => !/^[a-z][a-z_]*$/.test(name))) {
    throw storeError("ToubaStoreConfigurationInvalid", "invalid index name");
  }

  /** @param {DatabaseSync} db */
  function configure(db) {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA cache_size=-2048;");
    const pages = Math.floor(maxBytes / /** @type {{page_size: number}} */ (db.prepare("PRAGMA page_size").get()).page_size);
    if (/** @type {{page_count: number}} */ (db.prepare("PRAGMA page_count").get()).page_count > pages) throw storeError("ToubaStoreCapacityExceeded", "database exceeds its configured byte limit");
    db.exec(`PRAGMA max_page_count=${pages};`);
  }

  function initialize() {
    mkdirSync(dirname(absolutePath), { recursive: true, mode: 0o700 });
    const temporary = `${absolutePath}.init-${randomUUID()}`;
    closeSync(openSync(temporary, "wx", 0o600));
    try {
      const db = new DatabaseSync(temporary, { timeout: 1000, allowExtension: false });
      try {
        configure(db);
        db.exec("BEGIN IMMEDIATE");
        db.exec(`CREATE TABLE metadata (singleton INTEGER PRIMARY KEY CHECK(singleton=1), format TEXT NOT NULL, schema_version TEXT NOT NULL) STRICT;
          CREATE TABLE records (id TEXT PRIMARY KEY NOT NULL, revision INTEGER NOT NULL CHECK(revision > 0), body TEXT NOT NULL CHECK(json_valid(body))) STRICT;`);
        db.prepare("INSERT INTO metadata VALUES (1, ?, ?)").run(FORMAT, schemaVersion);
        for (const [name, expression] of Object.entries(indexes)) {
          db.exec(`CREATE INDEX idx_${name} ON records (${expression})`);
        }
        db.exec("COMMIT");
      } finally { db.close(); }
      // Publish a fully initialized database without replacing another writer.
      try { linkSync(temporary, absolutePath); }
      catch (error) { if (/** @type {NodeJS.ErrnoException} */ (error).code !== "EEXIST") throw error; }
    } finally { unlinkSync(temporary); }
    if (process.platform !== "win32") {
      const directory = openSync(dirname(absolutePath), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
  }

  function open({ forWrite = true } = {}) {
    if (!existsSync(absolutePath)) {
      if (readOnly) throw storeError("ToubaStoreMissing", "stored state does not exist");
      initialize();
    }
    for (const suffix of ["", "-wal", "-shm", "-journal"]) {
      let stat;
      try { stat = lstatSync(absolutePath + suffix); }
      catch (error) { if (suffix && /** @type {NodeJS.ErrnoException} */ (error).code === "ENOENT") continue; throw error; }
      // Initial publication links the completed database and then unlinks its
      // temporary name. Another process may observe that short two-link window.
      // Wait a bounded interval, but never accept a persistently hardlinked file.
      if (!suffix && stat.isFile() && stat.nlink === 2) {
        const wait = new Int32Array(new SharedArrayBuffer(4));
        for (let attempt = 0; attempt < 25 && stat.nlink === 2; attempt++) {
          Atomics.wait(wait, 0, 0, 10);
          stat = lstatSync(absolutePath);
        }
      }
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw storeError("ToubaStorePathInvalid", "stored state must be a regular file without links");
    }
    {
      const fd = openSync(absolutePath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      const header = Buffer.alloc(16);
      try {
        if (!fstatSync(fd).isFile()) throw storeError("ToubaStorePathInvalid", "stored state must be a regular file");
        readSync(fd, header, 0, 16, 0);
      } finally { closeSync(fd); }
      if (!header.equals(SQLITE_HEADER)) {
        throw storeError("ToubaStoreFormatIncompatible",
          "stored state is not the current indexed format; preserve it and use its original build before upgrading");
      }
    }
    const db = new DatabaseSync(absolutePath, { timeout: 1000, allowExtension: false, readOnly: readOnly || !forWrite });
    try {
      db.exec("PRAGMA trusted_schema=OFF;");
      const metadata = db.prepare("SELECT format, schema_version FROM metadata WHERE singleton=1").get();
      if (metadata?.format !== FORMAT || metadata.schema_version !== schemaVersion) {
        throw storeError("ToubaStoreFormatIncompatible", "stored state schema does not match this build; no migration was performed");
      }
      if (!readOnly && forWrite) configure(db);
      else {
        // Read paths do not change journaling or persist page-quota settings.
        // Still reject an oversized database before returning any record.
        const pageSize = /** @type {{page_size: number}} */ (db.prepare("PRAGMA page_size").get()).page_size;
        if (/** @type {{page_count: number}} */ (db.prepare("PRAGMA page_count").get()).page_count > Math.floor(maxBytes / pageSize)) {
          throw storeError("ToubaStoreCapacityExceeded", "database exceeds its configured byte limit");
        }
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  /** @param {Filter | undefined} filter */
  function selection(filter) {
    if (filter === undefined) return { sql: "", params: [] };
    if (!Array.isArray(filter) || filter.length === 0) {
      throw storeError("ToubaStoreQueryInvalid", "selection must contain at least one indexed clause");
    }
    /** @type {IndexValue[]} */
    const params = [];
    const clauses = filter.map(clause => {
      const keys = Object.keys(clause);
      if (keys.length === 0) throw storeError("ToubaStoreQueryInvalid", "empty indexed clause");
      return `(${keys.map(name => {
        if (!Object.hasOwn(indexes, name) && name !== "id") {
          throw storeError("ToubaStoreQueryInvalid", "unknown indexed field");
        }
        const expression = name === "id" ? "id" : indexes[name];
        const values = Array.isArray(clause[name]) ? clause[name] : [clause[name]];
        if (values.length === 0) return "0";
        if (values.some(value => typeof value !== "string" && typeof value !== "number" && value !== null)) {
          throw storeError("ToubaStoreQueryInvalid", "index values must be scalar");
        }
        params.push(...values);
        return `(${values.map(() => `${expression} IS ?`).join(" OR ")})`;
      }).join(" AND ")})`;
    });
    return { sql: ` WHERE ${clauses.join(" OR ")}`, params };
  }

  /** @param {Filter} [filter] @param {Page} [page] */
  function read(filter, page) {
    const query = selection(filter);
    if (page) {
      if (!["id", "rowid"].includes(page.order)) throw storeError("ToubaStoreQueryInvalid", "unsupported page order");
      if (!["asc", "desc"].includes(page.direction)) throw storeError("ToubaStoreQueryInvalid", "unsupported page direction");
      if (page.after !== undefined && (page.order === "id" ? typeof page.after !== "string" : !Number.isSafeInteger(page.after))) {
        throw storeError("ToubaStoreQueryInvalid", "page cursor must match its selected order");
      }
      if (!Number.isSafeInteger(page.limit) || page.limit < 1 || page.limit > 1000) throw storeError("ToubaStoreQueryInvalid", "page limit must be between 1 and 1000");
      // Parentheses retain the meaning of OR selections before adding a cursor.
      query.sql = query.sql ? ` WHERE (${query.sql.slice(7)})` : " WHERE 1";
      if (page.after !== undefined) { query.sql += ` AND ${page.order}${page.direction === "desc" ? "<" : ">"}?`; query.params.push(page.after); }
    }
    const records = [];
    const versions = new Map();
    let cursor = null;
    let hasMore = false;
    if (existsSync(absolutePath)) {
      const db = open({ forWrite: false });
      try {
        const tail = page ? ` ORDER BY ${page.order} ${page.direction.toUpperCase()} LIMIT ?` : " ORDER BY rowid";
        const params = page ? [...query.params, page.limit] : query.params;
        let bytes = 0;
        for (const stored of db.prepare(`SELECT rowid, id, revision, body FROM records${query.sql}${tail}`).iterate(...params)) {
          const row = /** @type {{rowid: number, id: string, revision: number, body: string}} */ (stored);
          if (page) {
            const size = Buffer.byteLength(row.body);
            if (size > 16 * 1024 * 1024) throw storeError("ToubaStoreRecordTooLarge", "record exceeds the page byte limit");
            if (bytes + size > 16 * 1024 * 1024) break;
            bytes += size;
          }
          let record;
          // A caller may pair its writer validator with a validating JSON
          // parser. This avoids serializing an already-read body for a cache
          // key; identity and optimistic revision checks remain in this store.
          if (parseValidated) {
            try { record = parseValidated(row.body, records.length); }
            catch (error) {
              if (error instanceof SyntaxError) throw storeError("ToubaStoreRecordInvalid", "stored record is not valid JSON");
              throw error;
            }
          } else {
            try { record = JSON.parse(row.body); }
            catch { throw storeError("ToubaStoreRecordInvalid", "stored record is not valid JSON"); }
            validate(record, records.length);
          }
          if (keyOf(record) !== row.id) {
            throw storeError("ToubaStoreRecordInvalid", "stored record key does not match its content");
          }
          records.push(record);
          cursor = page?.order === "rowid" ? row.rowid : row.id;
          versions.set(row.id, { revision: row.revision, body: row.body });
        }
        if (page && cursor !== null) {
          // Probe only the next key, never deserialize the rest of the history.
          hasMore = Boolean(db.prepare(`SELECT 1 FROM records${query.sql} AND ${page.order}${page.direction === "desc" ? "<" : ">"}? LIMIT 1`)
            .get(...query.params, cursor));
        }
      } finally { db.close(); }
    }
    snapshots.set(records, { path: absolutePath, schemaVersion, versions, cursor, hasMore });
    return records;
  }

  /** @param {any[]} records @param {{removeIds?: string[]}} options */
  function write(records, { removeIds = [] } = {}) {
    if (readOnly) throw storeError("ToubaStoreReadOnly", "stored state is read-only");
    const snapshot = snapshots.get(records);
    if (!snapshot || snapshot.path !== absolutePath || snapshot.schemaVersion !== schemaVersion) {
      throw storeError("ToubaStoreSnapshotRequired", "write requires a snapshot read from this store");
    }
    const next = new Map();
    const changes = [];
    for (const [index, record] of records.entries()) {
      validate(record, index);
      const id = keyOf(record);
      if (typeof id !== "string" || id.length === 0 || next.has(id)) {
        throw storeError("ToubaStoreRecordInvalid", "record keys must be nonempty and unique");
      }
      const body = JSON.stringify(record);
      if (Buffer.byteLength(body) > maxRecordBytes) throw storeError("ToubaStoreRecordTooLarge", "record exceeds its byte limit");
      const previous = snapshot.versions.get(id);
      const revision = previous?.revision ?? 0;
      if (body !== previous?.body) changes.push({ id, body, revision, previous });
      next.set(id, { body, revision: revision + (body !== previous?.body ? 1 : 0) });
    }
    const removed = new Set(removeIds);
    if (removed.size !== removeIds.length || [...removed].some(id => !snapshot.versions.has(id) || next.has(id))) {
      throw storeError("ToubaStoreDeletionRefused", "explicit removal requires a record in the read snapshot");
    }
    for (const id of snapshot.versions.keys()) {
      if (!next.has(id) && !removed.has(id)) throw storeError("ToubaStoreDeletionRefused", "record deletion is not an implicit update");
    }
    // A no-op commit still validates its read set: authorization may depend on
    // an unchanged record that another process has revoked in the meantime.
    const db = open();
    try {
      db.exec("BEGIN IMMEDIATE");
      try {
        // Validate the whole read set, not just rows being modified. A write
        // may depend on an unchanged peer that another caller has since changed.
        const current = db.prepare("SELECT revision, body FROM records WHERE id=?");
        for (const [id, previous] of snapshot.versions) {
          const row = current.get(id);
          if (row?.revision !== previous.revision || row?.body !== previous.body) throw conflict();
        }
        for (const id of removed) db.prepare("DELETE FROM records WHERE id=?").run(id);
        for (const { id, body, revision, previous } of changes) {
          if (previous === undefined) {
            const result = db.prepare("INSERT INTO records(id, revision, body) VALUES (?, 1, ?) ON CONFLICT(id) DO NOTHING").run(id, body);
            if (result.changes !== 1) throw conflict();
          } else {
            const result = db.prepare("UPDATE records SET body=?, revision=revision+1 WHERE id=? AND revision=? AND body=?")
              .run(body, id, revision, previous.body);
            if (result.changes !== 1) throw conflict();
          }
        }
        checkTransaction?.(db);
        db.exec("COMMIT");
        snapshot.versions = next;
      } catch (error) {
        // SQLITE_FULL / IOERR can roll back the transaction themselves. Keep
        // the original failure instead of replacing it with "no transaction".
        try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
        throw error;
      }
    } finally { db.close(); }
  }

  return Object.freeze({ read, write,
    /** Read-only projection of a bounded window, validating one complete row
     * at a time without retaining writable snapshots or all source bodies.
     * @param {(record: any) => any} project
     * @param {{filter?: Filter, limit: number, maxOutputBytes?: number}} options */
    project(project, { filter, limit, maxOutputBytes = 16 * 1024 * 1024 }) {
      if (typeof project !== "function" || !Number.isSafeInteger(limit) || limit < 1 || limit > 1000
        || !Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 16 * 1024 * 1024) {
        throw storeError("ToubaStoreQueryInvalid", "invalid bounded projection");
      }
      if (!existsSync(absolutePath)) return [];
      const query = selection(filter), db = open({ forWrite: false }), result = [];
      let bytes = 2;
      try {
        for (const stored of db.prepare(`SELECT id, body FROM records${query.sql} ORDER BY rowid LIMIT ?`).iterate(...query.params, limit + 1)) {
          if (result.length === limit) throw storeError("ToubaStoreCapacityExceeded", "projection exceeds its bounded window");
          const row = /** @type {{id: string, body: string}} */ (stored);
          if (Buffer.byteLength(row.body) > maxRecordBytes) throw storeError("ToubaStoreRecordTooLarge", "record exceeds its byte limit");
          let record;
          try { record = parseValidated ? parseValidated(row.body, result.length) : JSON.parse(row.body); }
          catch (error) {
            if (error instanceof SyntaxError) throw storeError("ToubaStoreRecordInvalid", "stored record is not valid JSON");
            throw error;
          }
          if (!parseValidated) validate(record, result.length);
          if (keyOf(record) !== row.id) throw storeError("ToubaStoreRecordInvalid", "stored record key does not match its content");
          const projected = project(record), encoded = JSON.stringify(projected);
          if (encoded === undefined) throw storeError("ToubaStoreQueryInvalid", "projection must return JSON");
          bytes += Buffer.byteLength(encoded) + (result.length ? 1 : 0);
          if (bytes > maxOutputBytes) throw storeError("ToubaStoreCapacityExceeded", "projection exceeds its byte limit");
          result.push(projected);
        }
        return result;
      } finally { db.close(); }
    },
    /** @param {{filter?: Filter, after?: string | number, limit?: number, order?: string, direction?: string}} options */
    page({ filter, after, limit = 100, order = "id", direction = "asc" } = {}) {
      // Exhaustive internal audits can follow physical row order. UI/API
      // pagination retains stable record identifiers. Each page closes its
      // connection before callers process it, including callers that repair.
      const items = read(filter, { after, limit, order, direction });
      return { items, next: snapshots.get(items).cursor, hasMore: snapshots.get(items).hasMore };
    },
    /** @param {Filter} [filter] */
    count(filter) {
      if (!existsSync(absolutePath)) return 0;
      const query = selection(filter), db = open({ forWrite: false });
      try { return /** @type {{n: number}} */ (db.prepare(`SELECT count(*) AS n FROM records${query.sql}`).get(...query.params)).n; }
      finally { db.close(); }
    },
    /** Count groups in one SQL observation, without loading record bodies into JS.
     * @param {string} index */
    countBy(index) {
      if (!Object.hasOwn(indexes, index)) throw storeError("ToubaStoreQueryInvalid", "unknown count index");
      if (!existsSync(absolutePath)) return [];
      const db = open({ forWrite: false });
      try {
        return db.prepare(`SELECT ${indexes[index]} AS value, count(*) AS count FROM records GROUP BY ${indexes[index]}`).all();
      } finally { db.close(); }
    },
    initialize() { open().close(); },
  });
}

function conflict() {
  return storeError("ToubaStoreWriteConflict", "stored state changed after it was read; retry from a fresh snapshot");
}

/** @param {string} code @param {string} message */
function storeError(code, message) {
  return Object.assign(new Error(message), { code });
}
