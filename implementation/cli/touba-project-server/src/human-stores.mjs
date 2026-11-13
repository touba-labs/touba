import { indexedStore } from "../../../runtime/touba-runtime/src/sqlite-record-store.mjs";
import { migrateRecordState } from "../../../runtime/touba-runtime/src/sqlite-state-migration.mjs";
import { readFileSync } from "node:fs";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";
import { validatedRecordCodec } from "./validated-records.mjs";

const REQUEST_SCHEMA = "touba-human-requests-v1";
const DECISION_SCHEMA = "touba-human-decisions-v1";
const requestSnapshots = new WeakMap();
const schemas = new Map(["touba-approval-request-v1", "touba-human-review-request-v1",
  "touba-approval-decision-v1", "touba-human-review-decision-v1"].map(name => [name,
  JSON.parse(readFileSync(new URL(`../../../contracts/product-surfaces/schemas/${name}.schema.json`, import.meta.url), "utf8"))]));
const requestCodec = validatedRecordCodec(record => {
  const request = record?.request;
  const approval = record?.collection === "approvals";
  if (!request || Object.keys(record).some(key => !["collection", "request"].includes(key))
    || !["approvals", "reviews"].includes(record.collection)
    || request.mode !== (approval ? "approval" : "human_review")
    || request.schema_version !== (approval ? "touba-approval-request-v1" : "touba-human-review-request-v1")
    || validateObject(schemas.get(request.schema_version), request).length > 0) {
    throw invalid("human request projection has an invalid contract or collection");
  }
});
const decisionCodec = validatedRecordCodec(record => {
  if (!record || !["touba-approval-decision-v1", "touba-human-review-decision-v1"].includes(record.schema_version)) {
    throw invalid("human decision projection has an invalid identity");
  }
  const { accepted_at, ...decision } = record;
  if (typeof accepted_at !== "string" || !Number.isFinite(Date.parse(accepted_at))
    || validateObject(schemas.get(decision.schema_version), decision).length > 0) {
    throw invalid("human decision projection has an invalid contract or acceptance instant");
  }
});
export const HUMAN_REQUEST_INDEXES = Object.freeze({
  request_id: "json_extract(body, '$.request.request_id')",
  run_id: "json_extract(body, '$.request.run_id')",
  collection: "json_extract(body, '$.collection')",
});
export const HUMAN_DECISION_INDEXES = Object.freeze({
  request_id: "json_extract(body, '$.request_id')",
  run_id: "json_extract(body, '$.run_id')",
  schema_version: "json_extract(body, '$.schema_version')",
});

function requests(path) {
  return indexedStore({ path, schemaVersion: REQUEST_SCHEMA,
    keyOf: record => record.request.request_id,
    indexes: HUMAN_REQUEST_INDEXES,
    validate: requestCodec.validate, parseValidated: requestCodec.parse,
  });
}

export function migrateHumanRequests(options) {
  return migrateRecordState(options, { schemaVersion: REQUEST_SCHEMA, fields: ["approvals", "reviews"],
    recordsOf: document => [
      ...document.approvals.map(request => ({ collection: "approvals", request })),
      ...document.reviews.map(request => ({ collection: "reviews", request })),
    ], validateRecord: requestCodec.validate, keyOf: record => record.request.request_id, storeOf: requests,
  });
}

export function migrateHumanDecisions(options) {
  return migrateRecordState(options, { schemaVersion: DECISION_SCHEMA, fields: ["decisions"],
    recordsOf: document => document.decisions, validateRecord: decisionCodec.validate,
    keyOf: record => record.request_id, storeOf: decisions,
  });
}

function decisions(path) {
  return indexedStore({ path, schemaVersion: DECISION_SCHEMA,
    keyOf: record => record.request_id,
    indexes: HUMAN_DECISION_INDEXES,
    validate: decisionCodec.validate, parseValidated: decisionCodec.parse,
  });
}

export function readHumanRequestStore(path, filter) {
  const records = read(requests(path), filter);
  const result = { schema_version: REQUEST_SCHEMA,
    approvals: records.filter(record => record.collection === "approvals").map(record => record.request),
    reviews: records.filter(record => record.collection === "reviews").map(record => record.request) };
  requestSnapshots.set(result, records);
  return result;
}

export function saveHumanRequestStore(path, store) {
  const records = requestSnapshots.get(store);
  if (!records) throw invalid("request write requires a fresh store snapshot");
  records.splice(0, records.length,
    ...store.approvals.map(request => ({ collection: "approvals", request })),
    ...store.reviews.map(request => ({ collection: "reviews", request })));
  requests(path).write(records);
}

export function loadHumanDecisionStore(path, filter) {
  return { schema_version: DECISION_SCHEMA, decisions: read(decisions(path), filter) };
}

export function pageHumanDecisions(path, { cursor = null, limit = 50, requestId = null } = {}) {
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100
    || (cursor !== null && (typeof cursor !== "string" || !/^[1-9][0-9]{0,15}$/.test(cursor)
      || !Number.isSafeInteger(Number(cursor))))) {
    throw Object.assign(new Error("decision history requires a limit from 1 to 100 and a valid cursor"),
      { code: "ToubaServeDecisionPageInvalid" });
  }
  const store = decisions(path);
  const filter = requestId === null ? undefined : [{request_id: requestId}];
  const page = store.page({ filter, order: "rowid", direction: "desc", limit,
    ...(cursor === null ? {} : { after: Number(cursor) }) });
  const counts = requestId === null ? store.countBy("schema_version")
    : ['touba-approval-decision-v1','touba-human-review-decision-v1'].map(value => ({value, count: store.count([{request_id: requestId, schema_version: value}])}));
  return {
    decisions: page.items,
    summary: {
      total: counts.reduce((total, row) => total + row.count, 0),
      approvals: counts.find(row => row.value === "touba-approval-decision-v1")?.count ?? 0,
      reviews: counts.find(row => row.value === "touba-human-review-decision-v1")?.count ?? 0,
    },
    pagination: { limit, cursor, next_cursor: page.hasMore ? String(page.next) : null, order: "recorded_desc" },
  };
}

export function auditHumanStore(path, kind) {
  if (!["requests", "decisions"].includes(kind)) throw invalid("unknown human store kind");
  const store = kind === "requests" ? requests(path) : decisions(path);
  let after, count = 0;
  try {
    for (;;) {
      const page = store.page({ after, limit: 100 });
      count += page.items.length;
      if (page.next === null) break;
      after = page.next;
    }
  } catch (cause) {
    if (cause.code === "ToubaStoreRecordInvalid") throw invalid("human projection has a duplicate or divergent stored identity");
    throw cause;
  }
  return { schema_version: kind === "requests" ? REQUEST_SCHEMA : DECISION_SCHEMA, entry_count: count };
}

export function saveHumanDecisionStore(path, store) {
  decisions(path).write(store.decisions);
}

function read(store, filter) {
  try { return store.read(filter); }
  catch (cause) {
    if (cause.code === "ToubaStoreRecordInvalid") throw invalid("human projection has a duplicate or divergent stored identity");
    throw cause;
  }
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
}
