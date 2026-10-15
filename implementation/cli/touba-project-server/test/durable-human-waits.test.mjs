import assert from "node:assert/strict";
import {
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
import test from "node:test";

import { canonicalDigest } from "@touba/runtime";

import {
  createToubaProjectServer,
  loadSandboxCheckpointStore,
  readProjectEventJournal,
} from "../src/serve.mjs";
import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
} from "../../../contracts/machine/contracts.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;
const DAY_MS = 24 * 60 * 60 * 1000;
const WAIT_TARGET = "strategy:demo.approval/RunApproval";
const PURE_TARGET = "strategy:demo.approval/RunPure";
const SENTINEL_TARGET = "strategy:demo.approval/RunSentinel";
const REVIEW_TARGET = "strategy:demo.review/RunReview";
const USER_REF = "user:test-reviewer";
const DEVICE_REF = "device:test-suite";

test("stored human checkpoints retain loop cursors and refuse missing correlation without rewriting", async () => {
  const root = createTestProject();
  const path = join(root, ".touba", "sandbox-checkpoints.json");
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
      const bytes = JSON.stringify(invalid); writeFileSync(path, bytes, "utf8");
      assert.throws(() => loadSandboxCheckpointStore(path), { code: "ToubaServeSandboxCheckpointStoreInvalid" });
      assert.equal(readFileSync(path, "utf8"), bytes);
    }
  } finally { await service.stop(); rmSync(root, { recursive: true, force: true }); }
});

test("obsolete checkpoint stores are refused unchanged, including empty stores", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-wait-obsolete-"));
  const path = join(root, "sandbox-checkpoints.json");
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
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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
    const invalidBytes = `${JSON.stringify(invalidStore)}\n`;
    writeFileSync(checkpointPath, invalidBytes, "utf8");
    assert.throws(() => loadSandboxCheckpointStore(checkpointPath), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
    assert.equal(readFileSync(checkpointPath, "utf8"), invalidBytes);

    const orphanStore = {
      schema_version: "touba-sandbox-checkpoints-v1",
      records: [],
    };
    const orphanBytes = `${JSON.stringify(orphanStore)}\n`;
    writeFileSync(checkpointPath, orphanBytes, "utf8");
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
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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
      const bytes = `${JSON.stringify(corrupted)}\n`;
      writeFileSync(checkpointPath, bytes, "utf8");
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
    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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

test("WAIT capacity rejects the 101st human target before execution but permits a pure target", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - 1_000);
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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
    const records = loadSandboxCheckpointStore(join(root, ".touba", "sandbox-checkpoints.json"))
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

test("WAIT failed terminalization is valid only after an attempt, retries on one timer, and recovers at cap 100", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now() - DAY_MS - 2_000);
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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
    const sensitiveErrorBytes = `${JSON.stringify(sensitiveErrorStore)}\n`;
    writeFileSync(checkpointPath, sensitiveErrorBytes, "utf8");
    assert.throws(() => loadSandboxCheckpointStore(checkpointPath), {
      code: "ToubaServeSandboxCheckpointStoreInvalid",
    });
    assert.equal(readFileSync(checkpointPath, "utf8"), sensitiveErrorBytes);

    const invalidFailedStore = structuredClone(validFailedStore);
    invalidFailedStore.records[0].human_wait.terminalization.attempt_count = 0;
    invalidFailedStore.records[0].human_wait.terminalization.last_attempt_at = null;
    const invalidBytes = `${JSON.stringify(invalidFailedStore)}\n`;
    writeFileSync(checkpointPath, invalidBytes, "utf8");
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
  const decisionsPath = join(root, ".touba", "human-decisions.json");
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
  const sessionsPath = join(root, ".touba", "interaction-sessions.json");
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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

test("WAIT rejects a pause projection marker bound to a foreign interaction session without side effects", async () => {
  const root = createTestProject();
  const clock = controlledClock(Date.now());
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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
  const sessionsPath = join(root, ".touba", "interaction-sessions.json");
  const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
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
    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
    const requestsPath = join(root, ".touba", "human-requests.json");
    const decisionsPath = join(root, ".touba", "human-decisions.json");
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
        const bytes = `${JSON.stringify(requestStore)}\n`;
        writeFileSync(requestsPath, bytes, "utf8");
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
        const bytes = `${JSON.stringify(decisionStore)}\n`;
        writeFileSync(decisionsPath, bytes, "utf8");
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
    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.json");
    const requestsPath = join(root, ".touba", "human-requests.json");
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
      const bytes = `${JSON.stringify(store)}\n`;
      writeFileSync(requestsPath, bytes, "utf8");
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

function createTestProject({ twoApprovals = false, withSentinel = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), "touba-durable-human-waits-"));
  mkdirSync(join(root, "src", "demo"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "demo", "approval.tb"), "module demo.approval\n", "utf8");
  writeJson(
    join(root, ".touba", "air", "demo", "approval.air.json"),
    approvalAirDocument({ twoApprovals, withSentinel }),
  );
  writeTestDecisionIdentity(root);
  return root;
}

function createAgentReviewProject() {
  const root = mkdtempSync(join(tmpdir(), "touba-durable-human-review-"));
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
      signature: { inputs: [], output_type: "builtin:Text" },
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

async function createInteraction(baseUrl, targetRef) {
  const response = await postJson(`${baseUrl}/interactions/sessions`, {
    schema_version: "touba-interaction-session-create-v1",
    target_ref: targetRef,
    target_kind: "strategy",
    presentation: "workflow",
    effect_policy: "runtime_only",
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
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = await getJson(
      `${baseUrl}/interactions/sessions/${sessionId}/operations/${operationId}`,
    );
    if (operation.status === expectedStatus) return operation;
    await new Promise((resolveWait) => setTimeout(resolveWait, 5));
  }
  assert.fail(`interaction operation ${operationId} did not reach ${expectedStatus}`);
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
  const path = join(root, ".touba", "sandbox-checkpoints.json");
  const record = loadSandboxCheckpointStore(path).records.find((candidate) => candidate.request_id === requestId);
  assert.ok(record, `missing durable human wait ${requestId}`);
  return record;
}

function clonePendingHumanRecord(template, runId) {
  const serialized = JSON.stringify(template)
    .split(template.run_id)
    .join(runId);
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
  return JSON.parse(readFileSync(path, "utf8"));
}

function writeJson(path, value) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
