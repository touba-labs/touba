import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
  EFFECT_JOURNAL_SCHEMA_VERSION,
  EXECUTION_CHECKPOINT_VERSION,
  canonicalDigest,
  executeAirDocument,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
  validateExecutionCheckpoint,
} from "../src/index.mjs";
import { deriveEffectId, deriveEffectRequestDigest } from "../src/effect-contract.mjs";
import { airDocumentDigest } from "../src/human-approval-checkpoints.mjs";

test("accepts empty inputs and persists awaited checkpoints before dispatch without secrets", async () => {
  const secretValue = "durable-secret-\"quoted\"\nwith\\escapes-never-persisted";
  const journal = journalAdapter();
  const checkpoints = [];
  let observerActive = false;
  const result = await executeAirDocument(effectDocument(), {
    ...durableOptions({
      manifest: effectManifest(successHandlerScript()),
      journal,
      observer: async (snapshot) => {
        observerActive = true;
        await Promise.resolve();
        checkpoints.push(structuredClone(snapshot));
        observerActive = false;
      },
    }),
    secretStore: testSecretStore(secretValue),
  });

  assert.equal(result.status, "success");
  assert.equal(observerActive, false);
  assert.ok(checkpoints.length >= 5);
  for (const [index, snapshot] of checkpoints.entries()) {
    const checkpoint = validateExecutionCheckpoint(snapshot.checkpoint);
    assert.equal(checkpoint.checkpoint_schema_version, EXECUTION_CHECKPOINT_VERSION);
    assert.equal(checkpoint.revision, index + 1);
    assert.equal(
      checkpoint.previous_checkpoint_digest,
      index === 0 ? null : checkpoints[index - 1].checkpoint.checkpoint_digest,
    );
    assert.equal(JSON.stringify(snapshot).includes(secretValue), false);
  }
  const reserved = checkpoints.find(({ checkpoint }) =>
    checkpoint.pending_dispatch?.phase === "reserved"
  ).checkpoint;
  const dispatched = checkpoints.find(({ checkpoint }) =>
    checkpoint.pending_dispatch?.phase === "dispatched"
  ).checkpoint;
  assert.equal(reserved.cursor.phase, "started");
  assert.equal(reserved.runtime_state.budget_counters.steps, 1);
  assert.equal(reserved.runtime_state.budget_counters.tool_calls, 1);
  assert.equal(reserved.pending_dispatch.call_id, "call:run:durable:1");
  assert.equal(dispatched.pending_dispatch.call_id, reserved.pending_dispatch.call_id);
});

test("refuses non-empty runtime inputs before the first checkpoint or handler", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-input-refusal-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const rawInput = "raw prompt with bearer-token-never-persisted";
    const journal = journalAdapter();
    let observerCalls = 0;
    const document = effectDocument();
    document.definitions.skills[0].signature.inputs = [{ name: "prompt", type_ref: "builtin:Text" }];
    const result = await executeAirDocument(document, {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript(callsPath)),
        journal,
        observer: async () => { observerCalls += 1; },
      }),
      inputs: { prompt: rawInput },
    });

    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "DurableResumeUnsupportedState");
    assert.equal(observerCalls, 0);
    assert.equal(journal.entries.size, 0);
    assert.equal(readFileIfExists(callsPath), "");
    assert.equal(JSON.stringify(result).includes(rawInput), false);
    const failure = result.trace.events.findLast((event) => event.kind === "failure_detected");
    assert.match(failure.message, /opaque input contract/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("resumes an eligible direct bind to stop graph without any dispatch", async () => {
  const document = bindStopDocument();
  const manifest = emptyEffectManifest();
  const journal = journalAdapter();
  let readyStop;

  await assert.rejects(() => executeAirDocument(document, durableOptions({
    manifest,
    journal,
    observer: async ({ checkpoint }) => {
      if (checkpoint.cursor.node_id !== "stop" || checkpoint.cursor.phase !== "ready") return;
      readyStop = structuredClone(checkpoint);
      throw new Error("simulated crash before stop");
    },
  })), /simulated crash before stop/u);

  assert.deepEqual(readyStop.cursor, { node_id: "stop", phase: "ready" });
  assert.deepEqual(readyStop.runtime_state.values, { "value:bound": "kept" });
  assert.deepEqual(readyStop.runtime_state.value_types, { "value:bound": "builtin:Text" });
  assert.deepEqual(readyStop.runtime_state.budget_counters, {
    steps: 1,
    tool_calls: 0,
    agent_invocations: 0,
    provider_calls: 0,
  });
  assert.equal(readyStop.runtime_state.next_call_index, 1);
  assert.equal(readyStop.runtime_state.next_effect_index, 1);
  assert.equal(readyStop.runtime_state.external_tool_dispatches, 0);
  assert.equal(readyStop.pending_dispatch, null);
  assert.equal(journal.entries.size, 0);

  let startedStop;
  await assert.rejects(() => executeAirDocument(document, {
    ...durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => {
        startedStop = structuredClone(checkpoint);
        throw new Error("simulated crash after stop checkpoint");
      },
    }),
    executionResumeCheckpoint: readyStop,
  }), /simulated crash after stop checkpoint/u);

  assert.deepEqual(startedStop.cursor, { node_id: "stop", phase: "started" });
  assert.equal(startedStop.revision, readyStop.revision + 1);
  assert.equal(startedStop.previous_checkpoint_digest, readyStop.checkpoint_digest);
  assert.deepEqual(startedStop.runtime_state.values, readyStop.runtime_state.values);
  assert.deepEqual(startedStop.runtime_state.value_types, readyStop.runtime_state.value_types);
  assert.deepEqual(startedStop.runtime_state.budget_counters, {
    steps: 2,
    tool_calls: 0,
    agent_invocations: 0,
    provider_calls: 0,
  });
  assert.equal(startedStop.runtime_state.next_call_index, 1);
  assert.equal(startedStop.runtime_state.next_effect_index, 1);
  assert.equal(startedStop.runtime_state.external_tool_dispatches, 0);
  assert.equal(startedStop.pending_dispatch, null);
  assert.equal(journal.entries.size, 0);

  let observerCalls = 0;
  const resumed = await executeAirDocument(document, {
    ...durableOptions({
      manifest,
      journal,
      observer: async () => { observerCalls += 1; },
    }),
    executionResumeCheckpoint: startedStop,
  });

  assert.equal(resumed.status, "stopped");
  assert.equal(resumed.result, undefined);
  assert.equal(observerCalls, 0);
  assert.equal(journal.entries.size, 0);
  assert.deepEqual(
    resumed.trace.events.map((event) => event.kind),
    ["run_started", "scope_entered", "scope_exited", "run_completed"],
  );
  assert.equal(
    resumed.trace.events[0].sequence_index,
    startedStop.trace_state.next_sequence_index,
  );
  assert.equal(resumed.trace.events.at(-1).payload.status, "stopped");
});

