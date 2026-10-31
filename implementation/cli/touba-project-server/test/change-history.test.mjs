import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { indexedStore } from "../../../runtime/touba-runtime/src/sqlite-record-store.mjs";
import { CHANGE_INDEXES, readChangeProposals, saveChangeProposals, migrateChangeProposals, pageChangeProposals } from "../src/change-store.mjs";
import { createToubaProjectServer, listProjectChanges, getProjectChangeDetail, checkToubaProjectState } from "../src/serve.mjs";
import { validateObject } from "../../../contracts/product-surfaces/validate.mjs";
import { stateCommand } from "../../touba-project/src/state-command.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;
const schema = JSON.parse(readFileSync(join(contractsRoot, "schemas/touba-project-change-history-v1.schema.json")));
const sample = { schema_version: "touba-project-change-proposal-v1", proposal_id: "first",
  status: "proposed", action: "write_text_file", target: { path: "src/main.tb" },
  requested_by: { kind: "studio", id: "test-user" }, reason: "Test change", proposed_at: "2026-10-30T00:00:00Z",
  content: "module history.sample\n", content_sha256: "a".repeat(64), validations: [] };

function fixture(t, count = 0) {
  const root = mkdtempSync(join(tmpdir(), "touba-change-pages-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".touba")); mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src/main.tb"), sample.content);
  const path = join(root, ".touba/project-change-proposals.sqlite");
  // Synthetic history seeding is separate from the real propose/apply tests.
  const store = indexedStore({ path, schemaVersion: "touba-project-change-proposals-v1",
    keyOf: record => record.proposal_id, indexes: CHANGE_INDEXES, validate() {} });
  const rows = store.read();
  for (let i = 0; i < count; i++) rows.push({ ...sample, proposal_id: `change-${i}`,
    status: i % 2 ? "applied" : "proposed", content: "x".repeat(4000) });
  if (count) store.write(rows);
  return { root, path };
}

test("10,000 changes remain bounded with global counts and status across all pages", t => {
  const { root, path } = fixture(t, 10_000);
  const first = listProjectChanges({ projectRoot: root, changeProposalsPath: path });
  assert.deepEqual(validateObject(schema, first), []);
  assert.deepEqual(first.summary, { total: 10_000, pending: 5000, applied: 5000, refused: 0 });
  assert.equal(first.changes.length, 50);
  assert.equal(first.changes[0].proposal_id, "change-9999");
  assert.ok(!JSON.stringify(first).includes("xxxx"));
  assert.ok(Buffer.byteLength(JSON.stringify(first)) < 65536);
  const add = readChangeProposals(path, "new"); add.proposals.push({ ...sample, proposal_id: "new" });
  saveChangeProposals(path, add);
  const second = listProjectChanges({ changeProposalsPath: path, cursor: first.pagination.next_cursor });
  assert.equal(second.changes[0].proposal_id, "change-9949");
  const filtered = listProjectChanges({ changeProposalsPath: path, status: "pending", cursor: "4" });
  assert.deepEqual(filtered.changes.map(row => row.proposal_id), ["change-2", "change-0"]);
  assert.equal(filtered.pagination.next_cursor, null);
  assert.equal(getProjectChangeDetail({ projectRoot: root, changeProposalsPath: path, proposalId: "new" }).change.proposal_id, "new");
  const left = readChangeProposals(path, "new"), right = readChangeProposals(path, "new");
  left.proposals[0].status = "refused"; saveChangeProposals(path, left);
  right.proposals[0].status = "applied";
  assert.throws(() => saveChangeProposals(path, right), { code: "ToubaStoreWriteConflict" });
  // Isolated reader: a 10,000-row / 40 MiB synthetic history, 40 page reads.
  // Admission thresholds: retained heap growth <16 MiB and run time <10 s.
  // This measures one local reader, not concurrent production capacity.
  const source = `import { pageChangeProposals } from ${JSON.stringify(new URL("../src/change-store.mjs", import.meta.url).href)};
    const path = process.argv[1];
    for (let n = 0; n < 5; n++) pageChangeProposals(path);
    global.gc(); const before = process.memoryUsage(), start = performance.now();
    let cursor = null;
    for (let n = 0; n < 40; n++) cursor = pageChangeProposals(path, { cursor }).pagination.next_cursor;
    global.gc(); const after = process.memoryUsage();
    console.log(JSON.stringify({ heapGrowth: after.heapUsed - before.heapUsed,
      rssGrowth: after.rss - before.rss, elapsedMs: performance.now() - start, pages: 40 }));`;
  const capacity = JSON.parse(execFileSync(process.execPath, ["--expose-gc", "--input-type=module", "-e", source, path],
    { encoding: "utf8", timeout: 15000 }));
  assert.ok(capacity.heapGrowth < 16 * 1024 * 1024, JSON.stringify(capacity));
  assert.ok(capacity.elapsedMs < 10000, JSON.stringify(capacity));
  t.diagnostic(JSON.stringify(capacity));
});

