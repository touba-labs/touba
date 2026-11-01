import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
  EFFECT_JOURNAL_SCHEMA_VERSION,
  executeAirDocument,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
} from "../src/index.mjs";

test("requires a stable scope and host journal before spawning an external write", async () => {
  const manifest = effectManifest(successHandlerScript());
  const withoutScope = await executeAirDocument(effectDocument(), {
    entryRef: "skill:test/CreateFlow",
    inputs: { query: "one" },
    toolBindingManifest: manifest,
    effectJournal: journalAdapter().adapter,
  });
  assert.equal(withoutScope.status, "failure");
  assert.equal(failureCode(withoutScope), "EffectContextRequired");

  const withoutJournal = await executeAirDocument(effectDocument(), {
    entryRef: "skill:test/CreateFlow",
    inputs: { query: "one" },
    toolBindingManifest: manifest,
    effectScopeId: "operation:test-1",
  });
  assert.equal(withoutJournal.status, "failure");
  assert.equal(failureCode(withoutJournal), "EffectJournalRequired");
});

test("canonical manifest requires an explicit effect contract and refuses old formats", () => {
  const binding = {
    handler: { kind: "process", command: "node", args: ["handler.mjs"] },
    grants: [], timeout_ms: 1000, max_payload_bytes: 4096,
  };
  const load = (version, effect_contract) => loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: version,
    bindings: { "tool:test/Create": { ...binding, ...(effect_contract === undefined ? {} : { effect_contract }) } },
  }));
  assert.deepEqual(load("touba-manifest-v1", { kind: "none" }).bindings.get("tool:test/Create").effectContract, { kind: "none" });
  for (const contract of [undefined, null, { kind: "none", retry_mode: "none" }, { kind: "external_write", retry_mode: "unsafe" }]) {
    assert.throws(() => load("touba-manifest-v1", contract), { code: contract === null ? "ToolBindingReviewRequired" : "InvalidToolBindingManifest" });
  }
  for (const version of ["touba-manifest-v2", "touba-manifest-v3", "forged"]) {
    assert.throws(() => load(version, { kind: "none" }), { code: "InvalidToolBindingManifest" });
  }
});

test("persists an applied result and serves its replay without redispatch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-applied-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    const manifest = effectManifest(successHandlerScript(callsPath));
    const options = {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: manifest,
      effectScopeId: "queue:stable-applied",
      effectJournal: journal.adapter,
    };

    const first = await executeAirDocument(effectDocument(), { ...options, runId: "run:first" });
    const replay = await executeAirDocument(effectDocument(), { ...options, runId: "run:replay" });

    assert.equal(first.status, "success");
    assert.equal(replay.status, "success");
    assert.equal(first.result, "created:same");
    assert.equal(replay.result, first.result);
    assert.ok(replay.trace.events.some(event => event.kind === "tool_execution_status" && event.payload.phase === "journal_restore"));
    assert.equal(replay.trace.events.some(event => event.kind === "tool_execution_status" && event.payload.phase === "dispatch"), false);
    assert.equal(readFileSync(callsPath, "utf8"), "called\n");
    const [entry] = [...journal.entries.values()];
    assert.equal(entry.state, "applied");
    assert.equal(entry.attempt_count, 1);
    assert.equal(entry.effect_index, 1);
    assert.equal(entry.result, "created:same");
    assert.deepEqual(journal.transitions.slice(0, 3), ["prepared", "dispatched", "applied"]);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("identical arguments in two intentional invocations create distinct effects; replay creates neither again", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-two-intentional-effects-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    const document = effectDocument();
    const graph = document.execution_graphs[0];
    graph.nodes.splice(1, 0, { ...structuredClone(graph.nodes[0]), id: "second-call", result_binding: "second-created" });
    graph.edges = [{ from_node_id: "call", to_node_id: "second-call", role: "next" }, { from_node_id: "second-call", to_node_id: "give", role: "next" }];
    const options = { entryRef: "skill:test/CreateFlow", inputs: { query: "same" },
      toolBindingManifest: effectManifest(successHandlerScript(callsPath)),
      effectScopeId: "operation:two-intentional-writes", effectJournal: journal.adapter };
    const first = await executeAirDocument(document, options);
    assert.equal(first.status, "success", failureCode(first));
    const entries = [...journal.entries.values()];
    assert.equal(entries.length, 2);
    assert.notEqual(entries[0].effect_id, entries[1].effect_id);
    assert.deepEqual(entries.map((item) => item.effect_index), [1, 2]);
    assert.deepEqual(entries.map((item) => item.attempt_count), [1, 1]);
    assert.equal(readFileSync(callsPath, "utf8"), "called\ncalled\n");
    const replay = await executeAirDocument(document, options);
    assert.equal(replay.status, "success", failureCode(replay));
    assert.equal(readFileSync(callsPath, "utf8"), "called\ncalled\n");
  } finally { rmSync(workspace, { recursive: true, force: true }); }
});

