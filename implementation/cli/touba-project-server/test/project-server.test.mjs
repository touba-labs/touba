import assert from "node:assert/strict";
import { readStoreFixture, writeStoreFixture } from "./store-fixtures.mjs";
import { spawn, spawnSync, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";

import {
  acceptMobilePairing,
  acceptDecision,
  authorizeHumanIdentity,
  bindDecisionSigner,
  filterLiveStateForIdentity,
  buildAuthorityGraph,
  buildGovernanceReadiness,
  buildHandlerSandboxStatus,
  buildElementAuthoringPreview,
  buildSupplyChainStatus,
  readCostObservatory,
  readMobileEscalation,
  readMobileNotifications,
  readMobileQuickApprovalPolicy,
  applyProjectChange,
  buildContractIndex,
  buildLiveState,
  buildProjectEvent,
  buildSandboxRunResult,
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
  projectOperationRecoveryDecision,
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
import { executeAirDocument } from "../../../runtime/touba-runtime/src/index.mjs";
import { generateHandlerStubFromAirTool } from "../../touba-manifest/src/stub.mjs";
import {
  archiveInteractionSession,
  completeInteractionOperation,
  createInteractionSession,
  enqueueInteractionOperation,
  getInteractionSession,
  listInteractionSessions,
  startInteractionOperation,
} from "../src/interactions.mjs";
import { createDeploymentTargetService } from "../../touba-deployment/src/serve.mjs";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";
import {
  AIR_CAPABILITY_PROFILE,
  AIR_JSON_PROFILE,
  AIR_SCHEMA_VERSION,
} from "../../../contracts/machine/contracts.mjs";

const contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname;

test("refusing a change requires mutation authority just like applying it", () => {
  for (const pathname of ["/changes/apply", "/changes/refuse"]) assert.equal(requiredIdentityPermission("POST", pathname), "governance.apply");
});

test("human decisions bind the signer to the authenticated subject", () => {
  const decision = { schema_version: "touba-approval-decision-v1", user_ref: "user:alice", decided_by: "user:alice" };
  assert.equal(bindDecisionSigner(decision, { active: true, user: { id: "alice" } }), decision);
  assert.equal(bindDecisionSigner(decision, null), decision);
  for (const identity of [{ active: false, user: { id: "alice" } }, { active: true, user: { id: "bob" } }, {}]) {
    assert.throws(() => bindDecisionSigner(decision, identity), { code: "ToubaServeDecisionIdentityUnauthorized" });
  }
  assert.throws(() => bindDecisionSigner({ ...decision, decided_by: "user:bob" }, { active: true, user: { id: "alice" } }), { code: "ToubaServeDecisionIdentityUnauthorized" });
  const review = { schema_version: "touba-human-review-decision-v1", user_ref: "user:alice", reviewed_by: "user:alice" };
  assert.equal(bindDecisionSigner(review, { active: true, user: { id: "user:alice" } }), review);
});

test("contract index lists product-surface contracts without filesystem paths", () => {
  const index = buildContractIndex({ contractsRoot, generatedAt: "2026-06-22T00:00:00Z" });

  assert.equal(index.schema_version, "touba-project-server-contract-index-v1");
  assert.equal(index.contracts.some((item) => item.schema_version === "touba-run-summary-v1"), true);
  assert.equal(index.contracts.every((item) => item.status === "available"), true);
  assert.equal(JSON.stringify(index).includes(contractsRoot), false);
});

test("element authoring preview renders and validates changes without mutating the project", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-element-preview-"));
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    const sourcePath = join(root, "src", "main.tb");
    const source = "module demo.preview\n";
    writeFileSync(sourcePath, source, "utf8");
    const preview = buildElementAuthoringPreview({
      projectRoot: root,
      generatedAt: "2026-09-22T20:00:00.000Z",
      request: {
        schema_version: "touba-element-authoring-request-v1",
        proposal_id: "preview_memory_001",
        module_ref: "demo.preview",
        element: { kind: "memory", name: "ReviewMemory", description: "" },
        requested_by: { kind: "studio", id: "touba-studio" },
        reason: "Preview a governed memory.",
      },
    });
    assertMatchesSchema("touba-element-authoring-preview-v1", preview);
    assert.equal(preview.impact.file_count, 1);
    assert.equal(preview.impact.update_count, 1);
    assert.match(preview.changes[0].diff, /\+memory ReviewMemory/u);
    assert.equal(readFileSync(sourcePath, "utf8"), source);
    assert.equal(existsSync(join(root, ".touba", "project-change-proposals.sqlite")), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("project server contracts keep product presentation outside the Touba project", () => {
  const inputPresentationSchema = new URL(
    "../../../contracts/product-surfaces/schemas/touba-input-presentation-v1.schema.json",
    import.meta.url,
  );
  const interactionContracts = readFileSync(
    new URL("../../../contracts/product-surfaces/interaction-contracts.mjs", import.meta.url),
    "utf8",
  );
  const serverSource = readFileSync(new URL("../src/serve.mjs", import.meta.url), "utf8")
    .split("\n")
    .filter((line) => !line.includes("LEGACY_CHANGE_"))
    .join("\n");

  assert.equal(existsSync(inputPresentationSchema), false);
  assert.doesNotMatch(interactionContracts, /generated_fields|touba\.inputs/u);
});

test("preflight rejects invalid contracts root and decision store path", () => {
  assert.throws(
    () => preflightServeOptions({
      contractsRoot: join(tmpdir(), "missing-touba-contracts"),
      humanDecisionsPath: join(tmpdir(), "human-decisions.sqlite"),
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

test("serve help documents host options and CLI names an identity outside the project", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-serve-identity-path-"));
  try {
    const cli = new URL("../../touba-project/src/main.mjs", import.meta.url).pathname;
    const help = spawnSync(process.execPath, [cli, "serve", "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    for (const flag of ["--identity <", "--agent-decision-provider <", "--agent-decision-provider-timeout-ms"]) assert.ok(help.stdout.includes(flag));
    const outside = join(root, "..", "identity-outside.json");
    const result = spawnSync(process.execPath, [cli, "serve", "--project-root", root, "--identity", outside, "--port", "0"], { encoding: "utf8", timeout: 10000 });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /ToubaServeProductIdentityPathInvalid/);
    assert.match(result.stderr, /identity-outside\.json/);
    assert.match(result.stderr, /inside the project root/);
    assert.equal(existsSync(join(root, ".touba")), false);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("authority graph preserves two approval sites without duplicating source and compiled gates", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-authority-gates-"));
  try {
    const source = join(root, "main.tb");
    writeFileSync(source, 'module gates.check\nstrategy Run\n    do\n        human.approve\n            with context as "First"\n            into first\n        human.approve\n            with context as "Second"\n            into second\n');
    const sourceGraph = buildAuthorityGraph({ projectRoot: root });
    assert.equal(sourceGraph.nodes.filter(node => node.kind === "human_gate").length, 2);
    const air = JSON.parse(execFileSync(process.env.CARGO ?? "cargo", ["run", "--quiet", "--manifest-path", new URL("../../../Cargo.toml", import.meta.url).pathname,
      "-p", "touba-cli", "--bin", "touba-compile", "--", source], { encoding: "utf8" }));
    writeFileSync(join(root, "main.air.json"), JSON.stringify(air));
    const graph = buildAuthorityGraph({ projectRoot: root });
    assertMatchesSchema("touba-authority-graph-v1", graph);
    const gates = graph.nodes.filter(node => node.kind === "human_gate");
    assert.equal(gates.length, 2);
    assert.equal(new Set(gates.map(node => node.ref)).size, 2);
    for (const gate of gates) {
      assert.ok(gate.ref.startsWith("human_gate:strategy:gates.check/Run/node:"));
      assert.equal(graph.edges.filter(edge => edge.to === gate.ref && edge.from === "strategy:gates.check/Run").length, 1);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('authority graph merges imported memories and marks calls required by source', () => {
  const root = mkdtempSync(join(tmpdir(), 'touba-authority-imported-memory-'));
  try {
    writeFileSync(join(root, 'library.tb'), 'module library\nmemory Notes\ntool Read\n    gives Text\n    uses memory Notes read\n    requires memory_read\n');
    for (const name of ['first','second','third','fourth']) {
      const source = join(root, `${name}.tb`);
      writeFileSync(source, `module ${name}\nimport tool Read from library\nimport memory Notes from library\nstrategy Run\n    gives Text\n    uses Read\n    memory Notes read\n    do\n        Read\n            into note\n        give note\n`);
      const air = execFileSync(process.execPath, [new URL('../../touba-project/src/main.mjs', import.meta.url).pathname,
        'compile',source,'--stdout','--source-root',root], {encoding:'utf8'});
      writeFileSync(join(root, `${name}.air.json`), air);
    }
    const graph = buildAuthorityGraph({projectRoot:root});
    assertMatchesSchema('touba-authority-graph-v1', graph);
    assert.deepEqual(graph.nodes.filter(node => node.kind === 'memory').map(node => node.ref), ['memory:library/Notes']);
    for (const name of ['first','second','third','fourth']) {
      const edge = graph.edges.find(edge => edge.from === `strategy:${name}/Run` && edge.to === 'tool:library/Read' && edge.kind === 'uses');
      assert.equal(edge?.required_by_source, true);
    }
  } finally { rmSync(root, {recursive:true, force:true}); }
});

test("project server ignores obsolete client change stores without modifying them", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-change-migration-"));
  const dataRoot = join(root, ".touba");
  mkdirSync(dataRoot, { recursive: true });
  const legacyPath = join(dataRoot, "studio-change-proposals.json");
  const currentPath = join(dataRoot, "project-change-proposals.sqlite");
  writeFileSync(legacyPath, JSON.stringify({
    schema_version: "touba-studio-change-proposals-v0.1",
    proposals: [{
      proposal_id: "legacy-proposal",
      status: "applied",
    }],
  }), "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    assert.equal(existsSync(currentPath), false);
    assert.equal(existsSync(legacyPath), true);
    assert.equal(existsSync(legacyPath + ".migrated"), false);
    assert.equal(JSON.parse(readFileSync(legacyPath, "utf8")).proposals[0].proposal_id, "legacy-proposal");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
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
  assert.equal(requiredIdentityPermission("GET", "/runs/example/trace"), "executions.read");
  for (const path of ["/runs/example/trace/segments/0", "/runs/example/trace/segments/123", "/runs/current", "/trace/current"]) {
    assert.equal(requiredIdentityPermission("GET", path), "executions.read", path);
  }
  assert.equal(
    requiredIdentityPermission("GET", "/operations/operation%3A17/recovery"),
    "executions.read",
  );
  assert.equal(requiredIdentityPermission("POST", "/runs/sandbox"), "executions.run");
  assert.equal(requiredIdentityPermission("POST", "/decisions"), "decisions.act");
  assert.equal(requiredIdentityPermission("GET", "/decisions"), "decisions.read");
  assert.equal(requiredIdentityPermission("GET", "/approvals/pending/current"), "decisions.read");
  assert.equal(requiredIdentityPermission("GET", "/reviews/pending/current"), "decisions.read");
  assert.equal(requiredIdentityPermission("POST", "/changes/propose"), "governance.propose");
  assert.equal(requiredIdentityPermission("POST", "/elements/preview"), "governance.propose");
  assert.equal(requiredIdentityPermission("POST", "/changes/apply"), "governance.apply");
  assert.equal(requiredIdentityPermission("POST", "/deployments/publish"), "deployments.publish");
});

test("operation recovery advertises resume only for retry-safe ambiguity", () => {
  const base = {
    correlations: { checkpoint_revision: 4, checkpoint_digest: `sha256:${"a".repeat(64)}` },
    execution: { resume_claim: null },
    generatedAt: "2026-09-22T12:00:00.000Z",
    human: undefined,
    status: "interrupted",
  };
  const effects = (reconciliation) => ({ reconciliation });

  const safe = projectOperationRecoveryDecision({ ...base, effects: effects("retry_safe") });
  assert.deepEqual(safe.allowedActions.map((action) => action.action), ["resume"]);
  assert.equal(safe.refusal, null);

  const reconcile = projectOperationRecoveryDecision({ ...base, effects: effects("provider_required") });
  assert.deepEqual(reconcile.allowedActions, []);
  assert.equal(reconcile.refusal.code, "EffectReconciliationRequired");

  const unavailable = projectOperationRecoveryDecision({ ...base, effects: effects("unavailable") });
  assert.deepEqual(unavailable.allowedActions, []);
  assert.equal(unavailable.refusal.code, "EffectOutcomeUnknown");
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

test("Cloud identity uses its API prefix, refuses redirects and binds the registered root", async () => {
  for (const root of ["/projects/invoice", "/projects/other"]) {
    const result = await authorizeHumanIdentity({ accessToken: "project-grant", permission: "projects.read",
      controlPlaneUrl: "https://cloud.example/api/v1/studio", serviceToken: "service-token",
      expectedProjectRoot: "/projects/invoice", fetchImpl: async (url, options) => {
        assert.equal(url.href, "https://cloud.example/api/v1/studio/auth/introspect");
        assert.equal(options.redirect, "error");
        return new Response(JSON.stringify({ active: true, user: { id: "user" }, project_root: root, permissions: ["projects.read"] }));
      } });
    assert.equal(result.allowed, root === "/projects/invoice");
  }
});

test("composite project state does not bypass trace and decision permissions", () => {
  const state = { project: { name: "demo" }, current_run: { id: "run" }, trace_timeline: { events: [] },
    events: {}, pending_approval: { request_id: "private" }, pending_review: {}, mobile_notifications: {}, cost_observatory: {} };
  const reader = filterLiveStateForIdentity(state, { active: true, permissions: ["projects.read"] });
  assert.equal(reader.project, state.project);
  for (const key of ["current_run", "trace_timeline", "events", "pending_approval", "pending_review", "mobile_notifications", "cost_observatory"]) assert.equal(reader[key], null, key);
  const auditor = filterLiveStateForIdentity(state, { active: true, permissions: ["executions.read"] });
  assert.equal(auditor.trace_timeline, state.trace_timeline);
  assert.equal(auditor.pending_approval, null);
  assert.deepEqual(filterLiveStateForIdentity(state, { active: true, permissions: ["*"] }), state);
  assert.equal(filterLiveStateForIdentity(state, null), state);
  assert.deepEqual(state.pending_approval, { request_id: "private" });
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
      : body.access_token === "execution-reader-token"
        ? ["executions.read"]
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
    for (const route of ["/approvals/pending/current", "/reviews/pending/current"]) {
      const refused = await fetch(baseUrl + route, { headers: { "x-touba-identity-token": "viewer-token" } });
      assert.equal(refused.status, 403);
    }

    const viewerRecovery = await fetch(`${baseUrl}/operations/missing/recovery`, {
      headers: { "x-touba-identity-token": "viewer-token" },
    });
    assert.equal(viewerRecovery.status, 403);
    assert.equal((await viewerRecovery.json()).code, "ToubaServeIdentityPermissionDenied");
    const executionReaderRecovery = await fetch(`${baseUrl}/operations/missing/recovery`, {
      headers: { "x-touba-identity-token": "execution-reader-token" },
    });
    assert.equal(executionReaderRecovery.status, 404);
    assert.equal((await executionReaderRecovery.json()).code, "ToubaServeOperationNotFound");

    const viewerWrite = await fetch(`${baseUrl}/project/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-identity-token": "viewer-token",
      },
      body: JSON.stringify({
        schema_version: "touba-project-refresh-request-v1",
        reason: "identity-test",
        requested_by: { kind: "studio", id: "identity-test" },
      }),
    });
    assert.equal(viewerWrite.status, 403);
    assert.equal((await viewerWrite.json()).code, "ToubaServeIdentityPermissionDenied");
    for (const token of ["viewer-token", "operator-token", "governor-token"]) {
      const prepare = await fetch(`${baseUrl}/project/prepare`, {
        method: "POST", headers: { "content-type": "application/json", "x-touba-identity-token": token }, body: "{}",
      });
      assert.equal(prepare.status, 403, "preparation requires governance.apply, not read, project management or proposal alone");
      const review = await fetch(`${baseUrl}/triggers/scheduler/acknowledge`, {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-touba-identity-token': token },
        body: JSON.stringify({trigger_ref:'trigger:demo/Job',run_id:'schedule_'+'a'.repeat(40),reason:'Review'}),
      });
      assert.equal(review.status, 403, 'schedule recovery requires governance.apply');
    }

    const operatorWrite = await fetch(`${baseUrl}/project/refresh`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-identity-token": "operator-token",
      },
      body: JSON.stringify({
        schema_version: "touba-project-refresh-request-v1",
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
        schema_version: "touba-project-change-proposal-v1",
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

  assert.equal(state.schema_version, "touba-project-live-state-v1");
  assert.equal(state.project.schema_version, "touba-project-inspection-v1");
  assert.equal(state.authority_graph.schema_version, "touba-authority-graph-v1");
  assert.equal(state.identity.schema_version, "touba-product-identity-v1");
  assert.equal(state.current_run.schema_version, "touba-run-summary-v1");
  assert.equal(state.trigger_queue_health.schema_version, "touba-trigger-queue-health-v1");
  assert.equal(state.supply_chain_status.schema_version, "touba-supply-chain-status-v1");
  assert.equal(state.governance_readiness.schema_version, "touba-governance-readiness-v1");
  assert.equal(state.cost_observatory.schema_version, "touba-cost-observatory-v1");
  assert.equal(state.handler_sandbox_status.schema_version, "touba-handler-sandbox-status-v1");
  assert.equal(state.mobile_notifications.schema_version, "touba-mobile-notification-v1");
  assert.equal(state.mobile_quick_approval_policy.schema_version, "touba-mobile-quick-approval-policy-v1");
  assert.equal(state.mobile_escalation.schema_version, "touba-mobile-escalation-v1");
  assert.equal(state.pending_approval, null);
  assert.equal(state.pending_review, null);
  assert.equal(state.featured_resource, null);
  assert.equal(state.alert, null);
  assert.equal(state.events.transport, "server_sent_events");
  assert.equal(state.events.event_schema_version, "touba-project-event-v1");
  assert.equal(state.project_server.refresh.schema_version, "touba-project-refresh-v1");
});

test("project events use a stable envelope contract", () => {
  const event = buildProjectEvent({
    type: "project.changed",
    sequence: 7,
    emittedAt: "2026-06-23T00:00:00.000Z",
    payload: {
      schema_version: "touba-project-refresh-v1",
      status: "refreshed",
    },
  });

  assert.equal(event.schema_version, "touba-project-event-v1");
  assert.equal(event.event_id, "evt_000007");
  assert.equal(event.sequence, 7);
  assertMatchesSchema("touba-project-event-v1", event);
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

test('repeated browser handshakes retain operational history and restart cursor continuity', t => {
  const root = mkdtempSync(join(tmpdir(), 'touba-handshake-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const eventJournalPath = join(root, 'events.jsonl');
  appendProjectEventJournal({ eventJournalPath, limit: 3, event: buildProjectEvent({ type: 'human_decision.accepted', sequence: 1, payload: {} }) });
  for (let sequence = 2; sequence <= 205; sequence++) {
    appendProjectEventJournal({ eventJournalPath, limit: 3, event: buildProjectEvent({ type: 'touba.server.ready', sequence, payload: {} }) });
  }
  const events = readProjectEventJournal(eventJournalPath);
  assert.deepEqual(events.map(item => item.sequence), [1, 2, 205]);
  assert.deepEqual(replayProjectEvents({ eventJournalPath, lastEventId: 'evt_000100' }).events.map(item => item.sequence), [205]);
  appendProjectEventJournal({ eventJournalPath, limit: 3, event: buildProjectEvent({ type: 'project.changed', sequence: events.at(-1).sequence + 1, payload: {} }) });
  assert.deepEqual(replayProjectEvents({ eventJournalPath, lastEventId: 'evt_000205' }).events.map(item => item.sequence), [206]);
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
      "    responsibility \"Review the requested change through the declared validation capability.\"",
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
    assertMatchesSchema("touba-authority-graph-v1", graph);
    assert.equal(graph.schema_version, "touba-authority-graph-v1");
    assert.equal(graph.nodes.some((node) => node.ref === "agent:examples.strategy_agents/Reviewer"), true);
    assert.equal(graph.nodes.some((node) => node.ref === "memory:demo.authority/ProjectKnowledge"), true);
    assert.equal(graph.nodes.some((node) => node.ref === "trigger:demo.authority/ReviewWebhook"), true);
    const gate = graph.nodes.find((node) => node.ref.startsWith("human_gate:skill:demo.authority/ValidateChange/source:"));
    assert.ok(gate);
    assert.equal(graph.nodes.some((node) => node.ref === "capability:secret:DEMO_SECRET"), true);
    assert.equal(graph.edges.some((edge) =>
      edge.kind === "callable_by"
      && edge.from === "strategy:examples.strategy_agents/RunChange"
      && edge.to === "agent:examples.strategy_agents/Reviewer"
    ), true);
    assert.equal(graph.edges.some((edge) =>
      edge.kind === "uses"
      && edge.from === "skill:demo.authority/ValidateChange"
      && edge.to === gate.ref
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
      "    responsibility \"Read only the account data required by the invoice workflow.\"",
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
      governance_action_schema_version: "touba-governance-action-v1",
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
      governance_action_schema_version: "touba-governance-action-v1",
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
      "    responsibility \"Summarize invoices only through the declared capability and caller.\"",
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
      lock_schema_version: "touba-lock-v1",
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
      JSON.stringify(readJson("fixtures/valid/touba-product-identity-v1.json")),
      "utf8",
    );
    writeStoreFixture(join(root, ".touba", "project-change-proposals.sqlite"), {
      schema_version: "touba-project-change-proposals-v1",
      proposals: [
        {
          schema_version: "touba-project-change-proposal-v1",
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
    });
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
    assertMatchesSchema("touba-supply-chain-status-v1", supplyChain);
    assert.equal(supplyChain.entries.find((entry) => entry.ref === "tool:demo.governance/ReadInvoice").status, "ok");

    const readiness = buildGovernanceReadiness({
      contractsRoot,
      projectRoot: root,
      productIdentityPath: join(root, ".touba", "product-identity.json"),
      changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
      generatedAt: "2026-06-23T00:00:02.000Z",
    });
    assertMatchesSchema("touba-governance-readiness-v1", readiness);
    assert.equal(readiness.artifacts.some((artifact) => artifact.kind === "trigger"), true);
    assert.equal(readiness.summary.pending_review > 0, true);

    const queueHealth = buildTriggerQueueHealth({
      contractsRoot,
      projectRoot: root,
      triggerStatusPath: join(root, ".touba", "trigger-status.json"),
      eventJournalPath: join(root, ".touba", "project-events.jsonl"),
      generatedAt: "2026-06-23T00:00:02.000Z",
    });
    assertMatchesSchema("touba-trigger-queue-health-v1", queueHealth);
    assert.equal(queueHealth.triggers[0].status, "watch");
    assert.equal(queueHealth.triggers[0].replay_rejected, 1);

    const sandbox = buildHandlerSandboxStatus({
      contractsRoot,
      projectRoot: root,
      platform: "darwin",
      generatedAt: "2026-06-23T00:00:02.000Z",
    });
    assertMatchesSchema("touba-handler-sandbox-status-v1", sandbox);
    assert.equal(sandbox.handlers[0].tool_ref, "tool:demo.governance/ReadInvoice");
    assert.equal(sandbox.handlers[0].implementation_status, 'present');
    assert.equal(sandbox.handlers[0].candidate_path, 'handlers/read-invoice.handler.mjs');
    assert.equal(sandbox.handlers[0].tests.status, 'missing');
    assert.equal(sandbox.handlers[0].status, "unknown", "a manifest requirement is not isolation evidence");
    assert.equal(sandbox.handlers[0].mechanism, "sandbox-exec");
    const claimed = structuredClone(sandbox);
    claimed.handlers[0].status = 'isolated'; claimed.summary.isolated = 1; claimed.summary.unknown = 0;
    writeFileSync(join(root, '.touba/handler-sandbox-status.json'), JSON.stringify(claimed));
    const untrusted = buildHandlerSandboxStatus({ contractsRoot, projectRoot: root, platform: 'darwin' });
    assert.equal(untrusted.handlers[0].status, 'unknown', 'a self-authored report cannot claim current runtime confinement');
    assert.equal(untrusted.summary.isolated, 0);
    assert.ok(untrusted.diagnostics.some(item => item.code === 'HandlerSandboxLegacyEvidenceIgnored'));
    for (const [platform, mechanism] of [["linux", "bubblewrap"], ["win32", "windows-lpac-job"], ["other", null]]) {
      const report = buildHandlerSandboxStatus({ contractsRoot, projectRoot: root, platform });
      assertMatchesSchema("touba-handler-sandbox-status-v1", report);
      assert.equal(report.handlers[0].status, mechanism ? "unknown" : "unsupported");
      assert.equal(report.handlers[0].mechanism, mechanism);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("product identity surface is empty until a project identity store exists", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-identity-"));
  try {
    const productIdentityPath = join(root, ".touba", "product-identity.json");
    const empty = readProductIdentity({ contractsRoot, productIdentityPath });
    assertMatchesSchema("touba-product-identity-v1", empty);
    assert.equal(empty.summary.user_count, 0);
    assert.deepEqual(empty.assignments, []);

    mkdirSync(join(root, ".touba"), { recursive: true });
    const fixture = readJson("fixtures/valid/touba-product-identity-v1.json");
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
    assertMatchesSchema("touba-product-identity-v1", identity);
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

  assertMatchesSchema("touba-cost-observatory-v1", costs);
  assertMatchesSchema("touba-mobile-notification-v1", notifications);
  assertMatchesSchema("touba-mobile-quick-approval-policy-v1", quickApproval);
  assertMatchesSchema("touba-mobile-escalation-v1", escalation);
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

    assertMatchesSchema("touba-mobile-pairing-request-v1", issued);
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
    const humanRequestsPath = join(root, ".touba", "human-requests.sqlite");
    const humanDecisionsPath = join(root, ".touba", "human-decisions.sqlite");
    const approval = readJson("fixtures/valid/touba-approval-request-v1.json");
    mkdirSync(join(root, ".touba"), { recursive: true });
    writeStoreFixture(
      humanRequestsPath,
      {
        schema_version: "touba-human-requests-v1",
        approvals: [approval],
        reviews: [],
      },
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

test("pending requests select the requested run without consuming another queue entry", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-pending-run-"));
  try {
    const humanRequestsPath = join(root, "requests.json");
    const humanDecisionsPath = join(root, "decisions.json");
    for (const [kind, schema, key] of [
      ["approval", "touba-approval-request-v1", "approvals"],
      ["human_review", "touba-human-review-request-v1", "reviews"],
    ]) {
      const first = readJson(`fixtures/valid/${schema}.json`);
      const second = { ...first, request_id: `${first.request_id}-second`, run_id: `${first.run_id}-second` };
      writeStoreFixture(humanRequestsPath, { schema_version: "touba-human-requests-v1", approvals: [], reviews: [], [key]: [first, second] });
      const options = { contractsRoot, humanRequestsPath, humanDecisionsPath, kind };
      assert.equal(readPendingHumanRequest(options).request_id, first.request_id);
      assert.equal(readPendingHumanRequest({ ...options, runId: second.run_id }).request_id, second.request_id);
      for (const runId of ["absent-run", ""]) {
        assert.throws(() => readPendingHumanRequest({ ...options, runId }), { code: "ToubaServePendingHumanRequestNotFound" });
      }
      assert.equal(readPendingHumanRequest(options).request_id, first.request_id);
    }
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
      request: { schema_version: "touba-project-refresh-request-v1" },
    });
    assert.equal(first.report.schema_version, "touba-project-refresh-v1");
    assert.equal(first.report.summary.artifact_count, 1);
    assert.equal(first.report.changes.changed_artifacts.length, 1);
    assert.equal(first.report.diagnostics.some((item) => item.code === "ToubaServeProjectAirStale"), true);

    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n// changed\n", "utf8");
    const second = refreshProject({
      projectRoot: root,
      previousSnapshot: first.snapshot,
      refreshedAt: "2026-06-22T00:00:01Z",
      request: { schema_version: "touba-project-refresh-request-v1" },
    });
    assert.deepEqual(second.report.changes.changed_artifacts.map((item) => item.relative_path), ["src/main.tb"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("change proposals are stored, applied atomically and cannot be replayed", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-change-"));
  try {
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");
    const proposed = proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-06-22T00:00:00Z",
      proposal: {
        schema_version: "touba-project-change-proposal-v1",
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
        schema_version: "touba-project-change-apply-v1",
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
          schema_version: "touba-project-change-apply-v1",
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");
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
            content: generateHandlerStubFromAirTool({ id: "tool:demo.main/LookupRecord" }),
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
        schema_version: "touba-project-change-apply-v1",
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");
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
          schema_version: "touba-project-change-apply-v1",
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
      schema_version: "touba-project-change-transaction-v1",
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
      sdk: "@touba/sdk",
      artifact_layout: "touba-artifacts-v1",
    })}\n`, "utf8");
    writeFileSync(join(root, "touba.manifest.json"), `${JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {},
      triggers: {},
    })}\n`, "utf8");
    writeFileSync(join(root, "touba.lock.json"), `${JSON.stringify({
      lock_version: "touba-lock-v1",
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
    assertMatchesSchema("touba-deployment-plan-v1", ready);

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
      "    responsibility \"Review records with the declared memory scope and caller.\"",
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");

    const proposed = proposeGovernanceRelationChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-07-22T00:00:00Z",
      request: {
        schema_version: "touba-governance-relation-change-v1",
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
        schema_version: "touba-project-change-apply-v1",
        proposal_id: "governance_add_uses",
        decision: "apply",
        decided_by: { kind: "user", id: "reviewer" },
        reason: "Authority reviewed.",
      },
    });
    assert.equal(applied.status, "applied");
    assert.match(readFileSync(sourcePath, "utf8"), /agent Reviewer\n    responsibility[^\n]+\n    uses SummarizeRecord\n    memory ReviewNotes write\n    callable_by strategy RunReview/u);
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
        schema_version: "touba-governance-relation-change-v1",
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
        schema_version: "touba-project-change-apply-v1",
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
      "    responsibility \"Perform only the bounded task delegated by an authorized caller.\"",
      "",
      "agent Supervisor",
      "    description \"Coordinates delegated work.\"",
      "    responsibility \"Coordinate work using only explicitly declared agents.\"",
      "",
    ].join("\n"), "utf8");
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");

    proposeGovernanceRelationChange({
      projectRoot: root,
      changeProposalsPath,
      request: {
        schema_version: "touba-governance-relation-change-v1",
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
        schema_version: "touba-project-change-apply-v1",
        proposal_id: "authorize_supervisor_worker",
        decision: "apply",
        decided_by: { kind: "user", id: "reviewer" },
        reason: "Delegation reviewed.",
      },
    });

    const source = readFileSync(sourcePath, "utf8");
    assert.match(source, /agent Worker\n    description[^\n]+\n    responsibility[^\n]+\n    callable_by agent Supervisor\n\nagent Supervisor/u);
    assert.match(source, /agent Supervisor\n    description[^\n]+\n    responsibility[^\n]+\n    uses Worker\n$/u);
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");

    proposeGovernanceRelationChange({
      projectRoot: root,
      changeProposalsPath,
      request: {
        schema_version: "touba-governance-relation-change-v1",
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
        schema_version: "touba-project-change-apply-v1",
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
        schema_version: "touba-governance-relation-change-v1",
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
        schema_version: "touba-project-change-apply-v1",
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
      "    responsibility \"Review only records supplied through declared capabilities.\"",
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");
    const request = {
      schema_version: "touba-governance-relation-change-v1",
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
        schema_version: "touba-project-change-proposal-v1",
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
          schema_version: "touba-project-change-apply-v1",
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");
    proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposedAt: "2026-06-23T00:00:00.000Z",
      proposal: {
        schema_version: "touba-project-change-proposal-v1",
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
        schema_version: "touba-project-change-proposal-v1",
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
        schema_version: "touba-project-change-apply-v1",
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
        schema_version: "touba-project-change-proposal-v1",
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
        schema_version: "touba-project-change-apply-v1",
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
    assertMatchesSchema("touba-project-change-history-v1", history);
    assert.deepEqual(history.summary, { total: 3, pending: 1, applied: 1, refused: 1 });
    assert.equal(JSON.stringify(history).includes("module demo"), false);
    assert.deepEqual(new Set(history.changes.map((item) => item.status)), new Set(["pending", "applied", "refused"]));

    const detail = getProjectChangeDetail({
      projectRoot: root,
      changeProposalsPath,
      proposalId: "applied_change",
      generatedAt: "2026-06-23T00:00:06.000Z",
    });
    assertMatchesSchema("touba-project-change-detail-v1", detail);
    assert.equal(detail.change.status, "applied");
    assert.equal(detail.change.evidence.write_mode, "atomic_rename");
    assert.equal(detail.change.decision_reason, "approved");
    const { diffs, ...detailMetadata } = detail.change;
    assert.equal(JSON.stringify(detailMetadata).includes("module demo"), false);
    assert.match(diffs[0].diff, /module demo.applied/);
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
        changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v1",
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
          schema_version: "touba-project-change-proposal-v1",
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");
    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v1",
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
          schema_version: "touba-project-change-proposal-v1",
          proposal_id: "bad_ownership",
          action: "write_text_file",
          target: { path: "touba.ownership.json" },
          requested_by: { kind: "studio", id: "touba-studio" },
          content: JSON.stringify({
            ownership_schema_version: "touba-ownership-v1",
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
          schema_version: "touba-project-change-proposal-v1",
          proposal_id: "bad_resources",
          action: "write_text_file",
          target: { path: "touba.resources.json" },
          requested_by: { kind: "studio", id: "touba-studio" },
          content: JSON.stringify({
            resource_bindings_schema_version: "touba-resource-bindings-v1",
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
          schema_version: "touba-project-change-proposal-v1",
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
        schema_version: "touba-project-change-proposal-v1",
        proposal_id: "package_ok",
        action: "write_text_file",
        target: { path: "touba.package.json" },
        requested_by: { kind: "studio", id: "touba-studio" },
        content: JSON.stringify({
          package_schema_version: "touba-package-v1",
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
    const changeProposalsPath = join(root, ".touba", "project-change-proposals.sqlite");
    const accepted = proposeProjectChange({
      projectRoot: root,
      changeProposalsPath,
      proposal: {
        schema_version: "touba-project-change-proposal-v1",
        proposal_id: "handler_stub_ok",
        action: "write_text_file",
        target: { path: "handlers/studio/studio_draft_tool.handler.mjs" },
        requested_by: { kind: "studio", id: "touba-studio" },
        content: generateHandlerStubFromAirTool({ id: "tool:studio/StudioDraftTool" }),
      },
    });
    assert.equal(accepted.status, "proposed");

    assert.throws(
      () => proposeProjectChange({
        projectRoot: root,
        changeProposalsPath,
        proposal: {
          schema_version: "touba-project-change-proposal-v1",
          proposal_id: "handler_arbitrary",
          action: "write_text_file",
          target: { path: "handlers/studio/arbitrary.handler.mjs" },
          requested_by: { kind: "studio", id: "touba-studio" },
          content: [
            "// Touba generated handler stub v0.1",
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
    const humanDecisionsPath = join(root, "human-decisions.sqlite");
    const decision = readJson("fixtures/valid/touba-approval-decision-v1.json");
    const accepted = acceptDecision({
      contractsRoot,
      humanDecisionsPath,
      decision,
      acceptedAt: "2026-06-22T00:00:00Z",
    });

    assert.equal(accepted.status, "accepted");
    const store = readStoreFixture(humanDecisionsPath);
    assert.equal(store.schema_version, "touba-human-decisions-v1");
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
    const humanDecisionsPath = join(root, "human-decisions.sqlite");
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
    assertMatchesSchema("touba-human-decision-history-v1", history);
    assert.deepEqual(history.summary, { total: 2, approvals: 1, reviews: 1 });
    assert.deepEqual(new Set(history.decisions.map((item) => item.decision_kind)), new Set(["approval", "human_review"]));

    const detail = getHumanDecisionDetail({
      humanDecisionsPath,
      schemaVersion: "touba-human-review-decision-v1",
      requestId: review.request_id,
      generatedAt: "2026-06-23T00:00:03.000Z",
    });
    assertMatchesSchema("touba-human-decision-detail-v1", detail);
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
        humanDecisionsPath: join(root, "human-decisions.sqlite"),
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
  writeStoreFixture(join(root, ".touba", "human-requests.sqlite"), {
    schema_version: "touba-human-requests-v1",
    approvals: [{
      ...readJson("fixtures/valid/touba-approval-request-v1.json"),
      expires_at: "2099-01-01T00:00:00.000Z",
    }],
    reviews: [],
  });
  writeTestDecisionIdentity(root, {
    userRef: "user:khadim",
    deviceRef: "device:review-phone-01",
  });
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.sqlite"),
    changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
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
      schema_version: "touba-project-change-proposal-v1",
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
      schema_version: "touba-project-change-apply-v1",
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
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: [
    "strategy:demo.main/RunReview", "function:demo.main/FormatReview", "tool:demo.main/StoreReview",
    "skill:demo.main/ReviewDraft", "trigger:demo.main/ReviewWebhook",
  ] }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.main\n", "utf8");
  const pendingReview = {
    ...readJson("fixtures/valid/touba-human-review-request-v1.json"),
    expires_at: "2099-01-01T00:00:00.000Z",
  };
  writeStoreFixture(join(root, ".touba", "human-requests.sqlite"), {
    schema_version: "touba-human-requests-v1",
    approvals: [],
    reviews: [pendingReview],
  });
  writeTestDecisionIdentity(root, {
    userRef: "user:khadim",
    deviceRef: "device:review-phone-01",
  });
  writeFileSync(join(root, ".touba", "air", "demo", "main.air.json"), JSON.stringify({
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
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
          signature: {
            inputs: [{ name: "request", type_ref: "type:demo.main/ReviewRequest" }],
            output_type: "builtin:Text",
          },
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
    package_schema_version: "touba-package-v1",
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
    humanDecisionsPath: join(root, "human-decisions.sqlite"),
    changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const health = await getJson(`${baseUrl}/health`);
    assert.equal(health.endpoints.trace_storage, "/traces/storage");
    assert.equal(requiredIdentityPermission("GET", "/traces/storage"), "executions.read");
    const storageStatus = await getJson(`${baseUrl}/traces/storage`);
    assertMatchesSchema("touba-trace-storage-status-v1", storageStatus);
    assert.equal(storageStatus.storage.kind, "sqlite");
    assert.equal(storageStatus.exports.length, 0);
    assert.equal(health.status, "ok");
    assert.equal(health.service, "touba-project-server");
    assert.equal(health.endpoints.events, "/events");
    assert.equal(health.endpoints.trigger_queue_health, "/triggers/queue-health");
    assert.equal(health.endpoints.supply_chain_status, "/supply-chain/status");
    assert.equal(health.endpoints.governance_readiness, "/governance/readiness");
    assert.equal(health.endpoints.project_refresh_status, "/project/refresh");
    assert.equal(health.endpoints.package_registry, undefined);
    assert.equal(health.endpoints.package_local_preview, "/packages/local/preview");
    assert.equal(health.endpoints.package_cancel, "/packages/cancel");
    for (const action of ["message", "resume", "cancel", "archive"]) {
      assert.match(health.endpoints[`interaction_${action}`], /^\/interactions\/sessions\/<session_id>\//u);
    }

    const state = await getJson(`${baseUrl}/state`);
    assert.equal(state.schema_version, "touba-project-live-state-v1");
    assert.equal(state.project_server.refresh.summary.artifact_count, 4);
    const refreshStatus = await getJson(`${baseUrl}/project/refresh`);
    assert.deepEqual(refreshStatus, state.project_server.refresh);
    assert.equal(requiredIdentityPermission("GET", "/project/refresh"), "projects.read");
    assert.equal(requiredIdentityPermission("POST", "/project/refresh"), "projects.manage");
    assert.equal(validateObject(JSON.parse(readFileSync(join(contractsRoot, "schemas/touba-project-refresh-v1.schema.json"))), refreshStatus).length, 0);
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
      status: "invalid",
      digest: project.packages[0].digest,
      digest_kind: "manifest",
      manifest_digest: project.packages[0].digest,
      lock_digest: null,
      expected_digest: null,
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
    assert.equal(agentEntrypoint, undefined, "agents remain inspectable but require an authorized caller");
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
    const strategyEntrypoint = project.entrypoints.find((entrypoint) => entrypoint.kind === "strategy");
    assert.equal(Object.hasOwn(strategyEntrypoint.interaction_contract, "generated_fields"), false);
    assert.equal(JSON.stringify(project).includes("billing-agent"), false);
    assertMatchesSchema("touba-project-inspection-v1", project);

    const authorityGraph = await getJson(`${baseUrl}/authority/graph`);
    assertMatchesSchema("touba-authority-graph-v1", authorityGraph);
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
    assertMatchesSchema("touba-product-identity-v1", identity);
    assert.equal(health.endpoints.identity, "/identity");

    const runSummary = await getJson(`${baseUrl}/runs/current`);
    assert.equal(runSummary.schema_version, "touba-run-summary-v1");

    const triggerQueueHealth = await getJson(`${baseUrl}/triggers/queue-health`);
    assertMatchesSchema("touba-trigger-queue-health-v1", triggerQueueHealth);
    const supplyChainStatus = await getJson(`${baseUrl}/supply-chain/status`);
    assertMatchesSchema("touba-supply-chain-status-v1", supplyChainStatus);
    const governanceReadiness = await getJson(`${baseUrl}/governance/readiness`);
    assertMatchesSchema("touba-governance-readiness-v1", governanceReadiness);

    const eventStream = await fetch(`${baseUrl}/events`);
    assert.equal(eventStream.status, 200);
    assert.match(eventStream.headers.get("content-type"), /text\/event-stream/);
    const { text: readyText, reader } = await readNextEvent(eventStream);
    const readyEvent = parseSseEvent(readyText);
    assertMatchesSchema("touba-project-event-v1", readyEvent);
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
    assertMatchesSchema("touba-project-event-v1", replayedEvent);
    assert.equal(replayedEvent.type, "human_decision.accepted");
    await replayReader.cancel();

    const decisionHistory = await getJson(`${baseUrl}/decisions`);
    assertMatchesSchema("touba-human-decision-history-v1", decisionHistory);
    assert.equal(decisionHistory.summary.reviews, 1);

    const decisionDetail = await getJson(`${baseUrl}/decisions/${encodeURIComponent(decision.schema_version)}/${encodeURIComponent(decision.request_id)}`);
    assertMatchesSchema("touba-human-decision-detail-v1", decisionDetail);
    assert.equal(decisionDetail.decision.request_id, decision.request_id);
    assert.equal(decisionDetail.decision.decision_kind, "human_review");

    const functionSessionResponse = await postJson(`${baseUrl}/interactions/sessions`, {
      schema_version: "touba-interaction-session-create-v1",
      target_ref: functionEntrypoint.ref,
      target_kind: "function",
      presentation: functionEntrypoint.interaction_contract.presentation,
      effect_policy: "runtime_only",
      requested_by: { kind: "cli", id: "generic-client-test" },
    });
    assert.equal(functionSessionResponse.status, 201);
    assert.equal((await functionSessionResponse.json()).target_kind, "function");

    writeFileSync(join(root, "src", "main.tb"), "module demo.main\n// refresh\n", "utf8");
    const refreshResponse = await fetch(`${baseUrl}/project/refresh`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-refresh-request-v1",
        requested_by: { kind: "studio", id: "test-suite" },
        reason: "http-test-refresh",
      }),
    });
    assert.equal(refreshResponse.status, 202);
    const refresh = await refreshResponse.json();
    assertMatchesSchema("touba-project-refresh-v1", refresh);
    assert.deepEqual(refresh.changes.changed_artifacts.map((item) => item.relative_path), ["src/main.tb"]);

    const proposedResponse = await fetch(`${baseUrl}/changes/propose`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-change-proposal-v1",
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
    assertMatchesSchema("touba-project-change-proposed-v1", proposed);
    assert.equal(proposed.status, "proposed");

    const pendingHistory = await getJson(`${baseUrl}/changes`);
    assertMatchesSchema("touba-project-change-history-v1", pendingHistory);
    assert.equal(pendingHistory.summary.pending, 1);

    const pendingDetail = await getJson(`${baseUrl}/changes/http_change_001`);
    assertMatchesSchema("touba-project-change-detail-v1", pendingDetail);
    assert.equal(pendingDetail.change.status, "pending");
    const { diffs, ...pendingMetadata } = pendingDetail.change;
    assert.equal(JSON.stringify(pendingMetadata).includes("project_version"), false);
    assert.match(diffs[0].diff, /project_version/);

    const applyResponse = await fetch(`${baseUrl}/changes/apply`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        schema_version: "touba-project-change-apply-v1",
        proposal_id: "http_change_001",
        decision: "apply",
        decided_by: { kind: "user", id: "khadim" },
        reason: "http apply test",
      }),
    });
    assert.equal(applyResponse.status, 202);
    const applied = await applyResponse.json();
    assertMatchesSchema("touba-project-change-result-v1", applied);
    assert.equal(applied.status, "applied");
    assert.equal(existsSync(join(root, "touba.project.json")), true);

    const appliedHistory = await getJson(`${baseUrl}/changes`);
    assertMatchesSchema("touba-project-change-history-v1", appliedHistory);
    assert.equal(appliedHistory.summary.applied, 1);

    const appliedDetail = await getJson(`${baseUrl}/changes/http_change_001`);
    assertMatchesSchema("touba-project-change-detail-v1", appliedDetail);
    assert.equal(appliedDetail.change.status, "applied");
    assert.equal(appliedDetail.change.evidence.write_mode, "atomic_rename");

    const { text: eventText } = await readNextEventFromReader(reader);
    const emittedEvent = parseSseEvent(eventText);
    assertMatchesSchema("touba-project-event-v1", emittedEvent);
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
    "    responsibility \"Review only records supplied through declared capabilities.\"",
    "",
  ].join("\n"), "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, ".touba", "human-decisions.sqlite"),
    changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const proposalResponse = await postJson(`${baseUrl}/governance/relations/propose`, {
      schema_version: "touba-governance-relation-change-v1",
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
    assertMatchesSchema("touba-project-change-proposed-v1", await proposalResponse.json());

    const applyResponse = await postJson(`${baseUrl}/changes/apply`, {
      schema_version: "touba-project-change-apply-v1",
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
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.sandbox/RunReady","strategy:demo.sandbox/EchoInput","function:demo.sandbox/FormatReady","trigger:demo.sandbox/ManualCheck"] }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.sandbox\n", "utf8");
  writeFileSync(join(root, ".touba", "air", "demo", "main.air.json"), JSON.stringify(sandboxAirDocument({ withInput: true }), null, 2), "utf8");
  writeFileSync(join(root, "touba.manifest.json"), JSON.stringify(sandboxManifestDocument(), null, 2), "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.sqlite"),
    changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
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
      schema_version: "touba-sandbox-run-request-v1",
      execution_kind: "entrypoint",
      target_ref: "strategy:demo.sandbox/RunReady",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "test sandbox run",
    });
    const run = await runResponse.json();
    assert.equal(runResponse.status, 200, JSON.stringify(run));
    assertMatchesSchema("touba-sandbox-run-result-v1", run);
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
      schema_version: "touba-sandbox-run-request-v1",
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

    const inputResponse = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v1",
      execution_kind: "entrypoint",
      target_ref: "strategy:demo.sandbox/EchoInput",
      effect_policy: "runtime_only",
      inputs: { query: "caller-provided" },
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "keep non-empty input runs non-durable until RESUME-1 models inputs",
    });
    assert.equal(inputResponse.status, 200);
    const inputRun = await inputResponse.json();
    assert.equal(inputRun.status, "success");
    assert.equal(inputRun.result, "caller-provided");
    assert.equal(inputRun.trace.entry_ref, "strategy:demo.sandbox/EchoInput");

    const triggerResponse = await postJson(`${baseUrl}/triggers/fire`, {
      schema_version: "touba-sandbox-run-request-v1",
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
    assertMatchesSchema("touba-sandbox-run-result-v1", triggerRun);
    assert.equal(triggerRun.status, "success");
    assert.equal(triggerRun.result, "triggered");
    assert.equal(triggerRun.trace.entry_ref, "trigger:demo.sandbox/ManualCheck");
    const checkpoints = readStoreFixture(join(root, ".touba", "sandbox-checkpoints.sqlite"));
    const executionRecords = checkpoints.records.filter((record) => record.record_kind === "execution");
    assert.deepEqual(
      executionRecords.map((record) => record.target_ref).sort(),
      ["function:demo.sandbox/FormatReady", "strategy:demo.sandbox/RunReady"],
      "direct strategies and function body graphs are durable, triggers are deliberately excluded",
    );
    assert.equal(executionRecords.every((record) => record.status === "completed"), true);
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const surface of ["sandbox", "interaction", "application"]) {
  test(`initial durable ${surface} execution revalidates control-plane authority before handler spawn`, async () => {
    const root = mkdtempSync(join(tmpdir(), `touba-project-server-initial-authority-${surface}-`));
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.sandbox/RunTool"] }));
    const accessToken = `identity-initial-${surface}-token`;
    const serviceToken = "identity-initial-service-token-at-least-32-characters";
    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
    const journalPath = join(root, ".touba", "project.effect-journal.sqlite");
    const sessionsPath = join(root, ".touba", "interaction-sessions.sqlite");
    const handlerStartedPath = join(root, ".touba", "initial-handler-started");
    let identityActive = true;
    let identityChecks = 0;
    let observeDispatchAuthority;
    const dispatchAuthorityObserved = new Promise((resolveObserved) => {
      observeDispatchAuthority = resolveObserved;
    });
    let releaseDispatchAuthority;
    const dispatchAuthorityGate = new Promise((resolveAuthority) => {
      releaseDispatchAuthority = resolveAuthority;
    });
    const identityServer = createHttpServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.headers["x-touba-service-token"], serviceToken);
      assert.equal(body.access_token, accessToken);
      identityChecks += 1;
      if (identityChecks === 2) {
        observeDispatchAuthority();
        await dispatchAuthorityGate;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        active: identityActive,
        permissions: identityActive ? ["executions.run"] : [],
        ...(surface === 'application' ? { project_root: root, principal: { kind: 'service', id: 'application-initial' },
          scopes: ['executions.invoke'], targets: ['strategy:demo.sandbox/RunTool'] }
          : { user: { id: "user:initial-authority" } }),
      }));
    });
    let service;
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
      writeFileSync(join(root, "src", "main.tb"), "module demo.sandbox\n", "utf8");
      writeFileSync(
        join(root, ".touba", "air", "demo", "main.air.json"),
        JSON.stringify(sandboxAirDocument({ withTool: true }), null, 2),
        "utf8",
      );
      const handlerPath = join(root, "initial-authority-handler.mjs");
      writeFileSync(handlerPath, `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(handlerStartedPath)}, "started\\n", "utf8");
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", () => {
          const request = JSON.parse(input);
          process.stdout.write(JSON.stringify({
            ok: true,
            value: "must-not-run",
            effect_receipt: {
              effect_id: request.effect.effect_id,
              request_digest: request.effect.request_digest,
              outcome: "applied",
              receipt_ref: "opaque:test:must-not-run",
            },
          }));
        });
      `, "utf8");
      writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({
        manifest_version: "touba-manifest-v1",
        bindings: {
          "tool:demo.sandbox/ReadExternal": {
            handler: { kind: "process", command: process.execPath, args: [handlerPath], cwd: root },
            grants: ["network"],
            secrets: [],
            timeout_ms: 10000,
            max_payload_bytes: 16384,
            effect_contract: { kind: "external_write", retry_mode: "idempotency_key" },
          },
        },
      }, null, 2), "utf8");
      let session;
      if (surface !== "sandbox") {
        session = createInteractionSession({
          request: {
            target_ref: "strategy:demo.sandbox/RunTool",
            target_kind: "strategy",
            presentation: "workflow",
            effect_policy: "allow_declared_external_effects",
            requested_by: surface === 'application' ? { kind: 'service', id: 'application-initial' } : { kind: "user", id: "user:initial-authority" },
          },
          sessionsPath,
        });
      }
      await listenHttpServer(identityServer);
      service = createToubaProjectServer({
        contractsRoot,
        identityControlPlaneUrl: `http://127.0.0.1:${identityServer.address().port}`,
        identityServiceToken: serviceToken,
        port: 0,
        projectRoot: root,
        quiet: true,
      });
      await service.start();
      const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
      let pendingResponse;
      let operationId;
      if (surface === "sandbox") {
        pendingResponse = fetch(`${baseUrl}/runs/sandbox`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-touba-identity-token": accessToken,
          },
          body: JSON.stringify({
            schema_version: "touba-sandbox-run-request-v1",
            execution_kind: "entrypoint",
            target_ref: "strategy:demo.sandbox/RunTool",
            effect_policy: "allow_declared_external_effects",
            inputs: {},
            requested_by: { kind: "user", id: "spoofed" },
            reason: "verify initial pre-spawn authority",
          }),
        });
      } else {
        const accepted = await fetch(`${baseUrl}/interactions/sessions/${session.session_id}/messages`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            "x-touba-identity-token": accessToken,
          },
          body: JSON.stringify({
            schema_version: "touba-interaction-message-request-v1",
            message_id: "message:initial-authority",
            display_text: "Run only while my authority remains active.",
            inputs: {},
            requested_by: { kind: "user", id: "spoofed" },
          }),
        });
        assert.equal(accepted.status, 202);
        operationId = (await accepted.json()).operation_id;
      }

      await withTimeout(dispatchAuthorityObserved, "initial dispatch authority introspection");
      assert.equal(identityChecks, 2);
      const checkpointStore = readStoreFixture(checkpointPath);
      assert.equal(checkpointStore.records[0].status, "running");
      const journalAtAuthorityCheck = readStoreFixture(journalPath);
      const [dispatchedEntry] = Object.values(journalAtAuthorityCheck.entries);
      assert.equal(dispatchedEntry.state, "dispatched");
      identityActive = false;
      releaseDispatchAuthority();

      if (surface === "sandbox") {
        const refusedResponse = await withTimeout(pendingResponse, "initial authority-refused response");
        assert.equal(refusedResponse.status, 200);
        const refused = await refusedResponse.json();
        assert.equal(refused.status, "failure");
        assert.equal(
          refused.diagnostics.some((diagnostic) => diagnostic.code === "DurableResumeAuthorityRefused"),
          true,
        );
      } else {
        const terminal = await waitForStoredInteractionOperation({ operationId, sessionsPath });
        assert.equal(terminal.status, "failed");
        assert.equal(terminal.error.code, "DurableResumeAuthorityRefused");
      }
      assert.equal(existsSync(handlerStartedPath), false);
      for (const persistedPath of [checkpointPath, journalPath, sessionsPath]) {
        if (existsSync(persistedPath)) {
          assert.equal(readFileSync(persistedPath, "utf8").includes(accessToken), false);
        }
      }
    } finally {
      releaseDispatchAuthority?.();
      await service?.stop();
      await closeHttpServer(identityServer);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("HTTP durable resume reconstructs the terminal result and coalesces one claimed revision", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-durable-resume-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.sandbox/RunReady"] }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.sandbox\n", "utf8");
  writeFileSync(
    join(root, ".touba", "air", "demo", "main.air.json"),
    JSON.stringify(sandboxAirDocument(), null, 2),
    "utf8",
  );
  writeFileSync(join(root, "touba.manifest.json"), JSON.stringify(sandboxManifestDocument(), null, 2), "utf8");
  let service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
  try {
    await service.start();
    let baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const initialResponse = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v1",
      execution_kind: "entrypoint",
      target_ref: "strategy:demo.sandbox/RunReady",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "create a real durable checkpoint",
    });
    const initial = await initialResponse.json();
    assert.equal(initialResponse.status, 200, JSON.stringify(initial));
    await service.stop();

    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
    const store = readStoreFixture(checkpointPath);
    const record = store.records.find((candidate) => candidate.record_kind === "execution");
    assert.equal(record.checkpoint.cursor.phase, "started");
    record.status = "running";
    record.result = null;
    record.resume_claim = null;
    writeStoreFixture(checkpointPath, store);

    service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
    await service.start();
    baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const resumeRequest = {
      schema_version: "touba-operation-resume-request-v1",
      operation_id: record.operation_id,
      checkpoint_revision: record.checkpoint.revision,
      checkpoint_digest: record.checkpoint.checkpoint_digest,
      resume_request_id: "resume:terminal-window",
    };
    const recoveryResponse = await fetch(
      `${baseUrl}/operations/${encodeURIComponent(record.operation_id)}/recovery`,
    );
    assert.equal(recoveryResponse.status, 200);
    const recovery = await recoveryResponse.json();
    assertMatchesSchema("touba-operation-recovery-v1", recovery);
    assert.equal(recovery.status, "interrupted");
    assert.equal(recovery.budgets.status, "available");
    const toolBudget = recovery.budgets.rows.find(row => row.kind === "max_tool_calls");
    assert.equal(toolBudget.charged, record.checkpoint.runtime_state.budget_counters.tool_calls);
    assert.equal(toolBudget.reserved, record.checkpoint.pending_dispatch?.budget_reserved?.tool_calls ?? 0);
    assert.equal(toolBudget.limit, record.checkpoint.runtime_state.effective_limits.max_tool_calls ?? null);
    assert.equal(recovery.freshness.state_revision, record.checkpoint.revision);
    assert.equal(recovery.correlations.checkpoint_digest, record.checkpoint.checkpoint_digest);
    assert.deepEqual(recovery.allowed_actions.map((action) => action.action), ["resume"]);
    assert.equal(recovery.allowed_actions[0].required_permission, "executions.run");
    assert.equal(recovery.refusal, null);
    const airPath = join(root, ".touba", "air", "demo", "main.air.json");
    const originalAir = readFileSync(airPath), checkpointBeforePreview = readFileSync(checkpointPath);
    writeFileSync(airPath, JSON.stringify({ ...JSON.parse(originalAir), preview_change: true }));
    const incompatible = await getJson(`${baseUrl}/operations/${encodeURIComponent(record.operation_id)}/recovery`);
    assert.deepEqual(incompatible.allowed_actions, []);
    assert.equal(incompatible.refusal.code, "DurableResumeCheckpointIncompatible");
    assert.notEqual(incompatible.freshness.state_digest, recovery.freshness.state_digest);
    assert.deepEqual(readFileSync(checkpointPath), checkpointBeforePreview, "compatibility preview is read-only");
    writeFileSync(airPath, originalAir);
    const restored = await getJson(`${baseUrl}/operations/${encodeURIComponent(record.operation_id)}/recovery`);
    assert.deepEqual(restored.allowed_actions.map(action => action.action), ["resume"]);
    assert.equal(restored.freshness.state_digest, recovery.freshness.state_digest);
    const wrongVersion = await postJson(`${baseUrl}/runs/sandbox/resume`, {
      ...resumeRequest,
      schema_version: "touba-operation-resume-request-v0",
    });
    assert.equal(wrongVersion.status, 400);
    assert.equal((await wrongVersion.json()).code, "DurableResumeCheckpointInvalid");
    const [firstResponse, coalescedResponse] = await Promise.all([
      postJson(`${baseUrl}/runs/sandbox/resume`, resumeRequest),
      postJson(`${baseUrl}/runs/sandbox/resume`, resumeRequest),
    ]);
    assert.equal(firstResponse.status, 200);
    assert.equal(coalescedResponse.status, 200);
    const first = await firstResponse.json();
    const coalesced = await coalescedResponse.json();
    assert.deepEqual(coalesced, first);
    assert.equal(first.run_id, initial.run_id);
    assert.equal(first.result, "ready");
    const nativeEvidence = await (await fetch(`${baseUrl}/runs/${first.run_id}/trace`)).json();
    assert.equal(nativeEvidence.complete, true);
    assert.deepEqual(nativeEvidence.segments.map(segment => segment.phase), ["initial", "execution_resume"]);
    assertMatchesSchema("touba-run-trace-export-v1", nativeEvidence);
    const traceUrl = `${baseUrl}/runs/${first.run_id}/trace`;
    const traceIndex = await getJson(`${traceUrl}?index=true`);
    assert.equal(traceIndex.schema_version, "touba-native-trace-index-v1");
    assert.equal(traceIndex.segments.length, 2);
    for (const [index, segment] of nativeEvidence.segments.entries()) {
      let after = segment.trace.events[0].sequence_index - 1;
      const events = [];
      while (true) {
        const page = await getJson(`${traceUrl}/segments/${index}?after=${after}&limit=2`);
        assert.ok(page.events.length <= 2);
        events.push(...page.events); after = page.next;
        if (page.done) break;
      }
      assert.deepEqual(events, segment.trace.events);
    }
    for (const query of ["limit=0", "limit=1001", "after=-2", "after=NaN", "after=99999999"]) {
      assert.equal((await fetch(`${traceUrl}/segments/0?${query}`)).status, 400);
    }
    assert.deepEqual(first.trace.events.map((event) => event.index), first.trace.events.map((_, index) => index));

    const repeated = await postJson(`${baseUrl}/runs/sandbox/resume`, resumeRequest);
    assert.equal(repeated.status, 200);
    assert.deepEqual(await repeated.json(), first);
    const divergent = await postJson(`${baseUrl}/runs/sandbox/resume`, {
      ...resumeRequest,
      resume_request_id: "resume:divergent",
    });
    assert.equal(divergent.status, 409);
    assert.equal((await divergent.json()).code, "DurableResumeConflict");
    const completedStore = readStoreFixture(checkpointPath);
    assert.equal(completedStore.records[0].status, "completed");
    assert.equal(completedStore.records[0].resume_claim.status, "completed");
    const completedRecovery = await getJson(
      `${baseUrl}/operations/${encodeURIComponent(record.operation_id)}/recovery`,
    );
    assert.equal(completedRecovery.status, "completed");
    assert.deepEqual(completedRecovery.allowed_actions, []);
    assert.equal(completedRecovery.refusal.code, "OperationTerminal");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("SIGKILL after an applied effect resumes explicitly without redispatching the mutation", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-sigkill-resume-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.sandbox/RunTool"] }));
  const effectRequests = [];
  const appliedEffects = new Set();
  const effectService = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    effectRequests.push(body);
    appliedEffects.add(body.effect_id);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: "created-once" }));
  });
  let worker;
  let resumedServer;
  try {
    await new Promise((resolveListen, rejectListen) => {
      effectService.once("error", rejectListen);
      effectService.listen(0, "127.0.0.1", resolveListen);
    });
    const effectPort = effectService.address().port;
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), "module demo.sandbox\n", "utf8");
    writeFileSync(
      join(root, ".touba", "air", "demo", "main.air.json"),
      JSON.stringify(sandboxAirDocument({ withTool: true }), null, 2),
      "utf8",
    );
    const handlerPath = join(root, "effect-handler.mjs");
    writeFileSync(handlerPath, `
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", async () => {
        const request = JSON.parse(input);
        const response = await fetch("http://127.0.0.1:${effectPort}/mutate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            effect_id: request.effect.effect_id,
            request_digest: request.effect.request_digest,
          }),
        });
        const result = await response.json();
        process.stdout.write(JSON.stringify({
          ok: true,
          value: result.value,
          effect_receipt: {
            effect_id: request.effect.effect_id,
            request_digest: request.effect.request_digest,
            outcome: "applied",
            receipt_ref: "opaque:test:created-once",
          },
        }));
      });
    `, "utf8");
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:demo.sandbox/ReadExternal": {
          handler: { kind: "process", command: process.execPath, args: [handlerPath], cwd: root },
          grants: ["network"],
          secrets: [],
          timeout_ms: 10000,
          max_payload_bytes: 16384,
          effect_contract: { kind: "external_write", retry_mode: "idempotency_key" },
        },
      },
    }, null, 2), "utf8");

    const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
    const journalPath = join(root, ".touba", "project.effect-journal.sqlite");
    const appliedMarkerPath = join(root, ".touba", "effect-applied-before-host-advance");
    const harnessPath = join(root, "crash-worker.mjs");
    const projectServerModule = new URL("../src/serve.mjs", import.meta.url).href;
    const journalModule = new URL("../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs", import.meta.url).href;
    writeFileSync(harnessPath, `
      import { writeFileSync } from "node:fs";
      import { executeProjectSandboxRun } from ${JSON.stringify(projectServerModule)};
      import { createSqliteEffectJournal } from ${JSON.stringify(journalModule)};
      const persisted = createSqliteEffectJournal(${JSON.stringify(journalPath)});
      const blockingJournal = {
        schemaVersion: persisted.schemaVersion,
        readEntry: (effectId) => persisted.readEntry(effectId),
        entriesForScope: (scopeId) => persisted.entriesForScope(scopeId),
        writeEntry(entry) {
          persisted.writeEntry(entry);
          if (entry.state === "applied") {
            writeFileSync(${JSON.stringify(appliedMarkerPath)}, "applied\\n", "utf8");
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
          }
        },
      };
      const result = await executeProjectSandboxRun({
        contractsRoot: ${JSON.stringify(contractsRoot)},
        effectJournal: blockingJournal,
        effectJournalPath: ${JSON.stringify(journalPath)},
        executionKind: "entrypoint",
        humanRequestsPath: ${JSON.stringify(join(root, ".touba", "human-requests.sqlite"))},
        operationId: "operation:sigkill-applied",
        projectRoot: ${JSON.stringify(root)},
        request: {
          schema_version: "touba-sandbox-run-request-v1",
          execution_kind: "entrypoint",
          target_ref: "strategy:demo.sandbox/RunTool",
          effect_policy: "allow_declared_external_effects",
          inputs: {},
          requested_by: { kind: "service", id: "sigkill-proof" },
          reason: "prove durable host recovery after applied effect",
        },
        runId: "run:sigkill-applied",
        runSummaryPath: ${JSON.stringify(join(root, ".touba", "current-run-summary.json"))},
        sandboxCheckpointsPath: ${JSON.stringify(checkpointPath)},
        traceTimelinePath: ${JSON.stringify(join(root, ".touba", "current-trace-timeline.json"))},
      });
      process.stderr.write(JSON.stringify(result));
    `, "utf8");

    let workerStderr = "";
    worker = spawn(process.execPath, [harnessPath], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
    worker.stderr.on("data", (chunk) => { workerStderr += chunk.toString("utf8"); });
    await waitForPath(appliedMarkerPath, worker, () => workerStderr);
    assert.equal(effectRequests.length, 1);
    assert.equal(appliedEffects.size, 1);
    const journalBeforeKill = readStoreFixture(journalPath);
    const [appliedEntry] = Object.values(journalBeforeKill.entries);
    assert.equal(appliedEntry.state, "applied");
    const beforeKill = readStoreFixture(checkpointPath).records[0];
    assert.equal(beforeKill.status, "running");
    assert.equal(beforeKill.checkpoint.pending_dispatch.effect_id, appliedEntry.effect_id);

    worker.kill("SIGKILL");
    await waitForChildExit(worker);
    worker = undefined;

    resumedServer = await startProjectServerProcess(root);
    const interrupted = readStoreFixture(checkpointPath).records[0];
    assert.equal(interrupted.status, "interrupted");
    const resumeRequest = {
      schema_version: "touba-operation-resume-request-v1",
      operation_id: interrupted.operation_id,
      checkpoint_revision: interrupted.checkpoint.revision,
      checkpoint_digest: interrupted.checkpoint.checkpoint_digest,
      resume_request_id: "resume:sigkill-applied",
    };
    const resumedResponse = await postJson(`${resumedServer.baseUrl}/runs/sandbox/resume`, resumeRequest);
    assert.equal(resumedResponse.status, 200);
    const resumed = await resumedResponse.json();
    assert.equal(resumed.run_id, "run:sigkill-applied");
    assert.equal(resumed.result, "created-once");
    assert.equal(effectRequests.length, 1, "an applied journal result must not redispatch the handler");
    assert.equal(appliedEffects.size, 1);
    const completedJournal = readStoreFixture(journalPath);
    const [completedEntry] = Object.values(completedJournal.entries);
    assert.equal(completedEntry.effect_id, appliedEntry.effect_id);
    assert.equal(completedEntry.attempt_count, 1);
    const repeatedResponse = await postJson(`${resumedServer.baseUrl}/runs/sandbox/resume`, resumeRequest);
    assert.equal(repeatedResponse.status, 200);
    assert.equal(effectRequests.length, 1);
  } finally {
    if (worker !== undefined) {
      worker.kill("SIGKILL");
      await waitForChildExit(worker);
    }
    if (resumedServer !== undefined) await stopChildProcess(resumedServer.child);
    await closeHttpServer(effectService);
    rmSync(root, { recursive: true, force: true });
  }
});

