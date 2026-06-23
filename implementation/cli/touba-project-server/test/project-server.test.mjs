import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  acceptDecision,
  applyProjectChange,
  buildContractIndex,
  buildLiveState,
  buildProjectEvent,
  createToubaProjectServer,
  preflightServeOptions,
  proposeProjectChange,
  refreshProject,
} from "../src/serve.mjs";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;

test("contract index lists product-surface contracts without filesystem paths", () => {
  const index = buildContractIndex({ contractsRoot, generatedAt: "2026-06-22T00:00:00Z" });

  assert.equal(index.schema_version, "touba-project-server-contract-index-v0.1");
  assert.equal(index.contracts.some((item) => item.schema_version === "touba-run-summary-v1"), true);
  assert.equal(index.contracts.every((item) => item.status === "available"), true);
  assert.equal(JSON.stringify(index).includes(contractsRoot), false);
});

test("preflight rejects invalid contracts root and decision store path", () => {
  assert.throws(
    () => preflightServeOptions({
      contractsRoot: join(tmpdir(), "missing-touba-contracts"),
      humanDecisionsPath: join(tmpdir(), "human-decisions.json"),
    }),
    /valid contracts root/,
  );
  assert.throws(
    () => preflightServeOptions({
      contractsRoot,
      humanDecisionsPath: contractsRoot,
    }),
    /directory as decision store/,
  );
});

test("live state composes project, run, trigger, decision and event surfaces", () => {
  const state = buildLiveState({ contractsRoot, generatedAt: "2026-06-22T00:00:00Z" });

  assert.equal(state.schema_version, "touba-project-live-state-v0.1");
  assert.equal(state.project.schema_version, "touba-project-inspection-v1");
  assert.equal(state.current_run.schema_version, "touba-run-summary-v1");
  assert.equal(state.pending_approval.schema_version, "touba-approval-request-v1");
  assert.equal(state.pending_review.schema_version, "touba-human-review-request-v1");
  assert.equal(state.events.transport, "server_sent_events");
  assert.equal(state.events.event_schema_version, "touba-project-event-v0.1");
  assert.equal(state.project_server.refresh.schema_version, "touba-project-refresh-v0.1");
});

test("project events use a stable envelope contract", () => {
  const event = buildProjectEvent({
    type: "project.changed",
    sequence: 7,
    emittedAt: "2026-06-23T00:00:00.000Z",
    payload: {
      schema_version: "touba-project-refresh-v0.1",
      status: "refreshed",
    },
  });

  assert.equal(event.schema_version, "touba-project-event-v0.1");
  assert.equal(event.event_id, "evt_000007");
  assert.equal(event.sequence, 7);
  assertMatchesSchema("touba-project-event-v0.1", event);
});

