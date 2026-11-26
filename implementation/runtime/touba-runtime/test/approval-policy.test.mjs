import test, { before } from "node:test";
import assert from "node:assert/strict";
import { compileTestAir } from "../../../tests/helpers/compile.mjs";
import { executeAirDocument } from "../src/index.mjs";
import { validateApprovalState } from "../src/human-approval-policy.mjs";
import { fileURLToPath } from "node:url";


let air;
before(() => {
  air = compileTestAir(fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/approval-policy.tb", import.meta.url)));
});
const copy = value => JSON.parse(JSON.stringify(value));
const base = { entryRef: "strategy:approval_policy/ApproveTwice", durableHumanApprovals: true, humanApprovalInitiator: "employee:initiator" };
const attest = (subject = "employee:one", roles = ["finance"]) => ({ request, decision, evidenceRef }) => {
  assert.equal(evidenceRef, "receipt-from-host");
  return { request_id: request.request_id, run_id: request.run_id, decision, subject_ref: subject, roles };
};
const resume = (checkpoint, options = {}) => executeAirDocument(air, { ...base,
  humanApprovalResumeCheckpoint: copy(checkpoint),
  humanApprovalDecisions: { [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "receipt-from-host" } }, ...options });

test("trusted initiator resolution is isolated per run and persisted across resume", async () => {
  const observed = [];
  const resolver = async ({ run_id, entry_ref }) => {
    observed.push(run_id);
    assert.equal(entry_ref, base.entryRef);
    return `employee:${run_id}`;
  };
  const results = await Promise.all(["one", "two"].map(runId => executeAirDocument(air, {
    ...base, runId, inputs: { dossier: "invoice" }, humanApprovalInitiator: resolver,
  })));
  assert.deepEqual(results.map(result => result.checkpoint.approval_state.initiator), ["employee:one", "employee:two"]);
  const denied = await resume(results[0].checkpoint, { humanApprovalInitiator: resolver, humanApprovalAuthority: attest("employee:one") });
  assert.equal(denied.reason, "HumanApprovalSignerConflict");
  assert.deepEqual(observed.sort(), ["one", "two"]);
  const unavailable = await executeAirDocument(air, { ...base, inputs: { dossier: "invoice" }, humanApprovalInitiator: () => { throw new Error("private host detail"); } });
  assert.equal(unavailable.reason, "HumanApprovalAuthorityUnavailable");
  assert.equal(JSON.stringify(unavailable).includes("private host detail"), false);
});

test("parallel occurrences share signer separation, with partial durable decisions and no second verification of accepted evidence", async () => {
  const entryRef = "strategy:approval_policy/ReviewBatch";
  const first = await executeAirDocument(air, { ...base, entryRef, inputs: { dossiers: ["one", "two"] } });
  assert.equal(first.reason, "human_approval_pending", JSON.stringify(first));
  assert.equal(first.checkpoint.pending_approvals.length, 2);
  const second = await resume(first.checkpoint, { entryRef, humanApprovalAuthority: attest() });
  assert.equal(second.reason, "human_approval_pending", JSON.stringify(second));
  assert.equal(second.checkpoint.pending_approvals.length, 1);
  assert.equal(second.checkpoint.approval_state.receipts.length, 1);
  const refused = await resume(second.checkpoint, { entryRef, humanApprovalAuthority: attest() });
  assert.equal(refused.reason, "HumanApprovalSignerConflict", JSON.stringify(refused));
  let verifications = 0;
  const done = await resume(second.checkpoint, { entryRef, humanApprovalAuthority: args => { verifications++; return attest("employee:two")(args); } });
  assert.equal(done.status, "success", JSON.stringify(done));
  assert.deepEqual(done.result, ["one", "two"]);
  assert.equal(verifications, 1);
});

test("source roles and signer separation survive two real pauses and guard the effect", async () => {
  let calls = 0;
  const handlers = { "tool:approval_policy/Commit": () => { calls++; return "invoice"; } };
  const first = await executeAirDocument(air, { ...base, inputs: { dossier: "invoice" }, toolHandlers: handlers });
  assert.equal(first.status, "stopped", JSON.stringify(first));
  validateApprovalState(first.checkpoint.approval_state);
  const second = await resume(first.checkpoint, { humanApprovalAuthority: attest(), toolHandlers: handlers });
  assert.equal(second.status, "stopped", JSON.stringify(second));
  assert.notEqual(second.checkpoint.approval_ref, first.checkpoint.approval_ref);
  assert.equal(second.checkpoint.approval_state.receipts[0].subject_ref, "employee:one");
  for (const roles of [undefined, [], ["finance", "finance"]]) {
    const damaged = copy(second.checkpoint.approval_state);
    damaged.requests[first.checkpoint.approval_ref] = copy(first.checkpoint.approval_state.requests[first.checkpoint.approval_ref]);
    damaged.receipts[0].attested_roles = roles;
    assert.throws(() => validateApprovalState(damaged), { code: "InvalidHumanApprovalCheckpoint" });
  }
  assert.equal(calls, 0);
  for (const [authority, expected] of [[attest(), "HumanApprovalSignerConflict"], [attest("employee:initiator"), "HumanApprovalSignerConflict"], [attest("employee:two", []), "HumanApprovalRoleRequired"], [undefined, "HumanApprovalAuthorityRequired"]]) {
    const denied = await resume(second.checkpoint, { humanApprovalAuthority: authority, toolHandlers: handlers });
    assert.equal(denied.reason, expected, JSON.stringify(denied));
    assert.equal(calls, 0);
  }
  const accepted = await resume(second.checkpoint, { humanApprovalAuthority: attest("employee:two"), toolHandlers: handlers });
  assert.equal(accepted.status, "success", JSON.stringify(accepted));
  assert.equal(calls, 1);
  assert.ok(!JSON.stringify(accepted.trace).includes("employee:"));
});

test("client identity claims, unrelated evidence, altered state and changed initiators fail closed", async () => {
  const first = await executeAirDocument(air, { ...base, inputs: { dossier: "invoice" } });
  const checkpoint = first.checkpoint;
  const fake = await resume(checkpoint, { humanApprovalDecisions: { [checkpoint.approval_ref]: { decision: "approved", roles: ["finance"], subject_ref: "employee:one" } } });
  assert.equal(fake.reason, "HumanApprovalAuthorityRequired");
  const wrongRequest = await resume(checkpoint, { humanApprovalAuthority: args => ({ ...attest()(args), request_id: "other-request" }) });
  assert.equal(wrongRequest.reason, "HumanApprovalAttestationInvalid");
  await assert.rejects(resume(checkpoint, { humanApprovalInitiator: "employee:other" }), { code: "HumanApprovalIdentityMismatch" });
  const damaged = copy(checkpoint);
  delete damaged.approval_state;
  await assert.rejects(resume(damaged), { code: "HumanApprovalCheckpointIncompatible" });
  const corrupt = copy(checkpoint);
  corrupt.approval_state.requests[checkpoint.approval_ref].deadline_at = new Date(Date.now() + 120000).toISOString();
  await assert.rejects(resume(corrupt), { code: "InvalidHumanApprovalCheckpoint" });
});

test("a real deadline persists across pause and escalation requests a different role, never approval", async () => {
  const options = { ...base, entryRef: "strategy:approval_policy/Escalate" };
  const paused = await executeAirDocument(air, { ...options, inputs: { dossier: "invoice" } });
  assert.ok(paused.checkpoint, JSON.stringify(paused));
  await new Promise(resolve => setTimeout(resolve, 30));
  const escalated = await resume(paused.checkpoint, { ...options, humanApprovalDecisions: {} });
  assert.equal(escalated.status, "stopped", JSON.stringify(escalated));
  assert.ok(escalated.trace.events.some(event => event.kind === "human_approval_expired"));
  const request = escalated.checkpoint.approval_state.requests[escalated.checkpoint.approval_ref];
  assert.equal(request.policy.role, "finance_manager");
  assert.notEqual(request.request_id, paused.checkpoint.approval_state.requests[paused.checkpoint.approval_ref].request_id);
  const denied = await resume(escalated.checkpoint, { ...options, humanApprovalAuthority: attest() });
  assert.equal(denied.reason, "HumanApprovalRoleRequired");
  const approved = await resume(escalated.checkpoint, { ...options, humanApprovalAuthority: attest("employee:manager", ["finance_manager"]) });
  assert.equal(approved.result, "escalation approved", JSON.stringify(approved));
});

test("authority outage and timeout cannot release the protected continuation", async () => {
  let calls = 0;
  const toolHandlers = { "tool:approval_policy/Commit": () => { calls++; return "invoice"; } };
  const first = await executeAirDocument(air, { ...base, inputs: { dossier: "invoice" }, toolHandlers });
  for (const authority of [() => { throw new Error("private identity service detail"); }, () => new Promise(() => {})]) {
    const denied = await resume(first.checkpoint, { humanApprovalAuthority: authority,
      humanApprovalAuthorityTimeoutMs: 10, toolHandlers });
    assert.equal(denied.reason, "HumanApprovalAuthorityUnavailable");
    assert.ok(!JSON.stringify(denied).includes("private identity service detail"));
  }
  assert.equal(calls, 0);
});

test("direct AIR rejects malformed or misplaced approval constraints before an authority callback", async () => {
  for (const policy of [{ role: "" }, { timeout_ms: 0 }, { timeout_ms: 2592000001 }, { distinct_from: "anyone" },
    { role: "finance", bypass: true }, null]) {
    const document = copy(air);
    const node = document.execution_graphs.flatMap(graph => graph.nodes).find(node => node.approval_policy);
    node.approval_policy = policy;
    await assert.rejects(executeAirDocument(document, { ...base, inputs: { dossier: "invoice" } }));
  }
});
