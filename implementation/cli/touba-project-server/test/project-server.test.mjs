import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  acceptMobilePairing,
  acceptDecision,
  authorizeHumanIdentity,
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
  buildProjectDeploymentPlan,
  buildTriggerQueueHealth,
  createToubaProjectServer,
  getProjectChangeDetail,
  getHumanDecisionDetail,
  issueMobilePairingRequest,
  appendProjectEventJournal,
  listHumanDecisions,
  listProjectChanges,
  loadOptionalProjectSecretStore,
  preflightServeOptions,
  proposeProjectChange,
  proposeProjectChangeSet,
  proposeGovernanceRelationChange,
  requiredIdentityPermission,
  recoverProjectChangeTransactions,
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
import { createDeploymentTargetService } from "../../touba-deployment/src/serve.mjs";
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

test("project sandbox secret profiles resolve handles from the server environment", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-secrets-"));
  const path = join(root, "touba.secrets.dev.json");
  const previous = process.env.TOUBA_PROJECT_SERVER_TEST_SECRET;
  process.env.TOUBA_PROJECT_SERVER_TEST_SECRET = "server-secret-value";
  writeFileSync(path, JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      TEST_HANDLE: {
        source: "env",
        name: "TOUBA_PROJECT_SERVER_TEST_SECRET",
      },
    },
  }), "utf8");

  try {
    const store = loadOptionalProjectSecretStore({
      projectRoot: root,
      required: true,
      secretsPath: path,
    });
    assert.equal(store.has("TEST_HANDLE"), true);
    assert.equal(store.valueFor("TEST_HANDLE"), "server-secret-value");
    assert.throws(
      () => loadOptionalProjectSecretStore({
        projectRoot: root,
        required: true,
        secretsPath: join(root, "missing.json"),
      }),
      (error) => error.code === "ToubaServeSandboxSecretsMissing",
    );
  } finally {
    if (previous === undefined) {
      delete process.env.TOUBA_PROJECT_SERVER_TEST_SECRET;
    } else {
      process.env.TOUBA_PROJECT_SERVER_TEST_SECRET = previous;
    }
    rmSync(root, { recursive: true, force: true });
  }
});

test("human identity permissions map project reads and governed actions", () => {
  assert.equal(requiredIdentityPermission("GET", "/health"), null);
  assert.equal(requiredIdentityPermission("GET", "/state"), "projects.read");
  assert.equal(requiredIdentityPermission("GET", "/events"), "executions.read");
  assert.equal(requiredIdentityPermission("POST", "/runs/sandbox"), "executions.run");
  assert.equal(requiredIdentityPermission("POST", "/decisions"), "decisions.act");
  assert.equal(requiredIdentityPermission("GET", "/decisions"), "decisions.read");
  assert.equal(requiredIdentityPermission("POST", "/changes/propose"), "governance.propose");
  assert.equal(requiredIdentityPermission("POST", "/changes/apply"), "governance.apply");
  assert.equal(requiredIdentityPermission("POST", "/deployments/publish"), "deployments.publish");
});

test("human identity introspection separates active sessions from permissions", async () => {
  const accepted = await authorizeHumanIdentity({
    accessToken: "identity-access",
    controlPlaneUrl: "https://identity.example.test",
    permission: "projects.read",
    serviceToken: "service-secret",
    fetchImpl: async (_url, init) => {
      assert.equal(init.headers["x-touba-service-token"], "service-secret");
      assert.deepEqual(JSON.parse(init.body), { access_token: "identity-access" });
      return new Response(JSON.stringify({
        active: true,
        permissions: ["projects.read"],
        user: { id: "user-1" },
      }), { status: 200 });
    },
  });
  assert.equal(accepted.active, true);
  assert.equal(accepted.allowed, true);

  const denied = await authorizeHumanIdentity({
    accessToken: "identity-access",
    controlPlaneUrl: "https://identity.example.test",
    permission: "governance.apply",
    serviceToken: "service-secret",
    fetchImpl: async () => new Response(JSON.stringify({
      active: true,
      permissions: ["projects.read"],
    }), { status: 200 }),
  });
  assert.equal(denied.active, false);
  assert.equal(denied.allowed, false);
});

