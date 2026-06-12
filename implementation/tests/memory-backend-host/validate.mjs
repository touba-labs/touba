import { spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateManifestFromAirDocument } from "../../cli/touba-manifest/src/generate.mjs";
import {
  closeMemoryBackendServer,
  createMemoryBackendServer,
  listenMemoryBackendServer,
} from "./backend/memory_backend_server.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-memory-backend-host-"));
const projectRoot = path.join(tmpRoot, "project");
const airPath = path.join(projectRoot, ".touba/air/memory-backend-host.air.json");
const manifestPath = path.join(projectRoot, "touba.manifest.json");
const resourceBindingsPath = path.join(projectRoot, "touba.resources.json");
const secretsPath = path.join(projectRoot, "touba.secrets.dev.json");
const tracePath = path.join(projectRoot, "run.trace.json");
const cargo = process.env.CARGO ?? "cargo";
const secretValue = "memory-backend-token-secret";
const externalEndpoint = argValue("--external-endpoint");
let backend;

try {
  materializeProject();
  if (!externalEndpoint) {
    backend = await startMemoryBackend();
  }
  compileSourceToAir();
  materializeManifestFromAir();
  writeSecrets();

  writeResourceBindings();
  const positive = await runAir();
  assertPositiveRun(positive);

  const missing = await runAir({ omitResourceBindings: true, expectFailure: true });
  assertFailure("ResourceBindingMissing", missing);

  writeResourceBindings({ grants: ["memory.read"] });
  const missingGrant = await runAir({ expectFailure: true });
  assertFailure("ResourceBindingGrantMissing", missingGrant);

  writeResourceBindings({ forbiddenConfig: true });
  const forbiddenPayload = await runAir({ expectFailure: true });
  assertFailure("ResourceBindingPayloadForbidden", forbiddenPayload);

  console.log("memory-backend-host: status=success scenario=rb2_http_memory checks=positive,missing_binding,missing_grant,forbidden_payload");
} finally {
  await closeBackend();
  rmSync(tmpRoot, { recursive: true, force: true });
}

function materializeProject() {
  mkdirSync(path.join(projectRoot, "source"), { recursive: true });
  mkdirSync(path.join(projectRoot, "handlers"), { recursive: true });
  mkdirSync(path.join(projectRoot, ".touba/air"), { recursive: true });
  mkdirSync(path.join(projectRoot, "node_modules/@touba"), { recursive: true });
  cpSync(
    path.join(implementationRoot, "runtime/touba-handler-sdk"),
    path.join(projectRoot, "node_modules/@touba/sdk"),
    { recursive: true },
  );
  cpSync(
    path.join(fixtureRoot, "source/memory-backend-host.tb"),
    path.join(projectRoot, "source/memory-backend-host.tb"),
  );
  cpSync(
    path.join(fixtureRoot, "handlers/write_memory_note.handler.mjs"),
    path.join(projectRoot, "handlers/write_memory_note.handler.mjs"),
  );
  cpSync(
    path.join(fixtureRoot, "handlers/read_memory_note.handler.mjs"),
    path.join(projectRoot, "handlers/read_memory_note.handler.mjs"),
  );
}

async function startMemoryBackend() {
  const server = createMemoryBackendServer({
    secretValue,
  });
  await listenMemoryBackendServer(server);
  return server;
}

async function closeBackend() {
  await closeMemoryBackendServer(backend);
}

function compileSourceToAir() {
  const compileResult = spawnSync(
    cargo,
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", path.join(projectRoot, "source/memory-backend-host.tb")],
    {
      cwd: implementationRoot,
      encoding: "utf8",
    },
  );
  assertSuccess("compile", compileResult);
  writeFileSync(airPath, compileResult.stdout, "utf8");
}

