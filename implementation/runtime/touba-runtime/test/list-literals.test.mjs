import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { executeAirDocument } from "../src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";

let air;
before(() => {
  air = JSON.parse(execFileSync("cargo", ["run", "--quiet", "--manifest-path",
    new URL("../../../Cargo.toml", import.meta.url).pathname, "-p", "touba-cli", "--bin", "touba-compile", "--",
    new URL("../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/list-literals.tb", import.meta.url).pathname], { encoding: "utf8" }));
});
test("compiled lists preserve order, nested empties, record and optional contexts", async () => {
  validateAirMachineContract(air);
  for (const [name, result] of [["Empty", []], ["Nested", [[], [1, 5], []]],
    ["MaybeEmpty", { present: true, value: [] }], ["Record", { names: [] }], ["Values", [7, 2.5]], ["First", "one"]]) {
    const output = await executeAirDocument(air, { entryRef: `function:lists/${name}`, inputs: name === "Values" ? { value: 7 } : {} });
    assert.equal(output.status, "success", JSON.stringify(output));
    assert.deepEqual(output.result, result);
  }
});
test("forged list types and operands fail before returning a value", async () => {
  for (const mutate of [
    expression => { expression.type_ref = "list:type:missing/Type"; },
    expression => { expression.type_ref = "builtin:Text"; },
    expression => { expression.operands = [null]; },
    expression => { expression.literal_text = "bypass"; },
  ]) {
    const copy = structuredClone(air);
    mutate(copy.execution_graphs.find(graph => graph.owner_ref === "function:lists/Empty").expressions[0]);
    assert.throws(() => validateAirMachineContract(copy));
  }
  const copy = structuredClone(air);
  copy.execution_graphs.find(graph => graph.owner_ref === "function:lists/Empty").expressions[0].operands = ['literal:int:1'];
  const result = await executeAirDocument(copy, { entryRef: "function:lists/Empty" });
  assert.equal(result.status, "failure");
  assert.equal(result.reason, "ListElementTypeMismatch");
});