test("resumes a prepared reservation with the reserved call id and no second budget charge", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-prepared-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    let preparedCheckpoint;
    await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
      manifest: effectManifest(successHandlerScript(callsPath)),
      journal,
      observer: async ({ checkpoint }) => {
        const entry = journal.entries.values().next().value;
        if (checkpoint.pending_dispatch?.phase === "reserved" && entry?.state === "prepared") {
          preparedCheckpoint = structuredClone(checkpoint);
          throw new Error("simulated crash before dispatch");
        }
      },
    })), /simulated crash/u);

    assert.equal(journal.entries.values().next().value.state, "prepared");
    const snapshots = [];
    const resumed = await executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript(callsPath)),
        journal,
        observer: async (snapshot) => snapshots.push(structuredClone(snapshot)),
      }),
      executionResumeCheckpoint: preparedCheckpoint,
      runLimits: { max_tool_calls: 1 },
    });

    assert.equal(resumed.status, "success");
    const request = readJsonLines(callsPath)[0];
    assert.equal(request.call_id, "call:run:durable:1");
    assert.equal(request.effect.attempt_index, 1);
    const readyGive = snapshots.find(({ checkpoint }) => checkpoint.cursor.node_id === "give")
      .checkpoint;
    assert.equal(readyGive.runtime_state.budget_counters.steps, 1);
    assert.equal(readyGive.runtime_state.budget_counters.tool_calls, 1);
    assert.equal(readyGive.runtime_state.next_call_index, 2);
    assert.ok(
      readyGive.runtime_state.active_elapsed_ms
        >= preparedCheckpoint.runtime_state.active_elapsed_ms,
      "a restored timeout reservation must remain consumed after the handler returns",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("counts delayed checkpoint observation as active time before handler dispatch", async () => {
  let nowMs = 0;
  let delayed = false;
  const journal = journalAdapter();
  const snapshots = [];
  const result = await executeAirDocument(effectDocument({ maxRunMs: 2000 }), {
    ...durableOptions({
      manifest: effectManifest(successHandlerScript(), { timeoutMs: 1000 }),
      journal,
      observer: async (snapshot) => {
        snapshots.push(structuredClone(snapshot));
        if (!delayed && snapshot.checkpoint.pending_dispatch?.phase === "reserved") {
          delayed = true;
          nowMs += 125;
        }
      },
    }),
    now: () => nowMs,
  });
  assert.equal(result.status, "success");
  const readyGive = snapshots.find(({ checkpoint }) => checkpoint.cursor.node_id === "give")
    .checkpoint;
  assert.ok(readyGive.runtime_state.active_elapsed_ms >= 125);

  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-active-latency-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const boundedJournal = journalAdapter();
    nowMs = 0;
    delayed = false;
    const refused = await executeAirDocument(effectDocument({ maxRunMs: 1100 }), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript(callsPath), { timeoutMs: 1000 }),
        journal: boundedJournal,
        observer: async ({ checkpoint }) => {
          if (!delayed && checkpoint.pending_dispatch?.phase === "reserved") {
            delayed = true;
            nowMs += 125;
          }
        },
      }),
      now: () => nowMs,
    });
    assert.equal(refused.status, "failure");
    assert.equal(failureCode(refused), "RunTimeBudgetExceeded");
    assert.equal(readFileIfExists(callsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rechecks cancellation and active time after the dispatched checkpoint before spawn", async () => {
  for (const kind of ["none", "external_write"]) {
    for (const mode of ["cancel", "time"]) {
      const workspace = mkdtempSync(join(tmpdir(), `touba-resume-final-${kind}-${mode}-`));
      try {
        const callsPath = join(workspace, "calls.log");
        const journal = journalAdapter();
        let cancelRequested = false;
        let nowMs = 0;
        const script = kind === "none"
          ? noneHandlerScript(callsPath)
          : successHandlerScript(callsPath);
        const result = await executeAirDocument(effectDocument({ maxRunMs: 1100 }), {
          ...durableOptions({
            manifest: effectManifest(script, { kind, timeoutMs: 1000 }),
            journal,
            observer: async ({ checkpoint }) => {
              if (checkpoint.pending_dispatch?.phase !== "dispatched") return;
              if (mode === "cancel") cancelRequested = true;
              if (mode === "time") nowMs = 125;
            },
          }),
          now: () => nowMs,
          cancelRequestedProvider: () => cancelRequested,
        });

        if (mode === "cancel") {
          assert.equal(result.status, "cancelled");
          assert.equal(
            result.trace.events.some((event) => event.kind === "dispatch_refused_cancelled"),
            true,
          );
        } else {
          assert.equal(result.status, "failure");
          assert.equal(failureCode(result), "RunTimeBudgetExceeded");
        }
        assert.equal(readFileIfExists(callsPath), "");
        assert.equal(
          [...journal.entries.values()].some((entry) => entry.state === "applied"),
          false,
        );
      } finally {
        rmSync(workspace, { recursive: true, force: true });
      }
    }
  }
});

test("revalidates expiring secret authority after the dispatched checkpoint before spawn", async () => {
  const initialNowMs = Date.parse("2026-01-01T00:00:00.000Z");
  const expiresAt = "2026-01-01T00:00:00.100Z";
  const secretValue = "durable-expiring-\"secret\"\nwith\\escapes-never-disclose";
  const document = effectDocument();
  document.definitions.tools[0].required_capabilities = ["secret_read"];
  document.definitions.tools[0].required_secrets = ["API_TOKEN"];

  for (const kind of ["none", "external_write"]) {
    const workspace = mkdtempSync(join(tmpdir(), `touba-resume-expiring-${kind}-`));
    try {
      const callsPath = join(workspace, "calls.log");
      const journal = journalAdapter();
      let nowMs = initialNowMs;
      const script = kind === "none"
        ? noneHandlerScript(callsPath)
        : successHandlerScript(callsPath);
      const result = await executeAirDocument(document, {
        ...durableOptions({
          manifest: effectManifest(script, {
            kind,
            grants: ["secret_read"],
            secrets: ["API_TOKEN"],
          }),
          journal,
          observer: async ({ checkpoint }) => {
            if (checkpoint.pending_dispatch?.phase === "dispatched") {
              nowMs = Date.parse(expiresAt);
            }
          },
        }),
        now: () => nowMs,
        secretStore: expiringSecretStore(secretValue, expiresAt),
      });

      assert.equal(result.status, "failure");
      assert.equal(failureCode(result), "SecretHandleExpired");
      assert.equal(readFileIfExists(callsPath), "");
      assert.equal([...journal.entries.values()].some((entry) => entry.state === "applied"), false);
      assert.equal(JSON.stringify(result.trace).includes(secretValue), false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }
});

test("revalidates current host dispatch authority after the dispatched checkpoint", async () => {
  for (const kind of ["none", "external_write"]) {
    const workspace = mkdtempSync(join(tmpdir(), `touba-resume-host-authority-${kind}-`));
    try {
      const callsPath = join(workspace, "calls.log");
      const journal = journalAdapter();
      let authorized = true;
      const authorityRequests = [];
      const result = await executeAirDocument(effectDocument(), {
        ...durableOptions({
          manifest: effectManifest(
            kind === "none" ? noneHandlerScript(callsPath) : successHandlerScript(callsPath),
            { kind },
          ),
          journal,
          observer: async ({ checkpoint }) => {
            if (checkpoint.pending_dispatch?.phase === "dispatched") authorized = false;
          },
        }),
        dispatchAuthorityProvider: async (request) => {
          authorityRequests.push(structuredClone(request));
          return authorized;
        },
      });

      assert.equal(result.status, "failure");
      assert.equal(failureCode(result), "DurableResumeAuthorityRefused");
      assert.equal(authorityRequests.length, 1);
      assert.equal(authorityRequests[0].tool_ref, "tool:test/Create");
      assert.equal(authorityRequests[0].effect_contract_kind, kind);
      assert.equal(readFileIfExists(callsPath), "");
      assert.equal([...journal.entries.values()].some((entry) => entry.state === "applied"), false);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  }

  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-host-authority-error-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const privateCause = "bearer host-authority-never-disclose";
    const result = await executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript(callsPath)),
        journal: journalAdapter(),
        observer: async () => {},
      }),
      dispatchAuthorityProvider: async () => {
        throw new Error(privateCause);
      },
    });
    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "DurableResumeAuthorityRefused");
    assert.equal(JSON.stringify(result).includes(privateCause), false);
    assert.equal(readFileIfExists(callsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses restored counters above tightened effective limits before execution", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-restored-budget-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const document = effectDocument();
    document.budgets = {
      run: {
        max_tool_calls: { value: 2, source_ref: sourceRef() },
      },
    };
    const manifest = effectManifest(successHandlerScript(callsPath));
    const { checkpoint, journal } = await captureRetryReservedCheckpoint(document, manifest);
    let observerCalls = 0;
    const result = await executeAirDocument(document, {
      ...durableOptions({
        manifest,
        journal,
        observer: async () => { observerCalls += 1; },
      }),
      executionResumeCheckpoint: checkpoint,
      runLimits: { max_tool_calls: 1 },
    });

    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "ToolCallBudgetExceeded");
    assert.equal(observerCalls, 0);
    assert.equal(journal.entries.size, 1);
    assert.equal(readFileIfExists(callsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("repairs a dispatched unknown attempt with a new call id and the same effect identity", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-unknown-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    let dispatchedCheckpoint;
    await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
      manifest: effectManifest(successHandlerScript(callsPath)),
      journal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.pending_dispatch?.phase === "dispatched") {
          dispatchedCheckpoint = structuredClone(checkpoint);
          throw new Error("simulated crash at spawn boundary");
        }
      },
    })), /simulated crash/u);

    const unknown = journal.entries.values().next().value;
    assert.equal(unknown.state, "unknown");
    const snapshots = [];
    const resumed = await executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript(callsPath)),
        journal,
        observer: async (snapshot) => snapshots.push(structuredClone(snapshot)),
      }),
      executionResumeCheckpoint: dispatchedCheckpoint,
    });

    assert.equal(resumed.status, "success");
    const request = readJsonLines(callsPath)[0];
    assert.equal(request.call_id, "call:run:durable:2");
    assert.equal(request.effect.effect_id, dispatchedCheckpoint.pending_dispatch.effect_id);
    assert.equal(request.effect.request_digest, dispatchedCheckpoint.pending_dispatch.request_digest);
    assert.equal(request.effect.attempt_index, 2);
    const readyGive = snapshots.find(({ checkpoint }) => checkpoint.cursor.node_id === "give")
      .checkpoint;
    assert.equal(readyGive.runtime_state.budget_counters.tool_calls, 2);
    assert.equal(readyGive.runtime_state.next_call_index, 3);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("converges when a retry reservation is persisted before the journal returns to prepared", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-retry-window-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    const manifest = effectManifest(successHandlerScript(callsPath));
    let dispatchedCheckpoint;
    await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.pending_dispatch?.phase === "dispatched") {
          dispatchedCheckpoint = structuredClone(checkpoint);
          throw new Error("first attempt interrupted");
        }
      },
    })), /first attempt/u);
    assert.equal(journal.entries.values().next().value.state, "unknown");

    let retryReservation;
    await assert.rejects(() => executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest,
        journal,
        observer: async ({ checkpoint }) => {
          if (
            checkpoint.pending_dispatch?.phase === "reserved"
            && checkpoint.pending_dispatch.call_id === "call:run:durable:2"
            && journal.entries.values().next().value.state === "unknown"
          ) {
            retryReservation = structuredClone(checkpoint);
            throw new Error("retry reserved before journal rewrite");
          }
        },
      }),
      executionResumeCheckpoint: dispatchedCheckpoint,
    }), /retry reserved/u);

    const resumed = await executeAirDocument(effectDocument(), {
      ...durableOptions({ manifest, journal, observer: async () => {} }),
      executionResumeCheckpoint: retryReservation,
    });
    assert.equal(resumed.status, "success");
    const request = readJsonLines(callsPath)[0];
    assert.equal(request.call_id, "call:run:durable:2");
    assert.equal(request.effect.attempt_index, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("repairs journal dispatch evidence before retrying without losing counters", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-journal-ahead-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter({ throwAfterState: "dispatched" });
    const manifest = effectManifest(successHandlerScript(callsPath));
    const checkpoints = [];
    const interrupted = await executeAirDocument(effectDocument(), durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => checkpoints.push(structuredClone(checkpoint)),
    }));
    assert.equal(interrupted.status, "failure");
    assert.equal(journal.entries.values().next().value.state, "dispatched");
    const reserved = checkpoints.findLast((checkpoint) =>
      checkpoint.pending_dispatch?.phase === "reserved"
    );
    journal.disableFailure();

    const resumedSnapshots = [];
    const resumed = await executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest,
        journal,
        observer: async ({ checkpoint }) => resumedSnapshots.push(structuredClone(checkpoint)),
      }),
      executionResumeCheckpoint: reserved,
    });
    assert.equal(resumed.status, "success");
    const repaired = resumedSnapshots.find((checkpoint) =>
      checkpoint.pending_dispatch?.phase === "dispatched"
      && checkpoint.pending_dispatch.call_id === "call:run:durable:1"
    );
    assert.equal(repaired.runtime_state.external_tool_dispatches, 1);
    assert.equal(repaired.runtime_state.budget_counters.tool_calls, 1);
    const readyGive = resumedSnapshots.find((checkpoint) => checkpoint.cursor.node_id === "give");
    assert.equal(readyGive.runtime_state.external_tool_dispatches, 2);
    assert.equal(readyGive.runtime_state.budget_counters.tool_calls, 2);
    assert.equal(readJsonLines(callsPath)[0].call_id, "call:run:durable:2");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("restores an applied journal result after crash without redispatch or tool budget charge", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-applied-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    let dispatchedCheckpoint;
    await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
      manifest: effectManifest(successHandlerScript(callsPath)),
      journal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.pending_dispatch?.phase === "dispatched") {
          dispatchedCheckpoint = structuredClone(checkpoint);
          throw new Error("simulated process loss");
        }
      },
    })), /simulated process loss/u);

    const [effectId, unknown] = journal.entries.entries().next().value;
    journal.entries.set(effectId, {
      ...unknown,
      state: "applied",
      receipt: {
        effect_id: effectId,
        request_digest: unknown.request_digest,
        outcome: "applied",
      },
      result: "created:same",
    });
    const contradictoryCheckpoint = structuredClone(dispatchedCheckpoint);
    contradictoryCheckpoint.pending_dispatch.request_digest = `sha256:${"0".repeat(64)}`;
    resealCheckpoint(contradictoryCheckpoint);
    const contradictory = await executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript(callsPath)),
        journal,
        observer: async () => {},
      }),
      executionResumeCheckpoint: contradictoryCheckpoint,
    });
    assert.equal(contradictory.status, "failure");
    assert.equal(failureCode(contradictory), "DurableResumeCheckpointIncompatible");
    assert.equal(readFileIfExists(callsPath), "");

    const snapshots = [];
    const resumed = await executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript(callsPath)),
        journal,
        observer: async (snapshot) => snapshots.push(structuredClone(snapshot)),
      }),
      executionResumeCheckpoint: dispatchedCheckpoint,
    });

    assert.equal(resumed.status, "success");
    assert.equal(resumed.result, "created:same");
    assert.equal(readFileIfExists(callsPath), "");
    const readyGive = snapshots.find(({ checkpoint }) => checkpoint.cursor.node_id === "give")
      .checkpoint;
    assert.equal(readyGive.runtime_state.budget_counters.tool_calls, 1);
    assert.equal(readyGive.runtime_state.next_call_index, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("continues a resumed trace segment at the checkpoint absolute sequence", async () => {
  const journal = journalAdapter();
  let appliedCheckpoint;
  await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
    manifest: effectManifest(successHandlerScript()),
    journal,
    observer: async ({ checkpoint }) => {
      if (checkpoint.cursor.node_id === "give" && checkpoint.cursor.phase === "ready") {
        appliedCheckpoint = structuredClone(checkpoint);
        throw new Error("simulated crash after effect");
      }
    },
  })), /simulated crash/u);

  const resumed = await executeAirDocument(effectDocument(), {
    ...durableOptions({
      manifest: effectManifest(successHandlerScript()),
      journal,
      observer: async () => {},
    }),
    executionResumeCheckpoint: appliedCheckpoint,
  });
  assert.equal(resumed.status, "success");
  assert.equal(resumed.trace.events[0].sequence_index, appliedCheckpoint.trace_state.next_sequence_index);
  assert.equal(
    resumed.trace.events[0].event_id,
    `event:run:durable:${appliedCheckpoint.trace_state.next_sequence_index + 1}`,
  );
  for (const [index, event] of resumed.trace.events.entries()) {
    assert.equal(event.sequence_index, appliedCheckpoint.trace_state.next_sequence_index + index);
  }
});

