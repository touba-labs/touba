import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { loadHumanDecisionStore, saveHumanDecisionStore, pageHumanDecisions } from "../src/human-stores.mjs";
import { createToubaProjectServer, listHumanDecisions } from "../src/serve.mjs";
import { validateObject } from "../../../contracts/product-surfaces/validate.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;
const schema = JSON.parse(readFileSync(join(contractsRoot, "schemas/touba-human-decision-history-v1.schema.json")));
const approval = JSON.parse(readFileSync(join(contractsRoot, "fixtures/valid/touba-approval-decision-v1.json")));
const review = JSON.parse(readFileSync(join(contractsRoot, "fixtures/valid/touba-human-review-decision-v1.json")));

function fixture(t, count) {
  const root = mkdtempSync(join(tmpdir(), "touba-decision-pages-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".touba")); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.tb"), "module sample.history\n");
  const path = join(root, ".touba/human-decisions.sqlite");
  const state = loadHumanDecisionStore(path);
  for (let i = 0; i < count; i++) state.decisions.push({ ...(i % 2 ? review : approval),
    request_id: `request-${i}`, accepted_at: "2026-10-30T12:00:00.000Z" });
  saveHumanDecisionStore(path, state);
  return { root, path };
}

test("10,000 decisions stay paged, with global counts and a stable cursor", t => {
  const { path } = fixture(t, 10_000);
  const first = listHumanDecisions({ humanDecisionsPath: path });
  assert.deepEqual(validateObject(schema, first), []);
  assert.deepEqual(first.summary, { total: 10_000, approvals: 5000, reviews: 5000 });
  assert.equal(first.decisions.length, 50);
  assert.equal(first.decisions[0].request_id, "request-9999");
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 65536);
  const append = loadHumanDecisionStore(path, [{ request_id: "new" }]);
  append.decisions.push({ ...approval, request_id: "new", accepted_at: "2026-10-30T12:00:00.000Z" });
  saveHumanDecisionStore(path, append);
  const second = pageHumanDecisions(path, { cursor: first.pagination.next_cursor, limit: 50 });
  assert.equal(second.decisions[0].request_id, "request-9949");
  assert.equal(second.summary.total, 10_001);
  const last = pageHumanDecisions(path, { cursor: "3", limit: 50 });
  assert.deepEqual(last.decisions.map(item => item.request_id), ["request-1", "request-0"]);
  assert.equal(last.pagination.next_cursor, null);
  assert.equal(pageHumanDecisions(path).decisions[0].request_id, "new");
  for (const options of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: "0" },
    { cursor: "-1" }, { cursor: "1 OR 1=1" }, { cursor: "9007199254740992" }, { cursor: 2 }]) {
    assert.throws(() => pageHumanDecisions(path, options), { code: "ToubaServeDecisionPageInvalid" });
  }
});

test("decision pages preserve HTTP authentication, validation and final-page navigation", async t => {
  const { root, path } = fixture(t, 55);
  const tokenName = `TOUBA_DECISION_PAGE_TEST_${process.pid}`;
  process.env[tokenName] = "isolated-decision-page-token";
  const service = createToubaProjectServer({ projectRoot: root, contractsRoot, humanDecisionsPath: path,
    authTokenEnv: tokenName, quiet: true, port: 0 });
  try {
    await service.start();
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const headers = { authorization: "Bearer isolated-decision-page-token" };
    assert.equal((await fetch(base + "/decisions")).status, 401);
    const first = await (await fetch(base + "/decisions?limit=50", { headers })).json();
    assert.equal(first.decisions.length, 50);
    const lastResponse = await fetch(`${base}/decisions?limit=50&cursor=${first.pagination.next_cursor}`, { headers });
    assert.equal(lastResponse.status, 200);
    const last = await lastResponse.json();
    assert.equal(last.decisions.length, 5); assert.equal(last.pagination.next_cursor, null);
    for (const query of ["limit=0", "limit=101", "limit=no", "cursor=-1", "cursor=1%20OR%201=1"]) {
      const response = await fetch(`${base}/decisions?${query}`, { headers });
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).code, "ToubaServeDecisionPageInvalid");
    }
  } finally { await service.stop(); delete process.env[tokenName]; }
});
