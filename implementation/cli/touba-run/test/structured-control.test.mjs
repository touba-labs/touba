import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";

const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
  fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--",
  fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/control-flow-v1/positive/nested-controls.tb", import.meta.url))], { encoding: "utf8" }));

test("else if selects exactly the first matching branch with sibling lexical bindings", async () => {
  for (const [x, expected] of [[-1, "negative"], [0, "zero"], [5, "small"], [10, "large"]]) {
    const result = await executeAirDocument(air, { entryRef: "function:control.nested/Classify", inputs: { x } });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.result, expected);
  }
});

test("nested loops preserve order, reset inner cursors, and isolate successive skill calls", async () => {
  for (const [entry, copies] of [["skill:control.nested/Visit", 1], ["strategy:control.nested/Twice", 2]]) {
    const writes = [];
    const result = await executeAirDocument(air, { entryRef: entry, inputs: { rows: [[1, 0], [], [-1, 2]] },
      maxLoopIterations: 3, toolHandlers: { "tool:control.nested/Write": ({ arguments: args }) => { writes.push(args.value); return "stored"; } } });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.deepEqual(writes, Array.from({ length: copies }, () => ["1", "zero", "2"]).flat());
  }
});

test("empty loops, nested early returns and exact iteration limits remain well defined", async () => {
  for (const [rows, expected] of [[[], 0], [[[], []], 0], [[[-1], [2, 3]], 2], [[[-1], [-2]], 0]]) {
    const result = await executeAirDocument(air, { entryRef: "function:control.nested/First", inputs: { rows }, maxLoopIterations: 2 });
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.equal(result.result, expected);
  }
  const writes = [];
  const refused = await executeAirDocument(air, { entryRef: "skill:control.nested/Visit", inputs: { rows: [[1, 2, 3]] },
    maxLoopIterations: 2, toolHandlers: { "tool:control.nested/Write": ({ arguments: args }) => { writes.push(args.value); return "stored"; } } });
  assert.equal(refused.status, "failure");
  assert.match(JSON.stringify(refused.trace), /LoopIterationLimitExceeded/);
  assert.deepEqual(writes, ["1", "2"]);
  for (const [ready, items, expected] of [[false, [2], 0], [true, [-1, 2], 2]]) {
    const result = await executeAirDocument(air, { entryRef: "function:control.nested/Bounded", inputs: { ready, items }, maxLoopIterations: 2 });
    assert.equal(result.result, expected);
    assert.equal(result.status, "success", JSON.stringify(result));
  }
  const bounded = await executeAirDocument(air, { entryRef: "function:control.nested/Bounded", inputs: { ready: true, items: [] }, maxLoopIterations: 2 });
  assert.equal(bounded.status, "failure");
  assert.match(JSON.stringify(bounded.trace), /LoopIterationLimitExceeded/);
});

test("each nested-loop approval requires its own decision and resumes without replaying previous writes", async () => {
  const writes = [];
  const options = { entryRef: "strategy:control.nested/Review", durableHumanApprovals: true, maxLoopIterations: 2,
    toolHandlers: { "tool:control.nested/Write": ({ arguments: args }) => { writes.push(args.value); return "stored"; } } };
  let result = await executeAirDocument(air, { ...options, inputs: { rows: [[1, 2], [3]] } });
  for (const item of [1, 2, 3]) {
    assert.equal(result.reason, "human_approval_pending", JSON.stringify(result));
    assert.deepEqual(result.checkpoint.context_values, [item]);
    assert.deepEqual(writes, Array.from({ length: item - 1 }, (_, i) => String(i + 1)));
    const broken = structuredClone(result.checkpoint);
    broken.loop_state.foreign = { index: 1 };
    const refused = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: broken,
      humanApprovalDecisions: { [broken.approval_ref]: "approved" } });
    assert.equal(refused.status, "failure");
    assert.deepEqual(writes, Array.from({ length: item - 1 }, (_, i) => String(i + 1)));
    result = await executeAirDocument(air, { ...options, humanApprovalResumeCheckpoint: result.checkpoint,
      humanApprovalDecisions: { [result.checkpoint.approval_ref]: "approved" } });
  }
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(writes, ["1", "2", "3"]);
});
