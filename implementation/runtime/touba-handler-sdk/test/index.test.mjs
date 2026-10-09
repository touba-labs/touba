import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  ToubaEngine,
  ToubaEngineError,
  ToubaAgentDecisionProviderError,
  ToubaHandlerError,
  TOUBA_SDK_METADATA,
  EFFECT_TOOL_HANDLER_PROTOCOL_VERSION,
  COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION,
  MCP_BRIDGE_CONFIG_VERSION,
  createAiSdkDecisionProvider,
  createEffectReceipt,
  createCompensationReceipt,
  createMcpStdioToolBridge,
  createOpenAiDecisionProvider,
  createOllamaDecisionProvider,
  createToolHandler,
  handleToolRequest,
  toubaSdkMetadata,
} from "../src/index.mjs";

const TOOL_REF = "tool:examples.sdk/SearchDatasets";
const testDir = dirname(fileURLToPath(import.meta.url));

function effectEnvelope() {
  return {
    effect_id: `effect:sha256:${"a".repeat(64)}`,
    attempt_index: 1,
    request_digest: `sha256:${"b".repeat(64)}`,
  };
}

function digest(value) {
  const canonical = (item) => {
    if (Array.isArray(item)) return item.map(canonical);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, canonical(item[key])]));
    }
    return item;
  };
  return `sha256:${createHash("sha256").update(JSON.stringify(canonical(value))).digest("hex")}`;
}

function compensationEnvelope() {
  const originalEffectReceipt = {
    effect_id: `effect:sha256:${"c".repeat(64)}`,
    request_digest: `sha256:${"d".repeat(64)}`,
    outcome: "applied",
    receipt_ref: "opaque:original:1",
  };
  return {
    compensation_id: `compensation:sha256:${"e".repeat(64)}`,
    compensates_effect_id: originalEffectReceipt.effect_id,
    plan_digest: `sha256:${"f".repeat(64)}`,
    execution_request_digest: `sha256:${"1".repeat(64)}`,
    original_tool_ref: "tool:examples.sdk/CreateDataset",
    original_request_digest: originalEffectReceipt.request_digest,
    original_effect_receipt_digest: digest(originalEffectReceipt),
    original_effect_receipt: originalEffectReceipt,
  };
}

test("exposes descriptive SDK metadata without runtime authority fields", () => {
  assert.deepEqual(TOUBA_SDK_METADATA, {
    name: "@touba/sdk",
    version: "0.1.0",
    protocol: "touba-tool-handler-v1",
    protocols: ["touba-tool-handler-v1", "touba-tool-handler-v2", "touba-tool-handler-v3"],
    status: "ok",
  });
  const metadata = toubaSdkMetadata();
  assert.deepEqual(metadata, TOUBA_SDK_METADATA);
  assert.equal(Object.hasOwn(metadata, "grants"), false);
  assert.equal(Object.hasOwn(metadata, "secrets"), false);
  assert.equal(Object.hasOwn(metadata, "memory_scopes"), false);
  assert.equal(Object.hasOwn(metadata, "permissions"), false);
});

test("handles strict V3 compensation with deeply frozen context and correlated receipt", async () => {
  const effect = effectEnvelope();
  const compensation = compensationEnvelope();
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION,
      tool_ref: TOOL_REF,
      arguments: { request: { query: "parks" } },
      effect,
      compensation,
    }),
    TOOL_REF,
    createToolHandler({
      toolRef: TOOL_REF,
      inputSignature: [{ name: "request", type_ref: "type:examples.sdk/SearchRequest" }],
      run: async ({ request, context }) => {
        assert.equal(Object.isFrozen(context.compensation), true);
        assert.equal(Object.isFrozen(context.compensation.original_effect_receipt), true);
        assert.throws(() => {
          context.compensation.original_effect_receipt.receipt_ref = "mutated";
        }, TypeError);
        return {
          value: { echoed: request.query },
          effect_receipt: context.createEffectReceipt({ outcome: "applied" }),
          compensation_receipt: context.createCompensationReceipt({ result: "completed" }),
        };
      },
    }),
  );

  assert.deepEqual(response, {
    ok: true,
    value: { echoed: "parks" },
    effect_receipt: {
      effect_id: effect.effect_id,
      request_digest: effect.request_digest,
      outcome: "applied",
    },
    compensation_receipt: {
      compensation_id: compensation.compensation_id,
      compensates_effect_id: compensation.compensates_effect_id,
      inverse_effect_id: effect.effect_id,
      result: "completed",
    },
  });
});

test("supports partial V3 success and bounded V3 errors", async () => {
  const effect = effectEnvelope();
  const compensation = compensationEnvelope();
  assert.deepEqual(
    createCompensationReceipt(compensation, effect, { result: "partial" }).result,
    "partial",
  );
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION,
      tool_ref: TOOL_REF,
      arguments: {},
      effect,
      compensation,
    }),
    TOOL_REF,
    async ({ createEffectReceipt: receiptForRequest }) => {
      throw new ToubaHandlerError("UndoRejected", "undo rejected", {
        effect_receipt: receiptForRequest({ outcome: "not_applied" }),
      });
    },
  );
  assert.equal(response.ok, false);
  assert.equal(response.effect_receipt.outcome, "not_applied");
  assert.equal(Object.hasOwn(response, "compensation_receipt"), false);
});

test("rejects V3 compensation on legacy protocols and invalid V3 correlations", async () => {
  const effect = effectEnvelope();
  const compensation = compensationEnvelope();
  for (const request of [
    {
      protocol: EFFECT_TOOL_HANDLER_PROTOCOL_VERSION,
      tool_ref: TOOL_REF,
      arguments: {},
      effect,
      compensation,
    },
    {
      protocol: COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION,
      tool_ref: TOOL_REF,
      arguments: {},
      effect,
      compensation: { ...compensation, original_request_digest: `sha256:${"9".repeat(64)}` },
    },
    {
      protocol: COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION,
      tool_ref: TOOL_REF,
      arguments: {},
      effect,
      compensation,
      vendor: true,
    },
  ]) {
    let called = false;
    const response = await handleToolRequest(JSON.stringify(request), TOOL_REF, async () => {
      called = true;
      return null;
    });
    assert.equal(called, false);
    assert.equal(response.ok, false);
    assert.match(response.error.code, /Compensation/u);
  }
});