test("lost HTTP response and SIGKILL recover by session and message through public APIs without duplicate effects", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-sigkill-unknown-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.sandbox/RunTool"] }));
  const effectRequests = [];
  const appliedEffects = new Set();
  const effectService = createHttpServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    effectRequests.push(body);
    appliedEffects.add(body.effect_id);
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ value: "created-idempotently" }));
  });
  let worker;
  let interruptedHandlerPid;
  let resumedServer;
  try {
    await new Promise((resolveListen, rejectListen) => {
      effectService.once("error", rejectListen);
      effectService.listen(0, "127.0.0.1", resolveListen);
    });
    const effectPort = effectService.address().port;
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), "module demo.sandbox\n", "utf8");
    writeFileSync(
      join(root, ".touba", "air", "demo", "main.air.json"),
      JSON.stringify(sandboxAirDocument({ withTool: true }), null, 2),
      "utf8",
    );
    const mutationMarkerPath = join(root, ".touba", "mutation-before-receipt.json");
    const handlerPath = join(root, "effect-handler.mjs");
    writeFileSync(handlerPath, `
      import { renameSync, writeFileSync } from "node:fs";
      let input = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => { input += chunk; });
      process.stdin.on("end", async () => {
        const request = JSON.parse(input);
        const response = await fetch("http://127.0.0.1:${effectPort}/mutate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            effect_id: request.effect.effect_id,
            request_digest: request.effect.request_digest,
            attempt_index: request.effect.attempt_index,
            call_id: request.call_id,
          }),
        });
        const result = await response.json();
        if (request.effect.attempt_index === 1) {
          // Publish the completed witness atomically: existence alone must not
          // expose the empty file between open and write to the observing test.
          writeFileSync(${JSON.stringify(`${mutationMarkerPath}.pending`)}, JSON.stringify({
            pid: process.pid,
            call_id: request.call_id,
          }), "utf8");
          renameSync(${JSON.stringify(`${mutationMarkerPath}.pending`)}, ${JSON.stringify(mutationMarkerPath)});
          Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
        }
        process.stdout.write(JSON.stringify({
          ok: true,
          value: result.value,
          effect_receipt: {
            effect_id: request.effect.effect_id,
            request_digest: request.effect.request_digest,
            outcome: "applied",
            receipt_ref: "opaque:test:created-idempotently",
          },
        }));
      });
    `, "utf8");
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:demo.sandbox/ReadExternal": {
          handler: { kind: "process", command: process.execPath, args: [handlerPath], cwd: root },
          grants: ["network"],
          secrets: [],
          timeout_ms: 10000,
          max_payload_bytes: 16384,
          effect_contract: { kind: "external_write", retry_mode: "idempotency_key" },
        },
      },
    }, null, 2), "utf8");

    const original = await startProjectServerProcess(root);
    worker = original.child;
    const sessionResponse = await postJson(`${original.baseUrl}/interactions/sessions`, {
      schema_version: "touba-interaction-session-create-v1",
      target_ref: "strategy:demo.sandbox/RunTool", target_kind: "strategy", presentation: "workflow",
      effect_policy: "allow_declared_external_effects", requested_by: {kind: "service", id: "crash-test"},
    });
    assert.equal(sessionResponse.status, 201, await sessionResponse.clone().text());
    const session = await sessionResponse.json();
    const message = {schema_version: "touba-interaction-message-request-v1", message_id: "message:lost-response",
      display_text: "Create order", inputs: {}, requested_by: {kind: "service", id: "crash-test"}};
    const sessionPath = `/interactions/sessions/${encodeURIComponent(session.session_id)}`;
    // Close the real HTTP connection before consuming its operation response.
    await new Promise((resolveLost, rejectLost) => {
      const request = httpRequest(`${original.baseUrl}${sessionPath}/messages`, {
        method: "POST", headers: {"content-type": "application/json"},
      }, response => {
        assert.equal(response.statusCode, 202);
        response.destroy(); resolveLost();
      });
      request.on("error", rejectLost);
      request.end(JSON.stringify(message));
    });
    await waitForPath(mutationMarkerPath, worker, original.stderr);
    const mutationMarker = JSON.parse(readFileSync(mutationMarkerPath, "utf8"));
    interruptedHandlerPid = mutationMarker.pid;
    assert.equal(effectRequests.length, 1);
    assert.equal(appliedEffects.size, 1);
    worker.kill("SIGKILL");
    await waitForChildExit(worker);
    worker = undefined;
    process.kill(interruptedHandlerPid, "SIGKILL");
    interruptedHandlerPid = undefined;

    resumedServer = await startProjectServerProcess(root);
    const restoredSession = await getJson(`${resumedServer.baseUrl}${sessionPath}`);
    const interrupted = restoredSession.operations.find(operation => operation.message_id === message.message_id);
    assert.ok(interrupted, "the persisted message must identify its operation without reading SQLite");
    assert.equal(restoredSession.operations.length, 1);
    const duplicate = await postJson(`${resumedServer.baseUrl}${sessionPath}/messages`, message);
    assert.equal((await duplicate.json()).operation_id, interrupted.operation_id);
    const recovery = await getJson(
      `${resumedServer.baseUrl}/operations/${encodeURIComponent(interrupted.operation_id)}/recovery`,
    );
    const resumeRequest = {
      schema_version: "touba-operation-resume-request-v1",
      operation_id: interrupted.operation_id,
      checkpoint_revision: recovery.freshness.state_revision,
      checkpoint_digest: recovery.correlations.checkpoint_digest,
      resume_request_id: "resume:sigkill-unknown",
    };
    assert.equal(recovery.status, "interrupted");
    assert.equal(recovery.effects.dispatched, 1);
    assert.equal(recovery.effects.reconciliation, "retry_safe");
    assert.deepEqual(recovery.allowed_actions.map((action) => action.action), ["resume"]);
    assert.equal(JSON.stringify(recovery).includes("last_call_id"), false);
    assert.equal(JSON.stringify(recovery).includes("receipt_ref"), false);
    const resumedResponse = await postJson(`${resumedServer.baseUrl}/runs/sandbox/resume`, resumeRequest);
    assert.equal(resumedResponse.status, 200);
    const resumed = await resumedResponse.json();
    assert.equal(resumed.run_id, interrupted.run_id);
    assert.equal(resumed.result, "created-idempotently");
    assert.equal(effectRequests.length, 2, "the ambiguous dispatch must use one bounded retry");
    assert.equal(appliedEffects.size, 1, "the provider idempotency key must preserve one mutation");
    assert.equal(effectRequests[0].effect_id, effectRequests[1].effect_id);
    assert.equal(effectRequests[0].request_digest, effectRequests[1].request_digest);
    assert.notEqual(effectRequests[0].call_id, effectRequests[1].call_id);
    assert.deepEqual(effectRequests.map((entry) => entry.attempt_index), [1, 2]);
    const repeated = await postJson(`${resumedServer.baseUrl}/runs/sandbox/resume`, resumeRequest);
    assert.equal(repeated.status, 200);
    assert.equal(effectRequests.length, 2);
  } finally {
    if (worker !== undefined) {
      worker.kill("SIGKILL");
      await waitForChildExit(worker);
    }
    if (interruptedHandlerPid !== undefined) {
      try {
        process.kill(interruptedHandlerPid, "SIGKILL");
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (resumedServer !== undefined) await stopChildProcess(resumedServer.child);
    await closeHttpServer(effectService);
    rmSync(root, { recursive: true, force: true });
  }
});

