import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from 'node:http';
import { existsSync, readFileSync, rmSync } from "node:fs";
import { bindRunInitiator, createToubaProjectServer } from "../src/serve.mjs";
import { toolReviewFixture, toolReviewRef } from "./fixtures/tool-review-project.mjs";

test('private dossier HTTP surface requires an explicit human grant, signer role and current session', async t => {
  const f = await toolReviewFixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  let permissions = ['executions.run', 'executions.read', 'decisions.read', 'decisions.act'];
  let active = true, role = 'reviewer', revokeDuringReview = false, attestations = 0;
  let subject = 'initiator';
  const identity = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ active, user: { id: subject }, permissions, project_root: f.root, session_id: 'qa-session' }));
  });
  await new Promise(resolve => identity.listen(0, '127.0.0.1', resolve));
  t.after(async () => { identity.closeAllConnections(); await new Promise(resolve => identity.close(resolve)); });
  const core = createToubaProjectServer({ projectRoot: f.root, host: '127.0.0.1', port: 0, quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${identity.address().port}`, identityServiceToken: 'synthetic-service-token-for-private-review',
    humanApprovalReviewAuthority: ({ purpose, request, viewer }) => {
      attestations++;
      assert.equal(request.review_context, undefined);
      if (revokeDuringReview) permissions = ['*'];
      return { purpose, request_id: request.request_id, run_id: request.run_id, subject_ref: viewer.subject_ref, roles: [role] };
    },
  });
  try {
    await core.start();
    const send = (path, body) => fetch(`http://127.0.0.1:${core.server.address().port}${path}`, {
      headers: { 'x-touba-identity-token': 'synthetic-access', 'content-type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
    });
    const run = await send('/runs/sandbox', { schema_version: 'touba-sandbox-run-request-v1', execution_kind: 'entrypoint',
      target_ref: 'strategy:client.main/Run', inputs: { request: 'PRIVATE-HTTP-REVIEW' }, effect_policy: 'allow_declared_external_effects',
      requested_by: { kind: 'studio', id: 'fixture' }, reason: 'Isolated private review' });
    assert.equal(run.status, 200, await run.text());
    const pending = await (await send('/approvals/pending/current')).json();
    assert.ok(pending.request_id); assert.doesNotMatch(JSON.stringify(pending), /PRIVATE-HTTP-REVIEW/);
    const path = `/approvals/dossier/${encodeURIComponent(pending.request_id)}`;
    const selfReview = await send(path);
    assert.equal(selfReview.status, 403);
    assert.match(await selfReview.text(), /HumanApprovalSignerConflict/);
    subject = 'reviewer'; attestations = 0;
    permissions = ['decisions.read'];
    assert.equal((await send(path)).status, 403); assert.equal(attestations, 0);
    permissions = ['*'];
    assert.equal((await send(path)).status, 403); assert.equal(attestations, 0);
    permissions = ['decisions.act']; role = 'owner';
    const denied = await send(path); assert.equal(denied.status, 403); assert.doesNotMatch(await denied.text(), /PRIVATE-HTTP-REVIEW/);
    role = 'reviewer'; revokeDuringReview = true;
    assert.equal((await send(path)).status, 403, 'wildcard does not retain private review after explicit grant loss');
    permissions = ['decisions.act']; revokeDuringReview = false;
    const granted = await send(path);
    assert.equal(granted.status, 200, await granted.clone().text());
    assert.equal(granted.headers.get('cache-control'), 'no-store, private');
    assert.match(JSON.stringify((await granted.json()).arguments), /PRIVATE-HTTP-REVIEW/);
    assert.equal(existsSync(f.ledgerPath), false, 'reading a dossier never dispatches');
    active = false; assert.equal((await send(path)).status, 401);
  } finally {
    const stopping = core.stop(); core.server.closeAllConnections(); await stopping;
  }
});

