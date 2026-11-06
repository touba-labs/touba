import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";
import { generateSupplyChainLock } from "../../touba-supply-chain/src/generate.mjs";

import {
  applyRunProfileToArgs,
  checkProjectSecret,
  initProject,
  listProjectSecrets,
  newModule,
  prepareProject,
  removeProjectSecret,
  renderReport,
  resolveProjectRunArgs,
  setProjectSecret,
} from "../src/project.mjs";

import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";
import { createToubaProjectServer } from "../../touba-project-server/src/serve.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = new URL("../src/main.mjs", import.meta.url).pathname;
const implementationRoot = join(testDir, "../../..");
const releaseVersion = JSON.parse(readFileSync(join(implementationRoot, "package.json"), "utf8")).version;
const linearAirFixture = join(implementationRoot, "tests/air/tb-v01-001-linear-skill.air.json");
const projectInspectionSchema = join(
  implementationRoot,
  "contracts/product-surfaces/schemas/touba-project-inspection-v1.schema.json",
);
const effectiveProjectSchema = join(
  implementationRoot,
  "contracts/product-surfaces/schemas/touba-effective-project-v1.schema.json",
);
const triggerRunnerFixture = join(
  implementationRoot,
  "grammar/tree-sitter-touba/examples/triggers-anneau-2/positive/tb-a2-trigger-p04-runner-revue-matinale.tb",
);

test("init creates project folders without creating a manifest", () => {
  const root = tempRoot();
  try {
    const report = initProject({ root });
    assert.equal(report.command, "init");
    assert.equal(existsSync(join(root, "src")), true);
    assert.equal(existsSync(join(root, "handlers")), true);
    assert.equal(existsSync(join(root, ".touba")), true);
    assert.equal(existsSync(join(root, "touba.project.json")), true);
    assert.equal(existsSync(join(root, ".touba/build")), true);
    assert.equal(existsSync(join(root, ".touba/state")), true);
    assert.equal(existsSync(join(root, ".touba/evidence")), true);
    assert.equal(existsSync(join(root, ".touba/state/secrets.local.json")), true);
    assert.equal(existsSync(join(root, ".env")), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
    assert.equal(existsSync(join(root, "touba.secrets.dev.json")), false);
    assert.equal(existsSync(join(root, "touba.secrets.prod.json")), false);
    const store = JSON.parse(readFileSync(join(root, ".touba/state/secrets.local.json"), "utf8"));
    assert.equal(store.store_version, "touba-secret-store-local-v1");
    assert.deepEqual(store.secrets, {});
    const projectConfig = JSON.parse(readFileSync(join(root, "touba.project.json"), "utf8"));
    assert.deepEqual(projectConfig, {
      project_version: "touba-project-v1",
      language: "javascript",
      sdk: "@touba/sdk",
      artifact_layout: "touba-artifacts-v1",
      run_profiles: {
        pure: {
          require_supply_chain_lock: false,
        },
        dev: {
          require_supply_chain_lock: false,
        },
        prod: {
          require_supply_chain_lock: true,
          supply_chain_lock: "touba.lock.json",
        },
      },
    });
    assert.equal(report.language, "javascript");
    assert.equal(report.sdk, "@touba/sdk");
    const gitignore = readFileSync(join(root, ".gitignore"), "utf8");
    assert.match(gitignore, /\.touba\//);
    assert.match(gitignore, /^\.env$/m);
    assert.equal(gitignore.includes("touba.manifest.json"), false);
  } finally {
    cleanup(root);
  }
});

test("init supports Python and refuses the reserved TypeScript generator", () => {
  const root = tempRoot();
  try {
    const result = spawnSync(process.execPath, [
      cliPath,
      "init",
      "--root",
      root,
      "--language",
      "typescript",
    ], { encoding: "utf8" });
    assert.equal(result.status, 2);
    assert.match(result.stderr, /project language typescript is not available in this V1; choose javascript/);
    assert.equal(existsSync(join(root, "touba.project.json")), false);
    const python = initProject({ root, language: "python" });
    assert.equal(python.sdk, "touba-sdk");
    assert.equal(python.language, "python");
  } finally {
    cleanup(root);
  }
});

test("new module writes canonical dotted module under src", () => {
  const root = tempRoot();
  try {
    const report = newModule("donnees_quebec.live_search", { root });
    const sourcePath = join(root, "src/donnees_quebec/live_search.tb");
    assert.equal(report.source_path, sourcePath);
    assert.equal(readFileSync(sourcePath, "utf8"), "module donnees_quebec.live_search\n");
    assert.throws(() => newModule("scratch", { root }), /at least two lowercase dotted/);
    assert.throws(() => newModule("DonneesQuebec.live_search", { root }), /lowercase dotted/);
    assert.throws(() => newModule("donnees_quebec.live_search", { root }), /already exists/);
  } finally {
    cleanup(root);
  }
});

// Package authoring, refusal and CLI tests live in packages.test.mjs.

test("secret store commands manage handles without printing values", () => {
  const root = tempRoot();
  try {
    const setReport = setProjectSecret("OPENAI_API_KEY", "local-secret-value", { root });
    const storePath = join(root, ".touba/state/secrets.local.json");
    assert.equal(setReport.store_path, storePath);
    assert.deepEqual(setReport.handles, ["OPENAI_API_KEY"]);
    const store = JSON.parse(readFileSync(storePath, "utf8"));
    assert.equal(store.store_version, "touba-secret-store-local-v1");
    assert.equal(store.secrets.OPENAI_API_KEY, "local-secret-value");

    const listReport = listProjectSecrets({ root });
    assert.deepEqual(listReport.handles, ["OPENAI_API_KEY"]);
    assert.equal(JSON.stringify(listReport).includes("local-secret-value"), false);

    const checkReport = checkProjectSecret("OPENAI_API_KEY", { root });
    assert.equal(checkReport.present, true);

    const removeReport = removeProjectSecret("OPENAI_API_KEY", { root });
    assert.equal(removeReport.removed, true);
    assert.equal(checkProjectSecret("OPENAI_API_KEY", { root }).present, false);
    assert.throws(() => setProjectSecret("openai", "value", { root }), /secret handles/);
  } finally {
    cleanup(root);
  }
});

test("CLI secret set reads value from stdin and never writes it to stdout", () => {
  const root = tempRoot();
  try {
    const setResult = spawnSync(process.execPath, [
      cliPath,
      "secret",
      "set",
      "OPENAI_API_KEY",
      "--root",
      root,
      "--value-stdin",
    ], {
      input: "stdin-secret-value\n",
      encoding: "utf8",
    });
    assert.equal(setResult.status, 0);
    assert.equal(setResult.stdout.includes("stdin-secret-value"), false);

    const listResult = spawnSync(process.execPath, [
      cliPath,
      "secret",
      "list",
      "--root",
      root,
    ], { encoding: "utf8" });
    assert.equal(listResult.status, 0);
    assert.match(listResult.stdout, /OPENAI_API_KEY/);
    assert.equal(listResult.stdout.includes("stdin-secret-value"), false);
  } finally {
    cleanup(root);
  }
});

test("CLI serve command exposes the Touba project server", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "serve",
    "--help",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /touba serve/);
  assert.match(result.stdout, /Touba project server/);
  assert.match(result.stdout, /human-decisions/);
  assert.match(result.stdout, /project-root/);
  assert.match(result.stdout, /change-proposals/);
  assert.match(result.stdout, /event-journal/);
  assert.match(result.stdout, /port: 8791/);
});

test("CLI deploy exposes revision operations and stable content-bound plans", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), "module demo.deployment\n", "utf8");
    writeJson(join(root, "touba.project.json"), {
      project_version: "touba-project-v1",
      artifact_layout: "touba-artifacts-v1",
      language: "javascript",
      sdk: "@touba/sdk",
      run_profiles: {
        dev: { require_supply_chain_lock: false },
        prod: { require_supply_chain_lock: true, supply_chain_lock: "touba.lock.json" },
      },
    });
    writeJson(join(root, "touba.manifest.json"), {
      manifest_version: "touba-manifest-v1",
      bindings: {},
      triggers: {},
    });
    writeJson(join(root, "touba.lock.json"), {
      lock_version: "touba-lock-v1",
      artifacts: [],
    });

    const help = spawnSync(process.execPath, [cliPath, "deploy", "--help"], { encoding: "utf8" });
    assert.equal(help.status, 0, help.stderr);
    assert.match(help.stdout, /deploy plan/u);
    assert.match(help.stdout, /deploy publish/u);
    assert.match(help.stdout, /deploy activate/u);
    assert.match(help.stdout, /deploy rollback/u);
    assert.match(help.stdout, /deploy target serve/u);

    const args = [
      cliPath,
      "deploy",
      "plan",
      "--root",
      root,
      "--profile",
      "dev",
      "--target",
      "http://127.0.0.1:8792",
      "--json",
    ];
    const first = spawnSync(process.execPath, args, { encoding: "utf8" });
    const second = spawnSync(process.execPath, args, { encoding: "utf8" });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(second.status, 0, second.stderr);
    const firstPlan = JSON.parse(first.stdout);
    const secondPlan = JSON.parse(second.stdout);
    assert.equal(firstPlan.status, "ready");
    assert.equal(firstPlan.bundle_id, secondPlan.bundle_id);
    assert.equal(firstPlan.bundle_sha256, secondPlan.bundle_sha256);
    const deploymentPlanSchema = JSON.parse(readFileSync(projectInspectionSchema.replace(
      "touba-project-inspection-v1.schema.json",
      "touba-deployment-plan-v1.schema.json",
    ), "utf8"));
    assert.deepEqual(validateObject(deploymentPlanSchema, firstPlan), []);
  } finally {
    cleanup(root);
  }
});

test("CLI deployment refuses a dirty production source before contacting its target", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "main.tb"), "module demo.deployment\n", "utf8");
    writeJson(join(root, "touba.project.json"), {
      project_version: "touba-project-v1",
      artifact_layout: "touba-artifacts-v1",
      language: "javascript",
      sdk: "@touba/sdk",
    });
    writeJson(join(root, "touba.lock.json"), {
      lock_version: "touba-lock-v1",
      artifacts: [],
    });
    const result = spawnSync(process.execPath, [
      cliPath,
      "deploy",
      "publish",
      "--root",
      root,
      "--profile",
      "prod",
      "--target",
      "http://127.0.0.1:1",
      "--auth-token-env",
      "TOUBA_TEST_DEPLOY_TOKEN",
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        TOUBA_TEST_DEPLOY_TOKEN: "deployment-test-token-with-at-least-32-characters",
      },
    });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /deployment blocked.*clean source revision/iu);
    assert.doesNotMatch(result.stderr, /unavailable|ECONNREFUSED/iu);
  } finally {
    cleanup(root);
  }
});

test("CLI refresh signals an existing Touba project server", async () => {
  const root = tempRoot();
  const contractsRoot = join(implementationRoot, "contracts", "product-surfaces");
  writeFileSync(join(root, "main.tb"), "module demo.main\n", "utf8");
  const service = createToubaProjectServer({
    contractsRoot,
    projectRoot: root,
    humanDecisionsPath: join(root, ".touba", "human-decisions.sqlite"),
    changeProposalsPath: join(root, ".touba", "studio-change-proposals.json"),
    port: 0,
    quiet: true,
  });
  try {
    await service.start();
    const url = `http://127.0.0.1:${service.server.address().port}`;
    writeFileSync(join(root, "main.tb"), "module demo.main\n// changed\n", "utf8");
    const result = await runCliAsync([
      cliPath,
      "refresh",
      "--url",
      url,
      "--reason",
      "test-refresh",
    ]);

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.schema_version, "touba-project-refresh-v1");
    assert.equal(report.status, "refreshed");
    assert.deepEqual(report.changes.changed_artifacts.map((item) => item.relative_path), ["main.tb"]);
  } finally {
    await service.stop();
    cleanup(root);
  }
});

test("CLI serve streams its startup address before the server exits", async () => {
  const root = tempRoot();
  writeFileSync(join(root, "main.tb"), "module demo.main\n");
  const child = spawn(process.execPath, [cliPath, "serve", "--project-root", root, "--port", "0"], {
    detached: process.platform !== "win32", stdio: ["ignore", "pipe", "pipe"],
  });
  const closed = new Promise(resolve => child.once("close", resolve));
  try {
    const startup = await new Promise((resolve, reject) => {
      let stdout = "", stderr = "";
      const timer = setTimeout(() => reject(new Error(`server startup was not streamed: ${stderr}`)), 15000);
      child.stderr.on("data", bytes => { stderr += bytes; });
      child.stdout.on("data", bytes => {
        stdout += bytes;
        if (stdout.includes("\n")) {
          clearTimeout(timer);
          try { resolve(JSON.parse(stdout.split("\n")[0])); } catch (error) { reject(error); }
        }
      });
      child.once("error", error => { clearTimeout(timer); reject(error); });
      child.once("close", () => { clearTimeout(timer); reject(new Error(`server exited before startup: ${stderr}`)); });
    });
    assert.equal(startup.event, "touba_project_server_started");
    assert.ok(startup.port > 0);
    assert.equal(child.exitCode, null);
  } finally {
    if (child.exitCode === null && child.pid) {
      if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/t", "/f"]);
      else process.kill(-child.pid, "SIGTERM");
    }
    await closed;
    cleanup(root);
  }
});

test("CLI refresh requires an explicit project server URL", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "refresh",
  ], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires --url/);
});

test("CLI rejects the legacy product command", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "product",
    "--help",
  ], { encoding: "utf8" });

  assert.equal(result.status, 2);
  assert.doesNotMatch(result.stdout, /\bproduct\b/);
});

test("prepare plan reports AIR, manifest and handler stub actions for tools", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    const report = await prepareProject({
      root,
      mode: "plan",
      airPaths: ["input.air.json"],
    });
    assert.equal(report.status, "needs_changes");
    assert.deepEqual(report.tools, ["tool:donnees_quebec.live_search/SearchDatasets"]);
    assert.equal(report.actions.some((item) => item.kind === "would_create_manifest"), true);
    assert.equal(report.actions.some((item) => item.kind === "would_create_handler_stub"), true);
    assert.equal(report.actions.some((item) => item.kind === "would_create_handler_contract_test"), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
  } finally {
    cleanup(root);
  }
});

test("prepare detects changed generated handler contracts without overwriting business code", async () => {
  const root = tempRoot();
  try {
    const path = join(root, "input.air.json");
    const air = airDocumentWithTool();
    air.definitions.tools[0].signature.inputs[0].source_ref = { source_id: "source.tb", start_line: 1, start_column: 0, end_line: 1, end_column: 10 };
    writeFileSync(path, JSON.stringify(air));
    await prepareProject({ root, mode: "write", airPaths: ["input.air.json"] });
    const stable = await prepareProject({ root, mode: "check", airPaths: ["input.air.json"] });
    assert.equal(stable.diagnostics.some(item => item.code === "HandlerDeclaredContractDrift"), false);
    const handler = join(root, "handlers/donnees_quebec/live_search/search_datasets.handler.mjs");
    const original = readFileSync(handler, "utf8") + "\n// Custom business implementation must survive preparation.\n";
    writeFileSync(handler, original);
    air.definitions.tools[0].required_secrets.push("SECOND_TOKEN");
    writeFileSync(path, JSON.stringify(air));
    for (const mode of ["write", "check"]) {
      const result = await prepareProject({ root, mode, airPaths: ["input.air.json"] });
      assert.ok(result.diagnostics.some(item => item.code === "HandlerDeclaredContractDrift"), JSON.stringify(result));
      assert.match(renderReport(result), /SECOND_TOKEN|REQUIRED_SECRET_HANDLES/);
      assert.equal(readFileSync(handler, "utf8"), original);
      if (mode === "check") assert.equal(result.status, "error");
    }
  } finally { cleanup(root); }
});

