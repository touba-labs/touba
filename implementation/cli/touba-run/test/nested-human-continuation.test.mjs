import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { linkSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeAirDocument, loadSecretsFromJson } from "../../../runtime/touba-runtime/src/index.mjs";
import { checkpointJsonClone, validateHumanCheckpointContinuation } from "../../../runtime/touba-runtime/src/human-approval-checkpoints.mjs";

const fixture = fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-nested-human-continuation.tb", import.meta.url));
const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
  fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--", fixture], { encoding: "utf8" }));
const ref = name => `strategy:agent.continuation/${name}`;
const resume = (checkpoint, options = {}, decision = "approved") => executeAirDocument(air, {
  ...options, entryRef: checkpoint.entry_ref, durableHumanApprovals: true,
  humanApprovalResumeCheckpoint: JSON.parse(JSON.stringify(checkpoint)),
  humanApprovalDecisions: { [checkpoint.approval_ref]: decision },
});
function recording(writes) {
  return { "tool:agent.continuation/Record": ({ arguments: args }) => { writes.push(args.value); return args.value; } };
}

test("an agent-selected workflow resumes the pending selection once and returns through its source caller", async () => {
  const writes = [], decisions = [];
  const options = { toolHandlers: recording(writes), agentDecisionProviderInitialMode: "capabilities",
    agentDecisionProvider: request => {
      decisions.push({ step: request.step_index, observations: structuredClone(request.observations) });
      return request.step_index === 0
        ? { target_ref: ref("Work"), arguments: { value: "child" } }
        : { action: "answer_directly", result: request.observations[0].value };
    } };
  const paused = await executeAirDocument(air, { ...options, entryRef: ref("RunDelegation"), inputs: { value: "parent" }, durableHumanApprovals: true });
  assert.equal(paused.reason, "human_approval_pending", JSON.stringify(paused));
  assert.deepEqual(paused.checkpoint.call_stack.map(f => f.kind), ["call_agent", "agent_capability", "call_skill"]);
  const result = await resume(paused.checkpoint, options);
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "child");
  assert.deepEqual(writes, ["before", "child"]);
  assert.deepEqual(decisions.map(d => d.step), [0, 1]);
  assert.deepEqual(decisions[1].observations.map(o => [o.target_ref, o.value]), [[ref("Work"), "child"]]);
});

test("repeated delegated agent reviews each require a fresh decision and preserve distinct caller observations", async () => {
  const seen = [], agent = name => `agent:agent.continuation/${name}`;
  const options = { agentDecisionProviderInitialMode: "capabilities", agentDecisionProvider: request => {
    seen.push([request.agent_ref, request.step_index, request.inputs.value, structuredClone(request.observations)]);
    if (request.agent_ref === agent("Coordinator")) return request.step_index < 2
      ? { target_ref: agent("Reviewer"), arguments: { value: `child-${request.step_index}` } }
      : { action: "answer_directly", result: request.inputs.value + ":" + request.observations.map(o => o.value).join(",") };
    return request.step_index === 0 ? { action: "request_human_review", review_prompt: "Approve this delegated value." }
      : { action: "answer_directly", result: request.inputs.value };
  } };
  let result = await executeAirDocument(air, { ...options, entryRef: ref("RunDelegation"), inputs: { value: "parent" }, durableHumanApprovals: true });
  const approval = result.checkpoint.approval_ref;
  assert.equal(result.checkpoint.call_stack[1].kind, "agent_capability");
  result = await resume(result.checkpoint, options);
  assert.equal(result.reason, "human_approval_pending", JSON.stringify(result));
  assert.equal(result.checkpoint.approval_ref, approval);
  assert.equal(result.checkpoint.call_stack[1].observations.length, 1);
  result = await resume(result.checkpoint, options);
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "parent:child-0,child-1");
  assert.deepEqual(seen.filter(s => s[0] === agent("Coordinator")).map(s => s[1]), [0, 1, 2]);
  assert.deepEqual(seen.filter(s => s[0] === agent("Reviewer")).map(s => s[1]), [0, 1, 0, 1]);
});

test("a host-selected capability resumes without changing into a provider loop", async () => {
  const writes = [];
  const options = { toolHandlers: recording(writes), agentDecisions: {
    "agent:agent.continuation/Coordinator": { target_ref: ref("Work"), arguments: { value: "selected" } },
  } };
  const paused = await executeAirDocument(air, { ...options, entryRef: ref("RunDelegation"), inputs: { value: "parent" }, durableHumanApprovals: true });
  assert.equal(paused.reason, "human_approval_pending", JSON.stringify(paused));
  assert.equal(paused.checkpoint.call_stack[1].decision_mode, "single");
  const result = await resume(paused.checkpoint, { toolHandlers: recording(writes),
    agentDecisionProvider: () => { throw new Error("Must not consult a provider for a completed host selection"); } });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "selected");
  assert.deepEqual(writes, ["before", "selected"]);
});

