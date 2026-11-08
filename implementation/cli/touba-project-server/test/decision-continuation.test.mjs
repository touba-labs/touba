import assert from "node:assert/strict";
import test from "node:test";
import { createServer } from "node:http";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { assertDecisionContinuation, isDecisionContinuationRoute } from "../src/decision-continuation.mjs";
import { createToubaProjectServer } from "../src/serve.mjs";
import { toolReviewFixture } from "./fixtures/tool-review-project.mjs";

test("review continuation cannot be used for execution recovery or another signer's decision", () => {
  const identity = { active: true, user: { id: "reviewer" }, permissions: ["decisions.act"] };
  const checkpoint = { record_kind: "human", request_id: "request", run_id: "run",
    human_wait: { resolution: { kind: "decision", decision: { request_id: "request", run_id: "run",
      user_ref: "user:reviewer", decided_by: "user:reviewer" } } } };
  assert.doesNotThrow(() => assertDecisionContinuation(identity, { request_id: "request" }, checkpoint));
  for (const [who, body, record] of [
    [identity, { operation_id: "effect", request_id: "request" }, checkpoint],
    [identity, { request_id: "other" }, checkpoint],
    [identity, { request_id: "request" }, null],
    [{ ...identity, active: false }, { request_id: "request" }, checkpoint],
    [{ ...identity, permissions: [] }, { request_id: "request" }, checkpoint],
    [{ ...identity, user: { id: "other" } }, { request_id: "request" }, checkpoint],
  ]) assert.throws(() => assertDecisionContinuation(who, body, record), { code: "ToubaServeDecisionContinuationDenied" });
  assert.equal(isDecisionContinuationRoute("POST", "/runs/sandbox"), false);
  assert.equal(isDecisionContinuationRoute("POST", "/interactions/sessions/id/messages"), false);
  assert.equal(isDecisionContinuationRoute("POST", "/interactions/sessions/id/resume"), true);
});

for (const transport of ["sandbox", "interaction"]) test(`HTTP reviewer continues two exact checkpoints through ${transport} with no execution grant`, async t => {
  const f = await toolReviewFixture();
  t.after(() => rmSync(f.directory, { recursive: true, force: true }));
  let revoked = false;
  const identity = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const { access_token: token } = JSON.parse(body);
    const permissions = ["projects.read", "executions.read", "decisions.read",
      ...(token === "operator" ? ["executions.run"] : !revoked && ["reviewer", "other"].includes(token) ? ["decisions.act"] : [])];
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ active: true, user: { id: token }, project_root: f.root, permissions }));
  });
  await new Promise(resolve => identity.listen(0, "127.0.0.1", resolve));
  t.after(() => { identity.closeAllConnections(); identity.close(); });
  const core = createToubaProjectServer({ projectRoot: f.root, port: 0, quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${identity.address().port}`,
    identityServiceToken: "isolated-service-token-long-enough-for-this-test",
    humanApprovalInitiator: "user:operator",
    humanApprovalAuthority: ({ request, decision }) => ({ request_id: request.request_id, run_id: request.run_id,
      decision, subject_ref: "user:reviewer", roles: ["reviewer"] }) });
  await core.start(); t.after(async () => { core.server.closeAllConnections(); await core.stop(); });
  const send = async (token, path, body) => {
    const res = await fetch(`http://127.0.0.1:${core.server.address().port}${path}`, {
      method: body ? "POST" : "GET", headers: { "content-type": "application/json", "x-touba-identity-token": token },
      ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: res.status, data: await res.json() };
  };
  const run = { schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint",
    target_ref: "strategy:client.main/Run", inputs: { request: "review" }, effect_policy: "allow_declared_external_effects",
    requested_by: { kind: "studio", id: "fixture" }, reason: "Scoped reviewer qualification" };
  assert.equal((await send("reviewer", "/runs/sandbox", run)).status, 403);
  assert.equal((await send("reader", "/runs/sandbox/resume", { request_id: "unknown" })).status, 403);
  assert.equal((await send("reviewer", "/runs/sandbox/resume", { operation_id: "unknown" })).status, 403);
  let resumePath = "/runs/sandbox/resume", sessionId, operationId;
  const stabilize = async () => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const { data } = await send("reviewer", `/interactions/sessions/${sessionId}/operations/${operationId}`);
      if (["awaiting_human", "succeeded", "failed", "interrupted"].includes(data.status)) return data;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.fail("interaction did not stabilize");
  };
  if (transport === "sandbox") {
    const paused = await send("operator", "/runs/sandbox", run);
    assert.equal(paused.status, 200, JSON.stringify(paused));
    assert.equal(paused.data.reason, "human_approval_pending");
  } else {
    const { status, data: session } = await send("operator", "/interactions/sessions", {
      schema_version: "touba-interaction-session-create-v1", target_ref: run.target_ref,
      target_kind: "strategy", presentation: "workflow", effect_policy: run.effect_policy, requested_by: run.requested_by,
    });
    assert.equal(status, 201, JSON.stringify(session));
    sessionId = session.session_id;
    resumePath = `/interactions/sessions/${sessionId}/resume`;
    const message = { schema_version: "touba-interaction-message-request-v1", message_id: "review-test",
      display_text: "Review", inputs: run.inputs, requested_by: run.requested_by };
    assert.equal((await send("reviewer", `/interactions/sessions/${sessionId}/messages`, message)).status, 403);
    const accepted = await send("operator", `/interactions/sessions/${sessionId}/messages`, message);
    assert.equal(accepted.status, 202, JSON.stringify(accepted));
    operationId = accepted.data.operation_id;
    assert.equal((await stabilize()).status, "awaiting_human");
  }
  assert.equal(existsSync(f.ledgerPath), false);
  for (let i = 0; i < 2; i++) {
    const { data: pending } = await send("reviewer", "/approvals/pending/current");
    const continuation = { request_id: pending.request_id, ...(transport === "interaction" ? {
      schema_version: "touba-interaction-resume-request-v1",
    } : {}) };
    assert.equal((await send("reviewer", resumePath, continuation)).status, 403);
    const decision = { schema_version: "touba-approval-decision-v1", request_id: pending.request_id,
      run_id: pending.run_id, trace_ref: pending.trace_ref, user_ref: "user:reviewer", device_ref: "device:fixture",
      decision: "approve", decided_by: "user:reviewer", decided_at: new Date().toISOString(), comment: null, client_ref: "fixture" };
    assert.equal((await send("operator", "/decisions", decision)).status, 403);
    const accepted = await send("reviewer", "/decisions", decision);
    assert.equal(accepted.status, 202, JSON.stringify(accepted));
    assert.equal((await send("other", resumePath, continuation)).status, 403);
    revoked = true;
    assert.equal((await send("reviewer", resumePath, continuation)).status, 403);
    revoked = false;
    const resumed = await send("reviewer", resumePath, continuation);
    assert.equal(resumed.status, transport === "sandbox" ? 200 : 202, JSON.stringify(resumed));
    if (transport === "sandbox") assert.equal(resumed.data.status, i === 0 ? "stopped" : "success", JSON.stringify(resumed));
    else {
      operationId = resumed.data.operation_id;
      const completed = await stabilize();
      assert.equal(completed.status, i === 0 ? "awaiting_human" : "succeeded", JSON.stringify(completed));
    }
    assert.equal(readFileSync(f.ledgerPath, "utf8").trim().split("\n").length, i + 1);
    await send("reviewer", resumePath, continuation);
    assert.equal(readFileSync(f.ledgerPath, "utf8").trim().split("\n").length, i + 1, "no replayed effect");
  }
});
