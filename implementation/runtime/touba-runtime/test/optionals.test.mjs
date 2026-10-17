import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { executeAirDocument, loadToolBindingManifestFromJson } from "../src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";
import { executeReferenceAir } from "../../../contracts/reference-runtime/runtime.mjs";
import { agentResultSchema, argumentsSchemaForCapability } from "../../touba-handler-sdk/src/decision-contract.mjs";
import { createAiSdkDecisionProvider } from "../../touba-handler-sdk/src/index.mjs";
import { nativeCapabilityName } from "../../touba-handler-sdk/src/native-decision.mjs";

let air;
before(() => {
  air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
    new URL("../../../Cargo.toml", import.meta.url).pathname, "-p", "touba-cli", "--bin", "touba-compile", "--",
    new URL("../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/optional-business.tb", import.meta.url).pathname], { encoding: "utf8" }));
});
const present = value => ({ present: true, value });
const absent = { present: false };
const contact = { address: "user@example.test", channel: "email" };
const run = (name, inputs = {}, options = {}) => executeAirDocument(air, { entryRef: `function:contacts/${name}`, inputs, ...options });

test("compiled optionals distinguish absence, empty presence, nested containers and guarded values", async () => {
  validateAirMachineContract(air);
  for (const [name, inputs, expected] of [
    ["Label", { contact: present(contact) }, contact.address], ["Label", { contact: absent }, "No contact"],
    ["Absent", {}, absent], ["Present", { address: "" }, present({ ...contact, address: "" })],
    ["FirstEmail", { contacts: [absent, present(contact)] }, present(contact.address)],
    ["FirstEmail", { contacts: [absent, absent] }, absent],
    ["Nested", { candidate: present(present("")) }, ""],
    ["Nested", { candidate: present(absent) }, "Inner absent"],
    ["Nested", { candidate: absent }, "Outer absent"],
    ["ReadEnvelope", { envelope: { contact: absent } }, absent],
    ["Choose", { first: absent, backup: present("fallback") }, "fallback"],
    ["Choose", { first: present(""), backup: present("fallback") }, ""],
    ["Choose", { first: absent, backup: absent }, "Unavailable"],
    ["FirstAvailable", { candidates: present([absent, present(contact)]) }, present(contact)],
    ["FirstAvailable", { candidates: present([]) }, absent],
    ["FirstAvailable", { candidates: absent }, absent],
  ]) {
    const output = await run(name, inputs);
    assert.equal(output.status, "success", JSON.stringify(output.trace));
    assert.deepEqual(output.result, expected);
  }
});

test("missing, null and malformed optional inputs are refused before human approval", async () => {
  for (const value of [undefined, null, "", {}, { present: false, value: contact }, { present: true },
    { present: true, value: null }, { present: "true", value: contact }, { present: true, value: { ...contact, channel: "typo" } },
    { present: false, extra: true }]) {
    const result = await executeAirDocument(air, { entryRef: "strategy:contacts/Review", inputs: value === undefined ? {} : { contact: value }, durableHumanApprovals: true });
    assert.equal(result.status, "failure");
    assert.equal(result.trace.events.some(event => event.kind === "human_approval_requested"), false);
  }
  assert.equal((await run("ReadEnvelope", { envelope: {} })).status, "failure");
});

test("present branch values and their types survive a real human checkpoint", async () => {
  const options = { entryRef: "strategy:contacts/Review", durableHumanApprovals: true };
  const paused = await executeAirDocument(air, { ...options, inputs: { contact: present(contact) } });
  assert.equal(paused.status, "stopped");
  const resumed = await executeAirDocument(air, { ...options,
    humanApprovalResumeCheckpoint: JSON.parse(JSON.stringify(paused.checkpoint)),
    humanApprovalDecisions: { [paused.checkpoint.approval_ref]: "approved" } });
  assert.equal(resumed.status, "success", JSON.stringify(resumed.trace));
  assert.equal(resumed.result, contact.address);
  assert.equal((await executeAirDocument(air, { ...options, inputs: { contact: absent } })).result, "No contact");
});

test("optional machine shapes are strict and direct AIR cannot extract absence", async () => {
  for (const mutate of [
    expression => { expression.type_ref = "builtin:Text"; },
    expression => { expression.type_ref = "optional:type:unknown/Contact"; },
    expression => { expression.operands = ["literal:string:forged"]; },
    expression => { expression.literal_text = "forged"; },
  ]) {
    const copy = structuredClone(air);
    mutate(copy.execution_graphs.flatMap(graph => graph.expressions ?? []).find(expression => expression.kind === "optional_none"));
    assert.throws(() => validateAirMachineContract(copy));
  }
  const forged = structuredClone(air);
  const graph = forged.execution_graphs.find(value => value.owner_ref === "function:contacts/Label");
  const guard = graph.nodes.find(value => value.kind === "branch");
  guard.condition_ref = "literal:bool:true";
  const result = await executeAirDocument(forged, { entryRef: graph.owner_ref, inputs: { contact: absent } });
  assert.equal(result.status, "failure");
  assert.equal(result.reason, "OptionalValueAbsent");
  assert.equal((await executeReferenceAir(air, { entryRef: "function:contacts/Label" })).failure_code, "ReferenceEnumOutsideProfile");
});

