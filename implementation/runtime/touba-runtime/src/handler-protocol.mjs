// @ts-check

import { spawn as spawnProcess } from "node:child_process";
import { isAbsolute, resolve as resolvePath } from "node:path";
import { accessSync, constants, existsSync, realpathSync, statSync } from "node:fs";
import { startupHandlerDiagnostic, validatedHandlerDiagnostic } from "./handler-diagnostics.mjs";
import { handlerIsolationIdentity } from './handler-isolation-evidence.mjs';
import { macosHandlerPolicy, macosHandlerLaunch, macosHandlerEvidenceFiles } from "./handler-sandbox-policy.mjs";
import { linuxHandlerSandboxPlan, linuxSandboxOptions } from "./linux-handler-sandbox.mjs";
import { windowsHandlerSandboxPlan, windowsSandboxOptions } from "./windows-handler-sandbox.mjs";
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
 * @property {{required?: boolean, profile?: string, code_paths?: string[], read_paths?: string[], write_paths?: string[], local_sockets?: string[]}=} sandbox
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
 * @property {Buffer=} seccomp
 * @property {Buffer=} policy
 * @property {Record<string, string | undefined>=} environment
 * @property {string[]=} evidenceFiles
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
 * @property {((observation: Record<string, unknown>) => void)=} onIsolationObservation
 */

/**
 * @param {RunProcessToolHandlerInput} input
 * @returns {Promise<ToolHandlerResult>}
 */
