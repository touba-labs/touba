import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { eventVisibleToIdentity, registerEventClient, writeSse } from "../src/event-clients.mjs";

test("live and replay delivery cannot cross decision, deployment or authoring permissions", () => {
  const reader = { active: true, permissions: ["projects.read", "executions.read"] };
  for (const kind of ["project.changed", "artifact.changed", "validation.changed", "sandbox_run.completed", "interaction.run.started", "trigger.fire.completed"]) {
    assert.equal(eventVisibleToIdentity(kind, reader), true, kind);
  }
  for (const kind of ["human_decision.accepted", "human_wait.terminalized", "mobile_pairing.issued", "change.proposed", "element.proposed", "deployment.activated", "future.unknown"]) {
    assert.equal(eventVisibleToIdentity(kind, reader), false, kind);
  }
  assert.equal(eventVisibleToIdentity("human_decision.accepted", { active: true, permissions: ["decisions.read"] }), true);
  assert.equal(eventVisibleToIdentity("change.applied", { active: true, permissions: ["governance.read"] }), true);
  assert.equal(eventVisibleToIdentity("package.installed", reader), false);
  assert.equal(eventVisibleToIdentity("package.installed", { active: true, permissions: ["governance.read"] }), true);
  assert.equal(eventVisibleToIdentity("deployment.published", { active: true, permissions: ["deployments.read"] }), true);
  assert.equal(eventVisibleToIdentity("project.changed", { active: false, permissions: ["*"] }), false);
  assert.equal(eventVisibleToIdentity("project.changed", undefined), false);
  assert.equal(eventVisibleToIdentity('approval.dossier.viewed', { active: true, permissions: ['decisions.read', 'decisions.act'] }), false);
  assert.equal(eventVisibleToIdentity('approval.dossier.viewed', { active: true, permissions: ['audit.read'] }), true);
});

function response() {
  return Object.assign(new EventEmitter(), { writableLength: 0, frames: [], write(frame) { this.frames.push(frame); },
    end() { this.writableEnded = true; this.emit("close"); }, destroy() { this.destroyed = true; this.emit("close"); } });
}
test("SSE bounds queued bytes and releases a closed client", () => {
  const client = response(); let closed = 0;
  registerEventClient(client, { active: true, permissions: ["executions.read"] }, { onClose: () => { closed++; } });
  writeSse(client, "human_decision.accepted", { secret: "must-not-deliver" });
  assert.deepEqual(client.frames, []);
  writeSse(client, "sandbox_run.completed", { event_id: "event:1", sequence: 1 });
  assert.equal(client.frames.length, 1);
  client.writableLength = 1024 * 1024;
  writeSse(client, "sandbox_run.completed", {});
  assert.equal(client.destroyed, true); assert.equal(closed, 1);
});
test("SSE lifetime is bounded to force an authorization check at reconnect", async () => {
  const client = response(); registerEventClient(client, null, { lifetimeMs: 10, heartbeatMs: 5 });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(client.writableEnded, true);
  assert.ok(client.frames.every(frame => frame === ": heartbeat\n\n"));
});
