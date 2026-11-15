import assert from "node:assert/strict";
import test from "node:test";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  mkdirSync,
  readdirSync,
  realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openCliEffectJournal } from '../../../cli/touba-run/src/effect-journal.mjs';
import { buildHandlerSandboxPlan } from '../src/handler-protocol.mjs';

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

// These tests observe actual durable writes separately from handler replies.
// They qualify our protocol, not arbitrary third-party code or business rules.
for (const language of ['javascript', 'python']) {
 for (const confined of [false, true]) {
  const python = process.env.TOUBA_TEST_PYTHON || (process.platform === 'win32' ? 'python' : 'python3');
  const available = (!confined || process.platform === 'darwin') && (language !== 'python' || spawnSync(python, ['--version']).status === 0);
  const label = language + (confined ? ' under native macOS confinement' : '');
  for (const mode of ['missing', 'invalid', 'throw', 'timeout']) {
    test(`${label} committed write with ${mode} response remains unknown and is not blindly retried`, { skip: !available }, async t => {
      const f = conformanceFixture(t, language, python, mode, 'reconcile', confined);
      const first = await f.run();
      assert.equal(first.status, 'failure');
      assert.equal(failureCode(first), mode === 'timeout' ? 'ToolHandlerTimeout' : 'ToolHandlerReportedError', JSON.stringify(first.diagnostics));
      assert.equal(f.entry().state, 'unknown');
      assert.equal(f.count('effects'), 1, 'The response failure did not undo the external write');
      assert.equal(f.count('calls'), 1);
      const second = await f.run();
      assert.equal(failureCode(second), 'EffectReconciliationRequired');
      assert.equal(f.count('calls'), 1, 'No automatic redispatch without provider evidence');
      assert.equal(f.entry().attempt_count, 1);
    });
  }
  test(`${label} idempotent provider survives a lost reply, a competing resume and journal reopen`, { skip: !available }, async t => {
    const f = conformanceFixture(t, language, python, 'timeout', 'idempotency_key', confined);
    const first = f.run();
    // Admission covers the whole run, not just the individual SQL statements.
    assert.throws(() => openCliEffectJournal(f.journalPath), { code: 'EffectJournalBusy' });
    assert.equal(failureCode(await first), 'ToolHandlerTimeout');
    assert.equal(f.count('effects'), 1);
    const before = f.entry();
    assert.equal(before.state, 'unknown');
    const second = await f.run();
    assert.equal(second.status, 'success', failureCode(second));
    assert.equal(second.result, 'created:record');
    assert.equal(f.entry().effect_id, before.effect_id);
    assert.equal(f.entry().attempt_count, 2);
    assert.equal(f.count('calls'), 2);
    assert.equal(f.count('effects'), 1, 'Provider uniqueness, not the receipt alone, prevents duplicate writes');
    const restored = await f.run();
    assert.equal(restored.status, 'success');
    assert.equal(restored.result, second.result);
    assert.equal(f.count('calls'), 2, 'An applied journal entry is restored without another provider call');
  });
 }
}

function conformanceFixture(t, language, python, mode, retryMode, confined = false) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'touba-effect-conformance-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const provider = join(root, 'provider'); mkdirSync(provider);
  const database = join(provider, 'provider.sqlite');
  const db = new DatabaseSync(database);
  db.exec('CREATE TABLE calls (id TEXT, digest TEXT, attempt INTEGER); CREATE TABLE effects (id TEXT PRIMARY KEY, digest TEXT NOT NULL, value TEXT NOT NULL);');
  db.close();
  const script = fileURLToPath(new URL(`./fixtures/effect-conformance/handler.${language === 'python' ? 'py' : 'mjs'}`, import.meta.url));
  const sandbox = confined ? conformanceSandbox(language, python, provider) : undefined;
  const command = language === 'python' && confined
    ? spawnSync(python, ['-I', '-S', '-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' }).stdout.trim()
    : language === 'python' ? python : process.execPath;
  const manifest = loadToolBindingManifestFromJson(JSON.stringify({ manifest_version: 'touba-manifest-v1', bindings: {
    'tool:test/Create': { handler: { kind: 'process', command,
      // Include Python startup under concurrent CI load. Timeout fixtures hang
      // after committing, so the durable-write assertion still proves the fault.
      args: [script, database, mode], cwd: root }, grants: confined ? ['filesystem_read', 'filesystem_write'] : [],
      ...(sandbox ? { sandbox } : {}), secrets: [], timeout_ms: 5000, max_payload_bytes: 16384,
      effect_contract: { kind: 'external_write', retry_mode: retryMode } },
  } }));
  if (confined) {
    const binding = manifest.bindings.get('tool:test/Create');
    const plan = buildHandlerSandboxPlan({ binding });
    const startup = spawnSync(plan.command, plan.args, { cwd: root, env: { PYTHONDONTWRITEBYTECODE: '1' },
      input: '{}', encoding: 'utf8', timeout: 10000 });
    assert.equal(startup.status, 0, startup.stderr);
  }
  const journalPath = join(root, 'run.effect-journal.sqlite');
  const scope = 'synthetic:durable-write';
  return {
    journalPath,
    async run() {
      const lease = openCliEffectJournal(journalPath);
      try { return await executeAirDocument(effectDocument(), { entryRef: 'skill:test/CreateFlow',
        inputs: { query: 'record' }, toolBindingManifest: manifest, effectScopeId: scope, effectJournal: lease.journal }); }
      finally { lease.close(); }
    },
    entry() {
      const lease = openCliEffectJournal(journalPath);
      try { return lease.journal.entriesForScope(scope)[0]; }
      finally { lease.close(); }
    },
    count(table) {
      assert.ok(['calls', 'effects'].includes(table));
      const connection = new DatabaseSync(database, { readOnly: true });
      try { return connection.prepare(`SELECT count(*) AS count FROM ${table}`).get().count; }
      finally { connection.close(); }
    },
  };
}

