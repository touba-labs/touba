import assert from "node:assert/strict";
import { readStoreFixture, writeStoreFixture } from "./store-fixtures.mjs";
import { completedCheckpointCount, corruptLastCheckpoint, restoreHttpHistoryFixture } from "./http-history-fixture.mjs";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  statSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { monitorEventLoopDelay } from "node:perf_hooks";
import { execFile, execFileSync } from "node:child_process";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";

import { canonicalDigest } from "@touba/runtime";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";

import {
  createToubaProjectServer,
  checkToubaProjectState,
  loadSandboxCheckpointStore,
  readProjectEventJournal,
} from "../src/serve.mjs";
import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
} from "../../../contracts/machine/contracts.mjs";

const contractsRoot = fileURLToPath(new URL("../../../contracts/product-surfaces/", import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const WAIT_TARGET = "strategy:demo.approval/RunApproval";
const PURE_TARGET = "strategy:demo.approval/RunPure";
const SENTINEL_TARGET = "strategy:demo.approval/RunSentinel";
const REVIEW_TARGET = "strategy:demo.review/RunReview";
const USER_REF = "user:test-reviewer";
const DEVICE_REF = "device:test-suite";

for (const journal of [false, true]) for (const delegated of [false, true]) test(`compiled ${delegated ? "agent-selected" : "source"} continuation survives server restart and validates persisted scopes (${journal ? "host SQLite journal" : "default SQLite journal"})`, async t => {
  const root = createTestProject();
  const traceStorage = journal ? createSqliteTraceStore({ filename: join(root, "traces.sqlite"), maxDocumentBytes: 1 }) : undefined;
  const longContinuation = journal && !delegated;
  t.after(() => { traceStorage?.close(); rmSync(root, { recursive: true, force: true }); });
  const source = join(root, "src/demo/approval.tb");
  writeFileSync(source, `module demo.approval
strategy Child
    description "Obtain approval before returning this value."
    takes value as Text
    gives Text
    do
        human.approve
            with context as value
            into approval
${longContinuation ? `        for item in [${Array(80).fill('"item"').join(", ")}]
            bind first as Text = item
            bind second as Text = item
            bind third as Text = item
` : ""}        give value
${delegated ? `agent Coordinator
    takes value as Text
    gives Text
    responsibility "Delegate approval and return the reviewed result."
    uses Child
    callable_by strategy RunApproval
` : ""}
strategy RunApproval
    gives Text
    uses ${delegated ? "Coordinator" : "Child"}
    do
        ${delegated ? "Coordinator" : "Child"}
            with value as "nested request"
            into reviewed
        give reviewed
`);
  const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
    fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--", source], { encoding: "utf8" }));
  writeJson(join(root, ".touba/air/demo/approval.air.json"), air);
  const steps = [];
  const agentDecisionProvider = delegated ? request => {
    if (request.mode === "summary") return { action: "request_capabilities" };
    steps.push(request.step_index);
    return request.step_index === 0
      ? { target_ref: "strategy:demo.approval/Child", arguments: { value: request.inputs.value } }
      : { action: "answer_directly", result: request.observations[0].value };
  } : undefined;
  let service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true, agentDecisionProvider, traceStorage });
  try {
    await service.start();
    const paused = await runSandbox(serverBaseUrl(service), WAIT_TARGET);
    const pending = await getJson(`${serverBaseUrl(service)}/approvals/pending/current`);
    await service.stop();
    const path = join(root, ".touba/sandbox-checkpoints.sqlite");
    const originPath = join(root, ".touba/state-origin.json");
    const originalOrigin = readFileSync(originPath, "utf8");
    const beforePreflight = readFileSync(path);
    const checked = checkToubaProjectState({ projectRoot: root });
    assert.equal(checked.status, "structurally_valid");
    assert.equal(checked.origin.status, "matching");
    assert.equal(checked.stores.find(store => store.store === "sandboxCheckpointsPath").active_waits, 1);
    assert.deepEqual(readFileSync(path), beforePreflight, "preflight must not terminalize or rewrite a wait");
    const wrongBuild = { ...JSON.parse(originalOrigin), build_id: "0".repeat(64) };
    writeFileSync(originPath, JSON.stringify(wrongBuild));
    assert.equal(checkToubaProjectState({ projectRoot: root }).diagnostics[0].code, "ToubaServeStateBuildMismatch");
    assert.throws(() => createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true }), { code: "ToubaServeStateBuildMismatch" });
    writeFileSync(originPath, JSON.stringify({ ...wrongBuild, project_root: join(root, "different-project") }));
    assert.equal(checkToubaProjectState({ projectRoot: root }).diagnostics[0].code, "ToubaServeStateProjectMismatch");
    writeFileSync(originPath, originalOrigin);
    const stored = readStoreFixture(path);
    assert.equal(stored.records[0].checkpoint.call_stack.length, delegated ? 2 : 1);
    for (const corrupt of [f => { delete f.caller_scope; }, f => { delete f.caller_scope.values; },
      f => { delete f.caller_scope.loop_state; }, f => { f.caller_scope.input_value_keys = ["missing"]; },
      f => { f.caller_scope.active_agent_ref = 42; }, f => { f.kind = "invented"; }]) {
      const invalid = structuredClone(stored); corrupt(invalid.records[0].checkpoint.call_stack[0]);
      writeJson(path, invalid);
      const bytes = readFileSync(path);
      assert.throws(() => createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true, agentDecisionProvider }),
        { code: "ToubaServeSandboxCheckpointStoreInvalid" });
      assert.deepEqual(readFileSync(path), bytes);
    }
    if (delegated) for (const corrupt of [
      f => { delete f.max_steps; }, f => { f.observations = [{}]; }, f => { f.next_step_index = 0; },
      f => { f.arguments = null; }, f => { f.capability_refs = null; },
    ]) {
      const invalid = structuredClone(stored); corrupt(invalid.records[0].checkpoint.call_stack[1]);
      writeJson(path, invalid);
      const bytes = readFileSync(path);
      assert.throws(() => createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true, agentDecisionProvider }),
        { code: "ToubaServeSandboxCheckpointStoreInvalid" });
      assert.deepEqual(readFileSync(path), bytes);
    }
    // Restore the exact test snapshot. No recovery or effect ran while corrupted.
    writeJson(path, stored);
    service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true, agentDecisionProvider, traceStorage });
    await service.start();
    const base = serverBaseUrl(service);
    assert.equal((await postJson(`${base}/decisions`, decisionFor(pending))).status, 202);
    const resumed = await postJson(`${base}/runs/sandbox/resume`, { request_id: pending.request_id });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    const completed = await resumed.json();
    assert.equal(completed.status, "success", JSON.stringify(completed));
    assert.equal(completed.run_id, paused.run_id);
    assert.equal(completed.result, "nested request");
    if (longContinuation) {
      assert.ok(completed.trace.event_count > 200);
      assert.equal(completed.trace.events.length, 200);
      assert.ok(completed.trace.approval_evidence.length > 0);
      await service.stop();
      service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true, traceStorage });
      await service.start();
      assert.equal(checkToubaProjectState({ projectRoot: root }).status, "structurally_valid");
    }
    if (traceStorage) {
      const segments = [...traceStorage.segments({ runId: completed.run_id })];
      assert.equal(segments.length, 2);
      for (const segment of segments) assert.throws(() => traceStorage.document(segment.id), { code: "TraceMaterializationLimitExceeded" });
    }
    if (delegated) assert.deepEqual(steps, [0, 1]);
  } finally { await service.stop(); }
});