test("agent continuation authority, types, step history and scope are checked before a resumed dispatch", async () => {
  let dispatches = 0;
  const options = { toolHandlers: { "tool:agent.continuation/Record": ({ arguments: args }) => { dispatches++; return args.value; } },
    agentDecisionProviderInitialMode: "capabilities", agentDecisionProvider: () => {
      dispatches++; return { target_ref: ref("Work"), arguments: { value: "child" } };
    } };
  const first = await executeAirDocument(air, { ...options, entryRef: ref("RunDelegation"), inputs: { value: "parent" }, durableHumanApprovals: true });
  const second = await resume(first.checkpoint, options);
  assert.equal(second.reason, "human_approval_pending", JSON.stringify(second));
  const before = dispatches;
  for (const corrupt of [
    f => { f.agent_ref = "agent:agent.continuation/Reviewer"; }, f => { f.target_ref = ref("Run"); },
    f => { f.capability_refs.push(ref("Run")); }, f => { f.arguments.value = 123; },
    f => { delete f.max_steps; }, f => { f.next_step_index++; }, f => { f.observations = []; },
    f => { f.observations[0].step_index = 3; }, f => { f.observations[0].target_ref = ref("Run"); },
    f => { delete f.observations[0].arguments; },
    f => { f.observations[0].arguments.value = false; }, f => { f.observations[0].value = false; },
    f => { f.decision_mode = "single"; }, f => { f.caller_scope.active_agent_ref = f.agent_ref; },
    f => { f.caller_scope.values["value:value"] = false; },
  ]) {
    const checkpoint = structuredClone(second.checkpoint); corrupt(checkpoint.call_stack[1]);
    const invalid = await resume(checkpoint, options);
    assert.equal(invalid.status, "failure", JSON.stringify(invalid));
    assert.match(invalid.reason, /HumanApprovalCheckpoint/);
    assert.equal(dispatches, before);
  }
});

test("resumed agent loops retain their original step and global provider ceilings", async () => {
  const writes = [], seen = [];
  const options = { toolHandlers: recording(writes), agentDecisionProviderInitialMode: "capabilities",
    agentDecisionProvider: request => { seen.push([request.step_index, request.mode]);
      return { target_ref: ref("Work"), arguments: { value: "child" } }; } };
  const paused = await executeAirDocument(air, { ...options, entryRef: ref("RunDelegation"), inputs: { value: "parent" },
    maxAgentSteps: 1, durableHumanApprovals: true });
  assert.equal(paused.checkpoint.call_stack[1].max_steps, 1);
  const result = await resume(paused.checkpoint, { ...options, maxAgentSteps: 8 });
  assert.equal(result.reason, "AgentStepLimitExceeded", JSON.stringify(result));
  assert.deepEqual(writes, ["before", "child"]);
  assert.deepEqual(seen.map(s => s[0]), [0, 1]);
  assert.equal(seen[1][1], "finalization");
  const fresh = await executeAirDocument(air, { ...options, entryRef: ref("RunDelegation"), inputs: { value: "parent" },
    maxAgentSteps: 1, durableHumanApprovals: true });
  const before = seen.length;
  const capped = await resume(fresh.checkpoint, { ...options, runLimits: { max_provider_calls: 1 } });
  assert.equal(capped.reason, "AgentDecisionProviderBudgetExceeded", JSON.stringify(capped));
  assert.equal(seen.length, before);
});

test("a paused agent review retains its step ceiling through successive resumptions", async () => {
  const modes = [];
  const options = { agentDecisionProviderInitialMode: "capabilities", agentDecisionProvider: request => {
    if (request.mode === "summary") return { action: "request_capabilities" };
    modes.push([request.step_index, request.mode]);
    return request.mode === "finalization" ? { action: "cannot_complete", reason: "Review is still required." }
      : { action: "request_human_review", review_prompt: "Approve the next step." };
  } };
  let result = await executeAirDocument(air, { ...options, entryRef: ref("RunAgent"), inputs: { value: "parent" },
    maxAgentSteps: 2, durableHumanApprovals: true });
  const invalid = structuredClone(result.checkpoint); delete invalid.agent_loop_state.max_steps;
  assert.equal((await resume(invalid, options)).reason, "InvalidHumanApprovalCheckpoint");
  result = await resume(result.checkpoint, { ...options, maxAgentSteps: 8 });
  assert.equal(result.reason, "human_approval_pending", JSON.stringify(result));
  assert.equal(result.checkpoint.agent_loop_state.max_steps, 2);
  result = await resume(result.checkpoint, { ...options, maxAgentSteps: 8 });
  assert.equal(result.reason, "AgentStepLimitExceeded", JSON.stringify(result));
  assert.deepEqual(modes, [[0, "capabilities"], [1, "capabilities"], [2, "finalization"]]);
});

