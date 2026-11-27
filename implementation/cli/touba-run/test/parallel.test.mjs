import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";
import { createSqliteEffectJournal } from "../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { canonicalDigest } from "../../../runtime/touba-runtime/src/execution-checkpoints.mjs";
import { createApprovalTestRunner } from "../../../tests/helpers/approval-checkpoints.mjs";

const executeAirDocument = createApprovalTestRunner();

function assertProcessTerminated(result) {
  if (process.platform === "win32") assert.ok(Number.isInteger(result.status) && result.status !== 0, result.stderr);
  else assert.equal(result.signal, "SIGKILL", result.stderr);
}

const cargoManifest = fileURLToPath(new URL("../../../Cargo.toml", import.meta.url));
// Cargo coordinates compilation with the other test files. Executing the
// shared target/debug binary directly can race a concurrent Cargo relink.
function compileFile(...args) {
  return JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path", cargoManifest,
    "-p", "touba-cli", "--bin", "touba-compile", "--", ...args], { encoding: "utf8" }));
}
const fixture = fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/parallel-v1/positive/diagnostics.tb", import.meta.url));
const air = compileFile(fixture);
const entryRef = "strategy:parallel.diagnostics/Run";
const toolRef = "tool:parallel.diagnostics/Diagnose";
const agentRef = "agent:parallel.diagnostics/Specialist";
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const options = { entryRef, inputs: { incidents: ["a", "b", "c", "d", "e", "f"] },
  agentDecisionProviderInitialMode: "capabilities",
  agentDecisionProvider: request => request.observations?.length
    ? { action: "answer_directly", result: request.observations.at(-1).value }
    : { action: "select_capability", target_ref: toolRef, arguments: { request: request.inputs.request } },
};

function compile(source) {
  const dir = mkdtempSync(join(tmpdir(), "touba-parallel-source-"));
  try { const path = join(dir, "main.tb"); writeFileSync(path, source); return compileFile(path); }
  finally { rmSync(dir, { recursive: true, force: true }); }
}
const approvalSource = `module parallel.review
tool Diagnose
    takes request as Text
    gives Text
skill Review
    takes request as Text
    gives Text
    uses Diagnose
    do
        Diagnose
            with request as request
            into result
        human.approve
            with context as result
            into approval
        give result
strategy Run
    takes incidents as List of Text
    gives List of Text
    uses Review
    do
        parallel Review
            each incident in incidents
            with request as incident
            max_concurrency 2
            max_items 10
            into results
        give results
`;

test("the last parallel observer snapshot is exactly the resumable returned pause", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-final-parallel-pause-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const document = compile(approvalSource);
  let latest;
  let effects = 0;
  const options = {
    entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a", "b"] },
    humanCheckpointStorePath: join(root, "approval-checkpoints.sqlite"),
    toolHandlers: { "tool:parallel.review/Diagnose": ({ arguments: args }) => { effects++; return args.request; } },
    parallelCheckpointObserver: async ({ checkpoint }) => { latest = structuredClone(checkpoint); await delay(5); },
  };
  const paused = await executeAirDocument(document, options);
  assert.equal(paused.reason, "human_approval_pending");
  assert.deepEqual(latest, paused.checkpoint);
  let checkpoint;
  let resumed = paused;
  for (let attempt = 0; attempt < 4 && resumed.status === "stopped"; attempt++) {
    assert.deepEqual(latest, resumed.checkpoint);
    checkpoint = latest;
    resumed = await executeAirDocument(document, { ...options, inputs: {}, humanApprovalResumeCheckpoint: checkpoint,
      humanApprovalDecisions: Object.fromEntries(checkpoint.pending_approvals.map(item => [item.approval_ref, "approved"])) });
  }
  assert.equal(resumed.status, "success");
  assert.deepEqual(resumed.result, ["a", "b"]);
  assert.equal(effects, 2);
  assert.equal((await executeAirDocument(document, { ...options, humanApprovalResumeCheckpoint: checkpoint })).reason,
    "HumanApprovalCheckpointIntegrityMismatch");
  assert.equal((await executeAirDocument(document, { ...options, humanApprovalResumeCheckpoint: latest })).reason,
    "HumanApprovalCheckpointAlreadyConsumed");
  assert.equal(effects, 2);
});

