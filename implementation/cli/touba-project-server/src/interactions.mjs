import { createHash, randomBytes } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { StringDecoder } from "node:string_decoder";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";
import { validatedRecords } from "./validated-records.mjs";
import { indexedStore } from "./indexed-store.mjs";

const SESSION_SCHEMA = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/schemas/touba-interaction-session-v1.schema.json", import.meta.url), "utf8"));
const ASSET_SCHEMA = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/schemas/touba-interaction-asset-v1.schema.json", import.meta.url), "utf8"));

export const INTERACTION_SESSION_CREATE_SCHEMA_VERSION = "touba-interaction-session-create-v1";
export const INTERACTION_MESSAGE_REQUEST_SCHEMA_VERSION = "touba-interaction-message-request-v1";
export const INTERACTION_RESUME_REQUEST_SCHEMA_VERSION = "touba-interaction-resume-request-v1";
export const INTERACTION_SESSION_SCHEMA_VERSION = "touba-interaction-session-v1";
export const INTERACTION_SESSION_LIST_SCHEMA_VERSION = "touba-interaction-session-list-v1";
export const INTERACTION_OPERATION_SCHEMA_VERSION = "touba-interaction-operation-v1";
export const INTERACTION_ASSET_SCHEMA_VERSION = "touba-interaction-asset-v1";
export const INTERACTION_SESSION_STORE_SCHEMA_VERSION = "touba-interaction-sessions-v1";
export const INTERACTION_ASSET_STORE_SCHEMA_VERSION = "touba-interaction-assets-v1";
export const MAX_INTERACTION_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_INTERACTION_DISPLAY_TEXT_BYTES = 4096;

const MAX_SESSIONS = 100;
const MAX_MESSAGES_PER_SESSION = 100;
const MAX_OPERATIONS_PER_SESSION = 50;
const MAX_PROGRESS_EVENTS_PER_OPERATION = 80;
const ACTIVE_OPERATION_STATUSES = new Set(["queued", "running", "cancel_requested"]);
const TERMINAL_OPERATION_STATUSES = new Set(["succeeded", "failed", "cancelled"]);
const EXECUTABLE_INTERACTION_TARGET_KINDS = new Set([
  "agent",
  "function",
  "skill",
  "strategy",
  "tool",
  "trigger",
]);
const ALLOWED_MEDIA_TYPES = Object.freeze({
  audio: new Set(["audio/mpeg", "audio/mp4", "audio/ogg", "audio/wav", "audio/x-wav"]),
  document: new Set(["application/json", "application/pdf", "text/csv", "text/markdown", "text/plain"]),
  file: new Set(["application/octet-stream"]),
  image: new Set(["image/gif", "image/jpeg", "image/png", "image/webp"]),
});

export function createInteractionSession({
  request,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath);
  const removeIds = [];
  while (store.sessions.length >= MAX_SESSIONS) {
    const evictable = store.sessions
      .filter((session) => !sessionHasActiveOperation(session))
      .sort(compareInteractionSessionAge)[0];
    if (evictable === undefined) {
      throw interactionError(
        "ToubaServeInteractionSessionCapacityExceeded",
        `interaction store already has ${MAX_SESSIONS} sessions with active operations`,
      );
    }
    removeIds.push(evictable.session_id);
    store.sessions.splice(store.sessions.findIndex((session) => (
      session.session_id === evictable.session_id
    )), 1);
  }
  const session = {
    schema_version: INTERACTION_SESSION_SCHEMA_VERSION,
    session_id: `interaction_${compactTimestamp(generatedAt)}_${randomBytes(4).toString("hex")}`,
    target_ref: request.target_ref,
    target_kind: request.target_kind,
    presentation: request.presentation,
    effect_policy: request.effect_policy,
    title: shortTargetRef(request.target_ref),
    status: "open",
    last_run_status: null,
    created_at: generatedAt,
    updated_at: generatedAt,
    created_by: request.requested_by,
    messages: [],
    operations: [],
  };
  store.sessions.push(session);
  store.sessions.sort(compareInteractionSessionAge);
  saveInteractionSessionStore(sessionsPath, store, { removeIds });
  return session;
}