test("prepare write creates one project manifest and module-scoped handler stubs", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    const report = await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
      handlerCommand: "/usr/bin/node",
    });
    assert.equal(report.status, "needs_changes");
    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    assert.equal(binding.handler.command, "/usr/bin/node");
    assert.deepEqual(binding.handler.args, ["handlers/donnees_quebec/live_search/search_datasets.handler.mjs"]);
    assert.equal(binding.handler.cwd, "../../..");
    assert.deepEqual(binding.grants, []);
    assert.deepEqual(binding.secrets, []);
    assert.equal(existsSync(join(root, "handlers/donnees_quebec/live_search/search_datasets.handler.mjs")), true);
    assert.match(
      readFileSync(join(root, "handlers/donnees_quebec/live_search/search_datasets.handler.mjs"), "utf8"),
      /from "@touba\/sdk"/,
    );
    assert.match(
      readFileSync(join(root, "handlers/donnees_quebec/live_search/search_datasets.handler.mjs"), "utf8"),
      /defineTool/,
    );
    assert.equal(
      existsSync(join(root, "handlers/donnees_quebec/live_search/search_datasets.handler.contract.test.mjs")),
      true,
    );
    assert.match(
      readFileSync(join(root, "handlers/donnees_quebec/live_search/search_datasets.handler.contract.test.mjs"), "utf8"),
      /createToolHandler/,
    );
    const projectConfig = JSON.parse(readFileSync(join(root, "touba.project.json"), "utf8"));
    assert.equal(projectConfig.language, "javascript");
    assert.equal(projectConfig.sdk, "@touba/sdk");
    assert.equal(existsSync(join(root, ".touba/state/secrets.local.json")), true);
    assert.equal(existsSync(join(root, ".env")), true);
    const devSecrets = JSON.parse(readFileSync(join(root, "touba.secrets.dev.json"), "utf8"));
    assert.equal(devSecrets.secrets_version, "touba-secrets-v1");
    assert.deepEqual(devSecrets.secrets.API_TOKEN, {
      source: "touba_store",
      path: ".touba/state/secrets.local.json",
      name: "API_TOKEN",
    });
    const prodSecrets = JSON.parse(readFileSync(join(root, "touba.secrets.prod.json"), "utf8"));
    assert.deepEqual(prodSecrets.secrets.API_TOKEN, {
      source: "env",
      name: "API_TOKEN",
    });
  } finally {
    cleanup(root);
  }
});

test("prepare accepts request-trigger inputs supplied by payload mappings", async () => {
  const root = tempRoot();
  try {
    writeFileSync(
      join(root, "input.air.json"),
      JSON.stringify(airDocumentWithPayloadTrigger(), null, 2),
      "utf8",
    );
    const report = await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
    });

    assert.equal(report.status, "success");
    assert.equal(
      report.diagnostics.some((diagnostic) => diagnostic.code === "MissingTriggerArgument"),
      false,
    );
  } finally {
    cleanup(root);
  }
});

test("prepare write preserves existing secret profile entries and adds missing handles", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    writeFileSync(join(root, "touba.secrets.dev.json"), JSON.stringify({
      secrets_version: "touba-secrets-v1",
      secrets: {
        API_TOKEN: {
          source: "dotenv",
          path: ".env",
          name: "CUSTOM_API_TOKEN",
        },
      },
    }, null, 2), "utf8");
    const report = await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
    });
    assert.equal(report.status, "needs_changes");
    const devSecrets = JSON.parse(readFileSync(join(root, "touba.secrets.dev.json"), "utf8"));
    assert.deepEqual(devSecrets.secrets.API_TOKEN, {
      source: "dotenv",
      path: ".env",
      name: "CUSTOM_API_TOKEN",
    });
    const prodSecrets = JSON.parse(readFileSync(join(root, "touba.secrets.prod.json"), "utf8"));
    assert.deepEqual(prodSecrets.secrets.API_TOKEN, {
      source: "env",
      name: "API_TOKEN",
    });
  } finally {
    cleanup(root);
  }
});

test("prepare composes explicit binding fragments into the project manifest", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    writeJson(join(root, "bindings.search.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          handler: {
            kind: "process",
            command: "node",
            args: ["custom/search.handler.mjs"],
            cwd: ".",
          },
          grants: ["network"],
          secrets: ["API_TOKEN"],
          timeout_ms: 12000,
          max_payload_bytes: 2048,
          effect_contract: {
            kind: "external_write",
            retry_mode: "idempotency_key",
          },
          payload_constraints: {
            input: {
              request: { non_empty: true, max_length: 80 },
              "request.tags": { min_items: 1, max_items: 5 },
              "request.mode": { allowed_values: ["dry_run", "review"] },
            },
          },
        },
      },
    }));

    const report = await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
      bindingFragmentPaths: ["bindings.search.json"],
    });

    assert.equal(report.status, "success");
    assert.equal(report.binding_fragments.length, 1);
    assert.equal(report.actions.some((item) => item.kind === "compose_binding_fragment"), true);
    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    assert.equal(manifest.manifest_version, "touba-manifest-v1");
    assert.equal(binding.handler.args[0], "custom/search.handler.mjs");
    assert.equal(binding.timeout_ms, 12000);
    assert.equal(binding.max_payload_bytes, 2048);
    const manifestBeforeConflict = readFileSync(report.manifest_path, "utf8");
    const conflictOptions = { root, mode: "write", airPaths: ["input.air.json"], bindingFragmentPaths: ["bindings.search.json"] };
    const conflicting = await prepareProject({ ...conflictOptions, hostDecisions: { bindings: {
      "tool:donnees_quebec.live_search/SearchDatasets": { timeout_ms: 1000 },
    } } });
    assert.equal(conflicting.status, "error");
    assert.ok(conflicting.diagnostics.some(d => d.code === "HostDecisionFragmentConflict"));
    assert.equal(readFileSync(report.manifest_path, "utf8"), manifestBeforeConflict);
    const fragment = JSON.parse(readFileSync(join(root, "bindings.search.json"), "utf8"));
    fragment.bindings["tool:donnees_quebec.live_search/SearchDatasets"].timeout_ms = 13000;
    writeJson(join(root, "bindings.search.json"), fragment);
    const plan = await prepareProject({ ...conflictOptions, mode: "plan" });
    assert.equal(plan.status, "needs_changes", JSON.stringify(plan.diagnostics));
    assert.ok(plan.actions.some(action => action.kind === "would_update_fragment_binding"
      && action.field === "timeout_ms" && action.before === 12000 && action.after === 13000));
    assert.equal(readFileSync(report.manifest_path, "utf8"), manifestBeforeConflict);
    const updated = await prepareProject(conflictOptions);
    assert.equal(updated.status, "success", JSON.stringify(updated.diagnostics));
    assert.equal(JSON.parse(readFileSync(report.manifest_path, "utf8"))
      .bindings["tool:donnees_quebec.live_search/SearchDatasets"].timeout_ms, 13000);
    assert.equal((await prepareProject({ ...conflictOptions, mode: "check" })).status, "success");
    assert.deepEqual(binding.payload_constraints.input.request, { non_empty: true, max_length: 80 });
    assert.deepEqual(binding.payload_constraints.input["request.tags"], { min_items: 1, max_items: 5 });
    assert.deepEqual(binding.payload_constraints.input["request.mode"], { allowed_values: ["dry_run", "review"] });
    assert.deepEqual(binding.effect_contract, {
      kind: "external_write",
      retry_mode: "idempotency_key",
    });
  } finally {
    cleanup(root);
  }
});

test("prepare preserves compensation declarations from explicit binding fragments", async () => {
  const root = tempRoot();
  try {
    writeJson(join(root, "input.air.json"), airDocumentWithTool());
    writeJson(join(root, "bindings.compensation.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          handler: { kind: "process", command: "node", args: ["handlers/search.mjs"], cwd: "." },
          grants: ["network"],
          secrets: ["API_TOKEN"],
          timeout_ms: 5000,
          max_payload_bytes: 2048,
          effect_contract: {
            kind: "external_write",
            retry_mode: "idempotency_key",
            compensation: {
              entry_ref: "strategy:donnees_quebec.live_search/CancelSearch",
            },
          },
        },
      },
    }));

    const report = await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
      bindingFragmentPaths: ["bindings.compensation.json"],
    });
    assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    assert.equal(manifest.manifest_version, "touba-manifest-v1");
    assert.deepEqual(
      manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"].effect_contract.compensation,
      { entry_ref: "strategy:donnees_quebec.live_search/CancelSearch" },
    );
  } finally {
    cleanup(root);
  }
});

test("prepare refuses an old manifest even when its effect contract is present", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    const initial = await prepareProject({ root, mode: "write", airPaths: ["input.air.json"] });
    assert.equal(initial.status, "needs_changes");
    const manifestPath = join(root, ".touba/build/dev/touba.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"].effect_contract = { kind: "none" };
    manifest.manifest_version = "touba-manifest-v2";
    writeJson(manifestPath, manifest);

    const report = await prepareProject({ root, mode: "check", airPaths: ["input.air.json"] });
    assert.equal(report.status, "error");
    assert.equal(
      report.diagnostics.some((item) => item.code === "ManifestVersionInvalid"),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test("prepare requires host review for each unresolved effect contract", async () => {
  const root = tempRoot();
  try {
    const air = airDocumentWithTool();
    air.definitions.tools.push({
      id: "tool:donnees_quebec.live_search/CreateBookmark",
      name: "CreateBookmark",
      required_capabilities: ["network"],
      required_secrets: [],
      memory_accesses: [],
    });
    writeJson(join(root, "input.air.json"), air);
    writeJson(join(root, "bindings.search.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/CreateBookmark": {
          handler: {
            kind: "process",
            command: "node",
            args: ["custom/create_bookmark.handler.mjs"],
            cwd: ".",
          },
          grants: ["network"],
          secrets: [],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
          effect_contract: { kind: "external_write", retry_mode: "none" },
        },
      },
    }));

    const fragmentPath = join(root, "bindings.search.json");
    const fragment = JSON.parse(readFileSync(fragmentPath, "utf8"));
    delete fragment.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    writeJson(fragmentPath, fragment);
    const report = await prepareProject({
      root,
      mode: "check",
      airPaths: ["input.air.json"],
      bindingFragmentPaths: ["bindings.search.json"],
    });
    assert.equal(report.status, "error");
    const diagnostic = report.diagnostics.find((item) => item.code === "ManifestEffectReviewRequired");
    assert.ok(diagnostic, JSON.stringify({ diagnostics: report.diagnostics, requirements: report.manifest_requirements, actions: report.actions }));
    assert.equal(diagnostic.tool_ref, "tool:donnees_quebec.live_search/SearchDatasets");
  } finally {
    cleanup(root);
  }
});

test("prepare rejects invalid binding fragments without assembling authority", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    writeJson(join(root, "missing-grant.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "node",
            args: ["custom/search.handler.mjs"],
            cwd: ".",
          },
          grants: [],
          secrets: ["API_TOKEN"],
          timeout_ms: 12000,
          max_payload_bytes: 2048,
        },
      },
    }));
    writeJson(join(root, "duplicate.json"), bindingFragmentDocument());
    writeJson(join(root, "conflict.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "node",
            args: ["other/search.handler.mjs"],
            cwd: ".",
          },
          grants: ["network"],
          secrets: ["API_TOKEN"],
          timeout_ms: 12000,
          max_payload_bytes: 2048,
        },
      },
    }));
    writeJson(join(root, "unknown-tool.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/Unknown": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "node",
            args: ["custom/unknown.handler.mjs"],
            cwd: ".",
          },
          grants: ["network"],
          secrets: [],
          timeout_ms: 12000,
          max_payload_bytes: 2048,
        },
      },
    }));
    writeJson(join(root, "bad-constraint.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "node",
            args: ["custom/search.handler.mjs"],
            cwd: ".",
          },
          grants: ["network"],
          secrets: ["API_TOKEN"],
          timeout_ms: 12000,
          max_payload_bytes: 2048,
          payload_constraints: {
            input: {
              request: { min: 10, max: 1 },
            },
          },
        },
      },
    }));
    writeJson(join(root, "bad-list-constraint.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "node",
            args: ["custom/search.handler.mjs"],
            cwd: ".",
          },
          grants: ["network"],
          secrets: ["API_TOKEN"],
          timeout_ms: 12000,
          max_payload_bytes: 2048,
          payload_constraints: {
            input: {
              "request.tags": { min_items: 3, max_items: 2 },
            },
          },
        },
      },
    }));
    writeJson(join(root, "bad-list-constraint-type.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "node",
            args: ["custom/search.handler.mjs"],
            cwd: ".",
          },
          grants: ["network"],
          secrets: ["API_TOKEN"],
          timeout_ms: 12000,
          max_payload_bytes: 2048,
          payload_constraints: {
            input: {
              "request.tags": { max_items: -1 },
            },
          },
        },
      },
    }));
    writeJson(join(root, "authority.json"), {
      fragment_schema_version: "touba-binding-fragment-v1",
      source: { kind: "module", module: "donnees_quebec.live_search" },
      callable_by: ["strategy:examples/Run"],
      bindings: {},
    });
    writeJson(join(root, "effect-unknown-field.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          ...bindingFragmentDocument().bindings["tool:donnees_quebec.live_search/SearchDatasets"],
          effect_contract: { kind: "none", vendor: "example" },
        },
      },
    }));
    writeJson(join(root, "effect-unknown-mode.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          ...bindingFragmentDocument().bindings["tool:donnees_quebec.live_search/SearchDatasets"],
          effect_contract: { kind: "external_write", retry_mode: "automatic" },
        },
      },
    }));

    const cases = [
      ["missing-grant.json", "BindingFragmentMissingGrant"],
      ["duplicate.json", "BindingFragmentDuplicateBinding", ["duplicate.json", "duplicate.json"]],
      ["conflict.json", "BindingFragmentConflictingBinding", ["duplicate.json", "conflict.json"]],
      ["unknown-tool.json", "BindingFragmentUnknownTool"],
      ["bad-constraint.json", "BindingFragmentConstraintInvalid"],
      ["bad-list-constraint.json", "BindingFragmentConstraintInvalid"],
      ["bad-list-constraint-type.json", "BindingFragmentConstraintInvalid"],
      ["authority.json", "BindingFragmentAuthorityFieldForbidden"],
      ["effect-unknown-field.json", "EffectContractFieldUnknown"],
      ["effect-unknown-mode.json", "EffectRetryModeUnsupported"],
    ];
    for (const [fragmentPath, expectedCode, fragmentPaths = [fragmentPath]] of cases) {
      const report = await prepareProject({
        root,
        mode: "check",
        airPaths: ["input.air.json"],
        bindingFragmentPaths: fragmentPaths,
      });
      assert.equal(report.status, "error", fragmentPath);
      assert.equal(report.diagnostics.some((item) => item.code === expectedCode), true, fragmentPath);
    }
  } finally {
    cleanup(root);
  }
});

test("prepare write uses the current node executable by default", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
    });
    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    assert.equal(binding.handler.command, process.execPath);
  } finally {
    cleanup(root);
  }
});

test("prepare reports required agent secret scopes without granting them", async () => {
  const root = tempRoot();
  try {
    const air = airDocumentWithToolStrategy();
    air.definitions.agents = [
      {
        id: "agent:examples.data_app/Researcher",
        name: "Researcher",
        uses: ["skill:examples.data_app/SearchSkill"],
        callable_by: [{ caller_kind: "strategy", caller_ref: "strategy:examples.data_app/RunSearch" }],
      },
    ];
    writeFileSync(join(root, "input.air.json"), JSON.stringify(air, null, 2), "utf8");
    const report = await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
    });
    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    assert.deepEqual(manifest.agent_secret_scopes, {});
    assert.deepEqual(report.manifest_requirements.agent_secret_scopes, {
      "agent:examples.data_app/Researcher": ["DATA_API_TOKEN"],
    });
  } finally {
    cleanup(root);
  }
});

test("source changes never expand existing host permissions or overwrite a business handler", async () => {
  const root = tempRoot();
  try {
    const air = airDocumentWithToolStrategy();
    writeJson(join(root, "input.air.json"), air);
    const options = { root, mode: "write", airPaths: ["input.air.json"] };
    const draft = await prepareProject(options);
    assert.equal(draft.status, "needs_changes");
    assert.deepEqual(JSON.parse(readFileSync(draft.manifest_path, "utf8")).bindings["tool:examples.data_app/Search"].grants, []);
    // A deliberate host decision in the fixture, never an action of prepare.
    draft.manifest_requirements.bindings["tool:examples.data_app/Search"].effect_contract = { kind: "none" };
    writeFileSync(draft.manifest_path, JSON.stringify(draft.manifest_requirements));
    const originalManifest = readFileSync(draft.manifest_path, "utf8");
    const handlerPath = join(root, "handlers/examples/data_app/search.handler.mjs");
    const businessHandler = "// user-owned implementation, unchanged by prepare\n";
    writeFileSync(handlerPath, businessHandler);
    const authorized = await prepareProject(options);
    assert.equal(authorized.status, "success", JSON.stringify(authorized.diagnostics));
    assert.equal(readFileSync(draft.manifest_path, "utf8"), originalManifest);
    air.definitions.tools[0].required_capabilities.push("filesystem_write");
    air.definitions.tools[0].required_secrets.push("NEW_TOKEN");
    writeJson(join(root, "input.air.json"), air);
    for (const mode of ["plan", "check", "write"]) {
      const report = await prepareProject({ ...options, mode });
      assert.equal(report.status, mode === "check" ? "error" : "needs_changes");
      assert.ok(report.diagnostics.some(item => item.code === "ManifestGrantMissing"));
      assert.ok(report.diagnostics.some(item => item.code === "ManifestSecretMissing"));
      assert.equal(readFileSync(draft.manifest_path, "utf8"), originalManifest);
      assert.equal(readFileSync(handlerPath, "utf8"), businessHandler);
    }
  } finally { cleanup(root); }
});

