import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeAirDocument, loadToolBindingManifestFromJson } from "../../../runtime/touba-runtime/src/index.mjs";
import { validateAirDocument } from "../../../runtime/touba-runtime/src/air-runtime-profile.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";
import { prepareProject } from "../../touba-project/src/project.mjs";
import { generateSupplyChainLock } from "../../touba-supply-chain/src/generate.mjs";

const implementation = fileURLToPath(new URL("../../../", import.meta.url));
const source = readFileSync(new URL("../../../grammar/tree-sitter-touba/examples/budgets-bq1/source-limits.tb", import.meta.url), "utf8");
const limits = source.slice(source.indexOf("limits run"), source.indexOf("tool Normalize"));
const pure = `module budgets.pure\n${limits}\nfunction Ready\n    gives Text\n    do\n        give "ready"\n`;
const profile = join(implementation, "contracts/hardened/profile.json");
const tool = "tool:budgets.source/Normalize";
function workspace(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-source-budgets-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function compile(t, code = source) {
  const path = join(workspace(t), "source.tb");
  writeFileSync(path, code);
  return JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "-p", "touba-cli", "--bin", "touba-compile", "--", path], { cwd: implementation, encoding: "utf8" }));
}
const failureCode = result => result.trace.events.findLast(event => event.payload?.runtime_error_code)?.payload.runtime_error_code;

const pausedSource = `module budgets.paused
limits run
    max_run_ms as 100
    max_steps as 30
    max_tool_calls as 3
tool Normalize
    gives Text
skill Review
    gives Text
    uses Normalize
    do
        Normalize
            into first
        human.approve
            with context as first
            into approval
        Normalize
            into second
        Normalize
            into third
        give third
`;

test("human resume retains active time and removed or widened host ceilings", async t => {
  const air = compile(t, pausedSource);
  for (const elapsed of [40, 60]) {
    let now = 0, calls = 0;
    const options = { entryRef: "skill:budgets.paused/Review", durableHumanApprovals: true, now: () => now,
      toolHandlers: { "tool:budgets.paused/Normalize": () => { calls++; now += elapsed; return "normalized"; } } };
    const paused = await executeAirDocument(air, { ...options, runLimits: { max_tool_calls: 2, max_run_ms: 90 } });
    assert.equal(paused.reason, "human_approval_pending", JSON.stringify(paused));
    assert.equal(paused.checkpoint.active_elapsed_ms, elapsed);
    assert.equal(paused.checkpoint.effective_limits.max_tool_calls, 2);
    now += 86400000; // Waiting for a human is not active execution time.
    const resumed = await executeAirDocument(air, { ...options, runLimits: { max_tool_calls: 30, max_run_ms: 900 },
      humanApprovalResumeCheckpoint: paused.checkpoint,
      humanApprovalDecisions: { [paused.checkpoint.approval_ref]: "approved" } });
    assert.equal(calls, 2);
    assert.equal(resumed.status, "failure");
    assert.equal(failureCode(resumed), elapsed === 40 ? "ToolCallBudgetExceeded" : "RunTimeBudgetExceeded");
    const limits = resumed.trace.events.filter(event => event.kind === "budget_limit_checked");
    assert.equal(limits.find(e => e.payload.budget_kind === "max_tool_calls").payload.limit_value, 2);
    assert.equal(limits.find(e => e.payload.budget_kind === "max_tool_calls").payload.authority_source, "checkpoint");
  }
});

test("missing or malformed checkpoint budget state is refused without provider or handler execution", async t => {
  const air = compile(t, pausedSource);
  let calls = 0;
  const options = { entryRef: "skill:budgets.paused/Review", durableHumanApprovals: true, now: () => 0,
    toolHandlers: { "tool:budgets.paused/Normalize": () => { calls++; return "normalized"; } } };
  const paused = await executeAirDocument(air, options);
  assert.equal(paused.reason, "human_approval_pending");
  for (const mutate of [c => { delete c.active_elapsed_ms; }, c => { delete c.effective_limits; },
    c => { delete c.budget_counters.tool_calls; }, c => { c.budget_counters.tool_calls = -1; },
    c => { c.effective_limits.max_tool_calls = 0; }, c => { c.effective_limits.max_usd = 2; },
    c => { c.active_elapsed_ms = NaN; }]) {
    const checkpoint = structuredClone(paused.checkpoint); mutate(checkpoint);
    const refused = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: checkpoint,
      humanApprovalDecisions: { [checkpoint.approval_ref]: "approved" } });
    assert.equal(refused.status, "failure");
    assert.equal(failureCode(refused), "InvalidHumanApprovalCheckpoint");
    assert.equal(calls, 1);
  }
});