test("native parallel approval continuations survive project-server restart and release one occurrence at a time", async t => {
  const root = createTestProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, "src/demo/approval.tb");
  writeFileSync(path, `module demo.approval
skill Review
    takes value as Text
    gives Text
    do
        human.approve
            with context as value
            into approval
        give value
strategy RunApproval
    takes values as List of Text
    gives List of Text
    do
        parallel Review
            each value in values
            with value as value
            max_concurrency 2
            max_items 10
            into results
        give results
`);
  const air = JSON.parse(execFileSync(fileURLToPath(new URL(`../../../target/debug/touba-compile${process.platform === "win32" ? ".exe" : ""}`, import.meta.url)), [path], { encoding: "utf8" }));
  writeJson(join(root, ".touba/air/demo/approval.air.json"), air);
  let service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
  try {
    await service.start();
    const response = await postJson(`${serverBaseUrl(service)}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint", target_ref: WAIT_TARGET,
      effect_policy: "runtime_only", inputs: { values: ["first", "second"] },
      requested_by: { kind: "studio", id: "parallel-test" }, reason: "Verify native parallel continuations.",
    });
    assert.equal(response.status, 200, await response.clone().text());
    let result = await response.json();
    let attempts = 0;
    while (result.status === "stopped" && attempts++ < 4) {
      const pending = await getJson(`${serverBaseUrl(service)}/approvals/pending/current`);
      await service.stop();
      service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
      await service.start();
      const base = serverBaseUrl(service);
      assert.equal((await postJson(`${base}/decisions`, decisionFor(pending))).status, 202);
      const resumed = await postJson(`${base}/runs/sandbox/resume`, { request_id: pending.request_id });
      assert.equal(resumed.status, 200, await resumed.clone().text());
      result = await resumed.json();
    }
    assert.equal(result.status, "success", JSON.stringify(result));
    assert.deepEqual(result.result, ["first", "second"]);
  } finally { await service.stop(); }
});

test("human checkpoint budget omissions and tampering fail before recovery without changing stored bytes", async t => {
  const root = createTestProject({ withSentinel: true });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const marker = join(root, "external-effect.log");
  configureSentinelHandler(root, marker);
  const service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
  try {
    await service.start();
    await runSandbox(serverBaseUrl(service), SENTINEL_TARGET, "allow_declared_external_effects");
  } finally { await service.stop(); }
  const path = join(root, ".touba/sandbox-checkpoints.sqlite");
  const original = readStoreFixture(path);
  for (const mutate of [c => { delete c.active_elapsed_ms; }, c => { delete c.effective_limits; },
    c => { c.active_elapsed_ms = -1; }, c => { c.effective_limits = { max_tool_calls: 0 }; },
    c => { delete c.call_stack; }, c => { c.call_frame = {}; }, c => { c.call_stack = [{ kind: "invented" }]; },
    c => { delete c.loop_state; }, c => { delete c.next_call_index; }, c => { delete c.active_caller_ref; },
    c => { delete c.budget_counters.provider_calls; }]) {
    const altered = structuredClone(original); mutate(altered.records[0].checkpoint);
    writeJson(path, altered);
    const bytes = readFileSync(path);
    assert.throws(() => createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true }),
      { code: "ToubaServeSandboxCheckpointStoreInvalid" });
    assert.deepEqual(readFileSync(path), bytes);
    assert.equal(existsSync(marker), false);
  }
});

test("WAIT cold backup restores a pending decision and native evidence; incomplete historical results fail without rewrite", async () => {
  const root = createTestProject({ withSentinel: true });
  const backup = mkdtempSync(join(tmpdir(), "touba-wait-cold-backup-"));
  const markerPath = join(root, "external-effect.log");
  configureSentinelHandler(root, markerPath);
  let service;
  try {
    service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
    await service.start();
    let base = serverBaseUrl(service);
    const paused = await runSandbox(base, SENTINEL_TARGET, "allow_declared_external_effects");
    const pending = await getJson(`${base}/approvals/pending/current`);
    const evidence = await getJson(`${base}/runs/${paused.run_id}/trace`);
    assert.equal(existsSync(markerPath), false);
    await service.stop();
    service = null;
    cpSync(root, join(backup, "project"), { recursive: true, preserveTimestamps: true });
    const storePath = join(root, ".touba/sandbox-checkpoints.sqlite");
    const original = readFileSync(storePath);
    const historical = readStoreFixture(storePath);
    delete historical.records[0].paused_result.messages;
    delete historical.records[0].paused_result.messages_truncated;
    writeJson(storePath, historical);
    const incompatible = readFileSync(storePath);
    assert.throws(() => loadSandboxCheckpointStore(storePath), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
    assert.deepEqual(readFileSync(storePath), incompatible);
    assert.equal(existsSync(markerPath), false);
    // Restore the coherent cold snapshot at the same path, with no external
    // effects since the snapshot. This is not a rewrite of historical data.
    cpSync(join(backup, "project"), root, { recursive: true, preserveTimestamps: true });
    assert.deepEqual(readFileSync(storePath), original);
    service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
    await service.start();
    base = serverBaseUrl(service);
    assert.deepEqual(await getJson(`${base}/approvals/pending/current`), pending);
    assert.deepEqual(await getJson(`${base}/runs/${paused.run_id}/trace`), evidence);
    assert.equal((await postJson(`${base}/decisions`, decisionFor(pending))).status, 202);
    const resume = await postJson(`${base}/runs/sandbox/resume`, { request_id: pending.request_id });
    assert.equal(resume.status, 200, await resume.clone().text());
    assert.equal((await resume.json()).status, "success");
    const terminal = await getJson(`${base}/runs/${paused.run_id}/trace`);
    assert.equal(terminal.complete, true);
    assert.equal(terminal.segments.length, 2);
    const replay = await postJson(`${base}/runs/sandbox/resume`, { request_id: pending.request_id });
    assert.equal(replay.status, 200);
    assert.equal(readFileSync(markerPath, "utf8"), "dispatched\n");
    assert.deepEqual(await getJson(`${base}/runs/${paused.run_id}/trace`), terminal);
  } finally {
    if (service) await service.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(backup, { recursive: true, force: true });
  }
});

for (const decision of ["approve", "reject"]) test(`compiled show messages survive successive pauses and ${decision} without duplication`, async () => {
  const root = createTestProject();
  let service;
  try {
    const sourcePath = join(root, "src/demo/approval.tb");
    writeFileSync(sourcePath, `module demo.approval
strategy RunApproval
    gives Text
    do
        show
            with message as "Before review"
        human.approve
            with context as "First review"
            into first
        show
            with message as "Between reviews"
        human.approve
            with context as "Second review"
            into second
        show
            with message as "After reviews"
        give "Business result"
`);
    const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
      fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--", sourcePath], { encoding: "utf8" }));
    writeJson(join(root, ".touba/air/demo/approval.air.json"), air);
    service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
    await service.start();
    let base = serverBaseUrl(service);
    const session = await createInteraction(base, WAIT_TARGET);
    const foreign = await createInteraction(base, WAIT_TARGET);
    const operation = await sendInteractionMessage(base, session.session_id, "messages-run");
    await waitForInteractionStatus(base, session.session_id, operation.operation_id, "awaiting_human");
    const output = async () => (await getJson(`${base}/interactions/sessions/${session.session_id}`)).messages.filter(message => message.role === "touba");
    assert.deepEqual((await output()).flatMap(message => message.run_result.messages.map(m => m.text)), ["Before review"]);
    const initialEvidence = await getJson(`${base}/runs/${operation.run_id}/trace`);
    assert.equal(initialEvidence.complete, false);
    assert.equal(initialEvidence.segments.length, 1);
    assert.equal(initialEvidence.segments[0].state, "paused");
    for (const [index, choice] of ["approve", decision].entries()) {
      const sessionsPath = join(root, ".touba/interaction-sessions.sqlite");
      const beforeResume = readJson(sessionsPath);
      const eventsPath = join(root, ".touba/project-events.jsonl");
      const beforeResumeEvents = readFileSync(eventsPath, "utf8");
      const pending = await getJson(`${base}/approvals/pending/current`);
      assert.equal((await postJson(`${base}/decisions`, decisionFor(pending, { decision: choice }))).status, 202);
      const request = { schema_version: "touba-interaction-resume-request-v1", request_id: pending.request_id };
      const response = await postJson(`${base}/interactions/sessions/${session.session_id}/resume`, request);
      assert.equal(response.status, 202, await response.clone().text());
      if (index === 0) await waitForDifferentPending(base, pending.request_id);
      else await waitForInteractionStatus(base, session.session_id, operation.operation_id, decision === "approve" ? "succeeded" : "failed");
      const repeated = await postJson(`${base}/interactions/sessions/${session.session_id}/resume`, request);
      assert.equal(repeated.status, 200, await repeated.clone().text());
      await service.stop();
      if (index === 0) {
        // Crash window: the durable result exists, but its session projection
        // has not committed. Startup must recover the messages, not rerun show.
        const interrupted = beforeResume.sessions.find(candidate => candidate.session_id === session.session_id);
        interrupted.status = "running";
        interrupted.last_run_status = "running";
        interrupted.operations[0].status = "running";
        interrupted.operations[0].completed_at = null;
        interrupted.messages.find(message => message.role === "user").run_status = "running";
        writeJson(sessionsPath, beforeResume);
        writeFileSync(eventsPath, beforeResumeEvents, "utf8");
        const checkpointsPath = join(root, ".touba/sandbox-checkpoints.sqlite");
        const store = readJson(checkpointsPath);
        for (const record of store.records.filter(candidate => candidate.operation_id === operation.operation_id)) {
          // Durable results precede their UI/event projection markers. Retain
          // only the first pause, which was already visible before the resume.
          record.human_wait.projections.interaction = null;
          record.human_wait.projections.terminal_event = null;
          if (record.request_id !== pending.request_id) record.human_wait.projections.pause_interaction = null;
        }
        writeJson(checkpointsPath, store);
      }
      service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
      await service.start();
      base = serverBaseUrl(service);
      const messages = await output();
      const evidence = await getJson(`${base}/runs/${operation.run_id}/trace`);
      assert.equal(evidence.segments.length, index + 2);
      assert.equal(evidence.complete, index === 1);
      assert.equal(evidence.segments[0].digest, initialEvidence.segments[0].digest);
      assert.ok(evidence.segments.every(segment => segment.trace?.run?.run_id === operation.run_id));
      assert.ok(evidence.segments[1].trace.events.some(event => event.kind === "human_approval_resumed"));
      assert.doesNotMatch(JSON.stringify(evidence), /Before review|Between reviews|After reviews|Business result/);
      const expected = index === 0 || decision === "reject" ? ["Before review", "Between reviews"] : ["Before review", "Between reviews", "After reviews"];
      assert.deepEqual(messages.flatMap(message => message.run_result.messages.map(m => m.text)), expected);
      assert.deepEqual(messages.filter(message => message.run_result.messages.length).map(message => message.display_text), expected);
      assert.doesNotMatch(JSON.stringify(readProjectEventJournal(join(root, ".touba/project-events.jsonl"))), /Before review|Between reviews|After reviews|Business result/);
      assert.equal((await getJson(`${base}/interactions/sessions/${foreign.session_id}`)).messages.length, 0);
    }
    const messages = await output();
    assert.equal(messages.at(-1).run_result.result, decision === "approve" ? "Business result" : null);
  } finally { await service?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("approval context is explicit, bounded and private, while unrelated input stays hidden", async () => {
  const root = createTestProject();
  let service;
  try {
    const path = join(root, ".touba/air/demo/approval.air.json");
    const air = readJson(path);
    air.definitions.strategies[0].signature.inputs = [
      { name: "note", type_ref: "builtin:Text" }, { name: "unrelated", type_ref: "builtin:Text" },
    ];
    air.execution_graphs[0].nodes[0].context_refs = ["value:note"];
    writeJson(path, air);
    service = createToubaProjectServer({ projectRoot: root, contractsRoot, port: 0, quiet: true });
    await service.start();
    const base = serverBaseUrl(service);
    for (const note of ["Expense E-42: CAD 125, approved supplier", "", "x".repeat(5000)]) {
      const response = await postJson(`${base}/runs/sandbox`, {
        schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint",
        target_ref: WAIT_TARGET, effect_policy: "runtime_only",
        inputs: { note, unrelated: "PRIVATE_UNRELATED_RECORD" },
        requested_by: { kind: "service", id: "approval-context-test" }, reason: "Review selected context",
      });
      const result = await response.json();
      assert.equal(response.status, 200, JSON.stringify(result));
      assert.equal(result.status, "stopped", JSON.stringify(result));
      const pending = await getJson(`${base}/approvals/pending/current?run_id=${result.run_id}`);
      assert.equal(pending.summary.length <= 4096, true);
      assert.equal(pending.summary.length > 0, true);
      if (note.length > 0 && note.length < 4096) assert.equal(pending.summary, note);
      assert.doesNotMatch(JSON.stringify(pending), /PRIVATE_UNRELATED_RECORD/);
      assert.doesNotMatch(JSON.stringify(result.trace), /Expense E-42|PRIVATE_UNRELATED_RECORD/);
      assert.doesNotMatch(JSON.stringify(readProjectEventJournal(join(root, ".touba/project-events.jsonl"))), /Expense E-42|PRIVATE_UNRELATED_RECORD/);
    }
    await service.stop();
    service = createToubaProjectServer({ projectRoot: root, contractsRoot, port: 0, quiet: true });
    await service.start();
  } finally { await service?.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("eight independent approval requests run concurrently and keep separate durable identities", async t => {
  const root = createTestProject();
  const service = createToubaProjectServer({ projectRoot: root, contractsRoot, port: 0, quiet: true });
  try {
    await service.start();
    const start = performance.now();
    const results = await Promise.all(Array.from({ length: 8 }, () => runSandbox(serverBaseUrl(service), WAIT_TARGET)));
    t.diagnostic(`Eight concurrent approval runs: ${Math.round(performance.now() - start)} ms (local deterministic workflow)`);
    assert.ok(results.every(result => result.status === "stopped"));
    assert.equal(new Set(results.map(result => result.run_id)).size, 8);
    const store = loadSandboxCheckpointStore(join(root, ".touba/sandbox-checkpoints.sqlite"));
    assert.equal(store.records.length, 8);
    const interactionStart = performance.now();
    await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const base = serverBaseUrl(service);
      const session = await createInteraction(base, WAIT_TARGET);
      const operation = await sendInteractionMessage(base, session.session_id, `parallel-${index}`);
      await waitForInteractionStatus(base, session.session_id, operation.operation_id, "awaiting_human");
    }));
    t.diagnostic(`Eight concurrent session/message/approval flows: ${Math.round(performance.now() - interactionStart)} ms`);
    assert.equal(loadSandboxCheckpointStore(join(root, ".touba/sandbox-checkpoints.sqlite")).records.length, 16);
  } finally { await service.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("stored human checkpoints retain loop cursors and refuse missing correlation without rewriting", async () => {
  const root = createTestProject();
  const path = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const session = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, session.session_id, "cursor_validation");
    await waitForInteractionStatus(baseUrl, session.session_id, operation.operation_id, "awaiting_human");
    await service.stop();
    if (process.platform !== "win32") assert.equal(statSync(path).mode & 0o777, 0o600);
    const stored = loadSandboxCheckpointStore(path);
    const key = stored.records[0].checkpoint.graph_ref + ":loop";
    stored.records[0].checkpoint.loop_state = { [key]: { index: 1 } };
    writeJson(path, stored);
    assert.deepEqual(loadSandboxCheckpointStore(path).records[0].checkpoint.loop_state, { [key]: { index: 1 } });
    const mutations = [
      ...[[], null, { [key]: { index: -1 } }, { [key]: { index: 0.5 } }, { [key]: { index: 1, extra: true } }, { [key]: {} }]
        .map(state => record => { record.checkpoint.loop_state = state; }),
      record => { delete record.operation_id; },
      record => { delete record.effect_scope_id; },
      record => { delete record.human_wait; },
      record => { record.paused_result.trace.events = []; record.paused_result.trace.event_count = 0; },
    ];
    for (const mutate of mutations) {
      const invalid = structuredClone(stored); mutate(invalid.records[0]);
      writeStoreFixture(path, invalid); const bytes = readFileSync(path, "utf8");
      assert.throws(() => loadSandboxCheckpointStore(path), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
      assert.equal(readFileSync(path, "utf8"), bytes);
    }
  } finally { await service.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("obsolete checkpoint stores are refused unchanged, including empty stores", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-wait-obsolete-"));
  const path = join(root, "sandbox-checkpoints.sqlite");
  try {
    for (const schema_version of ["touba-sandbox-checkpoints-v0.1", "touba-sandbox-checkpoints-v0.2"]) {
      for (const records of [[], [{ run_id: "historical", status: "completed" }]]) {
        const bytes = JSON.stringify({ schema_version, records }); writeFileSync(path, bytes, "utf8");
        assert.throws(() => loadSandboxCheckpointStore(path), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
        assert.equal(readFileSync(path, "utf8"), bytes);
      }
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("WAIT deadline uses the server clock at D-1, D, and D+1; one timer is armed and stop clears it", async (t) => {
  const cases = [
    { label: "D-1", deltaMs: DAY_MS - 1, accepted: true },
    { label: "D", deltaMs: DAY_MS, accepted: false },
    { label: "D+1", deltaMs: DAY_MS + 1, accepted: false },
  ];
  for (const scenario of cases) {
    await t.test(scenario.label, async () => {
      const root = createTestProject();
      // Keep the injected deadline at or just before the wall clock because
      // resumed runtime result timestamps are produced by the runtime clock.
      const clock = controlledClock(Date.now() - DAY_MS - 1_000);
      const service = createToubaProjectServer({
        contractsRoot,
        projectRoot: root,
        humanWaitRuntime: clock.runtime,
        port: 0,
        quiet: true,
      });
      try {
        await service.start();
        const baseUrl = serverBaseUrl(service);
        const paused = await runSandbox(baseUrl, WAIT_TARGET);
        assert.equal(paused.status, "stopped");
        assert.equal(paused.diagnostics[0].code, "ToubaSandboxRunAwaitingHumanDecision");
        await settleAsync();
        const pending = await getJson(`${baseUrl}/approvals/pending/current`);
        const recordAtPause = humanRecord(root, pending.request_id);
        const createdMs = Date.parse(recordAtPause.created_at);
        assert.equal(Date.parse(recordAtPause.human_wait.deadline_at) - createdMs, DAY_MS);
        assert.equal(recordAtPause.human_wait.request.expires_at, recordAtPause.human_wait.deadline_at);
        assert.equal(clock.activeTimers().length, 1);

        clock.setNow(createdMs + scenario.deltaMs);
        const response = await postJson(`${baseUrl}/decisions`, decisionFor(pending, {
          // Audit metadata is deliberately unrelated to the server deadline.
          decidedAt: scenario.accepted
            ? "1900-01-01T00:00:00.000Z"
            : "2999-01-01T00:00:00.000Z",
        }));
        if (scenario.accepted) {
          assert.equal(response.status, 202, await response.clone().text());
          const claimed = humanRecord(root, pending.request_id);
          assert.equal(claimed.status, "resolution_claimed");
          assert.equal(claimed.human_wait.resolution.kind, "decision");
          assert.equal(claimed.human_wait.resolution.claimed_at, new Date(clock.now()).toISOString());
          assert.equal(clock.activeTimers().length, 0);
          const resumedResponse = await postJson(`${baseUrl}/runs/sandbox/resume`, {
            request_id: pending.request_id,
          });
          assert.equal(resumedResponse.status, 200, await resumedResponse.clone().text());
          const resumed = await resumedResponse.json();
          assert.equal(resumed.status, "success");
          assert.equal(humanRecord(root, pending.request_id).status, "completed");
        } else {
          assert.equal(response.status, 410, await response.clone().text());
          assert.equal((await response.json()).code, "ToubaServeDecisionRequestExpired");
          await waitForRecord(root, pending.request_id, (record) => record.status === "completed");
          const expired = humanRecord(root, pending.request_id);
          assert.equal(expired.human_wait.resolution.kind, "expired");
          assert.equal(expired.human_wait.resolution.claimed_at, new Date(clock.now()).toISOString());
          assert.equal(expired.human_wait.terminalization.attempt_count, 1);
          assert.equal(expired.result.trace.events.some((event) => event.type === "human_approval_expired"), true);
          assert.equal(clock.activeTimers().length, 0);
        }
      } finally {
        await service.stop();
        assert.equal(clock.activeTimers().length, 0);
        assert.equal(clock.clearCount() >= 1, true);
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

test("WAIT v0.3 validation and orphan requests fail closed without mutating durable bytes", async () => {
  const root = createTestProject();
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const clock = controlledClock(Date.now() - 1_000);
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    await settleAsync();
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    const validStore = readJson(checkpointPath);
    await service.stop();

    const invalidStore = structuredClone(validStore);
    invalidStore.records[0].human_wait.request_digest = `sha256:${"f".repeat(64)}`;
    writeStoreFixture(checkpointPath, invalidStore);
    const invalidBytes = readFileSync(checkpointPath, "utf8");
    assert.throws(() => loadSandboxCheckpointStore(checkpointPath), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
    assert.equal(readFileSync(checkpointPath, "utf8"), invalidBytes);

    const orphanStore = {
      schema_version: "touba-sandbox-checkpoints-v1",
      records: [],
    };
    writeStoreFixture(checkpointPath, orphanStore);
    const orphanBytes = readFileSync(checkpointPath, "utf8");
    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    const orphanBaseUrl = serverBaseUrl(service);
    assert.equal((await fetch(`${orphanBaseUrl}/approvals/pending/current`)).status, 404);
    const decisionResponse = await postJson(
      `${orphanBaseUrl}/decisions`,
      decisionFor(pending),
    );
    assert.equal(decisionResponse.status, 409, await decisionResponse.clone().text());
    assert.equal((await decisionResponse.json()).code, "ToubaServeHumanWaitConflict");
    assert.equal(readFileSync(checkpointPath, "utf8"), orphanBytes);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT v0.3 rejects resealed pause and decision traces bound to another approval or outcome", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    clock.setNow(Date.now());
    assert.equal((await postJson(`${baseUrl}/decisions`, decisionFor(pending))).status, 202);
    const resume = await postJson(`${baseUrl}/runs/sandbox/resume`, {
      request_id: pending.request_id,
    });
    assert.equal(resume.status, 200, await resume.clone().text());
    await service.stop();

    const validStore = readJson(checkpointPath);
    assert.doesNotThrow(() => loadSandboxCheckpointStore(checkpointPath));
    const variants = [
      (record) => {
        const paused = record.paused_result.trace.events.find((event) => event.type === "human_approval_paused");
        assert.ok(paused);
        paused.authority_ref = "approval:foreign/OtherBoundary";
      },
      (record) => {
        const loaded = record.result.trace.events.find((event) => event.type === "human_approval_checkpoint_loaded");
        const resolved = record.result.trace.events.find((event) => event.type === "human_approval_resumed");
        assert.ok(loaded);
        assert.ok(resolved);
        loaded.related_ref = "decision:rejected";
        resolved.related_ref = "decision:rejected";
        if (record.human_wait.projections.terminal_event !== null) {
          record.human_wait.projections.terminal_event.result_digest = canonicalDigest(record.result);
        }
      },
    ];
    for (const mutate of variants) {
      const corrupted = structuredClone(validStore);
      mutate(corrupted.records[0]);
      writeStoreFixture(checkpointPath, corrupted);
      const bytes = readFileSync(checkpointPath, "utf8");
      assert.throws(() => loadSandboxCheckpointStore(checkpointPath), {
        code: "ToubaServeSandboxCheckpointStoreInvalid",
      });
      assert.equal(readFileSync(checkpointPath, "utf8"), bytes);
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT decision claim survives a crash, repairs its projection once, and resumes only explicitly", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - 1_000);
  let crashObserved = false;
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    humanWaitClaimedObserver({ kind }) {
      if (kind === "decision") {
        crashObserved = true;
        throw new Error("simulated crash after durable decision claim");
      }
    },
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    await settleAsync();
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    clock.setNow(Date.now());
    const crashedDecision = await postJson(`${baseUrl}/decisions`, decisionFor(pending));
    assert.equal(crashedDecision.status, 500, await crashedDecision.clone().text());
    assert.equal(crashObserved, true);
    const claimed = humanRecord(root, pending.request_id);
    assert.equal(claimed.status, "resolution_claimed");
    assert.equal(claimed.human_wait.resolution.kind, "decision");
    assert.equal(claimed.human_wait.resolution.status, "claimed");
    await service.stop();

    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    const recoveredBaseUrl = serverBaseUrl(service);
    const decisions = await getJson(`${recoveredBaseUrl}/decisions`);
    assert.equal(decisions.summary.total, 1);
    assert.equal(humanRecord(root, pending.request_id).status, "resolution_claimed");
    assert.equal((await fetch(`${recoveredBaseUrl}/approvals/pending/current`)).status, 404);

    const resumedResponse = await postJson(`${recoveredBaseUrl}/runs/sandbox/resume`, {
      request_id: pending.request_id,
    });
    assert.equal(resumedResponse.status, 200, await resumedResponse.clone().text());
    const resumed = await resumedResponse.json();
    assert.equal(resumed.status, "success");
    const completed = humanRecord(root, pending.request_id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.human_wait.resolution.status, "completed");
    assert.equal((await getJson(`${recoveredBaseUrl}/decisions`)).summary.total, 1);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT timer coalesces duplicate wakes and startup distinguishes future from overdue waits", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - DAY_MS - 2_000);
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    await settleAsync();
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    const deadlineMs = Date.parse(humanRecord(root, pending.request_id).human_wait.deadline_at);
    assert.equal(clock.activeTimers().length, 1);
    await service.stop();
    assert.equal(clock.activeTimers().length, 0);

    clock.setNow(deadlineMs - 1);
    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    assert.equal(humanRecord(root, pending.request_id).status, "pending");
    assert.equal(clock.activeTimers().length, 1);
    const timer = clock.activeTimers()[0];
    clock.setNow(deadlineMs);
    // Two callbacks from the same platform handle must still have one durable
    // winner and one terminalization attempt.
    timer.fired = true;
    timer.callback();
    timer.callback();
    await waitForRecord(root, pending.request_id, (record) => record.status === "completed");
    const completed = humanRecord(root, pending.request_id);
    assert.equal(completed.human_wait.resolution.kind, "expired");
    assert.equal(completed.human_wait.terminalization.attempt_count, 1);
    assert.equal(clock.activeTimers().length, 0);
    await service.stop();

    // A completed overdue wait is replay-safe on every later startup.
    clock.setNow(deadlineMs + 1);
    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    assert.equal(humanRecord(root, pending.request_id).human_wait.terminalization.attempt_count, 1);
    assert.equal(clock.activeTimers().length, 0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT startup repairs crashes after an automatic claim and after durable terminalization", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - DAY_MS - 2_000);
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    humanWaitClaimedObserver({ kind }) {
      if (kind === "expired") throw new Error("simulated crash after expiry claim");
    },
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    await settleAsync();
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    const deadlineMs = Date.parse(humanRecord(root, pending.request_id).human_wait.deadline_at);
    clock.setNow(deadlineMs);
    clock.fire();
    await waitForRecord(
      root,
      pending.request_id,
      (record) => record.status === "resolution_claimed",
    );
    const claimed = humanRecord(root, pending.request_id);
    assert.equal(claimed.human_wait.resolution.kind, "expired");
    assert.equal(claimed.human_wait.terminalization.attempt_count, 0);
    assert.equal(claimed.result, undefined);
    await service.stop();

    let completedObserverCalled = false;
    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      humanWaitCompletedObserver() {
        completedObserverCalled = true;
        throw new Error("simulated crash after durable terminal result");
      },
      port: 0,
      quiet: true,
    });
    await assert.rejects(service.start(), /simulated crash after durable terminal result/u);
    assert.equal(completedObserverCalled, true);
    const durableTerminal = humanRecord(root, pending.request_id);
    assert.equal(durableTerminal.status, "completed");
    assert.equal(durableTerminal.human_wait.terminalization.attempt_count, 1);
    assert.equal(durableTerminal.human_wait.projections.terminal_event, null);
    await service.stop();

    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    const repaired = humanRecord(root, pending.request_id);
    assert.equal(repaired.status, "completed");
    assert.equal(repaired.human_wait.terminalization.attempt_count, 1);
    assert.notEqual(repaired.human_wait.projections.terminal_event, null);
    const terminalEvents = readProjectEventJournal(join(root, ".touba", "project-events.jsonl"))
      .filter((event) => (
        event.type === "human_wait.terminalized"
        && event.payload.request_id === pending.request_id
      ));
    assert.equal(terminalEvents.length, 1);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT interaction cancellation is exact, crash-safe, and idempotently repaired", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - 1_000);
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    humanWaitClaimedObserver({ kind }) {
      if (kind === "cancelled") throw new Error("simulated crash after cancellation claim");
    },
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const session = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, session.session_id, "cancel_wait");
    const pausedOperation = await waitForInteractionOperation(
      baseUrl,
      session.session_id,
      operation.operation_id,
    );
    assert.equal(pausedOperation.status, "awaiting_human");
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    clock.setNow(Date.now());
    const cancelled = await postJson(
      `${baseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}/cancel`,
      {},
    );
    assert.equal(cancelled.status, 500, await cancelled.clone().text());
    const completedLive = await waitForRecord(
      root,
      pending.request_id,
      (record) => record.status === "completed",
    );
    assert.equal(completedLive.operation_id, operation.operation_id);
    assert.equal(completedLive.run_id, operation.run_id);
    assert.equal(completedLive.human_wait.resolution.kind, "cancelled");
    assert.equal(completedLive.human_wait.terminalization.attempt_count, 1);
    await waitForInteractionStatus(baseUrl, session.session_id, operation.operation_id, "cancelled");
    await service.stop();

    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    const recoveredBaseUrl = serverBaseUrl(service);
    const recovered = await getJson(
      `${recoveredBaseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}`,
    );
    assert.equal(recovered.status, "cancelled");
    const completed = humanRecord(root, pending.request_id);
    assert.equal(completed.status, "completed");
    assert.equal(completed.human_wait.resolution.kind, "cancelled");
    assert.equal(completed.human_wait.terminalization.attempt_count, 1);
    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
    const terminalBytes = readFileSync(checkpointPath, "utf8");
    clock.setNow(Date.parse(completed.human_wait.deadline_at) + 1);
    const repeated = await postJson(
      `${recoveredBaseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}/cancel`,
      {},
    );
    assert.equal(repeated.status, 200, await repeated.clone().text());
    assert.equal((await repeated.json()).status, "cancelled");
    assert.equal(humanRecord(root, pending.request_id).human_wait.terminalization.attempt_count, 1);
    assert.equal(readFileSync(checkpointPath, "utf8"), terminalBytes);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT cancellation wakes the live worker after a post-claim error and retries projection without rerunning", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const eventJournalPath = join(root, ".touba", "cancel-transient-events.jsonl");
  let completedObserverCalls = 0;
  const service = createToubaProjectServer({
    contractsRoot,
    eventJournalPath,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    humanWaitClaimedObserver({ kind }) {
      if (kind === "cancelled") throw new Error("simulated post-cancel-claim host error");
    },
    humanWaitCompletedObserver() {
      completedObserverCalls += 1;
    },
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const session = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, session.session_id, "cancel_live_retry");
    await waitForInteractionStatus(baseUrl, session.session_id, operation.operation_id, "awaiting_human");
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    rmSync(eventJournalPath, { force: true });
    mkdirSync(eventJournalPath);
    clock.setNow(Date.now());
    const response = await postJson(
      `${baseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}/cancel`,
      {},
    );
    assert.equal(response.status, 500);
    const durable = await waitForRecord(root, pending.request_id, (record) => record.status === "completed");
    assert.equal(durable.human_wait.resolution.kind, "cancelled");
    assert.equal(durable.human_wait.terminalization.attempt_count, 1);
    assert.equal(durable.human_wait.projections.terminal_event, null);
    assert.equal(completedObserverCalls, 1);
    await waitForActiveTimers(clock, 1);
    const retryTimer = clock.activeTimers()[0];
    assert.equal(retryTimer.delay, 30_000);

    rmSync(eventJournalPath, { recursive: true, force: true });
    clock.setNow(clock.now() + retryTimer.delay);
    clock.fire(retryTimer);
    const repaired = await waitForRecord(root, pending.request_id, (record) => (
      record.human_wait.projections.terminal_event !== null
      && record.human_wait.projections.interaction !== null
    ));
    assert.equal(repaired.human_wait.terminalization.attempt_count, 1);
    assert.equal(completedObserverCalls, 1);
    assert.equal((await getJson(
      `${baseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}`,
    )).status, "cancelled");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT capacity is configurable above 100 and lowering it preserves existing waits", async t => {
  const root = createTestProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const maxPendingApprovals of [0, -1, 1.2, 10001, "100"])
    assert.throws(() => createToubaProjectServer({ projectRoot: root, maxPendingApprovals }), { code: "ToubaServeHumanWaitCapacityInvalid" });
  const options = { contractsRoot, projectRoot: root, port: 0, quiet: true };
  let service = createToubaProjectServer({ ...options, maxPendingApprovals: 102 });
  try {
    await service.start();
    for (let i = 0; i < 101; i++) assert.equal((await runSandbox(serverBaseUrl(service), WAIT_TARGET)).reason, "human_approval_pending");
    const pending = await getJson(`${serverBaseUrl(service)}/approvals/pending/current`);
    await service.stop();
    service = createToubaProjectServer({ ...options, maxPendingApprovals: 1 }); await service.start();
    const refused = await postJson(`${serverBaseUrl(service)}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v1", execution_kind: "entrypoint", target_ref: WAIT_TARGET,
      inputs: {}, effect_policy: "runtime_only", requested_by: { kind: "service", id: "capacity-test" }, reason: "Check configured capacity",
    });
    assert.equal(refused.status, 429);
    assert.equal((await postJson(`${serverBaseUrl(service)}/decisions`, decisionFor(pending))).status, 202);
  } finally { await service.stop(); }
});

