import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import {
  ToubaAgentDecisionProviderError,
  validateAgentDecisionRequest,
  modelInputForDecision,
  defaultDecisionSystemPrompt,
  decisionSchemaForRequest,
  normalizeAiSdkDecisionObject,
  assertCompleteProviderResponse,
} from "./decision-contract.mjs";
import { decideNativeCapability } from "./native-decision.mjs";
import { providerBudgetFetch, validateProviderRequestBudget } from "./provider-request-budget.mjs";

export const TOOL_HANDLER_PROTOCOL_VERSION = "touba-tool-handler-v1";
export const EFFECT_TOOL_HANDLER_PROTOCOL_VERSION = "touba-tool-handler-v2";
export const COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION = "touba-tool-handler-v3";
const PROTOCOL = TOOL_HANDLER_PROTOCOL_VERSION;
const EFFECT_OUTCOMES = new Set(["applied", "not_applied", "unknown"]);
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const EFFECT_ID_PATTERN = /^effect:sha256:[0-9a-f]{64}$/u;
const COMPENSATION_ID_PATTERN = /^compensation:sha256:[0-9a-f]{64}$/u;
const MAX_EFFECT_RECEIPT_REF_LENGTH = 512;
export const MCP_BRIDGE_CONFIG_VERSION = "touba-mcp-bridge-config-v0.1";
const MCP_PROTOCOL_VERSION = "2025-06-18";
const SECRET_ENV_NAME_PATTERN = /(KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL)/iu;
const DEFAULT_MCP_BRIDGE_TIMEOUT_MS = 5000;
const DEFAULT_MCP_MAX_PAYLOAD_BYTES = 1048576;

export const TOUBA_SDK_METADATA = Object.freeze({
  name: "@touba/sdk",
  version: "0.1.0",
  protocol: PROTOCOL,
  protocols: Object.freeze([
    PROTOCOL,
    EFFECT_TOOL_HANDLER_PROTOCOL_VERSION,
    COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION,
  ]),
  status: "ok",
});

export class ToubaHandlerError extends Error {
  constructor(code, message, details = undefined) {
    super(message);
    this.name = "ToubaHandlerError";
    this.code = code;
    this.details = details;
  }
}

export class ToubaEngineError extends Error {
  constructor(phase, message, details = {}) {
    super(message);
    this.name = "ToubaEngineError";
    this.phase = phase;
    this.details = details;
  }
}

export { ToubaAgentDecisionProviderError } from "./decision-contract.mjs";

export function toubaSdkMetadata() {
  return {
    ...TOUBA_SDK_METADATA,
    protocols: [...TOUBA_SDK_METADATA.protocols],
  };
}

export class ToubaEngine {
  constructor(options = {}) {
    this.projectRoot = resolve(options.projectRoot ?? process.cwd());
    this.command = options.command ?? options.toubaCommand ?? "touba";
    this.commandArgs = [...(options.commandArgs ?? options.toubaArgs ?? [])];
    this.env = {
      ...process.env,
      ...(options.env ?? {}),
    };
    this.redactValues = collectRedactionValues(this.env, options.redactValues ?? []);
  }

  async compile(options = {}) {
    const source = requireString(options.source, "compile.source");
    const result = await this.#runCommand("compile", ["compile", source, "--stdout"]);
    const airJson = result.stdout;
    let airDocument;
    try {
      airDocument = JSON.parse(airJson);
    } catch (error) {
      throw new ToubaEngineError("compile", "touba compile returned invalid AIR JSON", {
        cause: error instanceof Error ? error.message : String(error),
        stdout: redactText(result.stdout, this.redactValues),
        stderr: redactText(result.stderr, this.redactValues),
      });
    }
    return {
      airJson,
      airDocument,
    };
  }

  async run(options = {}) {
    const tempRoot = await mkdtemp(join(tmpdir(), "touba-engine-"));
    try {
      const airPath = await this.#materializeAir(options, tempRoot);
      const tracePath = options.traceOut
        ? resolvePath(this.projectRoot, options.traceOut)
        : join(tempRoot, "run.trace.json");
      const args = ["run", airPath, "--output", "result", "--trace-out", tracePath];

      appendOptionalPath(args, "--manifest", options.manifest, this.projectRoot);
      appendOptionalPath(args, "--secrets", options.secrets, this.projectRoot);
      appendOptionalPath(args, "--resource-bindings", options.resourceBindings, this.projectRoot);
      appendOptionalJson(args, "--inputs-json", options.inputs, "inputs");
      appendOptionalJson(args, "--human-decisions-json", options.humanDecisions, "humanDecisions");
      appendOptionalJson(args, "--user-inputs-json", options.userInputs, "userInputs");
      appendOptionalJson(args, "--agent-decisions-json", options.agentDecisions, "agentDecisions");
      appendOptionalPath(
        args,
        "--agent-decision-provider",
        options.agentDecisionProvider,
        this.projectRoot,
      );
      appendOptionalJson(
        args,
        "--agent-decision-provider-metadata-json",
        options.agentDecisionProviderMetadata,
        "agentDecisionProviderMetadata",
      );
      if (options.agentDecisionProviderTimeoutMs !== undefined) {
        args.push(
          "--agent-decision-provider-timeout-ms",
          String(requirePositiveInteger(
            options.agentDecisionProviderTimeoutMs,
            "run.agentDecisionProviderTimeoutMs",
          )),
        );
      }
      if (options.agentDecisionProviderMaxRetries !== undefined) {
        args.push(
          "--agent-decision-provider-max-retries",
          String(requireNonNegativeInteger(
            options.agentDecisionProviderMaxRetries,
            "run.agentDecisionProviderMaxRetries",
          )),
        );
      }
      if (options.maxAgentSteps !== undefined) {
        args.push(
          "--max-agent-steps",
          String(requirePositiveInteger(options.maxAgentSteps, "run.maxAgentSteps")),
        );
      }
      if (options.maxProviderCalls !== undefined) {
        args.push(
          "--max-provider-calls",
          String(requirePositiveInteger(options.maxProviderCalls, "run.maxProviderCalls")),
        );
      }
      if (options.requireResourceBindings === true) {
        args.push("--require-resource-bindings");
      }
      if (options.entryRef !== undefined) {
        args.push("--entry", requireString(options.entryRef, "run.entryRef"));
      }

      const result = await this.#runCommand("run", args, { allowFailure: true });
      const trace = await readOptionalJson(tracePath);
      if (result.status !== 0) {
        throw new ToubaEngineError("run", "touba run failed", {
          exitCode: result.status,
          stdout: redactText(result.stdout, this.redactValues),
          stderr: redactText(result.stderr, this.redactValues),
          trace,
        });
      }

      return {
        status: trace?.events?.at?.(-1)?.payload?.status ?? "success",
        result: parseJsonOutput(result.stdout, "run result"),
        trace,
      };
    } finally {
      await rm(tempRoot, { recursive: true, force: true });
    }
  }