function sessionHasActiveOperation(session) {
  return session.operations.some((operation) => !TERMINAL_OPERATION_STATUSES.has(operation.status));
}

function compareInteractionSessionAge(left, right) {
  return left.updated_at.localeCompare(right.updated_at)
    || left.created_at.localeCompare(right.created_at)
    || left.session_id.localeCompare(right.session_id);
}

export function listInteractionSessions(sessionsPath) {
  const store = loadInteractionSessionStore(sessionsPath);
  return {
    schema_version: INTERACTION_SESSION_LIST_SCHEMA_VERSION,
    sessions: [...store.sessions]
      .filter((session) => EXECUTABLE_INTERACTION_TARGET_KINDS.has(session.target_kind))
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((session) => ({
        session_id: session.session_id,
        target_ref: session.target_ref,
        target_kind: session.target_kind,
        presentation: session.presentation,
        title: session.title,
        status: session.status,
        last_run_status: session.last_run_status,
        updated_at: session.updated_at,
        message_count: session.messages.length,
        operation_count: session.operations.length,
        active_operation: session.operations.find((operation) => (
          ACTIVE_OPERATION_STATUSES.has(operation.status) || operation.status === "awaiting_human"
        )) ?? null,
      })),
  };
}

// Fresh validated snapshot for a synchronous recovery pass. It must not be
// retained across awaits or used to authorize a later write.
export function readInteractionSessions(sessionsPath) {
  return loadInteractionSessionStore(sessionsPath).sessions;
}

export function getInteractionSession({ sessionId, sessionsPath }) {
  const session = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]).sessions
    .find((candidate) => candidate.session_id === sessionId);
  if (session === undefined) {
    throw interactionError("ToubaServeInteractionSessionNotFound", "interaction session is unknown");
  }
  return session;
}

export function findInteractionOperationByMessage({ messageId, sessionId, sessionsPath }) {
  const session = getInteractionSession({ sessionId, sessionsPath });
  return session.operations.find((operation) => operation.message_id === messageId);
}

export function getInteractionOperation({ operationId, sessionId, sessionsPath }) {
  const session = getInteractionSession({ sessionId, sessionsPath });
  const operation = session.operations.find((candidate) => candidate.operation_id === operationId);
  if (operation === undefined) {
    throw interactionError("ToubaServeInteractionOperationNotFound", "interaction operation is unknown");
  }
  return operation;
}

export function enqueueInteractionOperation({
  message,
  runId,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]);
  const session = requireSession(store, sessionId);
  const existing = session.operations.find((operation) => operation.message_id === message.message_id);
  if (existing !== undefined) return existing;
  if (session.status === "archived") {
    throw interactionError("ToubaServeInteractionSessionArchived", "archived interaction session is read-only");
  }
  if (session.operations.some((operation) => (
    ACTIVE_OPERATION_STATUSES.has(operation.status) || operation.status === "awaiting_human"
  ))) {
    throw interactionError("ToubaServeInteractionSessionBusy", "interaction session already has an active operation");
  }
  const displayText = boundedDisplayText(message.display_text);
  const operation = {
    schema_version: INTERACTION_OPERATION_SCHEMA_VERSION,
    operation_id: `operation_${compactTimestamp(generatedAt)}_${randomBytes(4).toString("hex")}`,
    session_id: sessionId,
    message_id: message.message_id,
    target_ref: session.target_ref,
    run_id: runId,
    status: "queued",
    event_count: 0,
    current_event: null,
    recent_events: [],
    created_at: generatedAt,
    started_at: null,
    completed_at: null,
    cancel_requested_at: null,
    error: null,
  };
  session.messages.push({
    message_id: message.message_id,
    role: "user",
    created_at: generatedAt,
    display_text: displayText,
    operation_id: operation.operation_id,
    run_id: runId,
    run_status: "queued",
  });
  session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
  session.operations.push(operation);
  session.operations = session.operations.slice(-MAX_OPERATIONS_PER_SESSION);
  session.title = sessionTitle(session, displayText);
  session.status = "running";
  session.last_run_status = "queued";
  session.updated_at = generatedAt;
  saveInteractionSessionStore(sessionsPath, store);
  return operation;
}

