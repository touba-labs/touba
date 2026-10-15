import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";

import { importMcpTools } from "../src/mcp-import.mjs";

const cliPath = new URL("../src/main.mjs", import.meta.url).pathname;

test("mcp import plans and writes governed Touba artifacts from a tools snapshot", () => {
  const root = tempRoot();
  try {
    const configPath = writeMcpConfig(root, {
      tools: [
        weatherTool(),
        {
          name: "post_comment",
          description: "Post a comment after review",
          secret_handles: ["GITHUB_TOKEN"],
          inputSchema: {
            type: "object",
            properties: {
              issueNumber: { type: "integer" },
              body: { type: "string" },
            },
            required: ["issueNumber", "body"],
          },
          outputSchema: {
            type: "object",
            properties: {
              url: { type: "string" },
              posted: { type: "boolean" },
            },
            required: ["url", "posted"],
          },
        },
      ],
    });

    const plan = importMcpTools({
      root,
      configPath,
      moduleName: "integrations.mcp.demo",
      out: "integrations/demo",
    });
    assert.equal(plan.status, "success");
    assert.equal(plan.mode, "plan");
    assert.equal(plan.imported_tools.length, 2);
    assert.equal(existsSync(join(root, "integrations/demo/src/demo.tb")), false);

    const written = importMcpTools({
      root,
      configPath,
      moduleName: "integrations.mcp.demo",
      out: "integrations/demo",
      mode: "write",
    });
    assert.equal(written.status, "success");
    assert.equal(existsSync(join(root, "integrations/demo/src/demo.tb")), true);
    assert.equal(existsSync(join(root, "integrations/demo/touba.manifest.fragment.json")), true);
    assert.equal(existsSync(join(root, "integrations/demo/mcp.bridge.config.json")), true);
    assert.equal(existsSync(join(root, "integrations/demo/handlers/get-weather.mcp-bridge.mjs")), true);
    assert.equal(existsSync(join(root, "integrations/demo/handlers/post-comment.mcp-bridge.mjs")), true);

    const source = readFileSync(join(root, "integrations/demo/src/demo.tb"), "utf8");
    assert.match(source, /module integrations\.mcp\.demo/);
    assert.match(source, /tool GetWeather/);
    assert.match(source, /query is Text/);
    assert.match(source, /temperature is Float/);
    assert.match(source, /tool PostComment/);
    assert.match(source, /secrets DEMO_MCP_TOKEN, GITHUB_TOKEN/);

    const manifest = JSON.parse(readFileSync(join(root, "integrations/demo/touba.manifest.fragment.json"), "utf8"));
    assert.equal(manifest.binding_fragment_schema_version, "touba-binding-fragment-v1");
    assert.deepEqual(
      manifest.bindings["tool:integrations.mcp.demo/PostComment"].grants,
      ["network", "secret_read"],
    );
    assert.deepEqual(
      manifest.bindings["tool:integrations.mcp.demo/GetWeather"].secrets,
      ["DEMO_MCP_TOKEN"],
    );

    const bridgeConfig = JSON.parse(readFileSync(join(root, "integrations/demo/mcp.bridge.config.json"), "utf8"));
    assert.equal(bridgeConfig.mcp_bridge_config_version, "touba-mcp-bridge-config-v1");
    assert.equal(bridgeConfig.server.transport, "stdio");
    assert.equal(bridgeConfig.server.command, "");
    assert.deepEqual(bridgeConfig.server.env.GITHUB_TOKEN, { from_secret_handle: "GITHUB_TOKEN" });

    const handler = readFileSync(join(root, "integrations/demo/handlers/get-weather.mcp-bridge.mjs"), "utf8");
    assert.match(handler, /createMcpStdioToolBridge/);
    assert.match(handler, /mcp\.bridge\.config\.json/);

    const secretsTemplate = readFileSync(join(root, "integrations/demo/touba.secrets.template.json"), "utf8");
    assert.match(secretsTemplate, /DEMO_MCP_TOKEN/);
    assert.match(secretsTemplate, /GITHUB_TOKEN/);
    assert.equal(secretsTemplate.includes("secret-value"), false);

    const compileResult = spawnSync(process.execPath, [
      cliPath,
      "compile",
      join(root, "integrations/demo/src/demo.tb"),
      "--out",
      join(root, "integrations/demo/demo.air.json"),
    ], { encoding: "utf8" });
    assert.equal(compileResult.status, 0, compileResult.stderr);
    assert.equal(existsSync(join(root, "integrations/demo/demo.air.json")), true);

    const checked = importMcpTools({
      root,
      configPath,
      moduleName: "integrations.mcp.demo",
      out: "integrations/demo",
      mode: "check",
    });
    assert.equal(checked.status, "success");
  } finally {
    cleanup(root);
  }
});

