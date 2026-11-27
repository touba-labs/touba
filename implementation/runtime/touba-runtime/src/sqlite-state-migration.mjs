import { constants, closeSync, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Current record contracts are reused by explicit migrations. A migration never
// fabricates missing authority, checkpoints, approval evidence or revisions.
export function migrateRecordState(options, { schemaVersion, fields, recordsOf, validateRecord, keyOf, validateSet, storeOf }) {
  return migrateJsonState({ ...options,
    validate(document) {
      if (!document || typeof document !== "object" || Array.isArray(document)
          || document.schema_version !== schemaVersion
          || Object.keys(document).some(key => !["schema_version", "updated_at", ...fields].includes(key))) {
        throw Object.assign(new Error("incompatible state migration envelope"), { code: "StateMigrationInvalid" });
      }
      for (const field of fields) if (!Array.isArray(document[field])) throw Object.assign(new Error("state collection must be an array"), { code: "StateMigrationInvalid" });
      const records = recordsOf(document), keys = new Set();
      records.forEach((record, index) => {
        validateRecord(record, index);
        const key = keyOf(record);
        if (keys.has(key)) throw Object.assign(new Error("duplicate state identity"), { code: "StateMigrationInvalid" });
        keys.add(key);
      });
      validateSet?.(records);
      return records;
    },
    build(path, values) {
      const store = storeOf(path), records = store.read();
      records.push(...values); store.write(records); store.initialize();
    },
  });
}

// Explicit host maintenance only: bounded input, original retained, exact
// backup and publication of a fully validated new database without overwrite.
export function migrateJsonState({ source, destination, apply = false, maxSourceBytes = 16 * 1024 * 1024, validate, build }) {
  source = resolve(source); destination = resolve(destination);
  const fail = message => { throw Object.assign(new Error(message), { code: "StateMigrationInvalid" }); };
  if (source === destination || !destination.endsWith(".sqlite")) fail("migration requires a new .sqlite destination");
  if (!Number.isSafeInteger(maxSourceBytes) || maxSourceBytes < 1) fail("invalid source byte limit");
  const before = lstatSync(source);
  if (!before.isFile() || before.isSymbolicLink()) fail("source must be a regular file without symbolic links");
  const fd = openSync(source, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  let bytes;
  try {
    const stat = fstatSync(fd);
    if (stat.dev !== before.dev || stat.ino !== before.ino || stat.size > maxSourceBytes) fail("source changed or exceeds the migration limit");
    const buffer = Buffer.alloc(stat.size + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const count = readSync(fd, buffer, offset, buffer.length - offset, offset);
      if (!count) break;
      offset += count;
    }
    const after = fstatSync(fd);
    if (offset !== stat.size || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs) fail("source changed while reading; stop its writer before migration");
    bytes = buffer.subarray(0, offset);
  } finally { closeSync(fd); }
  let document;
  try { document = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { fail("source must contain valid UTF-8 JSON"); }
  const records = validate(document);
  const result = { source, destination, record_count: records.length,
    source_sha256: createHash("sha256").update(bytes).digest("hex"), applied: false };
  if (!apply) return result;
  try { lstatSync(destination); fail("migration destination already exists"); }
  catch (cause) { if (cause.code !== "ENOENT") throw cause; }
  mkdirSync(dirname(destination), { recursive: true, mode: 0o700 });
  const temporary = join(dirname(destination), `.state-migration-${randomUUID()}.sqlite`);
  const backup = `${destination}.source-backup.json`;
  try {
    build(temporary, records);
    writeFileSync(backup, bytes, { flag: "wx", mode: 0o600 });
    for (const path of [backup, temporary]) {
      const output = openSync(path, "r+");
      try { fsyncSync(output); } finally { closeSync(output); }
    }
    linkSync(temporary, destination);
    if (process.platform !== "win32") {
      const directory = openSync(dirname(destination), "r");
      try { fsyncSync(directory); } finally { closeSync(directory); }
    }
    return { ...result, applied: true, backup };
  } finally {
    try { unlinkSync(temporary); } catch (cause) { if (cause.code !== "ENOENT") throw cause; }
  }
}