test("JSON history requires explicit migration, retaining exact source and authority evidence", async t => {
  const { root, path } = fixture(t);
  const source = path.replace(/sqlite$/, "json");
  const document = { schema_version: "touba-project-change-proposals-v1", proposals: [sample] };
  writeFileSync(source, JSON.stringify(document));
  const before = readFileSync(source);
  assert.throws(() => pageChangeProposals(path), { code: "ToubaStoreFormatIncompatible" });
  assert.throws(() => pageChangeProposals(source), { code: "ToubaStoreFormatIncompatible" });
  assert.ok(checkToubaProjectState({ projectRoot: root }).diagnostics.some(item => item.store === "changeProposalsPath" && item.code === "ToubaStoreFormatIncompatible"));
  const preview = JSON.parse((await stateCommand(["migrate", "changes", source, "--out", path])).text);
  assert.equal(preview.applied, false); assert.equal(existsSync(path), false);
  const applied = migrateChangeProposals({ source, destination: path, apply: true });
  assert.deepEqual(readFileSync(source), before); assert.deepEqual(readFileSync(applied.backup), before);
  assert.deepEqual(readChangeProposals(path, sample.proposal_id).proposals, [sample]);
  const checked = checkToubaProjectState({ projectRoot: root });
  assert.equal(checked.status, "structurally_valid");
  assert.equal(checked.stores.find(item => item.store === "changeProposalsPath").records, 1);
  assert.throws(() => migrateChangeProposals({ source, destination: path, apply: true }), /already exists/);
  writeFileSync(source, JSON.stringify({ ...document, proposals: [sample, sample] }));
  assert.throws(() => migrateChangeProposals({ source, destination: path + ".sqlite" }), /duplicate/);
});

test("change pages preserve HTTP authentication, status and cursor validation", async t => {
  const { root, path } = fixture(t, 55);
  const tokenName = `TOUBA_CHANGE_PAGE_TEST_${process.pid}`;
  process.env[tokenName] = "isolated-change-page-token";
  const service = createToubaProjectServer({ projectRoot: root, contractsRoot,
    authTokenEnv: tokenName, quiet: true, port: 0 });
  try {
    await service.start();
    const base = `http://127.0.0.1:${service.server.address().port}`;
    const headers = { authorization: "Bearer isolated-change-page-token" };
    assert.equal((await fetch(base + "/changes")).status, 401);
    const first = await (await fetch(base + "/changes", { headers })).json();
    assert.equal(first.changes.length, 50);
    const last = await (await fetch(`${base}/changes?cursor=${first.pagination.next_cursor}`, { headers })).json();
    assert.equal(last.changes.length, 5); assert.equal(last.pagination.next_cursor, null);
    const filtered = await (await fetch(base + "/changes?status=pending", { headers })).json();
    assert.equal(filtered.changes.length, 28);
    for (const query of ["limit=0", "limit=101", "limit=no", "cursor=-1", "cursor=1%20OR%201=1", "status=deleted"]) {
      const response = await fetch(`${base}/changes?${query}`, { headers });
      assert.equal(response.status, 400, query);
      assert.equal((await response.json()).code, "ToubaServeChangePageInvalid");
    }
  } finally { await service.stop(); delete process.env[tokenName]; }
});