test("prepare refuses unavailable project SDK languages from project config", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({
      project_version: "touba-project-v1",
      artifact_layout: "touba-artifacts-v1",
      language: "python",
      sdk: "touba",
    }, null, 2), "utf8");
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    const report = await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ProjectConfigInvalid"), true);
    assert.equal(existsSync(join(root, "handlers/donnees_quebec/live_search/search_datasets.handler.mjs")), false);
  } finally {
    cleanup(root);
  }
});

test("prepare write keeps a pure Touba source manifest-free when no tool is declared", async () => {
  const root = tempRoot();
  try {
    const sourcePath = join(root, "src/local/simple.tb");
    mkdirSync(join(root, "src/local"), { recursive: true });
    writeFileSync(sourcePath, "module local.simple\n", "utf8");
    const report = await prepareProject({
      root,
      mode: "write",
      compileSource: () => airDocumentWithoutTools(),
    });
    assert.equal(report.status, "success");
    assert.deepEqual(report.tools, []);
    assert.equal(existsSync(join(root, ".touba/build/dev/air/local/simple.air.json")), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
    assert.equal(existsSync(join(root, "touba.secrets.dev.json")), false);
    assert.equal(existsSync(join(root, "touba.secrets.prod.json")), false);
    assert.equal(existsSync(join(root, "handlers/local/simple")), false);
  } finally {
    cleanup(root);
  }
});

test("prepare write creates an explicit RP-1 run plan for a pure Touba entry", async () => {
  const root = tempRoot();
  try {
    const sourcePath = join(root, "src/local/run.tb");
    mkdirSync(join(root, "src/local"), { recursive: true });
    writeFileSync(sourcePath, "module local.run\n", "utf8");
    const report = await prepareProject({
      root,
      mode: "write",
      runPlanPath: "touba.run-plan.json",
      compileSource: () => airDocumentWithPureStrategy(),
    });

    assert.equal(report.status, "success");
    assert.equal(report.run_plan_path, join(root, "touba.run-plan.json"));
    const plan = JSON.parse(readFileSync(join(root, "touba.run-plan.json"), "utf8"));
    assert.deepEqual(plan, {
      run_plan_schema_version: "touba-run-plan-v1",
      entry_ref: "strategy:local.run/Run",
      air: ".touba/build/dev/air/local/run.air.json",
      project: "touba.project.json",
      profile: "dev",
      outputs: {
        mode: "show",
      },
    });
    assert.equal(existsSync(join(root, ".touba/build/dev/air/local/run.air.json")), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
  } finally {
    cleanup(root);
  }
});

test("multiple strategies share an explicit project entry across write and check", async () => {
  const root = tempRoot();
  try {
    initProject({ root });
    mkdirSync(join(root, "src/local"), { recursive: true });
    writeFileSync(join(root, "src/local/run.tb"), 'module local.run\nstrategy First\n    gives Text\n    do\n        give "first"\nstrategy Second\n    gives Text\n    do\n        give "second"\n');
    const options = { root, runProfile: "pure", entryRef: "strategy:local.run/Second" };
    assert.equal((await prepareProject({ ...options, mode: "write" })).status, "success");
    assert.equal((await prepareProject({ ...options, mode: "check" })).status, "success");
    const drift = await prepareProject({ root, runProfile: "pure", mode: "check" });
    assert.equal(drift.status, "success", JSON.stringify(drift));
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.entry = options.entryRef;
    writeJson(configPath, config);
    for (const mode of ["write", "check"]) {
      assert.equal((await prepareProject({ root, runProfile: "pure", mode })).status, "success");
    }
  } finally { cleanup(root); }
});

test("converged project preparation writes only profile-derived artifacts under .touba/build", async () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.entry = "strategy:local.run/Run";
    writeJson(configPath, config);
    mkdirSync(join(root, "src/local"), { recursive: true });
    writeFileSync(join(root, "src/local/run.tb"), "module local.run\n", "utf8");

    const report = await prepareProject({
      root,
      mode: "write",
      runProfile: "pure",
      compileSource: () => airDocumentWithPureStrategy(),
    });

    assert.equal(report.status, "success");
    assert.equal(report.artifact_layout, "touba-artifacts-v1");
    assert.equal(report.profile, "pure");
    assert.equal(existsSync(join(root, ".touba/build/pure/air/local/run.air.json")), true);
    assert.equal(existsSync(join(root, ".touba/build/pure/touba.run-plan.json")), true);
    assert.equal(existsSync(join(root, ".touba/build/pure/touba.effective-project.json")), true);
    assert.equal(existsSync(join(root, ".touba/build/pure/touba.manifest.json")), false);
    assert.equal(existsSync(join(root, ".touba/air/local/run.air.json")), false);
    assert.equal(existsSync(join(root, "touba.run-plan.json")), false);
    const plan = JSON.parse(readFileSync(join(root, ".touba/build/pure/touba.run-plan.json"), "utf8"));
    assert.equal(plan.air, "air/local/run.air.json");
    assert.equal(plan.profile, "pure");
    const effective = JSON.parse(readFileSync(
      join(root, ".touba/build/pure/touba.effective-project.json"),
      "utf8",
    ));
    assert.equal(effective.schema_version, "touba-effective-project-v1");
    assert.equal(effective.artifact_role, "derived_non_authoritative");
    assert.equal(effective.contract.sources.provenance.status, "declared");
    assert.equal(effective.contract.air.provenance.status, "derived");
    assert.equal(effective.contract.entry.provenance.status, "effective");
    assert.equal(effective.contract.handlers.provenance.status, "non_applicable");
    assert.equal(effective.contract.budgets.provenance.status, "absent");
    assert.equal(JSON.stringify(effective).includes(root), false);
    const schema = JSON.parse(readFileSync(effectiveProjectSchema, "utf8"));
    assert.deepEqual(validateObject(schema, effective), []);
  } finally {
    cleanup(root);
  }
});

test("effective project projection is deterministic, detects drift and never exposes secret values", async () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.entry = "strategy:examples.data_app/RunSearch";
    writeJson(configPath, config);
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/data_app.tb"), "module examples.data_app\n# do-not-project-this-secret\n", "utf8");
    setProjectSecret("DATA_API_TOKEN", "do-not-project-this-secret", { root });

    await prepareProject({
      root,
      mode: "write",
      runProfile: "dev",
      compileSource: () => airDocumentWithToolStrategy(),
    });
    const effectivePath = join(root, ".touba/build/dev/touba.effective-project.json");
    const first = readFileSync(effectivePath, "utf8");
    assert.equal(first.includes("do-not-project-this-secret"), false);
    const document = JSON.parse(first);
    assert.deepEqual(document.contract.secrets.handles, ["DATA_API_TOKEN"]);
    assert.equal(document.contract.secrets.provenance.status, "declared");
    assert.equal(document.contract.handlers.provenance.status, "effective");
    assert.deepEqual(document.contract.grants.bindings[0].capabilities, []);

    await prepareProject({
      root,
      mode: "write",
      runProfile: "dev",
      compileSource: () => airDocumentWithToolStrategy(),
    });
    assert.equal(readFileSync(effectivePath, "utf8"), first);

    document.project.profile = "prod";
    writeJson(effectivePath, document);
    const drift = await prepareProject({
      root,
      mode: "check",
      runProfile: "dev",
      compileSource: () => airDocumentWithToolStrategy(),
    });
    assert.equal(drift.status, "error");
    assert.equal(drift.diagnostics.some((item) => item.code === "EffectiveProjectDrift"), true);
  } finally {
    cleanup(root);
  }
});

test("converged dev preparation keeps tool authority explicit and detects derived manifest drift", async () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.entry = "strategy:examples.data_app/RunSearch";
    writeJson(configPath, config);
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/data_app.tb"), "module examples.data_app\n", "utf8");

    const report = await prepareProject({
      root,
      mode: "write",
      runProfile: "dev",
      compileSource: () => airDocumentWithToolStrategy(),
    });
    assert.equal(report.status, "needs_changes");
    const manifestPath = join(root, ".touba/build/dev/touba.manifest.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
    const binding = manifest.bindings["tool:examples.data_app/Search"];
    assert.equal(binding.handler.cwd, "../../..");
    assert.deepEqual(binding.grants, []);
    assert.deepEqual(binding.secrets, []);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
    assert.equal(existsSync(join(root, ".touba/state/secrets.local.json")), true);
    const devSecrets = JSON.parse(readFileSync(join(root, "touba.secrets.dev.json"), "utf8"));
    assert.equal(devSecrets.secrets.DATA_API_TOKEN.path, ".touba/state/secrets.local.json");

    manifest.bindings["tool:examples.data_app/Search"].grants = [];
    writeJson(manifestPath, manifest);
    const drift = await prepareProject({
      root,
      mode: "check",
      runProfile: "dev",
      compileSource: () => airDocumentWithToolStrategy(),
    });
    assert.equal(drift.status, "error");
    assert.equal(drift.diagnostics.some((item) => item.code === "ManifestGrantMissing"), true);

    manifest.bindings["tool:examples.data_app/Search"].grants = [
      "network",
      "secret_read",
      "filesystem_write",
    ];
    writeJson(manifestPath, manifest);
    const widened = await prepareProject({
      root,
      mode: "check",
      runProfile: "dev",
      compileSource: () => airDocumentWithToolStrategy(),
    });
    assert.equal(widened.status, "error");
    assert.equal(widened.diagnostics.some((item) => item.code === "ManifestSecretMissing"), true);
  } finally {
    cleanup(root);
  }
});

test("converged preparation reads only configuration paths explicitly referenced by the project", async () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.configuration = { binding_fragments: ["bindings.search.json"] };
    writeJson(configPath, config);
    writeJson(join(root, "input.air.json"), airDocumentWithTool());
    writeJson(join(root, "bindings.search.json"), bindingFragmentDocument({
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          handler: {
            kind: "process",
            command: "node",
            args: ["custom/search.handler.mjs"],
            cwd: ".",
          },
          grants: ["network"],
          secrets: ["API_TOKEN"],
          timeout_ms: 12000,
          max_payload_bytes: 2048,
          effect_contract: {
            kind: "external_write",
            retry_mode: "reconcile",
          },
        },
      },
    }));
    writeJson(join(root, "undeclared-authority.json"), { grants: ["filesystem_write"] });

    const report = await prepareProject({ root, mode: "write", airPaths: ["input.air.json"] });
    assert.equal(report.status, "success");
    assert.deepEqual(report.binding_fragments.map((item) => item.path), [join(root, "bindings.search.json")]);
    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    assert.equal(manifest.manifest_version, "touba-manifest-v1");
    assert.deepEqual(binding.grants, ["network"]);
    assert.equal(binding.handler.args[0], "custom/search.handler.mjs");
    assert.deepEqual(binding.effect_contract, { kind: "external_write", retry_mode: "reconcile" });
    const effective = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.effective-project.json"), "utf8"));
    assert.deepEqual(effective.contract.handlers.bindings[0].effect_contract, {
      kind: "external_write",
      retry_mode: "reconcile",
    });
    assert.equal(JSON.stringify(manifest).includes("filesystem_write"), false);
  } finally {
    cleanup(root);
  }
});

test("old project layouts are refused without rewriting user files or exposing migration", async () => {
  const root = tempRoot();
  try {
    const config = { project_version: "touba-project-v1", language: "javascript", sdk: "@touba/sdk" };
    const configPath = join(root, "touba.project.json");
    writeJson(configPath, config);
    const before = readFileSync(configPath, "utf8");
    const report = await prepareProject({ root, mode: "write" });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some(item => item.code === "ProjectConfigInvalid" && /artifact_layout/.test(item.message)), true);
    assert.equal(readFileSync(configPath, "utf8"), before);
    const result = spawnSync(process.execPath, [cliPath, "project", "migrate", "--root", root], { encoding: "utf8" });
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(configPath, "utf8"), before);
  } finally { cleanup(root); }
});

test("project run resolution passes an explicit prepared run plan to the low-level runtime", async () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.entry = "strategy:local.run/Run";
    writeJson(configPath, config);
    mkdirSync(join(root, "src/local"), { recursive: true });
    writeFileSync(join(root, "src/local/run.tb"), "module local.run\n", "utf8");
    await prepareProject({
      root,
      mode: "write",
      runProfile: "dev",
      compileSource: () => airDocumentWithPureStrategy(),
    });

    const args = resolveProjectRunArgs([
      "--project",
      root,
      "--entry",
      "strategy:local.run/Run",
      "--output",
      "trace",
    ]);
    assert.deepEqual(args.slice(0, 2), [
      "--run-plan",
      join(root, ".touba/build/dev/touba.run-plan.json"),
    ]);
    assert.equal(args.includes("--project"), false);
    assert.doesNotThrow(() => resolveProjectRunArgs([
      "--project",
      root,
      "--trace-out",
      "run.json",
    ]));
    assert.throws(
      () => resolveProjectRunArgs(["legacy.air.json", "--project", root]),
      /positional AIR path/,
    );
    assert.throws(
      () => resolveProjectRunArgs(["--project", root, "--entry", "strategy:local.run/Other"]),
      /not a declared project entrypoint/,
    );
  } finally {
    cleanup(root);
  }
});

test("prepare run plan check reports missing, drift and sensitive payloads", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "src/local"), { recursive: true });
    writeFileSync(join(root, "src/local/run.tb"), "module local.run\n", "utf8");

    let report = await prepareProject({
      root,
      mode: "check",
      runPlanPath: "touba.run-plan.json",
      compileSource: () => airDocumentWithPureStrategy(),
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "RunPlanMissing"), true);

    writeJson(join(root, "touba.run-plan.json"), {
      run_plan_schema_version: "touba-run-plan-v1",
      entry_ref: "strategy:local.run/Run",
      air: ".touba/build/dev/air/local/run.air.json",
      profile: "dev",
      outputs: {
        mode: "trace",
      },
    });
    report = await prepareProject({
      root,
      mode: "check",
      runPlanPath: "touba.run-plan.json",
      compileSource: () => airDocumentWithPureStrategy(),
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "RunPlanDrift"), true);

    writeJson(join(root, "touba.run-plan.json"), {
      run_plan_schema_version: "touba-run-plan-v1",
      entry_ref: "strategy:local.run/Run",
      air: ".touba/build/dev/air/local/run.air.json",
      profile: "dev",
      inputs: {
        request: "forbidden",
      },
    });
    report = await prepareProject({
      root,
      mode: "check",
      runPlanPath: "touba.run-plan.json",
      compileSource: () => airDocumentWithPureStrategy(),
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "RunPlanSensitivePayloadForbidden"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare run plan includes manifest, secrets profile and required prod lock authority", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/data_app.tb"), "module examples.data_app\n", "utf8");
    const report = await prepareProject({
      root,
      mode: "write",
      runPlanPath: "touba.run-plan.json",
      runProfile: "prod",
      compileSource: () => airDocumentWithToolStrategy(),
    });

    assert.equal(report.status, "needs_changes");
    const plan = JSON.parse(readFileSync(join(root, "touba.run-plan.json"), "utf8"));
    assert.equal(plan.entry_ref, "strategy:examples.data_app/RunSearch");
    assert.equal(plan.air, ".touba/build/prod/air/examples/data_app.air.json");
    assert.equal(plan.manifest, ".touba/build/prod/touba.manifest.json");
    assert.equal(plan.secrets_profile, "touba.secrets.prod.json");
    assert.equal(plan.profile, "prod");
    assert.equal(plan.supply_chain_lock, "touba.lock.json");
  } finally {
    cleanup(root);
  }
});

test("prepare validates TEAM-1 ownership and review gates without runtime authority", async () => {
  const root = tempRoot();
  try {
    writeJson(join(root, "input.air.json"), airDocumentWithTool());
    writeJson(join(root, "touba.ownership.json"), ownershipDocument({
      owners: {
        "tool:donnees_quebec.live_search/SearchDatasets": ["team:platform"],
      },
      review_gates: {
        prod: {
          requires_review_for: ["tool_binding", "required_capability", "required_secret"],
          reviewers: ["team:security"],
        },
      },
      reviews: [
        {
          review_id: "review:donnees-quebec/security-001",
          profile: "prod",
          target_ref: "tool:donnees_quebec.live_search/SearchDatasets",
          reviewer: "team:security",
          decision: "approved",
          evidence_ref: "reviews/security-001.md",
        },
      ],
    }));

    const report = await prepareProject({
      root,
      mode: "plan",
      airPaths: ["input.air.json"],
      ownershipPath: "touba.ownership.json",
      runProfile: "prod",
    });

    assert.equal(report.status, "needs_changes");
    assert.equal(report.ownership.path, join(root, "touba.ownership.json"));
    assert.equal(report.ownership.profile, "prod");
    assert.equal(report.ownership.team_count, 2);
    assert.equal(report.ownership.owner_count, 1);
    assert.equal(report.ownership.review_count, 1);
    assert.deepEqual(report.ownership.active_gate_subjects, ["tool_binding", "required_capability", "required_secret"]);
    assert.equal(report.actions.some((item) => item.kind === "would_validate_ownership"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "ReviewGateMissing"), false);
    assert.equal(report.diagnostics.some((item) => item.code === "OwnershipAuthorityFieldForbidden"), false);
  } finally {
    cleanup(root);
  }
});