function conformanceSandbox(language, python, provider) {
  const files = new Set();
  const inventory = directory => {
    for (const item of readdirSync(directory, { withFileTypes: true })) {
      if (['site-packages', '__pycache__', 'tests', 'test'].includes(item.name)) continue;
      const path = join(directory, item.name);
      if (item.isDirectory()) inventory(path);
      else if (item.isFile() && /\.(py|mjs|json|so|dylib)$/.test(item.name)) files.add(realpathSync(path));
    }
  };
  if (language === 'python') {
    const probe = spawnSync(python, ['-I', '-S', '-c', 'import sys,sysconfig,json,_sqlite3;print(json.dumps([sys.base_prefix,sysconfig.get_path("stdlib"),_sqlite3.__file__]))'], { encoding: 'utf8' });
    assert.equal(probe.status, 0, probe.stderr);
    const [base, stdlib, sqliteModule] = JSON.parse(probe.stdout); inventory(stdlib);
    const linked = spawnSync('/usr/bin/otool', ['-L', sqliteModule], { encoding: 'utf8' });
    assert.equal(linked.status, 0, linked.stderr);
    for (const line of linked.stdout.split('\n').slice(1)) {
      const path = line.trim().split(' (')[0];
      if (path.startsWith('/') && existsSync(path)) files.add(realpathSync(path));
    }
    for (const path of [join(base, 'Python'), join(base, 'Python3'), join(base, 'Resources/Python.app/Contents/MacOS/Python')]) {
      if (existsSync(path)) files.add(realpathSync(path));
    }
    inventory(fileURLToPath(new URL('../../touba-python-sdk/src/touba_sdk/', import.meta.url)));
  } else {
    const sdk = fileURLToPath(new URL('../../touba-handler-sdk/', import.meta.url));
    inventory(join(sdk, 'src')); files.add(join(sdk, 'package.json'));
    files.add(fileURLToPath(new URL('../../../contracts/machine/value-contracts.mjs', import.meta.url)));
  }
  assert.ok(files.size > 0 && files.size < 4096);
  // The handler can access only its simulated provider, not the run journal.
  return { required: true, code_paths: [...files], read_paths: [provider], write_paths: [provider] };
}

test('effect identity refuses changed handler configuration without repeating an applied write', async t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-effect-configuration-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const calls = join(root, 'calls');
  const schema = { schema_version: 'touba-handler-configuration-v1', fields: { region: { type: 'string', required: true } } };
  const manifest = region => effectManifest(successHandlerScript(calls), { configuration: { schema, values: { region } } });
  const journal = journalAdapter();
  const options = { entryRef: 'skill:test/CreateFlow', inputs: { query: 'one' }, effectScopeId: 'operation:configuration', effectJournal: journal.adapter };
  const first = await executeAirDocument(effectDocument(), { ...options, toolBindingManifest: manifest('private-region-one') });
  assert.equal(first.status, 'success', failureCode(first));
  assert.ok(!JSON.stringify(first).includes('private-region-one'));
  const replay = await executeAirDocument(effectDocument(), { ...options, toolBindingManifest: manifest('private-region-two') });
  assert.equal(failureCode(replay), 'EffectRequestConflict');
  assert.equal(readFileSync(calls, 'utf8'), 'called\n');
});

function effectManifest(script, {
  kind = "external_write",
  retryMode = "idempotency_key",
  timeoutMs = 1000,
  configuration,
} = {}) {
  return loadToolBindingManifestFromJson(JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:test/Create": {
        ...(configuration === undefined ? {} : { configuration }),
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
