import test, { before } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { executeAirDocument } from "../src/index.mjs";
import { validateAirMachineContract } from "../../../contracts/machine/contracts.mjs";

let air;
before(() => {
  air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
    new URL("../../../Cargo.toml", import.meta.url).pathname, "-p", "touba-cli", "--bin", "touba-compile", "--",
    new URL("../../../grammar/tree-sitter-touba/examples/typechecker-v1/positive/match-templates.tb", import.meta.url).pathname], { encoding: "utf8" }));
  validateAirMachineContract(air);
});
const run = (name, inputs = {}) => executeAirDocument(air, { entryRef: `function:selection/${name}`, inputs });

test("every enum branch executes with pure templates, literal braces and escapes", async () => {
  for (const [status, expected] of [["ready", "Ready: 3 {items}"], ["waiting", "Waiting: waiting"], ["refused", "Refused"]]) {
    const result = await run("Label", { status, count: 3 });
    assert.equal(result.status, "success", JSON.stringify(result.trace));
    assert.equal(result.result, expected);
    assert.equal((await run("Nested", { status })).result, status);
  }
  assert.equal((await run("Escaped", { value: "hello" })).result, '{hello}\n"quoted" \\');
  assert.equal((await run("Empty")).result, "");
  assert.equal((await run("Plain")).result, "{text(count)}");
  assert.equal((await run("Label", { status: "unknown", count: 3 })).status, "failure");
});

test("integer division truncates toward zero without floating-point rounding", async () => {
  for (const amount of [0, 7, -7, 9007199254740991, -9007199254740991]) {
    for (const divisor of [1, -1, 2, -2, 3, -3, 7, 9007199254740991]) {
      const result = await run("Quotient", { amount, divisor });
      assert.equal(result.status, "success", JSON.stringify(result.trace));
      assert.equal(result.result, Number(BigInt(amount) / BigInt(divisor)));
    }
  }
  for (const [amount, divisor] of [[1, 0], [1.5, 1], [1, 0.5], [Number.MAX_SAFE_INTEGER + 1, 1]]) {
    assert.equal((await run("Quotient", { amount, divisor })).status, "failure");
  }
});

test("a selected branch requests and consumes its actual user interaction", async () => {
  const options = { entryRef: "skill:selection/AskThenLabel", inputs: { status: "ready" } };
  const paused = await executeAirDocument(air, options);
  assert.equal(paused.status, "stopped", JSON.stringify(paused.trace));
  const request = paused.trace.events.find(event => event.kind === "user_interaction_requested");
  assert.ok(request, JSON.stringify(paused.trace));
  const answered = await executeAirDocument(air, { ...options, userInputs: { [request.payload.interaction_ref]: "Shipment" } });
  assert.equal(answered.status, "success", JSON.stringify(answered.trace));
  assert.equal(answered.result, "Ready: Shipment");
});

test("match snapshot survives durable approval and rejection executes no following node", async () => {
  const options = { entryRef: "strategy:selection/ApproveThenLabel", inputs: { status: "ready" }, durableHumanApprovals: true };
  for (const decision of ["approved", "rejected"]) {
    const paused = await executeAirDocument(air, options);
    assert.equal(paused.status, "stopped");
    assert.ok(paused.checkpoint);
    const checkpoint = JSON.parse(JSON.stringify(paused.checkpoint));
    const resumed = await executeAirDocument(air, { entryRef: options.entryRef, durableHumanApprovals: true,
      humanApprovalResumeCheckpoint: checkpoint, humanApprovalDecisions: { [checkpoint.approval_ref]: decision } });
    assert.equal(resumed.status, decision === "approved" ? "success" : "stopped", JSON.stringify(resumed.trace));
    if (decision === "approved") assert.equal(resumed.result, "approved");
    else assert.notEqual(resumed.result, "approved");
  }
});
