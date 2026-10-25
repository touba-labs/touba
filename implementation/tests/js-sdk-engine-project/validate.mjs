import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { packageSdk } from "../../cli/touba-distribution/src/package-sdk.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const sourceFixturePath = path.join(fixtureRoot, "source/js-sdk-engine-project.tb");
const handlerFixturePath = path.join(fixtureRoot, "handlers/build_greeting.handler.mjs");
const tmpRoot = mkdtempSync(path.join(tmpdir(), "touba-js-sdk-engine-project-"));
const projectRoot = path.join(tmpRoot, "project");
const manifestPath = path.join(projectRoot, "touba.manifest.json");
const secretsPath = path.join(projectRoot, "touba.secrets.dev.json");
const secretValue = "engine-fixture-secret";

try {
  packageSdk(implementationRoot, tmpRoot);
  materializeJavaScriptProject();
  const { ToubaEngine } = await import(path.join(projectRoot, "node_modules/@touba/sdk/src/index.mjs"));
  const engine = new ToubaEngine({
    projectRoot,
    command: process.execPath,
    commandArgs: [path.join(implementationRoot, "cli/touba-project/src/main.mjs")],
    env: {
      DEMO_API_KEY: secretValue,
    },
  });

  const run = await engine.run({
    source: "source/js-sdk-engine-project.tb",
    entryRef: "skill:examples.js_sdk_engine_project/RunGreeting",
    manifest: "touba.manifest.json",
    secrets: "touba.secrets.dev.json",
    inputs: {
      request: {
        name: "Bamba",
      },
    },
  });

  assertRun(run);
  assertNoSecretLeak(JSON.stringify(run.trace));
  console.log("js-sdk-engine-project: status=success language=javascript sdk=@touba/sdk engine=local_cli");
} finally {
  rmSync(tmpRoot, { recursive: true, force: true });
}

function materializeJavaScriptProject() {
  mkdirSync(path.join(projectRoot, "source"), { recursive: true });
  mkdirSync(path.join(projectRoot, "handlers"), { recursive: true });
  mkdirSync(path.join(projectRoot, "node_modules/@touba"), { recursive: true });
  cpSync(
    path.join(tmpRoot, "lib/node_modules/@touba/sdk"),
    path.join(projectRoot, "node_modules/@touba/sdk"),
    { recursive: true },
  );
  cpSync(sourceFixturePath, path.join(projectRoot, "source/js-sdk-engine-project.tb"));
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

  writeFileSync(manifestPath, `${JSON.stringify(manifestDocument(), null, 2)}\n`, "utf8");
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

function manifestDocument() {
  return {
    manifest_version: "touba-manifest-v1",
    bindings: {
      "tool:examples.js_sdk_engine_project/BuildGreeting": {
        effect_contract: { kind: "none" }, handler: {
          kind: "process",
          command: process.execPath,
          args: ["handlers/build_greeting.handler.mjs"],
          cwd: ".",
        },
        grants: ["network", "secret_read"],
        secrets: ["DEMO_API_KEY"],
        timeout_ms: 10000,
        max_payload_bytes: 1048576,
      },
    },
  };
}

function assertRun(run) {
  if (run.status !== "success") {
    throw new Error(`expected run status success, got ${run.status}`);
  }
  if (run.result?.message !== "Hello Bamba from ToubaEngine") {
    throw new Error(`unexpected result message ${run.result?.message}`);
  }
  if (run.result?.secret_seen !== true) {
    throw new Error("expected secret_seen=true in result");
  }
  const completed = run.trace.events?.find((event) => event.kind === "run_completed");
  if (completed?.payload?.status !== "success") {
    throw new Error(`expected trace status success, got ${completed?.payload?.status}`);
  }
  const bindingEvent = run.trace.events.find((event) => event.kind === "tool_binding_authorized");
  if (bindingEvent?.payload?.tool_ref !== "tool:examples.js_sdk_engine_project/BuildGreeting") {
    throw new Error(`unexpected tool binding ${bindingEvent?.payload?.tool_ref}`);
  }
  if (!bindingEvent.payload.secret_handles_used.includes("DEMO_API_KEY")) {
    throw new Error("expected DEMO_API_KEY handle in trace");
  }
  if (run.messages[0]?.text !== "Hello Bamba from ToubaEngine") {
    throw new Error(`unexpected show message ${run.messages[0]?.text}`);
  }
}

function assertNoSecretLeak(traceText) {
  if (traceText.includes(secretValue)) {
    throw new Error("trace includes resolved DEMO_API_KEY value");
  }
}
