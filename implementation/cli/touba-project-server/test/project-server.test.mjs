import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  acceptDecision,
  buildContractIndex,
  buildLiveState,
  createToubaProjectServer,
  preflightServeOptions,
} from "../src/serve.mjs";

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
  const service = createToubaProjectServer({
    contractsRoot,
    humanDecisionsPath: join(root, "human-decisions.json"),
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

    const project = await getJson(`${baseUrl}/project`);
    assert.equal(project.schema_version, "touba-project-inspection-v1");

    const runSummary = await getJson(`${baseUrl}/runs/current`);
    assert.equal(runSummary.schema_version, "touba-run-summary-v1");

    const eventStream = await fetch(`${baseUrl}/events`);
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.headers.get("content-type"), /text\/event-stream/);

    const decision = readJson("fixtures/valid/touba-human-review-decision-v1.json");
    const response = await fetch(`${baseUrl}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.request_id, decision.request_id);

    const { text: eventText, reader } = await readNextEvent(eventStream);
    assert.match(eventText, /touba\.server\.ready|human_decision\.accepted/);
    await reader.cancel();
  } finally {
    await service.stop();
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
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return { text, reader };
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(contractsRoot, relativePath), "utf8"));
}