test("WAIT capacity rejects the 101st human target before execution but permits a pure target", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - 1_000);
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    await settleAsync();
    const template = loadSandboxCheckpointStore(checkpointPath).records[0];
    await service.stop();

    const records = Array.from({ length: 99 }, (_, index) => (
      clonePendingHumanRecord(template, `run_capacity_${String(index).padStart(3, "0")}`)
    ));
    writeJson(checkpointPath, {
      schema_version: "touba-sandbox-checkpoints-v1",
      records,
    });
    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    const fullBaseUrl = serverBaseUrl(service);
    assert.equal(
      loadSandboxCheckpointStore(checkpointPath).records.filter((record) => record.record_kind === "human").length,
      99,
    );
    const concurrentBody = {
      schema_version: "touba-sandbox-run-request-v1",
      execution_kind: "entrypoint",
      target_ref: WAIT_TARGET,
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "durable-human-waits-test" },
      reason: "Two callers compete for the final human-wait slot.",
    };
    const concurrent = await Promise.all([
      postJson(`${fullBaseUrl}/runs/sandbox`, concurrentBody),
      postJson(`${fullBaseUrl}/runs/sandbox`, concurrentBody),
    ]);
    assert.deepEqual(concurrent.map((response) => response.status).sort(), [200, 429]);
    await settleAsync();
    assert.equal(
      loadSandboxCheckpointStore(checkpointPath).records.filter((record) => record.record_kind === "human").length,
      100,
    );
    const bytesBeforeRefusal = readFileSync(checkpointPath, "utf8");
    const refused = await postJson(`${fullBaseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v1",
      execution_kind: "entrypoint",
      target_ref: WAIT_TARGET,
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "durable-human-waits-test" },
      reason: "The capacity arbiter must refuse before enqueue or runtime.",
    });
    assert.equal(refused.status, 429, await refused.clone().text());
    assert.equal((await refused.json()).code, "ToubaServeHumanWaitCapacityExceeded");
    await settleAsync();
    assert.equal(readFileSync(checkpointPath, "utf8"), bytesBeforeRefusal);

    const pure = await runSandbox(fullBaseUrl, PURE_TARGET);
    assert.equal(pure.status, "success");
    assert.equal(pure.result, "pure");
    const afterPure = loadSandboxCheckpointStore(checkpointPath);
    assert.equal(afterPure.records.filter((record) => record.record_kind === "human").length, 100);
    assert.equal(afterPure.records.some((record) => (
      record.record_kind === "execution" && record.target_ref === PURE_TARGET
    )), true);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT successive pauses retain distinct request and result identities in the event journal", async () => {
  const root = createTestProject({ twoApprovals: true });
  const clock = controlledClock(Date.now() - 1_000);
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const session = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, session.session_id, "two_waits");
    assert.equal((await waitForInteractionOperation(
      baseUrl,
      session.session_id,
      operation.operation_id,
    )).status, "awaiting_human");
    const first = await getJson(`${baseUrl}/approvals/pending/current`);
    clock.setNow(Date.now());
    assert.equal((await postJson(`${baseUrl}/decisions`, decisionFor(first))).status, 202);
    const firstResume = await postJson(`${baseUrl}/interactions/sessions/${session.session_id}/resume`, {
      schema_version: "touba-interaction-resume-request-v1",
      request_id: first.request_id,
    });
    assert.equal(firstResume.status, 202, await firstResume.clone().text());
    const second = await waitForDifferentPending(baseUrl, first.request_id);
    assert.notEqual(second.request_id, first.request_id);
    clock.setNow(Date.now());
    assert.equal((await postJson(`${baseUrl}/decisions`, decisionFor(second, {
      decision: "reject",
    }))).status, 202);
    const secondResume = await postJson(`${baseUrl}/interactions/sessions/${session.session_id}/resume`, {
      schema_version: "touba-interaction-resume-request-v1",
      request_id: second.request_id,
    });
    assert.equal(secondResume.status, 202, await secondResume.clone().text());
    await waitForInteractionStatus(
      baseUrl,
      session.session_id,
      operation.operation_id,
      "failed",
    );

    const pauseEvents = readProjectEventJournal(join(root, ".touba", "project-events.jsonl"))
      .filter((event) => (
        event.type === "interaction.run.awaiting_human"
        && event.payload.operation_id === operation.operation_id
      ));
    assert.equal(pauseEvents.length, 2);
    assert.deepEqual(
      new Set(pauseEvents.map((event) => event.payload.request_id)),
      new Set([first.request_id, second.request_id]),
    );
    assert.equal(new Set(pauseEvents.map((event) => event.payload.result_digest)).size, 2);
    const records = loadSandboxCheckpointStore(join(root, ".touba", "sandbox-checkpoints.sqlite"))
      .records.filter((record) => record.operation_id === operation.operation_id);
    assert.equal(records.length, 2);
    const firstRecord = records.find((record) => record.request_id === first.request_id);
    const secondRecord = records.find((record) => record.request_id === second.request_id);
    assert.equal(firstRecord.status, "superseded");
    assert.notEqual(firstRecord.human_wait.projections.terminal_event, null);
    assert.equal(firstRecord.human_wait.projections.interaction, null);
    assert.equal(secondRecord.status, "completed");
    assert.notEqual(secondRecord.human_wait.projections.pause_interaction, null);
    assert.notEqual(secondRecord.human_wait.projections.interaction, null);
    assert.notEqual(secondRecord.human_wait.projections.terminal_event, null);
    await waitForActiveTimers(clock, 0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const ending of ["cancel", "approve"]) test(`WAIT successive approvals survive ${ending}, archive and restart without blocking another deadline`, { timeout: 20000 }, async () => {
  const root = createTestProject({ twoApprovals: true });
  const clock = controlledClock(Date.now());
  let service = createToubaProjectServer({ contractsRoot, projectRoot: root, humanWaitRuntime: clock.runtime, port: 0, quiet: true });
  try {
    await service.start();
    const url = serverBaseUrl(service);
    const session = await createInteraction(url, WAIT_TARGET);
    const operation = await sendInteractionMessage(url, session.session_id, `two-waits-${ending}`);
    await waitForInteractionStatus(url, session.session_id, operation.operation_id, "awaiting_human");
    const first = await getJson(`${url}/approvals/pending/current`);
    clock.setNow(Date.now());
    const accepted = await postJson(`${url}/decisions`, decisionFor(first));
    assert.equal(accepted.status, 202, await accepted.text());
    assert.equal((await postJson(`${url}/interactions/sessions/${session.session_id}/resume`, {
      schema_version: "touba-interaction-resume-request-v1", request_id: first.request_id,
    })).status, 202);
    const second = await waitForDifferentPending(url, first.request_id);
    await waitForInteractionStatus(url, session.session_id, operation.operation_id, "awaiting_human");
    clock.setNow(Date.now());
    if (ending === "cancel") {
      const response = await postJson(`${url}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}/cancel`, {});
      assert.ok([200, 202].includes(response.status), await response.text());
    } else {
      assert.equal((await postJson(`${url}/decisions`, decisionFor(second))).status, 202);
      assert.equal((await postJson(`${url}/interactions/sessions/${session.session_id}/resume`, {
        schema_version: "touba-interaction-resume-request-v1", request_id: second.request_id,
      })).status, 202);
    }
    await waitForInteractionStatus(url, session.session_id, operation.operation_id, ending === "cancel" ? "cancelled" : "succeeded");
    const archived = await postJson(`${url}/interactions/sessions/${session.session_id}/archive`, {});
    assert.equal(archived.status, 200, await archived.text());
    await service.stop();
    assert.equal(checkToubaProjectState({ projectRoot: root }).status, "structurally_valid");
    service = createToubaProjectServer({ contractsRoot, projectRoot: root, humanWaitRuntime: clock.runtime, port: 0, quiet: true });
    await service.start();
    const nextUrl = serverBaseUrl(service);
    const other = await createInteraction(nextUrl, WAIT_TARGET);
    const nextOperation = await sendInteractionMessage(nextUrl, other.session_id, "independent-deadline");
    await waitForInteractionStatus(nextUrl, other.session_id, nextOperation.operation_id, "awaiting_human");
    const pending = await getJson(`${nextUrl}/approvals/pending/current`);
    await waitForActiveTimers(clock, 1);
    clock.setNow(Date.parse(pending.expires_at) + 1);
    clock.fire(clock.activeTimers()[0]);
    await waitForInteractionStatus(nextUrl, other.session_id, nextOperation.operation_id, "failed");
    const records = loadSandboxCheckpointStore(join(root, ".touba/sandbox-checkpoints.sqlite")).records;
    assert.equal(records.find(r => r.request_id === first.request_id).status, "superseded");
    assert.equal(records.find(r => r.request_id === pending.request_id).human_wait.resolution.kind, "expired");
  } finally { await service.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("WAIT failed terminalization is valid only after an attempt, retries on one timer, and recovers at cap 100", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - DAY_MS - 2_000);
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const airPath = join(root, ".touba", "air", "demo", "approval.air.json");
  const originalAirBytes = readFileSync(airPath, "utf8");
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    await settleAsync();
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    const deadlineMs = Date.parse(humanRecord(root, pending.request_id).human_wait.deadline_at);
    const incompatibleAir = JSON.parse(originalAirBytes);
    incompatibleAir.definitions.strategies[0].description = "Changed after the durable checkpoint.";
    writeJson(airPath, incompatibleAir);
    clock.setNow(deadlineMs);
    clock.fire();
    const failed = await waitForRecord(root, pending.request_id, (record) => (
      record.human_wait.terminalization?.status === "failed"
    ));
    assert.equal(failed.status, "resolution_claimed");
    assert.equal(failed.human_wait.terminalization.attempt_count, 1);
    assert.notEqual(failed.human_wait.terminalization.last_attempt_at, null);
    await waitForActiveTimers(clock, 1);
    const retryTimer = clock.activeTimers()[0];
    assert.equal(retryTimer.delay, 30_000);
    const firstAttemptAt = failed.human_wait.terminalization.last_attempt_at;
    const firstAttemptAtMs = Date.parse(firstAttemptAt);
    const validFailedStore = readJson(checkpointPath);
    for (const elapsedMs of [1, 10_000, 29_999]) {
      clock.setNow(firstAttemptAtMs + elapsedMs);
      assert.equal((await fetch(`${baseUrl}/approvals/pending/current`)).status, 404);
      const unchanged = humanRecord(root, pending.request_id);
      assert.equal(unchanged.status, "resolution_claimed");
      assert.equal(unchanged.human_wait.terminalization.status, "failed");
      assert.equal(unchanged.human_wait.terminalization.attempt_count, 1);
      assert.equal(unchanged.human_wait.terminalization.last_attempt_at, firstAttemptAt);
      assert.equal(clock.activeTimers().length, 1);
      assert.equal(clock.activeTimers()[0], retryTimer);
    }
    writeFileSync(airPath, originalAirBytes, "utf8");
    clock.setNow(firstAttemptAtMs + 30_000);
    clock.fire(retryTimer);
    const retried = await waitForRecord(root, pending.request_id, (record) => record.status === "completed");
    assert.equal(retried.human_wait.terminalization.status, "completed");
    assert.equal(retried.human_wait.terminalization.attempt_count, 2);
    await waitForActiveTimers(clock, 0);
    await service.stop();

    writeJson(checkpointPath, validFailedStore);
    assert.doesNotThrow(() => loadSandboxCheckpointStore(checkpointPath));
    const sensitiveErrorStore = structuredClone(validFailedStore);
    sensitiveErrorStore.records[0].human_wait.terminalization.error.bearer = "must-not-be-persisted";
    writeStoreFixture(checkpointPath, sensitiveErrorStore);
    const sensitiveErrorBytes = readFileSync(checkpointPath, "utf8");
    assert.throws(() => loadSandboxCheckpointStore(checkpointPath), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
    assert.equal(readFileSync(checkpointPath, "utf8"), sensitiveErrorBytes);

    const invalidFailedStore = structuredClone(validFailedStore);
    invalidFailedStore.records[0].human_wait.terminalization.attempt_count = 0;
    invalidFailedStore.records[0].human_wait.terminalization.last_attempt_at = null;
    writeStoreFixture(checkpointPath, invalidFailedStore);
    const invalidBytes = readFileSync(checkpointPath, "utf8");
    assert.throws(() => loadSandboxCheckpointStore(checkpointPath), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
    assert.equal(readFileSync(checkpointPath, "utf8"), invalidBytes);

    validFailedStore.records[0].human_wait.terminalization.attempt_count = 100;
    writeJson(checkpointPath, validFailedStore);
    writeFileSync(airPath, originalAirBytes, "utf8");
    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    const repaired = humanRecord(root, pending.request_id);
    assert.equal(repaired.status, "completed");
    assert.equal(repaired.human_wait.terminalization.status, "completed");
    assert.equal(repaired.human_wait.terminalization.attempt_count, 100);
    assert.equal(clock.activeTimers().length, 0);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT automatic expiry never dispatches an effect located after the human boundary", async () => {
  const root = createTestProject({ withSentinel: true });
  const markerPath = join(root, ".touba", "sentinel-dispatched");
  configureSentinelHandler(root, markerPath);
  const clock = controlledClock(Date.now() - DAY_MS - 2_000);
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const paused = await runSandbox(
      baseUrl,
      SENTINEL_TARGET,
      "allow_declared_external_effects",
    );
    assert.equal(paused.status, "stopped", JSON.stringify(paused, null, 2));
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    const deadlineMs = Date.parse(humanRecord(root, pending.request_id).human_wait.deadline_at);
    clock.setNow(deadlineMs);
    clock.fire();
    const expired = await waitForRecord(root, pending.request_id, (record) => record.status === "completed");
    assert.equal(expired.human_wait.resolution.kind, "expired");
    assert.equal(expired.result.trace.events.some((event) => event.type === "tool_call_started"), false);
    const evidence = await getJson(`${baseUrl}/runs/${paused.run_id}/trace`);
    assert.equal(evidence.complete, true);
    assert.deepEqual(evidence.segments.map(segment => segment.phase), ["initial", "human_terminal"]);
    assert.equal(evidence.segments.flatMap(segment => segment.trace.events).some(event => event.kind === "tool_call_started"), false);
    assert.equal(existsSync(markerPath), false);
    await service.stop();

    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    assert.equal(existsSync(markerPath), false);
    assert.equal(humanRecord(root, pending.request_id).human_wait.terminalization.attempt_count, 1);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT live worker repairs a transient decision projection failure before the deadline without resuming", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const decisionsPath = join(root, ".touba", "human-decisions.sqlite");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    await settleAsync();
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    const deadlineMs = Date.parse(humanRecord(root, pending.request_id).human_wait.deadline_at);
    mkdirSync(decisionsPath);
    clock.setNow(Date.now());
    const response = await postJson(`${baseUrl}/decisions`, decisionFor(pending));
    assert.equal(response.status, 500);
    const claimed = humanRecord(root, pending.request_id);
    assert.equal(claimed.status, "resolution_claimed");
    assert.equal(claimed.human_wait.resolution.kind, "decision");
    assert.equal(claimed.human_wait.resolution.status, "claimed");
    assert.equal(clock.now() < deadlineMs, true);

    rmSync(decisionsPath, { recursive: true, force: true });
    await settleAsync();
    if (!existsSync(decisionsPath)) {
      await waitForActiveTimers(clock, 1);
      const retryTimer = clock.activeTimers()[0];
      assert.equal(retryTimer.delay <= 30_000, true);
      clock.setNow(clock.now() + retryTimer.delay);
      clock.fire(retryTimer);
    }
    await waitForPath(decisionsPath);
    const decisions = await getJson(`${baseUrl}/decisions`);
    assert.equal(decisions.summary.total, 1);
    const stillClaimed = humanRecord(root, pending.request_id);
    assert.equal(stillClaimed.status, "resolution_claimed");
    assert.equal(stillClaimed.human_wait.resolution.status, "claimed");
    assert.equal(stillClaimed.result, undefined);
    assert.equal(
      readProjectEventJournal(join(root, ".touba", "project-events.jsonl"))
        .some((event) => event.type === "sandbox_run.resumed"),
      false,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT direct human resume repairs a durable terminal result live after surface failure without replaying effects", async () => {
  const root = createTestProject({ withSentinel: true });
  const markerPath = join(root, ".touba", "resume-sentinel-dispatched");
  configureSentinelHandler(root, markerPath);
  const clock = controlledClock(Date.now());
  const traceTimelinePath = join(root, ".touba", "transient-trace-timeline.json");
  const runSummaryPath = join(root, ".touba", "transient-run-summary.json");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    runSummaryPath,
    traceTimelinePath,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, SENTINEL_TARGET, "allow_declared_external_effects");
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    clock.setNow(Date.now());
    assert.equal((await postJson(`${baseUrl}/decisions`, decisionFor(pending))).status, 202);
    rmSync(traceTimelinePath, { force: true });
    mkdirSync(traceTimelinePath);
    const resume = await postJson(`${baseUrl}/runs/sandbox/resume`, {
      request_id: pending.request_id,
    });
    assert.equal(resume.status, 500);
    const durable = humanRecord(root, pending.request_id);
    assert.equal(durable.status, "completed");
    assert.equal(durable.human_wait.resolution.kind, "decision");
    assert.equal(durable.result.status, "success");
    assert.equal(readFileSync(markerPath, "utf8").trim().split("\n").length, 1);
    const resultDigest = canonicalDigest(durable.result);

    rmSync(traceTimelinePath, { recursive: true, force: true });
    await waitForActiveTimers(clock, 1);
    const retryTimer = clock.activeTimers()[0];
    assert.equal(retryTimer.delay <= 30_000, true);
    clock.setNow(clock.now() + retryTimer.delay);
    clock.fire(retryTimer);
    await waitForPath(traceTimelinePath);
    const repaired = await waitForRecord(root, pending.request_id, (record) => (
      record.human_wait.projections.terminal_event !== null
    ));
    assert.equal(canonicalDigest(repaired.result), resultDigest);
    assert.equal(readFileSync(markerPath, "utf8").trim().split("\n").length, 1);
    assert.equal(readJson(runSummaryPath).status, "succeeded");
    assert.equal(
      readProjectEventJournal(join(root, ".touba", "project-events.jsonl"))
        .filter((event) => (
          event.type === "sandbox_run.resumed"
          && event.payload.request_id === pending.request_id
        )).length,
      1,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT human-review decision validates, survives restart, and resumes its agent checkpoint", async () => {
  const root = createAgentReviewProject();
  const clock = controlledClock(Date.now());
  const agentDecisionProvider = (request) => {
    if (request.step_index === 0 && request.mode === "summary") {
      return {
        action: "request_capabilities",
        reason: "human review may be required",
      };
    }
    if (request.step_index === 0 && request.mode === "capabilities") {
      return {
        action: "request_human_review",
        source: "durable_human_wait_test",
        reason: "a reviewer must confirm the draft",
        review_prompt: "Confirm the generated draft.",
      };
    }
    return {
      action: "answer_directly",
      source: "durable_human_wait_test",
      reason: "the review was accepted",
      result: "accepted after human review",
    };
  };
  let service = createToubaProjectServer({
    agentDecisionProvider,
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const paused = await runSandbox(baseUrl, REVIEW_TARGET);
    assert.equal(paused.status, "stopped", JSON.stringify(paused, null, 2));
    assert.equal(paused.diagnostics[0].code, "ToubaSandboxRunAwaitingHumanDecision");
    const pending = await getJson(`${baseUrl}/reviews/pending/current`);
    assert.equal(pending.schema_version, "touba-human-review-request-v1");
    clock.setNow(Date.now());
    const accepted = await postJson(`${baseUrl}/decisions`, {
      schema_version: "touba-human-review-decision-v1",
      request_id: pending.request_id,
      run_id: pending.run_id,
      trace_ref: pending.trace_ref,
      user_ref: USER_REF,
      device_ref: DEVICE_REF,
      outcome: "accepted",
      reviewed_by: USER_REF,
      reviewed_at: "1900-01-01T00:00:00.000Z",
      comment: null,
      client_ref: "durable-human-waits-test",
    });
    assert.equal(accepted.status, 202, await accepted.clone().text());
    assert.equal(humanRecord(root, pending.request_id).human_wait.resolution.kind, "decision");
    await service.stop();

    service = createToubaProjectServer({
      agentDecisionProvider,
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    const recoveredBaseUrl = serverBaseUrl(service);
    const decisionHistory = await getJson(`${recoveredBaseUrl}/decisions`);
    assert.equal(decisionHistory.summary.total, 1);
    assert.equal(decisionHistory.decisions[0].decision_kind, "human_review");
    const resumedResponse = await postJson(`${recoveredBaseUrl}/runs/sandbox/resume`, {
      request_id: pending.request_id,
    });
    assert.equal(resumedResponse.status, 200, await resumedResponse.clone().text());
    const resumed = await resumedResponse.json();
    assert.equal(resumed.status, "success");
    assert.equal(resumed.result, "accepted after human review");
    assert.equal(humanRecord(root, pending.request_id).status, "completed");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT live projection retry reuses the exact durable terminal result without rerunning runtime", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - DAY_MS - 2_000);
  const eventJournalPath = join(root, ".touba", "transient-project-events.jsonl");
  let completedObserverCalls = 0;
  const service = createToubaProjectServer({
    contractsRoot,
    eventJournalPath,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    humanWaitCompletedObserver() {
      completedObserverCalls += 1;
    },
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    await runSandbox(baseUrl, WAIT_TARGET);
    await settleAsync();
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    const deadlineMs = Date.parse(humanRecord(root, pending.request_id).human_wait.deadline_at);
    rmSync(eventJournalPath, { force: true });
    mkdirSync(eventJournalPath);
    clock.setNow(deadlineMs);
    clock.fire();
    const durable = await waitForRecord(root, pending.request_id, (record) => record.status === "completed");
    assert.equal(durable.human_wait.terminalization.attempt_count, 1);
    assert.equal(durable.human_wait.projections.terminal_event, null);
    assert.equal(completedObserverCalls, 1);
    await waitForActiveTimers(clock, 1);
    const retryTimer = clock.activeTimers()[0];
    assert.equal(retryTimer.delay, 30_000);

    rmSync(eventJournalPath, { recursive: true, force: true });
    clock.setNow(clock.now() + retryTimer.delay);
    clock.fire(retryTimer);
    const repaired = await waitForRecord(root, pending.request_id, (record) => (
      record.human_wait.projections.terminal_event !== null
    ));
    assert.equal(repaired.human_wait.terminalization.attempt_count, 1);
    assert.equal(canonicalDigest(repaired.result), canonicalDigest(durable.result));
    assert.equal(completedObserverCalls, 1);
    const events = readProjectEventJournal(eventJournalPath).filter((event) => (
      event.type === "human_wait.terminalized"
      && event.payload.request_id === pending.request_id
    ));
    assert.equal(events.length, 1);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT restart projects a completed decision into a still-running interaction before interruption recovery", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const sessionsPath = join(root, ".touba", "interaction-sessions.sqlite");
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const eventsPath = join(root, ".touba", "project-events.jsonl");
  let service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const session = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, session.session_id, "running_projection_window");
    await waitForInteractionStatus(
      baseUrl,
      session.session_id,
      operation.operation_id,
      "awaiting_human",
    );
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    const pausedSessions = readJson(sessionsPath);
    const pausedEventBytes = readFileSync(eventsPath, "utf8");
    clock.setNow(Date.now());
    assert.equal((await postJson(`${baseUrl}/decisions`, decisionFor(pending))).status, 202);
    assert.equal((await postJson(`${baseUrl}/interactions/sessions/${session.session_id}/resume`, {
      schema_version: "touba-interaction-resume-request-v1",
      request_id: pending.request_id,
    })).status, 202);
    await waitForInteractionStatus(
      baseUrl,
      session.session_id,
      operation.operation_id,
      "succeeded",
    );
    const completedRecord = humanRecord(root, pending.request_id);
    assert.equal(completedRecord.status, "completed");
    await service.stop();

    const crashSessions = structuredClone(pausedSessions);
    const crashSession = crashSessions.sessions.find((candidate) => candidate.session_id === session.session_id);
    const crashOperation = crashSession.operations.find((candidate) => candidate.operation_id === operation.operation_id);
    crashSession.status = "running";
    crashSession.last_run_status = "running";
    crashOperation.status = "running";
    crashOperation.completed_at = null;
    crashOperation.error = null;
    crashSession.messages.find((message) => message.operation_id === operation.operation_id && message.role === "user")
      .run_status = "running";
    writeJson(sessionsPath, crashSessions);
    writeFileSync(eventsPath, pausedEventBytes, "utf8");
    const crashStore = readJson(checkpointPath);
    const crashRecord = crashStore.records.find((record) => record.request_id === pending.request_id);
    crashRecord.human_wait.projections.terminal_event = null;
    crashRecord.human_wait.projections.interaction = null;
    writeJson(checkpointPath, crashStore);

    service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    await service.start();
    const recoveredBaseUrl = serverBaseUrl(service);
    const recovered = await getJson(
      `${recoveredBaseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}`,
    );
    assert.equal(recovered.status, "succeeded");
    assert.equal(recovered.error, null);
    const recoveredSession = await getJson(`${recoveredBaseUrl}/interactions/sessions/${session.session_id}`);
    assert.equal(recoveredSession.messages.at(-1).run_result.status, "success");
    assert.equal(
      recoveredSession.messages.some((message) => message.run_status === "interrupted"),
      false,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const twoApprovals of [false, true]) test(`WAIT completed projections survive bounded session retention without replaying effects (two approvals: ${twoApprovals})`, async () => {
  const root = createTestProject({ twoApprovals });
  let service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
  try {
    await service.start();
    const url = serverBaseUrl(service);
    const session = await createInteraction(url, WAIT_TARGET);
    const operation = await sendInteractionMessage(url, session.session_id, "retained_approval");
    await waitForInteractionStatus(url, session.session_id, operation.operation_id, "awaiting_human");
    const pending = await getJson(`${url}/approvals/pending/current`);
    assert.equal((await postJson(`${url}/decisions`, decisionFor(pending))).status, 202);
    const resumed = await postJson(`${url}/runs/sandbox/resume`, { request_id: pending.request_id });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    if (twoApprovals) {
      const second = await waitForDifferentPending(url, pending.request_id);
      assert.equal((await postJson(`${url}/decisions`, decisionFor(second))).status, 202);
      const finished = await postJson(`${url}/runs/sandbox/resume`, { request_id: second.request_id });
      assert.equal(finished.status, 200, await finished.clone().text());
    }
    await waitForInteractionStatus(url, session.session_id, operation.operation_id, "succeeded");
    const before = humanRecord(root, pending.request_id);
    assert.notEqual(before.human_wait.projections.terminal_event, null);
    for (let index = 0; index < 101; index += 1) await createInteraction(url, PURE_TARGET);
    assert.equal((await fetch(`${url}/interactions/sessions/${session.session_id}`)).status, 404);
    await service.stop();
    service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
    await service.start();
    assert.deepEqual(humanRecord(root, pending.request_id), before);
    const replay = await postJson(`${serverBaseUrl(service)}/decisions`, decisionFor(pending));
    assert.equal(replay.status, 409);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT startup recovery reads checkpoints through pages or indexed selections only", async () => {
  const root = createTestProject();
  let service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
  const originalPrepare = DatabaseSync.prototype.prepare;
  let paged = 0, physical = 0, selected = 0;
  try {
    await service.start();
    const url = serverBaseUrl(service);
    const session = await createInteraction(url, WAIT_TARGET);
    const operation = await sendInteractionMessage(url, session.session_id, "bounded_recovery");
    await waitForInteractionStatus(url, session.session_id, operation.operation_id, "awaiting_human");
    const pending = await getJson(`${url}/approvals/pending/current`);
    assert.equal((await postJson(`${url}/decisions`, decisionFor(pending))).status, 202);
    assert.equal((await postJson(`${url}/runs/sandbox/resume`, { request_id: pending.request_id })).status, 200);
    await waitForInteractionStatus(url, session.session_id, operation.operation_id, "succeeded");
    await service.stop();
    DatabaseSync.prototype.prepare = function(sql) {
      if (/^SELECT (?:rowid, )?id, revision, body FROM records/u.test(sql)) {
        const schema = originalPrepare.call(this, "SELECT schema_version FROM metadata WHERE singleton=1").get();
        if (schema?.schema_version === "touba-sandbox-checkpoints-v1") {
          assert.ok((sql.includes(" WHERE ") && !sql.includes(" WHERE 1")) || sql.includes(" LIMIT "),
            "recovery must not materialize all historical checkpoints");
          if (sql.includes(" LIMIT ")) {
            paged++;
            if (sql.includes("ORDER BY rowid")) physical++;
          }
          else selected++;
        }
      }
      return originalPrepare.call(this, sql);
    };
    service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
    await service.start();
    assert.ok(paged > 0, "exhaustive startup admission remains paginated");
    assert.ok(physical > 0, "internal exhaustive audits follow physical order");
    assert.ok(selected > 0, "recovery keeps indexed operation reads");
    const restored = await getJson(`${serverBaseUrl(service)}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}`);
    assert.equal(restored.status, "succeeded");
    await service.stop();
    DatabaseSync.prototype.prepare = originalPrepare;
    const checkpointPath = join(root, ".touba/sandbox-checkpoints.sqlite");
    const validStore = readJson(checkpointPath);
    for (const field of ["paused_result", "result"]) {
      const corrupted = structuredClone(validStore);
      const record = corrupted.records.find(candidate => candidate.record_kind === "human");
      record[field].diagnostics.push({ code: "ChangedAfterValidation" });
      // On the terminal result, one resealed marker must not hide the stale
      // second marker, even though the two share a per-validation digest.
      if (field === "result") record.human_wait.projections.terminal_event.result_digest = canonicalDigest(record.result);
      writeStoreFixture(checkpointPath, corrupted);
      const before = readFileSync(checkpointPath);
      assert.throws(() => loadSandboxCheckpointStore(checkpointPath), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
      assert.deepEqual(readFileSync(checkpointPath), before);
    }
  } finally {
    DatabaseSync.prototype.prepare = originalPrepare;
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT recovery rereads contract schemas on each pass", async () => {
  const root = createTestProject();
  const localContracts = join(root, "test-contracts");
  cpSync(contractsRoot, localContracts, { recursive: true });
  let service = createToubaProjectServer({ contractsRoot: localContracts, projectRoot: root, port: 0, quiet: true });
  try {
    await service.start();
    const url = serverBaseUrl(service);
    await runSandbox(url, WAIT_TARGET);
    const pending = await getJson(`${url}/approvals/pending/current`);
    assert.equal((await postJson(`${url}/decisions`, decisionFor(pending))).status, 202);
    assert.equal((await postJson(`${url}/runs/sandbox/resume`, { request_id: pending.request_id })).status, 200);
    await service.stop();
    service = createToubaProjectServer({ contractsRoot: localContracts, projectRoot: root, port: 0, quiet: true });
    await service.start();
    await service.stop();
    const path = join(localContracts, "schemas/touba-approval-request-v1.schema.json");
    const schema = readJson(path);
    schema.required.push("changed_contract_requirement");
    writeJson(path, schema);
    service = createToubaProjectServer({ contractsRoot: localContracts, projectRoot: root, port: 0, quiet: true });
    await assert.rejects(() => service.start(), { code: "ToubaServePendingHumanRequestInvalid" });
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

// Include the exact retained-history sizes reported by the industrial pilot.
// Histories are created through real decisions/resumes, never cloned as successes.
const extendedHistory = process.env.TOUBA_HTTP_HISTORY_COUNTS;
const historyMatrix = process.env.TOUBA_HTTP_HISTORY_MATRIX === "1";
const historyCounts = extendedHistory ? extendedHistory.split(",").map(Number) : [0, 16, 50, 100];
if (historyCounts.length > 4 || historyCounts.some(count => !Number.isSafeInteger(count) || count < 0 || count > 10000)) {
  throw new Error("TOUBA_HTTP_HISTORY_COUNTS requires up to four counts between 0 and 10000");
}
for (const historyCount of historyCounts) test(`WAIT ${historyCount} completed approvals preserve restart and eight concurrent multi-handler sessions`, { timeout: (historyMatrix ? 1800000 : 180000) + historyCount * 2000 }, async t => {
  const replay = process.env.TOUBA_HTTP_HISTORY_REPLAY_DIR;
  if (replay) assert.ok(historyMatrix, "retained histories are for the repeated matrix only");
  const root = replay ? restoreHttpHistoryFixture(replay, historyCount) : createTestProject({ withSentinel: true });
  const marker = join(root, "concurrent-writes.txt");
  if (replay) {
    t.diagnostic(`Replaying retained ${historyCount} real approval/resume flows with unchanged build and project origin; no new baseline outcomes`);
    try { await qualifyHttpHistoryMatrix(root, historyCount, marker, t); }
    finally { rmSync(root, { recursive: true, force: true }); }
    return;
  }
  configureSentinelHandler(root, marker);
  const manifestPath = join(root, "touba.manifest.json");
  const manifest = readJson(manifestPath);
  manifest.bindings["tool:demo.approval/Sentinel"].timeout_ms = 5000;
  writeJson(manifestPath, manifest);
  // The concurrent path dispatches three real processes before its approval pause.
  // Keep the separate history path unchanged and do not rewrite saved evidence.
  const airPath = join(root, ".touba/air/demo/approval.air.json");
  const air = readJson(airPath);
  const sentinel = air.execution_graphs.find(graph => graph.owner_ref === SENTINEL_TARGET);
  const dispatch = sentinel.nodes.find(node => node.id === "sentinel");
  sentinel.nodes.push({ ...structuredClone(dispatch), id: "sentinel2" }, { ...structuredClone(dispatch), id: "sentinel3" });
  sentinel.entry_node_id = "sentinel";
  sentinel.edges = [edge("sentinel", "sentinel2", "next"), edge("sentinel2", "sentinel3", "next"),
    edge("sentinel3", "approval_sentinel", "next"), edge("approval_sentinel", "sentinel_done", "next")];
  writeJson(airPath, air);
  let service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
  const lag = monitorEventLoopDelay({ resolution: 10 });
  try {
    await service.start();
    const url = serverBaseUrl(service);
    const started = performance.now();
    for (let index = 0; index < historyCount; index++) {
      const session = await createInteraction(url, WAIT_TARGET);
      const operation = await sendInteractionMessage(url, session.session_id, `history-${index}`);
      await waitForInteractionStatus(url, session.session_id, operation.operation_id, "awaiting_human");
      const pending = await getJson(`${url}/approvals/pending/current`);
      assert.equal((await postJson(`${url}/decisions`, decisionFor(pending))).status, 202);
      const resumed = await postJson(`${url}/runs/sandbox/resume`, { request_id: pending.request_id });
      assert.equal(resumed.status, 200, await resumed.clone().text());
      await waitForInteractionStatus(url, session.session_id, operation.operation_id, "succeeded");
      if (extendedHistory && (index + 1) % 100 === 0) process.stdout.write(`HTTP_HISTORY ${JSON.stringify({ target: historyCount, completed: index + 1, elapsed_ms: Math.round(performance.now() - started), rss_bytes: process.memoryUsage().rss })}\n`);
    }
    t.diagnostic(`${historyCount} actual approval/resume flows: ${Math.round(performance.now() - started)} ms`);
    await service.stop();
    if (historyMatrix) {
      await qualifyHttpHistoryMatrix(root, historyCount, marker, t);
      return;
    }
    const restartAt = performance.now();
    service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
    await service.start();
    const restartMs = performance.now() - restartAt;
    t.diagnostic(`Restart with ${historyCount} completed checkpoints: ${Math.round(restartMs)} ms`);
    assert.ok(restartMs < 10000, `restart took ${Math.round(restartMs)} ms`);
    const storePath = join(root, ".touba/sandbox-checkpoints.sqlite");
    assert.equal(loadSandboxCheckpointStore(storePath).records.filter(record => record.status === "completed").length, historyCount);
    const concurrentAt = performance.now();
    lag.enable();
    const results = await Promise.all(Array.from({ length: 8 }, async (_, index) => {
      const base = serverBaseUrl(service);
      const session = await createInteraction(base, SENTINEL_TARGET, "allow_declared_external_effects");
      const operation = await sendInteractionMessage(base, session.session_id, `concurrent-${index}`);
      return waitForInteractionOperation(base, session.session_id, operation.operation_id);
    }));
    t.diagnostic(`Eight concurrent three-handler sessions after history: ${Math.round(performance.now() - concurrentAt)} ms`);
    lag.disable();
    t.diagnostic(`Event-loop lag: mean ${(lag.mean / 1e6).toFixed(1)} ms, max ${(lag.max / 1e6).toFixed(1)} ms`);
    assert.deepEqual(results.map(result => result.status), Array(8).fill("awaiting_human"), JSON.stringify(results));
    assert.equal(new Set(results.map(result => result.operation_id)).size, 8);
    assert.equal(readFileSync(marker, "utf8"), "dispatched\n".repeat(24));
    const effects = Object.values(readJson(join(root, ".touba/project.effect-journal.sqlite")).entries);
    assert.equal(effects.length, 24);
    assert.ok(effects.every(effect => effect.state === "applied"));
    await service.stop();
    // A terminal record is still evidence: optimization must not ignore corruption.
    const store = readJson(storePath);
    store.records[0].human_wait.request_digest = "sha256:" + "0".repeat(64);
    writeJson(storePath, store);
    assert.throws(() => createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true }),
      { code: "ToubaServeSandboxCheckpointStoreInvalid" });
  } finally { lag.disable(); await service.stop(); rmSync(root, { recursive: true, force: true }); }
});

async function qualifyHttpHistoryMatrix(root, history, marker, t) {
  const backup = mkdtempSync(join(tmpdir(), "touba-http-history-baseline-"));
  const state = join(root, ".touba");
  cpSync(state, join(backup, "state"), { recursive: true });
  const failures = [];
  try {
    for (let repetition = 0; repetition < 3; repetition++) for (const concurrency of [1, 8, 32]) {
      // Restore only this disposable fixture, with all services stopped. Keep
      // its absolute path because checkpoint origin is bound to that path.
      rmSync(state, { recursive: true });
      cpSync(join(backup, "state"), state, { recursive: true });
      writeFileSync(marker, "");
      const { stdout } = await promisify(execFile)(process.execPath, ["--max-old-space-size=512",
        fileURLToPath(new URL("./http-history-profile.mjs", import.meta.url)),
        JSON.stringify({ root, history, repetition, concurrency })], { encoding: "utf8", timeout: 180000, signal: t.signal, maxBuffer: 8 * 1024 * 1024 })
        .catch(error => {
          // Preserve partial observations even when a later flow fails.
          for (const line of (error.stdout ?? "").trim().split("\n").filter(Boolean)) process.stdout.write(`HTTP_PROFILE ${line}\n`);
          process.stderr.write(error.stderr ?? "");
          throw error;
        });
      const observations = stdout.trim().split("\n").map(line => JSON.parse(line));
      for (const observation of observations) {
        process.stdout.write(`HTTP_PROFILE ${JSON.stringify(observation)}\n`);
        if (observation.kind === "startup") {
          if (observation.milliseconds > 10000) failures.push({ history, repetition, concurrency, limit: "startup_10s" });
        } else {
          if (observation.peak_rss_bytes > 512 * 1024 * 1024) failures.push({ history, repetition, concurrency, limit: "rss_512mib" });
          if (observation.quantiles.total.p95_ms > 30000) failures.push({ history, repetition, concurrency, limit: "flow_p95_30s" });
          if (observation.throughput_per_second < 0.5) failures.push({ history, repetition, concurrency, limit: "throughput_0.5" });
          assert.deepEqual(observation.errors, []);
        }
      }
      assert.equal(readFileSync(marker, "utf8"), "dispatched\n".repeat(6 * concurrency));
      const effects = Object.values(readJson(join(root, ".touba/project.effect-journal.sqlite")).entries);
      assert.equal(effects.length, 6 * concurrency);
      assert.ok(effects.every(effect => effect.state === "applied"));
      assert.equal(completedCheckpointCount(join(state, "sandbox-checkpoints.sqlite")), history + 2 * concurrency);
      t.diagnostic(`Observer RSS after count: ${process.memoryUsage().rss} bytes`);
    }
    t.diagnostic(`HTTP matrix: history=${history}, 3 repetitions, concurrency=1/8/32, two waves per fresh process`);
    // Check the final page too: a bounded startup audit must not stop early.
    const path = join(state, "sandbox-checkpoints.sqlite");
    corruptLastCheckpoint(path);
    assert.throws(() => createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true }),
      { code: "ToubaServeSandboxCheckpointStoreInvalid" });
    assert.deepEqual(failures, [], JSON.stringify(failures));
  } finally {
    try {
      if (process.env.TOUBA_HTTP_HISTORY_EVIDENCE_DIR) {
        mkdirSync(process.env.TOUBA_HTTP_HISTORY_EVIDENCE_DIR, { recursive: true, mode: 0o700 });
        const evidence = mkdtempSync(join(process.env.TOUBA_HTTP_HISTORY_EVIDENCE_DIR, `history-${history}-`));
        // The baseline was copied with the server stopped, before all timed
        // processes. Keep its exact origin and source path; never reattribute
        // these completed runs to a future build during diagnosis.
        cpSync(join(backup, "state"), join(evidence, "state"), { recursive: true });
        cpSync(root, join(evidence, "project"), { recursive: true, filter: source => source !== state && source !== marker });
        writeJson(join(evidence, "preservation.json"), {
          history, originalProjectRoot: root, origin: readJson(join(backup, "state/state-origin.json")),
          note: "Coherent synthetic baseline retained after all timed processes; not new outcomes.",
        });
        t.diagnostic(`Preserved coherent synthetic baseline: ${evidence}`);
      }
    } finally { rmSync(backup, { recursive: true, force: true }); }
  }
}

test("offline preflight and startup both refuse an orphan interaction projection without altering stored state", async () => {
  const root = createTestProject();
  const service = createToubaProjectServer({contractsRoot, projectRoot: root, port: 0, quiet: true});
  try {
    await service.start();
    const url = serverBaseUrl(service);
    const session = await createInteraction(url, WAIT_TARGET);
    const operation = await sendInteractionMessage(url, session.session_id, "orphan projection regression");
    await waitForInteractionStatus(url, session.session_id, operation.operation_id, "awaiting_human");
    await service.stop();
    assert.equal(checkToubaProjectState({projectRoot: root}).status, "structurally_valid");
    const sessionsPath = join(root, ".touba/interaction-sessions.sqlite");
    const store = readStoreFixture(sessionsPath);
    store.sessions = [];
    writeStoreFixture(sessionsPath, store);
    const paths = [sessionsPath, join(root, ".touba/sandbox-checkpoints.sqlite"), join(root, ".touba/state-origin.json")];
    const bytes = paths.map(path => readFileSync(path));
    const checked = checkToubaProjectState({projectRoot: root});
    assert.equal(checked.status, "refused");
    assert.ok(checked.diagnostics.some(d => d.code === "ToubaServeSandboxCheckpointStoreInvalid" && d.related_store === "interactionSessionsPath"), JSON.stringify(checked));
    assert.throws(() => createToubaProjectServer({contractsRoot, projectRoot: root, port: 0, quiet: true}), {code: "ToubaServeSandboxCheckpointStoreInvalid"});
    paths.forEach((path, index) => assert.deepEqual(readFileSync(path), bytes[index]));
  } finally { await service.stop(); rmSync(root, {recursive: true, force: true}); }
});

test("WAIT rejects a pause projection marker bound to a foreign interaction session without side effects", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const eventsPath = join(root, ".touba", "project-events.jsonl");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const owner = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, owner.session_id, "foreign_marker_owner");
    await waitForInteractionStatus(baseUrl, owner.session_id, operation.operation_id, "awaiting_human");
    const foreign = await createInteraction(baseUrl, WAIT_TARGET);
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    await service.stop();

    const store = readJson(checkpointPath);
    const record = store.records.find((candidate) => candidate.request_id === pending.request_id);
    assert.notEqual(record.human_wait.projections.pause_interaction, null);
    record.human_wait.projections.pause_interaction.session_id = foreign.session_id;
    const corruptedBytes = `${JSON.stringify(store)}\n`;
    const journalBytes = readFileSync(eventsPath, "utf8");
    writeFileSync(checkpointPath, corruptedBytes, "utf8");
    assert.throws(() => createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    }), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
    assert.equal(readFileSync(checkpointPath, "utf8"), corruptedBytes);
    assert.equal(readFileSync(eventsPath, "utf8"), journalBytes);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT rejects a terminal event marker that bypasses its exact interaction projection", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const eventsPath = join(root, ".touba", "project-events.jsonl");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const session = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, session.session_id, "terminal_marker_order");
    await waitForInteractionStatus(baseUrl, session.session_id, operation.operation_id, "awaiting_human");
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    clock.setNow(Date.now());
    const cancelled = await postJson(
      `${baseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}/cancel`,
      {},
    );
    assert.equal([200, 202].includes(cancelled.status), true, await cancelled.clone().text());
    await waitForRecord(root, pending.request_id, (record) => (
      record.status === "completed"
      && record.human_wait.projections.interaction !== null
      && record.human_wait.projections.terminal_event !== null
    ));
    await service.stop();

    const store = readJson(checkpointPath);
    const record = store.records.find((candidate) => candidate.request_id === pending.request_id);
    assert.notEqual(record.human_wait.projections.pause_interaction, null);
    assert.notEqual(record.human_wait.projections.terminal_event, null);
    record.human_wait.projections.interaction = null;
    const corruptedBytes = `${JSON.stringify(store)}\n`;
    const journalBytes = readFileSync(eventsPath, "utf8");
    writeFileSync(checkpointPath, corruptedBytes, "utf8");
    assert.throws(() => createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    }), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
    assert.equal(readFileSync(checkpointPath, "utf8"), corruptedBytes);
    assert.equal(readFileSync(eventsPath, "utf8"), journalBytes);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT rejects cancellation once a decision owns the paused interaction and then resumes exactly once", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const session = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, session.session_id, "decision_beats_cancel");
    await waitForInteractionStatus(baseUrl, session.session_id, operation.operation_id, "awaiting_human");
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    clock.setNow(Date.now());
    assert.equal((await postJson(`${baseUrl}/decisions`, decisionFor(pending))).status, 202);

    const cancellation = await postJson(
      `${baseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}/cancel`,
      {},
    );
    assert.equal(cancellation.status, 409, await cancellation.clone().text());
    assert.equal((await cancellation.json()).code, "ToubaServeHumanWaitConflict");
    const afterCancel = humanRecord(root, pending.request_id);
    assert.equal(afterCancel.status, "resolution_claimed");
    assert.equal(afterCancel.human_wait.resolution.kind, "decision");
    assert.equal((await getJson(
      `${baseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}`,
    )).status, "awaiting_human");

    const resume = await postJson(`${baseUrl}/interactions/sessions/${session.session_id}/resume`, {
      schema_version: "touba-interaction-resume-request-v1",
      request_id: pending.request_id,
    });
    assert.equal(resume.status, 202, await resume.clone().text());
    await waitForInteractionStatus(baseUrl, session.session_id, operation.operation_id, "succeeded");
    assert.equal(humanRecord(root, pending.request_id).status, "completed");
    assert.equal(
      readProjectEventJournal(join(root, ".touba", "project-events.jsonl"))
        .some((event) => (
          event.type === "interaction.run.cancel_requested"
          && event.payload.operation_id === operation.operation_id
        )),
      false,
    );
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT interaction resume refuses a same-run session with divergent operation and target identities", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const sessionsPath = join(root, ".touba", "interaction-sessions.sqlite");
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanWaitRuntime: clock.runtime,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = serverBaseUrl(service);
    const owner = await createInteraction(baseUrl, WAIT_TARGET);
    const operation = await sendInteractionMessage(baseUrl, owner.session_id, "exact_resume_owner");
    await waitForInteractionStatus(baseUrl, owner.session_id, operation.operation_id, "awaiting_human");
    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    clock.setNow(Date.now());
    assert.equal((await postJson(`${baseUrl}/decisions`, decisionFor(pending))).status, 202);

    const store = readJson(sessionsPath);
    const foreign = structuredClone(store.sessions.find((session) => session.session_id === owner.session_id));
    foreign.session_id = `${owner.session_id}_foreign`;
    foreign.target_ref = PURE_TARGET;
    foreign.operations[0].session_id = foreign.session_id;
    foreign.operations[0].operation_id = `${operation.operation_id}_foreign`;
    foreign.operations[0].target_ref = PURE_TARGET;
    for (const message of foreign.messages) {
      message.operation_id = foreign.operations[0].operation_id;
    }
    store.sessions.push(foreign);
    writeJson(sessionsPath, store);
    const arbiterBytes = readFileSync(checkpointPath, "utf8");
    const refused = await postJson(`${baseUrl}/interactions/sessions/${foreign.session_id}/resume`, {
      schema_version: "touba-interaction-resume-request-v1",
      request_id: pending.request_id,
    });
    assert.equal(refused.status, 409, await refused.clone().text());
    assert.equal((await refused.json()).code, "ToubaServeHumanWaitConflict");
    assert.equal(readFileSync(checkpointPath, "utf8"), arbiterBytes);
    assert.equal((await getJson(
      `${baseUrl}/interactions/sessions/${foreign.session_id}/operations/${foreign.operations[0].operation_id}`,
    )).status, "awaiting_human");
    assert.equal((await getJson(
      `${baseUrl}/interactions/sessions/${owner.session_id}/operations/${operation.operation_id}`,
    )).status, "awaiting_human");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("WAIT request and decision projections reject wrong collections and duplicates without mutating the arbiter", async (t) => {
  await t.test("approval request and decision projection cardinality", async () => {
    const root = createTestProject();
    const clock = controlledClock(Date.now());
    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
    const requestsPath = join(root, ".touba", "human-requests.sqlite");
    const decisionsPath = join(root, ".touba", "human-decisions.sqlite");
    let service = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    try {
      await service.start();
      const baseUrl = serverBaseUrl(service);
      await runSandbox(baseUrl, WAIT_TARGET);
      const pending = await getJson(`${baseUrl}/approvals/pending/current`);
      await service.stop();
      const arbiterBytes = readFileSync(checkpointPath, "utf8");
      const canonicalRequests = readJson(requestsPath);
      const approval = canonicalRequests.approvals[0];
      const divergentApproval = { ...approval, summary: `${approval.summary} Divergent.` };
      for (const requestStore of [
        { ...canonicalRequests, approvals: [], reviews: [approval] },
        { ...canonicalRequests, approvals: [approval, structuredClone(approval)] },
        { ...canonicalRequests, approvals: [approval, divergentApproval] },
      ]) {
        writeStoreFixture(requestsPath, requestStore);
        const bytes = readFileSync(requestsPath, "utf8");
        await expectServerRepairFailure({ clock, root });
        assert.equal(readFileSync(checkpointPath, "utf8"), arbiterBytes);
        assert.equal(readFileSync(requestsPath, "utf8"), bytes);
      }

      writeJson(requestsPath, canonicalRequests);
      service = createToubaProjectServer({
        contractsRoot,
        projectRoot: root,
        humanWaitRuntime: clock.runtime,
        port: 0,
        quiet: true,
      });
      await service.start();
      clock.setNow(Date.now());
      assert.equal((await postJson(`${serverBaseUrl(service)}/decisions`, decisionFor(pending))).status, 202);
      await service.stop();
      const claimedArbiterBytes = readFileSync(checkpointPath, "utf8");
      const decision = readJson(decisionsPath).decisions[0];

      writeJson(decisionsPath, {
        schema_version: "touba-human-decisions-v1",
        decisions: [],
      });
      service = createToubaProjectServer({
        contractsRoot,
        projectRoot: root,
        humanWaitRuntime: clock.runtime,
        port: 0,
        quiet: true,
      });
      await service.start();
      assert.deepEqual(readJson(decisionsPath).decisions, [decision]);
      await service.stop();
      service = createToubaProjectServer({
        contractsRoot,
        projectRoot: root,
        humanWaitRuntime: clock.runtime,
        port: 0,
        quiet: true,
      });
      await service.start();
      assert.deepEqual(readJson(decisionsPath).decisions, [decision]);
      await service.stop();

      for (const duplicate of [
        structuredClone(decision),
        { ...decision, comment: "divergent duplicate" },
      ]) {
        const decisionStore = {
          schema_version: "touba-human-decisions-v1",
          decisions: [decision, duplicate],
        };
        writeStoreFixture(decisionsPath, decisionStore);
        const bytes = readFileSync(decisionsPath, "utf8");
        await expectServerRepairFailure({ clock, root });
        assert.equal(readFileSync(checkpointPath, "utf8"), claimedArbiterBytes);
        assert.equal(readFileSync(decisionsPath, "utf8"), bytes);
      }
    } finally {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });

  await t.test("human review stored as an approval", async () => {
    const root = createAgentReviewProject();
    const clock = controlledClock(Date.now());
    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
    const requestsPath = join(root, ".touba", "human-requests.sqlite");
    const service = createToubaProjectServer({
      agentDecisionProvider: testAgentDecisionProvider,
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
    try {
      await service.start();
      await runSandbox(serverBaseUrl(service), REVIEW_TARGET);
      await service.stop();
      const arbiterBytes = readFileSync(checkpointPath, "utf8");
      const store = readJson(requestsPath);
      store.approvals = [store.reviews[0]];
      store.reviews = [];
      writeStoreFixture(requestsPath, store);
      const bytes = readFileSync(requestsPath, "utf8");
      await expectServerRepairFailure({
        agentDecisionProvider: testAgentDecisionProvider,
        clock,
        root,
      });
      assert.equal(readFileSync(checkpointPath, "utf8"), arbiterBytes);
      assert.equal(readFileSync(requestsPath, "utf8"), bytes);
    } finally {
      await service.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});

test("configured attestation timeout refuses without claiming and permits a later verified decision", async t => {
  const root = createTestProject(); t.after(() => rmSync(root, { recursive: true, force: true }));
  let slow = true;
  const authority = async ({ request, decision, hostDecision }) => {
    if (slow) await new Promise(resolve => setTimeout(resolve, 80));
    return { request_id: request.request_id, run_id: request.run_id, decision, subject_ref: hostDecision.user_ref, roles: [] };
  };
  const options = { contractsRoot, projectRoot: root, port: 0, quiet: true, humanApprovalAuthority: authority };
  let service = createToubaProjectServer({ ...options, humanApprovalAuthorityTimeoutMs: 10 });
  try {
    await service.start();
    await runSandbox(serverBaseUrl(service), WAIT_TARGET);
    const pending = await getJson(`${serverBaseUrl(service)}/approvals/pending/current`);
    const denied = await postJson(`${serverBaseUrl(service)}/decisions`, decisionFor(pending));
    assert.equal(denied.status, 503);
    assert.equal((await denied.json()).code, "HumanApprovalAuthorityUnavailable");
    await new Promise(resolve => setTimeout(resolve, 100));
    assert.equal(humanRecord(root, pending.request_id).human_wait.resolution, null);
    await service.stop();
    service = createToubaProjectServer({ ...options, humanApprovalAuthorityTimeoutMs: 1000 });
    await service.start();
    const accepted = await postJson(`${serverBaseUrl(service)}/decisions`, decisionFor(pending));
    assert.equal(accepted.status, 202, await accepted.clone().text());
    slow = false;
    const resumed = await postJson(`${serverBaseUrl(service)}/runs/sandbox/resume`, { request_id: pending.request_id });
    assert.equal(resumed.status, 200, await resumed.clone().text());
  } finally { await service.stop(); }
});

test("source approval roles are checked before claim and timely acceptance survives restart past its deadline", async t => {
  const root = createTestProject(); t.after(() => rmSync(root, { recursive: true, force: true }));
  compilePolicyProject(root, `        human.approve
            with context as "invoice"
            with role as "finance"
            with timeout_ms as 1500
            into approval
        give "accepted"
