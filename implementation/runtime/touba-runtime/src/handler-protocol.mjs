// @ts-check

import { spawn as spawnProcess } from "node:child_process";
import { resolve as resolvePath } from "node:path";
import { realpathSync } from "node:fs";
import { validatedHandlerDiagnostic } from "./handler-diagnostics.mjs";
import {
  validateEffectReceipt,
} from "./effect-contract.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";
import { redactSecrets, secretValuesForRedaction } from "./secret-redaction.mjs";

export const TOOL_HANDLER_PROTOCOL_VERSION = "touba-tool-handler-v1";

const COMPENSATION_ID_PATTERN = /^compensation:sha256:[0-9a-f]{64}$/u;
const EFFECT_ID_PATTERN = /^effect:sha256:[0-9a-f]{64}$/u;

/**
 * @typedef {import("./secret-redaction.mjs").SecretStore} SecretStore
 *
 * @typedef {object} ProcessToolBindingHandler
 * @property {string} command
 * @property {string[]} args
 * @property {string=} cwd
 *
 * @typedef {object} ProcessToolBindingLimits
 * @property {number} max_payload_bytes
 * @property {number} timeout_ms
 *
 * @typedef {object} ProcessToolBinding
 * @property {ProcessToolBindingHandler} handler
 * @property {ProcessToolBindingLimits} limits
 * @property {string[]=} grants
 * @property {{required?: boolean, profile?: string, box_name?: string}=} sandbox
 *
 * @typedef {object} ToolHandlerResult
 * @property {unknown} value
 * @property {unknown=} memoryMetadata
 * @property {import("./effect-contract.mjs").EffectReceipt=} effectReceipt
 * @property {Record<string, unknown>=} compensationReceipt
 *
 * @typedef {object} HandlerSandboxPlan
 * @property {boolean} enabled
 * @property {string | null} mechanism
 * @property {string} command
 * @property {string[]} args
 *
 * @typedef {object} RunProcessToolHandlerInput
 * @property {string} toolRef
 * @property {ProcessToolBinding} binding
 * @property {Record<string, unknown>} request
 * @property {string[]} secretHandles
 * @property {SecretStore | null | undefined} secretStore
 * @property {string=} platform
 * @property {Record<string, string | undefined>=} env
 * @property {(() => void | Promise<void>)=} beforeDispatch
 * @property {(() => void | Promise<void>)=} beforeSpawn
 * @property {ReturnType<import('./handler-diagnostics.mjs').openLocalHandlerDiagnostics>=} localHandlerDiagnostics
 * @property {string=} runId
 */

/**
 * @param {RunProcessToolHandlerInput} input
 * @returns {Promise<ToolHandlerResult>}
 */
