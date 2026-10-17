import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";

const root = new URL("../../../grammar/tree-sitter-touba/examples/imports-im2/agent/typed/", import.meta.url);
const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
  fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--",
  "--source-root", fileURLToPath(root), fileURLToPath(new URL("incident/workflow.tb", root))], { encoding: "utf8" }));
const options = { entryRef: "strategy:incident.workflow/Run", inputs: { request: { query: "Diagnose the incident" } } };
const cycle = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
  fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--",
  fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-agent-revision-cycle.tb", import.meta.url))], { encoding: "utf8" }));

test("the documented revision provider runs through the real CLI with the compiled tutorial source", t => {
  const directory = mkdtempSync(join(tmpdir(), "touba-revision-doc-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const markdown = readFileSync(new URL("../../../../docs/tutoriels/orchestration-multi-agent-sequentielle.md", import.meta.url), "utf8");
  const source = markdown.match(/```touba title="revision\.tb"\n([\s\S]*?)\n```/u)[1];
  const provider = markdown.match(/```js title="providers\/revision\.mjs"\n([\s\S]*?)\n```/u)[1];
  assert.equal(source.trim(), readFileSync(new URL("../../../grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-agent-revision-cycle.tb", import.meta.url), "utf8").trim());
  const airPath = join(directory, "revision.air.json"), providerPath = join(directory, "revision.mjs");
  writeFileSync(airPath, JSON.stringify(cycle));
  writeFileSync(providerPath, provider);
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("../src/run.mjs", import.meta.url)), airPath,
    "--entry", "strategy:agent.revision/Run", "--inputs-json", JSON.stringify({ draft: { text: "Initial draft", accepted: false } }),
    "--agent-decision-provider", providerPath, "--output", "result"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { text: "Initial draft [reviewed]", accepted: true });
});

test("typed revision cycles carry each result into the next invocation and terminate explicitly", async () => {
  for (const acceptAt of [0, 2, 3, 4]) {
    let calls = 0;
    const seen = [];
    const result = await executeAirDocument(cycle, {
      entryRef: "strategy:agent.revision/Run", inputs: { draft: { text: "draft-0", accepted: acceptAt === 0 } },
      agentDecisionProvider(request) {
        seen.push(request.inputs.draft.text);
        calls++;
        return { action: "answer_directly", result: { text: `draft-${calls}`, accepted: calls === acceptAt } };
      },
    });
    assert.equal(calls, Math.min(acceptAt, 3));
    assert.deepEqual(seen, Array.from({ length: calls }, (_, index) => `draft-${index}`));
    if (acceptAt <= 3) {
      assert.equal(result.status, "success", JSON.stringify(result));
      assert.deepEqual(result.result, { text: `draft-${acceptAt}`, accepted: true });
    } else {
      assert.equal(result.status, "stopped");
      assert.equal(result.reason, "explicit_stop");
      assert.equal(result.result, undefined);
    }
  }
});

test("revision recursion cannot reset run-wide agent or provider limits", async () => {
  for (const [kind, code] of [["max_agent_invocations", "AgentInvocationBudgetExceeded"], ["max_provider_calls", "AgentDecisionProviderBudgetExceeded"]]) {
    let calls = 0;
    const result = await executeAirDocument(cycle, {
      entryRef: "strategy:agent.revision/Run", inputs: { draft: { text: "draft-0", accepted: false } }, runLimits: { [kind]: 2 },
      agentDecisionProvider: () => { calls++; return { action: "answer_directly", result: { text: `draft-${calls}`, accepted: false } }; },
    });
    assert.equal(result.reason, code);
    assert.equal(calls, 2);
  }
});

test("compiled imported strategies compose typed agent workflows without resetting budgets", async () => {
  const attempts = [];
  const provider = request => {
    attempts.push(request.inputs.attempt);
    return { action: "answer_directly", result: { summary: "Reviewed", attempt: request.inputs.attempt } };
  };
  const result = await executeAirDocument(air, { ...options, agentDecisionProvider: provider });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(attempts, [1, 2, 1, 2]);
  assert.deepEqual(result.result, { summary: "Reviewed", attempt: 2 });
  const authorized = result.trace.events.filter(e => e.kind === "agent_invocation_authorized");
  assert.equal(authorized.length, 4);
  assert.ok(authorized.every(e => e.payload.caller_ref === "strategy:incident.coordinator/Resolve"));
  attempts.length = 0;
  const exhausted = await executeAirDocument(air, { ...options, agentDecisionProvider: provider, runLimits: { max_agent_invocations: 3 } });
  assert.equal(exhausted.reason, "AgentInvocationBudgetExceeded");
  assert.deepEqual(attempts, [1, 2, 1]);
});

test("strategy subworkflows do not bypass the specialist's callable_by contract", async () => {
  const altered = structuredClone(air);
  altered.definitions.agents.find(a => a.name === "Diagnose").callable_by = [];
  let calls = 0;
  const result = await executeAirDocument(altered, { ...options, agentDecisionProvider: () => { calls++; } });
  assert.equal(result.reason, "UnauthorizedAgentInvocation");
  assert.equal(calls, 0);
});

test("altered strategy arguments fail before entering the nested workflow", async () => {
  const altered = structuredClone(air);
  altered.execution_graphs.find(g => g.owner_ref === options.entryRef).nodes.find(n => n.kind === "call_strategy").arguments = ["literal:string:wrong record type"];
  let calls = 0;
  const result = await executeAirDocument(altered, { ...options, agentDecisionProvider: () => { calls++; } });
  assert.equal(result.reason, "StrategyInputTypeMismatch");
  assert.equal(calls, 0);
});

test("call_strategy cannot be retargeted to an agent or lose its required interface", () => {
  for (const alter of [
    doc => { doc.execution_graphs.find(g => g.owner_ref === options.entryRef).nodes.find(n => n.kind === "call_strategy").target_ref = "agent:incident.specialist/Diagnose"; },
    doc => { delete doc.definitions.strategies.find(s => s.name === "Resolve").signature; },
    doc => { delete doc.execution_graphs.find(g => g.owner_ref === options.entryRef).nodes.find(n => n.kind === "call_strategy").arguments; },
  ]) {
    const doc = structuredClone(air); alter(doc);
    assert.throws(() => validateAirMachineContract(doc), e => ["AirStrategyTargetInvalid", "AirStrategyArgumentsInvalid"].includes(e.code));
  }
});