`);
  let activeRole = false, verifications = 0;
  const authority = ({ request, decision, hostDecision, evidenceRef }) => {
    verifications++;
    assert.equal(evidenceRef, "evidence:review-42");
    assert.equal(hostDecision.run_id, request.run_id);
    return { request_id: request.request_id, run_id: request.run_id, decision, subject_ref: hostDecision.user_ref,
      roles: activeRole ? ["finance"] : [] };
  };
  const options = { contractsRoot, projectRoot: root, port: 0, quiet: true, humanApprovalAuthority: authority };
  let service = createToubaProjectServer(options);
  try {
    await service.start(); const base = serverBaseUrl(service);
    await runSandbox(base, WAIT_TARGET);
    const pending = await getJson(`${base}/approvals/pending/current`);
    assert.deepEqual(pending.policy, { role: "finance", timeout_ms: 1500 });
    const record = humanRecord(root, pending.request_id);
    const occurrence = record.checkpoint.approval_state.requests[record.approval_ref];
    assert.equal(pending.expires_at, occurrence.deadline_at);
    assert.equal(Date.parse(occurrence.deadline_at) - Date.parse(occurrence.created_at), 1500);
    const denied = await postJson(`${base}/decisions`, { ...decisionFor(pending), evidence_ref: "evidence:review-42" });
    assert.ok(denied.status >= 400, await denied.clone().text());
    assert.equal(humanRecord(root, pending.request_id).human_wait.resolution, null);
    activeRole = true;
    const accepted = await postJson(`${base}/decisions`, { ...decisionFor(pending), evidence_ref: "evidence:review-42" });
    assert.equal(accepted.status, 202, await accepted.clone().text());
    assert.equal(humanRecord(root, pending.request_id).checkpoint.approval_state.receipts.length, 1);
    await service.stop(); activeRole = false;
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(pending.expires_at) - Date.now() + 20)));
    service = createToubaProjectServer(options); await service.start();
    const resumed = await postJson(`${serverBaseUrl(service)}/runs/sandbox/resume`, { request_id: pending.request_id });
    assert.equal(resumed.status, 200, await resumed.clone().text());
    assert.equal((await resumed.json()).result, "accepted");
    assert.equal(verifications, 2);
  } finally { await service.stop(); }
});

test("trusted host approval needs no local identity directory and rejects substituted signers", async t => {
  const root = createTestProject({ withIdentity: false });
  t.after(() => rmSync(root, { recursive: true, force: true }));
  let subject = "user:other", calls = 0;
  const authority = ({ request, decision, evidenceRef }) => {
    calls++;
    assert.equal(evidenceRef, "receipt:application");
    return { request_id: request.request_id, run_id: request.run_id, decision, subject_ref: subject, roles: [] };
  };
  const service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true, humanApprovalAuthority: authority });
  await service.start(); t.after(() => service.stop());
  const base = serverBaseUrl(service);
  await runSandbox(base, WAIT_TARGET);
  const pending = await getJson(`${base}/approvals/pending/current`);
  assert.deepEqual(pending.policy, {});
  const decision = { ...decisionFor(pending), evidence_ref: "receipt:application" };
  const wrongRun = await postJson(`${base}/decisions`, { ...decision, run_id: "run:foreign" });
  assert.equal(wrongRun.status, 409);
  assert.equal(calls, 0);
  const denied = await postJson(`${base}/decisions`, decision);
  assert.equal(denied.status, 503);
  assert.equal(humanRecord(root, pending.request_id).human_wait.resolution, null);
  subject = decision.user_ref;
  const accepted = await postJson(`${base}/decisions`, decision);
  assert.equal(accepted.status, 202, await accepted.clone().text());
  assert.equal(calls, 2);
  assert.equal(humanRecord(root, pending.request_id).checkpoint.approval_state.receipts[0].subject_ref, subject);
});

test("removing the host adapter cannot bypass a persisted attestation requirement", async t => {
  const root = createTestProject();
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const options = { contractsRoot, projectRoot: root, port: 0, quiet: true };
  let service = createToubaProjectServer({ ...options, humanApprovalAuthority: () => assert.fail("no decision yet") });
  try {
    await service.start(); await runSandbox(serverBaseUrl(service), WAIT_TARGET);
    const pending = await getJson(`${serverBaseUrl(service)}/approvals/pending/current`);
    await service.stop();
    service = createToubaProjectServer(options); await service.start();
    const refused = await postJson(`${serverBaseUrl(service)}/decisions`, decisionFor(pending));
    assert.equal(refused.status, 503, await refused.clone().text());
    assert.equal((await refused.json()).code, "HumanApprovalAuthorityRequired");
    assert.equal(humanRecord(root, pending.request_id).human_wait.resolution, null);
  } finally { await service.stop(); }
});

test("source deadline creates a durable escalation instead of authorizing the expired path", async t => {
  const root = createTestProject(); t.after(() => rmSync(root, { recursive: true, force: true }));
  const clock = controlledClock(Date.now());
  compilePolicyProject(root, `        human.approve
            with context as "invoice"
            with timeout_ms as 250
            into approval
            on expired
                human.approve
                    with context as "manager review"
                    with role as "finance_manager"
                    with timeout_ms as 60000
                    into escalation
                give "manager accepted"
        give "initial accepted"
