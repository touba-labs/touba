import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";

const implementation = fileURLToPath(new URL("../../../", import.meta.url));
const source = fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/agent-interface-v1/positive/tb-invocation-isolation.tb", import.meta.url));
const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "-p", "touba-cli", "--bin", "touba-compile", "--", source], {
  cwd: implementation, encoding: "utf8",
}));

test("compiled calls isolate handler arguments, retained outputs and caller values", async () => {
  const hostInput = { query: "Investigate delayed settlement" };
  const seen = [], retained = [];
  const result = await executeAirDocument(air, {
    entryRef: "skill:agent.isolation/Isolated", inputs: { request: hostInput },
    toolHandlers: {
      "tool:agent.isolation/Inspect": request => {
        seen.push(request.arguments.request.query);
        request.arguments.request.query = "Changed handler argument";
        request.values["value:request"].query = "Changed handler value map";
        const output = { query: "Observed evidence" };
        retained.push(output);
        return output;
      },
      "tool:agent.isolation/Later": () => {
        retained[0].query = "Changed retained output";
        return "done";
      },
    },
  });
  assert.equal(result.status, "success", JSON.stringify(result));
  assert.deepEqual(seen, ["Investigate delayed settlement", "Investigate delayed settlement"]);
  assert.deepEqual(hostInput, { query: "Investigate delayed settlement" });
  assert.deepEqual(result.result, { query: "Observed evidence" });
  retained[0].query = "Changed after completion";
  assert.deepEqual(result.result, { query: "Observed evidence" });
  assert.equal(JSON.stringify(result.trace).includes(hostInput.query), false);
});

test("a handler cannot return non-copyable values as an accepted result", async () => {
  let calls = 0;
  const result = await executeAirDocument(air, {
    entryRef: "skill:agent.isolation/Isolated", inputs: { request: { query: "Inspect" } },
    toolHandlers: {
      "tool:agent.isolation/Inspect": () => { calls++; return { query() {} }; },
      "tool:agent.isolation/Later": () => { throw new Error("Must not execute"); },
    },
  });
  assert.equal(result.reason, "ToolOutputSchemaViolation");
  assert.equal(calls, 1);
});