  async #materializeAir(options, tempRoot) {
    const provided = [options.source, options.air, options.airJson].filter((value) => value !== undefined);
    if (provided.length !== 1) {
      throw new ToubaEngineError(
        "run",
        "run requires exactly one of source, air or airJson",
      );
    }

    if (options.source !== undefined) {
      const { airJson } = await this.compile({ source: options.source });
      const airPath = join(tempRoot, "program.air.json");
      await writeFile(airPath, airJson, "utf8");
      return airPath;
    }

    if (options.airJson !== undefined) {
      const airJson = typeof options.airJson === "string"
        ? options.airJson
        : JSON.stringify(options.airJson, null, 2);
      const airPath = join(tempRoot, "program.air.json");
      await writeFile(airPath, airJson, "utf8");
      return airPath;
    }

    return resolvePath(this.projectRoot, requireString(options.air, "run.air"));
  }

  async #runCommand(phase, args, options = {}) {
    const result = await runProcess(this.command, [...this.commandArgs, ...args], {
      cwd: this.projectRoot,
      env: this.env,
    });
    if (!options.allowFailure && result.status !== 0) {
      throw new ToubaEngineError(phase, `touba ${phase} failed`, {
        exitCode: result.status,
        stdout: redactText(result.stdout, this.redactValues),
        stderr: redactText(result.stderr, this.redactValues),
      });
    }
    return result;
  }
}

export function createAiSdkDecisionProvider(options = {}) {
  const normalized = normalizeAiSdkDecisionProviderOptions(options);
  if (normalized.maxProviderRequestBytes !== undefined) {
    throw new ToubaAgentDecisionProviderError("InvalidDecisionProviderOptions", "maxProviderRequestBytes requires an HTTP provider factory; configure the supplied model transport for a generic AI SDK provider");
  }

  return async function decideAgentCapability(request) {
    validateAgentDecisionRequest(request);
    const model = await modelForDecisionRequest(normalized, request);
    const allowHumanReview = await valueForRequest(normalized.allowHumanReview, request) !== false;
    const providerOptions = await valueForRequest(normalized.providerOptions, request);
    const system = await valueForRequest(normalized.system, request);
    const instructions = await valueForRequest(normalized.instructions, request);
    if (instructions !== undefined && typeof instructions !== "string") {
      throw new ToubaAgentDecisionProviderError("InvalidDecisionProviderOptions", "instructions must resolve to a string");
    }
    const effectiveSystem = [system ?? defaultDecisionSystemPrompt(request, {
      allowHumanReview, transport: normalized.decisionInterface === "native" && request.mode === "capabilities" ? "native_tools" : "json_schema",
    }), instructions].filter(Boolean).join("\n\n");
    if (normalized.decisionInterface === "native") {
      return decideNativeCapability(request, {
        ...normalized, model, allowHumanReview, system: effectiveSystem, providerOptions,
      });
    }
    const generateObject = await aiSdkGenerateObject(normalized);
    const schema = decisionSchemaForRequest(request, normalized, { allowHumanReview });
    const aiSchema = await aiSdkJsonSchema(schema, normalized);
    const prompt = JSON.stringify(modelInputForDecision(request, { allowHumanReview }), null, 2);
    const result = await generateObject(compactObject({
      model,
      schema: aiSchema,
      schemaName: schema.title,
      schemaDescription: schema.description,
      system: effectiveSystem,
      prompt,
      temperature: normalized.temperature,
      maxRetries: normalized.maxRetries,
      maxOutputTokens: normalized.maxOutputTokens,
      providerOptions,
    }));

    // Legacy injected generators may expose only { object }. Real AI SDK
    // responses include completion metadata and must not hide failed output.
    if (result?.finishReason !== undefined || result?.response !== undefined) {
      assertCompleteProviderResponse(result, normalized);
    }

    return normalizeAiSdkDecisionObject(request, result?.object, normalized.source, {
      allowHumanReview,
    });
  };
}

export function createOpenAiDecisionProvider(options = {}) {
  validateProviderRequestBudget(options);
  const { maxProviderRequestBytes: _httpBudget, ...providerOptions } = options;
  const normalized = {
    ...providerOptions,
    responseProtocol: "openai-responses",
    source: options.source ?? (options.decisionInterface === "native" ? "openai_native_tools" : "openai_structured_output"),
    providerOptions: options.providerOptions ?? { openai: { store: false } },
    model: async (request) => {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const apiKey = firstNonEmptyEnv(options.apiKeyEnvNames ?? [
        "TOUBA_AGENT_DECISION_OPENAI_API_KEY",
        "OPENAI_API_KEY",
      ]);
      const provider = createOpenAI(compactObject({
        apiKey,
        baseURL: options.baseURL,
        organization: options.organization,
        project: options.project,
        headers: await valueForRequest(options.headers, request),
        fetch: providerBudgetFetch(options, request),
      }));
      const modelId = await valueForRequest(options.model, request)
        ?? process.env.TOUBA_OPENAI_MODEL
        ?? "gpt-4.1-nano";
      return provider(modelId);
    },
  };
  return createAiSdkDecisionProvider(normalized);
}

export function createOllamaDecisionProvider(options = {}) {
  validateProviderRequestBudget(options);
  const { maxProviderRequestBytes: _httpBudget, ...providerOptions } = options;
  const normalized = {
    ...providerOptions,
    responseProtocol: "openai-responses",
    source: options.source ?? "ollama_openai_compatible",
    providerOptions: options.providerOptions ?? { openai: { store: false } },
    model: async (request) => {
      const { createOpenAI } = await import("@ai-sdk/openai");
      const apiKey = await valueForRequest(options.apiKey, request)
        ?? firstNonEmptyEnvOptional(options.apiKeyEnvNames ?? [
          "TOUBA_AGENT_DECISION_OLLAMA_API_KEY",
          "OLLAMA_API_KEY",
        ])
        ?? "ollama-local";
      const baseURL = await valueForRequest(options.baseURL, request)
        ?? process.env.TOUBA_AGENT_DECISION_OLLAMA_BASE_URL
        ?? process.env.OLLAMA_BASE_URL
        ?? "http://127.0.0.1:11434/v1";
      const provider = createOpenAI(compactObject({
        apiKey,
        baseURL,
        headers: await valueForRequest(options.headers, request),
        fetch: providerBudgetFetch(options, request),
      }));
      const modelId = await valueForRequest(options.model, request)
        ?? process.env.TOUBA_AGENT_DECISION_OLLAMA_MODEL
        ?? process.env.OLLAMA_MODEL
        ?? "llama3.2";
      return provider(modelId);
    },
  };
  return createAiSdkDecisionProvider(normalized);
}

export function createMcpStdioToolBridge(options = {}) {
  const normalized = normalizeMcpBridgeOptions(options);
  return async ({ request, context }) => {
    const config = await loadMcpBridgeConfig(normalized);
    return callMcpStdioTool({
      config,
      toolName: normalized.mcpToolName,
      argumentsPayload: normalizeMcpArguments(request),
      context: context ?? {},
    });
  };
}