test("prepare ownership reports missing required artifacts and reviews", async () => {
  const root = tempRoot();
  try {
    writeJson(join(root, "input.air.json"), airDocumentWithTool());
    writeJson(join(root, "touba.ownership.json"), ownershipDocument({
      owners: {},
      review_gates: {
        prod: {
          requires_review_for: ["tool_binding", "required_capability", "required_secret"],
          reviewers: ["team:security"],
        },
      },
      reviews: [],
    }));

    const report = await prepareProject({
      root,
      mode: "check",
      airPaths: ["input.air.json"],
      ownershipPath: "touba.ownership.json",
      runProfile: "prod",
    });

    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "OwnershipMissing"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "ReviewGateMissing"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare ownership refuses absent ownership and authority-shaped fields", async () => {
  const root = tempRoot();
  try {
    writeJson(join(root, "input.air.json"), airDocumentWithTool());

    let report = await prepareProject({
      root,
      mode: "check",
      airPaths: ["input.air.json"],
      requireOwnership: true,
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "OwnershipMissing"), true);

    writeJson(join(root, "touba.ownership.json"), {
      ownership_schema_version: "touba-ownership-v1",
      teams: {
        "team:security": {
          display_name: "Security",
        },
      },
      grants: ["network"],
      owners: {},
      review_gates: {},
      reviews: [],
    });
    report = await prepareProject({
      root,
      mode: "check",
      airPaths: ["input.air.json"],
      ownershipPath: "touba.ownership.json",
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "OwnershipAuthorityFieldForbidden"), true);
  } finally {
    cleanup(root);
  }
});

test("CLI prepare accepts explicit ownership validation options", () => {
  const root = tempRoot();
  try {
    writeJson(join(root, "input.air.json"), airDocumentWithTool());
    writeJson(join(root, "touba.ownership.json"), ownershipDocument({
      owners: {
        "tool:donnees_quebec.live_search/SearchDatasets": ["team:platform"],
      },
      review_gates: {
        prod: {
          requires_review_for: ["tool_binding"],
          reviewers: ["team:security"],
        },
      },
      reviews: [
        {
          review_id: "review:donnees-quebec/security-cli",
          profile: "prod",
          target_ref: "tool:donnees_quebec.live_search/SearchDatasets",
          reviewer: "team:security",
          decision: "approved",
        },
      ],
    }));

    const result = spawnSync(process.execPath, [
      cliPath,
      "prepare",
      "--root",
      root,
      "--air",
      "input.air.json",
      "--ownership",
      "touba.ownership.json",
      "--profile",
      "prod",
      "--mode",
      "plan",
      "--json",
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.ownership.profile, "prod");
    assert.equal(report.ownership.review_count, 1);
  } finally {
    cleanup(root);
  }
});

test("real prepare resolves imported fields and signatures before expression typing", async () => {
  const root = tempRoot();
  try {
    initProject({ root });
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/common.tb"), 'module examples.common\ntype Request\n    query is Text\nfunction Normalize\n    takes query as Text\n    gives Text\n    do\n        give query ++ "!"\n');
    writeFileSync(join(root, "src/examples/search.tb"), 'module examples.search\nimport type Request from examples.common\nimport function Normalize from examples.common\nfunction Label\n    takes request as Request\n    gives Text\n    do\n        Normalize\n            with query as request.query\n            into normalized\n        give normalized ++ " done"\n');
    writeFileSync(join(root, "src/examples/consumer.tb"), 'module examples.consumer\nimport function Label from examples.search\nimport function Normalize from examples.common\nfunction Ready\n    gives Text\n    do\n        give "ready"\n');
    const report = await prepareProject({ root, mode: "write", entryRef: "function:examples.search/Label" });
    assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
    const air = JSON.parse(readFileSync(join(root, ".touba/build/dev/air/examples/search.air.json"), "utf8"));
    assert.ok(air.definitions.functions.some(f => f.id === "function:examples.common/Normalize"));
    assert.ok(air.definitions.types.some(f => f.id === "type:examples.common/Request"));
    // Traversing search directly and through consumer must not duplicate its
    // import edges; consumer's own import of Normalize remains distinct.
    const normalizeImports = report.imports.filter(item => item.target_ref === "function:examples.common/Normalize");
    assert.deepEqual(normalizeImports.map(item => item.module_name).sort(), ["examples.consumer", "examples.search"]);
    const importKeys = report.imports.map(item => JSON.stringify([item.module_name, item.from_module, item.target_ref, item.import_name, item.import_kind]));
    assert.equal(new Set(importKeys).size, importKeys.length);
  } finally { cleanup(root); }
});

test("real prepare checks package signatures without granting private exports", async () => {
  const root = tempRoot();
  try {
    initProject({ root });
    writeLocalPackageFixture(root, { exports: { functions: ["function:org.example.research/Public"] } });
    writeFileSync(join(root, "authors/research/src/org/example/research.tb"), 'module org.example.research\nfunction Public\n    gives Text\n    do\n        give "public"\nfunction Private\n    gives Text\n    do\n        give "private"\n');
    const configPath = join(root, "touba.project.json");
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    config.packages = [{ editable: true, manifest: "authors/research/touba.package.json" }];
    writeFileSync(configPath, JSON.stringify(config));
    mkdirSync(join(root, "src/examples"), { recursive: true });
    const sourcePath = join(root, "src/examples/search.tb");
    const source = 'module examples.search\nimport function Public from org.example.research\nfunction Label\n    gives Text\n    do\n        Public\n            into value\n        give value ++ " done"\n';
    writeFileSync(sourcePath, source);
    let report = await prepareProject({ root, mode: "write", entryRef: "function:examples.search/Label" });
    assert.equal(report.status, "success", JSON.stringify(report.diagnostics));
    writeFileSync(sourcePath, source.replaceAll("Public", "Private"));
    report = await prepareProject({ root, mode: "plan" });
    assert.equal(report.status, "error");
    assert.ok(report.diagnostics.some(d => d.code === "PackageExportMissing"), JSON.stringify(report.diagnostics));
  } finally { cleanup(root); }
});

test("prepare write assembles IM-1 imports without creating a manifest for pure modules", async () => {
  const root = tempRoot();
  try {
    const commonPath = join(root, "src/examples/common.tb");
    const searchPath = join(root, "src/examples/search.tb");
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(commonPath, "module examples.common\n", "utf8");
    writeFileSync(searchPath, "module examples.search\n", "utf8");

    const report = await prepareProject({
      root,
      mode: "write",
      compileSource: (sourcePath) => sourcePath.endsWith("common.tb")
        ? airDocumentImportCommon()
        : airDocumentImportSearch(),
    });

    assert.equal(report.status, "success");
    assert.deepEqual(report.tools, []);
    assert.equal(report.imports.length, 3);
    assert.equal(report.imports.some((item) => item.target_ref === "type:examples.common/SearchRequest"), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
    const assembledSearch = JSON.parse(readFileSync(join(root, ".touba/build/dev/air/examples/search.air.json"), "utf8"));
    assert.equal(
      assembledSearch.definitions.types.some((item) => item.id === "type:examples.common/SearchRequest"),
      true,
    );
    assert.equal(
      assembledSearch.definitions.constants.some((item) => item.id === "constant:examples.common/DefaultRows"),
      true,
    );
    assert.equal(
      assembledSearch.definitions.functions.some((item) => item.id === "function:examples.common/NormalizeQuery"),
      true,
    );
    assert.equal(
      assembledSearch.execution_graphs.some((item) => item.owner_ref === "function:examples.common/NormalizeQuery"),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test("prepare write assembles imported tools with declaring-module handler stubs", async () => {
  const root = tempRoot();
  try {
    const dataToolsPath = join(root, "src/examples/data_tools.tb");
    const researchAppPath = join(root, "src/examples/research_app.tb");
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(dataToolsPath, "module examples.data_tools\n", "utf8");
    writeFileSync(researchAppPath, "module examples.research_app\n", "utf8");

    const report = await prepareProject({
      root,
      mode: "write",
      compileSource: (sourcePath) => sourcePath.endsWith("data_tools.tb")
        ? airDocumentImportToolDataTools()
        : airDocumentImportToolResearchApp(),
    });

    assert.equal(report.status, "needs_changes");
    assert.deepEqual(report.tools, ["tool:examples.data_tools/SearchDatasets"]);
    assert.equal(report.imports.some((item) => item.target_ref === "tool:examples.data_tools/SearchDatasets"), true);

    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:examples.data_tools/SearchDatasets"];
    assert.deepEqual(binding.grants, []);
    assert.deepEqual(binding.secrets, []);
    assert.deepEqual(binding.handler.args, ["handlers/examples/data_tools/search_datasets.handler.mjs"]);

    assert.equal(
      existsSync(join(root, "handlers/examples/data_tools/search_datasets.handler.mjs")),
      true,
    );
    assert.equal(
      existsSync(join(root, "handlers/examples/research_app/search_datasets.handler.mjs")),
      false,
    );

    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/build/dev/air/examples/research_app.air.json"), "utf8"));
    assert.equal(
      assembledApp.definitions.tools.some((item) => item.id === "tool:examples.data_tools/SearchDatasets"),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test("prepare write assembles imported skills and strategies without creating handlers", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/shared_flow.tb"), "module examples.shared_flow\n", "utf8");
    writeFileSync(join(root, "src/examples/flow_app.tb"), "module examples.flow_app\n", "utf8");

    const report = await prepareProject({
      root,
      mode: "write",
      compileSource: (sourcePath) => sourcePath.endsWith("shared_flow.tb")
        ? airDocumentImportFlowShared()
        : airDocumentImportFlowApp(),
    });

    assert.equal(report.status, "needs_changes");
    assert.equal(report.actions.some(item => item.kind === "select_entry"), true);
    assert.deepEqual(report.tools, []);
    assert.equal(report.imports.some((item) => item.target_ref === "skill:examples.shared_flow/NormalizeTopic"), true);
    assert.equal(report.imports.some((item) => item.target_ref === "strategy:examples.shared_flow/SharedTopicRun"), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);

    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/build/dev/air/examples/flow_app.air.json"), "utf8"));
    assert.equal(
      assembledApp.definitions.skills.some((item) => item.id === "skill:examples.shared_flow/NormalizeTopic"),
      true,
    );
    assert.equal(
      assembledApp.definitions.strategies.some((item) => item.id === "strategy:examples.shared_flow/SharedTopicRun"),
      true,
    );
    assert.equal(
      assembledApp.execution_graphs.some((item) => item.owner_ref === "strategy:examples.shared_flow/SharedTopicRun"),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test("prepare validates imported agent callable_by across modules", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/agent_pool.tb"), "module examples.agent_pool\n", "utf8");
    writeFileSync(join(root, "src/examples/agent_app.tb"), "module examples.agent_app\n", "utf8");

    let report = await prepareProject({
      root,
      mode: "write",
      compileSource: (sourcePath) => sourcePath.endsWith("agent_pool.tb")
        ? airDocumentImportAgentPool()
        : airDocumentImportAgentApp(),
    });

    assert.equal(report.status, "success");
    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/build/dev/air/examples/agent_app.air.json"), "utf8"));
    assert.equal(
      assembledApp.definitions.agents.some((item) => item.id === "agent:examples.agent_pool/Reviewer"),
      true,
    );

    cleanup(root);
    const unauthorizedRoot = tempRoot();
    mkdirSync(join(unauthorizedRoot, "src/examples"), { recursive: true });
    writeFileSync(join(unauthorizedRoot, "src/examples/agent_pool.tb"), "module examples.agent_pool\n", "utf8");
    writeFileSync(join(unauthorizedRoot, "src/examples/agent_app_unauthorized.tb"), "module examples.agent_app_unauthorized\n", "utf8");
    try {
      report = await prepareProject({
        root: unauthorizedRoot,
        mode: "plan",
        compileSource: (sourcePath) => sourcePath.endsWith("agent_pool.tb")
          ? airDocumentImportAgentPool()
          : airDocumentImportAgentAppUnauthorized(),
      });
      assert.equal(report.status, "error");
      assert.equal(report.diagnostics.some((item) => item.code === "AgentCallerNotAllowed"), true);
    } finally {
      cleanup(unauthorizedRoot);
    }
  } finally {
    if (existsSync(root)) {
      cleanup(root);
    }
  }
});

test("prepare assembles imported logical memory and refuses missing owner scope", async () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/shared_memory.tb"), "module examples.shared_memory\n", "utf8");
    writeFileSync(join(root, "src/examples/memory_tools.tb"), "module examples.memory_tools\n", "utf8");
    writeFileSync(join(root, "src/examples/memory_app.tb"), "module examples.memory_app\n", "utf8");

    let report = await prepareProject({
      root,
      mode: "write",
      compileSource: (sourcePath) => {
        if (sourcePath.endsWith("shared_memory.tb")) return airDocumentImportSharedMemory();
        if (sourcePath.endsWith("memory_tools.tb")) return airDocumentImportMemoryTools();
        return airDocumentImportMemoryApp();
      },
    });

    assert.equal(report.status, "needs_changes");
    assert.deepEqual(report.tools, ["tool:examples.memory_tools/ReadKnowledge"]);
    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/build/dev/air/examples/memory_app.air.json"), "utf8"));
    assert.equal(
      assembledApp.definitions.memories.some((item) => item.id === "memory:examples.shared_memory/ProjectKnowledge"),
      true,
    );

    cleanup(root);
    const missingScopeRoot = tempRoot();
    mkdirSync(join(missingScopeRoot, "src/examples"), { recursive: true });
    writeFileSync(join(missingScopeRoot, "src/examples/shared_memory.tb"), "module examples.shared_memory\n", "utf8");
    writeFileSync(join(missingScopeRoot, "src/examples/memory_tools.tb"), "module examples.memory_tools\n", "utf8");
    writeFileSync(join(missingScopeRoot, "src/examples/memory_app_missing_scope.tb"), "module examples.memory_app_missing_scope\n", "utf8");
    try {
      report = await prepareProject({
        root: missingScopeRoot,
        mode: "plan",
        compileSource: (sourcePath) => {
          if (sourcePath.endsWith("shared_memory.tb")) return airDocumentImportSharedMemory();
          if (sourcePath.endsWith("memory_tools.tb")) return airDocumentImportMemoryTools();
          return airDocumentImportMemoryAppMissingScope();
        },
      });
      assert.equal(report.status, "error");
      assert.equal(report.diagnostics.some((item) => item.code === "OwnerMemoryScopeMissing"), true);
    } finally {
      cleanup(missingScopeRoot);
    }
  } finally {
    if (existsSync(root)) {
      cleanup(root);
    }
  }
});

test("prepare validates RB-1 resource bindings for memory resources", async () => {
  const root = tempRoot();
  try {
    writeJson(join(root, "memory.air.json"), airDocumentWithMemoryResource());
    writeJson(join(root, "touba.resources.json"), resourceBindingsDocument());

    const report = await prepareProject({
      root,
      mode: "write",
      airPaths: ["memory.air.json"],
      resourceBindingsPaths: ["touba.resources.json"],
      requireResourceBindings: true,
    });

    assert.equal(report.status, "needs_changes");
    assert.equal(report.resource_bindings.length, 1);
  } finally {
    cleanup(root);
  }
});

test("prepare rejects RB-1 resource binding schema, authority and scope errors", async () => {
  const root = tempRoot();
  try {
    writeJson(join(root, "memory.air.json"), airDocumentWithMemoryResource());
    writeJson(join(root, "memory-missing-scope.air.json"), airDocumentWithMemoryResource({ withScope: false }));
    writeJson(join(root, "schema.json"), {
      resource_bindings_schema_version: "unknown",
      resources: {},
    });
    writeJson(join(root, "unknown.json"), resourceBindingsDocument({
      resources: {
        "memory:examples.memory/Unknown": {
          kind: "memory_backend",
          provider: "host.local",
          grants: ["memory.read"],
          secrets: [],
        },
      },
    }));
    writeJson(join(root, "unsupported.json"), resourceBindingsDocument({
      resources: {
        "memory:examples.memory/Notes": {
          kind: "trace_store",
          provider: "host.local",
          grants: ["memory.read"],
          secrets: [],
        },
      },
    }));
    writeJson(join(root, "inactive.json"), resourceBindingsDocument({
      resources: {
        "memory:examples.memory/Notes": {
          kind: "memory_backend",
          provider: "host.local",
          grants: ["memory.read"],
          secrets: [],
          active: false,
        },
      },
    }));
    writeJson(join(root, "missing-secret.json"), resourceBindingsDocument({
      resources: {
        "memory:examples.memory/Notes": {
          kind: "memory_backend",
          provider: "host.local",
          grants: ["memory.read"],
          secrets: [],
          required_secrets: ["DATABASE_URL"],
        },
      },
    }));
    writeJson(join(root, "missing-grant.json"), resourceBindingsDocument({
      resources: {
        "memory:examples.memory/Notes": {
          kind: "memory_backend",
          provider: "host.local",
          grants: [],
          secrets: [],
        },
      },
    }));
    writeJson(join(root, "payload.json"), resourceBindingsDocument({
      resources: {
        "memory:examples.memory/Notes": {
          kind: "memory_backend",
          provider: "host.local",
          grants: ["memory.read"],
          secrets: [],
          connection_string: "postgres://must-not-appear",
        },
      },
    }));

    const cases = [
      ["schema.json", "ResourceBindingsSchemaMismatch"],
      ["unknown.json", "ResourceBindingUnknownResource"],
      ["unsupported.json", "ResourceBindingUnsupportedKind"],
      ["inactive.json", "ResourceBindingInactive"],
      ["missing-secret.json", "ResourceBindingSecretMissing"],
      ["missing-grant.json", "ResourceBindingGrantMissing"],
      ["payload.json", "ResourceBindingPayloadForbidden"],
    ];
    for (const [resourceBindingsPath, expectedCode] of cases) {
      const report = await prepareProject({
        root,
        mode: "check",
        airPaths: ["memory.air.json"],
        resourceBindingsPaths: [resourceBindingsPath],
      });
      assert.equal(report.status, "error", resourceBindingsPath);
      assert.equal(report.diagnostics.some((item) => item.code === expectedCode), true, resourceBindingsPath);
      assert.equal(JSON.stringify(report).includes("postgres://must-not-appear"), false);
    }

    const missingReport = await prepareProject({
      root,
      mode: "check",
      airPaths: ["memory.air.json"],
      requireResourceBindings: true,
    });
    assert.equal(missingReport.status, "error");
    assert.equal(missingReport.diagnostics.some((item) => item.code === "ResourceBindingMissing"), true);

    const scopeReport = await prepareProject({
      root,
      mode: "check",
      airPaths: ["memory-missing-scope.air.json"],
      resourceBindingsPaths: ["touba.resources.json"],
    });
    assert.equal(scopeReport.status, "error");
    assert.equal(scopeReport.diagnostics.some((item) => item.code === "ResourceBindingScopeMissing"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare assembles explicitly configured local package exports without package auto-authority", async () => {
  const root = tempRoot();
  try {
    writeLocalPackageFixture(root, {
      exports: {
        types: [
          "type:org.example.research/DatasetSearchRequest",
          "type:org.example.research/DatasetSearchResult",
        ],
        tools: ["tool:org.example.research/SearchDatasets"],
      },
    });
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/package_app.tb"), "module examples.package_app\n", "utf8");
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({
      project_version: "touba-project-v1",
      artifact_layout: "touba-artifacts-v1",
      language: "javascript",
      sdk: "@touba/sdk",
      packages: [
        {
          editable: true, manifest: "authors/research/touba.package.json",
          version: "0.1.0",
        },
      ],
      run_profiles: {
        dev: { require_supply_chain_lock: false },
        prod: {
          require_supply_chain_lock: true,
          supply_chain_lock: "touba.lock.json",
        },
      },
    }, null, 2), "utf8");

    const report = await prepareProject({
      root,
      mode: "write",
      compileSource: (sourcePath) => sourcePath.includes(join("authors", "research"))
        ? airDocumentPackageResearchTools()
        : airDocumentPackageResearchApp(),
    });

    assert.equal(report.status, "needs_changes");
    assert.equal(report.packages[0].name, "org.example.research");
    assert.deepEqual(report.packages[0].modules, ["org.example.research"]);
    assert.equal(report.imports.some((item) => item.target_ref === "tool:org.example.research/SearchDatasets"), true);
    assert.deepEqual(report.tools, ["tool:org.example.research/SearchDatasets"]);

    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:org.example.research/SearchDatasets"];
    assert.deepEqual(binding.grants, []);
    assert.deepEqual(binding.handler.args, ["handlers/org/example/research/search_datasets.handler.mjs"]);
    assert.equal(existsSync(join(root, "handlers/org/example/research/search_datasets.handler.mjs")), true);
    assert.equal(existsSync(join(root, ".touba/air/org/example/research.air.json")), false);

    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/build/dev/air/examples/package_app.air.json"), "utf8"));
    assert.equal(
      assembledApp.definitions.tools.some((item) => item.id === "tool:org.example.research/SearchDatasets"),
      true,
    );
  } finally {
    cleanup(root);
  }
});

test("prepare refuses package declarations that are not explicitly exported", async () => {
  const root = tempRoot();
  try {
    writeLocalPackageFixture(root, {
      exports: {
        types: [
          "type:org.example.research/DatasetSearchRequest",
          "type:org.example.research/DatasetSearchResult",
        ],
      },
    });
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/package_app.tb"), "module examples.package_app\n", "utf8");
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({
      project_version: "touba-project-v1",
      artifact_layout: "touba-artifacts-v1",
      language: "javascript",
      sdk: "@touba/sdk",
      packages: [{ editable: true, manifest: "authors/research/touba.package.json" }],
      run_profiles: {
        dev: { require_supply_chain_lock: false },
        prod: {
          require_supply_chain_lock: true,
          supply_chain_lock: "touba.lock.json",
        },
      },
    }, null, 2), "utf8");

    const report = await prepareProject({
      root,
      mode: "plan",
      compileSource: (sourcePath) => sourcePath.includes(join("authors", "research"))
        ? airDocumentPackageResearchTools()
        : airDocumentPackageResearchApp(),
    });

    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "PackageExportMissing"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare reports local package export and compatibility diagnostics", async () => {
  const root = tempRoot();
  try {
    writeLocalPackageFixture(root, {
      manifest: {
        version: "0.1.0",
        touba: {
          air_profile: "air-json-v9",
          runtime_compatibility: ">=1.0 <2.0",
        },
        registry: "https://registry.example.invalid",
        bindings: {},
      },
    });
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/package_app.tb"), "module examples.package_app\n", "utf8");
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({
      project_version: "touba-project-v1",
      artifact_layout: "touba-artifacts-v1",
      language: "javascript",
      sdk: "@touba/sdk",
      packages: [
        {
          editable: true, manifest: "authors/research/touba.package.json",
          version: "0.2.0",
        },
      ],
      run_profiles: {
        dev: { require_supply_chain_lock: false },
        prod: {
          require_supply_chain_lock: true,
          supply_chain_lock: "touba.lock.json",
        },
      },
    }, null, 2), "utf8");

    const fixturePath = join(root, "authors/research/touba.package.json");
    const base = packageManifestDocument({ exports: { tools: ["tool:org.example.research/SearchDatasets"] } });
    const cases = [
      ["PackageRegistryForbidden", { registry: "https://registry.example.invalid" }],
      ["PackageAuthorityFieldForbidden", { bindings: {} }],
      ["PackageVersionIncompatible", {}],
      ["PackageAirProfileIncompatible", { touba: { air_profile: "air-json-v9", runtime_compatibility: ">=1.0 <2.0" } }],
    ];
    for (const [code, patch] of cases) {
      writeFileSync(fixturePath, JSON.stringify({ ...base, ...patch }));
      const report = await prepareProject({ root, mode: "plan", compileSource: sourcePath => sourcePath.includes(join("packages", "research")) ? airDocumentPackageResearchTools() : airDocumentPackageResearchApp() });
      assert.equal(report.status, "error");
      assert.ok(report.diagnostics.some(item => item.code === code), JSON.stringify(report.diagnostics));
    }
  } finally {
    cleanup(root);
  }
});

test("prepare reports package exports that do not exist in package sources", async () => {
  const root = tempRoot();
  try {
    writeLocalPackageFixture(root, {
      exports: {
        types: ["type:org.example.research/MissingType"],
      },
    });
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/package_app.tb"), "module examples.package_app\n", "utf8");
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({
      project_version: "touba-project-v1",
      artifact_layout: "touba-artifacts-v1",
      language: "javascript",
      sdk: "@touba/sdk",
      packages: [{ editable: true, manifest: "authors/research/touba.package.json" }],
      run_profiles: {
        dev: { require_supply_chain_lock: false },
        prod: {
          require_supply_chain_lock: true,
          supply_chain_lock: "touba.lock.json",
        },
      },
    }, null, 2), "utf8");

    const report = await prepareProject({
      root,
      mode: "plan",
      compileSource: () => airDocumentPackageResearchTools(),
    });

    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "PackageExportUnknownRef"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare reports IM-1 import resolution errors from explicit project AIR", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "missing-module.air.json"), JSON.stringify(airDocumentImportMissingModule(), null, 2), "utf8");
    let report = await prepareProject({
      root,
      mode: "plan",
      airPaths: ["missing-module.air.json"],
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ImportModuleNotFound"), true);

    writeFileSync(join(root, "common.air.json"), JSON.stringify(airDocumentImportCommon(), null, 2), "utf8");
    writeFileSync(join(root, "missing-declaration.air.json"), JSON.stringify(airDocumentImportMissingDeclaration(), null, 2), "utf8");
    report = await prepareProject({
      root,
      mode: "plan",
      airPaths: ["missing-declaration.air.json", "common.air.json"],
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ImportDeclarationNotFound"), true);

    writeFileSync(join(root, "kind-mismatch.air.json"), JSON.stringify(airDocumentImportKindMismatch(), null, 2), "utf8");
    report = await prepareProject({
      root,
      mode: "plan",
      airPaths: ["kind-mismatch.air.json", "common.air.json"],
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ImportKindMismatch"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare attributes a shared import error once to its actual source", async () => {
  const root = tempRoot();
  try {
    const sources = join(root, "src");
    mkdirSync(sources);
    writeFileSync(join(sources, "base.tb"), 'module base\nfunction Value\n    gives Text\n    do\n        give "ok"\n');
    writeFileSync(join(sources, "broken.tb"), 'module broken\nimport function Missing from base\nfunction Value\n    gives Text\n    do\n        give "ok"\n');
    writeFileSync(join(sources, "app.tb"), 'module app\nimport function Value from broken\nstrategy Run\n    uses Value\n    do\n        Value\n            into value\n        give value\n');
    const report = await prepareProject({ root, mode: "plan" });
    assert.equal(report.status, "error");
    const imports = report.diagnostics.filter(d => d.code === "ImportDeclarationNotFound");
    assert.equal(imports.length, 1, JSON.stringify(report.diagnostics));
    assert.equal(imports[0].source_path, realpathSync(join(sources, "broken.tb")));
  } finally { cleanup(root); }
});

test("prepare source compilation uses TOUBA_COMPILE_BIN before Cargo", async () => {
  const root = tempRoot();
  const compilerRoot = tempRoot();
  const previousCompiler = process.env.TOUBA_COMPILE_BIN;
  try {
    const sourcePath = join(root, "src/local/simple.tb");
    mkdirSync(join(root, "src/local"), { recursive: true });
    writeFileSync(sourcePath, "module local.simple\n", "utf8");

    const compilerPath = join(compilerRoot, "mock-touba-compile.mjs");
    const airJson = JSON.stringify({ ok: true, air: airDocumentWithoutTools(), diagnostics: [] });
    writeFileSync(compilerPath, [
      "#!/usr/bin/env node",
      `process.stdout.write(${JSON.stringify(airJson)});`,
      "",
    ].join("\n"), "utf8");
    chmodSync(compilerPath, 0o755);
    process.env.TOUBA_COMPILE_BIN = compilerPath;

    const report = await prepareProject({
      root,
      mode: "write",
    });
    assert.equal(report.status, "success");
    assert.deepEqual(report.modules, ["local.simple"]);
    assert.equal(existsSync(join(root, ".touba/build/dev/air/local/simple.air.json")), true);
  } finally {
    if (previousCompiler === undefined) {
      delete process.env.TOUBA_COMPILE_BIN;
    } else {
      process.env.TOUBA_COMPILE_BIN = previousCompiler;
    }
    cleanup(root);
    cleanup(compilerRoot);
  }
});

test("prepare check fails when manifest or handler stubs are missing", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    const report = await prepareProject({
      root,
      mode: "check",
      airPaths: ["input.air.json"],
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ManifestMissing"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "HandlerStubMissing"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "HandlerContractTestMissing"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "SecretProfileMissing"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare check reports manifest drift without adding grants silently", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    mkdirSync(join(root, ".touba/build/dev"), { recursive: true });
    writeFileSync(join(root, ".touba/build/dev/touba.manifest.json"), JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "/usr/bin/node",
            args: ["handlers/donnees_quebec/live_search/search_datasets.handler.mjs"],
            cwd: ".",
          },
          grants: [],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
        },
      },
    }, null, 2), "utf8");
    const report = await prepareProject({
      root,
      mode: "check",
      airPaths: ["input.air.json"],
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ManifestGrantMissing"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "ManifestSecretMissing"), true);
    const manifest = JSON.parse(readFileSync(join(root, ".touba/build/dev/touba.manifest.json"), "utf8"));
    assert.deepEqual(manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"].grants, []);
  } finally {
    cleanup(root);
  }
});

test("prepare validates source path and module name convention", async () => {
  const root = tempRoot();
  try {
    const sourcePath = join(root, "src/donnees_quebec/wrong_name.tb");
    mkdirSync(join(root, "src/donnees_quebec"), { recursive: true });
    writeFileSync(sourcePath, "module donnees_quebec.live_search\n", "utf8");
    const report = await prepareProject({
      root,
      mode: "plan",
      compileSource: () => airDocumentWithTool(),
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ModulePathMismatch"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare rejects project sources that cannot produce a canonical dotted module", async () => {
  const root = tempRoot();
  try {
    const sourcePath = join(root, "src/scratch.tb");
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(sourcePath, "module scratch\n", "utf8");
    const report = await prepareProject({
      root,
      mode: "plan",
      compileSource: () => ({
        ...airDocumentWithoutTools(),
        module: {
          id: "module:scratch",
          name: "scratch",
        },
      }),
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ModulePathNotCanonical"), true);
  } finally {
    cleanup(root);
  }
});

test("prepare reports stale manifest bindings when no project tool remains", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithoutTools(), null, 2), "utf8");
    mkdirSync(join(root, ".touba/build/dev"), { recursive: true });
    writeFileSync(join(root, ".touba/build/dev/touba.manifest.json"), JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:local.simple/OldTool": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "/usr/bin/node",
            args: ["handlers/local/simple/old_tool.handler.mjs"],
            cwd: ".",
          },
          grants: [],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
        },
      },
    }, null, 2), "utf8");
    const report = await prepareProject({
      root,
      mode: "check",
      airPaths: ["input.air.json"],
    });
    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "ManifestHasUnexpectedBindings"), true);
  } finally {
    cleanup(root);
  }
});

test("CLI supports air-only prepare without scanning src", () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithoutTools(), null, 2), "utf8");
    const prepared = spawnSync(process.execPath, [cliPath, "prepare", "--root", root, "--air", "input.air.json", "--mode", "write"], { encoding: "utf8" });
    assert.equal(prepared.status, 0, prepared.stderr);
    const result = spawnSync(process.execPath, [
      cliPath,
      "prepare",
      "--root",
      root,
      "--air",
      "input.air.json",
      "--mode",
      "check",
      "--json",
    ], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "success");
    assert.deepEqual(report.tools, []);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
  } finally {
    cleanup(root);
  }
});

test("CLI help prints usage without a synthetic report", () => {
  const result = spawnSync(process.execPath, [cliPath, "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage:/);
  assert.match(result.stdout, /touba trigger run <program\.air\.json> --manifest <path> --trigger <trigger_ref> --max-runs <n> \[--state <path\.sqlite>\]/);
  assert.match(result.stdout, /touba trigger serve <program\.air\.json> --manifest <path> \[--state <path\.sqlite>\] \[--queue <path\.sqlite>\]/);
  assert.match(result.stdout, /touba package new\|check\|test\|version\|pack\|checkout\|submit\|publish\|add\|list\|remove/);
  assert.match(result.stdout, /--state <path\.sqlite>/);
  assert.match(result.stdout, /touba manifest generate <air\.json> --out <touba\.manifest\.json>/);
  assert.match(result.stdout, /touba manifest generate <air\.json> --stdout/);
  assert.match(result.stdout, /touba handler stub <air\.json> \[--language javascript\|python\] \[--tool-ref <tool_ref>\] \[--handler-root <path>\] \[--force\]/);
  assert.match(result.stdout, /touba doctor \[--json\]/);
  assert.match(result.stdout, /--ownership <touba\.ownership\.json>/);
  assert.match(result.stdout, /touba audit --trace <trace\.json>/);
  assert.match(result.stdout, /--report-out <report\.trace-audit-report\.json>/);
  assert.match(result.stdout, /--timeline-out <timeline\.trace-timeline\.json>/);
  assert.match(result.stdout, /touba supply-chain validate --lock <touba\.lock\.json>/);
  assert.match(result.stdout, /--report-out <report\.supply-chain-report\.json>/);
  assert.match(result.stdout, /--require-review/);
  assert.equal(result.stdout.includes("Touba project undefined"), false);
});

test("CLI trigger, manifest and handler help match current public options", () => {
  const triggerResult = spawnSync(process.execPath, [cliPath, "trigger", "--help"], { encoding: "utf8" });
  assert.equal(triggerResult.status, 0, triggerResult.stderr);
  assert.match(triggerResult.stdout, /touba trigger run <air\.json>/);
  assert.match(triggerResult.stdout, /--max-runs <n>/);
  assert.match(triggerResult.stdout, /--state <path\.sqlite>/);
  assert.match(triggerResult.stdout, /trigger migrate-state <old\.json> --out <new\.sqlite>/);
  assert.match(triggerResult.stdout, /run-summary/);
  assert.equal(triggerResult.stdout.includes("daemon"), false);

  const manifestResult = spawnSync(process.execPath, [cliPath, "manifest", "--help"], { encoding: "utf8" });
  assert.equal(manifestResult.status, 0, manifestResult.stderr);
  assert.match(manifestResult.stdout, /touba manifest generate <air\.json> --out <touba\.manifest\.json>/);
  assert.match(manifestResult.stdout, /touba manifest generate <air\.json> --stdout/);
  assert.match(manifestResult.stdout, /--handler-command <command>/);
  assert.equal(manifestResult.stdout.includes("--handler <tool=path>"), false);

  const handlerResult = spawnSync(process.execPath, [cliPath, "handler", "--help"], { encoding: "utf8" });
  assert.equal(handlerResult.status, 0, handlerResult.stderr);
  assert.match(handlerResult.stdout, /touba handler stub <air\.json>/);
  assert.match(handlerResult.stdout, /--handler-root <path>/);
  assert.equal(handlerResult.stdout.includes("--out-dir"), false);

  const skillResult = spawnSync(process.execPath, [cliPath, "package", "--help"], { encoding: "utf8" });
  assert.equal(skillResult.status, 0, skillResult.stderr);
  assert.match(skillResult.stdout, /touba package new \[name\]/);
  assert.match(skillResult.stdout, /touba package check \[directory\|archive\.tar\.gz\]/);
  assert.equal(skillResult.stdout.includes("marketplace"), false);

  const auditResult = spawnSync(process.execPath, [cliPath, "audit", "--help"], { encoding: "utf8" });
  assert.equal(auditResult.status, 0, auditResult.stderr);
  assert.match(auditResult.stdout, /touba-audit --trace <trace\.json>/);
  assert.match(auditResult.stdout, /--export <export\.json>/);
  assert.match(auditResult.stdout, /--report-out <report\.trace-audit-report\.json>/);
  assert.match(auditResult.stdout, /--timeline-out <timeline\.trace-timeline\.json>/);

  const supplyChainResult = spawnSync(process.execPath, [cliPath, "supply-chain", "--help"], { encoding: "utf8" });
  assert.equal(supplyChainResult.status, 0, supplyChainResult.stderr);
  assert.match(supplyChainResult.stdout, /touba supply-chain validate --lock <touba\.lock\.json>/);
  assert.match(supplyChainResult.stdout, /--report-out <report\.supply-chain-report\.json>/);
  assert.match(supplyChainResult.stdout, /--require-review/);
  assert.equal(supplyChainResult.stdout.includes("registry"), false);
});

test("CLI run help exposes project profiles before runtime options", () => {
  const result = spawnSync(process.execPath, [cliPath, "run", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Usage: touba run <program\.air\.json> \[--profile pure\|dev\|prod\]/);
  assert.match(result.stdout, /touba run --project <path>/);
  assert.match(result.stdout, /Project profiles are read from touba\.project\.json/);
  assert.match(result.stdout, /prod profile requires touba\.lock\.json/);
  assert.match(result.stdout, /--human-checkpoint-out <path> \[--human-resume-checkpoint <path>\]/);
  assert.match(result.stdout, /--output show\|result\|trace\|all\|run-summary/);
  assert.match(result.stdout, /--trace-out <path>/);
  assert.match(result.stdout, /--evidence-out <run\.evidence\.json>/);

  const profiledResult = spawnSync(process.execPath, [cliPath, "run", "--profile", "prod", "--help"], { encoding: "utf8" });
  assert.equal(profiledResult.status, 0, profiledResult.stderr);
  assert.match(profiledResult.stdout, /Usage: touba run <program\.air\.json> \[--profile pure\|dev\|prod\]/);
  assert.equal(profiledResult.stderr, "");
});

test("CLI version keeps human output concise and does not claim an environment-supplied build identity", () => {
  const env = { ...process.env, TOUBA_BUILD_ID: "spoofed-build", GITHUB_SHA: "a".repeat(40) };
  const result = spawnSync(process.execPath, [cliPath, "version"], { encoding: "utf8", env });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, `touba ${releaseVersion}\nbuild source-local\n`);
  assert.equal(result.stderr, "");
  const json = spawnSync(process.execPath, [cliPath, "version", "--json"], { encoding: "utf8", env });
  assert.equal(json.status, 0, json.stderr);
  assert.equal(JSON.parse(json.stdout).build.id, "source-local");
});

test("CLI version reports public command and schema versions", () => {
  const result = spawnSync(process.execPath, [cliPath, "version", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  for (const component of ["cli", "runtime", "inspect", "audit", "supply_chain", "manifest", "sdk"]) {
    assert.equal(report[component], releaseVersion, component);
  }
  assert.equal(report.schemas.air, "touba-air-v1");
  assert.equal(report.schemas.trace, "touba-trace-v1");
  assert.equal(report.schemas.manifest, "touba-manifest-v1");
  assert.equal(report.schemas.ownership, "touba-ownership-v1");
  assert.equal(report.schemas.trace_audit, "trace-audit-v1");
  assert.equal(report.schemas.trace_audit_validation, "trace-audit-validation-v1");
  assert.equal(report.schemas.trace_audit_export, "trace-audit-export-v1-local");
  assert.equal(report.schemas.supply_chain_lock, "touba-lock-v1");
  assert.equal(report.schemas.supply_chain_validation, "touba-supply-chain-validation-v1");
  assert.equal(report.features.run_profiles, "touba-run-profile-v1");
  assert.equal(report.features.human_checkpoints, "touba-human-approval-checkpoint-v1");
  assert.equal(report.features.registry_static_resolve, "touba-static-registry-lock-v1");
  assert.equal(report.features.project_refresh, "touba-project-refresh-v1");
  assert.equal(report.commands.run_profile, true);
  assert.equal(report.commands.refresh, true);
  assert.equal(report.commands.doctor, true);
  assert.equal(report.build.node, process.version);
  for (const component of ["cli", "runtime", "inspect", "audit", "supply_chain", "manifest"]) {
    assert.notEqual(report[component], "0.0.0", component);
    assert.notEqual(report[component], "unknown", component);
  }
  assert.equal(report.distribution.channel, "local-development");
  assert.equal(report.distribution.platform, `${process.platform}-${process.arch}`);
});

test("CLI doctor reports installation health and public feature surface", () => {
  const result = spawnSync(process.execPath, [cliPath, "doctor", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.doctor_schema_version, "touba-doctor-v1");
  assert.equal(report.status, "ok");
  assert.equal(report.version.cli, releaseVersion);
  assert.equal(report.version.commands.supply_chain_validate, true);
  assert.equal(report.version.commands.registry_resolve, true);
  assert.equal(report.version.commands.run_profile, true);
  assert.equal(report.checks.some((check) => check.id === "node_version" && check.status === "ok"), true);
  assert.equal(report.checks.some((check) => check.id === "component_versions" && check.status === "ok"), true);
  assert.equal(report.checks.some((check) => check.id === "public_command_surface" && check.status === "ok"), true);
});

test("CLI doctor rejects Node releases below the security baseline", () => {
  const setup = "Object.defineProperty(process.versions, 'node', {value: '24.15.0'});";
  const result = spawnSync(process.execPath, ["--import", `data:text/javascript,${encodeURIComponent(setup)}`, cliPath, "doctor", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 1, result.stderr);
  const check = JSON.parse(result.stdout).checks.find((item) => item.id === "node_version");
  assert.equal(check.status, "error");
  assert.equal(check.details.expected, ">=24.22.1 <25");
});

test("CLI update identifies a source checkout without fetching an update", () => {
  const result = spawnSync(process.execPath, [cliPath, "update"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  assert.match(result.stdout, /UpdateUnmanagedInstallation/);
  assert.match(result.stdout, /installer/);
});

test("CLI update reports an unmanaged installation in its machine contract", () => {
  const result = spawnSync(process.execPath, [cliPath, "update", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 2);
  const report = JSON.parse(result.stdout);
  assert.equal(report.schema, "touba-update-result-v1");
  assert.equal(report.status, "refused");
  assert.equal(report.code, "UpdateUnmanagedInstallation");
});

test("CLI update help is available without reporting a failed update", () => {
  const result = spawnSync(process.execPath, [cliPath, "update", "--help"], { encoding: "utf8" });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Usage: touba update \[--check \| --rollback\] \[--yes\] \[--json\]/);
});

test("CLI compile delegates to the configured compiler binary", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "compile",
    "--stdout",
    "-e",
    "process.stdout.write('mock-compile')",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      TOUBA_COMPILE_BIN: process.execPath,
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "mock-compile");
});

test("CLI compile refuses implicit stdout output", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "compile",
    "-e",
    "process.stdout.write(JSON.stringify({ air_schema_version: 'touba-air-v1' }))",
  ], {
    encoding: "utf8",
    env: {
      ...process.env,
      TOUBA_COMPILE_BIN: process.execPath,
    },
  });

  assert.equal(result.status, 2);
  assert.match(result.stderr, /requires an explicit output mode/);
  assert.equal(result.stdout, "");
});

test("CLI compile --out writes AIR JSON only to a .air.json path", () => {
  const root = tempRoot();
  try {
    const outPath = join(root, "nested", "hello.air.json");
    const result = spawnSync(process.execPath, [
      cliPath,
      "compile",
      "-e",
      "process.stdout.write(JSON.stringify({ air_schema_version: 'touba-air-v1', module: { name: 'examples.hello' } }))",
      "--out",
      outPath,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        TOUBA_COMPILE_BIN: process.execPath,
      },
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /wrote AIR JSON/);
    const air = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(air.air_schema_version, "touba-air-v1");
    assert.equal(air.module.name, "examples.hello");
  } finally {
    cleanup(root);
  }
});

test("CLI compile --out refuses non .air.json output paths", () => {
  const root = tempRoot();
  try {
    const outPath = join(root, "hello.json");
    const result = spawnSync(process.execPath, [
      cliPath,
      "compile",
      "-e",
      "process.stdout.write(JSON.stringify({ air_schema_version: 'touba-air-v1' }))",
      "--out",
      outPath,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        TOUBA_COMPILE_BIN: process.execPath,
      },
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /requires a \.air\.json output path/);
    assert.equal(existsSync(outPath), false);
  } finally {
    cleanup(root);
  }
});

test("CLI compile --out refuses non AIR JSON compiler output", () => {
  const root = tempRoot();
  try {
    const outPath = join(root, "hello.air.json");
    const result = spawnSync(process.execPath, [
      cliPath,
      "compile",
      "-e",
      "process.stdout.write('not-air')",
      "--out",
      outPath,
    ], {
      encoding: "utf8",
      env: {
        ...process.env,
        TOUBA_COMPILE_BIN: process.execPath,
      },
    });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /not valid JSON/);
    assert.equal(existsSync(outPath), false);
  } finally {
    cleanup(root);
  }
});

test("CLI compile uses a current local compiler for recent Touba syntax", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "compile",
    "--stdout",
    triggerRunnerFixture,
  ], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.equal(result.status, 0, result.stderr);
  const air = JSON.parse(result.stdout);
  assert.equal(
    air.definitions.triggers[0].id,
    "trigger:examples.trigger_morning_review/MorningReview",
  );
  assert.equal(air.definitions.triggers[0].event.value, "every 1s");
});

test("CLI inspect delegates to Touba Inspect for AIR artifacts", () => {
  const root = tempRoot();
  try {
    const airPath = join(root, "input.air.json");
    writeFileSync(airPath, JSON.stringify(airDocumentWithoutTools(), null, 2), "utf8");
    const result = spawnSync(process.execPath, [cliPath, "inspect", airPath], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /Touba Inspect touba-inspect-v1/);
    assert.match(result.stdout, /AIR touba-air-v1/);
  } finally {
    cleanup(root);
  }
});

test("CLI inspect --json emits the project inspection contract", () => {
  const root = tempRoot();
  try {
    const airPath = join(root, "input.air.json");
    writeFileSync(airPath, JSON.stringify(airDocumentWithoutTools(), null, 2), "utf8");
    const result = spawnSync(process.execPath, [cliPath, "inspect", airPath, "--json"], {
      encoding: "utf8",
    });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    const schema = JSON.parse(readFileSync(projectInspectionSchema, "utf8"));
    assert.equal(report.schema_version, "touba-project-inspection-v1");
    assert.deepEqual(validateObject(schema, report), []);
    assert.equal(report.project.root, root);
    assert.equal(report.artifacts.some((artifact) => artifact.kind === "air" && artifact.status === "present"), true);
    assert.equal(Array.isArray(report.entrypoints), true);
    assert.equal(Array.isArray(report.diagnostics), true);
  } finally {
    cleanup(root);
  }
});

test("CLI audit delegates to Touba Audit for trace artifacts", () => {
  const root = tempRoot();
  try {
    const tracePath = join(root, "run.trace.json");
    writeFileSync(tracePath, JSON.stringify({
      trace_protocol_version: "touba-trace-v1",
      trace_capability_profile: "touba-trace-capabilities-v1",
      run: {
        run_id: "run-project-audit",
        air_schema_version: "touba-air-v1",
        air_digest: `sha256:${"0".repeat(64)}`, // Synthetic CLI routing fixture, no AIR identity assertion.
        module_ref: "module:examples.audit",
        entry_ref: "strategy:examples.audit/Run",
      },
      events: [
        {
          event_id: "event:1",
          run_id: "run-project-audit",
          sequence_index: 0,
          kind: "run_started",
          payload: { entry_ref: "strategy:examples.audit/Run" },
        },
        {
          event_id: "event:2",
          run_id: "run-project-audit",
          sequence_index: 1,
          kind: "run_completed",
          payload: { status: "success", reason: "completed" },
        },
      ],
    }, null, 2), "utf8");

    const result = spawnSync(process.execPath, [
      cliPath,
      "audit",
      "--trace",
      tracePath,
      "--output",
      "json",
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.validationReport.status, "ok");
    assert.equal(report.traceAuditManifest.run_id, "run-project-audit");
  } finally {
    cleanup(root);
  }
});

test("CLI supply-chain delegates to Touba Supply Chain validation", () => {
  const root = tempRoot();
  try {
    mkdirSync(join(root, "handlers"), { recursive: true });

    const airPath = join(root, "program.air.json");
    const manifestPath = join(root, "touba.manifest.json");
    const lockPath = join(root, "touba.lock.json");
    const handlerPath = join(root, "handlers/search_datasets.handler.mjs");

    const airText = writeJson(airPath, airDocumentWithTool());
    const manifest = {
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          effect_contract: { kind: "none" }, handler: {
            kind: "process",
            command: "node",
            cwd: ".",
            args: ["handlers/search_datasets.handler.mjs"],
          },
          grants: ["network"],
          secrets: ["API_TOKEN"],
          timeout_ms: 5000,
          max_payload_bytes: 1048576,
        },
      },
    };
    const manifestText = writeJson(manifestPath, manifest);
    const handlerText = "export function run() { return { ok: true }; }\n";
    writeFileSync(handlerPath, handlerText, "utf8");
    writeJson(lockPath, {
      lock_schema_version: "touba-lock-v1",
      lock_kind: "supply_chain",
      generated_at: "2026-06-05T12:00:00Z",
      generated_by: {
        tool: "touba prepare",
        version: "0.1.0",
      },
      air: {
        path: "program.air.json",
        digest: {
          kind: "sha256",
          value: sha256(airText),
        },
      },
      manifest: {
        path: "touba.manifest.json",
        digest: {
          kind: "sha256",
          value: sha256(manifestText),
        },
      },
      handlers: [
        {
          tool_ref: "tool:donnees_quebec.live_search/SearchDatasets",
          path: "handlers/search_datasets.handler.mjs",
          command: "node",
          cwd: ".",
          args: ["handlers/search_datasets.handler.mjs"],
          digest: {
            kind: "sha256",
            value: sha256(handlerText),
          },
          sdk: {
            name: "@touba/sdk",
            version: "1.0.0",
            protocol: "touba-tool-handler-v1",
            status: "ok",
          },
          handler_package: {
            kind: "local",
            name: "donnees_quebec.live_search.handlers",
            version: "0.1.0",
            package_root: ".",
            entrypoint: "handlers/search_datasets.handler.mjs",
            files: [{ path: "handlers/search_datasets.handler.mjs", digest: { kind: "sha256", value: sha256(handlerText) } }],
          },
        },
      ],
    });

    const result = spawnSync(process.execPath, [
      cliPath,
      "supply-chain",
      "validate",
      "--lock",
      lockPath,
      "--air",
      airPath,
      "--manifest",
      manifestPath,
      "--output",
      "json",
    ], { encoding: "utf8" });

    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.status, "ok");
    assert.equal(report.handlers[0].drift_status, "ok");
  } finally {
    cleanup(root);
  }
});

test("CLI manifest and handler commands delegate to manifest tools", () => {
  const root = tempRoot();
  try {
    const airPath = join(root, "input.air.json");
    writeFileSync(airPath, JSON.stringify(airDocumentWithTool(), null, 2), "utf8");

    const manifestResult = spawnSync(process.execPath, [
      cliPath,
      "manifest",
      "generate",
      airPath,
      "--stdout",
      "--handler-command",
      "node",
      "--handler-root",
      "handlers",
    ], { encoding: "utf8" });
    assert.equal(manifestResult.status, 0, manifestResult.stderr);
    const manifest = JSON.parse(manifestResult.stdout);
    const binding = manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    assert.equal(binding.handler.command, "node");
    assert.deepEqual(binding.grants, []);

    const stubResult = spawnSync(process.execPath, [
      cliPath,
      "handler",
      "stub",
      airPath,
      "--handler-root",
      "handlers",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(stubResult.status, 0, stubResult.stderr);
    assert.equal(existsSync(join(root, "handlers/donnees_quebec/live_search/search_datasets.handler.mjs")), true);
  } finally {
    cleanup(root);
  }
});

function processRunFixture(root) {
  const airPath = join(root, "linear.air.json");
  writeFileSync(airPath, readFileSync(linearAirFixture));
  const handlerPath = join(root, "read.handler.mjs");
  writeFileSync(handlerPath, "process.stdin.resume(); process.stdin.on('end', () => process.stdout.write(JSON.stringify({ok:true,value:{content:'project CLI source'}})));\n");
  const manifest = join(root, "touba.manifest.json");
  writeJson(manifest, { manifest_version: "touba-manifest-v1", bindings: {
    "tool:examples.linear_skill/FetchSource": {
      effect_contract: { kind: "none" }, grants: ["network"],
      handler: { kind: "process", command: process.execPath, args: ["read.handler.mjs"], cwd: "." },
      timeout_ms: 5000, max_payload_bytes: 65536,
    },
  }});
  const lockPath = join(root, "touba.lock.json");
  writeJson(join(root, "package.json"), { name: "project-cli-test", version: "0.1.0" });
  generateSupplyChainLock({ air: airPath, manifest, out: lockPath, sdkMetadataJson: JSON.stringify({
    name: "@touba/sdk", version: "1.0.0", protocol: "touba-tool-handler-v1", status: "ok",
  }) });
  // Test-host review is explicit and separate from lock generation.
  const lock = JSON.parse(readFileSync(lockPath, "utf8"));
  lock.review = { status: "approved", reviewed_at: "2026-10-15T12:00:00Z", reviewers: [{ kind: "human", id: "fixture:reviewer" }] };
  writeJson(lockPath, lock);
  return { airPath, manifest, handlerPath };
}

test("CLI run delegates to the runtime with a process handler", () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const fixture = processRunFixture(root);
    const result = spawnSync(process.execPath, [cliPath, "run", fixture.airPath,
      "--manifest", fixture.manifest, "--inputs-json", JSON.stringify({ request: { topic: "project-cli" } }),
      "--output", "trace"], { encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
    const trace = JSON.parse(result.stdout);
    assert.equal(trace.trace_protocol_version, "touba-trace-v1");
    assert.equal(trace.events.at(-1).payload.status, "success");
  } finally { cleanup(root); }
});

test("CLI run applies project dev and prod supply-chain profiles", () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const fixture = processRunFixture(root);
    for (const profile of ["dev", "prod"]) {
      const result = spawnSync(process.execPath, [cliPath, "run", fixture.airPath,
        "--manifest", fixture.manifest, "--profile", profile,
        "--inputs-json", JSON.stringify({ request: { topic: "profile-" + profile } }),
        "--output", "trace"], { cwd: root, encoding: "utf8" });
      assert.equal(result.status, 0, result.stderr);
      const trace = JSON.parse(result.stdout);
      assert.equal(trace.events.at(-1).payload.status, "success");
      if (profile === "prod") {
        const admission = trace.events.find(event => event.kind === "package_admission_verified").payload;
        assert.equal(admission.supply_chain.state, "verified");
        assert.equal(admission.supply_chain.required, true);
        assert.match(admission.supply_chain.digest, /^sha256:[a-f0-9]{64}$/);
      }
    }
  } finally { cleanup(root); }
});

test("CLI run prod profile preserves orientation instead of forcing an operation", () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const args = applyRunProfileToArgs([
      "program.air.json",
      "--profile",
      "prod",
      "--agent-decision-provider",
      "provider.mjs",
    ], { root });

    assert.equal(args.includes("--require-supply-chain-lock"), true);
    assert.equal(args.includes("--agent-decision-provider-initial-mode"), false);
  } finally {
    cleanup(root);
  }
});

test("CLI run prod profile keeps explicit provider initial mode", () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const args = applyRunProfileToArgs([
      "program.air.json",
      "--profile=prod",
      "--agent-decision-provider",
      "provider.mjs",
      "--agent-decision-provider-initial-mode=summary",
    ], { root });

    assert.equal(args.includes("--require-supply-chain-lock"), true);
    assert.equal(args.filter((arg) => arg.startsWith("--agent-decision-provider-initial-mode")).length, 1);
    assert.equal(args.includes("--agent-decision-provider-initial-mode=summary"), true);
  } finally {
    cleanup(root);
  }
});