for (const crashWindow of [
  {
    name: "SIGKILL after the initial checkpoint but before tool reservation resumes with monotone state",
    mode: "before_reservation",
  },
  {
    name: "SIGKILL after durable reservation and prepared journal but before handler dispatch reuses the reservation",
    mode: "after_prepared",
  },
  {
    name: "SIGKILL before reservation then cancellation after the durable claim prevents handler dispatch",
    mode: "cancel_after_claim",
  },
  {
    name: "durable resume revalidates control-plane authority immediately before handler spawn",
    mode: "authority_generic",
  },
  {
    name: "interaction durable resume revalidates control-plane authority before handler spawn",
    mode: "authority_interaction",
  },
]) {
  test(crashWindow.name, async () => {
    const root = mkdtempSync(join(tmpdir(), `touba-project-server-${crashWindow.mode}-`));
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.sandbox/RunTool"] }));
    const effectRequests = [];
    const appliedEffects = new Set();
    let observeEffectRequest;
    const effectRequestObserved = new Promise((resolveObserved) => {
      observeEffectRequest = resolveObserved;
    });
    let releaseEffectResponse;
    const effectResponseGate = crashWindow.mode === "after_prepared"
      ? new Promise((resolveResponse) => { releaseEffectResponse = resolveResponse; })
      : Promise.resolve();
    let observeResumeClaim;
    const resumeClaimObserved = new Promise((resolveObserved) => {
      observeResumeClaim = resolveObserved;
    });
    let releaseResumeClaim;
    const resumeClaimGate = new Promise((resolveClaim) => {
      releaseResumeClaim = resolveClaim;
    });
    const dynamicAuthority = crashWindow.mode.startsWith("authority_");
    const identityAccessToken = "identity-resume-access-token";
    const identityServiceToken = "identity-resume-service-token-at-least-32-characters";
    let identityActive = true;
    let identityChecks = 0;
    let observeDispatchAuthority;
    const dispatchAuthorityObserved = new Promise((resolveObserved) => {
      observeDispatchAuthority = resolveObserved;
    });
    let releaseDispatchAuthority;
    const dispatchAuthorityGate = new Promise((resolveAuthority) => {
      releaseDispatchAuthority = resolveAuthority;
    });
    const identityServer = createHttpServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      assert.equal(request.headers["x-touba-service-token"], identityServiceToken);
      assert.equal(body.access_token, identityAccessToken);
      identityChecks += 1;
      if (identityChecks === 2) {
        observeDispatchAuthority();
        await dispatchAuthorityGate;
      }
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        active: identityActive,
        permissions: identityActive ? ["executions.run"] : [],
        user: { id: "user:resume-authority" },
      }));
    });
    const effectService = createHttpServer(async (request, response) => {
      const chunks = [];
      for await (const chunk of request) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      effectRequests.push(body);
      appliedEffects.add(body.effect_id);
      observeEffectRequest();
      await effectResponseGate;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ value: "created-once" }));
    });
    let worker;
    let resumedServer;
    let resumedService;
    try {
      await new Promise((resolveListen, rejectListen) => {
        effectService.once("error", rejectListen);
        effectService.listen(0, "127.0.0.1", resolveListen);
      });
      if (dynamicAuthority) await listenHttpServer(identityServer);
      const effectPort = effectService.address().port;
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
      writeFileSync(join(root, "src", "main.tb"), "module demo.sandbox\n", "utf8");
      writeFileSync(
        join(root, ".touba", "air", "demo", "main.air.json"),
        JSON.stringify(sandboxAirDocument({ withTool: true }), null, 2),
        "utf8",
      );
      const handlerPath = join(root, "effect-handler.mjs");
      const handlerStartedPath = join(root, ".touba", "effect-handler-started");
      writeFileSync(handlerPath, `
        import { writeFileSync } from "node:fs";
        writeFileSync(${JSON.stringify(handlerStartedPath)}, "started\\n", "utf8");
        let input = "";
        process.stdin.setEncoding("utf8");
        process.stdin.on("data", (chunk) => { input += chunk; });
        process.stdin.on("end", async () => {
          const request = JSON.parse(input);
          const response = await fetch("http://127.0.0.1:${effectPort}/mutate", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({
              effect_id: request.effect.effect_id,
              request_digest: request.effect.request_digest,
              attempt_index: request.effect.attempt_index,
              call_id: request.call_id,
            }),
          });
          const result = await response.json();
          process.stdout.write(JSON.stringify({
            ok: true,
            value: result.value,
            effect_receipt: {
              effect_id: request.effect.effect_id,
              request_digest: request.effect.request_digest,
              outcome: "applied",
              receipt_ref: "opaque:test:created-once",
            },
          }));
        });
      `, "utf8");
      writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({
        manifest_version: "touba-manifest-v1",
        bindings: {
          "tool:demo.sandbox/ReadExternal": {
            handler: { kind: "process", command: process.execPath, args: [handlerPath], cwd: root },
            grants: ["network"],
            secrets: [],
            timeout_ms: 10000,
            max_payload_bytes: 16384,
            effect_contract: { kind: "external_write", retry_mode: "idempotency_key" },
          },
        },
      }, null, 2), "utf8");

      const interactionSessionsPath = join(root, ".touba", "interaction-sessions.sqlite");
      let interactionSession;
      let interactionOperation;
      if (crashWindow.mode === "authority_interaction") {
        interactionSession = createInteractionSession({
          request: {
            target_ref: "strategy:demo.sandbox/RunTool",
            target_kind: "strategy",
            presentation: "workflow",
            effect_policy: "allow_declared_external_effects",
            requested_by: { kind: "user", id: "user:resume-authority" },
          },
          sessionsPath: interactionSessionsPath,
        });
        interactionOperation = enqueueInteractionOperation({
          message: {
            message_id: "message:resume-authority",
            display_text: "Resume the durable operation.",
          },
          runId: "run:authority_interaction",
          sessionId: interactionSession.session_id,
          sessionsPath: interactionSessionsPath,
        });
        startInteractionOperation({
          operationId: interactionOperation.operation_id,
          sessionId: interactionSession.session_id,
          sessionsPath: interactionSessionsPath,
        });
      }
      const durableOperationId = interactionOperation?.operation_id ?? `operation:${crashWindow.mode}`;
      const durableRunId = interactionOperation?.run_id ?? `run:${crashWindow.mode}`;

      const checkpointPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
      const journalPath = join(root, ".touba", "project.effect-journal.sqlite");
      const crashMarkerPath = join(root, ".touba", `${crashWindow.mode}.json`);
      const harnessPath = join(root, "crash-worker.mjs");
      const projectServerModule = new URL("../src/serve.mjs", import.meta.url).href;
      const journalModule = new URL("../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs", import.meta.url).href;
      const preparedJournalSetup = crashWindow.mode === "after_prepared"
        ? `
          const persisted = createSqliteEffectJournal(${JSON.stringify(journalPath)});
          const blockingJournal = {
            schemaVersion: persisted.schemaVersion,
            readEntry: (effectId) => persisted.readEntry(effectId),
            entriesForScope: (scopeId) => persisted.entriesForScope(scopeId),
            writeEntry(entry) {
              persisted.writeEntry(entry);
              if (entry.state === "prepared") {
                writeFileSync(${JSON.stringify(crashMarkerPath)}, JSON.stringify({
                  effect_id: entry.effect_id,
                  state: entry.state,
                }), "utf8");
                Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
              }
            },
          };
        `
        : "";
      const traceBlocker = crashWindow.mode !== "after_prepared"
        ? `
          traceEventObserver(event) {
            if (event.kind === "tool_binding_authorized") {
              writeFileSync(${JSON.stringify(crashMarkerPath)}, JSON.stringify({
                event_kind: event.kind,
                sequence_index: event.sequence_index,
              }), "utf8");
              Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0);
            }
          },
        `
        : "";
      const effectJournalOption = crashWindow.mode === "after_prepared"
        ? "effectJournal: blockingJournal,"
        : "";
      writeFileSync(harnessPath, `
        import { writeFileSync } from "node:fs";
        import { executeProjectSandboxRun } from ${JSON.stringify(projectServerModule)};
        import { createSqliteEffectJournal } from ${JSON.stringify(journalModule)};
        ${preparedJournalSetup}
        await executeProjectSandboxRun({
          contractsRoot: ${JSON.stringify(contractsRoot)},
          ${effectJournalOption}
          effectJournalPath: ${JSON.stringify(journalPath)},
          executionKind: "entrypoint",
          humanRequestsPath: ${JSON.stringify(join(root, ".touba", "human-requests.sqlite"))},
          operationId: ${JSON.stringify(durableOperationId)},
          projectRoot: ${JSON.stringify(root)},
          request: {
            schema_version: "touba-sandbox-run-request-v1",
            execution_kind: "entrypoint",
            target_ref: "strategy:demo.sandbox/RunTool",
            effect_policy: "allow_declared_external_effects",
            inputs: {},
            requested_by: { kind: "service", id: "sigkill-proof" },
            reason: ${JSON.stringify(`prove ${crashWindow.mode} durable recovery`)},
          },
          runId: ${JSON.stringify(durableRunId)},
          runSummaryPath: ${JSON.stringify(join(root, ".touba", "current-run-summary.json"))},
          sandboxCheckpointsPath: ${JSON.stringify(checkpointPath)},
          ${traceBlocker}
          traceTimelinePath: ${JSON.stringify(join(root, ".touba", "current-trace-timeline.json"))},
        });
      `, "utf8");

      let workerStderr = "";
      worker = spawn(process.execPath, [harnessPath], { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
      worker.stderr.on("data", (chunk) => { workerStderr += chunk.toString("utf8"); });
      await waitForPath(crashMarkerPath, worker, () => workerStderr);
      assert.equal(effectRequests.length, 0, "the handler must not dispatch before the crash marker");
      const beforeKill = readStoreFixture(checkpointPath).records[0];
      assert.equal(beforeKill.status, "running");
      assert.equal(beforeKill.checkpoint.cursor.phase, "started");
      if (crashWindow.mode !== "after_prepared") {
        assert.equal(beforeKill.checkpoint.pending_dispatch, null);
        assert.deepEqual(readStoreFixture(journalPath).entries, {}, "SQLite may be initialized, but no effect is reserved before the checkpoint barrier");
        assert.equal(beforeKill.checkpoint.runtime_state.budget_counters.tool_calls, 0);
      } else {
        assert.equal(beforeKill.checkpoint.pending_dispatch.phase, "reserved");
        const journalBeforeKill = readStoreFixture(journalPath);
        const [preparedEntry] = Object.values(journalBeforeKill.entries);
        assert.equal(preparedEntry.state, "prepared");
        assert.equal(preparedEntry.attempt_count, 0);
        assert.equal(preparedEntry.effect_id, beforeKill.checkpoint.pending_dispatch.effect_id);
        assert.equal(beforeKill.checkpoint.runtime_state.budget_counters.tool_calls, 1);
      }

      worker.kill("SIGKILL");
      await waitForChildExit(worker);
      worker = undefined;

      if (crashWindow.mode === "cancel_after_claim") {
        resumedService = createToubaProjectServer({
          contractsRoot,
          durableResumeClaimedObserver: async () => {
            observeResumeClaim();
            await resumeClaimGate;
          },
          port: 0,
          projectRoot: root,
          quiet: true,
        });
        await resumedService.start();
        resumedServer = {
          baseUrl: `http://127.0.0.1:${resumedService.server.address().port}`,
        };
      } else if (dynamicAuthority) {
        resumedService = createToubaProjectServer({
          contractsRoot,
          identityControlPlaneUrl: `http://127.0.0.1:${identityServer.address().port}`,
          identityServiceToken,
          port: 0,
          projectRoot: root,
          quiet: true,
        });
        await resumedService.start();
        resumedServer = {
          baseUrl: `http://127.0.0.1:${resumedService.server.address().port}`,
        };
      } else {
        resumedServer = await startProjectServerProcess(root);
      }
      const interrupted = readStoreFixture(checkpointPath).records[0];
      assert.equal(interrupted.status, "interrupted");
      const resumeRequest = {
      schema_version: "touba-operation-resume-request-v1",
        operation_id: interrupted.operation_id,
        checkpoint_revision: interrupted.checkpoint.revision,
        checkpoint_digest: interrupted.checkpoint.checkpoint_digest,
        resume_request_id: `resume:${crashWindow.mode}`,
      };
      let pendingResumedResponse;
      if (crashWindow.mode === "authority_interaction") {
        const acceptedResume = await fetch(
          `${resumedServer.baseUrl}/interactions/sessions/${interactionSession.session_id}/resume`,
          {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "x-touba-identity-token": identityAccessToken,
            },
            body: JSON.stringify(resumeRequest),
          },
        );
        assert.equal(acceptedResume.status, 202);
      } else {
        pendingResumedResponse = fetch(`${resumedServer.baseUrl}/runs/sandbox/resume`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(dynamicAuthority ? { "x-touba-identity-token": identityAccessToken } : {}),
          },
          body: JSON.stringify(resumeRequest),
        });
      }
      if (crashWindow.mode === "cancel_after_claim") {
        await withTimeout(resumeClaimObserved, "durable resume claim observer");
        const claimedStore = readStoreFixture(checkpointPath);
        const claimedRecord = claimedStore.records[0];
        assert.equal(claimedRecord.status, "resume_claimed");
        assert.equal(claimedRecord.resume_claim.status, "claimed");
        const cancelledAt = new Date().toISOString();
        claimedRecord.status = "cancelled";
        claimedRecord.updated_at = cancelledAt;
        claimedRecord.resume_claim.status = "refused";
        claimedRecord.resume_claim.completed_at = cancelledAt;
        claimedRecord.resume_claim.error = {
          code: "DurableResumeAuthorityRefused",
          message: "operation cancellation was requested after its durable claim",
        };
        writeStoreFixture(checkpointPath, claimedStore);
        releaseResumeClaim();
        const cancelledResponse = await withTimeout(pendingResumedResponse, "cancelled durable resume response");
        assert.equal(cancelledResponse.status, 200, await cancelledResponse.clone().text());
        const cancelled = await cancelledResponse.json();
        assert.equal(cancelled.status, "cancelled");
        assert.equal(effectRequests.length, 0);
        assert.equal(appliedEffects.size, 0);
        assert.equal(existsSync(handlerStartedPath), false, "cancellation must be observed before handler spawn");
        const cancelledStore = readStoreFixture(checkpointPath);
        assert.equal(cancelledStore.records[0].status, "cancelled");
        assert.equal(cancelledStore.records[0].resume_claim.status, "refused");
        return;
      }
      if (dynamicAuthority) {
        await withTimeout(dispatchAuthorityObserved, "dispatch authority introspection");
        assert.equal(identityChecks, 2);
        const claimedStore = readStoreFixture(checkpointPath);
        assert.equal(claimedStore.records[0].status, "resume_claimed");
        assert.equal(claimedStore.records[0].resume_claim.status, "claimed");
        const journalAtAuthorityCheck = readStoreFixture(journalPath);
        const [dispatchedEntry] = Object.values(journalAtAuthorityCheck.entries);
        assert.equal(dispatchedEntry.state, "dispatched");
        identityActive = false;
        releaseDispatchAuthority();

        if (crashWindow.mode === "authority_interaction") {
          const terminal = await waitForStoredInteractionOperation({
            operationId: interactionOperation.operation_id,
            sessionsPath: interactionSessionsPath,
          });
          assert.equal(terminal.status, "failed");
          assert.equal(terminal.error.code, "DurableResumeAuthorityRefused");
        } else {
          const refusedResponse = await withTimeout(
            pendingResumedResponse,
            "authority-refused durable resume response",
          );
          assert.equal(refusedResponse.status, 200);
          const refused = await refusedResponse.json();
          assert.equal(refused.status, "failure");
          assert.equal(
            refused.diagnostics.some((diagnostic) => diagnostic.code === "DurableResumeAuthorityRefused"),
            true,
          );
        }
        assert.equal(effectRequests.length, 0);
        assert.equal(appliedEffects.size, 0);
        assert.equal(existsSync(handlerStartedPath), false, "revoked authority must be observed before handler spawn");
        for (const persistedPath of [checkpointPath, journalPath, interactionSessionsPath]) {
          if (existsSync(persistedPath)) {
            assert.equal(readFileSync(persistedPath, "utf8").includes(identityAccessToken), false);
          }
        }
        return;
      }
      if (crashWindow.mode === "after_prepared") {
        await effectRequestObserved;
        const divergentResponse = await postJson(`${resumedServer.baseUrl}/runs/sandbox/resume`, {
          ...resumeRequest,
          checkpoint_digest: `sha256:${"b".repeat(64)}`,
        });
        assert.equal(divergentResponse.status, 409);
        assert.equal((await divergentResponse.json()).code, "DurableResumeConflict");
        releaseEffectResponse();
      }
      const resumedResponse = await pendingResumedResponse;
      assert.equal(resumedResponse.status, 200);
      const resumed = await resumedResponse.json();
      assert.equal(resumed.status, "success", JSON.stringify(resumed));
      assert.equal(resumed.result, "created-once");
      assert.equal(effectRequests.length, 1);
      assert.equal(appliedEffects.size, 1);

      const completedStore = readStoreFixture(checkpointPath);
      const completed = completedStore.records[0];
      assert.equal(completed.status, "completed");
      assert.equal(completed.operation_id, beforeKill.operation_id);
      assert.equal(completed.run_id, beforeKill.run_id);
      assert.equal(completed.effect_scope_id, beforeKill.effect_scope_id);
      assert.ok(completed.checkpoint.revision > beforeKill.checkpoint.revision);
      for (const counter of ["steps", "tool_calls", "agent_invocations", "provider_calls"]) {
        assert.ok(
          completed.checkpoint.runtime_state.budget_counters[counter]
            >= beforeKill.checkpoint.runtime_state.budget_counters[counter],
          `${counter} must remain monotone across process recovery`,
        );
      }
      assert.ok(
        completed.checkpoint.runtime_state.active_elapsed_ms
          >= beforeKill.checkpoint.runtime_state.active_elapsed_ms,
        `active elapsed time regressed from ${beforeKill.checkpoint.runtime_state.active_elapsed_ms} to ${completed.checkpoint.runtime_state.active_elapsed_ms}`,
      );
      const completedJournal = readStoreFixture(journalPath);
      const [appliedEntry] = Object.values(completedJournal.entries);
      assert.equal(appliedEntry.state, "applied");
      assert.equal(appliedEntry.attempt_count, 1);
      assert.equal(appliedEntry.effect_id, effectRequests[0].effect_id);
      assert.equal(appliedEntry.request_digest, effectRequests[0].request_digest);
      if (crashWindow.mode === "after_prepared") {
        assert.equal(
          completed.checkpoint.runtime_state.budget_counters.tool_calls,
          beforeKill.checkpoint.runtime_state.budget_counters.tool_calls,
          "a persisted reservation must not consume the tool budget twice",
        );
        assert.equal(effectRequests[0].call_id, beforeKill.checkpoint.pending_dispatch.call_id);
      }

      const repeatedResponse = await postJson(`${resumedServer.baseUrl}/runs/sandbox/resume`, resumeRequest);
      assert.equal(repeatedResponse.status, 200);
      assert.equal(effectRequests.length, 1);
      assert.equal(appliedEffects.size, 1);
    } finally {
      releaseEffectResponse?.();
      releaseResumeClaim?.();
      releaseDispatchAuthority?.();
      if (worker !== undefined) {
        worker.kill("SIGKILL");
        await waitForChildExit(worker);
      }
      if (resumedService !== undefined) {
        await resumedService.stop();
      } else if (resumedServer !== undefined) {
        await stopChildProcess(resumedServer.child);
      }
      await closeHttpServer(effectService);
      await closeHttpServer(identityServer);
      rmSync(root, { recursive: true, force: true });
    }
  });
}

