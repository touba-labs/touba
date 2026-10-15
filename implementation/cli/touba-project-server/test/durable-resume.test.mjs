import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { canonicalDigest, tracePrefixDigest } from "@touba/runtime";

import {
  createToubaProjectServer,
  loadSandboxCheckpointStore,
  persistSandboxExecutionCheckpoint,
  recoverInterruptedSandboxExecutions,
  resumeProjectSandboxRun,
} from "../src/serve.mjs";
import {
  createInteractionSession,
  enqueueInteractionOperation,
  getInteractionOperation,
  requestInteractionOperationCancel,
} from "../src/interactions.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;

test("durable resume requires the explicit current request contract before store access", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-resume-contract-"));
  try {
    for (const schema_version of [undefined, "touba-operation-resume-request-v0.1"]) {
      await assert.rejects(resumeProjectSandboxRun({ projectRoot: root, contractsRoot, request: {
        ...(schema_version === undefined ? {} : { schema_version }),
        operation_id: "operation:absent", checkpoint_revision: 1,
        checkpoint_digest: `sha256:${"a".repeat(64)}`, resume_request_id: "resume:absent",
      } }), error => error.code === "DurableResumeCheckpointInvalid" && /schema_version/.test(error.message));
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("execution store refuses obsolete human and execution envelopes without migration", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-checkpoint-obsolete-"));
  const path = join(root, "sandbox-checkpoints.json");
  try {
    for (const schema_version of ["touba-sandbox-checkpoints-v0.1", "touba-sandbox-checkpoints-v0.2"]) {
      const bytes = JSON.stringify({ schema_version, records: [{ record_kind: "execution", status: "completed" }] });
      writeFileSync(path, bytes, "utf8");
      assert.throws(() => loadSandboxCheckpointStore(path), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
      assert.equal(readFileSync(path, "utf8"), bytes);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("execution checkpoint observer replaces one atomic record and recovery only marks it interrupted", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-execution-checkpoint-"));
  const path = join(root, "sandbox-checkpoints.json");
  const operationId = "operation:host-test";
  const runId = "run:host-test";
  try {
    const firstTrace = trace(runId, [{ kind: "run_started", sequence_index: 0, payload: { raw: "not persisted" } }]);
    const first = persistSandboxExecutionCheckpoint({
      checkpoint: checkpoint({ operationId, runId, revision: 1, previousDigest: null, traceDocument: firstTrace }),
      createdAt: "2026-09-16T00:00:00.000Z",
      effectPolicy: "runtime_only",
      executionKind: "entrypoint",
      operationId,
      runId,
      sandboxCheckpointsPath: path,
      targetRef: "strategy:demo/Run",
      trace: firstTrace,
      updatedAt: "2026-09-16T00:00:01.000Z",
    });
    assert.equal(first.status, "running");
    assert.equal(first.request_id, runId);
    assert.equal(first.effect_scope_id, operationId);
    assert.equal(JSON.stringify(first).includes("not persisted"), false);

    const secondTrace = trace(runId, [
      { kind: "run_started", sequence_index: 0 },
      { kind: "graph_node_completed", sequence_index: 1 },
    ]);
    const second = persistSandboxExecutionCheckpoint({
      checkpoint: checkpoint({
        operationId,
        runId,
        revision: 2,
        previousDigest: first.checkpoint.checkpoint_digest,
        previousPrefixDigest: first.checkpoint.trace_state.prefix_digest,
        traceDocument: secondTrace,
        localEventOffset: 1,
      }),
      createdAt: first.created_at,
      effectPolicy: "runtime_only",
      executionKind: "entrypoint",
      operationId,
      runId,
      sandboxCheckpointsPath: path,
      targetRef: "strategy:demo/Run",
      trace: secondTrace,
      updatedAt: "2026-09-16T00:00:02.000Z",
    });
    assert.equal(second.checkpoint.revision, 2);
    assert.equal(loadSandboxCheckpointStore(path).records.length, 1);

    const recovered = recoverInterruptedSandboxExecutions({
      sandboxCheckpointsPath: path,
      generatedAt: "2026-09-16T00:00:03.000Z",
    });
    assert.equal(recovered.length, 1);
    assert.equal(recovered[0].status, "interrupted");
    assert.equal(recovered[0].checkpoint.revision, 2);
    assert.equal(recoverInterruptedSandboxExecutions({ sandboxCheckpointsPath: path }).length, 0);
    const durable = JSON.parse(readFileSync(path, "utf8"));
    const summaryTampered = structuredClone(durable);
    summaryTampered.records[0].trace_prefix.events[1].summary = "semantically altered";
    writeFileSync(path, JSON.stringify(summaryTampered), "utf8");
    assert.throws(() => loadSandboxCheckpointStore(path), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
    const tampered = structuredClone(durable);
    tampered.records[0].trace_prefix.events[1].index = 7;
    writeFileSync(path, JSON.stringify(tampered), "utf8");
    assert.throws(() => loadSandboxCheckpointStore(path), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("execution checkpoint persistence refuses resealed monotone state regressions without replacing the store", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-execution-checkpoint-monotone-"));
  const path = join(root, "sandbox-checkpoints.json");
  const operationId = "operation:host-monotone";
  const runId = "run:host-monotone";
  try {
    const firstTrace = trace(runId, [{ kind: "run_started", sequence_index: 0 }]);
    const firstCheckpoint = resealCheckpoint(
      checkpoint({ operationId, runId, revision: 1, previousDigest: null, traceDocument: firstTrace }),
      (candidate) => {
        candidate.runtime_state.budget_counters = {
          steps: 4,
          tool_calls: 3,
          agent_invocations: 2,
          provider_calls: 5,
        };
        candidate.runtime_state.effective_limits = { max_steps: 10, max_tool_calls: 8 };
        candidate.runtime_state.active_elapsed_ms = 20;
        candidate.runtime_state.next_call_index = 4;
        candidate.runtime_state.next_effect_index = 3;
        candidate.runtime_state.external_tool_dispatches = 2;
      },
    );
    const first = persistSandboxExecutionCheckpoint({
      checkpoint: firstCheckpoint,
      createdAt: "2026-09-16T00:00:00.000Z",
      effectPolicy: "runtime_only",
      executionKind: "entrypoint",
      operationId,
      runId,
      sandboxCheckpointsPath: path,
      targetRef: "strategy:demo/Run",
      trace: firstTrace,
      updatedAt: "2026-09-16T00:00:01.000Z",
    });
    const secondTrace = trace(runId, [
      { kind: "run_started", sequence_index: 0 },
      { kind: "graph_node_completed", sequence_index: 1 },
    ]);
    const validNext = resealCheckpoint(checkpoint({
      operationId,
      runId,
      revision: 2,
      previousDigest: first.checkpoint.checkpoint_digest,
      previousPrefixDigest: first.checkpoint.trace_state.prefix_digest,
      traceDocument: secondTrace,
      localEventOffset: 1,
    }), (candidate) => {
      candidate.runtime_state = structuredClone(first.checkpoint.runtime_state);
    });
    const regressions = [
      ["steps", (candidate) => { candidate.runtime_state.budget_counters.steps -= 1; }],
      ["tool_calls", (candidate) => { candidate.runtime_state.budget_counters.tool_calls -= 1; }],
      ["agent_invocations", (candidate) => { candidate.runtime_state.budget_counters.agent_invocations -= 1; }],
      ["provider_calls", (candidate) => { candidate.runtime_state.budget_counters.provider_calls -= 1; }],
      ["active_elapsed_ms", (candidate) => { candidate.runtime_state.active_elapsed_ms -= 1; }],
      ["next_call_index", (candidate) => { candidate.runtime_state.next_call_index -= 1; }],
      ["next_effect_index", (candidate) => { candidate.runtime_state.next_effect_index -= 1; }],
      ["external_tool_dispatches", (candidate) => { candidate.runtime_state.external_tool_dispatches -= 1; }],
      ["effective_limit_removed", (candidate) => { delete candidate.runtime_state.effective_limits.max_steps; }],
      ["effective_limit_relaxed", (candidate) => { candidate.runtime_state.effective_limits.max_steps += 1; }],
      ["next_sequence_index", (candidate) => { candidate.trace_state.next_sequence_index = 0; }],
      ["revision_jump", (candidate) => { candidate.revision += 1; }],
    ];
    const durableBefore = readFileSync(path, "utf8");
    for (const [field, mutate] of regressions) {
      const regressive = resealCheckpoint(validNext, mutate);
      assert.throws(() => persistSandboxExecutionCheckpoint({
        checkpoint: regressive,
        createdAt: first.created_at,
        effectPolicy: "runtime_only",
        executionKind: "entrypoint",
        operationId,
        runId,
        sandboxCheckpointsPath: path,
        targetRef: "strategy:demo/Run",
        trace: secondTrace,
        updatedAt: "2026-09-16T00:00:02.000Z",
      }), (error) => {
        assert.equal(error.code, "DurableResumeCheckpointIncompatible", field);
        return true;
      });
      assert.equal(readFileSync(path, "utf8"), durableBefore, field);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("active elapsed time can replace only a dispatch reservation from the current attempt", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-execution-checkpoint-active-time-"));
  const createdAt = "2026-09-16T00:00:00.000Z";
  const targetRef = "strategy:demo/Run";
  try {
    for (const claimedBeforeCrash of [false, true]) {
      const suffix = claimedBeforeCrash ? "precrash" : "initial";
      const path = join(root, `${suffix}.json`);
      const operationId = `operation:active-time:${suffix}`;
      const runId = `run:active-time:${suffix}`;
      const firstTrace = trace(runId, [{ kind: "run_started", sequence_index: 0 }]);
      const dispatched = resealCheckpoint(checkpoint({
        operationId,
        runId,
        revision: 1,
        previousDigest: null,
        traceDocument: firstTrace,
      }), applyDispatchedReservation);
      const first = persistSandboxExecutionCheckpoint({
        checkpoint: dispatched,
        createdAt,
        effectPolicy: "runtime_only",
        executionKind: "entrypoint",
        operationId,
        runId,
        sandboxCheckpointsPath: path,
        targetRef,
        trace: firstTrace,
        updatedAt: "2026-09-16T00:00:01.000Z",
      });
      if (claimedBeforeCrash) {
        const store = JSON.parse(readFileSync(path, "utf8"));
        store.records[0].status = "resume_claimed";
        store.records[0].resume_claim = {
          resume_request_id: "resume:active-time:precrash",
          checkpoint_revision: first.checkpoint.revision,
          checkpoint_digest: first.checkpoint.checkpoint_digest,
          claimed_at: "2026-09-16T00:00:02.000Z",
          status: "claimed",
        };
        writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, "utf8");
      }
      const secondTrace = trace(runId, [
        { kind: "run_started", sequence_index: 0 },
        { kind: "graph_node_completed", sequence_index: 1 },
      ]);
      const measured = resealCheckpoint(checkpoint({
        operationId,
        runId,
        revision: 2,
        previousDigest: first.checkpoint.checkpoint_digest,
        previousPrefixDigest: first.checkpoint.trace_state.prefix_digest,
        traceDocument: secondTrace,
        localEventOffset: 1,
      }), (candidate) => {
        candidate.runtime_state = structuredClone(first.checkpoint.runtime_state);
        candidate.runtime_state.active_elapsed_ms = 80;
        candidate.cursor = { node_id: "node:give", phase: "ready" };
        candidate.pending_dispatch = null;
      });
      const persistMeasured = () => persistSandboxExecutionCheckpoint({
        checkpoint: measured,
        createdAt,
        effectPolicy: "runtime_only",
        executionKind: "entrypoint",
        operationId,
        runId,
        sandboxCheckpointsPath: path,
        targetRef,
        trace: secondTrace,
        updatedAt: "2026-09-16T00:00:03.000Z",
      });
      if (!claimedBeforeCrash) {
        assert.equal(persistMeasured().checkpoint.runtime_state.active_elapsed_ms, 80);
      } else {
        const durableBefore = readFileSync(path, "utf8");
        assert.throws(persistMeasured, { code: "DurableResumeCheckpointIncompatible" });
        assert.equal(readFileSync(path, "utf8"), durableBefore);
      }
    }

    const path = join(root, "current-resume.json");
    const operationId = "operation:active-time:current-resume";
    const runId = "run:active-time:current-resume";
    const initialTrace = trace(runId, [{ kind: "run_started", sequence_index: 0 }]);
    const initial = persistSandboxExecutionCheckpoint({
      checkpoint: resealCheckpoint(checkpoint({
        operationId,
        runId,
        revision: 1,
        previousDigest: null,
        traceDocument: initialTrace,
      }), (candidate) => {
        candidate.runtime_state.active_elapsed_ms = 50;
      }),
      createdAt,
      effectPolicy: "runtime_only",
      executionKind: "entrypoint",
      operationId,
      runId,
      sandboxCheckpointsPath: path,
      targetRef,
      trace: initialTrace,
      updatedAt: "2026-09-16T00:00:01.000Z",
    });
    const claimedStore = JSON.parse(readFileSync(path, "utf8"));
    claimedStore.records[0].status = "resume_claimed";
    claimedStore.records[0].resume_claim = {
      resume_request_id: "resume:active-time:current",
      checkpoint_revision: initial.checkpoint.revision,
      checkpoint_digest: initial.checkpoint.checkpoint_digest,
      claimed_at: "2026-09-16T00:00:02.000Z",
      status: "claimed",
    };
    writeFileSync(path, `${JSON.stringify(claimedStore, null, 2)}\n`, "utf8");
    const dispatchedTrace = trace(runId, [
      { kind: "run_started", sequence_index: 0 },
      { kind: "tool_call_started", sequence_index: 1 },
    ]);
    const currentReservation = persistSandboxExecutionCheckpoint({
      checkpoint: resealCheckpoint(checkpoint({
        operationId,
        runId,
        revision: 2,
        previousDigest: initial.checkpoint.checkpoint_digest,
        previousPrefixDigest: initial.checkpoint.trace_state.prefix_digest,
        traceDocument: dispatchedTrace,
        localEventOffset: 1,
      }), applyDispatchedReservation),
      createdAt,
      effectPolicy: "runtime_only",
      executionKind: "entrypoint",
      operationId,
      runId,
      sandboxCheckpointsPath: path,
      targetRef,
      trace: dispatchedTrace,
      updatedAt: "2026-09-16T00:00:03.000Z",
    });
    const completedTrace = trace(runId, [
      ...dispatchedTrace.events,
      { kind: "graph_node_completed", sequence_index: 2 },
    ]);
    const measuredCurrentAttempt = resealCheckpoint(checkpoint({
      operationId,
      runId,
      revision: 3,
      previousDigest: currentReservation.checkpoint.checkpoint_digest,
      previousPrefixDigest: currentReservation.checkpoint.trace_state.prefix_digest,
      traceDocument: completedTrace,
      localEventOffset: 2,
    }), (candidate) => {
      candidate.runtime_state = structuredClone(currentReservation.checkpoint.runtime_state);
      candidate.runtime_state.active_elapsed_ms = 80;
      candidate.cursor = { node_id: "node:give", phase: "ready" };
      candidate.pending_dispatch = null;
    });
    const accepted = persistSandboxExecutionCheckpoint({
      checkpoint: measuredCurrentAttempt,
      createdAt,
      effectPolicy: "runtime_only",
      executionKind: "entrypoint",
      operationId,
      runId,
      sandboxCheckpointsPath: path,
      targetRef,
      trace: completedTrace,
      updatedAt: "2026-09-16T00:00:04.000Z",
    });
    assert.equal(accepted.checkpoint.runtime_state.active_elapsed_ms, 80);
    assert.equal(accepted.resume_claim.checkpoint_revision, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("canonical checkpoint store refuses unknown record fields", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-checkpoint-strict-"));
  const path = join(root, "sandbox-checkpoints.json");
  try {
    writeFileSync(path, JSON.stringify({
      schema_version: "touba-sandbox-checkpoints-v1",
      records: [{
        record_kind: "human",
        request_id: "approval:demo/Review:run_invalid",
        approval_ref: "approval:demo/Review",
        run_id: "run_invalid",
        operation_id: "run_invalid",
        effect_scope_id: "run_invalid",
        target_ref: "strategy:demo/Run",
        execution_kind: "entrypoint",
        effect_policy: "runtime_only",
        status: "pending",
        created_at: "2026-09-16T00:00:00.000Z",
        checkpoint: {},
        paused_result: {},
        leaked_payload: "refused",
      }],
    }), "utf8");
    assert.throws(() => loadSandboxCheckpointStore(path), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("invalid checkpoint JSON reports only a structural error without leaking source content", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-checkpoint-invalid-json-"));
  const path = join(root, "sandbox-checkpoints.json");
  const secret = "ToubaSecretValueMustNotLeak";
  const rawPrompt = "raw prompt content must not leak";
  try {
    writeFileSync(
      path,
      `{"schema_version":"${secret}","records":[,"prompt":"${rawPrompt}"}`,
      "utf8",
    );
    assert.throws(
      () => loadSandboxCheckpointStore(path),
      (error) => {
        assert.equal(error.code, "ToubaServeSandboxCheckpointStoreInvalid");
        assert.equal(error.message, "sandbox checkpoint store is not valid JSON");
        assert.equal(error.message.includes(secret), false);
        assert.equal(error.message.includes(rawPrompt), false);
        return true;
      },
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("restart preserves a pre-crash cancellation and refuses durable resurrection", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-cancelled-resume-"));
  const sessionsPath = join(root, ".touba", "interaction-sessions.json");
  const checkpointsPath = join(root, ".touba", "sandbox-checkpoints.json");
  let service;
  try {
    const session = createInteractionSession({
      request: {
        target_ref: "strategy:demo/Run",
        target_kind: "strategy",
        presentation: "workflow",
        effect_policy: "runtime_only",
        requested_by: { kind: "studio", id: "test-suite" },
      },
      sessionsPath,
    });
    const operation = enqueueInteractionOperation({
      message: { message_id: "cancel_before_crash", display_text: "Cancel this operation." },
      runId: "run:cancel-before-crash",
      sessionId: session.session_id,
      sessionsPath,
    });
    requestInteractionOperationCancel({
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    });
    const cancellationTrace = trace(operation.run_id, [{ kind: "run_started", sequence_index: 0 }]);
    const durableCheckpoint = checkpoint({
      operationId: operation.operation_id,
      runId: operation.run_id,
      revision: 1,
      previousDigest: null,
      traceDocument: cancellationTrace,
    });
    persistSandboxExecutionCheckpoint({
      checkpoint: durableCheckpoint,
      createdAt: "2026-09-16T00:00:00.000Z",
      effectPolicy: "runtime_only",
      executionKind: "entrypoint",
      operationId: operation.operation_id,
      runId: operation.run_id,
      sandboxCheckpointsPath: checkpointsPath,
      targetRef: "strategy:demo/Run",
      trace: cancellationTrace,
    });

    service = createToubaProjectServer({
      contractsRoot,
      interactionSessionsPath: sessionsPath,
      projectRoot: root,
      sandboxCheckpointsPath: checkpointsPath,
      port: 0,
      quiet: true,
    });
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const response = await fetch(`${baseUrl}/runs/sandbox/resume`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
      schema_version: "touba-operation-resume-request-v1",
        operation_id: operation.operation_id,
        checkpoint_revision: durableCheckpoint.revision,
        checkpoint_digest: durableCheckpoint.checkpoint_digest,
        resume_request_id: "resume:cancelled-operation",
      }),
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "DurableResumeAuthorityRefused");
    assert.equal(loadSandboxCheckpointStore(checkpointsPath).records[0].status, "cancelled");
    assert.equal(getInteractionOperation({
      operationId: operation.operation_id,
      sessionId: session.session_id,
      sessionsPath,
    }).status, "cancelled");
  } finally {
    if (service !== undefined) await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

function checkpoint({
  operationId,
  runId,
  revision,
  previousDigest,
  previousPrefixDigest = null,
  traceDocument,
  localEventOffset = 0,
}) {
  const unsigned = {
    checkpoint_schema_version: "touba-run-checkpoint-v1",
    revision,
    previous_checkpoint_digest: previousDigest,
    operation_id: operationId,
    run_id: runId,
    effect_scope_id: operationId,
    entry_ref: "strategy:demo/Run",
    module_ref: "module:demo",
    graph_ref: "graph:strategy:demo/Run",
    compatibility: {
      air_schema_version: "touba-air-v1",
      air_digest: `sha256:${"1".repeat(64)}`,
      manifest_schema_version: null,
      manifest_digest: null,
      run_plan_digest: null,
      resource_bindings_digest: null,
      supply_chain_lock_digest: null,
      hardened_profile_digest: null,
      authority_artifacts_digest: `sha256:${"2".repeat(64)}`,
    },
    cursor: { node_id: "node:ready", phase: "ready" },
    runtime_state: {
      values: {},
      value_types: {},
      input_keys: [],
      budget_counters: { steps: 0, tool_calls: 0, agent_invocations: 0, provider_calls: 0 },
      effective_limits: {},
      active_elapsed_ms: 0,
      next_call_index: 1,
      next_effect_index: 1,
      external_tool_dispatches: 0,
    },
    pending_dispatch: null,
    decisions_consumed: [],
    trace_state: {
      prefix_digest: tracePrefixDigest(previousPrefixDigest, traceDocument, localEventOffset),
      next_sequence_index: traceDocument.events.at(-1)?.sequence_index + 1 || 0,
    },
  };
  return { ...unsigned, checkpoint_digest: canonicalDigest(unsigned) };
}

function resealCheckpoint(checkpointValue, mutate) {
  const candidate = structuredClone(checkpointValue);
  delete candidate.checkpoint_digest;
  mutate(candidate);
  return { ...candidate, checkpoint_digest: canonicalDigest(candidate) };
}

function applyDispatchedReservation(candidate) {
  candidate.cursor = { node_id: "node:tool", phase: "started" };
  candidate.runtime_state.budget_counters = {
    steps: 1,
    tool_calls: 1,
    agent_invocations: 0,
    provider_calls: 0,
  };
  candidate.runtime_state.active_elapsed_ms = 150;
  candidate.runtime_state.next_call_index = 2;
  candidate.runtime_state.next_effect_index = 1;
  candidate.runtime_state.external_tool_dispatches = 1;
  candidate.pending_dispatch = {
    node_id: "node:tool",
    tool_ref: "tool:demo/Read",
    call_id: `call:${candidate.run_id}:1`,
    call_index: 1,
    effect_index: null,
    effect_id: null,
    request_digest: null,
    effect_contract_kind: "none",
    retry_mode: null,
    attempt_index: 1,
    phase: "dispatched",
    timeout_ms: 100,
    budget_reserved: { tool_calls: 1, active_ms: 100 },
  };
}

function trace(runId, events) {
  return {
    run: { run_id: runId, entry_ref: "strategy:demo/Run" },
    events,
  };
}
