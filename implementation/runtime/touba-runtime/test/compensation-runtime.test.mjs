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
  executeAirDocument,
} from "../src/index.mjs";
import {
  COMPENSATION_RESULTS,
  createCompensation,
  deriveCompensationId,
  resumeCompensation,
} from "../src/compensation.mjs";
import { createFileCompensationStore } from "../src/file-compensation-store.mjs";
import { sealCompensationRecord } from "../src/compensation-store.mjs";
import { airDocumentDigest } from "../src/human-approval-checkpoints.mjs";

test("executes one V3 inverse, journals its crash-safe result, and replays creation as a pure read", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-success-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const fixture = compensationFixture({ callsPath, handlerOutcome: "completed" });
    const authorityRequests = [];
    const published = [];
    const result = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      traceEventObserver: (event) => published.push(event),
      compensationAuthorityProvider: {
        check(request) {
          authorityRequests.push(request);
          return true;
        },
      },
    });

    assert.equal(result.record.state, "terminal");
    assert.equal(result.record.result, "completed");
    assert.deepEqual(authorityRequests.map((request) => request.phase), [
      "lookup", "resume", "pre_spawn",
    ]);
    assert.equal(authorityRequests[1].record_revision, 0);
    assert.equal(authorityRequests[1].requires_spawn, true);
    const requests = readJsonLines(callsPath);
    assert.equal(requests.length, 1);
    assert.equal(requests[0].protocol, "touba-tool-handler-v3");
    assert.equal(requests[0].compensation.compensates_effect_id, fixture.originalEffectId);
    const inverse = fixture.journal.entries.get(result.record.inverse.effect_id);
    assert.equal(inverse.state, "applied");
    assert.equal(inverse.result.schema_version, "touba-compensation-effect-result-v1");
    assert.equal(inverse.result.compensation_receipt.result, "completed");
    assert.equal(fixture.journal.entries.get(fixture.originalEffectId).state, "applied");
    for (const kind of ["call_started", "call_completed", "run_completed"]) {
      const event = result.trace.events.find((candidate) => candidate.kind === kind);
      assert.equal(event.payload.compensation_id, result.record.compensation_id);
      assert.equal(event.payload.compensates_effect_id, fixture.originalEffectId);
      assert.equal(event.payload.inverse_effect_id, result.record.inverse.effect_id);
    }
    assert.deepEqual(
      published.map((event) => event.sequence_index),
      [...new Set(published.map((event) => event.sequence_index))],
    );
    assert.equal(
      published.find((event) => event.kind === "call_started").payload.compensation_id,
      result.record.compensation_id,
    );

    const replay = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(replay.trace, null);
    assert.equal(replay.record.revision, result.record.revision);
    assert.equal(readJsonLines(callsPath).length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("exposes exactly the five bounded results and terminalizes partial", async () => {
  assert.deepEqual(COMPENSATION_RESULTS, [
    "completed", "partial", "unavailable", "failed", "unknown",
  ]);
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-partial-"));
  try {
    const fixture = compensationFixture({
      callsPath: join(workspace, "calls.log"),
      handlerOutcome: "partial",
    });
    const result = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(result.record.state, "terminal");
    assert.equal(result.record.result, "partial");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("terminalizes unavailable locally when no inverse is declared", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-unavailable-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const fixture = compensationFixture({ callsPath });
    delete fixture.options.toolBindingManifest.bindings["tool:test/CreateReservation"]
      .effect_contract.compensation;
    const requests = [];
    const result = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: { check: (request) => { requests.push(request); return true; } },
    });
    assert.equal(result.record.state, "terminal");
    assert.equal(result.record.result, "unavailable");
    assert.equal(result.record.inverse, null);
    assert.equal(requests.at(-1).phase, "resume");
    assert.equal(requests.at(-1).record_revision, 0);
    assert.equal(requests.at(-1).requires_spawn, false);
    assert.equal(result.trace.events.at(-1).payload.inverse_effect_id, null);
    assert.equal(readJsonLines(callsPath).length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses initial durable progression authority before creating a record", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-create-authority-"));
  try {
    const fixture = compensationFixture({ callsPath: join(workspace, "calls.log") });
    const compensationId = deriveCompensationId(fixture.originalEffectId);
    await assert.rejects(
      () => createCompensation(createCommand(fixture.originalEffectId), {
        ...fixture.options,
        compensationAuthorityProvider: {
          check: (request) => request.phase === "lookup",
        },
      }),
      (error) => error?.code === "CompensationAuthorityRefused",
    );
    assert.equal(fixture.store.read(compensationId), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("maps an authority timeout to the same bounded refusal before record creation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-authority-timeout-"));
  try {
    const fixture = compensationFixture({ callsPath: join(workspace, "calls.log") });
    await assert.rejects(
      () => createCompensation(createCommand(fixture.originalEffectId), {
        ...fixture.options,
        compensationAuthorityTimeoutMs: 5,
        compensationAuthorityProvider: {
          check: (request) => request.phase === "lookup" ? true : new Promise(() => {}),
        },
      }),
      (error) => error?.code === "CompensationAuthorityRefused"
        && error?.message === "compensation authority refused",
    );
    assert.equal(fixture.store.read(deriveCompensationId(fixture.originalEffectId)), null);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses a forged public compensation execution context", async () => {
  await assert.rejects(
    () => executeAirDocument(compensationDocument(), {
      __compensationExecutionContext: { envelope: {} },
    }),
    (error) => error?.code === "CompensationContextRequired",
  );
});

test("classifies an original unknown locally and resumes only after exact identity and CAS", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-resume-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const fixture = compensationFixture({ callsPath, originalState: "unknown" });
    const created = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(created.record.state, "action_required");
    assert.equal(created.record.result, "unknown");
    assert.equal(created.record.blocker_code, "CompensationOriginalOutcomeUnknown");
    assert.equal(readJsonLines(callsPath).length, 0);

    let providerCalls = 0;
    await assert.rejects(
      () => resumeCompensation({
        ...resumeCommand(created.record),
        compensation_id: `compensation:sha256:${"f".repeat(64)}`,
      }, {
        ...fixture.options,
        compensationAuthorityProvider: { check: () => { providerCalls += 1; return true; } },
      }),
      (error) => error?.code === "CompensationRequestInvalid",
    );
    assert.equal(providerCalls, 0);

    fixture.journal.entries.set(fixture.originalEffectId, originalEntry(
      fixture.document,
      fixture.originalEffectId,
      "applied",
    ));
    const resumed = await resumeCompensation(resumeCommand(created.record), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(resumed.record.result, "completed");
    assert.equal(readJsonLines(callsPath).length, 1);

    const replay = await resumeCompensation(resumeCommand(created.record), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(replay.trace, null);
    assert.equal(replay.record.revision, resumed.record.revision);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("fails closed in the final pre-spawn guard without dispatching the inverse", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-authority-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const fixture = compensationFixture({ callsPath });
    const result = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: {
        check(request) { return request.phase !== "pre_spawn"; },
      },
    });
    assert.equal(result.record.state, "action_required");
    assert.equal(result.record.result, null);
    assert.equal(result.record.blocker_code, "CompensationAuthorityRefused");
    assert.equal(readJsonLines(callsPath).length, 0);
    const inverse = fixture.journal.entries.get(result.record.inverse.effect_id);
    assert.equal(inverse.state, "prepared");
    assert.equal(inverse.attempt_count, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("retries a proven not-applied inverse with the same effect and a new call id", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-retry-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const fixture = compensationFixture({ callsPath, handlerOutcome: "retry" });
    const created = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(created.record.result, "failed");
    const effectId = created.record.inverse.effect_id;
    const firstCallId = fixture.journal.entries.get(effectId).last_call_id;

    const resumed = await resumeCompensation(resumeCommand(created.record), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(resumed.record.result, "completed");
    assert.equal(resumed.record.inverse.effect_id, effectId);
    const second = fixture.journal.entries.get(effectId);
    assert.equal(second.attempt_count, 2);
    assert.notEqual(second.last_call_id, firstCallId);
    assert.equal(readJsonLines(callsPath).length, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires renewable approval evidence and persists only its bounded decision in the checkpoint", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-approval-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const fixture = compensationFixture({ callsPath, approval: true });
    const created = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(created.record.state, "action_required");
    assert.equal(created.record.blocker_code, "CompensationApprovalRequired");
    assert.equal(created.record.approval.evidence, null);

    const expiredEvidence = {
      schema_version: "touba-compensation-approval-v1",
      approval_id: "approval-evidence:expired",
      approval_ref: "approval:test/ReleaseReservation",
      subject_ref: created.record.compensation_id,
      decision: "approved",
      decided_at: "2026-09-22T08:00:00.000Z",
      expires_at: "2026-09-22T09:00:00.000Z",
    };
    await assert.rejects(
      () => resumeCompensation({
        ...resumeCommand(created.record),
        approval_evidence: expiredEvidence,
      }, {
        ...fixture.options,
        compensationAuthorityProvider: { check: () => true },
      }),
      (error) => error?.code === "CompensationApprovalExpired",
    );
    const expired = fixture.store.read(created.record.compensation_id);
    assert.equal(expired.blocker_code, "CompensationApprovalExpired");
    assert.equal(readJsonLines(callsPath).length, 0);

    const evidence = {
      schema_version: "touba-compensation-approval-v1",
      approval_id: "approval-evidence:test-1",
      approval_ref: "approval:test/ReleaseReservation",
      subject_ref: created.record.compensation_id,
      decision: "approved",
      decided_at: "2026-09-22T09:00:00.000Z",
      expires_at: "2026-09-22T11:00:00.000Z",
    };
    const resumed = await resumeCompensation({
      ...resumeCommand(expired),
      resume_request_id: "resume:test-2",
      approval_evidence: evidence,
    }, {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(resumed.record.result, "completed");
    assert.deepEqual(resumed.record.checkpoint.decisions_consumed, [{
      decision_ref: evidence.approval_ref,
      result: "approved",
      decision_digest: resumed.record.checkpoint.decisions_consumed[0].decision_digest,
    }]);
    assert.equal(JSON.stringify(resumed.record.checkpoint).includes("approval-evidence:test-1"), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("restores an applied inverse envelope after an interrupted terminal record without redispatch", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-restore-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const fixture = compensationFixture({ callsPath });
    const completed = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    const running = sealCompensationRecord({
      ...completed.record,
      revision: completed.record.revision + 1,
      state: "running",
      result: null,
      blocker_code: null,
      updated_at: "2026-09-22T10:05:00.000Z",
    });
    const recoveryStore = memoryStoreFromRecord(running);
    const restored = await resumeCompensation(resumeCommand(running), {
      ...fixture.options,
      compensationStore: recoveryStore,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(restored.record.state, "terminal");
    assert.equal(restored.record.result, "completed");
    assert.equal(readJsonLines(callsPath).length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("never redispatches an applied inverse whose Core result envelope is invalid", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-comp-invalid-restore-"));
  try {
    const callsPath = join(workspace, "calls.log");
    const fixture = compensationFixture({ callsPath });
    const completed = await createCompensation(createCommand(fixture.originalEffectId), {
      ...fixture.options,
      compensationAuthorityProvider: { check: () => true },
    });
    const inverse = fixture.journal.entries.get(completed.record.inverse.effect_id);
    fixture.journal.entries.set(inverse.effect_id, { ...inverse, result: { corrupted: true } });
    const running = sealCompensationRecord({
      ...completed.record,
      revision: completed.record.revision + 1,
      state: "running",
      result: null,
      blocker_code: null,
      updated_at: "2026-09-22T10:06:00.000Z",
    });
    const recoveryStore = memoryStoreFromRecord(running);
    const restored = await resumeCompensation(resumeCommand(running), {
      ...fixture.options,
      compensationStore: recoveryStore,
      compensationAuthorityProvider: { check: () => true },
    });
    assert.equal(restored.record.state, "action_required");
    assert.equal(restored.record.result, "unknown");
    assert.equal(restored.record.blocker_code, "CompensationEffectResultInvalid");
    assert.equal(readJsonLines(callsPath).length, 1);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function compensationFixture({
  callsPath,
  originalState = "applied",
  handlerOutcome = "completed",
  approval = false,
}) {
  const document = compensationDocument({ approval });
  const originalEffectId = `effect:sha256:${"1".repeat(64)}`;
  const journal = journalAdapter();
  journal.entries.set(
    originalEffectId,
    originalEntry(document, originalEffectId, originalState),
  );
  const manifest = compensationManifest(callsPath, handlerOutcome);
  const store = createFileCompensationStore(join(callsPath, "..", "compensations.json"));
  return {
    document,
    originalEffectId,
    journal,
    store,
    options: {
      airDocument: document,
      toolBindingManifest: manifest,
      effectJournal: journal.adapter,
      compensationStore: store,
      compensationAuthorityTimeoutMs: 250,
      now: () => new Date("2026-09-22T10:00:00.000Z"),
    },
  };
}

function createCommand(originalEffectId) {
  return {
    compensation_request_id: "request:comp-1",
    compensates_effect_id: originalEffectId,
    requester_ref: "principal:test",
    journal_scope_ref: "effect-journal:test",
  };
}

function resumeCommand(record) {
  return {
    resume_request_id: "resume:test-1",
    compensation_id: deriveCompensationId(record.compensates_effect_id),
    compensates_effect_id: record.compensates_effect_id,
    expected_revision: record.revision,
    expected_record_digest: record.record_digest,
    requester_ref: "principal:test",
    journal_scope_ref: "effect-journal:test",
  };
}

function journalAdapter() {
  const entries = new Map();
  return {
    entries,
    adapter: {
      schemaVersion: EFFECT_JOURNAL_SCHEMA_VERSION,
      readEntry: (effectId) => entries.has(effectId) ? structuredClone(entries.get(effectId)) : null,
      entriesForScope: (scopeId) => [...entries.values()]
        .filter((entry) => entry.effect_scope_id === scopeId)
        .map((entry) => structuredClone(entry)),
      writeEntry: (entry) => entries.set(entry.effect_id, structuredClone(entry)),
    },
  };
}

function memoryStoreFromRecord(initial) {
  let record = structuredClone(initial);
  return {
    schemaVersion: "touba-compensation-store-v1",
    read: (compensationId) => compensationId === record.compensation_id
      ? structuredClone(record)
      : null,
    createIfAbsent: () => structuredClone(record),
    compareAndSwap(compensationId, revision, digest, next) {
      if (
        compensationId !== record.compensation_id
        || revision !== record.revision
        || digest !== record.record_digest
      ) throw Object.assign(new Error("conflict"), { code: "CompensationConflict" });
      record = structuredClone(next);
      return structuredClone(record);
    },
  };
}

function originalEntry(document, effectId, state) {
  const applied = state === "applied";
  return {
    effect_id: effectId,
    effect_scope_id: "operation:original",
    air_digest: airDocumentDigest(document),
    entry_ref: "strategy:test/CreateReservation",
    effect_index: 1,
    request_digest: `sha256:${"2".repeat(64)}`,
    tool_ref: "tool:test/CreateReservation",
    retry_mode: "idempotency_key",
    state,
    attempt_count: state === "prepared" ? 0 : 1,
    ...(state === "prepared" ? {} : { last_call_id: "call:original:1" }),
    ...(applied ? {
      receipt: {
        effect_id: effectId,
        request_digest: `sha256:${"2".repeat(64)}`,
        outcome: "applied",
        receipt_ref: "opaque:reservation:17",
      },
      result: "created",
    } : {}),
  };
}

function compensationManifest(callsPath, result) {
  return {
    manifest_version: "touba-manifest-v3",
    bindings: {
      "tool:test/CreateReservation": {
        handler: { kind: "process", command: process.execPath, args: ["-e", ""] },
        grants: [],
        secrets: [],
        timeout_ms: 1000,
        max_payload_bytes: 16384,
        effect_contract: {
          kind: "external_write",
          retry_mode: "idempotency_key",
          compensation: { entry_ref: "strategy:test/ReleaseReservation" },
        },
      },
      "tool:test/ReleaseReservation": {
        handler: {
          kind: "process",
          command: process.execPath,
          args: ["-e", compensationHandlerScript(callsPath, result)],
        },
        grants: [],
        secrets: [],
        timeout_ms: 1000,
        max_payload_bytes: 16384,
        effect_contract: { kind: "external_write", retry_mode: "idempotency_key" },
      },
    },
  };
}

function compensationHandlerScript(callsPath, result) {
  return `
    const fs = require("node:fs");
    let input = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => { input += chunk; });
    process.stdin.on("end", () => {
      const request = JSON.parse(input);
      fs.appendFileSync(${JSON.stringify(callsPath)}, JSON.stringify(request) + "\\n");
      const callCount = fs.readFileSync(${JSON.stringify(callsPath)}, "utf8").trim().split("\\n").length;
      if (${JSON.stringify(result)} === "retry" && callCount === 1) {
        process.stdout.write(JSON.stringify({
          ok: false,
          error: { code: "ReleaseDeferred", message: "not released" },
          effect_receipt: {
            effect_id: request.effect.effect_id,
            request_digest: request.effect.request_digest,
            outcome: "not_applied"
          }
        }));
        return;
      }
      process.stdout.write(JSON.stringify({
        ok: true,
        value: "released",
        effect_receipt: {
          effect_id: request.effect.effect_id,
          request_digest: request.effect.request_digest,
          outcome: "applied",
          receipt_ref: "opaque:release:17"
        },
        compensation_receipt: {
          compensation_id: request.compensation.compensation_id,
          compensates_effect_id: request.compensation.compensates_effect_id,
          inverse_effect_id: request.effect.effect_id,
          result: ${JSON.stringify(result === "retry" ? "completed" : result)}
        }
      }));
    });
  `;
}

function compensationDocument({ approval = false } = {}) {
  const src = sourceRef();
  return {
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
    module: { id: "module:test", name: "test", source_ref: src },
    definitions: {
      types: [], constants: [], functions: [], memories: [], skills: [], agents: [], triggers: [],
      tools: [
        tool("tool:test/CreateReservation", "CreateReservation"),
        tool("tool:test/ReleaseReservation", "ReleaseReservation"),
      ],
      strategies: [
        strategy("strategy:test/CreateReservation", "graph:strategy:test/CreateReservation", ["tool:test/CreateReservation"]),
        strategy("strategy:test/ReleaseReservation", "graph:strategy:test/ReleaseReservation", ["tool:test/ReleaseReservation"]),
      ],
    },
    execution_graphs: [
      {
        id: "graph:strategy:test/CreateReservation",
        owner_ref: "strategy:test/CreateReservation",
        entry_node_id: "stop",
        nodes: [{ id: "stop", kind: "stop", arguments: [], trace_point_refs: [], source_ref: src }],
        edges: [], expressions: [], failure_paths: [], failure_path_refs: [], source_ref: src,
      },
      {
        id: "graph:strategy:test/ReleaseReservation",
        owner_ref: "strategy:test/ReleaseReservation",
        entry_node_id: approval ? "approve" : "release",
        nodes: [
          ...(approval ? [{
            id: "approve", kind: "human_approval",
            approval_ref: "approval:test/ReleaseReservation",
            approval_mode: "required_approval",
            context_refs: [],
            result_binding: "approval_decision",
            arguments: [], trace_point_refs: [], source_ref: src,
          }] : []),
          {
            id: "release", kind: "call_tool", target_ref: "tool:test/ReleaseReservation",
            arguments: ["literal:string:reservation-17"], result_binding: "released",
            trace_point_refs: [], source_ref: src,
          },
          { id: "give", kind: "give", arguments: ["value:released"], trace_point_refs: [], source_ref: src },
        ],
        edges: [
          ...(approval ? [{ from_node_id: "approve", to_node_id: "release", role: "next" }] : []),
          { from_node_id: "release", to_node_id: "give", role: "next" },
        ],
        expressions: [], failure_paths: [], failure_path_refs: [], source_ref: src,
      },
    ],
    trace_points: [],
  };
}

function tool(id, name) {
  return {
    id, name, description: `${name} resource.`,
    signature: {
      inputs: [{ name: "reservation_id", type_ref: "builtin:Text", source_ref: sourceRef() }],
      output_type: "builtin:Text",
    },
    source_ref: sourceRef(),
  };
}

function strategy(id, graphRef, uses) {
  return {
    id,
    name: id.split("/").at(-1),
    signature: { inputs: [], output_type: "builtin:Text" },
    uses,
    flow_graph_ref: graphRef,
    source_ref: sourceRef(),
  };
}

function sourceRef() {
  return { file: "compensation.tb", start_line: 1, start_column: 1, end_line: 1, end_column: 2 };
}

function readJsonLines(path) {
  try {
    return readFileSync(path, "utf8").trim().split("\n").filter(Boolean).map(JSON.parse);
  } catch {
    return [];
  }
}