export async function defineTool(definition) {
  const normalized = normalizeToolDefinition(definition);
  const rawInput = await readStdin();
  const response = await handleToolRequest(
    rawInput,
    normalized.toolRef,
    createToolHandler(normalized),
    {
      requiredGrants: normalized.requiredGrants,
      requiredSecretHandles: normalized.requiredSecretHandles,
    },
  );
  process.stdout.write(JSON.stringify(response));
}

function normalizeAiSdkDecisionProviderOptions(options) {
  if (!options || typeof options !== "object" || Array.isArray(options)) {
    throw new ToubaAgentDecisionProviderError(
      "InvalidDecisionProviderOptions",
      "decision provider options must be an object",
    );
  }
  if (options.decisionInterface !== undefined && !["structured", "native"].includes(options.decisionInterface)) {
    throw new ToubaAgentDecisionProviderError("InvalidDecisionProviderOptions", "decisionInterface must be structured or native");
  }
  return {
    ...options,
    decisionInterface: options.decisionInterface ?? "structured",
    source: typeof options.source === "string" && options.source.trim() !== ""
      ? options.source
      : options.decisionInterface === "native" ? "ai_sdk_native_tools" : "ai_sdk_structured_output",
    temperature: options.temperature ?? 0,
    maxRetries: options.maxRetries ?? 1,
    maxOutputTokens: normalizePositiveIntegerOption(options.maxOutputTokens ?? 700, "maxOutputTokens"),
  };
}

async function aiSdkGenerateObject(options) {
  if (options.generateObject !== undefined) {
    if (typeof options.generateObject !== "function") {
      throw new ToubaAgentDecisionProviderError(
        "InvalidDecisionProviderOptions",
        "generateObject must be a function when provided",
      );
    }
    return options.generateObject;
  }
  const ai = await import("ai");
  return ai.generateObject;
}

async function aiSdkJsonSchema(schema, options) {
  if (options.jsonSchema !== undefined) {
    if (typeof options.jsonSchema !== "function") {
      throw new ToubaAgentDecisionProviderError(
        "InvalidDecisionProviderOptions",
        "jsonSchema must be a function when provided",
      );
    }
    return options.jsonSchema(schema);
  }
  const ai = await import("ai");
  return ai.jsonSchema(schema);
}

async function modelForDecisionRequest(options, request) {
  const model = await valueForRequest(options.model, request);
  if (!model) {
    throw new ToubaAgentDecisionProviderError(
      "InvalidDecisionProviderOptions",
      "model must be provided for the AI SDK decision provider",
    );
  }
  return model;
}


function normalizePositiveIntegerOption(value, fieldName) {
  if (typeof value === "number" && Number.isInteger(value) && value > 0) {
    return value;
  }
  throw new ToubaAgentDecisionProviderError(
    "InvalidDecisionProviderOptions",
    `${fieldName} must be a positive integer`,
    { fieldName },
  );
}


function valueForRequest(value, request) {
  if (typeof value === "function") {
    return value(request);
  }
  return value;
}

function firstNonEmptyEnv(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  throw new ToubaAgentDecisionProviderError(
    "MissingProviderSecret",
    `${names.join(" or ")} must be set for the OpenAI decision provider`,
  );
}

function firstNonEmptyEnvOptional(names) {
  for (const name of names) {
    const value = process.env[name];
    if (typeof value === "string" && value.trim() !== "") {
      return value;
    }
  }
  return undefined;
}

