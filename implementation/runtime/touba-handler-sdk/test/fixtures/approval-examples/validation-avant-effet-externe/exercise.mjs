import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { ToubaEngine, ToubaEngineError } from "@touba/sdk";
const engine = new ToubaEngine({ projectRoot: ".", command: process.execPath, commandArgs: [process.argv[2]],
  env: { LEDGER_TOKEN: "isolated-ledger-token" } });
const options = { source: "payment.tb", entryRef: "strategy:examples.scenario_external_approval/RunRegulatedPayment",
  manifest: "touba.manifest.json", secrets: "test-secret-bindings.json", effectJournal: "payment.effect-journal.sqlite",
  inputs: { request: { reference: "DEMO-42", amount_cents: 12500, destination: "isolated-demo-ledger" } } };
const paused = await engine.run({ ...options, humanCheckpointOut: "payment.checkpoint.json" });
assert.equal(paused.reason, "human_approval_pending");
assert.equal(existsSync("payment-ledger.ndjson"), false);
const checkpoint = JSON.parse(readFileSync("payment.checkpoint.json", "utf8"));
const approvalRef = checkpoint.approval_ref;
const rejected = await engine.run({ ...options, humanDecisions: { [approvalRef]: "rejected" } });
assert.equal(rejected.reason, "human_approval_rejected");
assert.equal(existsSync("payment-ledger.ndjson"), false);
const approved = { [approvalRef]: "approved" };
await assert.rejects(engine.run({ ...options, manifest: "denied.manifest.json", humanDecisions: approved }), error => {
  assert.ok(error instanceof ToubaEngineError);
  assert.equal(error.details.reason, "ToolCapabilityNotGranted");
  return true;
});
assert.equal(existsSync("payment-ledger.ndjson"), false);
const resume = { ...options, inputs: undefined, humanResumeCheckpoint: "payment.checkpoint.json", humanDecisions: approved };
const completed = await engine.run(resume);
assert.equal(completed.status, "success");
assert.equal(completed.reason, "completed");
await assert.rejects(engine.run(resume), error => {
  assert.ok(error instanceof ToubaEngineError);
  assert.equal(error.details.reason, "HumanApprovalCheckpointAlreadyConsumed");
  return true;
});
const lines = readFileSync("payment-ledger.ndjson", "utf8").trim().split("\n").map(JSON.parse);
assert.equal(lines.length, 1);
assert.equal(lines[0].receipt, completed.result.receipt);
assert.equal(lines[0].amount_cents, 12500);
assert.ok(!JSON.stringify(completed.trace).includes("isolated-ledger-token"));
console.log(JSON.stringify(completed.result));
console.log("APPROVAL_GRANTS_AND_SINGLE_ACQUIRED_WRITE_OK");
