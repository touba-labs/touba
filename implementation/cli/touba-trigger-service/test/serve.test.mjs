import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";
import {
  buildTriggerStatusContract,
  createTriggerService,
} from "../src/serve.mjs";

const servePath = new URL("../src/serve.mjs", import.meta.url).pathname;
const implementationDir = new URL("../../..", import.meta.url).pathname;
const triggerStatusSchemaPath = join(
  implementationDir,
  "contracts/product-surfaces/schemas/touba-trigger-status-v1.schema.json",
);

test("serves a request trigger through HTTP, durable queue, state and trace", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-"));
  try {
    const fixture = writeFixture(workspace);
    const child = spawnService(fixture, ["--max-events", "1"]);
    const started = await waitForStart(child);

    const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-event-id": "evt-webhook-001",
      },
      body: JSON.stringify({ payload: "raw-secret-payload" }),
    });
    assert.equal(response.status, 202);
    const queued = await response.json();
    assert.equal(queued.status, "queued");
    assert.equal(queued.trigger_ref, "trigger:examples.webhook/WebhookRun");

    const exit = await once(child, "exit");
    assert.equal(exit[0], 0);

    const queueText = readFileSync(fixture.queuePath, "utf8");
    assert.equal(queueText.includes("raw-secret-payload"), false);
    const queue = JSON.parse(queueText);
    assert.equal(queue.trigger_queue_schema_version, "touba-trigger-queue-v0.1");
    assert.equal(queue.entries.length, 1);
    assert.equal(queue.entries[0].status, "succeeded");
    assert.equal(queue.entries[0].http.payload_bytes > 0, true);
    assert.equal(typeof queue.entries[0].http.payload_sha256, "string");

    const stateText = readFileSync(fixture.statePath, "utf8");
    assert.equal(stateText.includes("raw-secret-payload"), false);
    const state = JSON.parse(stateText);
    const triggerState = state.triggers["trigger:examples.webhook/WebhookRun"];
    assert.equal(triggerState.accepted_count, 1);
    assert.deepEqual(triggerState.consumed_event_ids, ["evt-webhook-001"]);
    assert.match(triggerState.events[0].day_key, /^\d{4}-\d{2}-\d{2}$/u);

    assert.equal(existsSync(queue.entries[0].trace_path), true);
    const traceText = readFileSync(queue.entries[0].trace_path, "utf8");
    assert.equal(traceText.includes("raw-secret-payload"), false);
    const trace = JSON.parse(traceText);
    assert.equal(eventOf(trace, "trigger_event_accepted").payload.trigger_ref, "trigger:examples.webhook/WebhookRun");
    assert.equal(eventOf(trace, "trigger_execution_completed").payload.status, "success");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("assigns a fresh event and queue identity to each delivery without an event id header", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-fresh-events-"));
  let service;
  try {
    const fixture = writeFixture(workspace, { effectHandler: "delayed-success" });
    service = await createTriggerService({
      airPath: fixture.airPath,
      manifestPath: fixture.manifestPath,
      statePath: fixture.statePath,
      queuePath: fixture.queuePath,
      traceDir: fixture.traceDir,
      port: 0,
      maxEvents: 2,
      quiet: true,
    });
    await service.start();
    const closed = once(service.server, "close");
    const address = service.server.address();
    const url = `http://127.0.0.1:${address.port}/webhook/run`;
    const responses = await Promise.all([
      fetch(url, { method: "POST", body: "identical" }),
      fetch(url, { method: "POST", body: "identical" }),
    ]);
    assert.deepEqual(responses.map((response) => response.status), [202, 202]);
    const deliveries = await Promise.all(responses.map((response) => response.json()));
    assert.equal(new Set(deliveries.map((delivery) => delivery.event_id)).size, 2);
    assert.equal(new Set(deliveries.map((delivery) => delivery.queue_id)).size, 2);
    await closed;

    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    assert.equal(queue.entries.length, 2);
    assert.equal(queue.entries.every((entry) => entry.status === "succeeded"), true);
    assert.equal(effectInvocationCount(fixture.effectLogPath), 2);
  } finally {
    if (service?.server.listening) {
      await closeServer(service.server);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses an invalid event id header before creating a queue entry", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-invalid-event-id-"));
  let service;
  try {
    const fixture = writeFixture(workspace);
    service = await createTriggerService({
      airPath: fixture.airPath,
      manifestPath: fixture.manifestPath,
      statePath: fixture.statePath,
      queuePath: fixture.queuePath,
      port: 0,
      quiet: true,
    });
    await service.start();
    const address = service.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/run`, {
      method: "POST",
      headers: { "x-touba-event-id": "invalid/event/id" },
      body: "payload",
    });
    assert.equal(response.status, 400);
    assert.equal((await response.json()).code, "TriggerEventIdInvalid");
    assert.equal(existsSync(fixture.queuePath), false);
  } finally {
    if (service?.server.listening) {
      await closeServer(service.server);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses replayed webhook event ids before rerunning the target strategy", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-replay-"));
  let service;
  try {
    const fixture = writeFixture(workspace);
    await postOne(fixture, "evt-webhook-replay");

    service = await createTriggerService({
      airPath: fixture.airPath,
      manifestPath: fixture.manifestPath,
      statePath: fixture.statePath,
      queuePath: fixture.queuePath,
      traceDir: fixture.traceDir,
      port: 0,
      quiet: true,
    });
    await service.start();
    const address = service.server.address();
    const replay = await fetch(`http://127.0.0.1:${address.port}/webhook/run`, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-webhook-replay" },
      body: "trigger-body",
    });
    assert.equal(replay.status, 409);
    const refusal = await replay.json();
    assert.equal(refusal.code, "TriggerReplayRejected");

    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    assert.equal(queue.entries.length, 1);
    assert.equal(queue.entries[0].status, "succeeded");
    assert.equal(refusal.queue_id, queue.entries[0].queue_id);

    const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    const triggerState = state.triggers["trigger:examples.webhook/WebhookRun"];
    assert.equal(triggerState.accepted_count, 1);
    assert.equal(triggerState.refused_count, 1);
    assert.deepEqual(triggerState.consumed_event_ids, ["evt-webhook-replay"]);
  } finally {
    if (service?.server.listening) {
      await closeServer(service.server);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("serves touba-trigger-status-v1 without exposing webhook payloads", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-status-"));
  let service;
  try {
    const fixture = writeFixture(workspace);
    service = await createTriggerService({
      airPath: fixture.airPath,
      manifestPath: fixture.manifestPath,
      statePath: fixture.statePath,
      queuePath: fixture.queuePath,
      traceDir: fixture.traceDir,
      port: 0,
      quiet: true,
    });
    await service.start();
    const address = service.server.address();
    const baseUrl = `http://127.0.0.1:${address.port}`;

    const initialResponse = await fetch(`${baseUrl}/status`);
    assert.equal(initialResponse.status, 200);
    const initialStatus = await initialResponse.json();
    assert.deepEqual(validateObject(triggerStatusSchema(), initialStatus), []);
    assert.equal(initialStatus.triggers[0].queue.pending, 0);

    const response = await fetch(`${baseUrl}/webhook/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-event-id": "evt-webhook-status",
      },
      body: JSON.stringify({ payload: "raw-secret-payload" }),
    });
    assert.equal(response.status, 202);
    await waitForQueueEntryStatus(fixture.queuePath, "evt-webhook-status", "succeeded");

    const statusResponse = await fetch(`${baseUrl}/status`);
    assert.equal(statusResponse.status, 200);
    const status = await statusResponse.json();
    assert.deepEqual(validateObject(triggerStatusSchema(), status), []);
    assert.equal(JSON.stringify(status).includes("raw-secret-payload"), false);
    assert.equal(status.triggers[0].trigger_ref, "trigger:examples.webhook/WebhookRun");
    assert.equal(status.triggers[0].kind, "request");
    assert.equal(status.triggers[0].status, "enabled");
    assert.equal(status.triggers[0].state.accepted_count, 1);
    assert.equal(status.triggers[0].state.last_event_id, "evt-webhook-status");
    assert.equal(status.triggers[0].queue.pending, 0);
    assert.equal(status.triggers[0].queue.processing, 0);
    assert.equal(status.triggers[0].queue.dead_letter, 0);
  } finally {
    if (service?.server.listening) {
      await closeServer(service.server);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("projects request and schedule triggers to touba-trigger-status-v1", () => {
  const document = webhookAir();
  document.definitions.triggers.push({
    id: "trigger:examples.webhook/DailyRun",
    name: "DailyRun",
    event: {
      kind: "schedule",
      value: "every 1h",
      source_ref: sourceRef(),
    },
    target_ref: "strategy:examples.webhook/RunWebhook",
    target_kind: "strategy",
    arguments: [],
    limits: {
      max_runs_per_day: 1,
      timeout_ms: 30000,
      source_ref: sourceRef(),
    },
    source_ref: sourceRef(),
  });
  const manifest = webhookManifest();
  manifest.triggers["trigger:examples.webhook/DailyRun"] = {
    enabled: true,
    source: { kind: "schedule" },
    limits: {
      max_runs_per_day: 1,
      timeout_ms: 30000,
    },
  };
  const status = buildTriggerStatusContract({
    document,
    manifest,
    generatedAt: "2026-06-22T00:00:00Z",
    state: {
      triggers: {
        "trigger:examples.webhook/WebhookRun": {
          accepted_count: 2,
          refused_count: 1,
          last_event_id: "evt-webhook-last",
        },
        "trigger:examples.webhook/DailyRun": {
          accepted_count: 1,
          refused_count: 0,
          last_event_id: "evt-schedule-last",
        },
      },
    },
    queue: {
      entries: [
        { trigger_ref: "trigger:examples.webhook/WebhookRun", status: "queued" },
        { trigger_ref: "trigger:examples.webhook/WebhookRun", status: "processing" },
        { trigger_ref: "trigger:examples.webhook/WebhookRun", status: "dead_lettered" },
      ],
    },
  });

  assert.deepEqual(validateObject(triggerStatusSchema(), status), []);
  assert.equal(status.generated_at, "2026-06-22T00:00:00Z");
  assert.deepEqual(status.triggers.map((trigger) => trigger.kind), ["request", "schedule"]);
  assert.equal(status.triggers[0].queue.pending, 1);
  assert.equal(status.triggers[0].queue.processing, 1);
  assert.equal(status.triggers[0].queue.dead_letter, 1);
  assert.equal(status.triggers[1].limits.max_runs_per_day, 1);
  assert.equal(status.triggers[1].next_run_at, null);
});

test("requires an explicit auth token env var for non-loopback hosts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-auth-"));
  try {
    const fixture = writeFixture(workspace);
    await assert.rejects(
      () => createTriggerService({
        airPath: fixture.airPath,
        manifestPath: fixture.manifestPath,
        statePath: fixture.statePath,
        queuePath: fixture.queuePath,
        host: "0.0.0.0",
        port: 0,
      }),
      /non-loopback trigger service hosts require --auth-token-env/u,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("maps declared JSON webhook payload fields to durable trigger arguments", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-payload-"));
  try {
    const fixture = writeFixture(workspace, { payloadMapped: true });
    const child = spawnService(fixture, ["--max-events", "1"]);
    const started = await waitForStart(child);

    const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-event-id": "evt-webhook-payload",
      },
      body: JSON.stringify({
        message: "approved-message",
        ignored: "raw-secret-payload",
      }),
    });
    assert.equal(response.status, 202);
    const exit = await once(child, "exit");
    assert.equal(exit[0], 0);

    const queueText = readFileSync(fixture.queuePath, "utf8");
    assert.equal(queueText.includes("raw-secret-payload"), false);
    assert.equal(queueText.includes("approved-message"), true);
    const queue = JSON.parse(queueText);
    assert.deepEqual(queue.entries[0].arguments, { message: "approved-message" });
    assert.deepEqual(queue.entries[0].payload_contract.mapped_inputs, ["message"]);

    const traceText = readFileSync(queue.entries[0].trace_path, "utf8");
    assert.equal(traceText.includes("raw-secret-payload"), false);
    assert.equal(eventOf(JSON.parse(traceText), "trigger_event_received").payload.arguments_present, true);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires a valid webhook HMAC signature when configured", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-signature-"));
  try {
    const fixture = writeFixture(workspace);
    const body = Buffer.from("signed-body");
    const secret = "trigger-signing-secret";
    const child = spawnService(fixture, [
      "--max-events",
      "1",
      "--signature-secret-env",
      "TOUBA_TRIGGER_SIGNATURE_SECRET",
    ], {
      TOUBA_TRIGGER_SIGNATURE_SECRET: secret,
    });
    const started = await waitForStart(child);

    const rejected = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: {
        "x-touba-event-id": "evt-webhook-bad-signature",
        "x-touba-signature": "sha256=0000000000000000000000000000000000000000000000000000000000000000",
      },
      body,
    });
    assert.equal(rejected.status, 401);

    const signature = createHmac("sha256", secret).update(body).digest("hex");
    const accepted = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: {
        "x-touba-event-id": "evt-webhook-good-signature",
        "x-touba-signature": `sha256=${signature}`,
      },
      body,
    });
    assert.equal(accepted.status, 202);
    const exit = await once(child, "exit");
    assert.equal(exit[0], 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects mapped webhook payload arguments that do not match the target signature", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-payload-type-"));
  try {
    const fixture = writeFixture(workspace, { payloadMapped: true });
    const child = spawnService(fixture, ["--max-events", "1"]);
    const started = await waitForStart(child);

    const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-event-id": "evt-webhook-bad-type",
      },
      body: JSON.stringify({
        message: 42,
      }),
    });
    assert.equal(response.status, 202);
    const exit = await once(child, "exit");
    assert.equal(exit[0], 0);

    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    assert.equal(queue.entries[0].status, "failed");
    assert.equal(queue.entries[0].runtime_error_code, "TriggerPayloadInvalid");
    assert.equal(queue.entries[0].arguments.message, 42);

    const trace = JSON.parse(readFileSync(queue.entries[0].trace_path, "utf8"));
    const refusal = eventOf(trace, "trigger_event_refused");
    assert.equal(refusal.payload.runtime_error_code, "TriggerPayloadInvalid");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("recovers stale processing queue entries when the service starts", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-recover-"));
  try {
    const fixture = writeFixture(workspace);
    writeFileSync(fixture.queuePath, JSON.stringify({
      trigger_queue_schema_version: "touba-trigger-queue-v0.1",
      created_at: new Date().toISOString(),
      entries: [
        {
          queue_id: "queue:stale:001",
          trigger_ref: "trigger:examples.webhook/WebhookRun",
          event_id: "evt-webhook-stale",
          source_kind: "request",
          status: "processing",
          received_at: new Date(Date.now() - 600000).toISOString(),
          started_at: new Date(Date.now() - 600000).toISOString(),
          http: {
            method: "POST",
            path: "/webhook/run",
            payload_bytes: 0,
            payload_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
          },
        },
      ],
    }, null, 2), "utf8");
    const child = spawnService(fixture, ["--max-events", "1", "--processing-timeout-ms", "1"]);
    await waitForStart(child);
    const exit = await once(child, "exit");
    assert.equal(exit[0], 0);

    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    assert.equal(queue.entries[0].status, "succeeded");
    assert.equal(queue.entries[0].recovery_reason, "processing_timeout");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("deduplicates overlapping deliveries and refuses a divergent payload before dispatch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-concurrency-"));
  let service;
  try {
    const fixture = writeFixture(workspace, { effectHandler: "delayed-success" });
    service = await createTriggerService({
      airPath: fixture.airPath,
      manifestPath: fixture.manifestPath,
      statePath: fixture.statePath,
      queuePath: fixture.queuePath,
      traceDir: fixture.traceDir,
      port: 0,
      maxEvents: 1,
      quiet: true,
    });
    await service.start();
    const address = service.server.address();
    const url = `http://127.0.0.1:${address.port}/webhook/run`;
    const first = await fetch(url, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-overlapping-replay" },
      body: "first",
    });
    assert.equal(first.status, 202);
    const firstDelivery = await first.json();
    assert.match(firstDelivery.queue_id, /^queue:sha256:[a-f0-9]{64}$/u);
    await waitForQueueEntryStatus(fixture.queuePath, "evt-overlapping-replay", "processing");
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 10));
    const second = await fetch(url, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-overlapping-replay" },
      body: "first",
    });
    assert.equal(second.status, 202);
    const secondDelivery = await second.json();
    assert.equal(secondDelivery.deduplicated, true);
    assert.equal(secondDelivery.queue_status, "processing");
    assert.equal(secondDelivery.queue_id, firstDelivery.queue_id);

    const divergent = await fetch(url, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-overlapping-replay" },
      body: "different",
    });
    assert.equal(divergent.status, 409);
    assert.equal((await divergent.json()).code, "TriggerEventPayloadConflict");

    const entries = await waitForQueueEventTerminalCount(
      fixture.queuePath,
      "evt-overlapping-replay",
      1,
    );
    assert.equal(entries[0].queue_id, firstDelivery.queue_id);
    assert.equal(entries[0].status, "succeeded");
    assert.equal(effectInvocationCount(fixture.effectLogPath), 1);

    const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    const triggerState = state.triggers["trigger:examples.webhook/WebhookRun"];
    assert.equal(triggerState.accepted_count, 1);
    assert.equal(triggerState.refused_count, 0);
  } finally {
    if (service?.server.listening) {
      await closeServer(service.server);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("wakes a delayed retry without requiring another HTTP event", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-retry-wakeup-"));
  let service;
  try {
    const fixture = writeFixture(workspace, { effectHandler: "fail-once" });
    service = await createTriggerService({
      airPath: fixture.airPath,
      manifestPath: fixture.manifestPath,
      statePath: fixture.statePath,
      queuePath: fixture.queuePath,
      traceDir: fixture.traceDir,
      port: 0,
      maxEvents: 2,
      maxAttempts: 3,
      quiet: true,
    });
    await service.start();
    const address = service.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/run`, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-delayed-retry" },
      body: "retry",
    });
    assert.equal(response.status, 202);

    const entry = await waitForQueueEntryStatus(
      fixture.queuePath,
      "evt-delayed-retry",
      "succeeded",
      3000,
    );
    assert.equal(entry.attempt_count, 2);
    assert.equal(entry.next_attempt_at, undefined);
    assert.equal(effectInvocationCount(fixture.effectLogPath), 2);
    const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.triggers["trigger:examples.webhook/WebhookRun"].accepted_count, 1);
  } finally {
    if (service?.server.listening) {
      await closeServer(service.server);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("moves an exhausted retry to dead letter without inflating accepted event count", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-dead-letter-"));
  let service;
  try {
    const fixture = writeFixture(workspace, { effectHandler: "always-fail" });
    service = await createTriggerService({
      airPath: fixture.airPath,
      manifestPath: fixture.manifestPath,
      statePath: fixture.statePath,
      queuePath: fixture.queuePath,
      traceDir: fixture.traceDir,
      port: 0,
      maxAttempts: 2,
      maxEvents: 2,
      quiet: true,
    });
    await service.start();
    const address = service.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/run`, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-dead-letter" },
      body: "dead-letter",
    });
    assert.equal(response.status, 202);

    const entry = await waitForQueueEntryStatus(
      fixture.queuePath,
      "evt-dead-letter",
      "dead_lettered",
      3000,
    );
    assert.equal(entry.attempt_count, 2);
    assert.equal(typeof entry.dead_lettered_at, "string");
    assert.equal(effectInvocationCount(fixture.effectLogPath), 2);
    const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    assert.equal(state.triggers["trigger:examples.webhook/WebhookRun"].accepted_count, 1);
  } finally {
    if (service?.server.listening) {
      await closeServer(service.server);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("an immediate HTTP event preserves the earlier wake-up of a delayed queue entry", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-reprogram-wake-"));
  let service;
  try {
    const fixture = writeFixture(workspace);
    const delayedDueAt = Date.now() + 700;
    writeFileSync(fixture.queuePath, JSON.stringify({
      trigger_queue_schema_version: "touba-trigger-queue-v0.1",
      created_at: new Date().toISOString(),
      entries: [queuedEntry("queue:delayed:001", "evt-delayed-existing", {
        nextAttemptAt: new Date(delayedDueAt).toISOString(),
      })],
    }, null, 2), "utf8");
    service = await createTriggerService({
      airPath: fixture.airPath,
      manifestPath: fixture.manifestPath,
      statePath: fixture.statePath,
      queuePath: fixture.queuePath,
      traceDir: fixture.traceDir,
      port: 0,
      maxEvents: 2,
      quiet: true,
    });
    await service.start();
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 75));
    const address = service.server.address();
    const response = await fetch(`http://127.0.0.1:${address.port}/webhook/run`, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-immediate-new" },
      body: "immediate",
    });
    assert.equal(response.status, 202);
    await waitForQueueEntryStatus(fixture.queuePath, "evt-immediate-new", "succeeded");
    const delayed = await waitForQueueEntryStatus(
      fixture.queuePath,
      "evt-delayed-existing",
      "succeeded",
      2000,
    );
    assert.equal(delayed.attempt_count, 1);
    assert.equal(Date.parse(delayed.started_at) >= delayedDueAt - 25, true);
  } finally {
    if (service?.server.listening) {
      await closeServer(service.server);
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("cancels delayed queue wake-up when max-events stops the service", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-stop-wake-"));
  let child;
  try {
    const fixture = writeFixture(workspace);
    writeFileSync(fixture.queuePath, JSON.stringify({
      trigger_queue_schema_version: "touba-trigger-queue-v0.1",
      created_at: new Date().toISOString(),
      entries: [
        queuedEntry("queue:eligible:001", "evt-stop-first"),
        queuedEntry("queue:delayed:002", "evt-stop-delayed", {
          nextAttemptAt: new Date(Date.now() + 350).toISOString(),
        }),
      ],
    }, null, 2), "utf8");
    child = spawnService(fixture, ["--max-events", "1"]);
    await waitForStart(child);
    const exit = await once(child, "exit");
    assert.equal(exit[0], 0);
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 500));

    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    assert.equal(queue.entries[0].status, "succeeded");
    assert.equal(queue.entries[1].status, "queued");
    assert.equal(queue.entries[1].attempt_count, undefined);
  } finally {
    await terminateChild(child);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("marks the previous external outcome unknown when recovering a crash after effect dispatch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-crash-outcome-"));
  let crashed;
  let recovered;
  let handlerPid;
  try {
    const fixture = writeFixture(workspace, { effectHandler: "hang-after-first-effect" });
    crashed = spawnService(fixture, ["--max-events", "1"]);
    const started = await waitForStart(crashed);
    const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-crash-after-effect" },
      body: "crash",
    });
    assert.equal(response.status, 202);
    await waitForFile(fixture.handlerPidPath);
    await waitForQueueEntryStatus(fixture.queuePath, "evt-crash-after-effect", "processing");
    assert.equal(effectInvocationCount(fixture.effectLogPath), 1);

    const crashedExit = once(crashed, "exit");
    crashed.kill("SIGKILL");
    await crashedExit;
    handlerPid = Number(readFileSync(fixture.handlerPidPath, "utf8"));
    try {
      process.kill(handlerPid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") {
        throw error;
      }
    }
    handlerPid = undefined;

    recovered = spawnService(fixture, [
      "--max-events",
      "1",
      "--processing-timeout-ms",
      "1",
    ]);
    await waitForStart(recovered);
    const recoveredExit = await once(recovered, "exit");
    assert.equal(recoveredExit[0], 0);

    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    assert.equal(queue.entries[0].status, "succeeded");
    assert.equal(queue.entries[0].attempt_count, 2);
    assert.equal(queue.entries[0].recovery_effect_outcome, "unknown");
    assert.equal(effectInvocationCount(fixture.effectLogPath), 2);
  } finally {
    await terminateChild(crashed);
    await terminateChild(recovered);
    if (Number.isInteger(handlerPid)) {
      try {
        process.kill(handlerPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") {
          throw error;
        }
      }
    }
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses an external-write service before listen when its durable journal is absent", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-effect-journal-required-"));
  try {
    const fixture = writeFixture(workspace, {
      effectHandler: "http-effect",
      effectContractKind: "external_write",
      effectRetryMode: "idempotency_key",
      effectServiceUrl: "http://127.0.0.1:1/effects",
    });
    await assert.rejects(
      createTriggerService({
        airPath: fixture.airPath,
        manifestPath: fixture.manifestPath,
        statePath: fixture.statePath,
        queuePath: fixture.queuePath,
        port: 0,
        quiet: true,
      }),
      (error) => error?.code === "EffectJournalRequired",
    );

    const noneFixture = writeFixture(workspace, {
      effectHandler: "delayed-success",
      effectContractKind: "none",
    });
    const service = await createTriggerService({
      airPath: noneFixture.airPath,
      manifestPath: noneFixture.manifestPath,
      statePath: noneFixture.statePath,
      queuePath: noneFixture.queuePath,
      port: 0,
      quiet: true,
    });
    assert.equal(service.server.listening, false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("redelivery during a crash lease reuses one queue and effect identity, then resumes automatically", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-idempotent-crash-"));
  let crashed;
  let recovered;
  let handlerPid;
  const external = await startLocalEffectService({ holdFirstResponse: true });
  try {
    const fixture = writeFixture(workspace, {
      effectHandler: "http-effect",
      effectContractKind: "external_write",
      effectRetryMode: "idempotency_key",
      effectServiceUrl: external.url,
    });
    crashed = spawnService(fixture, [
      "--max-events",
      "1",
      "--processing-timeout-ms",
      "1200",
      "--effect-journal",
      fixture.effectJournalPath,
    ]);
    const started = await waitForStart(crashed);
    const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-idempotent-host-crash" },
      body: "create-once",
    });
    assert.equal(response.status, 202);
    const firstDelivery = await response.json();
    assert.match(firstDelivery.queue_id, /^queue:sha256:[a-f0-9]{64}$/u);
    await external.firstMutation;
    await waitForFile(fixture.handlerPidPath);
    await waitForQueueEntryStatus(fixture.queuePath, "evt-idempotent-host-crash", "processing");
    await waitForEffectJournalState(fixture.effectJournalPath, "dispatched");

    const crashedExit = once(crashed, "exit");
    crashed.kill("SIGKILL");
    await crashedExit;
    handlerPid = Number(readFileSync(fixture.handlerPidPath, "utf8"));
    try {
      process.kill(handlerPid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
    handlerPid = undefined;

    recovered = spawnService(fixture, [
      "--max-events",
      "1",
      "--processing-timeout-ms",
      "1200",
      "--effect-journal",
      fixture.effectJournalPath,
    ]);
    const recoveredStart = await waitForStart(recovered);
    const deliveryUrl = `http://${recoveredStart.host}:${recoveredStart.port}/webhook/run`;
    const redelivery = await fetch(deliveryUrl, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-idempotent-host-crash" },
      body: "create-once",
    });
    assert.equal(redelivery.status, 202);
    const repeatedDelivery = await redelivery.json();
    assert.equal(repeatedDelivery.deduplicated, true);
    assert.equal(repeatedDelivery.queue_status, "processing");
    assert.equal(repeatedDelivery.queue_id, firstDelivery.queue_id);

    const divergent = await fetch(deliveryUrl, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-idempotent-host-crash" },
      body: "create-something-else",
    });
    assert.equal(divergent.status, 409);
    assert.equal((await divergent.json()).code, "TriggerEventPayloadConflict");
    assert.equal(external.requestCount(), 1);
    assert.equal(external.mutationCount(), 1);
    assert.equal(JSON.parse(readFileSync(fixture.queuePath, "utf8")).entries.length, 1);

    const recoveredExit = await once(recovered, "exit");
    assert.equal(recoveredExit[0], 0);

    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    assert.equal(queue.entries.length, 1);
    assert.equal(queue.entries[0].queue_id, firstDelivery.queue_id);
    assert.equal(queue.entries[0].status, "succeeded");
    assert.equal(queue.entries[0].attempt_count, 2);
    const journal = JSON.parse(readFileSync(fixture.effectJournalPath, "utf8"));
    const entries = Object.values(journal.entries);
    assert.equal(entries.length, 1);
    assert.equal(entries[0].state, "applied");
    assert.equal(entries[0].attempt_count, 2);
    assert.match(entries[0].effect_id, /^effect:sha256:[a-f0-9]{64}$/u);
    assert.equal(external.requestCount(), 2);
    assert.equal(external.mutationCount(), 1);
    assert.equal(new Set(external.effectIds()).size, 1);
  } finally {
    await terminateChild(crashed);
    await terminateChild(recovered);
    if (Number.isInteger(handlerPid)) {
      try {
        process.kill(handlerPid, "SIGKILL");
      } catch (error) {
        if (error?.code !== "ESRCH") throw error;
      }
    }
    await external.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

for (const [retryMode, expectedCode] of [
  ["reconcile", "EffectReconciliationRequired"],
  ["none", "EffectOutcomeUnknown"],
]) {
  test(`blocks ${retryMode} after an unknown external outcome without redispatch`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), `touba-trigger-service-${retryMode}-unknown-`));
    const external = await startLocalEffectService();
    let child;
    try {
      const fixture = writeFixture(workspace, {
        effectHandler: "http-effect-unknown",
        effectContractKind: "external_write",
        effectRetryMode: retryMode,
        effectServiceUrl: external.url,
      });
      child = spawnService(fixture, [
        "--max-events",
        "1",
        "--effect-journal",
        fixture.effectJournalPath,
      ]);
      const started = await waitForStart(child);
      const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
        method: "POST",
        headers: { "x-touba-event-id": `evt-${retryMode}-unknown` },
        body: "uncertain",
      });
      assert.equal(response.status, 202);
      const exit = await once(child, "exit");
      assert.equal(exit[0], 0);

      const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
      assert.equal(queue.entries[0].status, "failed");
      assert.equal(queue.entries[0].runtime_error_code, expectedCode);
      assert.equal(queue.entries[0].attempt_count, 1);
      const journal = JSON.parse(readFileSync(fixture.effectJournalPath, "utf8"));
      const entries = Object.values(journal.entries);
      assert.equal(entries.length, 1);
      assert.equal(entries[0].state, "unknown");
      assert.equal(entries[0].attempt_count, 1);
      assert.equal(external.requestCount(), 1);
      assert.equal(external.mutationCount(), 1);
    } finally {
      await terminateChild(child);
      await external.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

for (const scenario of [
  {
    name: "timeout before mutation",
    effectHandler: "http-effect-timeout-before-mutation",
    holdFirstResponse: false,
    expectedCode: "ToolHandlerTimeout",
    expectedRequests: 0,
    expectedMutations: 0,
  },
  {
    name: "timeout after mutation",
    effectHandler: "http-effect-timeout",
    holdFirstResponse: true,
    expectedCode: "ToolHandlerTimeout",
    expectedRequests: 1,
    expectedMutations: 1,
  },
  {
    name: "invalid receipt",
    effectHandler: "http-effect-invalid-receipt",
    holdFirstResponse: false,
    expectedCode: "EffectReceiptInvalid",
    expectedRequests: 1,
    expectedMutations: 1,
  },
]) {
  test(`does not redispatch mode none after ${scenario.name}`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-none-failure-"));
    const external = await startLocalEffectService({
      holdFirstResponse: scenario.holdFirstResponse,
    });
    let child;
    try {
      const fixture = writeFixture(workspace, {
        effectHandler: scenario.effectHandler,
        effectContractKind: "external_write",
        effectRetryMode: "none",
        effectServiceUrl: external.url,
        handlerTimeoutMs: 500,
      });
      child = spawnService(fixture, [
        "--max-events",
        "1",
        "--effect-journal",
        fixture.effectJournalPath,
      ]);
      const started = await waitForStart(child);
      const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
        method: "POST",
        headers: { "x-touba-event-id": `evt-none-${scenario.name.replaceAll(" ", "-")}` },
        body: "uncertain",
      });
      assert.equal(response.status, 202);
      const exit = await once(child, "exit");
      assert.equal(exit[0], 0);

      const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
      assert.equal(queue.entries[0].status, "failed");
      assert.equal(queue.entries[0].runtime_error_code, scenario.expectedCode);
      assert.equal(queue.entries[0].attempt_count, 1);
      const journal = JSON.parse(readFileSync(fixture.effectJournalPath, "utf8"));
      assert.equal(Object.values(journal.entries)[0].state, "unknown");
      assert.equal(external.requestCount(), scenario.expectedRequests);
      assert.equal(external.mutationCount(), scenario.expectedMutations);
    } finally {
      await terminateChild(child);
      await external.close();
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("keeps resolved secrets out of the durable journal, queue and trace on an invalid receipt", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-effect-secret-"));
  const secretValue = "private-trigger-effect-token-0849";
  let child;
  try {
    const fixture = writeFixture(workspace, {
      effectHandler: "secret-effect-receipt",
      effectContractKind: "external_write",
      effectRetryMode: "none",
      secretValue,
    });
    child = spawnService(fixture, [
      "--max-events",
      "1",
      "--effect-journal",
      fixture.effectJournalPath,
      "--secrets",
      fixture.secretsPath,
    ], {
      TRIGGER_EFFECT_TEST_SECRET: secretValue,
    });
    const started = await waitForStart(child);
    const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: { "x-touba-event-id": "evt-secret-receipt" },
      body: "safe-payload",
    });
    assert.equal(response.status, 202);
    const exit = await once(child, "exit");
    assert.equal(exit[0], 0);

    const queueText = readFileSync(fixture.queuePath, "utf8");
    const queue = JSON.parse(queueText);
    assert.equal(queue.entries[0].status, "failed");
    assert.equal(queue.entries[0].runtime_error_code, "EffectReceiptInvalid");
    const journalText = readFileSync(fixture.effectJournalPath, "utf8");
    const [journalEntry] = Object.values(JSON.parse(journalText).entries);
    assert.equal(journalEntry.state, "unknown");
    assert.equal(Object.hasOwn(journalEntry, "receipt"), false);
    const traceText = readFileSync(queue.entries[0].trace_path, "utf8");
    const stateText = readFileSync(fixture.statePath, "utf8");
    for (const durableText of [queueText, journalText, traceText, stateText]) {
      assert.equal(durableText.includes(secretValue), false);
    }
  } finally {
    await terminateChild(child);
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses a divergent request for the same durable effect before redispatch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-effect-conflict-"));
  const external = await startLocalEffectService();
  let child;
  try {
    const fixture = writeFixture(workspace, {
      effectHandler: "http-effect-unknown",
      effectContractKind: "external_write",
      effectRetryMode: "idempotency_key",
      effectServiceUrl: external.url,
      effectUsesMessage: true,
      payloadMapped: true,
    });
    child = spawnService(fixture, [
      "--max-events",
      "2",
      "--effect-journal",
      fixture.effectJournalPath,
    ]);
    const started = await waitForStart(child);
    const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-event-id": "evt-effect-request-conflict",
      },
      body: JSON.stringify({ message: "original" }),
    });
    assert.equal(response.status, 202);
    await waitForEffectJournalState(fixture.effectJournalPath, "unknown");
    const queued = await waitForQueuedAttempt(fixture.queuePath, "evt-effect-request-conflict", 1);
    queued.arguments.message = "divergent";
    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    queue.entries = queue.entries.map((entry) =>
      entry.queue_id === queued.queue_id ? queued : entry
    );
    writeFileSync(fixture.queuePath, `${JSON.stringify(queue, null, 2)}\n`, "utf8");

    const exit = await once(child, "exit");
    assert.equal(exit[0], 0);
    const finished = JSON.parse(readFileSync(fixture.queuePath, "utf8")).entries[0];
    assert.equal(finished.status, "failed");
    assert.equal(finished.runtime_error_code, "EffectRequestConflict");
    assert.equal(finished.attempt_count, 2);
    assert.equal(external.requestCount(), 1);
    assert.equal(external.mutationCount(), 1);
  } finally {
    await terminateChild(child);
    await external.close();
    rmSync(workspace, { recursive: true, force: true });
  }
});