test("native multi-agent fan-out overlaps bounded calls and joins in input order", async () => {
  let active = 0, peak = 0;
  const identities = new Map();
  const finished = [];
  const result = await executeAirDocument(air, { ...options, agentDecisionProvider: request => {
    assert.equal(typeof request.invocation_id, "string");
    const ids = identities.get(request.inputs.request) ?? new Set();
    ids.add(request.invocation_id); identities.set(request.inputs.request, ids);
    return options.agentDecisionProvider(request);
  }, toolHandlers: { [toolRef]: async ({ arguments: args }) => {
    peak = Math.max(peak, ++active);
    await delay(args.request === "a" ? 35 : 5);
    active--; finished.push(args.request); return `diagnosis:${args.request}`;
  } } });
  assert.equal(result.status, "success", JSON.stringify({ reason: result.reason, failure: result.trace.events.findLast(e => e.kind === "failure_detected") }));
  assert.deepEqual(result.result, options.inputs.incidents.map(item => `diagnosis:${item}`));
  assert.ok(peak > 1 && peak <= 4, `peak=${peak}`);
  assert.notEqual(finished[0], "a");
  assert.equal(identities.size, 6);
  assert([...identities.values()].every(ids => ids.size === 1));
  assert.equal(new Set([...identities.values()].flatMap(ids => [...ids])).size, 6);
  assert.ok(result.trace.events.filter(e => e.kind === "agent_decision_provider_call_attempted").every(e => e.payload.branch_id));
  const contexts = result.trace.events.filter(e => e.kind === "agent_decision_provider_call_attempted").map(e => e.payload.trace_context);
  assert.ok(contexts.every(c => c?.target_ref === agentRef && c.parent_span_id));
  assert.equal(new Set(contexts.map(c => c.span_id)).size, 6);
  assert.deepEqual(new Set(contexts.map(c => c.agent_invocation_id)), new Set([...identities.values()].flatMap(ids => [...ids])));
});

test("parallel checkpoint observers retain the matching SQLite prefix after other branches advance", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-parallel-trace-"));
  const store = createSqliteTraceStore({ filename: join(root, "trace.sqlite"), maxDocumentBytes: 1 });
  t.after(() => { store.close(); rmSync(root, { recursive: true, force: true }); });
  const observations = [];
  const result = await executeAirDocument(air, {
    ...options, traceStorage: store,
    toolHandlers: { [toolRef]: async ({ arguments: args }) => { await delay(1); return `diagnosis:${args.request}`; } },
    parallelCheckpointObserver: async observation => { observations.push(observation); await delay(2); },
  });
  assert.equal(result.status, "success");
  assert.deepEqual(result.result, options.inputs.incidents.map(item => `diagnosis:${item}`));
  assert.ok(observations.length > 2);
  for (const { checkpoint, traceReader } of observations) {
    const trace = JSON.parse([...traceReader.json()].join(""));
    assert.equal(canonicalDigest(trace), checkpoint.trace_prefix_digest);
    assert.ok(trace.events.every(event => event.kind !== "run_completed"));
  }
  assert.throws(() => result.trace, { code: "TraceMaterializationLimitExceeded" });
});

test("zero items, cardinality and all input arguments are checked before dispatch", async () => {
  for (const [incidents, reason] of [[[], "completed"], [Array(33).fill("x"), "ParallelItemLimitExceeded"], [["x", 42], "StrategyInputTypeMismatch"]]) {
    let calls = 0;
    const result = await executeAirDocument(air, { ...options, inputs: { incidents }, agentDecisionProvider: () => { calls++; return { action: "answer_directly", result: "x" }; } });
    assert.equal(calls, 0);
    if (incidents.length === 0) assert.deepEqual(result.result, []);
    else assert.equal(result.status, "failure", result.reason);
    if (reason !== "StrategyInputTypeMismatch") assert.equal(result.reason, reason);
  }
});

test("shared provider and tool ceilings cannot be raced by parallel agents", async () => {
  for (const kind of ["max_provider_calls", "max_tool_calls"]) {
    let providers = 0, tools = 0;
    const result = await executeAirDocument(air, { ...options, runLimits: { [kind]: 1 },
      agentDecisionProvider: async request => { providers++; await delay(5); return options.agentDecisionProvider(request); },
      toolHandlers: { [toolRef]: async () => { tools++; await delay(5); return "ok"; } },
    });
    assert.equal(result.status, "failure", JSON.stringify({ reason: result.reason, failure: result.trace.events.findLast(e => e.kind === "failure_detected") }));
    assert.equal(kind === "max_provider_calls" ? providers : tools, 1);
  }
});