test("rejection, cancellation and a resumed child failure never become a successful agent observation", async () => {
  const writes = [];
  let providerCalls = 0;
  const options = { toolHandlers: recording(writes), agentDecisionProviderInitialMode: "capabilities",
    agentDecisionProvider: () => { providerCalls++; return { target_ref: ref("Work"), arguments: { value: "child" } }; } };
  for (const decision of ["rejected", "cancelled", "expired"]) {
    providerCalls = 0; writes.length = 0;
    const paused = await executeAirDocument(air, { ...options, entryRef: ref("RunDelegation"), inputs: { value: "parent" }, durableHumanApprovals: true });
    const stopped = await resume(paused.checkpoint, options, decision);
    assert.equal(stopped.status, "stopped", JSON.stringify(stopped));
    assert.equal(stopped.reason, `human_approval_${decision}`);
    assert.equal(providerCalls, 1);
  }
  providerCalls = 0; writes.length = 0;
  const paused = await executeAirDocument(air, { ...options, entryRef: ref("RunDelegation"), inputs: { value: "parent" }, durableHumanApprovals: true });
  const failed = await resume(paused.checkpoint, { ...options, toolHandlers: {
    "tool:agent.continuation/Record": () => { throw new Error("Controlled dispatch failure"); },
  } });
  assert.equal(failed.status, "failure");
  assert.equal(providerCalls, 1);
  assert.equal(failed.trace.events.some(e => e.kind === "agent_capability_result_returned"), false);
  assert.deepEqual(writes, ["before"]);
});

test("nested source calls restore parent loops and scopes without replaying any completed dispatch", async () => {
  const writes = [], options = { toolHandlers: recording(writes) };
  let result = await executeAirDocument(air, { ...options, entryRef: ref("Run"), inputs: { values: ["one", "two"] }, durableHumanApprovals: true });
  for (const [value, expectedWrites] of [["one", ["start", "before"]], ["two", ["start", "before", "one", "before"]], ["finish", ["start", "before", "one", "before", "two"]]]) {
    assert.equal(result.reason, "human_approval_pending", JSON.stringify(result));
    assert.deepEqual(result.checkpoint.context_values, [value]);
    assert.deepEqual(writes, expectedWrites);
    assert.equal(result.checkpoint.call_stack.length, value === "finish" ? 0 : 2);
    assert.doesNotThrow(() => validateHumanCheckpointContinuation(result.checkpoint));
    result = await resume(result.checkpoint, options);
  }
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "done");
  assert.deepEqual(writes, ["start", "before", "one", "before", "two"]);
});

test("recursive source continuations return through every typed frame and enforce depth before effects", async () => {
  const writes = [], options = { toolHandlers: recording(writes) };
  const paused = await executeAirDocument(air, { ...options, entryRef: ref("Recurse"), inputs: { value: "approved", remaining: 4 }, durableHumanApprovals: true });
  assert.equal(paused.checkpoint.call_stack.length, 6);
  const result = await resume(paused.checkpoint, options);
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "approved");
  assert.deepEqual(writes, ["before", "approved"]);
  for (const durableHumanApprovals of [false, true]) {
    const failed = await executeAirDocument(air, { ...options, entryRef: ref("Recurse"), inputs: { value: "unreachable", remaining: 70 }, durableHumanApprovals });
    assert.equal(failed.reason, "InvocationDepthLimitExceeded", JSON.stringify(failed));
    assert.deepEqual(writes, ["before", "approved"]);
  }
});

