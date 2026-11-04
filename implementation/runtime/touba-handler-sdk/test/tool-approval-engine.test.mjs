import test, { before } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { ToubaEngine } from "../src/index.mjs";

let air;
before(() => { air = JSON.parse(execFileSync("cargo", ["run", "--quiet", "--manifest-path",
  new URL("../../../Cargo.toml", import.meta.url).pathname, "-p", "touba-cli", "--bin", "touba-compile", "--",
  new URL("../../touba-runtime/test/fixtures/approved-invoice.tb", import.meta.url).pathname], { encoding: "utf8" })); });

for (const executionMode of ["process", "persistent"]) test(`tool-bound approval through real CLI/SDK ${executionMode}`, async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-operation-sdk-"));
  const database = join(root, "business.sqlite"), db = new DatabaseSync(database);
  const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath,
    commandArgs: [new URL("../../../cli/touba-project/src/main.mjs", import.meta.url).pathname] });
  t.after(async () => { await engine.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  db.exec("CREATE TABLE orders(invoice_id TEXT PRIMARY KEY, amount INTEGER, vendor TEXT); INSERT INTO orders VALUES ('INV-001', 7, 'vendor:trusted'); CREATE TABLE payments(invoice_id TEXT PRIMARY KEY, amount INTEGER, call_id TEXT, provenance TEXT)");
  writeFileSync(join(root, "manifest.json"), JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:operation_approval/Pay": { handler: { kind: "process", command: process.execPath,
      args: [new URL("../../touba-runtime/test/fixtures/approved-payment.handler.mjs", import.meta.url).pathname, database] },
      grants: [], secrets: [], timeout_ms: 10000, max_payload_bytes: 32768,
      effect_contract: { kind: "external_write", retry_mode: "idempotency_key" } },
  } }));
  writeFileSync(join(root, "authority.mjs"), `export const initiatorRef = "employee:initiator";
export function attestHumanApproval({ request, decision, evidenceRef }) {
  if (evidenceRef !== "test-only-host-proof") throw new Error("Unknown evidence");
  return { request_id: request.request_id, run_id: request.run_id, decision, subject_ref: "employee:reviewer", roles: ["finance"] };
}`);
  const options = { airJson: air, entryRef: "strategy:operation_approval/Direct", manifest: "manifest.json",
    humanApprovalHost: "authority.mjs", humanCheckpointOut: "pending.json", effectJournal: "run.effect-journal.sqlite" };
  const first = await engine.run({ ...options, inputs: { payment: { invoice_id: "INV-001", vendor: "vendor:trusted", amount: 7 } } });
  assert.equal(first.reason, "human_approval_pending");
  assert.equal(db.prepare("SELECT count(*) AS n FROM payments").get().n, 0);
  const checkpoint = JSON.parse(readFileSync(join(root, "pending.json")));
  const resume = { ...options, humanResumeCheckpoint: "pending.json", humanDecisions: {
    [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "test-only-host-proof" },
  } };
  const done = await engine.run(resume);
  assert.equal(done.status, "success");
  assert.equal(db.prepare("SELECT count(*) AS n FROM payments").get().n, 1);
  await assert.rejects(engine.run(resume), error => error.details.reason === "HumanApprovalCheckpointAlreadyConsumed");
  assert.equal(db.prepare("SELECT count(*) AS n FROM payments").get().n, 1);
});
