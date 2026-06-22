import test from "node:test";
import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

test("refuses replayed webhook event ids before rerunning the target strategy", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-trigger-service-replay-"));
  try {
    const fixture = writeFixture(workspace);
    await postOne(fixture, "evt-webhook-replay");
    await postOne(fixture, "evt-webhook-replay");

    const queue = JSON.parse(readFileSync(fixture.queuePath, "utf8"));
    assert.equal(queue.entries.length, 2);
    assert.equal(queue.entries[0].status, "succeeded");
    assert.equal(queue.entries[1].status, "failed");
    assert.equal(queue.entries[1].runtime_error_code, "TriggerReplayRejected");
    assert.equal(queue.entries[1].refusal_reason, "event_replay");

    const state = JSON.parse(readFileSync(fixture.statePath, "utf8"));
    const triggerState = state.triggers["trigger:examples.webhook/WebhookRun"];
    assert.equal(triggerState.accepted_count, 1);
    assert.equal(triggerState.refused_count, 1);
    assert.deepEqual(triggerState.consumed_event_ids, ["evt-webhook-replay"]);
  } finally {
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

async function waitForQueueEntryStatus(queuePath, eventId, status) {
  const startedAt = Date.now();
  while (Date.now() - startedAt < 5000) {
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
  const traceDir = join(workspace, "traces");
  writeFileSync(airPath, JSON.stringify(webhookAir(options)), "utf8");
  writeFileSync(manifestPath, JSON.stringify(webhookManifest(options)), "utf8");
  return {
    airPath,
    manifestPath,
    statePath,
    queuePath,
    traceDir,
  };
}

function webhookAir(options = {}) {
  const payloadMapped = options.payloadMapped === true;
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
    module: {
      id: "module:examples.webhook",
      name: "examples.webhook",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      functions: [],
      tools: [],
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
        nodes: [
          {
            id: "n1",
            kind: "give",
            arguments: [payloadMapped ? "value:message" : "literal:string:webhook accepted"],
            trace_point_refs: [],
            source_ref: sourceRef(),
          },
        ],
        edges: [],
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
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {
      "trigger:examples.webhook/WebhookRun": trigger,
    },
  };
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
