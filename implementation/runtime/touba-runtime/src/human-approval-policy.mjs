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
/** @param {any} value */
const validComment = value => value == null || (typeof value === "string" && [...value].length <= 4096);

/** @param {any} policy */
export function validateApprovalPolicy(policy) {
  if (policy === undefined || policy === null) return null;
  if (!exactKeys(policy, ["role", "timeout_ms", "distinct_from", "exclude_signers"]) || !Object.keys(policy).length
    || (policy.role !== undefined && (!identity(policy.role) || Buffer.byteLength(policy.role, "utf8") > 128))
    || (policy.exclude_signers !== undefined && (!identity(policy.exclude_signers) || Buffer.byteLength(policy.exclude_signers, "utf8") > 128))
    || (policy.timeout_ms !== undefined && (!Number.isSafeInteger(policy.timeout_ms) || policy.timeout_ms < 1 || policy.timeout_ms > MAX_TIMEOUT_MS))
    || (policy.distinct_from !== undefined && !["initiator", "previous", "initiator_and_previous"].includes(policy.distinct_from))) {
    fail("InvalidHumanApprovalPolicy", "approval constraints must be valid static source literals");
  }
  return structuredClone(policy);
}

/** @param {any} state */
export function validateApprovalState(state) {
  const invalid = () => fail("InvalidHumanApprovalCheckpoint", "approval authority state is incomplete or invalid");
  if (!exactKeys(state, ["initiator", "requests", "receipts", "requires_attestation"]) || (state.initiator !== null && !identity(state.initiator))
    || (state.requires_attestation !== undefined && typeof state.requires_attestation !== "boolean")
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
  const previousSigners = new Set();
  for (const receipt of state.receipts) {
    if (!exactKeys(receipt, ["request_id", "run_id", "approval_ref", "decision", "subject_ref", "attested_roles", "excluded_signers", "accepted_at", "comment"])
      || !identity(receipt.request_id) || consumed.has(receipt.request_id) || !identity(receipt.run_id)
      || !identity(receipt.approval_ref) || !["approved", "rejected", "expired", "cancelled"].includes(receipt.decision)
      || (receipt.subject_ref !== null && !identity(receipt.subject_ref)) || !instant(receipt.accepted_at)
      || !Array.isArray(receipt.attested_roles) || receipt.attested_roles.length > 128 || !receipt.attested_roles.every(identity)
      || !validComment(receipt.comment)
      || new Set(receipt.attested_roles).size !== receipt.attested_roles.length
      || (receipt.subject_ref === null && receipt.attested_roles?.length)) invalid();
    if (receipt.excluded_signers !== undefined && (!validExclusions(receipt.excluded_signers)
      || receipt.excluded_signers.subject_refs.includes(receipt.subject_ref))) invalid();
    consumed.add(receipt.request_id);
    const request = Object.values(state.requests).find(/** @param {any} item */ item => item.request_id === receipt.request_id);
    if (request && (request.run_id !== receipt.run_id || request.approval_ref !== receipt.approval_ref
      || Date.parse(receipt.accepted_at) < Date.parse(request.created_at)
      || (["approved", "rejected"].includes(receipt.decision)
        && ((request.deadline_at !== null && Date.parse(receipt.accepted_at) >= Date.parse(request.deadline_at))
          || ((state.requires_attestation || request.policy?.role || request.policy?.distinct_from || request.policy?.exclude_signers) && receipt.subject_ref === null)
          || (request.policy?.role && !receipt.attested_roles.includes(request.policy.role))
          || (request.policy?.distinct_from?.includes("initiator") && receipt.subject_ref === state.initiator)
          || (request.policy?.distinct_from?.includes("previous") && previousSigners.has(receipt.subject_ref))
          || (request.policy?.exclude_signers && receipt.excluded_signers?.rule !== request.policy.exclude_signers))))) invalid();
    if (receipt.decision === "approved" && receipt.subject_ref !== null) previousSigners.add(receipt.subject_ref);
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
  const enabled = policies.some(Boolean) || typeof options.humanApprovalAuthority === "function" || checkpoint?.approval_state !== undefined
    || options.humanApprovalInitiator !== undefined || document.execution_graphs?.some(/** @param {any} graph */ graph => graph.nodes?.some(/** @param {any} node */ node => node.kind === "human_approval"));
  const trackSigners = policies.some(policy => policy?.distinct_from?.includes("previous"));
  if (options.humanApprovalAuthority != null && typeof options.humanApprovalAuthority !== "function") fail("InvalidRuntimeOption", "humanApprovalAuthority must be a trusted host function");
  const resolver = typeof options.humanApprovalInitiator === "function" ? options.humanApprovalInitiator : null;
  if (options.humanApprovalInitiator !== undefined && !resolver && !identity(options.humanApprovalInitiator)) fail("InvalidRuntimeOption", "humanApprovalInitiator must be an opaque host identity or trusted resolver");
  const state = structuredClone(checkpoint?.approval_state ?? { initiator: resolver ? null : options.humanApprovalInitiator ?? null, requests: {}, receipts: [] });
  if (typeof options.humanApprovalAuthority === "function") state.requires_attestation = true;
  if (enabled && checkpoint && !checkpoint.approval_state) fail("HumanApprovalCheckpointIncompatible", "source approval constraints require their persisted authority state");
  validateApprovalState(state);
  const nodes = (document.execution_graphs ?? []).flatMap(/** @param {any} graph */ graph => graph.nodes ?? []);
  for (const request of Object.values(state.requests)) {
    const ref = request.approval_ref.split(":parallel:")[0];
    const node = nodes.find(/** @param {any} node */ node => node.approval_ref === ref);
    if (node && !isDeepStrictEqual(node.approval_policy ?? null, request.policy)) fail("HumanApprovalCheckpointIncompatible", "persisted approval constraints differ from AIR");
  }
  if (checkpoint && !resolver && options.humanApprovalInitiator !== undefined && options.humanApprovalInitiator !== state.initiator) fail("HumanApprovalIdentityMismatch", "run initiator cannot change on resume");
  const timeout = options.humanApprovalAuthorityTimeoutMs ?? 5000;
  if (!Number.isSafeInteger(timeout) || timeout < 1 || timeout > 60000) fail("InvalidRuntimeOption", "human approval authority timeout must be 1..60000 ms");
  return { enabled, trackSigners, state: structuredClone(state), authority: options.humanApprovalAuthority ?? null,
    initiatorResolver: checkpoint ? null : resolver,
    timeout, evidence: options.humanApprovalDecisions ?? options.humanApprovals ?? {} };
}

/** @param {any} runtime @param {any} request */
export async function initializeApprovalInitiator(runtime, request) {
  if (!runtime.initiatorResolver) return;
  let timer;
  const controller = new AbortController();
  try {
    const initiator = await Promise.race([
      Promise.resolve().then(() => runtime.initiatorResolver({ ...structuredClone(request), signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error("timeout")); }, runtime.timeout); }),
    ]);
    if (!identity(initiator)) fail("HumanApprovalIdentityMismatch", "host initiator resolver must return an opaque identity");
    runtime.state.initiator = initiator;
    runtime.initiatorResolver = null;
  } catch (error) {
    if (error instanceof RuntimeFailure) throw error;
    fail("HumanApprovalAuthorityUnavailable", "host could not attest the run initiator");
  } finally { clearTimeout(timer); }
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
  const evidence = runtime.evidence instanceof Map ? runtime.evidence.get(request.approval_ref) : runtime.evidence[request.approval_ref];
  const comment = object(evidence) ? evidence.comment ?? null : null;
  if (!validComment(comment)) fail("InvalidHumanApprovalDecision", "approval comment must be text of at most 4096 characters");
  /** @type {string | null} */
  let subject = null;
  let roles = [];
  let exclusions;
  if (["approved", "rejected"].includes(decision) && (runtime.state.requires_attestation || runtime.authority || policy?.role || policy?.distinct_from || policy?.exclude_signers || runtime.trackSigners)) {
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
    if (!exactKeys(attestation, ["request_id", "run_id", "decision", "subject_ref", "roles", "excluded_signers"])
      || attestation.request_id !== request.request_id || attestation.run_id !== request.run_id || attestation.decision !== decision
      || !identity(attestation.subject_ref) || !Array.isArray(attestation.roles) || attestation.roles.length > 128 || !attestation.roles.every(identity)) {
      fail("HumanApprovalAttestationInvalid", "host attestation must bind the exact request, run and decision");
    }
    subject = attestation.subject_ref;
    roles = [...new Set(attestation.roles)].sort();
    if (policy?.exclude_signers) {
      if (!validExclusions(attestation.excluded_signers) || attestation.excluded_signers.rule !== policy.exclude_signers) {
        fail("HumanApprovalExclusionEvidenceRequired", "host must attest the source-declared signer exclusion rule for this request");
      }
      exclusions = structuredClone(attestation.excluded_signers);
      if (exclusions.subject_refs.includes(subject)) fail("HumanApprovalSignerConflict", "signer is excluded by the source-declared cross-run rule");
    } else if (attestation.excluded_signers !== undefined) {
      fail("HumanApprovalAttestationInvalid", "signer exclusions require a source-declared rule");
    }
    if (policy?.role && !attestation.roles.includes(policy.role)) fail("HumanApprovalRoleRequired", "signer does not currently hold the source-required role");
    if (policy?.distinct_from?.includes("initiator") && subject === runtime.state.initiator) fail("HumanApprovalSignerConflict", "initiator cannot sign this approval");
    if (policy?.distinct_from?.includes("previous") && runtime.state.receipts.some(/** @param {any} item */ item => item.decision === "approved" && item.subject_ref === subject)) fail("HumanApprovalSignerConflict", "a previous signer cannot sign this approval");
    // An adapter response cannot extend the deadline while it is being verified.
    if (approvalDeadlineDue(request)) { decision = "expired"; subject = null; roles = []; exclusions = undefined; }
  }
  if (runtime.state.receipts.length + Object.keys(runtime.state.requests).length >= MAX_RECORDS) fail("HumanApprovalStateLimitExceeded", "approval receipt limit reached before accepting the decision");
  runtime.state.receipts.push({ request_id: request.request_id, run_id: request.run_id, approval_ref: request.approval_ref,
    decision, comment, subject_ref: subject, attested_roles: roles, ...(exclusions ? { excluded_signers: exclusions } : {}), accepted_at: new Date().toISOString() });
  return decision;
}

/** Informative source value; it is never accepted as an authority proof.
 * @param {any} runtime @param {any} request */
export function approvalResult(runtime, request) {
  const receipt = runtime.state.receipts.find(/** @param {any} item */ item => item.request_id === request?.request_id);
  if (!receipt) fail("HumanApprovalReceiptMissing", "accepted source decision requires its runtime receipt");
  return { decision: receipt.decision, request_id: receipt.request_id, run_id: receipt.run_id,
    comment: receipt.comment == null ? { present: false } : { present: true, value: receipt.comment },
    accepted_at: receipt.accepted_at, subject_ref: receipt.subject_ref === null ? { present: false } : { present: true, value: receipt.subject_ref },
    attested_roles: [...(receipt.attested_roles ?? [])] };
}

/** @param {any} value */
function validExclusions(value) {
  return exactKeys(value, ["rule", "subject_refs"]) && identity(value.rule)
    && Array.isArray(value.subject_refs) && value.subject_refs.length <= 10000
    && value.subject_refs.every(identity) && new Set(value.subject_refs).size === value.subject_refs.length;
}