test("refuses the same effect identity with divergent request content before spawn", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-conflict-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    const manifest = effectManifest(successHandlerScript(callsPath));
    const base = {
      entryRef: "skill:test/CreateFlow",
      toolBindingManifest: manifest,
      effectScopeId: "queue:stable-conflict",
      effectJournal: journal.adapter,
    };
    const first = await executeAirDocument(effectDocument(), {
      ...base,
      inputs: { query: "one" },
      runId: "run:one",
    });
    const conflict = await executeAirDocument(effectDocument(), {
      ...base,
      inputs: { query: "different" },
      runId: "run:two",
    });

    assert.equal(first.status, "success");
    assert.equal(conflict.status, "failure");
    assert.equal(failureCode(conflict), "EffectRequestConflict");
    assert.equal(readFileSync(callsPath, "utf8"), "called\n");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("records unknown when a dispatched V2 handler omits or corrupts its receipt", async () => {
  for (const script of [missingReceiptHandlerScript(), divergentReceiptHandlerScript()]) {
    const journal = journalAdapter();
    const result = await executeAirDocument(effectDocument(), {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: effectManifest(script),
      effectScopeId: `operation:invalid-receipt-${journal.transitions.length}-${script.length}`,
      effectJournal: journal.adapter,
    });

    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "EffectReceiptInvalid");
    const [entry] = [...journal.entries.values()];
    assert.equal(entry.state, "unknown");
    assert.equal(Object.hasOwn(entry, "receipt"), false);
  }
});

test("preserves an acquired effect receipt but never persists or retries its secret-bearing result", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-effect-result-secret-"));
  try {
    const callsPath = join(root, "calls.txt");
    const sentinel = "synthetic-effect-result-secret";
    const journal = journalAdapter();
    const options = {
      entryRef: "skill:test/CreateFlow", inputs: { query: "one" },
      toolBindingManifest: effectManifest(successHandlerScript(callsPath, { valueExpression: JSON.stringify(sentinel) })),
      effectScopeId: "operation:secret-result", effectJournal: journal.adapter,
      secretStore: testSecretStore(sentinel),
    };
    const result = await executeAirDocument(effectDocument(), options);
    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), "SecretValueInEffectArtifact");
    const entry = [...journal.entries.values()][0];
    assert.equal(entry.state, "applied");
    assert.equal(entry.receipt.outcome, "applied");
    assert.equal(Object.hasOwn(entry, "result"), false);
    assert.equal(JSON.stringify({ result, snapshots: journal.snapshots }).includes(sentinel), false);
    const repeated = await executeAirDocument(effectDocument(), options);
    assert.equal(failureCode(repeated), "EffectResultUnavailable");
    assert.equal(readFileSync(callsPath, "utf8"), "called\n");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("refuses a secret-bearing call_id and an overflowing attempt counter before dispatch", async () => {
  const secretJournal = journalAdapter();
  const secretValue = "resolved-run-secret-value";
  const secretRun = await executeAirDocument(effectDocument(), {
    entryRef: "skill:test/CreateFlow",
    inputs: { query: "same" },
    runId: `run:${secretValue}`,
    toolBindingManifest: effectManifest(successHandlerScript()),
    effectScopeId: "operation:safe-scope",
    effectJournal: secretJournal.adapter,
    secretStore: loadSecretsFromJson(JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        RUN_ID_SECRET: { source: "env", name: "RUN_ID_SECRET" },
      },
    }), { env: { RUN_ID_SECRET: secretValue } }),
  });
  assert.equal(secretRun.status, "failure");
  assert.equal(failureCode(secretRun), "SecretValueInEffectArtifact");
  assert.deepEqual(secretJournal.transitions, ["prepared"]);
  assert.equal(JSON.stringify([...secretJournal.entries.values()]).includes(secretValue), false);

  const overflowJournal = journalAdapter();
  const options = {
    entryRef: "skill:test/CreateFlow",
    inputs: { query: "same" },
    toolBindingManifest: effectManifest(successHandlerScript()),
    effectScopeId: "operation:attempt-overflow",
    effectJournal: overflowJournal.adapter,
  };
  const applied = await executeAirDocument(effectDocument(), { ...options, runId: "run:initial" });
  assert.equal(applied.status, "success");
  const [effectId, entry] = [...overflowJournal.entries.entries()][0];
  overflowJournal.entries.set(effectId, {
    ...entry,
    state: "not_applied",
    attempt_count: Number.MAX_SAFE_INTEGER,
    receipt: {
      effect_id: entry.effect_id,
      request_digest: entry.request_digest,
      outcome: "not_applied",
    },
  });
  delete overflowJournal.entries.get(effectId).result;
  const writesBeforeOverflow = overflowJournal.transitions.length;
  const overflow = await executeAirDocument(effectDocument(), { ...options, runId: "run:overflow" });
  assert.equal(overflow.status, "failure");
  assert.equal(failureCode(overflow), "EffectOutcomeUnknown");
  assert.equal(overflowJournal.transitions.length, writesBeforeOverflow);
});