test("handles V2 effects with a read-only envelope and a request-bound receipt", async () => {
  const effect = effectEnvelope();
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: EFFECT_TOOL_HANDLER_PROTOCOL_VERSION,
      tool_ref: TOOL_REF,
      arguments: { request: { query: "parks" } },
      effect,
    }),
    TOOL_REF,
    createToolHandler({
      toolRef: TOOL_REF,
      inputSignature: [{ name: "request", type_ref: "type:examples.sdk/SearchRequest" }],
      run: async ({ request, context }) => {
        assert.equal(Object.isFrozen(context.effect), true);
        assert.deepEqual(context.effect, effect);
        return {
          value: { echoed: request.query },
          effect_receipt: context.createEffectReceipt({
            outcome: "applied",
            receipt_ref: "opaque:search:1",
          }),
        };
      },
    }),
  );

  assert.deepEqual(response, {
    ok: true,
    value: { echoed: "parks" },
    effect_receipt: {
      effect_id: effect.effect_id,
      request_digest: effect.request_digest,
      outcome: "applied",
      receipt_ref: "opaque:search:1",
    },
  });
});

test("requires a correlated receipt for every successful V2 effect", async () => {
  const effect = effectEnvelope();
  for (const handler of [
    async () => ({ echoed: "missing receipt" }),
    async () => ({
      value: { echoed: "wrong receipt" },
      effect_receipt: {
        ...createEffectReceipt(effect, { outcome: "applied" }),
        request_digest: `sha256:${"c".repeat(64)}`,
      },
    }),
  ]) {
    const response = await handleToolRequest(
      JSON.stringify({
        protocol: EFFECT_TOOL_HANDLER_PROTOCOL_VERSION,
        tool_ref: TOOL_REF,
        arguments: {},
        effect,
      }),
      TOOL_REF,
      handler,
    );
    assert.equal(response.ok, false);
    assert.match(response.error.code, /EffectReceipt/u);
    assert.equal(Object.hasOwn(response, "effect_receipt"), false);
  }
});

test("carries a bounded not_applied receipt on a V2 domain error", async () => {
  const effect = effectEnvelope();
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: EFFECT_TOOL_HANDLER_PROTOCOL_VERSION,
      tool_ref: TOOL_REF,
      arguments: {},
      effect,
    }),
    TOOL_REF,
    async ({ createEffectReceipt: receiptForRequest }) => {
      throw new ToubaHandlerError("OrderRejected", "order was rejected", {
        effect_receipt: receiptForRequest({ outcome: "not_applied" }),
      });
    },
  );

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "OrderRejected",
      message: "order was rejected",
    },
    effect_receipt: {
      effect_id: effect.effect_id,
      request_digest: effect.request_digest,
      outcome: "not_applied",
    },
  });
});

test("rejects effect fields on the legacy V1 protocol before handler code", async () => {
  let called = false;
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: TOOL_REF,
      arguments: {},
      effect: effectEnvelope(),
    }),
    TOOL_REF,
    async () => {
      called = true;
      return null;
    },
  );

  assert.equal(called, false);
  assert.equal(response.ok, false);
  assert.equal(response.error.code, "InvalidEffect");
});

test("handles a valid tool request and hides protocol plumbing from handler code", async () => {
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: TOOL_REF,
      arguments: { request: { query: "parks" } },
      grants: ["network"],
      secret_handles: [],
      limits: { timeout_ms: 5000, max_payload_bytes: 1048576 },
    }),
    TOOL_REF,
    async ({ arguments: args, grants }) => {
      assert.deepEqual(grants, ["network"]);
      return { echoed: args.request.query };
    },
    { requiredGrants: ["network"] },
  );

  assert.deepEqual(response, { ok: true, value: { echoed: "parks" } });
});

test("createToolHandler exposes a small run request and preserves context", async () => {
  const handler = createToolHandler({
    toolRef: TOOL_REF,
    requiredGrants: ["network"],
    inputSignature: [{ name: "request", type_ref: "type:examples.sdk/SearchRequest" }],
    outputType: "type:examples.sdk/SearchResult",
    run: async ({ request, context }) => {
      assert.deepEqual(request, { query: "parks" });
      assert.deepEqual(context.arguments, { request: { query: "parks" } });
      assert.equal(context.toolRef, TOOL_REF);
      assert.deepEqual(context.grants, ["network"]);
      assert.equal(context.outputType, "type:examples.sdk/SearchResult");
      return { echoed: request.query };
    },
  });

  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: TOOL_REF,
      arguments: { request: { query: "parks" } },
      grants: ["network"],
      secret_handles: [],
    }),
    TOOL_REF,
    handler,
    { requiredGrants: ["network"] },
  );

  assert.deepEqual(response, { ok: true, value: { echoed: "parks" } });
});

test("createToolHandler keeps the full arguments object when a tool has several inputs", async () => {
  const handler = createToolHandler({
    toolRef: TOOL_REF,
    inputSignature: [
      { name: "query", type_ref: "builtin:Text" },
      { name: "rows", type_ref: "builtin:Int" },
    ],
    run: async ({ request }) => ({ keys: Object.keys(request).sort() }),
  });

  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: TOOL_REF,
      arguments: { query: "parks", rows: 3 },
    }),
    TOOL_REF,
    handler,
  );

  assert.deepEqual(response, { ok: true, value: { keys: ["query", "rows"] } });
});

test("returns controlled protocol errors", async () => {
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: "tool:examples.sdk/Other",
      grants: ["network"],
    }),
    TOOL_REF,
    async () => ({ unreachable: true }),
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "InvalidToolRef");
});

test("returns controlled domain errors from handler code", async () => {
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: TOOL_REF,
      arguments: {},
      grants: ["network"],
    }),
    TOOL_REF,
    async () => {
      throw new ToubaHandlerError("InvalidArguments", "request.query must be a string");
    },
    { requiredGrants: ["network"] },
  );

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "InvalidArguments",
      message: "request.query must be a string",
    },
  });
});

test("redacts unexpected handler errors", async () => {
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: TOOL_REF,
      arguments: {},
      grants: ["network"],
    }),
    TOOL_REF,
    async () => {
      throw new Error("internal failure with secret-value");
    },
    { requiredGrants: ["network"] },
  );

  assert.deepEqual(response, {
    ok: false,
    error: {
      code: "UnhandledHandlerError",
      message: "handler failed",
    },
  });
});

