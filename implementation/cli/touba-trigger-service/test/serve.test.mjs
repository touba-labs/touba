import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createTriggerService } from "../src/serve.mjs";

const servePath = new URL("../src/serve.mjs", import.meta.url).pathname;

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

function spawnService(fixture, extraArgs = []) {
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

function writeFixture(workspace) {
  const airPath = join(workspace, "webhook.air.json");
  const manifestPath = join(workspace, "touba.manifest.json");
  const statePath = join(workspace, "touba.trigger-state.json");
  const queuePath = join(workspace, "touba.trigger-queue.json");
  const traceDir = join(workspace, "traces");
  writeFileSync(airPath, JSON.stringify(webhookAir()), "utf8");
  writeFileSync(manifestPath, JSON.stringify(webhookManifest()), "utf8");
  return {
    airPath,
    manifestPath,
    statePath,
    queuePath,
    traceDir,
  };
}

function webhookAir() {
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
            inputs: [],
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
            arguments: ["literal:string:webhook accepted"],
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

function webhookManifest() {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {
      "trigger:examples.webhook/WebhookRun": {
        enabled: true,
        source: {
          kind: "request",
        },
        limits: {
          max_runs_per_day: 10,
          timeout_ms: 30000,
        },
      },
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
