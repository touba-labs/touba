import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  acceptMobilePairing,
  acceptDecision,
  buildAuthorityGraph,
  buildGovernanceReadiness,
  buildHandlerSandboxStatus,
  buildSupplyChainStatus,
  readCostObservatory,
  readMobileEscalation,
  readMobileNotifications,
  readMobileQuickApprovalPolicy,
  applyProjectChange,
  buildContractIndex,
  buildLiveState,
  buildProjectEvent,
  buildTriggerQueueHealth,
  createToubaProjectServer,
  getProjectChangeDetail,
  getHumanDecisionDetail,
  issueMobilePairingRequest,
  appendProjectEventJournal,
  listHumanDecisions,
  listProjectChanges,
  preflightServeOptions,
  proposeProjectChange,
  readProjectEventJournal,
  readPendingHumanRequest,
  readProjectRunSummary,
  readProjectTraceTimeline,
  readProjectTriggerStatus,
  readProductIdentity,
  replayProjectEvents,
  revokeMobilePairing,
  refreshProject,
} from "../src/serve.mjs";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;

test("contract index lists product-surface contracts without filesystem paths", () => {
  const index = buildContractIndex({ contractsRoot, generatedAt: "2026-06-22T00:00:00Z" });

  assert.equal(index.schema_version, "touba-project-server-contract-index-v0.1");
  assert.equal(index.contracts.some((item) => item.schema_version === "touba-run-summary-v1"), true);
  assert.equal(index.contracts.every((item) => item.status === "available"), true);
  assert.equal(JSON.stringify(index).includes(contractsRoot), false);
});

test("preflight rejects invalid contracts root and decision store path", () => {
  assert.throws(
    () => preflightServeOptions({
      contractsRoot: join(tmpdir(), "missing-touba-contracts"),
      humanDecisionsPath: join(tmpdir(), "human-decisions.json"),
    }),
    /valid contracts root/,
  );
  assert.throws(
    () => preflightServeOptions({
      contractsRoot,
      humanDecisionsPath: contractsRoot,
    }),
    /directory as decision store/,
  );
});

test("live state composes project, run, trigger, decision and event surfaces", () => {
  const state = buildLiveState({ contractsRoot, generatedAt: "2026-06-22T00:00:00Z" });

  assert.equal(state.schema_version, "touba-project-live-state-v0.1");
  assert.equal(state.project.schema_version, "touba-project-inspection-v1");
  assert.equal(state.authority_graph.schema_version, "touba-authority-graph-v0.1");
  assert.equal(state.identity.schema_version, "touba-product-identity-v0.1");
  assert.equal(state.current_run.schema_version, "touba-run-summary-v1");
  assert.equal(state.trigger_queue_health.schema_version, "touba-trigger-queue-health-v0.1");
  assert.equal(state.supply_chain_status.schema_version, "touba-supply-chain-status-v0.1");
  assert.equal(state.governance_readiness.schema_version, "touba-governance-readiness-v0.1");
  assert.equal(state.cost_observatory.schema_version, "touba-cost-observatory-v0.1");
  assert.equal(state.handler_sandbox_status.schema_version, "touba-handler-sandbox-status-v0.1");
  assert.equal(state.mobile_notifications.schema_version, "touba-mobile-notification-v0.1");
  assert.equal(state.mobile_quick_approval_policy.schema_version, "touba-mobile-quick-approval-policy-v0.1");
  assert.equal(state.mobile_escalation.schema_version, "touba-mobile-escalation-v0.1");
  assert.equal(state.pending_approval.schema_version, "touba-approval-request-v1");
  assert.equal(state.pending_review.schema_version, "touba-human-review-request-v1");
  assert.equal(state.events.transport, "server_sent_events");
  assert.equal(state.events.event_schema_version, "touba-project-event-v0.1");
  assert.equal(state.project_server.refresh.schema_version, "touba-project-refresh-v0.1");
});

test("project events use a stable envelope contract", () => {
  const event = buildProjectEvent({
    type: "project.changed",
    sequence: 7,
    emittedAt: "2026-06-23T00:00:00.000Z",
    payload: {
      schema_version: "touba-project-refresh-v0.1",
      status: "refreshed",
    },
  });

  assert.equal(event.schema_version, "touba-project-event-v0.1");
  assert.equal(event.event_id, "evt_000007");
  assert.equal(event.sequence, 7);
  assertMatchesSchema("touba-project-event-v0.1", event);
});