test("a newly tightened resume limit includes usage that originally had no ceiling", async t => {
  const air = compile(t, pausedSource.replace("    max_tool_calls as 3\n", ""));
  let calls = 0;
  const options = { entryRef: "skill:budgets.paused/Review", durableHumanApprovals: true, now: () => 0,
    toolHandlers: { "tool:budgets.paused/Normalize": () => { calls++; return "normalized"; } } };
  const paused = await executeAirDocument(air, options);
  assert.equal(paused.checkpoint.budget_counters.tool_calls, 1);
  const result = await executeAirDocument(air, { ...options, runLimits: { max_tool_calls: 1 },
    humanApprovalResumeCheckpoint: paused.checkpoint, humanApprovalDecisions: { [paused.checkpoint.approval_ref]: "approved" } });
  assert.equal(calls, 1);
  assert.equal(failureCode(result), "ToolCallBudgetExceeded");
});

test("source budget allows repeated tool use and refuses the first excess call before dispatch", async t => {
  const air = compile(t);
  const calls = [];
  const result = await executeAirDocument(air, { entryRef: "skill:budgets.source/Repeat", inputs: { value: "incident" },
    toolHandlers: { [tool]: ({ arguments: args }) => { calls.push(args.value); return args.value + "!"; } } });
  assert.deepEqual(calls, ["incident", "incident!"]);
  assert.equal(result.status, "failure");
  assert.equal(failureCode(result), "ToolCallBudgetExceeded");
  const evidence = result.trace.events.find(event => event.kind === "dispatch_refused_budget_exceeded");
  assert.equal(evidence.payload.consumed_value, 2);
});

test("source agent and provider limits are run-wide, not reset for each invocation", async t => {
  for (const [code, reason, count] of [[source, "AgentInvocationBudgetExceeded", 2],
    [source.replace("max_provider_calls as 2", "max_provider_calls as 1"), "AgentDecisionProviderBudgetExceeded", 1]]) {
    let calls = 0;
    const result = await executeAirDocument(compile(t, code), { entryRef: "strategy:budgets.source/Review", inputs: { request: "incident" },
      agentDecisionProvider() { calls++; return { action: "answer_directly", result: "diagnosed" }; } });
    assert.equal(calls, count);
    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), reason);
  }
});

test("host limits restrict source limits and a manifest cannot widen them", async t => {
  const air = compile(t);
  let calls = 0;
  const handlers = { [tool]: () => { calls++; return "normalized"; } };
  const options = { entryRef: "skill:budgets.source/Repeat", inputs: { value: "incident" }, toolHandlers: handlers };
  const restricted = await executeAirDocument(air, { ...options, runLimits: { max_tool_calls: 1 } });
  assert.equal(calls, 1);
  assert.equal(failureCode(restricted), "ToolCallBudgetExceeded");
  const manifest = loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: "touba-manifest-v1", run_limits: { max_tool_calls: 3 }, bindings: {} }));
  const widened = await executeAirDocument(air, { ...options, toolBindingManifest: manifest });
  assert.equal(calls, 1);
  assert.equal(failureCode(widened), "BudgetExceeded");
});

test("source counters survive human pauses without replaying completed calls", async t => {
  const code = source + `\nskill Paused\n    takes notes as List of Text\n    gives Text\n    uses Normalize\n    do\n        for note in notes\n            human.approve\n                with context as note\n                into approval\n            Normalize\n                with value as note\n                into normalized\n        give "done"\n`;
  const air = compile(t, code);
  const calls = [];
  const options = { entryRef: "skill:budgets.source/Paused", durableHumanApprovals: true,
    toolHandlers: { [tool]: ({ arguments: args }) => { calls.push(args.value); return args.value; } } };
  let result = await executeAirDocument(air, { ...options, inputs: { notes: ["first", "second", "third"] } });
  for (let index = 0; index < 3; index++) {
    assert.equal(result.reason, "human_approval_pending", JSON.stringify(result));
    assert.equal(result.checkpoint.budget_counters.tool_calls, index);
    result = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: result.checkpoint,
      humanApprovalDecisions: { [result.checkpoint.approval_ref]: "approved" } });
  }
  assert.deepEqual(calls, ["first", "second"]);
  assert.equal(result.status, "failure");
  assert.equal(failureCode(result), "ToolCallBudgetExceeded");
});

test("runtime rejects altered budget kinds, values and fields before any execution", t => {
  const air = compile(t);
  for (const mutate of [a => { a.budgets.run.max_steps.value = 0; }, a => { a.budgets.run.max_steps.value = 1.5; },
    a => { a.budgets.run.max_steps.value = 9007199254740992; }, a => { delete a.budgets.run.max_steps.source_ref; },
    a => { a.budgets.run.max_usd = a.budgets.run.max_steps; }, a => { a.budgets.run.max_steps.unlimited = true; }]) {
    const altered = structuredClone(air); mutate(altered);
    assert.throws(() => validateAirDocument(altered), { code: "InvalidAirDocument" });
    assert.throws(() => validateAirMachineContract(altered));
  }
});

