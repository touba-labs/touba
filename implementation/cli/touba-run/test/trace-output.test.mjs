import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeChunks, writeTraceFile } from "../src/trace-output.mjs";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { validateTraceMachineContract } from "../../../contracts/machine/contracts.mjs";
import { validateRunResult } from "../../../contracts/run-outcome.mjs";
import { ToubaEngine } from "../../../runtime/touba-handler-sdk/src/index.mjs";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { buildRunSummary } from "../src/trace-summary.mjs";
import { traceCommand } from "../src/trace-command.mjs";

const compiler = fileURLToPath(new URL("../../../target/debug/touba-compile", import.meta.url));
const command = fileURLToPath(new URL("../src/run.mjs", import.meta.url));
const cli = fileURLToPath(new URL("../../touba-project/src/main.mjs", import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-trace-output-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "main.tb"), air = join(root, "main.air.json"), database = join(root, "traces.sqlite");
  writeFileSync(source, 'module traces.test\nstrategy Run\n    gives Text\n    do\n        give "stored"\n');
  writeFileSync(air, execFileSync(compiler, [source]));
  return { root, source, air, database };
}

test("trace archival requires an existing standalone journal and an explicit apply", t => {
  const { root, air, database } = fixture(t);
  assert.throws(() => traceCommand(["archive", "--store", database]), /does not exist/);
  const child = spawnSync(process.execPath, [command, air, "--trace-store", database, "--output", "json-reference"], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const reference = JSON.parse(child.stdout).trace_reference;
  const destination = join(root, "archive.sqlite");
  assert.equal(traceCommand(["archive", "--store", database]).report.status, "preview");
  assert.throws(() => traceCommand(["archive", "--store", database, "--apply"]));
  writeFileSync(join(root, "sandbox-checkpoints.sqlite"), "linked-state-sentinel");
  assert.throws(() => traceCommand(["archive", "--store", database, "--destination", destination, "--apply"]), /state archival/);
  assert.equal(existsSync(destination), false);
  rmSync(join(root, "sandbox-checkpoints.sqlite"));
  assert.equal(traceCommand(["archive", "--store", database, "--destination", destination, "--apply"]).report.status, "archived");
  assert.equal(traceCommand(["read", "--store", destination, "--reference-json", JSON.stringify(reference)]).report.done, true);
});

test("CLI SQLite storage survives exit and keeps JSON outputs compatible", t => {
  const { root, air, database } = fixture(t);
  for (const mode of ["show", "result", "trace", "json", "all", "run-summary"]) {
    const output = join(root, `${mode}.trace.json`);
    const evidencePath = join(root, `${mode}.evidence.json`);
    const child = spawnSync(process.execPath, [command, air, "--trace-store", database, "--trace-out", output, "--evidence-out", evidencePath, "--output", mode], { encoding: "utf8" });
    assert.equal(child.status, 0, child.stderr);
    const trace = JSON.parse(readFileSync(output, "utf8"));
    validateTraceMachineContract(trace);
    if (mode === "trace") assert.deepEqual(JSON.parse(child.stdout), trace);
    if (mode === "json") assert.deepEqual(validateRunResult(JSON.parse(child.stdout)).trace, trace);
    if (mode === "result") assert.equal(JSON.parse(child.stdout), "stored");
    if (mode === "run-summary") {
      const summary = JSON.parse(child.stdout);
      assert.equal(summary.status, "succeeded");
      assert.equal(summary.started_at, trace.events[0].observed_at);
      assert.equal(summary.completed_at, trace.events.at(-1).observed_at);
    }
    const evidence = JSON.parse(readFileSync(evidencePath, "utf8"));
    assert.equal(evidence.trace.events_count, trace.events.length);
    assert.equal(evidence.trace.digest.value, createHash("sha256").update(JSON.stringify(trace)).digest("hex"));
    assert.equal(evidence.run.terminal_event, "run_completed");
    if (process.platform !== "win32") assert.equal(statSync(output).mode & 0o777, 0o600);
  }
  const store = createSqliteTraceStore({ filename: database });
  try {
    const segments = [...store.segments()];
    assert.equal(segments.length, 6);
    assert.ok(segments.every(segment => segment.complete));
  } finally { store.close(); }
});

test("summary reads an immutable prefix and never materializes its document", () => {
  const events = [
    { kind: "run_started", observed_at: "2026-10-24T10:00:00.000Z" },
    { kind: "human_approval_paused", payload: { approval_ref: "a" } },
    { kind: "human_approval_paused", payload: { approval_ref: "b", mode: "agent_review" } },
    { kind: "human_approval_paused", payload: { approval_ref: "a" } },
    { kind: "human_approval_paused", payload: { approval_ref: "c" } },
    { kind: "human_approval_decided", payload: { approval_ref: "c" } },
    { kind: "human_approval_paused", payload: { approval_ref: "c" } },
    { kind: "call_completed", payload: { target_ref: "tool:Write" }, air_ref: { node_id: "x", flow_graph_ref: "f" } },
    { kind: "call_completed", payload: { target_ref: "tool:Write" }, air_ref: { node_id: "x", flow_graph_ref: "f" } },
    { kind: "agent_decision_provider_call_attempted" },
    { kind: "budget_consumed", payload: { budget_kind: "max_steps", consumed_value: 10 } },
    { kind: "dispatch_refused_budget_exceeded", message: "quota", payload: { runtime_error_code: "ToolCallBudgetExceeded", target_ref: "tool:Write" } },
    { kind: "run_completed", observed_at: "2026-10-24T10:00:01.000Z" },
  ];
  const trace = { run: { run_id: "r", entry_ref: "skill:x" }, events };
  const reader = { header: { run: trace.run }, *events() { yield* events; } };
  const result = { status: "stopped", traceReader: reader, get trace() { throw new Error("full read forbidden"); } };
  const summary = buildRunSummary(result);
  assert.deepEqual(summary, buildRunSummary({ status: "stopped", trace }));
  assert.equal(summary.status, "review_pending");
  assert.deepEqual(summary.approvals_pending, ["a", "b", "a"]);
  assert.deepEqual(summary.budgets, { steps_used: 10, tool_calls_used: 2, provider_calls_used: 1 });
  assert.deepEqual(summary.refusals, [{ code: "ToolCallBudgetExceeded", message: "quota", source_ref: "tool:Write" }]);
  assert.equal(summary.completed_at, null);
  assert.throws(() => buildRunSummary(result, {}, { maxBytes: 1 }), { code: "TraceSummaryLimitExceeded" });
});

test("summary collection limits do not depend on pure event volume", () => {
  const reader = {
    header: { run: { run_id: "r", entry_ref: "skill:x" } },
    *events() {
      for (let i = 0; i < 100000; i++) yield { kind: "binding_created", air_ref: { node_id: "x", flow_graph_ref: "f" } };
    },
  };
  const summary = buildRunSummary({ status: "success", traceReader: reader }, {}, { maxBytes: 10 });
  assert.equal(summary.budgets.steps_used, 1);
  for (const kind of ["tool_refused", "human_approval_decided", "human_approval_paused", "scope_entered"]) {
    let reads = 0;
    reader.events = function* () {
      for (let i = 0; i < 10000; i++) {
        reads++;
        yield { kind, payload: { approval_ref: `a${i}` }, air_ref: { node_id: `n${i}`, flow_graph_ref: "f" } };
      }
    };
    assert.throws(() => buildRunSummary({ status: "success", traceReader: reader }, {}, { maxBytes: 1024 }), { code: "TraceSummaryLimitExceeded" });
    assert.ok(reads < 1000);
  }
});

test("an export cannot replace its own SQLite evidence, including on refusal", t => {
  const { air, database } = fixture(t);
  let child = spawnSync(process.execPath, [command, air, "--trace-store", database], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const before = readFileSync(database);
  child = spawnSync(process.execPath, [command, air, "--trace-store", database, "--trace-out", database], { encoding: "utf8" });
  assert.equal(child.status, 1);
  assert.match(child.stderr, /own database path/);
  assert.deepEqual(readFileSync(database), before);
});

test("a failed streamed export leaves the previous file and no temporary artifact", async t => {
  const { root } = fixture(t);
  const output = join(root, "evidence.json");
  writeFileSync(output, "previous evidence");
  await assert.rejects(writeTraceFile(output, { *json() { yield "prefix"; throw new Error("read failure"); } }), /read failure/);
  assert.equal(readFileSync(output, "utf8"), "previous evidence");
  assert.equal(readdirSync(root).some(file => file.endsWith(".tmp")), false);
});

test("storage failure after an actual handler never becomes false admission evidence", t => {
  const { root, source, air, database } = fixture(t);
  createSqliteTraceStore({ filename: database }).close();
  const db = new DatabaseSync(database);
  db.exec("CREATE TRIGGER fail_after_handler BEFORE INSERT ON touba_trace_events WHEN NEW.kind='call_completed' BEGIN SELECT RAISE(ABORT,'injected storage fault after handler'); END;");
  db.close();
  writeFileSync(source, 'module traces.test\ntool Write\n    gives Text\nskill Run\n    gives Text\n    uses Write\n    do\n        Write\n            into value\n        give value\n');
  writeFileSync(air, execFileSync(compiler, [source]));
  const marker = join(root, "effect.txt"), output = join(root, "trace.json"), manifest = join(root, "manifest.json");
  writeFileSync(manifest, JSON.stringify({ manifest_version: "touba-manifest-v1", bindings: {
    "tool:traces.test/Write": { handler: { kind: "process", command: process.execPath, args: ["-e",
      `let input=''; process.stdin.on('data',chunk=>input+=chunk); process.stdin.on('end',()=>{
        const request=JSON.parse(input); require('node:fs').writeFileSync(${JSON.stringify(marker)},'applied');
        process.stdout.write(JSON.stringify({ok:true,value:'done',effect_receipt:{effect_id:request.effect.effect_id,
          request_digest:request.effect.request_digest,outcome:'applied'}})); });`] },
      grants: [], timeout_ms: 2000, max_payload_bytes: 16384,
      effect_contract: { kind: "external_write", retry_mode: "idempotency_key" } },
  } }));
  const child = spawnSync(process.execPath, [command, air, "--manifest", manifest,
    "--effect-journal", join(root, "run.effect-journal.sqlite"), "--trace-store", database, "--trace-out", output, "--output", "json"], { encoding: "utf8" });
  assert.equal(child.status, 1, child.stderr);
  assert.ok(existsSync(marker), child.stderr + child.stdout);
  assert.equal(readFileSync(marker, "utf8"), "applied");
  assert.match(child.stderr, /incomplete trace journal/);
  assert.deepEqual(JSON.parse(child.stdout), { schema_version: "touba-command-error-v1",
    code: "ExecutionInterrupted", stage: "execution" });
  assert.equal(readdirSync(root).includes("trace.json"), false);
  const store = createSqliteTraceStore({ filename: database });
  try {
    const [segment] = [...store.segments()];
    assert.equal(segment.complete, false);
    assert.ok([...store.events(segment.id)].some(event => event.kind === "call_started"));
    assert.ok([...store.events(segment.id)].every(event => event.kind !== "admission_refused"));
  } finally { store.close(); }
});

test("a slow output never queues the next trace chunk before acknowledgement", async () => {
  let pending = 0, consumed = 0, produced = 0;
  const stream = { write(chunk, callback) {
    pending++;
    assert.equal(pending, 1);
    assert.equal(produced, consumed + 1);
    setTimeout(() => { pending--; consumed++; callback(); }, 1);
    return false;
  } };
  function* chunks() { for (let i = 0; i < 10; i++) { produced++; yield String(i); } }
  await writeChunks(stream, chunks());
  assert.equal(consumed, 10);
  await assert.rejects(writeChunks({ write(_chunk, callback) { callback(new Error("closed pipe")); } }, chunks()), /closed pipe/);
});

for (const executionMode of ["process", "persistent"]) test(`JavaScript SDK (${executionMode}) persists the chosen trace store`, async t => {
  const { root, database } = fixture(t);
  const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath, commandArgs: [cli] });
  t.after(() => engine.close());
  const result = await engine.run({ source: "main.tb", traceStore: "traces.sqlite" });
  assert.equal(result.result, "stored");
  const store = createSqliteTraceStore({ filename: database });
  try {
    const segments = [...store.segments()];
    assert.equal(segments.length, 1);
    assert.deepEqual(store.document(segments[0].id), result.trace);
  } finally { store.close(); }
});

