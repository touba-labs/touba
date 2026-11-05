import test, { before } from "node:test";
import assert from "node:assert/strict";
import { compileTestAir as compile } from "../../../tests/helpers/compile.mjs";
import { executeAirDocument, loadToolBindingManifestFromJson } from "../src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";
import { executeReferenceAir } from "../../../contracts/reference-runtime/runtime.mjs";
import { createSqliteEffectJournal } from "../src/sqlite-effect-journal.mjs";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectExplorer } from "../../../cli/touba-inspect/src/explorer/model.mjs";
import { renderHoverDeclaration } from "../../../lsp/touba-lsp/src/server.mjs";

let air, invoiceAir;
before(() => { air = compile(new URL("../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/tool-approval.tb", import.meta.url).pathname); });
before(() => { invoiceAir = compile(new URL("./fixtures/approved-invoice.tb", import.meta.url).pathname); });
const toolRef = "tool:operation_approval/Pay";
const approvalRef = `approval:${toolRef}`;
const authority = (subject = "employee:reviewer", roles = ["finance"]) => ({ request, decision }) => ({
  request_id: request.request_id, run_id: request.run_id, decision, subject_ref: subject, roles,
});
const approve = checkpoint => ({ [checkpoint.approval_ref]: { decision: "approved", evidence_ref: "host-proof" } });

for (const entry of [toolRef, "strategy:operation_approval/Direct", "strategy:operation_approval/Nested", "strategy:operation_approval/AgentPath"]) {
  test(`one approved invocation consumes one tool budget unit: ${entry}`, async () => {
    let calls = 0;
    const options = { entryRef: entry, durableHumanApprovals: true, runLimits: { max_tool_calls: 1 },
      humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
      toolHandlers: { [toolRef]: ({ arguments: args }) => { calls++; return args.amount; } },
      agentDecisions: { "agent:operation_approval/Clerk": { action: "select_capability", target_ref: toolRef, arguments: { amount: 7 } } } };
    const pending = await executeAirDocument(air, { ...options, inputs: { amount: 7 } });
    assert.equal(pending.reason, "human_approval_pending");
    assert.equal(calls, 0);
    const resumed = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: pending.checkpoint,
      humanApprovalDecisions: approve(pending.checkpoint) });
    assert.equal(resumed.status, "success", JSON.stringify(resumed));
    assert.equal(resumed.result, 7);
    assert.equal(calls, 1);
    const replay = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: pending.checkpoint,
      humanApprovalDecisions: approve(pending.checkpoint) });
    assert.equal(replay.status, "failure");
    assert.equal(calls, 1);
  });
}

test("a second protected invocation cannot reuse the first invocation's budget", async () => {
  let calls = 0;
  const options = { entryRef: "strategy:operation_approval/Twice", durableHumanApprovals: true,
    runLimits: { max_tool_calls: 1 }, humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
    toolHandlers: { [toolRef]: () => { calls++; return 7; } } };
  const pending = await executeAirDocument(air, { ...options, inputs: { amount: 7 } });
  const resumed = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: pending.checkpoint,
    humanApprovalDecisions: approve(pending.checkpoint) });
  assert.equal(resumed.reason, "ToolCallBudgetExceeded");
  assert.equal(calls, 1);
});

test("an immediate decision consumes one unit and a cancelled resume dispatches nothing", async () => {
  let calls = 0;
  const options = { entryRef: "strategy:operation_approval/Direct", durableHumanApprovals: true,
    runLimits: { max_tool_calls: 1 }, humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
    toolHandlers: { [toolRef]: () => { calls++; return 7; } } };
  const immediate = await executeAirDocument(air, { ...options, inputs: { amount: 7 },
    humanApprovalDecisions: { [approvalRef]: { decision: "approved", evidence_ref: "host-proof" } } });
  assert.equal(immediate.status, "success", JSON.stringify(immediate));
  assert.equal(calls, 1);
  const pending = await executeAirDocument(air, { ...options, inputs: { amount: 7 } });
  const cancelled = await executeAirDocument(air, { ...options, cancelRequested: true,
    humanApprovalResumeCheckpoint: pending.checkpoint, humanApprovalDecisions: approve(pending.checkpoint) });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(calls, 1);
});

