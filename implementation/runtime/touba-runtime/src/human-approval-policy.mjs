// Source constraints are enforced here; identities are attested only by the host.
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { RuntimeFailure } from "./runtime-errors.mjs";

const MAX_RECORDS = 10000;
const MAX_TIMEOUT_MS = 2592000000;
/** @param {string} code @param {string} message @returns {never} */
const fail = (code, message) => { throw new RuntimeFailure(message, {}, code); };
/** @param {any} value */
const object = value => value !== null && typeof value === "object" && !Array.isArray(value);
/** @param {any} value */
const identity = value => typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= 256 && !/[\x00-\x1f\x7f]/.test(value);
/** @param {any} value */
const instant = value => typeof value === "string" && Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
/** @param {any} value @param {string[]} keys */
const exactKeys = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));

/** @param {any} policy */
export function validateApprovalPolicy(policy) {
  if (policy === undefined || policy === null) return null;
  if (!exactKeys(policy, ["role", "timeout_ms", "distinct_from"]) || !Object.keys(policy).length
    || (policy.role !== undefined && (!identity(policy.role) || Buffer.byteLength(policy.role, "utf8") > 128))
    || (policy.timeout_ms !== undefined && (!Number.isSafeInteger(policy.timeout_ms) || policy.timeout_ms < 1 || policy.timeout_ms > MAX_TIMEOUT_MS))
    || (policy.distinct_from !== undefined && !["initiator", "previous", "initiator_and_previous"].includes(policy.distinct_from))) {
    fail("InvalidHumanApprovalPolicy", "approval constraints must be valid static source literals");
  }
  return structuredClone(policy);
}

/** @param {any} state */
export function validateApprovalState(state) {
  const invalid = () => fail("InvalidHumanApprovalCheckpoint", "approval authority state is incomplete or invalid");
  if (!exactKeys(state, ["initiator", "requests", "receipts"]) || (state.initiator !== null && !identity(state.initiator))
    || !object(state.requests) || !Array.isArray(state.receipts)
    || Object.keys(state.requests).length + state.receipts.length > MAX_RECORDS) invalid();
  const ids = new Set();
  for (const [ref, request] of Object.entries(state.requests)) {
    if (!identity(ref) || !exactKeys(request, ["request_id", "run_id", "approval_ref", "created_at", "deadline_at", "policy"])
      || !identity(request.request_id) || ids.has(request.request_id) || !identity(request.run_id)
      || request.approval_ref !== ref || !instant(request.created_at)) invalid();
    ids.add(request.request_id);
    const policy = validateApprovalPolicy(request.policy);
    if (policy?.timeout_ms !== undefined) {
      if (!instant(request.deadline_at) || Date.parse(request.deadline_at) !== Date.parse(request.created_at) + policy.timeout_ms) invalid();
    } else if (request.deadline_at !== null) invalid();
  }
  const consumed = new Set();
  for (const receipt of state.receipts) {
    if (!exactKeys(receipt, ["request_id", "run_id", "approval_ref", "decision", "subject_ref", "accepted_at"])
      || !identity(receipt.request_id) || consumed.has(receipt.request_id) || !identity(receipt.run_id)
      || !identity(receipt.approval_ref) || !["approved", "rejected", "expired", "cancelled"].includes(receipt.decision)
      || (receipt.subject_ref !== null && !identity(receipt.subject_ref)) || !instant(receipt.accepted_at)) invalid();
    consumed.add(receipt.request_id);
    const request = Object.values(state.requests).find(/** @param {any} item */ item => item.request_id === receipt.request_id);
    if (request && (request.run_id !== receipt.run_id || request.approval_ref !== receipt.approval_ref
      || Date.parse(receipt.accepted_at) < Date.parse(request.created_at)
      || (["approved", "rejected"].includes(receipt.decision)
        && ((request.deadline_at !== null && Date.parse(receipt.accepted_at) >= Date.parse(request.deadline_at))
          || ((request.policy?.role || request.policy?.distinct_from) && receipt.subject_ref === null))))) invalid();
  }
}

