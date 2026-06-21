#!/usr/bin/env node
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  executeTriggerEvent,
  loadAirFromJson,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
  ToubaRuntimeError,
} from "@touba/runtime";

const QUEUE_SCHEMA_VERSION = "touba-trigger-queue-v0.1";
const STATE_SCHEMA_VERSION = "touba-trigger-state-v0.1";
const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 64 * 1024;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_PROCESSING_TIMEOUT_MS = 5 * 60 * 1000;

if (isMainModule()) {
  try {
    const parsed = parseArgs(process.argv.slice(2));
    if (parsed.help) {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const service = await createTriggerService(parsed);
    await service.start();
  } catch (error) {
    process.stderr.write(`trigger service error [${error.code ?? "TriggerServiceError"}]: ${error.message}\n`);
    process.exit(1);
  }
}

export async function createTriggerService(options) {
  const airPath = resolve(required(options.airPath, "AIR path"));
  const manifestPath = resolve(required(options.manifestPath, "--manifest"));
  const statePath = resolve(required(options.statePath, "--state"));
  const queuePath = resolve(required(options.queuePath, "--queue"));
  assertSuffix(statePath, ".trigger-state.json", "TriggerStatePathInvalid");
  assertSuffix(queuePath, ".trigger-queue.json", "TriggerQueuePathInvalid");
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const maxAttempts = options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const processingTimeoutMs = options.processingTimeoutMs ?? DEFAULT_PROCESSING_TIMEOUT_MS;

  const document = loadAirFromJson(readFileSync(airPath, "utf8"));
  const manifest = loadManifestFromPath(manifestPath);
  const secretStore = options.secretsPath === undefined
    ? undefined
    : loadSecretsFromJson(readFileSync(resolve(options.secretsPath), "utf8"), {
      baseDir: dirname(resolve(options.secretsPath)),
    });
  const routes = buildRequestRoutes(document, manifest, options.triggerRef);
  if (routes.length === 0) {
    throw serviceError(
      "TriggerServiceNoRequestRoutes",
      "no request trigger route is available in the AIR document",
    );
  }

  const authToken = options.authTokenEnv === undefined ? undefined : process.env[options.authTokenEnv];
  if (options.authTokenEnv !== undefined && (!authToken || authToken.trim() === "")) {
    throw serviceError(
      "TriggerServiceAuthTokenMissing",
      `environment variable ${options.authTokenEnv} is required`,
    );
  }
  if (!isLoopbackHost(host) && authToken === undefined) {
    throw serviceError(
      "TriggerServiceAuthRequired",
      "non-loopback trigger service hosts require --auth-token-env",
    );
  }
  const signatureSecret = options.signatureSecretEnv === undefined ? undefined : process.env[options.signatureSecretEnv];
  if (options.signatureSecretEnv !== undefined && (!signatureSecret || signatureSecret.trim() === "")) {
    throw serviceError(
      "TriggerServiceSignatureSecretMissing",
      `environment variable ${options.signatureSecretEnv} is required`,
    );
  }

  const serverState = {
    processedCount: 0,
    stopping: false,
  };
  const workerOptions = {
    document,
    manifest,
    secretStore,
    statePath,
    queuePath,
    traceDir: options.traceDir,
    server: undefined,
    serverState,
    maxEvents: options.maxEvents,
    maxAttempts,
    processingTimeoutMs,
  };

  const server = createServer(async (request, response) => {
    try {
      if (request.method === "GET" && request.url === "/health") {
        writeJson(response, 200, {
          status: "ok",
          service: "touba-trigger-service",
          queue_schema_version: QUEUE_SCHEMA_VERSION,
        });
        return;
      }

      const route = matchRoute(routes, request.method, request.url);
      if (!route) {
        writeJson(response, 404, {
          status: "error",
          code: "TriggerRouteNotFound",
        });
        return;
      }
      if (authToken !== undefined && !authorized(request, authToken)) {
        writeJson(response, 401, {
          status: "error",
          code: "TriggerUnauthorized",
        });
        return;
      }

      const body = await readBoundedBody(request, route.payload?.maxBytes ?? MAX_BODY_BYTES);
      if (signatureSecret !== undefined) {
        assertValidSignature(request, body.buffer, signatureSecret);
      }
      const argumentsFromPayload = materializePayloadArguments(route, request, body);
      const eventId = triggerEventId(request, route.trigger, body.digest);
      const queueId = `queue:${Date.now()}:${hashText(`${route.trigger.id}:${eventId}`).slice(0, 12)}`;
      const queue = loadQueue(queuePath);
      const entry = {
        queue_id: queueId,
        trigger_ref: route.trigger.id,
        event_id: eventId,
        source_kind: "request",
        status: "queued",
        received_at: new Date().toISOString(),
        http: {
          method: route.method,
          path: route.path,
          payload_bytes: body.bytes,
          payload_sha256: body.digest,
        },
        arguments: argumentsFromPayload ?? undefined,
        payload_contract: route.payload === undefined ? undefined : {
          format: route.payload.format,
          mapped_inputs: Object.keys(route.payload.map).sort(),
        },
      };
      queue.entries.push(entry);
      saveQueue(queuePath, queue);

      writeJson(response, 202, {
        status: "queued",
        queue_id: queueId,
        trigger_ref: route.trigger.id,
        event_id: eventId,
      });

      setImmediate(() => {
        processQueue({
          ...workerOptions,
          server,
        }).catch((error) => {
          process.stderr.write(`trigger service worker error [${error.code ?? "TriggerServiceWorkerError"}]: ${error.message}\n`);
        });
      });
    } catch (error) {
      const code = error.code ?? "TriggerServiceRequestFailed";
      writeJson(response, httpStatusForServiceError(code), {
        status: "error",
        code,
        message: error.message,
      });
    }
  });

  return {
    async start() {
      await new Promise((resolveListen) => {
        server.listen(port, host, resolveListen);
      });
      const address = server.address();
      process.stdout.write(`${JSON.stringify({
        event: "trigger_service_started",
        host,
        port: address.port,
        routes: routes.map((route) => ({
          method: route.method,
          path: route.path,
          trigger_ref: route.trigger.id,
        })),
        queue: queuePath,
        state: statePath,
      })}\n`);
      setImmediate(() => {
        processQueue({
          ...workerOptions,
          server,
        }).catch((error) => {
          process.stderr.write(`trigger service worker error [${error.code ?? "TriggerServiceWorkerError"}]: ${error.message}\n`);
        });
      });
    },
    server,
  };
}

async function processQueue({
  document,
  manifest,
  secretStore,
  statePath,
  queuePath,
  traceDir,
  server,
  serverState,
  maxEvents,
  maxAttempts,
  processingTimeoutMs,
}) {
  if (serverState.stopping) {
    return;
  }
  while (!serverState.stopping) {
    const queue = loadQueue(queuePath);
    const recovered = recoverStaleProcessingEntries(queue, processingTimeoutMs);
    const entry = queue.entries.find((candidate) =>
      candidate.status === "queued"
      && (!candidate.next_attempt_at || Date.parse(candidate.next_attempt_at) <= Date.now())
    );
    if (!entry) {
      if (recovered) {
        saveQueue(queuePath, queue);
      }
      return;
    }
    entry.status = "processing";
    entry.started_at = new Date().toISOString();
    entry.attempt_count = (entry.attempt_count ?? 0) + 1;
    saveQueue(queuePath, queue);

    const triggerState = loadTriggerState(statePath);
    const event = {
      trigger_ref: entry.trigger_ref,
      event_id: entry.event_id,
      source_kind: entry.source_kind,
      arguments: entry.arguments,
    };
    const result = await executeTriggerEventWithState(document, event, {
      toolBindingManifest: manifest,
      secretStore,
      statePath,
      runId: `trigger-service-${entry.queue_id.replaceAll(/[^A-Za-z0-9_-]/gu, "-")}-attempt-${entry.attempt_count}`,
      triggerRunCounts: {
        [entry.trigger_ref]: countAcceptedTriggerEvents(triggerState, entry.trigger_ref, currentDayKey()),
      },
    }, triggerState);

    const finishedQueue = loadQueue(queuePath);
    const stored = finishedQueue.entries.find((candidate) => candidate.queue_id === entry.queue_id);
    if (stored) {
      const refusal = lastTriggerRefusal(result.trace, entry.trigger_ref, entry.event_id);
      const runtimeErrorCode = refusal?.payload?.runtime_error_code;
      stored.completed_at = new Date().toISOString();
      stored.run_id = result.trace?.run?.run_id;
      stored.runtime_status = result.status;
      stored.runtime_error_code = runtimeErrorCode;
      stored.refusal_reason = refusal?.payload?.reason;
      if (traceDir !== undefined) {
        mkdirSync(resolve(traceDir), { recursive: true });
        const tracePath = join(resolve(traceDir), `${safeFilePart(entry.queue_id)}.attempt-${entry.attempt_count}.trace.json`);
        writeFileSync(tracePath, `${JSON.stringify(result.trace, null, 2)}\n`, "utf8");
        stored.trace_path = tracePath;
      }
      if (result.status === "success") {
        stored.status = "succeeded";
      } else if (shouldRetryQueueEntry(stored, runtimeErrorCode, maxAttempts)) {
        stored.status = "queued";
        stored.next_attempt_at = new Date(Date.now() + retryDelayMs(stored.attempt_count ?? 1)).toISOString();
      } else {
        stored.status = isNonRetryableRuntimeErrorCode(runtimeErrorCode) ? "failed" : "dead_lettered";
        stored.dead_lettered_at = stored.status === "dead_lettered" ? new Date().toISOString() : undefined;
      }
    }
    saveQueue(queuePath, finishedQueue);

    serverState.processedCount += 1;
    if (maxEvents !== undefined && serverState.processedCount >= maxEvents) {
      serverState.stopping = true;
      server.close();
    }
  }
}

async function executeTriggerEventWithState(document, triggerEvent, executionOptions, state) {
  const event = normalizeStateTriggerEvent(triggerEvent);
  if (event.triggerRef && event.eventId && isTriggerEventConsumed(state, event.triggerRef, event.eventId)) {
    const result = replayRejectedResult(document, event, executionOptions.runId);
    recordTriggerStateEvent(state, event, result);
    saveTriggerState(executionOptions.statePath, state);
    return result;
  }
  const result = await executeTriggerEvent(document, triggerEvent, executionOptions);
  recordTriggerStateEvent(state, event, result);
  saveTriggerState(executionOptions.statePath, state);
  return result;
}

function loadManifestFromPath(manifestPath) {
  const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const manifestDir = dirname(resolve(manifestPath));
  for (const binding of Object.values(rawManifest.bindings ?? {})) {
    if (binding?.handler?.cwd && !isAbsolute(binding.handler.cwd)) {
      binding.handler.cwd = resolve(manifestDir, binding.handler.cwd);
    }
  }
  return loadToolBindingManifestFromJson(JSON.stringify(rawManifest));
}

function buildRequestRoutes(document, manifest, triggerRef) {
  return (document.definitions?.triggers ?? [])
    .filter((trigger) => trigger.event?.kind === "request")
    .filter((trigger) => triggerRef === undefined || trigger.id === triggerRef)
    .map((trigger) => {
      const parsed = parseRequestEventValue(trigger.event.value);
      const manifestTrigger = manifest.triggers.get(trigger.id);
      if (!manifestTrigger || manifestTrigger.enabled !== true || manifestTrigger.source?.kind !== "request") {
        return null;
      }
      const target = (document.definitions?.strategies ?? [])
        .find((candidate) => candidate.id === trigger.target_ref);
      validatePayloadMappingAgainstTarget(manifestTrigger.payload, target, trigger.id);
      return parsed === null ? null : { ...parsed, trigger, target, payload: manifestTrigger.payload };
    })
    .filter(Boolean);
}

function parseRequestEventValue(value) {
  if (typeof value !== "string") {
    return null;
  }
  const match = /^(GET|POST|PUT|PATCH|DELETE) (\/\S*)$/u.exec(value);
  if (!match) {
    return null;
  }
  return {
    method: match[1],
    path: match[2],
  };
}

function matchRoute(routes, method, url) {
  const parsed = new URL(url, "http://127.0.0.1");
  return routes.find((route) => route.method === method && route.path === parsed.pathname);
}

function validatePayloadMappingAgainstTarget(payload, target, triggerRef) {
  if (payload === undefined) {
    return;
  }
  if (!target) {
    throw serviceError("TriggerPayloadContractInvalid", "payload mapping requires an existing target strategy");
  }
  const inputNames = (target.signature?.inputs ?? []).map((input) => input.name);
  const unknownInputs = Object.keys(payload.map).filter((inputName) => !inputNames.includes(inputName));
  if (unknownInputs.length > 0) {
    throw serviceError(
      "TriggerPayloadContractInvalid",
      `payload mapping references unknown strategy inputs for ${triggerRef}: ${unknownInputs.join(", ")}`,
    );
  }
}

function materializePayloadArguments(route, request, body) {
  if (route.payload === undefined) {
    return undefined;
  }
  assertAcceptedContentType(request, route.payload.contentTypes);
  const text = body.buffer.toString("utf8");
  let parsed;
  try {
    parsed = text.trim() === "" ? null : JSON.parse(text);
  } catch (error) {
    throw serviceError(
      "TriggerPayloadInvalid",
      `request body must be valid JSON: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const args = {};
  for (const [inputName, jsonPath] of Object.entries(route.payload.map)) {
    const value = readJsonPath(parsed, jsonPath);
    if (value === undefined) {
      throw serviceError("TriggerPayloadInvalid", `request body is missing mapped field ${jsonPath}`);
    }
    args[inputName] = value;
  }
  return args;
}

function assertAcceptedContentType(request, acceptedContentTypes) {
  const header = request.headers["content-type"];
  const contentType = Array.isArray(header) ? header[0] : header;
  const normalized = typeof contentType === "string"
    ? contentType.split(";")[0].trim().toLowerCase()
    : "";
  if (!acceptedContentTypes.includes(normalized)) {
    throw serviceError(
      "TriggerPayloadContentTypeUnsupported",
      `content-type must be one of ${acceptedContentTypes.join(", ")}`,
    );
  }
}

function readJsonPath(root, jsonPath) {
  if (jsonPath === "$") {
    return root;
  }
  const parts = jsonPath.slice(2).split(".");
  let current = root;
  for (const part of parts) {
    if (!current || typeof current !== "object" || Array.isArray(current) || !Object.hasOwn(current, part)) {
      return undefined;
    }
    current = current[part];
  }
  return current;
}

function loadQueue(queuePath) {
  if (!existsSync(queuePath)) {
    return {
      trigger_queue_schema_version: QUEUE_SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      entries: [],
    };
  }
  const queue = JSON.parse(readFileSync(queuePath, "utf8"));
  if (queue.trigger_queue_schema_version !== QUEUE_SCHEMA_VERSION) {
    throw serviceError("TriggerQueueSchemaMismatch", `trigger_queue_schema_version must be ${QUEUE_SCHEMA_VERSION}`);
  }
  if (!Array.isArray(queue.entries)) {
    throw serviceError("TriggerQueueSchemaMismatch", "trigger queue entries must be an array");
  }
  return queue;
}

function recoverStaleProcessingEntries(queue, processingTimeoutMs) {
  let recovered = false;
  const now = Date.now();
  for (const entry of queue.entries) {
    if (entry.status !== "processing") {
      continue;
    }
    const startedAt = Date.parse(entry.started_at ?? "");
    if (!Number.isFinite(startedAt) || now - startedAt < processingTimeoutMs) {
      continue;
    }
    entry.status = "queued";
    entry.recovered_at = new Date().toISOString();
    entry.recovery_reason = "processing_timeout";
    recovered = true;
  }
  return recovered;
}

function saveQueue(queuePath, queue) {
  queue.updated_at = new Date().toISOString();
  mkdirSync(dirname(queuePath), { recursive: true });
  writeFileSync(queuePath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");
}

function loadTriggerState(statePath) {
  if (!existsSync(statePath)) {
    return {
      trigger_state_schema_version: STATE_SCHEMA_VERSION,
      created_at: new Date().toISOString(),
      triggers: {},
    };
  }
  const state = JSON.parse(readFileSync(statePath, "utf8"));
  if (state.trigger_state_schema_version !== STATE_SCHEMA_VERSION) {
    throw serviceError("TriggerStateSchemaMismatch", `trigger_state_schema_version must be ${STATE_SCHEMA_VERSION}`);
  }
  return normalizeTriggerStateDocument(state);
}

function saveTriggerState(statePath, state) {
  state.updated_at = new Date().toISOString();
  mkdirSync(dirname(statePath), { recursive: true });
  writeFileSync(statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function normalizeTriggerStateDocument(document) {
  const normalized = {
    trigger_state_schema_version: STATE_SCHEMA_VERSION,
    created_at: typeof document.created_at === "string" ? document.created_at : new Date().toISOString(),
    updated_at: typeof document.updated_at === "string" ? document.updated_at : undefined,
    triggers: {},
  };
  for (const [triggerRef, state] of Object.entries(document.triggers ?? {})) {
    const events = Array.isArray(state.events) ? state.events : [];
    normalized.triggers[triggerRef] = summarizeTriggerStateEntry(
      events
        .filter((event) => event && typeof event === "object" && !Array.isArray(event))
        .map((event) => ({
          event_id: typeof event.event_id === "string" ? event.event_id : undefined,
          source_kind: typeof event.source_kind === "string" ? event.source_kind : undefined,
          status: event.status === "accepted" ? "accepted" : "refused",
          reason: typeof event.reason === "string" ? event.reason : undefined,
          observed_at: typeof event.observed_at === "string" ? event.observed_at : undefined,
          day_key: typeof event.day_key === "string" ? event.day_key : dayKeyFromObservedAt(event.observed_at),
          run_id: typeof event.run_id === "string" ? event.run_id : undefined,
        }))
        .filter((event) => event.event_id),
    );
  }
  return normalized;
}

function summarizeTriggerStateEntry(events) {
  const accepted = events.filter((event) => event.status === "accepted");
  const refused = events.filter((event) => event.status === "refused");
  const consumed = [...new Set(accepted.map((event) => event.event_id))].sort();
  const last = events.at(-1);
  return {
    accepted_count: accepted.length,
    refused_count: refused.length,
    consumed_event_ids: consumed,
    last_event_id: last?.event_id,
    last_status: last?.status,
    updated_at: last?.observed_at,
    events,
  };
}

function normalizeStateTriggerEvent(event) {
  return {
    triggerRef: stringOrNull(event?.trigger_ref ?? event?.triggerRef),
    eventId: stringOrNull(event?.event_id ?? event?.eventId),
    sourceKind: stringOrNull(event?.source_kind ?? event?.sourceKind),
  };
}

function isTriggerEventConsumed(state, triggerRef, eventId) {
  return Boolean(state.triggers?.[triggerRef]?.consumed_event_ids?.includes(eventId));
}

function countAcceptedTriggerEvents(state, triggerRef, dayKey = currentDayKey()) {
  const events = state.triggers?.[triggerRef]?.events;
  if (!Array.isArray(events)) {
    return 0;
  }
  return events.filter((event) =>
    event?.status === "accepted"
    && triggerStateEventDayKey(event) === dayKey,
  ).length;
}

function recordTriggerStateEvent(state, event, result) {
  if (!event.triggerRef || !event.eventId) {
    return;
  }
  const accepted = hasAcceptedTriggerEvent(result.trace, event.triggerRef, event.eventId);
  const refused = lastTriggerRefusal(result.trace, event.triggerRef, event.eventId);
  const observedAt = new Date().toISOString();
  const previous = state.triggers[event.triggerRef]?.events ?? [];
  state.triggers[event.triggerRef] = summarizeTriggerStateEntry([
    ...previous,
    {
      event_id: event.eventId,
      source_kind: event.sourceKind,
      status: accepted ? "accepted" : "refused",
      reason: accepted ? undefined : refused?.payload?.reason ?? "execution_failed",
      observed_at: observedAt,
      day_key: dayKeyFromObservedAt(observedAt),
      run_id: result.trace?.run?.run_id,
    },
  ]);
}

function hasAcceptedTriggerEvent(trace, triggerRef, eventId) {
  return Boolean(
    trace?.events?.some(
      (event) =>
        event.kind === "trigger_event_accepted" &&
        event.payload?.trigger_ref === triggerRef &&
        (event.payload?.event_id === undefined || event.payload?.event_id === eventId),
    ),
  );
}

function lastTriggerRefusal(trace, triggerRef, eventId) {
  return [...(trace?.events ?? [])]
    .reverse()
    .find(
      (event) =>
        event.kind === "trigger_event_refused" &&
        event.payload?.trigger_ref === triggerRef &&
        (event.payload?.event_id === undefined || event.payload?.event_id === eventId),
    );
}

function replayRejectedResult(document, event, runId) {
  const effectiveRunId = runId ?? "trigger-service-replay-rejected";
  const trace = {
    trace_protocol_version: "trace-minimal-v0.1",
    run: {
      module_ref: document.module?.id,
      entry_ref: event.triggerRef,
      run_id: effectiveRunId,
    },
    events: [
      traceEvent(effectiveRunId, 0, "run_started", { entry_ref: event.triggerRef }),
      traceEvent(effectiveRunId, 1, "trigger_event_received", {
        trigger_ref: event.triggerRef,
        event_id: event.eventId,
        source_kind: event.sourceKind,
      }),
      traceEvent(effectiveRunId, 2, "trigger_event_refused", {
        trigger_ref: event.triggerRef,
        event_id: event.eventId,
        source_kind: event.sourceKind,
        reason: "event_replay",
        runtime_error_code: "TriggerReplayRejected",
      }),
      traceEvent(effectiveRunId, 3, "run_completed", { status: "failure" }),
    ],
  };
  return { status: "failure", result: null, trace };
}

function traceEvent(runId, sequenceIndex, kind, payload) {
  return {
    event_id: `event:${runId}:${sequenceIndex + 1}`,
    run_id: runId,
    sequence_index: sequenceIndex,
    kind,
    payload,
  };
}

function currentDayKey() {
  return dayKeyFromObservedAt(new Date().toISOString());
}

function dayKeyFromObservedAt(observedAt) {
  if (typeof observedAt !== "string") {
    return undefined;
  }
  return /^(\d{4}-\d{2}-\d{2})T/u.exec(observedAt)?.[1];
}

function triggerStateEventDayKey(event) {
  return typeof event.day_key === "string"
    ? event.day_key
    : dayKeyFromObservedAt(event.observed_at);
}

async function readBoundedBody(request, maxBytes = MAX_BODY_BYTES) {
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request) {
    bytes += chunk.byteLength;
    if (bytes > maxBytes) {
      throw serviceError("TriggerPayloadTooLarge", `request body exceeds ${maxBytes} bytes`);
    }
    chunks.push(chunk);
  }
  const body = Buffer.concat(chunks);
  return {
    bytes,
    digest: createHash("sha256").update(body).digest("hex"),
    buffer: body,
  };
}

function assertValidSignature(request, body, secret) {
  const header = request.headers["x-touba-signature"];
  const signature = Array.isArray(header) ? header[0] : header;
  if (typeof signature !== "string" || !signature.startsWith("sha256=")) {
    throw serviceError("TriggerSignatureInvalid", "x-touba-signature must use sha256=<hex>");
  }
  const expected = createHmac("sha256", secret).update(body).digest("hex");
  const actual = signature.slice("sha256=".length);
  if (!/^[a-f0-9]{64}$/iu.test(actual)) {
    throw serviceError("TriggerSignatureInvalid", "x-touba-signature sha256 digest is invalid");
  }
  const expectedBuffer = Buffer.from(expected, "hex");
  const actualBuffer = Buffer.from(actual, "hex");
  if (expectedBuffer.length !== actualBuffer.length || !timingSafeEqual(expectedBuffer, actualBuffer)) {
    throw serviceError("TriggerSignatureInvalid", "request signature mismatch");
  }
}

function shouldRetryQueueEntry(entry, runtimeErrorCode, maxAttempts) {
  if (isNonRetryableRuntimeErrorCode(runtimeErrorCode)) {
    return false;
  }
  return (entry.attempt_count ?? 0) < maxAttempts;
}

function isNonRetryableRuntimeErrorCode(runtimeErrorCode) {
  return typeof runtimeErrorCode === "string"
    && (
      runtimeErrorCode.startsWith("Trigger")
      || runtimeErrorCode === "SecretValueInTriggerArgument"
    );
}

function retryDelayMs(attemptCount) {
  return Math.min(1000 * 2 ** Math.max(0, attemptCount - 1), 30000);
}

function triggerEventId(request, trigger, digest) {
  const header = request.headers["x-touba-event-id"];
  const value = Array.isArray(header) ? header[0] : header;
  if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) {
    return value;
  }
  return `evt-http-${safeFilePart(trigger.name ?? "trigger")}-${Date.now()}-${digest.slice(0, 12)}`;
}

function authorized(request, token) {
  const authorization = request.headers.authorization;
  if (authorization === `Bearer ${token}`) {
    return true;
  }
  const header = request.headers["x-touba-trigger-token"];
  return header === token;
}

function writeJson(response, statusCode, payload) {
  const text = `${JSON.stringify(payload, null, 2)}\n`;
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  response.end(text);
}

function parseArgs(rawArgs) {
  const parsed = {
    airPath: undefined,
    manifestPath: undefined,
    statePath: undefined,
    queuePath: undefined,
    secretsPath: undefined,
    triggerRef: undefined,
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    traceDir: undefined,
    maxEvents: undefined,
    maxAttempts: DEFAULT_MAX_ATTEMPTS,
    processingTimeoutMs: DEFAULT_PROCESSING_TIMEOUT_MS,
    authTokenEnv: undefined,
    signatureSecretEnv: undefined,
    help: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--manifest") {
      parsed.manifestPath = requiredValue(rawArgs, ++index, "--manifest");
    } else if (arg.startsWith("--manifest=")) {
      parsed.manifestPath = nonEmptyValue(arg.slice("--manifest=".length), "--manifest");
    } else if (arg === "--state") {
      parsed.statePath = requiredValue(rawArgs, ++index, "--state");
    } else if (arg.startsWith("--state=")) {
      parsed.statePath = nonEmptyValue(arg.slice("--state=".length), "--state");
    } else if (arg === "--queue") {
      parsed.queuePath = requiredValue(rawArgs, ++index, "--queue");
    } else if (arg.startsWith("--queue=")) {
      parsed.queuePath = nonEmptyValue(arg.slice("--queue=".length), "--queue");
    } else if (arg === "--secrets") {
      parsed.secretsPath = requiredValue(rawArgs, ++index, "--secrets");
    } else if (arg.startsWith("--secrets=")) {
      parsed.secretsPath = nonEmptyValue(arg.slice("--secrets=".length), "--secrets");
    } else if (arg === "--trigger") {
      parsed.triggerRef = requiredValue(rawArgs, ++index, "--trigger");
    } else if (arg.startsWith("--trigger=")) {
      parsed.triggerRef = nonEmptyValue(arg.slice("--trigger=".length), "--trigger");
    } else if (arg === "--host") {
      parsed.host = requiredValue(rawArgs, ++index, "--host");
    } else if (arg.startsWith("--host=")) {
      parsed.host = nonEmptyValue(arg.slice("--host=".length), "--host");
    } else if (arg === "--port") {
      parsed.port = parsePort(requiredValue(rawArgs, ++index, "--port"));
    } else if (arg.startsWith("--port=")) {
      parsed.port = parsePort(arg.slice("--port=".length));
    } else if (arg === "--trace-dir") {
      parsed.traceDir = requiredValue(rawArgs, ++index, "--trace-dir");
    } else if (arg.startsWith("--trace-dir=")) {
      parsed.traceDir = nonEmptyValue(arg.slice("--trace-dir=".length), "--trace-dir");
    } else if (arg === "--max-events") {
      parsed.maxEvents = parsePositiveInteger(requiredValue(rawArgs, ++index, "--max-events"), "--max-events");
    } else if (arg.startsWith("--max-events=")) {
      parsed.maxEvents = parsePositiveInteger(arg.slice("--max-events=".length), "--max-events");
    } else if (arg === "--max-attempts") {
      parsed.maxAttempts = parsePositiveInteger(requiredValue(rawArgs, ++index, "--max-attempts"), "--max-attempts");
    } else if (arg.startsWith("--max-attempts=")) {
      parsed.maxAttempts = parsePositiveInteger(arg.slice("--max-attempts=".length), "--max-attempts");
    } else if (arg === "--processing-timeout-ms") {
      parsed.processingTimeoutMs = parsePositiveInteger(requiredValue(rawArgs, ++index, "--processing-timeout-ms"), "--processing-timeout-ms");
    } else if (arg.startsWith("--processing-timeout-ms=")) {
      parsed.processingTimeoutMs = parsePositiveInteger(arg.slice("--processing-timeout-ms=".length), "--processing-timeout-ms");
    } else if (arg === "--auth-token-env") {
      parsed.authTokenEnv = requiredValue(rawArgs, ++index, "--auth-token-env");
    } else if (arg.startsWith("--auth-token-env=")) {
      parsed.authTokenEnv = nonEmptyValue(arg.slice("--auth-token-env=".length), "--auth-token-env");
    } else if (arg === "--signature-secret-env") {
      parsed.signatureSecretEnv = requiredValue(rawArgs, ++index, "--signature-secret-env");
    } else if (arg.startsWith("--signature-secret-env=")) {
      parsed.signatureSecretEnv = nonEmptyValue(arg.slice("--signature-secret-env=".length), "--signature-secret-env");
    } else if (arg.startsWith("--")) {
      throw serviceError("TriggerServiceUsage", `unknown option ${arg}`);
    } else if (parsed.airPath === undefined) {
      parsed.airPath = arg;
    } else {
      throw serviceError("TriggerServiceUsage", `unexpected argument ${arg}`);
    }
  }
  return parsed;
}

function usage() {
  return [
    "Usage: touba trigger serve <program.air.json> --manifest <path> --state <touba.trigger-state.json> --queue <touba.trigger-queue.json> [options]",
    "",
    "Options:",
    "  --trigger <trigger_ref>          Restrict service routes to one request trigger",
    "  --host <host>                   Bind host, default 127.0.0.1",
    "  --port <port>                   Bind port, default 8787; use 0 for an ephemeral test port",
    "  --trace-dir <dir>               Persist one trace JSON file per processed queue entry",
    "  --max-events <n>                Stop after n processed entries, useful for tests and supervised jobs",
    "  --max-attempts <n>              Retry target failures up to n attempts, default 3",
    "  --processing-timeout-ms <n>     Requeue stale processing entries after n ms, default 300000",
    "  --auth-token-env <NAME>         Require bearer token or x-touba-trigger-token from the named env var",
    "  --signature-secret-env <NAME>   Require x-touba-signature: sha256=<hex> HMAC using the named env var",
    "  --secrets <touba.secrets.json>  Resolve declared secret handles for triggered runs",
  ].join("\n");
}

function required(value, label) {
  if (value === undefined || value === "") {
    throw serviceError("TriggerServiceUsage", `${label} is required`);
  }
  return value;
}

function requiredValue(args, index, option) {
  if (index >= args.length) {
    throw serviceError("TriggerServiceUsage", `${option} requires a value`);
  }
  return nonEmptyValue(args[index], option);
}

function nonEmptyValue(value, option) {
  if (String(value).trim() === "") {
    throw serviceError("TriggerServiceUsage", `${option} requires a non-empty value`);
  }
  return value;
}

function parsePort(value) {
  const port = Number(value);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw serviceError("TriggerServiceUsage", "--port must be an integer between 0 and 65535");
  }
  return port;
}

function parsePositiveInteger(value, option) {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw serviceError("TriggerServiceUsage", `${option} must be a positive integer`);
  }
  return parsed;
}

function assertSuffix(path, suffix, code) {
  if (!basename(path).endsWith(suffix)) {
    throw serviceError(code, `path must end with ${suffix}`);
  }
}

function isLoopbackHost(host) {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function hashText(text) {
  return createHash("sha256").update(text).digest("hex");
}

function safeFilePart(value) {
  return String(value)
    .replaceAll(/[^A-Za-z0-9_.-]/gu, "-")
    .replaceAll(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
    || "entry";
}

function stringOrNull(value) {
  if (typeof value !== "string") {
    return null;
  }
  const trimmed = value.trim();
  return trimmed === "" ? null : trimmed;
}

function serviceError(code, message) {
  return new ToubaRuntimeError(code, message);
}

function httpStatusForServiceError(code) {
  if (code === "TriggerPayloadTooLarge") {
    return 413;
  }
  if (code === "TriggerPayloadContentTypeUnsupported") {
    return 415;
  }
  if (code === "TriggerUnauthorized" || code === "TriggerSignatureInvalid") {
    return 401;
  }
  return 400;
}

function isMainModule() {
  return process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}
