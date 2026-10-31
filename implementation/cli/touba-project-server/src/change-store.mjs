import { existsSync } from "node:fs";
import { indexedStore } from "../../../runtime/touba-runtime/src/sqlite-record-store.mjs";
import { migrateRecordState } from "../../../runtime/touba-runtime/src/sqlite-state-migration.mjs";

const SCHEMA = "touba-project-change-proposals-v1";
export const CHANGE_INDEXES = Object.freeze({ status: "json_extract(body, '$.status')" });

function validate(record) {
  if (!record || record.schema_version !== "touba-project-change-proposal-v1"
    || typeof record.proposal_id !== "string" || !record.proposal_id.trim()
    || !["proposed", "applied", "refused"].includes(record.status)
    || record.action !== "write_text_file" || typeof record.target?.path !== "string"
    || !record.target.path || typeof record.content !== "string"
    || !/^[a-f0-9]{64}$/.test(record.content_sha256)
    || typeof record.requested_by?.id !== "string" || typeof record.requested_by?.kind !== "string"
    || !Number.isFinite(Date.parse(record.proposed_at)) || !Array.isArray(record.validations)) {
    throw Object.assign(new Error("invalid stored change proposal"), { code: "ToubaServeChangeStoreInvalid" });
  }
}

function proposals(path) {
  // Never start an empty history beside a previous JSON store by accident.
  if (path.endsWith(".sqlite") && !existsSync(path) && existsSync(path.slice(0, -7) + ".json")) {
    throw Object.assign(new Error("change history requires explicit migration with touba state migrate changes"),
      { code: "ToubaStoreFormatIncompatible" });
  }
  return indexedStore({ path, schemaVersion: SCHEMA, keyOf: record => record.proposal_id,
    validate, indexes: CHANGE_INDEXES });
}

export function readChangeProposals(path, proposalId) {
  return { schema_version: SCHEMA, proposals: proposals(path).read([{ id: proposalId }]) };
}

export function saveChangeProposals(path, snapshot) {
  proposals(path).write(snapshot.proposals);
}

export function countChangeProposals(path) {
  const counts = proposals(path).countBy("status");
  return { total: counts.reduce((sum, row) => sum + row.count, 0),
    pending: counts.find(row => row.value === "proposed")?.count ?? 0,
    applied: counts.find(row => row.value === "applied")?.count ?? 0,
    refused: counts.find(row => row.value === "refused")?.count ?? 0 };
}

export function pageChangeProposals(path, { cursor = null, limit = 50, status = "all" } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || !["all", "pending", "applied", "refused"].includes(status)
    || (cursor !== null && (typeof cursor !== "string" || !/^[1-9][0-9]{0,15}$/.test(cursor)
      || !Number.isSafeInteger(Number(cursor))))) {
    throw Object.assign(new Error("change history requires a limit from 1 to 100, a valid cursor and status"),
      { code: "ToubaServeChangePageInvalid" });
  }
  const page = proposals(path).page({ order: "rowid", direction: "desc", limit,
    ...(status === "all" ? {} : { filter: [{ status: status === "pending" ? "proposed" : status }] }),
    ...(cursor === null ? {} : { after: Number(cursor) }) });
  return { proposals: page.items, summary: countChangeProposals(path),
    pagination: { limit, cursor, next_cursor: page.hasMore ? String(page.next) : null,
      order: "recorded_desc", status } };
}

export function migrateChangeProposals(options) {
  return migrateRecordState(options, { schemaVersion: SCHEMA, fields: ["proposals"],
    recordsOf: document => document.proposals, validateRecord: validate,
    keyOf: record => record.proposal_id, storeOf: proposals });
}

export function auditChangeProposals(path) {
  const store = proposals(path);
  let after, count = 0;
  for (;;) {
    const page = store.page({ order: "rowid", after, limit: 100 });
    count += page.items.length;
    if (!page.hasMore) break;
    after = page.next;
  }
  return { schema_version: SCHEMA, entry_count: count };
}
