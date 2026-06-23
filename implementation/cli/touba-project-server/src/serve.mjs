#!/usr/bin/env node
import { createServer } from "node:http";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
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

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const DEFAULT_HUMAN_DECISIONS_PATH = ".touba/human-decisions.json";
const DEFAULT_CHANGE_PROPOSALS_PATH = ".touba/studio-change-proposals.json";
const MAX_BODY_BYTES = 64 * 1024;
const MAX_CHANGE_CONTENT_BYTES = 64 * 1024;
const MAX_PROJECT_ARTIFACTS = 200;
const MAX_PROJECT_SCAN_DEPTH = 6;
const CONTRACT_INDEX_SCHEMA_VERSION = "touba-project-server-contract-index-v0.1";
const LIVE_STATE_SCHEMA_VERSION = "touba-project-live-state-v0.1";
const EVENT_STREAM_SCHEMA_VERSION = "touba-project-event-stream-v0.1";
const HUMAN_DECISION_STORE_SCHEMA_VERSION = "touba-human-decisions-v0.1";
const PROJECT_REFRESH_REQUEST_SCHEMA_VERSION = "touba-project-refresh-request-v0.1";
const PROJECT_REFRESH_SCHEMA_VERSION = "touba-project-refresh-v0.1";
const CHANGE_PROPOSAL_SCHEMA_VERSION = "touba-project-change-proposal-v0.1";
const CHANGE_PROPOSED_SCHEMA_VERSION = "touba-project-change-proposed-v0.1";
const CHANGE_APPLY_SCHEMA_VERSION = "touba-project-change-apply-v0.1";
const CHANGE_RESULT_SCHEMA_VERSION = "touba-project-change-result-v0.1";
const CHANGE_STORE_SCHEMA_VERSION = "touba-studio-change-proposals-v0.1";
const CHANGE_ACTIONS = Object.freeze(["write_text_file"]);
const CHANGE_DECISIONS = Object.freeze(["apply", "refuse"]);
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
  "resources.json",
]));
const CHANGE_TARGET_JSON_FILES = Object.freeze(new Set([
  "touba.project.json",
  "touba.manifest.json",
  "touba.package.json",
  "touba.ownership.json",
  "resources.json",
]));
const ACCEPTED_DECISION_CONTRACTS = Object.freeze([
  "touba-approval-decision-v1",
  "touba-human-review-decision-v1",
]);
const LIVE_ENDPOINT_CONTRACTS = Object.freeze({
  "/project": "touba-project-inspection-v1",
  "/runs/current": "touba-run-summary-v1",
  "/trace/current": "touba-trace-timeline-v1",
  "/triggers": "touba-trigger-status-v1",
  "/approvals/pending/current": "touba-approval-request-v1",
  "/reviews/pending/current": "touba-human-review-request-v1",
  "/resources/featured": "touba-registry-resource-v1",
  "/alerts/current": "touba-alert-v1",
});

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help === true) {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
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
  const humanDecisionsPath = resolve(options.humanDecisionsPath ?? DEFAULT_HUMAN_DECISIONS_PATH);
  const changeProposalsPath = resolve(
    options.changeProposalsPath ?? join(projectRoot, DEFAULT_CHANGE_PROPOSALS_PATH),
  );
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const authToken = options.authTokenEnv === undefined ? undefined : process.env[options.authTokenEnv];
  const eventClients = new Set();
  let projectSnapshot;

  if (options.authTokenEnv !== undefined && (!authToken || authToken.trim() === "")) {
    throw serviceError("ToubaServeAuthTokenMissing", `environment variable ${options.authTokenEnv} is required`);
  }
  if (!isLoopbackHost(host) && authToken === undefined) {
    throw serviceError("ToubaServeAuthRequired", "non-loopback Touba project server hosts require --auth-token-env");
  }
  preflightServeOptions({
    contractsRoot,
    projectRoot,
    humanDecisionsPath,
    changeProposalsPath,
    strict: options.strict === true,
  });
  projectSnapshot = buildProjectSnapshot({
    projectRoot,
    previousSnapshot: undefined,
    refreshedAt: new Date().toISOString(),
  });

  const server = createServer(async (request, response) => {
    try {
      if (authToken !== undefined && !authorized(request, authToken)) {
        writeJson(response, 401, { status: "error", code: "ToubaServeUnauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          service: "touba-project-server",
          contract_index_schema_version: CONTRACT_INDEX_SCHEMA_VERSION,
          live_state_schema_version: LIVE_STATE_SCHEMA_VERSION,
          event_stream_schema_version: EVENT_STREAM_SCHEMA_VERSION,
          endpoints: {
            state: "/state",
            events: "/events",
            project: "/project",
            project_refresh: "/project/refresh",
            current_run: "/runs/current",
            trigger_status: "/triggers",
            pending_approval: "/approvals/pending/current",
            pending_review: "/reviews/pending/current",
            human_decisions: "/decisions",
            change_propose: "/changes/propose",
            change_apply: "/changes/apply",
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        writeJson(response, 200, buildLiveState({ contractsRoot, projectRoot, projectSnapshot }));
        return;
      }
      if (request.method === "GET" && url.pathname === "/events") {
        openEventStream({ request, response, eventClients });
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
        const accepted = acceptDecision({ contractsRoot, humanDecisionsPath, decision: body });
        publishEvent(eventClients, "human_decision.accepted", accepted);
        writeJson(response, 202, accepted);
        return;
      }
      if (request.method === "POST" && url.pathname === "/project/refresh") {
        const body = await readOptionalJsonBody(request);
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
        publishRefreshEvents(eventClients, refreshed.report);
        writeJson(response, 202, refreshed.report);
        return;
      }
      if (request.method === "POST" && url.pathname === "/changes/propose") {
        const body = await readJsonBody(request);
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
        publishEvent(eventClients, "change.proposed", proposed);
        writeJson(response, 202, proposed);
        return;
      }
      if (request.method === "POST" && url.pathname === "/changes/apply") {
        const body = await readJsonBody(request);
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
        publishEvent(eventClients, result.status === "applied" ? "change.applied" : "change.refused", result);
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
          publishRefreshEvents(eventClients, refreshed.report);
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
          event_stream: `http://${host}:${address.port}/events`,
        })}\n`);
      }
    },
    async stop() {
      for (const client of eventClients) {
        client.end();
      }
      eventClients.clear();
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
  generatedAt = new Date().toISOString(),
}) {
  return {
    schema_version: LIVE_STATE_SCHEMA_VERSION,
    generated_at: generatedAt,
    project_server: {
      project_root: projectRoot,
      refresh: projectSnapshot.report,
    },
    project: readContractFixture({ contractsRoot, schemaVersion: "touba-project-inspection-v1" }),
    current_run: readContractFixture({ contractsRoot, schemaVersion: "touba-run-summary-v1" }),
    trace_timeline: readContractFixture({ contractsRoot, schemaVersion: "touba-trace-timeline-v1" }),
    trigger_status: readContractFixture({ contractsRoot, schemaVersion: "touba-trigger-status-v1" }),
    pending_approval: readContractFixture({ contractsRoot, schemaVersion: "touba-approval-request-v1" }),
    pending_review: readContractFixture({ contractsRoot, schemaVersion: "touba-human-review-request-v1" }),
    featured_resource: readContractFixture({ contractsRoot, schemaVersion: "touba-registry-resource-v1" }),
    alert: readContractFixture({ contractsRoot, schemaVersion: "touba-alert-v1" }),
    events: {
      schema_version: EVENT_STREAM_SCHEMA_VERSION,
      endpoint: "/events",
      transport: "server_sent_events",
    },
  };
}

export function preflightServeOptions({
  contractsRoot,
  projectRoot = process.cwd(),
  humanDecisionsPath,
  changeProposalsPath = join(projectRoot, DEFAULT_CHANGE_PROPOSALS_PATH),
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
  return {
    schema_version: "touba-serve-preflight-v0.1",
    status: diagnostics.length === 0 ? "ok" : "warning",
    diagnostics,
  };
}

export function acceptDecision({ contractsRoot, humanDecisionsPath, decision, acceptedAt = new Date().toISOString() }) {
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

export function applyProjectChange({
  projectRoot,
  changeProposalsPath,
  applyRequest,
  decidedAt = new Date().toISOString(),
}) {
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
    proposal.refusal_reason = request.reason ?? "refused";
    saveChangeProposalStore(changeProposalsPath, store);
    return {
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
  }

  const validations = validateChangeContent(proposal, { projectRoot });
  if (validations.some((item) => item.severity === "error")) {
    const error = serviceError("ToubaServeChangeValidationFailed", "change proposal failed validation");
    error.diagnostics = validations;
    throw error;
  }
  const targetPath = safeProjectPath(projectRoot, proposal.target.path);
  mkdirSync(dirname(targetPath), { recursive: true });
  const tempPath = `${targetPath}.touba-write-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, proposal.content, "utf8");
  renameSync(tempPath, targetPath);
  proposal.status = "applied";
  proposal.decided_at = decidedAt;
  proposal.decided_by = request.decided_by;
  proposal.applied_path = proposal.target.path;
  saveChangeProposalStore(changeProposalsPath, store);
  return {
    schema_version: CHANGE_RESULT_SCHEMA_VERSION,
    status: "applied",
    proposal_id: proposal.proposal_id,
    target: proposal.target,
    decided_at: decidedAt,
    decided_by: request.decided_by,
    reason: request.reason,
    content_sha256: proposal.content_sha256,
    validations,
    evidence: {
      write_mode: "atomic_rename",
      project_root: projectRoot,
      relative_path: proposal.target.path,
    },
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
      JSON.parse(proposal.content);
    } catch (cause) {
      diagnostics.push(serviceDiagnostic("ToubaServeChangeJsonInvalid", `${targetPath} is not valid JSON: ${cause.message}`));
    }
  }
  if (targetPath.endsWith(".tb")) {
    diagnostics.push(...validateToubaSourcePatch(proposal.content, { projectRoot }));
  }
  return diagnostics.length === 0
    ? [serviceDiagnostic("ToubaServeChangeContentValidated", "change content passed project-server validation", "info")]
    : diagnostics;
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
  return normalized.endsWith(".tb") || CHANGE_TARGET_JSON_FILES.has(basename(normalized));
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

function authorized(request, token) {
  return request.headers.authorization === `Bearer ${token}`;
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

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function openEventStream({ request, response, eventClients }) {
  response.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    "connection": "keep-alive",
  });
  eventClients.add(response);
  writeSse(response, "touba.server.ready", {
    schema_version: EVENT_STREAM_SCHEMA_VERSION,
    status: "ready",
  });
  request.on("close", () => {
    eventClients.delete(response);
  });
}

function publishEvent(eventClients, type, payload) {
  const event = {
    schema_version: EVENT_STREAM_SCHEMA_VERSION,
    type,
    emitted_at: new Date().toISOString(),
    payload,
  };
  for (const client of eventClients) {
    writeSse(client, type, event);
  }
}

function publishRefreshEvents(eventClients, report) {
  publishEvent(eventClients, "project.changed", report);
  if (report.changes.changed_artifacts.length > 0) {
    publishEvent(eventClients, "artifact.changed", {
      schema_version: PROJECT_REFRESH_SCHEMA_VERSION,
      project_root: report.project_root,
      refreshed_at: report.refreshed_at,
      changed_artifacts: report.changes.changed_artifacts,
    });
  }
  publishEvent(eventClients, "validation.changed", {
    schema_version: PROJECT_REFRESH_SCHEMA_VERSION,
    status: report.status,
    refreshed_at: report.refreshed_at,
    diagnostics: report.diagnostics,
  });
}

function writeSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function httpStatusForError(code) {
  if (code === "ToubaServeUnauthorized") return 401;
  if (
    code === "ToubaServeDecisionReplayRejected"
    || code === "ToubaServeChangeProposalDuplicate"
    || code === "ToubaServeChangeAlreadyDecided"
  ) return 409;
  if (
    code === "ToubaServeRouteNotFound"
    || code === "ToubaServeContractUnknown"
    || code === "ToubaServeChangeProposalNotFound"
  ) return 404;
  if (code === "ToubaServeBodyTooLarge" || code === "ToubaServeChangeTooLarge") return 413;
  if (code === "ToubaServeChangeTargetRejected" || code === "ToubaServeChangePathRejected") return 403;
  if (
    code === "ToubaServeDecisionInvalid"
    || code === "ToubaServeDecisionContractUnsupported"
    || code === "ToubaServeJsonInvalid"
    || code === "ToubaServeRefreshInvalid"
    || code === "ToubaServeChangeInvalid"
    || code === "ToubaServeChangeApplyInvalid"
    || code === "ToubaServeChangeValidationFailed"
  ) return 400;
  return 500;
}

function parseArgs(rawArgs) {
  const options = {
    host: DEFAULT_HOST,
    port: DEFAULT_PORT,
    humanDecisionsPath: DEFAULT_HUMAN_DECISIONS_PATH,
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
    } else if (arg === "--human-decisions") {
      options.humanDecisionsPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--change-proposals") {
      options.changeProposalsPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--host") {
      options.host = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--port") {
      options.port = Number.parseInt(requiredValue(arg, rawArgs, ++index), 10);
    } else if (arg === "--auth-token-env") {
      options.authTokenEnv = requiredValue(arg, rawArgs, ++index);
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
  return options;
}

function requiredValue(option, args, index) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw serviceError("ToubaServeOptionValueMissing", `${option} requires a value`);
  }
  return value;
}

function usage() {
  return [
    "Usage: touba serve [--project-root <path>] [--contracts-root <path>] [--human-decisions <human-decisions.json>] [--change-proposals <path>] [--host 127.0.0.1] [--port 8791] [--auth-token-env NAME] [--strict] [--quiet]",
    "",
    "Starts the live Touba project server for client, Mobile and contract clients.",
    "",
    "Defaults:",
    `  host: ${DEFAULT_HOST}`,
    `  port: ${DEFAULT_PORT}`,
    `  human_decisions: ${DEFAULT_HUMAN_DECISIONS_PATH}`,
    `  change_proposals: ${DEFAULT_CHANGE_PROPOSALS_PATH}`,
    "",
    "Live endpoints:",
    "  GET  /state",
    "  GET  /events",
    "  GET  /project",
    "  POST /project/refresh",
    "  GET  /runs/current",
    "  GET  /triggers",
    "  GET  /approvals/pending/current",
    "  POST /decisions",
    "  POST /changes/propose",
    "  POST /changes/apply",
  ].join("\n");
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function serviceError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function serviceDiagnostic(code, message, severity = "error") {
  return { severity, code, message };
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