test("two branch approvals remain distinct; resume never calls completed tools twice", async () => {
  const document = compile(approvalSource);
  let calls = 0;
  const config = { entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a", "b", "c"] }, durableHumanApprovals: true,
    toolHandlers: { "tool:parallel.review/Diagnose": async ({ arguments: args }) => { calls++; await delay(5); return args.request; } } };
  let result = await executeAirDocument(document, config);
  assert.equal(result.status, "stopped", JSON.stringify({ reason: result.reason, failure: result.trace.events.findLast(e => e.kind === "failure_detected") }));
  assert.equal(result.checkpoint.kind, "parallel_group");
  assert.equal(calls, 2);
  let resumes = 0;
  while (result.checkpoint && resumes++ < 5) {
    const checkpoint = JSON.parse(JSON.stringify(result.checkpoint));
    result = await executeAirDocument(document, { ...config, inputs: undefined, humanApprovalResumeCheckpoint: checkpoint,
      humanApprovalDecisions: Object.fromEntries(checkpoint.pending_approvals.map(entry => [entry.approval_ref, "approved"])) });
  }
  assert.equal(result.status, "success", JSON.stringify({ reason: result.reason, failure: result.trace.events.findLast(e => e.kind === "failure_detected") }));
  assert.deepEqual(result.result, ["a", "b", "c"]);
  assert.equal(calls, 3);
});

test("an all-complete snapshot from a consumed run cannot start another continuation", async () => {
  let completed;
  const first = await executeAirDocument(air, { ...options, durableHumanApprovals: true,
    toolHandlers: { [toolRef]: async ({ arguments: args }) => args.request },
    parallelCheckpointObserver: ({ checkpoint }) => { if (checkpoint.parallel_state.branches.every(b => b.status === "done")) completed = structuredClone(checkpoint); },
  });
  assert.equal(first.status, "success", first.reason);
  assert.ok(completed);
  const resumed = await executeAirDocument(air, { ...options, inputs: undefined, parallelResumeCheckpoint: completed,
    agentDecisionProvider: () => { throw Error("must not run"); }, toolHandlers: { [toolRef]: () => { throw Error("must not run"); } },
  });
  assert.equal(resumed.reason, "HumanApprovalCheckpointAlreadyConsumed");
});

test("machine contract rejects malformed and incomplete parallel AIR", () => {
  for (const change of [node => delete node.max_items, node => node.max_concurrency = 0,
    node => node.max_concurrency = 33, node => node.quorum = 1]) {
    const bad = structuredClone(air); change(bad.execution_graphs[0].nodes[0]);
    assert.throws(() => validateAirMachineContract(bad));
  }
});

test("global transport limit includes providers and handlers, including after provider timeout", async () => {
  let active = 0, peak = 0, completed = 0;
  const result = await executeAirDocument(air, { ...options, parallelLimits: { maxExternalCalls: 1 },
    agentDecisionProviderTimeoutMs: 5, agentDecisionProvider: async () => {
      peak = Math.max(peak, ++active); await delay(35); active--; completed++;
      return { action: "answer_directly", result: "late" };
    },
  });
  assert.equal(result.status, "failure");
  assert.equal(peak, 1);
  assert.equal(active, 0, "logical timeout must not return while transport is in flight");
  assert.equal(completed, 1);
});

test("nested groups share global admission without reserving parent transport permits", async () => {
  const document = compile(`module nested.parallel
tool Read
    takes value as Text
    gives Text
strategy Child
    takes values as List of Text
    gives List of Text
    uses Read
    do
        parallel Read
            each value in values
            with value as value
            max_concurrency 2
            max_items 4
            into result
        give result
strategy Run
    takes batches as List of List of Text
    gives List of List of Text
    uses Child
    do
        parallel Child
            each batch in batches
            with values as batch
            max_concurrency 2
            max_items 4
            into result
        give result
`);
  let active = 0, peak = 0;
  const config = { entryRef: "strategy:nested.parallel/Run", inputs: { batches: [["a", "b"], ["c", "d"]] },
    parallelLimits: { maxExternalCalls: 1 }, toolHandlers: { "tool:nested.parallel/Read": async ({ arguments: args }) => {
      peak = Math.max(peak, ++active); await delay(3); active--; return args.value;
    } } };
  const result = await executeAirDocument(document, config);
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.result, config.inputs.batches);
  assert.equal(peak, 1);
  const refused = await executeAirDocument(document, { ...config, parallelLimits: { maxBranches: 3 } });
  assert.equal(refused.reason, "ParallelBranchLimitExceeded");
});