for (const executionMode of ["process", "persistent"]) test(`JavaScript SDK (${executionMode}) reads durable traces by pages`, async t => {
  const { root } = fixture(t);
  const engine = new ToubaEngine({ executionMode, projectRoot: root, command: process.execPath, commandArgs: [cli] });
  t.after(() => engine.close());
  const options = { source: "main.tb", traceStore: "traces.sqlite", traceMode: "reference", traceOut: "export.json" };
  const automatic = await engine.run({ ...options, traceStore: undefined });
  assert.equal(automatic.result, "stored");
  assert.ok(existsSync(join(root, ".touba/traces.sqlite")));
  assert.ok((await engine.readTrace({ traceStore: ".touba/traces.sqlite", reference: automatic.traceReference })).events.length);
  const result = await engine.run(options);
  assert.equal(result.result, "stored"); assert.equal(result.trace, null);
  const reference = result.traceReference;
  const before = readFileSync(join(root, "traces.sqlite"));
  const events = []; let after, header;
  while (true) {
    const page = await engine.readTrace({ traceStore: "traces.sqlite", reference, after, limit: 2 });
    header = page.header; events.push(...page.events); after = page.next;
    if (page.done) break;
  }
  const exported = JSON.parse(readFileSync(join(root, "export.json"), "utf8"));
  assert.deepEqual({ ...header, events }, exported);
  assert.equal(reference.trace_digest, "sha256:" + createHash("sha256").update(JSON.stringify(exported)).digest("hex"));
  assert.deepEqual(readFileSync(join(root, "traces.sqlite")), before);
  await assert.rejects(engine.readTrace({ traceStore: "traces.sqlite", reference, after: -2 }), /cursor/);
  await assert.rejects(engine.readTrace({ traceStore: "traces.sqlite", reference: { ...reference, trace_digest: "sha256:" + "0".repeat(64) } }));
});

