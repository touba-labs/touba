import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { executeAirDocument } from "../src/index.mjs";
import { validateAirMachineContract, validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";

let air;
before(() => {
  air = JSON.parse(execFileSync("cargo", ["run", "--quiet", "--manifest-path",
    new URL("../../../Cargo.toml", import.meta.url).pathname, "-p", "touba-cli", "--bin", "touba-compile", "--",
    new URL("../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/list-transformations.tb", import.meta.url).pathname], { encoding: "utf8" }));
});

test("pure list transformations preserve order, lexical scope, filters and typed empty outputs", async () => {
  validateAirMachineContract(air);
  for (const [entry, inputs, expected] of [
    ["Positive", { values: [-2, 0, 3, 4] }, [6, 8]],
    ["Positive", { values: [] }, []],
    ["Messages", { values: [-2, 1, 4] }, "1; 4"],
    ["Messages", { values: [] }, ""],
    ["Nested", { value: 99 }, [[2, 4], [4, 6], [99]]],
    ["Empty", {}, [[], []]], ["Combine", {}, [1, 2, 3]], ["FilterBeforeMap", {}, [4, 3]],
  ]) {
    const output = await executeAirDocument(air, { entryRef: `function:list_transformations/${entry}`, inputs });
    assert.equal(output.status, "success", JSON.stringify(output));
    assert.deepEqual(output.result, expected);
    validateTraceMachineContract(output.trace);
  }
});

test("comprehensions honor loop limits even when every item is filtered out", async () => {
  for (const values of [[1, 2, 3], [-1, -2, -3]]) {
    const output = await executeAirDocument(air, { entryRef: "function:list_transformations/Positive", inputs: { values }, maxLoopIterations: 2 });
    assert.equal(output.status, "failure");
    assert.equal(output.reason, "LoopIterationLimitExceeded");
    assert.ok(output.trace.events.some(event => event.kind === "failure_detected"));
  }
});

test("forged comprehension shapes and result types are rejected, including empty collections", async () => {
  const graphFor = doc => doc.execution_graphs.find(g => g.owner_ref === "function:list_transformations/Positive");
  const expressionFor = doc => graphFor(doc).expressions.find(e => e.kind === "list_comprehension");
  for (const mutate of [
    e => { delete e.value_ref; }, e => { e.value_ref = "agent:authority/Owner"; },
    e => { e.operands = []; }, e => { e.type_ref = "list:type:missing/Type"; }, e => { e.handler = "bypass"; },
  ]) {
    const copy = structuredClone(air); mutate(expressionFor(copy));
    assert.throws(() => validateAirMachineContract(copy));
  }
  for (const mutate of [
    e => { e.operands[2] = "literal:string:true"; },
    e => { e.operands[1] = "literal:bool:true"; },
    e => { e.operands[0] = "literal:int:1"; },
  ]) {
    const copy = structuredClone(air); mutate(expressionFor(copy));
    const output = await executeAirDocument(copy, { entryRef: "function:list_transformations/Positive", inputs: { values: [] } });
    assert.equal(output.status, "failure");
    assert.equal(output.reason, "ListElementTypeMismatch");
  }
});