test("a decision for one occurrence cannot release another; rejected and expired groups dispatch nothing", async () => {
  const document = compile(approvalSource);
  let calls = 0;
  const config = { entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a", "b", "c"] },
    toolHandlers: { "tool:parallel.review/Diagnose": async ({ arguments: args }) => { calls++; await delay(5); return args.request; } } };
  for (const decision of ["rejected", "expired", "cancelled"]) {
    const first = await executeAirDocument(document, config);
    assert.equal(first.checkpoint.pending_approvals.length, 1, "the other branch should stop at the next serializable boundary");
    const [pending] = first.checkpoint.pending_approvals;
    const before = calls;
    const result = await executeAirDocument(document, { ...config, inputs: undefined, humanApprovalResumeCheckpoint: structuredClone(first.checkpoint),
      humanApprovalDecisions: { [pending.approval_ref]: decision } });
    assert.equal(result.reason, `human_approval_${decision}`);
    assert.equal(calls, before);
    assert.equal(result.checkpoint, undefined);
  }
  const first = await executeAirDocument(document, config);
  const [pending] = first.checkpoint.pending_approvals;
  const wrong = await executeAirDocument(document, { ...config, inputs: undefined, humanApprovalResumeCheckpoint: first.checkpoint,
    humanApprovalDecisions: { [`${pending.approval_ref}:wrong`]: "approved" } });
  assert.equal(wrong.reason, "UnknownApprovalReference");
});

test("checkpoint tampering and tighter restored budgets fail before another dispatch", async () => {
  const document = compile(approvalSource);
  let calls = 0;
  const config = { entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a", "b"] },
    toolHandlers: { "tool:parallel.review/Diagnose": async ({ arguments: args }) => { calls++; return args.request; } } };
  const first = await executeAirDocument(document, config);
  for (const mutate of [cp => cp.parallel_state.branches[0].arguments[0] = "other",
    cp => delete cp.parallel_limits.maxExternalCalls, cp => cp.parallel_state.branches[0].journal[0].key = "wrong"]) {
    const checkpoint = structuredClone(first.checkpoint); mutate(checkpoint);
    const before = calls;
    const result = await executeAirDocument(document, { ...config, inputs: undefined, humanApprovalResumeCheckpoint: checkpoint,
      humanApprovalDecisions: Object.fromEntries(checkpoint.pending_approvals.map(p => [p.approval_ref, "approved"])) });
    assert.equal(result.status, "failure", result.reason);
    assert.equal(calls, before);
  }
  const result = await executeAirDocument(document, { ...config, inputs: undefined, humanApprovalResumeCheckpoint: first.checkpoint,
    runLimits: { max_tool_calls: 1 }, humanApprovalDecisions: Object.fromEntries(first.checkpoint.pending_approvals.map(p => [p.approval_ref, "approved"])) });
  assert.equal(result.reason, "ToolCallBudgetExceeded");
});

test("a superseded partial snapshot cannot replay an earlier provider call", async () => {
  let snapshot, calls = 0;
  const result = await executeAirDocument(air, { ...options,
    agentDecisionProvider: async () => { calls++; await delay(5); return { action: "answer_directly", result: "ok" }; },
    parallelCheckpointObserver: ({ checkpoint }) => {
      if (!snapshot && checkpoint.parallel_state.branches.some(b => b.journal.some(e => e.kind === "provider" && e.state === "pending"))) snapshot = structuredClone(checkpoint);
    },
  });
  assert.equal(result.status, "success", result.reason);
  assert.ok(snapshot);
  const before = calls;
  const resumed = await executeAirDocument(air, { ...options, inputs: undefined, parallelResumeCheckpoint: snapshot,
    agentDecisionProvider: () => { calls++; return { action: "answer_directly", result: "wrong" }; } });
  assert.equal(resumed.reason, "HumanApprovalCheckpointIntegrityMismatch");
  assert.equal(calls, before);
});

test("shared memory writes serialize while compatible reads overlap", async () => {
  for (const access of ["read", "write"]) {
    const document = compile(approvalSource.replace("tool Diagnose", "memory Shared\n\ntool Diagnose")
      .replace("tool Diagnose\n", `tool Diagnose\n    uses memory Shared ${access}\n    requires memory_${access}\n`)
      .replace("skill Review\n", `skill Review\n    memory Shared ${access}\n`)
      .replace("        human.approve\n            with context as result\n            into approval\n", ""));
    let active = 0, peak = 0;
    const result = await executeAirDocument(document, { entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a", "b", "c"] },
      toolBindingManifest: { manifest_version: "touba-manifest-v1", bindings: {
        "tool:parallel.review/Diagnose": { handler: { kind: "process", command: process.execPath, args: [] },
          effect_contract: { kind: "none" }, grants: [`memory_${access}`],
          memories: [{ ref: "memory:parallel.review/Shared", access }], timeout_ms: 1000, max_payload_bytes: 65536 },
      } },
      toolHandlers: { "tool:parallel.review/Diagnose": async ({ arguments: args }) => {
        peak = Math.max(peak, ++active); await delay(5); active--; return args.request;
      } } });
    assert.equal(result.status, "success", result.reason);
    assert.equal(peak, access === "read" ? 2 : 1);
  }
});

