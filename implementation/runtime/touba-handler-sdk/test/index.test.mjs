import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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
  MCP_BRIDGE_CONFIG_VERSION,
  createAiSdkDecisionProvider,
  createMcpStdioToolBridge,
  createOllamaDecisionProvider,
  createToolHandler,
  handleToolRequest,
  toubaSdkMetadata,
} from "../src/index.mjs";

const TOOL_REF = "tool:examples.sdk/SearchDatasets";
const testDir = dirname(fileURLToPath(import.meta.url));

test("exposes descriptive SDK metadata without runtime authority fields", () => {
  assert.deepEqual(TOUBA_SDK_METADATA, {
    name: "@touba/sdk",
    version: "0.1.0",
    protocol: "touba-tool-handler-v1",
    status: "ok",
  });
  const metadata = toubaSdkMetadata();
  assert.deepEqual(metadata, TOUBA_SDK_METADATA);
  assert.equal(Object.hasOwn(metadata, "grants"), false);
  assert.equal(Object.hasOwn(metadata, "secrets"), false);
  assert.equal(Object.hasOwn(metadata, "memory_scopes"), false);
  assert.equal(Object.hasOwn(metadata, "permissions"), false);
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
	  assert.match(calls[0].system, /revue, approbation, validation ou décision humaine/);
	  assert.match(calls[0].system, /request_human_review n'est disponible qu'après le catalogue/);
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
            reason: "catalogue nécessaire",
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
    reason: "catalogue nécessaire",
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
  assert.match(calls[1].system, /frontière de responsabilité déclarée/u);
  assert.match(calls[1].system, /transmis à un autre agent/u);
  assert.equal(jsonSchemaOf(calls[1]).properties.arguments.properties.request.type, "object");
  assert.equal(jsonSchemaOf(calls[1]).properties.arguments.properties.request.properties.rows.type, "integer");
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
        reason: "jugement humain nécessaire",
        arguments: {
          request: {
            query: "postgres",
            rows: 1,
          },
        },
        review_prompt: "Merci de relire la synthèse avant réponse finale.",
      },
    }),
  });

  const decision = await provider(agentDecisionCatalogRequest());

  assert.deepEqual(decision, {
    action: "request_human_review",
    source: "test_ai_sdk",
    reason: "jugement humain nécessaire",
    review_prompt: "Merci de relire la synthèse avant réponse finale.",
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
  assert.match(calls[0].system, /review humain dynamique n'est pas autorisé/u);
});

test("createAiSdkDecisionProvider excludes capabilities already consumed by the agent", async () => {
  const calls = [];
  const provider = createAiSdkDecisionProvider({
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async (request) => {
      calls.push(request);
      return {
        object: {
          action: "select_capability",
          target_ref: "skill:test/Answer",
          source: "test_ai_sdk",
          reason: "la capacité restante finalise le travail",
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
  const request = agentDecisionCatalogRequest();
  request.model_input.agent_state = {
    completed_capability_refs: ["skill:test/Search"],
    remaining_capability_refs: ["skill:test/Answer"],
  };

  const decision = await provider(request);

  assert.equal(decision.target_ref, "skill:test/Answer");
  assert.deepEqual(jsonSchemaOf(calls[0]).properties.target_ref.enum, [
    "skill:test/Answer",
    "human_review",
  ]);
});

test("createAiSdkDecisionProvider requires a direct answer after every capability is consumed", async () => {
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
    completed_capability_refs: [...request.capability_refs],
    remaining_capability_refs: [],
  };

  const decision = await provider(request);

  assert.equal(decision.action, "answer_directly");
  assert.equal(decision.result, "final governed result");
  assert.deepEqual(jsonSchemaOf(calls[0]).properties.action.enum, ["answer_directly"]);
  assert.match(calls[0].system, /toutes les capacités déclarées ont déjà été consommées/iu);
});

test("createAiSdkDecisionProvider rejects a catalog request after every capability is consumed", async () => {
  const provider = createAiSdkDecisionProvider({
    allowHumanReview: false,
    model: "test-provider/test-model",
    source: "test_ai_sdk",
    generateObject: async () => ({
      object: {
        action: "request_capabilities",
        source: "test_ai_sdk",
        reason: "invalid continuation",
        result: "",
      },
    }),
  });
  const request = agentDecisionSummaryRequest();
  request.model_input.agent_state = {
    completed_capability_refs: [...request.capability_refs],
    remaining_capability_refs: [],
  };

  await assert.rejects(
    () => provider(request),
    /request_capabilities is unavailable after all declared capabilities have been consumed/u,
  );
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
    responsibility: "Répondre ou sélectionner une capacité autorisée.",
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