/** @param {any} document @param {any} options @param {any} checkpoint */
export function createApprovalRuntime(document, options, checkpoint) {
  /** @type {any[]} */
  const policies = (document.execution_graphs ?? []).flatMap(/** @param {any} graph */ graph => graph.nodes ?? [])
    .filter(/** @param {any} node */ node => node.approval_policy !== undefined).map(/** @param {any} node */ node => {
      if (node.kind !== "human_approval") fail("InvalidHumanApprovalPolicy", "approval policy belongs only to human approval nodes");
      return validateApprovalPolicy(node.approval_policy);
    });
  const enabled = policies.some(Boolean);
  const trackSigners = policies.some(policy => policy?.distinct_from?.includes("previous"));
  if (options.humanApprovalAuthority != null && typeof options.humanApprovalAuthority !== "function") fail("InvalidRuntimeOption", "humanApprovalAuthority must be a trusted host function");
  if (options.humanApprovalInitiator !== undefined && !identity(options.humanApprovalInitiator)) fail("InvalidRuntimeOption", "humanApprovalInitiator must be an opaque host identity");
  const state = checkpoint?.approval_state ?? { initiator: options.humanApprovalInitiator ?? null, requests: {}, receipts: [] };
  if (enabled && checkpoint && !checkpoint.approval_state) fail("HumanApprovalCheckpointIncompatible", "source approval constraints require their persisted authority state");
  validateApprovalState(state);
  const nodes = (document.execution_graphs ?? []).flatMap(/** @param {any} graph */ graph => graph.nodes ?? []);
  for (const request of Object.values(state.requests)) {
    const ref = request.approval_ref.split(":parallel:")[0];
    const node = nodes.find(/** @param {any} node */ node => node.approval_ref === ref);
    if (node && !isDeepStrictEqual(node.approval_policy ?? null, request.policy)) fail("HumanApprovalCheckpointIncompatible", "persisted approval constraints differ from AIR");
  }
  if (checkpoint && options.humanApprovalInitiator !== undefined && options.humanApprovalInitiator !== state.initiator) fail("HumanApprovalIdentityMismatch", "run initiator cannot change on resume");
  const timeout = options.humanApprovalAuthorityTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) fail("InvalidRuntimeOption", "human approval authority timeout must be 1..60000 ms");
  return { enabled, trackSigners, state: structuredClone(state), authority: options.humanApprovalAuthority ?? null,
    timeout, evidence: options.humanApprovalDecisions ?? options.humanApprovals ?? {} };
}

/** @param {any} runtime */
export function approvalStateSnapshot(runtime) {
  return runtime.enabled ? structuredClone(runtime.state) : undefined;
}

/** @param {any} runtime @param {string} runId @param {string} approvalRef @param {any} policy */
export function approvalRequest(runtime, runId, approvalRef, policy) {
  if (!runtime.enabled) return null;
  policy = validateApprovalPolicy(policy);
  if (policy?.distinct_from?.includes("initiator") && runtime.state.initiator === null) fail("HumanApprovalInitiatorRequired", "source separation requires a trusted host initiator");
  const old = runtime.state.requests[approvalRef];
  if (old) {
    if (old.run_id !== runId || !isDeepStrictEqual(old.policy, policy)) fail("HumanApprovalCheckpointIncompatible", "saved approval request differs from source constraints or run");
    return structuredClone(old);
  }
  if (Object.keys(runtime.state.requests).length + runtime.state.receipts.length >= MAX_RECORDS) fail("HumanApprovalStateLimitExceeded", "approval state limit reached before creating another request");
  const now = Date.now();
  const request = { request_id: `human:${randomUUID()}`, run_id: runId, approval_ref: approvalRef,
    created_at: new Date(now).toISOString(), deadline_at: policy?.timeout_ms ? new Date(now + policy.timeout_ms).toISOString() : null, policy };
  runtime.state.requests[approvalRef] = request;
  return structuredClone(request);
}

/** @param {any} request */
export function approvalDeadlineDue(request) {
  return request?.deadline_at != null && Date.now() >= Date.parse(request.deadline_at);
}

/** @param {any} runtime @param {string} approvalRef */
export function completeApprovalOccurrence(runtime, approvalRef) {
  delete runtime.state.requests[approvalRef];
}

