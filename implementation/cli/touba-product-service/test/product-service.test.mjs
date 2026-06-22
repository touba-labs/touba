import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  acceptDecision,
  buildContractIndex,
  createProductSurfaceService,
} from "../src/serve.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;

test("contract index lists product-surface contracts without filesystem paths", () => {
  const index = buildContractIndex({ contractsRoot, generatedAt: "2026-06-22T00:00:00Z" });

  assert.equal(index.schema_version, "touba-product-service-contract-index-v0.1");
  assert.equal(index.contracts.some((item) => item.schema_version === "touba-run-summary-v1"), true);
  assert.equal(index.contracts.every((item) => item.status === "available"), true);
  assert.equal(JSON.stringify(index).includes(contractsRoot), false);
});

test("accepts valid decisions and rejects replay", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-product-service-"));
  try {
    const decisionsPath = join(root, "decisions.json");
    const decision = readJson("fixtures/valid/touba-approval-decision-v1.json");
    const accepted = acceptDecision({
      contractsRoot,
      decisionsPath,
      decision,
      acceptedAt: "2026-06-22T00:00:00Z",
    });

    assert.equal(accepted.status, "accepted");
    const store = JSON.parse(readFileSync(decisionsPath, "utf8"));
    assert.equal(store.schema_version, "touba-product-decisions-v0.1");
    assert.equal(store.decisions.length, 1);
    assert.throws(
      () => acceptDecision({ contractsRoot, decisionsPath, decision }),
      /already stored/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP service exposes contracts and accepts decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-product-service-"));
  const service = createProductSurfaceService({
    contractsRoot,
    decisionsPath: join(root, "decisions.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.status, "ok");

    const runSummary = await getJson(`${baseUrl}/contracts/touba-run-summary-v1`);
    assert.equal(runSummary.schema_version, "touba-run-summary-v1");

    const decision = readJson("fixtures/valid/touba-human-review-decision-v1.json");
    const response = await fetch(`${baseUrl}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.request_id, decision.request_id);
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

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(contractsRoot, relativePath), "utf8"));
}
