import test from "node:test";
import assert from "node:assert/strict";
import { createDecisionWireSchema } from "../src/decision-wire-schema.mjs";
import { agentResultSchema } from "../src/decision-contract.mjs";
import { createAiSdkDecisionProvider } from "../src/index.mjs";

const fields = [
  { name: "amount", type_ref: "builtin:Int" },
  { name: "label", type_ref: "builtin:Text" },
];
const output = { output_type: "type:invoice/Reading", output_fields: [
  ...Array.from({ length: 5 }, (_, i) => ({ name: `field${i}`, type_ref: "optional:type:invoice/Amount", fields })),
  { name: "lines", type_ref: "list:optional:builtin:Text" },
  { name: "nested", type_ref: "optional:optional:builtin:Int" },
  { name: "collision", type_ref: "optional:type:invoice/Flag", fields: [{ name: "present", type_ref: "builtin:Boolean" }] },
] };
const request = () => ({ protocol: "touba-agent-decision-v1", mode: "capabilities", agent_ref: "agent:invoice/Reader",
  capability_refs: [], capabilities: [], agent_signature: output,
  model_input: { protocol: "touba-agent-model-input-v1", mode: "capabilities", agent: { signature: output },
    user_input: { value: "Read this invoice." }, agent_state: {}, decision_policy: {}, output_contract: {} } });
const wireValue = () => ({
  ...Object.fromEntries(Array.from({ length: 5 }, (_, i) => [`field${i}`, { present: i % 2 === 0, amount: i, label: "item" }])),
  lines: [{ present: false, value: "" }, { present: true, value: "line" }],
  nested: { present: true, value: { present: false, value: 0 } },
  collision: { present: true, value: { present: false } },
});

test("flat optional representation removes optional unions and preserves nested values and field-name collisions", () => {
  const wire = createDecisionWireSchema(agentResultSchema(request()), "flat_optionals");
  assert.equal(JSON.stringify(wire.schema).includes("anyOf"), false);
  const decoded = wire.decode(wireValue());
  assert.deepEqual(decoded.field0, { present: true, value: { amount: 0, label: "item" } });
  assert.deepEqual(decoded.field1, { present: false });
  assert.deepEqual(decoded.lines, [{ present: false }, { present: true, value: "line" }]);
  assert.deepEqual(decoded.nested, { present: true, value: { present: false } });
  assert.deepEqual(decoded.collision, { present: true, value: { present: false } });
});

test("malformed optional representations are rejected before decoding, including absent payloads", () => {
  const wire = createDecisionWireSchema(agentResultSchema(request()), "flat_optionals");
  for (const field of [null, {}, { present: "true", amount: 1, label: "x" },
    { present: false }, { present: false, amount: "1", label: "x" },
    { present: true, amount: 1, label: "x", extra: 1 }]) {
    const value = wireValue(); value.field0 = field;
    assert.throws(() => wire.decode(value), { code: "InvalidModelDecision" });
  }
});

for (const decisionInterface of ["structured", "native"]) test(`${decisionInterface} applies the same checked adaptation for Anthropic models`, async () => {
  let sent;
  const provider = createAiSdkDecisionProvider({ model: { provider: "anthropic.messages", modelId: "offline-schema-test" },
    history: false, source: "test", allowHumanReview: false, decisionInterface, jsonSchema: schema => schema,
    generateObject: async options => {
      sent = options;
      return { finishReason: "stop", object: { decision: { action: "answer_directly", source: "test", reason: "Read.", result: wireValue() } } };
    },
    generateText: async options => {
      sent = options;
      return { finishReason: "tool-calls", toolCalls: [{ toolName: "touba_finish", input: { reason: "Read.", result: wireValue() } }] };
    },
  });
  const result = await provider(request());
  assert.deepEqual(result.result.field1, { present: false });
  assert.match(sent.system, /boolean present flag/);
  const schema = sent.schema ?? sent.tools.touba_finish.inputSchema;
  assert.equal(JSON.stringify(schema).includes('"const":false'), false);
});

test("schema encoding option is explicit and validated", () => {
  assert.throws(() => createAiSdkDecisionProvider({ schemaEncoding: "permissive" }), { code: "InvalidDecisionProviderOptions" });
});
