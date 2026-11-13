import assert from 'node:assert/strict';
import test from 'node:test';
import { readApprovalDossier } from '../src/approval-dossier.mjs';
import { canonicalDigest } from '../../../runtime/touba-runtime/src/execution-checkpoints.mjs';

function fixture() {
  const now = Date.now(), policy = { role: 'controller', timeout_ms: 60000, distinct_from: 'initiator_and_previous' };
  const operation = { tool_ref: 'tool:example/Pay', run_id: 'run:one', caller_ref: 'strategy:example/Run', agent_ref: null,
    arguments: { amount: 25, reason: 'PRIVATE-SYNTHETIC-DOSSIER' } };
  const saved = { request_id: 'human:one', run_id: 'run:one', approval_ref: 'approval:one',
    created_at: new Date(now).toISOString(), deadline_at: new Date(now + 60000).toISOString(), policy,
    review_context: { operation } };
  const record = { request_id: 'approval:public', run_id: 'run:one', approval_ref: saved.approval_ref, status: 'pending',
    checkpoint: { approval_state: { initiator: 'user:initiator', requests: { [saved.approval_ref]: saved }, receipts: [] } },
    human_wait: { deadline_at: saved.deadline_at, resolution: null, request: { tool_operation: { operation_digest: canonicalDigest(operation) } } } };
  const identity = { active: true, allowed: true, user: { id: 'reviewer' }, session_id: 'session:one', permissions: ['decisions.act'] };
  const authority = async ({ purpose, request, viewer }) => {
    assert.equal(purpose, 'review'); assert.equal(viewer.subject_ref, 'user:reviewer');
    assert.ok(!JSON.stringify(request).includes('PRIVATE-SYNTHETIC-DOSSIER'));
    assert.equal(request.review_context, undefined);
    return { purpose, request_id: request.request_id, run_id: request.run_id, subject_ref: viewer.subject_ref, roles: ['controller'] };
  };
  return { record, identity, authority, revalidate: async () => record, now: () => now };
}

test('private review binds exact arguments and verifies the signer without deciding or altering a wait', async () => {
  const f = fixture(), before = structuredClone(f.record);
  const result = await readApprovalDossier(f);
  assert.equal(result.arguments.reason, 'PRIVATE-SYNTHETIC-DOSSIER');
  assert.equal(result.operation_digest, f.record.human_wait.request.tool_operation.operation_digest);
  assert.deepEqual(f.record, before);
});

test('private review denies weak identity, services, other roles and other viewers', async () => {
  for (const mutate of [
    f => { f.identity.active = false; }, f => { f.identity.allowed = false; },
    f => { f.identity.permissions = ['decisions.read']; }, f => { f.identity.permissions = ['*']; },
    f => { f.identity.principal = { kind: 'service' }; },
  ]) {
    const f = fixture(); mutate(f); f.authority = () => assert.fail('denial precedes attestation');
    await assert.rejects(readApprovalDossier(f), { code: 'ToubaServeDecisionIdentityUnauthorized' });
  }
  for (const [mutation, code] of [
    [value => ({ ...value, roles: ['owner'] }), 'HumanApprovalRoleRequired'],
    [value => ({ ...value, subject_ref: 'user:someone-else' }), 'HumanApprovalAttestationInvalid'],
    [value => ({ ...value, purpose: 'approve' }), 'HumanApprovalAttestationInvalid'],
    [value => ({ ...value, request_id: 'other-request' }), 'HumanApprovalAttestationInvalid'],
  ]) {
    const f = fixture(), authority = f.authority;
    f.authority = async args => mutation(await authority(args));
    await assert.rejects(readApprovalDossier(f), { code });
  }
});

test('source separation and cross-run exclusions also apply to the private dossier', async () => {
  const f = fixture(); f.record.checkpoint.approval_state.initiator = 'user:reviewer';
  await assert.rejects(readApprovalDossier(f), { code: 'HumanApprovalSignerConflict' });
  const excluded = fixture(), saved = excluded.record.checkpoint.approval_state.requests['approval:one'];
  saved.policy.exclude_signers = 'previous-invoice-reviewers';
  await assert.rejects(readApprovalDossier(excluded), { code: 'HumanApprovalExclusionEvidenceRequired' });
  const authority = excluded.authority;
  excluded.authority = async args => ({ ...await authority(args), excluded_signers: { rule: saved.policy.exclude_signers, subject_refs: ['user:reviewer'] } });
  await assert.rejects(readApprovalDossier(excluded), { code: 'HumanApprovalSignerConflict' });
});

test('closed, expired, changed and oversized dossiers fail without disclosing argument values', async () => {
  for (const [mutate, code] of [
    [f => { f.record.status = 'completed'; }, 'ToubaServeDecisionRequestNotFound'],
    [f => { f.now = () => Date.now() + 120000; }, 'ToubaServeDecisionRequestExpired'],
    [f => { f.record.checkpoint.approval_state.requests['approval:one'].review_context.operation.arguments.amount++; }, 'ToubaServePendingHumanRequestInvalid'],
    [f => { f.revalidate = async () => ({ ...f.record, status: 'resolution_claimed' }); }, 'ToubaServeDecisionRequestNotFound'],
    [f => { f.revalidate = async () => { throw Object.assign(new Error('revoked'), { code: 'ToubaServeDecisionIdentityUnauthorized' }); }; }, 'ToubaServeDecisionIdentityUnauthorized'],
    [f => { f.authority = undefined; }, 'ToubaServeApprovalDossierUnavailable'],
    [f => { f.authority = () => new Promise(() => {}); f.timeoutMs = 5; }, 'HumanApprovalAuthorityUnavailable'],
    [f => { const op = f.record.checkpoint.approval_state.requests['approval:one'].review_context.operation; op.arguments.reason = 'x'.repeat(32769); f.record.human_wait.request.tool_operation.operation_digest = canonicalDigest(op); }, 'ToubaServeApprovalDossierTooLarge'],
  ]) {
    const f = fixture(); mutate(f);
    await assert.rejects(readApprovalDossier(f), error => error.code === code && !JSON.stringify(error).includes('PRIVATE-SYNTHETIC-DOSSIER'));
  }
});