test("HTTP project server persists adaptive interaction sessions and governed assets", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-interactions-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.sandbox/RunReady"] }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.sandbox\n", "utf8");
  writeFileSync(
    join(root, ".touba", "air", "demo", "main.air.json"),
    JSON.stringify(sandboxAirDocument(), null, 2),
    "utf8",
  );
  writeFileSync(
    join(root, "touba.manifest.json"),
    JSON.stringify(sandboxManifestDocument(), null, 2),
    "utf8",
  );
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const inspection = await getJson(`${baseUrl}/project`);
    const strategy = inspection.entrypoints.find((entrypoint) => (
      entrypoint.ref === "strategy:demo.sandbox/RunReady"
    ));
    assert.equal(strategy.interaction_contract.presentation, "workflow");
    assert.deepEqual(strategy.interaction_contract.accepted_content_kinds, []);

    const createdResponse = await postJson(`${baseUrl}/interactions/sessions`, {
      schema_version: "touba-interaction-session-create-v1",
      target_ref: strategy.ref,
      target_kind: "strategy",
      presentation: "workflow",
      effect_policy: "runtime_only",
      requested_by: { kind: "studio", id: "test-suite" },
    });
    assert.equal(createdResponse.status, 201);
    const created = await createdResponse.json();
    assertMatchesSchema("touba-interaction-session-v1", created);

    const message = {
      schema_version: "touba-interaction-message-request-v1",
      message_id: "message_001",
      display_text: "Run the ready workflow.",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
    };
    const messageResponse = await postJson(
      `${baseUrl}/interactions/sessions/${created.session_id}/messages`,
      message,
    );
    assert.equal(messageResponse.status, 202);
    const accepted = await messageResponse.json();
    assertMatchesSchema("touba-interaction-operation-v1", accepted);
    const terminal = await waitForInteractionOperation(baseUrl, created.session_id, accepted.operation_id);
    assert.equal(terminal.status, "succeeded", JSON.stringify(terminal));
    assert.ok(terminal.event_count > 0);
    const completed = await getJson(`${baseUrl}/interactions/sessions/${created.session_id}`);
    assert.equal(completed.messages.length, 2);
    assert.equal(completed.messages[1].run_result.status, "success");

    const idempotentResponse = await postJson(
      `${baseUrl}/interactions/sessions/${created.session_id}/messages`,
      message,
    );
    assert.equal(idempotentResponse.status, 200);
    assert.equal((await idempotentResponse.json()).operation_id, accepted.operation_id);
    const sessions = await getJson(`${baseUrl}/interactions/sessions`);
    assertMatchesSchema("touba-interaction-session-list-v1", sessions);
    assert.equal(sessions.sessions[0].message_count, 2);

    const content = Buffer.from("incident evidence", "utf8");
    const digest = `sha256:${createHash("sha256").update(content).digest("hex")}`;
    const assetResponse = await fetch(
      `${baseUrl}/interaction-assets?name=incident.txt&content_kind=document&digest=${encodeURIComponent(digest)}`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: content,
      },
    );
    assert.equal(assetResponse.status, 201);
    const asset = await assetResponse.json();
    assertMatchesSchema("touba-interaction-asset-v1", asset);
    assert.equal(asset.digest, digest);
    assert.equal(JSON.stringify(asset).includes(root), false);

    const assetRead = await fetch(`${baseUrl}/interaction-assets/${asset.handle}`);
    assert.equal(assetRead.status, 200);
    assert.equal(Buffer.from(await assetRead.arrayBuffer()).toString("utf8"), "incident evidence");
    const badDigest = await fetch(
      `${baseUrl}/interaction-assets?name=incident.txt&content_kind=document&digest=sha256:${"0".repeat(64)}`,
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: content,
      },
    );
    assert.equal(badDigest.status, 400);
    assert.equal((await badDigest.json()).code, "ToubaServeInteractionAssetDigestMismatch");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

