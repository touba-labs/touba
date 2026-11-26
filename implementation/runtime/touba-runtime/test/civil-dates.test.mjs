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
  fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/civil-dates.tb", import.meta.url))], { encoding: "utf8" })); });
const run = (entry, inputs = {}, options = {}) => executeAirDocument(air, { entryRef: `function:calendar/${entry}`, inputs, ...options });
test("Date validates Gregorian civil dates, compares and renders without timezone conversion", async () => {
  for (const value of ["0001-01-01", "2000-02-29", "2024-02-29", "9999-12-31"]) {
    const result = await run("Parse", { value });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.result, value);
    assert.equal((await run("Label", { value })).result, value);
  }
  assert.equal((await run("Literal")).result, "2024-02-29");
  assert.equal((await run("Constant")).result, "2024-02-29");
  for (const [issued, expected] of [["2026-01-31", false], ["2026-02-01", true], ["2026-12-01", true]]) {
    assert.equal((await run("OnOrAfter", { invoice: { issued, paid: { present: false } }, ordered: "2026-02-01" })).result, expected);
  }
});
test("Date constants reject forged calendar values at AIR admission", () => {
  const copy = structuredClone(air);
  copy.definitions.constants[0].literal_text = "2023-02-29";
  assert.throws(() => validateAirMachineContract(copy), { code: "AirDateInvalid" });
});
test("invalid dates fail at dynamic conversion, entry and handler boundaries", async () => {
  for (const value of ["0000-01-01", "1900-02-29", "2026-04-31", "2026-13-01", "2026-1-1", "2026-01-01T00:00:00Z", 1, null]) {
    assert.equal((await run("Parse", { value })).status, "failure");
    assert.equal((await run("Label", { value })).status, "failure");
    const result = await executeAirDocument(air, { entryRef: "strategy:calendar/Read", toolHandlers: { "tool:calendar/ReadDate": () => value } });
    assert.equal(result.reason, "ToolOutputSchemaInvalid");
  }
});
test("SDK schema and flat optional transport retain exact Date validation", () => {
  const schema = argumentsSchemaForCapability({ signature: { inputs: [{ name: "day", type_ref: "builtin:Date" }] } });
  assert.deepEqual(schema.properties.day, { type: "string", format: "date" });
  const wire = createDecisionWireSchema(schema, "flat_optionals");
  assert.deepEqual(wire.decode({ day: "2024-02-29" }), { day: "2024-02-29" });
  assert.throws(() => wire.decode({ day: "2023-02-29" }));
});
