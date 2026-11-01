import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  generateManifestFromAirDocument,
  toolNameToHandlerFile,
} from "../src/generate.mjs";
import {
  generateHandlerContractTestFromAirTool,
  generateHandlerStubFromAirTool,
  writeHandlerStubsFromAirDocument,
} from "../src/stub.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const generatePath = join(__dir, "../src/generate.mjs");
const stubPath = join(__dir, "../src/stub.mjs");

for (const language of ["javascript", "python"]) test(`CLI honors the canonical ${language} project without overwriting its manifest`, t => {
  const root = mkdtempSync(join(tmpdir(), "touba-manifest-language-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, "touba.project.json"), JSON.stringify({ project_version: "touba-project-v1", artifact_layout: "touba-artifacts-v1", language,
    sdk: language === "python" ? "touba-sdk" : "@touba/sdk" }));
  writeFileSync(join(root, "source.air.json"), JSON.stringify(airDocument()));
  const args = [generatePath, "source.air.json", "--out", "config/touba.manifest.json"];
  const first = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  assert.equal(first.status, 0, first.stderr);
  const bytes = readFileSync(join(root, "config/touba.manifest.json"), "utf8");
  const binding = JSON.parse(bytes).bindings["tool:examples.docs/SearchDatasets"];
  assert.equal(binding.effect_contract, null);
  assert.deepEqual(binding.grants, []);
  assert.equal(binding.handler.cwd, "..");
  assert.match(binding.handler.args[0], language === "python" ? /\.handler\.py$/ : /\.handler\.mjs$/);
  assert.equal(binding.handler.command, language === "python" ? (process.platform === "win32" ? ".venv/Scripts/python.exe" : "./.venv/bin/python") : "node");
  const again = spawnSync(process.execPath, args, { cwd: root, encoding: "utf8" });
  assert.equal(again.status, 1);
  assert.equal(readFileSync(join(root, "config/touba.manifest.json"), "utf8"), bytes);
  assert.doesNotMatch(again.stderr, /Generated a draft/);
  const mismatch = spawnSync(process.execPath, [generatePath, "source.air.json", "--stdout", "--language", language === "python" ? "javascript" : "python"], { cwd: root, encoding: "utf8" });
  assert.equal(mismatch.status, 1);
});

test("converts Touba tool names to handler file names", () => {
  assert.equal(toolNameToHandlerFile("SearchDatasets"), "search_datasets.handler.mjs");
  assert.equal(toolNameToHandlerFile("FetchSource"), "fetch_source.handler.mjs");
  assert.equal(toolNameToHandlerFile("ApplyHTTPPatch", "js"), "apply_http_patch.handler.js");
});

test("generates manifest bindings from AIR tools", () => {
  const manifest = generateManifestFromAirDocument(airDocument(), {
    handlerCommand: "node",
    handlerRoot: "handlers",
    handlerCwd: ".",
    timeoutMs: 7000,
    maxPayloadBytes: 2048,
  });

  assert.equal(manifest.manifest_version, "touba-manifest-v1");
  assert.equal(manifest.agent_secret_scopes, undefined);
  assert.deepEqual(manifest.bindings["tool:examples.docs/SearchDatasets"], {
    effect_contract: null,
    handler: {
      kind: "process",
      command: "node",
      args: ["handlers/examples/docs/search_datasets.handler.mjs"],
      cwd: ".",
    },
    grants: [],
    timeout_ms: 7000,
    max_payload_bytes: 2048,
    secrets: [],
    memories: [],
  });
});

test("generates request trigger payload contracts from AIR", () => {
  const manifest = generateManifestFromAirDocument(triggerAirDocument());

  assert.deepEqual(manifest.triggers["trigger:examples.webhook/WebhookRun"], {
    enabled: false,
    source: {
      kind: "request",
    },
    limits: {
      max_runs_per_day: 5,
      timeout_ms: 30000,
    },
    payload: {
      format: "json",
      content_types: ["application/json"],
      max_bytes: 65536,
      map: {
        message: "$.message",
      },
    },
  });
});