export async function runProcessToolHandler(input) {
  const { toolRef, binding, request, secretHandles, secretStore } = input;
  const secretValues = secretValuesForRedaction(secretStore);
  const requestPayload = `${JSON.stringify(request)}\n`;
  assertPayloadWithinLimit(
    Buffer.byteLength(requestPayload, "utf8"),
    binding.limits.max_payload_bytes,
    "tool handler request payload",
    toolRef,
    secretValues,
  );

  const sandboxPlan = buildHandlerSandboxPlan({
    binding,
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
  });
  const isCompensation = request.operation === "compensate";
  const preparedChildEnv = isCompensation
    ? buildHandlerEnv(secretHandles, secretStore)
    : null;
  if (input.beforeDispatch) {
    await input.beforeDispatch();
  }
  if (!isCompensation && input.beforeSpawn) {
    await input.beforeSpawn();
  }
  const childEnv = preparedChildEnv ?? buildHandlerEnv(secretHandles, secretStore);
  const diagnostics = input.localHandlerDiagnostics;
  /** @param {string} arg */
  const diagnosticSourcePath = arg => {
    const path = resolvePath(binding.handler.cwd ?? process.cwd(), arg);
    try { return realpathSync(path); } catch { return path; }
  };
  const diagnosticSources = diagnostics ? binding.handler.args.flatMap((arg, index) =>
    /\.(?:mjs|cjs|js)$/u.test(arg) && !arg.startsWith("-")
      ? [{ index, path: diagnosticSourcePath(arg) }] : []).slice(0, 8) : [];
  if (diagnostics) {
    childEnv.TOUBA_LOCAL_DIAGNOSTIC_FD = "3";
    childEnv.TOUBA_LOCAL_DIAGNOSTIC_SOURCES = JSON.stringify(diagnosticSources);
  }
  const child = spawnProcess(sandboxPlan.command, sandboxPlan.args, {
    cwd: binding.handler.cwd,
    env: childEnv,
    stdio: diagnostics ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  });

  return new Promise((resolve, reject) => {
    let settled = false;
    let stdoutSize = 0;
    let stderrSize = 0;
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let diagnosticSize = 0;
    /** @type {Buffer[]} */
    const diagnosticChunks = [];
    if (diagnostics) child.stdio[3]?.on("data", chunk => {
      diagnosticSize += chunk.length;
      if (diagnosticSize <= 4096) diagnosticChunks.push(chunk);
      else diagnostics.markIncomplete();
    });
    /** @param {string} reason */
    const recordDiagnostic = reason => {
      if (!diagnostics) return;
      const detail = diagnosticSize > 0 && diagnosticSize <= 4096
        ? validatedHandlerDiagnostic(Buffer.concat(diagnosticChunks).toString("utf8"), diagnosticSources) : null;
      if (diagnosticSize > 0 && detail === null) diagnostics.markIncomplete();
      diagnostics.record({ run_id: input.runId ?? null, call_id: request.call_id ?? null,
        tool_ref: toolRef, reason, ...(detail ?? {}) });
    };

    const timer = setTimeout(() => {
      failAndKill(
        new RuntimeFailure(
          `tool handler timed out ${toolRef}`,
          { toolRef, timeoutMs: binding.limits.timeout_ms },
          "ToolHandlerTimeout",
        ),
      );
    }, binding.limits.timeout_ms);

    /**
     * @param {ToolHandlerResult} value
     */
    const finishResolve = (value) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      recordDiagnostic("completed");
      resolve(value);
    };

    /**
     * @param {unknown} error
     */
    const finishReject = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      recordDiagnostic(error instanceof RuntimeFailure ? error.code : "ToolHandlerFailure");
      reject(error);
    };

    /**
     * @param {RuntimeFailure} error
     */
    const failAndKill = (error) => {
      if (!child.killed) {
        child.kill("SIGTERM");
      }
      finishReject(error);
    };

    child.stdout.on("data", (chunk) => {
      const outputChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stdoutSize += outputChunk.length;
      if (stdoutSize > binding.limits.max_payload_bytes) {
        failAndKill(
          new RuntimeFailure(
            `tool handler stdout exceeded max_payload_bytes ${toolRef}`,
            { toolRef, maxPayloadBytes: binding.limits.max_payload_bytes },
            "ToolHandlerOutputTooLarge",
          ),
        );
        return;
      }
      stdoutChunks.push(outputChunk);
    });

    child.stderr.on("data", (chunk) => {
      const errorChunk = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      stderrSize += errorChunk.length;
      if (stderrSize > binding.limits.max_payload_bytes) {
        failAndKill(
          new RuntimeFailure(
            `tool handler stderr exceeded max_payload_bytes ${toolRef}`,
            { toolRef, maxPayloadBytes: binding.limits.max_payload_bytes },
            "ToolHandlerOutputTooLarge",
          ),
        );
        return;
      }
      stderrChunks.push(errorChunk);
    });

    child.on("error", (error) => {
      const message = redactSecrets(error instanceof Error ? error.message : String(error), secretValues);
      finishReject(
        new RuntimeFailure(
          `tool handler process failed ${toolRef}: ${message}`,
          { toolRef, cause: message },
          "ToolHandlerProcessError",
        ),
      );
    });

    child.on("close", (code, signal) => {
      if (settled) {
        return;
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = redactSecrets(Buffer.concat(stderrChunks).toString("utf8"), secretValues);

      if (code !== 0) {
        const missingSdk = /Cannot find package ['"]@touba\/sdk['"]|Cannot find module ['"]@touba\/sdk['"]/u.test(stderr);
        const missingProviderDependency = /Cannot find package ['"](?:ai|@ai-sdk\/[^'"]+|zod)['"]/u.test(stderr);
        if (missingSdk || missingProviderDependency) {
          finishReject(new RuntimeFailure(
            missingSdk
              ? "handler SDK is missing; install the SDK tarball shown by touba version --json in the project with npm install --offline --ignore-scripts --save-exact <archive.tgz>"
              : "handler SDK provider dependency is missing; reinstall the complete SDK tarball in the project",
            { toolRef }, missingSdk ? "ToolHandlerSdkMissing" : "ToolHandlerSdkDependencyMissing",
          ));
          return;
        }
        finishReject(
          new RuntimeFailure(
            `tool handler exited non-zero ${toolRef} (${code ?? signal}); inspect the handler with a local development test`,
            {
              toolRef,
              exitCode: code,
              signal,
            },
            "ToolHandlerNonZeroExit",
          ),
        );
        return;
      }

      let response;
      try {
        response = JSON.parse(stdout);
      } catch {
        finishReject(
          new RuntimeFailure(
            `tool handler returned invalid JSON ${toolRef}`,
            { toolRef },
            "ToolHandlerInvalidJson",
          ),
        );
        return;
      }

      try {
        finishResolve(decodeToolHandlerResponse(response, toolRef, secretValues, {
          effect: request.effect,
          compensation: request.operation === "compensate"
            ? request.compensation
            : undefined,
        }));
      } catch (error) {
        finishReject(error);
      }
    });

    child.stdin.on("error", (error) => {
      if (settled) {
        return;
      }
      const message = redactSecrets(error instanceof Error ? error.message : String(error), secretValues);
      failAndKill(
        new RuntimeFailure(
          `tool handler stdin failed ${toolRef}: ${message}`,
          { toolRef, cause: message },
          "ToolHandlerProcessError",
        ),
      );
    });
    child.stdin.end(requestPayload);
  });
}