test("HTTP project server refuses sandbox runtime-only runs that may dispatch tools", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-sandbox-effects-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.sandbox/RunTool", "tool:demo.sandbox/ReadExternal"] }));
  mkdirSync(join(root, "src"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "main.tb"), "module demo.effects\n", "utf8");
  writeFileSync(join(root, ".touba", "air", "demo", "main.air.json"), JSON.stringify(sandboxAirDocument({ withTool: true }), null, 2), "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.sqlite"),
    changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const response = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v1",
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
      schema_version: "touba-sandbox-run-request-v1",
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
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.agent/RunAgent"] }));
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
    humanDecisionsPath: join(root, "human-decisions.sqlite"),
    changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const response = await postJson(`${baseUrl}/runs/sandbox`, {
      schema_version: "touba-sandbox-run-request-v1",
      execution_kind: "entrypoint",
      target_ref: "strategy:demo.agent/RunAgent",
      effect_policy: "runtime_only",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
      reason: "test sandbox agent provider",
    });
    assert.equal(response.status, 200);
    const run = await response.json();
    assertMatchesSchema("touba-sandbox-run-result-v1", run);
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

test("HTTP interaction cancellation stops an active agent before capability dispatch", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-interaction-cancel-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.agent/RunAgent"] }));
  mkdirSync(join(root, "src", "demo"), { recursive: true });
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  writeFileSync(join(root, "src", "demo", "agent.tb"), "module demo.agent\n", "utf8");
  writeFileSync(
    join(root, ".touba", "air", "demo", "agent.air.json"),
    JSON.stringify(sandboxAgentAirDocument(), null, 2),
    "utf8",
  );
  let releaseProvider;
  let reportProviderStarted;
  const providerStarted = new Promise((resolveStarted) => {
    reportProviderStarted = resolveStarted;
  });
  const providerRelease = new Promise((resolveRelease) => {
    releaseProvider = resolveRelease;
  });
  const service = createToubaProjectServer({
    agentDecisionProvider: async () => {
      reportProviderStarted();
      await providerRelease;
      return {
        target_ref: "skill:demo.agent/BuildOverview",
        reason: "provider released after cancellation request",
      };
    },
    agentDecisionProviderInitialMode: "capabilities",
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.sqlite"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const sessionResponse = await postJson(`${baseUrl}/interactions/sessions`, {
      schema_version: "touba-interaction-session-create-v1",
      target_ref: "strategy:demo.agent/RunAgent",
      target_kind: "strategy",
      presentation: "workflow",
      effect_policy: "runtime_only",
      requested_by: { kind: "studio", id: "test-suite" },
    });
    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json();
    const messageResponse = await postJson(
      `${baseUrl}/interactions/sessions/${session.session_id}/messages`,
      {
        schema_version: "touba-interaction-message-request-v1",
        message_id: "message_cancel_001",
        display_text: "Start and then cancel the governed agent.",
        inputs: {},
        requested_by: { kind: "studio", id: "test-suite" },
      },
    );
    assert.equal(messageResponse.status, 202);
    const operation = await messageResponse.json();
    await providerStarted;
    const cancelResponse = await postJson(
      `${baseUrl}/interactions/sessions/${session.session_id}/operations/${operation.operation_id}/cancel`,
    );
    assert.equal(cancelResponse.status, 202);
    assert.equal((await cancelResponse.json()).status, "cancel_requested");
    releaseProvider();
    const terminal = await waitForInteractionOperation(
      baseUrl,
      session.session_id,
      operation.operation_id,
    );
    assert.equal(terminal.status, "cancelled");
    const cancelledSession = await getJson(
      `${baseUrl}/interactions/sessions/${session.session_id}`,
    );
    const result = cancelledSession.messages.at(-1).run_result;
    assert.equal(result.status, "cancelled");
    assert.equal(
      result.trace.events.some((event) => event.type === "run_cancel_requested"),
      true,
      JSON.stringify(result.trace.events.map((event) => event.type)),
    );
    assert.equal(
      result.trace.events.some((event) => (
        event.type === "scope_entered"
        && event.references?.owner_ref === "skill:demo.agent/BuildOverview"
      )),
      false,
    );
  } finally {
    releaseProvider?.();
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const decisionKind of ["approve", "reject"]) {
test(`HTTP interaction ${decisionKind} preserves its terminal outcome without replay`, async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-sandbox-approval-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.approval/RunApproval"] }));
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
    humanDecisionsPath: join(root, ".touba", "human-decisions.sqlite"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const sessionResponse = await postJson(`${baseUrl}/interactions/sessions`, {
      schema_version: "touba-interaction-session-create-v1",
      target_ref: "strategy:demo.approval/RunApproval",
      target_kind: "strategy",
      presentation: "workflow",
      effect_policy: "runtime_only",
      requested_by: { kind: "studio", id: "test-suite" }
    });
    assert.equal(sessionResponse.status, 201);
    const session = await sessionResponse.json();
    const pausedResponse = await postJson(`${baseUrl}/interactions/sessions/${session.session_id}/messages`, {
      schema_version: "touba-interaction-message-request-v1",
      message_id: "message_approval_001",
      display_text: "Run the approval workflow.",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
    });
    assert.equal(pausedResponse.status, 202);
    const pausedOperation = await pausedResponse.json();
    const pausedTerminal = await waitForInteractionOperation(
      baseUrl,
      session.session_id,
      pausedOperation.operation_id,
    );
    assert.equal(pausedTerminal.status, "awaiting_human");
    const pausedSession = await getJson(`${baseUrl}/interactions/sessions/${session.session_id}`);
    const paused = pausedSession.messages.at(-1).run_result;
    assert.equal(pausedSession.status, "awaiting_human");
    assert.equal(paused.status, "stopped", JSON.stringify(paused, null, 2));
    assert.equal(paused.diagnostics[0].code, "ToubaSandboxRunAwaitingHumanDecision");
    const pausedSummary = await getJson(`${baseUrl}/runs/current`);
    assert.equal(pausedSummary.status, "approval_pending");
    assert.equal(pausedSummary.completed_at, null);
    assert.equal(pausedSummary.approvals_pending.length, 1);

    const pending = await getJson(`${baseUrl}/approvals/pending/current`);
    assertMatchesSchema("touba-approval-request-v1", pending);
    assert.equal(pending.run_id, paused.run_id);
    assert.deepEqual(await getJson(`${baseUrl}/approvals/pending/current?run_id=${encodeURIComponent(paused.run_id)}`), pending);
    assert.equal((await fetch(`${baseUrl}/approvals/pending/current?run_id=absent-run`)).status, 404);
    assert.equal((await fetch(`${baseUrl}/reviews/pending/current?run_id=absent-run`)).status, 404);

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
      decision: decisionKind,
      decided_by: "user:test-reviewer",
      decided_at: new Date().toISOString(),
      comment: null,
      client_ref: "touba-project-server-test",
    });
    assert.equal(decisionResponse.status, 202);

    const unrelatedSessionResponse = await postJson(`${baseUrl}/interactions/sessions`, {
      schema_version: "touba-interaction-session-create-v1",
      target_ref: "strategy:demo.approval/RunApproval",
      target_kind: "strategy",
      presentation: "workflow",
      effect_policy: "runtime_only",
      requested_by: { kind: "studio", id: "test-suite" }
    });
    assert.equal(unrelatedSessionResponse.status, 201);
    const unrelatedSession = await unrelatedSessionResponse.json();
    const mismatchedResume = await postJson(
      `${baseUrl}/interactions/sessions/${unrelatedSession.session_id}/resume`,
      {
        schema_version: "touba-interaction-resume-request-v1",
        request_id: pending.request_id,
      },
    );
    assert.equal(mismatchedResume.status, 409);
    assert.equal((await mismatchedResume.json()).code, "ToubaServeInteractionResumeMismatch");

    const resumedResponse = await postJson(`${baseUrl}/interactions/sessions/${session.session_id}/resume`, {
      schema_version: "touba-interaction-resume-request-v1",
      request_id: pending.request_id,
    });
    assert.equal(resumedResponse.status, 202);
    const resumedOperation = await resumedResponse.json();
    await waitForInteractionOperation(baseUrl, session.session_id, resumedOperation.operation_id);
    const resumedSession = await getJson(`${baseUrl}/interactions/sessions/${session.session_id}`);
    const resumed = resumedSession.messages.at(-1).run_result;
    const expectedOperationStatus = { approve: "succeeded", reject: "failed", cancel: "cancelled" }[decisionKind];
    assert.equal(resumedSession.status, decisionKind === "reject" ? "failed" : "open");
    assert.equal(resumedSession.operations[0].status, expectedOperationStatus);
    assert.equal(resumedSession.messages.length, 3);
    assert.equal(resumed.status, decisionKind === "approve" ? "success" : "stopped");
    assert.equal(resumed.result?.decision ?? null, decisionKind === "approve" ? "approved" : null);
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
    const summary = await getJson(`${baseUrl}/runs/current`);
    assertMatchesSchema("touba-run-summary-v1", summary);
    assert.equal(summary.status, { approve: "succeeded", reject: "refused", cancel: "cancelled" }[decisionKind]);
    assert.equal(summary.completed_at, resumed.completed_at);
    assert.deepEqual(summary.approvals_pending, []);
    assert.equal((await fetch(`${baseUrl}/approvals/pending/current`)).status, 404);
    if (decisionKind !== "approve") {
      assert.equal(resumed.trace.events.some((event) => event.type === `human_approval_${decisionKind === "reject" ? "rejected" : "cancelled"}`), true);
      assert.equal(resumed.trace.events.some((event) => event.type === "human_approval_resumed"), false);
    }
    if (decisionKind === "reject") {
      assert.equal(summary.refusals[0].code, "ToubaSandboxHumanDecisionRejected");
    }

    const idempotentResponse = await postJson(`${baseUrl}/interactions/sessions/${session.session_id}/resume`, {
      schema_version: "touba-interaction-resume-request-v1",
      request_id: pending.request_id,
    });
    assert.equal(idempotentResponse.status, 200);
    assert.equal((await idempotentResponse.json()).status, expectedOperationStatus);
    assert.deepEqual(await getJson(`${baseUrl}/interactions/sessions/${session.session_id}`), resumedSession);
    if (decisionKind === "reject") {
      const legacyRoot = mkdtempSync(join(tmpdir(), "touba-interaction-legacy-refusal-"));
      try {
        mkdirSync(join(legacyRoot, ".touba"));
        const sessionsPath = join(legacyRoot, ".touba", "interaction-sessions.sqlite");
        const legacySession = structuredClone(resumedSession);
        legacySession.status = "awaiting_human";
        legacySession.last_run_status = "awaiting_human";
        legacySession.messages = legacySession.messages.slice(0, 2);
        legacySession.operations[0].status = "awaiting_human";
        legacySession.operations[0].error = null;
        writeStoreFixture(sessionsPath, { schema_version: "touba-interaction-sessions-v1", sessions: [legacySession] });
        const checkpoints = readStoreFixture(join(root, ".touba", "sandbox-checkpoints.sqlite"));
        checkpoints.records[0].result.diagnostics = [{ severity: "warning", code: "ToubaSandboxRunFinishedWithStatus", message: "sandbox entrypoint run finished with status stopped" }];
        checkpoints.records[0].human_wait.projections = {
          terminal_event: null,
          pause_interaction: null,
          interaction: null,
        };
        const checkpointPath = join(legacyRoot, ".touba", "sandbox-checkpoints.sqlite");
        const withoutTerminalProof = structuredClone(checkpoints);
        withoutTerminalProof.records[0].result.trace = paused.trace;
        writeStoreFixture(checkpointPath, withoutTerminalProof);
        const withoutTerminalProofBytes = readFileSync(checkpointPath, "utf8");
        writeFileSync(join(legacyRoot, ".touba", "current-run-summary.json"), JSON.stringify({ ...summary, status: "paused", completed_at: null, refusals: [] }));
        assert.throws(
          () => createToubaProjectServer({ contractsRoot, projectRoot: legacyRoot, quiet: true, port: 0 }),
          { code: "ToubaServeSandboxCheckpointStoreInvalid" },
        );
        assert.equal(readFileSync(checkpointPath, "utf8"), withoutTerminalProofBytes);
        assert.deepEqual(getInteractionSession({ sessionId: session.session_id, sessionsPath }), legacySession);
        for (const [field, value] of [["run_id", "run_foreign"], ["entry_ref", "strategy:foreign/Unrelated"]]) {
          const foreignTrace = structuredClone(checkpoints);
          foreignTrace.records[0].result.trace[field] = value;
          assertMatchesSchema("touba-sandbox-run-result-v1", foreignTrace.records[0].result);
          writeStoreFixture(checkpointPath, foreignTrace);
          const foreignBytes = readFileSync(checkpointPath, "utf8");
          assert.throws(
            () => createToubaProjectServer({ contractsRoot, projectRoot: legacyRoot, quiet: true, port: 0 }),
            { code: "ToubaServeSandboxCheckpointStoreInvalid" },
          );
          assert.equal(readFileSync(checkpointPath, "utf8"), foreignBytes, field);
          assert.deepEqual(getInteractionSession({ sessionId: session.session_id, sessionsPath }), legacySession, field);
          assert.equal(JSON.parse(readFileSync(join(legacyRoot, ".touba", "current-run-summary.json"), "utf8")).status, "paused", field);
        }
        writeStoreFixture(checkpointPath, checkpoints);
        const repairedService = createToubaProjectServer({ contractsRoot, projectRoot: legacyRoot, quiet: true, port: 0 });
        await repairedService.stop();
        const repaired = getInteractionSession({ sessionId: session.session_id, sessionsPath });
        assert.equal(repaired.status, "failed");
        assert.equal(repaired.operations[0].status, "failed");
        assert.equal(repaired.messages.length, 3);
        assert.deepEqual(repaired.messages.at(-1).run_result, checkpoints.records[0].result);
        assert.equal(repaired.messages.at(-1).run_result.diagnostics[0].code, "ToubaSandboxRunFinishedWithStatus");
        const repairedSummary = JSON.parse(readFileSync(join(legacyRoot, ".touba", "current-run-summary.json"), "utf8"));
        assert.equal(repairedSummary.status, "refused");
        assert.equal(repairedSummary.completed_at, resumed.completed_at);
        const repeatedService = createToubaProjectServer({ contractsRoot, projectRoot: legacyRoot, quiet: true, port: 0 });
        await repeatedService.stop();
        assert.deepEqual(getInteractionSession({ sessionId: session.session_id, sessionsPath }), repaired);
      } finally {
        rmSync(legacyRoot, { recursive: true, force: true });
      }
    }
    const archiveResponse = await postJson(`${baseUrl}/interactions/sessions/${session.session_id}/archive`, {});
    assert.equal(archiveResponse.status, 200);
    assert.equal((await archiveResponse.json()).status, "archived");
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});
}

