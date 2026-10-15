import { spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateManifestFromAirDocument } from "../../cli/touba-manifest/src/generate.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const sourcePath = path.join(fixtureRoot, "source/js-sdk-project.tb");
const handlerFixturePath = path.join(fixtureRoot, "handlers/build_greeting.handler.mjs");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-js-sdk-project-"));
const projectRoot = path.join(tmpRoot, "project");
const airPath = path.join(tmpRoot, "js-sdk-project.air.json");
const manifestPath = path.join(projectRoot, "touba.manifest.json");
const secretsPath = path.join(projectRoot, "touba.secrets.dev.json");
const cargo = process.env.CARGO ?? "cargo";
const secretValue = "integration-secret-value";

try {
  materializeJavaScriptProject();
  compileSourceToAir();
  materializeManifestFromAir();
  materializeSecrets();
  const traceText = runAir();
  assertTrace(JSON.parse(traceText));
  assertNoSecretLeak(traceText);
  console.log("js-sdk-project: status=success language=javascript sdk=@touba/sdk");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function materializeJavaScriptProject() {
  mkdirSync(path.join(projectRoot, "handlers"), { recursive: true });
  mkdirSync(path.join(projectRoot, "node_modules/@touba"), { recursive: true });
  cpSync(
    path.join(implementationRoot, "runtime/touba-handler-sdk"),
    path.join(projectRoot, "node_modules/@touba/sdk"),
    { recursive: true },
  );
  cpSync(handlerFixturePath, path.join(projectRoot, "handlers/build_greeting.handler.mjs"));

  const sdkPackage = JSON.parse(
    readFileSync(path.join(projectRoot, "node_modules/@touba/sdk/package.json"), "utf8"),
  );
  if (sdkPackage.name !== "@touba/sdk") {
    throw new Error(`expected copied SDK package name @touba/sdk, got ${sdkPackage.name}`);
  }

  const handlerSource = readFileSync(path.join(projectRoot, "handlers/build_greeting.handler.mjs"), "utf8");
  if (!handlerSource.includes('from "@touba/sdk"')) {
    throw new Error("handler fixture must import the public @touba/sdk package");
  }
}

function compileSourceToAir() {
  const compileResult = spawnSync(
    cargo,
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath],
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
    handlerCwd: projectRoot,
    timeoutMs: 10000,
    maxPayloadBytes: 1048576,
  });
  // Explicit host permissions for this fixture, not inferred authorization.
  const binding = manifest.bindings["tool:examples.js_sdk_project/BuildGreeting"];
  binding.handler.args = ["handlers/build_greeting.handler.mjs"];
  binding.effect_contract = { kind: "none" };
  binding.grants = ["network", "secret_read"];
  binding.secrets = ["DEMO_API_KEY"];
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

function materializeSecrets() {
  writeFileSync(
    secretsPath,
    `${JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        DEMO_API_KEY: {
          source: "env",
          name: "DEMO_API_KEY",
        },
      },
    }, null, 2)}\n`,
    "utf8",
  );
}

function runAir() {
  const runResult = spawnSync(
    process.execPath,
    [
      path.join(implementationRoot, "cli/touba-run/src/run.mjs"),
      airPath,
      "--manifest",
      manifestPath,
      "--secrets",
      secretsPath,
      "--inputs-json",
      JSON.stringify({
        request: {
          name: "Bamba",
        },
      }),
      "--output",
      "json",
    ],
    {
      cwd: implementationRoot,
      encoding: "utf8",
      env: {
        ...process.env,
        DEMO_API_KEY: secretValue,
      },
    },
  );
  assertSuccess("run", runResult);
  return runResult.stdout;
}

function assertTrace({ trace, messages }) {
  const completed = trace.events?.find((event) => event.kind === "run_completed");
  if (completed?.payload?.status !== "success") {
    throw new Error(`expected trace status success, got ${completed?.payload?.status}`);
  }

  const bindingEvent = trace.events.find((event) => event.kind === "tool_binding_authorized");
  if (!bindingEvent) {
    throw new Error("expected tool_binding_authorized event");
  }
  if (bindingEvent.payload.tool_ref !== "tool:examples.js_sdk_project/BuildGreeting") {
    throw new Error(`unexpected tool_ref ${bindingEvent.payload.tool_ref}`);
  }
  if (!bindingEvent.payload.granted_capabilities.includes("network")) {
    throw new Error("expected network grant");
  }
  if (!bindingEvent.payload.granted_capabilities.includes("secret_read")) {
    throw new Error("expected secret_read grant");
  }
  if (!bindingEvent.payload.secret_handles_used.includes("DEMO_API_KEY")) {
    throw new Error("expected DEMO_API_KEY handle in trace");
  }

  if (messages[0]?.text !== "Hello Bamba from JavaScript") {
    throw new Error(`unexpected show message ${messages[0]?.text}`);
  }
}

function assertNoSecretLeak(traceText) {
  if (traceText.includes(secretValue)) {
    throw new Error("trace includes resolved DEMO_API_KEY value");
  }
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