for (const [retryMode, expectedSecondCode] of [
  ["reconcile", "EffectReconciliationRequired"],
  ["none", "EffectOutcomeUnknown"],
]) {
  test(`blocks an unknown ${retryMode} effect without redispatch`, async () => {
    const workspace = mkdtempSync(join(tmpdir(), `touba-effect-${retryMode}-`));
    try {
      const callsPath = join(workspace, "calls.log");
      const journal = journalAdapter();
      const manifest = effectManifest(timeoutHandlerScript(callsPath), {
        retryMode,
        // Include process startup under concurrent CI load; the handler stays
        // alive indefinitely after recording dispatch, so this still proves
        // a real timeout and the absence of a second external dispatch.
        timeoutMs: 2000,
      });
      const options = {
        entryRef: "skill:test/CreateFlow",
        inputs: { query: "same" },
        toolBindingManifest: manifest,
        effectScopeId: `queue:stable-${retryMode}`,
        effectJournal: journal.adapter,
      };

      const timedOut = await executeAirDocument(effectDocument(), { ...options, runId: "run:timeout" });
      const blocked = await executeAirDocument(effectDocument(), { ...options, runId: "run:blocked" });

      assert.equal(timedOut.status, "failure");
      assert.equal(failureCode(timedOut), "ToolHandlerTimeout");
      assert.equal(blocked.status, "failure");
      assert.equal(failureCode(blocked), expectedSecondCode);
      assert.equal(readFileSync(callsPath, "utf8"), "called\n");
      const [entry] = [...journal.entries.values()];
      assert.equal(entry.state, "unknown");
      assert.equal(entry.attempt_count, 1);
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }
  });
}