/**
 * @param {{binding: ProcessToolBinding, platform?: string, env?: Record<string, string | undefined>}} input
 * @returns {HandlerSandboxPlan}
 */
export function buildHandlerSandboxPlan({
  binding,
  platform = process.platform,
  env = process.env,
}) {
  const sandbox = binding?.sandbox;
  if (sandbox?.required !== true) {
    return {
      enabled: false,
      mechanism: null,
      command: resolveHandlerCommand(binding.handler.command),
      args: binding.handler.args,
    };
  }
  const handlerCommand = resolveHandlerCommand(binding.handler.command);
  const grants = Array.isArray(binding.grants) ? binding.grants : [];
  if (platform === "linux") {
    const command = env.TOUBA_BWRAP_COMMAND || "bwrap";
    const args = [
      "--die-with-parent",
      "--unshare-pid",
      "--unshare-ipc",
      "--unshare-uts",
      "--proc",
      "/proc",
      "--dev",
      "/dev",
      "--ro-bind",
      "/",
      "/",
      "--tmpfs",
      "/tmp",
    ];
    if (!grants.includes("network")) {
      args.unshift("--unshare-net");
    }
    if (binding.handler.cwd) {
      args.push(grants.includes("filesystem_write") ? "--bind" : "--ro-bind", binding.handler.cwd, binding.handler.cwd);
    }
    args.push(handlerCommand, ...binding.handler.args);
    return {
      enabled: true,
      mechanism: "bubblewrap",
      command,
      args,
    };
  }
  if (platform === "darwin") {
    const command = env.TOUBA_SANDBOX_EXEC_COMMAND || "sandbox-exec";
    const policy = macosSeatbeltPolicy({ grants, cwd: binding.handler.cwd });
    return {
      enabled: true,
      mechanism: "sandbox-exec",
      command,
      args: ["-p", policy, handlerCommand, ...binding.handler.args],
    };
  }
  if (platform === "win32") {
    const command = env.TOUBA_SANDBOXIE_START_COMMAND || "Start.exe";
    const boxName = sandbox.box_name || "ToubaHandler";
    return {
      enabled: true,
      mechanism: "Sandboxie-Plus",
      command,
      args: [`/box:${boxName}`, handlerCommand, ...binding.handler.args],
    };
  }
  throw new RuntimeFailure(
    `handler sandbox is not supported on ${platform}`,
    { platform, handlerCommand: binding.handler.command },
    "HandlerSandboxUnsupportedPlatform",
  );
}

/**
 * @param {string} command
 * @returns {string}
 */
function resolveHandlerCommand(command) {
  return command === "node" || command === "node.exe"
    ? process.execPath
    : command;
}

/**
 * @param {{grants: string[], cwd?: string | undefined}} input
 * @returns {string}
 */
function macosSeatbeltPolicy({ grants, cwd }) {
  const rules = [
    "(version 1)",
    "(deny default)",
    "(allow process*)",
    "(allow sysctl*)",
    "(allow file-read*)",
    "(allow file-write* (subpath \"/tmp\"))",
  ];
  if (cwd && grants.includes("filesystem_write")) {
    rules.push(`(allow file-write* (subpath ${JSON.stringify(cwd)}))`);
  }
  if (grants.includes("network")) {
    rules.push("(allow network*)");
  }
  return rules.join("\n");
}