test("CLI run prod profile refuses before runtime when project lock drifts", () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const fixture = processRunFixture(root);
    const air = JSON.parse(readFileSync(fixture.airPath, "utf8"));
    air.module.name = "changed";
    writeJson(fixture.airPath, air);
    const result = spawnSync(process.execPath, [cliPath, "run", fixture.airPath,
      "--manifest", fixture.manifest, "--profile", "prod", "--output", "trace"], { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, /SupplyChainLockInvalid/);
    assert.match(result.stderr, /AirChanged|SupplyChainDigestMismatch/);
  } finally { cleanup(root); }
});

test("CLI run profile requires an explicit project config", () => {
  const root = tempRoot();
  try {
    const result = spawnSync(process.execPath, [
      cliPath,
      "run",
      linearAirFixture,
      "--profile",
      "prod",
    ], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /run profile prod requires touba\.project\.json/);
  } finally {
    cleanup(root);
  }
});

function airDocumentWithTool() {
  return {
    air_schema_version: "touba-air-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: {
      id: "module:donnees_quebec.live_search",
      name: "donnees_quebec.live_search",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      functions: [],
      tools: [
        {
          id: "tool:donnees_quebec.live_search/SearchDatasets",
          name: "SearchDatasets",
          signature: {
            inputs: [{ name: "request", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          required_capabilities: ["network"],
          required_secrets: ["API_TOKEN"],
        },
      ],
      skills: [],
      agents: [],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function airDocumentImportCommon() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.common",
      name: "examples.common",
    },
    definitions: {
      constants: [
        {
          id: "constant:examples.common/DefaultRows",
          name: "DefaultRows",
          type_ref: "builtin:Int",
          literal_int: "5",
        },
      ],
      types: [
        {
          id: "type:examples.common/SearchRequest",
          name: "SearchRequest",
          fields: [
            { name: "query", type_ref: "builtin:Text" },
            { name: "rows", type_ref: "builtin:Int" },
          ],
        },
      ],
      functions: [
        {
          id: "function:examples.common/NormalizeQuery",
          name: "NormalizeQuery",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          body_graph_ref: "graph:function:examples.common/NormalizeQuery",
        },
      ],
      tools: [],
      skills: [],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      {
        id: "graph:function:examples.common/NormalizeQuery",
        owner_ref: "function:examples.common/NormalizeQuery",
        entry_node_id: "give:1",
        nodes: [
          {
            id: "give:1",
            kind: "give",
            arguments: ["value:query"],
            trace_point_refs: [],
          },
        ],
        edges: [],
      },
    ],
    trace_points: [],
  };
}

function airDocumentImportSearch() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.search",
      name: "examples.search",
    },
    imports: [
      {
        kind: "type",
        name: "SearchRequest",
        from_module: "examples.common",
        target_ref: "type:examples.common/SearchRequest",
      },
      {
        kind: "define",
        name: "DefaultRows",
        from_module: "examples.common",
        target_ref: "constant:examples.common/DefaultRows",
      },
      {
        kind: "function",
        name: "NormalizeQuery",
        from_module: "examples.common",
        target_ref: "function:examples.common/NormalizeQuery",
      },
    ],
    definitions: {
      constants: [],
      types: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function airDocumentImportMissingModule() {
  return {
    ...airDocumentImportSearch(),
    module: {
      id: "module:examples.missing_module",
      name: "examples.missing_module",
    },
    imports: [
      {
        kind: "function",
        name: "NormalizeQuery",
        from_module: "examples.absent",
        target_ref: "function:examples.absent/NormalizeQuery",
      },
    ],
  };
}

function airDocumentImportMissingDeclaration() {
  return {
    ...airDocumentImportSearch(),
    module: {
      id: "module:examples.missing_declaration",
      name: "examples.missing_declaration",
    },
    imports: [
      {
        kind: "function",
        name: "MissingFunction",
        from_module: "examples.common",
        target_ref: "function:examples.common/MissingFunction",
      },
    ],
  };
}

function airDocumentImportKindMismatch() {
  return {
    ...airDocumentImportSearch(),
    module: {
      id: "module:examples.kind_mismatch",
      name: "examples.kind_mismatch",
    },
    imports: [
      {
        kind: "function",
        name: "SearchRequest",
        from_module: "examples.common",
        target_ref: "function:examples.common/SearchRequest",
      },
    ],
  };
}

function airDocumentImportToolDataTools() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.data_tools",
      name: "examples.data_tools",
    },
    definitions: {
      constants: [],
      types: [
        {
          id: "type:examples.data_tools/DatasetSearchRequest",
          name: "DatasetSearchRequest",
          fields: [
            { name: "query", type_ref: "builtin:Text" },
            { name: "rows", type_ref: "builtin:Int" },
          ],
        },
        {
          id: "type:examples.data_tools/DatasetSearchResult",
          name: "DatasetSearchResult",
          fields: [
            { name: "title", type_ref: "builtin:Text" },
            { name: "url", type_ref: "builtin:Text" },
          ],
        },
      ],
      functions: [],
      tools: [
        {
          id: "tool:examples.data_tools/SearchDatasets",
          name: "SearchDatasets",
          signature: {
            inputs: [
              {
                name: "request",
                type_ref: "type:examples.data_tools/DatasetSearchRequest",
              },
            ],
            output_type: "type:examples.data_tools/DatasetSearchResult",
          },
          required_capabilities: ["network", "secret_read"],
          required_secrets: ["DATA_API_TOKEN"],
        },
      ],
      skills: [],
      agents: [],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function airDocumentImportToolResearchApp() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.research_app",
      name: "examples.research_app",
    },
    imports: [
      {
        kind: "type",
        name: "DatasetSearchRequest",
        from_module: "examples.data_tools",
        target_ref: "type:examples.data_tools/DatasetSearchRequest",
      },
      {
        kind: "type",
        name: "DatasetSearchResult",
        from_module: "examples.data_tools",
        target_ref: "type:examples.data_tools/DatasetSearchResult",
      },
      {
        kind: "tool",
        name: "SearchDatasets",
        from_module: "examples.data_tools",
        target_ref: "tool:examples.data_tools/SearchDatasets",
      },
    ],
    definitions: {
      constants: [],
      types: [],
      functions: [],
      tools: [],
      skills: [
        {
          id: "skill:examples.research_app/BuildDatasetBrief",
          name: "BuildDatasetBrief",
          signature: {
            inputs: [
              {
                name: "request",
                type_ref: "type:examples.data_tools/DatasetSearchRequest",
              },
            ],
            output_type: "type:examples.data_tools/DatasetSearchResult",
          },
          uses: ["tool:examples.data_tools/SearchDatasets"],
          flow_graph_ref: "graph:skill:examples.research_app/BuildDatasetBrief",
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      {
        id: "graph:skill:examples.research_app/BuildDatasetBrief",
        owner_ref: "skill:examples.research_app/BuildDatasetBrief",
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_tool",
            target_ref: "tool:examples.data_tools/SearchDatasets",
            arguments: ["value:request"],
            result_binding: "result",
            trace_point_refs: [],
          },
        ],
        edges: [],
      },
    ],
    trace_points: [],
  };
}