test("refresh project reports artifacts, stale state and changed files", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-refresh-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n", "utf8");
    const first = refreshProject({
      projectRoot: root,
      refreshedAt: "2026-06-22T00:00:00Z",
      request: { schema_version: "touba-project-refresh-request-v0.1" },
    });
    assert.equal(first.report.schema_version, "touba-project-refresh-v0.1");
    assert.equal(first.report.summary.artifact_count, 1);
    assert.equal(first.report.changes.changed_artifacts.length, 1);
    assert.equal(first.report.diagnostics.some((item) => item.code === "ToubaServeProjectAirStale"), true);

    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n// changed\n", "utf8");
    const second = refreshProject({
      projectRoot: root,
      previousSnapshot: first.snapshot,
      refreshedAt: "2026-06-22T00:00:01Z",
      request: { schema_version: "touba-project-refresh-request-v0.1" },
    });
    assert.deepEqual(second.report.changes.changed_artifacts.map((item) => item.relative_path), ["src/main.tb"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change proposals are stored, applied atomically and cannot be replayed", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-change-"));
  try {
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    const proposed = proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-06-22T00:00:00Z",
      proposal: {
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "change_001",
        action: "write_text_file",
        target: { path: "src/main.tb" },
        requested_by: { kind: "user", id: "khadim" },
        content: "module demo.main\n",
      },
    });
    assert.equal(proposed.status, "proposed");
    assert.equal(existsSync(changeProposalsPath), true);

    const applied = applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      decidedAt: "2026-06-22T00:00:01Z",
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "change_001",
        decision: "apply",
        decided_by: { kind: "user", id: "khadim" },
      },
    });
    assert.equal(applied.status, "applied");
    assert.equal(readFileSync(join(root, "src", "main.tb"), "utf8"), "module demo.main\n");
    assert.throws(
      () => applyProjectChange({
        projectRoot: root,
        changeProposalsPath,
        applyRequest: {
          schema_version: "touba-project-change-apply-v0.1",
          proposal_id: "change_001",
          decision: "apply",
        },
      }),
      /no longer pending/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change proposals reject unsafe paths and invalid Touba JSON metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-reject-"));
  try {
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "escape",
          action: "write_text_file",
          target: { path: "../outside.tb" },
          content: "module bad",
        },
      }),
      /escapes the project root/,
    );
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "bad_json",
          action: "write_text_file",
          target: { path: "touba.manifest.json" },
          content: "{not-json",
        },
      }),
      /failed validation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts valid decisions and rejects replay", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-"));
  try {
    const humanDecisionsPath = join(root, "human-decisions.json");
    const decision = readJson("fixtures/valid/touba-approval-decision-v1.json");
    const accepted = acceptDecision({
      contractsRoot,
      humanDecisionsPath,
      decision,
      acceptedAt: "2026-06-22T00:00:00Z",
    });

    assert.equal(accepted.status, "accepted");
    const store = JSON.parse(readFileSync(humanDecisionsPath, "utf8"));
    assert.equal(store.schema_version, "touba-human-decisions-v0.1");
    assert.equal(store.decisions.length, 1);
    assert.throws(
      () => acceptDecision({ contractsRoot, humanDecisionsPath, decision }),
      /already stored/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server exposes live state, events and decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.main\n", "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.json"),
    changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.status, "ok");
    assert.equal(health.service, "touba-project-server");
    assert.equal(health.endpoints.events, "/events");

    const state = await getJson(`${baseUrl}/state`);
    assert.equal(state.schema_version, "touba-project-live-state-v0.1");
    assert.equal(state.project_server.refresh.summary.artifact_count, 1);

    const project = await getJson(`${baseUrl}/project`);
    assert.equal(project.schema_version, "touba-project-inspection-v1");

    const runSummary = await getJson(`${baseUrl}/runs/current`);
    assert.equal(runSummary.schema_version, "touba-run-summary-v1");

    const eventStream = await fetch(`${baseUrl}/events`);
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.headers.get("content-type"), /text\/event-stream/);
    const { text: readyText, reader } = await readNextEvent(eventStream);
    const readyEvent = parseSseEvent(readyText);
    assertMatchesSchema("touba-project-event-v0.1", readyEvent);
    assert.equal(readyEvent.type, "touba.server.ready");

    const decision = readJson("fixtures/valid/touba-human-review-decision-v1.json");
    const response = await fetch(`${baseUrl}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.request_id, decision.request_id);

    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n// refresh\n", "utf8");
    const refreshResponse = await fetch(`${baseUrl}/project/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-refresh-request-v0.1",
        requested_by: { kind: "studio", id: "test-suite" },
        reason: "http-test-refresh",
      }),
    });
    assert.equal(refreshResponse.status, 202);
    const refresh = await refreshResponse.json();
    assertMatchesSchema("touba-project-refresh-v0.1", refresh);
    assert.deepEqual(refresh.changes.changed_artifacts.map((item) => item.relative_path), ["src/main.tb"]);

    const proposedResponse = await fetch(`${baseUrl}/changes/propose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "http_change_001",
        action: "write_text_file",
        target: { path: "touba.project.json" },
        requested_by: { kind: "user", id: "khadim" },
        reason: "http change test",
        content: JSON.stringify({ project_version: "touba-project-v1", language: "javascript" }, null, 2),
      }),
    });
    assert.equal(proposedResponse.status, 202);
    const proposed = await proposedResponse.json();
    assertMatchesSchema("touba-project-change-proposed-v0.1", proposed);
    assert.equal(proposed.status, "proposed");

    const applyResponse = await fetch(`${baseUrl}/changes/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "http_change_001",
        decision: "apply",
        decided_by: { kind: "user", id: "khadim" },
        reason: "http apply test",
      }),
    });
    assert.equal(applyResponse.status, 202);
    const applied = await applyResponse.json();
    assertMatchesSchema("touba-project-change-result-v0.1", applied);
    assert.equal(applied.status, "applied");
    assert.equal(existsSync(join(root, "touba.project.json")), true);

    const { text: eventText } = await readNextEventFromReader(reader);
    const emittedEvent = parseSseEvent(eventText);
    assertMatchesSchema("touba-project-event-v0.1", emittedEvent);
    assert.match(eventText, /touba\.server\.ready|human_decision\.accepted|project\.changed|change\.proposed|change\.applied/);
    await reader.cancel();
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server requires bearer auth when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-auth-"));
  const previous = process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN;
  process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN = "secret-token";
  const service = createToubaProjectServer({
    authTokenEnv: "TOUBA_TEST_PROJECT_SERVER_TOKEN",
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.json"),
    changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const unauthorized = await fetch(`${baseUrl}/state`);
    assert.equal(unauthorized.status, 401);

    const authorized = await fetch(`${baseUrl}/state`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(authorized.status, 200);
    const state = await authorized.json();
    assert.equal(state.schema_version, "touba-project-live-state-v0.1");

    const eventStream = await fetch(`${baseUrl}/events`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(eventStream.status, 200);
    const { text, reader } = await readNextEvent(eventStream);
    assert.equal(parseSseEvent(text).schema_version, "touba-project-event-v0.1");
    await reader.cancel();
  } finally {
    await service.stop();
    if (previous === undefined) {
      delete process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN;
    } else {
      process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function readNextEvent(response) {
  const reader = response.body.getReader();
  const result = await readNextEventFromReader(reader);
  return { ...result, reader };
}

async function readNextEventFromReader(reader) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return { text };
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(contractsRoot, relativePath), "utf8"));
}

function assertMatchesSchema(schemaVersion, value) {
  const schema = readJson(`schemas/${schemaVersion}.schema.json`);
  const diagnostics = validateObject(schema, value);
  assert.deepEqual(diagnostics, []);
}

function parseSseEvent(text) {
  const dataLine = text.split(/\r?\n/u).find((line) => line.startsWith("data: "));
  assert.ok(dataLine, `SSE event has no data line: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}