test("a tighter host budget on resume still rejects a previously reserved call", async () => {
  let calls = 0;
  const options = { entryRef: "strategy:operation_approval/Twice", durableHumanApprovals: true,
    runLimits: { max_tool_calls: 2 }, humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
    toolHandlers: { [toolRef]: () => { calls++; return 7; } } };
  const first = await executeAirDocument(air, { ...options, inputs: { amount: 7 } });
  const second = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: first.checkpoint,
    humanApprovalDecisions: approve(first.checkpoint) });
  assert.equal(second.reason, "human_approval_pending");
  assert.equal(calls, 1);
  const refused = await executeAirDocument(air, { ...options, runLimits: { max_tool_calls: 1 },
    humanApprovalResumeCheckpoint: second.checkpoint, humanApprovalDecisions: approve(second.checkpoint) });
  assert.equal(refused.reason, "ToolCallBudgetExceeded");
  assert.equal(calls, 1);
});

test("parallel approved calls respect the exact shared tool budget", async () => {
  for (const max_tool_calls of [1, 2]) {
    const calls = [];
    const options = { entryRef: "strategy:operation_approval/Batch", durableHumanApprovals: true,
      runLimits: { max_tool_calls }, humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
      toolHandlers: { [toolRef]: ({ arguments: args }) => { calls.push(args.amount); return args.amount; } } };
    const pending = await executeAirDocument(air, { ...options, inputs: { amounts: [7, 9] } });
    assert.equal(pending.reason, "human_approval_pending", JSON.stringify(pending));
    const decisions = Object.fromEntries(pending.checkpoint.pending_approvals.map(item => [item.approval_ref,
      { decision: "approved", evidence_ref: "host-proof" }]));
    const done = await executeAirDocument(air, { ...options, parallelResumeCheckpoint: pending.checkpoint, humanApprovalDecisions: decisions });
    if (max_tool_calls === 2) { assert.equal(done.status, "success", JSON.stringify(done)); assert.deepEqual(calls.sort(), [7, 9]); }
    else { assert.equal(done.status, "failure"); assert.equal(calls.length, 1); }
  }
});

for (const entry of ["tool:operation_approval/Pay", "strategy:operation_approval/Direct", "strategy:operation_approval/Nested", "strategy:operation_approval/AgentPath"]) {
  test(`tool obligation survives ${entry} and guards the exact arguments`, async () => {
    const writes = [];
    const options = { entryRef: entry, durableHumanApprovals: true, humanApprovalInitiator: "employee:initiator",
      toolHandlers: { [toolRef]: ({ arguments: args }) => { writes.push(args.amount); return args.amount; } },
      agentDecisions: { "agent:operation_approval/Clerk": { action: "select_capability", target_ref: toolRef, arguments: { amount: 23 } } } };
    const first = await executeAirDocument(air, { ...options, inputs: { amount: 23 } });
    assert.equal(first.reason, "human_approval_pending", JSON.stringify(first));
    assert.deepEqual(writes, []);
    assert.equal(first.checkpoint.approval_ref, approvalRef);
    const request = first.checkpoint.approval_state.requests[approvalRef];
    assert.deepEqual(request.review_context.operation.arguments, { amount: 23 });
    for (const [attest, code] of [[undefined, "HumanApprovalAuthorityRequired"], [authority("employee:initiator"), "HumanApprovalSignerConflict"], [authority("employee:reviewer", []), "HumanApprovalRoleRequired"]]) {
      const refused = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: structuredClone(first.checkpoint),
        humanApprovalDecisions: approve(first.checkpoint), humanApprovalAuthority: attest });
      assert.equal(refused.reason, code, JSON.stringify(refused));
      assert.deepEqual(writes, []);
    }
    const accepted = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: structuredClone(first.checkpoint),
      humanApprovalDecisions: approve(first.checkpoint), humanApprovalAuthority: authority() });
    assert.equal(accepted.status, "success", JSON.stringify(accepted));
    assert.deepEqual(writes, [23]);
    assert.equal(accepted.result, 23);
    const replay = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: structuredClone(first.checkpoint),
      humanApprovalDecisions: approve(first.checkpoint), humanApprovalAuthority: authority() });
    assert.equal(replay.status, "failure");
    assert.deepEqual(writes, [23]);
  });
}