export function startInteractionOperation({
  operationId,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]);
  const { session, operation } = requireOperation(store, sessionId, operationId);
  if (!["queued", "awaiting_human", "cancel_requested"].includes(operation.status)) {
    throw interactionError("ToubaServeInteractionOperationStateInvalid", "interaction operation cannot start from its current state");
  }
  operation.started_at ??= generatedAt;
  operation.completed_at = null;
  operation.error = null;
  if (operation.status !== "cancel_requested") {
    operation.status = "running";
    updateUserMessageStatus(session, operation.message_id, "running");
    session.status = "running";
    session.last_run_status = "running";
  }
  session.updated_at = generatedAt;
  saveInteractionSessionStore(sessionsPath, store);
  return operation;
}

/**
 * An interrupted durable operation may only re-enter running through an
 * explicit resume request. Keeping this transition separate prevents the
 * normal queue starter from turning process recovery into an implicit retry.
 */
export function resumeInterruptedInteractionOperation({
  operationId,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]);
  const { session, operation } = requireOperation(store, sessionId, operationId);
  if (operation.status !== "interrupted") {
    throw interactionError(
      "DurableResumeNotAvailable",
      "only an interrupted interaction operation can be resumed durably",
    );
  }
  operation.status = "running";
  operation.completed_at = null;
  operation.error = null;
  updateUserMessageStatus(session, operation.message_id, "running");
  session.status = "running";
  session.last_run_status = "running";
  session.updated_at = generatedAt;
  saveInteractionSessionStore(sessionsPath, store);
  return operation;
}

export function recordInteractionOperationProgress({
  events,
  operationId,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]);
  const { session, operation } = requireOperation(store, sessionId, operationId);
  if (!ACTIVE_OPERATION_STATUSES.has(operation.status)) return operation;
  const progress = events.map(event => publicProgressEvent(event, generatedAt));
  if (progress.length === 0) return operation;
  operation.event_count += progress.length;
  operation.current_event = progress.at(-1);
  operation.recent_events.push(...progress);
  operation.recent_events = operation.recent_events.slice(-MAX_PROGRESS_EVENTS_PER_OPERATION);
  session.updated_at = generatedAt;
  saveInteractionSessionStore(sessionsPath, store);
  return operation;
}

// Progress is a bounded UI projection, not the effect journal or checkpoint.
// Coalesce synchronous trace bursts, then persist before publishing to SSE.
export function bufferedInteractionProgress(args, onProgress) {
  let pending = [];
  let scheduled = null;
  let failure = null;
  const flush = () => {
    if (scheduled !== null) clearImmediate(scheduled);
    scheduled = null;
    if (failure) throw failure;
    if (!pending.length) return;
    const events = pending;
    pending = [];
    try {
      onProgress(recordInteractionOperationProgress({ ...args, events }));
    } catch (error) { failure = error; throw error; }
  };
  return {
    record(event) {
      if (failure) throw failure;
      pending.push(event);
      if (pending.length >= MAX_PROGRESS_EVENTS_PER_OPERATION) return flush();
      scheduled ??= setImmediate(() => { try { flush(); } catch { /* Delivered to the run on its next event or final flush. */ } });
    },
    flush,
    close() {
      if (scheduled !== null) clearImmediate(scheduled);
      scheduled = null;
      pending = [];
    },
  };
}