test("HTTP project server enforces human sessions and permissions", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-identity-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.identity\n", "utf8");
  const serviceToken = "identity-service-token-at-least-32-characters";
  const identityServer = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    assert.equal(request.headers["x-touba-service-token"], serviceToken);
    const permissions = body.access_token === "viewer-token"
      ? ["projects.read"]
      : body.access_token === "operator-token"
        ? ["projects.read", "projects.manage"]
        : body.access_token === "governor-token"
          ? ["projects.read", "governance.propose"]
        : [];
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({
      active: permissions.length > 0,
      permissions,
      user: { id: "human-1" },
    }));
  });
  await listenHttpServer(identityServer);
  const identityAddress = identityServer.address();
  const projectServer = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    port: 0,
    quiet: true,
    identityControlPlaneUrl: `http://127.0.0.1:${identityAddress.port}`,
    identityServiceToken: serviceToken,
  });
  try {
    await projectServer.start();
    const baseUrl = `http://127.0.0.1:${projectServer.server.address().port}`;

    assert.equal((await fetch(`${baseUrl}/health`)).status, 200);
    const anonymous = await fetch(`${baseUrl}/state`);
    assert.equal(anonymous.status, 401);
    assert.equal((await anonymous.json()).code, "ToubaServeIdentityUnauthorized");

    const viewerRead = await fetch(`${baseUrl}/state`, {
      headers: { "x-touba-identity-token": "viewer-token" },
    });
    assert.equal(viewerRead.status, 200);

    const viewerWrite = await fetch(`${baseUrl}/project/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-identity-token": "viewer-token",
      },
      body: JSON.stringify({
        schema_version: "touba-project-refresh-request-v0.1",
        reason: "identity-test",
        requested_by: { kind: "studio", id: "identity-test" },
      }),
    });
    assert.equal(viewerWrite.status, 403);
    assert.equal((await viewerWrite.json()).code, "ToubaServeIdentityPermissionDenied");

    const operatorWrite = await fetch(`${baseUrl}/project/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-identity-token": "operator-token",
      },
      body: JSON.stringify({
        schema_version: "touba-project-refresh-request-v0.1",
        reason: "identity-test",
        requested_by: { kind: "studio", id: "identity-test" },
      }),
    });
    assert.equal(operatorWrite.status, 202);

    const proposed = await fetch(`${baseUrl}/changes/propose`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-identity-token": "governor-token",
      },
      body: JSON.stringify({
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "identity_actor_binding",
        action: "write_text_file",
        target: { path: "src/identity-note.tb" },
        requested_by: { kind: "user", id: "spoofed-user" },
        reason: "verify server-derived human identity",
        content: "module demo.identity_note\n",
      }),
    });
    assert.equal(proposed.status, 202);
    assert.deepEqual((await proposed.json()).requested_by, {
      kind: "user",
      id: "human-1",
    });
  } finally {
    await projectServer.stop();
    await closeHttpServer(identityServer);
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(state.pending_approval, null);
  assert.equal(state.pending_review, null);
  assert.equal(state.featured_resource, null);
  assert.equal(state.alert, null);
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
      "trigger ReviewWebhook",
      "    on request POST \"/review\"",
      "    runs strategy RunReview",
      "    limits",
      "        max_runs_per_day as 5",
      "        timeout_ms as 30000",
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
    assert.equal(graph.nodes.some((node) => node.ref === "trigger:demo.authority/ReviewWebhook"), true);
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
    assert.equal(graph.edges.some((edge) =>
      edge.kind === "dispatches"
      && edge.from === "trigger:demo.authority/ReviewWebhook"
      && edge.to === "strategy:demo.authority/RunReview"
    ), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("authority graph ignores legacy client governance overlays", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-governance-action-"));
  try {
    writeFileSync(join(root, "workflow.tb"), [
      "module demo.governance",
      "",
      "tool ReadAccount",
      "",
      "tool SendPayment",
      "",
      "agent InvoiceAgent",
      "    uses ReadAccount",
      "",
      "strategy RunInvoice",
      "    uses InvoiceAgent",
      "",
    ].join("\n"), "utf8");

    const initialGraph = buildAuthorityGraph({ projectRoot: root });
    assert.equal(initialGraph.edges.some((edge) =>
      edge.kind === "uses"
      && edge.from === "agent:demo.governance/InvoiceAgent"
      && edge.to === "tool:demo.governance/ReadAccount"
    ), true);

    writeFileSync(join(root, "touba.governance-actions.json"), JSON.stringify({
      governance_action_schema_version: "touba-studio-governance-action-v0.1",
      action_id: "studio-governance-revoke-read",
      operation: "revoke_authority",
      relation: {
        kind: "uses",
        source_ref: "agent:demo.governance/InvoiceAgent",
        target_ref: "tool:demo.governance/ReadAccount",
      },
      intent: {
        kind: "revoke",
        source_ref: "agent:demo.governance/InvoiceAgent",
        target_ref: "tool:demo.governance/ReadAccount",
        relation_kind: "uses",
      },
      review: {
        required: true,
        profile: "prod",
      },
    }, null, 2), "utf8");
    const graphWithLegacyRevoke = buildAuthorityGraph({ projectRoot: root });
    assert.equal(graphWithLegacyRevoke.edges.some((edge) =>
      edge.kind === "uses"
      && edge.from === "agent:demo.governance/InvoiceAgent"
      && edge.to === "tool:demo.governance/ReadAccount"
    ), true);

    writeFileSync(join(root, "touba.governance-actions.json"), JSON.stringify({
      governance_action_schema_version: "touba-studio-governance-action-v0.1",
      action_id: "studio-governance-grant-payment",
      operation: "grant_authority",
      relation: {
        kind: "uses",
        source_ref: "agent:demo.governance/InvoiceAgent",
        target_ref: "tool:demo.governance/SendPayment",
      },
      intent: {
        kind: "grant",
        source_ref: "agent:demo.governance/InvoiceAgent",
        target_ref: "tool:demo.governance/SendPayment",
        relation_kind: "uses",
      },
      review: {
        required: true,
        profile: "prod",
      },
    }, null, 2), "utf8");
    const graphWithLegacyGrant = buildAuthorityGraph({ projectRoot: root });
    assert.equal(graphWithLegacyGrant.edges.some((edge) =>
      edge.kind === "uses"
      && edge.from === "agent:demo.governance/InvoiceAgent"
      && edge.to === "tool:demo.governance/SendPayment"
    ), false);
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

test("product identity surface is empty until a project identity store exists", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-identity-"));
  try {
    const productIdentityPath = join(root, ".touba", "product-identity.json");
    const empty = readProductIdentity({ contractsRoot, productIdentityPath });
    assertMatchesSchema("touba-product-identity-v0.1", empty);
    assert.equal(empty.summary.user_count, 0);
    assert.deepEqual(empty.assignments, []);

    mkdirSync(join(root, ".touba"), { recursive: true });
    const fixture = readJson("fixtures/valid/touba-product-identity-v0.1.json");
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

test("observability and mobile product surfaces return valid empty states without stores", () => {
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
  assert.equal(costs.summary.run_count, 0);
  assert.equal(costs.summary.estimated_cost, 0);
  assert.deepEqual(notifications.notifications, []);
  assert.equal(quickApproval.status, "disabled");
  assert.deepEqual(quickApproval.allowed_decisions, []);
  assert.deepEqual(escalation.assignments, []);
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

test("multi-file change sets apply through a recoverable transaction", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-change-set-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n", "utf8");
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    const proposed = proposeProjectChangeSet({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-07-23T00:00:00Z",
      changeSet: {
        proposal_id: "change_set_001",
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Add a governed tool source and handler stub.",
        changes: [
          {
            path: "src/main.tb",
            role: "source",
            content: [
              "module demo.main",
              "",
              "tool LookupRecord",
              '    description "Reads one governed record from the project."',
              "    takes request as Text",
              "    gives Text",
              "",
            ].join("\n"),
          },
          {
            path: "handlers/demo/main/lookup_record.handler.mjs",
            role: "handler_stub",
            content: [
              "#!/usr/bin/env node",
              "// Touba Studio generated handler stub v0.1",
              'const code = "HandlerStubNotImplemented";',
              "process.stderr.write(`${code}\\n`);",
              "process.exitCode = 1;",
              "",
            ].join("\n"),
          },
        ],
      },
    });
    assert.equal(proposed.target_count, 2);
    assert.equal(proposed.targets.some((target) => target.role === "handler_stub"), true);

    const applied = applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      decidedAt: "2026-07-23T00:00:01Z",
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "change_set_001",
        decision: "apply",
        decided_by: { kind: "user", id: "reviewer" },
        reason: "Validated.",
      },
    });
    assert.equal(applied.status, "applied");
    assert.equal(applied.evidence.write_mode, "recoverable_transaction");
    assert.deepEqual(applied.evidence.relative_paths, [
      "src/main.tb",
      "handlers/demo/main/lookup_record.handler.mjs",
    ]);
    assert.match(readFileSync(join(root, "src", "main.tb"), "utf8"), /tool LookupRecord/u);
    assert.equal(existsSync(join(root, ".touba", "change-transactions", applied.evidence.transaction_id, "journal.json")), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-file change sets restore already written targets when commit fails", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-change-rollback-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const original = "module demo.main\n";
    writeFileSync(join(root, "src", "main.tb"), original, "utf8");
    writeFileSync(join(root, "blocked"), "not a directory\n", "utf8");
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    proposeProjectChangeSet({
      projectRoot: root,
      changeProposalsPath,
      changeSet: {
        proposal_id: "change_set_rollback",
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Exercise transaction rollback.",
        changes: [
          {
            path: "src/main.tb",
            role: "source",
            content: "module demo.main\n\nmemory Evidence\n",
          },
          {
            path: "blocked/new.tb",
            role: "source",
            content: "module demo.secondary\n",
          },
        ],
      },
    });
    assert.throws(
      () => applyProjectChange({
        projectRoot: root,
        changeProposalsPath,
        applyRequest: {
          schema_version: "touba-project-change-apply-v0.1",
          proposal_id: "change_set_rollback",
          decision: "apply",
          decided_by: { kind: "user", id: "reviewer" },
          reason: "Exercise rollback.",
        },
      }),
      /rolled back/u,
    );
    assert.equal(readFileSync(join(root, "src", "main.tb"), "utf8"), original);
    assert.equal(existsSync(join(root, ".touba", "project-change.lock")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("interrupted multi-file changes recover from their journal before the next project operation", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-change-recovery-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".touba", "project-change.lock"), { recursive: true });
    const transactionRoot = join(root, ".touba", "change-transactions", "interrupted-001");
    mkdirSync(join(transactionRoot, "backup"), { recursive: true });
    const original = "module demo.recovery\n";
    const interrupted = "module demo.recovery\n\nmemory Interrupted\n";
    writeFileSync(join(root, "src", "main.tb"), interrupted, "utf8");
    writeFileSync(join(transactionRoot, "backup", "0.previous"), original, "utf8");
    writeFileSync(join(transactionRoot, "journal.json"), `${JSON.stringify({
      schema_version: "touba-project-change-transaction-v0.1",
      transaction_id: "interrupted-001",
      proposal_id: "proposal-interrupted",
      status: "committing",
      prepared_at: "2026-07-23T00:00:00.000Z",
      targets: [{
        path: "src/main.tb",
        content_sha256: createHash("sha256").update(interrupted).digest("hex"),
        base_content_exists: true,
        base_content_sha256: createHash("sha256").update(original).digest("hex"),
      }],
    }, null, 2)}\n`, "utf8");

    const recovered = recoverProjectChangeTransactions({
      projectRoot: root,
      recoveredAt: "2026-07-23T00:00:01.000Z",
    });
    assert.deepEqual(recovered, {
      status: "recovered",
      recovered: ["interrupted-001"],
    });
    assert.equal(readFileSync(join(root, "src", "main.tb"), "utf8"), original);
    assert.equal(existsSync(join(root, ".touba", "project-change.lock")), false);
    const journal = JSON.parse(readFileSync(join(transactionRoot, "journal.json"), "utf8"));
    assert.equal(journal.status, "recovered");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("deployment plans verify immutable project bundles and block dirty prod sources", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-deployment-plan-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), "module demo.deployment\n", "utf8");
    writeFileSync(join(root, "touba.project.json"), `${JSON.stringify({
      project_version: "touba-project-v1",
      language: "javascript",
    })}\n`, "utf8");
    writeFileSync(join(root, "touba.manifest.json"), `${JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {},
      triggers: {},
    })}\n`, "utf8");
    writeFileSync(join(root, "touba.lock.json"), `${JSON.stringify({
      lock_version: "touba-lock-v0.1",
      artifacts: [],
    })}\n`, "utf8");
    const ready = buildProjectDeploymentPlan({
      projectRoot: root,
      profile: "prod",
      targetConfigured: true,
      createdAt: "2026-07-23T00:00:00.000Z",
      sourceRevision: { commit: "clean-revision", dirty: false },
    });
    assert.equal(ready.status, "ready");
    assertMatchesSchema("touba-deployment-plan-v0.1", ready);

    const blocked = buildProjectDeploymentPlan({
      projectRoot: root,
      profile: "prod",
      targetConfigured: true,
      createdAt: "2026-07-23T00:00:00.000Z",
      sourceRevision: { commit: "dirty-revision", dirty: true },
    });
    assert.equal(blocked.status, "blocked");
    assert.equal(blocked.checks.some((item) => item.code === "ToubaDeploymentSourceRevision" && item.status === "blocked"), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("governance relation changes edit compiled Touba source through review", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-governance-edit-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const sourcePath = join(root, "src", "main.tb");
    const original = [
      "module demo.governance_edit",
      "",
      "memory ReviewNotes",
      "",
      "tool ReadRecord",
      "    takes request as Text",
      "    gives Text",
      "",
      "skill SummarizeRecord",
      "    takes request as Text",
      "    gives Text",
      "    uses ReadRecord",
      "    do",
      "        ReadRecord",
      "            with request as request",
      "            into result",
      "        give result",
      "",
      "agent Reviewer",
      "    memory ReviewNotes write",
      "    callable_by strategy RunReview",
      "",
      "strategy RunReview",
      "    uses Reviewer",
      "    do",
      "        Reviewer",
      "",
    ].join("\n");
    writeFileSync(sourcePath, original, "utf8");
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");

    const proposed = proposeGovernanceRelationChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-07-22T00:00:00Z",
      request: {
        schema_version: "touba-governance-relation-change-v0.1",
        proposal_id: "governance_add_uses",
        operation: "add",
        relation: {
          kind: "uses",
          source_ref: "agent:demo.governance_edit/Reviewer",
          target_ref: "skill:demo.governance_edit/SummarizeRecord",
        },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Authorize Reviewer to use SummarizeRecord.",
      },
    });
    assert.equal(proposed.status, "proposed");
    assert.equal(readFileSync(sourcePath, "utf8"), original);

    const applied = applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "governance_add_uses",
        decision: "apply",
        decided_by: { kind: "user", id: "reviewer" },
        reason: "Authority reviewed.",
      },
    });
    assert.equal(applied.status, "applied");
    assert.match(readFileSync(sourcePath, "utf8"), /agent Reviewer\n    uses SummarizeRecord\n    memory ReviewNotes write\n    callable_by strategy RunReview/u);
    const graph = buildAuthorityGraph({ projectRoot: root });
    assert.equal(graph.edges.some((edge) => (
      edge.kind === "uses"
      && edge.from === "agent:demo.governance_edit/Reviewer"
      && edge.to === "skill:demo.governance_edit/SummarizeRecord"
    )), true);

    proposeGovernanceRelationChange({
      projectRoot: root,
      changeProposalsPath,
      request: {
        schema_version: "touba-governance-relation-change-v0.1",
        proposal_id: "governance_remove_uses",
        operation: "remove",
        relation: {
          kind: "uses",
          source_ref: "agent:demo.governance_edit/Reviewer",
          target_ref: "skill:demo.governance_edit/SummarizeRecord",
        },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Remove Reviewer access to SummarizeRecord.",
      },
    });
    applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "governance_remove_uses",
        decision: "apply",
        decided_by: { kind: "user", id: "reviewer" },
        reason: "Authority removal reviewed.",
      },
    });
    assert.doesNotMatch(readFileSync(sourcePath, "utf8"), /uses SummarizeRecord/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("multi-agent governance edits uses and callable_by as one reviewed change", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-agent-authority-edit-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const sourcePath = join(root, "src", "main.tb");
    writeFileSync(sourcePath, [
      "module demo.agent_authority_edit",
      "",
      "agent Worker",
      "    description \"Performs a bounded delegated task.\"",
      "",
      "agent Supervisor",
      "    description \"Coordinates delegated work.\"",
      "",
    ].join("\n"), "utf8");
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");

    proposeGovernanceRelationChange({
      projectRoot: root,
      changeProposalsPath,
      request: {
        schema_version: "touba-governance-relation-change-v0.1",
        proposal_id: "authorize_supervisor_worker",
        operation: "add",
        relation: {
          kind: "invokes_agent",
          source_ref: "agent:demo.agent_authority_edit/Supervisor",
          target_ref: "agent:demo.agent_authority_edit/Worker",
        },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Authorize supervised delegation.",
      },
    });
    applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "authorize_supervisor_worker",
        decision: "apply",
        decided_by: { kind: "user", id: "reviewer" },
        reason: "Delegation reviewed.",
      },
    });

    const source = readFileSync(sourcePath, "utf8");
    assert.match(source, /agent Worker\n    description[^\n]+\n    callable_by agent Supervisor\n\nagent Supervisor/u);
    assert.match(source, /agent Supervisor\n    description[^\n]+\n    uses Worker\n$/u);
    const graph = buildAuthorityGraph({ projectRoot: root });
    assert.equal(graph.edges.some((edge) => (
      edge.kind === "uses"
      && edge.from === "agent:demo.agent_authority_edit/Supervisor"
      && edge.to === "agent:demo.agent_authority_edit/Worker"
    )), true);
    assert.equal(graph.edges.some((edge) => (
      edge.kind === "callable_by"
      && edge.from === "agent:demo.agent_authority_edit/Supervisor"
      && edge.to === "agent:demo.agent_authority_edit/Worker"
    )), true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("governance relation changes edit memory access and replace trigger targets", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-contextual-governance-edit-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const sourcePath = join(root, "src", "main.tb");
    writeFileSync(sourcePath, [
      "module demo.contextual_governance",
      "",
      "memory ProjectNotes",
      "",
      "function ProduceSnapshot",
      "    gives Text",
      "    do",
      "        give \"snapshot\"",
      "",
      "strategy RunPrimary",
      "    gives Text",
      "    uses ProduceSnapshot",
      "    do",
      "        ProduceSnapshot",
      "            into result",
      "        give result",
      "",
      "strategy RunSecondary",
      "    gives Text",
      "    uses ProduceSnapshot",
      "    do",
      "        ProduceSnapshot",
      "            into result",
      "        give result",
      "",
      "trigger ProjectWebhook",
      "    on request POST \"/project\"",
      "    runs strategy RunPrimary",
      "    limits",
      "        max_runs_per_day as 5",
      "        timeout_ms as 30000",
      "",
    ].join("\n"), "utf8");
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");

    proposeGovernanceRelationChange({
      projectRoot: root,
      changeProposalsPath,
      request: {
        schema_version: "touba-governance-relation-change-v0.1",
        proposal_id: "add_strategy_memory_read",
        operation: "add",
        relation: {
          kind: "memory_access",
          source_ref: "strategy:demo.contextual_governance/RunPrimary",
          target_ref: "memory:demo.contextual_governance/ProjectNotes",
          access: "read",
        },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Authorize the strategy to read project notes.",
      },
    });
    applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "add_strategy_memory_read",
        decision: "apply",
        decided_by: { kind: "user", id: "reviewer" },
        reason: "Memory scope reviewed.",
      },
    });
    assert.match(readFileSync(sourcePath, "utf8"), /strategy RunPrimary[\s\S]*memory ProjectNotes read\n    do/u);
    const graphAfterMemory = buildAuthorityGraph({ projectRoot: root });
    assert.equal(graphAfterMemory.edges.some((edge) => (
      edge.kind === "requires"
      && edge.from === "strategy:demo.contextual_governance/RunPrimary"
      && edge.to === "memory:demo.contextual_governance/ProjectNotes"
      && edge.access === "read"
    )), true);

    proposeGovernanceRelationChange({
      projectRoot: root,
      changeProposalsPath,
      request: {
        schema_version: "touba-governance-relation-change-v0.1",
        proposal_id: "replace_trigger_target",
        operation: "replace",
        relation: {
          kind: "dispatches",
          source_ref: "trigger:demo.contextual_governance/ProjectWebhook",
          target_ref: "strategy:demo.contextual_governance/RunSecondary",
        },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Route the trigger to the secondary strategy.",
      },
    });
    applyProjectChange({
      projectRoot: root,
      changeProposalsPath,
      applyRequest: {
        schema_version: "touba-project-change-apply-v0.1",
        proposal_id: "replace_trigger_target",
        decision: "apply",
        decided_by: { kind: "user", id: "reviewer" },
        reason: "Trigger target reviewed.",
      },
    });
    const source = readFileSync(sourcePath, "utf8");
    assert.match(source, /trigger ProjectWebhook[\s\S]*runs strategy RunSecondary/u);
    assert.doesNotMatch(source, /runs strategy RunPrimary/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("governance relation changes reject incompatible, cross-source and stale edits", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-governance-guard-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), [
      "module demo.governance_guard",
      "",
      "tool ReadRecord",
      "    takes request as Text",
      "    gives Text",
      "",
      "agent Reviewer",
      "    description \"Reviews governed records.\"",
      "",
    ].join("\n"), "utf8");
    writeFileSync(join(root, "src", "other.tb"), [
      "module demo.governance_other",
      "",
      "skill ExternalSkill",
      "    takes request as Text",
      "    gives Text",
      "    do",
      "        give request",
      "",
    ].join("\n"), "utf8");
    const changeProposalsPath = join(root, ".touba", "studio-change-proposals.json");
    const request = {
      schema_version: "touba-governance-relation-change-v0.1",
      proposal_id: "guard_relation",
      operation: "add",
      relation: {
        kind: "uses",
        source_ref: "agent:demo.governance_guard/Reviewer",
        target_ref: "skill:demo.governance_other/ExternalSkill",
      },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "Cross-source authority request.",
    };
    assert.throws(
      () => proposeGovernanceRelationChange({ projectRoot: root, changeProposalsPath, request }),
      /spans multiple source files/,
    );
    assert.throws(
      () => proposeGovernanceRelationChange({
        projectRoot: root,
        changeProposalsPath,
        request: {
          ...request,
          proposal_id: "incompatible_relation",
          relation: {
            kind: "uses",
            source_ref: "tool:demo.governance_guard/ReadRecord",
            target_ref: "agent:demo.governance_guard/Reviewer",
          },
        },
      }),
      /cannot declare a uses relation/,
    );

    const sourcePath = join(root, "src", "main.tb");
    proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposal: {
        schema_version: "touba-project-change-proposal-v0.1",
        proposal_id: "stale_change",
        action: "write_text_file",
        target: { path: "src/main.tb" },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Validated before an external source edit.",
        content: `${readFileSync(sourcePath, "utf8")}\n`,
      },
    });
    writeFileSync(sourcePath, `${readFileSync(sourcePath, "utf8")}\n// concurrent edit\n`, "utf8");
    assert.throws(
      () => applyProjectChange({
        projectRoot: root,
        changeProposalsPath,
        applyRequest: {
          schema_version: "touba-project-change-apply-v0.1",
          proposal_id: "stale_change",
          decision: "apply",
          decided_by: { kind: "user", id: "reviewer" },
          reason: "Attempt stale apply.",
        },
      }),
      /changed after validation/,
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

    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v0.1",
          proposal_id: "legacy_governance_overlay",
          action: "write_text_file",
          target: { path: "touba.governance-actions.json" },
          requested_by: { kind: "studio", id: "touba-studio" },
          content: "{}",
        },
      }),
      /approved Touba project metadata only/,
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
  mkdirSync(join(root, ".touba"), { recursive: true });
  writeFileSync(join(root, ".touba", "human-requests.json"), JSON.stringify({
    schema_version: "touba-human-requests-v0.1",
    approvals: [{
      ...readJson("fixtures/valid/touba-approval-request-v1.json"),
      expires_at: "2099-01-01T00:00:00.000Z",
    }],
    reviews: [],
  }), "utf8");
  writeTestDecisionIdentity(root, {
    userRef: "user:khadim",
    deviceRef: "device:review-phone-01",
  });
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
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.main\n", "utf8");
  const pendingReview = {
    ...readJson("fixtures/valid/touba-human-review-request-v1.json"),
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  writeFileSync(join(root, ".touba", "human-requests.json"), JSON.stringify({
    schema_version: "touba-human-requests-v0.1",
    approvals: [],
    reviews: [pendingReview],
  }), "utf8");
  writeTestDecisionIdentity(root, {
    userRef: "user:khadim",
    deviceRef: "device:review-phone-01",
  });
  writeFileSync(join(root, ".touba", "air", "demo", "main.air.json"), JSON.stringify({
    air_schema_version: "air-minimal-v0.1",
    module: { id: "module:demo.main", name: "demo.main" },
    definitions: {
      types: [
        {
          id: "type:demo.main/ReviewRequest",
          name: "ReviewRequest",
          fields: [
            { name: "body", type_ref: "builtin:Text" },
            { name: "priority", type_ref: "builtin:Int" },
            { name: "labels", type_ref: "list:builtin:Text" },
          ],
        },
      ],
      agents: [
        {
          id: "agent:demo.main/ReviewAgent",
          name: "ReviewAgent",
          description: "Selects review capabilities for the served project.",
          uses: ["skill:demo.main/ReviewDraft"],
        },
      ],
      functions: [
        {
          id: "function:demo.main/FormatReview",
          name: "FormatReview",
          description: "Formats a review request without external effects.",
          signature: {
            inputs: [{ name: "request", type_ref: "type:demo.main/ReviewRequest" }],
            output_type: "builtin:Text",
          },
        },
      ],
      tools: [
        {
          id: "tool:demo.main/StoreReview",
          name: "StoreReview",
          description: "Stores an approved review through a declared handler.",
          signature: {
            inputs: [{ name: "request", type_ref: "type:demo.main/ReviewRequest" }],
            output_type: "builtin:Text",
          },
        },
      ],
      skills: [
        {
          id: "skill:demo.main/ReviewDraft",
          name: "ReviewDraft",
          description: "Reviews a draft artifact.",
          uses: ["tool:demo.main/StoreReview"],
          signature: {
            inputs: [{ name: "request", type_ref: "type:demo.main/ReviewRequest" }],
            output_type: "builtin:Text",
          },
        },
      ],
      strategies: [
        {
          id: "strategy:demo.main/RunReview",
          name: "RunReview",
          description: "Runs the review strategy.",
          flow_graph_ref: "graph:strategy:demo.main/RunReview",
          signature: {
            inputs: [
              { name: "request", type_ref: "type:demo.main/ReviewRequest" },
              { name: "reviewer_note", type_ref: "builtin:Text" },
            ],
            output_type: "builtin:Text",
          },
        },
      ],
      triggers: [
        {
          id: "trigger:demo.main/ReviewWebhook",
          name: "ReviewWebhook",
          target_ref: "strategy:demo.main/RunReview",
          arguments: [{ input: "reviewer_note", value_ref: "literal:string:webhook" }],
          payload: { map: { request: "$.request" } },
        },
      ],
    },
    execution_graphs: [
      {
        id: "graph:strategy:demo.main/RunReview",
        owner_ref: "strategy:demo.main/RunReview",
        nodes: [
          {
            id: "node:graph:strategy:demo.main/RunReview:0",
            kind: "call_tool",
            target_ref: "tool:demo.main/StoreReview",
          },
        ],
        edges: [],
      },
    ],
  }, null, 2), "utf8");
  mkdirSync(join(root, "packages", "review"), { recursive: true });
  writeFileSync(join(root, "packages", "review", "touba.package.json"), JSON.stringify({
    package_schema_version: "touba-package-v0.1",
    name: "org.example.review",
    version: "1.2.3",
    description: "Review capabilities installed in the served project.",
    documentation_url: "https://example.test/packages/review",
    root: "../..",
    exports: {
      functions: ["function:demo.main/FormatReview"],
      agents: ["agent:demo.main/ReviewAgent"],
      skills: ["skill:demo.main/ReviewDraft"],
    },
  }, null, 2), "utf8");
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
    assert.equal(state.project_server.refresh.summary.artifact_count, 3);
    assert.equal(state.project.project.name, basename(root));
    assert.equal(state.project.entrypoints.some((entrypoint) => entrypoint.kind === "strategy"), true);

    const project = await getJson(`${baseUrl}/project`);
    assert.equal(project.schema_version, "touba-project-inspection-v1");
    assert.equal(project.project.name, basename(root));
    assert.equal(project.artifacts.some((artifact) => artifact.path === "src/main.tb"), true);
    assert.equal(project.entrypoints.some((entrypoint) => entrypoint.kind === "strategy"), true);
    assert.equal(project.packages.length, 1);
    assert.deepEqual(project.packages[0], {
      package_ref: "package:org.example.review",
      name: "org.example.review",
      version: "1.2.3",
      status: "installed",
      digest: project.packages[0].digest,
      path: "packages/review/touba.package.json",
      description: "Review capabilities installed in the served project.",
      documentation_url: "https://example.test/packages/review",
      exports: [
        "function:demo.main/FormatReview",
        "agent:demo.main/ReviewAgent",
        "skill:demo.main/ReviewDraft",
      ],
    });
    assert.match(project.packages[0].digest, /^sha256:[0-9a-f]{64}$/u);
    const agentEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.kind === "agent");
    assert.equal(agentEntrypoint.input_contract.mode, "open");
    assert.equal(agentEntrypoint.effect_policy_requirement, "declared_external_effects_required");
    const functionEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.kind === "function");
    assert.equal(functionEntrypoint.input_contract.mode, "declared");
    assert.equal(functionEntrypoint.effect_policy_requirement, "runtime_only_compatible");
    const toolEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.kind === "tool");
    assert.equal(toolEntrypoint.input_contract.mode, "declared");
    assert.equal(toolEntrypoint.effect_policy_requirement, "declared_external_effects_required");
    const skillEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.kind === "skill");
    assert.equal(skillEntrypoint.input_contract.mode, "declared");
    assert.equal(skillEntrypoint.effect_policy_requirement, "declared_external_effects_required");
    assert.deepEqual(skillEntrypoint.input_contract.fields, [
      { name: "request", type_ref: "type:demo.main/ReviewRequest", required: true },
    ]);
    assert.equal(skillEntrypoint.input_contract.types[0].fields[2].type_ref, "list:builtin:Text");
    const triggerEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.kind === "trigger");
    assert.equal(triggerEntrypoint.input_contract.mode, "declared");
    assert.equal(triggerEntrypoint.effect_policy_requirement, "declared_external_effects_required");
    assert.deepEqual(triggerEntrypoint.input_contract.fields.map((field) => field.name), ["request"]);
    assert.equal(JSON.stringify(project).includes("billing-agent"), false);
    assertMatchesSchema("touba-project-inspection-v1", project);

    const authorityGraph = await getJson(`${baseUrl}/authority/graph`);
    assertMatchesSchema("touba-authority-graph-v0.1", authorityGraph);
    assert.equal(
      authorityGraph.nodes.some((node) => (
        node.kind === "function" && node.ref === "function:demo.main/FormatReview"
      )),
      true,
    );
    assert.equal(
      authorityGraph.edges.some((edge) => (
        edge.kind === "imports"
        && edge.from === "package:org.example.review"
        && edge.to === "function:demo.main/FormatReview"
      )),
      true,
    );
    assert.equal(
      authorityGraph.diagnostics.some((diagnostic) => (
        diagnostic.code === "ToubaAuthorityGraphNodeKindUnknown"
        || diagnostic.code === "ToubaAuthorityGraphDanglingEdge"
      )),
      false,
    );
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

    const decision = {
      ...readJson("fixtures/valid/touba-human-review-decision-v1.json"),
      user_ref: "user:khadim",
      device_ref: "device:review-phone-01",
      reviewed_by: "user:khadim",
      reviewed_at: new Date().toISOString(),
    };
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