export async function runProcessToolHandler(input) {
  const { toolRef, binding, request, secretHandles, secretStore } = input;
  if (secretHandles.some(handle => handle.toUpperCase() === "PYTHONDONTWRITEBYTECODE")) {
    throw new RuntimeFailure("a secret handle conflicts with a reserved handler environment variable", {}, "ToolHandlerEnvironmentInvalid");
  }
  const secretValues = secretValuesForRedaction(secretStore);
  const requestPayload = `${JSON.stringify(request)}\n`;
  assertPayloadWithinLimit(
    Buffer.byteLength(requestPayload, "utf8"),
    binding.limits.max_payload_bytes,
    "tool handler request payload",
    toolRef,
    secretValues,
  );

  let sandboxPlan = preflightProcessToolHandler({
    binding,
    platform: input.platform ?? process.platform,
    env: input.env ?? process.env,
    diagnostic: Boolean(input.localHandlerDiagnostics),
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
  // A human wait or a durable reservation is not a promise that the selected
  // files still exist. Recheck immediately before launching, without running
  // the business handler during either preflight.
  if (binding.sandbox?.required === true) sandboxPlan = preflightProcessToolHandler({
    binding, platform: input.platform ?? process.platform, env: input.env ?? process.env,
    diagnostic: Boolean(input.localHandlerDiagnostics),
  });
  const childEnv = preparedChildEnv ?? buildHandlerEnv(secretHandles, secretStore);
  const isolationIdentity = input.onIsolationObservation ? handlerIsolationIdentity(binding, sandboxPlan) : null;
  if (sandboxPlan.environment) {
    if (Object.keys(childEnv).some(key => ["TEMP", "TMP"].includes(key.toUpperCase()))) {
      throw new RuntimeFailure("a secret handle conflicts with a reserved sandbox temporary location", {}, "HandlerSandboxEnvironmentInvalid");
    }
    for (const [name, value] of Object.entries(sandboxPlan.environment)) {
      if (Object.keys(childEnv).some(key => key.toLowerCase() === name.toLowerCase())) {
        throw new RuntimeFailure("a secret handle conflicts with a reserved sandbox environment variable", {}, "HandlerSandboxEnvironmentInvalid");
      }
      if (value !== undefined) childEnv[name] = value;
    }
  }
  const diagnostics = input.localHandlerDiagnostics;
  /** @param {string} arg */
  const diagnosticSourcePath = arg => {
    const path = resolvePath(binding.handler.cwd ?? process.cwd(), arg);
    try { return realpathSync(path); } catch { return path; }
  };
  const diagnosticSources = diagnostics ? binding.handler.args.flatMap((arg, index) =>
    /\.(?:mjs|cjs|js|py)$/u.test(arg) && !arg.startsWith("-")
      ? [{ index, path: diagnosticSourcePath(arg) }] : []).slice(0, 8) : [];
  if (diagnostics) {
    childEnv.TOUBA_LOCAL_DIAGNOSTIC_FD = "3";
    childEnv.TOUBA_LOCAL_DIAGNOSTIC_SOURCES = JSON.stringify(diagnosticSources);
  }
  if (sandboxPlan.mechanism === "windows-lpac-job" && sandboxPlan.policy) {
    const policy = JSON.parse(sandboxPlan.policy.toString("utf8"));
    policy.env_keys = Object.keys(childEnv).filter(key => !["SYSTEMROOT", "LOCALAPPDATA", "TEMP", "TMP"].includes(key.toUpperCase()));
    sandboxPlan.policy = Buffer.from(JSON.stringify(policy));
  }
  const child = /** @type {import('node:child_process').ChildProcessWithoutNullStreams} */ (spawnProcess(sandboxPlan.command, sandboxPlan.args, {
    cwd: binding.handler.cwd,
    env: childEnv,
    stdio: sandboxPlan.policy ? ["pipe", "pipe", "pipe", diagnostics ? "pipe" : "ignore", "pipe", "pipe"]
      : sandboxPlan.seccomp ? ["pipe", "pipe", "pipe", diagnostics ? "pipe" : "ignore", "pipe"]
      : diagnostics ? ["pipe", "pipe", "pipe", "pipe"] : ["pipe", "pipe", "pipe"],
    shell: false,
    windowsHide: true,
  }));
  if (sandboxPlan.seccomp) {
    const filter = /** @type {import('node:stream').Writable} */ (child.stdio[4]);
    filter.on("error", () => { /* the process failure is handled below */ });
    filter.end(sandboxPlan.seccomp);
  }
  if (sandboxPlan.policy) {
    const extra = /** @type {Array<import('node:stream').Readable | import('node:stream').Writable | null | undefined>} */ (child.stdio);
    const policy = /** @type {import('node:stream').Writable} */ (extra[5]);
    policy.on("error", () => { /* process failure is handled below */ });
    policy.end(sandboxPlan.policy);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let protocolObserved = false;
    /** @param {'completed'|'failed'} outcome */
    const recordIsolation = outcome => {
      if (!isolationIdentity || !input.onIsolationObservation) return;
      try { input.onIsolationObservation({ ...isolationIdentity, protocol_observed: protocolObserved, outcome }); }
      catch { /* Observability does not alter an effect's result. */ }
    };
    /** @type {RuntimeFailure | null} */
    let terminationError = null;
    let stdoutSize = 0;
    let stderrSize = 0;
    /** @type {Buffer[]} */
    const stdoutChunks = [];
    /** @type {Buffer[]} */
    const stderrChunks = [];
    let sandboxResultSize = 0;
    /** @type {Buffer[]} */
    const sandboxResultChunks = [];
    if (sandboxPlan.mechanism === "windows-lpac-job") child.stdio[4]?.on("data", chunk => {
      sandboxResultSize += chunk.length;
      if (sandboxResultSize <= 1024) sandboxResultChunks.push(chunk);
    });
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
        ? validatedHandlerDiagnostic(Buffer.concat(diagnosticChunks).toString("utf8"), diagnosticSources)
        : reason === "completed" ? null : startupHandlerDiagnostic(Buffer.concat(stderrChunks).toString("utf8"), diagnosticSources);
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
      recordIsolation('completed');
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
      recordIsolation('failed');
      recordDiagnostic(error instanceof RuntimeFailure ? error.code : "ToolHandlerFailure");
      reject(error);
    };

    /**
     * @param {RuntimeFailure} error
     */
    const failAndKill = (error) => {
      if (["bubblewrap-seccomp-landlock", "windows-lpac-job"].includes(sandboxPlan.mechanism ?? "")) {
        // Killing bubblewrap tears down its PID namespace. Wait for the child
        // pipes to close before reporting timeout: no detached descendant may
        // keep running after the failed handler is reported as stopped.
        if (terminationError) return;
        terminationError = error;
        child.kill("SIGKILL");
        return;
      }
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
      if (terminationError) { finishReject(terminationError); return; }
      if (sandboxPlan.mechanism === "windows-lpac-job") {
        let result;
        try { result = sandboxResultSize <= 1024 ? JSON.parse(Buffer.concat(sandboxResultChunks).toString("utf8")) : null; } catch { result = null; }
        if (result?.protocol !== "touba-windows-sandbox-result-v1"
          || (result.ok !== true && result.ok !== false)
          || (result.ok === true && result.exit_code !== code)) {
          finishReject(new RuntimeFailure("native sandbox returned no valid completion evidence", { toolRef }, "HandlerSandboxResultInvalid")); return;
        }
        if (result.ok === false) {
          const errorCode = typeof result.code === "string" && /^HandlerSandbox[A-Za-z]+$/u.test(result.code) ? result.code : "HandlerSandboxResultInvalid";
          finishReject(new RuntimeFailure("native sandbox admission or cleanup failed; check the selected paths and host permissions", { toolRef }, errorCode)); return;
        }
      }
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = redactSecrets(Buffer.concat(stderrChunks).toString("utf8"), secretValues);

      if (code !== 0) {
        if (sandboxPlan.enabled && /\b(?:EPERM|EACCES)\b|Operation not permitted/u.test(stderr)) {
          finishReject(new RuntimeFailure(
            "handler access was refused by the required sandbox; review sandbox code_paths and resource scopes, or use --handler-diagnostics for a private startup diagnostic",
            { toolRef, exitCode: code, signal }, "ToolHandlerSandboxAccessDenied"));
          return;
        }
        const missingSdk = /Cannot find package ['"]@touba\/sdk['"]|Cannot find module ['"]@touba\/sdk['"]|ModuleNotFoundError: No module named ['"]touba_sdk['"]/u.test(stderr);
        const missingProviderDependency = /Cannot find package ['"](?:ai|@ai-sdk\/[^'"]+|zod)['"]/u.test(stderr);
        if (missingSdk || missingProviderDependency) {
          finishReject(new RuntimeFailure(
            missingSdk
              ? "handler cannot load its SDK; use touba sdk install for its language and, under confinement, review the inventory from touba sdk sandbox"
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
        protocolObserved = response !== null && typeof response === 'object' && !Array.isArray(response)
          && typeof response.ok === 'boolean';
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
 * @param {{binding: ProcessToolBinding, platform?: string, env?: Record<string, string | undefined>, diagnostic?: boolean}} input
 * @returns {HandlerSandboxPlan}
 */
export function buildHandlerSandboxPlan({
  binding,
  platform = process.platform,
  env = process.env,
  diagnostic = false,
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
  // A sandbox executable or externally configured box is not proof that
  // this manifest's file/process/network grants are enforced.
  if (platform === "linux" && process.platform === "linux") {
    return linuxHandlerSandboxPlan(binding, handlerCommand, linuxSandboxOptions(env));
  }
  if (platform === "win32" && process.platform === "win32") {
    return windowsHandlerSandboxPlan(binding, handlerCommand, { ...windowsSandboxOptions(env), diagnostic });
  }
  if (platform === "linux" || platform === "win32") {
    throw new RuntimeFailure("required handler sandbox policy is not qualified on this host", { platform }, "HandlerSandboxUnsupportedPolicy");
  }
  if (platform === "darwin") {
    const command = env.TOUBA_SANDBOX_EXEC_COMMAND || "/usr/bin/sandbox-exec";
    const launch = macosHandlerLaunch(binding, handlerCommand);
    const policy = macosHandlerPolicy(binding, launch.command);
    return {
      enabled: true,
      mechanism: "sandbox-exec",
      command,
      environment: launch.environment,
      evidenceFiles: macosHandlerEvidenceFiles(launch.command),
      args: ["-p", policy, launch.command, ...binding.handler.args.map((arg, index) => {
        // Resolve selected script paths before Node attempts process.cwd in confinement.
        const file = resolvePath(binding.handler.cwd ?? process.cwd(), arg);
        // Generated bindings put the entrypoint first. Never rewrite business
        // arguments, or guess which values following interpreter flags are code.
        return index === 0 && !arg.startsWith("-") && /\.(?:mjs|cjs|js|py)$/.test(arg) && existsSync(file) ? file : arg;
      })],
    };
  }
  throw new RuntimeFailure(
    `handler sandbox is not supported on ${platform}`,
    { platform, handlerCommand: binding.handler.command },
    "HandlerSandboxUnsupportedPlatform",
  );
}

/** Read-only admission of a required process sandbox, not execution evidence.
 * @param {Parameters<typeof buildHandlerSandboxPlan>[0]} input
 * @returns {HandlerSandboxPlan}
 */
export function preflightProcessToolHandler(input) {
  const { binding } = input;
  if (binding.sandbox?.required === true) {
    const command = resolveHandlerCommand(binding.handler.command);
    const cwd = binding.handler.cwd ?? process.cwd();
    try {
      if (!isAbsolute(command) || !statSync(command).isFile() || !statSync(cwd).isDirectory()) throw new Error();
      accessSync(command, process.platform === 'win32' ? constants.R_OK : constants.X_OK);
      // An explicitly selected script must be present. Other arguments are
      // business values and must never be interpreted as host file paths.
      const entry = binding.handler.args[0];
      if (entry && !entry.startsWith('-') && /\.(?:mjs|cjs|js|py)$/u.test(entry)) {
        const path = resolvePath(cwd, entry);
        if (!statSync(path).isFile()) throw new Error();
        accessSync(path, constants.R_OK);
      }
    } catch {
      throw new RuntimeFailure('required sandbox needs a readable entrypoint, an executable interpreter and an existing working directory; check the binding before requesting approval', {}, 'HandlerSandboxPathInvalid');
    }
  }
  return buildHandlerSandboxPlan(input);
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
      // A missing/invalid receipt leaves the effect outcome unknown. Preserve
      // the handler's diagnostic without admitting the unverified receipt.
      if (response.ok === false) {
        const handlerError = response.error;
        const code = isPlainRecord(handlerError) && typeof handlerError.code === "string"
          && handlerError.code.trim() ? handlerError.code : "ToolHandlerError";
        const message = isPlainRecord(handlerError) && typeof handlerError.message === "string"
          ? handlerError.message : code;
        const handlerErrorCode = redactSecrets(code, secretValues);
        const cause = redactSecrets(message, secretValues);
        throw new RuntimeFailure(
          `tool handler returned error ${toolRef} [${handlerErrorCode}]: ${cause}; effect receipt is invalid, outcome is unknown`,
          { toolRef, handlerErrorCode, cause, effectId: effect.effect_id,
            requestDigest: effect.request_digest, state: "unknown", receiptErrorCode: error.code },
          "ToolHandlerReportedError",
        );
      }
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
  const env = { PYTHONDONTWRITEBYTECODE: "1" };
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