test("HTTP successive checkpoints retain both pauses and never replay a superseded checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-successive-checkpoints-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.approval/RunApproval"] }));
  mkdirSync(join(root, ".touba", "air", "demo"), { recursive: true });
  const document = sandboxApprovalAirDocument();
  const flow = document.execution_graphs[0];
  flow.nodes.splice(1, 0, node("approval_second", "human_approval", {
    approval_ref: "approval:demo/SecondApproval",
    approval_mode: "required_approval",
    context_refs: [],
    result_binding: "decision",
  }));
  flow.edges = [edge("approval", "approval_second", "next"), edge("approval_second", "done", "next")];
  writeFileSync(join(root, ".touba", "air", "demo", "approval.air.json"), JSON.stringify(document));
  writeTestDecisionIdentity(root, { userRef: "user:test-reviewer", deviceRef: "device:test-suite" });
  const service = createToubaProjectServer({ contractsRoot, projectRoot: root, port: 0, quiet: true });
  try {
    await service.start();
    const baseUrl = `http://127.0.0.1:${service.server.address().port}`;
    const createResponse = await postJson(`${baseUrl}/interactions/sessions`, {
      schema_version: "touba-interaction-session-create-v1",
      target_ref: "strategy:demo.approval/RunApproval",
      target_kind: "strategy",
      presentation: "workflow",
      effect_policy: "runtime_only",
      requested_by: { kind: "studio", id: "test-suite" },
    });
    assert.equal(createResponse.status, 201);
    const session = await createResponse.json();
    const sessionUrl = `${baseUrl}/interactions/sessions/${session.session_id}`;
    const operationResponse = await postJson(`${sessionUrl}/messages`, {
      schema_version: "touba-interaction-message-request-v1",
      message_id: "two_checkpoints",
      display_text: "Verify both human boundaries.",
      inputs: {},
      requested_by: { kind: "studio", id: "test-suite" },
    });
    const operation = await operationResponse.json();
    await waitForInteractionOperation(baseUrl, session.session_id, operation.operation_id);
    let firstRequest;
    for (const decision of ["approve", "reject"]) {
      const pending = await getJson(`${baseUrl}/approvals/pending/current`);
      if (decision === "approve") firstRequest = pending;
      else assert.notEqual(pending.request_id, firstRequest.request_id);
      const accepted = await postJson(`${baseUrl}/decisions`, {
        schema_version: "touba-approval-decision-v1",
        request_id: pending.request_id,
        run_id: pending.run_id,
        trace_ref: pending.trace_ref,
        user_ref: "user:test-reviewer",
        device_ref: "device:test-suite",
        decision,
        decided_by: "user:test-reviewer",
        decided_at: new Date().toISOString(),
        comment: null,
        client_ref: "test-suite",
      });
      assert.equal(accepted.status, 202);
      assert.equal((await postJson(`${sessionUrl}/resume`, {
        schema_version: "touba-interaction-resume-request-v1",
        request_id: pending.request_id,
      })).status, 202);
      await waitForInteractionOperation(baseUrl, session.session_id, operation.operation_id);
      const stored = await getJson(sessionUrl);
      assert.equal(stored.messages.length, decision === "approve" ? 3 : 4);
      assert.equal(stored.operations[0].status, decision === "approve" ? "awaiting_human" : "failed");
      const staleResume = await postJson(`${sessionUrl}/resume`, {
        schema_version: "touba-interaction-resume-request-v1",
        request_id: firstRequest.request_id,
      });
      assert.equal(staleResume.status, 200);
      assert.deepEqual(await getJson(sessionUrl), stored);
      const directStaleResume = await postJson(`${baseUrl}/runs/sandbox/resume`, { request_id: firstRequest.request_id });
      assert.equal(directStaleResume.status, 200);
      assert.deepEqual(await directStaleResume.json(), stored.messages[2].run_result);
      assert.deepEqual(await getJson(sessionUrl), stored);
    }
  } finally {
    await service.stop();
    rmSync(root, { recursive: true, force: true });
  }
});