`);
  const options = { contractsRoot, projectRoot: root, port: 0, quiet: true, humanWaitRuntime: clock.runtime };
  let service = createToubaProjectServer(options);
  try {
    await service.start(); const base = serverBaseUrl(service);
    const paused = await runSandbox(base, WAIT_TARGET);
    assert.equal(paused.reason, "human_approval_pending");
    const initial = await getJson(`${base}/approvals/pending/current`);
    // Freeze expiry until the initial request has been observed, even on a
    // slow disk; then cross the real source deadline explicitly.
    await new Promise(resolve => setTimeout(resolve, Math.max(0, Date.parse(initial.expires_at) - Date.now() + 1)));
    clock.setNow(Date.now());
    const nextResponse = await fetch(`${base}/approvals/pending/current`);
    assert.equal(nextResponse.status, 200, JSON.stringify(humanRecord(root, initial.request_id)));
    const next = await nextResponse.json();
    assert.notEqual(next.request_id, initial.request_id, JSON.stringify(humanRecord(root, initial.request_id)));
    assert.equal(humanRecord(root, initial.request_id).status, "superseded");
    const record = humanRecord(root, next.request_id);
    assert.equal(record.checkpoint.approval_state.requests[record.approval_ref].policy.role, "finance_manager");
    await service.stop(); service = createToubaProjectServer(options); await service.start();
    assert.equal((await getJson(`${serverBaseUrl(service)}/approvals/pending/current`)).request_id, next.request_id);
  } finally { await service.stop(); }
});

function compilePolicyProject(root, body) {
  const path = join(root, "src/demo/approval.tb");
  writeFileSync(path, `module demo.approval\nstrategy RunApproval\n    gives Text\n    do\n${body}`);
  const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path",
    fileURLToPath(new URL("../../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--", path], { encoding: "utf8" }));
  writeJson(join(root, ".touba/air/demo/approval.air.json"), air);
}

function createTestProject({ twoApprovals = false, withSentinel = false, withIdentity = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), "touba-durable-human-waits-"));
  writeJson(join(root, "touba.project.json"), { entry: WAIT_TARGET, entrypoints: [PURE_TARGET, SENTINEL_TARGET] });
  mkdirSync(join(root, "src", "demo"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "demo", "approval.tb"), "module demo.approval\n", "utf8");
  writeJson(
    join(root, ".touba", "air", "demo", "approval.air.json"),
    approvalAirDocument({ twoApprovals, withSentinel }),
  );
  if (withIdentity) writeTestDecisionIdentity(root);
  return root;
}

function createAgentReviewProject() {
  const root = mkdtempSync(join(tmpdir(), "touba-durable-human-review-"));
  writeJson(join(root, "touba.project.json"), { entry: REVIEW_TARGET });
  mkdirSync(join(root, "src", "demo"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "demo", "review.tb"), "module demo.review\n", "utf8");
  writeJson(join(root, ".touba", "air", "demo", "review.air.json"), agentReviewAirDocument());
  writeTestDecisionIdentity(root);
  return root;
}

function agentReviewAirDocument() {
  const agentRef = "agent:demo.review/Reviewer";
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: { id: "module:demo.review", name: "demo.review", source_ref: sourceRef() },
    definitions: {
      types: [],
      constants: [],
      functions: [],
      tools: [],
      memories: [],
      skills: [],
      agents: [{
        id: agentRef,
        name: "Reviewer",
        description: "Produces a draft that requires explicit human review.",
        responsibility: "Prepare one governed draft.",
        uses: [],
        use_refs: [],
        callable_by: [{
          caller_ref: REVIEW_TARGET,
          caller_kind: "strategy",
          source_ref: sourceRef(),
        }],
        source_ref: sourceRef(),
      }],
      strategies: [{
        id: REVIEW_TARGET,
        name: "RunReview",
        description: "Runs an agent whose draft requires review.",
        signature: { inputs: [], output_type: "builtin:Text" },
        uses: [agentRef],
        use_refs: [{ target_ref: agentRef, source_ref: sourceRef() }],
        flow_graph_ref: "graph:strategy:demo.review/RunReview",
        source_ref: sourceRef(),
      }],
      triggers: [],
    },
    execution_graphs: [
      graph("graph:strategy:demo.review/RunReview", REVIEW_TARGET, [
        node("review_agent", "call_agent", {
          target_ref: agentRef,
          result_binding: "review_result",
        }),
        node("review_done", "give", { arguments: ["value:review_result"] }),
      ], [edge("review_agent", "review_done", "next")]),
    ],
    trace_points: [],
  };
}

function testAgentDecisionProvider(request) {
  if (request.step_index === 0 && request.mode === "summary") {
    return {
      action: "request_capabilities",
      reason: "human review may be required",
    };
  }
  if (request.step_index === 0 && request.mode === "capabilities") {
    return {
      action: "request_human_review",
      source: "durable_human_wait_test",
      reason: "a reviewer must confirm the draft",
      review_prompt: "Confirm the generated draft.",
    };
  }
  return {
    action: "answer_directly",
    source: "durable_human_wait_test",
    reason: "the review was accepted",
    result: "accepted after human review",
  };
}

function approvalAirDocument({ twoApprovals = false, withSentinel = false } = {}) {
  const strategies = [
    {
      id: WAIT_TARGET,
      name: "RunApproval",
      description: "Pauses at a durable human approval boundary.",
      signature: { inputs: [], output_type: "builtin:Approval" },
      flow_graph_ref: "graph:strategy:demo.approval/RunApproval",
      source_ref: sourceRef(),
    },
    {
      id: PURE_TARGET,
      name: "RunPure",
      description: "Returns without a human boundary.",
      signature: { inputs: [], output_type: "builtin:Text" },
      flow_graph_ref: "graph:strategy:demo.approval/RunPure",
      source_ref: sourceRef(),
    },
  ];
  const tools = [];
  if (withSentinel) {
    strategies.push({
      id: SENTINEL_TARGET,
      name: "RunSentinel",
      description: "Requires approval before the sentinel tool.",
      signature: { inputs: [], output_type: "builtin:Text" },
      uses: ["tool:demo.approval/Sentinel"],
      use_refs: [{ target_ref: "tool:demo.approval/Sentinel", source_ref: sourceRef() }],
      flow_graph_ref: "graph:strategy:demo.approval/RunSentinel",
      source_ref: sourceRef(),
    });
    tools.push({
      id: "tool:demo.approval/Sentinel",
      name: "Sentinel",
      description: "Writes one test sentinel after approval.",
      signature: { inputs: [], output_type: "builtin:Text" },
      required_capabilities: ["network"],
      required_secrets: [],
      memory_accesses: [],
      source_ref: sourceRef(),
    });
  }
  const approvalNodes = [
    node("approval", "human_approval", {
      approval_ref: "approval:demo/RunApproval",
      approval_mode: "required_approval",
      context_refs: [],
      result_binding: "decision",
    }),
  ];
  const approvalEdges = [];
  if (twoApprovals) {
    approvalNodes.push(node("approval_second", "human_approval", {
      approval_ref: "approval:demo/SecondApproval",
      approval_mode: "required_approval",
      context_refs: [],
      result_binding: "decision_second",
    }));
    approvalEdges.push(edge("approval", "approval_second", "next"));
  }
  approvalNodes.push(node("done", "give", {
    arguments: [`value:${twoApprovals ? "decision_second" : "decision"}`],
  }));
  approvalEdges.push(edge(twoApprovals ? "approval_second" : "approval", "done", "next"));
  const executionGraphs = [
    graph("graph:strategy:demo.approval/RunApproval", WAIT_TARGET, approvalNodes, approvalEdges),
    graph("graph:strategy:demo.approval/RunPure", PURE_TARGET, [
      node("pure", "give", { arguments: ["literal:string:pure"] }),
    ]),
  ];
  if (withSentinel) {
    executionGraphs.push(graph("graph:strategy:demo.approval/RunSentinel", SENTINEL_TARGET, [
      node("approval_sentinel", "human_approval", {
        approval_ref: "approval:demo/RunSentinel",
        approval_mode: "required_approval",
        context_refs: [],
        result_binding: "decision",
      }),
      node("sentinel", "call_tool", {
        target_ref: "tool:demo.approval/Sentinel",
        result_binding: "sentinel_result",
      }),
      node("sentinel_done", "give", { arguments: ["value:sentinel_result"] }),
    ], [
      edge("approval_sentinel", "sentinel", "next"),
      edge("sentinel", "sentinel_done", "next"),
    ]));
  }
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: { id: "module:demo.approval", name: "demo.approval", source_ref: sourceRef() },
    definitions: {
      types: [],
      constants: [],
      functions: [],
      tools,
      memories: [],
      skills: [],
      agents: [],
      strategies,
      triggers: [],
    },
    execution_graphs: executionGraphs,
    trace_points: [],
  };
}

function graph(id, ownerRef, nodes, edges = []) {
  return {
    id,
    owner_ref: ownerRef,
    entry_node_id: nodes[0].id,
    nodes,
    edges,
    expressions: [],
    failure_paths: [],
    failure_path_refs: [],
    source_ref: sourceRef(),
  };
}

function node(id, kind, fields = {}) {
  return {
    id,
    kind,
    arguments: [],
    trace_point_refs: [],
    source_ref: sourceRef(),
    ...fields,
  };
}

function edge(fromNodeId, toNodeId, role) {
  return {
    from_node_id: fromNodeId,
    to_node_id: toNodeId,
    role,
    source_ref: sourceRef(),
  };
}

function sourceRef() {
  return {
    source_id: "src/main.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 1,
    end_line: 1,
    end_column: 1,
  };
}

function writeTestDecisionIdentity(root) {
  writeJson(join(root, ".touba", "product-identity.json"), {
    schema_version: "touba-product-identity-v1",
    generated_at: "2026-09-16T00:00:00.000Z",
    summary: {
      user_count: 1,
      team_count: 1,
      device_count: 1,
      active_assignment_count: 0,
      revoked_device_count: 0,
    },
    users: [{
      user_ref: USER_REF,
      display_name: "Test Reviewer",
      email: null,
      status: "active",
      team_refs: ["team:test"],
      role_refs: ["role:test-reviewer"],
    }],
    teams: [{ team_ref: "team:test", name: "Test", owner_refs: [USER_REF] }],
    roles: [{ role_ref: "role:test-reviewer", name: "Reviewer", scope: "human_decision" }],
    devices: [{
      device_ref: DEVICE_REF,
      user_ref: USER_REF,
      kind: "studio",
      status: "paired",
      paired_at: "2026-09-16T00:00:00.000Z",
      revoked_at: null,
    }],
    sessions: [],
    assignments: [],
    escalation_policies: [],
    events: [],
  });
}

function configureSentinelHandler(root, markerPath) {
  const handlerPath = join(root, "sentinel-handler.mjs");
  writeFileSync(handlerPath, `
    import { appendFileSync } from "node:fs";
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      appendFileSync(${JSON.stringify(markerPath)}, "dispatched\\n", "utf8");
      process.stdout.write(JSON.stringify({
        ok: true,
        value: "sentinel",
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "applied",
          receipt_ref: "opaque:test:sentinel",
        },
      }));
    });
  `, "utf8");
  writeJson(join(root, "touba.manifest.json"), {
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:demo.approval/Sentinel": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: [handlerPath],
          cwd: root,
        },
        grants: ["network"],
        secrets: [],
        timeout_ms: 10_000,
        max_payload_bytes: 16_384,
        effect_contract: { kind: "external_write", retry_mode: "idempotency_key" },
      },
    },
  });
}

function controlledClock(initialMs) {
  let nowMs = initialMs;
  let cleared = 0;
  const timers = [];
  return {
    runtime: {
      nowMs: () => nowMs,
      setTimer(callback, delay) {
        const handle = { callback, delay, cleared: false, fired: false };
        timers.push(handle);
        return handle;
      },
      clearTimer(handle) {
        if (!handle.cleared) cleared += 1;
        handle.cleared = true;
      },
    },
    activeTimers: () => timers.filter((timer) => !timer.cleared && !timer.fired),
    clearCount: () => cleared,
    now: () => nowMs,
    setNow(value) {
      nowMs = value;
    },
    fire(timer = timers.find((candidate) => !candidate.cleared && !candidate.fired)) {
      assert.ok(timer, "expected an active timer");
      timer.fired = true;
      timer.callback();
      return timer;
    },
  };
}

function serverBaseUrl(service) {
  return `http://127.0.0.1:${service.server.address().port}`;
}