test("a compiled imported tool keeps its mandatory approval on a new caller path", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-imported-approval-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "protected.tb"), 'module protected\ntool Pay\n    gives Int\n    human.approve\n        with role as "finance"\n');
  writeFileSync(join(root, "consumer.tb"), 'module consumer\nimport tool Pay from protected\nstrategy Alternate\n    gives Int\n    uses Pay\n    do\n        Pay\n            into paid\n        give paid\n');
  const imported = compile("--source-root", root, join(root, "consumer.tb"));
  let calls = 0;
  const options = { entryRef: "strategy:consumer/Alternate", durableHumanApprovals: true,
    humanApprovalAuthority: authority(), toolHandlers: { "tool:protected/Pay": () => { calls++; return 7; } } };
  const first = await executeAirDocument(imported, options);
  assert.equal(first.reason, "human_approval_pending", JSON.stringify(first));
  assert.equal(calls, 0);
  const done = await executeAirDocument(imported, { ...options,
    humanApprovalResumeCheckpoint: first.checkpoint, humanApprovalDecisions: approve(first.checkpoint) });
  assert.equal(done.result, 7, JSON.stringify(done));
  assert.equal(calls, 1);
});

test("each new invocation requires another approval even for identical arguments", async () => {
  const writes = [];
  const options = { entryRef: "strategy:operation_approval/Twice", durableHumanApprovals: true,
    humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
    toolHandlers: { [toolRef]: ({ arguments: args }) => { writes.push(args.amount); return args.amount; } } };
  const first = await executeAirDocument(air, { ...options, inputs: { amount: 8 } });
  const second = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: first.checkpoint, humanApprovalDecisions: approve(first.checkpoint) });
  assert.equal(second.reason, "human_approval_pending", JSON.stringify(second));
  assert.deepEqual(writes, [8]);
  assert.notEqual(first.checkpoint.approval_state.requests[approvalRef].request_id, second.checkpoint.approval_state.requests[approvalRef].request_id);
  const done = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: second.checkpoint, humanApprovalDecisions: approve(second.checkpoint) });
  assert.equal(done.status, "success", JSON.stringify(done));
  assert.deepEqual(writes, [8, 8]);
});

test("parallel tool requests are separate, exact and resume without duplicate effects", async () => {
  const writes = [];
  const options = { entryRef: "strategy:operation_approval/Batch", durableHumanApprovals: true,
    humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
    toolHandlers: { [toolRef]: ({ arguments: args }) => { writes.push(args.amount); return args.amount; } } };
  const first = await executeAirDocument(air, { ...options, inputs: { amounts: [7, 9] } });
  assert.equal(first.reason, "human_approval_pending", JSON.stringify(first));
  assert.equal(first.checkpoint.pending_approvals.length, 2);
  assert.deepEqual(writes, []);
  const decisions = Object.fromEntries(first.checkpoint.pending_approvals.map(item => [item.approval_ref, { decision: "approved", evidence_ref: "host-proof" }]));
  const done = await executeAirDocument(air, { ...options, parallelResumeCheckpoint: first.checkpoint, humanApprovalDecisions: decisions });
  assert.equal(done.status, "success", JSON.stringify(done));
  assert.deepEqual(writes.sort(), [7, 9]);
  assert.deepEqual(done.result, [7, 9]);
});