test("guarded loop resumptions preserve distinct approvals and do not repeat earlier effects", async () => {
  const effects = [];
  const options = { entryRef: "strategy:contacts/ReviewAll", durableHumanApprovals: true,
    toolHandlers: { "tool:contacts/StoreContact": ({ arguments: input }) => { effects.push(input.contact.address); return "stored"; } } };
  let result = await executeAirDocument(air, { ...options, inputs: { contacts: [absent, present(contact), present({ ...contact, address: "second@example.test" })] } });
  assert.equal(result.status, "stopped");
  assert.deepEqual(effects, []);
  for (const count of [1, 2]) {
    result = await executeAirDocument(air, { ...options,
      humanApprovalResumeCheckpoint: JSON.parse(JSON.stringify(result.checkpoint)),
      humanApprovalDecisions: { [result.checkpoint.approval_ref]: "approved" } });
    assert.equal(effects.length, count);
    assert.equal(result.status, count === 1 ? "stopped" : "success", JSON.stringify(result.trace));
  }
  assert.deepEqual(effects, [contact.address, "second@example.test"]);
});

test("shared schemas represent both optional branches including nested enum payloads", () => {
  const descriptor = { type_ref: "optional:list:optional:type:contacts/Channel", enum_values: ["email", "phone"] };
  const schema = argumentsSchemaForCapability({ signature: { inputs: [{ name: "channel", ...descriptor }] } }).properties.channel;
  assert.deepEqual(schema.anyOf[0].required, ["present"]);
  assert.equal(schema.anyOf[0].additionalProperties, false);
  assert.deepEqual(schema.anyOf[1].properties.value.items.anyOf[1].properties.value.enum, ["email", "phone"]);
  assert.deepEqual(agentResultSchema({ agent_signature: { output_type: descriptor.type_ref, output_enum_values: descriptor.enum_values } }), schema);
});

test("actual process handlers preserve optional inputs and validate outputs", async () => {
  for (const value of [absent, present(contact), null]) {
    const script = `let input = ""; process.stdin.setEncoding("utf8"); process.stdin.on("data", chunk => input += chunk);
      process.stdin.on("end", () => { const request = JSON.parse(input);
        if (JSON.stringify(request.arguments.channel) !== '{"present":true,"value":"email"}') process.exit(2);
        process.stdout.write(JSON.stringify({ ok: true, value: ${JSON.stringify(value)} })); });`;
    const manifest = loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
      "tool:contacts/Lookup": { handler: { kind: "process", command: process.execPath, args: ["-e", script] },
        grants: [], secrets: [], timeout_ms: 5000, max_payload_bytes: 16384, effect_contract: { kind: "none" } },
    } }));
    const result = await executeAirDocument(air, { entryRef: "strategy:contacts/LookupOnly",
      inputs: { channel: present("email") }, toolBindingManifest: manifest });
    assert.equal(result.status, value === null ? "failure" : "success", JSON.stringify(result.trace));
    if (value === null) assert.equal(result.reason, "ToolOutputSchemaInvalid");
    else assert.deepEqual(result.result, value);
  }
});

for (const decisionInterface of ["structured", "native"]) {
  for (const outcome of ["present", "absent", "bad_input", "bad_output", "bad_result"]) test(`${decisionInterface} optional handler and final result: ${outcome}`, async () => {
    const target = "tool:contacts/Lookup";
    const expected = outcome === "absent" ? absent : present(contact);
    let request;
    let effects = 0;
    const args = { query: "Find contact", channel: outcome === "bad_input" ? null : absent };
    const provider = createAiSdkDecisionProvider({ model: "fixture", source: "tests", decisionInterface,
      jsonSchema: schema => schema,
      generateText: async options => {
        assert.deepEqual(options.tools[nativeCapabilityName(target)].inputSchema.properties.channel.anyOf[1].properties.value.enum, ["email", "phone"]);
        const call = { toolCallId: "contact", toolName: nativeCapabilityName(target), input: args };
        return { finishReason: "tool-calls", toolCalls: [call],
          response: { messages: [{ role: "assistant", content: [{ type: "tool-call", ...call }] }] } };
      },
      generateObject: async () => ({ finishReason: "stop", object: request.step_index === 0
        ? { decision: { action: "select_capability", target_ref: target, arguments: args, source: "tests", reason: "Look up the requested contact.", review_prompt: "" } }
        : { decision: { action: "answer_directly", result: outcome === "bad_result" ? null : expected, source: "tests", reason: "The lookup is complete." } } }),
    });
    const result = await executeAirDocument(air, { entryRef: "strategy:contacts/Dispatch", inputs: { query: "Find contact" },
      agentDecisionProviderInitialMode: "capabilities", agentDecisionProviderContentMode: "inline",
      agentDecisionProvider: async value => { request = value; return provider(value); },
      toolHandlers: { [target]: async () => { effects += 1; return outcome === "bad_output" ? { present: true } : expected; } },
    });
    assert.equal(effects, outcome === "bad_input" ? 0 : 1, JSON.stringify(result.trace));
    assert.equal(result.status, outcome.startsWith("bad_") ? "failure" : "success", JSON.stringify(result.trace));
    if (result.status === "success") assert.deepEqual(result.result, expected);
  });
}
