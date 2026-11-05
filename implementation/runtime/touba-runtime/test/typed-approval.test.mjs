import test, { before } from "node:test";
import assert from "node:assert/strict";
import { compileTestAir } from "../../../tests/helpers/compile.mjs";
import { executeAirDocument } from "../src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";
import { pendingParallelApprovals } from "../src/parallel-execution.mjs";
let air;
before(() => { air = compileTestAir(new URL("../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/typed-approval.tb", import.meta.url).pathname); });

test("rejected and expired continuations cannot execute the approved effect", async () => {
  for (const decision of ["approved", "rejected", "expired"]) {
    let commits = 0;
    const notices = [];
    const options = { entryRef: "strategy:approval_result/Decide", inputs: { dossier: "invoice" }, durableHumanApprovals: true,
      toolHandlers: { "tool:approval_result/Commit": () => { commits++; return "committed"; },
        "tool:approval_result/Notify": request => { notices.push(request.arguments.receipt); return "notified"; } } };
    const paused = await executeAirDocument(air, options);
    assert.equal(paused.status, "stopped", JSON.stringify(paused));
    const resumed = await executeAirDocument(air, { ...options, inputs: undefined, humanApprovalResumeCheckpoint: structuredClone(paused.checkpoint),
      humanApprovalDecisions: { [paused.checkpoint.approval_ref]: decision } });
    assert.equal(resumed.status, "success", JSON.stringify(resumed));
    assert.equal(resumed.result, decision);
    assert.equal(commits, decision === "approved" ? 1 : 0);
    assert.equal(notices.length, decision === "rejected" ? 1 : 0);
    if (notices.length) assert.deepEqual(notices[0].subject_ref, { present: false });
  }
});
test("typed receipt contains only verified subject and roles and survives a durable pause", async () => {
  const options = { entryRef: "strategy:approval_result/Receipt", inputs: { dossier: "invoice" }, durableHumanApprovals: true };
  const paused = await executeAirDocument(air, options);
  const result = await executeAirDocument(air, { ...options, inputs: undefined, humanApprovalResumeCheckpoint: paused.checkpoint,
    humanApprovalDecisions: { [paused.checkpoint.approval_ref]: { decision: "approved", evidence_ref: "proof" } },
    humanApprovalAuthority: ({ request, decision }) => ({ request_id: request.request_id, run_id: request.run_id, decision,
      subject_ref: "employee:42", roles: ["finance", "finance"] }) });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result.decision, "approved");
  assert.deepEqual(result.result.subject_ref, { present: true, value: "employee:42" });
  assert.deepEqual(result.result.attested_roles, ["finance"]);
  assert.equal(result.result.run_id, paused.checkpoint.run_id);
  assert.ok(Number.isFinite(Date.parse(result.result.accepted_at)));
});
test("direct AIR cannot connect a rejection branch to the protected path", () => {
  const copy = structuredClone(air);
  const graph = copy.execution_graphs.find(graph => graph.owner_ref === "strategy:approval_result/Decide");
  const rejected = graph.edges.find(edge => edge.role === "rejected");
  rejected.to_node_id = graph.nodes.find(node => node.target_ref === "tool:approval_result/Commit").id;
  assert.throws(() => validateAirMachineContract(copy), { code: "InvalidHumanApprovalOutcome" });
});

test("approval comments are optional bounded data, separate from attested roles", async () => {
  const options = { entryRef: "strategy:approval_result/Receipt", inputs: { dossier: "invoice" }, durableHumanApprovals: true };
  for (const comment of [undefined, null, "", "Please correct the invoice.\nrole=owner", 42, "a".repeat(4097)]) {
    const paused = await executeAirDocument(air, options);
    const result = await executeAirDocument(air, { ...options, inputs: undefined, humanApprovalResumeCheckpoint: structuredClone(paused.checkpoint),
      humanApprovalDecisions: { [paused.checkpoint.approval_ref]: { decision: "approved", evidence_ref: "proof", comment } },
      humanApprovalAuthority: ({ request, decision }) => ({ request_id: request.request_id, run_id: request.run_id, decision,
        subject_ref: "employee:42", roles: ["finance"] }) });
    if (typeof comment === "number" || comment?.length > 4096) {
      assert.equal(result.reason, "InvalidHumanApprovalDecision", JSON.stringify(result));
    } else {
      assert.equal(result.status, "success", JSON.stringify(result));
      assert.deepEqual(result.result.comment, comment == null ? { present: false } : { present: true, value: comment });
      assert.deepEqual(result.result.attested_roles, ["finance"]);
      if (comment) assert.equal(JSON.stringify(result.trace).includes("Please correct"), false);
    }
  }
});