test("retries an unknown idempotency_key effect with one identity and a new attempt", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-idempotent-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    const manifest = effectManifest(timeoutThenSuccessHandlerScript(callsPath), {
      retryMode: "idempotency_key",
      timeoutMs: 2000,
    });
    const options = {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: manifest,
      effectScopeId: "queue:stable-idempotent",
      effectJournal: journal.adapter,
    };

    const first = await executeAirDocument(effectDocument(), { ...options, runId: "run:attempt-1" });
    const second = await executeAirDocument(effectDocument(), { ...options, runId: "run:attempt-2" });

    assert.equal(first.status, "failure");
    assert.equal(failureCode(first), "ToolHandlerTimeout");
    assert.equal(second.status, "success");
    assert.equal(second.result, "created:same");
    assert.equal(readFileSync(callsPath, "utf8"), "called\ncalled\n");
    const [entry] = [...journal.entries.values()];
    assert.equal(entry.state, "applied");
    assert.equal(entry.attempt_count, 2);
    const dispatched = journal.snapshots.filter((entry) => entry.state === "dispatched");
    assert.equal(dispatched.length, 2);
    assert.equal(dispatched[0].effect_id, dispatched[1].effect_id);
    assert.notEqual(dispatched[0].last_call_id, dispatched[1].last_call_id);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("retries a proven not_applied effect with one identity, a new attempt, and bounded dispatch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-not-applied-"));
  try {
    const callsPath = join(workspace, "calls.jsonl");
    const journal = journalAdapter();
    const options = {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: effectManifest(notAppliedThenSuccessHandlerScript(callsPath)),
      effectScopeId: "queue:stable-not-applied",
      effectJournal: journal.adapter,
    };

    const notApplied = await executeAirDocument(effectDocument(), {
      ...options,
      runId: "run:not-applied",
    });
    const applied = await executeAirDocument(effectDocument(), {
      ...options,
      runId: "run:applied",
    });
    const replay = await executeAirDocument(effectDocument(), {
      ...options,
      runId: "run:replay",
    });

    assert.equal(notApplied.status, "failure");
    assert.equal(failureCode(notApplied), "EffectNotApplied");
    assert.equal(applied.status, "success");
    assert.equal(applied.result, "created:same");
    assert.equal(replay.status, "success");
    assert.equal(replay.result, applied.result);

    const calls = readJsonLines(callsPath);
    assert.equal(calls.length, 2);
    assert.equal(calls[0].effect_id, calls[1].effect_id);
    assert.equal(calls[0].request_digest, calls[1].request_digest);
    assert.deepEqual(calls.map((call) => call.attempt_index), [1, 2]);
    assert.deepEqual(journal.transitions, [
      "prepared",
      "dispatched",
      "not_applied",
      "prepared",
      "dispatched",
      "applied",
    ]);
    const [entry] = [...journal.entries.values()];
    assert.equal(entry.state, "applied");
    assert.equal(entry.attempt_count, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reloads a persisted prepared effect and dispatches it exactly once", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-reload-prepared-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const crashed = crashAfterPersistingStateJournal("prepared");
    const base = {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: effectManifest(successHandlerScript(callsPath)),
      effectScopeId: "queue:reload-prepared",
    };

    const interrupted = await executeAirDocument(effectDocument(), {
      ...base,
      runId: "run:before-prepared-reload",
      effectJournal: crashed.adapter,
    });
    assert.equal(interrupted.status, "failure");
    assert.equal(failureCode(interrupted), "EffectJournalWriteFailed");
    assert.equal(existsSync(callsPath), false);
    const [prepared] = [...crashed.entries.values()];
    assert.equal(prepared.state, "prepared");
    assert.equal(prepared.attempt_count, 0);

    const reloaded = journalAdapter({ initialEntries: crashed.entries });
    const resumed = await executeAirDocument(effectDocument(), {
      ...base,
      runId: "run:after-prepared-reload",
      effectJournal: reloaded.adapter,
    });

    assert.equal(resumed.status, "success");
    assert.equal(resumed.result, "created:same");
    assert.equal(readFileSync(callsPath, "utf8"), "called\n");
    assert.deepEqual(reloaded.transitions, ["prepared", "dispatched", "applied"]);
    const [applied] = [...reloaded.entries.values()];
    assert.equal(applied.effect_id, prepared.effect_id);
    assert.equal(applied.state, "applied");
    assert.equal(applied.attempt_count, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("reloads an applied effect after the durable write and restores it without redispatch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-reload-applied-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const crashed = crashAfterPersistingStateJournal("applied");
    const base = {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: effectManifest(successHandlerScript(callsPath)),
      effectScopeId: "queue:reload-applied",
    };

    const interrupted = await executeAirDocument(effectDocument(), {
      ...base,
      runId: "run:before-applied-reload",
      effectJournal: crashed.adapter,
    });
    assert.equal(interrupted.status, "failure");
    assert.equal(failureCode(interrupted), "EffectJournalWriteFailed");
    assert.equal(readFileSync(callsPath, "utf8"), "called\n");
    const [persisted] = [...crashed.entries.values()];
    assert.equal(persisted.state, "applied");
    assert.equal(persisted.result, "created:same");

    const reloaded = journalAdapter({ initialEntries: crashed.entries });
    const resumed = await executeAirDocument(effectDocument(), {
      ...base,
      runId: "run:after-applied-reload",
      effectJournal: reloaded.adapter,
    });

    assert.equal(resumed.status, "success");
    assert.equal(resumed.result, "created:same");
    assert.equal(readFileSync(callsPath, "utf8"), "called\n");
    assert.deepEqual(reloaded.transitions, []);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("rejects a secret-bearing receipt without leaking it to the journal or trace", async () => {
  const secretValue = "private-\"effect\"\nreceipt\\token-0849";
  const journal = journalAdapter();
  const result = await executeAirDocument(effectDocument(), {
    entryRef: "skill:test/CreateFlow",
    inputs: { query: "same" },
    toolBindingManifest: effectManifest(secretReceiptHandlerScript(secretValue)),
    effectScopeId: "queue:secret-receipt",
    effectJournal: journal.adapter,
    secretStore: testSecretStore(secretValue),
  });

  assert.equal(result.status, "failure");
  assert.equal(failureCode(result), "EffectReceiptInvalid");
  const [entry] = [...journal.entries.values()];
  assert.equal(entry.state, "unknown");
  assert.equal(Object.hasOwn(entry, "receipt"), false);
  assert.equal(JSON.stringify(entry).includes(secretValue), false);
  assert.equal(JSON.stringify(journal.snapshots).includes(secretValue), false);
  assert.equal(JSON.stringify(result.trace).includes(secretValue), false);
});

test("rejects a secret-bearing unknown receipt field without leaking its name", async () => {
  const secretValue = "private-\"unknown-field\"\nreceipt\\token-never-disclose";
  const journal = journalAdapter();
  const result = await executeAirDocument(effectDocument(), {
    entryRef: "skill:test/CreateFlow",
    inputs: { query: "same" },
    toolBindingManifest: effectManifest(unknownReceiptFieldHandlerScript(secretValue)),
    effectScopeId: "queue:secret-receipt-field",
    effectJournal: journal.adapter,
    secretStore: testSecretStore(secretValue),
  });

  assert.equal(result.status, "failure");
  assert.equal(failureCode(result), "EffectReceiptInvalid");
  const [entry] = [...journal.entries.values()];
  assert.equal(entry.state, "unknown");
  assert.equal(JSON.stringify(journal.snapshots).includes(secretValue), false);
  assert.equal(JSON.stringify(result.trace).includes(secretValue), false);
});

test("does not echo secrets from invalid JSON or handler error codes into traces or journal", async () => {
  const secretValue = "private-\"handler-diagnostic\"\nwith\\escapes";
  for (const [label, script, expectedCode, expectedState] of [
    ["invalid-json", invalidJsonHandlerScript(secretValue), "ToolHandlerInvalidJson", "unknown"],
    ["error-code", secretErrorCodeHandlerScript(secretValue), "ToolHandlerReportedError", "not_applied"],
  ]) {
    const journal = journalAdapter();
    const result = await executeAirDocument(effectDocument(), {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: effectManifest(script),
      effectScopeId: `queue:secret-handler-diagnostic-${label}`,
      effectJournal: journal.adapter,
      secretStore: testSecretStore(secretValue),
    });

    assert.equal(result.status, "failure");
    assert.equal(failureCode(result), expectedCode);
    const [entry] = [...journal.entries.values()];
    assert.equal(entry.state, expectedState);
    assert.equal(JSON.stringify(journal.snapshots).includes(secretValue), false);
    assert.equal(JSON.stringify(result.trace).includes(secretValue), false);
  }
});

test("does not echo journal adapter read or write failures into traces or stored entries", async () => {
  const sensitiveMessage = "journal-adapter-\"secret\"\nwith\\escapes-never-disclose";
  for (const failurePoint of ["read", "write"]) {
    const snapshots = [];
    const adapter = {
      schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
      readEntry: () => {
        if (failurePoint === "read") throw new Error(sensitiveMessage);
        return null;
      },
      writeEntry: (entry) => {
        snapshots.push(structuredClone(entry));
        if (failurePoint === "write") {
          throw new Error(sensitiveMessage);
        }
      },
    };
    const result = await executeAirDocument(effectDocument(), {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: effectManifest(successHandlerScript()),
      effectScopeId: `queue:adapter-failure-${failurePoint}`,
      effectJournal: adapter,
      secretStore: testSecretStore(sensitiveMessage),
    });

    assert.equal(result.status, "failure");
    assert.equal(
      failureCode(result),
      failurePoint === "read" ? "EffectJournalReadFailed" : "EffectJournalWriteFailed",
    );
    assert.equal(JSON.stringify(result.trace).includes(sensitiveMessage), false);
    assert.equal(JSON.stringify(snapshots).includes(sensitiveMessage), false);
  }
});

test("keeps applied without result when output validation fails and never redispatches", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-effect-invalid-result-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const journal = journalAdapter();
    const manifest = effectManifest(successHandlerScript(callsPath, {
      valueExpression: "{ unexpected: true }",
    }));
    const options = {
      entryRef: "skill:test/CreateFlow",
      inputs: { query: "same" },
      toolBindingManifest: manifest,
      effectScopeId: "queue:invalid-result",
      effectJournal: journal.adapter,
    };

    const invalid = await executeAirDocument(effectDocument(), { ...options, runId: "run:invalid" });
    const replay = await executeAirDocument(effectDocument(), { ...options, runId: "run:replay" });

    assert.equal(invalid.status, "failure");
    assert.ok(invalid.trace.events.some(event => event.kind === "tool_execution_status" && event.payload.phase === "post_validation" && event.payload.status === "refused"));
    assert.equal(replay.status, "failure");
    assert.equal(failureCode(replay), "EffectResultUnavailable");
    assert.equal(readFileSync(callsPath, "utf8"), "called\n");
    const [entry] = [...journal.entries.values()];
    assert.equal(entry.state, "applied");
    assert.equal(Object.hasOwn(entry, "result"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses an in-process override for external_write but keeps kind none on V1 protocol", async () => {
  let inProcessCalled = false;
  const journal = journalAdapter();
  const refused = await executeAirDocument(effectDocument(), {
    entryRef: "skill:test/CreateFlow",
    inputs: { query: "same" },
    toolBindingManifest: effectManifest(successHandlerScript()),
    effectScopeId: "operation:override",
    effectJournal: journal.adapter,
    toolHandlers: {
      "tool:test/Create": async () => {
        inProcessCalled = true;
        return "bypassed";
      },
    },
  });
  assert.equal(refused.status, "failure");
  assert.equal(failureCode(refused), "EffectContextRequired");
  assert.equal(inProcessCalled, false);

  const none = await executeAirDocument(effectDocument(), {
    entryRef: "skill:test/CreateFlow",
    inputs: { query: "same" },
    toolBindingManifest: effectManifest(protocolEchoHandlerScript(), { kind: "none" }),
  });
  assert.equal(none.status, "success");
  assert.equal(none.result, "touba-tool-handler-v1");
});

function effectManifest(script, {
  kind = "external_write",
  retryMode = "idempotency_key",
  timeoutMs = 1000,
} = {}) {
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:test/Create": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: ["-e", script],
        },
        grants: [],
        secrets: [],
        timeout_ms: timeoutMs,
        max_payload_bytes: 16384,
        effect_contract: kind === "none"
          ? { kind: "none" }
          : { kind: "external_write", retry_mode: retryMode },
      },
    },
  }));
}