test("replays a lost kind none response with a new call id and bounded counters", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-none-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    const manifest = effectManifest(noneHandlerScript(callsPath), { kind: "none" });
    let dispatchedCheckpoint;
    await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.pending_dispatch?.phase === "dispatched") {
          dispatchedCheckpoint = structuredClone(checkpoint);
          throw new Error("simulated lost none response");
        }
      },
    })), /simulated lost/u);

    const snapshots = [];
    const resumed = await executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest,
        journal,
        observer: async (snapshot) => snapshots.push(structuredClone(snapshot)),
      }),
      executionResumeCheckpoint: dispatchedCheckpoint,
    });
    assert.equal(resumed.status, "success");
    assert.equal(resumed.result, "created:same");
    assert.equal(readJsonLines(callsPath)[0].call_id, "call:run:durable:2");
    const readyGive = snapshots.find(({ checkpoint }) => checkpoint.cursor.node_id === "give")
      .checkpoint;
    assert.equal(readyGive.runtime_state.budget_counters.tool_calls, 2);
    assert.equal(readyGive.runtime_state.next_call_index, 3);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects journal high-water that cannot be reconciled without refunding budgets", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-journal-high-water-"));
  try {
    const document = effectDocument();

    const conflictCallsPath = join(workspace, "conflict-calls.log");
    const conflictJournal = journalAdapter();
    seedJournalEntry(conflictJournal, document, { effectIndex: 1, callIndex: 7 });
    let conflictObserverCalls = 0;
    const conflict = await executeAirDocument(document, durableOptions({
      manifest: effectManifest(successHandlerScript(conflictCallsPath)),
      journal: conflictJournal,
      observer: async () => { conflictObserverCalls += 1; },
    }));
    assert.equal(conflict.status, "failure");
    assert.equal(failureCode(conflict), "DurableResumeConflict");
    assert.equal(conflictObserverCalls, 0);
    assert.equal(readFileIfExists(conflictCallsPath), "");

    for (const state of ["applied", "unknown"]) {
      const aheadCallsPath = join(workspace, `ahead-${state}-calls.log`);
      const aheadManifest = effectManifest(successHandlerScript(aheadCallsPath));
      const aheadCheckpoint = await captureInitialCheckpoint(document, aheadManifest);
      const aheadJournal = journalAdapter();
      seedJournalEntry(aheadJournal, document, {
        effectIndex: 1,
        callIndex: 7,
        state,
        ...(state === "applied" ? { result: "created:same" } : {}),
      });
      let aheadObserverCalls = 0;
      const aheadResult = await executeAirDocument(document, {
        ...durableOptions({
          manifest: aheadManifest,
          journal: aheadJournal,
          observer: async () => { aheadObserverCalls += 1; },
        }),
        executionResumeCheckpoint: aheadCheckpoint,
      });
      assert.equal(aheadResult.status, "failure");
      assert.equal(failureCode(aheadResult), "DurableResumeCheckpointIncompatible");
      assert.equal(aheadObserverCalls, 0);
      assert.equal(readFileIfExists(aheadCallsPath), "");
    }

    const retryCallsPath = join(workspace, "retry-calls.log");
    const retryManifest = effectManifest(successHandlerScript(retryCallsPath));
    const {
      checkpoint: retryCheckpoint,
      journal: retryJournal,
    } = await captureRetryReservedCheckpoint(document, retryManifest);
    const [retryEffectId, priorAttempt] = retryJournal.entries.entries().next().value;
    retryJournal.entries.set(retryEffectId, {
      ...priorAttempt,
      last_call_id: "call:run:durable:7",
    });
    let retryObserverCalls = 0;
    const retryResult = await executeAirDocument(document, {
      ...durableOptions({
        manifest: retryManifest,
        journal: retryJournal,
        observer: async () => { retryObserverCalls += 1; },
      }),
      executionResumeCheckpoint: retryCheckpoint,
    });
    assert.equal(retryResult.status, "failure");
    assert.equal(failureCode(retryResult), "DurableResumeCheckpointIncompatible");
    assert.equal(retryObserverCalls, 0);
    assert.equal(readFileIfExists(retryCallsPath), "");
    assert.equal(retryJournal.entries.size, 1);

    const emptyCallsPath = join(workspace, "empty-reserved-calls.log");
    const emptyManifest = effectManifest(successHandlerScript(emptyCallsPath));
    const emptyCheckpoint = await captureReservedCheckpoint(document, emptyManifest);
    const emptyJournal = journalAdapter();
    const emptyResume = await executeAirDocument(document, {
      ...durableOptions({
        manifest: emptyManifest,
        journal: emptyJournal,
        observer: async () => {},
      }),
      executionResumeCheckpoint: emptyCheckpoint,
    });
    assert.equal(emptyResume.status, "success");
    assert.equal(readJsonLines(emptyCallsPath)[0].call_id, "call:run:durable:1");

    const malformedPending = structuredClone(emptyCheckpoint);
    malformedPending.runtime_state.next_effect_index = 100;
    resealCheckpoint(malformedPending);
    assert.throws(
      () => validateExecutionCheckpoint(malformedPending),
      (error) => error?.code === "DurableResumeCheckpointInvalid",
    );

    const gapCallsPath = join(workspace, "gap-calls.log");
    const gapManifest = effectManifest(successHandlerScript(gapCallsPath));
    const gapCheckpoint = await captureInitialCheckpoint(document, gapManifest);
    const gapJournal = journalAdapter();
    seedJournalEntry(gapJournal, document, { effectIndex: 1, callIndex: 7 });
    seedJournalEntry(gapJournal, document, { effectIndex: 3, callIndex: 9 });
    let gapObserverCalls = 0;
    const gapResult = await executeAirDocument(document, {
      ...durableOptions({
        manifest: gapManifest,
        journal: gapJournal,
        observer: async () => { gapObserverCalls += 1; },
      }),
      executionResumeCheckpoint: gapCheckpoint,
    });
    assert.equal(gapResult.status, "failure");
    assert.equal(failureCode(gapResult), "DurableResumeCheckpointIncompatible");
    assert.equal(gapObserverCalls, 0);
    assert.equal(readFileIfExists(gapCallsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses a resumed checkpoint whose completed effect history was truncated", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-truncated-journal-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const document = twoEffectDocument();
    const manifest = effectManifest(successHandlerScript(callsPath));
    const journal = journalAdapter();
    let checkpointAfterFirstEffect;
    await assert.rejects(() => executeAirDocument(document, durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.cursor.node_id !== "call_b" || checkpoint.cursor.phase !== "ready") return;
        checkpointAfterFirstEffect = structuredClone(checkpoint);
        throw new Error("capture checkpoint after first effect");
      },
    })), /capture checkpoint after first effect/u);
    assert.equal(journal.entries.size, 1);
    assert.equal(readJsonLines(callsPath).length, 1);

    journal.entries.clear();
    let observerCalls = 0;
    const resumed = await executeAirDocument(document, {
      ...durableOptions({
        manifest,
        journal,
        observer: async () => { observerCalls += 1; },
      }),
      executionResumeCheckpoint: checkpointAfterFirstEffect,
    });
    assert.equal(resumed.status, "failure");
    assert.equal(failureCode(resumed), "DurableResumeCheckpointIncompatible");
    assert.equal(observerCalls, 0);
    assert.equal(readJsonLines(callsPath).length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses durable execution when the journal cannot enumerate its scope", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-journal-enumeration-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    delete journal.adapter.entriesForScope;
    let observerCalls = 0;
    const result = await executeAirDocument(effectDocument(), durableOptions({
      manifest: effectManifest(successHandlerScript(callsPath)),
      journal,
      observer: async () => { observerCalls += 1; },
    }));
    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "DurableResumeUnsupportedState");
    assert.equal(observerCalls, 0);
    assert.equal(journal.entries.size, 0);
    assert.equal(readFileIfExists(callsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires a valid preavailable human decision and persists its bounded ledger", async () => {
  const journal = journalAdapter();
  const withoutDecision = await executeAirDocument(humanDocument(), {
    entryRef: "skill:test/ApproveFlow",
    runId: "run:human",
    operationId: "operation:human",
    effectScopeId: "operation:human",
    effectJournal: journal.adapter,
    executionCheckpointObserver: async () => {},
  });
  assert.equal(withoutDecision.status, "failure");
  assert.equal(failureCode(withoutDecision), "DurableResumeUnsupportedGraph");

  const checkpoints = [];
  const approved = await executeAirDocument(humanDocument(), {
    entryRef: "skill:test/ApproveFlow",
    runId: "run:human",
    operationId: "operation:human",
    effectScopeId: "operation:human",
    effectJournal: journal.adapter,
    humanApprovalDecisions: { "approval:test": "approved" },
    executionCheckpointObserver: async ({ checkpoint }) => {
      checkpoints.push(structuredClone(checkpoint));
    },
  });
  assert.equal(approved.status, "success");
  const readyGive = checkpoints.find((checkpoint) => checkpoint.cursor.node_id === "give");
  assert.deepEqual(readyGive.decisions_consumed, [{
    decision_ref: "approval:test",
    result: "approved",
    decision_digest: readyGive.decisions_consumed[0].decision_digest,
  }]);
  assert.match(readyGive.decisions_consumed[0].decision_digest, /^sha256:[0-9a-f]{64}$/u);
});

