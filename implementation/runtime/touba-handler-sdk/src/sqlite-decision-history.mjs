import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { constants, openSync, closeSync, fchmodSync, fstatSync, lstatSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ToubaAgentDecisionProviderError } from "./decision-contract.mjs";

const fail = (code, message) => { throw new ToubaAgentDecisionProviderError(code, message); };

function privateDatabaseFile(filename) {
  if (filename === ":memory:") return;
  const parent = lstatSync(dirname(resolve(filename)));
  if (!parent.isDirectory() || parent.isSymbolicLink()
      || (process.platform !== "win32" && (parent.mode & 0o022) !== 0)) {
    fail("DecisionHistoryStorageUnsafe", "history database requires a directory not writable by other users");
  }
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    let fd;
    try {
      let before;
      try { before = lstatSync(filename + suffix); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
      if (before && (!before.isFile() || before.isSymbolicLink() || before.nlink !== 1)) {
        fail("DecisionHistoryStorageUnsafe", "history storage must be a regular file without links");
      }
      fd = openSync(filename + suffix, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0)
        | (suffix === "" ? constants.O_CREAT : 0), 0o600);
      const stat = fstatSync(fd);
      if (!stat.isFile() || stat.nlink !== 1) fail("DecisionHistoryStorageUnsafe", "history storage must be a regular file without links");
      if (before && (before.dev !== stat.dev || before.ino !== stat.ino)) fail("DecisionHistoryStorageUnsafe", "history storage changed while opening");
      if (process.platform !== "win32") fchmodSync(fd, 0o600);
    } catch (error) {
      if (suffix && error.code === "ENOENT") continue;
      if (error.code === "ELOOP") fail("DecisionHistoryStorageUnsafe", "history storage cannot be a symbolic link");
      throw error;
    } finally { if (fd !== undefined) closeSync(fd); }
  }
}

/** Private application state. Supply a path in a private directory, or an open
 * DatabaseSync connection. A crash leaves a busy row: stop the old worker and
 * reconcile explicitly with recover(), never infer that a request did not run.
 */
export function createSqliteDecisionHistoryStore({ filename, database, maxSessions = 128,
  maxBytes = 33554432, ttlMs = 86400000 } = {}) {
  if ((!database && (typeof filename !== "string" || !filename)) || (database && filename)) {
    fail("InvalidDecisionProviderOptions", "supply a database connection or filename for history");
  }
  for (const value of [maxSessions, maxBytes, ttlMs]) {
    if (!Number.isSafeInteger(value) || value < 1) fail("InvalidDecisionProviderOptions", "history store limits must be positive integers");
  }
  if (!database) privateDatabaseFile(filename);
  const db = database ?? new DatabaseSync(filename);
  db.exec(`CREATE TABLE IF NOT EXISTS touba_decision_history (
    session_key TEXT PRIMARY KEY, record TEXT, size INTEGER NOT NULL DEFAULT 0,
    expires INTEGER NOT NULL, owner TEXT
  )`);
  const transaction = fn => {
    db.exec("BEGIN IMMEDIATE");
    try { const value = fn(); db.exec("COMMIT"); return value; }
    catch (error) { db.exec("ROLLBACK"); throw error; }
  };
  return {
    read(key) {
      const row = db.prepare("SELECT record, expires, owner FROM touba_decision_history WHERE session_key = ?").get(key);
      if (row?.owner) fail("DecisionHistoryBusy", "cannot read an active conversation");
      return row?.record && row.expires > Date.now() ? JSON.parse(row.record) : null;
    },
    async transact(key, operation) {
      const owner = randomUUID();
      const saved = transaction(() => {
        db.prepare("DELETE FROM touba_decision_history WHERE expires <= ? AND owner IS NULL").run(Date.now());
        const row = db.prepare("SELECT record, owner FROM touba_decision_history WHERE session_key = ?").get(key);
        if (row?.owner) fail("DecisionHistoryBusy", "conversation is active or requires explicit crash recovery");
        if (!row && db.prepare("SELECT COUNT(*) AS n FROM touba_decision_history").get().n >= maxSessions) {
          fail("DecisionHistoryLimitExceeded", "conversation store session limit reached");
        }
        db.prepare(`INSERT INTO touba_decision_history (session_key, expires, owner) VALUES (?, ?, ?)
          ON CONFLICT(session_key) DO UPDATE SET owner = excluded.owner`).run(key, Date.now() + ttlMs, owner);
        return row?.record ? JSON.parse(row.record) : null;
      });
      try {
        const { record, result } = await operation(saved);
        const json = JSON.stringify(record), size = Buffer.byteLength(json, "utf8");
        transaction(() => {
          const total = db.prepare("SELECT COALESCE(SUM(size), 0) AS n FROM touba_decision_history WHERE session_key <> ?").get(key).n;
          if (size + total > maxBytes) fail("DecisionHistoryLimitExceeded", "conversation store byte limit reached");
          const changed = db.prepare("UPDATE touba_decision_history SET record = ?, size = ?, expires = ?, owner = NULL WHERE session_key = ? AND owner = ?")
            .run(json, size, Date.now() + ttlMs, key, owner);
          if (changed.changes !== 1) fail("DecisionHistoryMismatch", "conversation reservation no longer belongs to this worker");
        });
        return result;
      } catch (error) {
        // The runtime has not received a decision from this failed transaction.
        db.prepare("UPDATE touba_decision_history SET owner = NULL WHERE session_key = ? AND owner = ?").run(key, owner);
        throw error;
      }
    },
    delete(key) {
      return transaction(() => {
        if (db.prepare("SELECT owner FROM touba_decision_history WHERE session_key = ?").get(key)?.owner) {
          fail("DecisionHistoryBusy", "cannot delete an active conversation");
        }
        return db.prepare("DELETE FROM touba_decision_history WHERE session_key = ?").run(key).changes === 1;
      });
    },
    recover(key, { workerStopped = false } = {}) {
      if (!workerStopped) fail("DecisionHistoryBusy", "explicit confirmation that the old worker is stopped is required");
      return db.prepare("UPDATE touba_decision_history SET owner = NULL WHERE session_key = ?").run(key).changes === 1;
    },
    close() { if (!database) db.close(); },
  };
}