function journalAdapter({ initialEntries = [] } = {}) {
  const entries = new Map(
    [...initialEntries].map(([effectId, entry]) => [effectId, structuredClone(entry)]),
  );
  const transitions = [];
  const snapshots = [];
  return {
    entries,
    transitions,
    snapshots,
    adapter: {
      schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
      readEntry: (effectId) => entries.has(effectId)
        ? structuredClone(entries.get(effectId))
        : null,
      writeEntry: (entry) => {
        const snapshot = structuredClone(entry);
        entries.set(entry.effect_id, snapshot);
        transitions.push(entry.state);
        snapshots.push(snapshot);
      },
    },
  };
}

function crashAfterPersistingStateJournal(crashState) {
  const entries = new Map();
  let crashed = false;
  return {
    entries,
    adapter: {
      schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
      readEntry: (effectId) => entries.has(effectId)
        ? structuredClone(entries.get(effectId))
        : null,
      writeEntry: (entry) => {
        entries.set(entry.effect_id, structuredClone(entry));
        if (!crashed && entry.state === crashState) {
          crashed = true;
          throw new Error(`simulated crash after persisting ${crashState}`);
        }
      },
    },
  };
}

function successHandlerScript(callsPath = null, { valueExpression = "`created:${request.arguments.query}`" } = {}) {
  return `
    const fs = require("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      ${callsPath ? `fs.appendFileSync(${JSON.stringify(callsPath)}, "called\\n");` : ""}
      process.stdout.write(JSON.stringify({
        ok: true,
        value: ${valueExpression},
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "applied",
          receipt_ref: "opaque:test:created"
        }
      }));
    });
  `;
}