test("CLI reference output keeps the canonical export and refuses invalid readers before any write", t => {
  const { root, air, database } = fixture(t);
  const args = [command, air, "--output", "json-reference"];
  const automatic = spawnSync(process.execPath, args, { encoding: "utf8" });
  assert.equal(automatic.status, 0, automatic.stderr); assert.equal(existsSync(database), false);
  assert.ok(existsSync(join(root, ".touba/traces.sqlite")));
  const child = spawnSync(process.execPath, [...args, "--trace-store", database], { encoding: "utf8" });
  assert.equal(child.status, 0, child.stderr);
  const result = validateRunResult(JSON.parse(child.stdout));
  assert.equal(result.schema_version, "touba-run-reference-v1");
  assert.equal(Object.hasOwn(result, "trace"), false);
  const readArgs = ["read", "--store", database, "--reference-json", JSON.stringify(result.trace_reference)];
  const page = traceCommand([...readArgs, "--limit", "1"]).report;
  assert.equal(page.events.length, 1); assert.equal(page.done, false);
  for (const flags of [["--limit", "1.5"], ["--after", "999"], ["--limit", "1", "--limit", "2"], ["--unknown", "x"]]) {
    assert.throws(() => traceCommand([...readArgs, ...flags]));
  }
  assert.throws(() => traceCommand(["read", "--store", join(root, "absent.sqlite"), "--reference-json", "{}"]));
  assert.equal(existsSync(join(root, "absent.sqlite")), false);
  const plan = join(root, "plan.json");
  writeFileSync(plan, JSON.stringify({ run_plan_schema_version: "touba-run-plan-v1", air,
    entry_ref: "strategy:traces.test/Run", outputs: { mode: "json-reference" } }));
  const planned = spawnSync(process.execPath, [command, "--run-plan", plan], { encoding: "utf8" });
  assert.equal(planned.status, 0, planned.stderr);
  assert.equal(validateRunResult(JSON.parse(planned.stdout)).schema_version, "touba-run-reference-v1");
  const plannedRun = spawnSync(process.execPath, [command, "--run-plan", plan, "--trace-store", database], { encoding: "utf8" });
  assert.equal(plannedRun.status, 0, plannedRun.stderr);
  assert.equal(validateRunResult(JSON.parse(plannedRun.stdout)).schema_version, "touba-run-reference-v1");
});