test("cancellation during transport admission stops queued branches and drains the active handler", async () => {
  const document = compile(approvalSource.replace("        human.approve\n            with context as result\n            into approval\n", ""));
  let cancelled = false, calls = 0, active = 0;
  const result = await executeAirDocument(document, { entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a", "b", "c"] },
    cancelRequestedProvider: () => cancelled, parallelLimits: { maxExternalCalls: 1 },
    toolHandlers: { "tool:parallel.review/Diagnose": async ({ arguments: args }) => {
      calls++; active++; cancelled = true; await delay(15); active--; return args.request;
    } } });
  assert.equal(result.status, "cancelled", result.reason);
  assert.equal(calls, 1); assert.equal(active, 0);
});

test("branch show messages join in input order independently of completion order", async () => {
  const document = compile(approvalSource.replace("        human.approve\n            with context as result\n            into approval\n",
    "        show\n            with message as result\n"));
  const result = await executeAirDocument(document, { entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a", "b"] },
    toolHandlers: { "tool:parallel.review/Diagnose": async ({ arguments: args }) => { await delay(args.request === "a" ? 20 : 1); return args.request; } } });
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.messages.map(m => m.text), ["a", "b"]);
});

test("parallel ask answers are occurrence-specific, journaled, and never silently join an unanswered branch", async () => {
  const document = compile(approvalSource.replace("        Diagnose\n            with request as request\n            into result\n",
    "        ask\n            with prompt as request\n            into result\n"));
  const config = { entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a", "b"] } };
  const missing = await executeAirDocument(document, config);
  assert.equal(missing.status, "stopped");
  assert.equal(missing.reason, "user_input_pending");
  assert.ok(missing.checkpoint.pending_interactions.length);
  assert.deepEqual(missing.pending_interactions, missing.checkpoint.pending_interactions.map(({ interaction_ref, prompt }) => ({ interaction_ref, prompt })));
  assert.deepEqual(missing.pending_interaction, missing.pending_interactions[0]);
  let resumed = missing;
  for (let i = 0; resumed.checkpoint && i < 8; i++) {
    const checkpoint = JSON.parse(JSON.stringify(resumed.checkpoint));
    const input = checkpoint.pending_interactions?.[0];
    resumed = await executeAirDocument(document, { ...config, inputs: undefined, parallelResumeCheckpoint: checkpoint,
      userInputs: input ? { [input.interaction_ref]: input.prompt + "?" } : {},
      humanApprovalDecisions: Object.fromEntries((checkpoint.pending_approvals ?? []).map(p => [p.approval_ref, "approved"])) });
  }
  assert.equal(resumed.status, "success", resumed.reason);
  assert.deepEqual(resumed.result, ["a?", "b?"]);
  assert.equal(resumed.pending_interactions, undefined);
  const seen = [];
  const userInputProvider = async request => {
    seen.push(request.interactionRef); await delay(2); return request.prompt + "!";
  };
  let result = await executeAirDocument(document, { ...config, userInputProvider });
  for (let i = 0; result.checkpoint && i < 4; i++) {
    const checkpoint = result.checkpoint;
    result = await executeAirDocument(document, { ...config, inputs: undefined, userInputProvider,
      parallelResumeCheckpoint: checkpoint,
      humanApprovalDecisions: Object.fromEntries(checkpoint.pending_approvals.map(p => [p.approval_ref, "approved"])) });
  }
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.result, ["a!", "b!"]);
  assert.equal(seen.length, 2);
  assert.equal(new Set(seen).size, 2);
});

test("parallel agent-requested reviews preserve provider responses and consume occurrence-specific decisions", async () => {
  let calls = 0;
  const config = { ...options, inputs: { incidents: ["a", "b", "c"] }, agentDecisionProvider: async request => {
    calls++; await delay(2);
    return request.step_index === 0 ? { action: "request_human_review", review_prompt: "Approve this incident diagnosis." }
      : { action: "answer_directly", result: request.inputs.request };
  } };
  let result = await executeAirDocument(air, config);
  assert.ok(result.checkpoint.pending_approvals.length > 1, "concurrent provider reviews must remain separate waits");
  for (let i = 0; result.checkpoint && i < 6; i++) {
    const cp = result.checkpoint;
    result = await executeAirDocument(air, { ...config, inputs: undefined, humanApprovalResumeCheckpoint: cp,
      humanApprovalDecisions: { [cp.approval_ref]: "approved" } });
  }
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.result, ["a", "b", "c"]);
  assert.equal(calls, 6);
});

