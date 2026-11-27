import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { once } from "node:events";
import { DatabaseSync } from "node:sqlite";
import { canonicalDigest, executeAirDocument } from "@touba/runtime";
import { NATIVE_TRACE_LIMITS, withNativeTrace, readNativeTraceExport, readNativeTraceIndex, readNativeTracePage, nativeTraceExportChunks, validateNativeTraceExport } from "../src/native-traces.mjs";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";
import { compileTestAir } from "../../../tests/helpers/compile.mjs";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { attachTraceReader } from "../../../runtime/touba-runtime/src/trace-builder.mjs";
import { executeProjectSandboxRun, loadSandboxCheckpointStore } from "../src/serve.mjs";
import { fileURLToPath } from "node:url";


const sample = JSON.parse(readFileSync(new URL("../../../tests/traces/tb-v01-003-branch.trace.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/schemas/touba-run-trace-export-v1.schema.json", import.meta.url), "utf8"));
function result(runId, paused = false) {
  const trace = structuredClone(sample);
  trace.run.run_id = runId;
  for (const event of trace.events) { event.run_id = runId; event.event_id = `event:${runId}:${event.sequence_index + 1}`; }
  return { status: paused ? "stopped" : "success", trace, ...(paused ? { checkpoint: { private: "PRIVATE_CHECKPOINT" } } : {}) };
}
function files(root) { const path = join(root, ".touba"); return readdirSync(path).filter(name => name.endsWith(".sqlite")).map(name => join(path, name)); }
function changeIndex(root, id, action) {
  const db = new DatabaseSync(join(root, ".touba/native-traces.sqlite"));
  try {
    const value = JSON.parse(db.prepare("SELECT body FROM records WHERE id=?").get(id).body);
    db.prepare("UPDATE records SET body=? WHERE id=?").run(JSON.stringify(action(value) ?? value), id);
  } finally { db.close(); }
}
function temporary(t) { const root = mkdtempSync(join(tmpdir(), "touba-native-traces-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

test("a real approval resume retains sealed observation times and detects timestamp tampering", async t => {
  const projectRoot = temporary(t), runId = "run:timestamp-resume";
  const air = JSON.parse(execFileSync("cargo", ["run", "--quiet", "--manifest-path", fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)),
    "-p", "touba-cli", "--bin", "touba-compile", "--", fileURLToPath(new URL("../../../grammar/tree-sitter-touba/examples/human-approval-v1/positive/typed-approval.tb", import.meta.url))], { encoding: "utf8" }));
  const options = { entryRef: "strategy:approval_result/Receipt", runId, inputs: { dossier: "invoice" }, durableHumanApprovals: true };
  const paused = await withNativeTrace({ projectRoot, runId, phase: "initial" }, () => executeAirDocument(air, options));
  assert.equal(paused.reason, "human_approval_pending");
  const initial = readNativeTraceExport(projectRoot, runId).segments[0];
  assert.ok(initial.trace.events.every(event => new Date(event.observed_at).toISOString() === event.observed_at));
  const resumedAt = Date.now();
  const resumed = await withNativeTrace({ projectRoot, runId, phase: "human_resume" }, () => executeAirDocument(air, {
    ...options, inputs: undefined, humanApprovalResumeCheckpoint: structuredClone(paused.checkpoint),
    humanApprovalDecisions: { [paused.checkpoint.approval_ref]: { decision: "approved", evidence_ref: "proof" } },
    humanApprovalAuthority: ({ request, decision }) => ({ request_id: request.request_id, run_id: request.run_id, decision,
      subject_ref: "employee:test", roles: ["finance"] }),
  }));
  assert.equal(resumed.status, "success", JSON.stringify(resumed));
  const completed = readNativeTraceExport(projectRoot, runId);
  assert.deepEqual(completed.segments[0], initial);
  assert.equal(completed.segments[1].previous_digest, initial.digest);
  assert.ok(completed.segments[1].trace.events.every(event => Date.parse(event.observed_at) >= resumedAt));
  completed.segments[0].trace.events[0].observed_at = "2000-01-01T00:00:00.000Z";
  assert.throws(() => validateNativeTraceExport(completed), { code: "ToubaServeNativeTraceStoreInvalid" });
});

test("native segments retain exact events and AIR identity, with independent concurrent runs and no private envelope", async t => {
  const projectRoot = temporary(t);
  const original = result("one", true);
  await Promise.all([
    withNativeTrace({ projectRoot, runId: "one", phase: "initial" }, async () => original),
    withNativeTrace({ projectRoot, runId: "two", phase: "initial" }, async () => result("two")),
  ]);
  assert.deepEqual(readNativeTraceExport(projectRoot, "one").segments[0].trace, original.trace);
  assert.equal(readNativeTraceExport(projectRoot, "one").complete, false);
  assert.equal(readNativeTraceExport(projectRoot, "two").complete, true);
  await withNativeTrace({ projectRoot, runId: "one", phase: "human_resume" }, async () => result("one"));
  const exported = readNativeTraceExport(projectRoot, "one");
  assert.equal(exported.complete, true);
  assert.equal(exported.segments[1].previous_digest, exported.segments[0].digest);
  assert.deepEqual(validateObject(schema, exported), []);
  assert.equal(exported.segments[1].trace.events[0].sequence_index, original.trace.events[0].sequence_index);
  assert.doesNotMatch(JSON.stringify(exported), /PRIVATE_CHECKPOINT/);
  assert.equal(readNativeTraceExport(projectRoot, "absent"), null);
  assert.ok(files(projectRoot).every(file => (statSync(file).mode & 0o777) === 0o600));
  await assert.rejects(withNativeTrace({ projectRoot, runId: "one", phase: "initial" }, async () => result("one")), { code: "ToubaServeNativeTraceRunConflict" });
});

test("native export rejects corruption, a forged completeness flag and cross-run identities", async t => {
  const projectRoot = temporary(t);
  await withNativeTrace({ projectRoot, runId: "one", phase: "initial" }, async () => result("one"));
  const valid = readNativeTraceExport(projectRoot, "one");
  changeIndex(projectRoot, "one", value => { value.segments[0].reference.trace_digest = "sha256:" + "0".repeat(64); });
  assert.throws(() => readNativeTraceExport(projectRoot, "one"), { code: "ToubaServeNativeTraceStoreInvalid" });
  assert.throws(() => validateNativeTraceExport({ ...valid, complete: false }), { code: "ToubaServeNativeTraceStoreInvalid" });
  await withNativeTrace({ projectRoot, runId: "other", phase: "initial" }, async () => result("wrong"));
  const rejected = readNativeTraceExport(projectRoot, "other");
  assert.equal(rejected.complete, false);
  assert.equal(rejected.segments[0].reason, "trace_rejected");
  assert.equal(rejected.segments[0].trace, null);
});

test("native trace storage never writes or exports a known secret or raw prompt", async t => {
  const projectRoot = temporary(t);
  for (const [runId, secret] of [["secret", "private\ncredential-123"], ["prompt", null]]) {
    const output = result(runId);
    if (secret) output.trace.events[0].message = secret;
    else output.trace.events[0].payload = { raw_prompt: "PRIVATE_PROMPT" };
    await withNativeTrace({ projectRoot, runId, phase: "initial", secretValues: secret ? [secret] : [] }, async () => output);
    assert.equal(readNativeTraceExport(projectRoot, runId).segments[0].reason, "trace_rejected");
  }
  for (const file of files(projectRoot)) assert.doesNotMatch(readFileSync(file, "utf8"), /credential-123|PRIVATE_PROMPT/);
});

test("native storage refuses a full index before executing", async t => {
  const projectRoot = temporary(t);
  await withNativeTrace({ projectRoot, runId: "one", phase: "initial" }, async () => result("one"));
  const db = new DatabaseSync(join(projectRoot, ".touba/native-traces.sqlite"));
  try {
    // Fill real SQLite pages, not a fictitious run count. The generic store
    // also tests rollback on SQLITE_FULL during an attempted transaction.
    db.exec("CREATE TABLE quota_fixture (body BLOB)");
    db.prepare("INSERT INTO quota_fixture VALUES (zeroblob(?))").run(NATIVE_TRACE_LIMITS.bytes);
  } finally { db.close(); }
  let executed = false;
  await assert.rejects(withNativeTrace({ projectRoot, runId: "next", phase: "initial" }, async () => { executed = true; return result("next"); }), { code: "ToubaServeNativeTraceStorageFull" });
  assert.equal(executed, false);
});

test("native index admission uses its byte quota beyond 1024 metadata records", async t => {
  const projectRoot = temporary(t);
  await withNativeTrace({ projectRoot, runId: "one", phase: "initial" }, async () => result("one"));
  const db = new DatabaseSync(join(projectRoot, ".touba/native-traces.sqlite"));
  try {
    const body = { index: 0, phase: "initial", state: "unavailable", reason: "runtime_rejected", previous_digest: null, reference: null };
    const segment = { ...body, digest: canonicalDigest(body) };
    db.exec("BEGIN");
    const insert = db.prepare("INSERT INTO records VALUES (?,1,?)");
    // Metadata-only fixtures exercise storage cardinality, not completed runs.
    for (let i = 0; i < 1100; i++) {
      const runId = `metadata:${i}`;
      insert.run(runId, JSON.stringify({ schema_version: "touba-native-trace-index-v1", run_id: runId, complete: false, segments: [segment] }));
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  let executed = 0;
  await withNativeTrace({ projectRoot, runId: "next", phase: "initial" }, async () => { executed++; return result("next"); });
  assert.equal(executed, 1);
  assert.equal(readNativeTraceIndex(projectRoot, "next").complete, true);
  assert.equal(readNativeTraceIndex(projectRoot, "metadata:1099").complete, false);
});

test("SIGKILL preserves an incomplete native segment without inventing crash evidence", async t => {
  const projectRoot = temporary(t);
  const moduleUrl = new URL("../src/native-traces.mjs", import.meta.url).href;
  const child = spawn(process.execPath, ["--input-type=module", "-e", `
    import {withNativeTrace} from ${JSON.stringify(moduleUrl)};
    setInterval(() => {}, 1000);
    await withNativeTrace(${JSON.stringify({ projectRoot, runId: "crashed", phase: "initial" })}, async () => {
      process.send("recording"); await new Promise(() => {});
    });`], { stdio: ["ignore", "ignore", "pipe", "ipc"] });
  const exit = once(child, "exit");
  t.after(() => child.kill("SIGKILL"));
  await once(child, "message");
  child.kill("SIGKILL");
  await exit;
  assert.equal(readNativeTraceExport(projectRoot, "crashed").segments[0].state, "recording");
  await withNativeTrace({ projectRoot, runId: "crashed", phase: "execution_resume" }, async () => result("crashed"));
  const evidence = readNativeTraceExport(projectRoot, "crashed");
  assert.equal(evidence.complete, false);
  assert.equal(evidence.segments[0].trace, null);
  assert.equal(evidence.segments[1].state, "terminal");
});

test("segment seals follow the canonical machine digest", () => {
  const fixture = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/fixtures/valid/touba-run-trace-export-v1.json", import.meta.url), "utf8"));
  validateNativeTraceExport(fixture);
  const { digest, ...body } = fixture.segments[0];
  assert.equal(digest, canonicalDigest(body));
});

test("native export consumes a journal reader without invoking its full-document getter", async t => {
  const projectRoot = temporary(t), original = result("bounded-reader");
  const store = createSqliteTraceStore({ filename: join(projectRoot, "traces.sqlite"), maxDocumentBytes: 1 });
  try {
    const { events, ...header } = original.trace;
    const id = store.openSegment(header, events[0].sequence_index);
    for (const event of events) store.append(id, event);
    const output = attachTraceReader({ status: original.status }, store.snapshot(id));
    assert.throws(() => output.trace, { code: "TraceMaterializationLimitExceeded" });
    await withNativeTrace({ projectRoot, runId: "bounded-reader", phase: "initial" }, async () => output);
    const exported = readNativeTraceExport(projectRoot, "bounded-reader");
    assert.equal(exported.complete, true);
    assert.deepEqual(exported.segments[0].trace, original.trace);
  } finally { store.close(); }
});

test("a failed trace getter does not replace an acquired runtime result with an export exception", async t => {
  const projectRoot = temporary(t);
  const output = { status: "success", get trace() { throw new Error("unreadable"); } };
  assert.equal(await withNativeTrace({ projectRoot, runId: "unreadable", phase: "initial" }, async () => output), output);
  const exported = readNativeTraceExport(projectRoot, "unreadable");
  assert.equal(exported.complete, false);
  assert.equal(exported.segments[0].reason, "trace_rejected");
});

test("large native exports are paged and streamed beyond the materialization limit", async t => {
  const projectRoot = temporary(t), original = result("large-reader");
  const storage = createSqliteTraceStore({ filename: join(projectRoot, "traces.sqlite"), maxDocumentBytes: 1 });
  try {
    const { events, ...header } = original.trace;
    const id = storage.openSegment(header, 0);
    storage.append(id, events[0]);
    for (let index = 1; index <= 12; index++) storage.append(id, {
      event_id: `event:large-reader:${index + 1}`, run_id: "large-reader", sequence_index: index,
      kind: "binding_created", payload: { binding_ref: "binding:test", detail: "x".repeat(800 * 1024) },
    });
    storage.append(id, { ...events.at(-1), event_id: "event:large-reader:14", sequence_index: 13 });
    const reader = storage.snapshot(id);
    const output = attachTraceReader({ status: "success" }, reader);
    assert.equal(await withNativeTrace({ projectRoot, runId: "large-reader", phase: "initial" }, async () => output), output);
    const index = readNativeTraceIndex(projectRoot, "large-reader");
    const indexSchema = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/schemas/touba-native-trace-index-v1.schema.json", import.meta.url)));
    assert.deepEqual(validateObject(indexSchema, index), []);
    assert.equal(index.complete, true);
    assert.equal(index.segments[0].reason, null);
    assert.throws(() => readNativeTraceExport(projectRoot, "large-reader"), { code: "TraceMaterializationLimitExceeded" });
    let bytes = 0;
    for (const chunk of nativeTraceExportChunks(projectRoot, "large-reader")) bytes += Buffer.byteLength(chunk);
    assert.ok(bytes > NATIVE_TRACE_LIMITS.runBytes);
    let after = -1, count = 0;
    while (true) {
      const page = readNativeTracePage(projectRoot, "large-reader", 0, { after, limit: 2 });
      assert.ok(page.events.length <= 2); count += page.events.length; after = page.next;
      if (page.done) break;
    }
    assert.equal(count, 14);
    assert.equal(storage.snapshot(id).complete, true);
    assert.equal([...storage.snapshot(id).events()].length, 14);
    assert.throws(() => output.trace, { code: "TraceMaterializationLimitExceeded" });
  } finally { storage.close(); }
});

for (const large of [false, true]) test(`a compiled project uses bounded projections (${large ? "large pure loop" : "sequential checkpoints"})`, async t => {
  const projectRoot = temporary(t);
  const targetRef = "strategy:bounded_server/Run";
  mkdirSync(join(projectRoot, "src"));
  mkdirSync(join(projectRoot, ".touba/air"), { recursive: true });
  const source = join(projectRoot, "src/main.tb");
  writeFileSync(source, large ? `module bounded_server
function Work
    takes items as List of Text
    gives Text
    do
        for item in items
${Array.from({ length: 15 }, (_, i) => `            bind observed${i} as Text = item`).join("\n")}
        give "retained"
strategy Run
    gives Text
    uses Work
    do
        Work
            with items as [${Array(80).fill('"item"').join(", ")}]
            into value
        give value
` : 'module bounded_server\nstrategy Run\n    gives Text\n    do\n        bind value as Text = "retained"\n        give value\n');
  writeFileSync(join(projectRoot, "touba.project.json"), JSON.stringify({ entry: targetRef }));
  const air = compileTestAir(source);
  writeFileSync(join(projectRoot, ".touba/air/main.air.json"), JSON.stringify(air));
  const traceStorage = createSqliteTraceStore({ filename: join(projectRoot, "traces.sqlite"), maxDocumentBytes: 1 });
  try {
    const output = await executeProjectSandboxRun({
      projectRoot, traceStorage, executionKind: "entrypoint", runId: "sequential-reader", operationId: "operation:sequential-reader",
      contractsRoot: fileURLToPath(new URL("../../../contracts/product-surfaces/", import.meta.url)),
      request: { schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint", target_ref: targetRef,
        effect_policy: "runtime_only", inputs: {}, requested_by: { kind: "service", id: "trace-test" }, reason: "Validate checkpoint readers." },
    });
    assert.equal(output.status, "success", JSON.stringify(output));
    assert.equal(output.result, "retained");
    const stored = loadSandboxCheckpointStore(join(projectRoot, ".touba/sandbox-checkpoints.sqlite"));
    // The direct sequential graph has durable checkpoints. The pure loop is
    // used here to qualify projection volume, not broaden resume admission.
    assert.equal(stored.records.length, large ? 0 : 1);
    if (!large) assert.equal(stored.records[0].status, "completed");
    const [segment] = traceStorage.segments({ runId: output.run_id });
    assert.equal(output.trace.event_count, segment.eventCount);
    if (large) {
      assert.ok(output.trace.event_count > 1000);
      assert.equal(output.trace.events.length, 200);
      assert.equal(output.trace.events_truncated, true);
    } else assert.ok(stored.records[0].trace_prefix.events.length <= 200);
    assert.throws(() => traceStorage.document(segment.id), { code: "TraceMaterializationLimitExceeded" });
    const exported = readNativeTraceExport(projectRoot, output.run_id);
    assert.equal(exported.complete, true);
    assert.equal(exported.segments[0].trace.events.length, segment.eventCount);
  } finally { traceStorage.close(); }
});

test("historical resumes stay incomplete and the segment limit preserves retained evidence", async t => {
  const projectRoot = temporary(t);
  await withNativeTrace({ projectRoot, runId: "historical", phase: "human_resume" }, async () => result("historical"));
  assert.equal(readNativeTraceExport(projectRoot, "historical").complete, false);
  const interrupted = { schema_version: "touba-native-trace-index-v1", run_id: "historical", complete: false, segments: [] };
  for (let index = 0; index < NATIVE_TRACE_LIMITS.segments; index++) {
    const body = { index, phase: index ? "execution_resume" : "initial", state: "recording", reason: "not_completed", previous_digest: interrupted.segments.at(-1)?.digest ?? null, reference: null };
    interrupted.segments.push({ ...body, digest: canonicalDigest(body) });
  }
  const retained = JSON.stringify(interrupted);
  changeIndex(projectRoot, "historical", () => interrupted);
  let executed = false;
  await assert.rejects(withNativeTrace({ projectRoot, runId: "historical", phase: "execution_resume" }, async () => { executed = true; }), { code: "ToubaServeNativeTraceStorageFull" });
  assert.equal(executed, false);
  assert.equal(JSON.stringify(readNativeTraceIndex(projectRoot, "historical")), retained);
});