function airDocumentImportFlowShared() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.shared_flow",
      name: "examples.shared_flow",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [
        {
          id: "skill:examples.shared_flow/NormalizeTopic",
          name: "NormalizeTopic",
          signature: {
            inputs: [{ name: "topic", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: [],
          use_refs: [],
          flow_graph_ref: "graph:skill:examples.shared_flow/NormalizeTopic",
        },
      ],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.shared_flow/SharedTopicRun",
          name: "SharedTopicRun",
          signature: {
            inputs: [{ name: "topic", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: ["skill:examples.shared_flow/NormalizeTopic"],
          use_refs: [{ target_ref: "skill:examples.shared_flow/NormalizeTopic" }],
          flow_graph_ref: "graph:strategy:examples.shared_flow/SharedTopicRun",
        },
      ],
    },
    execution_graphs: [
      {
        id: "graph:skill:examples.shared_flow/NormalizeTopic",
        owner_ref: "skill:examples.shared_flow/NormalizeTopic",
        entry_node_id: "give:1",
        nodes: [{ id: "give:1", kind: "give", arguments: ["value:topic"], trace_point_refs: [] }],
        edges: [],
      },
      {
        id: "graph:strategy:examples.shared_flow/SharedTopicRun",
        owner_ref: "strategy:examples.shared_flow/SharedTopicRun",
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_skill",
            target_ref: "skill:examples.shared_flow/NormalizeTopic",
            arguments: ["value:topic"],
            result_binding: "normalized",
            trace_point_refs: [],
          },
          { id: "give:1", kind: "give", arguments: ["value:normalized"], trace_point_refs: [] },
        ],
        edges: [{ from: "call:1", to: "give:1", role: "next" }],
      },
    ],
    trace_points: [],
  };
}