test("reference mode preserves pauses, stops, cancellations and runtime failure evidence", async t => {
  const { root, source } = fixture(t);
  const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [cli] });
  t.after(() => engine.close());
  const cases = [
    ["stop", "        stop", {}, "stopped"],
    ["pause", '        ask\n            with prompt as "Continue?"\n            into answer', {}, "stopped"],
    ["cancel", '        ask\n            with prompt as "Continue?"\n            into answer', { cancelOnPause: true }, "cancelled"],
    ["failure", "        give 1 // divisor", { inputs: { divisor: 0 } }, "failure"],
  ];
  for (const [name, body, flags, status] of cases) {
    writeFileSync(source, `module traces.${name}\nstrategy Run\n    takes divisor as Int\n    do\n${body}\n`);
    let reference;
    try {
      const result = await engine.run({ source, inputs: { divisor: 1 }, ...flags, traceStore: "traces.sqlite", traceMode: "reference" });
      assert.notEqual(status, "failure"); assert.equal(result.status, status);
      if (name === "pause") assert.equal(result.pendingInteraction.prompt, "Continue?");
      reference = result.traceReference;
    } catch (error) {
      assert.equal(status, "failure"); assert.equal(error.details.status, status);
      reference = error.details.traceReference;
    }
    const page = await engine.readTrace({ traceStore: "traces.sqlite", reference });
    assert.equal(page.events.at(-1).payload.status, status);
  }
});

test("admission refusal in reference mode retains its full small error trace without a fake segment", async t => {
  const { root, database } = fixture(t);
  const engine = new ToubaEngine({ projectRoot: root, command: process.execPath, commandArgs: [cli] });
  t.after(() => engine.close());
  const { airDocument } = await engine.compile({ source: "main.tb" });
  airDocument.air_schema_version = "unsupported";
  await assert.rejects(engine.run({ airJson: airDocument,
    traceStore: "traces.sqlite", traceMode: "reference" }), error => {
    assert.equal(error.details.status, "failure");
    assert.equal(error.details.traceReference, undefined);
    assert.equal(error.details.trace.run.admission, "refused");
    assert.deepEqual(error.details.trace.events.map(event => event.kind), ["admission_refused"]);
    return true;
  });
  assert.equal(existsSync(database), false);
});