test("durable execution preserves constrained signer history across a crash between approvals", async () => {
  const document = humanDocument();
  const graph = document.execution_graphs[0];
  graph.nodes[0].approval_policy = { role: "finance", distinct_from: "previous" };
  graph.nodes.splice(1, 0, { ...structuredClone(graph.nodes[0]), id: "approve_again", approval_ref: "approval:second" });
  graph.edges = [{ from_node_id: "approve", to_node_id: "approve_again", role: "next" },
    { from_node_id: "approve_again", to_node_id: "give", role: "next" }];
  const journal = journalAdapter();
  let checkpoint;
  const authority = subject => ({ request, decision }) => ({ request_id: request.request_id,
    run_id: request.run_id, decision, subject_ref: subject, roles: ["finance"] });
  const options = { entryRef: "skill:test/ApproveFlow", runId: "run:signers", operationId: "operation:signers",
    effectScopeId: "operation:signers",
    effectJournal: journal.adapter, humanApprovalAuthority: authority("employee:one"),
    humanApprovalDecisions: new Map(["approval:test", "approval:second"].map(ref =>
      [ref, { decision: "approved", evidence_ref: "host-evidence" }])) };
  await assert.rejects(executeAirDocument(document, { ...options, executionCheckpointObserver: snapshot => {
    if (snapshot.checkpoint.cursor.node_id === "approve_again" && snapshot.checkpoint.cursor.phase === "ready") {
      checkpoint = structuredClone(snapshot.checkpoint);
      throw new Error("crash between signatures");
    }
  } }), /crash between signatures/u);
  assert.equal(checkpoint.approval_state.receipts[0].subject_ref, "employee:one");
  const denied = await executeAirDocument(document, { ...options, executionResumeCheckpoint: checkpoint,
    executionCheckpointObserver: () => {} });
  assert.equal(denied.reason, "HumanApprovalSignerConflict");
  const accepted = await executeAirDocument(document, { ...options, executionResumeCheckpoint: checkpoint,
    humanApprovalAuthority: authority("employee:two"), executionCheckpointObserver: () => {} });
  assert.equal(accepted.status, "success", JSON.stringify(accepted));
  const incomplete = structuredClone(checkpoint);
  delete incomplete.approval_state;
  const { checkpoint_digest, ...content } = incomplete;
  incomplete.checkpoint_digest = canonicalDigest(content);
  await assert.rejects(executeAirDocument(document, { ...options, executionResumeCheckpoint: incomplete,
    executionCheckpointObserver: () => {} }), { code: "HumanApprovalCheckpointIncompatible" });
});