for (const decision of ["rejected", "expired", "cancelled"]) {
test(`real runtime ${decision} projects a terminal interaction and retains both outcomes`, async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-interaction-human-terminal-"));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ entrypoints: ["strategy:demo.approval/RunApproval"] }));
  const sessionsPath = join(root, "sessions.json");
  const targetRef = "strategy:demo.approval/RunApproval";
  const document = sandboxApprovalAirDocument();
  try {
    const session = createInteractionSession({
      request: {
        target_ref: targetRef,
        target_kind: "strategy",
        presentation: "workflow",
        effect_policy: "runtime_only",
        requested_by: { kind: "studio", id: "test-suite" },
      },
      sessionsPath,
    });
    const operation = enqueueInteractionOperation({
      message: { message_id: "terminal_test", display_text: "Review the pure test." },
      runId: `run_${decision}`,
      sessionId: session.session_id,
      sessionsPath,
    });
    const operationArgs = { operationId: operation.operation_id, sessionId: session.session_id, sessionsPath };
    const paused = await executeAirDocument(document, {
      entryRef: targetRef,
      runId: operation.run_id,
      durableHumanApprovals: true,
    });
    const projectResult = (runtimeResult) => buildSandboxRunResult({
      completedAt: new Date().toISOString(),
      startedAt: operation.created_at,
      startedMs: Date.now(),
      effectPolicy: "runtime_only",
      executionKind: "entrypoint",
      runId: operation.run_id,
      runtimeResult,
      targetRef,
    });
    startInteractionOperation(operationArgs);
    const pausedResult = projectResult(paused);
    assert.equal(completeInteractionOperation({ ...operationArgs, result: pausedResult }).status, "awaiting_human");
    assert.throws(() => archiveInteractionSession({ sessionId: session.session_id, sessionsPath }), { code: "ToubaServeInteractionSessionBusy" });
    startInteractionOperation(operationArgs);
    const terminal = await executeAirDocument(document, {
      entryRef: targetRef,
      runId: operation.run_id,
      durableHumanApprovals: true,
      humanApprovalResumeCheckpoint: paused.checkpoint,
      humanApprovalDecisions: { [paused.checkpoint.approval_ref]: decision },
    });
    assert.equal(terminal.status, "stopped");
    assert.equal(terminal.checkpoint, undefined);
    assert.equal(terminal.result, undefined);
    assert.equal(terminal.trace.events.some((event) => event.kind === `human_approval_${decision}`), true);
    assert.equal(terminal.trace.events.some((event) => event.kind === "human_approval_resumed"), false);
    const terminalResult = projectResult(terminal);
    assertMatchesSchema("touba-sandbox-run-result-v1", terminalResult);
    const completed = completeInteractionOperation({ ...operationArgs, result: terminalResult });
    assert.equal(completed.status, decision === "cancelled" ? "cancelled" : "failed");
    assertMatchesSchema("touba-interaction-operation-v1", completed);
    completeInteractionOperation({ ...operationArgs, result: terminalResult });
    const stored = getInteractionSession({ sessionId: session.session_id, sessionsPath });
    assert.equal(stored.messages.length, 3, "a repeated terminal result must not duplicate history");
    assert.deepEqual(stored.messages[1].run_result, pausedResult);
    assert.deepEqual(stored.messages[2].run_result, terminalResult);
    assert.equal(listInteractionSessions(sessionsPath).sessions[0].active_operation, null);
    assert.equal(archiveInteractionSession({ sessionId: session.session_id, sessionsPath }).status, "archived");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
}

test("HTTP project server requires bearer auth when configured", async () => {
  const root = mkdtempSync(join(tmpdir(), "touba-project-server-auth-"));
  const previous = process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN;
  process.env.TOUBA_TEST_PROJECT_SERVER_TOKEN = "secret-token";
  const service = createToubaProjectServer({
    authTokenEnv: "TOUBA_TEST_PROJECT_SERVER_TOKEN",
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, "human-decisions.sqlite"),
    changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
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
    assert.equal((await fetch(`${baseUrl}/runs/unknown/trace`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/runs/unknown/trace?index=true`)).status, 401);
    assert.equal((await fetch(`${baseUrl}/runs/unknown/trace/segments/0`)).status, 401);
    const missingNativeTrace = await fetch(`${baseUrl}/runs/unknown/trace`, { headers: { authorization: "Bearer secret-token" } });
    assert.equal(missingNativeTrace.status, 404);
    assert.equal((await missingNativeTrace.json()).code, "ToubaServeNativeTraceUnavailable");

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
    assert.equal(state.schema_version, "touba-project-live-state-v1");

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
    assertMatchesSchema("touba-mobile-pairing-request-v1", issued);

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
    const mobileNativeTrace = await fetch(`${baseUrl}/runs/unknown/trace`, {
      headers: { authorization: `Bearer ${issued.bearer_token}` },
    });
    assert.equal(mobileNativeTrace.status, 403);
    assert.equal((await mobileNativeTrace.json()).code, "ToubaServeNativeTraceUnauthorized");

    const sandboxCheckpointsPath = join(root, ".touba", "sandbox-checkpoints.sqlite");
    const checkpointStoreBeforeMobileExecution = existsSync(sandboxCheckpointsPath)
      ? readFileSync(sandboxCheckpointsPath, "utf8")
      : null;
    const mobileResumeRefused = await fetch(`${baseUrl}/runs/sandbox/resume`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${issued.bearer_token}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
      schema_version: "touba-operation-resume-request-v1",
        operation_id: "op_mobile_must_not_claim",
        checkpoint_revision: 1,
        checkpoint_digest: "a".repeat(64),
        resume_request_id: "resume_mobile_must_not_dispatch",
      }),
    });
    assert.equal(mobileResumeRefused.status, 401);
    assert.equal((await mobileResumeRefused.json()).code, "ToubaServeUnauthorized");
    const checkpointStoreAfterMobileExecution = existsSync(sandboxCheckpointsPath)
      ? readFileSync(sandboxCheckpointsPath, "utf8")
      : null;
    assert.equal(
      checkpointStoreAfterMobileExecution,
      checkpointStoreBeforeMobileExecution,
      "a mobile pairing token must not claim or mutate a durable execution",
    );

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
    assert.equal(parseSseEvent(text).schema_version, "touba-project-event-v1");
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
    sdk: "@touba/sdk",
    artifact_layout: "touba-artifacts-v1",
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
    lock_version: "touba-lock-v1",
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
      changeProposalsPath: join(root, ".touba", "project-change-proposals.sqlite"),
      deploymentTargetUrl: `${targetAddress.protocol}://${targetAddress.host}:${targetAddress.port}`,
      deploymentTargetToken: token,
      port: 0,
      quiet: true,
    });
    await projectServer.start();
    const baseUrl = `http://127.0.0.1:${projectServer.server.address().port}`;

    const memoryRequest = {
      schema_version: "touba-element-authoring-request-v1",
      proposal_id: "author_memory_lifecycle",
      module_ref: "demo.lifecycle",
      element: {
        kind: "memory",
        name: "LifecycleEvidence",
        description: "Stores governed lifecycle evidence.",
      },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "Add lifecycle evidence memory.",
    };
    const memoryPreviewResponse = await postJson(`${baseUrl}/elements/preview`, memoryRequest);
    assert.equal(memoryPreviewResponse.status, 200);
    const memoryPreview = await memoryPreviewResponse.json();
    assertMatchesSchema("touba-element-authoring-preview-v1", memoryPreview);
    assert.match(memoryPreview.changes[0].diff, /\+memory LifecycleEvidence/u);
    assert.equal((await getJson(`${baseUrl}/changes`)).summary.pending, 0);

    const memoryProposal = await postJson(`${baseUrl}/elements/propose`, {
      ...memoryRequest,
      preview_digest: memoryPreview.preview_digest,
    });
    assert.equal(memoryProposal.status, 202);
    assert.equal((await memoryProposal.json()).target_count, undefined);
    const memoryApply = await postJson(`${baseUrl}/changes/apply`, {
      schema_version: "touba-project-change-apply-v1",
      proposal_id: "author_memory_lifecycle",
      decision: "apply",
      decided_by: { kind: "user", id: "reviewer" },
      reason: "Validated.",
    });
    assert.equal(memoryApply.status, 202);
    assert.match(readFileSync(join(root, "src", "main.tb"), "utf8"), /memory LifecycleEvidence/u);

    const toolRequest = {
      schema_version: "touba-element-authoring-request-v1",
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
          effect_contract: { kind: "none" },
          timeout_ms: 5000,
          max_payload_bytes: 65536,
          sandbox_required: true,
        },
      },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "Add the governed lifecycle integration.",
    };
    const toolPreviewResponse = await postJson(`${baseUrl}/elements/preview`, toolRequest);
    assert.equal(toolPreviewResponse.status, 200, await toolPreviewResponse.clone().text());
    const toolPreview = await toolPreviewResponse.json();
    assertMatchesSchema("touba-element-authoring-preview-v1", toolPreview);
    assert.equal(toolPreview.impact.file_count, 4);
    assert.equal(toolPreview.impact.handler_stub_count, 1);
    assert.equal(toolPreview.changes.some((change) => change.path === "touba.manifest.json"), false);
    assert.equal(toolPreview.changes.some((change) => change.path === "touba.bindings.json"), true);
    assert.equal(toolPreview.changes.some((change) => change.path === "touba.project.json"), true);

    const toolProposal = await postJson(`${baseUrl}/elements/propose`, {
      ...toolRequest,
      preview_digest: toolPreview.preview_digest,
    });
    assert.equal(toolProposal.status, 202);
    const toolDraft = await toolProposal.json();
    assert.equal(toolDraft.target_count, 4);
    assert.equal(JSON.stringify(toolDraft).includes("LIFECYCLE_API_TOKEN"), false);
    const toolApply = await postJson(`${baseUrl}/changes/apply`, {
      schema_version: "touba-project-change-apply-v1",
      proposal_id: "author_tool_lifecycle",
      decision: "apply",
      decided_by: { kind: "user", id: "reviewer" },
      reason: "Validated.",
    });
    assert.equal(toolApply.status, 202);
    const fragment = JSON.parse(readFileSync(join(root, "touba.bindings.json"), "utf8"));
    const handlerPath = fragment.bindings["tool:demo.lifecycle/FetchLifecycleRecord"].handler.args[0];
    assert.equal(existsSync(join(root, handlerPath)), true);
    assert.match(readFileSync(join(root, handlerPath), "utf8"), /HandlerNotImplemented/u);
    assert.deepEqual(JSON.parse(readFileSync(join(root, "touba.project.json"), "utf8")).configuration.binding_fragments, ["touba.bindings.json"]);
    const graph = await getJson(`${baseUrl}/authority/graph`);
    assert.equal(graph.nodes.some((node) => node.ref === "tool:demo.lifecycle/FetchLifecycleRecord"), true);

    const staleRequest = {
      schema_version: "touba-element-authoring-request-v1",
      proposal_id: "author_stale_lifecycle",
      module_ref: "demo.lifecycle",
      element: { kind: "memory", name: "StaleEvidence", description: "" },
      requested_by: { kind: "studio", id: "touba-studio" },
      reason: "Prove stale preview rejection.",
    };
    const stalePreview = await (await postJson(`${baseUrl}/elements/preview`, staleRequest)).json();
    writeFileSync(join(root, "src", "main.tb"), `${readFileSync(join(root, "src", "main.tb"), "utf8")}\n`, "utf8");
    const staleProposal = await postJson(`${baseUrl}/elements/propose`, {
      ...staleRequest,
      preview_digest: stalePreview.preview_digest,
    });
    assert.equal(staleProposal.status, 409);
    assert.equal((await staleProposal.json()).code, "ToubaServeElementPreviewStale");

    const planResponse = await postJson(`${baseUrl}/deployments/plan`, {
      schema_version: "touba-deployment-action-v1",
      action: "plan",
      profile: "dev",
      actor: "user:reviewer",
    });
    const plan = await planResponse.json();
    assert.equal(planResponse.status, 200, JSON.stringify(plan));
    assert.equal(plan.status, "ready");
    assertMatchesSchema("touba-deployment-plan-v1", plan);

    const missingReview = await postJson(`${baseUrl}/deployments/publish`, {
      schema_version: "touba-deployment-action-v1", action: "publish", profile: "dev", actor: "user:reviewer",
    });
    assert.equal(missingReview.status, 400);
    const stalePublish = await postJson(`${baseUrl}/deployments/publish`, {
      schema_version: "touba-deployment-action-v1", action: "publish", profile: "dev", actor: "user:reviewer", bundle_sha256: "0".repeat(64),
    });
    assert.equal(stalePublish.status, 409);
    assert.equal((await getJson(`${baseUrl}/deployments`)).revisions.length, 0);
    const firstPublish = await postJson(`${baseUrl}/deployments/publish`, {
      schema_version: "touba-deployment-action-v1",
      action: "publish",
      bundle_sha256: plan.bundle_sha256,
      profile: "dev",
      actor: "user:reviewer",
    });
    assert.equal(firstPublish.status, 202);
    const firstStatus = await firstPublish.json();
    const firstRevision = firstStatus.revision.revision_id;
    assert.equal(JSON.stringify(firstStatus).includes(token), false);
    const firstActivation = await postJson(`${baseUrl}/deployments/activate`, {
      schema_version: "touba-deployment-action-v1",
      action: "activate",
      revision_id: firstRevision,
      expected_state: firstStatus.state_digest,
      actor: "user:reviewer",
    });
    assert.equal(firstActivation.status, 202);

    const secondProposal = await postJson(`${baseUrl}/elements/propose`, {
      schema_version: "touba-element-authoring-request-v1",
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
      schema_version: "touba-project-change-apply-v1",
      proposal_id: "author_memory_second_revision",
      decision: "apply",
      decided_by: { kind: "user", id: "reviewer" },
      reason: "Validated.",
    });
    assert.equal(secondApply.status, 202);
    const secondPlan = await (await postJson(`${baseUrl}/deployments/plan`, {
      schema_version: "touba-deployment-action-v1", action: "plan", profile: "dev", actor: "user:reviewer",
    })).json();
    const secondPublish = await postJson(`${baseUrl}/deployments/publish`, {
      schema_version: "touba-deployment-action-v1",
      action: "publish",
      bundle_sha256: secondPlan.bundle_sha256,
      profile: "dev",
      actor: "user:reviewer",
    });
    assert.equal(secondPublish.status, 202);
    const secondStatus = await secondPublish.json();
    const secondRevision = secondStatus.revision.revision_id;
    assert.notEqual(secondRevision, firstRevision);
    const secondActivation = await postJson(`${baseUrl}/deployments/activate`, {
      schema_version: "touba-deployment-action-v1",
      action: "activate",
      revision_id: secondRevision,
      expected_state: secondStatus.state_digest,
      actor: "user:reviewer",
    });
    assert.equal(secondActivation.status, 202);
    const activatedStatus = await secondActivation.json();
    const staleRollback = await postJson(`${baseUrl}/deployments/rollback`, {
      schema_version: "touba-deployment-action-v1", action: "rollback", actor: "user:reviewer", expected_state: secondStatus.state_digest,
    });
    assert.equal(staleRollback.status, 409);
    assert.equal((await getJson(`${baseUrl}/deployments`)).current_revision_id, secondRevision);

    const rollback = await postJson(`${baseUrl}/deployments/rollback`, {
      schema_version: "touba-deployment-action-v1",
      action: "rollback",
      expected_state: activatedStatus.state_digest,
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
  assert.equal(response.status, 200, response.ok ? undefined : await response.clone().text());
  return response.json();
}

async function postJson(url, body) {
  return fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

async function waitForInteractionOperation(baseUrl, sessionId, operationId) {
  const terminalStatuses = new Set([
    "awaiting_human",
    "succeeded",
    "failed",
    "cancelled",
    "interrupted",
  ]);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const operation = await getJson(
      `${baseUrl}/interactions/sessions/${sessionId}/operations/${operationId}`,
    );
    if (terminalStatuses.has(operation.status)) return operation;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`interaction operation ${operationId} did not reach a terminal status`);
}

async function waitForStoredInteractionOperation({ operationId, sessionsPath }) {
  const terminalStatuses = new Set(["awaiting_human", "succeeded", "failed", "cancelled", "interrupted"]);
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const store = readStoreFixture(sessionsPath);
    const operation = store.sessions
      .flatMap((session) => session.operations)
      .find((candidate) => candidate.operation_id === operationId);
    if (operation !== undefined && terminalStatuses.has(operation.status)) return operation;
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`stored interaction operation ${operationId} did not reach a terminal status`);
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

async function waitForPath(path, child, stderr, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path)) return;
    if (child.exitCode !== null || child.signalCode !== null) {
      assert.fail(`child exited before durable marker: ${stderr()}`);
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 10));
  }
  assert.fail(`timed out waiting for ${path}: ${stderr()}`);
}

async function waitForChildExit(child, timeoutMs = 10000) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await Promise.race([
    new Promise((resolveExit) => child.once("exit", resolveExit)),
    new Promise((_, rejectTimeout) => setTimeout(
      () => rejectTimeout(new Error(`child ${child.pid} did not exit`)),
      timeoutMs,
    )),
  ]);
}

