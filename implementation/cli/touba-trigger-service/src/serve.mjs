#!/usr/bin/env node
import { createHash, createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createSqliteTriggerStore } from "../../../runtime/touba-runtime/src/sqlite-trigger-store.mjs";
import { projectTracePath } from "../../../runtime/touba-runtime/src/project-trace-path.mjs";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { writeTraceFile } from "../../touba-run/src/trace-output.mjs";
import { createSqliteTriggerQueue } from "./sqlite-queue.mjs";
import { createHostModuleLoader } from "../../touba-run/src/host-modules.mjs";
import { createSqliteHumanCheckpointStore } from "../../../runtime/touba-runtime/src/human-checkpoint-store.mjs";
import {
  executeTriggerEvent,
  loadAirFromJson,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
  ToubaRuntimeError,
} from "@touba/runtime";
import {
  createSqliteEffectJournal,
  unknownEffectRetryDecision,
} from "./effect-journal.mjs";

const QUEUE_SCHEMA_VERSION = "touba-trigger-queue-v1";
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
  const statePath = resolve(options.statePath ?? join(dirname(projectTracePath(airPath)), "triggers.sqlite"));
  const queuePath = resolve(options.queuePath ?? join(dirname(projectTracePath(airPath)), "trigger-queue.sqlite"));
  const tracePath = resolve(options.traceStorePath ?? projectTracePath(airPath));
  const effectJournalPath = options.effectJournalPath === undefined
    ? undefined
    : resolve(options.effectJournalPath);
  assertSuffix(statePath, ".sqlite", "TriggerStatePathInvalid");
  assertSuffix(queuePath, ".sqlite", "TriggerQueuePathInvalid");
  if (effectJournalPath !== undefined) {
    assertSuffix(effectJournalPath, ".sqlite", "EffectJournalPathInvalid");
  }
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
  if (manifestRequiresEffectJournal(manifest) && effectJournalPath === undefined) {
    throw serviceError(
      "EffectJournalRequired",
      "explicit external_write effect contracts require --effect-journal",
    );
  }
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

  const managementToken = options.managementTokenEnv === undefined ? undefined : process.env[options.managementTokenEnv];
  if (options.managementTokenEnv !== undefined && (!managementToken || managementToken.trim() === "" || managementToken === authToken)) {
    throw serviceError("TriggerManagementTokenInvalid", "management requires a non-empty token distinct from the ingress token");
  }
  const checkpointPath = resolve(options.humanCheckpointStorePath ?? join(dirname(queuePath), "approval-checkpoints.sqlite"));
  assertSuffix(checkpointPath, ".sqlite", "HumanApprovalCheckpointStoreInvalid");
  if ([statePath, queuePath, tracePath, effectJournalPath].includes(checkpointPath)) {
    throw serviceError("HumanApprovalCheckpointStoreInvalid", "checkpoint custody must use its own database");
  }
  const hostModules = createHostModuleLoader();
  let agentDecisionProvider, humanApprovalHost;
  try {
    if (options.agentDecisionProviderPath) agentDecisionProvider = await hostModules.decisionProvider(options.agentDecisionProviderPath, { projectRoot: options.projectRoot });
    humanApprovalHost = options.humanApprovalHostPath
      ? await hostModules.approvalHost(options.humanApprovalHostPath, { projectRoot: options.projectRoot }) : {};
  } catch (error) { hostModules.close(); throw error; }
  const checkpointStore = createSqliteHumanCheckpointStore(checkpointPath);

  let effectJournal, triggerState, queue, traceStorage;
  try {
    effectJournal = effectJournalPath === undefined ? undefined
      : createSqliteEffectJournal(effectJournalPath, {
      secretValues: secretStore?.resolvedSecretEntries?.().map(entry => entry.value) ?? [],
    });
    triggerState = createSqliteTriggerStore({ filename: statePath, maxBytes: options.stateMaxBytes });
    queue = createSqliteTriggerQueue({ filename: queuePath, maxEntries: options.queueMaxEntries, maxBytes: options.queueMaxBytes });
    traceStorage = createSqliteTraceStore({ filename: tracePath, maxBytes: options.traceMaxBytes });
  } catch (error) { triggerState?.close(); queue?.close(); hostModules.close(); throw error; }
  const serverState = {
    processedCount: 0,
    stopping: false,
    workerPromise: undefined,
    workerRequested: false,
    retryTimer: undefined,
    retryDueAt: undefined,
  };
  const workerOptions = {
    document,
    manifest,
    secretStore,
    statePath,
    triggerState,
    queue,
    queuePath,
    traceDir: options.traceDir,
    traceStorage,
    server: undefined,
    serverState,
    maxEvents: options.maxEvents,
    maxAttempts,
    processingTimeoutMs,
    effectJournal,
    executionHost: {
      agentDecisionProvider, ...humanApprovalHost,
      humanCheckpointStore: checkpointStore,
      durableHumanApprovals: true,
      agentDecisionProviderTimeoutMs: options.agentDecisionProviderTimeoutMs,
      humanApprovalAuthorityTimeoutMs: options.humanApprovalAuthorityTimeoutMs,
    },
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
      if (request.method === "GET" && request.url === "/status") {
        if (authToken !== undefined && !authorized(request, authToken)) {
          writeJson(response, 401, {
            status: "error",
            code: "TriggerUnauthorized",
          });
          return;
        }
        writeJson(response, 200, buildTriggerStatusContract({
          document,
          manifest,
          state: triggerState,
          queue,
        }));
        return;
      }

      const managementUrl = new URL(request.url, "http://127.0.0.1");
      if (managementUrl.pathname.startsWith("/_touba/")) {
        if (!managementToken) { writeJson(response, 404, { code: "TriggerRouteNotFound" }); return; }
        if (!authorized(request, managementToken)) { writeJson(response, 401, { code: "TriggerUnauthorized" }); return; }
        if (request.method === "GET" && managementUrl.pathname === "/_touba/approvals") {
          const page = queue.page({ after: managementUrl.searchParams.get("after") ?? "", limit: 100 });
          writeJson(response, 200, { approvals: page.entries.filter(entry => entry.status === "awaiting_human").map(pendingApproval), next: page.next });
          return;
        }
        if (request.method === "POST" && managementUrl.pathname === "/_touba/approvals") {
          const body = await readBoundedBody(request, 16 * 1024);
          const result = await resumeApproval(JSON.parse(body.buffer.toString("utf8")));
          writeJson(response, 200, result); return;
        }
        writeJson(response, 404, { code: "TriggerRouteNotFound" }); return;
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
      const existingEntry = queue.find(route.trigger.id, eventId);
      if (existingEntry !== undefined) {
        if (existingEntry.http?.payload_sha256 !== body.digest) {
          throw serviceError(
            "TriggerEventPayloadConflict",
            "the trigger event id is already associated with a different payload digest",
          );
        }
        if (
          isTerminalQueueStatus(existingEntry.status)
          && triggerState.consumed(existingEntry.trigger_ref, existingEntry.event_id)
        ) {
          const runId = `trigger-service-${safeFilePart(existingEntry.queue_id)}-replay`;
          const event = normalizeStateTriggerEvent(existingEntry);
          const result = replayRejectedResult(document, event, runId);
          triggerState.recordResult(event, result);
          writeJson(response, 409, {
            status: "error",
            code: "TriggerReplayRejected",
            message: "the trigger event id has already been consumed",
            queue_id: existingEntry.queue_id,
            trigger_ref: existingEntry.trigger_ref,
            event_id: existingEntry.event_id,
          });
          return;
        }
        writeJson(response, 202, {
          status: "queued",
          queue_id: existingEntry.queue_id,
          trigger_ref: existingEntry.trigger_ref,
          event_id: existingEntry.event_id,
          deduplicated: true,
          queue_status: existingEntry.status,
        });
        setImmediate(() => requestQueueProcessing({
          ...workerOptions,
          server,
        }));
        return;
      }
      const queueId = stableQueueId(route.trigger.id, eventId);
      const entry = {
        queue_id: queueId,
        trigger_ref: route.trigger.id,
        event_id: eventId,
        source_kind: "request",
        status: "queued",
        guarded_execution: true,
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
      queue.enqueue(entry);

      writeJson(response, 202, {
        status: "queued",
        queue_id: queueId,
        trigger_ref: route.trigger.id,
        event_id: eventId,
      });

      setImmediate(() => requestQueueProcessing({
        ...workerOptions,
        server,
      }));
    } catch (error) {
      const code = error.code ?? "TriggerServiceRequestFailed";
      writeJson(response, httpStatusForServiceError(code), {
        status: "error",
        code,
        message: error.message,
      });
    }
  });
  let storesClosed = false;
  const closeStores = () => {
    if (storesClosed) return;
    storesClosed = true;
    triggerState.close(); queue.close(); traceStorage.close(); hostModules.close();
  };
  server.once("close", () => {
    serverState.stopping = true;
    clearRetryWake(serverState);
    Promise.resolve(serverState.workerPromise).finally(closeStores).catch(() => {});
  });

  async function resumeApproval(input) {
    if (!input || typeof input !== "object" || Array.isArray(input)
      || Object.keys(input).some(key => !["queue_id", "request_id", "decision"].includes(key))
      || typeof input.queue_id !== "string" || typeof input.request_id !== "string"
      || !input.decision || typeof input.decision !== "object" || Array.isArray(input.decision)
      || Object.keys(input.decision).some(key => !["decision", "evidence_ref", "client_ref", "comment"].includes(key))
      || !["approved", "rejected"].includes(input.decision.decision)
      || Object.values(input.decision).some(value => typeof value !== "string" || value.length > 8192)) {
      throw serviceError("TriggerApprovalInvalid", "provide the pending queue_id, request_id and an attested approval decision");
    }
    if (!humanApprovalHost.humanApprovalAuthority) throw serviceError("HumanApprovalAuthorityUnavailable", "configure a trusted human approval host");
    if (serverState.stopping || serverState.workerPromise) throw serviceError("TriggerWorkerBusy", "the single execution worker is busy");
    const entry = queue.continue(input.queue_id, input.request_id);
    clearRetryWake(serverState);
    const work = executeQueueEntry({ ...workerOptions, server }, entry, input.decision);
    serverState.workerPromise = work;
    try {
      await work;
      const stored = queue.get(entry.queue_id);
      return { queue_id: stored.queue_id, status: stored.status, runtime_error_code: stored.runtime_error_code,
        ...(stored.status === "awaiting_human" ? { approval: pendingApproval(stored) } : {}) };
    } finally {
      serverState.workerPromise = undefined;
      if (!serverState.stopping) requestQueueProcessing({ ...workerOptions, server });
    }
  }

  return {
    async start() {
      if (storesClosed || serverState.stopping) throw serviceError("TriggerServiceClosed", "create a new service after it has stopped");
      await new Promise((resolveListen, rejectListen) => {
        const failListen = error => {
          server.removeListener("error", failListen);
          serverState.stopping = true; closeStores(); rejectListen(error);
        };
        server.once("error", failListen);
        try {
          server.listen(port, host, () => { server.removeListener("error", failListen); resolveListen(); });
        } catch (error) { failListen(error); }
      });
      const address = server.address();
      if (options.quiet !== true) {
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
          effect_journal: effectJournalPath,
        })}\n`);
      }
      setImmediate(() => requestQueueProcessing({
        ...workerOptions,
        server,
      }));
    },
    server,
    // Trusted local callers use the same custody and attestation as the private
    // management endpoint. This method cannot submit a checkpoint or new inputs.
    resumeApproval,
  };
}

function pendingApproval(entry) {
  const checkpoint = entry.checkpoint;
  const request = checkpoint?.approval_state?.requests?.[checkpoint.approval_ref];
  return { queue_id: entry.queue_id, trigger_ref: entry.trigger_ref, event_id: entry.event_id,
    run_id: checkpoint?.run_id, approval_ref: checkpoint?.approval_ref,
    request_id: request?.request_id, role: request?.policy?.role ?? null };
}

function requestQueueProcessing(workerOptions) {
  const { serverState } = workerOptions;
  if (serverState.stopping) {
    return;
  }
  clearRetryWake(serverState);
  serverState.workerRequested = true;
  if (serverState.workerPromise !== undefined) {
    return;
  }

  const workerPromise = drainRequestedQueueWork(workerOptions);
  serverState.workerPromise = workerPromise;
  workerPromise.then(
    (nextWakeDelayMs) => finishQueueWorker(workerOptions, workerPromise, nextWakeDelayMs),
    (error) => {
      process.stderr.write(`trigger service worker error [${error.code ?? "TriggerServiceWorkerError"}]: ${error.message}\n`);
      finishQueueWorker(workerOptions, workerPromise, workerOptions.processingTimeoutMs);
    },
  );
}

async function drainRequestedQueueWork(workerOptions) {
  const { serverState } = workerOptions;
  let nextWakeDelayMs;
  do {
    serverState.workerRequested = false;
    nextWakeDelayMs = await processQueue(workerOptions);
  } while (!serverState.stopping && serverState.workerRequested);
  return nextWakeDelayMs;
}

function finishQueueWorker(workerOptions, workerPromise, nextWakeDelayMs) {
  const { serverState } = workerOptions;
  if (serverState.workerPromise !== workerPromise) {
    return;
  }
  serverState.workerPromise = undefined;
  if (serverState.stopping) {
    clearRetryWake(serverState);
    return;
  }
  if (serverState.workerRequested) {
    requestQueueProcessing(workerOptions);
    return;
  }
  if (Number.isFinite(nextWakeDelayMs)) {
    scheduleRetryWake(workerOptions, nextWakeDelayMs);
  }
}

function scheduleRetryWake(workerOptions, delayMs) {
  const { serverState } = workerOptions;
  if (serverState.stopping) {
    return;
  }
  const boundedDelayMs = Math.max(0, delayMs);
  const dueAt = Date.now() + boundedDelayMs;
  if (serverState.retryTimer !== undefined && serverState.retryDueAt <= dueAt) {
    return;
  }
  clearRetryWake(serverState);
  serverState.retryDueAt = dueAt;
  serverState.retryTimer = setTimeout(() => {
    serverState.retryTimer = undefined;
    serverState.retryDueAt = undefined;
    requestQueueProcessing(workerOptions);
  }, boundedDelayMs);
}

function clearRetryWake(serverState) {
  if (serverState.retryTimer !== undefined) {
    clearTimeout(serverState.retryTimer);
  }
  serverState.retryTimer = undefined;
  serverState.retryDueAt = undefined;
}

async function processQueue(workerOptions) {
  const { queue, serverState, processingTimeoutMs } = workerOptions;
  if (serverState.stopping) {
    return;
  }
  while (!serverState.stopping) {
    const entry = queue.claim(processingTimeoutMs, Date.now(), { guardUnknown: true });
    if (!entry) {
      return queue.nextWake(processingTimeoutMs);
    }
    await executeQueueEntry(workerOptions, entry);
  }
}

async function executeQueueEntry({ document, manifest, secretStore, statePath, triggerState,
  queue, traceDir, traceStorage, server, serverState, maxEvents, maxAttempts, effectJournal, executionHost }, entry, decision) {
  const checkpoint = decision ? entry.checkpoint : undefined;
  try {

    // TD-1 consumes an external event once. A later attempt owned by the same
    // queue entry may retry its target without recording a second event.
    const retryingConsumedEvent = entry.attempt_count > 1
      && triggerState.consumed(entry.trigger_ref, entry.event_id);
    const event = {
      trigger_ref: entry.trigger_ref,
      event_id: entry.event_id,
      source_kind: entry.source_kind,
      arguments: entry.arguments,
    };
    const result = await executeTriggerEventWithState(document, event, {
      ...executionHost,
      toolBindingManifest: manifest,
      secretStore,
      statePath,
      runId: checkpoint?.run_id ?? `trigger-service-${entry.queue_id.replaceAll(/[^A-Za-z0-9_-]/gu, "-")}-attempt-${entry.attempt_count}`,
      humanApprovalResumeCheckpoint: checkpoint,
      humanApprovalDecisions: checkpoint ? { [checkpoint.approval_ref]: decision } : undefined,
      triggerAdmission: request => triggerState.admit({ ...request, ownerId: entry.queue_id,
        attempt: entry.attempt_count, retry: retryingConsumedEvent }),
      effectScopeId: entry.queue_id,
      effectJournal,
      traceStorage,
    }, triggerState);

    const stored = entry;
    if (stored) {
      let refusal, executionFailure, failure;
      for (const event of result.traceReader?.events() ?? result.trace.events) {
        if (event.kind === "failure_detected") failure = event;
        if (event.payload?.trigger_ref !== entry.trigger_ref) continue;
        if (event.kind === "trigger_event_refused" && (event.payload.event_id === undefined || event.payload.event_id === entry.event_id)) refusal = event;
        if (event.kind === "trigger_execution_failed") executionFailure = event;
      }
      const runtimeErrorCode = refusal?.payload?.runtime_error_code
        ?? executionFailure?.payload?.runtime_error_code ?? failure?.payload?.runtime_error_code;
      stored.completed_at = new Date().toISOString();
      stored.run_id = result.trace?.run?.run_id;
      stored.runtime_status = result.status;
      stored.runtime_error_code = runtimeErrorCode;
      stored.refusal_reason = refusal?.payload?.reason;
      if (traceDir !== undefined) {
        mkdirSync(resolve(traceDir), { recursive: true });
        const segment = checkpoint ? `.continuation-${entry.continuation_count}` : "";
        const tracePath = join(resolve(traceDir), `${safeFilePart(entry.queue_id)}.attempt-${entry.attempt_count}${segment}.trace.json`);
        await writeTraceFile(tracePath, result.traceReader);
        stored.trace_path = tracePath;
      }
      if (result.status === "stopped" && result.checkpoint && result.reason === "human_approval_pending") {
        stored.status = "awaiting_human";
        stored.checkpoint = result.checkpoint;
        delete stored.completed_at;
      } else if (checkpoint && result.status === "failure"
        && !["HumanApprovalRejected", "HumanApprovalExpired"].includes(runtimeErrorCode)
        && executionHost.humanCheckpointStore.ready(checkpoint)) {
        // The runtime, not the queue, decides whether a refused attestation left
        // the exact original continuation available. No effect can be rearmed here.
        stored.status = "awaiting_human";
        delete stored.completed_at;
      } else if (result.status === "success") {
        stored.status = "succeeded";
        delete stored.checkpoint;
      } else if (!checkpoint && result.status === "failure" && shouldRetryQueueEntry(stored, runtimeErrorCode, maxAttempts, effectJournal)) {
        stored.status = "queued";
        stored.next_attempt_at = new Date(Date.now() + retryDelayMs(stored.attempt_count ?? 1)).toISOString();
      } else {
        const unknownRetryDecision = unknownEffectRetryDecisionForEntry(stored, effectJournal);
        stored.status = checkpoint || result.status === "stopped" || isNonRetryableRuntimeErrorCode(runtimeErrorCode)
          || unknownRetryDecision === false
          ? "failed"
          : "dead_lettered";
        stored.dead_lettered_at = stored.status === "dead_lettered" ? new Date().toISOString() : undefined;
      }
    }
    queue.finish(stored);
  } catch (error) {
    // An exception may follow a real effect or durable pause. Keep the evidence
    // and stop this entry; a fresh worker must not replay the entire strategy.
    entry.status = "interrupted";
    entry.runtime_error_code = "TriggerExecutionInterrupted";
    entry.recovery_effect_outcome = "unknown";
    queue.finish(entry);
    throw error;
  } finally {
    serverState.processedCount += 1;
    if (maxEvents !== undefined && serverState.processedCount >= maxEvents) {
      serverState.stopping = true;
      clearRetryWake(serverState);
      server.close();
    }
  }
}

async function executeTriggerEventWithState(document, event, options, state) {
  const result = await executeTriggerEvent(document, event, options);
  state.recordResult(event, result);
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

function manifestRequiresEffectJournal(manifest) {
  const bindings = manifest?.bindings instanceof Map
    ? [...manifest.bindings.values()]
    : Object.values(manifest?.bindings ?? {});
  return bindings.some((binding) =>
    (binding?.effectContract ?? binding?.effect_contract)?.kind === "external_write"
  );
}

function buildRequestRoutes(document, manifest, triggerRef) {
  return (document.definitions?.triggers ?? [])
    .filter((trigger) => trigger.event?.kind === "request")
    .filter((trigger) => triggerRef === undefined || trigger.id === triggerRef)
    .map((trigger) => {
      const parsed = parseRequestEventValue(trigger.event.value);
      if (parsed?.path.startsWith("/_touba/")) throw serviceError("TriggerServiceReservedRoute", "the /_touba/ path prefix is reserved for service management");
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


export function buildTriggerStatusContract({
  document,
  manifest,
  state,
  queue,
  generatedAt = new Date().toISOString(),
  triggerRef,
}) {
  const triggers = (document.definitions?.triggers ?? [])
    .filter((trigger) => triggerRef === undefined || trigger.id === triggerRef)
    .filter((trigger) => ["request", "schedule"].includes(trigger.event?.kind))
    .map((trigger) => triggerStatusEntry(trigger, manifest, state, queue, generatedAt));
  return {
    schema_version: "touba-trigger-status-v1",
    generated_at: generatedAt,
    triggers,
  };
}

function triggerStatusEntry(trigger, manifest, state, queue, generatedAt) {
  const manifestTrigger = manifestTriggerForStatus(manifest, trigger.id);
  const triggerState = state?.summary?.(trigger.id) ?? state?.triggers?.[trigger.id] ?? {};
  const queueEntries = queueEntriesForTrigger(queue, trigger.id);
  const limits = triggerStatusLimits(trigger, manifestTrigger);
  return {
    trigger_ref: trigger.id,
    kind: trigger.event.kind,
    status: triggerStatus(trigger, manifestTrigger),
    next_run_at: null,
    limits,
    state: {
      accepted_count: safeNonNegativeInteger(triggerState.accepted_count),
      refused_count: safeNonNegativeInteger(triggerState.refused_count),
      last_event_id: typeof triggerState.last_event_id === "string" ? triggerState.last_event_id : null,
      ...(typeof state?.count === 'function' ? {
        daily_count: state.count(trigger.id, generatedAt.slice(0, 10)),
        day_utc: generatedAt.slice(0, 10),
      } : {}),
    },
    queue: queue?.counts?.(trigger.id) ?? {
      pending: queueEntries.filter((entry) => entry.status === "queued").length,
      processing: queueEntries.filter((entry) => entry.status === "processing").length,
      dead_letter: queueEntries.filter((entry) => entry.status === "dead_lettered").length,
    },
  };
}

function manifestTriggerForStatus(manifest, triggerRef) {
  if (manifest?.triggers instanceof Map) {
    return manifest.triggers.get(triggerRef);
  }
  if (manifest?.triggers && typeof manifest.triggers === "object" && !Array.isArray(manifest.triggers)) {
    return manifest.triggers[triggerRef];
  }
  return undefined;
}

function triggerStatus(trigger, manifestTrigger) {
  if (!manifestTrigger) {
    return "blocked";
  }
  if (manifestTrigger.enabled === false) {
    return "disabled";
  }
  if (manifestTrigger.source?.kind !== trigger.event?.kind) {
    return "blocked";
  }
  return "enabled";
}

function triggerStatusLimits(trigger, manifestTrigger) {
  const source = manifestTrigger?.limits ?? trigger.limits ?? {};
  return {
    max_runs_per_day: safeNullableInteger(source.max_runs_per_day),
    timeout_ms: safeNullableInteger(source.timeout_ms),
  };
}

function queueEntriesForTrigger(queue, triggerRef) {
  return (Array.isArray(queue?.entries) ? queue.entries : [])
    .filter((entry) => entry?.trigger_ref === triggerRef);
}

function safeNonNegativeInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

function safeNullableInteger(value) {
  return Number.isInteger(value) && value >= 0 ? value : null;
}


function normalizeStateTriggerEvent(event) {
  return {
    triggerRef: stringOrNull(event?.trigger_ref ?? event?.triggerRef),
    eventId: stringOrNull(event?.event_id ?? event?.eventId),
    sourceKind: stringOrNull(event?.source_kind ?? event?.sourceKind),
  };
}


function isTerminalQueueStatus(status) {
  return status === "succeeded" || status === "failed" || status === "dead_lettered";
}


function replayRejectedResult(document, event, runId) {
  const effectiveRunId = runId ?? "trigger-service-replay-rejected";
  const trace = {
    trace_protocol_version: "touba-trace-v1",
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

function shouldRetryQueueEntry(entry, runtimeErrorCode, maxAttempts, effectJournal) {
  if (isAlwaysNonRetryableRuntimeErrorCode(runtimeErrorCode)) {
    return false;
  }
  const unknownDecision = unknownEffectRetryDecisionForEntry(entry, effectJournal);
  if (unknownDecision !== null) {
    return unknownDecision && (entry.attempt_count ?? 0) < maxAttempts;
  }
  if (isNonRetryableRuntimeErrorCode(runtimeErrorCode)) {
    return false;
  }
  return (entry.attempt_count ?? 0) < maxAttempts;
}

function unknownEffectRetryDecisionForEntry(entry, effectJournal) {
  if (!effectJournal?.entriesForScope) {
    return null;
  }
  return unknownEffectRetryDecision(effectJournal.entriesForScope(entry.queue_id));
}

function isAlwaysNonRetryableRuntimeErrorCode(runtimeErrorCode) {
  return typeof runtimeErrorCode === "string"
    && (
      runtimeErrorCode.startsWith("Trigger")
      || runtimeErrorCode === "SecretValueInTriggerArgument"
      || [
        "EffectContextRequired",
        "EffectJournalInvalid",
        "EffectJournalRequired",
        "EffectReconciliationRequired",
        "EffectRequestConflict",
        "EffectResultUnavailable",
      ].includes(runtimeErrorCode)
    );
}

function isNonRetryableRuntimeErrorCode(runtimeErrorCode) {
  return isAlwaysNonRetryableRuntimeErrorCode(runtimeErrorCode)
    || runtimeErrorCode === "EffectOutcomeUnknown";
}

function retryDelayMs(attemptCount) {
  return Math.min(1000 * 2 ** Math.max(0, attemptCount - 1), 30000);
}

function triggerEventId(request, trigger, digest) {
  const header = request.headers["x-touba-event-id"];
  if (header === undefined) {
    return `evt-http-${safeFilePart(trigger.name ?? "trigger")}-${Date.now()}-${digest.slice(0, 12)}-${randomUUID()}`;
  }
  const value = Array.isArray(header) && header.length === 1 ? header[0] : header;
  if (typeof value === "string" && /^[A-Za-z0-9_.:-]{1,128}$/u.test(value)) {
    return value;
  }
  throw serviceError(
    "TriggerEventIdInvalid",
    "x-touba-event-id must contain 1 to 128 ASCII letters, digits, dots, underscores, colons or hyphens",
  );
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
    effectJournalPath: undefined,
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
    } else if (arg === "--state-max-bytes" || arg.startsWith("--state-max-bytes=")) {
      parsed.stateMaxBytes = parsePositiveInteger(arg.includes("=") ? arg.slice("--state-max-bytes=".length)
        : requiredValue(rawArgs, ++index, "--state-max-bytes"), "--state-max-bytes");
      if (parsed.stateMaxBytes < 65536) throw serviceError("TriggerServiceUsage", "--state-max-bytes must be >= 65536");
    } else if (arg.startsWith("--state=")) {
      parsed.statePath = nonEmptyValue(arg.slice("--state=".length), "--state");
    } else if (arg === "--queue") {
      parsed.queuePath = requiredValue(rawArgs, ++index, "--queue");
    } else if (arg === "--queue-max-entries" || arg.startsWith("--queue-max-entries=")) {
      parsed.queueMaxEntries = parsePositiveInteger(arg.includes("=") ? arg.slice("--queue-max-entries=".length)
        : requiredValue(rawArgs, ++index, "--queue-max-entries"), "--queue-max-entries");
    } else if (arg === "--queue-max-bytes" || arg.startsWith("--queue-max-bytes=")) {
      parsed.queueMaxBytes = parsePositiveInteger(arg.includes("=") ? arg.slice("--queue-max-bytes=".length)
        : requiredValue(rawArgs, ++index, "--queue-max-bytes"), "--queue-max-bytes");
      if (parsed.queueMaxBytes < 65536) throw serviceError("TriggerServiceUsage", "--queue-max-bytes must be >= 65536");
    } else if (arg.startsWith("--queue=")) {
      parsed.queuePath = nonEmptyValue(arg.slice("--queue=".length), "--queue");
    } else if (arg === "--effect-journal") {
      parsed.effectJournalPath = requiredValue(rawArgs, ++index, "--effect-journal");
    } else if (arg.startsWith("--effect-journal=")) {
      parsed.effectJournalPath = nonEmptyValue(arg.slice("--effect-journal=".length), "--effect-journal");
    } else if (arg === "--secrets") {
      parsed.secretsPath = requiredValue(rawArgs, ++index, "--secrets");
    } else if (arg.startsWith("--secrets=")) {
      parsed.secretsPath = nonEmptyValue(arg.slice("--secrets=".length), "--secrets");
    } else if (["--agent-decision-provider", "--human-approval-host", "--human-checkpoint-store", "--management-token-env", "--project-root"].includes(arg.split("=")[0])) {
      const option = arg.split("=")[0];
      const field = { "--agent-decision-provider": "agentDecisionProviderPath", "--human-approval-host": "humanApprovalHostPath",
        "--human-checkpoint-store": "humanCheckpointStorePath", "--management-token-env": "managementTokenEnv", "--project-root": "projectRoot" }[option];
      parsed[field] = arg.includes("=") ? nonEmptyValue(arg.slice(option.length + 1), option) : requiredValue(rawArgs, ++index, option);
    } else if (["--agent-decision-provider-timeout-ms", "--human-approval-authority-timeout-ms"].includes(arg.split("=")[0])) {
      const option = arg.split("=")[0];
      const value = parsePositiveInteger(arg.includes("=") ? arg.slice(option.length + 1) : requiredValue(rawArgs, ++index, option), option);
      if (value > 60000) throw serviceError("TriggerServiceUsage", `${option} must be <= 60000`);
      parsed[option === "--agent-decision-provider-timeout-ms" ? "agentDecisionProviderTimeoutMs" : "humanApprovalAuthorityTimeoutMs"] = value;
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
    } else if (arg === "--trace-store" || arg.startsWith("--trace-store=")) {
      parsed.traceStorePath = arg.includes("=") ? nonEmptyValue(arg.slice("--trace-store=".length), "--trace-store") : requiredValue(rawArgs, ++index, "--trace-store");
    } else if (arg === "--trace-max-bytes" || arg.startsWith("--trace-max-bytes=")) {
      parsed.traceMaxBytes = parsePositiveInteger(arg.includes("=") ? arg.slice("--trace-max-bytes=".length) : requiredValue(rawArgs, ++index, "--trace-max-bytes"), "--trace-max-bytes");
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
    "Usage: touba trigger serve <program.air.json> --manifest <path> [--state <path.sqlite>] [--queue <path.sqlite>] [options]",
    "",
    "Options:",
    "  --queue <path.sqlite>           Queue, default .touba/trigger-queue.sqlite",
    "  --queue-max-entries <n>         Queue entry limit, default 10000",
    "  --queue-max-bytes <n>           Queue storage limit, default 536870912 bytes",
    "  --state <path.sqlite>           Trigger ledger, default .touba/triggers.sqlite",
    "  --state-max-bytes <n>           Trigger ledger quota, default 536870912 bytes",
    "  --trigger <trigger_ref>          Restrict service routes to one request trigger",
    "  --host <host>                   Bind host, default 127.0.0.1",
    "  --port <port>                   Bind port, default 8787; use 0 for an ephemeral test port",
    "  --trace-store <path.sqlite>     Trace journal, default .touba/traces.sqlite",
    "  --trace-max-bytes <n>           Trace quota, default 536870912 bytes",
    "  --trace-dir <dir>               Also export each processed trace as JSON",
    "  --effect-journal <path>          Persist touba-effect-journal-v1 for external writes",
    "  --max-events <n>                Stop after n processed entries, useful for tests and supervised jobs",
    "  --max-attempts <n>              Retry target failures up to n attempts, default 3",
    "  --processing-timeout-ms <n>     Mark exited workers interrupted after n ms, default 300000",
    "  --auth-token-env <NAME>         Require bearer token or x-touba-trigger-token from the named env var",
    "  --signature-secret-env <NAME>   Require x-touba-signature: sha256=<hex> HMAC using the named env var",
    "  --secrets <touba.secrets.json>  Resolve declared secret handles for triggered runs",
    "  --agent-decision-provider <path>  Explicit trusted JavaScript or Python decision host",
    "  --agent-decision-provider-timeout-ms <n>  Bound each provider call (1..60000 ms)",
    "  --human-approval-host <path>     Explicit trusted human attestation host",
    "  --human-approval-authority-timeout-ms <n>  Bound each attestation (1..60000 ms)",
    "  --human-checkpoint-store <path.sqlite>  Private single-use checkpoint custody",
    "  --management-token-env <NAME>   Separate management token for /_touba/approvals",
    "  --project-root <path>           Project root for explicitly activated package hosts",
  ].join("\n");
}

function required(value, label) {
  if (value === undefined || value === "") {
    throw serviceError("TriggerServiceUsage", `${label} is required`);
  }
  return value;
}

function requiredValue(args, index, option) {
  if (index >= args.length || args[index].startsWith("--")) {
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

function stableQueueId(triggerRef, eventId) {
  return `queue:sha256:${hashText(JSON.stringify([triggerRef, eventId]))}`;
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
  if (code === "TriggerQueueCapacityExceeded" || code === "TriggerStateUnavailable") return 503;
  if (["TriggerEventPayloadConflict", "TriggerReplayRejected", "TriggerApprovalConflict", "TriggerWorkerBusy"].includes(code)) {
    return 409;
  }
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
