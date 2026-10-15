import test, { before, after } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { executeAirDocument, loadAirFromJson } from "../../runtime/touba-runtime/src/index.mjs";
import { createAiSdkDecisionProvider } from "../../runtime/touba-handler-sdk/src/index.mjs";

const implementationRoot = fileURLToPath(new URL("../../", import.meta.url));
const moduleName = "regression.reusable_capabilities";
const skillRef = `skill:${moduleName}/Transform`;
const toolRef = `tool:${moduleName}/Compute`;
const hiddenRef = `tool:${moduleName}/Unlisted`;
const source = `module ${moduleName}

tool Compute
    description "Double one integer with a local handler."
    takes item as Int
    gives Int

tool Unlisted
    description "An operation not exposed to the current agent."
    takes item as Int
    gives Int

skill Transform
    description "Transform one integer through the declared computation tool."
    takes item as Int
    gives Int
    uses Compute
    do
        Compute
            with item as item
            into transformed
        give transformed

agent Calculator
    takes start as Int
    gives Int
    responsibility "Compute the requested integer transformations and return a typed result."
    uses Transform
    callable_by strategy Run

strategy Run
    takes start as Int
    gives Int
    uses Calculator
    do
        Calculator
            with start as start
            into result
        give result
`;

let temporaryRoot;
let document;
let listDocument;

before(() => {
  temporaryRoot = mkdtempSync(path.join(tmpdir(), "touba-agent-reuse-source-"));
  document = compileSource("integers.tb", source);
  listDocument = compileSource(
    "lists.tb",
    source.replaceAll("as Int", "as List of Text").replaceAll("gives Int", "gives List of Text"),
  );
});

after(() => {
  if (temporaryRoot) rmSync(temporaryRoot, { recursive: true, force: true });
});

// These scripted providers exercise protocol/runtime invariants. They are not
// a model-quality benchmark and make no claim about autonomous task success.
test("compiled source reuses one skill with changed and identical arguments", async () => {
  const handlerInputs = [];
  const result = await executeAirDocument(document, {
    inputs: { start: 2 },
    maxAgentSteps: 3,
    runLimits: { max_tool_calls: 3, max_provider_calls: 7 },
    toolHandlers: { [toolRef]: localDoubleHandler(handlerInputs) },
    agentDecisionProvider: sequenceProvider([2, 4, 4]),
  });

  assert.equal(result.status, "success");
  assert.equal(result.result, 20);
  assert.deepEqual(handlerInputs, [2, 4, 4]);
  assert.deepEqual(selectedRefs(result), [skillRef, skillRef, skillRef]);
  const selections = events(result, "agent_capability_selected");
  assert.equal(selections[0].payload.repeated_from_step, undefined);
  assert.equal(selections[1].payload.repeated_from_step, undefined);
  assert.equal(selections[2].payload.repeated_from_step, 1);
  assert.equal(selections[2].payload.identical_invocation_number, 2);
  assert.equal(Object.hasOwn(selections[2].payload, "arguments"), false);
  assert.equal(events(result, "agent_direct_answer_returned")[0].payload.decision_phase, "finalization");
  assert.equal(events(result, "agent_interface_result_returned")[0].payload.output_type, "builtin:Int");
  assert.deepEqual(
    events(result, "budget_consumed")
      .filter((event) => event.payload.budget_kind === "max_tool_calls")
      .map((event) => event.payload.consumed_value),
    [1, 2, 3],
  );
});

test("a provider without a terminal branch repeats honestly until refusal, not fake completion", async () => {
  const effects = [];
  const observed = [];
  const result = await executeAirDocument(document, {
    inputs: { start: 2 }, maxAgentSteps: 3,
    toolHandlers: { [toolRef]: ({ arguments: args }) => { effects.push(structuredClone(args)); return args.item * 2; } },
    agentDecisionProvider: (request) => {
      observed.push(structuredClone(request.observations));
      if (request.mode === "summary") return { action: "request_capabilities" };
      return { target_ref: skillRef, arguments: { item: 2 } };
    },
  });
  assert.equal(result.status, "failure");
  assert.ok(errorCodes(result).includes("AgentStepLimitExceeded"));
  assert.deepEqual(effects, [{ item: 2 }, { item: 2 }, { item: 2 }]);
  assert.deepEqual(observed.at(-1).map((item) => item.value), [4, 4, 4]);
  assert.deepEqual(observed.at(-1).slice(1).map((item) => [item.repeated_from_step, item.identical_invocation_number]), [[0, 2], [0, 3]]);
  assert.equal(events(result, "agent_direct_answer_returned").length, 0);
});

