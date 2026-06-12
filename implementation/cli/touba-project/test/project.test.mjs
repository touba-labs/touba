import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import test from "node:test";

import {
  checkProjectSecret,
  initProject,
  listProjectSecrets,
  newModule,
  prepareProject,
  removeProjectSecret,
  setProjectSecret,
} from "../src/project.mjs";

const testDir = dirname(fileURLToPath(import.meta.url));
const cliPath = new URL("../src/main.mjs", import.meta.url).pathname;
const implementationRoot = join(testDir, "../../..");
const linearAirFixture = join(implementationRoot, "tests/air/tb-v01-001-linear-skill.air.json");
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
    assert.equal(existsSync(join(root, ".touba/secrets.local.json")), true);
    assert.equal(existsSync(join(root, ".env")), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
    assert.equal(existsSync(join(root, "touba.secrets.dev.json")), false);
    assert.equal(existsSync(join(root, "touba.secrets.prod.json")), false);
    const store = JSON.parse(readFileSync(join(root, ".touba/secrets.local.json"), "utf8"));
    assert.equal(store.store_version, "touba-secret-store-local-v1");
    assert.deepEqual(store.secrets, {});
    const projectConfig = JSON.parse(readFileSync(join(root, "touba.project.json"), "utf8"));
    assert.deepEqual(projectConfig, {
      project_version: "touba-project-v1",
      language: "javascript",
      sdk: "@touba/sdk",
      run_profiles: {
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

test("init rejects reserved project languages until their SDKs are available", () => {
  const root = tempRoot();
  try {
    assert.throws(
      () => initProject({ root, language: "python" }),
      /project language python is not available in this V1; choose javascript/,
    );
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

test("secret store commands manage handles without printing values", () => {
  const root = tempRoot();
  try {
    const setReport = setProjectSecret("OPENAI_API_KEY", "local-secret-value", { root });
    const storePath = join(root, ".touba/secrets.local.json");
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
    assert.equal(report.status, "success");
    const manifest = JSON.parse(readFileSync(join(root, "touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    assert.equal(binding.handler.command, "/usr/bin/node");
    assert.deepEqual(binding.handler.args, ["handlers/donnees_quebec/live_search/search_datasets.handler.mjs"]);
    assert.equal(binding.handler.cwd, ".");
    assert.deepEqual(binding.grants, ["network"]);
    assert.deepEqual(binding.secrets, ["API_TOKEN"]);
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
    assert.equal(existsSync(join(root, ".touba/secrets.local.json")), true);
    assert.equal(existsSync(join(root, ".env")), true);
    const devSecrets = JSON.parse(readFileSync(join(root, "touba.secrets.dev.json"), "utf8"));
    assert.equal(devSecrets.secrets_version, "touba-secrets-v1");
    assert.deepEqual(devSecrets.secrets.API_TOKEN, {
      source: "touba_store",
      path: ".touba/secrets.local.json",
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
    assert.equal(report.status, "success");
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
    const manifest = JSON.parse(readFileSync(join(root, "touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    assert.equal(binding.handler.args[0], "custom/search.handler.mjs");
    assert.equal(binding.timeout_ms, 12000);
    assert.equal(binding.max_payload_bytes, 2048);
    assert.deepEqual(binding.payload_constraints.input.request, { non_empty: true, max_length: 80 });
    assert.deepEqual(binding.payload_constraints.input["request.tags"], { min_items: 1, max_items: 5 });
    assert.deepEqual(binding.payload_constraints.input["request.mode"], { allowed_values: ["dry_run", "review"] });
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
          handler: {
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
          handler: {
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
          handler: {
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
          payload_constraints: {
            input: {
              "request.tags": { max_items: -1 },
            },
          },
        },
      },
    }));
    writeJson(join(root, "authority.json"), {
      fragment_schema_version: "touba-binding-fragment-v0.1",
      source: { kind: "module", module: "donnees_quebec.live_search" },
      callable_by: ["strategy:examples/Run"],
      bindings: {},
    });

    const cases = [
      ["missing-grant.json", "BindingFragmentMissingGrant"],
      ["duplicate.json", "BindingFragmentDuplicateBinding", ["duplicate.json", "duplicate.json"]],
      ["conflict.json", "BindingFragmentConflictingBinding", ["duplicate.json", "conflict.json"]],
      ["unknown-tool.json", "BindingFragmentUnknownTool"],
      ["bad-constraint.json", "BindingFragmentConstraintInvalid"],
      ["bad-list-constraint.json", "BindingFragmentConstraintInvalid"],
      ["bad-list-constraint-type.json", "BindingFragmentConstraintInvalid"],
      ["authority.json", "BindingFragmentAuthorityFieldForbidden"],
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

test("prepare write uses a portable node command by default", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "input.air.json"), JSON.stringify(airDocumentWithTool(), null, 2), "utf8");
    await prepareProject({
      root,
      mode: "write",
      airPaths: ["input.air.json"],
    });
    const manifest = JSON.parse(readFileSync(join(root, "touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:donnees_quebec.live_search/SearchDatasets"];
    assert.equal(binding.handler.command, "node");
  } finally {
    cleanup(root);
  }
});

test("prepare refuses unavailable project SDK languages from project config", async () => {
  const root = tempRoot();
  try {
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({
      project_version: "touba-project-v1",
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
    assert.equal(existsSync(join(root, ".touba/air/local/simple.air.json")), true);
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
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:local.run/Run",
      air: ".touba/air/local/run.air.json",
      profile: "dev",
      outputs: {
        mode: "show",
      },
    });
    assert.equal(existsSync(join(root, ".touba/air/local/run.air.json")), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);
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
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:local.run/Run",
      air: ".touba/air/local/run.air.json",
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
      run_plan_schema_version: "touba-run-plan-v0.1",
      entry_ref: "strategy:local.run/Run",
      air: ".touba/air/local/run.air.json",
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

    assert.equal(report.status, "success");
    const plan = JSON.parse(readFileSync(join(root, "touba.run-plan.json"), "utf8"));
    assert.equal(plan.entry_ref, "strategy:examples.data_app/RunSearch");
    assert.equal(plan.air, ".touba/air/examples/data_app.air.json");
    assert.equal(plan.manifest, "touba.manifest.json");
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
      ownership_schema_version: "touba-ownership-v0.1",
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
    const assembledSearch = JSON.parse(readFileSync(join(root, ".touba/air/examples/search.air.json"), "utf8"));
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

    assert.equal(report.status, "success");
    assert.deepEqual(report.tools, ["tool:examples.data_tools/SearchDatasets"]);
    assert.equal(report.imports.some((item) => item.target_ref === "tool:examples.data_tools/SearchDatasets"), true);

    const manifest = JSON.parse(readFileSync(join(root, "touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:examples.data_tools/SearchDatasets"];
    assert.deepEqual(binding.grants, ["network", "secret_read"]);
    assert.deepEqual(binding.secrets, ["DATA_API_TOKEN"]);
    assert.deepEqual(binding.handler.args, ["handlers/examples/data_tools/search_datasets.handler.mjs"]);

    assert.equal(
      existsSync(join(root, "handlers/examples/data_tools/search_datasets.handler.mjs")),
      true,
    );
    assert.equal(
      existsSync(join(root, "handlers/examples/research_app/search_datasets.handler.mjs")),
      false,
    );

    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/air/examples/research_app.air.json"), "utf8"));
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

    assert.equal(report.status, "success");
    assert.deepEqual(report.tools, []);
    assert.equal(report.imports.some((item) => item.target_ref === "skill:examples.shared_flow/NormalizeTopic"), true);
    assert.equal(report.imports.some((item) => item.target_ref === "strategy:examples.shared_flow/SharedTopicRun"), true);
    assert.equal(existsSync(join(root, "touba.manifest.json")), false);

    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/air/examples/flow_app.air.json"), "utf8"));
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
    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/air/examples/agent_app.air.json"), "utf8"));
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

    assert.equal(report.status, "success");
    assert.deepEqual(report.tools, ["tool:examples.memory_tools/ReadKnowledge"]);
    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/air/examples/memory_app.air.json"), "utf8"));
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

    assert.equal(report.status, "success");
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
      language: "javascript",
      sdk: "@touba/sdk",
      packages: [
        {
          manifest: "packages/research/touba.package.json",
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
      compileSource: (sourcePath) => sourcePath.includes(join("packages", "research"))
        ? airDocumentPackageResearchTools()
        : airDocumentPackageResearchApp(),
    });

    assert.equal(report.status, "success");
    assert.equal(report.packages[0].name, "org.example.research");
    assert.deepEqual(report.packages[0].modules, ["org.example.research"]);
    assert.equal(report.imports.some((item) => item.target_ref === "tool:org.example.research/SearchDatasets"), true);
    assert.deepEqual(report.tools, ["tool:org.example.research/SearchDatasets"]);

    const manifest = JSON.parse(readFileSync(join(root, "touba.manifest.json"), "utf8"));
    const binding = manifest.bindings["tool:org.example.research/SearchDatasets"];
    assert.deepEqual(binding.grants, ["network"]);
    assert.deepEqual(binding.handler.args, ["handlers/org/example/research/search_datasets.handler.mjs"]);
    assert.equal(existsSync(join(root, "handlers/org/example/research/search_datasets.handler.mjs")), true);
    assert.equal(existsSync(join(root, ".touba/air/org/example/research.air.json")), false);

    const assembledApp = JSON.parse(readFileSync(join(root, ".touba/air/examples/package_app.air.json"), "utf8"));
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
      language: "javascript",
      sdk: "@touba/sdk",
      packages: [{ manifest: "packages/research/touba.package.json" }],
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
      compileSource: (sourcePath) => sourcePath.includes(join("packages", "research"))
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
          runtime_compatibility: ">=0.1 <0.2",
        },
        registry: "https://registry.example.invalid",
        bindings: {},
      },
    });
    mkdirSync(join(root, "src/examples"), { recursive: true });
    writeFileSync(join(root, "src/examples/package_app.tb"), "module examples.package_app\n", "utf8");
    writeFileSync(join(root, "touba.project.json"), JSON.stringify({
      project_version: "touba-project-v1",
      language: "javascript",
      sdk: "@touba/sdk",
      packages: [
        {
          manifest: "packages/research/touba.package.json",
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

    const report = await prepareProject({
      root,
      mode: "plan",
      compileSource: (sourcePath) => sourcePath.includes(join("packages", "research"))
        ? airDocumentPackageResearchTools()
        : airDocumentPackageResearchApp(),
    });

    assert.equal(report.status, "error");
    assert.equal(report.diagnostics.some((item) => item.code === "PackageRegistryForbidden"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "PackageAuthorityFieldForbidden"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "PackageVersionIncompatible"), true);
    assert.equal(report.diagnostics.some((item) => item.code === "PackageAirProfileIncompatible"), true);
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
      language: "javascript",
      sdk: "@touba/sdk",
      packages: [{ manifest: "packages/research/touba.package.json" }],
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

test("prepare source compilation uses TOUBA_COMPILE_BIN before Cargo", async () => {
  const root = tempRoot();
  const compilerRoot = tempRoot();
  const previousCompiler = process.env.TOUBA_COMPILE_BIN;
  try {
    const sourcePath = join(root, "src/local/simple.tb");
    mkdirSync(join(root, "src/local"), { recursive: true });
    writeFileSync(sourcePath, "module local.simple\n", "utf8");

    const compilerPath = join(compilerRoot, "mock-touba-compile.mjs");
    const airJson = JSON.stringify(airDocumentWithoutTools());
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
    assert.equal(existsSync(join(root, ".touba/air/local/simple.air.json")), true);
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
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:donnees_quebec.live_search/SearchDatasets": {
          handler: {
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
    const manifest = JSON.parse(readFileSync(join(root, "touba.manifest.json"), "utf8"));
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
    writeFileSync(join(root, "touba.manifest.json"), JSON.stringify({
      manifest_version: "touba-manifest-v1",
      bindings: {
        "tool:local.simple/OldTool": {
          handler: {
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
  assert.match(result.stdout, /touba trigger run <program\.air\.json> --manifest <path> --trigger <trigger_ref> --max-runs <n>/);
  assert.match(result.stdout, /--state <touba\.trigger-state\.json>/);
  assert.match(result.stdout, /touba manifest generate <air\.json> --out <touba\.manifest\.json>/);
  assert.match(result.stdout, /touba manifest generate <air\.json> --stdout/);
  assert.match(result.stdout, /touba handler stub <air\.json> \[--tool-ref <tool_ref>\] \[--handler-root <path>\] \[--force\]/);
  assert.match(result.stdout, /--ownership <touba\.ownership\.json>/);
  assert.match(result.stdout, /touba audit --trace <trace\.json>/);
  assert.match(result.stdout, /--report-out <report\.trace-audit-report\.json>/);
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
  assert.match(triggerResult.stdout, /--state <touba\.trigger-state\.json>/);
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

  const auditResult = spawnSync(process.execPath, [cliPath, "audit", "--help"], { encoding: "utf8" });
  assert.equal(auditResult.status, 0, auditResult.stderr);
  assert.match(auditResult.stdout, /touba-audit --trace <trace\.json>/);
  assert.match(auditResult.stdout, /--export <export\.json>/);
  assert.match(auditResult.stdout, /--report-out <report\.trace-audit-report\.json>/);

  const supplyChainResult = spawnSync(process.execPath, [cliPath, "supply-chain", "--help"], { encoding: "utf8" });
  assert.equal(supplyChainResult.status, 0, supplyChainResult.stderr);
  assert.match(supplyChainResult.stdout, /touba supply-chain validate --lock <touba\.lock\.json>/);
  assert.match(supplyChainResult.stdout, /--report-out <report\.supply-chain-report\.json>/);
  assert.match(supplyChainResult.stdout, /--require-review/);
  assert.equal(supplyChainResult.stdout.includes("registry"), false);
});

test("CLI version reports public command and schema versions", () => {
  const result = spawnSync(process.execPath, [cliPath, "version", "--json"], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const report = JSON.parse(result.stdout);
  assert.equal(report.cli, "0.1.0");
  assert.equal(report.runtime, "0.1.0");
  assert.equal(report.audit, "0.1.0");
  assert.equal(report.supply_chain, "0.1.0");
  assert.equal(report.schemas.air, "air-minimal-v0.1");
  assert.equal(report.schemas.trace, "trace-minimal-v0.1");
  assert.equal(report.schemas.manifest, "touba-manifest-v1");
  assert.equal(report.schemas.ownership, "touba-ownership-v0.1");
  assert.equal(report.schemas.trace_audit, "trace-audit-v0.1");
  assert.equal(report.schemas.trace_audit_validation, "trace-audit-validation-v0.1");
  assert.equal(report.schemas.trace_audit_export, "trace-audit-export-v0.1-local");
  assert.equal(report.schemas.supply_chain_lock, "touba-lock-v0.1");
  assert.equal(report.schemas.supply_chain_validation, "touba-supply-chain-validation-v0.1");
  assert.equal(report.distribution.platform, `${process.platform}-${process.arch}`);
});

test("CLI update is explicit when self-update is unavailable", () => {
  const result = spawnSync(process.execPath, [cliPath, "update"], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assert.match(result.stdout, /self-update is not available/);
  assert.match(result.stdout, /local-development/);
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
    "process.stdout.write(JSON.stringify({ air_schema_version: 'air-minimal-v0.1' }))",
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
      "process.stdout.write(JSON.stringify({ air_schema_version: 'air-minimal-v0.1', module: { name: 'examples.hello' } }))",
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
    assert.equal(air.air_schema_version, "air-minimal-v0.1");
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
      "process.stdout.write(JSON.stringify({ air_schema_version: 'air-minimal-v0.1' }))",
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
    assert.match(result.stdout, /Touba Inspect touba-inspect-v0\.1/);
    assert.match(result.stdout, /AIR air-minimal-v0\.1/);
  } finally {
    cleanup(root);
  }
});

test("CLI audit delegates to Touba Audit for trace artifacts", () => {
  const root = tempRoot();
  try {
    const tracePath = join(root, "run.trace.json");
    writeFileSync(tracePath, JSON.stringify({
      trace_protocol_version: "trace-minimal-v0.1",
      run: {
        run_id: "run-project-audit",
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
          payload: { status: "success" },
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
          handler: {
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
      lock_schema_version: "touba-lock-v0.1",
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
            version: "0.1.0",
            protocol: "touba-tool-handler-v1",
            status: "ok",
          },
          handler_package: {
            kind: "local",
            name: "donnees_quebec.live_search.handlers",
            version: "0.1.0",
            entrypoint: "handlers/search_datasets.handler.mjs",
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
    assert.deepEqual(binding.grants, ["network"]);

    const stubResult = spawnSync(process.execPath, [
      cliPath,
      "handler",
      "stub",
      airPath,
      "--handler-root",
      "handlers",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(stubResult.status, 0, stubResult.stderr);
    assert.equal(existsSync(join(root, "handlers/search_datasets.handler.mjs")), true);
  } finally {
    cleanup(root);
  }
});

test("CLI run delegates to the runtime", () => {
  const result = spawnSync(process.execPath, [
    cliPath,
    "run",
    linearAirFixture,
    "--inputs-json",
    JSON.stringify({ request: { topic: "project-cli" } }),
    "--local-fetch-source-text",
    "project CLI source",
    "--output",
    "trace",
  ], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const trace = JSON.parse(result.stdout);
  assert.equal(trace.trace_protocol_version, "trace-minimal-v0.1");
  assert.equal(trace.events.at(-1).payload.status, "success");
});

test("CLI run applies project dev and prod supply-chain profiles", () => {
  const root = tempRoot();
  try {
    initProject({ root });
    const devResult = spawnSync(process.execPath, [
      cliPath,
      "run",
      linearAirFixture,
      "--profile",
      "dev",
      "--inputs-json",
      JSON.stringify({ request: { topic: "profile-dev" } }),
      "--local-fetch-source-text",
      "profile dev source",
      "--output",
      "trace",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(devResult.status, 0, devResult.stderr);

    const airText = readFileSync(linearAirFixture, "utf8");
    writeJson(join(root, "touba.lock.json"), {
      lock_schema_version: "touba-lock-v0.1",
      lock_kind: "supply_chain",
      generated_at: "2026-06-05T12:00:00Z",
      generated_by: {
        tool: "touba test",
        version: "0.1.0",
      },
      air: {
        path: "linear.air.json",
        digest: {
          kind: "sha256",
          value: sha256(airText),
        },
      },
      handlers: [],
    });

    const prodResult = spawnSync(process.execPath, [
      cliPath,
      "run",
      linearAirFixture,
      "--profile=prod",
      "--inputs-json",
      JSON.stringify({ request: { topic: "profile-prod" } }),
      "--local-fetch-source-text",
      "profile prod source",
      "--output",
      "trace",
    ], { cwd: root, encoding: "utf8" });
    assert.equal(prodResult.status, 0, prodResult.stderr);
    const trace = JSON.parse(prodResult.stdout);
    assert.equal(trace.events.at(-1).payload.status, "success");
  } finally {
    cleanup(root);
  }
});

test("CLI run prod profile refuses before runtime when project lock drifts", () => {
  const root = tempRoot();
  try {
    initProject({ root });
    writeJson(join(root, "touba.lock.json"), {
      lock_schema_version: "touba-lock-v0.1",
      lock_kind: "supply_chain",
      generated_at: "2026-06-05T12:00:00Z",
      generated_by: {
        tool: "touba test",
        version: "0.1.0",
      },
      air: {
        path: "linear.air.json",
        digest: {
          kind: "sha256",
          value: "0".repeat(64),
        },
      },
      handlers: [],
    });

    const result = spawnSync(process.execPath, [
      cliPath,
      "run",
      linearAirFixture,
      "--profile",
      "prod",
      "--inputs-json",
      JSON.stringify({ request: { topic: "profile-prod-drift" } }),
      "--local-fetch-source-text",
      "should not matter",
      "--output",
      "trace",
    ], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 1);
    assert.match(result.stderr, /SupplyChainLockInvalid/);
    assert.match(result.stderr, /AirChanged|SupplyChainDigestMismatch/);
  } finally {
    cleanup(root);
  }
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
      "--local-fetch-source-text",
      "source",
    ], { cwd: root, encoding: "utf8" });

    assert.equal(result.status, 2);
    assert.match(result.stderr, /run profile prod requires touba\.project\.json/);
  } finally {
    cleanup(root);
  }
});

function airDocumentWithTool() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
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

function airDocumentWithToolStrategy() {
  return {
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
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
    fragment_schema_version: "touba-binding-fragment-v0.1",
    source: {
      kind: "module",
      module: "donnees_quebec.live_search",
    },
    bindings: {
      "tool:donnees_quebec.live_search/SearchDatasets": {
        handler: {
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
    resource_bindings_schema_version: "touba-resource-bindings-v0.1",
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
    ownership_schema_version: "touba-ownership-v0.1",
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
    air_schema_version: "air-minimal-v0.1",
    air_json_profile: "air-json-v0.1",
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

function writeJson(filePath, value) {
  const text = `${JSON.stringify(value, null, 2)}\n`;
  writeFileSync(filePath, text, "utf8");
  return text;
}

function writeLocalPackageFixture(root, options = {}) {
  const packageRoot = join(root, "packages/research");
  mkdirSync(join(packageRoot, "src/org/example"), { recursive: true });
  writeFileSync(join(packageRoot, "src/org/example/research.tb"), "module org.example.research\n", "utf8");
  writeFileSync(join(packageRoot, "touba.package.json"), JSON.stringify(packageManifestDocument(options), null, 2), "utf8");
}

function packageManifestDocument(options = {}) {
  return {
    package_schema_version: "touba-package-v0.1",
    name: "org.example.research",
    version: "0.1.0",
    root: ".",
    touba: {
      air_profile: "air-json-v0.1",
      runtime_compatibility: ">=0.1 <0.2",
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