async function withTimeout(promise, label, timeoutMs = 10000) {
  return new Promise((resolveValue, rejectValue) => {
    const timeout = setTimeout(
      () => rejectValue(new Error(`timed out waiting for ${label}`)),
      timeoutMs,
    );
    Promise.resolve(promise).then(
      (value) => {
        clearTimeout(timeout);
        resolveValue(value);
      },
      (error) => {
        clearTimeout(timeout);
        rejectValue(error);
      },
    );
  });
}

async function startProjectServerProcess(projectRoot) {
  const servePath = new URL("../src/serve.mjs", import.meta.url).pathname;
  const child = spawn(process.execPath, [
    servePath,
    "--contracts-root", contractsRoot,
    "--project-root", projectRoot,
    "--port", "0",
  ], {
    cwd: projectRoot,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderr += chunk.toString("utf8"); });
  const started = await new Promise((resolveStarted, rejectStarted) => {
    const timeout = setTimeout(() => {
      rejectStarted(new Error(`project server child did not start: ${stderr}`));
    }, 10000);
    const onExit = () => {
      clearTimeout(timeout);
      rejectStarted(new Error(`project server child exited before listen: ${stderr}`));
    };
    child.once("exit", onExit);
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString("utf8");
      const lines = stdout.split("\n");
      stdout = lines.pop() ?? "";
      for (const line of lines) {
        try {
          const event = JSON.parse(line);
          if (event.event === "touba_project_server_started") {
            clearTimeout(timeout);
            child.off("exit", onExit);
            resolveStarted(event);
            return;
          }
        } catch {
          // Preserve non-JSON process output for the next complete line.
        }
      }
    });
  });
  return {
    child,
    baseUrl: `http://${started.host}:${started.port}`,
    stderr: () => stderr,
  };
}

async function stopChildProcess(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill("SIGTERM");
  await waitForChildExit(child);
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

function sandboxAirDocument({ withInput = false, withTool = false } = {}) {
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
      ...(withInput ? [
        {
          id: "strategy:demo.sandbox/EchoInput",
          name: "EchoInput",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          flow_graph_ref: "graph:strategy:demo.sandbox/EchoInput",
          source_ref: sourceRef(),
        },
      ] : []),
      ...(withTool ? [
        {
          id: "strategy:demo.sandbox/RunTool",
          name: "RunTool",
          uses: ["tool:demo.sandbox/ReadExternal"],
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
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
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
      ...(withInput ? [
        graph("graph:strategy:demo.sandbox/EchoInput", "strategy:demo.sandbox/EchoInput", [
          node("echo", "give", { arguments: ["value:query"] }),
        ]),
      ] : []),
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
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
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
    air_schema_version: AIR_SCHEMA_VERSION,
    air_capability_profile: AIR_CAPABILITY_PROFILE,
    air_json_profile: AIR_JSON_PROFILE,
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
        signature: { inputs: [], output_type: "builtin:Approval" },
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
        },
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
    schema_version: "touba-product-identity-v1",
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