for (const language of ['javascript', 'python']) test(`${language} authenticated initiator survives restart and other signer resumes each protected call once`, async t => {
  const f = await toolReviewFixture({ parallel: true, language });
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  let subject = 'initiator';
  const identity = createServer((_req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ active: true, user: { id: subject }, permissions: ['executions.run', 'executions.read', 'decisions.read', 'decisions.act'], project_root: f.root, session_id: `session-${subject}` }));
  });
  await new Promise(resolve => identity.listen(0, '127.0.0.1', resolve));
  t.after(async () => { identity.closeAllConnections(); await new Promise(resolve => identity.close(resolve)); });
  const options = { projectRoot: f.root, host: "127.0.0.1", port: 0, quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${identity.address().port}`, identityServiceToken: 'synthetic-service-token-for-isolated-initiator',
    humanApprovalAuthority: ({ request, decision, hostDecision }) => ({
      request_id: request.request_id, run_id: request.run_id, decision, subject_ref: hostDecision.user_ref, roles: ["reviewer"],
    }) };
  let core = createToubaProjectServer(options);
  const base = () => `http://127.0.0.1:${core.server.address().port}`;
  const send = async (path, body) => {
    const res = await fetch(base() + path, { headers: { 'Content-Type': 'application/json', 'x-touba-identity-token': 'synthetic-token' }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
    const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data;
  };
  const stop = async () => { const stopping = core.stop(); core.server.closeAllConnections(); await stopping; };
  try {
    await core.start();
    let result = await send('/runs/sandbox', { schema_version: 'touba-sandbox-run-request-v1', execution_kind: 'entrypoint',
      target_ref: 'strategy:client.main/Run', inputs: { request: 'private-parallel-input' }, effect_policy: 'allow_declared_external_effects',
      requested_by: { kind: 'user', id: 'reviewer' }, reason: 'Isolated parallel review with untrusted actor input' });
    assert.equal(result.reason, 'human_approval_pending', JSON.stringify(result));
    assert.equal(existsSync(f.ledgerPath), false);
    const ids = new Set();
    for (let i = 0; i < 2; i++) {
      const pending = await send('/approvals/pending/current');
      assert.equal(pending.capability_ref, toolReviewRef);
      assert.equal(pending.tool_operation.tool_ref, toolReviewRef);
      assert.equal(pending.tool_operation.package.version, '0.1.0');
      assert.doesNotMatch(JSON.stringify(pending), /private-parallel-input/);
      assert.ok(!ids.has(pending.request_id)); ids.add(pending.request_id);
      if (i === 0) {
        const response = await fetch(base() + '/decisions', { method: 'POST',
          headers: { 'content-type': 'application/json', 'x-touba-identity-token': 'synthetic-token' },
          body: JSON.stringify({ schema_version: 'touba-approval-decision-v1', request_id: pending.request_id, run_id: pending.run_id,
            trace_ref: pending.trace_ref, user_ref: 'user:initiator', device_ref: 'device:fixture', decision: 'approve',
            decided_by: 'user:initiator', decided_at: new Date().toISOString(), comment: null, client_ref: 'fixture' }) });
        assert.equal(response.status, 403);
        assert.match(await response.text(), /HumanApprovalSignerConflict/);
        assert.equal(existsSync(f.ledgerPath), false);
        assert.deepEqual(await send('/approvals/pending/current'), pending, 'self-approval must not claim the wait');
      }
      await stop(); core = createToubaProjectServer(options); await core.start();
      assert.deepEqual(await send('/approvals/pending/current'), pending);
      subject = 'reviewer';
      const decision = { schema_version: 'touba-approval-decision-v1', request_id: pending.request_id, run_id: pending.run_id,
        trace_ref: pending.trace_ref, user_ref: 'user:reviewer', device_ref: 'device:fixture', decision: 'approve',
        decided_by: 'user:reviewer', decided_at: new Date().toISOString(), comment: null, client_ref: 'fixture' };
      await send('/decisions', decision);
      result = await send('/runs/sandbox/resume', { request_id: pending.request_id });
      assert.ok(['success', 'stopped'].includes(result.status), JSON.stringify(result));
    }
    assert.equal(result.status, 'success', JSON.stringify(result));
    assert.equal(readFileSync(f.ledgerPath, 'utf8').trim().split('\n').length, 2);
  } finally { await stop(); }
});

test('only attested human subjects become run initiators; local host resolvers remain supported', async () => {
  const resolver = () => 'host:operator';
  assert.equal(bindRunInitiator(null, resolver), resolver);
  assert.equal(await bindRunInitiator({ active: true, user: { id: 'alice' } }, () => 'user:spoof')(), 'user:alice');
  assert.equal(bindRunInitiator({ active: true, principal: { kind: 'service', id: 'job' } }, 'user:spoof'), undefined);
  assert.throws(() => bindRunInitiator({ active: false, user: { id: 'alice' } }), { code: 'ToubaServeIdentityUnauthorized' });
});
