import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  archiveInteractionSession,
  createInteractionSession,
  enqueueInteractionOperation,
  getInteractionSession,
  listInteractionSessions,
  recordInteractionOperationProgress,
  recoverInterruptedInteractionOperations,
  requestInteractionOperationCancel,
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
      event: {
        kind: "tool_dispatch_started",
        sequence_index: 4,
        payload: {
          tool_ref: "tool:demo/Lookup",
          secret_value: "MUST_NOT_PERSIST",
          raw_payload: { customer: "sensitive" },
        },
      },
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

test("interaction operations recover as interrupted and completed sessions can be archived", () => {
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
    assert.equal(recovered[0].status, "interrupted");
    const archived = archiveInteractionSession({
      sessionId: session.session_id,
      sessionsPath,
    });
    assert.equal(archived.status, "archived");
    const store = JSON.parse(readFileSync(sessionsPath, "utf8"));
    assert.equal(store.schema_version, "touba-interaction-sessions-v0.2");
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
        presentation: "typed_invocation",
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

function createSession(sessionsPath) {
  return createInteractionSession({
    request: {
      target_ref: "agent:demo/Coordinator",
      target_kind: "agent",
      presentation: "conversation",
      effect_policy: "runtime_only",
      requested_by: { kind: "studio", id: "test-suite" },
    },
    sessionsPath,
  });
}

function interactionMessage() {
  return {
    message_id: "message_01",
    display_text: "Coordinate the bounded test.",
  };
}