test("an expired tool approval cannot dispatch the operation", async () => {
  const document = structuredClone(air);
  document.definitions.tools[0].approval_policy.timeout_ms = 200;
  let calls = 0;
  const options = { entryRef: "strategy:operation_approval/Direct", durableHumanApprovals: true,
    humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
    toolHandlers: { [toolRef]: () => { calls++; return 7; } } };
  const pending = await executeAirDocument(document, { ...options, inputs: { amount: 7 } });
  assert.equal(pending.reason, "human_approval_pending");
  await new Promise(resolve => setTimeout(resolve, 225));
  const expired = await executeAirDocument(document, { ...options,
    humanApprovalResumeCheckpoint: pending.checkpoint, humanApprovalDecisions: approve(pending.checkpoint) });
  assert.notEqual(expired.status, "success");
  assert.ok(expired.trace.events.some(event => event.kind === "human_approval_expired"));
  assert.equal(calls, 0);
});

test("concurrent attempts to consume the same tool checkpoint dispatch once", async () => {
  let calls = 0;
  const options = { entryRef: "strategy:operation_approval/Direct", durableHumanApprovals: true,
    humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
    toolHandlers: { [toolRef]: async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return 7; } } };
  const pending = await executeAirDocument(air, { ...options, inputs: { amount: 7 } });
  const results = await Promise.all([1, 2].map(() => executeAirDocument(air, { ...options,
    humanApprovalResumeCheckpoint: structuredClone(pending.checkpoint), humanApprovalDecisions: approve(pending.checkpoint) })));
  assert.equal(results.filter(result => result.status === "success").length, 1, JSON.stringify(results));
  assert.equal(calls, 1);
});

test("the linear execution recovery profile rejects operation approval before any dispatch", async () => {
  let calls = 0;
  const result = await executeAirDocument(air, { entryRef: "strategy:operation_approval/Fixed",
    runId: "run:tool-approval-linear-refusal", operationId: "operation:tool-approval-linear-refusal",
    effectScopeId: "operation:tool-approval-linear-refusal", executionCheckpointObserver: async () => {},
    toolHandlers: { [toolRef]: () => { calls++; return 7; } } });
  assert.equal(result.status, "failure", JSON.stringify(result));
  assert.equal(result.reason, "DurableResumeUnsupportedGraph", JSON.stringify(result));
  assert.equal(calls, 0);
});

test("AIR requires the feature marker and the limited reference runtime refuses it", async () => {
  assert.deepEqual(air.required_features, ["tool_operation_approval"]);
  const damaged = structuredClone(air);
  delete damaged.required_features;
  assert.throws(() => validateAirMachineContract(damaged));
  const limited = await executeReferenceAir(air, { entryRef: "strategy:operation_approval/Direct" });
  assert.equal(limited.failure_code, "ReferenceFeatureOutsideProfile");
  const view = projectExplorer([air], { name: "approval", revision: "test", files: [] });
  assert.equal(view.nodes.find(node => node.id === toolRef).details.approval_required, true);
  assert.equal(view.nodes.find(node => node.id === toolRef).details.approval_policy.role, "finance");
  const hover = renderHoverDeclaration({ kind: "tool", item: air.definitions.tools[0] });
  assert.match(hover, /human.approve: required/);
  assert.match(hover, /finance/);
});

test("tool policy requires approval even when no durable continuation is requested", async () => {
  let calls = 0;
  const paused = await executeAirDocument(air, { entryRef: "strategy:operation_approval/Direct", inputs: { amount: 7 },
    humanApprovalInitiator: "employee:initiator", toolHandlers: { [toolRef]: () => { calls++; return 7; } } });
  assert.notEqual(paused.status, "success");
  assert.equal(calls, 0);
});

test("altering the pending arguments or policy cannot retain the original approval", async () => {
  let writes = 0;
  const options = { entryRef: "strategy:operation_approval/Direct", durableHumanApprovals: true,
    humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
    toolHandlers: { [toolRef]: () => { writes++; return 7; } } };
  const first = await executeAirDocument(air, { ...options, inputs: { amount: 7 } });
  const damaged = structuredClone(first.checkpoint);
  damaged.approval_state.requests[approvalRef].review_context.operation.arguments.amount = 70;
  const refused = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: damaged,
    humanApprovalDecisions: approve(damaged) });
  assert.equal(refused.status, "failure", JSON.stringify(refused));
  assert.match(refused.reason, /Checkpoint/);
  const changedAir = structuredClone(air);
  changedAir.definitions.tools[0].approval_policy.role = "other-role";
  await assert.rejects(executeAirDocument(changedAir, { ...options, humanApprovalResumeCheckpoint: first.checkpoint,
    humanApprovalDecisions: approve(first.checkpoint) }));
  assert.equal(writes, 0);
});