test("checks defense-in-depth grants and secret handles", async () => {
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: TOOL_REF,
      arguments: {},
      grants: ["network"],
      secret_handles: [],
    }),
    TOOL_REF,
    async () => ({ unreachable: true }),
    {
      requiredGrants: ["network"],
      requiredSecretHandles: ["SEARCH_API_KEY"],
    },
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "MissingSecretHandle");
});

test("accepts required grants and secret handles when the envelope is complete", async () => {
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      tool_ref: TOOL_REF,
      arguments: { request: { query: "parks" } },
      grants: ["network", "secret_read"],
      secret_handles: ["SEARCH_API_KEY"],
    }),
    TOOL_REF,
    async ({ secretHandles }) => ({ handles: secretHandles }),
    {
      requiredGrants: ["network", "secret_read"],
      requiredSecretHandles: ["SEARCH_API_KEY"],
    },
  );

  assert.deepEqual(response, {
    ok: true,
    value: {
      handles: ["SEARCH_API_KEY"],
    },
  });
});

test("createMcpStdioToolBridge executes a stdio MCP tool with structured output", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-sdk-mcp-"));
  try {
    const serverPath = writeFakeMcpServer(workspace);
    const bridge = createMcpStdioToolBridge({
      mcpToolName: "get_weather",
      config: mcpBridgeConfig(serverPath, "structured-secret", {
        env: {
          MCP_TOKEN: { from_secret_handle: "DEMO_API_KEY" },
        },
      }),
    });

    const result = await bridge({
      request: { location: "Montreal" },
      context: {
        secretHandles: ["DEMO_API_KEY"],
        env: { DEMO_API_KEY: "secret-value" },
        limits: { timeout_ms: 1000, max_payload_bytes: 4096 },
      },
    });

    assert.deepEqual(result, {
      temperature: 22.5,
      conditions: "clear",
      token_seen: true,
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("createMcpStdioToolBridge normalizes text content fallback", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-sdk-mcp-"));
  try {
    const serverPath = writeFakeMcpServer(workspace);
    const bridge = createMcpStdioToolBridge({
      mcpToolName: "summarize",
      config: mcpBridgeConfig(serverPath, "text"),
    });

    const result = await bridge({
      request: { topic: "Touba" },
      context: {
        secretHandles: [],
        env: {},
        limits: { timeout_ms: 1000, max_payload_bytes: 4096 },
      },
    });

    assert.deepEqual(result, {
      content: "Summary for Touba",
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("createMcpStdioToolBridge reports MCP tool and protocol errors", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-sdk-mcp-"));
  try {
    const serverPath = writeFakeMcpServer(workspace);
    const toolErrorBridge = createMcpStdioToolBridge({
      mcpToolName: "fail_tool",
      config: mcpBridgeConfig(serverPath, "tool-error"),
    });
    await assert.rejects(
      () => toolErrorBridge({
        request: { topic: "Touba" },
        context: { secretHandles: [], env: {}, limits: { timeout_ms: 1000, max_payload_bytes: 4096 } },
      }),
      (error) => error instanceof ToubaHandlerError && error.code === "McpToolExecutionError",
    );

    const protocolErrorBridge = createMcpStdioToolBridge({
      mcpToolName: "missing_tool",
      config: mcpBridgeConfig(serverPath, "protocol-error"),
    });
    await assert.rejects(
      () => protocolErrorBridge({
        request: { topic: "Touba" },
        context: { secretHandles: [], env: {}, limits: { timeout_ms: 1000, max_payload_bytes: 4096 } },
      }),
      (error) => error instanceof ToubaHandlerError && error.code === "McpProtocolError",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects malformed handler envelopes before user handler code", async () => {
  for (const [rawInput, expectedCode] of [
    ["not-json", "InvalidHandlerJson"],
    [JSON.stringify(null), "InvalidHandlerRequest"],
    [JSON.stringify({ protocol: "other", tool_ref: TOOL_REF }), "InvalidProtocol"],
    [JSON.stringify({ protocol: "touba-tool-handler-v1", tool_ref: TOOL_REF, arguments: [] }), "InvalidArguments"],
    [JSON.stringify({ protocol: "touba-tool-handler-v1", tool_ref: TOOL_REF, grants: "network" }), "InvalidHandlerRequest"],
    [JSON.stringify({ protocol: "touba-tool-handler-v1", tool_ref: TOOL_REF, grants: [1] }), "InvalidHandlerRequest"],
  ]) {
    const response = await handleToolRequest(
      rawInput,
      TOOL_REF,
      async () => ({ unreachable: true }),
    );
    assert.equal(response.ok, false);
    assert.equal(response.error.code, expectedCode);
  }
});

test("defineTool reads stdin and writes a protocol response to stdout", () => {
  const result = spawnSync(
    process.execPath,
    [join(testDir, "fixtures/echo.handler.mjs")],
    {
      input: JSON.stringify({
        protocol: "touba-tool-handler-v1",
        tool_ref: "tool:examples.sdk/EchoProfile",
        call_id: "call:test-sdk:1",
        arguments: { request: { name: "Bamba" } },
        grants: ["network", "secret_read"],
        memory_accesses: [{ memory_ref: "memory:examples.sdk/ProfileCache", access: "read" }],
        secret_handles: ["DEMO_API_KEY"],
        limits: { timeout_ms: 5000, max_payload_bytes: 1048576 },
      }),
      encoding: "utf8",
      env: {
        ...process.env,
        DEMO_API_KEY: "sdk-secret-value",
      },
    },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), {
    ok: true,
    value: {
      message: "Hello Bamba",
      secret_seen: true,
      memory_ref: "memory:examples.sdk/ProfileCache",
    },
  });
});

test("ToubaEngine compiles a source and runs it through the Touba CLI facade", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-sdk-engine-"));
  try {
    const fakeCliPath = writeFakeToubaCli(workspace);
    const logPath = join(workspace, "calls.jsonl");
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/program.tb"), "module examples.sdk_engine\n", "utf8");
    writeFileSync(join(workspace, "touba.manifest.json"), "{}\n", "utf8");
    writeFileSync(join(workspace, "touba.secrets.json"), "{}\n", "utf8");
    writeFileSync(join(workspace, "touba.resources.json"), "{}\n", "utf8");
    writeFileSync(join(workspace, "decision-provider.mjs"), "export function decideAgentCapability() {}\n", "utf8");

    const engine = new ToubaEngine({
      projectRoot: workspace,
      command: process.execPath,
      commandArgs: [fakeCliPath],
      env: {
        TOUBA_FAKE_LOG: logPath,
        DEMO_API_KEY: "sdk-engine-secret",
      },
    });

    const run = await engine.run({
      source: "src/program.tb",
      entryRef: "skill:examples.sdk_engine/Main",
      manifest: "touba.manifest.json",
      secrets: "touba.secrets.json",
      resourceBindings: "touba.resources.json",
      requireResourceBindings: true,
      inputs: {
        request: {
          name: "Bamba",
        },
      },
      agentDecisions: {
        "agent:examples.sdk_engine/Researcher": "skill:examples.sdk_engine/BuildGreeting",
      },
      agentDecisionProvider: "decision-provider.mjs",
      agentDecisionProviderMetadata: {
        provider_kind: "test_provider",
        provider_name: "sdk-fixture",
      },
      agentDecisionProviderTimeoutMs: 1000,
      agentDecisionProviderMaxRetries: 1,
      maxAgentSteps: 4,
      maxProviderCalls: 3,
    });

    assert.equal(run.status, "success");
    assert.deepEqual(run.result, {
      message: "Hello Bamba",
      entry_ref: "skill:examples.sdk_engine/Main",
    });
    assert.equal(run.trace.run.entry_ref, "skill:examples.sdk_engine/Main");

    const calls = readFileSync(logPath, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(calls[0].command, "compile");
    assert.equal(calls[1].command, "run");
    assert.ok(calls[1].args.includes("--entry"));
    assert.ok(calls[1].args.includes("--trace-out"));
    assert.ok(calls[1].args.includes("--resource-bindings"));
    assert.ok(calls[1].args.includes(join(workspace, "touba.resources.json")));
    assert.ok(calls[1].args.includes("--require-resource-bindings"));
    assert.ok(calls[1].args.includes("--agent-decisions-json"));
    assert.ok(calls[1].args.includes("--agent-decision-provider"));
    assert.ok(calls[1].args.includes(join(workspace, "decision-provider.mjs")));
    const metadataIndex = calls[1].args.indexOf("--agent-decision-provider-metadata-json");
    assert.notEqual(metadataIndex, -1);
    assert.deepEqual(JSON.parse(calls[1].args[metadataIndex + 1]), {
      provider_kind: "test_provider",
      provider_name: "sdk-fixture",
    });
    const timeoutIndex = calls[1].args.indexOf("--agent-decision-provider-timeout-ms");
    assert.notEqual(timeoutIndex, -1);
    assert.equal(calls[1].args[timeoutIndex + 1], "1000");
    const retriesIndex = calls[1].args.indexOf("--agent-decision-provider-max-retries");
    assert.notEqual(retriesIndex, -1);
    assert.equal(calls[1].args[retriesIndex + 1], "1");
    const maxStepsIndex = calls[1].args.indexOf("--max-agent-steps");
    assert.notEqual(maxStepsIndex, -1);
    assert.equal(calls[1].args[maxStepsIndex + 1], "4");
    const maxProviderCallsIndex = calls[1].args.indexOf("--max-provider-calls");
    assert.notEqual(maxProviderCallsIndex, -1);
    assert.equal(calls[1].args[maxProviderCallsIndex + 1], "3");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("ToubaEngine redacts known secret values from command failures", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-sdk-engine-fail-"));
  try {
    const fakeCliPath = writeFakeToubaCli(workspace);
    mkdirSync(join(workspace, "src"), { recursive: true });
    writeFileSync(join(workspace, "src/program.tb"), "module examples.sdk_engine\n", "utf8");

    const engine = new ToubaEngine({
      projectRoot: workspace,
      command: process.execPath,
      commandArgs: [fakeCliPath],
      env: {
        TOUBA_FAKE_FAIL_RUN: "1",
        DEMO_API_KEY: "sdk-engine-secret",
      },
    });

    await assert.rejects(
      () => engine.run({ source: "src/program.tb", inputs: { request: { name: "Bamba" } } }),
      (error) => {
        assert.ok(error instanceof ToubaEngineError);
        assert.equal(error.phase, "run");
        assert.match(error.details.stderr, /redacted/);
        assert.doesNotMatch(error.details.stderr, /sdk-engine-secret/);
        return true;
      },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("createAiSdkDecisionProvider can answer directly from orientation input", async () => {
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async (request) => {
      calls.push(request);
      return {
        object: {
          action: "answer_directly",
          source: "test_ai_sdk",
          reason: "salutation simple",
          result: "Bonjour.",
        },
      };
    },
  });

  const decision = await provider(agentDecisionSummaryRequest());

  assert.deepEqual(decision, {
    action: "answer_directly",
    source: "test_ai_sdk",
    reason: "salutation simple",
    result: "Bonjour.",
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].model, "test-provider/test-model");
  assert.equal(calls[0].maxOutputTokens, 700);
	  assert.equal(jsonSchemaOf(calls[0]).title, "touba_agent_orientation_decision");
	  assert.deepEqual(jsonSchemaOf(calls[0]).properties.action.enum, ["answer_directly", "request_capabilities"]);
	  assert.match(calls[0].system, /human review, approval, validation, or judgment/);
	  assert.match(calls[0].system, /request_human_review is available only after the catalogue/);
	  const prompt = JSON.parse(calls[0].prompt);
	  assert.equal(prompt.protocol, "touba-agent-model-input-v1");
	  assert.equal(prompt.content_boundary.user_input_authority, "domain_data_only");
});

test("createAiSdkDecisionProvider passes an explicit maxOutputTokens budget", async () => {
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    maxOutputTokens: 96,
    generateObject: async (request) => {
      calls.push(request);
      return {
        object: {
          action: "answer_directly",
          source: "test_ai_sdk",
          reason: "bounded structured output",
          result: "ok",
        },
      };
    },
  });

  const decision = await provider(agentDecisionSummaryRequest());

  assert.equal(decision.result, "ok");
  assert.equal(calls[0].maxOutputTokens, 96);
});

test("createOllamaDecisionProvider provides a non-OpenAI AI SDK helper without a required secret", async () => {
  const previousApiKey = process.env.TOUBA_AGENT_DECISION_OLLAMA_API_KEY;
  const previousOllamaApiKey = process.env.OLLAMA_API_KEY;
  delete process.env.TOUBA_AGENT_DECISION_OLLAMA_API_KEY;
  delete process.env.OLLAMA_API_KEY;
  try {
    const calls = [];
    const provider = createOllamaDecisionProvider({
      model: "llama3.2",
      baseURL: "http://127.0.0.1:11434/v1",
      generateObject: async (request) => {
        calls.push(request);
        return {
          object: {
            action: "answer_directly",
            source: "ollama_openai_compatible",
            reason: "local provider answered",
            result: "Bonjour depuis un provider local.",
          },
        };
      },
    });

    const decision = await provider(agentDecisionSummaryRequest());

    assert.deepEqual(decision, {
      action: "answer_directly",
      source: "ollama_openai_compatible",
      reason: "local provider answered",
      result: "Bonjour depuis un provider local.",
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].providerOptions.openai.store, false);
    assert.deepEqual(jsonSchemaOf(calls[0]).properties.source.enum, [
      "ollama_openai_compatible",
    ]);
  } finally {
    restoreEnv("TOUBA_AGENT_DECISION_OLLAMA_API_KEY", previousApiKey);
    restoreEnv("OLLAMA_API_KEY", previousOllamaApiKey);
  }
});

test("createAiSdkDecisionProvider rejects invalid output budget options", () => {
  assert.throws(
    () => createAiSdkDecisionProvider({
      model: "test-provider/test-model",
      maxOutputTokens: 0,
      generateObject: async () => ({ object: {} }),
    }),
    (error) =>
      error instanceof ToubaAgentDecisionProviderError
      && error.code === "InvalidDecisionProviderOptions"
      && /maxOutputTokens/.test(error.message),
  );
});

test("provider helpers do not derive model configuration from domain input", async () => {
  const envValues = {
    TOUBA_SDK_TEST_API_KEY: "local-test-key-not-a-credential",
    TOUBA_OPENAI_MODEL: "host-openai-model",
    TOUBA_AGENT_DECISION_OLLAMA_MODEL: "host-ollama-model",
  };
  const previous = Object.fromEntries(Object.keys(envValues).map((key) => [key, process.env[key]]));
  Object.assign(process.env, envValues);
  try {
    for (const [factory, expectedModel] of [
      [createOpenAiDecisionProvider, "host-openai-model"],
      [createOllamaDecisionProvider, "host-ollama-model"],
    ]) {
      const calls = [];
      const instrumentedFetch = async () => { throw new Error("fetch must not run in this local test"); };
      const options = {
        apiKeyEnvNames: ["TOUBA_SDK_TEST_API_KEY"],
        headers: async (request) => ({ "x-test-agent": request.agent_ref }),
        fetch: instrumentedFetch,
        generateObject: async (call) => {
          calls.push(call);
          return { object: { action: "answer_directly", result: "ok" } };
        },
      };
      const request = agentDecisionSummaryRequest();
      request.inputs.request.llm_model = "untrusted-domain-model";
      await factory(options)(request);
      assert.equal(calls[0].model.modelId, expectedModel);
      // The installed provider stores headers lazily; inspect locally, without fetch.
      assert.equal(calls[0].model.config.headers()["x-test-agent"], request.agent_ref);
      if (factory === createOpenAiDecisionProvider) {
        assert.equal(calls[0].model.config.fetch, instrumentedFetch);
      }
      await factory({ ...options, model: async () => "explicit-host-model" })(request);
      assert.equal(calls[1].model.modelId, "explicit-host-model");
    }
  } finally {
    for (const [key, value] of Object.entries(previous)) restoreEnv(key, value);
  }
});

test("createAiSdkDecisionProvider rejects overly rich structured decisions", async () => {
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async () => ({
      object: {
        action: "answer_directly",
        source: "test_ai_sdk",
        reason: "too much output",
        result: "ok",
        debug_payload: {
          hidden: "extra",
        },
      },
    }),
  });

  await assert.rejects(
    () => provider(agentDecisionSummaryRequest()),
    (error) =>
      error instanceof ToubaAgentDecisionProviderError
      && error.code === "InvalidModelDecision"
      && /unsupported fields/.test(error.message),
  );
});

test("createAiSdkDecisionProvider requests a catalog and selects a capability with signature arguments", async () => {
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    model: (request) => `test-provider/${request.mode}`,
    source: "test_ai_sdk",
    providerOptions: { test: { store: false } },
    generateObject: async (request) => {
      calls.push(request);
      if (jsonSchemaOf(request).title === "touba_agent_orientation_decision") {
        return {
          object: {
            action: "request_capabilities",
            source: "test_ai_sdk",
            reason: "the capability catalog is required",
            result: "",
          },
        };
      }
      return {
        object: {
          action: "select_capability",
          target_ref: "skill:test/Answer",
          source: "test_ai_sdk",
          reason: "la skill accepte la requête",
          arguments: {
            request: {
              query: "postgres",
              rows: 1,
            },
          },
        },
      };
    },
  });

  const catalogRequest = agentDecisionCatalogRequest();
  const first = await provider(agentDecisionSummaryRequest());
  const selected = await provider(catalogRequest);

  assert.deepEqual(first, {
    action: "request_capabilities",
    source: "test_ai_sdk",
    reason: "the capability catalog is required",
  });
  assert.deepEqual(selected, {
    target_ref: "skill:test/Answer",
    source: "test_ai_sdk",
    reason: "la skill accepte la requête",
    arguments: {
      request: {
        query: "postgres",
        rows: 1,
      },
    },
  });
  assert.equal(calls[0].model, "test-provider/summary");
  assert.equal(calls[1].model, "test-provider/capabilities");
  assert.deepEqual(calls[1].providerOptions, { test: { store: false } });
  assert.equal(jsonSchemaOf(calls[1]).title, "touba_agent_capability_decision");
  assert.deepEqual(jsonSchemaOf(calls[1]).properties.target_ref.enum, [
    "skill:test/Search",
    "skill:test/Answer",
    "human_review",
  ]);
  assert.deepEqual(jsonSchemaOf(calls[1]).properties.action.enum, [
    "select_capability",
    "request_human_review",
  ]);
  assert.match(calls[1].system, /declared responsibility boundary/u);
  assert.match(calls[1].system, /pass a result to another agent/u);
  const argumentSchemas = jsonSchemaOf(calls[1]).properties.arguments.anyOf;
  assert.equal(argumentSchemas[0].properties.request.type, "object");
  assert.equal(argumentSchemas[0].properties.request.properties.rows.type, "integer");
  assert.deepEqual(argumentSchemas[1].properties, {});
});

test("createAiSdkDecisionProvider can request governed human review from the catalog", async () => {
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async () => ({
      object: {
        action: "request_human_review",
        target_ref: "human_review",
        source: "test_ai_sdk",
        reason: "human judgment is required",
        arguments: {
          request: {
            query: "postgres",
            rows: 1,
          },
        },
        review_prompt: "Please review the summary before the final answer.",
      },
    }),
  });

  const decision = await provider(agentDecisionCatalogRequest());

  assert.deepEqual(decision, {
    action: "request_human_review",
    source: "test_ai_sdk",
    reason: "human judgment is required",
    review_prompt: "Please review the summary before the final answer.",
  });
});

test("createAiSdkDecisionProvider can disable dynamic human review by policy", async () => {
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    allowHumanReview: false,
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async (request) => {
      calls.push(request);
      return {
        object: {
          action: "select_capability",
          target_ref: "skill:test/Answer",
          source: "test_ai_sdk",
          reason: "la responsabilité reste attribuée à l'agent",
          arguments: {
            request: {
              query: "postgres",
              rows: 1,
            },
          },
          review_prompt: "",
        },
      };
    },
  });

  const decision = await provider(agentDecisionCatalogRequest());

  assert.equal(decision.target_ref, "skill:test/Answer");
  assert.deepEqual(jsonSchemaOf(calls[0]).properties.action.enum, ["select_capability"]);
  assert.equal(
    jsonSchemaOf(calls[0]).properties.target_ref.enum.includes("human_review"),
    false,
  );
  assert.match(calls[0].system, /Dynamic human review is not authorized/u);
});

test("createAiSdkDecisionProvider permits repeated authorized capability selections", async () => {
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async (request) => {
      calls.push(request);
      return {
        object: {
          action: "select_capability",
          target_ref: "skill:test/Search",
          source: "test_ai_sdk",
          reason: "the same capability searches another page",
          arguments: {
            request: {
              query: "postgres",
              rows: calls.length,
            },
          },
          review_prompt: "",
        },
      };
    },
  });
  const request = agentDecisionCatalogRequest();
  request.model_input.agent_state = {
    used_capability_refs: ["skill:test/Search"],
    available_capability_refs: [...request.capability_refs],
  };

  const decision = await provider(request);

  const repeated = await provider(request);
  assert.equal(decision.target_ref, "skill:test/Search");
  assert.equal(repeated.target_ref, "skill:test/Search");
  assert.equal(decision.arguments.request.rows, 1);
  assert.equal(repeated.arguments.request.rows, 2);
  assert.deepEqual(jsonSchemaOf(calls[0]).properties.target_ref.enum, [
    "skill:test/Search",
    "skill:test/Answer",
    "human_review",
  ]);
  assert.doesNotMatch(calls[0].system, /non encore sélectionnée/u);
});

