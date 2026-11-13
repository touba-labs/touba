import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';
import { approvalHostTemplate } from '../../../contracts/product-surfaces/approval-host-template.mjs';
import { assertApprovalSigner } from '../../../runtime/touba-runtime/src/human-approval-policy.mjs';

const identity = { schema_version: 'touba-product-identity-v1', users: [{ user_ref: 'user:qa' }] };
const request = { request_id: 'request:one', run_id: 'run:one', policy: { role: 'legal' } };
const payload = { request, decision: 'approved', hostDecision: { request_id: request.request_id,
  run_id: request.run_id, user_ref: 'user:qa', decided_by: 'user:qa', decision: 'approve' } };

for (const language of ['javascript', 'python']) test(`${language} generated approval host binds the server decision and reads only explicit business roles`, async () => {
  const root = await mkdtemp(join(tmpdir(), 'touba-approval-template-'));
  try {
    await mkdir(join(root, 'host')); await mkdir(join(root, 'config'));
    const files = approvalHostTemplate(language, identity);
    await writeFile(join(root, files.host.path), files.host.content);
    await writeFile(join(root, files.directory.path), files.directory.content);
    const module = language === 'javascript' ? await import(pathToFileURL(join(root, files.host.path))) : null;
    const call = async (method, value) => {
      if (module) return module[method === 'review' ? 'attestHumanApprovalReview' : 'attestHumanApproval'](value);
      const code = "import importlib.util,json,sys\nspec=importlib.util.spec_from_file_location('host',sys.argv[1]); m=importlib.util.module_from_spec(spec); spec.loader.exec_module(m)\np=json.load(sys.stdin)\nf=m.attest_human_approval_review if sys.argv[2]=='review' else m.attest_human_approval\nprint(json.dumps(f(p)))";
      return JSON.parse(execFileSync('python3', ['-c', code, join(root, files.host.path), method], { input: JSON.stringify(value), encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }));
    };
    await assert.rejects(call('decision', payload), 'default directory grants no role');
    const directory = JSON.parse(files.directory.content);
    directory.users['user:qa'] = { enabled: true, roles: ['legal'] };
    await writeFile(join(root, files.directory.path), JSON.stringify(directory));
    const receipt = await call('decision', payload);
    assert.deepEqual(receipt, { request_id: request.request_id, run_id: request.run_id, decision: 'approved', subject_ref: 'user:qa', roles: ['legal'] });
    assert.equal(assertApprovalSigner({ receipts: [], initiator: null }, request, receipt).subject, 'user:qa');
    assert.throws(() => assertApprovalSigner({ receipts: [], initiator: null }, { ...request, policy: { role: 'finance' } }, receipt), { code: 'HumanApprovalRoleRequired' });
    for (const change of [{ request_id: 'other' }, { run_id: 'other' }, { decided_by: 'user:other' }, { decision: 'reject' }, { user_ref: 'user:unknown', decided_by: 'user:unknown' }]) {
      await assert.rejects(call('decision', { ...payload, hostDecision: { ...payload.hostDecision, ...change } }));
    }
    await assert.rejects(call('decision', { ...payload, hostDecision: undefined }));
    const review = { purpose: 'review', request, viewer: { subject_ref: 'user:qa', session_id: 'authenticated-session' } };
    assert.deepEqual(await call('review', review), { purpose: 'review', request_id: request.request_id, run_id: request.run_id, subject_ref: 'user:qa', roles: ['legal'] });
    await assert.rejects(call('review', { ...review, viewer: { subject_ref: 'user:qa' } }));
    await assert.rejects(call('review', { ...review, request: { ...request, policy: { exclude_signers: 'application-rule' } } }));
    directory.users['user:qa'].enabled = false;
    await writeFile(join(root, files.directory.path), JSON.stringify(directory));
    await assert.rejects(call('decision', payload), 'revocation takes effect without caching');
  } finally { await rm(root, { recursive: true, force: true }); }
});