test("prepared multi-module project keeps the same minimum and provenance as the compiler", async t => {
  const root = workspace(t);
  mkdirSync(join(root, "src/budgets"), { recursive: true });
  writeFileSync(join(root, "src/budgets/pure.tb"), pure.replace("limits run", "import type Request from budgets.shared\nlimits run"));
  writeFileSync(join(root, "src/budgets/shared.tb"), `module budgets.shared\nlimits run\n    max_steps as 25\ntype Request\n    value is Text\n`);
  const report = await prepareProject({ root, mode: "write" });
  assert.equal(report.status, "success", JSON.stringify(report));
  const plan = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.run-plan.json"), "utf8"));
  const path = join(root, ".touba/build/dev", plan.air);
  const air = JSON.parse(readFileSync(path, "utf8"));
  assert.equal(air.budgets.run.max_steps.value, 25);
  assert.match(air.budgets.run.max_steps.source_ref.source_id, /shared\.tb$/);
  const direct = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "-p", "touba-cli", "--bin", "touba-compile", "--",
    "--source-root", join(root, "src"), join(root, "src/budgets/pure.tb")], { cwd: implementation, encoding: "utf8" }));
  assert.deepEqual(air.budgets, direct.budgets);
});

test("hardened run-plan uses real source budgets and requires durable checkpoint configuration", async t => {
  for (const missingBudget of [false, true]) {
  const root = workspace(t);
  mkdirSync(join(root, "src/budgets"), { recursive: true });
  writeFileSync(join(root, "src/budgets/pure.tb"), missingBudget ? pure.replace("    max_steps as 100\n", "") : pure);
  const report = await prepareProject({ root, mode: "write" });
  assert.equal(report.status, "success", JSON.stringify(report));
  const planPath = join(root, ".touba/build/dev/touba.run-plan.json");
  const plan = JSON.parse(readFileSync(planPath, "utf8"));
  const air = join(root, ".touba/build/dev", plan.air);
  const lock = join(root, "supply-chain.lock.json");
  generateSupplyChainLock({ air, out: lock });
  const run = args => spawnSync(process.execPath, [join(implementation, "cli/touba-run/src/run.mjs"), "--run-plan", planPath,
    "--entry", "function:budgets.pure/Ready", "--supply-chain-lock", lock, "--hardened-profile", profile, "--output", "json", ...args], { cwd: root, encoding: "utf8" });
  const refused = run([]);
  assert.equal(JSON.parse(refused.stdout).reason, "HardenedDurableCheckpointRequired", refused.stdout + refused.stderr);
  const accepted = run(["--human-checkpoint-out", join(root, "pending.json")]);
  if (missingBudget) {
    assert.equal(accepted.status, 1);
    assert.equal(JSON.parse(accepted.stdout).reason, "HardenedBudgetRequired", accepted.stdout + accepted.stderr);
    continue;
  }
  assert.equal(accepted.status, 0, accepted.stdout + accepted.stderr);
  assert.equal(JSON.parse(accepted.stdout).result, "ready");
  }
});

test("prepared source limits stop a real SDK process handler before its third invocation", async t => {
  const root = workspace(t);
  mkdirSync(join(root, "src/budgets"), { recursive: true });
  writeFileSync(join(root, "src/budgets/source.tb"), source);
  const report = await prepareProject({ root, mode: "write", hostDecisions: { bindings: {
    [tool]: { grants: [], effect_contract: { kind: "none" } },
  } } });
  assert.equal(report.status, "success", JSON.stringify(report));
  const manifest = JSON.parse(readFileSync(report.manifest_path, "utf8"));
  const journal = join(root, "observed-calls.jsonl");
  const sdk = new URL("../../../runtime/touba-handler-sdk/src/index.mjs", import.meta.url).href;
  writeFileSync(join(root, manifest.bindings[tool].handler.args[0]), `import { defineTool } from ${JSON.stringify(sdk)};
import { appendFileSync } from "node:fs";
await defineTool({ toolRef: ${JSON.stringify(tool)}, requiredGrants: [], inputSignature: [{ name: "value", type_ref: "builtin:Text" }], outputType: "builtin:Text",
  run: async ({ request }) => { appendFileSync(${JSON.stringify(journal)}, JSON.stringify(request) + "\\n"); return request + "!"; } });
`);
  const result = spawnSync(process.execPath, [join(implementation, "cli/touba-run/src/run.mjs"),
    "--run-plan", join(root, ".touba/build/dev/touba.run-plan.json"), "--entry", "skill:budgets.source/Repeat",
    "--inputs-json", '{"value":"incident"}', "--output", "json"], { cwd: root, encoding: "utf8" });
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.equal(JSON.parse(result.stdout).reason, "ToolCallBudgetExceeded", result.stdout + result.stderr);
  assert.deepEqual(readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line)), ["incident", "incident!"]);
});