export function completeInteractionOperation({
  operationId,
  result,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]);
  const { session, operation } = requireOperation(store, sessionId, operationId);
  assertInteractionResultIdentity({ operation, result });
  const finalStatus = operationStatusForRun(result);
  const resultDigest = interactionResultDigest(result);
  const recordedTerminal = session.messages.find((message) => (
    message.operation_id === operation.operation_id
    && message.role === "touba"
    && isTerminalInteractionResult(message.run_result)
  ));
  if (recordedTerminal !== undefined) {
    if (interactionResultDigest(recordedTerminal.run_result) === resultDigest) return operation;
    throw interactionError(
      "ToubaServeInteractionOperationResultConflict",
      "interaction operation already has a different terminal result",
    );
  }
  if (
    TERMINAL_OPERATION_STATUSES.has(operation.status)
    && operation.status !== finalStatus
  ) {
    throw interactionError(
      "ToubaServeInteractionOperationResultConflict",
      "interaction operation terminal status conflicts with its result projection",
    );
  }
  operation.status = finalStatus;
  operation.completed_at = result.completed_at ?? generatedAt;
  operation.error = finalStatus === "failed"
    ? publicOperationError(result)
    : null;
  // One run can pause at multiple checkpoints before reaching a terminal result.
  // Retries return the same persisted result; different outcomes must survive.
  const resultMessageId = `${operation.message_id}:result:${resultDigest}`;
  if (!session.messages.some((message) => message.message_id === resultMessageId)) {
    session.messages.push({
      message_id: resultMessageId,
      role: "touba",
      created_at: operation.completed_at,
      display_text: resultDisplayText(result),
      operation_id: operation.operation_id,
      run_id: result.run_id,
      run_status: result.status,
      run_result: result,
    });
  }
  session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
  updateUserMessageStatus(session, operation.message_id, result.status);
  session.status = sessionStatusForOperation(operation.status);
  session.last_run_status = operation.status;
  session.updated_at = generatedAt;
  saveInteractionSessionStore(sessionsPath, store);
  return operation;
}

export function failInteractionOperation({
  code,
  message,
  operationId,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]);
  const { session, operation } = requireOperation(store, sessionId, operationId);
  if (
    operation.status === "awaiting_human"
    || TERMINAL_OPERATION_STATUSES.has(operation.status)
  ) {
    return operation;
  }
  operation.status = "failed";
  operation.completed_at = generatedAt;
  operation.error = {
    code: boundedOperationText(code, 128),
    message: boundedOperationText(message, 512),
  };
  updateUserMessageStatus(session, operation.message_id, "failure");
  session.status = "failed";
  session.last_run_status = "failed";
  session.updated_at = generatedAt;
  saveInteractionSessionStore(sessionsPath, store);
  return operation;
}

export function requestInteractionOperationCancel({
  operationId,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]);
  const { session, operation } = requireOperation(store, sessionId, operationId);
  if (operation.status === "cancel_requested") return operation;
  if (!["queued", "running", "awaiting_human"].includes(operation.status)) {
    throw interactionError("ToubaServeInteractionOperationNotCancellable", "interaction operation is not cancellable");
  }
  operation.status = "cancel_requested";
  operation.cancel_requested_at ??= generatedAt;
  session.status = "running";
  session.last_run_status = "cancel_requested";
  session.updated_at = generatedAt;
  saveInteractionSessionStore(sessionsPath, store);
  return operation;
}

export function archiveInteractionSession({
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath, [{ id: sessionId }]);
  const session = requireSession(store, sessionId);
  if (session.operations.some((operation) => (
    ACTIVE_OPERATION_STATUSES.has(operation.status) || operation.status === "awaiting_human"
  ))) {
    throw interactionError(
      "ToubaServeInteractionSessionBusy",
      "an interaction session with an active operation cannot be archived",
    );
  }
  session.status = "archived";
  session.updated_at = generatedAt;
  saveInteractionSessionStore(sessionsPath, store);
  return session;
}

export function recoverInterruptedInteractionOperations({
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath);
  const recovered = [];
  for (const session of store.sessions) {
    for (const operation of session.operations) {
      if (!ACTIVE_OPERATION_STATUSES.has(operation.status)) continue;
      if (operation.status === "cancel_requested") {
        operation.status = "cancelled";
        operation.completed_at = generatedAt;
        operation.error = null;
        updateUserMessageStatus(session, operation.message_id, "cancelled");
        session.status = "open";
        session.last_run_status = "cancelled";
        session.updated_at = generatedAt;
        recovered.push(operation);
        continue;
      }
      operation.status = "interrupted";
      operation.completed_at = generatedAt;
      operation.error = {
        code: "ToubaServeInteractionInterrupted",
        message: "project server stopped before the interaction operation completed",
      };
      updateUserMessageStatus(session, operation.message_id, "interrupted");
      session.status = "failed";
      session.last_run_status = "interrupted";
      session.updated_at = generatedAt;
      recovered.push(operation);
    }
  }
  if (recovered.length > 0) saveInteractionSessionStore(sessionsPath, store);
  return recovered;
}

