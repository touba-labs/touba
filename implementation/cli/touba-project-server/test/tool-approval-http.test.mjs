import assert from "node:assert/strict";
import test from "node:test";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { createToubaProjectServer } from "../src/serve.mjs";
import { toolReviewFixture, toolReviewRef } from "./fixtures/tool-review-project.mjs";

test("parallel imported tool requests retain their exact private context across restart and resume once each", async t => {
  const f = await toolReviewFixture({ parallel: true });
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  const options = { projectRoot: f.root, host: "127.0.0.1", port: 0, quiet: true,
    humanApprovalInitiator: "user:initiator", humanApprovalAuthority: ({ request, decision }) => ({
      request_id: request.request_id, run_id: request.run_id, decision, subject_ref: "user:reviewer", roles: ["reviewer"],
    }) };
  let core = createToubaProjectServer(options);
  const base = () => `http://127.0.0.1:${core.server.address().port}`;
  const send = async (path, body) => {
    const res = await fetch(base() + path, body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {});
    const data = await res.json(); assert.ok(res.ok, JSON.stringify(data)); return data;
  };
  const stop = async () => { const stopping = core.stop(); core.server.closeAllConnections(); await stopping; };
  try {
    await core.start();
    let result = await send('/runs/sandbox', { schema_version: 'touba-sandbox-run-request-v1', execution_kind: 'entrypoint',
      target_ref: 'strategy:client.main/Run', inputs: { request: 'private-parallel-input' }, effect_policy: 'allow_declared_external_effects',
      requested_by: { kind: 'studio', id: 'fixture' }, reason: 'Isolated parallel review' });
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
      await stop(); core = createToubaProjectServer(options); await core.start();
      assert.deepEqual(await send('/approvals/pending/current'), pending);
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