/**
 * @param {unknown} response
 * @param {string} toolRef
 * @param {string[]} secretValues
 * @param {{effect?: unknown, compensation?: unknown}} [options]
 * @returns {ToolHandlerResult}
 */
export function decodeToolHandlerResponse(response, toolRef, secretValues, options = {}) {
  if (!isPlainRecord(response)) {
    throw new RuntimeFailure(
      `tool handler response must be an object ${toolRef}`,
      { toolRef },
      "ToolHandlerInvalidResponse",
    );
  }

  if (options.compensation !== undefined) {
    return decodeCompensationToolHandlerResponse(
      response,
      toolRef,
      secretValues,
      options.effect,
      options.compensation,
    );
  }

  if (options.effect !== undefined) {
    return decodeEffectfulToolHandlerResponse(response, toolRef, secretValues, options.effect);
  }

  if (response.ok === true) {
    if (!Object.hasOwn(response, "value")) {
      throw new RuntimeFailure(
        `tool handler success response is missing value ${toolRef}`,
        { toolRef },
        "ToolHandlerInvalidResponse",
      );
    }
    /** @type {ToolHandlerResult} */
    const result = { value: response.value };
    if (Object.hasOwn(response, "memory_metadata")) {
      result.memoryMetadata = response.memory_metadata;
    }
    return result;
  }

  if (response.ok === false) {
    const handlerError = response.error;
    const rawHandlerErrorCode =
      isPlainRecord(handlerError) && typeof handlerError.code === "string" && handlerError.code.trim() !== ""
        ? handlerError.code
        : "ToolHandlerError";
    const handlerErrorCode = redactSecrets(rawHandlerErrorCode, secretValues);
    const rawMessage =
      isPlainRecord(handlerError) && typeof handlerError.message === "string"
        ? handlerError.message
        : handlerErrorCode;
    const message = redactSecrets(rawMessage, secretValues);
    throw new RuntimeFailure(
      `tool handler returned error ${toolRef} [${handlerErrorCode}]: ${message}`,
      { toolRef, handlerErrorCode, cause: message },
      "ToolHandlerReportedError",
    );
  }

  throw new RuntimeFailure(
    `tool handler response ok must be boolean ${toolRef}`,
    { toolRef },
    "ToolHandlerInvalidResponse",
  );
}

/**
 * @param {Record<string, unknown>} response
 * @param {string} toolRef
 * @param {string[]} secretValues
 * @param {unknown} effect
 * @returns {ToolHandlerResult}
 */
function decodeEffectfulToolHandlerResponse(response, toolRef, secretValues, effect) {
  if (!isPlainRecord(effect)) {
    throw new RuntimeFailure(
      `effectful handler request is missing effect ${toolRef}`,
      { toolRef },
      "EffectContextRequired",
    );
  }
  const allowedResponseFields = new Set([
    "ok",
    "value",
    "error",
    "memory_metadata",
    "effect_receipt",
  ]);
  const unknownFields = Object.keys(response).filter((key) => !allowedResponseFields.has(key));
  if (unknownFields.length > 0) {
    throw new RuntimeFailure(
      `effectful tool handler response contains unknown fields ${toolRef}`,
      { toolRef, effectId: effect.effect_id, unknownFieldCount: unknownFields.length },
      "EffectReceiptInvalid",
    );
  }
  let effectReceipt;
  try {
    /** @type {{secretValues: string[], effectId?: string, requestDigest?: string}} */
    const expectedReceipt = { secretValues };
    if (typeof effect.effect_id === "string") {
      expectedReceipt.effectId = effect.effect_id;
    }
    if (typeof effect.request_digest === "string") {
      expectedReceipt.requestDigest = effect.request_digest;
    }
    effectReceipt = validateEffectReceipt(response.effect_receipt, expectedReceipt);
  } catch (error) {
    if (error instanceof RuntimeFailure) {
      error.details.toolRef = toolRef;
    }
    throw error;
  }

  if (response.ok === true) {
    if (!Object.hasOwn(response, "value")) {
      throw new RuntimeFailure(
        `effectful tool handler success response is missing value ${toolRef}`,
        { toolRef, effectId: effectReceipt.effect_id },
        "EffectReceiptInvalid",
      );
    }
    /** @type {ToolHandlerResult} */
    const result = { value: response.value, effectReceipt };
    if (Object.hasOwn(response, "memory_metadata")) {
      result.memoryMetadata = response.memory_metadata;
    }
    return result;
  }

  if (response.ok === false) {
    const handlerError = response.error;
    const rawHandlerErrorCode =
      isPlainRecord(handlerError) && typeof handlerError.code === "string" && handlerError.code.trim() !== ""
        ? handlerError.code
        : "ToolHandlerError";
    const handlerErrorCode = redactSecrets(rawHandlerErrorCode, secretValues);
    const rawMessage =
      isPlainRecord(handlerError) && typeof handlerError.message === "string"
        ? handlerError.message
        : handlerErrorCode;
    const message = redactSecrets(rawMessage, secretValues);
    throw new RuntimeFailure(
      `tool handler returned error ${toolRef} [${handlerErrorCode}]: ${message}`,
      {
        toolRef,
        handlerErrorCode,
        cause: message,
        effectId: effectReceipt.effect_id,
        requestDigest: effectReceipt.request_digest,
        effectReceipt,
      },
      "ToolHandlerReportedError",
    );
  }

  throw new RuntimeFailure(
    `effectful tool handler response ok must be boolean ${toolRef}`,
    { toolRef, effectId: effectReceipt.effect_id },
    "EffectReceiptInvalid",
  );
}