test("refuses a removed or changed consumed human decision as current authority", async () => {
  const initialJournal = journalAdapter();
  let initialCheckpoint;
  await assert.rejects(() => executeAirDocument(humanDocument(), {
    entryRef: "skill:test/ApproveFlow",
    runId: "run:human-initial-authority",
    operationId: "operation:human-initial-authority",
    effectScopeId: "operation:human-initial-authority",
    effectJournal: initialJournal.adapter,
    humanApprovalDecisions: { "approval:test": "approved" },
    executionCheckpointObserver: async ({ checkpoint }) => {
      initialCheckpoint = structuredClone(checkpoint);
      throw new Error("crash before decision consumption");
    },
  }), /before decision/u);
  const removedBeforeConsumption = await executeAirDocument(humanDocument(), {
    entryRef: "skill:test/ApproveFlow",
    runId: "run:human-initial-authority",
    operationId: "operation:human-initial-authority",
    effectScopeId: "operation:human-initial-authority",
    effectJournal: initialJournal.adapter,
    humanApprovalDecisions: {},
    executionResumeCheckpoint: initialCheckpoint,
    executionCheckpointObserver: async () => {},
  });
  assert.equal(removedBeforeConsumption.status, "failure");
  assert.equal(failureCode(removedBeforeConsumption), "DurableResumeAuthorityRefused");

  const consumedJournal = journalAdapter();
  let consumedCheckpoint;
  await assert.rejects(() => executeAirDocument(humanDocument(), {
    entryRef: "skill:test/ApproveFlow",
    runId: "run:human-authority",
    operationId: "operation:human-authority",
    effectScopeId: "operation:human-authority",
    effectJournal: consumedJournal.adapter,
    humanApprovalDecisions: { "approval:test": "approved" },
    executionCheckpointObserver: async ({ checkpoint }) => {
      if (checkpoint.cursor.node_id === "give") {
        consumedCheckpoint = structuredClone(checkpoint);
        throw new Error("decision consumed before crash");
      }
    },
  }), /decision consumed/u);

  for (const decisions of [{}, { "approval:test": "rejected" }]) {
    const resumed = await executeAirDocument(humanDocument(), {
      entryRef: "skill:test/ApproveFlow",
      runId: "run:human-authority",
      operationId: "operation:human-authority",
      effectScopeId: "operation:human-authority",
      effectJournal: consumedJournal.adapter,
      humanApprovalDecisions: decisions,
      executionResumeCheckpoint: consumedCheckpoint,
      executionCheckpointObserver: async () => {},
    });
    assert.equal(resumed.status, "failure");
    assert.equal(failureCode(resumed), "DurableResumeAuthorityRefused");
  }
});

test("refuses unsupported closure and missing bindings before any handler", async () => {
  const branched = effectDocument();
  branched.execution_graphs[0].edges.push({ from_node_id: "call", to_node_id: "give", role: "next" });
  for (const [document, manifest] of [
    [branched, effectManifest(successHandlerScript())],
    [effectDocument(), emptyEffectManifest()],
  ]) {
    const result = await executeAirDocument(document, durableOptions({
      manifest,
      journal: journalAdapter(),
      observer: async () => {},
    }));
    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "DurableResumeUnsupportedGraph");
  }
});

test("refuses a dispatched checkpoint that is ahead of its prepared journal", async () => {
  const journal = journalAdapter();
  let dispatchedCheckpoint;
  await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
    manifest: effectManifest(successHandlerScript()),
    journal,
    observer: async ({ checkpoint }) => {
      if (checkpoint.pending_dispatch?.phase === "dispatched") {
        dispatchedCheckpoint = structuredClone(checkpoint);
        throw new Error("simulated crash");
      }
    },
  })), /simulated crash/u);
  const [effectId, entry] = journal.entries.entries().next().value;
  journal.entries.set(effectId, {
    ...entry,
    state: "prepared",
    attempt_count: 0,
  });
  delete journal.entries.get(effectId).last_call_id;

  const resumed = await executeAirDocument(effectDocument(), {
    ...durableOptions({
      manifest: effectManifest(successHandlerScript()),
      journal,
      observer: async () => {},
    }),
    executionResumeCheckpoint: dispatchedCheckpoint,
  });
  assert.equal(resumed.status, "failure");
  assert.equal(failureCode(resumed), "DurableResumeCheckpointIncompatible");
});

