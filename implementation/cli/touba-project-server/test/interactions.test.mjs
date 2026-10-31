import assert from "node:assert/strict";
import { readStoreFixture } from "./store-fixtures.mjs";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { execFileSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";

import {
  archiveInteractionSession,
  bufferedInteractionProgress,
  completeInteractionOperation,
  createInteractionSession,
  enqueueInteractionOperation,
  failInteractionOperation,
  getInteractionSession,
  listInteractionSessions,
  recordInteractionOperationProgress,
  recoverInterruptedInteractionOperations,
  requestInteractionOperationCancel,
  resumeInterruptedInteractionOperation,
  startInteractionOperation,
} from "../src/interactions.mjs";

test("interaction operations persist bounded progress without raw runtime payloads", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-progress-"));
  const sessionsPath = join(root, "sessions.json");
  try {
    const session = createSession(sessionsPath);
    const operation = enqueueInteractionOperation({
      message: interactionMessage(),
      runId: "run_progress_01",
      sessionId: session.session_id,
      sessionsPath,
    });
    startInteractionOperation({
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    });
    recordInteractionOperationProgress({
      events: [{
        kind: "tool_dispatch_started",
        sequence_index: 4,
        payload: {
          tool_ref: "tool:demo/Lookup",
          secret_value: "MUST_NOT_PERSIST",
          raw_payload: { customer: "sensitive" },
        },
      }],
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    });
    const stored = getInteractionSession({ sessionId: session.session_id, sessionsPath });
    assert.equal(stored.operations[0].current_event.type, "tool_dispatch_started");
    assert.equal(stored.operations[0].current_event.references.tool_ref, "tool:demo/Lookup");
    assert.equal(JSON.stringify(stored).includes("MUST_NOT_PERSIST"), false);
    assert.equal(JSON.stringify(stored).includes("customer"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("progress batches persist before notification, keep counts, and surface changed-store corruption", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-progress-batch-"));
  const sessionsPath = join(root, "sessions.json");
  let recorder;
  try {
    const session = createSession(sessionsPath);
    const operation = enqueueInteractionOperation({ message: interactionMessage(), runId: "batch-run", sessionId: session.session_id, sessionsPath });
    const args = { operationId: operation.operation_id, sessionId: session.session_id, sessionsPath };
    startInteractionOperation(args);
    let notifications = 0;
    recorder = bufferedInteractionProgress(args, current => {
      notifications++;
      assert.equal(getInteractionSession(args).operations[0].event_count, current.event_count);
    });
    for (let i = 0; i < 81; i++) recorder.record({ kind: "scope_entered", sequence_index: i, payload: { secret_value: "PRIVATE" } });
    assert.equal(notifications, 1);
    recorder.flush();
    assert.equal(notifications, 2);
    const stored = getInteractionSession(args).operations[0];
    assert.equal(stored.event_count, 81);
    assert.equal(stored.recent_events.length, 80);
    assert.doesNotMatch(readFileSync(sessionsPath, "utf8"), /PRIVATE/);
    recorder.record({ kind: "scope_exited", sequence_index: 81 });
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(notifications, 3);
    // Reading the same file successfully must not hide a subsequent mutation.
    writeFileSync(sessionsPath, "broken JSON");
    recorder.record({ kind: "run_completed", sequence_index: 82 });
    await new Promise(resolve => setImmediate(resolve));
    assert.throws(() => recorder.flush(), { code: "ToubaServeInteractionSessionStoreInvalid" });
    assert.equal(notifications, 3);
  } finally { recorder?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("cancel-requested interaction operations recover as cancelled and can be archived", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-recovery-"));
  const sessionsPath = join(root, "sessions.json");
  try {
    const session = createSession(sessionsPath);
    const operation = enqueueInteractionOperation({
      message: interactionMessage(),
      runId: "run_recovery_01",
      sessionId: session.session_id,
      sessionsPath,
    });
    requestInteractionOperationCancel({
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    });
    const recovered = recoverInterruptedInteractionOperations({ sessionsPath });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "cancelled");
    const archived = archiveInteractionSession({
      sessionId: session.session_id,
      sessionsPath,
    });
    assert.equal(archived.status, "archived");
    const store = readStoreFixture(sessionsPath);
    assert.equal(store.schema_version, "touba-interaction-sessions-v1");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("awaiting-human cancellation is idempotent and remains recoverable", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-human-cancel-"));
  const sessionsPath = join(root, "sessions.json");
  try {
    const session = createSession(sessionsPath);
    const operation = enqueueInteractionOperation({
      message: interactionMessage(),
      runId: "run_human_cancel_01",
      sessionId: session.session_id,
      sessionsPath,
    });
    const operationArgs = {
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    };
    startInteractionOperation(operationArgs);
    assert.equal(completeInteractionOperation({
      ...operationArgs,
      generatedAt: "2026-09-16T09:00:00.000Z",
      result: interactionRunResult(operation, {
        code: "ToubaSandboxRunAwaitingHumanDecision",
        completedAt: "2026-09-16T09:00:00.000Z",
      }),
    }).status, "awaiting_human");

    const first = requestInteractionOperationCancel({
      ...operationArgs,
      generatedAt: "2026-09-16T09:01:00.000Z",
    });
    assert.equal(first.status, "cancel_requested");
    assert.equal(first.cancel_requested_at, "2026-09-16T09:01:00.000Z");
    const claimedBytes = readFileSync(sessionsPath, "utf8");
    const replay = requestInteractionOperationCancel({
      ...operationArgs,
      generatedAt: "2026-09-16T10:00:00.000Z",
    });
    assert.equal(replay.cancel_requested_at, first.cancel_requested_at);
    assert.equal(readFileSync(sessionsPath, "utf8"), claimedBytes);

    const recovered = recoverInterruptedInteractionOperations({
      sessionsPath,
      generatedAt: "2026-09-16T09:02:00.000Z",
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "cancelled");

    const cancelledResult = interactionRunResult(operation, {
      code: "ToubaSandboxHumanDecisionCancelled",
      completedAt: "2026-09-16T09:03:00.000Z",
    });
    assert.equal(completeInteractionOperation({
      ...operationArgs,
      generatedAt: "2026-09-16T09:03:00.000Z",
      result: cancelledResult,
    }).status, "cancelled");
    const projectedBytes = readFileSync(sessionsPath, "utf8");
    completeInteractionOperation({
      ...operationArgs,
      generatedAt: "2026-09-16T11:00:00.000Z",
      result: cancelledResult,
    });
    assert.equal(readFileSync(sessionsPath, "utf8"), projectedBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("terminal interaction results are write-once and cannot be overwritten by failure recovery", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-terminal-result-"));
  const sessionsPath = join(root, "sessions.json");
  try {
    const session = createSession(sessionsPath);
    const operation = enqueueInteractionOperation({
      message: interactionMessage(),
      runId: "run_terminal_result_01",
      sessionId: session.session_id,
      sessionsPath,
    });
    const operationArgs = {
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    };
    startInteractionOperation(operationArgs);
    const cancelledResult = interactionRunResult(operation, {
      code: "ToubaSandboxHumanDecisionCancelled",
      completedAt: "2026-09-16T09:03:00.000Z",
    });
    completeInteractionOperation({ ...operationArgs, result: cancelledResult });
    const terminalBytes = readFileSync(sessionsPath, "utf8");

    assert.throws(() => completeInteractionOperation({
      ...operationArgs,
      result: interactionRunResult(operation, {
        code: "ToubaSandboxHumanDecisionExpired",
        completedAt: "2026-09-16T09:04:00.000Z",
      }),
    }), { code: "ToubaServeInteractionOperationResultConflict" });
    assert.equal(readFileSync(sessionsPath, "utf8"), terminalBytes);

    const protectedOperation = failInteractionOperation({
      ...operationArgs,
      code: "ToubaServeProjectionFailed",
      message: "a later projection failed",
      generatedAt: "2026-09-16T09:05:00.000Z",
    });
    assert.equal(protectedOperation.status, "cancelled");
    assert.equal(readFileSync(sessionsPath, "utf8"), terminalBytes);

    assert.throws(() => completeInteractionOperation({
      ...operationArgs,
      result: { ...cancelledResult, run_id: "run_other" },
    }), { code: "ToubaServeInteractionOperationResultMismatch" });
    assert.equal(readFileSync(sessionsPath, "utf8"), terminalBytes);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("queued and running operations retain their cancellation transition", () => {
  for (const initialStatus of ["queued", "running"]) {
    const root = mkdtempSync(join(tmpdir(), `touba-interaction-${initialStatus}-cancel-`));
    const sessionsPath = join(root, "sessions.json");
    try {
      const session = createSession(sessionsPath);
      const operation = enqueueInteractionOperation({
        message: interactionMessage(),
        runId: `run_${initialStatus}_cancel_01`,
        sessionId: session.session_id,
        sessionsPath,
      });
      if (initialStatus === "running") {
        startInteractionOperation({
          operationId: operation.operation_id,
          sessionId: session.session_id,
          sessionsPath,
        });
      }
      const cancelled = requestInteractionOperationCancel({
        operationId: operation.operation_id,
        sessionId: session.session_id,
        sessionsPath,
      });
      assert.equal(cancelled.status, "cancel_requested");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }
});

test("an interrupted operation resumes only through the dedicated explicit transition", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-explicit-resume-"));
  const sessionsPath = join(root, "sessions.json");
  try {
    const session = createSession(sessionsPath);
    const operation = enqueueInteractionOperation({
      message: interactionMessage(),
      runId: "run_resume_01",
      sessionId: session.session_id,
      sessionsPath,
    });
    startInteractionOperation({
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    });
    recoverInterruptedInteractionOperations({ sessionsPath });
    assert.throws(() => startInteractionOperation({
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    }), { code: "ToubaServeInteractionOperationStateInvalid" });
    const resumed = resumeInterruptedInteractionOperation({
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    });
    assert.equal(resumed.status, "running");
    assert.equal(resumed.completed_at, null);
    assert.equal(resumed.error, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interaction session index preserves generic executable target kinds", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-targets-"));
  const sessionsPath = join(root, "sessions.json");
  try {
    const agent = createSession(sessionsPath);
    createInteractionSession({
      request: {
        target_ref: "function:demo/Format",
        target_kind: "function",
        presentation: "invocation",
        effect_policy: "runtime_only",
        requested_by: { kind: "studio", id: "test-suite" },
      },
      sessionsPath,
    });
    const index = listInteractionSessions(sessionsPath);
    assert.deepEqual(
      index.sessions.map((session) => session.target_kind).sort(),
      ["agent", "function"],
    );
    assert.equal(index.sessions.some((session) => session.session_id === agent.session_id), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interaction session capacity retains awaiting-human and interrupted sessions while evicting inactive state", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-capacity-retain-active-"));
  const sessionsPath = join(root, "sessions.json");
  try {
    const first = createInteractionSession({
      request: interactionSessionRequest(),
      sessionsPath,
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    const operation = enqueueInteractionOperation({
      message: interactionMessage(),
      runId: "run_capacity_awaiting",
      sessionId: first.session_id,
      sessionsPath,
      generatedAt: "2026-01-01T00:00:01.000Z",
    });
    const operationArgs = {
      operationId: operation.operation_id,
      sessionId: first.session_id,
      sessionsPath,
    };
    startInteractionOperation({
      ...operationArgs,
      generatedAt: "2026-01-01T00:00:02.000Z",
    });
    completeInteractionOperation({
      ...operationArgs,
      generatedAt: "2026-01-01T00:00:03.000Z",
      result: interactionRunResult(operation, {
        code: "ToubaSandboxRunAwaitingHumanDecision",
        completedAt: "2026-01-01T00:00:03.000Z",
      }),
    });

    const interrupted = createInteractionSession({
      request: interactionSessionRequest(),
      sessionsPath,
      generatedAt: "2026-01-01T00:01:00.000Z",
    });
    const interruptedOperation = enqueueInteractionOperation({
      message: { ...interactionMessage(), message_id: "message_interrupted" },
      runId: "run_capacity_interrupted",
      sessionId: interrupted.session_id,
      sessionsPath,
      generatedAt: "2026-01-01T00:01:01.000Z",
    });
    startInteractionOperation({
      operationId: interruptedOperation.operation_id,
      sessionId: interrupted.session_id,
      sessionsPath,
      generatedAt: "2026-01-01T00:01:02.000Z",
    });
    recoverInterruptedInteractionOperations({
      sessionsPath,
      generatedAt: "2026-01-01T00:01:03.000Z",
    });

    const inactive = [];
    for (let index = 2; index < 100; index += 1) {
      inactive.push(createInteractionSession({
        request: interactionSessionRequest(),
        sessionsPath,
        generatedAt: new Date(Date.parse("2026-01-01T01:00:00.000Z") + index * 1_000).toISOString(),
      }));
    }
    assert.equal(listInteractionSessions(sessionsPath).sessions.length, 100);

    const newest = createInteractionSession({
      request: interactionSessionRequest(),
      sessionsPath,
      generatedAt: "2026-01-02T00:00:00.000Z",
    });
    const ids = new Set(listInteractionSessions(sessionsPath).sessions.map((session) => session.session_id));
    assert.equal(ids.size, 100);
    assert.equal(ids.has(first.session_id), true);
    assert.equal(ids.has(interrupted.session_id), true);
    assert.equal(ids.has(inactive[0].session_id), false);
    assert.equal(ids.has(newest.session_id), true);
    assert.equal(getInteractionSession({ sessionId: first.session_id, sessionsPath }).operations[0].status, "awaiting_human");
    assert.equal(getInteractionSession({ sessionId: interrupted.session_id, sessionsPath }).operations[0].status, "interrupted");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interaction session capacity refuses creation when all 100 sessions have active operations", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-capacity-all-active-"));
  const sessionsPath = join(root, "sessions.json");
  try {
    const retainedIds = new Set();
    for (let index = 0; index < 100; index += 1) {
      const session = createInteractionSession({
        request: interactionSessionRequest(),
        sessionsPath,
        generatedAt: new Date(Date.parse("2026-01-01T00:00:00.000Z") + index * 1_000).toISOString(),
      });
      retainedIds.add(session.session_id);
      enqueueInteractionOperation({
        message: { ...interactionMessage(), message_id: `message_${index}` },
        runId: `run_capacity_active_${index}`,
        sessionId: session.session_id,
        sessionsPath,
      });
    }
    const bytes = readFileSync(sessionsPath, "utf8");
    assert.throws(() => createInteractionSession({
      request: interactionSessionRequest(),
      sessionsPath,
      generatedAt: "2026-01-02T00:00:00.000Z",
    }), {
      code: "ToubaServeInteractionSessionCapacityExceeded",
    });
    assert.equal(readFileSync(sessionsPath, "utf8"), bytes);
    assert.deepEqual(
      new Set(listInteractionSessions(sessionsPath).sessions.map((session) => session.session_id)),
      retainedIds,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function createSession(sessionsPath) {
  return createInteractionSession({
    request: interactionSessionRequest(),
    sessionsPath,
  });
}

test("session summaries scan 100 MiB of synthetic history inside a 96 MiB JS heap", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-session-summary-capacity-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const sessionsPath = join(root, "sessions.sqlite");
  const base = createSession(sessionsPath);
  // Seed large histories independently of the normal execution recipes. The
  // indexed store and complete canonical session validation remain real.
  const db = new DatabaseSync(sessionsPath);
  try {
    db.exec("BEGIN; DELETE FROM records");
    const insert = db.prepare("INSERT INTO records(id, revision, body) VALUES (?, 1, ?)");
    for (let n = 0; n < 100; n++) {
      const session = { ...base, session_id: `large-${n}`, messages: [{
        message_id: `message-${n}`, role: "touba", created_at: base.created_at,
        display_text: "Result retained", operation_id: `operation-${n}`, run_id: `run-${n}`,
        run_status: "success", run_result: { result: "x".repeat(1024 * 1024) },
      }] };
      insert.run(session.session_id, JSON.stringify(session));
    }
    db.exec("COMMIT");
  } finally { db.close(); }
  const source = `import { listInteractionSessions, readInteractionRecoveryProjections, recoverInterruptedInteractionOperations, createInteractionSession } from ${JSON.stringify(new URL("../src/interactions.mjs", import.meta.url).href)};
    global.gc(); const before = process.memoryUsage(), start = performance.now();
    let last, projection;
    for (let n = 0; n < 4; n++) { last = listInteractionSessions(process.argv[1]); projection = readInteractionRecoveryProjections(process.argv[1]); }
    const recovered = recoverInterruptedInteractionOperations({ sessionsPath: process.argv[1] });
    const created = createInteractionSession({ sessionsPath: process.argv[1], request: ${JSON.stringify(interactionSessionRequest())} });
    global.gc(); const after = process.memoryUsage();
    console.log(JSON.stringify({ heapGrowth: after.heapUsed - before.heapUsed,
      elapsedMs: performance.now() - start, scans: 4, sessions: last.sessions.length,
      bytes: Buffer.byteLength(JSON.stringify(last)), messageCounts: last.sessions.map(s => s.message_count),
      recoveryBytes: Buffer.byteLength(JSON.stringify(projection)), digests: projection.every(s => /^sha256:/.test(s.messages[0].run_result_digest)),
      recovered: recovered.length, created: Boolean(created.session_id), remaining: listInteractionSessions(process.argv[1]).sessions.length }));`;
  const measured = JSON.parse(execFileSync(process.execPath,
    ["--max-old-space-size=96", "--expose-gc", "--input-type=module", "-e", source, sessionsPath],
    { encoding: "utf8", timeout: 30000 }));
  assert.equal(measured.sessions, 100);
  assert.deepEqual(measured.messageCounts, Array(100).fill(1));
  assert.ok(measured.bytes < 65536);
  assert.ok(measured.recoveryBytes < 65536);
  assert.equal(measured.digests, true);
  assert.equal(measured.recovered, 0);
  assert.equal(measured.created, true);
  assert.equal(measured.remaining, 100);
  assert.ok(measured.heapGrowth < 16 * 1024 * 1024, JSON.stringify(measured));
  assert.ok(measured.elapsedMs < 25000, JSON.stringify(measured));
  const { messageCounts, ...diagnostic } = measured;
  t.diagnostic(JSON.stringify(diagnostic));
  // A new malformed body must still invalidate a later summary scan.
  const corrupt = new DatabaseSync(sessionsPath);
  try { corrupt.prepare("UPDATE records SET body=? WHERE id=?").run('{"status":"invalid"}', "large-99"); }
  finally { corrupt.close(); }
  assert.throws(() => listInteractionSessions(sessionsPath), { code: "ToubaServeInteractionSessionStoreInvalid" });
  writeFileSync(sessionsPath, "invalid SQLite");
  assert.throws(() => listInteractionSessions(sessionsPath), { code: "ToubaServeInteractionSessionStoreInvalid" });
});

function interactionSessionRequest() {
  return {
    target_ref: "agent:demo/Coordinator",
    target_kind: "agent",
    presentation: "conversation",
    effect_policy: "runtime_only",
    requested_by: { kind: "studio", id: "test-suite" },
  };
}

function interactionMessage() {
  return {
    message_id: "message_01",
    display_text: "Coordinate the bounded test.",
  };
}

function interactionRunResult(operation, { code, completedAt }) {
  return {
    schema_version: "touba-sandbox-run-result-v1",
    messages: [],
    messages_truncated: false,
    run_id: operation.run_id,
    target_ref: operation.target_ref,
    status: "stopped",
    completed_at: completedAt,
    diagnostics: [{ severity: "error", code, message: code }],
  };
}