test("parallel host limits, journal size and provider output types fail closed", async () => {
  for (const [parallelLimits, expected] of [[{ maxBranches: 2 }, "ParallelBranchLimitExceeded"],
    [{ maxItems: 2 }, "ParallelItemLimitExceeded"], [{ maxJournalEntries: 1 }, "ParallelJournalLimitExceeded"],
    [{ maxCheckpointBytes: 128 }, "InvalidParallelCheckpoint"]]) {
    const result = await executeAirDocument(air, { ...options, parallelLimits,
      agentDecisionProvider: () => ({ action: "answer_directly", result: "ok" }) });
    assert.equal(result.reason, expected);
  }
  const result = await executeAirDocument(air, { ...options, agentDecisionProvider: () => ({ action: "answer_directly", result: 42 }) });
  assert.equal(result.status, "failure");
});

test("nested parallel human checkpoints preserve the whole tree without duplicate calls", async () => {
  const document = compile(approvalSource + `strategy Nested
    takes batches as List of List of Text
    gives List of List of Text
    uses Run
    do
        parallel Run
            each batch in batches
            with incidents as batch
            max_concurrency 2
            max_items 4
            into results
        give results
`);
  const calls = [];
  const config = { entryRef: "strategy:parallel.review/Nested", inputs: { batches: [["a", "b"], ["c", "d"]] },
    toolHandlers: { "tool:parallel.review/Diagnose": async ({ arguments: args }) => { calls.push(args.request); await delay(3); return args.request; } } };
  let result = await executeAirDocument(document, config);
  for (let i = 0; result.checkpoint && i < 6; i++) {
    const checkpoint = result.checkpoint;
    result = await executeAirDocument(document, { ...config, inputs: undefined, humanApprovalResumeCheckpoint: checkpoint,
      humanApprovalDecisions: Object.fromEntries(checkpoint.pending_approvals.map(p => [p.approval_ref, "approved"])) });
  }
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.result, config.inputs.batches);
  assert.deepEqual(calls.sort(), ["a", "b", "c", "d"]);
});

test("bounded agent revision cycles can run as independent native branches", async () => {
  const source = readFileSync(new URL("../../../grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-agent-revision-cycle.tb", import.meta.url), "utf8")
    .replace("max_agent_invocations as 5", "max_agent_invocations as 12").replace("max_provider_calls as 5", "max_provider_calls as 12");
  const document = compile(source + `\nstrategy Batch
    takes drafts as List of Draft
    gives List of Draft
    uses Iterate
    do
        parallel Iterate
            each draft in drafts
            with draft as draft
            with remaining as 3
            max_concurrency 2
            max_items 10
            into reviewed
        give reviewed
`);
  const seen = [];
  const result = await executeAirDocument(document, { entryRef: "strategy:agent.revision/Batch",
    inputs: { drafts: [{ text: "a", accepted: false }, { text: "b", accepted: false }] },
    agentDecisionProvider: async request => {
      seen.push(request.inputs.draft.text); await delay(2);
      return { action: "answer_directly", result: { text: request.inputs.draft.text + "!", accepted: request.inputs.draft.text.endsWith("!") } };
    } });
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.result, [{ text: "a!!", accepted: true }, { text: "b!!", accepted: true }]);
  assert.deepEqual(seen.sort(), ["a", "a!", "b", "b!"]);
});

test("a killed process resumes completed branch evidence and dispatches only pending work", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-parallel-crash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const document = structuredClone(air);
  document.execution_graphs[0].nodes[0].max_concurrency = 1;
  writeFileSync(join(root, "air.json"), JSON.stringify(document));
  const runtimeUrl = new URL("../../../runtime/touba-runtime/src/index.mjs", import.meta.url).href;
  writeFileSync(join(root, "worker.mjs"), `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
import { executeAirDocument } from ${JSON.stringify(runtimeUrl)};
const document = JSON.parse(readFileSync('air.json', 'utf8'));
const resume = process.argv.includes('--resume');
const result = await executeAirDocument(document, {
  entryRef: ${JSON.stringify(entryRef)},
  ...(resume ? { parallelResumeCheckpoint: JSON.parse(readFileSync('checkpoint.json', 'utf8')) } : { inputs: { incidents: ['a','b','c'] } }),
  agentDecisionProvider: request => {
    appendFileSync('calls.txt', request.inputs.request + '\\n');
    return { action: 'answer_directly', result: request.inputs.request };
  },
  parallelCheckpointObserver: ({ checkpoint }) => {
    writeFileSync('checkpoint.json', JSON.stringify(checkpoint));
    if (!resume && checkpoint.parallel_state.branches[0].status === 'done') process.kill(process.pid, 'SIGKILL');
  }
});

writeFileSync('result.json', JSON.stringify(result));`);
  const killed = spawnSync(process.execPath, [join(root, "worker.mjs")], { cwd: root, encoding: "utf8" });
  assertProcessTerminated(killed);
  assert.equal(readFileSync(join(root, "calls.txt"), "utf8"), "a\n");
  const resumed = spawnSync(process.execPath, [join(root, "worker.mjs"), "--resume"], { cwd: root, encoding: "utf8" });
  assert.equal(resumed.status, 0, resumed.stderr);
  const result = JSON.parse(readFileSync(join(root, "result.json"), "utf8"));
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.result, ["a", "b", "c"]);
  assert.equal(readFileSync(join(root, "calls.txt"), "utf8"), "a\nb\nc\n");
});