test("refuses a pending dispatch that contradicts the current tool contract", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-pending-contract-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    const manifest = effectManifest(successHandlerScript(callsPath));
    let reservedCheckpoint;
    await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.pending_dispatch?.phase === "reserved") {
          reservedCheckpoint = structuredClone(checkpoint);
          throw new Error("capture reserved checkpoint");
        }
      },
    })), /capture reserved/u);
    assert.equal(journal.entries.size, 0);

    const mutations = [
      (checkpoint) => { checkpoint.pending_dispatch.tool_ref = "tool:test/Other"; },
      (checkpoint) => {
        checkpoint.pending_dispatch.effect_contract_kind = "none";
        checkpoint.pending_dispatch.effect_index = null;
        checkpoint.pending_dispatch.effect_id = null;
        checkpoint.pending_dispatch.request_digest = null;
        checkpoint.pending_dispatch.retry_mode = null;
      },
      (checkpoint) => { checkpoint.pending_dispatch.retry_mode = "reconcile"; },
    ];
    for (const mutate of mutations) {
      const contradictory = structuredClone(reservedCheckpoint);
      mutate(contradictory);
      resealCheckpoint(contradictory);
      validateExecutionCheckpoint(contradictory);
      let observerCalls = 0;
      const resumed = await executeAirDocument(effectDocument(), {
        ...durableOptions({
          manifest,
          journal,
          observer: async () => { observerCalls += 1; },
        }),
        executionResumeCheckpoint: contradictory,
      });
      assert.equal(resumed.status, "failure");
      assert.equal(failureCode(resumed), "DurableResumeCheckpointIncompatible");
      assert.equal(observerCalls, 0);
    }
    assert.equal(journal.entries.size, 0);
    assert.equal(readFileIfExists(callsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects re-sealed pending reservations that refund time or tool-call budgets", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-pending-budget-integrity-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const document = effectDocument();
    const manifest = effectManifest(successHandlerScript(callsPath));
    const reserved = await captureReservedCheckpoint(document, manifest);
    const mutations = [
      (checkpoint) => { checkpoint.pending_dispatch.budget_reserved.active_ms -= 1; },
      (checkpoint) => { checkpoint.runtime_state.active_elapsed_ms = 0; },
      (checkpoint) => { checkpoint.runtime_state.budget_counters.tool_calls = 0; },
    ];

    for (const mutate of mutations) {
      const contradictory = structuredClone(reserved);
      mutate(contradictory);
      resealCheckpoint(contradictory);
      let observerCalls = 0;
      await assert.rejects(
        () => executeAirDocument(document, {
          ...durableOptions({
            manifest,
            journal: journalAdapter(),
            observer: async () => { observerCalls += 1; },
          }),
          executionResumeCheckpoint: contradictory,
        }),
        (error) => error?.code === "DurableResumeCheckpointInvalid",
      );
      assert.equal(observerCalls, 0);
    }

    const staleTimeout = structuredClone(reserved);
    staleTimeout.pending_dispatch.timeout_ms -= 1;
    staleTimeout.pending_dispatch.budget_reserved.active_ms -= 1;
    resealCheckpoint(staleTimeout);
    validateExecutionCheckpoint(staleTimeout);
    let timeoutObserverCalls = 0;
    const timeoutResult = await executeAirDocument(document, {
      ...durableOptions({
        manifest,
        journal: journalAdapter(),
        observer: async () => { timeoutObserverCalls += 1; },
      }),
      executionResumeCheckpoint: staleTimeout,
    });
    assert.equal(timeoutResult.status, "failure");
    assert.equal(failureCode(timeoutResult), "DurableResumeCheckpointIncompatible");
    assert.equal(timeoutObserverCalls, 0);
    assert.equal(readFileIfExists(callsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses reserved checkpoints that contradict their journal attempt", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-pending-attempt-matrix-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const document = effectDocument();
    const manifest = effectManifest(successHandlerScript(callsPath));
    const reserved = await captureReservedCheckpoint(document, manifest);
    const cases = [
      {
        mutateCheckpoint: (checkpoint) => { checkpoint.pending_dispatch.attempt_index = 2; },
        seed: () => {},
      },
      {
        mutateCheckpoint: (checkpoint) => { checkpoint.pending_dispatch.attempt_index = 2; },
        seed: (journal) => seedJournalEntry(journal, document, {
          effectIndex: 1,
          callIndex: 1,
          state: "applied",
          result: "created:same",
        }),
      },
      {
        mutateCheckpoint: () => {},
        seed: (journal) => seedJournalEntry(journal, document, {
          effectIndex: 1,
          callIndex: 1,
          state: "prepared",
        }),
      },
    ];

    for (const scenario of cases) {
      const checkpoint = structuredClone(reserved);
      scenario.mutateCheckpoint(checkpoint);
      resealCheckpoint(checkpoint);
      const journal = journalAdapter();
      scenario.seed(journal);
      let observerCalls = 0;
      const result = await executeAirDocument(document, {
        ...durableOptions({
          manifest,
          journal,
          observer: async () => { observerCalls += 1; },
        }),
        executionResumeCheckpoint: checkpoint,
      });
      assert.equal(result.status, "failure");
      assert.equal(failureCode(result), "DurableResumeCheckpointIncompatible");
      assert.equal(observerCalls, 0);
      assert.equal(readFileIfExists(callsPath), "");
    }

    const {
      checkpoint: retryCheckpoint,
      journal: retryJournal,
    } = await captureRetryReservedCheckpoint(document, manifest);
    const [effectId, priorAttempt] = retryJournal.entries.entries().next().value;
    retryJournal.entries.set(effectId, {
      ...priorAttempt,
      state: "prepared",
      last_call_id: retryCheckpoint.pending_dispatch.call_id,
    });
    let retryObserverCalls = 0;
    const retryResult = await executeAirDocument(document, {
      ...durableOptions({
        manifest,
        journal: retryJournal,
        observer: async () => { retryObserverCalls += 1; },
      }),
      executionResumeCheckpoint: retryCheckpoint,
    });
    assert.equal(retryResult.status, "failure");
    assert.equal(failureCode(retryResult), "DurableResumeCheckpointIncompatible");
    assert.equal(retryObserverCalls, 0);
    assert.equal(readFileIfExists(callsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("binds durable counters and effect history to the exact linear cursor", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-linear-progress-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const document = twoEffectDocument();
    const manifest = effectManifest(successHandlerScript(callsPath));
    const journal = journalAdapter();
    let readyGive;
    await assert.rejects(() => executeAirDocument(document, durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.cursor.node_id !== "give" || checkpoint.cursor.phase !== "ready") return;
        readyGive = structuredClone(checkpoint);
        throw new Error("capture third-node checkpoint");
      },
    })), /capture third-node/u);
    assert.equal(readJsonLines(callsPath).length, 2);

    const mutations = [
      (checkpoint) => { checkpoint.runtime_state.budget_counters.steps = 1; },
      (checkpoint) => { checkpoint.runtime_state.next_call_index += 1; },
      (checkpoint) => { checkpoint.runtime_state.external_tool_dispatches -= 1; },
    ];
    for (const mutate of mutations) {
      const contradictory = structuredClone(readyGive);
      mutate(contradictory);
      resealCheckpoint(contradictory);
      let observerCalls = 0;
      const result = await executeAirDocument(document, {
        ...durableOptions({
          manifest,
          journal,
          observer: async () => { observerCalls += 1; },
        }),
        executionResumeCheckpoint: contradictory,
      });
      assert.equal(result.status, "failure");
      assert.equal(failureCode(result), "DurableResumeCheckpointIncompatible");
      assert.equal(observerCalls, 0);
    }
    assert.equal(readJsonLines(callsPath).length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("does not let a re-sealed checkpoint refund a completed kind none tool call", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-none-prefix-counter-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const document = twoEffectDocument();
    const manifest = effectManifest(noneHandlerScript(callsPath), { kind: "none" });
    const journal = journalAdapter();
    let afterFirst;
    await assert.rejects(() => executeAirDocument(document, durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.cursor.node_id !== "call_b" || checkpoint.cursor.phase !== "ready") return;
        afterFirst = structuredClone(checkpoint);
        throw new Error("capture completed none prefix");
      },
    })), /capture completed none prefix/u);
    assert.equal(readJsonLines(callsPath).length, 1);

    afterFirst.runtime_state.budget_counters.tool_calls = 0;
    afterFirst.runtime_state.external_tool_dispatches = 0;
    afterFirst.runtime_state.next_call_index = 1;
    resealCheckpoint(afterFirst);
    let observerCalls = 0;
    const result = await executeAirDocument(document, {
      ...durableOptions({
        manifest,
        journal,
        observer: async () => { observerCalls += 1; },
      }),
      executionResumeCheckpoint: afterFirst,
    });
    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "DurableResumeCheckpointIncompatible");
    assert.equal(observerCalls, 0);
    assert.equal(readJsonLines(callsPath).length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires historical effects to be applied, restorable, and bound to their tool request", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-historical-effect-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const document = twoEffectDocument();
    const manifest = effectManifest(successHandlerScript(callsPath));
    const sourceJournal = journalAdapter();
    let afterFirst;
    await assert.rejects(() => executeAirDocument(document, durableOptions({
      manifest,
      journal: sourceJournal,
      observer: async ({ checkpoint }) => {
        if (checkpoint.cursor.node_id !== "call_b" || checkpoint.cursor.phase !== "ready") return;
        afterFirst = structuredClone(checkpoint);
        throw new Error("capture first applied effect");
      },
    })), /capture first applied/u);
    const original = sourceJournal.entries.values().next().value;

    const mutations = [
      (entry) => {
        entry.state = "unknown";
        delete entry.receipt;
        delete entry.result;
      },
      (entry) => { entry.tool_ref = "tool:test/Other"; },
      (entry) => {
        entry.request_digest = `sha256:${"0".repeat(64)}`;
        entry.receipt.request_digest = entry.request_digest;
      },
      (entry) => { entry.attempt_count = 999; },
      (entry) => {
        entry.state = "prepared";
        entry.attempt_count = 1;
        delete entry.last_call_id;
        delete entry.receipt;
        delete entry.result;
      },
    ];
    for (const mutate of mutations) {
      const journal = journalAdapter();
      const entry = structuredClone(original);
      mutate(entry);
      journal.entries.set(entry.effect_id, entry);
      let observerCalls = 0;
      const result = await executeAirDocument(document, {
        ...durableOptions({
          manifest,
          journal,
          observer: async () => { observerCalls += 1; },
        }),
        executionResumeCheckpoint: afterFirst,
      });
      assert.equal(result.status, "failure");
      assert.equal(failureCode(result), "DurableResumeCheckpointIncompatible");
      assert.equal(observerCalls, 0);
    }

    const secretValue = "scope-secret-\"quoted\"\nwith\\slashes-never-disclose";
    const secretMutations = [
      (entry) => { entry.result = secretValue; },
      (entry) => { entry.receipt.receipt_ref = secretValue; },
      (entry) => { entry.tool_ref = secretValue; },
    ];
    for (const mutate of secretMutations) {
      const journal = journalAdapter();
      const entry = structuredClone(original);
      mutate(entry);
      journal.entries.set(entry.effect_id, entry);
      let observerCalls = 0;
      const result = await executeAirDocument(document, {
        ...durableOptions({
          manifest,
          journal,
          observer: async () => { observerCalls += 1; },
        }),
        executionResumeCheckpoint: afterFirst,
        secretStore: testSecretStore(secretValue),
      });
      assert.equal(result.status, "failure");
      assert.equal(failureCode(result), "SecretValueInEffectArtifact");
      assert.equal(observerCalls, 0);
      assert.equal(JSON.stringify(result).includes(secretValue), false);
    }
    assert.equal(readJsonLines(callsPath).length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("binds the consumed-decision ledger exactly to approvals before the cursor", async () => {
  const document = humanDocument();
  const journal = journalAdapter();
  let beforeApproval;
  let afterApproval;
  await assert.rejects(() => executeAirDocument(document, {
    entryRef: "skill:test/ApproveFlow",
    runId: "run:human-ledger",
    operationId: "operation:human-ledger",
    effectScopeId: "operation:human-ledger",
    effectJournal: journal.adapter,
    humanApprovalDecisions: { "approval:test": "approved" },
    executionCheckpointObserver: async ({ checkpoint }) => {
      if (checkpoint.cursor.node_id === "approve" && checkpoint.cursor.phase === "ready") {
        beforeApproval = structuredClone(checkpoint);
      }
      if (checkpoint.cursor.node_id === "give" && checkpoint.cursor.phase === "ready") {
        afterApproval = structuredClone(checkpoint);
        throw new Error("capture approval ledger");
      }
    },
  }), /capture approval ledger/u);

  const futureLedger = structuredClone(beforeApproval);
  futureLedger.decisions_consumed.push({
    decision_ref: "approval:test",
    result: "approved",
    decision_digest: canonicalDigest({ decision_ref: "approval:test", result: "approved" }),
  });
  resealCheckpoint(futureLedger);
  const missingLedger = structuredClone(afterApproval);
  missingLedger.decisions_consumed = [];
  resealCheckpoint(missingLedger);

  for (const checkpoint of [futureLedger, missingLedger]) {
    let observerCalls = 0;
    const result = await executeAirDocument(document, {
      entryRef: "skill:test/ApproveFlow",
      runId: "run:human-ledger",
      operationId: "operation:human-ledger",
      effectScopeId: "operation:human-ledger",
      effectJournal: journal.adapter,
      humanApprovalDecisions: { "approval:test": "approved" },
      executionResumeCheckpoint: checkpoint,
      executionCheckpointObserver: async () => { observerCalls += 1; },
    });
    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "DurableResumeCheckpointIncompatible");
    assert.equal(observerCalls, 0);
  }
});

test("rejects altered, legacy, and unknown checkpoint envelopes before execution", async () => {
  const journal = journalAdapter();
  let initialCheckpoint;
  await assert.rejects(() => executeAirDocument(effectDocument(), durableOptions({
    manifest: effectManifest(successHandlerScript()),
    journal,
    observer: async ({ checkpoint }) => {
      initialCheckpoint = structuredClone(checkpoint);
      throw new Error("capture initial checkpoint");
    },
  })), /capture initial/u);

  const altered = structuredClone(initialCheckpoint);
  altered.runtime_state.next_call_index += 1;
  await assert.rejects(
    () => executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript()),
        journal,
        observer: async () => {},
      }),
      executionResumeCheckpoint: altered,
    }),
    (error) => error?.code === "DurableResumeCheckpointIntegrityMismatch",
  );
  for (const [revision, previousCheckpointDigest] of [
    [1, `sha256:${"0".repeat(64)}`],
    [2, null],
  ]) {
    const inconsistentChain = structuredClone(initialCheckpoint);
    inconsistentChain.revision = revision;
    inconsistentChain.previous_checkpoint_digest = previousCheckpointDigest;
    resealCheckpoint(inconsistentChain);
    assert.throws(
      () => validateExecutionCheckpoint(inconsistentChain),
      (error) => error?.code === "DurableResumeCheckpointInvalid",
    );
  }
  for (const [checkpoint, code] of [
    [{ checkpoint_schema_version: "touba-human-approval-checkpoint-v1" }, "DurableResumeCheckpointMigrationRequired"],
    [{ checkpoint_schema_version: "future-checkpoint" }, "DurableResumeCheckpointInvalid"],
  ]) {
    await assert.rejects(
      () => executeAirDocument(effectDocument(), {
        ...durableOptions({
          manifest: effectManifest(successHandlerScript()),
          journal,
          observer: async () => {},
        }),
        executionResumeCheckpoint: checkpoint,
      }),
      (error) => error?.code === code,
    );
  }

  const sensitiveKey = "raw prompt \"quoted\"\nwith\\slashes-never-disclose";
  const unknownField = structuredClone(initialCheckpoint);
  unknownField[sensitiveKey] = true;
  resealCheckpoint(unknownField);
  let traceEvents = 0;
  await assert.rejects(
    () => executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript()),
        journal,
        observer: async () => {},
      }),
      executionResumeCheckpoint: unknownField,
      traceEventObserver: () => { traceEvents += 1; },
    }),
    (error) => (
      error?.code === "DurableResumeCheckpointInvalid"
      && !`${error.message}${JSON.stringify(error.details)}`.includes(sensitiveKey)
    ),
  );
  assert.equal(traceEvents, 0);
});

