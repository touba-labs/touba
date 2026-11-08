#!/usr/bin/env node
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { createServer as createSecureServer } from "node:https";
import { readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { createRevisionStore } from "./index.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8792;
const MAX_BODY_BYTES = 64 * 1024 * 1024;

export function createDeploymentTargetService(options = {}) {
  const host = options.host ?? DEFAULT_HOST;
  const port = options.port ?? DEFAULT_PORT;
  const token = options.token;
  if (typeof token !== "string" || token.length < 32) {
    throw targetError("ToubaDeploymentTokenInvalid", "deployment target token must contain at least 32 characters");
  }
  const secure = options.tlsCertPath !== undefined || options.tlsKeyPath !== undefined;
  if (!isLoopbackHost(host) && !secure) {
    throw targetError("ToubaDeploymentTlsRequired", "non-loopback deployment targets require TLS");
  }
  if (secure && (options.tlsCertPath === undefined || options.tlsKeyPath === undefined)) {
    throw targetError("ToubaDeploymentTlsInvalid", "TLS requires both certificate and key");
  }
  const storageRoot = resolve(options.storageRoot ?? ".touba-deployment-target");
  const listener = async (request, response) => {
    try {
      const url = new URL(request.url ?? "/", `${secure ? "https" : "http"}://${request.headers.host ?? `${host}:${port}`}`);
      if (request.method === "GET" && url.pathname === "/health") {
        writeJson(response, 200, {
          status: "ok",
          service: "touba-deployment-target",
          secure_transport: secure,
        });
        return;
      }
      if (!authorized(request.headers.authorization, token)) {
        writeJson(response, 401, { status: "error", code: "ToubaDeploymentUnauthorized" });
        return;
      }
      const scopedRoute = /^\/projects\/([a-f0-9]{64})(\/.*)$/u.exec(url.pathname);
      if (url.pathname.startsWith("/projects/") && scopedRoute === null) {
        throw targetError("ToubaDeploymentProjectScopeInvalid", "invalid project scope");
      }
      const scope = scopedRoute?.[1];
      if (scopedRoute) url.pathname = scopedRoute[2];
      // A scoped client cannot list, activate or roll back another project's
      // history. Legacy unscoped revisions remain isolated and untouched.
      const store = createRevisionStore({ storageRoot: scope === undefined ? storageRoot : join(storageRoot, "projects", scope) });
      if (scope !== undefined) response.setHeader("x-touba-project-scope", scope);
      if (request.method === "GET" && url.pathname === "/revisions") {
        writeJson(response, 200, store.list());
        return;
      }
      if (request.method === "POST" && url.pathname === "/revisions") {
        const body = await readJsonBody(request);
        writeJson(response, 201, store.publish(body.bundle, {
          publishedBy: actorId(body.published_by),
        }));
        return;
      }
      const activation = url.pathname.match(/^\/revisions\/([a-f0-9]{64})\/activate$/u);
      if (request.method === "POST" && activation !== null) {
        const body = await readJsonBody(request);
        writeJson(response, 202, store.activate(activation[1], {
          activatedBy: actorId(body.activated_by),
          expectedState: requiredState(body.expected_state),
        }));
        return;
      }
      if (request.method === "POST" && url.pathname === "/rollback") {
        const body = await readJsonBody(request);
        writeJson(response, 202, store.rollback({
          rolledBackBy: actorId(body.rolled_back_by),
          expectedState: requiredState(body.expected_state),
        }));
        return;
      }
      writeJson(response, 404, { status: "error", code: "ToubaDeploymentRouteNotFound" });
    } catch (error) {
      writeJson(response, statusForError(error.code), {
        status: "error",
        code: error.code ?? "ToubaDeploymentTargetFailed",
        message: error.message,
      });
    }
  };
  const server = secure
    ? createSecureServer({
        cert: readTlsFile(options.tlsCertPath),
        key: readTlsFile(options.tlsKeyPath),
      }, listener)
    : createServer(listener);
  return {
    async start() {
      await new Promise((resolveStart, reject) => {
        server.once("error", reject);
        server.listen(port, host, resolveStart);
      });
      const address = server.address();
      return {
        host,
        port: typeof address === "object" && address !== null ? address.port : port,
        protocol: secure ? "https" : "http",
      };
    },
    async stop() {
      if (!server.listening) return;
      await new Promise((resolveStop, reject) => {
        server.close((error) => error ? reject(error) : resolveStop());
      });
    },
  };
}

if (isMainModule()) {
  try {
    const options = parseArgs(process.argv.slice(2));
    const service = createDeploymentTargetService(options);
    const address = await service.start();
    process.stdout.write(`Touba deployment target listening on ${address.protocol}://${address.host}:${address.port}\n`);
  } catch (error) {
    process.stderr.write(`touba deployment target error [${error.code ?? "ToubaDeploymentTargetFailed"}]: ${error.message}\n`);
    process.exit(1);
  }
}

function parseArgs(args) {
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--host") options.host = requiredValue(arg, args, ++index);
    else if (arg === "--port") options.port = Number.parseInt(requiredValue(arg, args, ++index), 10);
    else if (arg === "--storage") options.storageRoot = requiredValue(arg, args, ++index);
    else if (arg === "--auth-token-env") {
      const envName = requiredValue(arg, args, ++index);
      options.token = process.env[envName];
    } else if (arg === "--tls-cert") options.tlsCertPath = requiredValue(arg, args, ++index);
    else if (arg === "--tls-key") options.tlsKeyPath = requiredValue(arg, args, ++index);
    else throw targetError("ToubaDeploymentOptionUnknown", `unknown option ${arg}`);
  }
  return options;
}

function readTlsFile(path) {
  const resolved = resolve(path);
  if (!statSync(resolved).isFile()) {
    throw targetError("ToubaDeploymentTlsInvalid", `${path} is not a file`);
  }
  return readFileSync(resolved);
}

function authorized(header, token) {
  if (typeof header !== "string") return false;
  const actual = createHash("sha256").update(header, "utf8").digest();
  const expected = createHash("sha256").update(`Bearer ${token}`, "utf8").digest();
  return timingSafeEqual(actual, expected)
    && Buffer.byteLength(header, "utf8") === Buffer.byteLength(`Bearer ${token}`, "utf8");
}

async function readJsonBody(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) {
      throw targetError("ToubaDeploymentBodyTooLarge", `request exceeds ${MAX_BODY_BYTES} bytes`);
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (cause) {
    throw targetError("ToubaDeploymentJsonInvalid", cause.message);
  }
}

function actorId(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw targetError("ToubaDeploymentActorInvalid", "deployment actor is required");
  }
  return value.trim();
}

function writeJson(response, status, value) {
  response.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  response.end(`${JSON.stringify(value, null, 2)}\n`);
}

function statusForError(code) {
  if (code === "ToubaDeploymentStateConflict") return 409;
  if (code === "ToubaDeploymentUnauthorized") return 401;
  if (code === "ToubaDeploymentRevisionNotFound") return 404;
  if (code === "ToubaDeploymentRevisionCorrupt") return 409;
  return 400;
}

function requiredState(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw targetError("ToubaDeploymentStateRequired", "activation and rollback require the reviewed target state");
  }
  return value;
}

function requiredValue(option, args, index) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw targetError("ToubaDeploymentOptionMissing", `${option} requires a value`);
  }
  return value;
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "localhost", "::1"].includes(host);
}

function targetError(code, message) {
  return Object.assign(new Error(message), { code });
}

function isMainModule() {
  return process.argv[1] !== undefined
    && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
}