function compactObject(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  );
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function loadMcpBridgeConfig(options) {
  if (options.config !== undefined) {
    return normalizeMcpBridgeConfig(options.config);
  }
  const raw = await readFile(options.configPath, "utf8");
  let document;
  try {
    document = JSON.parse(raw);
  } catch (error) {
    throw new ToubaHandlerError(
      "InvalidMcpBridgeConfig",
      `MCP bridge config must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  return normalizeMcpBridgeConfig(document);
}

async function callMcpStdioTool({ config, toolName, argumentsPayload, context }) {
  const limits = effectiveMcpLimits(config, context);
  const secretValues = [];
  const child = spawn(config.server.command, config.server.args, {
    cwd: config.server.cwd,
    env: buildMcpServerEnv(config, context, secretValues),
    stdio: ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });

  const client = createMcpJsonRpcClient(child, {
    timeoutMs: limits.timeoutMs,
    maxPayloadBytes: limits.maxPayloadBytes,
    redactionValues: secretValues,
  });

  try {
    await client.request("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "touba-mcp-bridge",
        version: TOUBA_SDK_METADATA.version,
      },
    });
    client.notify("notifications/initialized");
    const result = await client.request("tools/call", {
      name: toolName,
      arguments: argumentsPayload,
    });
    return normalizeMcpToolResult(result, limits.maxTextContentLength, secretValues);
  } finally {
    await client.close();
  }
}

function createMcpJsonRpcClient(child, options) {
  let nextId = 1;
  let stdoutSize = 0;
  let stderrSize = 0;
  let bufferedStdout = "";
  let closed = false;
  const pending = new Map();

  const failAll = (error) => {
    for (const { reject, timer } of pending.values()) {
      clearTimeout(timer);
      reject(error);
    }
    pending.clear();
  };

  const failAndKill = (error) => {
    if (!child.killed) {
      child.kill("SIGTERM");
    }
    failAll(error);
  };

  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdoutSize += Buffer.byteLength(chunk, "utf8");
    if (stdoutSize > options.maxPayloadBytes) {
      failAndKill(new ToubaHandlerError("McpPayloadTooLarge", "MCP server stdout exceeded max payload bytes"));
      return;
    }
    bufferedStdout += chunk;
    let newlineIndex = bufferedStdout.indexOf("\n");
    while (newlineIndex !== -1) {
      const line = bufferedStdout.slice(0, newlineIndex).trim();
      bufferedStdout = bufferedStdout.slice(newlineIndex + 1);
      if (line !== "") {
        handleMcpLine(line);
      }
      newlineIndex = bufferedStdout.indexOf("\n");
    }
  });

  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderrSize += Buffer.byteLength(chunk, "utf8");
    if (stderrSize > options.maxPayloadBytes) {
      failAndKill(new ToubaHandlerError("McpPayloadTooLarge", "MCP server stderr exceeded max payload bytes"));
    }
  });

  child.on("error", (error) => {
    failAll(new ToubaHandlerError(
      "McpServerProcessError",
      `MCP server process failed: ${redactText(error instanceof Error ? error.message : String(error), options.redactionValues)}`,
    ));
  });

  child.on("close", (code, signal) => {
    closed = true;
    if (pending.size > 0) {
      failAll(new ToubaHandlerError(
        "McpServerClosed",
        `MCP server closed before responding (${code ?? signal ?? "unknown"})`,
      ));
    }
  });

  function handleMcpLine(line) {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      failAndKill(new ToubaHandlerError("InvalidMcpJson", "MCP server emitted invalid JSON-RPC"));
      return;
    }
    if (!message || typeof message !== "object" || Array.isArray(message)) {
      failAndKill(new ToubaHandlerError("InvalidMcpMessage", "MCP server emitted a non-object JSON-RPC message"));
      return;
    }
    if (!Object.hasOwn(message, "id")) {
      return;
    }
    const entry = pending.get(message.id);
    if (!entry) {
      return;
    }
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error !== undefined) {
      const errorMessage = isPlainObject(message.error) && typeof message.error.message === "string"
        ? redactText(message.error.message, options.redactionValues)
        : "MCP protocol error";
      entry.reject(new ToubaHandlerError("McpProtocolError", errorMessage));
      return;
    }
    if (!Object.hasOwn(message, "result")) {
      entry.reject(new ToubaHandlerError("InvalidMcpResponse", "MCP response is missing result"));
      return;
    }
    entry.resolve(message.result);
  }

  function writeMessage(message) {
    if (closed || child.stdin.destroyed) {
      throw new ToubaHandlerError("McpServerClosed", "MCP server stdin is closed");
    }
    const payload = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(payload, "utf8") > options.maxPayloadBytes) {
      throw new ToubaHandlerError("McpPayloadTooLarge", "MCP request exceeded max payload bytes");
    }
    child.stdin.write(payload);
  }

  return {
    request(method, params) {
      const id = nextId;
      nextId += 1;
      return new Promise((resolveRequest, rejectRequest) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          rejectRequest(new ToubaHandlerError("McpRequestTimeout", `MCP request timed out: ${method}`));
          if (!child.killed) {
            child.kill("SIGTERM");
          }
        }, options.timeoutMs);
        pending.set(id, { resolve: resolveRequest, reject: rejectRequest, timer });
        try {
          writeMessage({
            jsonrpc: "2.0",
            id,
            method,
            params,
          });
        } catch (error) {
          clearTimeout(timer);
          pending.delete(id);
          rejectRequest(error);
        }
      });
    },
    notify(method, params = {}) {
      writeMessage({
        jsonrpc: "2.0",
        method,
        params,
      });
    },
    close() {
      return new Promise((resolveClose) => {
        if (closed) {
          resolveClose();
          return;
        }
        const timer = setTimeout(() => {
          if (!child.killed) {
            child.kill("SIGTERM");
          }
          resolveClose();
        }, 200);
        child.once("close", () => {
          clearTimeout(timer);
          resolveClose();
        });
        child.stdin.end();
      });
    },
  };
}

function normalizeMcpToolResult(result, maxTextContentLength, redactionValues) {
  if (!isPlainObject(result)) {
    throw new ToubaHandlerError("InvalidMcpToolResult", "MCP tool result must be an object");
  }
  if (result.isError === true) {
    const message = textContentForMcpResult(result, maxTextContentLength, redactionValues)
      || "MCP tool returned an execution error";
    throw new ToubaHandlerError("McpToolExecutionError", message);
  }
  if (isPlainObject(result.structuredContent)) {
    return result.structuredContent;
  }
  return {
    content: textContentForMcpResult(result, maxTextContentLength, redactionValues),
  };
}

function textContentForMcpResult(result, maxTextContentLength, redactionValues) {
  if (!Array.isArray(result.content)) {
    return "";
  }
  const textParts = [];
  for (const item of result.content) {
    if (!isPlainObject(item)) {
      throw new ToubaHandlerError("InvalidMcpToolResult", "MCP content entries must be objects");
    }
    if (item.type === "text") {
      if (typeof item.text !== "string") {
        throw new ToubaHandlerError("InvalidMcpToolResult", "MCP text content must contain text");
      }
      textParts.push(item.text);
      continue;
    }
    throw new ToubaHandlerError("UnsupportedMcpContent", `unsupported MCP content type ${item.type ?? "unknown"}`);
  }
  const content = redactText(textParts.join("\n"), redactionValues);
  if (content.length > maxTextContentLength) {
    throw new ToubaHandlerError("McpResultTooLarge", "MCP text result exceeded max text content length");
  }
  return content;
}

function normalizeMcpBridgeOptions(options) {
  if (!isPlainObject(options)) {
    throw new ToubaHandlerError("InvalidMcpBridgeOptions", "MCP bridge options must be an object");
  }
  if (typeof options.mcpToolName !== "string" || options.mcpToolName.trim() === "") {
    throw new ToubaHandlerError("InvalidMcpBridgeOptions", "mcpToolName must be a non-empty string");
  }
  if (options.config === undefined && options.configPath === undefined) {
    throw new ToubaHandlerError("InvalidMcpBridgeOptions", "config or configPath is required");
  }
  return {
    mcpToolName: options.mcpToolName,
    config: options.config,
    configPath: options.configPath,
  };
}

function normalizeMcpBridgeConfig(config) {
  if (!isPlainObject(config)) {
    throw new ToubaHandlerError("InvalidMcpBridgeConfig", "MCP bridge config must be an object");
  }
  if (config.mcp_bridge_config_version !== MCP_BRIDGE_CONFIG_VERSION) {
    throw new ToubaHandlerError(
      "InvalidMcpBridgeConfig",
      `mcp_bridge_config_version must be ${MCP_BRIDGE_CONFIG_VERSION}`,
    );
  }
  if (!isPlainObject(config.server)) {
    throw new ToubaHandlerError("InvalidMcpBridgeConfig", "MCP bridge config must contain server object");
  }
  if (config.server.transport !== "stdio") {
    throw new ToubaHandlerError("UnsupportedMcpTransport", "only MCP stdio transport is supported by this bridge");
  }
  if (typeof config.server.command !== "string" || config.server.command.trim() === "") {
    throw new ToubaHandlerError("InvalidMcpBridgeConfig", "server.command must be configured");
  }
  if (config.server.args !== undefined && !Array.isArray(config.server.args)) {
    throw new ToubaHandlerError("InvalidMcpBridgeConfig", "server.args must be an array of strings");
  }
  return {
    mcp_bridge_config_version: config.mcp_bridge_config_version,
    server: {
      transport: "stdio",
      command: config.server.command,
      args: normalizeStringArray(config.server.args ?? [], "server.args"),
      cwd: typeof config.server.cwd === "string" && config.server.cwd.trim() !== ""
        ? config.server.cwd
        : undefined,
      timeout_ms: normalizeMcpPositiveInteger(
        config.server.timeout_ms,
        DEFAULT_MCP_BRIDGE_TIMEOUT_MS,
        "server.timeout_ms",
      ),
      max_payload_bytes: normalizeMcpPositiveInteger(
        config.server.max_payload_bytes,
        DEFAULT_MCP_MAX_PAYLOAD_BYTES,
        "server.max_payload_bytes",
      ),
      max_text_content_length: normalizeMcpPositiveInteger(
        config.server.max_text_content_length,
        config.server.max_payload_bytes ?? DEFAULT_MCP_MAX_PAYLOAD_BYTES,
        "server.max_text_content_length",
      ),
      env: normalizeMcpEnv(config.server.env ?? {}),
    },
  };
}

function effectiveMcpLimits(config, context) {
  const contextLimits = isPlainObject(context.limits) ? context.limits : {};
  const timeoutCandidates = [
    config.server.timeout_ms,
    Number.isSafeInteger(contextLimits.timeout_ms) && contextLimits.timeout_ms > 0
      ? contextLimits.timeout_ms
      : undefined,
  ].filter((value) => value !== undefined);
  const payloadCandidates = [
    config.server.max_payload_bytes,
    Number.isSafeInteger(contextLimits.max_payload_bytes) && contextLimits.max_payload_bytes > 0
      ? contextLimits.max_payload_bytes
      : undefined,
  ].filter((value) => value !== undefined);
  const maxPayloadBytes = Math.min(...payloadCandidates);
  return {
    timeoutMs: Math.min(...timeoutCandidates),
    maxPayloadBytes,
    maxTextContentLength: Math.min(config.server.max_text_content_length, maxPayloadBytes),
  };
}

function buildMcpServerEnv(config, context, secretValues) {
  const env = {};
  const contextEnv = isPlainObject(context.env) ? context.env : process.env;
  const allowedSecretHandles = new Set(Array.isArray(context.secretHandles) ? context.secretHandles : []);
  for (const [name, spec] of Object.entries(config.server.env)) {
    if (spec.value !== undefined) {
      env[name] = spec.value;
      continue;
    }
    const handle = spec.from_secret_handle;
    if (!allowedSecretHandles.has(handle)) {
      throw new ToubaHandlerError("McpSecretNotGranted", `secret handle ${handle} is not granted to this bridge`);
    }
    const value = contextEnv[handle];
    if (typeof value !== "string" || value === "") {
      throw new ToubaHandlerError("McpSecretMissing", `secret handle ${handle} is not available to this bridge`);
    }
    env[name] = value;
    if (value.length >= 4) {
      secretValues.push(value);
    }
  }
  return env;
}

function normalizeMcpArguments(value) {
  if (!isPlainObject(value)) {
    throw new ToubaHandlerError("InvalidMcpArguments", "MCP tool arguments must be an object");
  }
  return value;
}

function normalizeMcpEnv(env) {
  if (!isPlainObject(env)) {
    throw new ToubaHandlerError("InvalidMcpBridgeConfig", "server.env must be an object");
  }
  const entries = {};
  for (const [name, spec] of Object.entries(env)) {
    if (!/^[A-Z_][A-Z0-9_]*$/u.test(name)) {
      throw new ToubaHandlerError("InvalidMcpBridgeConfig", "server.env keys must be uppercase environment names");
    }
    if (!isPlainObject(spec)) {
      throw new ToubaHandlerError("InvalidMcpBridgeConfig", "server.env entries must be objects");
    }
    if (typeof spec.value === "string" && spec.from_secret_handle === undefined) {
      if (SECRET_ENV_NAME_PATTERN.test(name)) {
        throw new ToubaHandlerError(
          "InvalidMcpBridgeConfig",
          "secret-shaped server.env entries must use from_secret_handle",
        );
      }
      entries[name] = { value: spec.value };
      continue;
    }
    if (typeof spec.from_secret_handle === "string" && spec.from_secret_handle.trim() !== "" && spec.value === undefined) {
      entries[name] = { from_secret_handle: spec.from_secret_handle };
      continue;
    }
    throw new ToubaHandlerError(
      "InvalidMcpBridgeConfig",
      "server.env entries must declare exactly one of value or from_secret_handle",
    );
  }
  return entries;
}

function normalizeMcpPositiveInteger(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ToubaHandlerError("InvalidMcpBridgeConfig", `${label} must be a positive integer`);
  }
  return value;
}

function normalizeStringArray(value, label) {
  if (!Array.isArray(value)) {
    throw new ToubaHandlerError("InvalidMcpBridgeConfig", `${label} must be an array`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new ToubaHandlerError("InvalidMcpBridgeConfig", `${label} entries must be strings`);
    }
    return item;
  });
}

export function createToolHandler(definition) {
  const normalized = normalizeToolDefinition(definition);
  return async (envelope) => {
    const args = envelope.arguments ?? {};
    const request = requestPayloadForTool(args, normalized.inputSignature);
    const context = {
      toolRef: normalized.toolRef,
      request: envelope.request,
      rawInput: envelope.rawInput,
      arguments: args,
      grants: envelope.grants,
      memoryAccesses: envelope.memoryAccesses,
      resourceBindings: envelope.resourceBindings,
      secretHandles: envelope.secretHandles,
      limits: envelope.limits,
      env: envelope.env,
      effect: envelope.effect,
      createEffectReceipt: envelope.createEffectReceipt,
      compensation: envelope.compensation,
      createCompensationReceipt: envelope.createCompensationReceipt,
      inputSignature: normalized.inputSignature,
      outputType: normalized.outputType,
    };
    return normalized.run({
      request,
      context,
    });
  };
}

export async function handleToolRequest(rawInput, expectedToolRef, handler, options = {}) {
  let effect;
  let compensation;
  let protocol;
  try {
    const request = parseRequest(rawInput);
    const envelope = validateEnvelope(request, expectedToolRef, options);
    ({ effect, compensation, protocol } = envelope);
    const value = await handler({
      request,
      rawInput,
      arguments: request.arguments ?? {},
      grants: request.grants ?? [],
      memoryAccesses: request.memory_accesses ?? [],
      resourceBindings: request.resource_bindings ?? [],
      secretHandles: request.secret_handles ?? [],
      limits: request.limits ?? {},
      env: process.env,
      effect,
      createEffectReceipt: effect === undefined
        ? undefined
        : (receipt) => createEffectReceipt(effect, receipt),
      compensation,
      createCompensationReceipt: compensation === undefined || effect === undefined
        ? undefined
        : (receipt) => createCompensationReceipt(compensation, effect, receipt),
    });
    if (protocol === COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION) {
      return encodeCompensationSuccess(value, effect, compensation);
    }
    if (protocol === EFFECT_TOOL_HANDLER_PROTOCOL_VERSION) {
      return encodeEffectfulSuccess(value, effect);
    }
    return { ok: true, value };
  } catch (error) {
    const normalized = normalizeError(error, effect, {
      compensation: protocol === COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION,
    });
    const response = {
      ok: false,
      error: {
        code: normalized.code,
        message: normalized.message,
      },
    };
    if (normalized.effectReceipt !== undefined) {
      response.effect_receipt = normalized.effectReceipt;
    }
    return response;
  }
}

/**
 * Create the bounded wire receipt for the exact effect request received by a
 * V2 handler. This helper grants no retry or idempotence capability.
 */
export function createEffectReceipt(effect, receipt) {
  const normalizedEffect = validateEffectEnvelope(effect);
  if (!isPlainObject(receipt)) {
    throw new ToubaHandlerError("EffectReceiptInvalid", "effect receipt options must be an object");
  }
  const allowed = new Set(["outcome", "receipt_ref", "receipt_digest"]);
  if (Object.keys(receipt).some((key) => !allowed.has(key))) {
    throw new ToubaHandlerError("EffectReceiptInvalid", "effect receipt options contain unknown fields");
  }
  if (typeof receipt.outcome !== "string" || !EFFECT_OUTCOMES.has(receipt.outcome)) {
    throw new ToubaHandlerError("EffectReceiptInvalid", "effect receipt outcome is invalid");
  }
  const result = {
    effect_id: normalizedEffect.effect_id,
    request_digest: normalizedEffect.request_digest,
    outcome: receipt.outcome,
  };
  if (receipt.receipt_ref !== undefined) {
    if (
      typeof receipt.receipt_ref !== "string"
      || receipt.receipt_ref.trim() === ""
      || receipt.receipt_ref.length > MAX_EFFECT_RECEIPT_REF_LENGTH
    ) {
      throw new ToubaHandlerError(
        "EffectReceiptInvalid",
        "effect receipt receipt_ref must be a non-empty bounded string",
      );
    }
    result.receipt_ref = receipt.receipt_ref;
  }
  if (receipt.receipt_digest !== undefined) {
    if (typeof receipt.receipt_digest !== "string" || !SHA256_PATTERN.test(receipt.receipt_digest)) {
      throw new ToubaHandlerError(
        "EffectReceiptInvalid",
        "effect receipt receipt_digest must be sha256:<hex>",
      );
    }
    result.receipt_digest = receipt.receipt_digest;
  }
  return Object.freeze(result);
}

/**
 * Create the strict receipt for the exact COMP-1 request. This helper reports
 * only the inverse operation result; it grants no authority and never exposes
 * the original opaque provider receipt.
 */
export function createCompensationReceipt(compensation, effect, receipt) {
  const normalizedCompensation = validateCompensationEnvelope(compensation);
  const normalizedEffect = validateEffectEnvelope(effect);
  if (!isPlainObject(receipt)) {
    throw new ToubaHandlerError(
      "CompensationReceiptInvalid",
      "compensation receipt options must be an object",
    );
  }
  if (Object.keys(receipt).some((key) => key !== "result")) {
    throw new ToubaHandlerError(
      "CompensationReceiptInvalid",
      "compensation receipt options contain unknown fields",
    );
  }
  if (receipt.result !== "completed" && receipt.result !== "partial") {
    throw new ToubaHandlerError(
      "CompensationReceiptInvalid",
      "compensation receipt result must be completed or partial",
    );
  }
  return Object.freeze({
    compensation_id: normalizedCompensation.compensation_id,
    compensates_effect_id: normalizedCompensation.compensates_effect_id,
    inverse_effect_id: normalizedEffect.effect_id,
    result: receipt.result,
  });
}

function normalizeToolDefinition(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) {
    throw new ToubaHandlerError("InvalidToolDefinition", "tool definition must be an object");
  }
  if (typeof definition.toolRef !== "string" || definition.toolRef.trim() === "") {
    throw new ToubaHandlerError("InvalidToolDefinition", "toolRef must be a non-empty string");
  }
  if (typeof definition.run !== "function") {
    throw new ToubaHandlerError("InvalidToolDefinition", "run must be a function");
  }
  return {
    toolRef: definition.toolRef,
    run: definition.run,
    requiredGrants: normalizeDefinitionList(definition.requiredGrants, "requiredGrants"),
    requiredSecretHandles: normalizeDefinitionList(
      definition.requiredSecretHandles,
      "requiredSecretHandles",
    ),
    inputSignature: normalizeInputSignature(definition.inputSignature),
    outputType: typeof definition.outputType === "string" ? definition.outputType : null,
  };
}

function normalizeDefinitionList(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ToubaHandlerError("InvalidToolDefinition", `${label} must be an array`);
  }
  return value.map((item) => {
    if (typeof item !== "string" || item.trim() === "") {
      throw new ToubaHandlerError("InvalidToolDefinition", `${label} entries must be non-empty strings`);
    }
    return item;
  });
}

function normalizeInputSignature(value) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ToubaHandlerError("InvalidToolDefinition", "inputSignature must be an array");
  }
  return value.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new ToubaHandlerError("InvalidToolDefinition", "inputSignature entries must be objects");
    }
    if (typeof input.name !== "string" || input.name.trim() === "") {
      throw new ToubaHandlerError("InvalidToolDefinition", "inputSignature entries must declare name");
    }
    if (typeof input.type_ref !== "string" || input.type_ref.trim() === "") {
      throw new ToubaHandlerError("InvalidToolDefinition", "inputSignature entries must declare type_ref");
    }
    return {
      name: input.name,
      type_ref: input.type_ref,
    };
  });
}

function requestPayloadForTool(args, inputSignature) {
  if (inputSignature.length === 1) {
    return args[inputSignature[0].name];
  }
  return args;
}

function parseRequest(rawInput) {
  try {
    return JSON.parse(rawInput);
  } catch (error) {
    throw new ToubaHandlerError(
      "InvalidHandlerJson",
      `handler request must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateEnvelope(request, expectedToolRef, options) {
  if (!request || typeof request !== "object" || Array.isArray(request)) {
    throw new ToubaHandlerError("InvalidHandlerRequest", "handler request must be an object");
  }
  if (
    request.protocol !== PROTOCOL
    && request.protocol !== EFFECT_TOOL_HANDLER_PROTOCOL_VERSION
    && request.protocol !== COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION
  ) {
    throw new ToubaHandlerError("InvalidProtocol", "unsupported handler protocol");
  }
  if (request.tool_ref !== expectedToolRef) {
    throw new ToubaHandlerError("InvalidToolRef", "unexpected tool ref");
  }
  if (
    request.arguments !== undefined
    && (!request.arguments || typeof request.arguments !== "object" || Array.isArray(request.arguments))
  ) {
    throw new ToubaHandlerError("InvalidArguments", "handler arguments must be an object");
  }

  const grants = normalizeList(request.grants, "grants");
  const secretHandles = normalizeList(request.secret_handles, "secret_handles");

  for (const grant of options.requiredGrants ?? []) {
    if (!grants.includes(grant)) {
      throw new ToubaHandlerError("MissingGrant", `required grant ${grant} missing from handler request`);
    }
  }

  for (const handle of options.requiredSecretHandles ?? []) {
    if (!secretHandles.includes(handle)) {
      throw new ToubaHandlerError(
        "MissingSecretHandle",
        `required secret handle ${handle} missing from handler request`,
      );
    }
  }

  if (request.protocol === COMPENSATION_TOOL_HANDLER_PROTOCOL_VERSION) {
    const allowed = new Set([
      "protocol",
      "tool_ref",
      "call_id",
      "arguments",
      "grants",
      "memory_accesses",
      "resource_bindings",
      "secret_handles",
      "limits",
      "effect",
      "compensation",
    ]);
    if (Object.keys(request).some((key) => !allowed.has(key))) {
      throw new ToubaHandlerError("InvalidCompensation", "V3 handler request contains unknown fields");
    }
    return Object.freeze({
      protocol: request.protocol,
      effect: validateEffectEnvelope(request.effect),
      compensation: validateCompensationEnvelope(request.compensation),
    });
  }
  if (request.protocol === EFFECT_TOOL_HANDLER_PROTOCOL_VERSION) {
    if (request.compensation !== undefined) {
      throw new ToubaHandlerError(
        "InvalidCompensation",
        "touba-tool-handler-v2 cannot carry a compensation envelope",
      );
    }
    return Object.freeze({
      protocol: request.protocol,
      effect: validateEffectEnvelope(request.effect),
      compensation: undefined,
    });
  }
  if (request.effect !== undefined) {
    throw new ToubaHandlerError(
      "InvalidEffect",
      "touba-tool-handler-v1 cannot carry an effect envelope",
    );
  }
  if (request.compensation !== undefined) {
    throw new ToubaHandlerError(
      "InvalidCompensation",
      "touba-tool-handler-v1 cannot carry a compensation envelope",
    );
  }
  return Object.freeze({
    protocol: request.protocol,
    effect: undefined,
    compensation: undefined,
  });
}

function validateEffectEnvelope(value) {
  if (!isPlainObject(value)) {
    throw new ToubaHandlerError("InvalidEffect", "effect must be an object");
  }
  const allowed = new Set(["effect_id", "attempt_index", "request_digest"]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ToubaHandlerError("InvalidEffect", "effect contains unknown fields");
  }
  if (typeof value.effect_id !== "string" || !EFFECT_ID_PATTERN.test(value.effect_id)) {
    throw new ToubaHandlerError("InvalidEffect", "effect.effect_id is invalid");
  }
  if (!Number.isSafeInteger(value.attempt_index) || value.attempt_index <= 0) {
    throw new ToubaHandlerError("InvalidEffect", "effect.attempt_index must be a positive safe integer");
  }
  if (typeof value.request_digest !== "string" || !SHA256_PATTERN.test(value.request_digest)) {
    throw new ToubaHandlerError("InvalidEffect", "effect.request_digest must be sha256:<hex>");
  }
  return Object.freeze({
    effect_id: value.effect_id,
    attempt_index: value.attempt_index,
    request_digest: value.request_digest,
  });
}

function validateCompensationEnvelope(value) {
  if (!isPlainObject(value)) {
    throw new ToubaHandlerError("InvalidCompensation", "compensation must be an object");
  }
  const allowed = new Set([
    "compensation_id",
    "compensates_effect_id",
    "plan_digest",
    "execution_request_digest",
    "original_tool_ref",
    "original_request_digest",
    "original_effect_receipt_digest",
    "original_effect_receipt",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ToubaHandlerError("InvalidCompensation", "compensation contains unknown fields");
  }
  if (
    typeof value.compensation_id !== "string"
    || !COMPENSATION_ID_PATTERN.test(value.compensation_id)
  ) {
    throw new ToubaHandlerError("InvalidCompensation", "compensation.compensation_id is invalid");
  }
  if (
    typeof value.compensates_effect_id !== "string"
    || !EFFECT_ID_PATTERN.test(value.compensates_effect_id)
  ) {
    throw new ToubaHandlerError("InvalidCompensation", "compensation.compensates_effect_id is invalid");
  }
  for (const field of [
    "plan_digest",
    "execution_request_digest",
    "original_request_digest",
    "original_effect_receipt_digest",
  ]) {
    if (typeof value[field] !== "string" || !SHA256_PATTERN.test(value[field])) {
      throw new ToubaHandlerError("InvalidCompensation", `compensation.${field} is invalid`);
    }
  }
  if (
    typeof value.original_tool_ref !== "string"
    || value.original_tool_ref.trim() === ""
    || value.original_tool_ref.length > 512
  ) {
    throw new ToubaHandlerError("InvalidCompensation", "compensation.original_tool_ref is invalid");
  }
  const originalEffectReceipt = validateOriginalEffectReceipt(
    value.original_effect_receipt,
    value.compensates_effect_id,
    value.original_request_digest,
  );
  if (canonicalDigest(originalEffectReceipt) !== value.original_effect_receipt_digest) {
    throw new ToubaHandlerError(
      "InvalidCompensation",
      "compensation.original_effect_receipt_digest does not match the receipt",
    );
  }
  return deepFreeze({
    compensation_id: value.compensation_id,
    compensates_effect_id: value.compensates_effect_id,
    plan_digest: value.plan_digest,
    execution_request_digest: value.execution_request_digest,
    original_tool_ref: value.original_tool_ref,
    original_request_digest: value.original_request_digest,
    original_effect_receipt_digest: value.original_effect_receipt_digest,
    original_effect_receipt: originalEffectReceipt,
  });
}

function validateOriginalEffectReceipt(value, effectId, requestDigest) {
  if (!isPlainObject(value)) {
    throw new ToubaHandlerError("InvalidCompensation", "original effect receipt must be an object");
  }
  const allowed = new Set([
    "effect_id",
    "request_digest",
    "outcome",
    "receipt_ref",
    "receipt_digest",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ToubaHandlerError("InvalidCompensation", "original effect receipt contains unknown fields");
  }
  if (
    value.effect_id !== effectId
    || value.request_digest !== requestDigest
    || value.outcome !== "applied"
  ) {
    throw new ToubaHandlerError("InvalidCompensation", "original effect receipt is not correlated");
  }
  if (
    typeof value.receipt_ref !== "string"
    || value.receipt_ref.trim() === ""
    || value.receipt_ref.length > MAX_EFFECT_RECEIPT_REF_LENGTH
  ) {
    throw new ToubaHandlerError("InvalidCompensation", "original effect receipt_ref is required");
  }
  if (
    value.receipt_digest !== undefined
    && (typeof value.receipt_digest !== "string" || !SHA256_PATTERN.test(value.receipt_digest))
  ) {
    throw new ToubaHandlerError("InvalidCompensation", "original effect receipt_digest is invalid");
  }
  return {
    effect_id: value.effect_id,
    request_digest: value.request_digest,
    outcome: "applied",
    receipt_ref: value.receipt_ref,
    ...(value.receipt_digest === undefined ? {} : { receipt_digest: value.receipt_digest }),
  };
}

function encodeEffectfulSuccess(value, effect) {
  if (!isPlainObject(value)) {
    throw new ToubaHandlerError(
      "EffectReceiptRequired",
      "effectful handlers must return { value, effect_receipt }",
    );
  }
  const allowed = new Set(["value", "effect_receipt", "memory_metadata"]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !Object.hasOwn(value, "value")) {
    throw new ToubaHandlerError(
      "EffectReceiptRequired",
      "effectful handlers must return only value, effect_receipt and optional memory_metadata",
    );
  }
  const effectReceipt = validateSdkEffectReceipt(value.effect_receipt, effect);
  const response = {
    ok: true,
    value: value.value,
    effect_receipt: effectReceipt,
  };
  if (Object.hasOwn(value, "memory_metadata")) {
    response.memory_metadata = value.memory_metadata;
  }
  return response;
}

function encodeCompensationSuccess(value, effect, compensation) {
  if (!isPlainObject(value)) {
    throw new ToubaHandlerError(
      "CompensationReceiptRequired",
      "V3 handlers must return { value, effect_receipt, compensation_receipt }",
    );
  }
  const allowed = new Set([
    "value",
    "effect_receipt",
    "compensation_receipt",
    "memory_metadata",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key)) || !Object.hasOwn(value, "value")) {
    throw new ToubaHandlerError(
      "CompensationReceiptRequired",
      "V3 handler success contains invalid fields",
    );
  }
  const effectReceipt = validateSdkEffectReceipt(value.effect_receipt, effect);
  if (effectReceipt.outcome !== "applied") {
    throw new ToubaHandlerError(
      "CompensationReceiptInvalid",
      "V3 handler success requires an applied effect receipt",
    );
  }
  const compensationReceipt = validateSdkCompensationReceipt(
    value.compensation_receipt,
    compensation,
    effect,
  );
  const response = {
    ok: true,
    value: value.value,
    effect_receipt: effectReceipt,
    compensation_receipt: compensationReceipt,
  };
  if (Object.hasOwn(value, "memory_metadata")) {
    response.memory_metadata = value.memory_metadata;
  }
  return response;
}

function validateSdkCompensationReceipt(value, compensation, effect) {
  if (!isPlainObject(value)) {
    throw new ToubaHandlerError("CompensationReceiptRequired", "compensation_receipt is required");
  }
  const allowed = new Set([
    "compensation_id",
    "compensates_effect_id",
    "inverse_effect_id",
    "result",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ToubaHandlerError(
      "CompensationReceiptInvalid",
      "compensation_receipt contains unknown fields",
    );
  }
  const expected = createCompensationReceipt(compensation, effect, { result: value.result });
  if (
    value.compensation_id !== expected.compensation_id
    || value.compensates_effect_id !== expected.compensates_effect_id
    || value.inverse_effect_id !== expected.inverse_effect_id
  ) {
    throw new ToubaHandlerError(
      "CompensationReceiptInvalid",
      "compensation_receipt does not match the request",
    );
  }
  return expected;
}

function validateSdkEffectReceipt(value, effect) {
  if (!isPlainObject(value)) {
    throw new ToubaHandlerError("EffectReceiptRequired", "effect_receipt is required");
  }
  const allowed = new Set([
    "effect_id",
    "request_digest",
    "outcome",
    "receipt_ref",
    "receipt_digest",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new ToubaHandlerError("EffectReceiptInvalid", "effect_receipt contains unknown fields");
  }
  if (value.effect_id !== effect.effect_id || value.request_digest !== effect.request_digest) {
    throw new ToubaHandlerError("EffectReceiptInvalid", "effect_receipt does not match the effect request");
  }
  return createEffectReceipt(effect, {
    outcome: value.outcome,
    ...(value.receipt_ref !== undefined ? { receipt_ref: value.receipt_ref } : {}),
    ...(value.receipt_digest !== undefined ? { receipt_digest: value.receipt_digest } : {}),
  });
}

function normalizeList(value, label) {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new ToubaHandlerError("InvalidHandlerRequest", `${label} must be an array`);
  }
  return value.map((item) => {
    if (typeof item !== "string") {
      throw new ToubaHandlerError("InvalidHandlerRequest", `${label} entries must be strings`);
    }
    return item;
  });
}

function normalizeError(error, effect = undefined, options = {}) {
  if (error instanceof ToubaHandlerError) {
    const normalized = {
      code: error.code,
      message: error.message,
    };
    if (effect !== undefined && error.details?.effect_receipt !== undefined) {
      try {
        normalized.effectReceipt = validateSdkEffectReceipt(error.details.effect_receipt, effect);
        if (
          options.compensation === true
          && normalized.effectReceipt.outcome !== "not_applied"
          && normalized.effectReceipt.outcome !== "unknown"
        ) {
          return {
            code: "CompensationReceiptInvalid",
            message: "V3 handler errors require not_applied or unknown effect outcome",
          };
        }
      } catch (receiptError) {
        if (receiptError instanceof ToubaHandlerError) {
          return {
            code: receiptError.code,
            message: receiptError.message,
          };
        }
        return {
          code: "EffectReceiptInvalid",
          message: "effect receipt is invalid",
        };
      }
    }
    return normalized;
  }
  return {
    code: "UnhandledHandlerError",
    message: "handler failed",
  };
}

async function readStdin() {
  let data = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    data += chunk;
  }
  return data;
}

function runProcess(command, args, options) {
  return new Promise((resolveProcess, rejectProcess) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", rejectProcess);
    child.on("close", (code, signal) => {
      resolveProcess({
        status: code ?? 1,
        signal,
        stdout,
        stderr,
      });
    });
  });
}

function requireString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToubaEngineError("options", `${label} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ToubaEngineError("options", `${label} must be a positive integer`);
  }
  return value;
}

function requireNonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new ToubaEngineError("options", `${label} must be a non-negative integer`);
  }
  return value;
}

function resolvePath(baseDir, path) {
  return isAbsolute(path) ? path : resolve(baseDir, path);
}

function appendOptionalPath(args, optionName, value, baseDir) {
  if (value !== undefined) {
    args.push(optionName, resolvePath(baseDir, requireString(value, optionName)));
  }
}

function appendOptionalJson(args, optionName, value, label) {
  if (value !== undefined) {
    args.push(optionName, JSON.stringify(normalizeJsonObject(value, label)));
  }
}

function normalizeJsonObject(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new ToubaEngineError("options", `${label} must be an object`);
  }
  return value;
}

function parseJsonOutput(raw, label) {
  try {
    return JSON.parse(raw.trim() === "" ? "null" : raw);
  } catch (error) {
    throw new ToubaEngineError("run", `touba ${label} is not valid JSON`, {
      cause: error instanceof Error ? error.message : String(error),
    });
  }
}

async function readOptionalJson(path) {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(await readFile(path, "utf8"));
}

function collectRedactionValues(env, extraValues) {
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (SECRET_ENV_NAME_PATTERN.test(name) && typeof value === "string" && value.length >= 4) {
      values.add(value);
    }
  }
  for (const value of extraValues) {
    if (typeof value === "string" && value.length >= 4) {
      values.add(value);
    }
  }
  return [...values].sort((left, right) => right.length - left.length);
}

function redactText(text, redactValues) {
  let redacted = text;
  for (const value of redactValues) {
    redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function canonicalDigest(value) {
  return `sha256:${createHash("sha256").update(JSON.stringify(canonicalValue(value))).digest("hex")}`;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalValue(item));
  if (isPlainObject(value)) {
    return Object.fromEntries(
      Object.keys(value).sort().map((key) => [key, canonicalValue(value[key])]),
    );
  }
  return value;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}