test("agent review under nested strategies keeps the caller value and does not charge the restored invocation again", async () => {
  const seen = [];
  const ask = request => { seen.push(request.inputs.value); return request.mode === "summary"
    ? { action: "request_capabilities" } : { action: "request_human_review", review_prompt: "Approve this value." }; };
  let result = await executeAirDocument(air, { entryRef: ref("RunAgent"), inputs: { value: "parent" }, durableHumanApprovals: true,
    runLimits: { max_agent_invocations: 1 }, agentDecisionProvider: ask });
  assert.equal(result.checkpoint.call_stack.length, 2);
  result = await resume(result.checkpoint, { agentDecisionProvider: ask });
  assert.equal(result.reason, "human_approval_pending", JSON.stringify(result));
  assert.equal(result.checkpoint.call_stack.length, 2);
  assert.equal(result.checkpoint.budget_counters.agent_invocations, 1);
  result = await resume(result.checkpoint, { agentDecisionProvider: request => {
    seen.push(request.inputs.value); return { action: "answer_directly", result: "reviewed" };
  } });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "parent");
  assert.ok(seen.length >= 3 && seen.every(value => value === "child"));
});

test("the whole stack is validated before any provider or handler resumes", async () => {
  let calls = 0;
  const options = { toolHandlers: { "tool:agent.continuation/Record": () => { calls++; return "recorded"; } } };
  const paused = await executeAirDocument(air, { ...options, entryRef: ref("Run"), inputs: { values: ["one"] }, durableHumanApprovals: true });
  for (const corrupt of [
    c => { delete c.call_stack; }, c => { c.call_frame = c.call_stack[0]; }, c => { c.call_stack.shift(); },
    c => { c.call_stack.reverse(); }, c => { c.call_stack[0].target_ref = ref("Run"); },
    c => { c.call_stack[0].resume_target_ref = "invented"; }, c => { c.call_stack[0].result_binding = "invented"; },
    c => { c.call_stack[0].caller_scope.active_agent_ref = "agent:agent.continuation/Reviewer"; },
    c => { c.active_caller_ref = ref("Run"); }, c => { delete c.call_stack[0].caller_scope.loop_state; },
    c => { c.call_stack[0].caller_scope.loop_state = {}; },
    c => { Object.values(c.call_stack[0].caller_scope.loop_state)[0].index = 0; },
    c => { Object.values(c.call_stack[0].caller_scope.loop_state)[0].index = 2; },
    c => { c.call_stack[0].caller_scope.loop_state.foreign = { index: 0 }; },
    c => { c.call_stack[0].caller_scope.values["value:values"] = 10; }, c => { delete c.loop_state; },
    c => { delete c.next_call_index; }, c => { c.effect_state.next_effect_index = 0; },
  ]) {
    const invalid = structuredClone(paused.checkpoint); corrupt(invalid);
    const result = await resume(invalid, options);
    assert.equal(result.status, "failure", JSON.stringify(result));
    assert.match(result.reason, /HumanApprovalCheckpoint/);
    assert.equal(calls, 2);
  }
});

test("declared failure recovery after a resumed child uses the restored caller, while rejection and budgets stay terminal", async () => {
  const writes = [];
  const options = { toolHandlers: { "tool:agent.continuation/Record": ({ arguments: args }) => {
    writes.push(args.value); if (args.value === "child") throw new Error("Controlled failure"); return args.value;
  } } };
  const paused = await executeAirDocument(air, { ...options, entryRef: "skill:agent.continuation/Recover", inputs: { value: "parent" }, durableHumanApprovals: true });
  const result = await resume(paused.checkpoint, options);
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "parent");
  assert.deepEqual(writes, ["before", "child"]);
  assert.equal(result.trace.events.filter(e => e.kind === "fallback_selected").length, 1);
  const pause = () => executeAirDocument(air, { ...options, entryRef: "skill:agent.continuation/Recover", inputs: { value: "parent" }, durableHumanApprovals: true });
  const rejected = await resume((await pause()).checkpoint, options, "rejected");
  assert.equal(rejected.status, "stopped");
  const budget = await resume((await pause()).checkpoint, { ...options, runLimits: { max_tool_calls: 1 } });
  assert.equal(budget.reason, "ToolCallBudgetExceeded");
  assert.deepEqual(writes, ["before", "child", "before", "before"]);
});

test("a declared recovery can itself pause and resume without retrying the failed child", async () => {
  const writes = [];
  const options = { toolHandlers: { "tool:agent.continuation/Record": ({ arguments: args }) => {
    writes.push(args.value); if (args.value === "child") throw new Error("Controlled failure"); return args.value;
  } } };
  let result = await executeAirDocument(air, { ...options, entryRef: "skill:agent.continuation/RecoverWithReview", inputs: { value: "parent" }, durableHumanApprovals: true });
  assert.equal(result.reason, "human_approval_pending");
  result = await resume(result.checkpoint, options);
  assert.equal(result.reason, "human_approval_pending", JSON.stringify(result));
  assert.deepEqual(result.checkpoint.context_values, ["parent"]);
  assert.equal(result.checkpoint.call_stack[0].kind, "fallback");
  result = await resume(result.checkpoint, options);
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.equal(result.result, "parent");
  assert.deepEqual(writes, ["before", "child"]);
});

