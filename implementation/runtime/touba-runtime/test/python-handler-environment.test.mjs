import test from "node:test";
import assert from "node:assert/strict";
import { runProcessToolHandler } from "../src/handler-protocol.mjs";

const input = {
  toolRef: "tool:environment/Read",
  request: { protocol: "touba-tool-handler-v1", operation: "invoke", tool_ref: "tool:environment/Read", arguments: {}, grants: [], secret_handles: [] },
  secretHandles: [],
  binding: { handler: { command: process.execPath, args: ["-e", 'process.stdout.write(JSON.stringify({ok:true,value:process.env.PYTHONDONTWRITEBYTECODE}))'] },
    limits: { timeout_ms: 5000, max_payload_bytes: 4096 } },
};

test("handlers receive the no-bytecode policy and cannot replace it with a secret", async () => {
  assert.equal((await runProcessToolHandler(input)).value, "1");
  for (const handle of ["PYTHONDONTWRITEBYTECODE", "pythonDontWriteBytecode"]) {
    let dispatched = false;
    await assert.rejects(runProcessToolHandler({ ...input, secretHandles: [handle],
      secretStore: { valueFor: () => "0" }, beforeSpawn: () => { dispatched = true; } }), { code: "ToolHandlerEnvironmentInvalid" });
    assert.equal(dispatched, false);
  }
});