test("does not infer agent or strategy authority from AIR owners", () => {
  const manifest = generateManifestFromAirDocument({
    air_schema_version: "touba-air-v1",
    definitions: {
      agents: [
        {
          id: "agent:examples.docs/Researcher",
          name: "Researcher",
          callable_by: [{ caller_kind: "strategy", caller_ref: "strategy:examples.docs/Run" }],
        },
      ],
      strategies: [
        {
          id: "strategy:examples.docs/Run",
          name: "Run",
        },
      ],
      tools: [
        {
          id: "tool:examples.docs/SearchDatasets",
          name: "SearchDatasets",
          required_capabilities: ["network"],
        },
      ],
    },
  });

  assert.deepEqual(Object.keys(manifest.bindings), ["tool:examples.docs/SearchDatasets"]);
  assert.equal(manifest.agent_secret_scopes, undefined);
});

test("prints a manifest template from the CLI", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-manifest-"));
  try {
    const airPath = join(workspace, "fixture.air.json");
    writeFileSync(airPath, JSON.stringify(airDocument()), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [
        generatePath,
        airPath,
        "--stdout",
        "--handler-command",
        "node",
        "--handler-cwd",
        ".",
        "--timeout-ms",
        "9000",
      ],
      { encoding: "utf8" },
    );

    const manifest = JSON.parse(stdout);
    assert.equal(
      manifest.bindings["tool:examples.docs/SearchDatasets"].handler.args[0],
      "handlers/examples/docs/search_datasets.handler.mjs",
    );
    assert.equal(manifest.bindings["tool:examples.docs/SearchDatasets"].timeout_ms, 9000);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CLI refuses implicit manifest stdout", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-manifest-implicit-"));
  try {
    const airPath = join(workspace, "fixture.air.json");
    writeFileSync(airPath, JSON.stringify(airDocument()), "utf8");

    assert.throws(
      () => execFileSync(process.execPath, [generatePath, airPath], { encoding: "utf8", stdio: "pipe" }),
      /requires an explicit output mode/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CLI writes manifest through --out", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-manifest-out-"));
  try {
    const airPath = join(workspace, "fixture.air.json");
    const outPath = join(workspace, "generated", "touba.manifest.json");
    writeFileSync(airPath, JSON.stringify(airDocument()), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [
        generatePath,
        airPath,
        "--out",
        outPath,
        "--handler-command",
        "node",
      ],
      { encoding: "utf8" },
    );

    assert.equal(stdout, "");
    const manifest = JSON.parse(readFileSync(outPath, "utf8"));
    assert.equal(manifest.manifest_version, "touba-manifest-v1");
    assert.equal(manifest.bindings["tool:examples.docs/SearchDatasets"].handler.command, "node");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("CLI refuses non-canonical manifest output extension", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-manifest-extension-"));
  try {
    const airPath = join(workspace, "fixture.air.json");
    writeFileSync(airPath, JSON.stringify(airDocument()), "utf8");

    assert.throws(
      () => execFileSync(
        process.execPath,
        [generatePath, airPath, "--out", join(workspace, "touba.json")],
        { encoding: "utf8", stdio: "pipe" },
      ),
      /must end with \.manifest\.json/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("generates a SDK handler stub from an AIR tool", () => {
  const stub = generateHandlerStubFromAirTool(airDocument().definitions.tools[0]);

  assert.match(stub, /from "@touba\/sdk"/);
  assert.match(stub, /toubaSdkMetadata/);
  assert.match(stub, /export const TOUBA_HANDLER_SDK = toubaSdkMetadata\(\)/);
  assert.match(stub, /const TOOL_REF = "tool:examples\.docs\/SearchDatasets"/);
  assert.match(stub, /const REQUIRED_GRANTS = \["network","secret_read","memory_read"\]/);
  assert.match(stub, /const REQUIRED_SECRET_HANDLES = \["SEARCH_API_KEY"\]/);
  assert.match(stub, /defineTool/);
  assert.match(stub, /export async function run/);
  assert.match(stub, /pathToFileURL/);
  assert.match(stub, /HandlerNotImplemented/);
});

test("generates a SDK handler contract test from an AIR tool", () => {
  const contract = generateHandlerContractTestFromAirTool(airDocument().definitions.tools[0], {
    handlerImport: "./search_datasets.handler.mjs",
  });

  assert.match(contract, /from "@touba\/sdk"/);
  assert.match(contract, /createToolHandler/);
  assert.match(contract, /handleToolRequest/);
  assert.match(contract, /TOUBA_HANDLER_SDK/);
  assert.match(contract, /without granting runtime authority/);
  assert.match(contract, /test\.todo\("business behavior:/);
  assert.match(contract, /admission tests alone do not cover it/);
  assert.match(contract, /from "\.\/search_datasets\.handler\.mjs"/);
  assert.match(contract, /InvalidToolRef/);
  assert.match(contract, /MissingGrant/);
});

test("writes handler stubs without overwriting by default", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-handler-stub-"));
  try {
    const written = writeHandlerStubsFromAirDocument(airDocument(), {
      handlerRoot: join(workspace, "handlers"),
    });

    assert.equal(written.length, 1);
    const targetPath = join(workspace, "handlers/examples/docs/search_datasets.handler.mjs");
    const content = readFileSync(targetPath, "utf8");
    assert.match(content, /tool:examples\.docs\/SearchDatasets/);
    assert.throws(
      () => writeHandlerStubsFromAirDocument(airDocument(), { handlerRoot: join(workspace, "handlers") }),
      /handler stub already exists/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("generates handler stubs from the CLI and refuses overwrite", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-handler-stub-cli-"));
  try {
    const airPath = join(workspace, "fixture.air.json");
    writeFileSync(airPath, JSON.stringify(airDocument()), "utf8");

    const stdout = execFileSync(
      process.execPath,
      [
        stubPath,
        airPath,
        "--handler-root",
        join(workspace, "handlers"),
        "--tool-ref",
        "tool:examples.docs/SearchDatasets",
      ],
      { encoding: "utf8" },
    );

    assert.match(stdout, /generated .*search_datasets\.handler\.mjs/);

    assert.throws(
      () => execFileSync(
        process.execPath,
        [stubPath, airPath, "--handler-root", join(workspace, "handlers")],
        { encoding: "utf8", stdio: "pipe" },
      ),
      /handler stub already exists/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

function airDocument() {
  return {
    air_schema_version: "touba-air-v1",
    definitions: {
      tools: [
        {
          id: "tool:examples.docs/SearchDatasets",
          name: "SearchDatasets",
          required_capabilities: ["network", "secret_read", "memory_read"],
          required_secrets: ["SEARCH_API_KEY"],
          memory_accesses: [
            {
              memory_ref: "memory:examples.docs/SearchCache",
              access: "read",
            },
          ],
        },
      ],
    },
  };
}

function triggerAirDocument() {
  return {
    air_schema_version: "touba-air-v1",
    definitions: {
      tools: [],
      triggers: [
        {
          id: "trigger:examples.webhook/WebhookRun",
          name: "WebhookRun",
          event: {
            kind: "request",
            value: "POST /webhook/run",
          },
          target_ref: "strategy:examples.webhook/RunWebhook",
          target_kind: "strategy",
          payload: {
            format: "json",
            content_types: ["application/json"],
            max_bytes: 65536,
            map: {
              message: "$.message",
            },
          },
          limits: {
            max_runs_per_day: 5,
            timeout_ms: 30000,
          },
        },
      ],
    },
  };
}