test("createAiSdkDecisionProvider does not infer completion from capability usage", async () => {
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    allowHumanReview: false,
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async (request) => {
      calls.push(request);
      return {
        object: {
          action: "answer_directly",
          source: "test_ai_sdk",
          reason: "all declared work is complete",
          result: "final governed result",
        },
      };
    },
  });
  const request = agentDecisionSummaryRequest();
  request.model_input.agent_state = {
    used_capability_refs: [...request.capability_refs],
    available_capability_refs: [...request.capability_refs],
  };

  const decision = await provider(request);

  assert.equal(decision.action, "answer_directly");
  assert.equal(decision.result, "final governed result");
  assert.deepEqual(jsonSchemaOf(calls[0]).properties.action.enum, ["answer_directly", "request_capabilities"]);
  assert.match(calls[0].system, /Usage history neither proves that the goal is complete/iu);
  assert.doesNotMatch(calls[0].system, /capacités déclarées ont déjà été consommées/iu);
});

test("createAiSdkDecisionProvider permits a catalog request after every capability was used", async () => {
  const provider = createAiSdkDecisionProvider({
    allowHumanReview: false,
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async () => ({
      object: {
        action: "request_capabilities",
        source: "test_ai_sdk",
        reason: "an authorized operation needs another invocation",
        result: "",
      },
    }),
  });
  const request = agentDecisionSummaryRequest();
  request.model_input.agent_state = {
    used_capability_refs: [...request.capability_refs],
    available_capability_refs: [...request.capability_refs],
  };

  assert.equal((await provider(request)).action, "request_capabilities");
});