async function postOne(fixture, eventId) {
  const child = spawnService(fixture, ["--max-events", "1"]);
  const started = await waitForStart(child);
  const response = await fetch(`http://${started.host}:${started.port}/webhook/run`, {
    method: "POST",
    headers: {
      "x-touba-event-id": eventId,
    },
    body: "trigger-body",
  });
  assert.equal(response.status, 202);
  const exit = await once(child, "exit");
  assert.equal(exit[0], 0);
}

async function closeServer(server) {
  await new Promise((resolveClose) => server.close(resolveClose));
}

async function terminateChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  const exit = once(child, "exit");
  child.kill("SIGKILL");
  await exit;
}

async function waitForQueueEntryStatus(queuePath, eventId, status, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(queuePath)) {
      const queue = JSON.parse(readFileSync(queuePath, "utf8"));
      const entry = queue.entries?.find((candidate) => candidate.event_id === eventId);
      if (entry?.status === status) {
        return entry;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`queue entry ${eventId} did not reach ${status}`);
}

async function waitForQueuedAttempt(queuePath, eventId, attemptCount, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(queuePath)) {
      const queue = JSON.parse(readFileSync(queuePath, "utf8"));
      const entry = queue.entries?.find((candidate) => candidate.event_id === eventId);
      if (entry?.status === "queued" && entry.attempt_count === attemptCount) {
        return entry;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`queue entry ${eventId} did not queue attempt ${attemptCount}`);
}

