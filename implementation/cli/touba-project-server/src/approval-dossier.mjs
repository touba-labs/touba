import { canonicalDigest } from '../../../runtime/touba-runtime/src/execution-checkpoints.mjs';
import { assertApprovalSigner, validateApprovalState } from '../../../runtime/touba-runtime/src/human-approval-policy.mjs';

const fail = (code, message) => { throw Object.assign(new Error(message), { code }); };
// This surface never calls the signing adapter, claims a wait or dispatches a tool.
export async function readApprovalDossier({ record, identity, authority, timeoutMs = 5000, revalidate, now = Date.now }) {
  if (!identity?.active || !identity.allowed || identity.principal || typeof identity.user?.id !== 'string' || !identity.user.id.trim()
    || !identity.permissions?.includes('decisions.act')) fail('ToubaServeDecisionIdentityUnauthorized', 'a strongly authenticated reviewer is required');
  const checkPending = value => {
    if (!value || value.status !== 'pending' || value.human_wait?.resolution !== null
      || !value.human_wait?.request?.tool_operation) fail('ToubaServeDecisionRequestNotFound', 'pending tool approval not found');
    const deadline = Date.parse(value.human_wait.deadline_at);
    if (!Number.isFinite(deadline) || deadline <= now()) fail('ToubaServeDecisionRequestExpired', 'approval has expired');
  };
  checkPending(record);
  const state = record.checkpoint?.approval_state;
  validateApprovalState(state);
  const saved = state.requests[record.approval_ref], operation = saved?.review_context?.operation;
  if (!operation || operation.run_id !== record.run_id || canonicalDigest(operation) !== record.human_wait.request.tool_operation.operation_digest) {
    fail('ToubaServePendingHumanRequestInvalid', 'dossier differs from the bound operation');
  }
  if (state.receipts.some(item => item.request_id === saved.request_id)) fail('ToubaServeDecisionRequestNotFound', 'approval is already decided');
  if (typeof authority !== 'function') fail('ToubaServeApprovalDossierUnavailable', 'configure an explicit private-review authority');
  const subject = identity.user.id.startsWith('user:') ? identity.user.id : `user:${identity.user.id}`;
  const { review_context: _context, ...request } = saved;
  const controller = new AbortController(); let timer, attestation;
  try {
    attestation = await Promise.race([
      Promise.resolve().then(() => authority({ purpose: 'review', request: structuredClone(request),
        viewer: { subject_ref: subject, session_id: identity.session_id }, signal: controller.signal })),
      new Promise((_, reject) => { timer = setTimeout(() => { controller.abort(); reject(new Error('timeout')); }, timeoutMs); }),
    ]);
  } catch { fail('HumanApprovalAuthorityUnavailable', 'private review authority unavailable'); }
  finally { clearTimeout(timer); }
  if (!attestation || Object.keys(attestation).some(key => !['purpose', 'request_id', 'run_id', 'subject_ref', 'roles', 'excluded_signers'].includes(key))
    || attestation.purpose !== 'review' || attestation.request_id !== saved.request_id || attestation.run_id !== saved.run_id
    || attestation.subject_ref !== subject) fail('HumanApprovalAttestationInvalid', 'private review attestation must bind the exact request, run and viewer');
  assertApprovalSigner(state, saved, attestation);
  const current = await revalidate();
  checkPending(current);
  if (canonicalDigest(current.checkpoint) !== canonicalDigest(record.checkpoint)) fail('ToubaServePendingHumanRequestInvalid', 'approval changed during authorization');
  const data = JSON.stringify(operation.arguments);
  if (typeof data !== 'string' || Buffer.byteLength(data) > 32768) fail('ToubaServeApprovalDossierTooLarge', 'private dossier exceeds 32 KiB; use an explicitly selected review context');
  return { schema_version: 'touba-approval-dossier-v1', request_id: record.request_id, run_id: record.run_id,
    operation_digest: canonicalDigest(operation), viewed_at: new Date(now()).toISOString(), arguments: JSON.parse(data) };
}