test("createAiSdkDecisionProvider supports bounded terminal completion", async () => {
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async (request) => {
      calls.push(request);
      return {
        object: {
          action: "answer_directly",
          source: "test_ai_sdk",
          reason: "the observation satisfies the goal",
          result: "terminal result",
        },
      };
    },
  });

  const decision = await provider(agentDecisionFinalizationRequest());

  assert.equal(decision.action, "answer_directly");
  assert.equal(decision.result, "terminal result");
  assert.equal(jsonSchemaOf(calls[0]).title, "touba_agent_finalization_decision");
  assert.deepEqual(
    jsonSchemaOf(calls[0]).properties.action.enum,
    ["answer_directly", "cannot_complete"],
  );
  assert.match(calls[0].system, /no new capability call/iu);
  assert.match(calls[0].system, /do not invent a missing result/iu);
});

test("createAiSdkDecisionProvider can declare terminal work incomplete", async () => {
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async () => ({
      object: {
        action: "cannot_complete",
        source: "test_ai_sdk",
        reason: "a required observation is absent",
        result: "",
      },
    }),
  });

  assert.deepEqual(await provider(agentDecisionFinalizationRequest()), {
    action: "cannot_complete",
    source: "test_ai_sdk",
    reason: "a required observation is absent",
  });
});

