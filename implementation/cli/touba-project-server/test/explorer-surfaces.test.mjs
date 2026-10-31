import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createProjectExplorerSurface } from "../src/explorer-surface.mjs";
import { createProjectTraceExplorer } from "../src/trace-explorer-surface.mjs";
import { initProject, newModule } from "../../touba-project/src/project.mjs";

test("Explorer serves canonical compiled resources and revision-bound captured sources", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-server-explorer-"));
  initProject({ root }); const module = newModule("sample.main", { root });
  writeFileSync(module.source_path, "module sample.main\nfunction Echo\n    takes value as Text\n    gives Text\n    do\n        give value\n");
  const surface = createProjectExplorerSurface(root);
  try {
    let state;
    for (let i = 0; i < 100; i++) {
      state = surface.state();
      if (state.status !== "loading") break;
      await new Promise(resolve => setTimeout(resolve, 50));
    }
    assert.equal(state.status, "ready", JSON.stringify(state.diagnostics));
    assert.equal(state.schema_version, "touba-project-explorer-state-v1");
    const node = state.graph.nodes.find(item => item.name === "Echo" || item.label === "Echo");
    assert.ok(node, JSON.stringify(state.graph.nodes));
    assert.match(surface.source(node.id, state.graph.revision).text, /function Echo/u);
    assert.throws(() => surface.source(node.id, "stale"), { code: "ToubaServeExplorerRevisionConflict" });
    assert.equal(surface.source("../../.env", state.graph.revision), null);
  } finally { surface.close(); rmSync(root, { recursive: true, force: true }); }
});

test("trace readers isolate identity and tab selection, bound capacity, expire and cancel only their own reader", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-server-traces-")); mkdirSync(join(root, ".touba"));
  writeFileSync(join(root, ".touba", "traces.sqlite"), "test port");
  let instant = 0; const clients = [];
  const surface = createProjectTraceExplorer(root, { now: () => instant, idleMs: 1000, createClient: () => {
    const client = { selected: null, async request(method, args) {
      if (method === "select") this.selected = args.id;
      return this.selected;
    }, async close() { this.closed = true; } }; clients.push(client); return client;
  } });
  const client_id = "isolated-browser-0123456";
  const select = id => ({ client_id, method: "select", args: { id } });
  try {
    assert.equal(await surface.request("user:a", select("a")), "a");
    assert.equal(await surface.request("user:b", select("b")), "b");
    assert.equal(await surface.request("user:a", { client_id, method: "query", args: {} }), "a");
    await assert.rejects(surface.request("user:c", select("c")), { code: "ToubaServeTraceExplorerBusy" });
    await surface.request("user:b", { client_id, method: "cancel", args: {} });
    assert.equal(clients[0].closed, undefined); assert.equal(clients[1].closed, true);
    instant = 1001;
    await surface.request("user:c", select("c")); assert.equal(clients[0].closed, true);
    await assert.rejects(surface.request("user:a", { client_id, method: "delete", args: {} }), { code: "ToubaServeTraceExplorerInvalid" });
    await assert.rejects(surface.request("", select("a")), { code: "ToubaServeTraceExplorerInvalid" });
  } finally { await surface.close(); rmSync(root, { recursive: true, force: true }); }
  assert.ok(clients.every(client => client.closed));
});

test("trace listing is empty before execution and refuses a journal outside the project", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-server-trace-empty-"));
  const surface = createProjectTraceExplorer(root);
  const request = { client_id: "isolated-browser-0123456", method: "list", args: {} };
  try {
    assert.deepEqual(await surface.request("user:a", request), { segments: [], next: null });
    mkdirSync(join(root, "project", ".touba"), { recursive: true }); writeFileSync(join(root, "outside.sqlite"), "do not open");
    symlinkSync(join(root, "outside.sqlite"), join(root, "project", ".touba", "traces.sqlite"));
    const nested = createProjectTraceExplorer(join(root, "project"));
    try { await assert.rejects(nested.request("user:a", request), { code: "ToubaServeTraceExplorerPathRejected" }); }
    finally { await nested.close(); }
  } finally { await surface.close(); rmSync(root, { recursive: true, force: true }); }
});

test('closing readers still occupy capacity until the process exits', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-reader-closing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, '.touba')); writeFileSync(join(root, '.touba/traces.sqlite'), 'fixture');
  let release, created = 0;
  const surface = createProjectTraceExplorer(root, { maxReaders: 1, createClient: () => {
    created++;
    return { request: async () => ({}), close: () => new Promise(resolve => { release = resolve; }) };
  } });
  const body = { client_id: 'reader-capacity-12345', method: 'list', args: {} };
  await surface.request('alice', body);
  const cancelling = surface.request('alice', { ...body, method: 'cancel' });
  await Promise.resolve();
  await assert.rejects(surface.request('bob', body), { code: 'ToubaServeTraceExplorerBusy' });
  await assert.rejects(surface.request('alice', body), { code: 'ToubaServeTraceExplorerBusy' });
  assert.equal(created, 1);
  release(); await cancelling;
  await surface.request('bob', body); assert.equal(created, 2);
  const closing = surface.close(); await Promise.resolve(); release(); await closing;
});
