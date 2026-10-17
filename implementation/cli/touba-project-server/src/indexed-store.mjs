import { closeSync, existsSync, linkSync, mkdirSync, openSync, readSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";

const FORMAT = "touba-indexed-record-store-v1";
const SQLITE_HEADER = Buffer.from("SQLite format 3\0");
const snapshots = new WeakMap();

// Local persistence only. Callers own record validation and authorization.
// No connection, payload or authorization cache survives an operation.
export function indexedStore({ path, schemaVersion, keyOf, validate, indexes = {}, checkTransaction }) {
  const absolutePath = resolve(path);
  const names = Object.keys(indexes);
  if (names.some(name => !/^[a-z][a-z_]*$/.test(name))) {
    throw storeError("ToubaStoreConfigurationInvalid", "invalid index name");
  }

  function configure(db) {
    db.exec("PRAGMA journal_mode=DELETE; PRAGMA trusted_schema=OFF; PRAGMA synchronous=EXTRA; PRAGMA fullfsync=ON; PRAGMA cache_size=-2048;");
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
      catch (error) { if (error.code !== "EEXIST") throw error; }
    } finally { unlinkSync(temporary); }
  }

  function open() {
    if (!existsSync(absolutePath)) initialize();
    {
      const fd = openSync(absolutePath, "r");
      const header = Buffer.alloc(16);
      try { readSync(fd, header, 0, 16, 0); } finally { closeSync(fd); }
      if (!header.equals(SQLITE_HEADER)) {
        throw storeError("ToubaStoreFormatIncompatible",
          "stored state is not the current indexed format; preserve it and use its original build before upgrading");
      }
    }
    const db = new DatabaseSync(absolutePath, { timeout: 1000, allowExtension: false });
    try {
      configure(db);
      const metadata = db.prepare("SELECT format, schema_version FROM metadata WHERE singleton=1").get();
      if (metadata?.format !== FORMAT || metadata.schema_version !== schemaVersion) {
        throw storeError("ToubaStoreFormatIncompatible", "stored state schema does not match this build; no migration was performed");
      }
      return db;
    } catch (error) {
      db.close();
      throw error;
    }
  }

  function selection(filter) {
    if (filter === undefined) return { sql: "", params: [] };
    if (!Array.isArray(filter) || filter.length === 0) {
      throw storeError("ToubaStoreQueryInvalid", "selection must contain at least one indexed clause");
    }
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

  function read(filter) {
    const query = selection(filter);
    const records = [];
    const versions = new Map();
    if (existsSync(absolutePath)) {
      const db = open();
      try {
        for (const row of db.prepare(`SELECT id, revision, body FROM records${query.sql} ORDER BY rowid`).iterate(...query.params)) {
          const record = JSON.parse(row.body);
          validate(record, records.length);
          if (keyOf(record) !== row.id) {
            throw storeError("ToubaStoreRecordInvalid", "stored record key does not match its content");
          }
          records.push(record);
          versions.set(row.id, { revision: row.revision, body: row.body });
        }
      } finally { db.close(); }
    }
    snapshots.set(records, { path: absolutePath, schemaVersion, versions });
    return records;
  }

  function write(records, { removeIds = [] } = {}) {
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
    if (changes.length === 0 && removed.size === 0) return;
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

  return Object.freeze({ read, write, initialize() { open().close(); } });
}

function conflict() {
  return storeError("ToubaStoreWriteConflict", "stored state changed after it was read; retry from a fresh snapshot");
}

function storeError(code, message) {
  return Object.assign(new Error(message), { code });
}