test("createAiSdkDecisionProvider keeps heterogeneous capability signatures separate", async () => {
  const request = agentDecisionCatalogRequest();
  request.capabilities = [
    { target_ref: "tool:test/Lookup", signature: { inputs: [{ name: "value", type_ref: "builtin:Text" }] } },
    { target_ref: "tool:test/Increment", signature: { inputs: [{ name: "value", type_ref: "builtin:Int" }] } },
    { target_ref: "tool:test/Page", signature: { inputs: [{ name: "cursor", type_ref: "builtin:Int" }] } },
    { target_ref: "tool:test/Refresh", signature: { inputs: [] } },
  ];
  request.capability_refs = request.capabilities.map((capability) => capability.target_ref);
  request.model_input.capabilities = request.capabilities;
  const choices = [
    { target_ref: "tool:test/Lookup", arguments: { value: "record-8" } },
    { target_ref: "tool:test/Increment", arguments: { value: 8 } },
    { target_ref: "tool:test/Page", arguments: { cursor: 9 } },
    { target_ref: "tool:test/Refresh", arguments: {} },
  ];
  let choice = choices[0];
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    allowHumanReview: false,
    generateObject: async (call) => {
      calls.push(call);
      return { object: { action: "select_capability", ...choice, review_prompt: "" } };
    },
  });
  for (const candidate of choices) {
    choice = candidate;
    const decision = await provider(request);
    assert.deepEqual(decision.arguments, choice.arguments);
  }
  const branches = jsonSchemaOf(calls[0]).properties.arguments.anyOf;
  assert.equal(branches.length, 4);
  assert.deepEqual(branches.map((branch) => branch.required), [["value"], ["value"], ["cursor"], []]);
  assert.equal(branches[0].properties.value.type, "string");
  assert.equal(branches[1].properties.value.type, "integer");
  for (const invalid of [
    { target_ref: "tool:test/Lookup", arguments: { value: 8 } },
    { target_ref: "tool:test/Increment", arguments: { value: "8" } },
    { target_ref: "tool:test/Page", arguments: { value: 8 } },
    { target_ref: "tool:test/Page", arguments: { cursor: 8, value: "unrelated" } },
    { target_ref: "tool:test/Refresh", arguments: { cursor: 8 } },
    { target_ref: "tool:test/Lookup", arguments: {} },
  ]) {
    choice = invalid;
    await assert.rejects(() => provider(request), /selected capability arguments do not match/u);
  }
});