test("mcp import reports unsupported schemas without writing in plan mode", () => {
  const root = tempRoot();
  try {
    const configPath = writeMcpConfig(root, {
      tools: [
        weatherTool(),
        {
          name: "stream_audio",
          description: "Unsupported audio stream",
          inputSchema: {
            type: "object",
            properties: {
              file: { type: "string" },
            },
          },
          outputSchema: {
            type: "object",
            properties: {
              audio: { type: "object" },
            },
          },
        },
      ],
    });

    const report = importMcpTools({
      root,
      configPath,
      moduleName: "integrations.mcp.demo",
      out: "integrations/demo",
    });
    assert.equal(report.status, "success");
    assert.equal(report.imported_tools.length, 1);
    assert.equal(report.refused_tools.length, 1);
    assert.equal(report.refused_tools[0].mcp_name, "stream_audio");
    assert.equal(report.diagnostics.some((item) => item.code === "McpToolNotMappable"), true);
  } finally {
    cleanup(root);
  }
});

test("mcp import validates package-safe server names", () => {
  const root = tempRoot();
  try {
    const configPath = writeMcpConfig(root, { server: { name: "Demo Server" } });
    assert.throws(
      () => importMcpTools({
        root,
        configPath,
        moduleName: "integrations.mcp.demo",
        out: "integrations/demo",
      }),
      /server\.name must use lowercase package-safe characters/,
    );
  } finally {
    cleanup(root);
  }
});

test("CLI mcp import writes JSON report and check detects drift", () => {
  const root = tempRoot();
  try {
    const configPath = writeMcpConfig(root, { tools: [weatherTool()] });
    const writeResult = spawnSync(process.execPath, [
      cliPath,
      "mcp",
      "import",
      configPath,
      "--root",
      root,
      "--module",
      "integrations.mcp.demo",
      "--out",
      "integrations/demo",
      "--mode",
      "write",
      "--json",
    ], { encoding: "utf8" });
    assert.equal(writeResult.status, 0, writeResult.stderr);
    const writeReport = JSON.parse(writeResult.stdout);
    assert.equal(writeReport.command, "mcp import");
    assert.equal(writeReport.imported_tools.length, 1);

    writeFileSync(join(root, "integrations/demo/src/demo.tb"), "module integrations.mcp.demo\n", "utf8");
    const checkResult = spawnSync(process.execPath, [
      cliPath,
      "mcp",
      "import",
      configPath,
      "--root",
      root,
      "--module",
      "integrations.mcp.demo",
      "--out",
      "integrations/demo",
      "--mode",
      "check",
      "--json",
    ], { encoding: "utf8" });
    assert.equal(checkResult.status, 1);
    const checkReport = JSON.parse(checkResult.stdout);
    assert.equal(checkReport.status, "error");
    assert.equal(checkReport.diagnostics.some((item) => item.code === "McpImportFileDrift"), true);
  } finally {
    cleanup(root);
  }
});

function writeMcpConfig(root, overrides = {}) {
  const config = {
    mcp_import_config_version: "touba-mcp-import-config-v1",
    server: {
      name: "demo",
      transport: "snapshot",
      secret_handles: ["DEMO_MCP_TOKEN"],
      timeout_ms: 5000,
      max_payload_bytes: 65536,
      ...(overrides.server ?? {}),
    },
    tools: overrides.tools ?? [weatherTool()],
  };
  const path = join(root, "mcp.demo.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

function weatherTool() {
  return {
    name: "get_weather",
    description: "Get weather for a city",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "City name" },
        days: { type: "integer" },
      },
      required: ["query"],
    },
    outputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        temperature: { type: "number" },
      },
      required: ["summary"],
    },
  };
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "touba-mcp-import-test-"));
}

function cleanup(path) {
  rmSync(path, { recursive: true, force: true });
}