/**
 * @param {Record<string, unknown>} response
 * @param {string} toolRef
 * @param {string[]} secretValues
 * @param {unknown} effect
 * @param {unknown} compensation
 * @returns {ToolHandlerResult}
 */
function decodeCompensationToolHandlerResponse(
  response,
  toolRef,
  secretValues,
  effect,
  compensation,
) {
  if (!isPlainRecord(effect)) {
    throw new RuntimeFailure(
      `compensation handler request is missing effect ${toolRef}`,
      { toolRef },
      "EffectContextRequired",
    );
  }
  const context = validateCompensationRequestContext(compensation, effect, toolRef);
  const successFields = new Set([
    "ok",
    "value",
    "memory_metadata",
    "effect_receipt",
    "compensation_receipt",
  ]);
  const errorFields = new Set(["ok", "error", "effect_receipt"]);
  const allowed = response.ok === true ? successFields : errorFields;
  if (Object.keys(response).some((key) => !allowed.has(key))) {
    throw new RuntimeFailure(
      `compensation tool handler response contains unknown fields ${toolRef}`,
      { toolRef, effectId: effect.effect_id },
      "CompensationReceiptInvalid",
    );
  }
  let effectReceipt;
  try {
    /** @type {{secretValues: string[], effectId?: string, requestDigest?: string}} */
    const expected = { secretValues };
    if (typeof effect.effect_id === "string") expected.effectId = effect.effect_id;
    if (typeof effect.request_digest === "string") expected.requestDigest = effect.request_digest;
    effectReceipt = validateEffectReceipt(response.effect_receipt, expected);
  } catch (error) {
    if (error instanceof RuntimeFailure) error.details.toolRef = toolRef;
    throw error;
  }

  if (response.ok === true) {
    if (!Object.hasOwn(response, "value") || effectReceipt.outcome !== "applied") {
      throw new RuntimeFailure(
        `compensation handler success requires value and applied receipt ${toolRef}`,
        { toolRef, effectId: effectReceipt.effect_id },
        "CompensationReceiptInvalid",
      );
    }
    const compensationReceipt = validateCompensationReceipt(
      response.compensation_receipt,
      context,
      effectReceipt.effect_id,
      toolRef,
    );
    /** @type {ToolHandlerResult} */
    const result = {
      value: response.value,
      effectReceipt,
      compensationReceipt,
    };
    if (Object.hasOwn(response, "memory_metadata")) {
      result.memoryMetadata = response.memory_metadata;
    }
    return result;
  }

  if (response.ok === false) {
    if (effectReceipt.outcome !== "not_applied" && effectReceipt.outcome !== "unknown") {
      throw new RuntimeFailure(
        `compensation handler error has invalid effect outcome ${toolRef}`,
        { toolRef, effectId: effectReceipt.effect_id },
        "CompensationReceiptInvalid",
      );
    }
    const handlerError = response.error;
    const rawCode = isPlainRecord(handlerError)
      && typeof handlerError.code === "string"
      && handlerError.code.trim() !== ""
      ? handlerError.code
      : "ToolHandlerError";
    const handlerErrorCode = redactSecrets(rawCode, secretValues);
    const rawMessage = isPlainRecord(handlerError) && typeof handlerError.message === "string"
      ? handlerError.message
      : handlerErrorCode;
    const message = redactSecrets(rawMessage, secretValues);
    throw new RuntimeFailure(
      `tool handler returned error ${toolRef} [${handlerErrorCode}]: ${message}`,
      {
        toolRef,
        handlerErrorCode,
        cause: message,
        effectId: effectReceipt.effect_id,
        requestDigest: effectReceipt.request_digest,
        effectReceipt,
      },
      "ToolHandlerReportedError",
    );
  }

  throw new RuntimeFailure(
    `compensation tool handler response ok must be boolean ${toolRef}`,
    { toolRef, effectId: effect.effect_id },
    "CompensationReceiptInvalid",
  );
}

