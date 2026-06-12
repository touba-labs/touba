// @ts-check

import { spawn as spawnProcess } from "node:child_process";
import { RuntimeFailure } from "./runtime-errors.mjs";
import { redactSecrets, secretValuesForRedaction } from "./secret-redaction.mjs";

export const TOOL_HANDLER_PROTOCOL_VERSION = "touba-tool-handler-v1";

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
 *
 * @typedef {object} ToolHandlerResult
 * @property {unknown} value
 * @property {unknown=} memoryMetadata
 *
 * @typedef {object} RunProcessToolHandlerInput
 * @property {string} toolRef
 * @property {ProcessToolBinding} binding
 * @property {Record<string, unknown>} request
 * @property {string[]} secretHandles
 * @property {SecretStore | null | undefined} secretStore
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

  const childEnv = buildHandlerEnv(secretHandles, secretStore);
  const child = spawnProcess(binding.handler.command, binding.handler.args, {
    cwd: binding.handler.cwd,
    env: childEnv,
    stdio: ["pipe", "pipe", "pipe"],
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
        const suffix = stderr.trim() ? `: ${stderr.trim()}` : "";
        finishReject(
          new RuntimeFailure(
            `tool handler exited non-zero ${toolRef} (${code ?? signal})${suffix}`,
            {
              toolRef,
              exitCode: code,
              signal,
              cause: stderr.trim() || undefined,
            },
            "ToolHandlerNonZeroExit",
          ),
        );
        return;
      }

      let response;
      try {
        response = JSON.parse(stdout);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        finishReject(
          new RuntimeFailure(
            `tool handler returned invalid JSON ${toolRef}: ${message}`,
            { toolRef, cause: message },
            "ToolHandlerInvalidJson",
          ),
        );
        return;
      }

      try {
        finishResolve(decodeToolHandlerResponse(response, toolRef, secretValues));
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
 * @param {unknown} response
 * @param {string} toolRef
 * @param {string[]} secretValues
 * @returns {ToolHandlerResult}
 */
export function decodeToolHandlerResponse(response, toolRef, secretValues) {
  if (!isPlainRecord(response)) {
    throw new RuntimeFailure(
      `tool handler response must be an object ${toolRef}`,
      { toolRef },
      "ToolHandlerInvalidResponse",
    );
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
    const handlerErrorCode =
      isPlainRecord(handlerError) && typeof handlerError.code === "string" && handlerError.code.trim() !== ""
        ? handlerError.code
        : "ToolHandlerError";
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