test("refuses a resumed checkpoint containing a currently resolved secret before execution", async () => {
  const secretValue = "resume-secret-\"quoted\"\nwith\\slashes-never-disclose";
  const secretStore = testSecretStore(secretValue);
  const journal = journalAdapter();
  let initialCheckpoint;
  await assert.rejects(() => executeAirDocument(effectDocument(), {
    ...durableOptions({
      manifest: effectManifest(successHandlerScript()),
      journal,
      observer: async ({ checkpoint }) => {
        initialCheckpoint = structuredClone(checkpoint);
        throw new Error("capture checkpoint before dispatch");
      },
    }),
    secretStore,
  }), /capture checkpoint/u);

  initialCheckpoint.runtime_state.values["value:poison"] = secretValue;
  resealCheckpoint(initialCheckpoint);
  let observerCalls = 0;
  let traceEvents = 0;
  await assert.rejects(
    () => executeAirDocument(effectDocument(), {
      ...durableOptions({
        manifest: effectManifest(successHandlerScript()),
        journal,
        observer: async () => { observerCalls += 1; },
      }),
      executionResumeCheckpoint: initialCheckpoint,
      secretStore,
      traceEventObserver: () => { traceEvents += 1; },
    }),
    (error) => (
      error?.code === "DurableResumeAuthorityRefused"
      && !`${error.message}${JSON.stringify(error.details)}`.includes(secretValue)
    ),
  );
  assert.equal(observerCalls, 0);
  assert.equal(traceEvents, 0);
  assert.equal(journal.entries.size, 0);
});

test("refuses mixing RESUME-1 with a human approval v0.1 checkpoint", async () => {
  const paused = await executeAirDocument(humanDocument(), {
    entryRef: "skill:test/ApproveFlow",
    durableHumanApprovals: true,
  });
  assert.equal(paused.status, "stopped");
  assert.ok(paused.checkpoint);

  const workspace = mkdtempSync(join(tmpdir(), "touba-resume-exclusive-checkpoints-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    let observerCalls = 0;
    let traceEvents = 0;
    await assert.rejects(
      () => executeAirDocument(effectDocument(), {
        ...durableOptions({
          manifest: effectManifest(successHandlerScript(callsPath)),
          journal,
          observer: async () => { observerCalls += 1; },
        }),
        humanApprovalResumeCheckpoint: paused.checkpoint,
        traceEventObserver: () => { traceEvents += 1; },
      }),
      (error) => error?.code === "DurableResumeUnsupportedState",
    );
    assert.equal(observerCalls, 0);
    assert.equal(traceEvents, 0);
    assert.equal(journal.entries.size, 0);
    assert.equal(readFileIfExists(callsPath), "");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses changed executable artifacts and revoked authority before a handler", async () => {
  const document = effectDocument();
  document.definitions.tools[0].required_capabilities = ["secret_read"];
  document.definitions.tools[0].required_secrets = ["API_TOKEN"];
  const manifest = effectManifest(successHandlerScript(), {
    grants: ["secret_read"],
    secrets: ["API_TOKEN"],
  });
  const journal = journalAdapter();
  let initialCheckpoint;
  await assert.rejects(() => executeAirDocument(document, {
    ...durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint }) => {
        initialCheckpoint = structuredClone(checkpoint);
        throw new Error("capture compatible authority");
      },
    }),
    secretStore: authoritySecretStore("active"),
  }), /capture compatible/u);

  const changed = structuredClone(document);
  changed.module.name = "changed-source";
  const incompatible = await executeAirDocument(changed, {
    ...durableOptions({ manifest, journal, observer: async () => {} }),
    secretStore: authoritySecretStore("active"),
    executionResumeCheckpoint: initialCheckpoint,
  });
  assert.equal(incompatible.status, "failure");
  assert.equal(failureCode(incompatible), "DurableResumeCheckpointIncompatible");

  const refused = await executeAirDocument(document, {
    ...durableOptions({ manifest, journal, observer: async () => {} }),
    secretStore: authoritySecretStore("revoked"),
    executionResumeCheckpoint: initialCheckpoint,
  });
  assert.equal(refused.status, "failure");
  assert.equal(failureCode(refused), "DurableResumeAuthorityRefused");
  assert.equal(journal.entries.size, 0);
});

test("keeps the terminal step reconstructible and preserves cumulative active time", async () => {
  const journal = journalAdapter();
  let readyTerminal;
  await assert.rejects(() => executeAirDocument(effectDocument({ maxRunMs: 2000 }), durableOptions({
    manifest: effectManifest(successHandlerScript(), { timeoutMs: 1000 }),
    journal,
    observer: async ({ checkpoint }) => {
      if (checkpoint.cursor.node_id === "give" && checkpoint.cursor.phase === "ready") {
        readyTerminal = structuredClone(checkpoint);
        throw new Error("simulated crash before terminal");
      }
    },
  })), /simulated crash/u);

  let terminalStarted;
  const reconstructed = await executeAirDocument(effectDocument({ maxRunMs: 2000 }), {
    ...durableOptions({
      manifest: effectManifest(successHandlerScript(), { timeoutMs: 1000 }),
      journal,
      observer: async ({ checkpoint }) => {
        terminalStarted = structuredClone(checkpoint);
      },
    }),
    executionResumeCheckpoint: readyTerminal,
  });
  assert.equal(reconstructed.status, "success");
  assert.equal(terminalStarted.cursor.node_id, "give");
  assert.equal(terminalStarted.cursor.phase, "started");
  assert.equal(terminalStarted.runtime_state.budget_counters.steps, 2);

  const refused = await executeAirDocument(effectDocument({ maxRunMs: 2000 }), {
    ...durableOptions({
      manifest: effectManifest(successHandlerScript(), { timeoutMs: 1000 }),
      journal,
      observer: async () => {},
    }),
    executionResumeCheckpoint: terminalStarted,
    runLimits: { max_run_ms: 1 },
  });
  assert.equal(refused.status, "failure");
  assert.equal(failureCode(refused), "RunTimeBudgetExceeded");
});

function durableOptions({ manifest, journal, observer }) {
  return {
    entryRef: "skill:test/CreateFlow",
    inputs: {},
    runId: "run:durable",
    operationId: "operation:durable",
    effectScopeId: "operation:durable",
    toolBindingManifest: manifest,
    effectJournal: journal.adapter,
    executionCheckpointObserver: observer,
  };
}

function effectManifest(script, {
  timeoutMs = 1000,
  kind = "external_write",
  grants = [],
  secrets = [],
} = {}) {
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:test/Create": {
        handler: { kind: "process", command: process.execPath, args: ["-e", script] },
        grants,
        secrets,
        timeout_ms: timeoutMs,
        max_payload_bytes: 16384,
        effect_contract: kind === "none"
          ? { kind: "none" }
          : { kind: "external_write", retry_mode: "idempotency_key" },
      },
    },
  }));
}

function emptyEffectManifest() {
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {},
  }));
}

function journalAdapter({ throwAfterState = null } = {}) {
  const entries = new Map();
  let failureState = throwAfterState;
  let failed = false;
  return {
    entries,
    disableFailure: () => { failureState = null; },
    adapter: {
      schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
      readEntry: (effectId) => entries.has(effectId) ? structuredClone(entries.get(effectId)) : null,
      entriesForScope: (effectScopeId) => [...entries.values()]
        .filter((entry) => entry.effect_scope_id === effectScopeId)
        .map((entry) => structuredClone(entry)),
      writeEntry: (entry) => {
        entries.set(entry.effect_id, structuredClone(entry));
        if (!failed && entry.state === failureState) {
          failed = true;
          throw new Error(`simulated journal crash after ${entry.state}`);
        }
      },
    },
  };
}

async function captureInitialCheckpoint(document, manifest) {
  const journal = journalAdapter();
  let checkpoint;
  await assert.rejects(() => executeAirDocument(document, durableOptions({
    manifest,
    journal,
    observer: async ({ checkpoint: observed }) => {
      checkpoint = structuredClone(observed);
      throw new Error("capture initial durable checkpoint");
    },
  })), /capture initial durable/u);
  return checkpoint;
}