function timeoutHandlerScript(callsPath) {
  return `
    const fs = require("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      JSON.parse(input);
      fs.appendFileSync(${JSON.stringify(callsPath)}, "called\\n");
      setInterval(() => {}, 1000);
    });
  `;
}

function timeoutThenSuccessHandlerScript(callsPath) {
  return `
    const fs = require("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      let count = 0;
      try { count = fs.readFileSync(${JSON.stringify(callsPath)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
      fs.appendFileSync(${JSON.stringify(callsPath)}, "called\\n");
      if (count === 0) {
        setInterval(() => {}, 1000);
        return;
      }
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

function notAppliedThenSuccessHandlerScript(callsPath) {
  return `
    const fs = require("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      let count = 0;
      try { count = fs.readFileSync(${JSON.stringify(callsPath)}, "utf8").trim().split("\\n").filter(Boolean).length; } catch {}
      fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(request.effect) + "\\n");
      const applied = count > 0;
      process.stdout.write(JSON.stringify({
        ok: true,
        value: applied ? \`created:\${request.arguments.query}\` : "not-created",
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: applied ? "applied" : "not_applied"
        }
      }));
    });
  `;
}

function secretReceiptHandlerScript(secretValue) {
  return `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        ok: true,
        value: "created",
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "applied",
          receipt_ref: ${JSON.stringify(`opaque:${secretValue}`)}
        }
      }));
    });
  `;
}

function unknownReceiptFieldHandlerScript(secretField) {
  return `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      const receipt = {
        effect_id: request.effect.effect_id,
        request_digest: request.effect.request_digest,
        outcome: "applied"
      };
      receipt[${JSON.stringify(secretField)}] = true;
      process.stdout.write(JSON.stringify({
        ok: true,
        value: "created",
        effect_receipt: receipt
      }));
    });
  `;
}

function invalidJsonHandlerScript(secretValue) {
  const malformed = `{"leak":${JSON.stringify(secretValue)}`;
  return `
    process.stdin.resume();
    process.stdin.on("end", () => {
      process.stdout.write(${JSON.stringify(malformed)});
    });
  `;
}

function secretErrorCodeHandlerScript(secretValue) {
  return `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        ok: false,
        error: { code: ${JSON.stringify(secretValue)}, message: "rejected" },
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "not_applied"
        }
      }));
    });
  `;
}

function testSecretStore(secretValue) {
  return loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      EFFECT_TEST_SECRET: { source: "env", name: "EFFECT_TEST_SECRET" },
    },
  }), { env: { EFFECT_TEST_SECRET: secretValue } });
}