test("a resumed group follows its declared handler recovery edge", async () => {
  const document = compile(approvalSource.replace("strategy Run", "skill Run").replace("    uses Review", "    uses Review\n    uses Recover").replace("        Diagnose\n            with request as request\n            into result\n        human.approve\n            with context as result\n            into approval\n",
    "        human.approve\n            with context as request\n            into approval\n        Diagnose\n            with request as request\n            into result\n")
    + `    on failure handler
        fallback Recover
skill Recover
    takes incidents as List of Text
    gives List of Text
    do
        give incidents
`);
  const config = { entryRef: "skill:parallel.review/Run", inputs: { incidents: ["a"] },
    toolHandlers: { "tool:parallel.review/Diagnose": () => { throw new Error("Backend unavailable"); } } };
  const paused = await executeAirDocument(document, config);
  assert.equal(paused.reason, "human_approval_pending");
  const result = await executeAirDocument(document, { ...config, inputs: undefined,
    parallelResumeCheckpoint: paused.checkpoint, humanApprovalDecisions: { [paused.checkpoint.approval_ref]: "approved" } });
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.result, ["a"]);
  assert.ok(result.trace.events.some(e => e.kind === "fallback_selected"));
});

test("a superseded in-flight external write snapshot cannot roll back a completed run", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-parallel-reconcile-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const document = compile(approvalSource.replace("        human.approve\n            with context as result\n            into approval\n", "")
    .replace("max_concurrency 2", "max_concurrency 1"));
  const marker = join(root, "effects.txt");
  const handler = `const {appendFileSync} = require('node:fs'); let data = '';
process.stdin.on('data', chunk => data += chunk); process.stdin.on('end', () => {
  const request = JSON.parse(data); appendFileSync(${JSON.stringify(marker)}, request.arguments.request + '\\n');
  process.stdout.write(JSON.stringify({ok: true, value: request.arguments.request, effect_receipt: {
    effect_id: request.effect.effect_id, request_digest: request.effect.request_digest, outcome: 'applied'}}));
});`;
  let interrupted;
  const config = { entryRef: "strategy:parallel.review/Run", inputs: { incidents: ["a"] },
    effectScopeId: "parallel-reconcile", effectJournal: createSqliteEffectJournal(join(root, "journal.sqlite")),
    toolBindingManifest: { manifest_version: "touba-manifest-v1", bindings: {
      "tool:parallel.review/Diagnose": { handler: { kind: "process", command: process.execPath, args: ["-e", handler] },
        grants: [], timeout_ms: 2000, max_payload_bytes: 65536, effect_contract: { kind: "external_write", retry_mode: "none" } } } },
    parallelCheckpointObserver: ({ checkpoint }) => {
      if (checkpoint.parallel_state.branches[0].journal.some(e => e.kind === "tool" && e.state === "pending" && e.effect_index)) {
        interrupted = structuredClone(checkpoint);
      }
    } };
  const first = await executeAirDocument(document, config);
  assert.equal(first.status, "success", first.reason);
  assert.ok(interrupted);
  const resumed = await executeAirDocument(document, { ...config, inputs: undefined, parallelResumeCheckpoint: interrupted });
  assert.equal(resumed.reason, "HumanApprovalCheckpointIntegrityMismatch");
  assert.equal(readFileSync(marker, "utf8"), "a\n");
});

