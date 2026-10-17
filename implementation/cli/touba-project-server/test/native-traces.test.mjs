import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, statSync, truncateSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { canonicalDigest } from "@touba/runtime";
import { NATIVE_TRACE_LIMITS, withNativeTrace, readNativeTraceExport, validateNativeTraceExport } from "../src/native-traces.mjs";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";

const sample = JSON.parse(readFileSync(new URL("../../../tests/traces/tb-v01-003-branch.trace.json", import.meta.url), "utf8"));
const schema = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/schemas/touba-run-trace-export-v1.schema.json", import.meta.url), "utf8"));
function result(runId, paused = false) {
  const trace = structuredClone(sample);
  trace.run.run_id = runId;
  for (const event of trace.events) { event.run_id = runId; event.event_id = `event:${runId}:${event.sequence_index + 1}`; }
  return { status: paused ? "stopped" : "success", trace, ...(paused ? { checkpoint: { private: "PRIVATE_CHECKPOINT" } } : {}) };
}
function files(root) { const path = join(root, ".touba/native-traces"); return readdirSync(path).map(name => join(path, name)); }
function temporary(t) { const root = mkdtempSync(join(tmpdir(), "touba-native-traces-")); t.after(() => rmSync(root, { recursive: true, force: true })); return root; }

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
  const corrupted = structuredClone(valid);
  corrupted.segments[0].trace.events[0].kind = "forged";
  writeFileSync(files(projectRoot)[0], JSON.stringify(corrupted));
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

test("native storage bounds large segments and refuses a full store before executing", async t => {
  const projectRoot = temporary(t);
  const large = result("large");
  const template = large.trace.events[0];
  const terminal = large.trace.events.at(-1);
  large.trace.events = Array.from({ length: 2200 }, (_, i) => ({ ...template, event_id: `event:large:${i + 1}`, sequence_index: i, message: "x".repeat(4096) }));
  large.trace.events.push({ ...terminal, event_id: "event:large:2201", sequence_index: 2200 });
  await withNativeTrace({ projectRoot, runId: "large", phase: "initial" }, async () => large);
  assert.equal(readNativeTraceExport(projectRoot, "large").segments[0].reason, "storage_limit");
  const path = files(projectRoot)[0];
  assert.ok(statSync(path).size < NATIVE_TRACE_LIMITS.runBytes);
  truncateSync(path, NATIVE_TRACE_LIMITS.bytes);
  let executed = false;
  await assert.rejects(withNativeTrace({ projectRoot, runId: "next", phase: "initial" }, async () => { executed = true; return result("next"); }), { code: "ToubaServeNativeTraceStorageFull" });
  assert.equal(executed, false);
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

test("historical resumes stay incomplete and the segment limit preserves retained evidence", async t => {
  const projectRoot = temporary(t);
  await withNativeTrace({ projectRoot, runId: "historical", phase: "human_resume" }, async () => result("historical"));
  assert.equal(readNativeTraceExport(projectRoot, "historical").complete, false);
  const interrupted = { schema_version: "touba-run-trace-export-v1", run_id: "historical", complete: false, segments: [] };
  for (let index = 0; index < NATIVE_TRACE_LIMITS.segments; index++) {
    const body = { index, phase: index ? "execution_resume" : "initial", state: "recording", reason: "not_completed", previous_digest: interrupted.segments.at(-1)?.digest ?? null, trace: null };
    interrupted.segments.push({ ...body, digest: canonicalDigest(body) });
  }
  const retained = JSON.stringify(interrupted);
  writeFileSync(files(projectRoot)[0], retained);
  let executed = false;
  await assert.rejects(withNativeTrace({ projectRoot, runId: "historical", phase: "execution_resume" }, async () => { executed = true; }), { code: "ToubaServeNativeTraceStorageFull" });
  assert.equal(executed, false);
  assert.equal(readFileSync(files(projectRoot)[0], "utf8"), retained);
});
