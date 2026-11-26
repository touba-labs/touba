import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { executeAirDocument } from "../src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";
import { argumentsSchemaForCapability } from "../../touba-handler-sdk/src/decision-contract.mjs";
import { createDecisionWireSchema } from "../../touba-handler-sdk/src/decision-wire-schema.mjs";
import { fileURLToPath } from "node:url";

let air;
before(() => { air = JSON.parse(execFileSync("cargo", ["run", "--quiet", "--manifest-path",
  fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--",
  fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/field-contracts.tb", import.meta.url))], { encoding: "utf8" })); });
const run = (name, inputs) => executeAirDocument(air, { entryRef: `function:fields/${name}`, inputs });
const account = { institution: "815", transit: "00001", account: "00000001234" };
test("source defaults are explicit values and copy keeps the original unchanged", async () => {
  const original = { id: "id", code: 0, reason: { present: false }, tags: [] };
  const created = await run("NewStatus", { id: "id" });
  assert.equal(created.status, "success", JSON.stringify(created));
  assert.deepEqual(created.result, original);
  const copied = await run("Change", { original, code: 2 });
  assert.equal(copied.status, "success", JSON.stringify(copied));
  assert.deepEqual(copied.result, { ...original, code: 2, reason: { present: true, value: "changed" } });
  assert.equal(original.code, 0);
  assert.deepEqual(original.reason, { present: false });
  assert.deepEqual((await run("AllDefaults", {})).result, { day: "2024-02-29", label: "💡", active: true, amount: 0 });
  assert.equal((await run("Change", { original: { id: "id" }, code: 2 })).status, "failure");
});
test("constraints protect dynamic construction, entry, copy and handler output", async () => {
  assert.equal((await run("Bank", { number: account.account })).status, "success");
  for (const number of ["1234", "1234567890123", "institution 815", "１２３４５", "1234\n"]) {
    assert.equal((await run("Bank", { number })).reason, "RecordValueInvalid");
  }
  assert.equal((await run("Change", { original: { id: "id", code: 0, reason: { present: false }, tags: [] }, code: 1000 })).reason, "RecordValueInvalid");
  let calls = 0;
  const options = { entryRef: "strategy:fields/Check", toolHandlers: { "tool:fields/Echo": () => { calls++; return { ...account, transit: "123" }; } } };
  const invalid = await executeAirDocument(air, { ...options, inputs: { account: { ...account, institution: "wrong" } } });
  assert.equal(invalid.reason, "EntryInputSchemaInvalid");
  const failure = invalid.trace.events.find(event => event.kind === "failure_detected");
  assert.equal(failure.payload.payload_constraint, "format");
  assert.equal(failure.payload.payload_constraint_limit_value, "digits");
  assert.equal(JSON.stringify(failure).includes("wrong"), false);
  assert.equal(calls, 0);
  const output = await executeAirDocument(air, { ...options, inputs: { account } });
  assert.equal(output.reason, "ToolOutputSchemaInvalid");
  assert.equal(calls, 1);
});
test("AIR rejects forged field constraints and invalid defaults", () => {
  for (const mutate of [field => { field.constraints = { min: 4 }; }, field => { field.constraints = { format: "sql" }; },
    field => { field.constraints = { min_length: 4, max_length: 2 }; }, field => { field.default = 1; }]) {
    const copy = structuredClone(air);
    mutate(copy.definitions.types.find(type => type.name === "Account").fields[0]);
    assert.throws(() => validateAirMachineContract(copy));
  }
});
test("model schemas carry source constraints and flat transport enforces them", () => {
  const fields = air.definitions.types.find(type => type.name === "Account").fields;
  const schema = argumentsSchemaForCapability({ signature: { inputs: [{ name: "account", type_ref: "type:fields/Account", fields }] } });
  assert.deepEqual(schema.properties.account.properties.institution, { type: "string", pattern: "^[0-9]+$", minLength: 3, maxLength: 3 });
  const wire = createDecisionWireSchema(schema, "flat_optionals");
  assert.deepEqual(wire.decode({ account }), { account });
  assert.throws(() => wire.decode({ account: { ...account, institution: "institution 815" } }));
});