/**
 * @param {unknown} value
 * @param {Record<string, unknown>} effect
 * @param {string} toolRef
 * @returns {{compensationId: string, compensatesEffectId: string}}
 */
function validateCompensationRequestContext(value, effect, toolRef) {
  if (!isPlainRecord(value)) {
    throw new RuntimeFailure(
      `compensation handler request is missing compensation context ${toolRef}`,
      { toolRef },
      "CompensationContextRequired",
    );
  }
  if (
    typeof value.compensation_id !== "string"
    || !COMPENSATION_ID_PATTERN.test(value.compensation_id)
    || typeof value.compensates_effect_id !== "string"
    || !EFFECT_ID_PATTERN.test(value.compensates_effect_id)
    || typeof effect.effect_id !== "string"
    || !EFFECT_ID_PATTERN.test(effect.effect_id)
  ) {
    throw new RuntimeFailure(
      `compensation handler request identities are invalid ${toolRef}`,
      { toolRef },
      "CompensationContextRequired",
    );
  }
  return {
    compensationId: value.compensation_id,
    compensatesEffectId: value.compensates_effect_id,
  };
}

/**
 * @param {unknown} value
 * @param {{compensationId: string, compensatesEffectId: string}} context
 * @param {string} inverseEffectId
 * @param {string} toolRef
 * @returns {Record<string, unknown>}
 */
function validateCompensationReceipt(value, context, inverseEffectId, toolRef) {
  if (!isPlainRecord(value)) {
    throw new RuntimeFailure(
      `compensation_receipt is required ${toolRef}`,
      { toolRef, effectId: inverseEffectId },
      "CompensationReceiptInvalid",
    );
  }
  const allowed = new Set([
    "compensation_id",
    "compensates_effect_id",
    "inverse_effect_id",
    "result",
  ]);
  if (Object.keys(value).some((key) => !allowed.has(key))) {
    throw new RuntimeFailure(
      `compensation_receipt contains unknown fields ${toolRef}`,
      { toolRef, effectId: inverseEffectId },
      "CompensationReceiptInvalid",
    );
  }
  if (
    value.compensation_id !== context.compensationId
    || value.compensates_effect_id !== context.compensatesEffectId
    || value.inverse_effect_id !== inverseEffectId
    || (value.result !== "completed" && value.result !== "partial")
  ) {
    throw new RuntimeFailure(
      `compensation_receipt does not match the request ${toolRef}`,
      { toolRef, effectId: inverseEffectId },
      "CompensationReceiptInvalid",
    );
  }
  return Object.freeze({
    compensation_id: value.compensation_id,
    compensates_effect_id: value.compensates_effect_id,
    inverse_effect_id: value.inverse_effect_id,
    result: value.result,
  });
}

/**
 * @param {string[]} secretHandles
 * @param {SecretStore | null | undefined} secretStore
 * @returns {Record<string, string>}
 */
function buildHandlerEnv(secretHandles, secretStore) {
  /** @type {Record<string, string>} */
  const env = {};
  for (const handle of secretHandles) {
    const value = secretStore?.valueFor?.(handle);
    if (value !== undefined) {
      env[handle] = value;
    }
  }
  return env;
}

/**
 * @param {number} size
 * @param {number} limit
 * @param {string} label
 * @param {string} toolRef
 * @param {string[]} secretValues
 */
function assertPayloadWithinLimit(size, limit, label, toolRef, secretValues) {
  if (size > limit) {
    throw new RuntimeFailure(
      `${redactSecrets(label, secretValues)} exceeded max_payload_bytes ${toolRef}`,
      { toolRef, size, maxPayloadBytes: limit },
      "ToolHandlerPayloadTooLarge",
    );
  }
}

/**
 * @param {unknown} value
 * @returns {value is Record<string, unknown>}
 */
function isPlainRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