test("event journal keeps a bounded replay window", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-events-"));
  try {
    const eventJournalPath = join(root, ".touba", "project-events.jsonl");
    for (const sequence of [1, 2, 3]) {
      appendProjectEventJournal({
        eventJournalPath,
        limit: 2,
        event: buildProjectEvent({
          type: "project.changed",
          sequence,
          emittedAt: `2026-06-23T00:00:0${sequence}.000Z`,
          payload: { sequence },
        }),
      });
    }

    const retained = readProjectEventJournal(eventJournalPath);
    assert.deepEqual(retained.map((event) => event.sequence), [2, 3]);
    const replay = replayProjectEvents({
      eventJournalPath,
      lastEventId: "evt_000002",
    });
    assert.equal(replay.status, "replayed");
    assert.deepEqual(replay.events.map((event) => event.sequence), [3]);

    const expired = replayProjectEvents({
      eventJournalPath,
      lastEventId: "evt_000000",
    });
    assert.equal(expired.status, "resync_required");
    assert.equal(expired.reason, "event_window_expired");
    assert.equal(expired.retained_from_sequence, 2);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project data surfaces read run, trace and trigger artifacts", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-surfaces-"));
  try {
    const runSummaryPath = join(root, ".touba", "current-run-summary.json");
    const traceTimelinePath = join(root, ".touba", "current-trace-timeline.json");
    const triggerStatusPath = join(root, ".touba", "trigger-status.json");
    mkdirSync(join(root, ".touba"), { recursive: true });
    writeFileSync(
      runSummaryPath,
      JSON.stringify(readJson("fixtures/valid/touba-run-summary-v1.json")),
      "utf8",
    );
    writeFileSync(
      traceTimelinePath,
      JSON.stringify(readJson("fixtures/valid/touba-trace-timeline-v1.json")),
      "utf8",
    );

    const run = readProjectRunSummary({ contractsRoot, runSummaryPath });
    const trace = readProjectTraceTimeline({ contractsRoot, traceTimelinePath });
    const trigger = readProjectTriggerStatus({
      contractsRoot,
      triggerStatusPath,
      generatedAt: "2026-06-23T00:00:00.000Z",
    });

    assertMatchesSchema("touba-run-summary-v1", run);
    assert.equal(run.status, "approval_pending");
    assertMatchesSchema("touba-trace-timeline-v1", trace);
    assert.equal(trace.events.length, 2);
    assertMatchesSchema("touba-trigger-status-v1", trigger);
    assert.deepEqual(trigger.triggers, []);

    writeFileSync(traceTimelinePath, "{bad-json", "utf8");
    assert.throws(
      () => readProjectTraceTimeline({ contractsRoot, traceTimelinePath }),
      /not valid JSON/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authority graph extracts source, AIR and manifest authority", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-authority-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), [
      "module demo.authority",
      "",
      "memory ProjectKnowledge",
      "",
      "type ChangeRequest",
      "    summary is Text",
      "",
      "tool ReadKnowledge",
      "    uses memory ProjectKnowledge read",
      "    takes request as ChangeRequest",
      "    gives ChangeRequest",
      "    requires memory_read",
      "",
      "skill ValidateChange",
      "    takes request as ChangeRequest",
      "    gives ChangeRequest",
      "    uses ReadKnowledge",
      "    do",
      "        human.approve",
      "            with context as request",
      "            into approval",
      "        give request",
      "",
      "agent Reviewer",
      "    uses ValidateChange",
      "    callable_by strategy RunReview",
      "",
      "strategy RunReview",
      "    takes request as ChangeRequest",
      "    uses Reviewer",
      "    do",
      "        Reviewer",
      "",
    ].join("\n"), "utf8");
    writeFileSync(
      join(root, "program.air.json"),
      readFileSync(new URL("../../../tests/air/tb-v01-005-strategy-agents.air.json", import.meta.url), "utf8"),
      "utf8",
    );
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:demo.authority/ReadKnowledge": {
          grants: ["memory_read"],
          secrets: ["DEMO_SECRET"],
        },
      },
    }, null, 2), "utf8");

    const graph = buildAuthorityGraph({
      projectRoot: root,
      generatedAt: "2026-06-23T00:00:00.000Z",
    });
    assertMatchesSchema("touba-authority-graph-v0.1", graph);
    assert.equal(graph.schema_version, "touba-authority-graph-v0.1");
    assert.equal(graph.nodes.some((node) => node.ref === "agent:examples.strategy_agents/Reviewer"), true);
    assert.equal(graph.nodes.some((node) => node.ref === "memory:demo.authority/ProjectKnowledge"), true);
    assert.equal(graph.nodes.some((node) => node.ref === "human_gate:skill:demo.authority/ValidateChange/approve"), true);
    assert.equal(graph.nodes.some((node) => node.ref === "capability:secret:DEMO_SECRET"), true);
    assert.equal(graph.edges.some((edge) =>
      edge.kind === "callable_by"
      && edge.from === "strategy:examples.strategy_agents/RunChange"
      && edge.to === "agent:examples.strategy_agents/Reviewer"
    ), true);
    assert.equal(graph.edges.some((edge) =>
      edge.kind === "uses"
      && edge.from === "skill:demo.authority/ValidateChange"
      && edge.to === "human_gate:skill:demo.authority/ValidateChange/approve"
    ), true);
    assert.equal(graph.edges.some((edge) =>
      edge.kind === "requires"
      && edge.from === "tool:demo.authority/ReadKnowledge"
      && edge.to === "capability:secret:DEMO_SECRET"
    ), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("operational project surfaces report supply chain, governance readiness and trigger queue health", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-ops-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "handlers"), { recursive: true });
    mkdirSync(join(root, ".touba"), { recursive: true });
    const handlerText = "export default async function readInvoice() { return { text: 'ok' }; }\n";
    const handlerDigest = sha256(handlerText);
    writeFileSync(join(root, "handlers", "read-invoice.handler.mjs"), handlerText, "utf8");
    writeFileSync(join(root, "src", "main.tb"), [
      "module demo.governance",
      "",
      "tool ReadInvoice",
      "    takes input as Text",
      "    gives Text",
      "    requires network",
      "",
      "skill SummarizeInvoice",
      "    takes input as Text",
      "    gives Text",
      "    uses ReadInvoice",
      "    do",
      "        human.approve",
      "            with context as input",
      "            into approval",
      "        give input",
      "",
      "agent InvoiceAgent",
      "    uses SummarizeInvoice",
      "    callable_by strategy RunInvoice",
      "",
      "strategy RunInvoice",
      "    takes input as Text",
      "    uses InvoiceAgent",
      "    do",
      "        InvoiceAgent",
      "",
      "trigger InvoiceWebhook",
      "    on request POST /invoice",
      "    run RunInvoice",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:demo.governance/ReadInvoice": {
          requires: ["network"],
          grants: ["network", "filesystem_read"],
          handler: {
            kind: "process",
            command: "node",
            args: ["handlers/read-invoice.handler.mjs"],
          },
          handler_package_ref: "package:demo.handlers",
          sandbox: {
            required: true,
          },
        },
      },
    }, null, 2), "utf8");
    writeFileSync(join(root, "touba.lock.json"), JSON.stringify({
      lock_schema_version: "touba-lock-v0.1",
      handlers: [
        {
          tool_ref: "tool:demo.governance/ReadInvoice",
          digest: { kind: "sha256", value: handlerDigest },
          handler_package: {
            kind: "local",
            name: "demo.handlers",
            version: "0.1.0",
            package_root: "handlers",
            entrypoint: "read-invoice.handler.mjs",
            files: [
              {
                path: "read-invoice.handler.mjs",
                digest: { kind: "sha256", value: handlerDigest },
              },
            ],
          },
        },
      ],
    }, null, 2), "utf8");
    writeFileSync(
      join(root, ".touba", "product-identity.json"),
      JSON.stringify(readJson("fixtures/valid/touba-product-identity-v0.1.json")),
      "utf8",
    );
    writeFileSync(join(root, ".touba", "studio-change-proposals.json"), JSON.stringify({
      schema_version: "touba-studio-change-proposals-v0.1",
      proposals: [
        {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "change_ops_1",
          status: "proposed",
          action: "write_text_file",
          target: { path: "touba.project.json" },
          requested_by: { kind: "studio", id: "touba-studio" },
          reason: "governance check",
          proposed_at: "2026-06-23T00:00:00.000Z",
          content: "{\"project_version\":\"touba-project-v1\"}",
          content_sha256: sha256("{\"project_version\":\"touba-project-v1\"}"),
          validations: [],
        },
      ],
    }), "utf8");
    writeFileSync(join(root, ".touba", "trigger-status.json"), JSON.stringify({
      schema_version: "touba-trigger-status-v1",
      generated_at: "2026-06-23T00:00:00.000Z",
      triggers: [
        {
          trigger_ref: "trigger:demo.governance/InvoiceWebhook",
          kind: "request",
          status: "enabled",
          next_run_at: null,
          limits: { max_runs_per_day: 3, timeout_ms: 30000 },
          state: { accepted_count: 3, refused_count: 1, last_event_id: "evt_000001" },
          queue: { pending: 1, processing: 0, dead_letter: 0 },
        },
      ],
    }), "utf8");
    appendProjectEventJournal({
      eventJournalPath: join(root, ".touba", "project-events.jsonl"),
      event: buildProjectEvent({
        type: "trigger.refused",
        sequence: 1,
        emittedAt: "2026-06-23T00:00:01.000Z",
        payload: {
          trigger_ref: "trigger:demo.governance/InvoiceWebhook",
          code: "TriggerReplayRejected",
        },
      }),
    });

    const supplyChain = buildSupplyChainStatus({
      projectRoot: root,
      generatedAt: "2026-06-23T00:00:02.000Z",
    });
    assertMatchesSchema("touba-supply-chain-status-v0.1", supplyChain);
    assert.equal(supplyChain.entries.find((entry) => entry.ref === "tool:demo.governance/ReadInvoice").status, "ok");

    const readiness = buildGovernanceReadiness({
      contractsRoot,
      projectRoot: root,
      productIdentityPath: join(root, ".touba", "product-identity.json"),
      changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
      generatedAt: "2026-06-23T00:00:02.000Z",
    });
    assertMatchesSchema("touba-governance-readiness-v0.1", readiness);
    assert.equal(readiness.artifacts.some((artifact) => artifact.kind === "trigger"), true);
    assert.equal(readiness.summary.pending_review > 0, true);

    const queueHealth = buildTriggerQueueHealth({
      contractsRoot,
      projectRoot: root,
      triggerStatusPath: join(root, ".touba", "trigger-status.json"),
      eventJournalPath: join(root, ".touba", "project-events.jsonl"),
      generatedAt: "2026-06-23T00:00:02.000Z",
    });
    assertMatchesSchema("touba-trigger-queue-health-v0.1", queueHealth);
    assert.equal(queueHealth.triggers[0].status, "watch");
    assert.equal(queueHealth.triggers[0].replay_rejected, 1);

    const sandbox = buildHandlerSandboxStatus({
      contractsRoot,
      projectRoot: root,
      platform: "darwin",
      generatedAt: "2026-06-23T00:00:02.000Z",
    });
    assertMatchesSchema("touba-handler-sandbox-status-v0.1", sandbox);
    assert.equal(sandbox.handlers[0].tool_ref, "tool:demo.governance/ReadInvoice");
    assert.equal(sandbox.handlers[0].status, "isolated");
    assert.equal(sandbox.handlers[0].mechanism, "sandbox-exec");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("product identity surface reads fixture and project identity stores", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-identity-"));
  try {
    const productIdentityPath = join(root, ".touba", "product-identity.json");
    const fixture = readProductIdentity({ contractsRoot, productIdentityPath });
    assertMatchesSchema("touba-product-identity-v0.1", fixture);
    assert.equal(fixture.summary.user_count, 2);
    assert.equal(fixture.assignments[0].run_id, "run_20260622_001");

    mkdirSync(join(root, ".touba"), { recursive: true });
    const stored = {
      ...fixture,
      generated_at: "2026-06-23T01:00:00.000Z",
      users: fixture.users.slice(0, 1),
      summary: {
        ...fixture.summary,
        user_count: 1,
      },
    };
    writeFileSync(productIdentityPath, JSON.stringify(stored), "utf8");
    const identity = readProductIdentity({ contractsRoot, productIdentityPath });
    assertMatchesSchema("touba-product-identity-v0.1", identity);
    assert.equal(identity.summary.user_count, 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("observability and mobile product surfaces read fixture contracts", () => {
  const costs = readCostObservatory({
    contractsRoot,
    costObservatoryPath: join(tmpdir(), "missing-cost-observatory.json"),
  });
  const notifications = readMobileNotifications({
    contractsRoot,
    mobileNotificationsPath: join(tmpdir(), "missing-mobile-notifications.json"),
  });
  const quickApproval = readMobileQuickApprovalPolicy({
    contractsRoot,
    mobileQuickApprovalPolicyPath: join(tmpdir(), "missing-mobile-quick-approval-policy.json"),
  });
  const escalation = readMobileEscalation({
    contractsRoot,
    mobileEscalationPath: join(tmpdir(), "missing-mobile-escalation.json"),
  });

  assertMatchesSchema("touba-cost-observatory-v0.1", costs);
  assertMatchesSchema("touba-mobile-notification-v0.1", notifications);
  assertMatchesSchema("touba-mobile-quick-approval-policy-v0.1", quickApproval);
  assertMatchesSchema("touba-mobile-escalation-v0.1", escalation);
  assert.equal(costs.summary.estimate_basis.includes("estimate"), true);
  assert.equal(notifications.notifications.every((item) => !JSON.stringify(item).includes("FAKE_SECRET")), true);
  assert.equal(quickApproval.require_biometric, true);
  assert.equal(escalation.assignments[0].backup_reviewer_ref, "user:soukaina");
});

test("mobile pairing requests are bounded, accepted once and revocable without persisting raw secrets", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-mobile-pairing-"));
  try {
    const mobilePairingsPath = join(root, ".touba", "mobile-pairings.json");
    const issued = issueMobilePairingRequest({
      contractsRoot,
      mobilePairingsPath,
      serverUrl: "http://127.0.0.1:8791",
      issuedAt: "2026-06-23T12:00:00.000Z",
      request: {
        pairing_id: "pair_test_001",
        device_ref: "device:phone-01",
        user_ref: "user:khadim",
        expires_at: "2026-06-23T12:05:00.000Z",
        scopes: ["decisions:write", "approvals:read"],
      },
    });

    assertMatchesSchema("touba-mobile-pairing-request-v0.1", issued);
    assert.match(issued.deep_link, /^touba-mobile:\/\/pair\?/u);
    const storeText = readFileSync(mobilePairingsPath, "utf8");
    assert.equal(storeText.includes(issued.bearer_token), false);
    assert.equal(storeText.includes(issued.nonce), false);

    const accepted = acceptMobilePairing({
      contractsRoot,
      mobilePairingsPath,
      pairingRequest: issued,
      acceptedAt: "2026-06-23T12:01:00.000Z",
    });
    assert.equal(accepted.status, "accepted");
    assert.equal(accepted.device_ref, "device:phone-01");

    assert.throws(
      () => acceptMobilePairing({
        contractsRoot,
        mobilePairingsPath,
        pairingRequest: issued,
        acceptedAt: "2026-06-23T12:02:00.000Z",
      }),
      /already been accepted/,
    );

    const revoked = revokeMobilePairing({
      mobilePairingsPath,
      deviceRef: "device:phone-01",
      revokedBy: { kind: "user", id: "khadim" },
      reason: "device replaced",
      revokedAt: "2026-06-23T12:03:00.000Z",
    });
    assert.equal(revoked.status, "revoked");
    assert.equal(revoked.reason, "device replaced");

    assert.throws(
      () => issueMobilePairingRequest({
        contractsRoot,
        mobilePairingsPath: join(root, ".touba", "mobile-pairings-invalid-scope.json"),
        serverUrl: "http://127.0.0.1:8791",
        issuedAt: "2026-06-23T12:00:00.000Z",
        request: { scopes: ["filesystem:write"] },
      }),
      /not allowed/,
    );

    const expired = issueMobilePairingRequest({
      contractsRoot,
      mobilePairingsPath: join(root, ".touba", "mobile-pairings-expired.json"),
      serverUrl: "http://127.0.0.1:8791",
      issuedAt: "2026-06-23T12:00:00.000Z",
      request: {
        pairing_id: "pair_expired",
        device_ref: "device:expired",
        expires_at: "2026-06-23T12:01:00.000Z",
      },
    });
    assert.throws(
      () => acceptMobilePairing({
        contractsRoot,
        mobilePairingsPath: join(root, ".touba", "mobile-pairings-expired.json"),
        pairingRequest: expired,
        acceptedAt: "2026-06-23T12:02:00.000Z",
      }),
      /expired/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("pending human request store filters decisions already accepted", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-human-requests-"));
  try {
    const humanRequestsPath = join(root, ".touba", "human-requests.json");
    const humanDecisionsPath = join(root, ".touba", "human-decisions.json");
    const approval = readJson("fixtures/valid/touba-approval-request-v1.json");
    mkdirSync(join(root, ".touba"), { recursive: true });
    writeFileSync(
      humanRequestsPath,
      JSON.stringify({
        schema_version: "touba-human-requests-v0.1",
        approvals: [approval],
        reviews: [],
      }),
      "utf8",
    );
    const pending = readPendingHumanRequest({
      contractsRoot,
      humanRequestsPath,
      humanDecisionsPath,
      kind: "approval",
    });
    assert.equal(pending.request_id, approval.request_id);

    acceptDecision({
      contractsRoot,
      humanDecisionsPath,
      decision: {
        schema_version: "touba-approval-decision-v1",
        request_id: approval.request_id,
        run_id: approval.run_id,
        trace_ref: approval.trace_ref,
        user_ref: "user:khadim",
        device_ref: "device:review-phone-01",
        decision: "approve",
        decided_by: "user:khadim",
        decided_at: "2026-06-23T00:00:00.000Z",
        comment: null,
        client_ref: "touba-mobile",
      },
    });
    assert.throws(
      () => readPendingHumanRequest({
        contractsRoot,
        humanRequestsPath,
        humanDecisionsPath,
        kind: "approval",
      }),
      /no pending/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("refresh project reports artifacts, stale state and changed files", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-refresh-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n", "utf8");
    const first = refreshProject({
      projectRoot: root,
      refreshedAt: "2026-06-22T00:00:00Z",
      request: { schema_version: "touba-project-refresh-request-v0.1" },
    });
    assert.equal(first.report.schema_version, "touba-project-refresh-v0.1");
    assert.equal(first.report.summary.artifact_count, 1);
    assert.equal(first.report.changes.changed_artifacts.length, 1);
    assert.equal(first.report.diagnostics.some((item) => item.code === "ToubaServeProjectAirStale"), true);

    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n// changed\n", "utf8");
    const second = refreshProject({
      projectRoot: root,
      previousSnapshot: first.snapshot,
      refreshedAt: "2026-06-22T00:00:01Z",
      request: { schema_version: "touba-project-refresh-request-v0.1" },
    });
    assert.deepEqual(second.report.changes.changed_artifacts.map((item) => item.relative_path), ["src/main.tb"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change proposals are stored, applied atomically and cannot be replayed", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-change-"));
  try {
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    const proposed = proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-06-22T00:00:00Z",
      proposal: {
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "change_001",
        action: "write_text_file",
        target: { path: "src/main.tb" },
        requested_by: { kind: "user", id: "khadim" },
        content: "module demo.main\n",
      },
    });
    assert.equal(proposed.status, "proposed");
    assert.equal(existsSync(changeProposalsPath), true);

    const applied = applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      decidedAt: "2026-06-22T00:00:01Z",
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "change_001",
        decision: "apply",
        decided_by: { kind: "user", id: "khadim" },
      },
    });
    assert.equal(applied.status, "applied");
    assert.equal(readFileSync(join(root, "src", "main.tb"), "utf8"), "module demo.main\n");
    assert.throws(
      () => applyProjectChange({
        projectRoot: root,
        changeProposalsPath,
        applyRequest: {
          schema_version: "touba-project-change-apply-v0.1",
          proposal_id: "change_001",
          decision: "apply",
        },
      }),
      /no longer pending/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change history reports pending, applied and refused proposals without raw content", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-history-"));
  try {
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-06-23T00:00:00.000Z",
      proposal: {
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "pending_change",
        action: "write_text_file",
        target: { path: "src/pending.tb" },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "keep pending",
        content: "module demo.pending\n",
      },
    });
    proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-06-23T00:00:01.000Z",
      proposal: {
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "applied_change",
        action: "write_text_file",
        target: { path: "src/applied.tb" },
        requested_by: { kind: "user", id: "khadim" },
        reason: "apply this",
        content: "module demo.applied\n",
      },
    });
    applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      decidedAt: "2026-06-23T00:00:02.000Z",
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "applied_change",
        decision: "apply",
        decided_by: { kind: "user", id: "khadim" },
        reason: "approved",
      },
    });
    proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-06-23T00:00:03.000Z",
      proposal: {
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "refused_change",
        action: "write_text_file",
        target: { path: "src/refused.tb" },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "refuse this",
        content: "module demo.refused\n",
      },
    });
    applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      decidedAt: "2026-06-23T00:00:04.000Z",
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "refused_change",
        decision: "refuse",
        decided_by: { kind: "user", id: "khadim" },
        reason: "not acceptable",
      },
    });

    const history = listProjectChanges({
      projectRoot: root,
      changeProposalsPath,
      generatedAt: "2026-06-23T00:00:05.000Z",
    });
    assertMatchesSchema("touba-project-change-history-v0.1", history);
    assert.deepEqual(history.summary, { total: 3, pending: 1, applied: 1, refused: 1 });
    assert.equal(JSON.stringify(history).includes("module demo"), false);
    assert.deepEqual(new Set(history.changes.map((item) => item.status)), new Set(["pending", "applied", "refused"]));

    const detail = getProjectChangeDetail({
      projectRoot: root,
      changeProposalsPath,
      proposalId: "applied_change",
      generatedAt: "2026-06-23T00:00:06.000Z",
    });
    assertMatchesSchema("touba-project-change-detail-v0.1", detail);
    assert.equal(detail.change.status, "applied");
    assert.equal(detail.change.evidence.write_mode, "atomic_rename");
    assert.equal(detail.change.decision_reason, "approved");
    assert.equal(JSON.stringify(detail).includes("module demo"), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change detail rejects unknown proposal ids", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-history-missing-"));
  try {
    assert.throws(
      () => getProjectChangeDetail({
        projectRoot: root,
        changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
        proposalId: "missing",
      }),
      /unknown/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change proposals reject unsafe paths and invalid Touba JSON metadata", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-reject-"));
  try {
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "escape",
          action: "write_text_file",
          target: { path: "../outside.tb" },
          content: "module bad",
        },
      }),
      /escapes the project root/,
    );
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "bad_json",
          action: "write_text_file",
          target: { path: "touba.manifest.json" },
          content: "{not-json",
        },
      }),
      /failed validation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change proposals validate Touba project metadata schemas before review", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-metadata-"));
  try {
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "bad_manifest",
          action: "write_text_file",
          target: { path: "touba.manifest.json" },
          requested_by: { kind: "studio", id: "touba-studio" },
          content: JSON.stringify({ bindings: [] }),
        },
      }),
      /failed validation/,
    );
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "bad_ownership",
          action: "write_text_file",
          target: { path: "touba.ownership.json" },
          requested_by: { kind: "studio", id: "touba-studio" },
          content: JSON.stringify({
            ownership_schema_version: "touba-ownership-v0.1",
            grants: ["network"],
          }),
        },
      }),
      /failed validation/,
    );
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "bad_resources",
          action: "write_text_file",
          target: { path: "touba.resources.json" },
          requested_by: { kind: "studio", id: "touba-studio" },
          content: JSON.stringify({
            resource_bindings_schema_version: "touba-resource-bindings-v0.1",
          }),
        },
      }),
      /failed validation/,
    );

    const accepted = proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposal: {
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "package_ok",
        action: "write_text_file",
        target: { path: "touba.package.json" },
        requested_by: { kind: "studio", id: "touba-studio" },
        content: JSON.stringify({
          package_schema_version: "touba-package-v0.1",
          name: "org.example.demo",
          version: "0.1.0",
          exports: {
            agents: [],
            skills: [],
            tools: [],
          },
        }),
      },
    });
    assert.equal(accepted.status, "proposed");
    assert.equal(accepted.validations[0].code, "ToubaServeChangeContentValidated");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change proposals allow guarded handler stubs but reject arbitrary handler code", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-handler-stub-"));
  try {
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    const accepted = proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposal: {
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "handler_stub_ok",
        action: "write_text_file",
        target: { path: "handlers/studio/studio_draft_tool.handler.mjs" },
        requested_by: { kind: "studio", id: "touba-studio" },
        content: [
          "#!/usr/bin/env node",
          "// Touba Studio generated handler stub v0.1",
          "const chunks = [];",
          "for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));",
          "const response = {",
          "  protocol: \"touba-tool-handler-v1\",",
          "  ok: false,",
          "  error: {",
          "    code: \"HandlerStubNotImplemented\",",
          "    message: \"Complete this handler before binding it.\"",
          "  }",
          "};",
          "process.stdout.write(`${JSON.stringify(response)}\\n`);",
          "",
        ].join("\n"),
      },
    });
    assert.equal(accepted.status, "proposed");

    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "handler_arbitrary",
          action: "write_text_file",
          target: { path: "handlers/studio/arbitrary.handler.mjs" },
          requested_by: { kind: "studio", id: "touba-studio" },
          content: [
            "// Touba Studio generated handler stub v0.1",
            "import { readFileSync } from 'node:fs';",
            "process.stdout.write(process.env.SECRET);",
            "",
          ].join("\n"),
        },
      }),
      /failed validation/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("accepts valid decisions and rejects replay", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-"));
  try {
    const humanDecisionsPath = join(root, "human-decisions.json");
    const decision = readJson("fixtures/valid/touba-approval-decision-v1.json");
    const accepted = acceptDecision({
      contractsRoot,
      humanDecisionsPath,
      decision,
      acceptedAt: "2026-06-22T00:00:00Z",
    });

    assert.equal(accepted.status, "accepted");
    const store = JSON.parse(readFileSync(humanDecisionsPath, "utf8"));
    assert.equal(store.schema_version, "touba-human-decisions-v0.1");
    assert.equal(store.decisions.length, 1);
    assert.throws(
      () => acceptDecision({ contractsRoot, humanDecisionsPath, decision }),
      /already stored/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("human decision history reports approval and review decisions", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-decisions-"));
  try {
    const humanDecisionsPath = join(root, "human-decisions.json");
    const approval = readJson("fixtures/valid/touba-approval-decision-v1.json");
    const review = readJson("fixtures/valid/touba-human-review-decision-v1.json");
    acceptDecision({
      contractsRoot,
      humanDecisionsPath,
      decision: approval,
      acceptedAt: "2026-06-23T00:00:00.000Z",
    });
    acceptDecision({
      contractsRoot,
      humanDecisionsPath,
      decision: review,
      acceptedAt: "2026-06-23T00:00:01.000Z",
    });

    const history = listHumanDecisions({
      humanDecisionsPath,
      generatedAt: "2026-06-23T00:00:02.000Z",
    });
    assertMatchesSchema("touba-human-decision-history-v0.1", history);
    assert.deepEqual(history.summary, { total: 2, approvals: 1, reviews: 1 });
    assert.deepEqual(new Set(history.decisions.map((item) => item.decision_kind)), new Set(["approval", "human_review"]));

    const detail = getHumanDecisionDetail({
      humanDecisionsPath,
      schemaVersion: "touba-human-review-decision-v1",
      requestId: review.request_id,
      generatedAt: "2026-06-23T00:00:03.000Z",
    });
    assertMatchesSchema("touba-human-decision-detail-v0.1", detail);
    assert.equal(detail.decision.decision_kind, "human_review");
    assert.equal(detail.decision.result, review.outcome);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("human decision detail rejects unknown decision ids", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-decisions-missing-"));
  try {
    assert.throws(
      () => getHumanDecisionDetail({
        humanDecisionsPath: join(root, "human-decisions.json"),
        schemaVersion: "touba-approval-decision-v1",
        requestId: "missing",
      }),
      /unknown/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server rejects invalid client and Mobile contract payloads", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-contracts-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.contracts\n", "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.json"),
    changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const decision = readJson("fixtures/valid/touba-approval-decision-v1.json");

    const unsupportedDecision = await postJson(`${baseUrl}/decisions`, {
      ...decision,
      schema_version: "touba-approval-decision-v9",
    });
    assert.equal(unsupportedDecision.status, 400);
    assert.equal((await unsupportedDecision.json()).code, "ToubaServeDecisionContractUnsupported");

    const extraFieldDecision = await postJson(`${baseUrl}/decisions`, {
      ...decision,
      raw_secret: "FAKE_SECRET_SHOULD_NOT_PASS",
    });
    assert.equal(extraFieldDecision.status, 400);
    const invalidDecision = await extraFieldDecision.json();
    assert.equal(invalidDecision.code, "ToubaServeDecisionInvalid");
    assert.equal(JSON.stringify(invalidDecision).includes("FAKE_SECRET_SHOULD_NOT_PASS"), false);

    const validDecision = await postJson(`${baseUrl}/decisions`, decision);
    assert.equal(validDecision.status, 202);
    const replayDecision = await postJson(`${baseUrl}/decisions`, decision);
    assert.equal(replayDecision.status, 409);
    assert.equal((await replayDecision.json()).code, "ToubaServeDecisionReplayRejected");

    const proposal = {
      schema_version: "touba-project-change-proposal-v0.1",
      proposal_id: "contract_change_001",
      action: "write_text_file",
      target: { path: "src/main.tb" },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "contract validation test",
      content: "module demo.contracts\n",
    };
    const invalidProposal = await postJson(`${baseUrl}/changes/propose`, {
      ...proposal,
      uncontracted_field: "not allowed",
    });
    assert.equal(invalidProposal.status, 400);
    assert.equal((await invalidProposal.json()).code, "ToubaServeChangeInvalid");

    const proposed = await postJson(`${baseUrl}/changes/propose`, proposal);
    assert.equal(proposed.status, 202);
    const duplicateProposal = await postJson(`${baseUrl}/changes/propose`, proposal);
    assert.equal(duplicateProposal.status, 409);
    assert.equal((await duplicateProposal.json()).code, "ToubaServeChangeProposalDuplicate");

    const invalidApply = await postJson(`${baseUrl}/changes/apply`, {
      schema_version: "touba-project-change-apply-v0.1",
      proposal_id: proposal.proposal_id,
      decision: "apply",
      decided_by: { kind: "studio", id: "touba-studio" },
      reason: "contract validation test",
      raw_payload: "not allowed",
    });
    assert.equal(invalidApply.status, 400);
    assert.equal((await invalidApply.json()).code, "ToubaServeChangeApplyInvalid");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server exposes live state, events and decisions", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.main\n", "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.json"),
    changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.status, "ok");
    assert.equal(health.service, "touba-project-server");
    assert.equal(health.endpoints.events, "/events");
    assert.equal(health.endpoints.trigger_queue_health, "/triggers/queue-health");
    assert.equal(health.endpoints.supply_chain_status, "/supply-chain/status");
    assert.equal(health.endpoints.governance_readiness, "/governance/readiness");

    const state = await getJson(`${baseUrl}/state`);
    assert.equal(state.schema_version, "touba-project-live-state-v0.1");
    assert.equal(state.project_server.refresh.summary.artifact_count, 1);

    const project = await getJson(`${baseUrl}/project`);
    assert.equal(project.schema_version, "touba-project-inspection-v1");

    const authorityGraph = await getJson(`${baseUrl}/authority/graph`);
    assertMatchesSchema("touba-authority-graph-v0.1", authorityGraph);
    assert.equal(health.endpoints.authority_graph, "/authority/graph");

    const identity = await getJson(`${baseUrl}/identity`);
    assertMatchesSchema("touba-product-identity-v0.1", identity);
    assert.equal(health.endpoints.identity, "/identity");

    const runSummary = await getJson(`${baseUrl}/runs/current`);
    assert.equal(runSummary.schema_version, "touba-run-summary-v1");

    const triggerQueueHealth = await getJson(`${baseUrl}/triggers/queue-health`);
    assertMatchesSchema("touba-trigger-queue-health-v0.1", triggerQueueHealth);
    const supplyChainStatus = await getJson(`${baseUrl}/supply-chain/status`);
    assertMatchesSchema("touba-supply-chain-status-v0.1", supplyChainStatus);
    const governanceReadiness = await getJson(`${baseUrl}/governance/readiness`);
    assertMatchesSchema("touba-governance-readiness-v0.1", governanceReadiness);

    const eventStream = await fetch(`${baseUrl}/events`);
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.headers.get("content-type"), /text\/event-stream/);
    const { text: readyText, reader } = await readNextEvent(eventStream);
    const readyEvent = parseSseEvent(readyText);
    assertMatchesSchema("touba-project-event-v0.1", readyEvent);
    assert.equal(readyEvent.type, "touba.server.ready");
    assert.match(readyText, /^id: evt_000001/m);

    const decision = readJson("fixtures/valid/touba-human-review-decision-v1.json");
    const response = await fetch(`${baseUrl}/decisions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(decision),
    });
    assert.equal(response.status, 202);
    const accepted = await response.json();
    assert.equal(accepted.request_id, decision.request_id);

    const replayStream = await fetch(`${baseUrl}/events`, {
      headers: { "last-event-id": readyEvent.event_id },
    });
    assert.equal(replayStream.status, 200);
    const { text: replayText, reader: replayReader } = await readNextEvent(replayStream);
    const replayedEvent = parseSseEvent(replayText);
    assertMatchesSchema("touba-project-event-v0.1", replayedEvent);
    assert.equal(replayedEvent.type, "human_decision.accepted");
    await replayReader.cancel();

    const decisionHistory = await getJson(`${baseUrl}/decisions`);
    assertMatchesSchema("touba-human-decision-history-v0.1", decisionHistory);
    assert.equal(decisionHistory.summary.reviews, 1);

    const decisionDetail = await getJson(`${baseUrl}/decisions/${encodeURIComponent(decision.schema_version)}/${encodeURIComponent(decision.request_id)}`);
    assertMatchesSchema("touba-human-decision-detail-v0.1", decisionDetail);
    assert.equal(decisionDetail.decision.request_id, decision.request_id);
    assert.equal(decisionDetail.decision.decision_kind, "human_review");

    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n// refresh\n", "utf8");
    const refreshResponse = await fetch(`${baseUrl}/project/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-refresh-request-v0.1",
        requested_by: { kind: "studio", id: "test-suite" },
        reason: "http-test-refresh",
      }),
    });
    assert.equal(refreshResponse.status, 202);
    const refresh = await refreshResponse.json();
    assertMatchesSchema("touba-project-refresh-v0.1", refresh);
    assert.deepEqual(refresh.changes.changed_artifacts.map((item) => item.relative_path), ["src/main.tb"]);

    const proposedResponse = await fetch(`${baseUrl}/changes/propose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "http_change_001",
        action: "write_text_file",
        target: { path: "touba.project.json" },
        requested_by: { kind: "user", id: "khadim" },
        reason: "http change test",
        content: JSON.stringify({ project_version: "touba-project-v1", language: "javascript" }, null, 2),
      }),
    });
    assert.equal(proposedResponse.status, 202);
    const proposed = await proposedResponse.json();
    assertMatchesSchema("touba-project-change-proposed-v0.1", proposed);
    assert.equal(proposed.status, "proposed");

    const pendingHistory = await getJson(`${baseUrl}/changes`);
    assertMatchesSchema("touba-project-change-history-v0.1", pendingHistory);
    assert.equal(pendingHistory.summary.pending, 1);

    const pendingDetail = await getJson(`${baseUrl}/changes/http_change_001`);
    assertMatchesSchema("touba-project-change-detail-v0.1", pendingDetail);
    assert.equal(pendingDetail.change.status, "pending");
    assert.equal(JSON.stringify(pendingDetail).includes("project_version"), false);

    const applyResponse = await fetch(`${baseUrl}/changes/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "http_change_001",
        decision: "apply",
        decided_by: { kind: "user", id: "khadim" },
        reason: "http apply test",
      }),
    });
    assert.equal(applyResponse.status, 202);
    const applied = await applyResponse.json();
    assertMatchesSchema("touba-project-change-result-v0.1", applied);
    assert.equal(applied.status, "applied");
    assert.equal(existsSync(join(root, "touba.project.json")), true);

    const appliedHistory = await getJson(`${baseUrl}/changes`);
    assertMatchesSchema("touba-project-change-history-v0.1", appliedHistory);
    assert.equal(appliedHistory.summary.applied, 1);

    const appliedDetail = await getJson(`${baseUrl}/changes/http_change_001`);
    assertMatchesSchema("touba-project-change-detail-v0.1", appliedDetail);
    assert.equal(appliedDetail.change.status, "applied");
    assert.equal(appliedDetail.change.evidence.write_mode, "atomic_rename");

    const { text: eventText } = await readNextEventFromReader(reader);
    const emittedEvent = parseSseEvent(eventText);
    assertMatchesSchema("touba-project-event-v0.1", emittedEvent);
    assert.match(eventText, /touba\.server\.ready|human_decision\.accepted|project\.changed|change\.proposed|change\.applied/);
    await reader.cancel();
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server requires bearer auth when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-auth-"));
  const previous = process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN;
  process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN = "secret-token";
  const service = createToubaProjectServer({
    authTokenEnv: "TOUBA_TEST_PROJECT_SERVER_TOKEN",
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.json"),
    changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const unauthorized = await fetch(`${baseUrl}/state`);
    assert.equal(unauthorized.status, 401);

    const wrongShortToken = await fetch(`${baseUrl}/state`, {
      headers: { authorization: "Bearer secret" },
    });
    assert.equal(wrongShortToken.status, 401);

    const wrongSameLengthToken = await fetch(`${baseUrl}/state`, {
      headers: { authorization: "Bearer secret-tokem" },
    });
    assert.equal(wrongSameLengthToken.status, 401);

    const unauthorizedEvents = await fetch(`${baseUrl}/events`);
    assert.equal(unauthorizedEvents.status, 401);
    assert.equal((await unauthorizedEvents.json()).code, "ToubaServeUnauthorized");

    const wrongEventsToken = await fetch(`${baseUrl}/events`, {
      headers: { authorization: "Bearer secret-tokem" },
    });
    assert.equal(wrongEventsToken.status, 401);

    const authorized = await fetch(`${baseUrl}/state`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(authorized.status, 200);
    const state = await authorized.json();
    assert.equal(state.schema_version, "touba-project-live-state-v0.1");

    const unauthorizedPairingIssue = await fetch(`${baseUrl}/mobile/pairings/request`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ device_ref: "device:mobile-http" }),
    });
    assert.equal(unauthorizedPairingIssue.status, 401);

    const issuedResponse = await fetch(`${baseUrl}/mobile/pairings/request`, {
      method: "POST",
      headers: {
        authorization: "Bearer secret-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        pairing_id: "pair_http_001",
        device_ref: "device:mobile-http",
        user_ref: "user:khadim",
        scopes: ["notifications:read", "decisions:write"],
      }),
    });
    assert.equal(issuedResponse.status, 201);
    const issued = await issuedResponse.json();
    assertMatchesSchema("touba-mobile-pairing-request-v0.1", issued);

    const acceptedResponse = await fetch(`${baseUrl}/mobile/pairings/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(issued),
    });
    assert.equal(acceptedResponse.status, 202);
    const accepted = await acceptedResponse.json();
    assert.equal(accepted.status, "accepted");

    const replayResponse = await fetch(`${baseUrl}/mobile/pairings/accept`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(issued),
    });
    assert.equal(replayResponse.status, 409);
    assert.equal((await replayResponse.json()).code, "ToubaServeMobilePairingReplayRejected");

    const mobileAuthorized = await fetch(`${baseUrl}/mobile/notifications`, {
      headers: { authorization: `Bearer ${issued.bearer_token}` },
    });
    assert.equal(mobileAuthorized.status, 200);

    const revokedResponse = await fetch(`${baseUrl}/mobile/pairings/revoke`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.bearer_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        device_ref: "device:mobile-http",
        revoked_by: { kind: "user", id: "khadim" },
        reason: "test revocation",
      }),
    });
    assert.equal(revokedResponse.status, 202);
    assert.equal((await revokedResponse.json()).status, "revoked");

    const revokedTokenResponse = await fetch(`${baseUrl}/mobile/notifications`, {
      headers: { authorization: `Bearer ${issued.bearer_token}` },
    });
    assert.equal(revokedTokenResponse.status, 401);

    const eventStream = await fetch(`${baseUrl}/events`, {
      headers: { authorization: "Bearer secret-token" },
    });
    assert.equal(eventStream.status, 200);
    const { text, reader } = await readNextEvent(eventStream);
    assert.equal(parseSseEvent(text).schema_version, "touba-project-event-v0.1");
    await reader.cancel();
  } finally {
    await service.stop();
    if (previous === undefined) {
      delete process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN;
    } else {
      process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

async function getJson(url) {
  const response = await fetch(url);
  assert.equal(response.status, 200);
  return response.json();
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function readNextEvent(response) {
  const reader = response.body.getReader();
  const result = await readNextEventFromReader(reader);
  return { ...result, reader };
}

async function readNextEventFromReader(reader) {
  const decoder = new TextDecoder();
  let text = "";
  while (!text.includes("\n\n")) {
    const chunk = await reader.read();
    if (chunk.done) break;
    text += decoder.decode(chunk.value, { stream: true });
  }
  return { text };
}

function readJson(relativePath) {
  return JSON.parse(readFileSync(join(contractsRoot, relativePath), "utf8"));
}

function assertMatchesSchema(schemaVersion, value) {
  const schema = readJson(`schemas/${schemaVersion}.schema.json`);
  const diagnostics = validateObject(schema, value);
  assert.deepEqual(diagnostics, []);
}

function sha256(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function parseSseEvent(text) {
  const dataLine = text.split(/\r?\n/u).find((line) => line.startsWith("data: "));
  assert.ok(dataLine, `SSE event has no data line: ${text}`);
  return JSON.parse(dataLine.slice("data: ".length));
}
