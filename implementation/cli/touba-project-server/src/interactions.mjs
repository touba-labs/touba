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

export const INTERACTION_SESSION_CREATE_SCHEMA_VERSION = "touba-interaction-session-create-v0.1";
export const INTERACTION_MESSAGE_REQUEST_SCHEMA_VERSION = "touba-interaction-message-request-v0.1";
export const INTERACTION_RESUME_REQUEST_SCHEMA_VERSION = "touba-interaction-resume-request-v0.1";
export const INTERACTION_SESSION_SCHEMA_VERSION = "touba-interaction-session-v0.1";
export const INTERACTION_SESSION_LIST_SCHEMA_VERSION = "touba-interaction-session-list-v0.1";
export const INTERACTION_ASSET_SCHEMA_VERSION = "touba-interaction-asset-v0.1";
export const INTERACTION_SESSION_STORE_SCHEMA_VERSION = "touba-interaction-sessions-v0.1";
export const INTERACTION_ASSET_STORE_SCHEMA_VERSION = "touba-interaction-assets-v0.1";
export const MAX_INTERACTION_ASSET_BYTES = 10 * 1024 * 1024;
export const MAX_INTERACTION_DISPLAY_TEXT_BYTES = 4096;

const MAX_SESSIONS = 100;
const MAX_MESSAGES_PER_SESSION = 100;
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
  const session = {
    schema_version: INTERACTION_SESSION_SCHEMA_VERSION,
    session_id: `interaction_${compactTimestamp(generatedAt)}_${randomBytes(4).toString("hex")}`,
    target_ref: request.target_ref,
    target_kind: request.target_kind,
    presentation: request.presentation,
    effect_policy: request.effect_policy,
    status: "active",
    created_at: generatedAt,
    updated_at: generatedAt,
    created_by: request.requested_by,
    messages: [],
  };
  store.sessions.push(session);
  store.sessions = store.sessions
    .sort((left, right) => left.updated_at.localeCompare(right.updated_at))
    .slice(-MAX_SESSIONS);
  saveJsonAtomic(sessionsPath, store);
  return session;
}

export function listInteractionSessions(sessionsPath) {
  const store = loadInteractionSessionStore(sessionsPath);
  return {
    schema_version: INTERACTION_SESSION_LIST_SCHEMA_VERSION,
    sessions: [...store.sessions]
      .sort((left, right) => right.updated_at.localeCompare(left.updated_at))
      .map((session) => ({
        session_id: session.session_id,
        target_ref: session.target_ref,
        target_kind: session.target_kind,
        presentation: session.presentation,
        status: session.status,
        updated_at: session.updated_at,
        message_count: session.messages.length,
      })),
  };
}

export function getInteractionSession({ sessionId, sessionsPath }) {
  const session = loadInteractionSessionStore(sessionsPath).sessions
    .find((candidate) => candidate.session_id === sessionId);
  if (session === undefined) {
    throw interactionError("ToubaServeInteractionSessionNotFound", "interaction session is unknown");
  }
  return session;
}

export function findInteractionMessageResult({ messageId, sessionId, sessionsPath }) {
  const session = getInteractionSession({ sessionId, sessionsPath });
  return session.messages.find((message) => (
    message.role === "touba"
    && message.message_id === `${messageId}:result`
    && message.run_result !== undefined
  ))?.run_result;
}

export function appendInteractionRun({
  message,
  result,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath);
  const session = store.sessions.find((candidate) => candidate.session_id === sessionId);
  if (session === undefined) {
    throw interactionError("ToubaServeInteractionSessionNotFound", "interaction session is unknown");
  }
  if (session.messages.some((candidate) => candidate.message_id === message.message_id)) {
    throw interactionError("ToubaServeInteractionMessageReplayRejected", "interaction message_id was already consumed");
  }
  const displayText = boundedDisplayText(message.display_text);
  session.messages.push({
    message_id: message.message_id,
    role: "user",
    created_at: generatedAt,
    display_text: displayText,
    run_id: result.run_id,
    run_status: result.status,
  }, {
    message_id: `${message.message_id}:result`,
    role: "touba",
    created_at: result.completed_at ?? generatedAt,
    display_text: resultDisplayText(result),
    run_id: result.run_id,
    run_status: result.status,
    run_result: result,
  });
  session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
  session.status = sessionStatusForRun(result);
  session.updated_at = generatedAt;
  saveJsonAtomic(sessionsPath, store);
  return session;
}