test("compiled agent signature and repeated calls cross the real SDK schema adapter", async () => {
  const handlerInputs = [];
  const providerModes = [];
  const values = [2, 4, 4];
  const providerSource = "scripted_sdk_integration_test";
  const provider = createAiSdkDecisionProvider({
    source: providerSource,
    allowHumanReview: false,
    maxRetries: 0,
    model: (request) => {
      assert.equal(request.agent_signature.output_type, "builtin:Int");
      return "scripted-no-network-model";
    },
    // Keep the SDK's actual jsonSchema adapter; only generation is scripted.
    // No provider model is invoked and this is not a model-quality evaluation.
    generateObject: async (call) => {
      const context = JSON.parse(call.system.split("\n\nRuntime context: ").at(-1));
      const data = JSON.parse(call.prompt);
      const prompt = { ...context, agent_state: { ...context.agent_state, observations: data.observations } };
      const schema = call.schema.jsonSchema ?? call.schema;
      const mode = prompt.runtime_contract.mode;
      const state = prompt.agent_state;
      providerModes.push(mode);
      assert.equal(prompt.agent.signature.output_type, "builtin:Int");
      assert.equal(call.model, "scripted-no-network-model");
      assert.deepEqual((mode === "capabilities" ? schema : schema.properties.decision.anyOf[0]).properties.source.enum, [providerSource]);
      assert.deepEqual(state.used_capability_refs, state.step_index === 0 ? [] : [skillRef]);

      if (mode === "capabilities") {
        assert.deepEqual(state.available_capability_refs, [skillRef]);
        assert.deepEqual(schema.properties.target_ref.enum, [skillRef]);
        assert.deepEqual(schema.properties.arguments.properties.item, { type: "integer" });
        assert.deepEqual(schema.properties.arguments.required, ["item"]);
        return { finishReason: "stop", response: { body: { object: "response", status: "completed" } }, object: {
          action: "select_capability",
          target_ref: skillRef,
          arguments: { item: values[state.step_index] },
          source: providerSource,
          reason: "Exercise the next declared integer transformation.",
          review_prompt: "",
        } };
      }

      assert.deepEqual(schema.properties.decision.anyOf.map(branch => branch.properties.result), [
        { type: "integer" },
        { type: "string", enum: [""] },
      ]);
      if (mode === "summary") {
        assert.deepEqual(state.available_capability_refs, [skillRef]);
        assert.ok(schema.properties.decision.anyOf.some(branch => branch.properties.action.enum.includes("request_capabilities")));
        return { finishReason: "stop", response: { body: { object: "response", status: "completed" } }, object: { decision: {
          action: "request_capabilities",
          source: providerSource,
          reason: "Another invocation is needed, including a previously used capability.",
          result: "",
        } } };
      }

      assert.equal(mode, "finalization");
      assert.deepEqual(state.available_capability_refs, []);
      assert.deepEqual(schema.properties.decision.anyOf.map(branch => branch.properties.action.enum[0]), ["answer_directly", "cannot_complete"]);
      assert.deepEqual(state.observations.map((observation) => observation.value), [4, 8, 8]);
      return { finishReason: "stop", response: { body: { object: "response", status: "completed" } }, object: { decision: {
        action: "answer_directly",
        source: providerSource,
        reason: "Return the integer sum computed from the three runtime observations.",
        result: state.observations.reduce((sum, observation) => sum + observation.value, 0),
      } } };
    },
  });

  const result = await executeAirDocument(document, {
    inputs: { start: 2 },
    maxAgentSteps: 3,
    runLimits: { max_tool_calls: 3, max_provider_calls: 7 },
    toolHandlers: { [toolRef]: localDoubleHandler(handlerInputs) },
    agentDecisionProvider: provider,
  });

  assert.equal(result.status, "success", JSON.stringify(errorCodes(result)));
  assert.equal(result.result, 20);
  assert.deepEqual(handlerInputs, values);
  assert.deepEqual(selectedRefs(result), [skillRef, skillRef, skillRef]);
  assert.deepEqual(providerModes, [
    "summary", "capabilities", "summary", "capabilities", "summary", "capabilities", "finalization",
  ]);
});