test("parallel approval outcomes keep their own branch and typed receipt", async () => {
  let commits = 0;
  const notices = [];
  const options = { entryRef: "strategy:approval_result/Parallel", durableHumanApprovals: true,
    toolHandlers: { "tool:approval_result/Commit": () => { commits++; return "committed"; },
      "tool:approval_result/Notify": request => { notices.push(request.arguments.receipt); return "notified"; } } };
  const paused = await executeAirDocument(air, { ...options, inputs: { dossiers: ["no", "yes"] } });
  assert.equal(paused.status, "stopped", JSON.stringify(paused));
  const pending = pendingParallelApprovals(paused.checkpoint.parallel_state);
  assert.equal(pending.length, 2);
  const decisions = Object.fromEntries(pending.map(entry => [entry.approval_ref, entry.metadata.context_values[0] === "no" ? "rejected" : "approved"]));
  const result = await executeAirDocument(air, { ...options, parallelResumeCheckpoint: structuredClone(paused.checkpoint), humanApprovalDecisions: decisions });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(result.result, ["rejected", "approved"]);
  assert.equal(commits, 1);
  assert.equal(notices.length, 1);
  assert.equal(notices[0].decision, "rejected");
});

test("approval comment survives a second durable checkpoint without repeating the decision", async () => {
  const options = { entryRef: "strategy:approval_result/SuccessiveReceipts", durableHumanApprovals: true };
  const first = await executeAirDocument(air, { ...options, inputs: { dossier: "invoice" } });
  assert.equal(first.status, "stopped");
  const second = await executeAirDocument(air, { ...options,
    humanApprovalResumeCheckpoint: JSON.parse(JSON.stringify(first.checkpoint)),
    humanApprovalDecisions: { [first.checkpoint.approval_ref]: { decision: "approved", comment: "Invoice checked." } } });
  assert.equal(second.status, "stopped", JSON.stringify(second));
  assert.notEqual(second.checkpoint.approval_ref, first.checkpoint.approval_ref);
  const result = await executeAirDocument(air, { ...options,
    humanApprovalResumeCheckpoint: JSON.parse(JSON.stringify(second.checkpoint)),
    humanApprovalDecisions: { [second.checkpoint.approval_ref]: "approved" } });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(result.result.comment, { present: true, value: "Invoice checked." });
  assert.equal(result.result.run_id, first.checkpoint.run_id);
  assert.equal(result.result.request_id, first.checkpoint.approval_state.requests[first.checkpoint.approval_ref].request_id);
  assert.equal(JSON.stringify(result.trace).includes("Invoice checked."), false);
});

test("source cross-run exclusions require a bound host attestation and reject previous invoice signers", async () => {
  const document = structuredClone(air);
  document.execution_graphs.find(graph => graph.owner_ref === "strategy:approval_result/Receipt").nodes
    .find(node => node.kind === "human_approval").approval_policy.exclude_signers = "invoice_approvers";
  const options = { entryRef: "strategy:approval_result/Receipt", durableHumanApprovals: true };
  const paused = await executeAirDocument(document, { ...options, inputs: { dossier: "batch" } });
  const decisions = { [paused.checkpoint.approval_ref]: { decision: "approved", evidence_ref: "proof" } };
  for (const [excluded, expected] of [[undefined, "HumanApprovalExclusionEvidenceRequired"],
    [{ rule: "wrong", subject_refs: [] }, "HumanApprovalExclusionEvidenceRequired"],
    [{ rule: "invoice_approvers", subject_refs: ["employee:42"] }, "HumanApprovalSignerConflict"],
    [{ rule: "invoice_approvers", subject_refs: ["employee:17"] }, "success"]]) {
    const result = await executeAirDocument(document, { ...options, humanApprovalResumeCheckpoint: structuredClone(paused.checkpoint),
      humanApprovalDecisions: decisions, humanApprovalAuthority: ({ request, decision }) => ({ request_id: request.request_id,
        run_id: request.run_id, decision, subject_ref: "employee:42", roles: ["finance"], ...(excluded ? { excluded_signers: excluded } : {}) }) });
    assert.equal(expected === "success" ? result.status : result.reason, expected, JSON.stringify(result));
    if (expected !== "success") {
      const failure = result.trace.events.find(event => event.kind === "failure_detected");
      assert.equal(failure.payload.failure_family, "authority");
    }
    assert.equal(JSON.stringify(result.trace).includes("employee:"), false);
  }
});