async function runSandbox(baseUrl, targetRef, effectPolicy = "runtime_only") {
  const response = await postJson(`${baseUrl}/runs/sandbox`, {
    schema_version: "touba-sandbox-run-request-v1",
    execution_kind: "entrypoint",
    target_ref: targetRef,
    effect_policy: effectPolicy,
    inputs: {},
    requested_by: { kind: "studio", id: "durable-human-waits-test" },
    reason: "Exercise the durable human wait corpus.",
  });
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function createInteraction(baseUrl, targetRef, effectPolicy = "runtime_only") {
  const response = await postJson(`${baseUrl}/interactions/sessions`, {
    schema_version: "touba-interaction-session-create-v1",
    target_ref: targetRef,
    target_kind: "strategy",
    presentation: "workflow",
    effect_policy: effectPolicy,
    requested_by: { kind: "studio", id: "durable-human-waits-test" },
  });
  assert.equal(response.status, 201, await response.clone().text());
  return response.json();
}

async function sendInteractionMessage(baseUrl, sessionId, messageId) {
  const response = await postJson(`${baseUrl}/interactions/sessions/${sessionId}/messages`, {
    schema_version: "touba-interaction-message-request-v1",
    message_id: messageId,
    display_text: "Exercise a durable human wait.",
    inputs: {},
    requested_by: { kind: "studio", id: "durable-human-waits-test" },
  });
  assert.equal(response.status, 202, await response.clone().text());
  return response.json();
}

async function waitForInteractionOperation(baseUrl, sessionId, operationId) {
  const stableStatuses = new Set(["awaiting_human", "succeeded", "failed", "cancelled", "interrupted"]);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = await getJson(
      `${baseUrl}/interactions/sessions/${sessionId}/operations/${operationId}`,
    );
    if (stableStatuses.has(operation.status)) return operation;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`interaction operation ${operationId} did not stabilize`);
}