async function captureReservedCheckpoint(document, manifest) {
  const journal = journalAdapter();
  let checkpoint;
  await assert.rejects(() => executeAirDocument(document, durableOptions({
    manifest,
    journal,
    observer: async ({ checkpoint: observed }) => {
      if (observed.pending_dispatch?.phase !== "reserved") return;
      checkpoint = structuredClone(observed);
      throw new Error("capture reserved durable checkpoint");
    },
  })), /capture reserved durable/u);
  return checkpoint;
}

async function captureRetryReservedCheckpoint(document, manifest) {
  const journal = journalAdapter();
  let dispatchedCheckpoint;
  await assert.rejects(() => executeAirDocument(document, durableOptions({
    manifest,
    journal,
    observer: async ({ checkpoint }) => {
      if (checkpoint.pending_dispatch?.phase !== "dispatched") return;
      dispatchedCheckpoint = structuredClone(checkpoint);
      throw new Error("capture dispatched durable checkpoint");
    },
  })), /capture dispatched durable/u);

  let checkpoint;
  await assert.rejects(() => executeAirDocument(document, {
    ...durableOptions({
      manifest,
      journal,
      observer: async ({ checkpoint: observed }) => {
        if (
          observed.pending_dispatch?.phase !== "reserved"
          || observed.pending_dispatch.attempt_index !== 2
        ) return;
        checkpoint = structuredClone(observed);
        throw new Error("capture retry reservation");
      },
    }),
    executionResumeCheckpoint: dispatchedCheckpoint,
  }), /capture retry reservation/u);
  return { checkpoint, journal };
}

function seedJournalEntry(journal, document, {
  effectIndex,
  callIndex,
  state = "unknown",
  result = undefined,
}) {
  const airDigest = airDocumentDigest(document);
  const effectId = deriveEffectId({
    effectScopeId: "operation:durable",
    airDigest,
    entryRef: "skill:test/CreateFlow",
    effectIndex,
  });
  const requestDigest = deriveEffectRequestDigest({
    airDigest,
    toolRef: "tool:test/Create",
    arguments: { query: "same" },
    resourceBindings: [],
  });
  journal.entries.set(effectId, {
    effect_id: effectId,
    effect_scope_id: "operation:durable",
    air_digest: airDigest,
    entry_ref: "skill:test/CreateFlow",
    effect_index: effectIndex,
    request_digest: requestDigest,
    tool_ref: "tool:test/Create",
    retry_mode: "idempotency_key",
    state,
    attempt_count: 1,
    last_call_id: `call:run:durable:${callIndex}`,
    ...(state === "applied" ? {
      receipt: {
        effect_id: effectId,
        request_digest: requestDigest,
        outcome: "applied",
      },
      result,
    } : {}),
  });
  return effectId;
}

function successHandlerScript(callsPath = null) {
  return `
    const fs = require("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      ${callsPath ? `fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(request) + "\\n");` : ""}
      process.stdout.write(JSON.stringify({
        ok: true,
        value: \`created:\${request.arguments.query}\`,
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "applied"
        }
      }));
    });
  `;
}

function noneHandlerScript(callsPath) {
  return `
    const fs = require("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(request) + "\\n");
      process.stdout.write(JSON.stringify({ ok: true, value: \`created:\${request.arguments.query}\` }));
    });
  `;
}

function effectDocument({ maxRunMs = null } = {}) {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: { id: "module:test", name: "test", source_ref: sourceRef() },
    ...(maxRunMs === null ? {} : {
      budgets: { run: { max_run_ms: { value: maxRunMs, source_ref: sourceRef() } } },
    }),
    definitions: {
      types: [],
      constants: [],
      functions: [],
      tools: [{
        id: "tool:test/Create",
        name: "Create",
        description: "Create a resource.",
        signature: {
          inputs: [{ name: "query", type_ref: "builtin:Text", source_ref: sourceRef() }],
          output_type: "builtin:Text",
        },
        source_ref: sourceRef(),
      }],
      memories: [],
      skills: [{
        id: "skill:test/CreateFlow",
        name: "CreateFlow",
        description: "Create a resource.",
        signature: {
          inputs: [],
          output_type: "builtin:Text",
        },
        uses: ["tool:test/Create"],
        flow_graph_ref: "graph:skill:test/CreateFlow",
        source_ref: sourceRef(),
      }],
      agents: [],
      strategies: [],
      triggers: [],
    },
    execution_graphs: [{
      id: "graph:skill:test/CreateFlow",
      owner_ref: "skill:test/CreateFlow",
      entry_node_id: "call",
      nodes: [
        {
          id: "call",
          kind: "call_tool",
          target_ref: "tool:test/Create",
          arguments: ["literal:string:same"],
          result_binding: "created",
          trace_point_refs: [],
          source_ref: sourceRef(),
        },
        {
          id: "give",
          kind: "give",
          arguments: ["value:created"],
          trace_point_refs: [],
          source_ref: sourceRef(),
        },
      ],
      edges: [{ from_node_id: "call", to_node_id: "give", role: "next" }],
      expressions: [],
      failure_paths: [],
      failure_path_refs: [],
      source_ref: sourceRef(),
    }],
    trace_points: [],
  };
}

function humanDocument() {
  const document = effectDocument();
  document.definitions.tools = [];
  document.definitions.skills[0] = {
    ...document.definitions.skills[0],
    id: "skill:test/ApproveFlow",
    name: "ApproveFlow",
    signature: { inputs: [], output_type: "builtin:Text" },
    uses: [],
    flow_graph_ref: "graph:skill:test/ApproveFlow",
  };
  document.execution_graphs[0] = {
    ...document.execution_graphs[0],
    id: "graph:skill:test/ApproveFlow",
    owner_ref: "skill:test/ApproveFlow",
    entry_node_id: "approve",
    nodes: [
      {
        id: "approve",
        kind: "human_approval",
        approval_ref: "approval:test",
        approval_mode: "required_approval",
        context_refs: [],
        result_binding: "decision",
        trace_point_refs: [],
        source_ref: sourceRef(),
      },
      {
        id: "give",
        kind: "give",
        arguments: ["value:decision"],
        trace_point_refs: [],
        source_ref: sourceRef(),
      },
    ],
    edges: [{ from_node_id: "approve", to_node_id: "give", role: "next" }],
  };
  return document;
}

function bindStopDocument() {
  const document = effectDocument();
  document.definitions.tools = [];
  document.definitions.skills[0] = {
    ...document.definitions.skills[0],
    uses: [],
  };
  document.execution_graphs[0] = {
    ...document.execution_graphs[0],
    entry_node_id: "bind",
    nodes: [
      {
        id: "bind",
        kind: "bind",
        arguments: ["literal:string:kept"],
        result_binding: "bound",
        trace_point_refs: [],
        source_ref: sourceRef(),
      },
      {
        id: "stop",
        kind: "stop",
        arguments: [],
        trace_point_refs: [],
        source_ref: sourceRef(),
      },
    ],
    edges: [{ from_node_id: "bind", to_node_id: "stop", role: "next" }],
  };
  return document;
}

function twoEffectDocument() {
  const document = effectDocument();
  document.execution_graphs[0] = {
    ...document.execution_graphs[0],
    entry_node_id: "call_a",
    nodes: [
      {
        id: "call_a",
        kind: "call_tool",
        target_ref: "tool:test/Create",
        arguments: ["literal:string:first"],
        result_binding: "created_a",
        trace_point_refs: [],
        source_ref: sourceRef(),
      },
      {
        id: "call_b",
        kind: "call_tool",
        target_ref: "tool:test/Create",
        arguments: ["literal:string:second"],
        result_binding: "created_b",
        trace_point_refs: [],
        source_ref: sourceRef(),
      },
      {
        id: "give",
        kind: "give",
        arguments: ["value:created_b"],
        trace_point_refs: [],
        source_ref: sourceRef(),
      },
    ],
    edges: [
      { from_node_id: "call_a", to_node_id: "call_b", role: "next" },
      { from_node_id: "call_b", to_node_id: "give", role: "next" },
    ],
  };
  return document;
}

function sourceRef() {
  return {
    source_id: "durable-resume-test.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}

function testSecretStore(secretValue) {
  return loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: { UNUSED_SECRET: { source: "env", name: "UNUSED_SECRET" } },
  }), { env: { UNUSED_SECRET: secretValue } });
}

function authoritySecretStore(status) {
  return loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      API_TOKEN: { source: "env", name: "API_TOKEN", status },
    },
  }), { env: { API_TOKEN: "rotated-current-credential" } });
}

function expiringSecretStore(secretValue, expiresAt) {
  return loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      API_TOKEN: {
        source: "env",
        name: "API_TOKEN",
        status: "active",
        expires_at: expiresAt,
      },
    },
  }), { env: { API_TOKEN: secretValue } });
}

function readJsonLines(path) {
  return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
}

function readFileIfExists(path) {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

function failureCode(result) {
  return result.trace.events.findLast((event) => event.kind === "failure_detected")
    ?.payload?.runtime_error_code;
}

function resealCheckpoint(checkpoint) {
  delete checkpoint.checkpoint_digest;
  checkpoint.checkpoint_digest = canonicalDigest(checkpoint);
  return checkpoint;
}