function readJsonLines(path) {
  return readFileSync(path, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function protocolEchoHandlerScript() {
  return `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({ ok: true, value: request.protocol }));
    });
  `;
}

function missingReceiptHandlerScript() {
  return `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      JSON.parse(input);
      process.stdout.write(JSON.stringify({ ok: true, value: "unproven" }));
    });
  `;
}

function divergentReceiptHandlerScript() {
  return `
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      process.stdout.write(JSON.stringify({
        ok: true,
        value: "unproven",
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: "sha256:${"f".repeat(64)}",
          outcome: "applied"
        }
      }));
    });
  `;
}

function effectDocument() {
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: {
      id: "module:test",
      name: "test",
      source_ref: sourceRef(),
    },
    definitions: {
      types: [],
      constants: [],
      functions: [],
      tools: [{
        id: "tool:test/Create",
        name: "Create",
        description: "Create one external test resource.",
        signature: {
          inputs: [parameter("query", "builtin:Text")],
          output_type: "builtin:Text",
        },
        source_ref: sourceRef(),
      }],
      memories: [],
      skills: [{
        id: "skill:test/CreateFlow",
        name: "CreateFlow",
        description: "Create one external test resource.",
        signature: {
          inputs: [parameter("query", "builtin:Text")],
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
          arguments: ["value:query"],
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

function parameter(name, typeRef) {
  return { name, type_ref: typeRef, source_ref: sourceRef() };
}

function sourceRef() {
  return {
    source_id: "effect-test.tb",
    start_byte: 0,
    end_byte: 0,
    start_line: 1,
    start_column: 0,
    end_line: 1,
    end_column: 0,
  };
}

function failureCode(result) {
  return result.trace.events.findLast((event) => event.kind === "failure_detected")
    ?.payload?.runtime_error_code;
}