test("repeated capability calls still stop before a tool dispatch over quota", async () => {
  const handlerInputs = [];
  const result = await executeAirDocument(document, {
    inputs: { start: 2 },
    maxAgentSteps: 3,
    runLimits: { max_tool_calls: 2, max_provider_calls: 7 },
    toolHandlers: { [toolRef]: localDoubleHandler(handlerInputs) },
    agentDecisionProvider: sequenceProvider([2, 4, 4]),
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(handlerInputs, [2, 4]);
  assert.ok(errorCodes(result).includes("ToolCallBudgetExceeded"));
  assert.equal(events(result, "dispatch_refused_budget_exceeded").length, 1);
});

test("reusing an allowed capability never authorizes an unlisted target", async () => {
  const handlerInputs = [];
  let hiddenCalls = 0;
  const result = await executeAirDocument(document, {
    inputs: { start: 2 },
    maxAgentSteps: 3,
    toolHandlers: {
      [toolRef]: localDoubleHandler(handlerInputs),
      [hiddenRef]: () => { hiddenCalls += 1; return 0; },
    },
    agentDecisionProvider: sequenceProvider([2, 4, 4], { lastTarget: hiddenRef }),
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(handlerInputs, [2, 4]);
  assert.equal(hiddenCalls, 0);
  assert.ok(errorCodes(result).includes("AgentCapabilityNotAllowed"));
});

test("provider values must match a compiled skill input before its graph executes", async () => {
  const handlerInputs = [];
  const result = await executeAirDocument(document, {
    inputs: { start: 2 },
    toolHandlers: { [toolRef]: localDoubleHandler(handlerInputs) },
    agentDecisionProvider: sequenceProvider(["not-an-integer"]),
  });

  assert.equal(result.status, "failure");
  assert.deepEqual(handlerInputs, []);
  assert.ok(errorCodes(result).includes("AgentCapabilityArgumentsInvalid"));
  assert.equal(result.trace.events.some((event) => event.air_ref?.owner_ref === skillRef), false);
});

for (const inputs of [{ start: 2 }, { start: 2, item: "not-an-integer" }, { start: 2, item: 3 }]) {
  test(`omitted capability arguments cannot capture undeclared caller inputs: ${JSON.stringify(inputs)}`, async () => {
    const handlerInputs = [];
    let providerCalls = 0;
    const result = await executeAirDocument(document, {
      inputs,
      toolHandlers: { [toolRef]: localDoubleHandler(handlerInputs) },
      agentDecisionProvider: (request) => {
        providerCalls++;
        assert.deepEqual(request.inputs, { start: 2 });
        return request.mode === "summary"
          ? { action: "request_capabilities" }
          : { action: "select_capability", target_ref: skillRef };
      },
    });

    assert.equal(result.status, "failure");
    assert.deepEqual(handlerInputs, []);
    assert.ok(errorCodes(result).includes(Object.hasOwn(inputs, "item") ? "EntryInputSchemaInvalid" : "AgentCapabilityArgumentsInvalid"));
    if (Object.hasOwn(inputs, "item")) assert.equal(providerCalls, 0, "undeclared entry fields are refused before the provider");
    assert.equal(result.trace.events.some((event) => event.air_ref?.owner_ref === skillRef), false);
  });
}

test("compiled agent List of Text accepts a correctly typed direct answer", async () => {
  const agent = listDocument.definitions.agents[0];
  assert.equal(agent.signature.output_type, "list:builtin:Text");
  const result = await executeAirDocument(listDocument, {
    inputs: { start: ["first"] },
    agentDecisionProvider: () => ({ action: "answer_directly", result: ["first", "second"] }),
  });
  assert.equal(result.status, "success");
  assert.deepEqual(result.result, ["first", "second"]);
});

for (const invalidValue of ["not-a-list", [1], ["valid", false]]) {
  test(`compiled agent rejects an invalid List of Text input: ${JSON.stringify(invalidValue)}`, async () => {
    let providerCalls = 0;
    const result = await executeAirDocument(listDocument, {
      inputs: { start: invalidValue },
      agentDecisionProvider: () => {
        providerCalls += 1;
        return { action: "answer_directly", result: [] };
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(providerCalls, 0);
    assert.ok(errorCodes(result).includes("EntryInputSchemaInvalid"));
  });

  test(`compiled agent rejects an invalid List of Text answer: ${JSON.stringify(invalidValue)}`, async () => {
    const result = await executeAirDocument(listDocument, {
      inputs: { start: ["first"] },
      agentDecisionProvider: () => ({ action: "answer_directly", result: invalidValue }),
    });
    assert.equal(result.status, "failure");
    assert.ok(errorCodes(result).includes("AgentInterfaceResultTypeMismatch"));
  });
}

function localDoubleHandler(handlerInputs) {
  return ({ arguments: args }) => {
    handlerInputs.push(args.item);
    return args.item * 2;
  };
}

function sequenceProvider(values, { lastTarget = skillRef } = {}) {
  return (request) => {
    if (request.mode === "finalization" || request.observations.length === values.length) {
      return {
        action: "answer_directly",
        result: request.observations.reduce((sum, observation) => sum + observation.value, 0),
      };
    }
    if (request.mode === "summary") return { action: "request_capabilities" };
    return {
      action: "select_capability",
      target_ref: request.step_index === values.length - 1 ? lastTarget : skillRef,
      arguments: { item: values[request.step_index] },
    };
  };
}

function compileSource(name, text) {
  const sourcePath = path.join(temporaryRoot, name);
  writeFileSync(sourcePath, text, "utf8");
  const result = spawnSync(
    process.env.CARGO ?? "cargo",
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath],
    { cwd: implementationRoot, encoding: "utf8", timeout: 60_000 },
  );
  if (result.error) throw result.error;
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return loadAirFromJson(result.stdout);
}

function events(result, kind) {
  return result.trace.events.filter((event) => event.kind === kind);
}

function selectedRefs(result) {
  return events(result, "agent_capability_selected").map((event) => event.payload.selected_ref);
}

function errorCodes(result) {
  return events(result, "failure_detected").map((event) => event.payload.runtime_error_code);
}