export function validateInteractionResume({
  checkpointStatus,
  runId,
  sessionId,
  sessionsPath,
}) {
  const session = getInteractionSession({ sessionId, sessionsPath });
  const operation = [...session.operations].reverse()
    .find((candidate) => candidate.run_id === runId);
  const alreadyRecorded = operation !== undefined && (checkpointStatus === "superseded" || session.messages.some((candidate) => (
    candidate.operation_id === operation.operation_id
    && candidate.role === "touba"
    && candidate.run_result
    && operationStatusForRun(candidate.run_result) !== "awaiting_human"
  )));
  if (alreadyRecorded) {
    return { alreadyRecorded, operation, session };
  }
  if (
    session.status !== "awaiting_human"
    || operation?.status !== "awaiting_human"
  ) {
    throw interactionError(
      "ToubaServeInteractionResumeMismatch",
      "checkpoint does not belong to the latest stopped run in this interaction session",
    );
  }
  return { alreadyRecorded, operation, session };
}

export function storeInteractionAsset({
  assetsDirectory,
  assetsPath,
  buffer,
  contentKind,
  digest,
  mediaType,
  name,
  generatedAt = new Date().toISOString(),
}) {
  assertAssetMetadata({ buffer, contentKind, digest, mediaType, name });
  const actualDigest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
  if (digest !== undefined && digest !== actualDigest) {
    throw interactionError("ToubaServeInteractionAssetDigestMismatch", "interaction asset digest does not match its content");
  }
  const store = loadInteractionAssetStore(assetsPath, [{ digest: actualDigest }]);
  const existing = store.assets.find((asset) => asset.digest === actualDigest);
  if (existing !== undefined) return publicAsset(existing);
  const handle = `asset_${actualDigest.slice("sha256:".length, "sha256:".length + 24)}`;
  const storageName = `${actualDigest.slice("sha256:".length)}.bin`;
  mkdirSync(assetsDirectory, { recursive: true });
  writeBufferAtomic(join(assetsDirectory, storageName), buffer);
  const asset = {
    schema_version: INTERACTION_ASSET_SCHEMA_VERSION,
    handle,
    name: basename(name),
    media_type: mediaType,
    content_kind: contentKind,
    size_bytes: buffer.length,
    digest: actualDigest,
    created_at: generatedAt,
    storage_name: storageName,
  };
  store.assets.push(asset);
  indexedAssetStore(assetsPath).write(store.assets);
  return publicAsset(asset);
}

export function readInteractionAsset({ assetsDirectory, assetsPath, handle }) {
  const asset = loadInteractionAssetStore(assetsPath, [{ id: handle }]).assets
    .find((candidate) => candidate.handle === handle);
  if (asset === undefined) {
    throw interactionError("ToubaServeInteractionAssetNotFound", "interaction asset handle is unknown");
  }
  const path = join(assetsDirectory, asset.storage_name);
  if (!existsSync(path) || !statSync(path).isFile()) {
    throw interactionError("ToubaServeInteractionAssetCorrupt", "interaction asset content is unavailable");
  }
  const buffer = readFileSync(path);
  const actualDigest = `sha256:${createHash("sha256").update(buffer).digest("hex")}`;
  if (actualDigest !== asset.digest || buffer.length !== asset.size_bytes) {
    throw interactionError("ToubaServeInteractionAssetCorrupt", "interaction asset integrity verification failed");
  }
  return { asset: publicAsset(asset), buffer };
}

const validateCurrentSession = validatedRecords(session => {
  if (validateObject(SESSION_SCHEMA, session).length > 0) {
    throw interactionError("ToubaServeInteractionSessionStoreInvalid", "stored sessions must satisfy the canonical session contract");
  }
});

function indexedSessionStore(path) {
  return indexedStore({
    path, schemaVersion: INTERACTION_SESSION_STORE_SCHEMA_VERSION,
    keyOf: session => session.session_id, validate: validateCurrentSession,
    checkTransaction(db) {
      if (db.prepare("SELECT COUNT(*) AS count FROM records").get().count > MAX_SESSIONS) {
        throw interactionError("ToubaServeInteractionSessionCapacityExceeded", "interaction projection exceeds its bounded window");
      }
    },
  });
}

