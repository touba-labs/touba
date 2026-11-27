import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { ToubaEngine, ToubaEngineError } from "@touba/sdk";
const cli = process.argv[2];
const engine = new ToubaEngine({ projectRoot: ".", command: process.execPath, commandArgs: [cli],
  env: { REMEDIATION_TOKEN: "isolated-ledger-credential" } });
const options = { source: "incident-remediation.tb", entryRef: "strategy:examples.incident_remediation/RunIncidentRemediation",
  manifest: "touba.manifest.json", secrets: "test-secret-bindings.json", resourceBindings: "touba.resources.json", requireResourceBindings: true,
  agentDecisionProvider: "providers/incidents.mjs", maxAgentSteps: 4, effectJournal: "remediation.effect-journal.sqlite",
  inputs: { request: { service: "billing-worker", urgency: 5 } } };
const paused = await engine.run({ ...options, humanCheckpointOut: "approval.checkpoint.json" });
assert.equal(paused.reason, "human_approval_pending");
assert.equal(existsSync("remediation-ledger.ndjson"), false);
const checkpoint = JSON.parse(readFileSync("approval.checkpoint.json", "utf8"));
const approvalRef = checkpoint.approval_ref;
assert.equal(typeof approvalRef, "string");
const rejected = await engine.run({ ...options, humanDecisions: { [approvalRef]: "rejected" } });
assert.equal(rejected.reason, "human_approval_rejected");
assert.equal(existsSync("remediation-ledger.ndjson"), false);
const humanDecisions = { [approvalRef]: "approved" };
await assert.rejects(engine.run({ ...options, manifest: "denied.manifest.json", humanDecisions }), error => {
  assert.ok(error instanceof ToubaEngineError); assert.equal(error.details.reason, "ToolCapabilityNotGranted"); return true;
});
assert.equal(existsSync("remediation-ledger.ndjson"), false);
const original = readFileSync("incident-remediation.tb", "utf8");
const missingScope = original.replace("    memory RemediationLedger write\n", "");
assert.notEqual(missingScope, original); writeFileSync("missing-scope.tb", missingScope);
const invalid = spawnSync(process.execPath, [cli, "compile", "missing-scope.tb", "--out", "missing-scope.air.json"], { encoding: "utf8" });
assert.equal(invalid.status, 1); assert.match(invalid.stderr + invalid.stdout, /OwnerMemoryScopeMissing/);
const resume = { ...options, inputs: undefined, humanResumeCheckpoint: "approval.checkpoint.json", humanDecisions };
const completed = await engine.run(resume);
assert.equal(completed.status, "success");
assert.equal(completed.result.service, "billing-worker");
assert.equal(completed.result.action, "Review immediately with the on-call engineer");
await assert.rejects(engine.run(resume), error => {
  assert.ok(error instanceof ToubaEngineError);
  assert.equal(error.details.reason, "HumanApprovalCheckpointAlreadyConsumed");
  return true;
});
const lines = readFileSync("remediation-ledger.ndjson", "utf8").trim().split("\n").map(JSON.parse);
assert.equal(lines.length, 1); assert.deepEqual(lines[0], completed.result);
assert.ok(!JSON.stringify(completed).includes("isolated-ledger-credential"));
writeFileSync("paused.trace.json", JSON.stringify(paused.trace, null, 2));
writeFileSync("completed.trace.json", JSON.stringify(completed.trace, null, 2));
console.log(JSON.stringify(completed.result));
console.log("THREE_AGENTS_APPROVAL_SCOPES_AND_ONE_ACQUIRED_WRITE_OK");