test("checkpoint JSON cloning preserves own prototype-like record fields as inert data", () => {
  const value = JSON.parse('{"__proto__":{"polluted":true},"constructor":"value"}');
  const cloned = checkpointJsonClone(value, "value");
  assert.equal(Object.getPrototypeOf(cloned), Object.prototype);
  assert.equal(Object.hasOwn(cloned, "__proto__"), true);
  assert.deepEqual(cloned, value);
  assert.equal({}.polluted, undefined);
  const cyclic = {}; cyclic.self = cyclic;
  for (const invalid of [cyclic, new Map(), new Date(), [undefined], Array(1)]) {
    assert.throws(() => checkpointJsonClone(invalid, "value"), { code: "HumanApprovalCheckpointValueNotPortable" });
  }
});

test("a secret retained only by an ancestor cannot enter a nested checkpoint, including escaped strings", async () => {
  for (const secret of ['secret"quoted', "secret\nline", "secret\\slash"]) {
    const result = await executeAirDocument(air, {
      entryRef: ref("RunAgent"), inputs: { value: secret }, durableHumanApprovals: true,
      secretStore: loadSecretsFromJson(JSON.stringify({ secrets_version: "touba-secrets-v1",
        secrets: { TOKEN: { source: "env", name: "TOKEN" } } }), { env: { TOKEN: secret } }),
      agentDecisionProvider: request => request.mode === "summary"
        ? { action: "request_capabilities" } : { action: "request_human_review", review_prompt: "Approve." },
    });
    assert.equal(result.reason, "SecretValueInHumanApprovalCheckpoint", JSON.stringify(result));
    assert.equal(result.checkpoint, undefined);
    assert.equal(JSON.stringify(result.trace).includes(JSON.stringify(secret).slice(1, -1)), false);
  }
});

test("the real CLI resumes nested checkpoints across fresh processes with exactly the recorded effects", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-nested-resume-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const airPath = join(root, "source.air.json"), manifest = join(root, "manifest.json");
  const handler = join(root, "handler.mjs"), marker = join(root, "calls.jsonl");
  writeFileSync(airPath, JSON.stringify(air));
  writeFileSync(handler, `import { appendFileSync } from "node:fs";
let input = ""; for await (const chunk of process.stdin) input += chunk;
const request = JSON.parse(input);
if (request.protocol !== "touba-tool-handler-v1" || request.operation !== "invoke") throw new Error("Invalid protocol");
const value = request.arguments.value;
appendFileSync(${JSON.stringify(marker)}, JSON.stringify(value) + "\\n");
process.stdout.write(JSON.stringify({ok:true,value}));
`);
  writeFileSync(manifest, JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:agent.continuation/Record": { handler: { kind: "process", command: process.execPath, args: [handler] },
      effect_contract: { kind: "none" }, grants: [], timeout_ms: 5000, max_payload_bytes: 65536 },
  } }));
  // The log is test instrumentation; this handler declares no business effect.
  const cli = fileURLToPath(new URL("../src/run.mjs", import.meta.url));
  const previousPath = join(root, "previous-checkpoint.json");
  const previous = '{"previous":true}\n';
  writeFileSync(previousPath, previous);
  linkSync(previousPath, join(root, "checkpoint-0.json"));
  let checkpoint;
  for (let turn = 0; turn < 4; turn++) {
    const outputPath = join(root, `checkpoint-${turn}.json`);
    const args = [cli, airPath, "--entry", ref("Run"), "--manifest", manifest, "--human-checkpoint-out", outputPath, "--output", "trace"];
    if (checkpoint) args.push("--human-resume-checkpoint", checkpoint.path, "--human-decisions-json", JSON.stringify({ [checkpoint.value.approval_ref]: "approved" }));
    else args.push("--inputs-json", JSON.stringify({ values: ["one", "two"] }));
    const run = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(run.status, turn === 3 ? 0 : 3, run.stderr + run.stdout);
    if (turn < 3) checkpoint = { path: outputPath, value: JSON.parse(readFileSync(outputPath, "utf8")) };
  }
  assert.equal(readFileSync(previousPath, "utf8"), previous);
  assert.deepEqual(readFileSync(marker, "utf8").trim().split("\n").map(JSON.parse), ["start", "before", "one", "before", "two"]);
});