async function waitForQueueEventTerminalCount(queuePath, eventId, expectedCount) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
    if (existsSync(queuePath)) {
      const queue = JSON.parse(readFileSync(queuePath, "utf8"));
      const entries = queue.entries?.filter((candidate) => candidate.event_id === eventId) ?? [];
      if (
        entries.length === expectedCount
        && entries.every((entry) => ["succeeded", "failed", "dead_lettered"].includes(entry.status))
      ) {
        return entries;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`queue event ${eventId} did not reach ${expectedCount} terminal entries`);
}

async function waitForFile(path, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) {
      return;
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`file was not created: ${path}`);
}

async function waitForEffectJournalState(path, state, timeoutMs = 5000) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    if (existsSync(path)) {
      const journal = JSON.parse(readFileSync(path, "utf8"));
      const entries = Object.values(journal.entries ?? {});
      if (entries.length > 0 && entries.every((entry) => entry.state === state)) {
        return entries;
      }
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
  }
  throw new Error(`effect journal did not reach ${state}`);
}

async function startLocalEffectService({ holdFirstResponse = false } = {}) {
  const records = new Map();
  const observedEffectIds = [];
  let requests = 0;
  let mutations = 0;
  let resolveFirstMutation;
  const firstMutation = new Promise((resolveMutation) => {
    resolveFirstMutation = resolveMutation;
  });
  const server = createServer(async (request, response) => {
    requests += 1;
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const payload = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const rawKey = request.headers["idempotency-key"];
    const effectId = Array.isArray(rawKey) ? rawKey[0] : rawKey;
    observedEffectIds.push(effectId);
    if (typeof effectId !== "string" || !effectId.startsWith("effect:sha256:")) {
      response.writeHead(400).end();
      return;
    }
    const previous = records.get(effectId);
    if (previous && previous.requestDigest !== payload.request_digest) {
      response.writeHead(409).end();
      return;
    }
    if (!previous) {
      mutations += 1;
      records.set(effectId, {
        requestDigest: payload.request_digest,
        receiptRef: `opaque:local-effect:${mutations}`,
        value: `created:${mutations}`,
      });
      resolveFirstMutation();
      if (holdFirstResponse) {
        return;
      }
    }
    const record = records.get(effectId);
    const body = JSON.stringify({
      receipt_ref: record.receiptRef,
      value: record.value,
    });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  });
  await new Promise((resolveListen) => server.listen(0, "127.0.0.1", resolveListen));
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}/effects`,
    firstMutation,
    requestCount: () => requests,
    mutationCount: () => mutations,
    effectIds: () => [...observedEffectIds],
    async close() {
      server.closeAllConnections?.();
      if (!server.listening) return;
      await new Promise((resolveClose) => server.close(resolveClose));
    },
  };
}

function effectInvocationCount(path) {
  if (!existsSync(path)) {
    return 0;
  }
  return readFileSync(path, "utf8").split("\n").filter(Boolean).length;
}

function queuedEntry(queueId, eventId, { nextAttemptAt } = {}) {
  return {
    queue_id: queueId,
    trigger_ref: "trigger:examples.webhook/WebhookRun",
    event_id: eventId,
    source_kind: "request",
    status: "queued",
    received_at: new Date().toISOString(),
    ...(nextAttemptAt === undefined ? {} : { next_attempt_at: nextAttemptAt }),
    http: {
      method: "POST",
      path: "/webhook/run",
      payload_bytes: 0,
      payload_sha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    },
  };
}

function triggerStatusSchema() {
  return JSON.parse(readFileSync(triggerStatusSchemaPath, "utf8"));
}

function spawnService(fixture, extraArgs = [], extraEnv = {}) {
  const child = spawn(process.execPath, [
    servePath,
    fixture.airPath,
    "--manifest",
    fixture.manifestPath,
    "--state",
    fixture.statePath,
    "--queue",
    fixture.queuePath,
    "--trace-dir",
    fixture.traceDir,
    "--port",
    "0",
    ...extraArgs,
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      ...extraEnv,
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += chunk.toString();
  });
  child.once("exit", (code) => {
    if (code !== 0 && stderr) {
      process.stderr.write(stderr);
    }
  });
  return child;
}

async function waitForStart(child) {
  let buffer = "";
  for await (const chunk of child.stdout) {
    buffer += chunk.toString();
    const lineEnd = buffer.indexOf("\n");
    if (lineEnd < 0) {
      continue;
    }
    const line = buffer.slice(0, lineEnd);
    const event = JSON.parse(line);
    assert.equal(event.event, "trigger_service_started");
    return event;
  }
  throw new Error("trigger service exited before reporting its port");
}

function writeFixture(workspace, options = {}) {
  const airPath = join(workspace, "webhook.air.json");
  const manifestPath = join(workspace, "touba.manifest.json");
  const statePath = join(workspace, "touba.trigger-state.json");
  const queuePath = join(workspace, "touba.trigger-queue.json");
  const effectJournalPath = join(workspace, "touba.effect-journal.json");
  const secretsPath = join(workspace, "touba.secrets.json");
  const traceDir = join(workspace, "traces");
  const effectLogPath = join(workspace, "effect-invocations.log");
  const handlerPidPath = join(workspace, "effect-handler.pid");
  const effectHandlerPath = options.effectHandler === undefined
    ? undefined
    : join(workspace, "effect.handler.mjs");
  const fixtureOptions = {
    ...options,
    workspace,
    effectHandlerPath,
    effectLogPath,
    handlerPidPath,
  };
  if (effectHandlerPath !== undefined) {
    writeFileSync(effectHandlerPath, effectHandlerSource(fixtureOptions), "utf8");
  }
  if (options.secretValue !== undefined) {
    writeFileSync(secretsPath, JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        TRIGGER_EFFECT_TEST_SECRET: {
          source: "env",
          name: "TRIGGER_EFFECT_TEST_SECRET",
        },
      },
    }), "utf8");
  }
  writeFileSync(airPath, JSON.stringify(webhookAir(fixtureOptions)), "utf8");
  writeFileSync(manifestPath, JSON.stringify(webhookManifest(fixtureOptions)), "utf8");
  return {
    airPath,
    manifestPath,
    statePath,
    queuePath,
    effectJournalPath,
    secretsPath,
    traceDir,
    effectLogPath,
    handlerPidPath,
  };
}

function webhookAir(options = {}) {
  const payloadMapped = options.payloadMapped === true;
  const effectHandler = options.effectHandler !== undefined;
  const effectUsesMessage = options.effectUsesMessage === true;
  const effectToolRef = "tool:examples.webhook/RecordEffect";
  return {
    air_schema_version: "touba-air-v1",
    air_capability_profile: "touba-air-capabilities-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: {
      id: "module:examples.webhook",
      name: "examples.webhook",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      functions: [],
      tools: effectHandler
        ? [
          {
            id: effectToolRef,
            name: "RecordEffect",
            signature: {
              inputs: effectUsesMessage
                ? [{ name: "message", type_ref: "builtin:Text" }]
                : [],
              output_type: "builtin:Text",
            },
            source_ref: sourceRef(),
          },
        ]
        : [],
      skills: [],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.webhook/RunWebhook",
          name: "RunWebhook",
          signature: {
            inputs: payloadMapped
              ? [
                {
                  name: "message",
                  type_ref: "builtin:Text",
                },
              ]
              : [],
            output_type: "builtin:Text",
          },
          uses: effectHandler ? [effectToolRef] : [],
          use_refs: effectHandler
            ? [{ target_ref: effectToolRef, source_ref: sourceRef() }]
            : [],
          flow_graph_ref: "graph:strategy:examples.webhook/RunWebhook",
          source_ref: sourceRef(),
        },
      ],
      triggers: [
        {
          id: "trigger:examples.webhook/WebhookRun",
          name: "WebhookRun",
          event: {
            kind: "request",
            value: "POST /webhook/run",
            source_ref: sourceRef(),
          },
          target_ref: "strategy:examples.webhook/RunWebhook",
          target_kind: "strategy",
          arguments: [],
          limits: {
            max_runs_per_day: 10,
            timeout_ms: 30000,
            source_ref: sourceRef(),
          },
          source_ref: sourceRef(),
        },
      ],
    },
    execution_graphs: [
      {
        id: "graph:strategy:examples.webhook/RunWebhook",
        owner_ref: "strategy:examples.webhook/RunWebhook",
        entry_node_id: "n1",
        nodes: effectHandler
          ? [
            {
              id: "n1",
              kind: "call_tool",
              target_ref: effectToolRef,
              arguments: effectUsesMessage ? ["value:message"] : [],
              result_binding: "effect_result",
              trace_point_refs: [],
              source_ref: sourceRef(),
            },
            {
              id: "n2",
              kind: "give",
              arguments: ["value:effect_result"],
              trace_point_refs: [],
              source_ref: sourceRef(),
            },
          ]
          : [
            {
              id: "n1",
              kind: "give",
              arguments: [payloadMapped ? "value:message" : "literal:string:webhook accepted"],
              trace_point_refs: [],
              source_ref: sourceRef(),
            },
          ],
        edges: effectHandler
          ? [{ from_node_id: "n1", to_node_id: "n2", role: "next", source_ref: sourceRef() }]
          : [],
        failure_paths: [],
        failure_path_refs: [],
        source_ref: sourceRef(),
      },
    ],
    trace_points: [],
  };
}

function webhookManifest(options = {}) {
  const trigger = {
    enabled: true,
    source: {
      kind: "request",
    },
    limits: {
      max_runs_per_day: 10,
      timeout_ms: 30000,
    },
  };
  if (options.payloadMapped === true) {
    trigger.payload = {
      format: "json",
      content_types: ["application/json"],
      max_bytes: 256,
      map: {
        message: "$.message",
      },
    };
  }
  return {
    manifest_version: options.effectContractKind === undefined
      ? "touba-manifest-v1"
      : "touba-manifest-v2",
    bindings: options.effectHandlerPath === undefined
      ? {}
      : {
        "tool:examples.webhook/RecordEffect": {
          handler: {
            kind: "process",
            command: process.execPath,
            args: [options.effectHandlerPath],
            cwd: options.workspace,
          },
          grants: [],
          secrets: [],
          timeout_ms: options.handlerTimeoutMs ?? 5000,
          max_payload_bytes: 1048576,
          ...(options.effectContractKind === undefined
            ? {}
            : {
              effect_contract: options.effectContractKind === "none"
                ? { kind: "none" }
                : {
                  kind: "external_write",
                  retry_mode: options.effectRetryMode,
                },
            }),
        },
      },
    triggers: {
      "trigger:examples.webhook/WebhookRun": trigger,
    },
  };
}

function effectHandlerSource(options) {
  const effectLogPath = JSON.stringify(options.effectLogPath);
  const handlerPidPath = JSON.stringify(options.handlerPidPath);
  const common = [
    "import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';",
    `const effectLogPath = ${effectLogPath};`,
    `const handlerPidPath = ${handlerPidPath};`,
    "process.stdin.resume();",
    "process.stdin.on('end', () => {",
    "  appendFileSync(effectLogPath, `${process.pid}\\n`, 'utf8');",
    "  const invocationCount = readFileSync(effectLogPath, 'utf8').split('\\n').filter(Boolean).length;",
  ];
  if (options.effectHandler === "http-effect-timeout-before-mutation") {
    return [
      "process.stdin.resume();",
      "process.stdin.on('end', () => {",
      "  setInterval(() => {}, 1000);",
      "});",
      "",
    ].join("\n");
  }
  if (options.effectHandler === "secret-effect-receipt") {
    return [
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', () => {",
      "  const request = JSON.parse(input);",
      "  process.stdout.write(JSON.stringify({",
      "    ok: true,",
      "    value: 'created',",
      "    effect_receipt: {",
      "      effect_id: request.effect.effect_id,",
      "      request_digest: request.effect.request_digest,",
      "      outcome: 'applied',",
      `      receipt_ref: ${JSON.stringify(`opaque:${options.secretValue}`)},`,
      "    },",
      "  }));",
      "});",
      "",
    ].join("\n");
  }
  if ([
    "http-effect",
    "http-effect-invalid-receipt",
    "http-effect-timeout",
    "http-effect-unknown",
  ].includes(options.effectHandler)) {
    const effectServiceUrl = JSON.stringify(options.effectServiceUrl);
    const outcome = options.effectHandler === "http-effect-unknown" ? "unknown" : "applied";
    const receiptLines = options.effectHandler === "http-effect-invalid-receipt"
      ? []
      : [
        "      effect_receipt: {",
        "        effect_id: request.effect.effect_id,",
        "        request_digest: request.effect.request_digest,",
        `        outcome: ${JSON.stringify(outcome)},`,
        "        receipt_ref: external.receipt_ref,",
        "      },",
      ];
    return [
      "import { writeFileSync } from 'node:fs';",
      `const handlerPidPath = ${handlerPidPath};`,
      `const effectServiceUrl = ${effectServiceUrl};`,
      "let input = '';",
      "process.stdin.setEncoding('utf8');",
      "process.stdin.on('data', (chunk) => { input += chunk; });",
      "process.stdin.on('end', async () => {",
      "  writeFileSync(handlerPidPath, String(process.pid), 'utf8');",
      "  try {",
      "    const request = JSON.parse(input);",
      "    const response = await fetch(effectServiceUrl, {",
      "      method: 'POST',",
      "      headers: {",
      "        'content-type': 'application/json',",
      "        'idempotency-key': request.effect.effect_id,",
      "      },",
      "      body: JSON.stringify({ request_digest: request.effect.request_digest }),",
      "    });",
      "    if (!response.ok) throw new Error(`service status ${response.status}`);",
      "    const external = await response.json();",
      "    process.stdout.write(JSON.stringify({",
      "      ok: true,",
      "      value: external.value,",
      ...receiptLines,
      "    }));",
      "  } catch {",
      "    process.exitCode = 1;",
      "  }",
      "});",
      "",
    ].join("\n");
  }
  if (options.effectHandler === "delayed-success") {
    return [...common,
      "  setTimeout(() => process.stdout.write(JSON.stringify({ ok: true, value: 'recorded' })), 250);",
      "});",
      "",
    ].join("\n");
  }
  if (options.effectHandler === "fail-once") {
    return [...common,
      "  if (invocationCount === 1) {",
      "    process.stdout.write(JSON.stringify({ ok: false, error: { code: 'FixtureTransientFailure', message: 'retry me' } }));",
      "    return;",
      "  }",
      "  process.stdout.write(JSON.stringify({ ok: true, value: 'recorded' }));",
      "});",
      "",
    ].join("\n");
  }
  if (options.effectHandler === "always-fail") {
    return [...common,
      "  process.stdout.write(JSON.stringify({ ok: false, error: { code: 'FixtureTransientFailure', message: 'retry me' } }));",
      "});",
      "",
    ].join("\n");
  }
  if (options.effectHandler === "hang-after-first-effect") {
    return [...common,
      "  writeFileSync(handlerPidPath, String(process.pid), 'utf8');",
      "  if (invocationCount === 1) {",
      "    setInterval(() => {}, 1000);",
      "    return;",
      "  }",
      "  process.stdout.write(JSON.stringify({ ok: true, value: 'recorded' }));",
      "});",
      "",
    ].join("\n");
  }
  throw new Error(`unknown effect handler fixture ${options.effectHandler}`);
}

function eventOf(trace, kind) {
  const event = trace.events.find((candidate) => candidate.kind === kind);
  assert.ok(event, `expected trace event ${kind}`);
  return event;
}

function sourceRef() {
  return {
    source_id: "webhook.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}
