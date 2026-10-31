// Test-only access below the domain validator: corrupt actual stored records,
// not the container format, so refusal tests still exercise their invariant.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { indexedStore } from "../../../runtime/touba-runtime/src/sqlite-record-store.mjs";
import { HUMAN_DECISION_INDEXES, HUMAN_REQUEST_INDEXES } from "../src/human-stores.mjs";
import { CHANGE_INDEXES } from "../src/change-store.mjs";
import { CHECKPOINT_INDEXES } from "../src/serve.mjs";

function isIndexed(path) {
  return existsSync(path) && readFileSync(path).subarray(0, 16).equals(Buffer.from("SQLite format 3\0"));
}

export function readStoreFixture(path) {
  if (!isIndexed(path)) return JSON.parse(readFileSync(path, "utf8"));
  const db = new DatabaseSync(path);
  try {
    const { schema_version } = db.prepare("SELECT schema_version FROM metadata").get();
    const records = db.prepare("SELECT body FROM records ORDER BY rowid").all().map(row => JSON.parse(row.body));
    if (schema_version === "touba-human-decisions-v1") return { schema_version, decisions: records };
    if (schema_version === "touba-project-change-proposals-v1") return { schema_version, proposals: records };
    if (schema_version === "touba-interaction-sessions-v1") return { schema_version, sessions: records };
    if (schema_version === "touba-human-requests-v1") return { schema_version,
      approvals: records.filter(record => record.collection === "approvals").map(record => record.request),
      reviews: records.filter(record => record.collection === "reviews").map(record => record.request) };
    if (schema_version === "touba-effect-journal-v1") return { schema_version,
      entries: Object.fromEntries(records.map(record => [record.effect_id, record])) };
    return { schema_version, records };
  } finally { db.close(); }
}

export function writeStoreFixture(path, document) {
  const requests = document.schema_version === "touba-human-requests-v1";
  const decisions = document.schema_version === "touba-human-decisions-v1";
  const effects = document.schema_version === "touba-effect-journal-v1";
  const checkpoints = document.schema_version === "touba-sandbox-checkpoints-v1";
  const sessions = document.schema_version === "touba-interaction-sessions-v1";
  const changes = document.schema_version === "touba-project-change-proposals-v1";
  const records = requests ? [
    ...document.approvals.map(request => ({ collection: "approvals", request })),
    ...document.reviews.map(request => ({ collection: "reviews", request })),
  ] : decisions ? document.decisions : effects ? Object.values(document.entries) : sessions ? document.sessions : changes ? document.proposals : document.records;
  const keyOf = record => requests ? record.request.request_id : decisions ? record.request_id : sessions ? record.session_id
    : effects ? record.effect_id : changes ? record.proposal_id : JSON.stringify([record.record_kind, record.record_kind === "human" ? record.request_id : record.operation_id]);
  if (!existsSync(path) && (requests || decisions || effects || checkpoints || sessions || changes)) {
    const store = indexedStore({ path, schemaVersion: document.schema_version, keyOf, validate() {},
      indexes: requests ? HUMAN_REQUEST_INDEXES : decisions ? HUMAN_DECISION_INDEXES : checkpoints ? CHECKPOINT_INDEXES : changes ? CHANGE_INDEXES : sessions ? {}
        : { effect_scope_id: "json_extract(body, '$.effect_scope_id')" } });
    store.initialize();
  }
  if (!isIndexed(path)) {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    return;
  }
  const db = new DatabaseSync(path);
  try {
    db.exec("BEGIN IMMEDIATE; DELETE FROM records;");
    db.prepare("UPDATE metadata SET schema_version=?").run(document.schema_version);
    const insert = db.prepare("INSERT INTO records(id, revision, body) VALUES (?, 1, ?)");
    const keys = new Set();
    for (const [index, record] of records.entries()) {
      let id = keyOf(record);
      if (keys.has(id)) id = `duplicate-fixture:${index}:${id}`;
      keys.add(id);
      insert.run(id, JSON.stringify(record));
    }
    db.exec("COMMIT");
  } finally { db.close(); }
}