test("a process killed after storing an applied receipt resumes without paying twice", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-parallel-receipt-crash-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const document = compile(approvalSource.replace("        human.approve\n            with context as result\n            into approval\n", "")
    .replace("max_concurrency 2", "max_concurrency 1"));
  writeFileSync(join(root, "air.json"), JSON.stringify(document));
  const runtime = new URL("../../../runtime/touba-runtime/src/index.mjs", import.meta.url).href;
  const journal = new URL("../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs", import.meta.url).href;
  writeFileSync(join(root, "handler.mjs"), `import {appendFileSync} from 'node:fs';
let raw=''; for await (const chunk of process.stdin) raw+=chunk;
const request=JSON.parse(raw); appendFileSync('payments.txt', request.arguments.request+'\\n');
process.stdout.write(JSON.stringify({ok:true,value:request.arguments.request,effect_receipt:{effect_id:request.effect.effect_id,request_digest:request.effect.request_digest,outcome:'applied'}}));`);
  writeFileSync(join(root, "worker.mjs"), `import {readFileSync,writeFileSync} from 'node:fs';
import {executeAirDocument} from ${JSON.stringify(runtime)};
import {createSqliteEffectJournal} from ${JSON.stringify(journal)};
const resume=process.argv.includes('--resume');
const store=createSqliteEffectJournal('effects.sqlite');
const result=await executeAirDocument(JSON.parse(readFileSync('air.json')), {
  entryRef:'strategy:parallel.review/Run', effectScopeId:'synthetic-receipt',
  effectJournal:{...store, writeEntry(entry){store.writeEntry(entry); if(!resume && entry.state==='applied') process.kill(process.pid,'SIGKILL');}},
  ...(resume?{parallelResumeCheckpoint:JSON.parse(readFileSync('checkpoint.json'))}:{inputs:{incidents:['a']}}),
  toolBindingManifest:{manifest_version:'touba-manifest-v1',bindings:{'tool:parallel.review/Diagnose':{
    handler:{kind:'process',command:process.execPath,args:['handler.mjs']},grants:[],timeout_ms:10000,max_payload_bytes:65536,
    effect_contract:{kind:'external_write',retry_mode:'none'}}}},
  parallelCheckpointObserver:({checkpoint})=>writeFileSync('checkpoint.json',JSON.stringify(checkpoint))
});
writeFileSync('result.json',JSON.stringify(result));`);
  const run = args => spawnSync(process.execPath, [join(root, "worker.mjs"), ...args], { cwd: root, encoding: "utf8", timeout: 30000 });
  const killed = run([]);
  assertProcessTerminated(killed);
  assert.equal(readFileSync(join(root, "payments.txt"), "utf8"), "a\n");
  const resumed = run(["--resume"]);
  assert.equal(resumed.status, 0, resumed.stderr);
  const result = JSON.parse(readFileSync(join(root, "result.json")));
  assert.equal(result.status, "success", result.reason);
  assert.deepEqual(result.result, ["a"]);
  assert.equal(readFileSync(join(root, "payments.txt"), "utf8"), "a\n");
});

test("imported specialists and supervisors keep typed authority and isolated inputs inside native branches", async t => {
  const root = mkdtempSync(join(tmpdir(), "touba-parallel-imports-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "specialists.tb"), `module specialists
agent Worker
    description "Review a supplied request independently."
    takes request as Text
    gives Text
    responsibility "Review the supplied request."
    callable_by strategy batches.Run
    callable_by agent batches.Supervisor
`);
  const source = `module batches
import agent Worker from specialists
agent Supervisor
    takes request as Text
    gives Text
    responsibility "Delegate the request to Worker and return the observation."
    uses Worker
    callable_by strategy Run
strategy Run
    takes requests as List of Text
    gives List of Text
    uses Worker
    uses Supervisor
    do
        parallel Supervisor
            each request in requests
            with request as request
            max_concurrency 2
            max_items 8
            into results
        give results
`;
  for (const target of ["Worker", "Supervisor"]) {
    writeFileSync(join(root, "batches.tb"), source.replace("parallel Supervisor", "parallel " + target));
    const document = compileFile("--source-root", root, join(root, "batches.tb"));
    const inputs = { requests: ["a", "b", "c"] }, seen = [];
    const result = await executeAirDocument(document, { entryRef: "strategy:batches/Run", inputs,
      agentDecisionProviderInitialMode: "capabilities", agentDecisionProvider: async request => {
        await delay(2);
        if (request.agent_ref === "agent:specialists/Worker") {
          seen.push(request.inputs.request);
          const value = request.inputs.request;
          request.inputs.request = "provider-local mutation";
          return { action: "answer_directly", result: value };
        }
        return request.observations.length
          ? { action: "answer_directly", result: request.observations[0].value }
          : { target_ref: "agent:specialists/Worker", arguments: { request: request.inputs.request } };
      },
    });
    assert.equal(result.status, "success", result.reason);
    assert.deepEqual(result.result, inputs.requests);
    assert.deepEqual(seen.sort(), ["a", "b", "c"]);
  }
});
