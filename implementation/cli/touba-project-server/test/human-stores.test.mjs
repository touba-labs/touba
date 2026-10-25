import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import test from "node:test";
import { auditHumanStore, loadHumanDecisionStore, saveHumanDecisionStore } from "../src/human-stores.mjs";

test("paged human audit validates all pages and rejects late corruption without rewriting", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-human-audit-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "decisions.sqlite");
  const fixture = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/fixtures/valid/touba-approval-decision-v1.json", import.meta.url)));
  const state = loadHumanDecisionStore(path);
  for (let i = 0; i < 305; i++) state.decisions.push({ ...fixture, request_id: `approval-${String(i).padStart(4, "0")}`, accepted_at: "2026-06-22T14:07:01.000Z" });
  saveHumanDecisionStore(path, state);
  assert.deepEqual(auditHumanStore(path, "decisions"), { schema_version: "touba-human-decisions-v1", entry_count: 305 });
  const db = new DatabaseSync(path);
  try { db.prepare("UPDATE records SET body=json_set(body, '$.request_id', 'forged') WHERE id=?").run("approval-0304"); }
  finally { db.close(); }
  const before = readFileSync(path);
  assert.throws(() => auditHumanStore(path, "decisions"), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
  assert.deepEqual(readFileSync(path), before);
  assert.throws(() => auditHumanStore(path, "unknown"), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
});