async function waitForInteractionStatus(baseUrl, sessionId, operationId, expectedStatus) {
  let last;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = await getJson(
      `${baseUrl}/interactions/sessions/${sessionId}/operations/${operationId}`,
    );
    if (operation.status === expectedStatus) return operation;
    last = operation;
    if (["failed", "cancelled", "interrupted"].includes(operation.status)) break;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`interaction operation ${operationId} did not reach ${expectedStatus}: ${JSON.stringify(last)}`);
}

async function waitForDifferentPending(baseUrl, priorRequestId) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const response = await fetch(`${baseUrl}/approvals/pending/current`);
    if (response.status === 200) {
      const pending = await response.json();
      if (pending.request_id !== priorRequestId) return pending;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`a successor human wait did not replace ${priorRequestId}`);
}

function decisionFor(pending, { decision = "approve", decidedAt = "2026-09-16T00:00:00.000Z" } = {}) {
  return {
    schema_version: "touba-approval-decision-v1",
    request_id: pending.request_id,
    run_id: pending.run_id,
    trace_ref: pending.trace_ref,
    user_ref: USER_REF,
    device_ref: DEVICE_REF,
    decision,
    decided_by: USER_REF,
    decided_at: decidedAt,
    comment: null,
    client_ref: "durable-human-waits-test",
  };
}