test("createAiSdkDecisionProvider preserves declared result types in orientation and finalization", async () => {
  const examples = [
    { signature: { output_type: "builtin:Int" }, result: 3, type: "integer" },
    { signature: { output_type: "builtin:Boolean" }, result: true, type: "boolean" },
    { signature: { output_type: "builtin:Float" }, result: 2.5, type: "number" },
    { signature: { output_type: "list:builtin:Int" }, result: [1, 3], type: "array" },
    {
      signature: {
        output_type: "type:test/Count",
        output_fields: [{ name: "total", type_ref: "builtin:Int" }],
      },
      result: { total: 3 },
      type: "object",
    },
    {
      signature: {
        output_type: "list:type:test/Batch",
        output_fields: [{
          name: "item",
          type_ref: "type:test/Item",
          fields: [{ name: "name", type_ref: "builtin:Text" }],
        }],
      },
      result: [{ item: { name: "entry" } }],
      type: "array",
    },
  ];
  for (const example of examples) {
    for (const mode of ["summary", "finalization"]) {
      const request = mode === "summary" ? agentDecisionSummaryRequest() : agentDecisionFinalizationRequest();
      if (mode === "summary") request.model_input.agent = { signature: example.signature };
      else request.agent_signature = example.signature;
      let result = example.result;
      const calls = [];
      const provider = createAiSdkDecisionProvider({
        model: "test-provider/test-model",
        generateObject: async (call) => {
          calls.push(call);
          return { object: { action: "answer_directly", result } };
        },
      });
      assert.deepEqual((await provider(request)).result, example.result);
      const branches = jsonSchemaOf(calls[0]).properties.result.anyOf;
      assert.equal(branches[0].type, example.type);
      assert.deepEqual(branches[1], { type: "string", enum: [""] });
      result = "";
      await assert.rejects(() => provider(request), /agent result do not match/u);
    }
  }
});

test("createAiSdkDecisionProvider allows non-answer actions for a typed result", async () => {
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    generateObject: async (call) => ({ object: {
      action: jsonSchemaOf(call).title === "touba_agent_orientation_decision" ? "request_capabilities" : "cannot_complete",
      reason: "more observations are required",
      result: "",
    } }),
  });
  const summary = agentDecisionSummaryRequest();
  summary.agent_signature = { output_type: "builtin:Int" };
  assert.equal((await provider(summary)).action, "request_capabilities");
  const final = agentDecisionFinalizationRequest();
  final.agent_signature = summary.agent_signature;
  assert.equal((await provider(final)).action, "cannot_complete");
});

test("createAiSdkDecisionProvider refuses incomplete type descriptors before generation", async () => {
  let calls = 0;
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    generateObject: async () => { calls += 1; return { object: {} }; },
  });
  const request = agentDecisionSummaryRequest();
  request.agent_signature = { output_type: "type:test/Missing" };
  await assert.rejects(() => provider(request), (error) => error.code === "UnsupportedDecisionTypeDescriptor");
  const catalog = agentDecisionCatalogRequest();
  catalog.capabilities[0].signature.inputs[0].fields.push({ name: "nested", type_ref: "type:test/Missing" });
  await assert.rejects(() => provider(catalog), (error) => error.code === "UnsupportedDecisionTypeDescriptor");
  assert.equal(calls, 0);
});

test("createAiSdkDecisionProvider never expands authority from descriptive state or allows terminal selection", async () => {
  const request = agentDecisionCatalogRequest();
  request.model_input.agent_state = {
    available_capability_refs: [...request.capability_refs, "tool:test/Undeclared"],
    used_capability_refs: request.capability_refs,
  };
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    generateObject: async () => ({ object: {
      action: "select_capability",
      target_ref: "tool:test/Undeclared",
      arguments: {},
    } }),
  });
  await assert.rejects(() => provider(request), /unavailable capability/u);
  const terminalProvider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    generateObject: async () => ({ object: {
      action: "select_capability",
      target_ref: request.capability_refs[0],
      arguments: { request: { query: "x", rows: 1 } },
    } }),
  });
  await assert.rejects(() => terminalProvider(agentDecisionFinalizationRequest()), /unavailable capability/u);
});

test("ToubaEngine requires a single AIR source for run", async () => {
  const engine = new ToubaEngine({ command: process.execPath, commandArgs: ["unused.mjs"] });
  await assert.rejects(
    () => engine.run({ source: "src/program.tb", air: "program.air.json" }),
    /exactly one of source, air or airJson/,
  );
});

function agentDecisionSummaryRequest() {
  return {
    protocol: "touba-agent-decision-v1",
    mode: "summary",
    run_id: "run-sdk-test",
    agent_ref: "agent:test/Researcher",
    agent_name: "Researcher",
    responsibility: "Answer directly or select an authorized capability.",
    input_keys: ["request"],
    inputs: {
      request: {
        query: "postgres",
        rows: 1,
      },
    },
    capability_count: 2,
    capability_refs: [
      "skill:test/Search",
      "skill:test/Answer",
    ],
    model_input: {
      protocol: "touba-agent-model-input-v1",
      mode: "orientation",
      content_boundary: {
        user_input_authority: "domain_data_only",
      },
      allowed_actions: ["answer_directly", "request_capabilities"],
      resources_hint: {
        capabilities_available: true,
        catalog_available_on_request: true,
      },
    },
    capabilities: null,
  };
}

