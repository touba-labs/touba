#!/usr/bin/env node
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCT_SURFACE_CONTRACTS,
  validateObject,
} from "../../../tools/validate-product-surface-contracts.mjs";
import {
  buildAirInputContract,
  unavailableAirInputContract,
} from "../../../contracts/product-surfaces/input-contracts.mjs";
import { buildInteractionContract } from "../../../contracts/product-surfaces/interaction-contracts.mjs";
import {
  buildElementAuthoringChangeSet,
  ELEMENT_AUTHORING_SCHEMA_VERSION,
} from "./element-authoring.mjs";
import {
  executeAirDocument,
  executeTriggerEvent,
  loadAirFromJson,
  loadSecretsFromJson,
  loadToolBindingManifestFromJson,
  ToubaRuntimeError,
} from "@touba/runtime";
import {
  buildDeploymentBundle,
  deploymentReadinessChecks,
  deploymentTargetRequest,
  verifyDeploymentBundle,
} from "@touba/deployment";
import {
  archiveInteractionSession,
  completeInteractionOperation,
  createInteractionSession,
  enqueueInteractionOperation,
  failInteractionOperation,
  findInteractionOperationByMessage,
  getInteractionOperation,
  getInteractionSession,
  INTERACTION_ASSET_SCHEMA_VERSION,
  INTERACTION_MESSAGE_REQUEST_SCHEMA_VERSION,
  INTERACTION_OPERATION_SCHEMA_VERSION,
  INTERACTION_RESUME_REQUEST_SCHEMA_VERSION,
  INTERACTION_SESSION_CREATE_SCHEMA_VERSION,
  INTERACTION_SESSION_LIST_SCHEMA_VERSION,
  INTERACTION_SESSION_SCHEMA_VERSION,
  listInteractionSessions,
  MAX_INTERACTION_ASSET_BYTES,
  readInteractionAsset,
  recordInteractionOperationProgress,
  recoverInterruptedInteractionOperations,
  requestInteractionOperationCancel,
  startInteractionOperation,
  storeInteractionAsset,
  validateInteractionResume,
} from "./interactions.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const DEFAULT_HUMAN_DECISIONS_PATH = ".touba/human-decisions.json";
const DEFAULT_CHANGE_PROPOSALS_PATH = ".touba/studio-change-proposals.json";
const DEFAULT_EVENT_JOURNAL_PATH = ".touba/project-events.jsonl";
const DEFAULT_RUN_SUMMARY_PATH = ".touba/current-run-summary.json";
const DEFAULT_TRACE_TIMELINE_PATH = ".touba/current-trace-timeline.json";
const DEFAULT_TRIGGER_STATUS_PATH = ".touba/trigger-status.json";
const DEFAULT_HUMAN_REQUESTS_PATH = ".touba/human-requests.json";
const DEFAULT_SANDBOX_CHECKPOINTS_PATH = ".touba/sandbox-checkpoints.json";
const DEFAULT_PRODUCT_IDENTITY_PATH = ".touba/product-identity.json";
const DEFAULT_COST_OBSERVATORY_PATH = ".touba/cost-observatory.json";
const DEFAULT_HANDLER_SANDBOX_STATUS_PATH = ".touba/handler-sandbox-status.json";
const DEFAULT_MOBILE_NOTIFICATIONS_PATH = ".touba/mobile-notifications.json";
const DEFAULT_MOBILE_PAIRINGS_PATH = ".touba/mobile-pairings.json";
const DEFAULT_MOBILE_QUICK_APPROVAL_POLICY_PATH = ".touba/mobile-quick-approval-policy.json";
const DEFAULT_MOBILE_ESCALATION_PATH = ".touba/mobile-escalation.json";
const DEFAULT_INTERACTION_SESSIONS_PATH = ".touba/interaction-sessions.json";
const DEFAULT_INTERACTION_ASSETS_PATH = ".touba/interaction-assets.json";
const DEFAULT_INTERACTION_ASSETS_DIRECTORY = ".touba/interaction-assets";
const DEFAULT_INPUT_PRESENTATION_PATH = "touba.inputs.json";
const DEFAULT_DEV_SECRETS_PROFILE_PATH = "touba.secrets.dev.json";
const DEFAULT_EVENT_JOURNAL_LIMIT = 200;
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CHANGE_CONTENT_BYTES = 64 * 1024;
const MAX_CHANGE_SET_BYTES = 512 * 1024;
const MAX_CHANGE_SET_TARGETS = 16;
const MAX_PROJECT_ARTIFACTS = 200;
const MAX_PROJECT_SCAN_DEPTH = 6;
const STUDIO_INTERACTION_TARGET_KINDS = new Set(["agent", "skill", "strategy", "tool", "trigger"]);
const CONTRACT_INDEX_SCHEMA_VERSION = "touba-project-server-contract-index-v0.1";
const LIVE_STATE_SCHEMA_VERSION = "touba-project-live-state-v0.1";
const EVENT_STREAM_SCHEMA_VERSION = "touba-project-event-stream-v0.1";
const HUMAN_DECISION_STORE_SCHEMA_VERSION = "touba-human-decisions-v0.1";
const HUMAN_REQUEST_STORE_SCHEMA_VERSION = "touba-human-requests-v0.1";
const SANDBOX_CHECKPOINT_STORE_SCHEMA_VERSION = "touba-sandbox-checkpoints-v0.1";
const HUMAN_DECISION_HISTORY_SCHEMA_VERSION = "touba-human-decision-history-v0.1";
const HUMAN_DECISION_DETAIL_SCHEMA_VERSION = "touba-human-decision-detail-v0.1";
const AUTHORITY_GRAPH_SCHEMA_VERSION = "touba-authority-graph-v0.1";
const PRODUCT_IDENTITY_SCHEMA_VERSION = "touba-product-identity-v0.1";
const SUPPLY_CHAIN_STATUS_SCHEMA_VERSION = "touba-supply-chain-status-v0.1";
const GOVERNANCE_READINESS_SCHEMA_VERSION = "touba-governance-readiness-v0.1";
const TRIGGER_QUEUE_HEALTH_SCHEMA_VERSION = "touba-trigger-queue-health-v0.1";
const COST_OBSERVATORY_SCHEMA_VERSION = "touba-cost-observatory-v0.1";
const HANDLER_SANDBOX_STATUS_SCHEMA_VERSION = "touba-handler-sandbox-status-v0.1";
const MOBILE_NOTIFICATION_SCHEMA_VERSION = "touba-mobile-notification-v0.1";
const MOBILE_PAIRING_REQUEST_SCHEMA_VERSION = "touba-mobile-pairing-request-v0.1";
const MOBILE_PAIRING_STORE_SCHEMA_VERSION = "touba-mobile-pairings-v0.1";
const MOBILE_QUICK_APPROVAL_POLICY_SCHEMA_VERSION = "touba-mobile-quick-approval-policy-v0.1";
const MOBILE_ESCALATION_SCHEMA_VERSION = "touba-mobile-escalation-v0.1";
const PROJECT_REFRESH_REQUEST_SCHEMA_VERSION = "touba-project-refresh-request-v0.1";
const PROJECT_REFRESH_SCHEMA_VERSION = "touba-project-refresh-v0.1";
const SANDBOX_RUN_REQUEST_SCHEMA_VERSION = "touba-sandbox-run-request-v0.1";
const SANDBOX_RUN_RESULT_SCHEMA_VERSION = "touba-sandbox-run-result-v0.1";
const CHANGE_PROPOSAL_SCHEMA_VERSION = "touba-project-change-proposal-v0.1";
const CHANGE_PROPOSED_SCHEMA_VERSION = "touba-project-change-proposed-v0.1";
const CHANGE_APPLY_SCHEMA_VERSION = "touba-project-change-apply-v0.1";
const CHANGE_RESULT_SCHEMA_VERSION = "touba-project-change-result-v0.1";
const CHANGE_HISTORY_SCHEMA_VERSION = "touba-project-change-history-v0.1";
const CHANGE_DETAIL_SCHEMA_VERSION = "touba-project-change-detail-v0.1";
const DEPLOYMENT_ACTION_SCHEMA_VERSION = "touba-deployment-action-v0.1";
const DEPLOYMENT_PLAN_SCHEMA_VERSION = "touba-deployment-plan-v0.1";
const GOVERNANCE_RELATION_CHANGE_SCHEMA_VERSION = "touba-governance-relation-change-v0.1";
const PROJECT_EVENT_SCHEMA_VERSION = "touba-project-event-v0.1";
const CHANGE_STORE_SCHEMA_VERSION = "touba-studio-change-proposals-v0.1";
const CHANGE_ACTIONS = Object.freeze(["write_text_file"]);
const CHANGE_DECISIONS = Object.freeze(["apply", "refuse"]);
const MOBILE_PAIRING_ALLOWED_SCOPES = Object.freeze([
  "approvals:read",
  "reviews:read",
  "decisions:write",
  "notifications:read",
  "events:read",
]);
const TOUBA_CLI_PATH = new URL("../../touba-project/src/main.mjs", import.meta.url).pathname;
const PROJECT_SCAN_EXCLUDED_DIRS = Object.freeze(new Set([
  ".git",
  "node_modules",
  ".pnpm-store",
  "dist",
  "build",
  ".next",
  ".turbo",
]));
const NAMED_PROJECT_ARTIFACTS = Object.freeze(new Set([
  "touba.project.json",
  "touba.manifest.json",
  "touba.package.json",
  "touba.ownership.json",
  "touba.lock.json",
  "touba.resources.json",
  "resources.json",
]));
const AIR_ENTRYPOINT_KINDS = Object.freeze({
  agents: "agent",
  functions: "function",
  skills: "skill",
  strategies: "strategy",
  tools: "tool",
});
const CHANGE_TARGET_JSON_FILES = Object.freeze(new Set([
  "touba.project.json",
  "touba.manifest.json",
  "touba.package.json",
  "touba.ownership.json",
  "touba.resources.json",
  "resources.json",
]));
const ACCEPTED_DECISION_CONTRACTS = Object.freeze([
  "touba-approval-decision-v1",
  "touba-human-review-decision-v1",
]);
const LIVE_ENDPOINT_CONTRACTS = Object.freeze({
  "/authority/graph": AUTHORITY_GRAPH_SCHEMA_VERSION,
  "/identity": PRODUCT_IDENTITY_SCHEMA_VERSION,
  "/runs/current": "touba-run-summary-v1",
  "/trace/current": "touba-trace-timeline-v1",
  "/triggers": "touba-trigger-status-v1",
  "/triggers/queue-health": TRIGGER_QUEUE_HEALTH_SCHEMA_VERSION,
  "/supply-chain/status": SUPPLY_CHAIN_STATUS_SCHEMA_VERSION,
  "/governance/readiness": GOVERNANCE_READINESS_SCHEMA_VERSION,
  "/budgets/costs": COST_OBSERVATORY_SCHEMA_VERSION,
  "/runtime/sandbox": HANDLER_SANDBOX_STATUS_SCHEMA_VERSION,
  "/mobile/notifications": MOBILE_NOTIFICATION_SCHEMA_VERSION,
  "/mobile/quick-approval-policy": MOBILE_QUICK_APPROVAL_POLICY_SCHEMA_VERSION,
  "/mobile/escalations": MOBILE_ESCALATION_SCHEMA_VERSION,
  "/approvals/pending/current": "touba-approval-request-v1",
  "/reviews/pending/current": "touba-human-review-request-v1",
});

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help === true) {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    if (options.agentDecisionProviderPath !== undefined) {
      options.agentDecisionProvider = await loadAgentDecisionProviderFromPath(options.agentDecisionProviderPath);
    }
    const service = createToubaProjectServer(options);
    await service.start();
  } catch (error) {
    process.stderr.write(`touba serve error [${error.code ?? "ToubaServeError"}]: ${error.message}\n`);
    process.exit(1);
  }
}