for (const sdk of ["javascript", "python"]) {
  test(`${sdk}: real process, persisted provenance, typed wrong amount and concurrent distinct runs`, async t => {
    const root = mkdtempSync(join(tmpdir(), "touba-approved-payment-"));
    const path = join(root, "business.sqlite");
    const db = new DatabaseSync(path);
    t.after(() => { db.close(); rmSync(root, { recursive: true, force: true }); });
    db.exec("CREATE TABLE orders(invoice_id TEXT PRIMARY KEY, amount INTEGER, vendor TEXT); INSERT INTO orders VALUES ('INV-001', 7, 'vendor:trusted'); CREATE TABLE payments(invoice_id TEXT PRIMARY KEY, amount INTEGER, call_id TEXT, provenance TEXT)");
    const handler = new URL(`./fixtures/approved-payment.handler.${sdk === "javascript" ? "mjs" : "py"}`, import.meta.url).pathname;
    const manifestDocument = { manifest_version: "touba-manifest-v1", bindings: {
      [toolRef]: { handler: { kind: "process", command: sdk === "javascript" ? process.execPath : "python3", args: [handler, path] },
        grants: [], secrets: [], timeout_ms: 10000, max_payload_bytes: 32768,
        effect_contract: { kind: "external_write", retry_mode: "idempotency_key" } },
    } };
    const manifest = loadToolBindingManifestFromJson(JSON.stringify(manifestDocument));
    const options = { entryRef: "strategy:operation_approval/Direct", durableHumanApprovals: true,
      humanApprovalInitiator: "employee:initiator", humanApprovalAuthority: authority(),
      toolBindingManifest: manifest, effectJournal: createSqliteEffectJournal(join(root, "effects.sqlite")) };
    const resume = checkpoint => executeAirDocument(air, { ...options, effectScopeId: checkpoint.run_id, humanApprovalResumeCheckpoint: checkpoint,
      humanApprovalDecisions: approve(checkpoint) });
    const bad = await executeAirDocument(air, { ...options, inputs: { amount: 70 } });
    assert.equal(bad.reason, "human_approval_pending", JSON.stringify(bad));
    const rejected = await resume(bad.checkpoint);
    assert.equal(rejected.status, "failure", JSON.stringify(rejected));
    assert.ok(JSON.stringify(rejected).includes("BusinessContractMismatch"), JSON.stringify(rejected));
    assert.equal(db.prepare("SELECT count(*) AS n FROM payments").get().n, 0);
    const pending = await Promise.all([1, 2].map(() => executeAirDocument(air, { ...options, inputs: { amount: 7 } })));
    assert.ok(pending.every(result => result.reason === "human_approval_pending"));
    assert.notEqual(pending[0].checkpoint.run_id, pending[1].checkpoint.run_id);
    const results = await Promise.all(pending.map(result => resume(result.checkpoint)));
    assert.equal(results.filter(result => result.status === "success").length, 1, JSON.stringify(results));
    assert.ok(results.some(result => JSON.stringify(result).includes("DuplicateBusinessOperation")));
    const rows = db.prepare("SELECT * FROM payments").all();
    assert.equal(rows.length, 1);
    const provenance = JSON.parse(rows[0].provenance);
    assert.ok(pending.some(result => result.checkpoint.run_id === provenance.run_id));
    assert.equal(provenance.caller_ref, "strategy:operation_approval/Direct");
    assert.equal(provenance.agent_ref, null);
    assert.equal(provenance.agent_invocation_id, null);
    assert.ok(rows[0].call_id.includes(provenance.run_id));
    db.exec("DELETE FROM payments"); // Only this test's disposable database.
    const agentOptions = { ...options, entryRef: "strategy:operation_approval/AgentPath",
      agentDecisions: { "agent:operation_approval/Clerk": { action: "select_capability", target_ref: toolRef, arguments: { amount: 7 } } } };
    const agentPending = await executeAirDocument(air, { ...agentOptions, inputs: { amount: 7 } });
    assert.equal(agentPending.reason, "human_approval_pending");
    const agentDone = await executeAirDocument(air, { ...agentOptions, effectScopeId: agentPending.checkpoint.run_id,
      humanApprovalResumeCheckpoint: agentPending.checkpoint, humanApprovalDecisions: approve(agentPending.checkpoint) });
    assert.equal(agentDone.status, "success", JSON.stringify(agentDone));
    const writer = JSON.parse(db.prepare("SELECT provenance FROM payments").get().provenance);
    assert.equal(writer.agent_ref, "agent:operation_approval/Clerk");
    assert.match(writer.agent_invocation_id, /^invocation:/);
    for (const change of [{ vendor: "vendor:other" }, { amount: 700 }, { invoice_id: "INV-unknown" }]) {
      const inputs = { payment: { invoice_id: "INV-001", vendor: "vendor:trusted", amount: 7, ...change } };
      const proposal = await executeAirDocument(invoiceAir, { ...options, inputs });
      assert.equal(proposal.reason, "human_approval_pending", JSON.stringify(proposal));
      const denied = await executeAirDocument(invoiceAir, { ...options, effectScopeId: proposal.checkpoint.run_id,
        humanApprovalResumeCheckpoint: proposal.checkpoint, humanApprovalDecisions: approve(proposal.checkpoint) });
      assert.equal(denied.status, "failure", JSON.stringify(denied));
      assert.ok(JSON.stringify(denied).includes("BusinessContractMismatch"));
      assert.equal(db.prepare("SELECT count(*) AS n FROM payments").get().n, 1);
    }
    db.exec("DELETE FROM payments");
    const memoryRef = "memory:operation_approval/Ledger";
    const scope = access => ({ memory_ref: memoryRef, access, source_ref: air.module.source_ref });
    const scoped = structuredClone(air);
    (scoped.definitions.memories ??= []).push({ id: memoryRef, name: "Ledger", source_ref: air.module.source_ref });
    scoped.definitions.tools[0].required_capabilities = ["memory_write"];
    scoped.definitions.tools[0].memory_accesses = [scope("write")];
    scoped.definitions.agents[0].memory_scopes = [scope("read")];
    const memoryManifest = structuredClone(manifestDocument);
    memoryManifest.bindings[toolRef].grants = ["memory_write"];
    memoryManifest.bindings[toolRef].memories = [{ ref: memoryRef, access: "write" }];
    const scopedOptions = { ...agentOptions, toolBindingManifest: loadToolBindingManifestFromJson(JSON.stringify(memoryManifest)) };
    const deniedWrite = await executeAirDocument(scoped, { ...scopedOptions, inputs: { amount: 7 } });
    assert.equal(deniedWrite.reason, "MemoryNotGrantedToOwner", JSON.stringify(deniedWrite));
    assert.equal(db.prepare("SELECT count(*) AS n FROM payments").get().n, 0);
    scoped.definitions.agents[0].memory_scopes.push(scope("write"));
    const allowed = await executeAirDocument(scoped, { ...scopedOptions, inputs: { amount: 7 } });
    assert.equal(allowed.reason, "human_approval_pending", JSON.stringify(allowed));
    const written = await executeAirDocument(scoped, { ...scopedOptions, effectScopeId: allowed.checkpoint.run_id,
      humanApprovalResumeCheckpoint: allowed.checkpoint, humanApprovalDecisions: approve(allowed.checkpoint) });
    assert.equal(written.status, "success", JSON.stringify(written));
    const retained = JSON.parse(db.prepare("SELECT provenance FROM payments").get().provenance);
    assert.equal(retained.agent_ref, "agent:operation_approval/Clerk");
    assert.equal(retained.run_id, allowed.checkpoint.run_id);
  });
}