/** @param {any} runtime @param {any} request @param {string | undefined} suppliedDecision @param {{replay?: boolean}} [options] */
export async function authorizeApprovalDecision(runtime, request, suppliedDecision, { replay = false } = {}) {
  if (!request) return suppliedDecision;
  const receipt = runtime.state.receipts.find(/** @param {any} item */ item => item.request_id === request.request_id);
  if (receipt) {
    if (!replay || receipt.decision !== suppliedDecision) fail("HumanApprovalDecisionAlreadyConsumed", "approval evidence authorizes one occurrence only");
    return receipt.decision;
  }
  let decision = approvalDeadlineDue(request) ? "expired" : suppliedDecision;
  if (decision === undefined) return undefined;
  if (!["approved", "rejected", "expired", "cancelled"].includes(decision)) fail("InvalidHumanApprovalDecision", "unknown human approval decision");
  if (decision === "expired" && request.deadline_at !== null && !approvalDeadlineDue(request)) fail("HumanApprovalNotExpired", "host cannot expire a source deadline before it is due");
  const policy = request.policy;
  /** @type {string | null} */
  let subject = null;
  if (["approved", "rejected"].includes(decision) && (policy?.role || policy?.distinct_from || runtime.trackSigners)) {
    if (!runtime.authority) fail("HumanApprovalAuthorityRequired", "source constraints require a trusted host authority adapter");
    const record = runtime.evidence instanceof Map ? runtime.evidence.get(request.approval_ref) : runtime.evidence[request.approval_ref];
    const evidenceRef = object(record) ? record.evidence_ref : undefined;
    if (!identity(evidenceRef)) fail("HumanApprovalEvidenceRequired", "constrained decision requires an opaque host evidence reference");
    let timer;
    let attestation;
    const controller = new AbortController();
    try {
      attestation = await Promise.race([
        Promise.resolve().then(() => runtime.authority({ request: structuredClone(request), decision, evidenceRef, signal: controller.signal })),
        new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new RuntimeFailure("human approval authority timed out", {}, "HumanApprovalAuthorityUnavailable")); }, runtime.timeout); }),
      ]);
    } catch (error) {
      if (error instanceof RuntimeFailure && error.code === "HumanApprovalAuthorityUnavailable") throw error;
      fail("HumanApprovalAuthorityUnavailable", "host could not attest this decision");
    } finally { clearTimeout(timer); }
    if (!exactKeys(attestation, ["request_id", "run_id", "decision", "subject_ref", "roles"])
      || attestation.request_id !== request.request_id || attestation.run_id !== request.run_id || attestation.decision !== decision
      || !identity(attestation.subject_ref) || !Array.isArray(attestation.roles) || attestation.roles.length > 128 || !attestation.roles.every(identity)) {
      fail("HumanApprovalAttestationInvalid", "host attestation must bind the exact request, run and decision");
    }
    subject = attestation.subject_ref;
    if (policy?.role && !attestation.roles.includes(policy.role)) fail("HumanApprovalRoleRequired", "signer does not currently hold the source-required role");
    if (policy?.distinct_from?.includes("initiator") && subject === runtime.state.initiator) fail("HumanApprovalSignerConflict", "initiator cannot sign this approval");
    if (policy?.distinct_from?.includes("previous") && runtime.state.receipts.some(/** @param {any} item */ item => item.decision === "approved" && item.subject_ref === subject)) fail("HumanApprovalSignerConflict", "a previous signer cannot sign this approval");
    // An adapter response cannot extend the deadline while it is being verified.
    if (approvalDeadlineDue(request)) { decision = "expired"; subject = null; }
  }
  if (runtime.state.receipts.length + Object.keys(runtime.state.requests).length >= MAX_RECORDS) fail("HumanApprovalStateLimitExceeded", "approval receipt limit reached before accepting the decision");
  runtime.state.receipts.push({ request_id: request.request_id, run_id: request.run_id, approval_ref: request.approval_ref,
    decision, subject_ref: subject, accepted_at: new Date().toISOString() });
  return decision;
}
