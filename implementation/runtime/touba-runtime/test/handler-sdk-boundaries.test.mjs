import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { runProcessToolHandler } from "../src/handler-protocol.mjs";

const toolRef = "tool:test/Echo";
const sdk = new URL("../../touba-handler-sdk/src/index.mjs", import.meta.url).href;

async function processHandler(body) {
  const root = mkdtempSync(join(tmpdir(), "touba-handler-sdk-boundary-"));
  try {
    const file = join(root, "handler.mjs");
    writeFileSync(file, body);
    return await runProcessToolHandler({ toolRef,
      binding: { handler: { command: process.execPath, args: [file], cwd: root },
        limits: { timeout_ms: 5000, max_payload_bytes: 65536 } },
      request: { protocol: "touba-tool-handler-v1", operation: "invoke", tool_ref: toolRef, arguments: {},
        grants: [], secret_handles: [], limits: { timeout_ms: 5000, max_payload_bytes: 65536 } },
      secretHandles: [], secretStore: null });
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test("a missing project SDK has an actionable process diagnostic", async () => {
  await assert.rejects(processHandler('import "@touba/sdk";'), error => {
    assert.equal(error.code, "ToolHandlerSdkMissing");
    assert.match(error.message, /touba version --json/);
    return true;
  });
});

test("a missing provider dependency is distinct from a missing SDK", async () => {
  await assert.rejects(processHandler('import "@ai-sdk/absent-test-provider";'), error => {
    assert.equal(error.code, "ToolHandlerSdkDependencyMissing");
    return true;
  });
});

test("explicit SDK result carries provenance outside business data through a real process", async () => {
  const metadata = [{ memory_ref: "memory:test/Records", operation: "read" }];
  const result = await processHandler(`import { defineTool, createToolResult } from ${JSON.stringify(sdk)};
    await defineTool({ toolRef: ${JSON.stringify(toolRef)}, inputSignature: [], outputType: "builtin:Text",
      run: async () => createToolResult("record", { memoryMetadata: ${JSON.stringify(metadata)} }) });`);
  assert.deepEqual(result, { value: "record", memoryMetadata: metadata });
});
