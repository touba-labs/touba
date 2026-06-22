#!/usr/bin/env node
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCT_SURFACE_CONTRACTS,
  validateObject,
} from "../../../tools/validate-product-surface-contracts.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const DEFAULT_HUMAN_DECISIONS_PATH = ".touba/human-decisions.json";
const MAX_BODY_BYTES = 64 * 1024;
const CONTRACT_INDEX_SCHEMA_VERSION = "touba-project-server-contract-index-v0.1";
const LIVE_STATE_SCHEMA_VERSION = "touba-project-live-state-v0.1";
const EVENT_STREAM_SCHEMA_VERSION = "touba-project-event-stream-v0.1";
const HUMAN_DECISION_STORE_SCHEMA_VERSION = "touba-human-decisions-v0.1";
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
  const humanDecisionsPath = resolve(options.humanDecisionsPath ?? DEFAULT_HUMAN_DECISIONS_PATH);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const authToken = options.authTokenEnv === undefined ? undefined : process.env[options.authTokenEnv];
  const eventClients = new Set();

  if (options.authTokenEnv !== undefined && (!authToken || authToken.trim() === "")) {
    throw serviceError("ToubaServeAuthTokenMissing", `environment variable ${options.authTokenEnv} is required`);
  }
  if (!isLoopbackHost(host) && authToken === undefined) {
    throw serviceError("ToubaServeAuthRequired", "non-loopback Touba project server hosts require --auth-token-env");
  }
  preflightServeOptions({ contractsRoot, humanDecisionsPath, strict: options.strict === true });

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
            current_run: "/runs/current",
            trigger_status: "/triggers",
            pending_approval: "/approvals/pending/current",
            pending_review: "/reviews/pending/current",
            human_decisions: "/decisions",
          },
        });
        return;
      }
      if (request.method === "GET" && url.pathname === "/state") {
        writeJson(response, 200, buildLiveState({ contractsRoot }));
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
      writeJson(response, 404, { status: "error", code: "ToubaServeRouteNotFound" });
    } catch (error) {
      writeJson(response, httpStatusForError(error.code), {
        status: "error",
        code: error.code ?? "ToubaServeRequestFailed",
        message: error.message,
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
          contracts_root: contractsRoot,
          human_decisions: humanDecisionsPath ?? null,
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

export function buildLiveState({ contractsRoot, generatedAt = new Date().toISOString() }) {
  return {
    schema_version: LIVE_STATE_SCHEMA_VERSION,
    generated_at: generatedAt,
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

export function preflightServeOptions({ contractsRoot, humanDecisionsPath, strict = false }) {
  const diagnostics = [];
  if (!existsSync(contractsRoot)) {
    diagnostics.push(serviceDiagnostic("ToubaServeContractsRootMissing", `${contractsRoot} does not exist`));
  } else if (!statSync(contractsRoot).isDirectory()) {
    diagnostics.push(serviceDiagnostic("ToubaServeContractsRootInvalid", `${contractsRoot} is not a directory`));
  }
  if (existsSync(humanDecisionsPath) && statSync(humanDecisionsPath).isDirectory()) {
    diagnostics.push(serviceDiagnostic("ToubaServeHumanDecisionStoreInvalid", `${humanDecisionsPath} is a directory`));
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
  if (diagnostics.some((diagnostic) => diagnostic.code === "ToubaServeHumanDecisionStoreInvalid")) {
    const error = serviceError("ToubaServePreflightFailed", "touba serve cannot use a directory as decision store");
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

function writeSse(response, event, data) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(data)}\n\n`);
}

function httpStatusForError(code) {
  if (code === "ToubaServeUnauthorized") return 401;
  if (code === "ToubaServeDecisionReplayRejected") return 409;
  if (code === "ToubaServeRouteNotFound" || code === "ToubaServeContractUnknown") return 404;
  if (code === "ToubaServeBodyTooLarge") return 413;
  if (code === "ToubaServeDecisionInvalid" || code === "ToubaServeDecisionContractUnsupported" || code === "ToubaServeJsonInvalid") return 400;
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
    } else if (arg === "--human-decisions") {
      options.humanDecisionsPath = requiredValue(arg, rawArgs, ++index);
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
    "Usage: touba serve [--contracts-root <path>] [--human-decisions <human-decisions.json>] [--host 127.0.0.1] [--port 8791] [--auth-token-env NAME] [--strict] [--quiet]",
    "",
    "Starts the live Touba project server for client, Mobile and contract clients.",
    "",
    "Defaults:",
    `  host: ${DEFAULT_HOST}`,
    `  port: ${DEFAULT_PORT}`,
    `  human_decisions: ${DEFAULT_HUMAN_DECISIONS_PATH}`,
    "",
    "Live endpoints:",
    "  GET  /state",
    "  GET  /events",
    "  GET  /project",
    "  GET  /runs/current",
    "  GET  /triggers",
    "  GET  /approvals/pending/current",
    "  POST /decisions",
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

function serviceDiagnostic(code, message) {
  return { severity: "error", code, message };
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
