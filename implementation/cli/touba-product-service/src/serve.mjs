#!/usr/bin/env node
import { createServer } from "node:http";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import {
  PRODUCT_SURFACE_CONTRACTS,
  validateObject,
} from "../../../tools/validate-product-surface-contracts.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8791;
const MAX_BODY_BYTES = 64 * 1024;
const CONTRACT_INDEX_SCHEMA_VERSION = "touba-product-service-contract-index-v0.1";
const DECISION_STORE_SCHEMA_VERSION = "touba-product-decisions-v0.1";
const ACCEPTED_DECISION_CONTRACTS = Object.freeze([
  "touba-approval-decision-v1",
  "touba-human-review-decision-v1",
]);

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help === true) {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    const service = createProductSurfaceService(options);
    await service.start();
  } catch (error) {
    process.stderr.write(`product service error [${error.code ?? "ProductServiceError"}]: ${error.message}\n`);
    process.exit(1);
  }
}

export function createProductSurfaceService(options = {}) {
  const contractsRoot = resolve(
    options.contractsRoot ?? new URL("../../../contracts/product-surfaces/", import.meta.url).pathname,
  );
  const decisionsPath = options.decisionsPath === undefined
    ? undefined
    : resolve(options.decisionsPath);
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const authToken = options.authTokenEnv === undefined ? undefined : process.env[options.authTokenEnv];

  if (options.authTokenEnv !== undefined && (!authToken || authToken.trim() === "")) {
    throw serviceError("ProductServiceAuthTokenMissing", `environment variable ${options.authTokenEnv} is required`);
  }
  if (!isLoopbackHost(host) && authToken === undefined) {
    throw serviceError("ProductServiceAuthRequired", "non-loopback product service hosts require --auth-token-env");
  }

  const server = createServer(async (request, response) => {
    try {
      if (authToken !== undefined && !authorized(request, authToken)) {
        writeJson(response, 401, { status: "error", code: "ProductServiceUnauthorized" });
        return;
      }
      const url = new URL(request.url ?? "/", `http://${request.headers.host ?? `${host}:${port}`}`);
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          service: "touba-product-service",
          contract_index_schema_version: CONTRACT_INDEX_SCHEMA_VERSION,
        });
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
        if (decisionsPath === undefined) {
          throw serviceError("ProductServiceDecisionStoreMissing", "--decisions is required to accept decisions");
        }
        const body = await readJsonBody(request);
        const accepted = acceptDecision({ contractsRoot, decisionsPath, decision: body });
        writeJson(response, 202, accepted);
        return;
      }
      writeJson(response, 404, { status: "error", code: "ProductServiceRouteNotFound" });
    } catch (error) {
      writeJson(response, httpStatusForError(error.code), {
        status: "error",
        code: error.code ?? "ProductServiceRequestFailed",
        message: error.message,
      });
    }
  });

  return {
    async start() {
      await new Promise((resolveListen, rejectListen) => {
        const onError = (error) => {
          server.off("listening", onListening);
          rejectListen(error);
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
          event: "product_service_started",
          host,
          port: address.port,
          contracts_root: contractsRoot,
          decisions: decisionsPath ?? null,
        })}\n`);
      }
    },
    async stop() {
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

export function acceptDecision({ contractsRoot, decisionsPath, decision, acceptedAt = new Date().toISOString() }) {
  const schemaVersion = decision?.schema_version;
  if (!ACCEPTED_DECISION_CONTRACTS.includes(schemaVersion)) {
    throw serviceError("ProductServiceDecisionContractUnsupported", "decision schema_version is not accepted by this service");
  }
  const schema = readContractSchema({ contractsRoot, schemaVersion });
  const diagnostics = validateObject(schema, decision);
  if (diagnostics.length > 0) {
    const error = serviceError("ProductServiceDecisionInvalid", "decision payload does not match its contract");
    error.diagnostics = diagnostics;
    throw error;
  }
  const store = loadDecisionStore(decisionsPath);
  const duplicate = store.decisions.some((item) =>
    item.schema_version === schemaVersion && item.request_id === decision.request_id
  );
  if (duplicate) {
    throw serviceError("ProductServiceDecisionReplayRejected", "decision for this request_id and schema_version is already stored");
  }
  const storedDecision = {
    ...decision,
    accepted_at: acceptedAt,
  };
  store.decisions.push(storedDecision);
  saveDecisionStore(decisionsPath, store);
  return {
    schema_version: "touba-product-decision-accepted-v0.1",
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
    throw serviceError("ProductServiceContractMissing", `${schemaVersion} fixture is missing`);
  }
  return JSON.parse(readFileSync(fixturePath, "utf8"));
}

function readContractSchema({ contractsRoot, schemaVersion }) {
  assertKnownContract(schemaVersion);
  const schemaPath = join(contractsRoot, "schemas", `${schemaVersion}.schema.json`);
  if (!existsSync(schemaPath)) {
    throw serviceError("ProductServiceSchemaMissing", `${schemaVersion} schema is missing`);
  }
  return JSON.parse(readFileSync(schemaPath, "utf8"));
}

function contractFilesExist({ contractsRoot, schemaVersion }) {
  return existsSync(join(contractsRoot, "schemas", `${schemaVersion}.schema.json`))
    && existsSync(join(contractsRoot, "fixtures", "valid", `${schemaVersion}.json`));
}

function assertKnownContract(schemaVersion) {
  if (!PRODUCT_SURFACE_CONTRACTS.includes(schemaVersion)) {
    throw serviceError("ProductServiceContractUnknown", `${schemaVersion} is not a product surface contract`);
  }
}

function loadDecisionStore(decisionsPath) {
  if (!existsSync(decisionsPath)) {
    return {
      schema_version: DECISION_STORE_SCHEMA_VERSION,
      decisions: [],
    };
  }
  const store = JSON.parse(readFileSync(decisionsPath, "utf8"));
  if (store.schema_version !== DECISION_STORE_SCHEMA_VERSION || !Array.isArray(store.decisions)) {
    throw serviceError("ProductServiceDecisionStoreInvalid", `decision store must use ${DECISION_STORE_SCHEMA_VERSION}`);
  }
  return store;
}

function saveDecisionStore(decisionsPath, store) {
  mkdirSync(dirname(decisionsPath), { recursive: true });
  writeFileSync(decisionsPath, `${JSON.stringify(store, null, 2)}\n`, "utf8");
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
      throw serviceError("ProductServiceBodyTooLarge", `request body exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw serviceError("ProductServiceJsonInvalid", `request body is not valid JSON: ${cause.message}`);
  }
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function httpStatusForError(code) {
  if (code === "ProductServiceUnauthorized") return 401;
  if (code === "ProductServiceDecisionReplayRejected") return 409;
  if (code === "ProductServiceRouteNotFound" || code === "ProductServiceContractUnknown") return 404;
  if (code === "ProductServiceBodyTooLarge") return 413;
  if (code === "ProductServiceDecisionInvalid" || code === "ProductServiceDecisionContractUnsupported" || code === "ProductServiceJsonInvalid") return 400;
  return 500;
}

function parseArgs(rawArgs) {
  const options = { host: DEFAULT_HOST, port: DEFAULT_PORT, help: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--contracts-root") {
      options.contractsRoot = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--decisions") {
      options.decisionsPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--host") {
      options.host = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--port") {
      options.port = Number.parseInt(requiredValue(arg, rawArgs, ++index), 10);
    } else if (arg === "--auth-token-env") {
      options.authTokenEnv = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--quiet") {
      options.quiet = true;
    } else {
      throw serviceError("ProductServiceOptionUnknown", `unknown option ${arg}`);
    }
  }
  if (!Number.isInteger(options.port) || options.port < 0 || options.port > 65535) {
    throw serviceError("ProductServicePortInvalid", "--port must be an integer between 0 and 65535");
  }
  return options;
}

function requiredValue(option, args, index) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw serviceError("ProductServiceOptionValueMissing", `${option} requires a value`);
  }
  return value;
}

function usage() {
  return [
    "Usage: touba product serve [--contracts-root <path>] [--decisions <decisions.json>] [--host 127.0.0.1] [--port 8791] [--auth-token-env NAME] [--quiet]",
    "",
    "Serves versioned Touba product-surface contracts for client/Mobile and accepts validated human decision payloads.",
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

function isMainModule() {
  return import.meta.url === pathToFileURL(process.argv[1]).href;
}