test("HTTP project server validates, reviews and applies semantic governance edits", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-http-governance-"));
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), [
    "module demo.http_governance",
    "",
    "tool ReadRecord",
    "    takes request as Text",
    "    gives Text",
    "",
    "skill SummarizeRecord",
    "    takes request as Text",
    "    gives Text",
    "    uses ReadRecord",
    "    do",
    "        ReadRecord",
    "            with request as request",
    "            into result",
    "        give result",
    "",
    "agent Reviewer",
    "    description \"Reviews governed records.\"",
    "",
  ].join("\n"), "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, ".touba", "human-decisions.json"),
    changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const proposalResponse = await postJson(`${baseUrl}/governance/relations/propose`, {
      schema_version: "touba-governance-relation-change-v0.1",
      proposal_id: "http_governance_001",
      operation: "add",
      relation: {
        kind: "uses",
        source_ref: "agent:demo.http_governance/Reviewer",
        target_ref: "skill:demo.http_governance/SummarizeRecord",
      },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "Authorize Reviewer to use SummarizeRecord.",
    });
    assert.equal(proposalResponse.status, 202);
    assertMatchesSchema("touba-project-change-proposed-v0.1", await proposalResponse.json());

    const applyResponse = await postJson(`${baseUrl}/changes/apply`, {
      schema_version: "touba-project-change-apply-v0.1",
      proposal_id: "http_governance_001",
      decision: "apply",
      decided_by: { kind: "user", id: "reviewer" },
      reason: "Authority reviewed.",
    });
    assert.equal(applyResponse.status, 202);
    const graph = await getJson(`${baseUrl}/authority/graph`);
    assert.equal(graph.edges.some((edge) => (
      edge.kind === "uses"
      && edge.from === "agent:demo.http_governance/Reviewer"
      && edge.to === "skill:demo.http_governance/SummarizeRecord"
    )), true);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server executes sandbox entrypoints and triggers through the runtime", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-sandbox-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.sandbox\n", "utf8");
  writeFileSync(join(root, ".touba", "air", "demo", "main.air.json"), JSON.stringify(sandboxAirDocument(), null, 2), "utf8");
  writeFileSync(join(root, "touba.manifest.json"), JSON.stringify(sandboxManifestDocument(), null, 2), "utf8");
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
    assert.equal(health.endpoints.sandbox_run, "/runs/sandbox");
    assert.equal(health.endpoints.trigger_fire, "/triggers/fire");

    const runResponse = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v0.1",
      execution_kind: "entrypoint",
      target_ref: "strategy:demo.sandbox/RunReady",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "test sandbox run",
    });
    assert.equal(runResponse.status, 200);
    const run = await runResponse.json();
    assertMatchesSchema("touba-sandbox-run-result-v0.1", run);
    assert.equal(run.status, "success");
    assert.equal(run.result, "ready");
    assert.equal(run.trace.entry_ref, "strategy:demo.sandbox/RunReady");
    assert.equal(run.trace.events.length, run.trace.event_count);

    const currentRun = await getJson(`${baseUrl}/runs/current`);
    assert.equal(currentRun.run_id, run.run_id);
    assert.equal(currentRun.status, "succeeded");
    assert.equal(currentRun.entrypoint_ref, "strategy:demo.sandbox/RunReady");
    const currentTrace = await getJson(`${baseUrl}/trace/current`);
    assert.equal(currentTrace.run_id, run.run_id);
    assert.equal(currentTrace.events.length, run.trace.event_count);
    assert.equal(currentTrace.events.every((event) => event.redaction !== "none"), true);

    const functionResponse = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v0.1",
      execution_kind: "entrypoint",
      target_ref: "function:demo.sandbox/FormatReady",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "test pure function run",
    });
    assert.equal(functionResponse.status, 200);
    const functionRun = await functionResponse.json();
    assert.equal(functionRun.status, "success");
    assert.equal(functionRun.result, "function-ready");
    assert.equal(functionRun.trace.entry_ref, "function:demo.sandbox/FormatReady");

    const triggerResponse = await postJson(`${baseUrl}/triggers/fire`, {
      schema_version: "touba-sandbox-run-request-v0.1",
      execution_kind: "trigger",
      target_ref: "trigger:demo.sandbox/ManualCheck",
      effect_policy: "runtime_only",
      event_id: "manual-check-001",
      source_kind: "schedule",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "test trigger fire",
    });
    assert.equal(triggerResponse.status, 200);
    const triggerRun = await triggerResponse.json();
    assertMatchesSchema("touba-sandbox-run-result-v0.1", triggerRun);
    assert.equal(triggerRun.status, "success");
    assert.equal(triggerRun.result, "triggered");
    assert.equal(triggerRun.trace.entry_ref, "trigger:demo.sandbox/ManualCheck");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server refuses sandbox runtime-only runs that may dispatch tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-sandbox-effects-"));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.effects\n", "utf8");
  writeFileSync(join(root, ".touba", "air", "demo", "main.air.json"), JSON.stringify(sandboxAirDocument({ withTool: true }), null, 2), "utf8");
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
    const response = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v0.1",
      execution_kind: "entrypoint",
      target_ref: "strategy:demo.sandbox/RunTool",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "tool effect refusal",
    });
    assert.equal(response.status, 403);
    assert.equal((await response.json()).code, "ToubaServeSandboxExternalEffectsRejected");

    const directToolResponse = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v0.1",
      execution_kind: "entrypoint",
      target_ref: "tool:demo.sandbox/ReadExternal",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "direct tool effect refusal",
    });
    assert.equal(directToolResponse.status, 403);
    assert.equal((await directToolResponse.json()).code, "ToubaServeSandboxExternalEffectsRejected");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server runs sandbox agents through a configured decision provider", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-sandbox-agent-"));
  mkdirSync(join(root, "src", "demo"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "demo", "agent.tb"), "module demo.agent\n", "utf8");
  writeFileSync(join(root, ".touba", "air", "demo", "agent.air.json"), JSON.stringify(sandboxAgentAirDocument(), null, 2), "utf8");
  const providerCalls = [];
  const service = createToubaProjectServer({
    agentDecisionProvider: (request) => {
      providerCalls.push(request);
      if (request.mode === "summary" && request.observations?.length > 0) {
        return {
          action: "answer_directly",
          result: request.observations[0].value,
          reason: "capability result is sufficient",
        };
      }
      return {
        target_ref: "skill:demo.agent/BuildOverview",
        reason: "sandbox provider selects the overview capability",
      };
    },
    agentDecisionProviderInitialMode: "capabilities",
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
    const response = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v0.1",
      execution_kind: "entrypoint",
      target_ref: "strategy:demo.agent/RunAgent",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "test sandbox agent provider",
    });
    assert.equal(response.status, 200);
    const run = await response.json();
    assertMatchesSchema("touba-sandbox-run-result-v0.1", run);
    assert.equal(run.status, "success");
    assert.equal(run.result, "overview");
    assert.equal(providerCalls.length, 2);
    assert.equal(providerCalls[0].mode, "capabilities");
    assert.equal(providerCalls[0].agent_ref, "agent:demo.agent/StudioAgent");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server persists and resumes a human approval checkpoint without replay", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-sandbox-approval-"));
  mkdirSync(join(root, "src", "demo"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "demo", "approval.tb"), "module demo.approval\n", "utf8");
  writeFileSync(
    join(root, ".touba", "air", "demo", "approval.air.json"),
    JSON.stringify(sandboxApprovalAirDocument(), null, 2),
    "utf8",
  );
  writeTestDecisionIdentity(root, {
    userRef: "user:test-reviewer",
    deviceRef: "device:test-suite",
  });
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, ".touba", "human-decisions.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const pausedResponse = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v0.1",
      execution_kind: "entrypoint",
      target_ref: "strategy:demo.approval/RunApproval",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "test durable approval",
    });
    assert.equal(pausedResponse.status, 200);
    const paused = await pausedResponse.json();
    assert.equal(paused.status, "stopped", JSON.stringify(paused, null, 2));
    assert.equal(paused.diagnostics[0].code, "ToubaSandboxRunAwaitingHumanDecision");

    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    assertMatchesSchema("touba-approval-request-v1", pending);
    assert.equal(pending.run_id, paused.run_id);

    const unauthorizedDecision = await postJson(`${baseUrl}/decisions`, {
      schema_version: "touba-approval-decision-v1",
      request_id: pending.request_id,
      run_id: pending.run_id,
      trace_ref: pending.trace_ref,
      user_ref: "user:unknown",
      device_ref: "device:unknown",
      decision: "approve",
      decided_by: "user:unknown",
      decided_at: new Date().toISOString(),
      comment: null,
      client_ref: "touba-project-server-test",
    });
    assert.equal(unauthorizedDecision.status, 403);
    assert.equal((await unauthorizedDecision.json()).code, "ToubaServeDecisionIdentityUnauthorized");

    const decisionResponse = await postJson(`${baseUrl}/decisions`, {
      schema_version: "touba-approval-decision-v1",
      request_id: pending.request_id,
      run_id: pending.run_id,
      trace_ref: pending.trace_ref,
      user_ref: "user:test-reviewer",
      device_ref: "device:test-suite",
      decision: "approve",
      decided_by: "user:test-reviewer",
      decided_at: new Date().toISOString(),
      comment: null,
      client_ref: "touba-project-server-test",
    });
    assert.equal(decisionResponse.status, 202);

    const resumedResponse = await postJson(`${baseUrl}/runs/sandbox/resume`, {
      request_id: pending.request_id,
    });
    assert.equal(resumedResponse.status, 200);
    const resumed = await resumedResponse.json();
    assert.equal(resumed.status, "success");
    assert.equal(resumed.result, "approved");
    assert.equal(resumed.run_id, paused.run_id);
    assert.ok(resumed.trace.event_count > paused.trace.event_count);
    assert.equal(
      resumed.trace.events.filter((event) => event.type === "run_started").length,
      2,
    );
    assert.equal(
      resumed.trace.events.filter((event) => event.type === "human_approval_checkpoint_loaded").length,
      1,
    );

    const idempotentResponse = await postJson(`${baseUrl}/runs/sandbox/resume`, {
      request_id: pending.request_id,
    });
    assert.equal(idempotentResponse.status, 200);
    assert.deepEqual(await idempotentResponse.json(), resumed);
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
    const preflight = await fetch(`${baseUrl}/state`, {
      method: "OPTIONS",
      headers: {
        origin: "http://127.0.0.1:5175",
        "access-control-request-method": "GET",
        "access-control-request-headers": "authorization",
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get("access-control-allow-origin"), "http://127.0.0.1:5175");
    assert.match(preflight.headers.get("access-control-allow-headers"), /authorization/);

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
      headers: {
        authorization: "Bearer secret-token",
        origin: "http://127.0.0.1:5175",
      },
    });
    assert.equal(authorized.status, 200);
    assert.equal(authorized.headers.get("access-control-allow-origin"), "http://127.0.0.1:5175");
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