export function createToubaProjectServer(options = {}) {
  const contractsRoot = resolve(
    options.contractsRoot ?? new URL("../../../contracts/product-surfaces/", import.meta.url).pathname,
  );
  const projectRoot = resolve(options.projectRoot ?? process.cwd());
  const deploymentTargetUrl = options.deploymentTargetUrl;
  const deploymentTargetToken = options.deploymentTargetToken
    ?? (options.deploymentTargetTokenEnv === undefined
      ? undefined
      : process.env[options.deploymentTargetTokenEnv]);
  const humanDecisionsPath = resolve(
    options.humanDecisionsPath ?? join(projectRoot, DEFAULT_HUMAN_DECISIONS_PATH),
  );
  const changeProposalsPath = resolve(
    options.changeProposalsPath ?? join(projectRoot, DEFAULT_CHANGE_PROPOSALS_PATH),
  );
  const eventJournalPath = resolve(
    options.eventJournalPath ?? join(projectRoot, DEFAULT_EVENT_JOURNAL_PATH),
  );
  const runSummaryPath = resolve(
    options.runSummaryPath ?? join(projectRoot, DEFAULT_RUN_SUMMARY_PATH),
  );
  const traceTimelinePath = resolve(
    options.traceTimelinePath ?? join(projectRoot, DEFAULT_TRACE_TIMELINE_PATH),
  );
  const triggerStatusPath = resolve(
    options.triggerStatusPath ?? join(projectRoot, DEFAULT_TRIGGER_STATUS_PATH),
  );
  const humanRequestsPath = resolve(
    options.humanRequestsPath ?? join(projectRoot, DEFAULT_HUMAN_REQUESTS_PATH),
  );
  const sandboxCheckpointsPath = resolve(
    options.sandboxCheckpointsPath ?? join(projectRoot, DEFAULT_SANDBOX_CHECKPOINTS_PATH),
  );
  const productIdentityPath = resolve(
    options.productIdentityPath ?? join(projectRoot, DEFAULT_PRODUCT_IDENTITY_PATH),
  );
  const costObservatoryPath = resolve(
    options.costObservatoryPath ?? join(projectRoot, DEFAULT_COST_OBSERVATORY_PATH),
  );
  const handlerSandboxStatusPath = resolve(
    options.handlerSandboxStatusPath ?? join(projectRoot, DEFAULT_HANDLER_SANDBOX_STATUS_PATH),
  );
  const mobileNotificationsPath = resolve(
    options.mobileNotificationsPath ?? join(projectRoot, DEFAULT_MOBILE_NOTIFICATIONS_PATH),
  );
  const mobilePairingsPath = resolve(
    options.mobilePairingsPath ?? join(projectRoot, DEFAULT_MOBILE_PAIRINGS_PATH),
  );
  const mobileQuickApprovalPolicyPath = resolve(
    options.mobileQuickApprovalPolicyPath ?? join(projectRoot, DEFAULT_MOBILE_QUICK_APPROVAL_POLICY_PATH),
  );
  const mobileEscalationPath = resolve(
    options.mobileEscalationPath ?? join(projectRoot, DEFAULT_MOBILE_ESCALATION_PATH),
  );
  const interactionSessionsPath = resolve(
    options.interactionSessionsPath ?? join(projectRoot, DEFAULT_INTERACTION_SESSIONS_PATH),
  );
  const interactionAssetsPath = resolve(
    options.interactionAssetsPath ?? join(projectRoot, DEFAULT_INTERACTION_ASSETS_PATH),
  );
  const interactionAssetsDirectory = resolve(
    options.interactionAssetsDirectory ?? join(projectRoot, DEFAULT_INTERACTION_ASSETS_DIRECTORY),
  );
  const eventJournalLimit = options.eventJournalLimit ?? DEFAULT_EVENT_JOURNAL_LIMIT;
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const authToken = options.authTokenEnv === undefined ? undefined : process.env[options.authTokenEnv];
  const identityControlPlaneUrl = options.identityControlPlaneUrl;
  const identityServiceToken = options.identityServiceToken
    ?? (options.identityServiceTokenEnv === undefined
      ? undefined
      : process.env[options.identityServiceTokenEnv]);
  const agentDecisionProvider = options.agentDecisionProvider;
  const secretsPath = resolve(
    options.secretsPath ?? join(projectRoot, DEFAULT_DEV_SECRETS_PROFILE_PATH),
  );
  const secretsRequired = options.secretsPath !== undefined;
  const eventClients = new Set();
  const interactionOperationControllers = new Map();
  const interactionOperationTasks = new Set();
  let projectSnapshot;
  let eventSequence = 0;
  const nextEvent = (type, payload) => {
    eventSequence += 1;
    const event = buildProjectEvent({ type, payload, sequence: eventSequence });
    appendProjectEventJournal({ eventJournalPath, limit: eventJournalLimit, event });
    return event;
  };

  if (options.authTokenEnv !== undefined && (!authToken || authToken.trim() === "")) {
    throw serviceError("ToubaServeAuthTokenMissing", `environment variable ${options.authTokenEnv} is required`);
  }
  if ((identityControlPlaneUrl === undefined) !== (identityServiceToken === undefined)) {
    throw serviceError(
      "ToubaServeIdentityNotConfigured",
      "--identity-control-plane-url and --identity-service-token-env must be configured together",
    );
  }
  if (identityServiceToken !== undefined && identityServiceToken.length < 32) {
    throw serviceError(
      "ToubaServeIdentityNotConfigured",
      `environment variable ${options.identityServiceTokenEnv} must contain at least 32 characters`,
    );
  }
  if (identityControlPlaneUrl !== undefined) {
    assertIdentityControlPlaneConfigured({
      controlPlaneUrl: identityControlPlaneUrl,
      serviceToken: identityServiceToken,
    });
  }
  if (
    options.deploymentTargetTokenEnv !== undefined
    && (deploymentTargetToken === undefined || deploymentTargetToken.length < 32)
  ) {
    throw serviceError(
      "ToubaServeDeploymentTargetNotConfigured",
      `environment variable ${options.deploymentTargetTokenEnv} must contain at least 32 characters`,
    );
  }
  if (
    (deploymentTargetUrl === undefined) !== (deploymentTargetToken === undefined)
  ) {
    throw serviceError(
      "ToubaServeDeploymentTargetNotConfigured",
      "deployment target URL and token must be configured together",
    );
  }
  if (deploymentTargetUrl !== undefined) {
    assertDeploymentTargetConfigured({ deploymentTargetToken, deploymentTargetUrl });
  }
  if (!isLoopbackHost(host) && authToken === undefined) {
    throw serviceError("ToubaServeAuthRequired", "non-loopback Touba project server hosts require --auth-token-env");
  }
  preflightServeOptions({
    contractsRoot,
    projectRoot,
    humanDecisionsPath,
    changeProposalsPath,
    eventJournalPath,
    runSummaryPath,
    traceTimelinePath,
    triggerStatusPath,
    humanRequestsPath,
    sandboxCheckpointsPath,
    productIdentityPath,
    mobilePairingsPath,
    interactionSessionsPath,
    interactionAssetsPath,
    interactionAssetsDirectory,
    eventJournalLimit,
    strict: options.strict === true,
  });
  recoverProjectChangeTransactions({ projectRoot });
  eventSequence = latestProjectEventSequence(readProjectEventJournal(eventJournalPath));
  for (const operation of recoverInterruptedInteractionOperations({
    sessionsPath: interactionSessionsPath,
  })) {
    nextEvent("interaction.run.interrupted", interactionOperationEventPayload(operation));
  }
  projectSnapshot = buildProjectSnapshot({
    projectRoot,
    previousSnapshot: undefined,
    refreshedAt: new Date().toISOString(),
  });

  const scheduleInteractionOperation = ({
    operation,
    request,
    resume = false,
    session,
  }) => {
    const controller = { cancelRequested: operation.status === "cancel_requested" };
    interactionOperationControllers.set(operation.operation_id, controller);
    const task = new Promise((resolveTask) => setImmediate(resolveTask))
      .then(async () => {
        const started = startInteractionOperation({
          operationId: operation.operation_id,
          sessionId: session.session_id,
          sessionsPath: interactionSessionsPath,
        });
        publishEvent(
          eventClients,
          started.status === "cancel_requested"
            ? "interaction.run.cancel_requested"
            : "interaction.run.started",
          interactionOperationEventPayload(started),
          nextEvent,
        );
        const traceEventObserver = (event) => {
          const progressed = recordInteractionOperationProgress({
            event,
            operationId: operation.operation_id,
            sessionId: session.session_id,
            sessionsPath: interactionSessionsPath,
          });
          publishEvent(
            eventClients,
            "interaction.run.progress",
            interactionOperationEventPayload(progressed),
            nextEvent,
          );
        };
        const common = {
          agentDecisionProvider,
          agentDecisionProviderContentMode: options.agentDecisionProviderContentMode,
          agentDecisionProviderInitialMode: options.agentDecisionProviderInitialMode,
          agentDecisionProviderMaxRetries: options.agentDecisionProviderMaxRetries,
          agentDecisionProviderMetadata: options.agentDecisionProviderMetadata,
          agentDecisionProviderTimeoutMs: options.agentDecisionProviderTimeoutMs,
          cancelRequestedProvider: () => controller.cancelRequested,
          contractsRoot,
          humanRequestsPath,
          projectRoot,
          runSummaryPath,
          sandboxCheckpointsPath,
          secretsPath,
          secretsRequired,
          traceEventObserver,
          traceTimelinePath,
        };
        const result = resume
          ? await resumeProjectSandboxRun({
            ...common,
            humanDecisionsPath,
            request,
          })
          : await executeProjectSandboxRun({
            ...common,
            executionKind: session.target_kind === "trigger" ? "trigger" : "entrypoint",
            request,
            runId: operation.run_id,
          });
        const completed = completeInteractionOperation({
          operationId: operation.operation_id,
          result,
          sessionId: session.session_id,
          sessionsPath: interactionSessionsPath,
        });
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_OPERATION_SCHEMA_VERSION,
          value: completed,
          errorCode: "ToubaServeInteractionOperationInvalid",
          message: "interaction operation does not match its contract",
        });
        publishEvent(
          eventClients,
          interactionCompletionEventType(completed.status),
          interactionOperationEventPayload(completed),
          nextEvent,
        );
      })
      .catch((cause) => {
        let failed;
        try {
          failed = failInteractionOperation({
            code: cause.code ?? "ToubaServeInteractionRunFailed",
            message: cause.message,
            operationId: operation.operation_id,
            sessionId: session.session_id,
            sessionsPath: interactionSessionsPath,
          });
        } catch {
          failed = operation;
        }
        publishEvent(
          eventClients,
          "interaction.run.failed",
          interactionOperationEventPayload(failed, {
            error: {
              code: String(cause.code ?? "ToubaServeInteractionRunFailed"),
              message: String(cause.message ?? "interaction run failed"),
            },
          }),
          nextEvent,
        );
      })
      .finally(() => {
        interactionOperationControllers.delete(operation.operation_id);
      });
    interactionOperationTasks.add(task);
    task.finally(() => interactionOperationTasks.delete(task));
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
      const corsAllowed = applyCorsHeaders(request, response);
      if (request.method === "OPTIONS") {
        if (corsAllowed) {
          response.writeHead(204);
          response.end();
        } else {
          writeJson(response, 403, { status: "error", code: "ToubaServeCorsOriginRejected" });
        }
        return;
      }
      const isPairingAccept = request.method === "POST" && url.pathname === "/mobile/pairings/accept";
      let humanIdentity = null;
      if (authToken !== undefined && !isPairingAccept && !authorized(request, authToken, mobilePairingsPath)) {
        writeJson(response, 401, { status: "error", code: "ToubaServeUnauthorized" });
        return;
      }
      const identityPermission = requiredIdentityPermission(request.method, url.pathname);
      if (
        identityControlPlaneUrl !== undefined
        && !isPairingAccept
        && identityPermission !== null
      ) {
        const identityResult = await authorizeHumanIdentity({
          accessToken: request.headers["x-touba-identity-token"],
          controlPlaneUrl: identityControlPlaneUrl,
          permission: identityPermission,
          serviceToken: identityServiceToken,
        });
        if (!identityResult.active) {
          writeJson(response, 401, {
            status: "error",
            code: "ToubaServeIdentityUnauthorized",
            message: "an active human identity session is required",
          });
          return;
        }
        if (!identityResult.allowed) {
          writeJson(response, 403, {
            status: "error",
            code: "ToubaServeIdentityPermissionDenied",
            message: `permission required: ${identityPermission}`,
          });
          return;
        }
        humanIdentity = identityResult;
      }
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          service: "touba-project-server",
          contract_index_schema_version: CONTRACT_INDEX_SCHEMA_VERSION,
          live_state_schema_version: LIVE_STATE_SCHEMA_VERSION,
          event_stream_schema_version: EVENT_STREAM_SCHEMA_VERSION,
          human_identity_enforced: identityControlPlaneUrl !== undefined,
          endpoints: {
            state: "/state",
            events: "/events",
            project: "/project",
            project_refresh: "/project/refresh",
            authority_graph: "/authority/graph",
            identity: "/identity",
            event_schema: PROJECT_EVENT_SCHEMA_VERSION,
            current_run: "/runs/current",
            sandbox_run: "/runs/sandbox",
            trigger_status: "/triggers",
            trigger_fire: "/triggers/fire",
            trigger_queue_health: "/triggers/queue-health",
            supply_chain_status: "/supply-chain/status",
            governance_readiness: "/governance/readiness",
            cost_observatory: "/budgets/costs",
            runtime_sandbox: "/runtime/sandbox",
            mobile_notifications: "/mobile/notifications",
            mobile_pairing_request: "/mobile/pairings/request",
            mobile_pairing_accept: "/mobile/pairings/accept",
            mobile_pairing_revoke: "/mobile/pairings/revoke",
            mobile_quick_approval_policy: "/mobile/quick-approval-policy",
            mobile_escalations: "/mobile/escalations",
            pending_approval: "/approvals/pending/current",
            pending_review: "/reviews/pending/current",
            human_decisions: "/decisions",
            sandbox_resume: "/runs/sandbox/resume",
            interaction_sessions: "/interactions/sessions",
            interaction_assets: "/interaction-assets",
            human_decision_detail: "/decisions/<schema_version>/<request_id>",
            change_history: "/changes",
            change_detail: "/changes/<proposal_id>",
            change_propose: "/changes/propose",
            change_apply: "/changes/apply",
            governance_relation_propose: "/governance/relations/propose",
            element_authoring_propose: "/elements/propose",
            deployments: "/deployments",
            deployment_plan: "/deployments/plan",
            deployment_publish: "/deployments/publish",
            deployment_activate: "/deployments/activate",
            deployment_rollback: "/deployments/rollback",
            event_replay: "Last-Event-ID",
            event_journal_limit: eventJournalLimit,
            run_summary: "/runs/current",
            sandbox_run_result_schema_version: SANDBOX_RUN_RESULT_SCHEMA_VERSION,
            trace_timeline: "/trace/current",
            pending_approval_source: "/approvals/pending/current",
            pending_review_source: "/reviews/pending/current",
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        writeJson(response, 200, buildLiveState({
          contractsRoot,
          projectRoot,
          projectSnapshot,
          runSummaryPath,
          traceTimelinePath,
          triggerStatusPath,
          humanRequestsPath,
          humanDecisionsPath,
          productIdentityPath,
          costObservatoryPath,
          handlerSandboxStatusPath,
          mobileNotificationsPath,
          mobileQuickApprovalPolicyPath,
          mobileEscalationPath,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/project") {
        writeJson(response, 200, buildProjectInspection({
          projectRoot,
          projectSnapshot,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        openEventStream({ request, response, eventClients, nextEvent, eventJournalPath });
        return;
      }
      if (request.method === "GET" && url.pathname === "/runs/current") {
        writeJson(response, 200, readProjectRunSummary({ contractsRoot, runSummaryPath }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/runs/sandbox") {
        const body = bindHumanActor(await readJsonBody(request), "requested_by", humanIdentity);
        const result = await executeProjectSandboxRun({
          agentDecisionProvider,
          agentDecisionProviderContentMode: options.agentDecisionProviderContentMode,
          agentDecisionProviderInitialMode: options.agentDecisionProviderInitialMode,
          agentDecisionProviderMaxRetries: options.agentDecisionProviderMaxRetries,
          agentDecisionProviderMetadata: options.agentDecisionProviderMetadata,
          agentDecisionProviderTimeoutMs: options.agentDecisionProviderTimeoutMs,
          contractsRoot,
          executionKind: "entrypoint",
          humanRequestsPath,
          projectRoot,
          request: body,
          runSummaryPath,
          sandboxCheckpointsPath,
          secretsPath,
          secretsRequired,
          traceTimelinePath,
        });
        publishEvent(eventClients, "sandbox_run.completed", sandboxRunEventPayload(result), nextEvent);
        writeJson(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/interactions/sessions") {
        const result = listInteractionSessions(interactionSessionsPath);
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_SESSION_LIST_SCHEMA_VERSION,
          value: result,
          errorCode: "ToubaServeInteractionSessionInvalid",
          message: "interaction session list does not match its contract",
        });
        writeJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/interactions/sessions") {
        const body = bindHumanActor(await readJsonBody(request), "requested_by", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_SESSION_CREATE_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeInteractionSessionInvalid",
          message: "interaction session request does not match its contract",
        });
        const entrypoint = buildProjectInspection({ projectRoot, projectSnapshot }).entrypoints
          .find((candidate) => candidate.ref === body.target_ref);
        if (
          entrypoint === undefined
          || !STUDIO_INTERACTION_TARGET_KINDS.has(body.target_kind)
          || entrypoint.kind !== body.target_kind
          || entrypoint.interaction_contract.presentation !== body.presentation
        ) {
          throw serviceError(
            "ToubaServeInteractionTargetInvalid",
            "interaction target does not match the current project inspection",
          );
        }
        const session = createInteractionSession({
          request: body,
          sessionsPath: interactionSessionsPath,
        });
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_SESSION_SCHEMA_VERSION,
          value: session,
          errorCode: "ToubaServeInteractionSessionInvalid",
          message: "interaction session does not match its contract",
        });
        publishEvent(eventClients, "interaction.session.created", {
          schema_version: INTERACTION_SESSION_SCHEMA_VERSION,
          session_id: session.session_id,
          target_ref: session.target_ref,
          status: session.status,
        }, nextEvent);
        writeJson(response, 201, session);
        return;
      }
      const interactionSessionMatch = /^\/interactions\/sessions\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && interactionSessionMatch !== null) {
        const session = getInteractionSession({
          sessionId: decodeURIComponent(interactionSessionMatch[1]),
          sessionsPath: interactionSessionsPath,
        });
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_SESSION_SCHEMA_VERSION,
          value: session,
          errorCode: "ToubaServeInteractionSessionInvalid",
          message: "interaction session does not match its contract",
        });
        writeJson(response, 200, session);
        return;
      }
      const interactionArchiveMatch = /^\/interactions\/sessions\/([^/]+)\/archive$/u.exec(url.pathname);
      if (request.method === "POST" && interactionArchiveMatch !== null) {
        const session = archiveInteractionSession({
          sessionId: decodeURIComponent(interactionArchiveMatch[1]),
          sessionsPath: interactionSessionsPath,
        });
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_SESSION_SCHEMA_VERSION,
          value: session,
          errorCode: "ToubaServeInteractionSessionInvalid",
          message: "interaction session does not match its contract",
        });
        publishEvent(eventClients, "interaction.session.archived", {
          schema_version: INTERACTION_SESSION_SCHEMA_VERSION,
          session_id: session.session_id,
          target_ref: session.target_ref,
          status: session.status,
        }, nextEvent);
        writeJson(response, 200, session);
        return;
      }
      const interactionOperationMatch = /^\/interactions\/sessions\/([^/]+)\/operations\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && interactionOperationMatch !== null) {
        const operation = getInteractionOperation({
          operationId: decodeURIComponent(interactionOperationMatch[2]),
          sessionId: decodeURIComponent(interactionOperationMatch[1]),
          sessionsPath: interactionSessionsPath,
        });
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_OPERATION_SCHEMA_VERSION,
          value: operation,
          errorCode: "ToubaServeInteractionOperationInvalid",
          message: "interaction operation does not match its contract",
        });
        writeJson(response, 200, operation);
        return;
      }
      const interactionCancelMatch = /^\/interactions\/sessions\/([^/]+)\/operations\/([^/]+)\/cancel$/u.exec(url.pathname);
      if (request.method === "POST" && interactionCancelMatch !== null) {
        const sessionId = decodeURIComponent(interactionCancelMatch[1]);
        const operationId = decodeURIComponent(interactionCancelMatch[2]);
        const operation = requestInteractionOperationCancel({
          operationId,
          sessionId,
          sessionsPath: interactionSessionsPath,
        });
        const controller = interactionOperationControllers.get(operationId);
        if (controller !== undefined) controller.cancelRequested = true;
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_OPERATION_SCHEMA_VERSION,
          value: operation,
          errorCode: "ToubaServeInteractionOperationInvalid",
          message: "interaction operation does not match its contract",
        });
        publishEvent(
          eventClients,
          "interaction.run.cancel_requested",
          interactionOperationEventPayload(operation),
          nextEvent,
        );
        writeJson(response, 202, operation);
        return;
      }
      const interactionMessageMatch = /^\/interactions\/sessions\/([^/]+)\/messages$/u.exec(url.pathname);
      if (request.method === "POST" && interactionMessageMatch !== null) {
        const sessionId = decodeURIComponent(interactionMessageMatch[1]);
        const body = bindHumanActor(await readJsonBody(request), "requested_by", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_MESSAGE_REQUEST_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeInteractionMessageInvalid",
          message: "interaction message does not match its contract",
        });
        const priorOperation = findInteractionOperationByMessage({
          messageId: body.message_id,
          sessionId,
          sessionsPath: interactionSessionsPath,
        });
        if (priorOperation !== undefined) {
          writeJson(
            response,
            ["queued", "running", "cancel_requested"].includes(priorOperation.status) ? 202 : 200,
            priorOperation,
          );
          return;
        }
        const session = getInteractionSession({ sessionId, sessionsPath: interactionSessionsPath });
        const executionKind = session.target_kind === "trigger" ? "trigger" : "entrypoint";
        const runId = `sandbox_${compactTimestamp(new Date().toISOString())}_${randomBytes(3).toString("hex")}`;
        const runRequest = {
          schema_version: SANDBOX_RUN_REQUEST_SCHEMA_VERSION,
          execution_kind: executionKind,
          target_ref: session.target_ref,
          effect_policy: session.effect_policy,
          inputs: body.inputs,
          ...(executionKind === "trigger" ? {
            event_id: body.event_id ?? `studio-${body.message_id}`,
            source_kind: body.source_kind ?? "request",
          } : {}),
          requested_by: body.requested_by,
          reason: `client interaction ${session.session_id}`,
        };
        const operation = enqueueInteractionOperation({
          message: body,
          runId,
          sessionId,
          sessionsPath: interactionSessionsPath,
        });
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_OPERATION_SCHEMA_VERSION,
          value: operation,
          errorCode: "ToubaServeInteractionOperationInvalid",
          message: "interaction operation does not match its contract",
        });
        publishEvent(
          eventClients,
          "interaction.run.queued",
          interactionOperationEventPayload(operation),
          nextEvent,
        );
        scheduleInteractionOperation({
          operation,
          request: runRequest,
          session,
        });
        writeJson(response, 202, operation);
        return;
      }
      const interactionResumeMatch = /^\/interactions\/sessions\/([^/]+)\/resume$/u.exec(url.pathname);
      if (request.method === "POST" && interactionResumeMatch !== null) {
        const sessionId = decodeURIComponent(interactionResumeMatch[1]);
        const body = await readJsonBody(request);
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_RESUME_REQUEST_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeInteractionResumeInvalid",
          message: "interaction resume request does not match its contract",
        });
        const checkpoint = loadSandboxCheckpointStore(sandboxCheckpointsPath).records
          .find((candidate) => candidate.request_id === body.request_id);
        if (checkpoint === undefined) {
          throw serviceError(
            "ToubaServeSandboxCheckpointNotFound",
            "sandbox checkpoint request_id is unknown",
          );
        }
        const resumeValidation = validateInteractionResume({
          requestId: body.request_id,
          runId: checkpoint.run_id,
          sessionId,
          sessionsPath: interactionSessionsPath,
        });
        if (resumeValidation.alreadyRecorded) {
          writeJson(response, 200, resumeValidation.operation);
          return;
        }
        if (interactionOperationControllers.has(resumeValidation.operation.operation_id)) {
          writeJson(response, 202, resumeValidation.operation);
          return;
        }
        scheduleInteractionOperation({
          operation: resumeValidation.operation,
          request: body,
          resume: true,
          session: resumeValidation.session,
        });
        writeJson(response, 202, resumeValidation.operation);
        return;
      }
      if (request.method === "POST" && url.pathname === "/interaction-assets") {
        const buffer = await readBinaryBody(request, MAX_INTERACTION_ASSET_BYTES);
        const asset = storeInteractionAsset({
          assetsDirectory: interactionAssetsDirectory,
          assetsPath: interactionAssetsPath,
          buffer,
          contentKind: url.searchParams.get("content_kind"),
          digest: url.searchParams.get("digest") ?? undefined,
          mediaType: String(request.headers["content-type"] ?? "").split(";")[0].trim().toLowerCase(),
          name: url.searchParams.get("name"),
        });
        validateContractPayload({
          contractsRoot,
          schemaVersion: INTERACTION_ASSET_SCHEMA_VERSION,
          value: asset,
          errorCode: "ToubaServeInteractionAssetInvalid",
          message: "interaction asset does not match its contract",
        });
        writeJson(response, 201, asset);
        return;
      }
      const interactionAssetMatch = /^\/interaction-assets\/([^/]+)$/u.exec(url.pathname);
      if (request.method === "GET" && interactionAssetMatch !== null) {
        const { asset, buffer } = readInteractionAsset({
          assetsDirectory: interactionAssetsDirectory,
          assetsPath: interactionAssetsPath,
          handle: decodeURIComponent(interactionAssetMatch[1]),
        });
        response.writeHead(200, {
          "content-type": asset.media_type,
          "content-length": buffer.length,
          "content-disposition": `inline; filename="${safeHeaderFileName(asset.name)}"`,
          "x-content-type-options": "nosniff",
          etag: `"${asset.digest}"`,
        });
        response.end(buffer);
        return;
      }
      if (request.method === "GET" && url.pathname === "/trace/current") {
        writeJson(response, 200, readProjectTraceTimeline({ contractsRoot, traceTimelinePath }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/authority/graph") {
        writeJson(response, 200, buildAuthorityGraph({ projectRoot }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/identity") {
        writeJson(response, 200, readProductIdentity({ contractsRoot, productIdentityPath }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/triggers") {
        writeJson(response, 200, readProjectTriggerStatus({ contractsRoot, triggerStatusPath }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/triggers/fire") {
        const body = bindHumanActor(await readJsonBody(request), "requested_by", humanIdentity);
        const result = await executeProjectSandboxRun({
          agentDecisionProvider,
          agentDecisionProviderContentMode: options.agentDecisionProviderContentMode,
          agentDecisionProviderInitialMode: options.agentDecisionProviderInitialMode,
          agentDecisionProviderMaxRetries: options.agentDecisionProviderMaxRetries,
          agentDecisionProviderMetadata: options.agentDecisionProviderMetadata,
          agentDecisionProviderTimeoutMs: options.agentDecisionProviderTimeoutMs,
          contractsRoot,
          executionKind: "trigger",
          humanRequestsPath,
          projectRoot,
          request: body,
          runSummaryPath,
          sandboxCheckpointsPath,
          secretsPath,
          secretsRequired,
          traceTimelinePath,
        });
        publishEvent(eventClients, "trigger.fire.completed", sandboxRunEventPayload(result), nextEvent);
        writeJson(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/triggers/queue-health") {
        writeJson(response, 200, buildTriggerQueueHealth({
          contractsRoot,
          projectRoot,
          triggerStatusPath,
          eventJournalPath,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/supply-chain/status") {
        writeJson(response, 200, buildSupplyChainStatus({ projectRoot }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/governance/readiness") {
        writeJson(response, 200, buildGovernanceReadiness({
          contractsRoot,
          projectRoot,
          productIdentityPath,
          changeProposalsPath,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/deployments") {
        assertDeploymentTargetConfigured({ deploymentTargetToken, deploymentTargetUrl });
        const result = await deploymentTargetRequest({
          targetUrl: deploymentTargetUrl,
          token: deploymentTargetToken,
          path: "/revisions",
        });
        writeJson(response, 200, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/deployments/plan") {
        const body = bindHumanActor(await readJsonBody(request), "actor", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: DEPLOYMENT_ACTION_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeDeploymentInvalid",
          message: "deployment action does not match its contract",
        });
        assertDeploymentAction(body, "plan");
        writeJson(response, 200, buildProjectDeploymentPlan({
          projectRoot,
          profile: body.profile,
          targetConfigured: deploymentTargetUrl !== undefined && deploymentTargetToken !== undefined,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/deployments/publish") {
        const body = bindHumanActor(await readJsonBody(request), "actor", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: DEPLOYMENT_ACTION_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeDeploymentInvalid",
          message: "deployment action does not match its contract",
        });
        assertDeploymentAction(body, "publish");
        assertDeploymentTargetConfigured({ deploymentTargetToken, deploymentTargetUrl });
        const plan = buildProjectDeploymentPlan({
          projectRoot,
          profile: body.profile,
          targetConfigured: true,
        });
        if (plan.status !== "ready") {
          const error = serviceError("ToubaServeDeploymentBlocked", "deployment plan is blocked");
          error.diagnostics = plan.checks
            .filter((check) => check.status === "blocked")
            .map((check) => serviceDiagnostic(check.code, check.message));
          throw error;
        }
        const bundle = buildDeploymentBundle({
          projectRoot,
          profile: body.profile,
        });
        const result = await deploymentTargetRequest({
          targetUrl: deploymentTargetUrl,
          token: deploymentTargetToken,
          method: "POST",
          path: "/revisions",
          body: {
            bundle,
            published_by: body.actor,
          },
        });
        publishEvent(eventClients, "deployment.published", result, nextEvent);
        writeJson(response, 202, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/deployments/activate") {
        const body = bindHumanActor(await readJsonBody(request), "actor", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: DEPLOYMENT_ACTION_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeDeploymentInvalid",
          message: "deployment action does not match its contract",
        });
        assertDeploymentAction(body, "activate");
        assertDeploymentTargetConfigured({ deploymentTargetToken, deploymentTargetUrl });
        const revisionId = requiredNonEmptyString(body.revision_id, "revision_id");
        const result = await deploymentTargetRequest({
          targetUrl: deploymentTargetUrl,
          token: deploymentTargetToken,
          method: "POST",
          path: `/revisions/${encodeURIComponent(revisionId)}/activate`,
          body: { activated_by: body.actor },
        });
        publishEvent(eventClients, "deployment.activated", result, nextEvent);
        writeJson(response, 202, result);
        return;
      }
      if (request.method === "POST" && url.pathname === "/deployments/rollback") {
        const body = bindHumanActor(await readJsonBody(request), "actor", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: DEPLOYMENT_ACTION_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeDeploymentInvalid",
          message: "deployment action does not match its contract",
        });
        assertDeploymentAction(body, "rollback");
        assertDeploymentTargetConfigured({ deploymentTargetToken, deploymentTargetUrl });
        const result = await deploymentTargetRequest({
          targetUrl: deploymentTargetUrl,
          token: deploymentTargetToken,
          method: "POST",
          path: "/rollback",
          body: { rolled_back_by: body.actor },
        });
        publishEvent(eventClients, "deployment.rolled_back", result, nextEvent);
        writeJson(response, 202, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/approvals/pending/current") {
        writeJson(response, 200, readPendingHumanRequest({
          contractsRoot,
          humanRequestsPath,
          humanDecisionsPath,
          kind: "approval",
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/reviews/pending/current") {
        writeJson(response, 200, readPendingHumanRequest({
          contractsRoot,
          humanRequestsPath,
          humanDecisionsPath,
          kind: "human_review",
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/budgets/costs") {
        writeJson(response, 200, readCostObservatory({
          contractsRoot,
          costObservatoryPath,
          projectRoot,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/runtime/sandbox") {
        writeJson(response, 200, buildHandlerSandboxStatus({
          contractsRoot,
          projectRoot,
          handlerSandboxStatusPath,
          generatedAt: new Date().toISOString(),
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/mobile/notifications") {
        writeJson(response, 200, readMobileNotifications({
          contractsRoot,
          mobileNotificationsPath,
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/mobile/pairings/request") {
        const body = bindHumanActor(
          await readOptionalJsonBody(request),
          "user_ref",
          humanIdentity,
        );
        const issued = issueMobilePairingRequest({
          contractsRoot,
          mobilePairingsPath,
          serverUrl: `http://${request.headers.host ?? `${host}:${port}`}`,
          request: body,
        });
        publishEvent(eventClients, "mobile_pairing.issued", mobilePairingEventPayload(issued), nextEvent);
        writeJson(response, 201, issued);
        return;
      }
      if (request.method === "POST" && url.pathname === "/mobile/pairings/accept") {
        const body = await readJsonBody(request);
        const accepted = acceptMobilePairing({
          contractsRoot,
          mobilePairingsPath,
          pairingRequest: body,
        });
        publishEvent(eventClients, "mobile_pairing.accepted", accepted, nextEvent);
        writeJson(response, 202, accepted);
        return;
      }
      if (request.method === "POST" && url.pathname === "/mobile/pairings/revoke") {
        const body = bindHumanActor(await readJsonBody(request), "revoked_by", humanIdentity);
        const revoked = revokeMobilePairing({
          mobilePairingsPath,
          deviceRef: body?.device_ref,
          pairingId: body?.pairing_id,
          revokedBy: body?.revoked_by,
          reason: body?.reason,
        });
        publishEvent(eventClients, "mobile_pairing.revoked", revoked, nextEvent);
        writeJson(response, 202, revoked);
        return;
      }
      if (request.method === "GET" && url.pathname === "/mobile/quick-approval-policy") {
        writeJson(response, 200, readMobileQuickApprovalPolicy({
          contractsRoot,
          mobileQuickApprovalPolicyPath,
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/mobile/escalations") {
        writeJson(response, 200, readMobileEscalation({
          contractsRoot,
          mobileEscalationPath,
        }));
        return;
      }
      if (request.method === "GET" && Object.hasOwn(LIVE_ENDPOINT_CONTRACTS, url.pathname)) {
        writeJson(response, 200, readContractFixture({
          contractsRoot,
          schemaVersion: LIVE_ENDPOINT_CONTRACTS[url.pathname],
        }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/contracts") {
        writeJson(response, 200, buildContractIndex({ contractsRoot }));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/contracts/")) {
        const schemaVersion = decodeURIComponent(url.pathname.slice("/contracts/".length));
        const contract = readContractFixture({ contractsRoot, schemaVersion });
        writeJson(response, 200, contract);
        return;
      }
      if (request.method === "POST" && url.pathname === "/decisions") {
        const body = await readJsonBody(request);
        const accepted = acceptDecision({
          contractsRoot,
          humanDecisionsPath,
          humanRequestsPath,
          productIdentityPath,
          decision: body,
          requireProjectAuthorization: true,
        });
        publishEvent(eventClients, "human_decision.accepted", accepted, nextEvent);
        writeJson(response, 202, accepted);
        return;
      }
      if (request.method === "POST" && url.pathname === "/runs/sandbox/resume") {
        const body = await readJsonBody(request);
        const result = await resumeProjectSandboxRun({
          agentDecisionProvider,
          agentDecisionProviderContentMode: options.agentDecisionProviderContentMode,
          agentDecisionProviderInitialMode: options.agentDecisionProviderInitialMode,
          agentDecisionProviderMaxRetries: options.agentDecisionProviderMaxRetries,
          agentDecisionProviderMetadata: options.agentDecisionProviderMetadata,
          agentDecisionProviderTimeoutMs: options.agentDecisionProviderTimeoutMs,
          contractsRoot,
          humanDecisionsPath,
          humanRequestsPath,
          projectRoot,
          request: body,
          runSummaryPath,
          sandboxCheckpointsPath,
          secretsPath,
          secretsRequired,
          traceTimelinePath,
        });
        publishEvent(eventClients, "sandbox_run.resumed", sandboxRunEventPayload(result), nextEvent);
        writeJson(response, 200, result);
        return;
      }
      if (request.method === "GET" && url.pathname === "/decisions") {
        writeJson(response, 200, listHumanDecisions({ humanDecisionsPath }));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/decisions/")) {
        const [schemaVersion, requestId] = decodeDecisionPath(url.pathname);
        writeJson(response, 200, getHumanDecisionDetail({ humanDecisionsPath, schemaVersion, requestId }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/changes") {
        writeJson(response, 200, listProjectChanges({ projectRoot, changeProposalsPath }));
        return;
      }
      if (request.method === "GET" && url.pathname.startsWith("/changes/")) {
        const proposalId = decodeURIComponent(url.pathname.slice("/changes/".length));
        writeJson(response, 200, getProjectChangeDetail({ projectRoot, changeProposalsPath, proposalId }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/project/refresh") {
        const body = bindHumanActor(await readOptionalJsonBody(request), "requested_by", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: PROJECT_REFRESH_REQUEST_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeRefreshInvalid",
          message: "refresh request payload does not match its contract",
        });
        const refreshed = refreshProject({
          projectRoot,
          previousSnapshot: projectSnapshot,
          request: body,
        });
        projectSnapshot = refreshed.snapshot;
        publishRefreshEvents(eventClients, refreshed.report, nextEvent);
        writeJson(response, 202, refreshed.report);
        return;
      }
      if (request.method === "POST" && url.pathname === "/changes/propose") {
        const body = bindHumanActor(await readJsonBody(request), "requested_by", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: CHANGE_PROPOSAL_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeChangeInvalid",
          message: "change proposal payload does not match its contract",
        });
        const proposed = proposeProjectChange({
          projectRoot,
          changeProposalsPath,
          proposal: body,
        });
        publishEvent(eventClients, "change.proposed", proposed, nextEvent);
        writeJson(response, 202, proposed);
        return;
      }
      if (request.method === "POST" && url.pathname === "/governance/relations/propose") {
        const body = bindHumanActor(await readJsonBody(request), "requested_by", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: GOVERNANCE_RELATION_CHANGE_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeGovernanceRelationInvalid",
          message: "governance relation change does not match its contract",
        });
        const proposed = proposeGovernanceRelationChange({
          projectRoot,
          changeProposalsPath,
          request: body,
        });
        publishEvent(eventClients, "change.proposed", proposed, nextEvent);
        writeJson(response, 202, proposed);
        return;
      }
      if (request.method === "POST" && url.pathname === "/elements/propose") {
        const body = bindHumanActor(await readJsonBody(request), "requested_by", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: ELEMENT_AUTHORING_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeElementAuthoringInvalid",
          message: "element authoring request does not match its contract",
        });
        const draft = buildElementAuthoringChangeSet({
          projectRoot,
          request: body,
        });
        const proposed = draft.changes.length === 1
          ? proposeProjectChange({
              projectRoot,
              changeProposalsPath,
              proposal: {
                schema_version: CHANGE_PROPOSAL_SCHEMA_VERSION,
                proposal_id: draft.proposal_id,
                action: "write_text_file",
                target: { path: draft.changes[0].path },
                requested_by: draft.requested_by,
                reason: draft.reason,
                content: draft.changes[0].content,
              },
            })
          : proposeProjectChangeSet({
              projectRoot,
              changeProposalsPath,
              changeSet: draft,
            });
        publishEvent(eventClients, "element.proposed", {
          ...proposed,
          element_ref: draft.element_ref,
        }, nextEvent);
        writeJson(response, 202, proposed);
        return;
      }
      if (request.method === "POST" && url.pathname === "/changes/apply") {
        const body = bindHumanActor(await readJsonBody(request), "decided_by", humanIdentity);
        validateContractPayload({
          contractsRoot,
          schemaVersion: CHANGE_APPLY_SCHEMA_VERSION,
          value: body,
          errorCode: "ToubaServeChangeApplyInvalid",
          message: "change apply payload does not match its contract",
        });
        const result = applyProjectChange({
          projectRoot,
          changeProposalsPath,
          applyRequest: body,
        });
        publishEvent(eventClients, result.status === "applied" ? "change.applied" : "change.refused", result, nextEvent);
        if (result.status === "applied") {
          const refreshed = refreshProject({
            projectRoot,
            previousSnapshot: projectSnapshot,
            request: {
              schema_version: PROJECT_REFRESH_REQUEST_SCHEMA_VERSION,
              reason: `change:${result.proposal_id}`,
            },
          });
          projectSnapshot = refreshed.snapshot;
          publishRefreshEvents(eventClients, refreshed.report, nextEvent);
        }
        writeJson(response, 202, result);
        return;
      }
      writeJson(response, 404, { status: "error", code: "ToubaServeRouteNotFound" });
    } catch (error) {
      writeJson(response, httpStatusForError(error.code), {
        status: "error",
        code: error.code ?? "ToubaServeRequestFailed",
        message: error.message,
        diagnostics: Array.isArray(error.diagnostics) ? error.diagnostics : undefined,
      });
    }
  });

  return {
    async start() {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectListen(normalizeListenError(error, { host, port }));
        };
        const onListening = () => {
          server.off("error", onError);
          resolveListen();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(port, host);
      });
      const address = server.address();
      if (options.quiet !== true) {
        process.stdout.write(`${JSON.stringify({
          event: "touba_project_server_started",
          host,
          port: address.port,
          project_root: projectRoot,
          contracts_root: contractsRoot,
          human_decisions: humanDecisionsPath ?? null,
          change_proposals: changeProposalsPath,
          event_journal: eventJournalPath,
          event_journal_limit: eventJournalLimit,
          run_summary: runSummaryPath,
          trace_timeline: traceTimelinePath,
          trigger_status: triggerStatusPath,
          human_requests: humanRequestsPath,
          mobile_pairings: mobilePairingsPath,
          product_identity: productIdentityPath,
          event_stream: `http://${host}:${address.port}/events`,
        })}\n`);
      }
    },
    async stop() {
      for (const controller of interactionOperationControllers.values()) {
        controller.cancelRequested = true;
      }
      await Promise.allSettled([...interactionOperationTasks]);
      for (const client of eventClients) {
        client.end();
      }
      eventClients.clear();
      if (!server.listening) {
        return;
      }
      await new Promise((resolveClose, rejectClose) => {
        server.close((error) => error ? rejectClose(error) : resolveClose());
      });
    },
    server,
  };
}

export function buildContractIndex({ contractsRoot, generatedAt = new Date().toISOString() }) {
  return {
    schema_version: CONTRACT_INDEX_SCHEMA_VERSION,
    generated_at: generatedAt,
    contracts: PRODUCT_SURFACE_CONTRACTS.map((schemaVersion) => ({
      schema_version: schemaVersion,
      status: contractFilesExist({ contractsRoot, schemaVersion }) ? "available" : "missing",
      endpoint: `/contracts/${encodeURIComponent(schemaVersion)}`,
    })),
  };
}

export function buildLiveState({
  contractsRoot,
  projectRoot = process.cwd(),
  projectSnapshot = buildProjectSnapshot({ projectRoot }),
  runSummaryPath = join(projectRoot, DEFAULT_RUN_SUMMARY_PATH),
  traceTimelinePath = join(projectRoot, DEFAULT_TRACE_TIMELINE_PATH),
  triggerStatusPath = join(projectRoot, DEFAULT_TRIGGER_STATUS_PATH),
  humanRequestsPath = join(projectRoot, DEFAULT_HUMAN_REQUESTS_PATH),
  humanDecisionsPath = join(projectRoot, DEFAULT_HUMAN_DECISIONS_PATH),
  productIdentityPath = join(projectRoot, DEFAULT_PRODUCT_IDENTITY_PATH),
  costObservatoryPath = join(projectRoot, DEFAULT_COST_OBSERVATORY_PATH),
  handlerSandboxStatusPath = join(projectRoot, DEFAULT_HANDLER_SANDBOX_STATUS_PATH),
  mobileNotificationsPath = join(projectRoot, DEFAULT_MOBILE_NOTIFICATIONS_PATH),
  mobileQuickApprovalPolicyPath = join(projectRoot, DEFAULT_MOBILE_QUICK_APPROVAL_POLICY_PATH),
  mobileEscalationPath = join(projectRoot, DEFAULT_MOBILE_ESCALATION_PATH),
  changeProposalsPath = join(projectRoot, DEFAULT_CHANGE_PROPOSALS_PATH),
  eventJournalPath = join(projectRoot, DEFAULT_EVENT_JOURNAL_PATH),
  generatedAt = new Date().toISOString(),
}) {
  return {
    schema_version: LIVE_STATE_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_server: {
      project_root: projectRoot,
      refresh: projectSnapshot.report,
    },
    project: buildProjectInspection({ projectRoot, projectSnapshot, generatedAt }),
    authority_graph: buildAuthorityGraph({ projectRoot, generatedAt }),
    identity: readProductIdentity({ contractsRoot, productIdentityPath, generatedAt }),
    current_run: readProjectRunSummary({ contractsRoot, runSummaryPath }),
    trace_timeline: readProjectTraceTimeline({ contractsRoot, traceTimelinePath }),
    trigger_status: readProjectTriggerStatus({ contractsRoot, triggerStatusPath }),
    trigger_queue_health: buildTriggerQueueHealth({
      contractsRoot,
      projectRoot,
      triggerStatusPath,
      eventJournalPath,
      generatedAt,
    }),
    supply_chain_status: buildSupplyChainStatus({ projectRoot, generatedAt }),
    governance_readiness: buildGovernanceReadiness({
      contractsRoot,
      projectRoot,
      productIdentityPath,
      changeProposalsPath,
      generatedAt,
    }),
    cost_observatory: readCostObservatory({
      contractsRoot,
      costObservatoryPath,
      generatedAt,
      projectRoot,
    }),
    handler_sandbox_status: buildHandlerSandboxStatus({
      contractsRoot,
      projectRoot,
      handlerSandboxStatusPath,
      generatedAt,
    }),
    mobile_notifications: readMobileNotifications({
      contractsRoot,
      mobileNotificationsPath,
      generatedAt,
    }),
    mobile_quick_approval_policy: readMobileQuickApprovalPolicy({
      contractsRoot,
      mobileQuickApprovalPolicyPath,
    }),
    mobile_escalation: readMobileEscalation({ contractsRoot, mobileEscalationPath }),
    pending_approval: optionalPendingHumanRequest({
      contractsRoot,
      humanRequestsPath,
      humanDecisionsPath,
      kind: "approval",
    }),
    pending_review: optionalPendingHumanRequest({
      contractsRoot,
      humanRequestsPath,
      humanDecisionsPath,
      kind: "human_review",
    }),
    featured_resource: null,
    alert: null,
    events: {
      schema_version: EVENT_STREAM_SCHEMA_VERSION,
      endpoint: "/events",
      transport: "server_sent_events",
      event_schema_version: PROJECT_EVENT_SCHEMA_VERSION,
      replay: {
        request_header: "Last-Event-ID",
        event_id_field: "event_id",
        retention: "bounded_journal",
      },
    },
  };
}

export function buildProjectEvent({
  type,
  payload,
  sequence,
  emittedAt = new Date().toISOString(),
}) {
  if (!Number.isInteger(sequence) || sequence < 1) {
    throw serviceError("ToubaServeEventSequenceInvalid", "event sequence must be a positive integer");
  }
  return {
    schema_version: PROJECT_EVENT_SCHEMA_VERSION,
    event_id: `evt_${String(sequence).padStart(6, "0")}`,
    sequence,
    type: requiredNonEmptyString(type, "type"),
    source: "touba-project-server",
    emitted_at: emittedAt,
    payload: isPlainObject(payload) ? payload : { value: payload },
  };
}

export function preflightServeOptions({
  contractsRoot,
  projectRoot = process.cwd(),
  humanDecisionsPath,
  changeProposalsPath = join(projectRoot, DEFAULT_CHANGE_PROPOSALS_PATH),
  eventJournalPath = join(projectRoot, DEFAULT_EVENT_JOURNAL_PATH),
  runSummaryPath = join(projectRoot, DEFAULT_RUN_SUMMARY_PATH),
  traceTimelinePath = join(projectRoot, DEFAULT_TRACE_TIMELINE_PATH),
  triggerStatusPath = join(projectRoot, DEFAULT_TRIGGER_STATUS_PATH),
  humanRequestsPath = join(projectRoot, DEFAULT_HUMAN_REQUESTS_PATH),
  sandboxCheckpointsPath = join(projectRoot, DEFAULT_SANDBOX_CHECKPOINTS_PATH),
  productIdentityPath = join(projectRoot, DEFAULT_PRODUCT_IDENTITY_PATH),
  mobilePairingsPath = join(projectRoot, DEFAULT_MOBILE_PAIRINGS_PATH),
  interactionSessionsPath = join(projectRoot, DEFAULT_INTERACTION_SESSIONS_PATH),
  interactionAssetsPath = join(projectRoot, DEFAULT_INTERACTION_ASSETS_PATH),
  interactionAssetsDirectory = join(projectRoot, DEFAULT_INTERACTION_ASSETS_DIRECTORY),
  eventJournalLimit = DEFAULT_EVENT_JOURNAL_LIMIT,
  strict = false,
}) {
  const diagnostics = [];
  if (!existsSync(contractsRoot)) {
    diagnostics.push(serviceDiagnostic("ToubaServeContractsRootMissing", `${contractsRoot} does not exist`));
  } else if (!statSync(contractsRoot).isDirectory()) {
    diagnostics.push(serviceDiagnostic("ToubaServeContractsRootInvalid", `${contractsRoot} is not a directory`));
  }
  if (!existsSync(projectRoot)) {
    diagnostics.push(serviceDiagnostic("ToubaServeProjectRootMissing", `${projectRoot} does not exist`));
  } else if (!statSync(projectRoot).isDirectory()) {
    diagnostics.push(serviceDiagnostic("ToubaServeProjectRootInvalid", `${projectRoot} is not a directory`));
  }
  if (existsSync(humanDecisionsPath) && statSync(humanDecisionsPath).isDirectory()) {
    diagnostics.push(serviceDiagnostic("ToubaServeHumanDecisionStoreInvalid", `${humanDecisionsPath} is a directory`));
  }
  if (!isPathInside(projectRoot, changeProposalsPath)) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeStoreOutsideProject", "change proposal store must stay inside the project root"));
  } else if (existsSync(changeProposalsPath) && statSync(changeProposalsPath).isDirectory()) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeStoreInvalid", `${changeProposalsPath} is a directory`));
  }
  if (!Number.isInteger(eventJournalLimit) || eventJournalLimit < 1 || eventJournalLimit > 10000) {
    diagnostics.push(serviceDiagnostic("ToubaServeEventJournalLimitInvalid", "event journal limit must be an integer between 1 and 10000"));
  }
  if (!isPathInside(projectRoot, eventJournalPath)) {
    diagnostics.push(serviceDiagnostic("ToubaServeEventJournalOutsideProject", "event journal must stay inside the project root"));
  } else if (existsSync(eventJournalPath) && statSync(eventJournalPath).isDirectory()) {
    diagnostics.push(serviceDiagnostic("ToubaServeEventJournalInvalid", `${eventJournalPath} is a directory`));
  }
  for (const [code, label, filePath] of [
    ["ToubaServeRunSummaryPathInvalid", "run summary", runSummaryPath],
    ["ToubaServeTraceTimelinePathInvalid", "trace timeline", traceTimelinePath],
    ["ToubaServeTriggerStatusPathInvalid", "trigger status", triggerStatusPath],
    ["ToubaServeHumanRequestsPathInvalid", "human request store", humanRequestsPath],
    ["ToubaServeSandboxCheckpointPathInvalid", "sandbox checkpoint store", sandboxCheckpointsPath],
    ["ToubaServeProductIdentityPathInvalid", "product identity", productIdentityPath],
    ["ToubaServeMobilePairingsPathInvalid", "mobile pairing store", mobilePairingsPath],
    ["ToubaServeInteractionSessionStoreInvalid", "interaction session store", interactionSessionsPath],
    ["ToubaServeInteractionAssetStoreInvalid", "interaction asset store", interactionAssetsPath],
  ]) {
    if (!isPathInside(projectRoot, filePath)) {
      diagnostics.push(serviceDiagnostic(code, `${label} path must stay inside the project root`));
    } else if (existsSync(filePath) && statSync(filePath).isDirectory()) {
      diagnostics.push(serviceDiagnostic(code, `${filePath} is a directory`));
    }
  }
  if (!isPathInside(projectRoot, interactionAssetsDirectory)) {
    diagnostics.push(serviceDiagnostic(
      "ToubaServeInteractionAssetPathInvalid",
      "interaction asset directory must stay inside the project root",
    ));
  } else if (existsSync(interactionAssetsDirectory) && !statSync(interactionAssetsDirectory).isDirectory()) {
    diagnostics.push(serviceDiagnostic(
      "ToubaServeInteractionAssetPathInvalid",
      `${interactionAssetsDirectory} is not a directory`,
    ));
  }
  for (const schemaVersion of PRODUCT_SURFACE_CONTRACTS) {
    if (!contractFilesExist({ contractsRoot, schemaVersion })) {
      diagnostics.push(serviceDiagnostic("ToubaServeContractMissing", `${schemaVersion} schema or fixture is missing`));
    }
  }
  if (strict && diagnostics.length > 0) {
    const error = serviceError("ToubaServePreflightFailed", "touba serve preflight failed");
    error.diagnostics = diagnostics;
    throw error;
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "ToubaServeContractsRootMissing" || diagnostic.code === "ToubaServeContractsRootInvalid")) {
    const error = serviceError("ToubaServePreflightFailed", "touba serve cannot start without a valid contracts root");
    error.diagnostics = diagnostics;
    throw error;
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "ToubaServeProjectRootMissing" || diagnostic.code === "ToubaServeProjectRootInvalid")) {
    const error = serviceError("ToubaServePreflightFailed", "touba serve cannot start without a valid project root");
    error.diagnostics = diagnostics;
    throw error;
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "ToubaServeHumanDecisionStoreInvalid")) {
    const error = serviceError("ToubaServePreflightFailed", "touba serve cannot use a directory as decision store");
    error.diagnostics = diagnostics;
    throw error;
  }
  if (diagnostics.some((diagnostic) => diagnostic.code === "ToubaServeChangeStoreOutsideProject" || diagnostic.code === "ToubaServeChangeStoreInvalid")) {
    const error = serviceError("ToubaServePreflightFailed", "touba serve cannot use the configured client change proposal store");
    error.diagnostics = diagnostics;
    throw error;
  }
  if (diagnostics.some((diagnostic) =>
    diagnostic.code === "ToubaServeEventJournalLimitInvalid"
    || diagnostic.code === "ToubaServeEventJournalOutsideProject"
    || diagnostic.code === "ToubaServeEventJournalInvalid"
  )) {
    const error = serviceError("ToubaServePreflightFailed", "touba serve cannot use the configured event journal");
    error.diagnostics = diagnostics;
    throw error;
  }
  if (diagnostics.some((diagnostic) =>
    diagnostic.code === "ToubaServeRunSummaryPathInvalid"
    || diagnostic.code === "ToubaServeTraceTimelinePathInvalid"
    || diagnostic.code === "ToubaServeTriggerStatusPathInvalid"
    || diagnostic.code === "ToubaServeHumanRequestsPathInvalid"
    || diagnostic.code === "ToubaServeProductIdentityPathInvalid"
    || diagnostic.code === "ToubaServeMobilePairingsPathInvalid"
  )) {
    const error = serviceError("ToubaServePreflightFailed", "touba serve cannot use the configured project data paths");
    error.diagnostics = diagnostics;
    throw error;
  }
  return {
    schema_version: "touba-serve-preflight-v0.1",
    status: diagnostics.length === 0 ? "ok" : "warning",
    diagnostics,
  };
}

export function acceptDecision({
  contractsRoot,
  humanDecisionsPath,
  humanRequestsPath,
  productIdentityPath,
  decision,
  acceptedAt = new Date().toISOString(),
  requireProjectAuthorization = false,
}) {
  const schemaVersion = decision?.schema_version;
  if (!ACCEPTED_DECISION_CONTRACTS.includes(schemaVersion)) {
    throw serviceError("ToubaServeDecisionContractUnsupported", "decision schema_version is not accepted by this service");
  }
  const schema = readContractSchema({ contractsRoot, schemaVersion });
  const diagnostics = validateObject(schema, decision);
  if (diagnostics.length > 0) {
    const error = serviceError("ToubaServeDecisionInvalid", "decision payload does not match its contract");
    error.diagnostics = diagnostics;
    throw error;
  }
  if (requireProjectAuthorization) {
    assertProjectDecisionAuthorized({
      acceptedAt,
      contractsRoot,
      decision,
      humanRequestsPath,
      productIdentityPath,
    });
  }
  const store = loadHumanDecisionStore(humanDecisionsPath);
  const duplicate = store.decisions.some((item) =>
    item.schema_version === schemaVersion && item.request_id === decision.request_id
  );
  if (duplicate) {
    throw serviceError("ToubaServeDecisionReplayRejected", "decision for this request_id and schema_version is already stored");
  }
  const storedDecision = {
    ...decision,
    accepted_at: acceptedAt,
  };
  store.decisions.push(storedDecision);
  saveHumanDecisionStore(humanDecisionsPath, store);
  return {
    schema_version: "touba-decision-accepted-v0.1",
    status: "accepted",
    request_id: decision.request_id,
    decision_schema_version: schemaVersion,
    accepted_at: acceptedAt,
  };
}

function assertProjectDecisionAuthorized({
  acceptedAt,
  contractsRoot,
  decision,
  humanRequestsPath,
  productIdentityPath,
}) {
  if (!humanRequestsPath || !existsSync(humanRequestsPath)) {
    throw serviceError("ToubaServeDecisionRequestNotFound", "decision does not match a pending project request");
  }
  const requestStore = readHumanRequestStore(humanRequestsPath);
  const isReview = decision.schema_version === "touba-human-review-decision-v1";
  const requests = isReview ? requestStore.reviews : requestStore.approvals;
  const pendingRequest = requests.find((request) => request.request_id === decision.request_id);
  if (!pendingRequest) {
    throw serviceError("ToubaServeDecisionRequestNotFound", "decision does not match a pending project request");
  }
  const expectedRequestSchema = isReview ? "touba-human-review-request-v1" : "touba-approval-request-v1";
  const result = isReview ? decision.outcome : decision.decision;
  const allowedResults = isReview ? pendingRequest.allowed_outcomes : pendingRequest.allowed_decisions;
  if (
    pendingRequest.schema_version !== expectedRequestSchema
    || pendingRequest.run_id !== decision.run_id
    || pendingRequest.trace_ref !== decision.trace_ref
    || !allowedResults.includes(result)
  ) {
    throw serviceError("ToubaServeDecisionRequestMismatch", "decision does not match the pending request contract");
  }
  if (Date.parse(pendingRequest.expires_at) <= Date.parse(acceptedAt)) {
    throw serviceError("ToubaServeDecisionRequestExpired", "pending human request has expired");
  }

  const identity = readProductIdentity({ contractsRoot, productIdentityPath, generatedAt: acceptedAt });
  const user = identity.users.find((candidate) => candidate.user_ref === decision.user_ref && candidate.status === "active");
  const device = identity.devices.find((candidate) =>
    candidate.device_ref === decision.device_ref
    && candidate.user_ref === decision.user_ref
    && candidate.status === "paired"
  );
  const signerRef = isReview ? decision.reviewed_by : decision.decided_by;
  if (!user || !device || signerRef !== decision.user_ref) {
    throw serviceError("ToubaServeDecisionIdentityUnauthorized", "decision signer is not an active paired project identity");
  }
  const assigned = identity.assignments.some((assignment) =>
    assignment.request_id === decision.request_id
    && assignment.user_ref === decision.user_ref
    && assignment.device_ref === decision.device_ref
    && ["assigned", "accepted"].includes(assignment.status)
  );
  const roleScopes = new Set(identity.roles
    .filter((role) => user.role_refs.includes(role.role_ref))
    .map((role) => role.scope));
  if (!assigned && !roleScopes.has("human_decision")) {
    throw serviceError("ToubaServeDecisionIdentityUnauthorized", "decision signer lacks a human-decision assignment or role");
  }
}

export function listHumanDecisions({
  humanDecisionsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadHumanDecisionStore(humanDecisionsPath);
  const decisions = store.decisions
    .map(projectHumanDecision)
    .sort((left, right) => right.accepted_at.localeCompare(left.accepted_at));
  return {
    schema_version: HUMAN_DECISION_HISTORY_SCHEMA_VERSION,
    generated_at: generatedAt,
    summary: {
      total: decisions.length,
      approvals: decisions.filter((item) => item.decision_kind === "approval").length,
      reviews: decisions.filter((item) => item.decision_kind === "human_review").length,
    },
    decisions,
  };
}

export function getHumanDecisionDetail({
  humanDecisionsPath,
  schemaVersion,
  requestId,
  generatedAt = new Date().toISOString(),
}) {
  if (!ACCEPTED_DECISION_CONTRACTS.includes(schemaVersion)) {
    throw serviceError("ToubaServeDecisionContractUnsupported", "decision schema_version is not accepted by this service");
  }
  const id = requiredNonEmptyString(requestId, "request_id");
  const store = loadHumanDecisionStore(humanDecisionsPath);
  const decision = store.decisions.find((item) =>
    item.schema_version === schemaVersion && item.request_id === id
  );
  if (decision === undefined) {
    throw serviceError("ToubaServeDecisionNotFound", "decision request_id is unknown");
  }
  return {
    schema_version: HUMAN_DECISION_DETAIL_SCHEMA_VERSION,
    generated_at: generatedAt,
    decision: projectHumanDecision(decision),
  };
}

export function readProjectRunSummary({ contractsRoot, runSummaryPath }) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: runSummaryPath,
    schemaVersion: "touba-run-summary-v1",
    errorCode: "ToubaServeRunSummaryInvalid",
    message: "project run summary does not match touba-run-summary-v1",
  });
  return stored ?? unavailableRunSummary();
}

export function readProjectTraceTimeline({ contractsRoot, traceTimelinePath }) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: traceTimelinePath,
    schemaVersion: "touba-trace-timeline-v1",
    errorCode: "ToubaServeTraceTimelineInvalid",
    message: "project trace timeline does not match touba-trace-timeline-v1",
  });
  return stored ?? emptyTraceTimeline();
}

export function readProjectTriggerStatus({
  contractsRoot,
  triggerStatusPath,
  generatedAt = new Date().toISOString(),
}) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: triggerStatusPath,
    schemaVersion: "touba-trigger-status-v1",
    errorCode: "ToubaServeTriggerStatusInvalid",
    message: "project trigger status does not match touba-trigger-status-v1",
  });
  return stored ?? {
    schema_version: "touba-trigger-status-v1",
    generated_at: generatedAt,
    triggers: [],
  };
}

export async function executeProjectSandboxRun({
  agentDecisionProvider,
  agentDecisionProviderContentMode,
  agentDecisionProviderInitialMode,
  agentDecisionProviderMaxRetries,
  agentDecisionProviderMetadata,
  agentDecisionProviderTimeoutMs,
  contractsRoot,
  cancelRequestedProvider,
  executionKind,
  humanRequestsPath = join(projectRoot, DEFAULT_HUMAN_REQUESTS_PATH),
  projectRoot,
  request,
  runId: requestedRunId,
  runSummaryPath,
  sandboxCheckpointsPath = join(projectRoot, DEFAULT_SANDBOX_CHECKPOINTS_PATH),
  secretsPath = join(projectRoot, DEFAULT_DEV_SECRETS_PROFILE_PATH),
  secretsRequired = false,
  traceTimelinePath,
  traceEventObserver,
  generatedAt = new Date().toISOString(),
}) {
  validateContractPayload({
    contractsRoot,
    schemaVersion: SANDBOX_RUN_REQUEST_SCHEMA_VERSION,
    value: request,
    errorCode: "ToubaServeSandboxInvalid",
    message: "sandbox run request does not match touba-sandbox-run-request-v0.1",
  });
  if (request.execution_kind !== executionKind) {
    throw serviceError("ToubaServeSandboxInvalid", `sandbox route expects execution_kind ${executionKind}`);
  }
  const targetRef = requiredNonEmptyString(request.target_ref, "target_ref");
  const effectPolicy = request.effect_policy;
  const resolved = resolveSandboxAirDocument({ projectRoot, targetRef });
  const targetExecutionRef = executionKind === "trigger"
    ? sandboxTriggerTargetRef(resolved.document, targetRef)
    : targetRef;
  if (effectPolicy === "runtime_only" && targetMayDispatchExternalTool(resolved.document, targetExecutionRef)) {
    throw serviceError(
      "ToubaServeSandboxExternalEffectsRejected",
      "sandbox runtime_only runs refuse targets that may dispatch external tools",
    );
  }

  const startedAt = generatedAt;
  const startedMs = Date.now();
  const runId = requestedRunId
    ?? `sandbox_${compactTimestamp(startedAt)}_${randomBytes(3).toString("hex")}`;
  const toolBindingManifest = loadOptionalProjectManifest({ projectRoot });
  const secretStore = loadOptionalProjectSecretStore({
    projectRoot,
    required: secretsRequired,
    secretsPath,
  });
  let runtimeResult;
  try {
    runtimeResult = executionKind === "trigger"
      ? await executeTriggerEvent(resolved.document, {
        trigger_ref: targetRef,
        event_id: nonEmptyString(request.event_id) ?? `sandbox-event-${runId}`,
        source_kind: nonEmptyString(request.source_kind) ?? sandboxTriggerSourceKind(resolved.document, targetRef),
        arguments: isPlainObject(request.inputs) ? request.inputs : {},
      }, {
        agentDecisionProvider,
        agentDecisionProviderContentMode,
        agentDecisionProviderInitialMode,
        agentDecisionProviderMaxRetries,
        agentDecisionProviderMetadata,
        agentDecisionProviderTimeoutMs,
        cancelRequestedProvider,
        durableHumanApprovals: true,
        runId,
        secretStore,
        toolBindingManifest,
        traceEventObserver,
      })
      : await executeAirDocument(resolved.document, {
        agentDecisionProvider,
        agentDecisionProviderContentMode,
        agentDecisionProviderInitialMode,
        agentDecisionProviderMaxRetries,
        agentDecisionProviderMetadata,
        agentDecisionProviderTimeoutMs,
        cancelRequestedProvider,
        durableHumanApprovals: true,
        entryRef: targetRef,
        inputs: isPlainObject(request.inputs) ? request.inputs : {},
        runId,
        secretStore,
        toolBindingManifest,
        traceEventObserver,
      });
  } catch (cause) {
    if (cause instanceof ToubaRuntimeError) {
      const error = serviceError("ToubaServeSandboxRuntimeRejected", cause.message);
      error.diagnostics = [serviceDiagnostic(cause.code ?? "ToubaRuntimeError", cause.message, "error", resolved.relativePath)];
      throw error;
    }
    throw cause;
  }

  const completedAt = new Date().toISOString();
  const result = buildSandboxRunResult({
    completedAt,
    effectPolicy,
    executionKind,
    runId,
    runtimeResult,
    startedAt,
    startedMs,
    targetRef,
  });
  if (runtimeResult.checkpoint) {
    persistSandboxCheckpoint({
      checkpoint: runtimeResult.checkpoint,
      contractsRoot,
      createdAt: completedAt,
      effectPolicy,
      executionKind,
      humanRequestsPath,
      result,
      sandboxCheckpointsPath,
      targetRef,
    });
  }
  validateContractPayload({
    contractsRoot,
    schemaVersion: SANDBOX_RUN_RESULT_SCHEMA_VERSION,
    value: result,
    errorCode: "ToubaServeSandboxResultInvalid",
    message: "sandbox run result does not match touba-sandbox-run-result-v0.1",
  });
  persistSandboxCurrentSurfaces({
    contractsRoot,
    result,
    runSummaryPath,
    runtimeResult,
    traceTimelinePath,
  });
  return result;
}

function buildSandboxRunResult({
  completedAt,
  effectPolicy,
  executionKind,
  runId,
  runtimeResult,
  startedAt,
  startedMs,
  targetRef,
}) {
  return {
    schema_version: SANDBOX_RUN_RESULT_SCHEMA_VERSION,
    run_id: runId,
    execution_kind: executionKind,
    target_ref: targetRef,
    status: runtimeResult.status,
    started_at: startedAt,
    completed_at: completedAt,
    duration_ms: Math.max(0, Date.now() - startedMs),
    effect_policy: effectPolicy,
    result: runtimeResult.result ?? null,
    trace: sandboxTraceSummary(runtimeResult.trace),
    diagnostics: [sandboxRunDiagnostic(runtimeResult, executionKind)],
  };
}

function sandboxRunDiagnostic(runtimeResult, executionKind) {
  if (runtimeResult.status === "success") {
    return serviceDiagnostic("ToubaSandboxRunCompleted", `sandbox ${executionKind} run completed`, "info");
  }
  if (runtimeResult.status === "stopped" && runtimeResult.checkpoint) {
    return serviceDiagnostic(
      "ToubaSandboxRunAwaitingHumanDecision",
      `sandbox ${executionKind} run is paused at a durable human decision checkpoint`,
      "warning",
    );
  }
  const runtimeFailure = [...(runtimeResult.trace?.events ?? [])]
    .reverse()
    .find((event) => (event.kind ?? event.type) === "failure_detected");
  if (runtimeFailure) {
    return serviceDiagnostic(
      runtimeFailure.payload?.runtime_error_code ?? "ToubaSandboxRuntimeFailure",
      runtimeFailure.message ?? `sandbox ${executionKind} run failed`,
      "error",
    );
  }
  return serviceDiagnostic(
    "ToubaSandboxRunFinishedWithStatus",
    `sandbox ${executionKind} run finished with status ${runtimeResult.status}`,
    "warning",
  );
}

export async function resumeProjectSandboxRun({
  agentDecisionProvider,
  agentDecisionProviderContentMode,
  agentDecisionProviderInitialMode,
  agentDecisionProviderMaxRetries,
  agentDecisionProviderMetadata,
  agentDecisionProviderTimeoutMs,
  contractsRoot,
  cancelRequestedProvider,
  humanDecisionsPath,
  humanRequestsPath = join(projectRoot, DEFAULT_HUMAN_REQUESTS_PATH),
  projectRoot,
  request,
  runSummaryPath,
  sandboxCheckpointsPath = join(projectRoot, DEFAULT_SANDBOX_CHECKPOINTS_PATH),
  secretsPath = join(projectRoot, DEFAULT_DEV_SECRETS_PROFILE_PATH),
  secretsRequired = false,
  traceTimelinePath,
  traceEventObserver,
  generatedAt = new Date().toISOString(),
}) {
  const requestId = requiredNonEmptyString(request?.request_id, "request_id");
  const store = loadSandboxCheckpointStore(sandboxCheckpointsPath);
  const record = store.records.find((candidate) => candidate.request_id === requestId);
  if (!record) {
    throw serviceError("ToubaServeSandboxCheckpointNotFound", "sandbox checkpoint request_id is unknown");
  }
  if (record.status === "completed" && record.result) {
    return record.result;
  }
  const decision = loadHumanDecisionStore(humanDecisionsPath).decisions.find((candidate) =>
    candidate.request_id === requestId
  );
  if (!decision) {
    throw serviceError("ToubaServeSandboxDecisionRequired", "a stored human decision is required before resume");
  }
  if (decision.run_id !== record.run_id) {
    throw serviceError("ToubaServeSandboxDecisionMismatch", "human decision run_id does not match the checkpoint");
  }
  const resolved = resolveSandboxAirDocument({ projectRoot, targetRef: record.target_ref });
  const toolBindingManifest = loadOptionalProjectManifest({ projectRoot });
  const secretStore = loadOptionalProjectSecretStore({
    projectRoot,
    required: secretsRequired,
    secretsPath,
  });
  const startedMs = Date.now();
  let runtimeResult;
  try {
    const runtimeOptions = {
      agentDecisionProvider,
      agentDecisionProviderContentMode,
      agentDecisionProviderInitialMode,
      agentDecisionProviderMaxRetries,
      agentDecisionProviderMetadata,
      agentDecisionProviderTimeoutMs,
      cancelRequestedProvider,
      durableHumanApprovals: true,
      entryRef: record.target_ref,
      humanApprovalDecisions: {
        [record.approval_ref]: runtimeDecisionFromStoredDecision(decision),
      },
      humanApprovalResumeCheckpoint: record.checkpoint,
      runId: record.run_id,
      secretStore,
      toolBindingManifest,
      traceEventObserver,
    };
    runtimeResult = record.execution_kind === "trigger"
      ? await executeTriggerEvent(resolved.document, {
        trigger_ref: record.target_ref,
        event_id: `resume-${record.run_id}`,
        source_kind: sandboxTriggerSourceKind(resolved.document, record.target_ref),
        arguments: {},
      }, runtimeOptions)
      : await executeAirDocument(resolved.document, {
        ...runtimeOptions,
        entryRef: record.target_ref,
      });
  } catch (cause) {
    if (cause instanceof ToubaRuntimeError) {
      const error = serviceError("ToubaServeSandboxRuntimeRejected", cause.message);
      error.diagnostics = [serviceDiagnostic(cause.code ?? "ToubaRuntimeError", cause.message, "error", resolved.relativePath)];
      throw error;
    }
    throw cause;
  }
  const completedAt = new Date().toISOString();
  const result = buildSandboxRunResult({
    completedAt,
    effectPolicy: record.effect_policy,
    executionKind: record.execution_kind,
    runId: record.run_id,
    runtimeResult,
    startedAt: record.paused_result?.started_at ?? generatedAt,
    startedMs,
    targetRef: record.target_ref,
  });
  result.trace = mergeSandboxTraceSummaries(record.paused_result?.trace, result.trace);
  validateContractPayload({
    contractsRoot,
    schemaVersion: SANDBOX_RUN_RESULT_SCHEMA_VERSION,
    value: result,
    errorCode: "ToubaServeSandboxResultInvalid",
    message: "resumed sandbox run result does not match touba-sandbox-run-result-v0.1",
  });
  persistSandboxCurrentSurfaces({
    contractsRoot,
    result,
    runSummaryPath,
    runtimeResult,
    traceTimelinePath,
  });
  record.status = runtimeResult.checkpoint ? "superseded" : "completed";
  record.resumed_at = completedAt;
  record.result = result;
  saveSandboxCheckpointStore(sandboxCheckpointsPath, store);
  if (runtimeResult.checkpoint) {
    persistSandboxCheckpoint({
      checkpoint: runtimeResult.checkpoint,
      contractsRoot,
      createdAt: completedAt,
      effectPolicy: record.effect_policy,
      executionKind: record.execution_kind,
      humanRequestsPath,
      result,
      sandboxCheckpointsPath,
      targetRef: record.target_ref,
    });
  }
  return result;
}

function resolveSandboxAirDocument({ projectRoot, targetRef }) {
  const diagnostics = [];
  const artifacts = collectProjectArtifacts(projectRoot, diagnostics).filter((artifact) => artifact.kind === "air");
  if (artifacts.length === 0) {
    const error = serviceError("ToubaServeSandboxAirUnavailable", "project has no AIR artifact to execute");
    error.diagnostics = diagnostics;
    throw error;
  }
  for (const artifact of artifacts) {
    const path = join(projectRoot, artifact.relative_path);
    try {
      const document = loadAirFromJson(readFileSync(path, "utf8"));
      if (airDocumentContainsRef(document, targetRef)) {
        return { document, relativePath: artifact.relative_path };
      }
    } catch (cause) {
      diagnostics.push(serviceDiagnostic(
        "ToubaServeSandboxAirInvalid",
        `${artifact.relative_path} cannot be loaded by the runtime: ${cause.message}`,
        "warning",
        artifact.relative_path,
      ));
    }
  }
  const error = serviceError("ToubaServeSandboxTargetNotFound", `target_ref ${targetRef} is not present in project AIR artifacts`);
  error.diagnostics = diagnostics;
  throw error;
}

function loadOptionalProjectManifest({ projectRoot }) {
  const manifestPath = join(projectRoot, "touba.manifest.json");
  if (!existsSync(manifestPath)) {
    return undefined;
  }
  try {
    const rawManifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const manifestDir = dirname(resolve(manifestPath));
    for (const binding of Object.values(rawManifest.bindings ?? {})) {
      if (binding?.handler?.cwd && !isAbsolute(binding.handler.cwd)) {
        binding.handler.cwd = resolve(manifestDir, binding.handler.cwd);
      }
    }
    return loadToolBindingManifestFromJson(JSON.stringify(rawManifest));
  } catch (cause) {
    throw serviceError("ToubaServeSandboxManifestInvalid", `touba.manifest.json cannot be loaded by the runtime: ${cause.message}`);
  }
}

export function loadOptionalProjectSecretStore({ projectRoot, required, secretsPath }) {
  if (!existsSync(secretsPath)) {
    if (required) {
      throw serviceError(
        "ToubaServeSandboxSecretsMissing",
        `secrets profile does not exist: ${relative(projectRoot, secretsPath) || basename(secretsPath)}`,
      );
    }
    return undefined;
  }
  try {
    return loadSecretsFromJson(readFileSync(secretsPath, "utf8"), {
      baseDir: projectRoot,
      env: process.env,
    });
  } catch (cause) {
    throw serviceError(
      "ToubaServeSandboxSecretsInvalid",
      `secrets profile cannot be loaded by the runtime: ${cause.message}`,
    );
  }
}

function airDocumentContainsRef(document, ref) {
  return ["agents", "skills", "strategies", "functions", "tools", "triggers"].some((collection) =>
    (document.definitions?.[collection] ?? []).some((definition) => definition.id === ref)
  );
}

function sandboxTriggerTargetRef(document, triggerRef) {
  const trigger = (document.definitions?.triggers ?? []).find((definition) => definition.id === triggerRef);
  if (!trigger) return triggerRef;
  return nonEmptyString(trigger.target_ref) ?? triggerRef;
}

function sandboxTriggerSourceKind(document, triggerRef) {
  const trigger = (document.definitions?.triggers ?? []).find((definition) => definition.id === triggerRef);
  return nonEmptyString(trigger?.event?.kind) ?? "request";
}

function targetMayDispatchExternalTool(document, targetRef, seen = new Set()) {
  if (targetRef.startsWith("tool:")) return true;
  if (seen.has(targetRef)) return false;
  seen.add(targetRef);
  const definition = ["agents", "skills", "strategies", "functions"]
    .flatMap((collection) => document.definitions?.[collection] ?? [])
    .find((candidate) => candidate.id === targetRef);
  for (const nestedRef of definition?.uses ?? []) {
    if (typeof nestedRef !== "string") continue;
    if (nestedRef.startsWith("tool:")) return true;
    if (/^(agent|skill|strategy|function):/u.test(nestedRef)
      && targetMayDispatchExternalTool(document, nestedRef, seen)) {
      return true;
    }
  }
  const graph = executionGraphForTarget(document, targetRef);
  if (!graph) return false;
  for (const node of graph.nodes ?? []) {
    if (node.kind === "call_tool") return true;
    const nestedRef = nonEmptyString(node.target_ref ?? node.targetRef);
    if (nestedRef && /^(agent|skill|strategy|function):/u.test(nestedRef)) {
      if (targetMayDispatchExternalTool(document, nestedRef, seen)) return true;
    }
  }
  return false;
}

function sandboxEffectPolicyRequirement(document, targetRef) {
  if (!airDocumentContainsRef(document, targetRef)) return "unknown";
  return targetMayDispatchExternalTool(document, targetRef)
    ? "declared_external_effects_required"
    : "runtime_only_compatible";
}

function executionGraphForTarget(document, targetRef) {
  const definition = ["agents", "skills", "strategies", "functions"]
    .flatMap((collection) => document.definitions?.[collection] ?? [])
    .find((candidate) => candidate.id === targetRef);
  const graphRef = nonEmptyString(definition?.flow_graph_ref);
  return (document.execution_graphs ?? []).find((graph) =>
    graph.id === graphRef || graph.owner_ref === targetRef
  );
}

function sandboxTraceSummary(trace) {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const entryRef = nonEmptyString(trace?.run?.entry_ref) ?? "unknown";
  return {
    run_id: nonEmptyString(trace?.run?.run_id) ?? "unknown",
    entry_ref: entryRef,
    event_count: events.length,
    events: events.map((event, index) => {
      const type = nonEmptyString(event.kind ?? event.type) ?? "event";
      const references = sandboxTraceEventReferences(event);
      const authorityRef = references.authorityRef
        ?? (/^run_(started|completed|cancelled)$/u.test(type) ? entryRef : null);
      return {
        index: Number.isInteger(event.sequence_index) ? event.sequence_index : index,
        type,
        summary: sandboxTraceEventSummary(event, type),
        ...(authorityRef ? { authority_ref: authorityRef } : {}),
        ...(references.relatedRef ? { related_ref: references.relatedRef } : {}),
        severity: sandboxTraceEventSeverity(event, type),
        redaction: type.includes("secret") ? "secrets_redacted" : "payload_minimized",
      };
    }),
  };
}

function mergeSandboxTraceSummaries(...summaries) {
  const available = summaries.filter((summary) => isPlainObject(summary));
  const latest = available.at(-1) ?? {
    run_id: "unknown",
    entry_ref: "unknown",
    events: [],
  };
  const events = available
    .flatMap((summary) => Array.isArray(summary.events) ? summary.events : [])
    .map((event, index) => ({ ...event, index }));
  return {
    run_id: nonEmptyString(latest.run_id) ?? "unknown",
    entry_ref: nonEmptyString(latest.entry_ref) ?? "unknown",
    event_count: events.length,
    events,
  };
}

function sandboxTraceEventReferences(event) {
  const payload = isPlainObject(event?.payload) ? event.payload : {};
  const selectedFirst = new Set(["agent_decision_recorded", "agent_capability_selected"])
    .has(event?.kind ?? event?.type);
  const primaryCandidates = selectedFirst
    ? [payload.selected_ref, payload.target_ref, payload.tool_ref, payload.skill_ref, payload.agent_ref]
    : [payload.target_ref, payload.tool_ref, payload.skill_ref, payload.strategy_ref, payload.agent_ref, payload.owner_ref, payload.entry_ref, payload.requester_ref, payload.source_ref];
  const authorityRef = primaryCandidates.map(nonEmptyString).find((value) => value?.includes(":")) ?? null;
  const relatedRef = [payload.caller_ref, payload.agent_ref, payload.source_ref, payload.requester_ref]
    .map(nonEmptyString)
    .find((value) => value?.includes(":") && value !== authorityRef) ?? null;
  return { authorityRef, relatedRef };
}

function sandboxTraceEventSummary(event, type) {
  const payload = isPlainObject(event?.payload) ? event.payload : {};
  return nonEmptyString(event?.message)
    ?? nonEmptyString(payload.runtime_error_code)
    ?? nonEmptyString(payload.decision_source)
    ?? nonEmptyString(payload.authority_source)
    ?? nonEmptyString(payload.status)
    ?? type;
}

function sandboxTraceEventSeverity(event, type) {
  const payload = isPlainObject(event?.payload) ? event.payload : {};
  const text = `${type} ${payload.runtime_error_code ?? ""} ${payload.status ?? ""}`.toLowerCase();
  if (/failure|error|refus|reject|denied/u.test(text)) return "error";
  if (/human|approval|review|cancel|stopped/u.test(text)) return "warning";
  return "info";
}

function persistSandboxCurrentSurfaces({ contractsRoot, result, runSummaryPath, runtimeResult, traceTimelinePath }) {
  if (!runSummaryPath || !traceTimelinePath) return;
  const traceRef = `trace:${result.run_id}`;
  const timeline = {
    schema_version: "touba-trace-timeline-v1",
    run_id: result.run_id,
    trace_ref: traceRef,
    events: result.trace.events.map((event) => ({
      index: event.index,
      type: event.type,
      timestamp: result.started_at,
      severity: event.severity,
      summary: event.summary,
      source_ref: event.authority_ref ?? event.related_ref ?? null,
      redaction: event.redaction,
    })),
  };
  const summary = {
    schema_version: "touba-run-summary-v1",
    run_id: result.run_id,
    status: sandboxRunSummaryStatus(result.status, runtimeResult?.checkpoint),
    entrypoint_ref: result.target_ref,
    started_at: result.started_at,
    completed_at: result.status === "stopped" ? null : result.completed_at,
    trigger_ref: result.execution_kind === "trigger" ? result.target_ref : null,
    trace_ref: traceRef,
    approvals_pending: runtimeResult?.checkpoint?.approval_ref ? [runtimeResult.checkpoint.approval_ref] : [],
    refusals: result.diagnostics
      .filter((diagnostic) => diagnostic.severity === "error")
      .map((diagnostic) => ({ code: diagnostic.code, message: diagnostic.message, source_ref: result.target_ref })),
    budgets: sandboxTraceBudgetUsage(result.trace.events),
  };
  validateContractPayload({
    contractsRoot,
    schemaVersion: "touba-trace-timeline-v1",
    value: timeline,
    errorCode: "ToubaServeTraceTimelineInvalid",
    message: "sandbox trace timeline does not match touba-trace-timeline-v1",
  });
  validateContractPayload({
    contractsRoot,
    schemaVersion: "touba-run-summary-v1",
    value: summary,
    errorCode: "ToubaServeRunSummaryInvalid",
    message: "sandbox run summary does not match touba-run-summary-v1",
  });
  writeJsonStoreAtomic(traceTimelinePath, timeline);
  writeJsonStoreAtomic(runSummaryPath, summary);
}

function sandboxRunSummaryStatus(status, checkpoint) {
  if (status === "success") return "succeeded";
  if (status === "failure") return "failed";
  if (status === "cancelled") return "cancelled";
  if (status === "stopped" && checkpoint?.kind === "agent_human_review") return "review_pending";
  if (status === "stopped" && checkpoint) return "approval_pending";
  return "paused";
}

function sandboxTraceBudgetUsage(events) {
  return {
    steps_used: events.filter((event) => event.type === "agent_decision_requested").length,
    tool_calls_used: events.filter((event) => event.type === "tool_binding_authorized").length,
    provider_calls_used: events.filter((event) => event.type === "agent_decision_provider_call_attempted").length,
  };
}

function sandboxRunEventPayload(result) {
  return {
    schema_version: SANDBOX_RUN_RESULT_SCHEMA_VERSION,
    run_id: result.run_id,
    execution_kind: result.execution_kind,
    target_ref: result.target_ref,
    status: result.status,
    effect_policy: result.effect_policy,
    completed_at: result.completed_at,
    trace_event_count: result.trace.event_count,
  };
}

export function buildTriggerQueueHealth({
  contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname,
  projectRoot = process.cwd(),
  triggerStatusPath = join(projectRoot, DEFAULT_TRIGGER_STATUS_PATH),
  eventJournalPath = join(projectRoot, DEFAULT_EVENT_JOURNAL_PATH),
  generatedAt = new Date().toISOString(),
}) {
  const triggerStatus = readProjectTriggerStatus({ contractsRoot, triggerStatusPath, generatedAt });
  const journalEvents = safeReadProjectEventJournal(eventJournalPath);
  const triggers = (Array.isArray(triggerStatus.triggers) ? triggerStatus.triggers : [])
    .map((trigger) => triggerQueueHealthRow(trigger, journalEvents))
    .sort((left, right) => left.trigger_ref.localeCompare(right.trigger_ref));

  return {
    schema_version: TRIGGER_QUEUE_HEALTH_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_root: projectRoot,
    summary: {
      trigger_count: triggers.length,
      healthy: triggers.filter((item) => item.status === "healthy").length,
      watch: triggers.filter((item) => item.status === "watch").length,
      blocked: triggers.filter((item) => item.status === "blocked").length,
      pending: sumIntegerField(triggers, "pending"),
      processing: sumIntegerField(triggers, "processing"),
      retry: sumIntegerField(triggers, "retry"),
      dead_letter: sumIntegerField(triggers, "dead_letter"),
      replay_rejected: sumIntegerField(triggers, "replay_rejected"),
      rate_limited: sumIntegerField(triggers, "rate_limited"),
    },
    triggers,
    diagnostics: [],
  };
}

export function buildSupplyChainStatus({
  projectRoot = process.cwd(),
  generatedAt = new Date().toISOString(),
}) {
  const diagnostics = [];
  const artifacts = collectProjectArtifacts(projectRoot, diagnostics);
  const manifestArtifact = artifacts.find((item) => item.kind === "manifest");
  const lockArtifact = artifacts.find((item) => item.kind === "lock");
  const manifest = manifestArtifact === undefined
    ? undefined
    : readJsonArtifact(join(projectRoot, manifestArtifact.relative_path), manifestArtifact.relative_path, diagnostics);
  const lock = lockArtifact === undefined
    ? undefined
    : readJsonArtifact(join(projectRoot, lockArtifact.relative_path), lockArtifact.relative_path, diagnostics);
  const lockEntries = extractSupplyChainLockEntries(lock);
  const entries = [];
  const manifestBindings = isPlainObject(manifest?.bindings) ? manifest.bindings : {};

  for (const [ref, binding] of Object.entries(manifestBindings)) {
    const lockEntry = lockEntries.find((item) => item.ref === ref);
    entries.push(supplyChainEntryFromBinding({
      projectRoot,
      ref,
      binding: isPlainObject(binding) ? binding : {},
      manifestArtifact,
      lockArtifact,
      lockEntry,
    }));
  }

  for (const lockEntry of lockEntries) {
    if (entries.some((item) => item.ref === lockEntry.ref)) {
      continue;
    }
    entries.push(supplyChainEntryFromLockEntry({
      projectRoot,
      manifestArtifact,
      lockArtifact,
      lockEntry,
    }));
  }

  if (lockArtifact !== undefined && entries.every((item) => item.kind !== "lock")) {
    entries.push(supplyChainArtifactEntry({
      artifact: lockArtifact,
      kind: "lock",
      observedDigest: `sha256:${lockArtifact.sha256}`,
      message: "lock artifact is present",
    }));
  }

  return {
    schema_version: SUPPLY_CHAIN_STATUS_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_root: projectRoot,
    summary: {
      total: entries.length,
      ok: entries.filter((item) => item.status === "ok").length,
      drift: entries.filter((item) => item.status === "drift").length,
      missing: entries.filter((item) => item.status === "missing").length,
      unknown: entries.filter((item) => item.status === "unknown").length,
    },
    entries: entries.sort((left, right) => `${left.kind}:${left.ref}`.localeCompare(`${right.kind}:${right.ref}`)),
    diagnostics: diagnostics.map((diagnostic) => ({
      severity: ["info", "warning", "error"].includes(diagnostic.severity) ? diagnostic.severity : "warning",
      code: nonEmptyString(diagnostic.code) ?? "ToubaSupplyChainStatusDiagnostic",
      message: nonEmptyString(diagnostic.message) ?? "supply-chain status diagnostic",
    })),
  };
}

export function buildGovernanceReadiness({
  contractsRoot = new URL("../../../contracts/product-surfaces/", import.meta.url).pathname,
  projectRoot = process.cwd(),
  productIdentityPath = join(projectRoot, DEFAULT_PRODUCT_IDENTITY_PATH),
  changeProposalsPath = join(projectRoot, DEFAULT_CHANGE_PROPOSALS_PATH),
  generatedAt = new Date().toISOString(),
}) {
  const graph = buildAuthorityGraph({ projectRoot, generatedAt });
  const identity = readProductIdentity({
    contractsRoot,
    productIdentityPath,
  });
  const changes = listProjectChanges({ projectRoot, changeProposalsPath, generatedAt });
  const pendingChanges = (Array.isArray(changes.changes) ? changes.changes : [])
    .filter((change) => change.status === "pending");
  const activeAssignments = (Array.isArray(identity.assignments) ? identity.assignments : [])
    .filter((assignment) => assignment.status === "assigned");
  const owners = uniqueSorted([
    ...(Array.isArray(identity.teams) ? identity.teams : []).flatMap((team) => team.owner_refs ?? []),
  ]);
  const reviewers = uniqueSorted(activeAssignments.map((assignment) => assignment.user_ref));
  const graphErrors = (Array.isArray(graph.diagnostics) ? graph.diagnostics : [])
    .filter((diagnostic) => diagnostic.severity === "error");
  const graphWarnings = (Array.isArray(graph.diagnostics) ? graph.diagnostics : [])
    .filter((diagnostic) => diagnostic.severity === "warning");
  const artifacts = (Array.isArray(graph.nodes) ? graph.nodes : [])
    .filter((node) => ["agent", "skill", "tool", "strategy", "package"].includes(node.kind))
    .map((node) => governanceReadinessArtifact({
      node,
      graph,
      owners,
      reviewers,
      pendingChanges,
      activeAssignments,
      graphErrors,
      graphWarnings,
    }));
  const airDiagnostics = [];
  const scannedArtifacts = collectProjectArtifacts(projectRoot, airDiagnostics);
  for (const trigger of governanceTriggerArtifacts({ projectRoot, artifacts: scannedArtifacts })) {
    artifacts.push(governanceReadinessArtifact({
      node: trigger,
      graph,
      owners,
      reviewers,
      pendingChanges,
      activeAssignments,
      graphErrors,
      graphWarnings,
    }));
  }
  for (const artifact of scannedArtifacts.filter((item) => item.kind === "air")) {
    artifacts.push(governanceRunPlanArtifact({ artifact, owners, pendingChanges, graphWarnings }));
  }
  const diagnostics = [
    ...graphErrors,
    ...graphWarnings,
    ...airDiagnostics.map(normalizeAuthorityDiagnostic),
  ].map((diagnostic) => ({
    severity: ["info", "warning", "error"].includes(diagnostic.severity) ? diagnostic.severity : "warning",
    code: nonEmptyString(diagnostic.code) ?? "ToubaGovernanceReadinessDiagnostic",
    message: nonEmptyString(diagnostic.message) ?? "governance readiness diagnostic",
  }));

  return {
    schema_version: GOVERNANCE_READINESS_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_root: projectRoot,
    summary: {
      artifact_count: artifacts.length,
      approved: artifacts.filter((item) => item.status_prod === "approved").length,
      pending_review: artifacts.filter((item) => item.status_prod === "pending_review").length,
      blocked: artifacts.filter((item) => item.status_prod === "blocked").length,
      stale: artifacts.filter((item) => item.status_prod === "stale").length,
    },
    artifacts: artifacts.sort((left, right) => `${left.kind}:${left.ref}`.localeCompare(`${right.kind}:${right.ref}`)),
    diagnostics,
  };
}

function triggerQueueHealthRow(trigger, journalEvents) {
  const pending = nonNegativeInteger(trigger.queue?.pending);
  const processing = nonNegativeInteger(trigger.queue?.processing);
  const deadLetter = nonNegativeInteger(trigger.queue?.dead_letter);
  const refused = nonNegativeInteger(trigger.state?.refused_count);
  const relatedEvents = journalEvents.filter((event) => eventReferencesTrigger(event, trigger.trigger_ref));
  const replayRejected = relatedEvents.filter((event) => eventMatchesAny(event, ["replay"])).length;
  const rateLimited = relatedEvents.filter((event) => eventMatchesAny(event, ["rate", "quota", "limit"])).length;
  const retry = relatedEvents.filter((event) => eventMatchesAny(event, ["retry"])).length;
  let status = "healthy";
  if (trigger.status === "blocked" || deadLetter > 0) {
    status = "blocked";
  } else if (
    trigger.status === "paused"
    || pending > 0
    || processing > 0
    || retry > 0
    || refused > 0
    || replayRejected > 0
    || rateLimited > 0
  ) {
    status = "watch";
  }
  return {
    trigger_ref: String(trigger.trigger_ref),
    kind: trigger.kind === "schedule" ? "schedule" : "request",
    status,
    transport_status: ["enabled", "disabled", "paused", "blocked"].includes(trigger.status) ? trigger.status : "blocked",
    pending,
    processing,
    retry,
    dead_letter: deadLetter,
    replay_rejected: replayRejected,
    rate_limited: rateLimited,
    refused,
    last_event_id: nonEmptyString(trigger.state?.last_event_id) ?? null,
    evidence: relatedEvents.slice(-5).map((event) => ({
      source: "project_event_journal",
      event_id: event.event_id ?? null,
      message: `${event.type}`,
    })).concat([{
      source: "trigger_status",
      event_id: nonEmptyString(trigger.state?.last_event_id) ?? null,
      message: status === "healthy" ? "trigger queue is empty" : "trigger queue requires attention",
    }]).slice(-5),
  };
}

function safeReadProjectEventJournal(eventJournalPath) {
  try {
    return readProjectEventJournal(eventJournalPath);
  } catch {
    return [];
  }
}

function eventReferencesTrigger(event, triggerRef) {
  if (typeof triggerRef !== "string" || triggerRef.trim() === "") {
    return false;
  }
  const text = JSON.stringify({
    type: event?.type,
    trigger_ref: event?.payload?.trigger_ref,
    source_ref: event?.payload?.source_ref,
    target_ref: event?.payload?.target_ref,
    code: event?.payload?.code,
    message: event?.payload?.message,
  });
  return text.includes(triggerRef);
}

function eventMatchesAny(event, needles) {
  const text = JSON.stringify({
    type: event?.type,
    code: event?.payload?.code,
    message: event?.payload?.message,
    status: event?.payload?.status,
  }).toLowerCase();
  return needles.some((needle) => text.includes(needle));
}

function supplyChainEntryFromBinding({
  projectRoot,
  ref,
  binding,
  manifestArtifact,
  lockArtifact,
  lockEntry,
}) {
  const handlerPackageRef = nonEmptyString(binding.handler_package_ref)
    ?? nonEmptyString(binding.handler_package)
    ?? nonEmptyString(binding.package_ref)
    ?? lockEntry?.handlerPackageRef
    ?? null;
  const expectedDigest = lockEntry?.expectedDigest ?? null;
  const observedDigest = lockEntry === undefined ? null : observedSupplyChainDigest(projectRoot, lockEntry);
  const status = supplyChainDigestStatus({ expectedDigest, observedDigest });
  return {
    ref,
    kind: "handler",
    status,
    handler_package_ref: handlerPackageRef,
    manifest_path: manifestArtifact?.relative_path ?? null,
    lock_path: lockArtifact?.relative_path ?? null,
    expected_digest: expectedDigest,
    observed_digest: observedDigest,
    evidence: {
      source: lockEntry === undefined ? "manifest" : "lock",
      path: lockEntry === undefined ? manifestArtifact?.relative_path ?? null : lockArtifact?.relative_path ?? null,
      source_ref: ref,
      message: supplyChainStatusMessage(status),
    },
  };
}

function supplyChainEntryFromLockEntry({
  projectRoot,
  manifestArtifact,
  lockArtifact,
  lockEntry,
}) {
  const observedDigest = observedSupplyChainDigest(projectRoot, lockEntry);
  const status = supplyChainDigestStatus({
    expectedDigest: lockEntry.expectedDigest,
    observedDigest,
  });
  return {
    ref: lockEntry.ref,
    kind: lockEntry.kind,
    status,
    handler_package_ref: lockEntry.handlerPackageRef,
    manifest_path: manifestArtifact?.relative_path ?? null,
    lock_path: lockArtifact?.relative_path ?? null,
    expected_digest: lockEntry.expectedDigest,
    observed_digest: observedDigest,
    evidence: {
      source: "lock",
      path: lockArtifact?.relative_path ?? null,
      source_ref: lockEntry.ref,
      message: supplyChainStatusMessage(status),
    },
  };
}

function supplyChainArtifactEntry({ artifact, kind, observedDigest, message }) {
  return {
    ref: artifact.relative_path,
    kind,
    status: "unknown",
    handler_package_ref: null,
    manifest_path: kind === "manifest" ? artifact.relative_path : null,
    lock_path: kind === "lock" ? artifact.relative_path : null,
    expected_digest: null,
    observed_digest: observedDigest,
    evidence: {
      source: "project_scan",
      path: artifact.relative_path,
      source_ref: null,
      message,
    },
  };
}

function extractSupplyChainLockEntries(lock) {
  if (!isPlainObject(lock)) {
    return [];
  }
  const handlers = Array.isArray(lock.handlers) ? lock.handlers : [];
  const packages = Array.isArray(lock.packages) ? lock.packages : [];
  return [
    ...handlers.map((entry) => normalizeSupplyChainLockEntry(entry, "handler")).filter(Boolean),
    ...packages.map((entry) => normalizeSupplyChainLockEntry(entry, "package")).filter(Boolean),
  ];
}

function normalizeSupplyChainLockEntry(entry, kind) {
  if (!isPlainObject(entry)) {
    return null;
  }
  const handlerPackage = isPlainObject(entry.handler_package) ? entry.handler_package : {};
  const ref = nonEmptyString(entry.tool_ref)
    ?? nonEmptyString(entry.handler_ref)
    ?? nonEmptyString(entry.package_ref)
    ?? nonEmptyString(entry.ref)
    ?? nonEmptyString(handlerPackage.name);
  if (ref === undefined) {
    return null;
  }
  const handlerPackageRef = packageRefFromLockEntry(entry, handlerPackage);
  const packageRoot = nonEmptyString(handlerPackage.package_root) ?? "";
  const entrypoint = nonEmptyString(handlerPackage.entrypoint) ?? nonEmptyString(entry.entrypoint) ?? nonEmptyString(entry.path) ?? "";
  const fileEntries = Array.isArray(handlerPackage.files) ? handlerPackage.files : [];
  const expectedDigest = normalizeDigest(entry.digest)
    ?? normalizeDigest(entry.handler_digest)
    ?? normalizeDigest(entry.sha256)
    ?? normalizeDigest(fileEntries.find((file) => nonEmptyString(file?.path) === entrypoint)?.digest)
    ?? normalizeDigest(fileEntries[0]?.digest)
    ?? null;
  return {
    ref,
    kind,
    handlerPackageRef,
    expectedDigest,
    candidatePaths: uniqueSorted([
      supplyChainRelativePath(packageRoot, entrypoint),
      ...fileEntries.map((file) => supplyChainRelativePath(packageRoot, nonEmptyString(file?.path) ?? "")),
    ]),
  };
}

function packageRefFromLockEntry(entry, handlerPackage) {
  const name = nonEmptyString(handlerPackage.name)
    ?? nonEmptyString(entry.package_ref)
    ?? nonEmptyString(entry.package_name);
  if (name === undefined) {
    return null;
  }
  return name.startsWith("package:") ? name : `package:${name}`;
}

function supplyChainRelativePath(packageRoot, path) {
  const normalizedPath = nonEmptyString(path);
  if (normalizedPath === undefined) {
    return null;
  }
  const normalizedRoot = nonEmptyString(packageRoot);
  if (normalizedRoot === undefined || normalizedPath.startsWith(`${normalizedRoot}/`)) {
    return normalizeRelativePath(normalizedPath);
  }
  return normalizeRelativePath(`${normalizedRoot}/${normalizedPath}`);
}

function observedSupplyChainDigest(projectRoot, lockEntry) {
  for (const candidatePath of lockEntry.candidatePaths) {
    if (candidatePath === null) {
      continue;
    }
    const absolutePath = resolve(projectRoot, candidatePath);
    if (!isPathInside(projectRoot, absolutePath) || !existsSync(absolutePath) || statSync(absolutePath).isDirectory()) {
      continue;
    }
    return `sha256:${sha256Buffer(readFileSync(absolutePath))}`;
  }
  return null;
}

function supplyChainDigestStatus({ expectedDigest, observedDigest }) {
  if (expectedDigest === null) {
    return "unknown";
  }
  if (observedDigest === null) {
    return "missing";
  }
  return expectedDigest === observedDigest ? "ok" : "drift";
}

function supplyChainStatusMessage(status) {
  if (status === "ok") return "observed digest matches the lock";
  if (status === "drift") return "observed digest differs from the lock";
  if (status === "missing") return "locked artifact is missing from the project";
  return "digest evidence is incomplete";
}

function normalizeDigest(value) {
  if (typeof value === "string" && value.trim() !== "") {
    return value.startsWith("sha256:") ? value : `sha256:${value}`;
  }
  if (isPlainObject(value)) {
    const digestValue = nonEmptyString(value.value) ?? nonEmptyString(value.sha256) ?? nonEmptyString(value.digest);
    if (digestValue !== undefined) {
      return digestValue.startsWith("sha256:") ? digestValue : `sha256:${digestValue}`;
    }
  }
  return null;
}

function governanceReadinessArtifact({
  node,
  graph,
  owners,
  reviewers,
  pendingChanges,
  activeAssignments,
  graphErrors,
  graphWarnings,
}) {
  const gates = reviewGateRefsForNode(node, graph);
  const statusDev = graphErrors.length > 0 ? "blocked" : graphWarnings.length > 0 ? "stale" : "approved";
  let statusProd = statusDev;
  if (statusProd === "approved" && (pendingChanges.length > 0 || activeAssignments.length > 0 || gates.length > 0)) {
    statusProd = "pending_review";
  }
  return {
    ref: node.ref,
    kind: node.kind,
    label: nonEmptyString(node.label) ?? authorityLabel(node.ref),
    status_dev: statusDev,
    status_prod: statusProd,
    owners,
    reviewers,
    review_gates: gates,
    evidence: {
      source: node.evidence?.source ?? "authority_graph",
      path: node.evidence?.path ?? null,
      source_ref: node.evidence?.source_ref ?? node.ref,
      message: statusProd === "approved" ? "artifact is ready for production profile" : "artifact requires governance attention",
    },
  };
}

function governanceRunPlanArtifact({ artifact, owners, pendingChanges, graphWarnings }) {
  const statusDev = graphWarnings.length > 0 ? "stale" : "approved";
  const statusProd = pendingChanges.length > 0 ? "pending_review" : statusDev;
  return {
    ref: `run_plan:${artifact.relative_path}`,
    kind: "run_plan",
    label: artifact.relative_path,
    status_dev: statusDev,
    status_prod: statusProd,
    owners,
    reviewers: [],
    review_gates: [],
    evidence: {
      source: "project_scan",
      path: artifact.relative_path,
      source_ref: artifact.relative_path,
      message: "AIR artifact participates in production readiness",
    },
  };
}

function governanceTriggerArtifacts({ projectRoot, artifacts }) {
  const triggers = [];
  for (const artifact of artifacts.filter((item) => item.kind === "source")) {
    const content = readTextArtifact(join(projectRoot, artifact.relative_path), artifact.relative_path, []);
    if (content === undefined) {
      continue;
    }
    const moduleName = content.match(/^\s*module\s+([A-Za-z_][\w.]*)/mu)?.[1] ?? "source";
    for (const match of content.matchAll(/^\s*trigger\s+([A-Za-z_][\w]*)\b/gmu)) {
      const name = match[1];
      triggers.push({
        ref: `trigger:${moduleName}/${name}`,
        kind: "trigger",
        label: name,
        evidence: {
          source: "source",
          path: artifact.relative_path,
          source_ref: `${artifact.relative_path}:${lineNumberAt(content, match.index)}`,
        },
      });
    }
  }
  return triggers;
}

function reviewGateRefsForNode(node, graph) {
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  return uniqueSorted(edges
    .filter((edge) => edge.from === node.ref && typeof edge.to === "string" && edge.to.startsWith("human_gate:"))
    .map((edge) => edge.to));
}

function sumIntegerField(items, field) {
  return items.reduce((sum, item) => sum + nonNegativeInteger(item[field]), 0);
}

function nonNegativeInteger(value) {
  return Number.isInteger(value) && value > 0 ? value : 0;
}

function uniqueSorted(values) {
  return Array.from(new Set(values.filter((value) => typeof value === "string" && value.trim() !== ""))).sort();
}

export function readProductIdentity({
  contractsRoot,
  productIdentityPath,
  generatedAt = new Date().toISOString(),
}) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: productIdentityPath,
    schemaVersion: PRODUCT_IDENTITY_SCHEMA_VERSION,
    errorCode: "ToubaServeProductIdentityInvalid",
    message: "project product identity does not match touba-product-identity-v0.1",
  });
  return stored ?? emptyProductIdentity(generatedAt);
}

function emptyProductIdentity(generatedAt) {
  return {
    schema_version: PRODUCT_IDENTITY_SCHEMA_VERSION,
    generated_at: generatedAt,
    summary: {
      user_count: 0,
      team_count: 0,
      device_count: 0,
      active_assignment_count: 0,
      revoked_device_count: 0,
    },
    users: [],
    teams: [],
    roles: [],
    devices: [],
    sessions: [],
    assignments: [],
    escalation_policies: [],
    events: [],
  };
}

export function readCostObservatory({
  contractsRoot,
  costObservatoryPath,
  generatedAt = new Date().toISOString(),
  projectRoot = process.cwd(),
}) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: costObservatoryPath,
    schemaVersion: COST_OBSERVATORY_SCHEMA_VERSION,
    errorCode: "ToubaServeCostObservatoryInvalid",
    message: "project cost observatory report does not match touba-cost-observatory-v0.1",
  });
  return stored ?? emptyCostObservatory({ generatedAt, projectRoot });
}

function emptyCostObservatory({ generatedAt, projectRoot }) {
  return {
    schema_version: COST_OBSERVATORY_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_root: projectRoot,
    currency: "USD",
    summary: {
      run_count: 0,
      provider_call_count: 0,
      tool_call_count: 0,
      duration_ms: 0,
      estimated_cost: 0,
      estimate_basis: "no recorded cost evidence",
    },
    runs: [],
    diagnostics: [],
  };
}

export function readMobileNotifications({
  contractsRoot,
  mobileNotificationsPath,
  generatedAt = new Date().toISOString(),
}) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: mobileNotificationsPath,
    schemaVersion: MOBILE_NOTIFICATION_SCHEMA_VERSION,
    errorCode: "ToubaServeMobileNotificationsInvalid",
    message: "mobile notification report does not match mobile client-notification-v0.1",
  });
  return stored ?? emptyMobileNotifications(generatedAt);
}

function emptyMobileNotifications(generatedAt) {
  return {
    schema_version: MOBILE_NOTIFICATION_SCHEMA_VERSION,
    generated_at: generatedAt,
    summary: {
      notification_count: 0,
      pending_decisions: 0,
      alerts: 0,
    },
    notifications: [],
  };
}

export function issueMobilePairingRequest({
  contractsRoot,
  mobilePairingsPath,
  serverUrl,
  request = {},
  issuedAt = new Date().toISOString(),
}) {
  const issuedMs = parseMobilePairingInstant(issuedAt, "issued_at");
  const expiresAt = nonEmptyString(request.expires_at)
    ?? new Date(issuedMs + 5 * 60 * 1000).toISOString();
  const expiresMs = parseMobilePairingInstant(expiresAt, "expires_at");
  if (expiresMs <= issuedMs) {
    throw serviceError("ToubaServeMobilePairingExpired", "mobile pairing expiration must be after issuance");
  }
  const pairingId = nonEmptyString(request.pairing_id) ?? `pair_${compactTimestamp(issuedAt)}_${randomBytes(4).toString("hex")}`;
  const deviceRef = nonEmptyString(request.device_ref) ?? `device:${pairingId}`;
  const userRef = nonEmptyString(request.user_ref) ?? "user:mobile-reviewer";
  const scopes = normalizeMobilePairingScopes(request.scopes);
  const token = `mbp_${randomBytes(24).toString("base64url")}`;
  const nonce = `nonce_${randomBytes(16).toString("hex")}`;
  const normalizedServerUrl = requiredMobilePairingString(serverUrl, "server_url");
  const pairingRequest = {
    schema_version: MOBILE_PAIRING_REQUEST_SCHEMA_VERSION,
    pairing_id: pairingId,
    server_url: normalizedServerUrl,
    bearer_token: token,
    device_ref: deviceRef,
    user_ref: userRef,
    nonce,
    expires_at: expiresAt,
    scopes,
    deep_link: buildMobilePairingDeepLink({
      pairingId,
      serverUrl: normalizedServerUrl,
      token,
      deviceRef,
      userRef,
      nonce,
      expiresAt,
      scopes,
    }),
  };
  validateContractPayload({
    contractsRoot,
    schemaVersion: MOBILE_PAIRING_REQUEST_SCHEMA_VERSION,
    value: pairingRequest,
    errorCode: "ToubaServeMobilePairingInvalid",
    message: "mobile pairing request does not match mobile client-pairing-request-v0.1",
  });
  const store = loadMobilePairingStore(mobilePairingsPath);
  if (store.pairings.some((item) => item.pairing_id === pairingId && item.status !== "revoked")) {
    throw serviceError("ToubaServeMobilePairingDuplicate", "mobile pairing_id is already active or pending");
  }
  store.pairings.push({
    pairing_id: pairingId,
    status: "issued",
    device_ref: deviceRef,
    user_ref: userRef,
    scopes,
    token_sha256: sha256Text(token),
    nonce_sha256: sha256Text(nonce),
    issued_at: issuedAt,
    expires_at: expiresAt,
    accepted_at: null,
    revoked_at: null,
    revoked_by: null,
    revocation_reason: null,
  });
  saveMobilePairingStore(mobilePairingsPath, store);
  return pairingRequest;
}

export function acceptMobilePairing({
  contractsRoot,
  mobilePairingsPath,
  pairingRequest,
  acceptedAt = new Date().toISOString(),
}) {
  validateContractPayload({
    contractsRoot,
    schemaVersion: MOBILE_PAIRING_REQUEST_SCHEMA_VERSION,
    value: pairingRequest,
    errorCode: "ToubaServeMobilePairingInvalid",
    message: "mobile pairing request does not match mobile client-pairing-request-v0.1",
  });
  const scopes = normalizeMobilePairingScopes(pairingRequest.scopes);
  const store = loadMobilePairingStore(mobilePairingsPath);
  const tokenDigest = sha256Text(requiredMobilePairingString(pairingRequest.bearer_token, "bearer_token"));
  const nonceDigest = sha256Text(requiredMobilePairingString(pairingRequest.nonce, "nonce"));
  const pairing = store.pairings.find((item) => item.pairing_id === pairingRequest.pairing_id);
  if (pairing === undefined) {
    throw serviceError("ToubaServeMobilePairingUnknown", "mobile pairing_id is unknown");
  }
  if (pairing.status === "revoked") {
    throw serviceError("ToubaServeMobilePairingRevoked", "mobile pairing has been revoked");
  }
  if (pairing.status === "active") {
    throw serviceError("ToubaServeMobilePairingReplayRejected", "mobile pairing invitation has already been accepted");
  }
  if (!constantTimeTextEqual(pairing.token_sha256, tokenDigest) || !constantTimeTextEqual(pairing.nonce_sha256, nonceDigest)) {
    throw serviceError("ToubaServeMobilePairingInvalid", "mobile pairing token or nonce does not match the issued invitation");
  }
  if (pairing.device_ref !== pairingRequest.device_ref || pairing.user_ref !== pairingRequest.user_ref) {
    throw serviceError("ToubaServeMobilePairingInvalid", "mobile pairing identity does not match the issued invitation");
  }
  if (!sameStringSet(pairing.scopes, scopes)) {
    throw serviceError("ToubaServeMobilePairingScopeRejected", "mobile pairing scopes do not match the issued invitation");
  }
  const acceptedMs = parseMobilePairingInstant(acceptedAt, "accepted_at");
  if (parseMobilePairingInstant(pairing.expires_at, "expires_at") <= acceptedMs) {
    throw serviceError("ToubaServeMobilePairingExpired", "mobile pairing invitation has expired");
  }
  pairing.status = "active";
  pairing.accepted_at = acceptedAt;
  saveMobilePairingStore(mobilePairingsPath, store);
  return {
    schema_version: "touba-mobile-pairing-accepted-v0.1",
    status: "accepted",
    pairing_id: pairing.pairing_id,
    device_ref: pairing.device_ref,
    user_ref: pairing.user_ref,
    scopes: pairing.scopes,
    accepted_at: acceptedAt,
  };
}

export function revokeMobilePairing({
  mobilePairingsPath,
  deviceRef,
  pairingId,
  revokedBy,
  reason,
  revokedAt = new Date().toISOString(),
}) {
  const normalizedPairingId = nonEmptyString(pairingId);
  const normalizedDeviceRef = nonEmptyString(deviceRef);
  if (normalizedPairingId === undefined && normalizedDeviceRef === undefined) {
    throw serviceError("ToubaServeMobilePairingInvalid", "pairing_id or device_ref is required to revoke a mobile pairing");
  }
  const store = loadMobilePairingStore(mobilePairingsPath);
  const pairing = store.pairings.find((item) =>
    (normalizedPairingId !== undefined && item.pairing_id === normalizedPairingId)
    || (normalizedDeviceRef !== undefined && item.device_ref === normalizedDeviceRef)
  );
  if (pairing === undefined) {
    throw serviceError("ToubaServeMobilePairingUnknown", "mobile pairing is unknown");
  }
  if (pairing.status === "revoked") {
    throw serviceError("ToubaServeMobilePairingRevoked", "mobile pairing has already been revoked");
  }
  pairing.status = "revoked";
  pairing.revoked_at = revokedAt;
  pairing.revoked_by = normalizeActor(revokedBy);
  pairing.revocation_reason = nonEmptyString(reason) ?? "revoked";
  saveMobilePairingStore(mobilePairingsPath, store);
  return {
    schema_version: "touba-mobile-pairing-revoked-v0.1",
    status: "revoked",
    pairing_id: pairing.pairing_id,
    device_ref: pairing.device_ref,
    user_ref: pairing.user_ref,
    revoked_at: revokedAt,
    revoked_by: pairing.revoked_by,
    reason: pairing.revocation_reason,
  };
}

export function readMobileQuickApprovalPolicy({ contractsRoot, mobileQuickApprovalPolicyPath }) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: mobileQuickApprovalPolicyPath,
    schemaVersion: MOBILE_QUICK_APPROVAL_POLICY_SCHEMA_VERSION,
    errorCode: "ToubaServeMobileQuickApprovalPolicyInvalid",
    message: "mobile quick approval policy does not match mobile client-quick-approval-policy-v0.1",
  });
  return stored ?? disabledMobileQuickApprovalPolicy();
}

function disabledMobileQuickApprovalPolicy(generatedAt = new Date().toISOString()) {
  return {
    schema_version: MOBILE_QUICK_APPROVAL_POLICY_SCHEMA_VERSION,
    generated_at: generatedAt,
    policy_ref: "policy:mobile/quick-approval-disabled",
    status: "disabled",
    max_risk: "low",
    allowed_modes: [],
    allowed_decisions: [],
    require_biometric: true,
    fallback_target: "full_review",
    evidence: {
      source: "touba-project-server",
      message: "No project quick-approval policy is configured.",
    },
  };
}

export function readMobileEscalation({ contractsRoot, mobileEscalationPath }) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: mobileEscalationPath,
    schemaVersion: MOBILE_ESCALATION_SCHEMA_VERSION,
    errorCode: "ToubaServeMobileEscalationInvalid",
    message: "mobile escalation report does not match mobile client-escalation-v0.1",
  });
  return stored ?? emptyMobileEscalation();
}

function emptyMobileEscalation(generatedAt = new Date().toISOString()) {
  return {
    schema_version: MOBILE_ESCALATION_SCHEMA_VERSION,
    generated_at: generatedAt,
    summary: {
      assignment_count: 0,
      active: 0,
      escalated: 0,
      expired: 0,
    },
    assignments: [],
    events: [],
  };
}

export function buildHandlerSandboxStatus({
  contractsRoot,
  projectRoot = process.cwd(),
  handlerSandboxStatusPath = join(projectRoot, DEFAULT_HANDLER_SANDBOX_STATUS_PATH),
  platform = process.platform,
  generatedAt = new Date().toISOString(),
}) {
  const stored = readOptionalContractFile({
    contractsRoot,
    filePath: handlerSandboxStatusPath,
    schemaVersion: HANDLER_SANDBOX_STATUS_SCHEMA_VERSION,
    errorCode: "ToubaServeHandlerSandboxStatusInvalid",
    message: "handler sandbox status does not match touba-handler-sandbox-status-v0.1",
  });
  if (stored !== undefined) {
    return stored;
  }

  const diagnostics = [];
  const artifacts = collectProjectArtifacts(projectRoot, diagnostics);
  const manifestArtifact = artifacts.find((item) => item.kind === "manifest");
  const manifest = manifestArtifact === undefined
    ? undefined
    : readJsonArtifact(join(projectRoot, manifestArtifact.relative_path), manifestArtifact.relative_path, diagnostics);
  const bindings = isPlainObject(manifest?.bindings) ? manifest.bindings : {};
  const handlers = Object.entries(bindings)
    .filter(([, binding]) => isPlainObject(binding) && isPlainObject(binding.handler))
    .map(([toolRef, binding]) => handlerSandboxRow({
      toolRef,
      binding,
      platform,
      sourceRef: manifestArtifact?.relative_path ?? null,
    }))
    .sort((left, right) => left.tool_ref.localeCompare(right.tool_ref));

  return {
    schema_version: HANDLER_SANDBOX_STATUS_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_root: projectRoot,
    platform,
    summary: {
      handler_count: handlers.length,
      isolated: handlers.filter((item) => item.status === "isolated").length,
      not_isolated: handlers.filter((item) => item.status === "not_isolated").length,
      unsupported: handlers.filter((item) => item.status === "unsupported").length,
      unknown: handlers.filter((item) => item.status === "unknown").length,
    },
    handlers,
    diagnostics: diagnostics.map((diagnostic) => ({
      severity: ["info", "warning", "error"].includes(diagnostic.severity) ? diagnostic.severity : "warning",
      code: nonEmptyString(diagnostic.code) ?? "ToubaHandlerSandboxDiagnostic",
      message: nonEmptyString(diagnostic.message) ?? "handler sandbox diagnostic",
    })),
  };
}

function handlerSandboxRow({ toolRef, binding, platform, sourceRef }) {
  const required = binding.sandbox?.required === true || binding.sandbox?.mode === "required";
  const mechanism = sandboxMechanismForPlatform(platform);
  let status = "not_isolated";
  let message = "handler binding does not require sandbox isolation";
  if (required && mechanism !== null) {
    status = "isolated";
    message = "handler binding requires platform sandbox isolation";
  } else if (required && mechanism === null) {
    status = "unsupported";
    message = "handler binding requires sandbox isolation on an unsupported platform";
  }
  const handler = isPlainObject(binding.handler) ? binding.handler : {};
  return {
    tool_ref: toolRef,
    handler_kind: nonEmptyString(handler.kind) ?? "unknown",
    command_ref: nonEmptyString(handler.command) ?? "unknown",
    status,
    mechanism: required ? mechanism : null,
    grants: normalizeStringList(binding.grants),
    required,
    evidence: {
      source: "touba.manifest.json",
      source_ref: sourceRef === null ? toolRef : `${sourceRef}#${toolRef}`,
      message,
    },
  };
}

function sandboxMechanismForPlatform(platform) {
  if (platform === "linux") return "bubblewrap";
  if (platform === "darwin") return "sandbox-exec";
  if (platform === "win32") return "Sandboxie-Plus";
  return null;
}

function normalizeStringList(value) {
  return Array.isArray(value)
    ? value.filter((item) => typeof item === "string" && item.trim() !== "")
    : [];
}

export function buildAuthorityGraph({
  projectRoot,
  generatedAt = new Date().toISOString(),
}) {
  const diagnostics = [];
  const artifacts = collectProjectArtifacts(projectRoot, diagnostics);
  const builder = createAuthorityGraphBuilder(diagnostics);

  for (const artifact of artifacts) {
    const artifactPath = join(projectRoot, artifact.relative_path);
    if (artifact.kind === "source") {
      parseToubaSourceAuthority({
        builder,
        content: readTextArtifact(artifactPath, artifact.relative_path, diagnostics),
        path: artifact.relative_path,
      });
      continue;
    }
    if (artifact.kind === "air") {
      const value = readJsonArtifact(artifactPath, artifact.relative_path, diagnostics);
      if (value !== undefined) {
        parseAirAuthority({ builder, value, path: artifact.relative_path });
      }
      continue;
    }
    if (artifact.kind === "manifest") {
      const value = readJsonArtifact(artifactPath, artifact.relative_path, diagnostics);
      if (value !== undefined) {
        parseManifestAuthority({ builder, value, path: artifact.relative_path });
      }
      continue;
    }
    if (artifact.kind === "package") {
      const value = readJsonArtifact(artifactPath, artifact.relative_path, diagnostics);
      if (value !== undefined) {
        parsePackageAuthority({ builder, value, path: artifact.relative_path });
      }
    }
  }
  const graph = builder.build();
  const authorityDiagnostics = diagnostics.map(normalizeAuthorityDiagnostic);
  return {
    schema_version: AUTHORITY_GRAPH_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_root: projectRoot,
    summary: {
      node_count: graph.nodes.length,
      edge_count: graph.edges.length,
      diagnostic_count: authorityDiagnostics.length,
    },
    nodes: graph.nodes,
    edges: graph.edges,
    diagnostics: authorityDiagnostics,
  };
}

export function readPendingHumanRequest({
  contractsRoot,
  humanRequestsPath,
  humanDecisionsPath,
  kind,
  allowFixtureWhenStoreMissing = false,
}) {
  if (!existsSync(humanRequestsPath)) {
    if (allowFixtureWhenStoreMissing) {
      return readContractFixture({
        contractsRoot,
        schemaVersion: kind === "approval"
          ? "touba-approval-request-v1"
          : "touba-human-review-request-v1",
      });
    }
    throw serviceError("ToubaServePendingHumanRequestNotFound", "pending human request store is not available");
  }
  const store = readHumanRequestStore(humanRequestsPath);
  const decisions = loadHumanDecisionStore(humanDecisionsPath);
  const decided = new Set(decisions.decisions.map((decision) =>
    `${decision.schema_version}:${decision.request_id}`
  ));
  const schemaVersion = kind === "approval"
    ? "touba-approval-request-v1"
    : "touba-human-review-request-v1";
  const requests = kind === "approval" ? store.approvals : store.reviews;
  const pending = requests.find((request) =>
    !decided.has(`${schemaVersionToDecisionSchema(schemaVersion)}:${request.request_id}`)
  );
  if (pending === undefined) {
    throw serviceError("ToubaServePendingHumanRequestNotFound", "no pending human request is available");
  }
  validateContractPayload({
    contractsRoot,
    schemaVersion,
    value: pending,
    errorCode: "ToubaServePendingHumanRequestInvalid",
    message: "pending human request does not match its contract",
  });
  return pending;
}

function optionalPendingHumanRequest(options) {
  try {
    return readPendingHumanRequest(options);
  } catch (error) {
    if (error?.code === "ToubaServePendingHumanRequestNotFound") {
      return null;
    }
    throw error;
  }
}

export function refreshProject({
  projectRoot,
  previousSnapshot,
  request = {},
  refreshedAt = new Date().toISOString(),
}) {
  if (request !== undefined && request !== null && typeof request !== "object") {
    throw serviceError("ToubaServeRefreshInvalid", "refresh request must be a JSON object");
  }
  if (
    request?.schema_version !== undefined
    && request.schema_version !== PROJECT_REFRESH_REQUEST_SCHEMA_VERSION
  ) {
    throw serviceError("ToubaServeRefreshInvalid", `refresh request schema_version must be ${PROJECT_REFRESH_REQUEST_SCHEMA_VERSION}`);
  }
  const snapshot = buildProjectSnapshot({ projectRoot, previousSnapshot, refreshedAt });
  return { snapshot, report: snapshot.report };
}

export function buildProjectDeploymentPlan({
  projectRoot,
  profile = "prod",
  targetConfigured = false,
  createdAt = new Date().toISOString(),
  sourceRevision,
}) {
  const bundle = buildDeploymentBundle({
    projectRoot,
    profile,
    createdAt,
    sourceRevision,
  });
  verifyDeploymentBundle(bundle);
  const checks = deploymentReadinessChecks(bundle, { targetConfigured });
  return {
    schema_version: DEPLOYMENT_PLAN_SCHEMA_VERSION,
    status: checks.some((check) => check.status === "blocked") ? "blocked" : "ready",
    profile,
    bundle_id: bundle.bundle_id,
    bundle_sha256: bundle.bundle_sha256,
    artifact_count: bundle.artifacts.length,
    source_revision: bundle.source_revision,
    source_dirty: bundle.source_dirty,
    target_configured: targetConfigured,
    checks,
  };
}

export function proposeProjectChange({
  projectRoot,
  changeProposalsPath,
  proposal,
  proposedAt = new Date().toISOString(),
}) {
  const normalized = validateChangeProposal({ projectRoot, proposal });
  const store = loadChangeProposalStore(changeProposalsPath);
  if (store.proposals.some((item) => item.proposal_id === normalized.proposal_id)) {
    throw serviceError("ToubaServeChangeProposalDuplicate", "change proposal_id already exists");
  }
  const stored = {
    ...normalized,
    ...changeTargetBaseEvidence(projectRoot, normalized.target.path),
    status: "proposed",
    proposed_at: proposedAt,
    validations: validateChangeContent(normalized, { projectRoot }),
  };
  store.proposals.push(stored);
  saveChangeProposalStore(changeProposalsPath, store);
  return {
    schema_version: CHANGE_PROPOSED_SCHEMA_VERSION,
    status: "proposed",
    proposal_id: stored.proposal_id,
    action: stored.action,
    target: stored.target,
    requested_by: stored.requested_by,
    proposed_at: proposedAt,
    content_sha256: stored.content_sha256,
    validations: stored.validations,
  };
}

export function proposeProjectChangeSet({
  projectRoot,
  changeProposalsPath,
  changeSet,
  proposedAt = new Date().toISOString(),
}) {
  if (!isPlainObject(changeSet) || !Array.isArray(changeSet.changes)) {
    throw serviceError("ToubaServeChangeSetInvalid", "change set must contain a changes array");
  }
  if (changeSet.changes.length < 2 || changeSet.changes.length > MAX_CHANGE_SET_TARGETS) {
    throw serviceError(
      "ToubaServeChangeSetInvalid",
      `change set must contain between 2 and ${MAX_CHANGE_SET_TARGETS} targets`,
    );
  }
  const proposalId = requiredNonEmptyString(changeSet.proposal_id, "proposal_id");
  const requestedBy = normalizeActor(changeSet.requested_by);
  const seenPaths = new Set();
  const targets = changeSet.changes.map((change, index) => {
    if (!isPlainObject(change)) {
      throw serviceError("ToubaServeChangeSetInvalid", `changes[${index}] must be an object`);
    }
    const normalized = validateChangeProposal({
      projectRoot,
      proposal: {
        schema_version: CHANGE_PROPOSAL_SCHEMA_VERSION,
        proposal_id: `${proposalId}:${index}`,
        action: "write_text_file",
        target: { path: change.path },
        requested_by: requestedBy,
        reason: changeSet.reason ?? "",
        content: change.content,
      },
    });
    if (seenPaths.has(normalized.target.path)) {
      throw serviceError("ToubaServeChangeSetInvalid", `duplicate change-set target ${normalized.target.path}`);
    }
    seenPaths.add(normalized.target.path);
    return {
      ...normalized.target,
      role: typeof change.role === "string" && change.role.trim() !== "" ? change.role.trim() : "project_file",
      content: normalized.content,
      content_sha256: normalized.content_sha256,
      ...changeTargetBaseEvidence(projectRoot, normalized.target.path),
    };
  });
  const aggregateBytes = targets.reduce(
    (total, target) => total + Buffer.byteLength(target.content, "utf8"),
    0,
  );
  if (aggregateBytes > MAX_CHANGE_SET_BYTES) {
    throw serviceError("ToubaServeChangeTooLarge", `change set exceeds ${MAX_CHANGE_SET_BYTES} bytes`);
  }
  const store = loadChangeProposalStore(changeProposalsPath);
  if (store.proposals.some((item) => item.proposal_id === proposalId)) {
    throw serviceError("ToubaServeChangeProposalDuplicate", "change proposal_id already exists");
  }
  const validations = validateChangeTargets(targets, { projectRoot });
  if (validations.some((item) => item.severity === "error")) {
    const error = serviceError("ToubaServeChangeValidationFailed", "change set failed validation");
    error.diagnostics = validations;
    throw error;
  }
  const stored = {
    schema_version: CHANGE_PROPOSAL_SCHEMA_VERSION,
    proposal_id: proposalId,
    action: "write_text_file",
    target: { path: targets[0].path },
    targets,
    requested_by: requestedBy,
    reason: typeof changeSet.reason === "string" ? changeSet.reason : "",
    content: targets[0].content,
    content_sha256: sha256Text(
      targets.map((target) => `${target.path}\0${target.content_sha256}`).join("\n"),
    ),
    status: "proposed",
    proposed_at: proposedAt,
    validations,
  };
  store.proposals.push(stored);
  saveChangeProposalStore(changeProposalsPath, store);
  return {
    schema_version: CHANGE_PROPOSED_SCHEMA_VERSION,
    status: "proposed",
    proposal_id: stored.proposal_id,
    action: stored.action,
    target: stored.target,
    targets: publicChangeTargets(stored),
    target_count: targets.length,
    requested_by: stored.requested_by,
    proposed_at: proposedAt,
    content_sha256: stored.content_sha256,
    validations: stored.validations,
  };
}

export function applyProjectChange({
  projectRoot,
  changeProposalsPath,
  applyRequest,
  decidedAt = new Date().toISOString(),
}) {
  recoverProjectChangeTransactions({ projectRoot });
  const request = validateChangeApplyRequest(applyRequest);
  const store = loadChangeProposalStore(changeProposalsPath);
  const proposal = store.proposals.find((item) => item.proposal_id === request.proposal_id);
  if (proposal === undefined) {
    throw serviceError("ToubaServeChangeProposalNotFound", "change proposal_id is unknown");
  }
  if (proposal.status !== "proposed") {
    throw serviceError("ToubaServeChangeAlreadyDecided", "change proposal is no longer pending");
  }
  if (request.decision === "refuse") {
    proposal.status = "refused";
    proposal.decided_at = decidedAt;
    proposal.decided_by = request.decided_by;
    proposal.decision_reason = request.reason ?? "refused";
    proposal.refusal_reason = request.reason ?? "refused";
    saveChangeProposalStore(changeProposalsPath, store);
    const result = {
      schema_version: CHANGE_RESULT_SCHEMA_VERSION,
      status: "refused",
      proposal_id: proposal.proposal_id,
      target: proposal.target,
      decided_at: decidedAt,
      decided_by: request.decided_by,
      reason: proposal.refusal_reason,
      content_sha256: proposal.content_sha256,
      validations: proposal.validations ?? [],
      evidence: {
        write_mode: "none",
        project_root: projectRoot,
        relative_path: proposal.target.path,
      },
    };
    if (Array.isArray(proposal.targets)) {
      result.targets = publicChangeTargets(proposal);
      result.target_count = proposal.targets.length;
      result.evidence.relative_paths = proposal.targets.map((target) => target.path);
    }
    return result;
  }

  const targets = changeTargets(proposal);
  const validations = validateChangeTargets(targets, { projectRoot });
  if (validations.some((item) => item.severity === "error")) {
    const error = serviceError("ToubaServeChangeValidationFailed", "change proposal failed validation");
    error.diagnostics = validations;
    throw error;
  }
  for (const target of targets) {
    assertChangeTargetUnchanged(target, safeProjectPath(projectRoot, target.path));
  }
  const writeEvidence = targets.length === 1
    ? applySingleChangeTarget({ projectRoot, target: targets[0] })
    : applyChangeTargetsTransaction({
        projectRoot,
        proposalId: proposal.proposal_id,
        targets,
        decidedAt,
      });
  proposal.status = "applied";
  proposal.decided_at = decidedAt;
  proposal.decided_by = request.decided_by;
  proposal.decision_reason = request.reason;
  proposal.validations = validations;
  proposal.applied_path = proposal.target.path;
  proposal.write_evidence = writeEvidence;
  saveChangeProposalStore(changeProposalsPath, store);
  const result = {
    schema_version: CHANGE_RESULT_SCHEMA_VERSION,
    status: "applied",
    proposal_id: proposal.proposal_id,
    target: proposal.target,
    decided_at: decidedAt,
    decided_by: request.decided_by,
    reason: request.reason,
    content_sha256: proposal.content_sha256,
    validations,
    evidence: writeEvidence,
  };
  if (Array.isArray(proposal.targets)) {
    result.targets = publicChangeTargets(proposal);
    result.target_count = proposal.targets.length;
  }
  return result;
}

export function proposeGovernanceRelationChange({
  projectRoot,
  changeProposalsPath,
  request,
  proposedAt = new Date().toISOString(),
}) {
  const normalized = validateGovernanceRelationChangeRequest(request);
  const draft = buildGovernanceRelationSourceDraft({
    operation: normalized.operation,
    projectRoot,
    relation: normalized.relation,
  });
  return proposeProjectChange({
    projectRoot,
    changeProposalsPath,
    proposedAt,
    proposal: {
      schema_version: CHANGE_PROPOSAL_SCHEMA_VERSION,
      proposal_id: normalized.proposal_id,
      action: "write_text_file",
      target: { path: draft.path },
      requested_by: normalized.requested_by,
      reason: normalized.reason,
      content: draft.content,
    },
  });
}

export function listProjectChanges({
  projectRoot,
  changeProposalsPath,
  generatedAt = new Date().toISOString(),
}) {
  const store = loadChangeProposalStore(changeProposalsPath);
  const changes = store.proposals
    .map((proposal) => projectChangeSummary(proposal))
    .sort((left, right) => right.proposed_at.localeCompare(left.proposed_at));
  return {
    schema_version: CHANGE_HISTORY_SCHEMA_VERSION,
    generated_at: generatedAt,
    summary: {
      total: changes.length,
      pending: changes.filter((item) => item.status === "pending").length,
      applied: changes.filter((item) => item.status === "applied").length,
      refused: changes.filter((item) => item.status === "refused").length,
    },
    changes,
  };
}

export function getProjectChangeDetail({
  projectRoot,
  changeProposalsPath,
  proposalId,
  generatedAt = new Date().toISOString(),
}) {
  const id = requiredNonEmptyString(proposalId, "proposal_id");
  const store = loadChangeProposalStore(changeProposalsPath);
  const proposal = store.proposals.find((item) => item.proposal_id === id);
  if (proposal === undefined) {
    throw serviceError("ToubaServeChangeProposalNotFound", "change proposal_id is unknown");
  }
  return {
    schema_version: CHANGE_DETAIL_SCHEMA_VERSION,
    generated_at: generatedAt,
    change: projectChangeDetail(proposal, { projectRoot }),
  };
}

function buildProjectSnapshot({
  projectRoot,
  previousSnapshot,
  refreshedAt = new Date().toISOString(),
}) {
  const diagnostics = [];
  const artifacts = collectProjectArtifacts(projectRoot, diagnostics);
  const changedArtifacts = changedProjectArtifacts(artifacts, previousSnapshot?.artifacts ?? []);
  appendProjectReadinessDiagnostics(artifacts, diagnostics);
  const report = {
    schema_version: PROJECT_REFRESH_SCHEMA_VERSION,
    status: diagnostics.some((item) => item.severity === "error") ? "error" : "refreshed",
    project_root: projectRoot,
    refreshed_at: refreshedAt,
    summary: {
      artifact_count: artifacts.length,
      changed_count: changedArtifacts.length,
      diagnostic_count: diagnostics.length,
    },
    artifacts,
    changes: {
      changed_artifacts: changedArtifacts,
    },
    diagnostics,
  };
  return {
    artifacts,
    report,
  };
}

function buildProjectInspection({
  projectRoot,
  projectSnapshot = buildProjectSnapshot({ projectRoot }),
  generatedAt = new Date().toISOString(),
}) {
  const diagnostics = [...inspectionDiagnostics(projectSnapshot.report?.diagnostics ?? [])];
  const projectConfig = readProjectConfig(projectRoot, diagnostics);
  const inputPresentation = readInputPresentationConfig(projectRoot, diagnostics);
  const artifacts = projectSnapshot.artifacts
    .filter((artifact) => ["source", "air", "manifest", "lock", "trace"].includes(artifact.kind))
    .map((artifact) => ({
      kind: artifact.kind,
      path: artifact.relative_path,
      status: inspectionArtifactStatus(artifact, projectSnapshot.report?.diagnostics ?? []),
    }));
  const packages = buildProjectPackages({ projectRoot, artifacts: projectSnapshot.artifacts, diagnostics });

  return {
    schema_version: "touba-project-inspection-v1",
    generated_at: generatedAt,
    project: {
      root: projectRoot,
      name: nonEmptyString(projectConfig?.name) ?? basename(projectRoot),
      host_language: nonEmptyString(projectConfig?.language) ?? "unknown",
    },
    artifacts,
    entrypoints: buildProjectEntrypoints({
      projectRoot,
      artifacts: projectSnapshot.artifacts,
      diagnostics,
      inputPresentation,
    }),
    packages,
    diagnostics,
  };
}

function buildProjectPackages({ projectRoot, artifacts, diagnostics }) {
  const packages = [];
  for (const artifact of artifacts.filter((item) => (
    item.kind === "package" && item.relative_path.startsWith("packages/")
  ))) {
    let document;
    try {
      document = JSON.parse(readFileSync(join(projectRoot, artifact.relative_path), "utf8"));
    } catch (cause) {
      diagnostics.push(serviceDiagnostic(
        "ToubaProjectPackageUnreadable",
        `cannot read ${artifact.relative_path}: ${cause.message}`,
        "warning",
        artifact.relative_path,
      ));
      continue;
    }
    const name = nonEmptyString(document?.name);
    const version = nonEmptyString(document?.version);
    const valid = document?.package_schema_version === "touba-package-v0.1"
      && name !== undefined
      && version !== undefined
      && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)
      && isPlainObject(document?.exports);
    if (!valid) {
      diagnostics.push(serviceDiagnostic(
        "ToubaProjectPackageInvalid",
        `${artifact.relative_path} is not a valid touba-package-v0.1 document`,
        "warning",
        artifact.relative_path,
      ));
      continue;
    }
    const exports = Object.values(document.exports)
      .filter(Array.isArray)
      .flat()
      .filter((ref) => typeof ref === "string" && ref.trim() !== "");
    packages.push({
      package_ref: `package:${name}`,
      name,
      version,
      status: "installed",
      digest: `sha256:${artifact.sha256}`,
      path: artifact.relative_path,
      description: nonEmptyString(document.description) ?? "",
      documentation_url: nonEmptyString(document.documentation_url)
        ?? nonEmptyString(document.docs_url)
        ?? "",
      exports,
    });
  }
  return packages.sort((left, right) => left.package_ref.localeCompare(right.package_ref));
}

function inspectionDiagnostics(diagnostics) {
  return diagnostics.map((item) => ({
    severity: item.severity === "error" ? "error" : item.severity === "warning" ? "warning" : "info",
    code: nonEmptyString(item.code) ?? "ToubaProjectInspectionDiagnostic",
    message: nonEmptyString(item.message) ?? "project inspection diagnostic",
    source_ref: item.source_ref ?? null,
  }));
}

function readProjectConfig(projectRoot, diagnostics) {
  const path = join(projectRoot, "touba.project.json");
  if (!existsSync(path)) {
    return null;
  }
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    diagnostics.push(serviceDiagnostic(
      "ToubaProjectConfigUnreadable",
      `cannot read touba.project.json: ${cause.message}`,
      "warning",
      "touba.project.json",
    ));
    return null;
  }
}

function readInputPresentationConfig(projectRoot, diagnostics) {
  const path = join(projectRoot, DEFAULT_INPUT_PRESENTATION_PATH);
  if (!existsSync(path)) return null;
  let document;
  try {
    document = JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    diagnostics.push(serviceDiagnostic(
      "ToubaInputPresentationUnreadable",
      `cannot read ${DEFAULT_INPUT_PRESENTATION_PATH}: ${cause.message}`,
      "warning",
      DEFAULT_INPUT_PRESENTATION_PATH,
    ));
    return null;
  }
  if (
    document?.schema_version !== "touba-input-presentation-v0.1"
    || !Array.isArray(document.targets)
  ) {
    diagnostics.push(serviceDiagnostic(
      "ToubaInputPresentationInvalid",
      `${DEFAULT_INPUT_PRESENTATION_PATH} must use touba-input-presentation-v0.1`,
      "warning",
      DEFAULT_INPUT_PRESENTATION_PATH,
    ));
    return null;
  }
  const seenTargets = new Set();
  for (const target of document.targets) {
    if (
      !isPlainObject(target)
      || nonEmptyString(target.target_ref) === undefined
      || !Array.isArray(target.generated_fields)
      || seenTargets.has(target.target_ref)
    ) {
      diagnostics.push(serviceDiagnostic(
        "ToubaInputPresentationInvalid",
        `${DEFAULT_INPUT_PRESENTATION_PATH} contains an invalid or duplicate target`,
        "warning",
        DEFAULT_INPUT_PRESENTATION_PATH,
      ));
      return null;
    }
    seenTargets.add(target.target_ref);
    for (const field of target.generated_fields) {
      if (!validGeneratedFieldDeclaration(field)) {
        diagnostics.push(serviceDiagnostic(
          "ToubaInputPresentationInvalid",
          `${DEFAULT_INPUT_PRESENTATION_PATH} contains an invalid generated field for ${target.target_ref}`,
          "warning",
          DEFAULT_INPUT_PRESENTATION_PATH,
        ));
        return null;
      }
    }
  }
  return document;
}

function validGeneratedFieldDeclaration(field) {
  if (
    !isPlainObject(field)
    || !Array.isArray(field.path)
    || field.path.length === 0
    || field.path.some((segment) => nonEmptyString(segment) === undefined)
    || !["uuid", "timestamp", "prefixed_timestamp"].includes(field.generator)
  ) {
    return false;
  }
  if (field.generator === "prefixed_timestamp") {
    return typeof field.prefix === "string"
      && /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/u.test(field.prefix);
  }
  return field.prefix === undefined;
}

function generatedFieldsForTarget({
  diagnostics,
  inputContract,
  inputPresentation,
  targetRef,
}) {
  const target = inputPresentation?.targets?.find((candidate) => candidate.target_ref === targetRef);
  if (target === undefined) return [];
  const generatedFields = [];
  for (const field of target.generated_fields) {
    const inputField = inputFieldAtPath(inputContract, field.path);
    if (inputField?.type_ref !== "builtin:Text") {
      diagnostics.push(serviceDiagnostic(
        "ToubaInputPresentationPathInvalid",
        `generated field ${field.path.join(".")} for ${targetRef} must resolve to a declared Text input`,
        "warning",
        DEFAULT_INPUT_PRESENTATION_PATH,
      ));
      continue;
    }
    generatedFields.push(field);
  }
  return generatedFields;
}

function inputFieldAtPath(contract, path) {
  if (contract?.mode !== "declared") return undefined;
  const typesByRef = new Map((contract.types ?? []).map((type) => [type.ref, type]));
  let fields = contract.fields ?? [];
  let current;
  for (const segment of path) {
    current = fields.find((field) => field.name === segment);
    if (current === undefined) return undefined;
    fields = typesByRef.get(current.type_ref)?.fields ?? [];
  }
  return current;
}

function inspectionArtifactStatus(artifact, diagnostics) {
  return diagnostics.some((item) => item.code === "ToubaServeProjectAirStale" && artifact.kind === "air")
    ? "stale"
    : "present";
}

function buildProjectEntrypoints({ projectRoot, artifacts, diagnostics, inputPresentation }) {
  const entrypoints = new Map();
  for (const artifact of artifacts.filter((item) => item.kind === "air")) {
    const path = join(projectRoot, artifact.relative_path);
    let air;
    try {
      air = JSON.parse(readFileSync(path, "utf8"));
    } catch (cause) {
      diagnostics.push(serviceDiagnostic(
        "ToubaProjectAirUnreadable",
        `cannot read ${artifact.relative_path}: ${cause.message}`,
        "warning",
        artifact.relative_path,
      ));
      continue;
    }
    for (const [collection, kind] of Object.entries(AIR_ENTRYPOINT_KINDS)) {
      for (const definition of Array.isArray(air?.definitions?.[collection]) ? air.definitions[collection] : []) {
        const ref = nonEmptyString(definition.id);
        if (ref === undefined) {
          continue;
        }
        const inputContract = buildAirInputContract({ air, definition, kind });
        const generatedFields = generatedFieldsForTarget({
          diagnostics,
          inputContract,
          inputPresentation,
          targetRef: ref,
        });
        entrypoints.set(ref, {
          kind,
          ref,
          description: nonEmptyString(definition.description) ?? nonEmptyString(definition.name) ?? ref,
          effect_policy_requirement: sandboxEffectPolicyRequirement(air, ref),
          input_contract: inputContract,
          interaction_contract: buildInteractionContract({ generatedFields, inputContract, kind }),
        });
      }
    }
    for (const trigger of Array.isArray(air?.definitions?.triggers) ? air.definitions.triggers : []) {
      const ref = nonEmptyString(trigger.id);
      if (ref === undefined) {
        continue;
      }
      const inputContract = buildAirInputContract({ air, definition: trigger, kind: "trigger" });
      const generatedFields = generatedFieldsForTarget({
        diagnostics,
        inputContract,
        inputPresentation,
        targetRef: ref,
      });
      entrypoints.set(ref, {
        kind: "trigger",
        ref,
        description: nonEmptyString(trigger.description) ?? nonEmptyString(trigger.name) ?? ref,
        effect_policy_requirement: sandboxEffectPolicyRequirement(
          air,
          sandboxTriggerTargetRef(air, ref),
        ),
        input_contract: inputContract,
        interaction_contract: buildInteractionContract({
          generatedFields,
          inputContract,
          kind: "trigger",
        }),
      });
    }
  }
  for (const artifact of artifacts.filter((item) => item.kind === "source")) {
    const content = readTextArtifact(join(projectRoot, artifact.relative_path), artifact.relative_path, diagnostics);
    if (content === undefined) {
      continue;
    }
    const moduleName = content.match(/^\s*module\s+([A-Za-z_][\w.]*)/mu)?.[1] ?? basename(artifact.relative_path, ".tb");
    for (const match of content.matchAll(/^\s*trigger\s+([A-Za-z_][\w]*)\b/gmu)) {
      const name = match[1];
      const ref = `trigger:${moduleName}/${name}`;
      if (entrypoints.has(ref)) {
        continue;
      }
      const inputContract = unavailableAirInputContract();
      entrypoints.set(ref, {
        kind: "trigger",
        ref,
        description: `Trigger ${name}`,
        effect_policy_requirement: "unknown",
        input_contract: inputContract,
        interaction_contract: buildInteractionContract({ inputContract, kind: "trigger" }),
      });
    }
  }
  return [...entrypoints.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

function collectProjectArtifacts(projectRoot, diagnostics) {
  const artifacts = [];
  visitProjectDirectory(projectRoot, "", 0, artifacts, diagnostics);
  artifacts.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return artifacts.slice(0, MAX_PROJECT_ARTIFACTS);
}

function visitProjectDirectory(projectRoot, relativeDir, depth, artifacts, diagnostics) {
  if (artifacts.length >= MAX_PROJECT_ARTIFACTS || depth > MAX_PROJECT_SCAN_DEPTH) {
    return;
  }
  const absoluteDir = join(projectRoot, relativeDir);
  let entries;
  try {
    entries = readdirSync(absoluteDir, { withFileTypes: true });
  } catch (cause) {
    diagnostics.push(serviceDiagnostic("ToubaServeProjectScanFailed", `cannot read ${relativeDir || "."}: ${cause.message}`, "warning"));
    return;
  }
  entries.sort((left, right) => left.name.localeCompare(right.name));
  for (const entry of entries) {
    if (artifacts.length >= MAX_PROJECT_ARTIFACTS) {
      return;
    }
    if (entry.name.includes("\0")) {
      diagnostics.push(serviceDiagnostic("ToubaServeProjectPathInvalid", "project path contains a NUL byte"));
      continue;
    }
    const relativePath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (!PROJECT_SCAN_EXCLUDED_DIRS.has(entry.name)) {
        visitProjectDirectory(projectRoot, relativePath, depth + 1, artifacts, diagnostics);
      }
      continue;
    }
    if (!entry.isFile() || !isRelevantProjectArtifact(relativePath)) {
      continue;
    }
    const absolutePath = join(projectRoot, relativePath);
    try {
      const stats = statSync(absolutePath);
      const content = readFileSync(absolutePath);
      artifacts.push({
        relative_path: relativePath,
        kind: projectArtifactKind(relativePath),
        size_bytes: stats.size,
        mtime_ms: Math.trunc(stats.mtimeMs),
        sha256: sha256Buffer(content),
      });
    } catch (cause) {
      diagnostics.push(serviceDiagnostic("ToubaServeProjectArtifactUnreadable", `cannot read ${relativePath}: ${cause.message}`, "warning"));
    }
  }
}

function appendProjectReadinessDiagnostics(artifacts, diagnostics) {
  if (!artifacts.some((item) => item.kind === "source")) {
    diagnostics.push(serviceDiagnostic("ToubaServeProjectSourceMissing", "no .tb source file was found", "warning"));
  }
  const latestSource = latestMtime(artifacts.filter((item) => item.kind === "source"));
  const latestAir = latestMtime(artifacts.filter((item) => item.kind === "air"));
  if (latestSource !== undefined && (latestAir === undefined || latestSource > latestAir)) {
    diagnostics.push(serviceDiagnostic("ToubaServeProjectAirStale", "source is newer than generated AIR or no AIR was found", "warning"));
  }
}

function changedProjectArtifacts(current, previous) {
  const previousByPath = new Map(previous.map((item) => [item.relative_path, item]));
  return current
    .filter((item) => previousByPath.get(item.relative_path)?.sha256 !== item.sha256)
    .map((item) => ({
      relative_path: item.relative_path,
      kind: item.kind,
      sha256: item.sha256,
    }));
}

function latestMtime(artifacts) {
  if (artifacts.length === 0) return undefined;
  return Math.max(...artifacts.map((item) => item.mtime_ms));
}

function isRelevantProjectArtifact(relativePath) {
  const name = basename(relativePath);
  return relativePath.endsWith(".tb")
    || relativePath.endsWith(".air.json")
    || relativePath.endsWith(".trace.json")
    || NAMED_PROJECT_ARTIFACTS.has(name);
}

function projectArtifactKind(relativePath) {
  const name = basename(relativePath);
  if (relativePath.endsWith(".tb")) return "source";
  if (relativePath.endsWith(".air.json")) return "air";
  if (relativePath.endsWith(".trace.json")) return "trace";
  if (name === "touba.manifest.json") return "manifest";
  if (name === "touba.lock.json") return "lock";
  if (name === "touba.project.json") return "project_config";
  if (name === "touba.package.json") return "package";
  if (name === "touba.ownership.json") return "ownership";
  return "metadata";
}

function createAuthorityGraphBuilder(diagnostics) {
  const nodes = new Map();
  const pendingEdges = new Map();

  const addNode = ({ ref, kind, label, evidence }) => {
    const id = normalizeAuthorityRef(ref);
    if (id === undefined) {
      return;
    }
    const normalizedKind = authorityKind(kind, id);
    if (normalizedKind === undefined) {
      diagnostics.push(authorityDiagnostic(
        "ToubaAuthorityGraphNodeKindUnknown",
        `cannot classify authority node ${id}`,
        "warning",
        id,
      ));
      return;
    }
    if (!nodes.has(id)) {
      nodes.set(id, {
        id,
        kind: normalizedKind,
        label: nonEmptyString(label) ?? authorityLabel(id),
        ref: id,
        evidence,
      });
    }
  };

  const addEdge = ({ kind, from, to, evidence, access }) => {
    const fromRef = normalizeAuthorityRef(from);
    const toRef = normalizeAuthorityRef(to);
    if (fromRef === undefined || toRef === undefined) {
      return;
    }
    const normalizedAccess = ["read", "write"].includes(access) ? access : undefined;
    const id = `edge:${kind}:${fromRef}->${toRef}${normalizedAccess === undefined ? "" : `:${normalizedAccess}`}`;
    if (!pendingEdges.has(id)) {
      pendingEdges.set(id, {
        id,
        kind,
        from: fromRef,
        to: toRef,
        ...(normalizedAccess === undefined ? {} : { access: normalizedAccess }),
        evidence,
      });
    }
  };

  const removeEdge = ({ kind, from, to, evidence }) => {
    const fromRef = normalizeAuthorityRef(from);
    const toRef = normalizeAuthorityRef(to);
    if (fromRef === undefined || toRef === undefined) {
      return;
    }
    const id = `edge:${kind}:${fromRef}->${toRef}`;
    if (!pendingEdges.delete(id)) {
      diagnostics.push(authorityDiagnostic(
        "ToubaAuthorityGraphGovernanceActionNoop",
        `${kind} edge ${fromRef} -> ${toRef} was not present when applying governance action`,
        "info",
        evidence?.source_ref ?? fromRef,
      ));
    }
  };

  const build = () => {
    const edges = [];
    for (const edge of pendingEdges.values()) {
      if (!nodes.has(edge.from) || !nodes.has(edge.to)) {
        diagnostics.push(authorityDiagnostic(
          "ToubaAuthorityGraphDanglingEdge",
          `${edge.kind} edge ${edge.from} -> ${edge.to} references a missing authority node`,
          "warning",
          edge.evidence.source_ref ?? edge.from,
        ));
        continue;
      }
      edges.push(edge);
    }
    return {
      nodes: Array.from(nodes.values()).sort((left, right) => authoritySortKey(left).localeCompare(authoritySortKey(right))),
      edges: edges.sort((left, right) => left.id.localeCompare(right.id)),
    };
  };

  return { addNode, addEdge, removeEdge, build };
}

function parseAirAuthority({ builder, value, path }) {
  const evidence = (sourceRef) => authorityEvidence("air", path, sourceRef);
  if (isPlainObject(value.module)) {
    builder.addNode({
      ref: value.module.id,
      kind: "module",
      label: value.module.name,
      evidence: evidence(value.module.source_ref),
    });
  }
  const definitions = isPlainObject(value.definitions) ? value.definitions : {};
  for (const [collection, kind] of [
    ["functions", "function"],
    ["tools", "tool"],
    ["skills", "skill"],
    ["agents", "agent"],
    ["strategies", "strategy"],
    ["triggers", "trigger"],
    ["memories", "memory"],
  ]) {
    for (const definition of Array.isArray(definitions[collection]) ? definitions[collection] : []) {
      if (!isPlainObject(definition)) {
        continue;
      }
      builder.addNode({
        ref: definition.id,
        kind,
        label: definition.name,
        evidence: evidence(definition.source_ref),
      });
    }
  }
  for (const collection of ["tools", "skills", "agents", "strategies"]) {
    for (const definition of Array.isArray(definitions[collection]) ? definitions[collection] : []) {
      if (!isPlainObject(definition) || typeof definition.id !== "string") {
        continue;
      }
      const useRefs = Array.isArray(definition.use_refs) ? definition.use_refs : [];
      for (const useRef of useRefs) {
        if (isPlainObject(useRef)) {
          builder.addEdge({
            kind: "uses",
            from: definition.id,
            to: useRef.target_ref,
            evidence: evidence(useRef.source_ref),
          });
        }
      }
      if (useRefs.length === 0) {
        for (const targetRef of Array.isArray(definition.uses) ? definition.uses : []) {
          builder.addEdge({
            kind: "uses",
            from: definition.id,
            to: targetRef,
            evidence: evidence(definition.source_ref),
          });
        }
      }
      for (const callableBy of Array.isArray(definition.callable_by) ? definition.callable_by : []) {
        if (isPlainObject(callableBy)) {
          builder.addEdge({
            kind: "callable_by",
            from: callableBy.caller_ref,
            to: definition.id,
            evidence: evidence(callableBy.source_ref),
          });
        }
      }
    }
  }
  for (const trigger of Array.isArray(definitions.triggers) ? definitions.triggers : []) {
    if (!isPlainObject(trigger) || typeof trigger.id !== "string") {
      continue;
    }
    if (typeof trigger.target_ref === "string") {
      builder.addEdge({
        kind: "dispatches",
        from: trigger.id,
        to: trigger.target_ref,
        evidence: evidence(trigger.source_ref),
      });
    }
  }
  for (const graph of Array.isArray(value.execution_graphs) ? value.execution_graphs : []) {
    if (!isPlainObject(graph)) {
      continue;
    }
    for (const node of Array.isArray(graph.nodes) ? graph.nodes : []) {
      if (!isPlainObject(node) || !String(node.kind ?? "").startsWith("human")) {
        continue;
      }
      const ref = `human_gate:${graph.owner_ref ?? graph.id}/${node.kind}`;
      builder.addNode({
        ref,
        kind: "human_gate",
        label: node.kind,
        evidence: evidence(node.source_ref ?? graph.source_ref),
      });
      if (typeof graph.owner_ref === "string") {
        builder.addEdge({
          kind: "uses",
          from: graph.owner_ref,
          to: ref,
          evidence: evidence(node.source_ref ?? graph.source_ref),
        });
      }
    }
  }
}

function parseManifestAuthority({ builder, value, path }) {
  const bindings = isPlainObject(value.bindings) ? value.bindings : {};
  for (const [ref, binding] of Object.entries(bindings)) {
    const evidence = authorityEvidence("manifest", path, null);
    builder.addNode({
      ref,
      kind: authorityKind(undefined, ref),
      label: authorityLabel(ref),
      evidence,
    });
    const grants = isPlainObject(binding) && Array.isArray(binding.grants) ? binding.grants : [];
    for (const grant of grants) {
      const grantRef = `capability:${grant}`;
      builder.addNode({ ref: grantRef, kind: "capability", label: String(grant), evidence });
      builder.addEdge({ kind: "grants", from: ref, to: grantRef, evidence });
    }
    const requires = isPlainObject(binding) && Array.isArray(binding.requires) ? binding.requires : [];
    for (const required of requires) {
      const capabilityRef = `capability:${required}`;
      builder.addNode({ ref: capabilityRef, kind: "capability", label: String(required), evidence });
      builder.addEdge({ kind: "requires", from: ref, to: capabilityRef, evidence });
    }
    const secrets = isPlainObject(binding) && Array.isArray(binding.secrets) ? binding.secrets : [];
    for (const secret of secrets) {
      const secretRef = `capability:secret:${secret}`;
      builder.addNode({ ref: secretRef, kind: "capability", label: `secret:${secret}`, evidence });
      builder.addEdge({ kind: "requires", from: ref, to: secretRef, evidence });
    }
  }
}

function parsePackageAuthority({ builder, value, path }) {
  const packageRef = nonEmptyString(value.package_ref)
    ?? nonEmptyString(value.name)
    ?? nonEmptyString(value.ref);
  if (packageRef === undefined) {
    return;
  }
  const normalizedPackageRef = packageRef.startsWith("package:")
    ? packageRef
    : `package:${packageRef}`;
  const evidence = authorityEvidence("package", path, null);
  builder.addNode({
    ref: normalizedPackageRef,
    kind: "package",
    label: authorityLabel(normalizedPackageRef),
    evidence,
  });
  const exportsValue = isPlainObject(value.exports) ? value.exports : {};
  for (const exported of flattenExportRefs(exportsValue)) {
    builder.addNode({
      ref: exported,
      kind: authorityKind(undefined, exported),
      label: authorityLabel(exported),
      evidence,
    });
    builder.addEdge({
      kind: "imports",
      from: normalizedPackageRef,
      to: exported,
      evidence,
    });
  }
}

function parseToubaSourceAuthority({ builder, content, path }) {
  if (content === undefined) {
    return;
  }
  const moduleName = content.match(/^\s*module\s+([A-Za-z_][\w.]*)/mu)?.[1];
  const localRefs = new Map();
  for (const match of content.matchAll(/^([ \t]*)(memory|function|tool|skill|agent|strategy|trigger)\s+([A-Za-z_][\w]*)\b/gmu)) {
    const kind = match[2] === "memory" ? "memory" : match[2];
    const name = match[3];
    const ref = kind === "memory"
      ? `memory:${moduleName ?? "source"}/${name}`
      : `${kind}:${moduleName ?? "source"}/${name}`;
    localRefs.set(name, ref);
    builder.addNode({
      ref,
      kind,
      label: name,
      evidence: authorityEvidence("source", path, `${path}:${lineNumberAt(content, match.index)}`),
    });
  }
  for (const match of content.matchAll(/^\s*import\s+(type|define|function|tool|skill|agent|strategy)?\s*([A-Za-z_][\w]*)\s+from\s+([A-Za-z_][\w.]*)/gmu)) {
    const importedName = match[2];
    const importedModule = match[3];
    const importedKind = match[1];
    if (importedKind === "type" || importedKind === "define") {
      continue;
    }
    const importRef = `${importedKind ?? "module"}:${importedModule}/${importedName}`;
    builder.addNode({
      ref: importRef,
      kind: authorityKind(importedKind, importRef) ?? "module",
      label: importedName,
      evidence: authorityEvidence("source", path, `${path}:${lineNumberAt(content, match.index)}`),
    });
    const moduleRef = moduleName === undefined ? `module:${path}` : `module:${moduleName}`;
    builder.addNode({
      ref: moduleRef,
      kind: "module",
      label: moduleName ?? path,
      evidence: authorityEvidence("source", path, `${path}:1`),
    });
    builder.addEdge({
      kind: "imports",
      from: moduleRef,
      to: importRef,
      evidence: authorityEvidence("source", path, `${path}:${lineNumberAt(content, match.index)}`),
    });
  }
  const blocks = splitToubaDeclarationBlocks(content);
  for (const block of blocks) {
    const ownerRef = localRefs.get(block.name);
    if (ownerRef === undefined) {
      continue;
    }
    for (const useMatch of block.body.matchAll(/^\s*uses\s+([A-Za-z_][\w]*)\b/gmu)) {
      const targetName = useMatch[1];
      const targetRef = localRefs.get(targetName);
      if (targetRef !== undefined) {
        builder.addEdge({
          kind: "uses",
          from: ownerRef,
          to: targetRef,
          evidence: authorityEvidence("source", path, `${path}:${block.startLine + lineNumberAt(block.body, useMatch.index) - 1}`),
        });
      }
    }
    for (const callMatch of block.body.matchAll(/^\s*callable_by\s+(?:strategy|agent)\s+([A-Za-z_][\w]*)\b/gmu)) {
      const callerRef = localRefs.get(callMatch[1]);
      if (callerRef !== undefined) {
        builder.addEdge({
          kind: "callable_by",
          from: callerRef,
          to: ownerRef,
          evidence: authorityEvidence("source", path, `${path}:${block.startLine + lineNumberAt(block.body, callMatch.index) - 1}`),
        });
      }
    }
    for (const memoryMatch of block.body.matchAll(/^\s*(?:uses\s+)?memory\s+([A-Za-z_][\w]*)\s+(read|write)\b/gmu)) {
      const memoryRef = localRefs.get(memoryMatch[1]);
      if (memoryRef !== undefined) {
        builder.addEdge({
          kind: "requires",
          from: ownerRef,
          to: memoryRef,
          access: memoryMatch[2],
          evidence: authorityEvidence("source", path, `${path}:${block.startLine + lineNumberAt(block.body, memoryMatch.index) - 1}`),
        });
      }
    }
    for (const humanMatch of block.body.matchAll(/\bhuman\.(approve|review)\b/gmu)) {
      const gateRef = `human_gate:${ownerRef}/${humanMatch[1]}`;
      const gateEvidence = authorityEvidence("source", path, `${path}:${block.startLine + lineNumberAt(block.body, humanMatch.index) - 1}`);
      builder.addNode({
        ref: gateRef,
        kind: "human_gate",
        label: `human.${humanMatch[1]}`,
        evidence: gateEvidence,
      });
      builder.addEdge({
        kind: "uses",
        from: ownerRef,
        to: gateRef,
        evidence: gateEvidence,
      });
    }
    if (block.kind === "trigger") {
      for (const runMatch of block.body.matchAll(/^\s*runs\s+(strategy|agent|skill)\s+([A-Za-z_][\w]*)\b/gmu)) {
        const targetRef = localRefs.get(runMatch[2]);
        if (targetRef !== undefined) {
          builder.addEdge({
            kind: "dispatches",
            from: ownerRef,
            to: targetRef,
            evidence: authorityEvidence("source", path, `${path}:${block.startLine + lineNumberAt(block.body, runMatch.index) - 1}`),
          });
        }
      }
    }
  }
}

function splitToubaDeclarationBlocks(content) {
  const declarations = [];
  for (const match of content.matchAll(/^([ \t]*)(tool|skill|agent|strategy|trigger)\s+([A-Za-z_][\w]*)\b/gmu)) {
    declarations.push({
      kind: match[2],
      name: match[3],
      index: match.index,
      startLine: lineNumberAt(content, match.index),
    });
  }
  return declarations.map((declaration, index) => {
    const next = declarations[index + 1]?.index ?? content.length;
    return {
      ...declaration,
      body: content.slice(declaration.index, next),
    };
  });
}

function flattenExportRefs(value) {
  const refs = [];
  if (Array.isArray(value)) {
    for (const item of value) {
      refs.push(...flattenExportRefs(item));
    }
    return refs;
  }
  if (typeof value === "string" && value.includes(":")) {
    refs.push(value);
    return refs;
  }
  if (isPlainObject(value)) {
    for (const key of ["ref", "target_ref", "id"]) {
      if (typeof value[key] === "string" && value[key].includes(":")) {
        refs.push(value[key]);
      }
    }
    for (const item of Object.values(value)) {
      refs.push(...flattenExportRefs(item));
    }
  }
  return Array.from(new Set(refs));
}

function readTextArtifact(path, relativePath, diagnostics) {
  try {
    return readFileSync(path, "utf8");
  } catch (cause) {
    diagnostics.push(authorityDiagnostic(
      "ToubaAuthorityGraphArtifactUnreadable",
      `cannot read ${relativePath}: ${cause.message}`,
      "warning",
      relativePath,
    ));
    return undefined;
  }
}

function readJsonArtifact(path, relativePath, diagnostics) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (cause) {
    diagnostics.push(authorityDiagnostic(
      "ToubaAuthorityGraphJsonInvalid",
      `${relativePath} is not valid JSON: ${cause.message}`,
      "warning",
      relativePath,
    ));
    return undefined;
  }
}

function authorityDiagnostic(code, message, severity = "warning", sourceRef = null) {
  return {
    severity,
    code,
    message,
    source_ref: sourceRef ?? null,
  };
}

function normalizeAuthorityDiagnostic(diagnostic) {
  return {
    severity: ["info", "warning", "error"].includes(diagnostic?.severity) ? diagnostic.severity : "warning",
    code: nonEmptyString(diagnostic?.code) ?? "ToubaAuthorityGraphDiagnostic",
    message: nonEmptyString(diagnostic?.message) ?? "authority graph diagnostic",
    source_ref: nonEmptyString(diagnostic?.source_ref) ?? nonEmptyString(diagnostic?.path) ?? null,
  };
}

function authorityKind(kind, ref) {
  if (["agent", "function", "skill", "tool", "strategy", "trigger", "human_gate", "memory", "capability", "package", "module"].includes(kind)) {
    return kind;
  }
  if (typeof ref !== "string") {
    return undefined;
  }
  if (ref.startsWith("agent:")) return "agent";
  if (ref.startsWith("function:")) return "function";
  if (ref.startsWith("skill:")) return "skill";
  if (ref.startsWith("tool:")) return "tool";
  if (ref.startsWith("strategy:")) return "strategy";
  if (ref.startsWith("trigger:")) return "trigger";
  if (ref.startsWith("human_gate:")) return "human_gate";
  if (ref.startsWith("memory:")) return "memory";
  if (ref.startsWith("capability:") || ref.startsWith("secret:")) return "capability";
  if (ref.startsWith("package:")) return "package";
  if (ref.startsWith("module:")) return "module";
  return undefined;
}

function authorityEvidence(source, path, sourceRef) {
  return {
    source,
    path: path ?? null,
    source_ref: sourceRefToString(sourceRef),
  };
}

function sourceRefToString(sourceRef) {
  if (sourceRef === null || sourceRef === undefined) {
    return null;
  }
  if (typeof sourceRef === "string") {
    return sourceRef;
  }
  if (isPlainObject(sourceRef)) {
    const sourceId = nonEmptyString(sourceRef.source_id);
    const startLine = Number.isInteger(sourceRef.start_line) ? sourceRef.start_line + 1 : undefined;
    if (sourceId !== undefined && startLine !== undefined) {
      return `${sourceId}:${startLine}`;
    }
    if (sourceId !== undefined) {
      return sourceId;
    }
  }
  return null;
}

function normalizeAuthorityRef(ref) {
  const value = nonEmptyString(ref);
  return value?.replace(/\s+/gu, " ");
}

function authorityLabel(ref) {
  const value = String(ref);
  const slash = value.lastIndexOf("/");
  if (slash >= 0 && slash < value.length - 1) {
    return value.slice(slash + 1);
  }
  const colon = value.lastIndexOf(":");
  if (colon >= 0 && colon < value.length - 1) {
    return value.slice(colon + 1);
  }
  return value;
}

function authoritySortKey(node) {
  const order = {
    module: "0",
    package: "1",
    strategy: "2",
    agent: "3",
    skill: "4",
    function: "5",
    tool: "6",
    human_gate: "7",
    memory: "8",
    capability: "9",
  };
  return `${order[node.kind] ?? "9"}:${node.ref}`;
}

function lineNumberAt(content, offset) {
  return content.slice(0, offset).split(/\r?\n/u).length;
}

function validateGovernanceRelationChangeRequest(request) {
  if (!isPlainObject(request) || request.schema_version !== GOVERNANCE_RELATION_CHANGE_SCHEMA_VERSION) {
    throw serviceError(
      "ToubaServeGovernanceRelationInvalid",
      `governance relation change must use ${GOVERNANCE_RELATION_CHANGE_SCHEMA_VERSION}`,
    );
  }
  if (!["add", "remove", "replace"].includes(request.operation)) {
    throw serviceError("ToubaServeGovernanceRelationInvalid", "governance relation operation must be add, remove or replace");
  }
  if (!isPlainObject(request.relation) || !["uses", "callable_by", "invokes_agent", "memory_access", "dispatches"].includes(request.relation.kind)) {
    throw serviceError(
      "ToubaServeGovernanceRelationInvalid",
      "governance relation kind must be uses, callable_by, invokes_agent, memory_access or dispatches",
    );
  }
  if (request.relation.kind === "memory_access" && !["read", "write"].includes(request.relation.access)) {
    throw serviceError("ToubaServeGovernanceRelationInvalid", "memory_access requires read or write access");
  }
  if (request.relation.kind === "dispatches" && request.operation !== "replace") {
    throw serviceError("ToubaServeGovernanceRelationInvalid", "dispatches supports replace operations only");
  }
  if (request.relation.kind !== "dispatches" && request.operation === "replace") {
    throw serviceError("ToubaServeGovernanceRelationInvalid", "replace is reserved for trigger dispatch targets");
  }
  return {
    schema_version: GOVERNANCE_RELATION_CHANGE_SCHEMA_VERSION,
    proposal_id: requiredNonEmptyString(request.proposal_id, "proposal_id"),
    operation: request.operation,
    relation: {
      kind: request.relation.kind,
      source_ref: requiredNonEmptyString(request.relation.source_ref, "relation.source_ref"),
      target_ref: requiredNonEmptyString(request.relation.target_ref, "relation.target_ref"),
      ...(request.relation.kind === "memory_access" ? { access: request.relation.access } : {}),
    },
    requested_by: normalizeActor(request.requested_by),
    reason: requiredNonEmptyString(request.reason, "reason"),
  };
}

function buildGovernanceRelationSourceDraft({ operation, projectRoot, relation }) {
  const sourceIndex = buildToubaEditableSourceIndex(projectRoot);
  const source = sourceIndex.declarations.get(relation.source_ref);
  const target = sourceIndex.declarations.get(relation.target_ref);
  if (source === undefined || target === undefined) {
    throw serviceError(
      "ToubaServeGovernanceRelationSourceMissing",
      "both governance relation endpoints must be declared in Touba source",
    );
  }
  assertGovernanceRelationCompatibility(relation.kind, source, target);
  if (source.path !== target.path) {
    throw serviceError(
      "ToubaServeGovernanceRelationCrossSourceUnsupported",
      "this governance relation spans multiple source files and cannot be edited as one atomic source change",
    );
  }
  const file = sourceIndex.files.get(source.path);
  const specs = governanceRelationMutationSpecs({
    access: relation.access,
    file,
    relationKind: relation.kind,
    source,
    target,
  });
  if (file === undefined || specs.some((spec) => spec.block === undefined)) {
    throw serviceError("ToubaServeGovernanceRelationSourceMissing", "governance relation source block is unavailable");
  }
  const states = specs.map((spec) => ({
    ...spec,
    present: spec.matcher.test(file.content.slice(spec.block.bodyStart, spec.block.end)),
    replacementPresent: spec.replacementMatcher?.test(file.content.slice(spec.block.bodyStart, spec.block.end)) ?? false,
  }));
  if (operation === "add" && states.every((state) => state.present)) {
    throw serviceError("ToubaServeGovernanceRelationAlreadyExists", "the governance relation already exists in source");
  }
  if (operation === "remove" && states.every((state) => !state.present)) {
    throw serviceError("ToubaServeGovernanceRelationNotFound", "the governance relation is not declared in source");
  }
  if (operation === "replace" && states.every((state) => state.replacementPresent)) {
    throw serviceError("ToubaServeGovernanceRelationAlreadyExists", "the trigger already dispatches to this target");
  }
  if (operation === "replace" && states.some((state) => !state.present)) {
    throw serviceError("ToubaServeGovernanceRelationNotFound", "the trigger dispatch target is not declared in source");
  }
  const content = states
    .filter((state) => operation === "add" ? !state.present : state.present)
    .sort((left, right) => right.block.headerStart - left.block.headerStart)
    .reduce((current, state) => (
      operation === "add"
        ? insertGovernanceRelationLine(current, state.block, state.line, state.kind)
        : operation === "remove"
          ? removeGovernanceRelationLine(current, state.block, state.matcher)
          : replaceGovernanceRelationLine(current, state.block, state.matcher, state.line)
    ), file.content);
  return { content, path: source.path };
}

function buildToubaEditableSourceIndex(projectRoot) {
  const diagnostics = [];
  const files = new Map();
  const declarations = new Map();
  for (const artifact of collectProjectArtifacts(projectRoot, diagnostics).filter((item) => item.kind === "source")) {
    const absolutePath = safeProjectPath(projectRoot, artifact.relative_path);
    const content = readFileSync(absolutePath, "utf8");
    const moduleName = content.match(/^\s*module\s+([A-Za-z_][\w.]*)/mu)?.[1];
    if (moduleName === undefined) {
      continue;
    }
    const fileDeclarations = new Map();
    for (const block of splitEditableToubaDeclarationBlocks(content, moduleName, artifact.relative_path)) {
      if (declarations.has(block.ref)) {
        throw serviceError(
          "ToubaServeGovernanceDeclarationAmbiguous",
          `authority reference ${block.ref} is declared more than once in source`,
        );
      }
      declarations.set(block.ref, block);
      fileDeclarations.set(block.ref, block);
    }
    files.set(artifact.relative_path, { content, declarations: fileDeclarations });
  }
  return { declarations, files };
}

function splitEditableToubaDeclarationBlocks(content, moduleName, path) {
  const declarations = [];
  for (const match of content.matchAll(/^(memory|function|tool|skill|agent|strategy|trigger)\s+([A-Za-z_][\w]*)\b[^\r\n]*(?:\r?\n|$)/gmu)) {
    declarations.push({
      bodyStart: match.index + match[0].length,
      headerStart: match.index,
      kind: match[1],
      name: match[2],
      path,
      ref: `${match[1]}:${moduleName}/${match[2]}`,
    });
  }
  return declarations.map((declaration, index) => ({
    ...declaration,
    end: declarations[index + 1]?.headerStart ?? content.length,
  }));
}

function assertGovernanceRelationCompatibility(kind, source, target) {
  if (kind === "memory_access") {
    if (target.kind !== "memory" || !["agent", "skill", "strategy", "tool"].includes(source.kind)) {
      throw serviceError(
        "ToubaServeGovernanceRelationIncompatible",
        "memory_access must connect an agent, skill, strategy or tool to a memory",
      );
    }
    return;
  }
  if (kind === "dispatches") {
    if (source.kind !== "trigger" || target.kind !== "strategy") {
      throw serviceError(
        "ToubaServeGovernanceRelationIncompatible",
        "dispatches must connect a trigger to a strategy",
      );
    }
    return;
  }
  if (kind === "invokes_agent") {
    if (target.kind !== "agent" || !["agent", "strategy"].includes(source.kind)) {
      throw serviceError(
        "ToubaServeGovernanceRelationIncompatible",
        "invokes_agent must connect a strategy or agent caller to an agent",
      );
    }
    return;
  }
  if (kind === "callable_by") {
    if (target.kind !== "agent" || !["agent", "strategy"].includes(source.kind)) {
      throw serviceError(
        "ToubaServeGovernanceRelationIncompatible",
        "callable_by must connect a strategy or agent caller to an agent",
      );
    }
    return;
  }
  const targetKinds = {
    agent: new Set(["agent", "skill", "tool"]),
    skill: new Set(["function", "skill", "tool"]),
    strategy: new Set(["agent", "function", "skill", "tool"]),
  };
  if (!targetKinds[source.kind]?.has(target.kind)) {
    throw serviceError(
      "ToubaServeGovernanceRelationIncompatible",
      `${source.kind} cannot declare a uses relation to ${target.kind}`,
    );
  }
}

function governanceRelationMutationSpecs({ access, file, relationKind, source, target }) {
  if (relationKind === "memory_access") {
    const line = source.kind === "tool"
      ? `uses memory ${target.name} ${access}`
      : `memory ${target.name} ${access}`;
    return [governanceLineMutationSpec({
      block: file?.declarations.get(source.ref),
      kind: "memory_access",
      line,
    })];
  }
  if (relationKind === "dispatches") {
    return [{
      block: file?.declarations.get(source.ref),
      kind: "dispatches",
      line: `runs strategy ${target.name}`,
      matcher: /^[ \t]+runs\s+strategy\s+[A-Za-z_][\w]*[ \t]*(?:\r?\n|$)/mu,
      replacementMatcher: governanceSourceLineMatcher(`runs strategy ${target.name}`),
    }];
  }
  if (relationKind === "invokes_agent") {
    return [
      governanceLineMutationSpec({
        block: file?.declarations.get(source.ref),
        kind: "uses",
        line: `uses ${target.name}`,
      }),
      governanceLineMutationSpec({
        block: file?.declarations.get(target.ref),
        kind: "callable_by",
        line: `callable_by ${source.kind} ${source.name}`,
      }),
    ];
  }
  const owner = relationKind === "callable_by" ? target : source;
  return [governanceLineMutationSpec({
    block: file?.declarations.get(owner.ref),
    kind: relationKind,
    line: governanceRelationSourceLine(relationKind, source, target),
  })];
}

function governanceLineMutationSpec({ block, kind, line }) {
  return {
    block,
    kind,
    line,
    matcher: governanceSourceLineMatcher(line),
  };
}

function governanceRelationSourceLine(kind, source, target) {
  if (kind === "callable_by") {
    return `callable_by ${source.kind} ${source.name}`;
  }
  return `uses ${target.name}`;
}

function governanceSourceLineMatcher(sourceLine) {
  const line = sourceLine
    .split(/\s+/u)
    .map(escapeRegex)
    .join("\\s+");
  return new RegExp(`^[ \\t]+${line}[ \\t]*(?:\\r?\\n|$)`, "mu");
}

function insertGovernanceRelationLine(content, block, line, kind) {
  const newline = content.includes("\r\n") ? "\r\n" : "\n";
  const body = content.slice(block.bodyStart, block.end);
  const boundaryPattern = kind === "uses"
    ? /^[ \t]+(?:callable_by\b|memory\b|do\s*$|on\s+failure\b)/mu
    : /^[ \t]+(?:memory\b|do\s*$)/mu;
  const boundary = boundaryPattern.exec(body);
  const trailingBlankLines = /(?<first>\r?\n)(?:[ \t]*\r?\n)+[ \t]*$/u.exec(body);
  const insertionOffset = boundary !== null
    ? block.bodyStart + boundary.index
    : trailingBlankLines !== null
      ? block.bodyStart + trailingBlankLines.index + trailingBlankLines.groups.first.length
      : block.end;
  return `${content.slice(0, insertionOffset)}    ${line}${newline}${content.slice(insertionOffset)}`;
}

function removeGovernanceRelationLine(content, block, matcher) {
  const body = content.slice(block.bodyStart, block.end);
  return `${content.slice(0, block.bodyStart)}${body.replace(matcher, "")}${content.slice(block.end)}`;
}

function replaceGovernanceRelationLine(content, block, matcher, line) {
  const body = content.slice(block.bodyStart, block.end);
  const replacement = body.replace(matcher, (matched) => {
    const indent = matched.match(/^[ \t]*/u)?.[0] ?? "    ";
    const newline = matched.endsWith("\r\n") ? "\r\n" : matched.endsWith("\n") ? "\n" : "";
    return `${indent}${line}${newline}`;
  });
  return `${content.slice(0, block.bodyStart)}${replacement}${content.slice(block.end)}`;
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validateChangeProposal({ projectRoot, proposal }) {
  if (!isPlainObject(proposal)) {
    throw serviceError("ToubaServeChangeInvalid", "change proposal must be a JSON object");
  }
  if (proposal.schema_version !== CHANGE_PROPOSAL_SCHEMA_VERSION) {
    throw serviceError("ToubaServeChangeInvalid", `change proposal schema_version must be ${CHANGE_PROPOSAL_SCHEMA_VERSION}`);
  }
  const proposalId = requiredNonEmptyString(proposal.proposal_id, "proposal_id");
  if (!CHANGE_ACTIONS.includes(proposal.action)) {
    throw serviceError("ToubaServeChangeInvalid", `change action must be one of ${CHANGE_ACTIONS.join(", ")}`);
  }
  if (!isPlainObject(proposal.target)) {
    throw serviceError("ToubaServeChangeInvalid", "change target must be an object");
  }
  const targetPath = requiredNonEmptyString(proposal.target.path, "target.path");
  safeProjectPath(projectRoot, targetPath);
  if (!isAllowedChangeTarget(targetPath)) {
    throw serviceError("ToubaServeChangeTargetRejected", "client changes may target .tb source or approved Touba project metadata only");
  }
  const content = requiredString(proposal.content, "content");
  if (Buffer.byteLength(content, "utf8") > MAX_CHANGE_CONTENT_BYTES) {
    throw serviceError("ToubaServeChangeTooLarge", `change content exceeds ${MAX_CHANGE_CONTENT_BYTES} bytes`);
  }
  const normalized = {
    schema_version: CHANGE_PROPOSAL_SCHEMA_VERSION,
    proposal_id: proposalId,
    action: proposal.action,
    target: {
      path: normalizeRelativePath(targetPath),
    },
    requested_by: normalizeActor(proposal.requested_by),
    reason: typeof proposal.reason === "string" ? proposal.reason : "",
    content,
    content_sha256: sha256Text(content),
  };
  const validations = validateChangeContent(normalized, { projectRoot });
  if (validations.some((item) => item.severity === "error")) {
    const error = serviceError("ToubaServeChangeValidationFailed", "change proposal failed validation");
    error.diagnostics = validations;
    throw error;
  }
  return normalized;
}

function validateChangeApplyRequest(request) {
  if (!isPlainObject(request)) {
    throw serviceError("ToubaServeChangeApplyInvalid", "change apply request must be a JSON object");
  }
  if (request.schema_version !== CHANGE_APPLY_SCHEMA_VERSION) {
    throw serviceError("ToubaServeChangeApplyInvalid", `change apply schema_version must be ${CHANGE_APPLY_SCHEMA_VERSION}`);
  }
  const proposalId = requiredNonEmptyString(request.proposal_id, "proposal_id");
  if (!CHANGE_DECISIONS.includes(request.decision)) {
    throw serviceError("ToubaServeChangeApplyInvalid", `change decision must be one of ${CHANGE_DECISIONS.join(", ")}`);
  }
  return {
    schema_version: CHANGE_APPLY_SCHEMA_VERSION,
    proposal_id: proposalId,
    decision: request.decision,
    decided_by: normalizeActor(request.decided_by),
    reason: typeof request.reason === "string" ? request.reason : "",
  };
}

function validateChangeContent(proposal, { projectRoot } = {}) {
  const diagnostics = [];
  const targetPath = proposal.target.path;
  if (CHANGE_TARGET_JSON_FILES.has(basename(targetPath))) {
    try {
      const document = JSON.parse(proposal.content);
      diagnostics.push(...validateProjectMetadataDocument(basename(targetPath), document));
    } catch (cause) {
      diagnostics.push(serviceDiagnostic("ToubaServeChangeJsonInvalid", `${targetPath} is not valid JSON: ${cause.message}`));
    }
  }
  if (targetPath.endsWith(".tb")) {
    diagnostics.push(...validateToubaSourcePatch(proposal.content, { projectRoot }));
  }
  if (isAllowedHandlerStubTarget(targetPath)) {
    diagnostics.push(...validateHandlerStubPatch(targetPath, proposal.content));
  }
  return diagnostics.length === 0
    ? [serviceDiagnostic("ToubaServeChangeContentValidated", "change content passed project-server validation", "info")]
    : diagnostics;
}

function validateChangeTargets(targets, { projectRoot } = {}) {
  const diagnostics = [];
  for (const target of targets) {
    for (const diagnostic of validateChangeContent({
      target: { path: target.path },
      content: target.content,
    }, { projectRoot })) {
      diagnostics.push({
        ...diagnostic,
        message: `${target.path}: ${diagnostic.message}`,
      });
    }
  }
  return diagnostics;
}

function validateProjectMetadataDocument(fileName, document) {
  if (!isPlainObject(document)) {
    return [serviceDiagnostic("ToubaServeChangeJsonShapeInvalid", `${fileName} must be a JSON object`)];
  }
  if (fileName === "touba.project.json") {
    return validateVersionedProjectMetadata({
      document,
      fileName,
      field: "project_version",
      expected: "touba-project-v1",
    });
  }
  if (fileName === "touba.manifest.json") {
    const diagnostics = validateVersionedProjectMetadata({
      document,
      fileName,
      field: "manifest_version",
      expected: "touba-manifest-v1",
    });
    for (const field of ["bindings", "triggers"]) {
      if (document[field] !== undefined && !isPlainObject(document[field])) {
        diagnostics.push(serviceDiagnostic("ToubaServeChangeManifestShapeInvalid", `${fileName}.${field} must be an object when present`));
      }
    }
    try {
      loadToolBindingManifestFromJson(JSON.stringify(document));
    } catch (cause) {
      diagnostics.push(serviceDiagnostic(
        "ToubaServeChangeManifestContractInvalid",
        `${fileName} does not satisfy the runtime manifest contract: ${cause.message}`,
      ));
    }
    return diagnostics;
  }
  if (fileName === "touba.package.json") {
    const diagnostics = validateVersionedProjectMetadata({
      document,
      fileName,
      field: "package_schema_version",
      expected: "touba-package-v0.1",
    });
    if (typeof document.name !== "string" || document.name.trim() === "") {
      diagnostics.push(serviceDiagnostic("ToubaServeChangePackageNameMissing", `${fileName}.name is required`));
    }
    if (typeof document.version !== "string" || !/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u.test(document.version)) {
      diagnostics.push(serviceDiagnostic("ToubaServeChangePackageVersionInvalid", `${fileName}.version must be semver`));
    }
    if (!isPlainObject(document.exports)) {
      diagnostics.push(serviceDiagnostic("ToubaServeChangePackageExportsMissing", `${fileName}.exports must be an object`));
    }
    return diagnostics;
  }
  if (fileName === "touba.ownership.json") {
    const diagnostics = validateVersionedProjectMetadata({
      document,
      fileName,
      field: "ownership_schema_version",
      expected: "touba-ownership-v0.1",
    });
    for (const field of ["teams", "owners", "review_gates"]) {
      if (document[field] !== undefined && !isPlainObject(document[field])) {
        diagnostics.push(serviceDiagnostic("ToubaServeChangeOwnershipShapeInvalid", `${fileName}.${field} must be an object when present`));
      }
    }
    if (document.grants !== undefined || document.secrets !== undefined || document.capabilities !== undefined) {
      diagnostics.push(serviceDiagnostic("ToubaServeChangeOwnershipAuthorityFieldForbidden", `${fileName} must not grant runtime authority`));
    }
    return diagnostics;
  }
  if (fileName === "touba.governance-actions.json") {
    return validateGovernanceActionMetadata({ document, fileName });
  }
  if (fileName === "touba.resources.json" || fileName === "resources.json") {
    const diagnostics = validateVersionedProjectMetadata({
      document,
      fileName,
      field: "resource_bindings_schema_version",
      expected: "touba-resource-bindings-v0.1",
    });
    if (!isPlainObject(document.resources)) {
      diagnostics.push(serviceDiagnostic("ToubaServeChangeResourcesMissing", `${fileName}.resources must be an object`));
    }
    return diagnostics;
  }
  return [];
}

function validateGovernanceActionMetadata({ document, fileName }) {
  const diagnostics = validateVersionedProjectMetadata({
    document,
    fileName,
    field: "governance_action_schema_version",
    expected: "touba-studio-governance-action-v0.1",
  });
  const allowedOperations = new Set(["grant_authority", "revoke_authority", "require_review", "set_quota"]);
  const allowedIntents = new Set(["grant", "revoke", "review", "quota"]);
  if (typeof document.operation !== "string" || !allowedOperations.has(document.operation)) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeGovernanceOperationInvalid", `${fileName}.operation is not supported`));
  }
  if (!isPlainObject(document.relation)) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeGovernanceRelationMissing", `${fileName}.relation must be an object`));
  } else {
    for (const field of ["kind", "source_ref", "target_ref"]) {
      if (typeof document.relation[field] !== "string" || document.relation[field].trim() === "") {
        diagnostics.push(serviceDiagnostic("ToubaServeChangeGovernanceRelationInvalid", `${fileName}.relation.${field} is required`));
      }
    }
  }
  if (!isPlainObject(document.intent)) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeGovernanceIntentMissing", `${fileName}.intent must be an object`));
  } else if (typeof document.intent.kind !== "string" || !allowedIntents.has(document.intent.kind)) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeGovernanceIntentInvalid", `${fileName}.intent.kind is not supported`));
  }
  if (!isPlainObject(document.review) || document.review.required !== true) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeGovernanceReviewRequired", `${fileName}.review.required must be true`));
  }
  return diagnostics;
}

function validateVersionedProjectMetadata({ document, expected, field, fileName }) {
  return document[field] === expected
    ? []
    : [serviceDiagnostic(
      "ToubaServeChangeMetadataSchemaInvalid",
      `${fileName}.${field} must be ${expected}`,
    )];
}

function projectChangeSummary(proposal) {
  const summary = {
    proposal_id: proposal.proposal_id,
    status: publicChangeStatus(proposal.status),
    action: proposal.action,
    target: proposal.target,
    requested_by: proposal.requested_by,
    proposed_at: proposal.proposed_at,
    proposal_reason: typeof proposal.reason === "string" ? proposal.reason : "",
    content_sha256: proposal.content_sha256,
    decided_at: proposal.decided_at ?? null,
    decided_by: proposal.decided_by ?? null,
    decision_reason: publicChangeDecisionReason(proposal),
  };
  if (Array.isArray(proposal.targets)) {
    summary.targets = publicChangeTargets(proposal);
    summary.target_count = proposal.targets.length;
  }
  return summary;
}

function projectChangeDetail(proposal, { projectRoot }) {
  return {
    ...projectChangeSummary(proposal),
    validations: proposal.validations ?? [],
    evidence: projectChangeEvidence(proposal, { projectRoot }),
  };
}

function publicChangeStatus(status) {
  return status === "proposed" ? "pending" : status;
}

function publicChangeDecisionReason(proposal) {
  if (proposal.status === "proposed") {
    return null;
  }
  return proposal.decision_reason ?? proposal.refusal_reason ?? "";
}

function projectChangeEvidence(proposal, { projectRoot }) {
  if (proposal.status === "proposed") {
    return null;
  }
  if (proposal.status === "applied" && isPlainObject(proposal.write_evidence)) {
    return proposal.write_evidence;
  }
  return {
    write_mode: proposal.status === "applied" ? "atomic_rename" : "none",
    project_root: projectRoot,
    relative_path: proposal.applied_path ?? proposal.target.path,
    ...(Array.isArray(proposal.targets)
      ? { relative_paths: proposal.targets.map((target) => target.path) }
      : {}),
  };
}

function changeTargets(proposal) {
  if (Array.isArray(proposal.targets)) {
    return proposal.targets;
  }
  return [{
    path: proposal.target.path,
    role: "project_file",
    content: proposal.content,
    content_sha256: proposal.content_sha256,
    base_content_exists: proposal.base_content_exists,
    base_content_sha256: proposal.base_content_sha256,
  }];
}

function publicChangeTargets(proposal) {
  return changeTargets(proposal).map((target) => ({
    path: target.path,
    role: target.role ?? "project_file",
    content_sha256: target.content_sha256,
  }));
}

function applySingleChangeTarget({ projectRoot, target }) {
  const targetPath = safeProjectPath(projectRoot, target.path);
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.touba-write-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, target.content, "utf8");
  replaceFileFromTemp(tempPath, targetPath);
  return {
    write_mode: "atomic_rename",
    project_root: projectRoot,
    relative_path: target.path,
  };
}

function applyChangeTargetsTransaction({ projectRoot, proposalId, targets, decidedAt }) {
  const toubaRoot = join(projectRoot, ".touba");
  const lockPath = join(toubaRoot, "project-change.lock");
  mkdirSync(toubaRoot, { recursive: true });
  try {
    mkdirSync(lockPath);
  } catch (cause) {
    if (cause?.code === "EEXIST") {
      throw serviceError("ToubaServeChangeProjectLocked", "another project change is being applied");
    }
    throw cause;
  }

  const transactionId = `${proposalId.replace(/[^A-Za-z0-9_.-]/gu, "_")}-${Date.now()}`;
  const transactionRoot = join(toubaRoot, "change-transactions", transactionId);
  const stageRoot = join(transactionRoot, "stage");
  const backupRoot = join(transactionRoot, "backup");
  const journalPath = join(transactionRoot, "journal.json");
  const journal = {
    schema_version: "touba-project-change-transaction-v0.1",
    transaction_id: transactionId,
    proposal_id: proposalId,
    status: "preparing",
    prepared_at: decidedAt,
    targets: targets.map((target) => ({
      path: target.path,
      content_sha256: target.content_sha256,
      base_content_exists: target.base_content_exists,
      base_content_sha256: target.base_content_sha256,
    })),
  };
  mkdirSync(stageRoot, { recursive: true });
  mkdirSync(backupRoot, { recursive: true });
  writeTransactionJournal(journalPath, journal);

  const entries = targets.map((target, index) => {
    const targetPath = safeProjectPath(projectRoot, target.path);
    const stagePath = join(stageRoot, `${index}.next`);
    const backupPath = join(backupRoot, `${index}.previous`);
    writeFileSync(stagePath, target.content, "utf8");
    if (target.base_content_exists) {
      writeFileSync(backupPath, readFileSync(targetPath));
    }
    return {
      target,
      targetPath,
      stagePath,
      backupPath,
    };
  });
  journal.status = "prepared";
  writeTransactionJournal(journalPath, journal);

  const committed = [];
  try {
    journal.status = "committing";
    writeTransactionJournal(journalPath, journal);
    for (const entry of entries) {
      mkdirSync(dirname(entry.targetPath), { recursive: true });
      replaceFileFromTemp(entry.stagePath, entry.targetPath);
      committed.push(entry);
    }
    journal.status = "committed";
    journal.committed_at = new Date().toISOString();
    writeTransactionJournal(journalPath, journal);
  } catch (cause) {
    const rollbackFailures = [];
    for (const entry of [...committed].reverse()) {
      try {
        if (entry.target.base_content_exists) {
          const restorePath = `${entry.targetPath}.touba-restore-${process.pid}-${Date.now()}`;
          writeFileSync(restorePath, readFileSync(entry.backupPath));
          replaceFileFromTemp(restorePath, entry.targetPath);
        } else {
          rmSync(entry.targetPath, { force: true });
        }
      } catch (rollbackCause) {
        rollbackFailures.push(`${entry.target.path}: ${rollbackCause.message}`);
      }
    }
    journal.status = rollbackFailures.length === 0 ? "rolled_back" : "rollback_failed";
    journal.failed_at = new Date().toISOString();
    journal.error = cause.message;
    journal.rollback_failures = rollbackFailures;
    writeTransactionJournal(journalPath, journal);
    const error = serviceError(
      rollbackFailures.length === 0
        ? "ToubaServeChangeTransactionRolledBack"
        : "ToubaServeChangeTransactionRecoveryRequired",
      rollbackFailures.length === 0
        ? "multi-file project change failed and was rolled back"
        : "multi-file project change requires operator recovery",
    );
    error.diagnostics = rollbackFailures.map((message) =>
      serviceDiagnostic("ToubaServeChangeRollbackFailed", message)
    );
    throw error;
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }

  return {
    write_mode: "recoverable_transaction",
    project_root: projectRoot,
    relative_path: targets[0].path,
    relative_paths: targets.map((target) => target.path),
    transaction_id: transactionId,
  };
}

export function recoverProjectChangeTransactions({
  projectRoot,
  recoveredAt = new Date().toISOString(),
}) {
  const toubaRoot = join(resolve(projectRoot), ".touba");
  const transactionsRoot = join(toubaRoot, "change-transactions");
  const lockPath = join(toubaRoot, "project-change.lock");
  if (!existsSync(transactionsRoot)) {
    rmSync(lockPath, { recursive: true, force: true });
    return { status: "clean", recovered: [] };
  }
  const recovered = [];
  const failures = [];
  for (const entry of readdirSync(transactionsRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const transactionRoot = join(transactionsRoot, entry.name);
    const journalPath = join(transactionRoot, "journal.json");
    if (!existsSync(journalPath)) continue;
    let journal;
    try {
      journal = JSON.parse(readFileSync(journalPath, "utf8"));
    } catch (cause) {
      failures.push(`${entry.name}: ${cause.message}`);
      continue;
    }
    if (
      journal.schema_version !== "touba-project-change-transaction-v0.1"
      || !Array.isArray(journal.targets)
    ) {
      failures.push(`${entry.name}: invalid transaction journal`);
      continue;
    }
    if (["committed", "rolled_back", "recovered"].includes(journal.status)) {
      continue;
    }
    const transactionFailures = [];
    if (["committing", "rollback_failed"].includes(journal.status)) {
      journal.targets.forEach((target, index) => {
        try {
          recoverProjectChangeTarget({
            projectRoot,
            target,
            backupPath: join(transactionRoot, "backup", `${index}.previous`),
          });
        } catch (cause) {
          transactionFailures.push(`${target.path}: ${cause.message}`);
        }
      });
    }
    if (transactionFailures.length === 0) {
      journal.status = "recovered";
      journal.recovered_at = recoveredAt;
      journal.rollback_failures = [];
      writeTransactionJournal(journalPath, journal);
      recovered.push(journal.transaction_id ?? entry.name);
    } else {
      journal.status = "rollback_failed";
      journal.rollback_failures = transactionFailures;
      writeTransactionJournal(journalPath, journal);
      failures.push(...transactionFailures.map((message) => `${entry.name}: ${message}`));
    }
  }
  if (failures.length > 0) {
    const error = serviceError(
      "ToubaServeChangeTransactionRecoveryRequired",
      "one or more interrupted project changes require operator recovery",
    );
    error.diagnostics = failures.map((message) =>
      serviceDiagnostic("ToubaServeChangeRollbackFailed", message)
    );
    throw error;
  }
  rmSync(lockPath, { recursive: true, force: true });
  return {
    status: recovered.length === 0 ? "clean" : "recovered",
    recovered,
  };
}

function recoverProjectChangeTarget({ projectRoot, target, backupPath }) {
  const targetPath = safeProjectPath(projectRoot, target.path);
  const targetExists = existsSync(targetPath);
  const currentDigest = targetExists ? sha256Buffer(readFileSync(targetPath)) : null;
  if (target.base_content_exists) {
    if (!existsSync(backupPath)) {
      throw serviceError("ToubaServeChangeBackupMissing", "transaction backup is missing");
    }
    const backup = readFileSync(backupPath);
    if (sha256Buffer(backup) !== target.base_content_sha256) {
      throw serviceError("ToubaServeChangeBackupInvalid", "transaction backup digest is invalid");
    }
    if (currentDigest === target.base_content_sha256) {
      return;
    }
    if (currentDigest !== target.content_sha256) {
      throw serviceError("ToubaServeChangeRecoveryConflict", "target changed after the interrupted transaction");
    }
    mkdirSync(dirname(targetPath), { recursive: true });
    const restorePath = `${targetPath}.touba-recovery-${process.pid}-${Date.now()}`;
    writeFileSync(restorePath, backup);
    replaceFileFromTemp(restorePath, targetPath);
    return;
  }
  if (!targetExists) return;
  if (currentDigest !== target.content_sha256) {
    throw serviceError("ToubaServeChangeRecoveryConflict", "new target changed after the interrupted transaction");
  }
  rmSync(targetPath, { force: true });
}

function replaceFileFromTemp(tempPath, targetPath) {
  try {
    renameSync(tempPath, targetPath);
  } catch (cause) {
    if (!["EEXIST", "EPERM"].includes(cause?.code) || !existsSync(targetPath)) {
      throw cause;
    }
    const previousPath = `${targetPath}.touba-previous-${process.pid}-${Date.now()}`;
    renameSync(targetPath, previousPath);
    try {
      renameSync(tempPath, targetPath);
      rmSync(previousPath, { force: true });
    } catch (replaceCause) {
      if (!existsSync(targetPath) && existsSync(previousPath)) {
        renameSync(previousPath, targetPath);
      }
      throw replaceCause;
    }
  }
}

function writeTransactionJournal(path, journal) {
  writeFileSync(path, `${JSON.stringify(journal, null, 2)}\n`, "utf8");
}

function validateToubaSourcePatch(content, { projectRoot } = {}) {
  const validationRoot = mkdtempSync(join(tmpdir(), "touba-studio-change-"));
  const sourcePath = join(validationRoot, "proposal.tb");
  try {
    writeFileSync(sourcePath, content, "utf8");
    const result = spawnSync(process.execPath, [
      TOUBA_CLI_PATH,
      "compile",
      sourcePath,
      "--stdout",
    ], {
      cwd: projectRoot ?? process.cwd(),
      env: process.env,
      encoding: "utf8",
    });
    if (result.status !== 0) {
      const details = String(result.stderr || result.stdout || "touba compile failed").trim().split(/\r?\n/u)[0];
      return [serviceDiagnostic("ToubaServeChangeToubaCompileFailed", details || "touba compile failed")];
    }
    try {
      const air = JSON.parse(result.stdout);
      if (air?.air_schema_version !== "air-minimal-v0.1") {
        return [serviceDiagnostic("ToubaServeChangeToubaCompileFailed", "compiler output is not an AIR document")];
      }
    } catch {
      return [serviceDiagnostic("ToubaServeChangeToubaCompileFailed", "compiler output is not valid JSON")];
    }
    return [];
  } finally {
    rmSync(validationRoot, { recursive: true, force: true });
  }
}

function isAllowedChangeTarget(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  if (normalized.startsWith(".git/") || normalized.startsWith(".touba/") || normalized.startsWith("node_modules/")) {
    return false;
  }
  return normalized.endsWith(".tb")
    || CHANGE_TARGET_JSON_FILES.has(basename(normalized))
    || isAllowedHandlerStubTarget(normalized);
}

function isAllowedHandlerStubTarget(relativePath) {
  const normalized = normalizeRelativePath(relativePath);
  return normalized.startsWith("handlers/")
    && normalized.endsWith(".handler.mjs")
    && !normalized.split("/").includes("..");
}

function validateHandlerStubPatch(targetPath, content) {
  const diagnostics = [];
  if (!content.includes("project client generated handler stub v0.1")) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeHandlerStubMarkerMissing", `${targetPath} must be a client-generated handler stub`));
  }
  if (!content.includes("HandlerStubNotImplemented")) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeHandlerStubNotImplementedMissing", `${targetPath} must remain explicitly not implemented`));
  }
  const forbiddenPatterns = [
    /\bimport\b/u,
    /\brequire\s*\(/u,
    /\bfetch\s*\(/u,
    /\bchild_process\b/u,
    /\bexec\s*\(/u,
    /\bspawn\s*\(/u,
    /\bprocess\.env\b/u,
    /\bfs\b/u,
    /\bnode:/u,
    /\bhttps?\b/u,
    /\beval\s*\(/u,
    /\bFunction\s*\(/u,
  ];
  if (forbiddenPatterns.some((pattern) => pattern.test(content))) {
    diagnostics.push(serviceDiagnostic("ToubaServeChangeHandlerStubUnsafeContent", `${targetPath} contains code outside the handler-stub guard`));
  }
  return diagnostics;
}

function safeProjectPath(projectRoot, relativePath) {
  if (typeof relativePath !== "string" || relativePath.trim() === "") {
    throw serviceError("ToubaServeChangeInvalid", "project path must be a non-empty string");
  }
  if (relativePath.includes("\0") || isAbsolute(relativePath)) {
    throw serviceError("ToubaServeChangePathRejected", "project path must be relative and safe");
  }
  const normalized = normalizeRelativePath(relativePath);
  const absolutePath = resolve(projectRoot, normalized);
  if (!isPathInside(projectRoot, absolutePath)) {
    throw serviceError("ToubaServeChangePathRejected", "project path escapes the project root");
  }
  return absolutePath;
}

function changeTargetBaseEvidence(projectRoot, relativePath) {
  const targetPath = safeProjectPath(projectRoot, relativePath);
  const exists = existsSync(targetPath);
  return {
    base_content_exists: exists,
    base_content_sha256: exists ? sha256Buffer(readFileSync(targetPath)) : null,
  };
}

function assertChangeTargetUnchanged(proposal, targetPath) {
  if (!Object.hasOwn(proposal, "base_content_exists") || !Object.hasOwn(proposal, "base_content_sha256")) {
    throw serviceError(
      "ToubaServeChangeBaseEvidenceMissing",
      "change proposal predates source-drift protection and must be proposed again",
    );
  }
  const exists = existsSync(targetPath);
  const digest = exists ? sha256Buffer(readFileSync(targetPath)) : null;
  if (exists !== proposal.base_content_exists || digest !== proposal.base_content_sha256) {
    throw serviceError(
      "ToubaServeChangeSourceDrift",
      "change target changed after validation; propose the governance change again",
    );
  }
}

function loadChangeProposalStore(changeProposalsPath) {
  if (!existsSync(changeProposalsPath)) {
    return {
      schema_version: CHANGE_STORE_SCHEMA_VERSION,
      proposals: [],
    };
  }
  const store = JSON.parse(readFileSync(changeProposalsPath, "utf8"));
  if (store.schema_version !== CHANGE_STORE_SCHEMA_VERSION || !Array.isArray(store.proposals)) {
    throw serviceError("ToubaServeChangeStoreInvalid", `change proposal store must use ${CHANGE_STORE_SCHEMA_VERSION}`);
  }
  return store;
}

function saveChangeProposalStore(changeProposalsPath, store) {
  mkdirSync(dirname(changeProposalsPath), { recursive: true });
  writeFileSync(changeProposalsPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function readContractFixture({ contractsRoot, schemaVersion }) {
  assertKnownContract(schemaVersion);
  const fixturePath = join(contractsRoot, "fixtures", "valid", `${schemaVersion}.json`);
  if (!existsSync(fixturePath)) {
    throw serviceError("ToubaServeContractMissing", `${schemaVersion} fixture is missing`);
  }
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function readContractSchema({ contractsRoot, schemaVersion }) {
  assertKnownContract(schemaVersion);
  const schemaPath = join(contractsRoot, "schemas", `${schemaVersion}.schema.json`);
  if (!existsSync(schemaPath)) {
    throw serviceError("ToubaServeSchemaMissing", `${schemaVersion} schema is missing`);
  }
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

function readOptionalContractFile({ contractsRoot, filePath, schemaVersion, errorCode, message }) {
  if (!existsSync(filePath)) {
    return undefined;
  }
  if (statSync(filePath).isDirectory()) {
    throw serviceError(errorCode, `${filePath} is a directory`);
  }
  let value;
  try {
    value = JSON.parse(readFileSync(filePath, "utf8"));
  } catch (cause) {
    throw serviceError(errorCode, `${filePath} is not valid JSON: ${cause.message}`);
  }
  validateContractPayload({
    contractsRoot,
    schemaVersion,
    value,
    errorCode,
    message,
  });
  return value;
}

function unavailableRunSummary(generatedAt = new Date().toISOString()) {
  return {
    schema_version: "touba-run-summary-v1",
    run_id: "run:unavailable",
    status: "unavailable",
    entrypoint_ref: "none",
    started_at: generatedAt,
    completed_at: null,
    trigger_ref: null,
    trace_ref: "trace:unavailable",
    approvals_pending: [],
    refusals: [
      {
        code: "ToubaServeRunUnavailable",
        message: "No project run summary is available.",
        source_ref: null,
      },
    ],
    budgets: {
      steps_used: 0,
      tool_calls_used: 0,
      provider_calls_used: 0,
    },
  };
}

function emptyTraceTimeline() {
  return {
    schema_version: "touba-trace-timeline-v1",
    run_id: "run:unavailable",
    trace_ref: "trace:unavailable",
    events: [],
  };
}

function validateContractPayload({ contractsRoot, schemaVersion, value, errorCode, message }) {
  const schema = readContractSchema({ contractsRoot, schemaVersion });
  const diagnostics = validateObject(schema, value);
  if (diagnostics.length > 0) {
    const error = serviceError(errorCode, message);
    error.diagnostics = diagnostics;
    throw error;
  }
}

function contractFilesExist({ contractsRoot, schemaVersion }) {
  return existsSync(join(contractsRoot, "schemas", `${schemaVersion}.schema.json`))
    && existsSync(join(contractsRoot, "fixtures", "valid", `${schemaVersion}.json`));
}

function assertKnownContract(schemaVersion) {
  if (!PRODUCT_SURFACE_CONTRACTS.includes(schemaVersion)) {
    throw serviceError("ToubaServeContractUnknown", `${schemaVersion} is not a Touba contract`);
  }
}

function loadHumanDecisionStore(humanDecisionsPath) {
  if (!existsSync(humanDecisionsPath)) {
    return {
      schema_version: HUMAN_DECISION_STORE_SCHEMA_VERSION,
      decisions: [],
    };
  }
  const store = JSON.parse(readFileSync(humanDecisionsPath, "utf8"));
  if (store.schema_version !== HUMAN_DECISION_STORE_SCHEMA_VERSION || !Array.isArray(store.decisions)) {
    throw serviceError("ToubaServeHumanDecisionStoreInvalid", `human decision store must use ${HUMAN_DECISION_STORE_SCHEMA_VERSION}`);
  }
  return store;
}

function saveHumanDecisionStore(humanDecisionsPath, store) {
  mkdirSync(dirname(humanDecisionsPath), { recursive: true });
  writeFileSync(humanDecisionsPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function loadMobilePairingStore(mobilePairingsPath) {
  if (!existsSync(mobilePairingsPath)) {
    return {
      schema_version: MOBILE_PAIRING_STORE_SCHEMA_VERSION,
      pairings: [],
    };
  }
  if (statSync(mobilePairingsPath).isDirectory()) {
    throw serviceError("ToubaServeMobilePairingStoreInvalid", "mobile pairing store path is a directory");
  }
  let store;
  try {
    store = JSON.parse(readFileSync(mobilePairingsPath, "utf8"));
  } catch (cause) {
    throw serviceError("ToubaServeMobilePairingStoreInvalid", `mobile pairing store is not valid JSON: ${cause.message}`);
  }
  if (store?.schema_version !== MOBILE_PAIRING_STORE_SCHEMA_VERSION || !Array.isArray(store.pairings)) {
    throw serviceError("ToubaServeMobilePairingStoreInvalid", `mobile pairing store must use ${MOBILE_PAIRING_STORE_SCHEMA_VERSION}`);
  }
  return store;
}

function saveMobilePairingStore(mobilePairingsPath, store) {
  mkdirSync(dirname(mobilePairingsPath), { recursive: true });
  writeFileSync(mobilePairingsPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
}

function activeMobilePairingTokenAuthorized({
  mobilePairingsPath,
  bearerToken,
  now = new Date().toISOString(),
}) {
  let store;
  try {
    store = loadMobilePairingStore(mobilePairingsPath);
  } catch {
    return false;
  }
  const tokenDigest = sha256Text(bearerToken);
  const nowMs = Date.parse(now);
  return store.pairings.some((pairing) =>
    pairing.status === "active"
    && typeof pairing.token_sha256 === "string"
    && constantTimeTextEqual(pairing.token_sha256, tokenDigest)
    && Date.parse(pairing.expires_at) > nowMs
  );
}

function readHumanRequestStore(humanRequestsPath) {
  let store;
  try {
    store = JSON.parse(readFileSync(humanRequestsPath, "utf8"));
  } catch (cause) {
    throw serviceError("ToubaServeHumanRequestStoreInvalid", `human request store is not valid JSON: ${cause.message}`);
  }
  if (
    store?.schema_version !== HUMAN_REQUEST_STORE_SCHEMA_VERSION
    || !Array.isArray(store.approvals)
    || !Array.isArray(store.reviews)
  ) {
    throw serviceError("ToubaServeHumanRequestStoreInvalid", `human request store must use ${HUMAN_REQUEST_STORE_SCHEMA_VERSION}`);
  }
  return store;
}

function persistSandboxCheckpoint({
  checkpoint,
  contractsRoot,
  createdAt,
  effectPolicy,
  executionKind,
  humanRequestsPath,
  result,
  sandboxCheckpointsPath,
  targetRef,
}) {
  const requestId = `${checkpoint.approval_ref}:${checkpoint.run_id}`;
  const humanRequest = humanRequestFromCheckpoint({
    checkpoint,
    createdAt,
    requestId,
  });
  validateContractPayload({
    contractsRoot,
    schemaVersion: humanRequest.schema_version,
    value: humanRequest,
    errorCode: "ToubaServePendingHumanRequestInvalid",
    message: "runtime checkpoint could not be represented as a human request",
  });
  const humanStore = existsSync(humanRequestsPath)
    ? readHumanRequestStore(humanRequestsPath)
    : { schema_version: HUMAN_REQUEST_STORE_SCHEMA_VERSION, approvals: [], reviews: [] };
  const requestCollection = humanRequest.mode === "approval" ? humanStore.approvals : humanStore.reviews;
  if (!requestCollection.some((candidate) => candidate.request_id === requestId)) {
    requestCollection.push(humanRequest);
    saveHumanRequestStore(humanRequestsPath, humanStore);
  }

  const checkpointStore = loadSandboxCheckpointStore(sandboxCheckpointsPath);
  if (!checkpointStore.records.some((candidate) => candidate.request_id === requestId)) {
    checkpointStore.records.push({
      request_id: requestId,
      approval_ref: checkpoint.approval_ref,
      run_id: checkpoint.run_id,
      target_ref: targetRef,
      execution_kind: executionKind,
      effect_policy: effectPolicy,
      status: "pending",
      created_at: createdAt,
      checkpoint,
      paused_result: result,
    });
    saveSandboxCheckpointStore(sandboxCheckpointsPath, checkpointStore);
  }
  return humanRequest;
}

function humanRequestFromCheckpoint({ checkpoint, createdAt, requestId }) {
  const expiresAt = new Date(Date.parse(createdAt) + 24 * 60 * 60 * 1000).toISOString();
  const traceRef = `trace:${checkpoint.run_id}`;
  if (checkpoint.kind === "agent_human_review") {
    return {
      schema_version: "touba-human-review-request-v1",
      request_id: requestId,
      run_id: checkpoint.run_id,
      mode: "human_review",
      requester_ref: checkpoint.requester_ref ?? checkpoint.agent_ref ?? checkpoint.entry_ref,
      review_prompt: checkpoint.review_prompt ?? "Review the requested agent decision.",
      context_summary: checkpoint.review_reason ?? `Review requested by ${checkpoint.agent_ref ?? checkpoint.entry_ref}.`,
      allowed_outcomes: ["accepted", "changes_requested", "rejected", "escalated"],
      expires_at: expiresAt,
      trace_ref: traceRef,
      redaction: "payload_minimized",
    };
  }
  return {
    schema_version: "touba-approval-request-v1",
    request_id: requestId,
    run_id: checkpoint.run_id,
    mode: "approval",
    requester_ref: checkpoint.requester_ref ?? checkpoint.caller_ref ?? checkpoint.entry_ref,
    capability_ref: checkpoint.required_by_ref ?? checkpoint.graph_ref ?? checkpoint.entry_ref,
    reason: `Approval required by ${checkpoint.graph_ref ?? checkpoint.entry_ref}.`,
    summary: `Resume ${checkpoint.entry_ref} at its declared human approval boundary.`,
    allowed_decisions: ["approve", "reject"],
    expires_at: expiresAt,
    trace_ref: traceRef,
    redaction: "payload_minimized",
  };
}

function saveHumanRequestStore(humanRequestsPath, store) {
  writeJsonStoreAtomic(humanRequestsPath, store);
}

function loadSandboxCheckpointStore(sandboxCheckpointsPath) {
  if (!existsSync(sandboxCheckpointsPath)) {
    return { schema_version: SANDBOX_CHECKPOINT_STORE_SCHEMA_VERSION, records: [] };
  }
  let store;
  try {
    store = JSON.parse(readFileSync(sandboxCheckpointsPath, "utf8"));
  } catch (cause) {
    throw serviceError("ToubaServeSandboxCheckpointStoreInvalid", `sandbox checkpoint store is not valid JSON: ${cause.message}`);
  }
  if (store?.schema_version !== SANDBOX_CHECKPOINT_STORE_SCHEMA_VERSION || !Array.isArray(store.records)) {
    throw serviceError("ToubaServeSandboxCheckpointStoreInvalid", `sandbox checkpoint store must use ${SANDBOX_CHECKPOINT_STORE_SCHEMA_VERSION}`);
  }
  return store;
}

function saveSandboxCheckpointStore(sandboxCheckpointsPath, store) {
  writeJsonStoreAtomic(sandboxCheckpointsPath, store);
}

function runtimeDecisionFromStoredDecision(decision) {
  if (decision.schema_version === "touba-approval-decision-v1") {
    if (decision.decision === "approve") return "approved";
    if (decision.decision === "reject") return "rejected";
    return "cancelled";
  }
  if (decision.schema_version === "touba-human-review-decision-v1") {
    return decision.outcome === "accepted" ? "approved" : "rejected";
  }
  throw serviceError("ToubaServeDecisionContractUnsupported", "stored decision cannot resume a sandbox checkpoint");
}

function writeJsonStoreAtomic(filePath, value) {
  mkdirSync(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
  renameSync(tempPath, filePath);
}

function schemaVersionToDecisionSchema(schemaVersion) {
  if (schemaVersion === "touba-approval-request-v1") {
    return "touba-approval-decision-v1";
  }
  if (schemaVersion === "touba-human-review-request-v1") {
    return "touba-human-review-decision-v1";
  }
  throw serviceError("ToubaServePendingHumanRequestInvalid", `unsupported pending request schema ${schemaVersion}`);
}

export function readProjectEventJournal(eventJournalPath) {
  if (!existsSync(eventJournalPath)) {
    return [];
  }
  if (statSync(eventJournalPath).isDirectory()) {
    throw serviceError("ToubaServeEventJournalInvalid", "event journal path is a directory");
  }
  const content = readFileSync(eventJournalPath, "utf8");
  const events = [];
  const lines = content.split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      continue;
    }
    let event;
    try {
      event = JSON.parse(line);
    } catch (cause) {
      throw serviceError("ToubaServeEventJournalInvalid", `event journal line ${index + 1} is not valid JSON: ${cause.message}`);
    }
    if (event?.schema_version !== PROJECT_EVENT_SCHEMA_VERSION || !Number.isInteger(event.sequence)) {
      throw serviceError("ToubaServeEventJournalInvalid", `event journal line ${index + 1} is not a Touba project event`);
    }
    events.push(event);
  }
  return events.sort((left, right) => left.sequence - right.sequence);
}

export function appendProjectEventJournal({ eventJournalPath, limit = DEFAULT_EVENT_JOURNAL_LIMIT, event }) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10000) {
    throw serviceError("ToubaServeEventJournalLimitInvalid", "event journal limit must be an integer between 1 and 10000");
  }
  const events = [...readProjectEventJournal(eventJournalPath), event]
    .sort((left, right) => left.sequence - right.sequence)
    .slice(-limit);
  mkdirSync(dirname(eventJournalPath), { recursive: true });
  writeFileSync(
    eventJournalPath,
    `${events.map((item) => JSON.stringify(item)).join("\n")}\n`,
    "utf8",
  );
}

export function replayProjectEvents({ eventJournalPath, lastEventId }) {
  if (lastEventId === undefined || lastEventId === null || String(lastEventId).trim() === "") {
    const events = readProjectEventJournal(eventJournalPath);
    return {
      status: "replayed",
      requested_last_event_id: null,
      events: [],
      retained_from_sequence: events[0]?.sequence ?? null,
      retained_to_sequence: events.at(-1)?.sequence ?? null,
    };
  }
  const sequence = parseProjectEventId(lastEventId);
  const events = readProjectEventJournal(eventJournalPath);
  if (sequence === null) {
    return {
      status: "resync_required",
      requested_last_event_id: lastEventId ?? null,
      events: [],
      retained_from_sequence: events[0]?.sequence ?? null,
      retained_to_sequence: events.at(-1)?.sequence ?? null,
      reason: "invalid_last_event_id",
    };
  }
  if (events.length === 0) {
    return {
      status: "replayed",
      requested_last_event_id: lastEventId,
      events: [],
      retained_from_sequence: null,
      retained_to_sequence: null,
    };
  }
  const firstSequence = events[0].sequence;
  const lastSequence = events.at(-1).sequence;
  if (sequence < firstSequence - 1) {
    return {
      status: "resync_required",
      requested_last_event_id: lastEventId,
      events: [],
      retained_from_sequence: firstSequence,
      retained_to_sequence: lastSequence,
      reason: "event_window_expired",
    };
  }
  return {
    status: "replayed",
    requested_last_event_id: lastEventId,
    events: events.filter((event) => event.sequence > sequence),
    retained_from_sequence: firstSequence,
    retained_to_sequence: lastSequence,
  };
}

function latestProjectEventSequence(events) {
  return events.length === 0 ? 0 : Math.max(...events.map((event) => event.sequence));
}

function parseProjectEventId(eventId) {
  if (typeof eventId !== "string" || eventId.trim() === "") {
    return null;
  }
  const match = /^evt_(\d+)$/u.exec(eventId.trim());
  if (match === null) {
    return null;
  }
  const sequence = Number.parseInt(match[1], 10);
  return Number.isInteger(sequence) && sequence >= 0 ? sequence : null;
}

function projectHumanDecision(decision) {
  if (decision.schema_version === "touba-approval-decision-v1") {
    return {
      source_schema_version: decision.schema_version,
      request_id: decision.request_id,
      run_id: decision.run_id,
      trace_ref: decision.trace_ref,
      user_ref: decision.user_ref,
      device_ref: decision.device_ref,
      decision_kind: "approval",
      result: decision.decision,
      decided_by: decision.decided_by,
      decided_at: decision.decided_at,
      comment: decision.comment,
      client_ref: decision.client_ref,
      accepted_at: decision.accepted_at ?? decision.decided_at,
    };
  }
  return {
    source_schema_version: decision.schema_version,
    request_id: decision.request_id,
    run_id: decision.run_id,
    trace_ref: decision.trace_ref,
    user_ref: decision.user_ref,
    device_ref: decision.device_ref,
    decision_kind: "human_review",
    result: decision.outcome,
    decided_by: decision.reviewed_by,
    decided_at: decision.reviewed_at,
    comment: decision.comment,
    client_ref: decision.client_ref,
    accepted_at: decision.accepted_at ?? decision.reviewed_at,
  };
}

function decodeDecisionPath(pathname) {
  const segments = pathname.slice("/decisions/".length).split("/");
  if (segments.length !== 2 || segments.some((item) => item === "")) {
    throw serviceError("ToubaServeDecisionPathInvalid", "decision detail path must be /decisions/<schema_version>/<request_id>");
  }
  return segments.map((segment) => decodeURIComponent(segment));
}

function authorized(request, token, mobilePairingsPath) {
  if (constantTimeTextEqual(request.headers.authorization, `Bearer ${token}`)) {
    return true;
  }
  const bearerToken = bearerTokenFromAuthorization(request.headers.authorization);
  if (bearerToken === undefined) {
    return false;
  }
  return activeMobilePairingTokenAuthorized({
    mobilePairingsPath,
    bearerToken,
  });
}

function constantTimeTextEqual(actual, expected) {
  if (typeof actual !== "string" || typeof expected !== "string") {
    return false;
  }
  const actualDigest = createHash("sha256").update(actual, "utf8").digest();
  const expectedDigest = createHash("sha256").update(expected, "utf8").digest();
  return timingSafeEqual(actualDigest, expectedDigest)
    && Buffer.byteLength(actual, "utf8") === Buffer.byteLength(expected, "utf8");
}

function bearerTokenFromAuthorization(authorization) {
  if (typeof authorization !== "string") {
    return undefined;
  }
  const match = /^Bearer\s+(.+)$/u.exec(authorization.trim());
  return match === null ? undefined : nonEmptyString(match[1]);
}

export function requiredIdentityPermission(method, pathname) {
  if (method === "GET" && pathname === "/health") return null;
  if (method === "POST" && pathname === "/mobile/pairings/accept") return null;
  if (method === "GET" && pathname === "/events") return "executions.read";
  if (method === "POST" && pathname === "/runs/sandbox") return "executions.run";
  if (method === "POST" && pathname === "/runs/sandbox/resume") return "executions.run";
  if (method === "POST" && pathname === "/triggers/fire") return "executions.run";
  if (pathname.startsWith("/interactions/sessions")) {
    return method === "GET" ? "executions.read" : "executions.run";
  }
  if (pathname.startsWith("/interaction-assets")) {
    return method === "GET" ? "executions.read" : "executions.run";
  }
  if (pathname.startsWith("/decisions")) {
    return method === "POST" ? "decisions.act" : "decisions.read";
  }
  if (pathname.startsWith("/deployments")) {
    if (method === "GET" || pathname === "/deployments/plan") return "deployments.read";
    if (pathname === "/deployments/publish") return "deployments.publish";
    return "deployments.activate";
  }
  if (
    pathname === "/governance/relations/propose"
    || pathname === "/elements/propose"
    || pathname === "/changes/propose"
  ) {
    return "governance.propose";
  }
  if (pathname === "/changes/apply") return "governance.apply";
  if (pathname.startsWith("/changes")) return "governance.read";
  if (pathname === "/project/refresh") return "projects.manage";
  if (method === "GET") return "projects.read";
  return "projects.manage";
}

export async function authorizeHumanIdentity({
  accessToken,
  controlPlaneUrl,
  fetchImpl = fetch,
  permission,
  serviceToken,
}) {
  if (typeof accessToken !== "string" || accessToken.trim() === "") {
    return { active: false, allowed: false };
  }
  let endpoint;
  try {
    endpoint = new URL("/auth/introspect", controlPlaneUrl);
  } catch {
    throw serviceError(
      "ToubaServeIdentityNotConfigured",
      "identity control-plane URL must be an absolute HTTP(S) URL",
    );
  }
  let response;
  try {
    response = await fetchImpl(endpoint, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-touba-service-token": serviceToken,
      },
      body: JSON.stringify({ access_token: accessToken.trim() }),
      signal: AbortSignal.timeout(3000),
    });
  } catch (cause) {
    throw serviceError(
      "ToubaServeIdentityUnavailable",
      `identity control plane is unavailable: ${cause.message}`,
    );
  }
  if (!response.ok) {
    throw serviceError(
      "ToubaServeIdentityUnavailable",
      `identity control plane refused introspection (${response.status})`,
    );
  }
  let result;
  try {
    result = await response.json();
  } catch {
    throw serviceError(
      "ToubaServeIdentityUnavailable",
      "identity control plane returned an invalid response",
    );
  }
  const permissions = Array.isArray(result.permissions) ? result.permissions : [];
  const active = result.active === true && nonEmptyString(result.user?.id) !== undefined;
  return {
    active,
    allowed: active
      && (permissions.includes("*") || permissions.includes(permission)),
    organization_id: result.organization_id,
    session_id: result.session_id,
    user: result.user,
  };
}

function bindHumanActor(body, field, identity) {
  if (identity === null) return body;
  const userId = nonEmptyString(identity.user?.id);
  if (userId === undefined) {
    throw serviceError(
      "ToubaServeIdentityUnauthorized",
      "identity introspection did not return a user id",
    );
  }
  const actor = ["requested_by", "decided_by"].includes(field)
    ? { kind: "user", id: userId }
    : userId.startsWith("user:")
      ? userId
      : `user:${userId}`;
  return {
    ...(body ?? {}),
    [field]: actor,
  };
}

async function readJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw serviceError("ToubaServeBodyTooLarge", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw serviceError("ToubaServeJsonInvalid", `request body is not valid JSON: ${cause.message}`);
  }
}

async function readOptionalJsonBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw serviceError("ToubaServeBodyTooLarge", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  if (chunks.length === 0 || size === 0) {
    return {};
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw serviceError("ToubaServeJsonInvalid", `request body is not valid JSON: ${cause.message}`);
  }
}

async function readBinaryBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw serviceError("ToubaServeInteractionAssetTooLarge", `request body exceeds ${limit} bytes`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function safeHeaderFileName(value) {
  return String(value ?? "asset")
    .replaceAll(/[\r\n"\\]/gu, "_")
    .slice(0, 160);
}

function applyCorsHeaders(request, response) {
  const origin = singleHeaderValue(request.headers.origin);
  if (origin === undefined) {
    return false;
  }
  if (!isAllowedStudioOrigin(origin)) {
    return false;
  }
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader(
    "access-control-allow-headers",
    "authorization, content-type, last-event-id, x-touba-identity-token",
  );
  response.setHeader("access-control-max-age", "600");
  response.setHeader("vary", "Origin");
  return true;
}

function singleHeaderValue(value) {
  if (Array.isArray(value)) {
    return value.length === 1 ? value[0] : undefined;
  }
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function isAllowedStudioOrigin(origin) {
  try {
    const url = new URL(origin);
    if (url.protocol === "tauri:" && url.hostname === "localhost") {
      return true;
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      return false;
    }
    return isLoopbackStudioHost(url.hostname);
  } catch {
    return false;
  }
}

function isLoopbackStudioHost(hostname) {
  return hostname === "localhost"
    || hostname === "127.0.0.1"
    || hostname === "::1"
    || hostname === "tauri.localhost"
    || hostname.endsWith(".localhost");
}

function openEventStream({ request, response, eventClients, nextEvent, eventJournalPath }) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
  });
  eventClients.add(response);
  const replay = replayProjectEvents({
    eventJournalPath,
    lastEventId: request.headers["last-event-id"],
  });
  if (replay.status === "resync_required") {
    writeSse(response, "touba.server.resync_required", nextEvent("touba.server.resync_required", {
      schema_version: EVENT_STREAM_SCHEMA_VERSION,
      requested_last_event_id: replay.requested_last_event_id,
    retained_from_sequence: replay.retained_from_sequence,
    retained_to_sequence: replay.retained_to_sequence,
    reason: replay.reason,
    }));
  } else {
    for (const event of replay.events) {
      writeSse(response, event.type, event);
    }
  }
  writeSse(response, "touba.server.ready", nextEvent("touba.server.ready", {
    schema_version: EVENT_STREAM_SCHEMA_VERSION,
    endpoint: "/events",
    transport: "server_sent_events",
    event_schema_version: PROJECT_EVENT_SCHEMA_VERSION,
    replay: {
      request_header: "Last-Event-ID",
      event_id_field: "event_id",
      retention: "bounded_journal",
      retained_from_sequence: replay.retained_from_sequence,
      retained_to_sequence: replay.retained_to_sequence,
    },
  }));
  request.on("close", () => {
    eventClients.delete(response);
  });
}

function publishEvent(eventClients, type, payload, nextEvent) {
  const event = nextEvent(type, payload);
  for (const client of eventClients) {
    writeSse(client, type, event);
  }
}

function interactionOperationEventPayload(operation, overrides = {}) {
  return {
    schema_version: INTERACTION_OPERATION_SCHEMA_VERSION,
    operation_id: operation.operation_id,
    session_id: operation.session_id,
    target_ref: operation.target_ref,
    run_id: operation.run_id,
    status: operation.status,
    event_count: operation.event_count,
    current_event: operation.current_event,
    error: operation.error,
    ...overrides,
  };
}

function interactionCompletionEventType(status) {
  if (status === "awaiting_human") return "interaction.run.awaiting_human";
  if (status === "cancelled") return "interaction.run.cancelled";
  if (status === "failed") return "interaction.run.failed";
  return "interaction.run.completed";
}

function publishRefreshEvents(eventClients, report, nextEvent) {
  publishEvent(eventClients, "project.changed", report, nextEvent);
  if (report.changes.changed_artifacts.length > 0) {
    publishEvent(eventClients, "artifact.changed", {
      schema_version: PROJECT_REFRESH_SCHEMA_VERSION,
      project_root: report.project_root,
      refreshed_at: report.refreshed_at,
      changed_artifacts: report.changes.changed_artifacts,
    }, nextEvent);
  }
  publishEvent(eventClients, "validation.changed", {
    schema_version: PROJECT_REFRESH_SCHEMA_VERSION,
    status: report.status,
    refreshed_at: report.refreshed_at,
    diagnostics: report.diagnostics,
  }, nextEvent);
}

function writeSse(response, event, data) {
  if (typeof data?.event_id === "string") {
    response.write(`id: ${data.event_id}\n`);
  }
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function httpStatusForError(code) {
  if (
    code === "ToubaServeUnauthorized"
    || code === "ToubaServeIdentityUnauthorized"
  ) return 401;
  if (code === "ToubaServeIdentityPermissionDenied") return 403;
  if (code === "ToubaServeIdentityUnavailable") return 503;
  if (
    code === "ToubaServeDecisionReplayRejected"
    || code === "ToubaServeDecisionRequestMismatch"
    || code === "ToubaServeSandboxDecisionRequired"
    || code === "ToubaServeSandboxDecisionMismatch"
    || code === "ToubaServeChangeProposalDuplicate"
    || code === "ToubaServeChangeAlreadyDecided"
    || code === "ToubaServeChangeProjectLocked"
    || code === "ToubaServeChangeTransactionRecoveryRequired"
    || code === "ToubaServeChangeRecoveryConflict"
    || code === "ToubaServeMobilePairingDuplicate"
    || code === "ToubaServeMobilePairingReplayRejected"
    || code === "ToubaServeMobilePairingRevoked"
    || code === "ToubaServeInteractionMessageReplayRejected"
    || code === "ToubaServeInteractionResumeMismatch"
    || code === "ToubaServeInteractionSessionBusy"
    || code === "ToubaServeInteractionSessionArchived"
    || code === "ToubaServeInteractionOperationNotCancellable"
    || code === "ToubaServeInteractionOperationStateInvalid"
  ) return 409;
  if (code === "ToubaServeMobilePairingExpired" || code === "ToubaServeDecisionRequestExpired") return 410;
  if (
    code === "ToubaServeRouteNotFound"
    || code === "ToubaServeContractUnknown"
    || code === "ToubaServeDecisionNotFound"
    || code === "ToubaServeDecisionRequestNotFound"
    || code === "ToubaServePendingHumanRequestNotFound"
    || code === "ToubaServeChangeProposalNotFound"
    || code === "ToubaServeMobilePairingUnknown"
    || code === "ToubaServeSandboxCheckpointNotFound"
    || code === "ToubaDeploymentRevisionNotFound"
    || code === "ToubaServeInteractionSessionNotFound"
    || code === "ToubaServeInteractionOperationNotFound"
    || code === "ToubaServeInteractionAssetNotFound"
  ) return 404;
  if (
    code === "ToubaServeBodyTooLarge"
    || code === "ToubaServeChangeTooLarge"
    || code === "ToubaServeInteractionAssetTooLarge"
    || code === "ToubaServeInteractionMessageTooLarge"
  ) return 413;
  if (
    code === "ToubaServeChangeTargetRejected"
    || code === "ToubaServeChangePathRejected"
    || code === "ToubaServeMobilePairingScopeRejected"
    || code === "ToubaServeSandboxExternalEffectsRejected"
    || code === "ToubaServeDecisionIdentityUnauthorized"
    || code === "ToubaServeDeploymentTargetInsecure"
    || code === "ToubaDeploymentInsecureTargetRejected"
    || code === "ToubaServeInteractionAssetMediaTypeRejected"
  ) return 403;
  if (
    code === "ToubaServeDeploymentTargetNotConfigured"
    || code === "ToubaServeDeploymentBlocked"
    || code === "ToubaDeploymentRollbackUnavailable"
  ) return 409;
  if (
    code === "ToubaDeploymentUnauthorized"
    || code === "ToubaDeploymentTargetRequestFailed"
    || code === "ToubaDeploymentTargetUnavailable"
    || code === "ToubaDeploymentRevisionCorrupt"
  ) return 502;
  if (
    code === "ToubaServeSandboxAirUnavailable"
    || code === "ToubaServeSandboxTargetNotFound"
  ) return 404;
  if (
    code === "ToubaServeDecisionInvalid"
    || code === "ToubaServeDecisionContractUnsupported"
    || code === "ToubaServeDecisionPathInvalid"
    || code === "ToubaServeJsonInvalid"
    || code === "ToubaServeRefreshInvalid"
    || code === "ToubaServeChangeInvalid"
    || code === "ToubaServeChangeApplyInvalid"
    || code === "ToubaServeChangeValidationFailed"
    || code === "ToubaServeEventJournalInvalid"
    || code === "ToubaServeEventJournalLimitInvalid"
    || code === "ToubaServeRunSummaryInvalid"
    || code === "ToubaServeTraceTimelineInvalid"
    || code === "ToubaServeTriggerStatusInvalid"
    || code === "ToubaServeHumanRequestStoreInvalid"
    || code === "ToubaServePendingHumanRequestInvalid"
    || code === "ToubaServeMobilePairingInvalid"
    || code === "ToubaServeMobilePairingStoreInvalid"
    || code === "ToubaServeSandboxInvalid"
    || code === "ToubaServeSandboxManifestInvalid"
    || code === "ToubaServeSandboxResultInvalid"
    || code === "ToubaServeSandboxRuntimeRejected"
    || code === "ToubaServeAgentDecisionProviderInvalid"
    || code === "ToubaServeChangeSetInvalid"
    || code === "ToubaServeDeploymentInvalid"
    || code === "ToubaServeDeploymentTargetInvalid"
    || code === "ToubaServeInteractionSessionInvalid"
    || code === "ToubaServeInteractionOperationInvalid"
    || code === "ToubaServeInteractionSessionStoreInvalid"
    || code === "ToubaServeInteractionMessageInvalid"
    || code === "ToubaServeInteractionResumeInvalid"
    || code === "ToubaServeInteractionTargetInvalid"
    || code === "ToubaServeInteractionAssetInvalid"
    || code === "ToubaServeInteractionAssetDigestMismatch"
    || code === "ToubaServeInteractionAssetStoreInvalid"
    || code === "ToubaServeInteractionAssetPathInvalid"
    || String(code ?? "").startsWith("ToubaServeElement")
    || String(code ?? "").startsWith("ToubaDeployment")
  ) return 400;
  if (code === "ToubaServeInteractionAssetCorrupt") return 500;
  return 500;
}

function parseArgs(rawArgs) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    eventJournalLimit: DEFAULT_EVENT_JOURNAL_LIMIT,
    help: false,
    strict: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--contracts-root") {
      options.contractsRoot = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--project-root") {
      options.projectRoot = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--secrets") {
      options.secretsPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--human-decisions") {
      options.humanDecisionsPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--change-proposals") {
      options.changeProposalsPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--event-journal") {
      options.eventJournalPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--event-journal-limit") {
      options.eventJournalLimit = Number.parseInt(requiredValue(arg, rawArgs, ++index), 10);
    } else if (arg === "--run-summary") {
      options.runSummaryPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--trace-timeline") {
      options.traceTimelinePath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--trigger-status") {
      options.triggerStatusPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--human-requests") {
      options.humanRequestsPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--mobile-pairings") {
      options.mobilePairingsPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--host") {
      options.host = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--port") {
      options.port = Number.parseInt(requiredValue(arg, rawArgs, ++index), 10);
    } else if (arg === "--auth-token-env") {
      options.authTokenEnv = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--identity-control-plane-url") {
      options.identityControlPlaneUrl = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--identity-service-token-env") {
      options.identityServiceTokenEnv = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--deployment-target-url") {
      options.deploymentTargetUrl = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--deployment-target-token-env") {
      options.deploymentTargetTokenEnv = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--agent-decision-provider") {
      options.agentDecisionProviderPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--agent-decision-provider=")) {
      options.agentDecisionProviderPath = arg.slice("--agent-decision-provider=".length);
    } else if (arg === "--agent-decision-provider-metadata-json") {
      options.agentDecisionProviderMetadata = parseJsonObjectOption(
        "--agent-decision-provider-metadata-json",
        requiredValue(arg, rawArgs, ++index),
      );
    } else if (arg.startsWith("--agent-decision-provider-metadata-json=")) {
      options.agentDecisionProviderMetadata = parseJsonObjectOption(
        "--agent-decision-provider-metadata-json",
        arg.slice("--agent-decision-provider-metadata-json=".length),
      );
    } else if (arg === "--agent-decision-provider-content-mode") {
      options.agentDecisionProviderContentMode = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--agent-decision-provider-content-mode=")) {
      options.agentDecisionProviderContentMode = arg.slice("--agent-decision-provider-content-mode=".length);
    } else if (arg === "--agent-decision-provider-initial-mode") {
      options.agentDecisionProviderInitialMode = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--agent-decision-provider-initial-mode=")) {
      options.agentDecisionProviderInitialMode = arg.slice("--agent-decision-provider-initial-mode=".length);
    } else if (arg === "--agent-decision-provider-timeout-ms") {
      options.agentDecisionProviderTimeoutMs = Number.parseInt(requiredValue(arg, rawArgs, ++index), 10);
    } else if (arg.startsWith("--agent-decision-provider-timeout-ms=")) {
      options.agentDecisionProviderTimeoutMs = Number.parseInt(arg.slice("--agent-decision-provider-timeout-ms=".length), 10);
    } else if (arg === "--agent-decision-provider-max-retries") {
      options.agentDecisionProviderMaxRetries = Number.parseInt(requiredValue(arg, rawArgs, ++index), 10);
    } else if (arg.startsWith("--agent-decision-provider-max-retries=")) {
      options.agentDecisionProviderMaxRetries = Number.parseInt(arg.slice("--agent-decision-provider-max-retries=".length), 10);
    } else if (arg === "--strict") {
      options.strict = true;
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else {
      throw serviceError("ToubaServeOptionUnknown", `unknown option ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw serviceError("ToubaServePortInvalid", "--port must be an integer between 0 and 65535");
  }
  if (!Number.isInteger(options.eventJournalLimit) || options.eventJournalLimit < 1 || options.eventJournalLimit > 10000) {
    throw serviceError("ToubaServeEventJournalLimitInvalid", "--event-journal-limit must be an integer between 1 and 10000");
  }
  if (
    options.agentDecisionProviderContentMode !== undefined
    && !["inline", "opaque_refs"].includes(options.agentDecisionProviderContentMode)
  ) {
    throw serviceError("ToubaServeAgentDecisionProviderInvalid", "--agent-decision-provider-content-mode must be inline or opaque_refs");
  }
  if (
    options.agentDecisionProviderInitialMode !== undefined
    && !["summary", "capabilities"].includes(options.agentDecisionProviderInitialMode)
  ) {
    throw serviceError("ToubaServeAgentDecisionProviderInvalid", "--agent-decision-provider-initial-mode must be summary or capabilities");
  }
  if (
    options.agentDecisionProviderTimeoutMs !== undefined
    && (!Number.isInteger(options.agentDecisionProviderTimeoutMs) || options.agentDecisionProviderTimeoutMs < 1)
  ) {
    throw serviceError("ToubaServeAgentDecisionProviderInvalid", "--agent-decision-provider-timeout-ms must be a positive integer");
  }
  if (
    options.agentDecisionProviderMaxRetries !== undefined
    && (!Number.isInteger(options.agentDecisionProviderMaxRetries) || options.agentDecisionProviderMaxRetries < 0)
  ) {
    throw serviceError("ToubaServeAgentDecisionProviderInvalid", "--agent-decision-provider-max-retries must be a non-negative integer");
  }
  return options;
}

function requiredValue(option, args, index) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw serviceError("ToubaServeOptionValueMissing", `${option} requires a value`);
  }
  return value;
}

function parseJsonObjectOption(option, rawValue) {
  try {
    const parsed = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new Error("expected object");
    }
    return parsed;
  } catch (error) {
    throw serviceError(
      "ToubaServeAgentDecisionProviderInvalid",
      `${option} must be a JSON object: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function loadAgentDecisionProviderFromPath(providerPath) {
  const moduleUrl = pathToFileURL(resolve(providerPath)).href;
  const providerModule = await import(moduleUrl);
  const provider =
    providerModule.decideAgentCapability
    ?? providerModule.decide
    ?? providerModule.default;
  if (typeof provider !== "function") {
    throw serviceError(
      "ToubaServeAgentDecisionProviderInvalid",
      "provider module must export decideAgentCapability, decide, or a default function",
    );
  }
  const metadata = providerModule.provider_metadata
    ?? providerModule.providerMetadata
    ?? provider.metadata
    ?? providerModule.default?.metadata;
  return metadata === undefined
    ? provider
    : {
      decide: provider,
      metadata,
    };
}

function usage() {
  return [
    "Usage: touba serve [--project-root <path>] [--secrets <touba.secrets.json>] [--contracts-root <path>] [--human-decisions <human-decisions.json>] [--human-requests <path>] [--mobile-pairings <path>] [--change-proposals <path>] [--event-journal <path>] [--event-journal-limit <n>] [--run-summary <path>] [--trace-timeline <path>] [--trigger-status <path>] [--host 127.0.0.1] [--port 8791] [--auth-token-env NAME] [--identity-control-plane-url URL --identity-service-token-env NAME] [--deployment-target-url URL --deployment-target-token-env NAME] [--agent-decision-provider <provider.mjs>] [--agent-decision-provider-initial-mode summary|capabilities] [--strict] [--quiet]",
    "",
    "Starts the live Touba project server for client, Mobile and contract clients.",
    "",
    "Defaults:",
    `  host: ${DEFAULT_HOST}`,
    `  port: ${DEFAULT_PORT}`,
    `  secrets: ${DEFAULT_DEV_SECRETS_PROFILE_PATH} when present`,
    `  human_decisions: ${DEFAULT_HUMAN_DECISIONS_PATH}`,
    `  change_proposals: ${DEFAULT_CHANGE_PROPOSALS_PATH}`,
    `  event_journal: ${DEFAULT_EVENT_JOURNAL_PATH}`,
    `  event_journal_limit: ${DEFAULT_EVENT_JOURNAL_LIMIT}`,
    `  run_summary: ${DEFAULT_RUN_SUMMARY_PATH}`,
    `  trace_timeline: ${DEFAULT_TRACE_TIMELINE_PATH}`,
    `  trigger_status: ${DEFAULT_TRIGGER_STATUS_PATH}`,
    `  human_requests: ${DEFAULT_HUMAN_REQUESTS_PATH}`,
    `  mobile_pairings: ${DEFAULT_MOBILE_PAIRINGS_PATH}`,
    "",
    "Live endpoints:",
    "  GET  /state",
    "  GET  /events",
    "  GET  /project",
    "  POST /project/refresh",
    "  GET  /authority/graph",
    "  GET  /identity",
    "  GET  /runs/current",
    "  POST /runs/sandbox",
    "  GET  /interactions/sessions",
    "  POST /interactions/sessions",
    "  GET  /interactions/sessions/<session_id>",
    "  POST /interactions/sessions/<session_id>/archive",
    "  POST /interactions/sessions/<session_id>/messages",
    "  POST /interactions/sessions/<session_id>/resume",
    "  GET  /interactions/sessions/<session_id>/operations/<operation_id>",
    "  POST /interactions/sessions/<session_id>/operations/<operation_id>/cancel",
    "  POST /interaction-assets",
    "  GET  /interaction-assets/<handle>",
    "  GET  /triggers",
    "  POST /triggers/fire",
    "  GET  /triggers/queue-health",
    "  GET  /supply-chain/status",
    "  GET  /governance/readiness",
    "  GET  /deployments",
    "  POST /deployments/plan",
    "  POST /deployments/publish",
    "  POST /deployments/activate",
    "  POST /deployments/rollback",
    "  GET  /mobile/notifications",
    "  POST /mobile/pairings/request",
    "  POST /mobile/pairings/accept",
    "  POST /mobile/pairings/revoke",
    "  GET  /approvals/pending/current",
    "  GET  /decisions",
    "  GET  /decisions/<schema_version>/<request_id>",
    "  GET  /changes",
    "  GET  /changes/<proposal_id>",
    "  POST /decisions",
    "  POST /changes/propose",
    "  POST /changes/apply",
    "  POST /governance/relations/propose",
    "  POST /elements/propose",
  ].join("\n");
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function assertDeploymentAction(request, expectedAction) {
  if (request.action !== expectedAction) {
    throw serviceError(
      "ToubaServeDeploymentInvalid",
      `deployment endpoint requires action ${expectedAction}`,
    );
  }
  if (["plan", "publish"].includes(expectedAction) && !["dev", "prod"].includes(request.profile)) {
    throw serviceError("ToubaServeDeploymentInvalid", `${expectedAction} requires profile dev or prod`);
  }
  if (
    expectedAction === "activate"
    && (typeof request.revision_id !== "string" || !/^[a-f0-9]{64}$/u.test(request.revision_id))
  ) {
    throw serviceError("ToubaServeDeploymentInvalid", "activate requires a SHA-256 revision_id");
  }
}

function assertDeploymentTargetConfigured({ deploymentTargetToken, deploymentTargetUrl }) {
  if (
    typeof deploymentTargetUrl !== "string"
    || deploymentTargetUrl.trim() === ""
    || typeof deploymentTargetToken !== "string"
    || deploymentTargetToken.length < 32
  ) {
    throw serviceError(
      "ToubaServeDeploymentTargetNotConfigured",
      "deployment target URL and strong server-side token are required",
    );
  }
  let target;
  try {
    target = new URL(deploymentTargetUrl);
  } catch {
    throw serviceError("ToubaServeDeploymentTargetInvalid", "deployment target URL is invalid");
  }
  if (target.protocol !== "https:" && !isLoopbackHost(target.hostname)) {
    throw serviceError("ToubaServeDeploymentTargetInsecure", "remote deployment targets require HTTPS");
  }
}

function assertIdentityControlPlaneConfigured({ controlPlaneUrl, serviceToken }) {
  if (
    typeof controlPlaneUrl !== "string"
    || controlPlaneUrl.trim() === ""
    || typeof serviceToken !== "string"
    || serviceToken.length < 32
  ) {
    throw serviceError(
      "ToubaServeIdentityNotConfigured",
      "identity control-plane URL and strong server-side token are required",
    );
  }
  let target;
  try {
    target = new URL(controlPlaneUrl);
  } catch {
    throw serviceError(
      "ToubaServeIdentityNotConfigured",
      "identity control-plane URL must be an absolute HTTP(S) URL",
    );
  }
  if (!["http:", "https:"].includes(target.protocol)) {
    throw serviceError(
      "ToubaServeIdentityNotConfigured",
      "identity control-plane URL must use HTTP or HTTPS",
    );
  }
  if (target.protocol !== "https:" && !isLoopbackHost(target.hostname)) {
    throw serviceError(
      "ToubaServeIdentityNotConfigured",
      "remote identity control planes require HTTPS",
    );
  }
}

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serviceDiagnostic(code, message, severity = "error") {
  return { severity, code, message };
}

function nonEmptyString(value) {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function requiredMobilePairingString(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw serviceError("ToubaServeMobilePairingInvalid", `${field} must be a non-empty string`);
  }
  return value.trim();
}

function normalizeMobilePairingScopes(value) {
  const requestedScopes = Array.isArray(value) && value.length > 0
    ? value
    : ["approvals:read", "reviews:read", "decisions:write", "notifications:read", "events:read"];
  const scopes = Array.from(new Set(requestedScopes.map((item) => requiredMobilePairingString(item, "scope"))));
  const rejected = scopes.filter((scope) => !MOBILE_PAIRING_ALLOWED_SCOPES.includes(scope));
  if (rejected.length > 0) {
    throw serviceError("ToubaServeMobilePairingScopeRejected", `mobile pairing scopes are not allowed: ${rejected.join(", ")}`);
  }
  return scopes.sort();
}

function parseMobilePairingInstant(value, field) {
  const text = requiredMobilePairingString(value, field);
  const timestamp = Date.parse(text);
  if (!Number.isFinite(timestamp)) {
    throw serviceError("ToubaServeMobilePairingInvalid", `${field} must be an ISO timestamp`);
  }
  return timestamp;
}

function compactTimestamp(value) {
  return value.replaceAll(/[^0-9A-Za-z]/gu, "").slice(0, 14) || "now";
}

function buildMobilePairingDeepLink({
  pairingId,
  serverUrl,
  token,
  deviceRef,
  userRef,
  nonce,
  expiresAt,
  scopes,
}) {
  const params = new URLSearchParams({
    pairing_id: pairingId,
    server_url: serverUrl,
    token,
    device: deviceRef,
    user: userRef,
    nonce,
    expires: expiresAt,
    scopes: scopes.join(","),
  });
  return `touba-mobile://pair?${params.toString()}`;
}

function mobilePairingEventPayload(pairingRequest) {
  return {
    schema_version: "touba-mobile-pairing-event-v0.1",
    pairing_id: pairingRequest.pairing_id,
    server_url: pairingRequest.server_url,
    device_ref: pairingRequest.device_ref,
    user_ref: pairingRequest.user_ref,
    expires_at: pairingRequest.expires_at,
    scopes: pairingRequest.scopes,
  };
}

function sameStringSet(left, right) {
  const leftSet = new Set(Array.isArray(left) ? left : []);
  const rightSet = new Set(Array.isArray(right) ? right : []);
  return leftSet.size === rightSet.size && Array.from(leftSet).every((item) => rightSet.has(item));
}

function isPathInside(root, candidate) {
  const rel = relative(resolve(root), resolve(candidate));
  return rel === "" || (!rel.startsWith("..") && !rel.includes(`..${sep}`) && !isAbsolute(rel));
}

function normalizeRelativePath(path) {
  return path.replaceAll("\\", "/").replace(/^\.\/+/u, "");
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function sha256Buffer(buffer) {
  return createHash("sha256").update(buffer).digest("hex");
}

function isPlainObject(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value, field) {
  if (typeof value !== "string") {
    throw serviceError("ToubaServeChangeInvalid", `${field} must be a string`);
  }
  return value;
}

function requiredNonEmptyString(value, field) {
  const text = requiredString(value, field).trim();
  if (text === "") {
    throw serviceError("ToubaServeChangeInvalid", `${field} must be a non-empty string`);
  }
  return text;
}

function normalizeActor(value) {
  if (typeof value === "string" && value.trim() !== "") {
    return { kind: "user", id: value.trim() };
  }
  if (isPlainObject(value)) {
    const kind = typeof value.kind === "string" && value.kind.trim() !== "" ? value.kind.trim() : "user";
    const id = typeof value.id === "string" && value.id.trim() !== "" ? value.id.trim() : "unknown";
    return { kind, id };
  }
  return { kind: "unknown", id: "unknown" };
}

function normalizeListenError(error, { host, port }) {
  if (error?.code === "EADDRINUSE") {
    return serviceError(
      "ToubaServePortInUse",
      `port ${port} on ${host} is already in use; choose another port with --port <number>`,
    );
  }
  if (error?.code === "EACCES" || error?.code === "EPERM") {
    return serviceError(
      "ToubaServePortUnavailable",
      `cannot listen on ${host}:${port}; choose another port or check network permissions`,
    );
  }
  return error;
}

function isMainModule() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