function loadInteractionSessionStore(path, filter) {
  try {
    return { schema_version: INTERACTION_SESSION_STORE_SCHEMA_VERSION, sessions: indexedSessionStore(path).read(filter) };
  } catch (error) {
    if (error instanceof SyntaxError || typeof error.errno === "number" || error.code?.startsWith("ToubaStore") || error.code?.startsWith("ERR_SQLITE")) {
      throw interactionError("ToubaServeInteractionSessionStoreInvalid", "interaction session store is not a valid indexed state");
    }
    throw error;
  }
}

function saveInteractionSessionStore(path, store, options) {
  indexedSessionStore(path).write(store.sessions, options);
}

function indexedAssetStore(path) {
  return indexedStore({ path, schemaVersion: INTERACTION_ASSET_STORE_SCHEMA_VERSION,
    keyOf: asset => asset.handle, indexes: { digest: "json_extract(body, '$.digest')" },
    validate(asset) {
      if (!asset || validateObject(ASSET_SCHEMA, publicAsset(asset)).length > 0
        || !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
        || asset.storage_name !== `${asset.digest.slice(7)}.bin`
        || asset.handle !== `asset_${asset.digest.slice(7, 31)}`) {
        throw interactionError("ToubaServeInteractionAssetStoreInvalid", "stored asset has an invalid contract or content address");
      }
    },
  });
}

function loadInteractionAssetStore(path, filter) {
  try {
    return { schema_version: INTERACTION_ASSET_STORE_SCHEMA_VERSION, assets: indexedAssetStore(path).read(filter) };
  } catch {
    throw interactionError("ToubaServeInteractionAssetStoreInvalid", "interaction asset store is not a valid indexed state");
  }
}

export function auditInteractionAssets(path) { loadInteractionAssetStore(path); }

function assertAssetMetadata({ buffer, contentKind, mediaType, name }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw interactionError("ToubaServeInteractionAssetInvalid", "interaction asset body is empty");
  }
  if (buffer.length > MAX_INTERACTION_ASSET_BYTES) {
    throw interactionError(
      "ToubaServeInteractionAssetTooLarge",
      `interaction asset exceeds ${MAX_INTERACTION_ASSET_BYTES} bytes`,
    );
  }
  if (typeof name !== "string" || name.trim() === "" || basename(name) !== name) {
    throw interactionError("ToubaServeInteractionAssetInvalid", "interaction asset name must be a file name");
  }
  if (!Object.hasOwn(ALLOWED_MEDIA_TYPES, contentKind)) {
    throw interactionError("ToubaServeInteractionAssetInvalid", "interaction content_kind is unsupported");
  }
  if (!ALLOWED_MEDIA_TYPES[contentKind].has(mediaType)) {
    throw interactionError(
      "ToubaServeInteractionAssetMediaTypeRejected",
      `media type ${mediaType} is not accepted for ${contentKind}`,
    );
  }
}

function publicAsset(asset) {
  const { storage_name: _storageName, ...value } = asset;
  return value;
}

function boundedDisplayText(value) {
  const text = typeof value === "string" ? value : "";
  if (Buffer.byteLength(text, "utf8") > MAX_INTERACTION_DISPLAY_TEXT_BYTES) {
    throw interactionError(
      "ToubaServeInteractionMessageTooLarge",
      `display_text exceeds ${MAX_INTERACTION_DISPLAY_TEXT_BYTES} bytes`,
    );
  }
  return text;
}

function resultDisplayText(result) {
  if (result.messages?.length) return boundedResultText(result.messages.map(message => message.text).join("\n"));
  if (typeof result.result === "string") return boundedResultText(result.result);
  if (result.result === null || result.result === undefined) return "";
  return boundedResultText(JSON.stringify(result.result));
}

export function boundedResultText(value, maxBytes = MAX_INTERACTION_DISPLAY_TEXT_BYTES) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length <= maxBytes) return String(value);
  const suffix = ".".repeat(Math.min(3, maxBytes));
  return new StringDecoder("utf8").write(bytes.subarray(0, maxBytes - suffix.length)) + suffix;
}