export function appendInteractionResume({
  requestId,
  result,
  sessionId,
  sessionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadInteractionSessionStore(sessionsPath);
  const session = store.sessions.find((candidate) => candidate.session_id === sessionId);
  if (session === undefined) {
    throw interactionError("ToubaServeInteractionSessionNotFound", "interaction session is unknown");
  }
  const messageId = `resume:${requestId}:result`;
  if (session.messages.some((candidate) => candidate.message_id === messageId)) {
    return session;
  }
  const priorResult = [...session.messages].reverse()
    .find((candidate) => candidate.role === "touba" && candidate.run_result !== undefined);
  if (
    session.status !== "awaiting_human"
    || priorResult?.run_id !== result.run_id
    || priorResult?.run_status !== "stopped"
  ) {
    throw interactionError(
      "ToubaServeInteractionResumeMismatch",
      "resumed run does not match the interaction session checkpoint",
    );
  }
  session.messages.push({
    message_id: messageId,
    role: "touba",
    created_at: result.completed_at ?? generatedAt,
    display_text: resultDisplayText(result),
    run_id: result.run_id,
    run_status: result.status,
    run_result: result,
  });
  session.messages = session.messages.slice(-MAX_MESSAGES_PER_SESSION);
  session.status = sessionStatusForRun(result);
  session.updated_at = generatedAt;
  saveJsonAtomic(sessionsPath, store);
  return session;
}

export function validateInteractionResume({
  requestId,
  runId,
  sessionId,
  sessionsPath,
}) {
  const session = getInteractionSession({ sessionId, sessionsPath });
  const messageId = `resume:${requestId}:result`;
  if (session.messages.some((candidate) => candidate.message_id === messageId)) {
    return { alreadyRecorded: true, session };
  }
  const priorResult = [...session.messages].reverse()
    .find((candidate) => candidate.role === "touba" && candidate.run_result !== undefined);
  if (
    session.status !== "awaiting_human"
    || priorResult?.run_id !== runId
    || priorResult?.run_status !== "stopped"
  ) {
    throw interactionError(
      "ToubaServeInteractionResumeMismatch",
      "checkpoint does not belong to the latest stopped run in this interaction session",
    );
  }
  return { alreadyRecorded: false, session };
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
  const store = loadInteractionAssetStore(assetsPath);
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
  saveJsonAtomic(assetsPath, store);
  return publicAsset(asset);
}

export function readInteractionAsset({ assetsDirectory, assetsPath, handle }) {
  const asset = loadInteractionAssetStore(assetsPath).assets
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

function loadInteractionSessionStore(path) {
  if (!existsSync(path)) {
    return { schema_version: INTERACTION_SESSION_STORE_SCHEMA_VERSION, sessions: [] };
  }
  const store = readStore(path, "ToubaServeInteractionSessionStoreInvalid");
  if (
    store?.schema_version !== INTERACTION_SESSION_STORE_SCHEMA_VERSION
    || !Array.isArray(store.sessions)
  ) {
    throw interactionError(
      "ToubaServeInteractionSessionStoreInvalid",
      `interaction session store must use ${INTERACTION_SESSION_STORE_SCHEMA_VERSION}`,
    );
  }
  return store;
}

function loadInteractionAssetStore(path) {
  if (!existsSync(path)) {
    return { schema_version: INTERACTION_ASSET_STORE_SCHEMA_VERSION, assets: [] };
  }
  const store = readStore(path, "ToubaServeInteractionAssetStoreInvalid");
  if (
    store?.schema_version !== INTERACTION_ASSET_STORE_SCHEMA_VERSION
    || !Array.isArray(store.assets)
  ) {
    throw interactionError(
      "ToubaServeInteractionAssetStoreInvalid",
      `interaction asset store must use ${INTERACTION_ASSET_STORE_SCHEMA_VERSION}`,
    );
  }
  return store;
}

function readStore(path, code) {
  if (statSync(path).isDirectory()) throw interactionError(code, "interaction store path is a directory");
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    throw interactionError(code, `interaction store is not valid JSON: ${cause.message}`);
  }
}

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
  if (typeof result.result === "string") return boundedResultText(result.result);
  if (result.result === null || result.result === undefined) return "";
  return boundedResultText(JSON.stringify(result.result));
}

function boundedResultText(value) {
  const bytes = Buffer.from(String(value), "utf8");
  if (bytes.length <= MAX_INTERACTION_DISPLAY_TEXT_BYTES) return String(value);
  return `${bytes.subarray(0, MAX_INTERACTION_DISPLAY_TEXT_BYTES).toString("utf8")}...`;
}

function sessionStatusForRun(result) {
  if (result.status === "stopped") return "awaiting_human";
  if (result.status === "failure" || result.status === "cancelled") return "failed";
  return "active";
}

function compactTimestamp(value) {
  return String(value).replaceAll(/[^0-9]/gu, "").slice(0, 14);
}

function saveJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const tempPath = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, path);
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