function materializeManifestFromAir() {
  const airDocument = JSON.parse(readFileSync(airPath, "utf8"));
  const manifest = generateManifestFromAirDocument(airDocument, {
    handlerCommand: process.execPath,
    handlerRoot: "handlers",
    handlerCwd: ".",
    timeoutMs: 10000,
    maxPayloadBytes: 1048576,
  });

  manifest.bindings["tool:examples.memory_backend_host/WriteMemoryNote"].handler.args = [
    "handlers/write_memory_note.handler.mjs",
  ];
  manifest.bindings["tool:examples.memory_backend_host/ReadMemoryNote"].handler.args = [
    "handlers/read_memory_note.handler.mjs",
  ];

  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function writeSecrets() {
  writeFileSync(
    secretsPath,
    `${JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        MEMORY_BACKEND_TOKEN: {
          source: "env",
          name: "MEMORY_BACKEND_TOKEN",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function writeResourceBindings(options = {}) {
  const resource = {
    kind: "memory_backend",
    provider: "host.http.memory_backend",
    config: {
      endpoint_url: endpointUrl(),
    },
    grants: options.grants ?? ["memory.read", "memory.write"],
    secrets: ["MEMORY_BACKEND_TOKEN"],
    required_secrets: ["MEMORY_BACKEND_TOKEN"],
    limits: {
      max_payload_bytes: 65536,
    },
  };
  if (options.forbiddenConfig === true) {
    resource.config.token = "must-not-be-accepted";
  }

  writeFileSync(
    resourceBindingsPath,
    `${JSON.stringify({
      resource_bindings_schema_version: "touba-resource-bindings-v0.1",
      resources: {
        "memory:examples.memory_backend_host/CustomerMemory": resource,
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

async function runAir(options = {}) {
  const args = [
    path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
    airPath,
    "--manifest",
    manifestPath,
    "--secrets",
    secretsPath,
    "--inputs-json",
    JSON.stringify({
      request: {
        customer_id: "ACME-001",
        note: "Renewal risk escalated to account team",
      },
    }),
    "--output",
    "result",
    "--trace-out",
    tracePath,
  ];
  if (options.omitResourceBindings !== true) {
    args.push("--resource-bindings", resourceBindingsPath);
  }
  args.push("--require-resource-bindings");

  const runResult = await runProcess(process.execPath, args, {
    cwd: implementationRoot,
    env: {
      ...process.env,
      MEMORY_BACKEND_TOKEN: secretValue,
    },
  });

  if (options.expectFailure === true) {
    if (runResult.status === 0) {
      throw new Error("expected run failure");
    }
    return runResult;
  }

  assertSuccess("run", runResult);
  return {
    result: JSON.parse(runResult.stdout),
    trace: JSON.parse(readFileSync(tracePath, "utf8")),
  };
}

function runProcess(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", (error) => {
      resolve({ status: 1, stdout, stderr: `${stderr}${error.message}` });
    });
    child.on("close", (status) => {
      resolve({ status, stdout, stderr });
    });
  });
}

function endpointUrl() {
  if (externalEndpoint) {
    return normalizeEndpoint(externalEndpoint);
  }
  const address = backend?.address();
  if (!address || typeof address === "string") {
    throw new Error("memory backend is not listening");
  }
  return `http://127.0.0.1:${address.port}`;
}

function normalizeEndpoint(value) {
  const url = new URL(value);
  if (url.protocol !== "http:" || url.hostname !== "127.0.0.1") {
    throw new Error("--external-endpoint must be an explicit http://127.0.0.1 URL");
  }
  return url.origin;
}

function assertPositiveRun(run) {
  if (run.result?.stored_note !== "Renewal risk escalated to account team") {
    throw new Error(`unexpected stored_note ${run.result?.stored_note}`);
  }
  if (run.result?.backend !== "host_http_memory") {
    throw new Error(`unexpected backend ${run.result?.backend}`);
  }
  const traceText = JSON.stringify(run.trace);
  if (traceText.includes(secretValue)) {
    throw new Error("trace leaked MEMORY_BACKEND_TOKEN value");
  }

  const completed = event(run.trace, "run_completed");
  if (completed.payload.status !== "success") {
    throw new Error(`unexpected run status ${completed.payload.status}`);
  }
  const bindingEvents = run.trace.events.filter((item) => item.kind === "tool_binding_authorized");
  if (bindingEvents.length !== 2) {
    throw new Error(`expected two tool_binding_authorized events, got ${bindingEvents.length}`);
  }
  for (const item of bindingEvents) {
    const bindings = item.payload.resource_bindings;
    if (!Array.isArray(bindings) || bindings.length !== 1) {
      throw new Error("expected one resource binding per tool event");
    }
    if (bindings[0].resource_ref !== "memory:examples.memory_backend_host/CustomerMemory") {
      throw new Error(`unexpected resource_ref ${bindings[0].resource_ref}`);
    }
    if (bindings[0].provider !== "host.http.memory_backend") {
      throw new Error(`unexpected provider ${bindings[0].provider}`);
    }
    if (JSON.stringify(bindings).includes("endpoint_url")) {
      throw new Error("trace must not include backend config endpoint_url");
    }
  }

  const memoryEvents = run.trace.events.filter((item) => item.kind === "memory_access_authorized");
  const accesses = memoryEvents.map((item) => item.payload.access).sort();
  if (JSON.stringify(accesses) !== JSON.stringify(["read", "write"])) {
    throw new Error(`unexpected memory accesses ${JSON.stringify(accesses)}`);
  }
  const show = event(run.trace, "user_interaction_shown");
  if (show.payload.message !== "Memory backend returned: Renewal risk escalated to account team") {
    throw new Error(`unexpected show message ${show.payload.message}`);
  }
}

function assertFailure(code, result) {
  const output = `${result.stdout}\n${result.stderr}`;
  if (!output.includes(code)) {
    throw new Error(`expected ${code} in failure output\n${output}`);
  }
  if (output.includes(secretValue)) {
    throw new Error(`${code} failure leaked secret value`);
  }
}

function event(trace, kind) {
  const item = trace.events?.find((candidate) => candidate.kind === kind);
  if (!item) {
    throw new Error(`expected trace event ${kind}`);
  }
  return item;
}

function assertSuccess(label, result) {
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} failed with code ${result.status}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
  }
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) {
    return undefined;
  }
  const value = process.argv[index + 1];
  if (!value || value.startsWith("--")) {
    throw new Error(`${name} requires a value`);
  }
  return value;
}