test("client authoring and deployment routes complete a governed project lifecycle", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-lifecycle-"));
  const targetStorage = mkdtempSync(join(tmpdir(), "touba-deployment-target-lifecycle-"));
  const token = "project-lifecycle-deployment-token-32-characters";
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), [
    "module demo.lifecycle",
    "",
    "strategy RunLifecycle",
    '    description "Runs the governed lifecycle operation."',
    "    takes request as Text",
    "    gives Text",
    "    do",
    "        give request",
    "",
  ].join("\n"), "utf8");
  writeFileSync(join(root, "touba.project.json"), `${JSON.stringify({
    project_version: "touba-project-v1",
    language: "javascript",
    run_profiles: {
      dev: { require_supply_chain_lock: false },
      prod: { require_supply_chain_lock: true, supply_chain_lock: "touba.lock.json" },
    },
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "touba.manifest.json"), `${JSON.stringify({
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {},
  }, null, 2)}\n`, "utf8");
  writeFileSync(join(root, "touba.lock.json"), `${JSON.stringify({
    lock_version: "touba-lock-v0.1",
    artifacts: [],
  }, null, 2)}\n`, "utf8");

  const target = createDeploymentTargetService({
    host: "127.0.0.1",
    port: 0,
    storageRoot: targetStorage,
    token,
  });
  let projectServer;
  try {
    const targetAddress = await target.start();
    projectServer = createToubaProjectServer({
      contractsRoot,
      projectRoot: root,
      changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
      deploymentTargetUrl: `${targetAddress.protocol}://${targetAddress.host}:${targetAddress.port}`,
      deploymentTargetToken: token,
      port: 0,
      quiet: true,
    });
    await projectServer.start();
    const baseUrl = `http://127.0.0.1:${projectServer.server.address().port}`;

    const memoryProposal = await postJson(`${baseUrl}/elements/propose`, {
      schema_version: "touba-element-authoring-request-v0.1",
      proposal_id: "author_memory_lifecycle",
      module_ref: "demo.lifecycle",
      element: {
        kind: "memory",
        name: "LifecycleEvidence",
        description: "Stores governed lifecycle evidence.",
      },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "Add lifecycle evidence memory.",
    });
    assert.equal(memoryProposal.status, 202);
    assert.equal((await memoryProposal.json()).target_count, undefined);
    const memoryApply = await postJson(`${baseUrl}/changes/apply`, {
      schema_version: "touba-project-change-apply-v0.1",
      proposal_id: "author_memory_lifecycle",
      decision: "apply",
      decided_by: { kind: "user", id: "reviewer" },
      reason: "Validated.",
    });
    assert.equal(memoryApply.status, 202);
    assert.match(readFileSync(join(root, "src", "main.tb"), "utf8"), /memory LifecycleEvidence/u);

    const toolProposal = await postJson(`${baseUrl}/elements/propose`, {
      schema_version: "touba-element-authoring-request-v0.1",
      proposal_id: "author_tool_lifecycle",
      module_ref: "demo.lifecycle",
      element: {
        kind: "tool",
        name: "FetchLifecycleRecord",
        description: "Reads one governed lifecycle record from the declared service.",
        takes: [{ name: "request", type_ref: "Text" }],
        gives: "Text",
        requirements: ["network", "secret_read"],
        secrets: ["LIFECYCLE_API_TOKEN"],
        handler: {
          timeout_ms: 5000,
          max_payload_bytes: 65536,
          sandbox_required: true,
        },
      },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "Add the governed lifecycle integration.",
    });
    assert.equal(toolProposal.status, 202);
    const toolDraft = await toolProposal.json();
    assert.equal(toolDraft.target_count, 3);
    assert.equal(JSON.stringify(toolDraft).includes("LIFECYCLE_API_TOKEN"), false);
    const toolApply = await postJson(`${baseUrl}/changes/apply`, {
      schema_version: "touba-project-change-apply-v0.1",
      proposal_id: "author_tool_lifecycle",
      decision: "apply",
      decided_by: { kind: "user", id: "reviewer" },
      reason: "Validated.",
    });
    assert.equal(toolApply.status, 202);
    assert.equal(existsSync(join(root, "handlers", "demo", "lifecycle", "fetch_lifecycle_record.handler.mjs")), true);
    const graph = await getJson(`${baseUrl}/authority/graph`);
    assert.equal(graph.nodes.some((node) => node.ref === "tool:demo.lifecycle/FetchLifecycleRecord"), true);

    const planResponse = await postJson(`${baseUrl}/deployments/plan`, {
      schema_version: "touba-deployment-action-v0.1",
      action: "plan",
      profile: "dev",
      actor: "user:reviewer",
    });
    assert.equal(planResponse.status, 200);
    const plan = await planResponse.json();
    assert.equal(plan.status, "ready");
    assertMatchesSchema("touba-deployment-plan-v0.1", plan);

    const firstPublish = await postJson(`${baseUrl}/deployments/publish`, {
      schema_version: "touba-deployment-action-v0.1",
      action: "publish",
      profile: "dev",
      actor: "user:reviewer",
    });
    assert.equal(firstPublish.status, 202);
    const firstStatus = await firstPublish.json();
    const firstRevision = firstStatus.revision.revision_id;
    assert.equal(JSON.stringify(firstStatus).includes(token), false);
    const firstActivation = await postJson(`${baseUrl}/deployments/activate`, {
      schema_version: "touba-deployment-action-v0.1",
      action: "activate",
      revision_id: firstRevision,
      actor: "user:reviewer",
    });
    assert.equal(firstActivation.status, 202);

    const secondProposal = await postJson(`${baseUrl}/elements/propose`, {
      schema_version: "touba-element-authoring-request-v0.1",
      proposal_id: "author_memory_second_revision",
      module_ref: "demo.lifecycle",
      element: {
        kind: "memory",
        name: "SecondRevisionEvidence",
        description: "Stores evidence for the second revision.",
      },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "Create a second immutable revision.",
    });
    assert.equal(secondProposal.status, 202);
    const secondApply = await postJson(`${baseUrl}/changes/apply`, {
      schema_version: "touba-project-change-apply-v0.1",
      proposal_id: "author_memory_second_revision",
      decision: "apply",
      decided_by: { kind: "user", id: "reviewer" },
      reason: "Validated.",
    });
    assert.equal(secondApply.status, 202);
    const secondPublish = await postJson(`${baseUrl}/deployments/publish`, {
      schema_version: "touba-deployment-action-v0.1",
      action: "publish",
      profile: "dev",
      actor: "user:reviewer",
    });
    assert.equal(secondPublish.status, 202);
    const secondRevision = (await secondPublish.json()).revision.revision_id;
    assert.notEqual(secondRevision, firstRevision);
    const secondActivation = await postJson(`${baseUrl}/deployments/activate`, {
      schema_version: "touba-deployment-action-v0.1",
      action: "activate",
      revision_id: secondRevision,
      actor: "user:reviewer",
    });
    assert.equal(secondActivation.status, 202);

    const rollback = await postJson(`${baseUrl}/deployments/rollback`, {
      schema_version: "touba-deployment-action-v0.1",
      action: "rollback",
      actor: "user:reviewer",
    });
    assert.equal(rollback.status, 202);
    assert.equal((await rollback.json()).current_revision_id, firstRevision);
    const finalStatus = await getJson(`${baseUrl}/deployments`);
    assert.equal(finalStatus.current_revision_id, firstRevision);
    assert.equal(finalStatus.revisions.length, 2);
  } finally {
    await projectServer?.stop();
    await target.stop();
    rmSync(root, { recursive: true, force: true });
    rmSync(targetStorage, { recursive: true, force: true });
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

async function listenHttpServer(server) {
  await new Promise((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(0, "127.0.0.1", resolveListen);
  });
}

async function closeHttpServer(server) {
  if (!server.listening) return;
  await new Promise((resolveClose, rejectClose) => {
    server.close((error) => error ? rejectClose(error) : resolveClose());
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

function sandboxAirDocument({ withTool = false } = {}) {
  const definitions = {
    types: [],
    constants: [],
    functions: [
      {
        id: "function:demo.sandbox/FormatReady",
        name: "FormatReady",
        description: "Returns a pure result for client function testing.",
        signature: { inputs: [], output_type: "builtin:Text" },
        body_graph_ref: "graph:function:demo.sandbox/FormatReady",
        source_ref: sourceRef(),
      },
    ],
    tools: withTool ? [
      {
        id: "tool:demo.sandbox/ReadExternal",
        name: "ReadExternal",
        signature: { inputs: [], output_type: "builtin:Text" },
        required_capabilities: ["network"],
        required_secrets: [],
        memory_accesses: [],
        source_ref: sourceRef(),
      },
    ] : [],
    memories: [],
    skills: [],
    agents: [],
    strategies: [
      {
        id: "strategy:demo.sandbox/RunReady",
        name: "RunReady",
        signature: { inputs: [], output_type: "builtin:Text" },
        flow_graph_ref: "graph:strategy:demo.sandbox/RunReady",
        source_ref: sourceRef(),
      },
      {
        id: "strategy:demo.sandbox/RunTriggered",
        name: "RunTriggered",
        signature: { inputs: [], output_type: "builtin:Text" },
        flow_graph_ref: "graph:strategy:demo.sandbox/RunTriggered",
        source_ref: sourceRef(),
      },
      ...(withTool ? [
        {
          id: "strategy:demo.sandbox/RunTool",
          name: "RunTool",
          signature: { inputs: [], output_type: "builtin:Text" },
          flow_graph_ref: "graph:strategy:demo.sandbox/RunTool",
          source_ref: sourceRef(),
        },
      ] : []),
    ],
    triggers: [
      {
        id: "trigger:demo.sandbox/ManualCheck",
        name: "ManualCheck",
        event: { kind: "schedule", value: "every 1h", source_ref: sourceRef() },
        target_ref: "strategy:demo.sandbox/RunTriggered",
        target_kind: "strategy",
        arguments: [],
        limits: { max_runs_per_day: 24, timeout_ms: 30000, source_ref: sourceRef() },
        source_ref: sourceRef(),
      },
    ],
  };
  return {
    air_schema_version: "air-minimal-v0.1",
    module: { id: "module:demo.sandbox", name: "demo.sandbox", source_ref: sourceRef() },
    definitions,
    execution_graphs: [
      graph("graph:function:demo.sandbox/FormatReady", "function:demo.sandbox/FormatReady", [
        node("formatted", "give", { arguments: ["literal:string:function-ready"] }),
      ]),
      graph("graph:strategy:demo.sandbox/RunReady", "strategy:demo.sandbox/RunReady", [
        node("ready", "give", { arguments: ["literal:string:ready"] }),
      ]),
      graph("graph:strategy:demo.sandbox/RunTriggered", "strategy:demo.sandbox/RunTriggered", [
        node("triggered", "give", { arguments: ["literal:string:triggered"] }),
      ]),
      ...(withTool ? [
        graph("graph:strategy:demo.sandbox/RunTool", "strategy:demo.sandbox/RunTool", [
          node("tool", "call_tool", { target_ref: "tool:demo.sandbox/ReadExternal", result_binding: "result" }),
          node("done", "give", { arguments: ["value:result"] }),
        ], [
          edge("tool", "done", "next"),
        ]),
      ] : []),
    ],
    trace_points: [],
  };
}

function sandboxAgentAirDocument() {
  const definitions = {
    types: [],
    constants: [],
    functions: [],
    tools: [],
    memories: [],
    skills: [
      {
        id: "skill:demo.agent/BuildOverview",
        name: "BuildOverview",
        description: "Builds the project overview for client sandbox testing.",
        signature: { inputs: [], output_type: "builtin:Text" },
        uses: [],
        use_refs: [],
        memory_accesses: [],
        flow_graph_ref: "graph:skill:demo.agent/BuildOverview",
        source_ref: sourceRef(),
      },
      {
        id: "skill:demo.agent/BuildOperations",
        name: "BuildOperations",
        description: "Builds the operations snapshot for client sandbox testing.",
        signature: { inputs: [], output_type: "builtin:Text" },
        uses: [],
        use_refs: [],
        memory_accesses: [],
        flow_graph_ref: "graph:skill:demo.agent/BuildOperations",
        source_ref: sourceRef(),
      },
    ],
    agents: [
      {
        id: "agent:demo.agent/StudioAgent",
        name: "StudioAgent",
        description: "Chooses between overview and operations capabilities for client sandbox testing.",
        responsibility: "Select a declared client sandbox capability.",
        uses: [
          "skill:demo.agent/BuildOverview",
          "skill:demo.agent/BuildOperations",
        ],
        use_refs: [
          { target_ref: "skill:demo.agent/BuildOverview", source_ref: sourceRef() },
          { target_ref: "skill:demo.agent/BuildOperations", source_ref: sourceRef() },
        ],
        callable_by: [
          {
            caller_ref: "strategy:demo.agent/RunAgent",
            caller_kind: "strategy",
            source_ref: sourceRef(),
          },
        ],
        source_ref: sourceRef(),
      },
    ],
    strategies: [
      {
        id: "strategy:demo.agent/RunAgent",
        name: "RunAgent",
        description: "Runs a client sandbox agent through a configured decision provider.",
        uses: ["agent:demo.agent/StudioAgent"],
        use_refs: [{ target_ref: "agent:demo.agent/StudioAgent", source_ref: sourceRef() }],
        flow_graph_ref: "graph:strategy:demo.agent/RunAgent",
        source_ref: sourceRef(),
      },
    ],
    triggers: [],
  };
  return {
    air_schema_version: "air-minimal-v0.1",
    module: { id: "module:demo.agent", name: "demo.agent", source_ref: sourceRef() },
    definitions,
    execution_graphs: [
      graph("graph:skill:demo.agent/BuildOverview", "skill:demo.agent/BuildOverview", [
        node("overview", "give", { arguments: ["literal:string:overview"] }),
      ]),
      graph("graph:skill:demo.agent/BuildOperations", "skill:demo.agent/BuildOperations", [
        node("operations", "give", { arguments: ["literal:string:operations"] }),
      ]),
      graph("graph:strategy:demo.agent/RunAgent", "strategy:demo.agent/RunAgent", [
        node("agent", "call_agent", { target_ref: "agent:demo.agent/StudioAgent", result_binding: "result" }),
        node("done", "give", { arguments: ["value:result"] }),
      ], [
        edge("agent", "done", "next"),
      ]),
    ],
    trace_points: [],
  };
}

function sandboxApprovalAirDocument() {
  return {
    air_schema_version: "air-minimal-v0.1",
    module: { id: "module:demo.approval", name: "demo.approval", source_ref: sourceRef() },
    definitions: {
      types: [],
      constants: [],
      functions: [],
      tools: [],
      memories: [],
      skills: [],
      agents: [],
      strategies: [{
        id: "strategy:demo.approval/RunApproval",
        name: "RunApproval",
        description: "Pauses at a durable human approval boundary.",
        signature: { inputs: [], output_type: "builtin:Text" },
        flow_graph_ref: "graph:strategy:demo.approval/RunApproval",
        source_ref: sourceRef(),
      }],
      triggers: [],
    },
    execution_graphs: [
      graph("graph:strategy:demo.approval/RunApproval", "strategy:demo.approval/RunApproval", [
        node("approval", "human_approval", {
          approval_ref: "approval:demo/RunApproval",
          approval_mode: "required_approval",
          context_refs: [],
          result_binding: "decision",
        }),
        node("done", "give", { arguments: ["value:decision"] }),
      ], [
        edge("approval", "done", "next"),
      ]),
    ],
    trace_points: [],
  };
}

function sandboxManifestDocument() {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {},
    triggers: {
      "trigger:demo.sandbox/ManualCheck": {
        enabled: true,
        source: {
          kind: "schedule",
          value: "every 1h",
        },
        target_ref: "strategy:demo.sandbox/RunTriggered",
        target_kind: "strategy",
        limits: {
          max_runs_per_day: 24,
          timeout_ms: 30000,
        },
      },
    },
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

function writeTestDecisionIdentity(root, { userRef, deviceRef }) {
  mkdirSync(join(root, ".touba"), { recursive: true });
  writeFileSync(join(root, ".touba", "product-identity.json"), JSON.stringify({
    schema_version: "touba-product-identity-v0.1",
    generated_at: new Date().toISOString(),
    summary: {
      user_count: 1,
      team_count: 1,
      device_count: 1,
      active_assignment_count: 0,
      revoked_device_count: 0,
    },
    users: [{
      user_ref: userRef,
      display_name: "Test Reviewer",
      email: null,
      status: "active",
      team_refs: ["team:test"],
      role_refs: ["role:test-reviewer"],
    }],
    teams: [{ team_ref: "team:test", name: "Test", owner_refs: [userRef] }],
    roles: [{ role_ref: "role:test-reviewer", name: "Reviewer", scope: "human_decision" }],
    devices: [{
      device_ref: deviceRef,
      user_ref: userRef,
      kind: "studio",
      status: "paired",
      paired_at: new Date().toISOString(),
      revoked_at: null,
    }],
    sessions: [],
    assignments: [],
    escalation_policies: [],
    events: [],
  }, null, 2), "utf8");
}