function humanRecord(root, requestId) {
  const path = join(root, ".touba", "sandbox-checkpoints.sqlite");
  const record = loadSandboxCheckpointStore(path).records.find((candidate) => candidate.request_id === requestId);
  assert.ok(record, `missing durable human wait ${requestId}`);
  return record;
}

function clonePendingHumanRecord(template, runId) {
  const serialized = JSON.stringify(template)
    .split(template.run_id)
    .join(runId)
    .split(template.request_id)
    .join(`human:${runId}`);
  const record = JSON.parse(serialized);
  record.run_id = runId;
  record.operation_id = runId;
  record.effect_scope_id = runId;
  record.checkpoint.run_id = runId;
  record.paused_result.run_id = runId;
  record.paused_result.trace.run_id = runId;
  record.human_wait.request.run_id = runId;
  record.human_wait.request_digest = canonicalDigest(record.human_wait.request);
  return record;
}

async function waitForRecord(root, requestId, predicate) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const record = humanRecord(root, requestId);
    if (predicate(record)) return record;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`durable human wait ${requestId} did not reach the expected state`);
}

async function waitForActiveTimers(clock, expectedCount) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (clock.activeTimers().length === expectedCount) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`controlled clock did not expose ${expectedCount} active timer(s)`);
}

async function waitForPath(path) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    if (existsSync(path)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`path was not repaired: ${path}`);
}

async function expectServerRepairFailure({ agentDecisionProvider, clock, root }) {
  let service;
  try {
    service = createToubaProjectServer({
      agentDecisionProvider,
      contractsRoot,
      projectRoot: root,
      humanWaitRuntime: clock.runtime,
      port: 0,
      quiet: true,
    });
  } catch (error) {
    assert.equal(error.code, "ToubaServeSandboxCheckpointStoreInvalid");
    return;
  }
  try {
    await assert.rejects(service.start(), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
  } finally {
    await service.stop();
  }
}

async function settleAsync() {
  await new Promise((resolveWait) => setImmediate(resolveWait));
  await new Promise((resolveWait) => setImmediate(resolveWait));
}

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200, await response.clone().text());
  return response.json();
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function readJson(path) {
  return readStoreFixture(path);
}

function writeJson(path, value) {
  writeStoreFixture(path, value);
}
