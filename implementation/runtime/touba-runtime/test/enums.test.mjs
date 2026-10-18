import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { executeAirDocument } from "../src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";
import { agentResultSchema, argumentsSchemaForCapability } from "../../touba-handler-sdk/src/decision-contract.mjs";
import { createAiSdkDecisionProvider } from "../../touba-handler-sdk/src/index.mjs";
import { nativeCapabilityName } from "../../touba-handler-sdk/src/native-decision.mjs";

let air;
before(() => {
  air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
    new URL("../../../Cargo.toml", import.meta.url).pathname, "-p", "touba-cli", "--bin", "touba-compile", "--",
    new URL("../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/enum-business.tb", import.meta.url).pathname], { encoding: "utf8" }));
});
const run = (name, inputs = {}, options = {}) => executeAirDocument(air, { entryRef: `function:orders/${name}`, inputs, ...options });

test("text(enum) returns the canonical declared variant and rejects unknown values", async () => {
  for (const priority of ["low", "normal", "high"]) {
    const output = await run("PriorityText", { priority });
    assert.equal(output.status, "success");
    assert.equal(output.result, priority);
  }
  for (const priority of ["HIGH", "unknown", null, {}]) {
    assert.equal((await run("PriorityText", { priority })).status, "failure");
  }
});

test("compiled enums execute nominal members, constants, record fields and lists", async () => {
  validateAirMachineContract(air);
  for (const [name, inputs, expected] of [
    ["IsUrgent", { priority: "high" }, true], ["IsUrgent", { priority: "low" }, false],
    ["Default", {}, "normal"], ["CreateOrder", { priority: "normal" }, { priority: "normal", title: "Shipment" }],
    ["HasUrgent", { priorities: ["low", "normal", "high"] }, true], ["HasUrgent", { priorities: [] }, false],
  ]) {
    const output = await run(name, inputs);
    assert.equal(output.status, "success", JSON.stringify(output.trace));
    assert.deepEqual(output.result, expected);
  }
});

test("invalid external enum values fail before reaching a human boundary", async () => {
  for (const value of ["hihg", "HIGH", "", null, {}, 0]) {
    const output = await executeAirDocument(air, { entryRef: "strategy:orders/Review", inputs: { priority: value }, durableHumanApprovals: true });
    assert.equal(output.status, "failure");
    assert.equal(output.trace.events.some(event => event.kind === "human_approval_requested"), false);
  }
  const output = await run("HasUrgent", { priorities: ["normal", "invalid"] });
  assert.equal(output.status, "failure");
});

test("enum input survives an actual human checkpoint without conversion", async () => {
  const paused = await executeAirDocument(air, { entryRef: "strategy:orders/Review", inputs: { priority: "high" }, durableHumanApprovals: true });
  assert.equal(paused.status, "stopped");
  const resumed = await executeAirDocument(air, { entryRef: "strategy:orders/Review", durableHumanApprovals: true,
    humanApprovalResumeCheckpoint: JSON.parse(JSON.stringify(paused.checkpoint)),
    humanApprovalDecisions: { [paused.checkpoint.approval_ref]: "approved" } });
  assert.equal(resumed.status, "success", JSON.stringify(resumed.trace));
  assert.equal(resumed.result, "high");
});

test("machine contract rejects forged enum definitions and values before execution", () => {
  for (const mutate of [
    copy => { copy.definitions.types[0].variants = []; },
    copy => { copy.definitions.types[0].variants.push(copy.definitions.types[0].variants[0]); },
    copy => { copy.definitions.types[0].fields.push({ name: "field", type_ref: "builtin:Text" }); },
    copy => { copy.definitions.constants[0].literal_text = "unknown"; },
    copy => { copy.execution_graphs.flatMap(graph => graph.expressions ?? []).find(expression => expression.kind === "enum_value").literal_text = "unknown"; },
  ]) {
    const copy = structuredClone(air);
    mutate(copy);
    assert.throws(() => validateAirMachineContract(copy), error => /^AirEnum/u.test(error.code));
  }
});

test("shared provider schema constrains enum values, including nested lists and results", () => {
  const descriptor = { type_ref: "type:orders/Priority", enum_values: ["low", "normal", "high"] };
  const schema = argumentsSchemaForCapability({ signature: { inputs: [{ name: "priority", ...descriptor }, { name: "priorities", ...descriptor, type_ref: "list:list:type:orders/Priority" }] } });
  assert.deepEqual(schema.properties.priority, { type: "string", enum: descriptor.enum_values });
  assert.deepEqual(schema.properties.priorities.items.items, schema.properties.priority);
  assert.deepEqual(agentResultSchema({ agent_signature: { output_type: descriptor.type_ref, output_enum_values: descriptor.enum_values } }), schema.properties.priority);
});

for (const decisionInterface of ["structured", "native"]) {
  for (const bad of [null, "input", "output", "result"]) test(`real ${decisionInterface} provider mapping validates enum ${bad ?? "success"}`, async () => {
    const target = "tool:orders/EchoPriority";
    let request;
    let dispatches = 0;
    const argumentsValue = { priority: bad === "input" ? "unknown" : "high" };
    const decide = () => request.step_index === 0
      ? { decision: { action: "select_capability", target_ref: target, arguments: argumentsValue, source: "tests", reason: "Read the requested priority.", review_prompt: "" } }
      : { decision: { action: "answer_directly", result: bad === "result" ? "unknown" : "high", source: "tests", reason: "The priority is available." } };
    const provider = createAiSdkDecisionProvider({ model: "fixture", source: "tests", decisionInterface,
      jsonSchema: schema => schema,
      generateText: async options => {
        assert.deepEqual(options.tools[nativeCapabilityName(target)].inputSchema.properties.priority.enum, ["low", "normal", "high"]);
        const call = { toolCallId: "enum-proposal", toolName: nativeCapabilityName(target), input: argumentsValue };
        return { finishReason: "tool-calls", toolCalls: [call],
          response: { messages: [{ role: "assistant", content: [{ type: "tool-call", ...call }] }] } };
      },
      generateObject: async () => ({ finishReason: "stop", object: decide() }),
    });
    const output = await executeAirDocument(air, { entryRef: "strategy:orders/Dispatch", inputs: { request: "Handle the shipping priority." },
      agentDecisionProviderInitialMode: "capabilities", agentDecisionProviderContentMode: "inline",
      agentDecisionProvider: async value => {
        request = value;
        if (value.mode === "capabilities") {
          const capability = value.capabilities.find(candidate => candidate.target_ref === target);
          assert.deepEqual(capability.signature.inputs[0].enum_values, ["low", "normal", "high"]);
          assert.deepEqual(capability.signature.output_enum_values, ["low", "normal", "high"]);
        }
        return provider(value);
      },
      toolHandlers: { [target]: ({ arguments: input }) => { dispatches++; assert.equal(input.priority, "high"); return bad === "output" ? "unknown" : "high"; } },
    });
    assert.equal(output.status, bad === null ? "success" : "failure", JSON.stringify(output.trace));
    assert.equal(dispatches, bad === "input" ? 0 : 1);
    if (bad === null) assert.equal(output.result, "high");
  });
}