function airDocumentImportFlowApp() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.flow_app",
      name: "examples.flow_app",
    },
    imports: [
      {
        kind: "skill",
        name: "NormalizeTopic",
        from_module: "examples.shared_flow",
        target_ref: "skill:examples.shared_flow/NormalizeTopic",
      },
      {
        kind: "strategy",
        name: "SharedTopicRun",
        from_module: "examples.shared_flow",
        target_ref: "strategy:examples.shared_flow/SharedTopicRun",
      },
    ],
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.flow_app/RunImportedSkill",
          name: "RunImportedSkill",
          signature: {
            inputs: [{ name: "topic", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: ["skill:examples.shared_flow/NormalizeTopic"],
          use_refs: [{ target_ref: "skill:examples.shared_flow/NormalizeTopic" }],
          flow_graph_ref: "graph:strategy:examples.flow_app/RunImportedSkill",
        },
      ],
    },
    execution_graphs: [
      {
        id: "graph:strategy:examples.flow_app/RunImportedSkill",
        owner_ref: "strategy:examples.flow_app/RunImportedSkill",
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_skill",
            target_ref: "skill:examples.shared_flow/NormalizeTopic",
            arguments: ["value:topic"],
            result_binding: "normalized",
            trace_point_refs: [],
          },
          { id: "give:1", kind: "give", arguments: ["value:normalized"], trace_point_refs: [] },
        ],
        edges: [{ from: "call:1", to: "give:1", role: "next" }],
      },
    ],
    trace_points: [],
  };
}

function airDocumentImportAgentPool() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.agent_pool",
      name: "examples.agent_pool",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [
        {
          id: "agent:examples.agent_pool/Reviewer",
          name: "Reviewer",
          responsibility: "Reviewer",
          uses: [],
          use_refs: [],
          callable_by: [
            {
              caller_ref: "strategy:examples.agent_app/RunReview",
              caller_kind: "strategy",
            },
          ],
        },
      ],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function airDocumentImportAgentApp() {
  return airDocumentImportAgentAppWithModule("examples.agent_app");
}

function airDocumentImportAgentAppUnauthorized() {
  return airDocumentImportAgentAppWithModule("examples.agent_app_unauthorized");
}