function operationStatusForRun(result) {
  if (result.status === "success") return "succeeded";
  if (result.status === "cancelled") return "cancelled";
  if (result.status === "stopped") {
    const codes = new Set((result.diagnostics ?? []).map((diagnostic) => diagnostic.code));
    if (codes.has("ToubaSandboxRunAwaitingHumanDecision")) return "awaiting_human";
    if (codes.has("ToubaSandboxHumanDecisionCancelled")) return "cancelled";
  }
  return "failed";
}

function isTerminalInteractionResult(result) {
  return result !== undefined
    && result !== null
    && TERMINAL_OPERATION_STATUSES.has(operationStatusForRun(result));
}

function interactionResultDigest(result) {
  return createHash("sha256").update(JSON.stringify(result)).digest("hex");
}

function assertInteractionResultIdentity({ operation, result }) {
  if (
    result === null
    || typeof result !== "object"
    || Array.isArray(result)
    || result.run_id !== operation.run_id
    || result.target_ref !== operation.target_ref
  ) {
    throw interactionError(
      "ToubaServeInteractionOperationResultMismatch",
      "interaction result does not belong to the requested operation",
    );
  }
}

function sessionStatusForOperation(status) {
  if (status === "awaiting_human") return "awaiting_human";
  if (["failed", "interrupted"].includes(status)) return "failed";
  return "open";
}

function requireSession(store, sessionId) {
  const session = store.sessions.find((candidate) => candidate.session_id === sessionId);
  if (session === undefined) {
    throw interactionError("ToubaServeInteractionSessionNotFound", "interaction session is unknown");
  }
  return session;
}

function requireOperation(store, sessionId, operationId) {
  const session = requireSession(store, sessionId);
  const operation = session.operations.find((candidate) => candidate.operation_id === operationId);
  if (operation === undefined) {
    throw interactionError("ToubaServeInteractionOperationNotFound", "interaction operation is unknown");
  }
  return { session, operation };
}

function updateUserMessageStatus(session, messageId, status) {
  const message = session.messages.find((candidate) => candidate.message_id === messageId);
  if (message !== undefined) message.run_status = status;
}

function publicProgressEvent(event, generatedAt) {
  const references = {};
  for (const source of [event?.air_ref, event?.payload]) {
    if (!source || typeof source !== "object" || Array.isArray(source)) continue;
    for (const key of [
      "agent_ref",
      "approval_ref",
      "caller_ref",
      "capability_ref",
      "flow_graph_ref",
      "graph_ref",
      "memory_ref",
      "owner_ref",
      "selected_ref",
      "skill_ref",
      "strategy_ref",
      "target_ref",
      "tool_ref",
      "trigger_ref",
    ]) {
      if (typeof source[key] === "string" && source[key].trim() !== "") {
        references[key] = source[key];
      }
    }
  }
  return {
    type: boundedOperationText(event?.kind ?? event?.type ?? "runtime_event", 128),
    sequence_index: Number.isInteger(event?.sequence_index) ? event.sequence_index : 0,
    references,
    observed_at: generatedAt,
  };
}

function publicOperationError(result) {
  const diagnostic = (result?.diagnostics ?? []).find((candidate) => candidate.severity === "error")
    ?? result?.diagnostics?.[0];
  return {
    code: boundedOperationText(diagnostic?.code ?? "ToubaInteractionRunFailed", 128),
    message: boundedOperationText(diagnostic?.message ?? "interaction run failed", 512),
  };
}

function boundedOperationText(value, maxLength) {
  return String(value ?? "").slice(0, maxLength);
}

function sessionTitle(session, displayText) {
  const target = shortTargetRef(session.target_ref);
  const summary = displayText.trim().replaceAll(/\s+/gu, " ").slice(0, 72);
  return summary === "" ? target : `${target} · ${summary}`;
}

function shortTargetRef(ref) {
  const value = String(ref ?? "");
  return value.split("/").at(-1) || value;
}

function compactTimestamp(value) {
  return String(value).replaceAll(/[^0-9]/gu, "").slice(0, 14);
}

function writeBufferAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, value);
  renameSync(tempPath, path);
}

function interactionError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