function jsonSchemaOf(call) {
  return call.schema.jsonSchema ?? call.schema;
}

function agentDecisionCatalogRequest() {
  return {
    ...agentDecisionSummaryRequest(),
    mode: "capabilities",
    model_input: {
      protocol: "touba-agent-model-input-v1",
      mode: "capability_catalog",
      content_boundary: {
        user_input_authority: "domain_data_only",
      },
      allowed_actions: ["select_capability"],
      capabilities: capabilityDescriptors(),
    },
    capabilities: capabilityDescriptors(),
  };
}

function agentDecisionFinalizationRequest() {
  const request = agentDecisionSummaryRequest();
  return {
    ...request,
    mode: "finalization",
    model_input: {
      ...request.model_input,
      mode: "finalization",
      agent_state: {
        phase: "finalization",
        execution_budget_exhausted: true,
        used_capability_refs: ["skill:test/Search"],
        available_capability_refs: [],
      },
      allowed_actions: ["answer_directly", "cannot_complete"],
    },
  };
}

function capabilityDescriptors() {
  return [
    {
      target_ref: "skill:test/Search",
      kind: "skill",
      signature: {
        inputs: [
          {
            name: "request",
            type_ref: "type:test/SearchRequest",
            fields: [
              { name: "query", type_ref: "builtin:Text" },
              { name: "rows", type_ref: "builtin:Int" },
            ],
          },
        ],
        output_type: "builtin:Text",
      },
    },
    {
      target_ref: "skill:test/Answer",
      kind: "skill",
      signature: {
        inputs: [
          {
            name: "request",
            type_ref: "type:test/SearchRequest",
            fields: [
              { name: "query", type_ref: "builtin:Text" },
              { name: "rows", type_ref: "builtin:Int" },
            ],
          },
        ],
        output_type: "builtin:Text",
      },
    },
  ];
}

function restoreEnv(name, value) {
  if (value === undefined) {
    delete process.env[name];
    return;
  }
  process.env[name] = value;
}

function mcpBridgeConfig(serverPath, mode, overrides = {}) {
  return {
    mcp_bridge_config_version: MCP_BRIDGE_CONFIG_VERSION,
    server: {
      transport: "stdio",
      command: process.execPath,
      args: [serverPath, mode],
      timeout_ms: 1000,
      max_payload_bytes: 4096,
      max_text_content_length: 4096,
      env: overrides.env ?? {},
    },
  };
}

function writeFakeMcpServer(workspace) {
  const serverPath = join(workspace, "fake-mcp-server.mjs");
  writeFileSync(
    serverPath,
    `import { createInterface } from "node:readline";

const mode = process.argv[2] ?? "structured-secret";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });

for await (const line of lines) {
  if (line.trim() === "") {
    continue;
  }
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    respond(request.id, {
      protocolVersion: "2025-06-18",
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: "fake-mcp", version: "0.1.0" }
    });
  } else if (request.method === "notifications/initialized") {
    continue;
  } else if (request.method === "tools/call") {
    handleToolCall(request);
  }
}

function handleToolCall(request) {
  if (mode === "structured-secret") {
    respond(request.id, {
      content: [
        { type: "text", text: "{\\"temperature\\":22.5,\\"conditions\\":\\"clear\\",\\"token_seen\\":true}" }
      ],
      structuredContent: {
        temperature: 22.5,
        conditions: "clear",
        token_seen: process.env.MCP_TOKEN === "secret-value"
      },
      isError: false
    });
    return;
  }
  if (mode === "text") {
    respond(request.id, {
      content: [
        { type: "text", text: "Summary for " + request.params.arguments.topic }
      ],
      isError: false
    });
    return;
  }
  if (mode === "tool-error") {
    respond(request.id, {
      content: [
        { type: "text", text: "Tool failed cleanly" }
      ],
      isError: true
    });
    return;
  }
  if (mode === "protocol-error") {
    process.stdout.write(JSON.stringify({
      jsonrpc: "2.0",
      id: request.id,
      error: { code: -32602, message: "Unknown tool" }
    }) + "\\n");
  }
}

function respond(id, result) {
  process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
}
`,
    "utf8",
  );
  return serverPath;
}

function writeFakeToubaCli(workspace) {
  const fakeCliPath = join(workspace, "fake-touba-cli.mjs");
  writeFileSync(
    fakeCliPath,
    `import { appendFileSync, readFileSync, writeFileSync } from "node:fs";

const [command, ...args] = process.argv.slice(2);
if (process.env.TOUBA_FAKE_LOG) {
  appendFileSync(process.env.TOUBA_FAKE_LOG, JSON.stringify({ command, args }) + "\\n");
}

if (command === "compile") {
  process.stdout.write(JSON.stringify({
    air_schema_version: "touba-air-v1",
    module: { id: "module:examples.sdk_engine", name: "examples.sdk_engine" },
    definitions: { types: [], functions: [], tools: [], skills: [], agents: [], strategies: [] },
    execution_graphs: [],
    trace_points: []
  }));
} else if (command === "run") {
  const option = (name) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args[index + 1];
  };
  if (process.env.TOUBA_FAKE_FAIL_RUN === "1") {
    process.stderr.write("runtime failed with " + process.env.DEMO_API_KEY);
    process.exit(1);
  }
  readFileSync(args[0], "utf8");
  const inputs = JSON.parse(option("--inputs-json") ?? "{}");
  const entryRef = option("--entry") ?? null;
  const trace = {
    trace_protocol_version: "touba-trace-v1",
    run: { id: "run-sdk-engine", entry_ref: entryRef },
    events: [{ kind: "run_completed", payload: { status: "success" } }]
  };
  writeFileSync(option("--trace-out"), JSON.stringify(trace), "utf8");
  process.stdout.write(JSON.stringify({
    message: "Hello " + inputs.request.name,
    entry_ref: entryRef
  }));
} else {
  process.stderr.write("unknown command " + command);
  process.exit(2);
}
`,
    "utf8",
  );
  return fakeCliPath;
}