function airDocumentImportAgentAppWithModule(moduleName) {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: `module:${moduleName}`,
      name: moduleName,
    },
    imports: [
      {
        kind: "agent",
        name: "Reviewer",
        from_module: "examples.agent_pool",
        target_ref: "agent:examples.agent_pool/Reviewer",
      },
    ],
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [],
      strategies: [
        {
          id: `strategy:${moduleName}/RunReview`,
          name: "RunReview",
          uses: ["agent:examples.agent_pool/Reviewer"],
          use_refs: [{ target_ref: "agent:examples.agent_pool/Reviewer" }],
          flow_graph_ref: `graph:strategy:${moduleName}/RunReview`,
        },
      ],
    },
    execution_graphs: [
      {
        id: `graph:strategy:${moduleName}/RunReview`,
        owner_ref: `strategy:${moduleName}/RunReview`,
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_agent",
            target_ref: "agent:examples.agent_pool/Reviewer",
            arguments: [],
            trace_point_refs: [],
          },
          { id: "stop:1", kind: "stop", arguments: [], trace_point_refs: [] },
        ],
        edges: [{ from: "call:1", to: "stop:1", role: "next" }],
      },
    ],
    trace_points: [],
  };
}

function airDocumentImportSharedMemory() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.shared_memory",
      name: "examples.shared_memory",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [
        {
          id: "memory:examples.shared_memory/ProjectKnowledge",
          name: "ProjectKnowledge",
        },
      ],
      triggers: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function airDocumentImportMemoryTools() {
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: "module:examples.memory_tools",
      name: "examples.memory_tools",
    },
    imports: [
      {
        kind: "memory",
        name: "ProjectKnowledge",
        from_module: "examples.shared_memory",
        target_ref: "memory:examples.shared_memory/ProjectKnowledge",
      },
    ],
    definitions: {
      constants: [],
      types: [
        {
          id: "type:examples.memory_tools/KnowledgeQuery",
          name: "KnowledgeQuery",
          fields: [{ name: "query", type_ref: "builtin:Text" }],
        },
        {
          id: "type:examples.memory_tools/KnowledgeResult",
          name: "KnowledgeResult",
          fields: [{ name: "summary", type_ref: "builtin:Text" }],
        },
      ],
      memories: [],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:examples.memory_tools/ReadKnowledge",
          name: "ReadKnowledge",
          signature: {
            inputs: [{ name: "query", type_ref: "type:examples.memory_tools/KnowledgeQuery" }],
            output_type: "type:examples.memory_tools/KnowledgeResult",
          },
          required_capabilities: ["memory_read"],
          memory_accesses: [
            {
              memory_ref: "memory:examples.shared_memory/ProjectKnowledge",
              access: "read",
            },
          ],
        },
      ],
      skills: [],
      agents: [],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function airDocumentImportMemoryApp() {
  return airDocumentImportMemoryAppWithScope(true);
}

function airDocumentImportMemoryAppMissingScope() {
  return airDocumentImportMemoryAppWithScope(false);
}

function airDocumentImportMemoryAppWithScope(withScope) {
  const moduleName = withScope ? "examples.memory_app" : "examples.memory_app_missing_scope";
  return {
    air_schema_version: "touba-air-v1",
    module: {
      id: `module:${moduleName}`,
      name: moduleName,
    },
    imports: [
      {
        kind: "type",
        name: "KnowledgeQuery",
        from_module: "examples.memory_tools",
        target_ref: "type:examples.memory_tools/KnowledgeQuery",
      },
      {
        kind: "type",
        name: "KnowledgeResult",
        from_module: "examples.memory_tools",
        target_ref: "type:examples.memory_tools/KnowledgeResult",
      },
      ...(withScope
        ? [{
          kind: "memory",
          name: "ProjectKnowledge",
          from_module: "examples.shared_memory",
          target_ref: "memory:examples.shared_memory/ProjectKnowledge",
        }]
        : []),
      {
        kind: "tool",
        name: "ReadKnowledge",
        from_module: "examples.memory_tools",
        target_ref: "tool:examples.memory_tools/ReadKnowledge",
      },
    ],
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [
        {
          id: `skill:${moduleName}/BuildKnowledgeAnswer`,
          name: "BuildKnowledgeAnswer",
          signature: {
            inputs: [{ name: "query", type_ref: "type:examples.memory_tools/KnowledgeQuery" }],
            output_type: "type:examples.memory_tools/KnowledgeResult",
          },
          uses: ["tool:examples.memory_tools/ReadKnowledge"],
          use_refs: [{ target_ref: "tool:examples.memory_tools/ReadKnowledge" }],
          memory_scopes: withScope
            ? [{
              memory_ref: "memory:examples.shared_memory/ProjectKnowledge",
              access: "read",
            }]
            : [],
          flow_graph_ref: `graph:skill:${moduleName}/BuildKnowledgeAnswer`,
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      {
        id: `graph:skill:${moduleName}/BuildKnowledgeAnswer`,
        owner_ref: `skill:${moduleName}/BuildKnowledgeAnswer`,
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_tool",
            target_ref: "tool:examples.memory_tools/ReadKnowledge",
            arguments: ["value:query"],
            result_binding: "result",
            trace_point_refs: [],
          },
          { id: "give:1", kind: "give", arguments: ["value:result"], trace_point_refs: [] },
        ],
        edges: [{ from: "call:1", to: "give:1", role: "next" }],
      },
    ],
    trace_points: [],
  };
}

function airDocumentPackageResearchTools() {
  return {
    air_schema_version: "touba-air-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: {
      id: "module:org.example.research",
      name: "org.example.research",
    },
    definitions: {
      constants: [],
      types: [
        {
          id: "type:org.example.research/DatasetSearchRequest",
          name: "DatasetSearchRequest",
          fields: [
            { name: "query", type_ref: "builtin:Text" },
            { name: "rows", type_ref: "builtin:Int" },
          ],
        },
        {
          id: "type:org.example.research/DatasetSearchResult",
          name: "DatasetSearchResult",
          fields: [
            { name: "title", type_ref: "builtin:Text" },
            { name: "url", type_ref: "builtin:Text" },
          ],
        },
      ],
      memories: [],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:org.example.research/SearchDatasets",
          name: "SearchDatasets",
          signature: {
            inputs: [{ name: "request", type_ref: "type:org.example.research/DatasetSearchRequest" }],
            output_type: "type:org.example.research/DatasetSearchResult",
          },
          required_capabilities: ["network"],
        },
      ],
      skills: [],
      agents: [],
      strategies: [],
    },
    execution_graphs: [],
    trace_points: [],
  };
}

function airDocumentPackageResearchApp() {
  return {
    air_schema_version: "touba-air-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: {
      id: "module:examples.package_app",
      name: "examples.package_app",
    },
    imports: [
      {
        kind: "type",
        name: "DatasetSearchRequest",
        from_module: "org.example.research",
        target_ref: "type:org.example.research/DatasetSearchRequest",
      },
      {
        kind: "type",
        name: "DatasetSearchResult",
        from_module: "org.example.research",
        target_ref: "type:org.example.research/DatasetSearchResult",
      },
      {
        kind: "tool",
        name: "SearchDatasets",
        from_module: "org.example.research",
        target_ref: "tool:org.example.research/SearchDatasets",
      },
    ],
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [
        {
          id: "skill:examples.package_app/BuildDatasetBrief",
          name: "BuildDatasetBrief",
          signature: {
            inputs: [{ name: "request", type_ref: "type:org.example.research/DatasetSearchRequest" }],
            output_type: "type:org.example.research/DatasetSearchResult",
          },
          uses: ["tool:org.example.research/SearchDatasets"],
          use_refs: [{ target_ref: "tool:org.example.research/SearchDatasets" }],
          flow_graph_ref: "graph:skill:examples.package_app/BuildDatasetBrief",
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      {
        id: "graph:skill:examples.package_app/BuildDatasetBrief",
        owner_ref: "skill:examples.package_app/BuildDatasetBrief",
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_tool",
            target_ref: "tool:org.example.research/SearchDatasets",
            arguments: ["value:request"],
            result_binding: "result",
            trace_point_refs: [],
          },
          { id: "give:1", kind: "give", arguments: ["value:result"], trace_point_refs: [] },
        ],
        edges: [{ from: "call:1", to: "give:1", role: "next" }],
      },
    ],
    trace_points: [],
  };
}

function airDocumentWithPureStrategy() {
  return {
    air_schema_version: "touba-air-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: {
      id: "module:local.run",
      name: "local.run",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [],
      skills: [],
      agents: [],
      strategies: [
        {
          id: "strategy:local.run/Run",
          name: "Run",
          signature: {
            inputs: [],
            output_type: "builtin:Text",
          },
          flow_graph_ref: "graph:strategy:local.run/Run",
        },
      ],
    },
    execution_graphs: [
      {
        id: "graph:strategy:local.run/Run",
        owner_ref: "strategy:local.run/Run",
        entry_node_id: "give:1",
        nodes: [
          {
            id: "give:1",
            kind: "give",
            arguments: ["literal:string:ok"],
            trace_point_refs: [],
          },
        ],
        edges: [],
      },
    ],
    trace_points: [],
  };
}

function airDocumentWithPayloadTrigger() {
  const document = airDocumentWithPureStrategy();
  document.definitions.strategies[0].signature.inputs = [
    { name: "query", type_ref: "builtin:Text" },
  ];
  document.execution_graphs[0].nodes[0].arguments = ["value:query"];
  document.definitions.triggers = [
    {
      id: "trigger:local.run/WebhookRun",
      name: "WebhookRun",
      event: {
        kind: "request",
        value: "POST /webhook/run",
      },
      target_ref: "strategy:local.run/Run",
      target_kind: "strategy",
      arguments: [],
      payload: {
        format: "json",
        content_types: ["application/json"],
        max_bytes: 65536,
        map: { query: "$.query" },
      },
      limits: {
        max_runs_per_day: 5,
        timeout_ms: 30000,
      },
    },
  ];
  return document;
}

function airDocumentWithToolStrategy() {
  return {
    air_schema_version: "touba-air-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: {
      id: "module:examples.data_app",
      name: "examples.data_app",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:examples.data_app/Search",
          name: "Search",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          required_capabilities: ["network", "secret_read"],
          required_secrets: ["DATA_API_TOKEN"],
        },
      ],
      skills: [
        {
          id: "skill:examples.data_app/SearchSkill",
          name: "SearchSkill",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: ["tool:examples.data_app/Search"],
          flow_graph_ref: "graph:skill:examples.data_app/SearchSkill",
        },
      ],
      agents: [],
      strategies: [
        {
          id: "strategy:examples.data_app/RunSearch",
          name: "RunSearch",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: ["skill:examples.data_app/SearchSkill"],
          flow_graph_ref: "graph:strategy:examples.data_app/RunSearch",
        },
      ],
    },
    execution_graphs: [
      {
        id: "graph:skill:examples.data_app/SearchSkill",
        owner_ref: "skill:examples.data_app/SearchSkill",
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_tool",
            target_ref: "tool:examples.data_app/Search",
            arguments: ["value:query"],
            result_binding: "result",
            trace_point_refs: [],
          },
          {
            id: "give:1",
            kind: "give",
            arguments: ["value:result"],
            trace_point_refs: [],
          },
        ],
        edges: [{ from_node_id: "call:1", to_node_id: "give:1", role: "next" }],
      },
      {
        id: "graph:strategy:examples.data_app/RunSearch",
        owner_ref: "strategy:examples.data_app/RunSearch",
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_skill",
            target_ref: "skill:examples.data_app/SearchSkill",
            arguments: ["value:query"],
            result_binding: "result",
            trace_point_refs: [],
          },
          {
            id: "give:1",
            kind: "give",
            arguments: ["value:result"],
            trace_point_refs: [],
          },
        ],
        edges: [{ from_node_id: "call:1", to_node_id: "give:1", role: "next" }],
      },
    ],
    trace_points: [],
  };
}

function airDocumentWithoutTools() {
  return {
    ...airDocumentWithTool(),
    module: {
      id: "module:local.simple",
      name: "local.simple",
    },
    definitions: {
      ...airDocumentWithTool().definitions,
      tools: [],
    },
  };
}

function bindingFragmentDocument(options = {}) {
  return {
    fragment_schema_version: "touba-binding-fragment-v1",
    source: {
      kind: "module",
      module: "donnees_quebec.live_search",
    },
    bindings: {
      "tool:donnees_quebec.live_search/SearchDatasets": {
        effect_contract: { kind: "none" }, handler: {
          kind: "process",
          command: "node",
          args: ["handlers/donnees_quebec/live_search/search_datasets.handler.mjs"],
          cwd: ".",
        },
        grants: ["network"],
        secrets: ["API_TOKEN"],
        timeout_ms: 5000,
        max_payload_bytes: 1048576,
      },
      ...(options.bindings ?? {}),
    },
    ...(options.fragment ?? {}),
  };
}

function resourceBindingsDocument(options = {}) {
  return {
    resource_bindings_schema_version: "touba-resource-bindings-v1",
    resources: {
      "memory:examples.memory/Notes": {
        kind: "memory_backend",
        provider: "host.local",
        grants: ["memory.read"],
        secrets: ["DATABASE_URL"],
        required_secrets: ["DATABASE_URL"],
        limits: {
          max_payload_bytes: 1048576,
        },
      },
      ...(options.resources ?? {}),
    },
  };
}

function ownershipDocument(options = {}) {
  return {
    ownership_schema_version: "touba-ownership-v1",
    teams: {
      "team:platform": {
        display_name: "Platform",
      },
      "team:security": {
        display_name: "Security",
      },
      ...(options.teams ?? {}),
    },
    owners: options.owners ?? {},
    review_gates: options.review_gates ?? {},
    reviews: options.reviews ?? [],
  };
}

function airDocumentWithMemoryResource({ withScope = true } = {}) {
  return {
    air_schema_version: "touba-air-v1",
    air_json_profile: "touba-air-json-canonical-v1",
    module: {
      id: "module:examples.memory",
      name: "examples.memory",
    },
    definitions: {
      constants: [],
      types: [],
      memories: [
        {
          id: "memory:examples.memory/Notes",
          name: "Notes",
        },
      ],
      triggers: [],
      functions: [],
      tools: [
        {
          id: "tool:examples.memory/ReadNotes",
          name: "ReadNotes",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          required_capabilities: ["memory_read"],
          memory_accesses: [
            {
              memory_ref: "memory:examples.memory/Notes",
              access: "read",
            },
          ],
        },
      ],
      skills: [
        {
          id: "skill:examples.memory/SearchNotes",
          name: "SearchNotes",
          signature: {
            inputs: [{ name: "query", type_ref: "builtin:Text" }],
            output_type: "builtin:Text",
          },
          uses: ["tool:examples.memory/ReadNotes"],
          memory_scopes: withScope
            ? [
              {
                memory_ref: "memory:examples.memory/Notes",
                access: "read",
              },
            ]
            : [],
          flow_graph_ref: "graph:skill:examples.memory/SearchNotes",
        },
      ],
      agents: [],
      strategies: [],
    },
    execution_graphs: [
      {
        id: "graph:skill:examples.memory/SearchNotes",
        owner_ref: "skill:examples.memory/SearchNotes",
        entry_node_id: "call:1",
        nodes: [
          {
            id: "call:1",
            kind: "call_tool",
            target_ref: "tool:examples.memory/ReadNotes",
            arguments: ["value:query"],
            result_binding: "result",
            trace_point_refs: [],
          },
          {
            id: "give:1",
            kind: "give",
            arguments: ["value:result"],
            trace_point_refs: [],
          },
        ],
        edges: [{ from_node_id: "call:1", to_node_id: "give:1", role: "next" }],
      },
    ],
    trace_points: [],
  };
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "touba-project-"));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}

async function runCliAsync(args, options = {}) {
  const child = spawn(process.execPath, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
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
  const status = await new Promise((resolveStatus, rejectStatus) => {
    child.on("error", rejectStatus);
    child.on("close", resolveStatus);
  });
  return { status, stdout, stderr };
}

function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, text, "utf8");
  return text;
}

function writeLocalPackageFixture(root, options = {}) {
  const packageRoot = join(root, "authors/research");
  mkdirSync(join(packageRoot, "src/org/example"), { recursive: true });
  writeFileSync(join(packageRoot, "src/org/example/research.tb"), "module org.example.research\n", "utf8");
  mkdirSync(join(packageRoot, "validation/package"), { recursive: true });
  writeFileSync(join(packageRoot, "validation/package/research-contract.md"), "# Fixture contract\n");
  writeFileSync(join(packageRoot, "touba.package.json"), JSON.stringify(packageManifestDocument(options), null, 2), "utf8");
}

function packageManifestDocument(options = {}) {
  return {
    package_schema_version: "touba-package-v1",
    name: "org.example.research",
    version: "0.1.0",
    root: ".",
    touba: {
      air_profile: "touba-air-json-canonical-v1",
      runtime_compatibility: ">=1.0 <2.0",
    },
    exports: {
      types: [],
      defines: [],
      functions: [],
      tools: [],
      skills: [],
      strategies: [],
      agents: [],
      memories: [],
      ...(options.exports ?? {}),
    },
    provenance: {
      kind: "local_path",
      source: ".",
    },
    contract_tests: [
      "validation/package/research-contract.md",
    ],
    ...(options.manifest ?? {}),
  };
}

function sha256(text) {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}
