import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import assert from "node:assert/strict";
import test from "node:test";

import { scaffoldRestTool } from "../src/rest-scaffold.mjs";

const cliPath = new URL("../src/main.mjs", import.meta.url).pathname;

test("rest scaffold plans and writes governed Touba artifacts from explicit operation config", () => {
  const root = tempRoot();
  try {
    const configPath = writeRestConfig(root);
    const plan = scaffoldRestTool({
      root,
      configPath,
      moduleName: "integrations.rest.search",
      out: "integrations/search",
    });
    assert.equal(plan.status, "success");
    assert.equal(plan.mode, "plan");
    assert.equal(plan.generated_tool.tool_ref, "tool:integrations.rest.search/SearchWeb");
    assert.equal(existsSync(join(root, "integrations/search/src/search.tb")), false);

    const written = scaffoldRestTool({
      root,
      configPath,
      moduleName: "integrations.rest.search",
      out: "integrations/search",
      mode: "write",
    });
    assert.equal(written.status, "success");
    assert.equal(existsSync(join(root, "integrations/search/src/search.tb")), true);
    assert.equal(existsSync(join(root, "integrations/search/touba.manifest.fragment.json")), true);
    assert.equal(existsSync(join(root, "integrations/search/rest.handler.config.json")), true);
    assert.equal(existsSync(join(root, "integrations/search/handlers/search-web.rest-handler.mjs")), true);

    const source = readFileSync(join(root, "integrations/search/src/search.tb"), "utf8");
    assert.match(source, /module integrations\.rest\.search/);
    assert.match(source, /type SearchWebRequest/);
    assert.match(source, /query is Text/);
    assert.match(source, /max_results is Optional of Int default none\(Int\)/);
    assert.match(source, /tool SearchWeb/);
    assert.match(source, /requires network, secret_read/);
    assert.match(source, /secrets SEARCH_API_KEY/);

    const manifest = JSON.parse(readFileSync(join(root, "integrations/search/touba.manifest.fragment.json"), "utf8"));
    assert.deepEqual(
      manifest.bindings["tool:integrations.rest.search/SearchWeb"].grants,
      ["network", "secret_read"],
    );
    assert.deepEqual(
      manifest.bindings["tool:integrations.rest.search/SearchWeb"].secrets,
      ["SEARCH_API_KEY"],
    );

    const handlerConfig = JSON.parse(readFileSync(join(root, "integrations/search/rest.handler.config.json"), "utf8"));
    assert.equal(handlerConfig.rest_handler_config_version, "touba-rest-handler-config-v1");
    assert.equal(handlerConfig.operation.method, "GET");
    assert.equal(handlerConfig.operation.body_mode, "query");
    assert.deepEqual(handlerConfig.operation.auth, {
      type: "bearer",
      secret_handle: "SEARCH_API_KEY",
    });

    const handler = readFileSync(join(root, "integrations/search/handlers/search-web.rest-handler.mjs"), "utf8");
    assert.match(handler, /defineTool/);
    assert.match(handler, /rest\.handler\.config\.json/);
    assert.equal(handler.includes("secret-value"), false);

    const secretsTemplate = readFileSync(join(root, "integrations/search/touba.secrets.template.json"), "utf8");
    assert.match(secretsTemplate, /SEARCH_API_KEY/);
    assert.equal(secretsTemplate.includes("secret-value"), false);

    const compileResult = spawnSync(process.execPath, [
      cliPath,
      "compile",
      join(root, "integrations/search/src/search.tb"),
      "--out",
      join(root, "integrations/search/search.air.json"),
    ], { encoding: "utf8" });
    assert.equal(compileResult.status, 0, compileResult.stderr);

    const checked = scaffoldRestTool({
      root,
      configPath,
      moduleName: "integrations.rest.search",
      out: "integrations/search",
      mode: "check",
    });
    assert.equal(checked.status, "success");
  } finally {
    cleanup(root);
  }
});

test("rest scaffold maps a simple OpenAPI operationId", () => {
  const root = tempRoot();
  try {
    const configPath = writeOpenApiConfig(root);
    const report = scaffoldRestTool({
      root,
      configPath,
      moduleName: "integrations.rest.weather",
      out: "integrations/weather",
    });
    assert.equal(report.status, "success");
    assert.equal(report.operation.source, "openapi");
    assert.equal(report.generated_tool.tool_ref, "tool:integrations.rest.weather/GetForecast");
    assert.equal(report.generated_tool.secret_handles.length, 0);
  } finally {
    cleanup(root);
  }
});

test("rest scaffold refuses unsupported schema shapes without writing files", () => {
  const root = tempRoot();
  try {
    const configPath = writeRestConfig(root, {
      operation: {
        inputSchema: {
          type: "object",
          properties: {
            nested: {
              type: "object",
              additionalProperties: true,
              properties: {
                value: { type: "string" },
              },
            },
          },
        },
      },
    });
    const report = scaffoldRestTool({
      root,
      configPath,
      moduleName: "integrations.rest.bad",
      out: "integrations/bad",
    });
    assert.equal(report.status, "error");
    assert.equal(report.refused_operation.reason.includes("unsupported schema shape"), true);
    assert.equal(report.files.length, 0);
    assert.equal(existsSync(join(root, "integrations/bad/src/bad.tb")), false);
  } finally {
    cleanup(root);
  }
});

test("rest scaffold blocks invalid secret handles before writing files", () => {
  const root = tempRoot();
  try {
    const configPath = writeRestConfig(root, {
      service: {
        secret_handles: ["not-valid"],
      },
    });
    const report = scaffoldRestTool({
      root,
      configPath,
      moduleName: "integrations.rest.badsecret",
      out: "integrations/badsecret",
      mode: "write",
    });
    assert.equal(report.status, "error");
    assert.equal(report.generated_tool, null);
    assert.equal(report.files.length, 0);
    assert.equal(report.diagnostics.some((item) => item.code === "RestSecretHandleInvalid"), true);
    assert.equal(existsSync(join(root, "integrations/badsecret/src/badsecret.tb")), false);
  } finally {
    cleanup(root);
  }
});

test("CLI rest scaffold writes JSON report and check detects drift", () => {
  const root = tempRoot();
  try {
    const configPath = writeRestConfig(root);
    const writeResult = spawnSync(process.execPath, [
      cliPath,
      "rest",
      "scaffold",
      configPath,
      "--root",
      root,
      "--module",
      "integrations.rest.search",
      "--out",
      "integrations/search",
      "--mode",
      "write",
      "--json",
    ], { encoding: "utf8" });
    assert.equal(writeResult.status, 0, writeResult.stderr);
    const writeReport = JSON.parse(writeResult.stdout);
    assert.equal(writeReport.command, "rest scaffold");
    assert.equal(writeReport.generated_tool.tool_ref, "tool:integrations.rest.search/SearchWeb");

    writeFileSync(join(root, "integrations/search/src/search.tb"), "module integrations.rest.search\n", "utf8");
    const checkResult = spawnSync(process.execPath, [
      cliPath,
      "rest",
      "scaffold",
      configPath,
      "--root",
      root,
      "--module",
      "integrations.rest.search",
      "--out",
      "integrations/search",
      "--mode",
      "check",
      "--json",
    ], { encoding: "utf8" });
    assert.equal(checkResult.status, 1);
    const checkReport = JSON.parse(checkResult.stdout);
    assert.equal(checkReport.status, "error");
    assert.equal(checkReport.diagnostics.some((item) => item.code === "RestScaffoldFileDrift"), true);
  } finally {
    cleanup(root);
  }
});

function writeRestConfig(root, overrides = {}) {
  const config = {
    rest_scaffold_config_version: "touba-rest-scaffold-config-v1",
    service: {
      name: "search",
      base_url: "https://api.example.test",
      secret_handles: ["SEARCH_API_KEY"],
      timeout_ms: 5000,
      max_payload_bytes: 65536,
      ...(overrides.service ?? {}),
    },
    operation: {
      name: "search_web",
      method: "GET",
      path: "/v1/search",
      description: "Search the web through a governed API",
      inputSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          maxResults: { type: "integer" },
        },
        required: ["query"],
      },
      outputSchema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          sourceCount: { type: "integer" },
        },
        required: ["summary"],
      },
      ...(overrides.operation ?? {}),
    },
  };
  const path = join(root, "rest.search.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

function writeOpenApiConfig(root) {
  const config = {
    rest_scaffold_config_version: "touba-rest-scaffold-config-v1",
    service: {
      name: "weather",
      base_url: "https://weather.example.test",
      timeout_ms: 5000,
      max_payload_bytes: 65536,
    },
    operation_id: "get_forecast",
    openapi: {
      openapi: "3.1.0",
      paths: {
        "/forecast": {
          get: {
            operationId: "get_forecast",
            summary: "Get a forecast",
            parameters: [
              {
                name: "city",
                in: "query",
                required: true,
                schema: { type: "string" },
              },
              {
                name: "days",
                in: "query",
                schema: { type: "integer" },
              },
            ],
            responses: {
              "200": {
                content: {
                  "application/json": {
                    schema: {
                      type: "object",
                      properties: {
                        summary: { type: "string" },
                        temperature: { type: "number" },
                      },
                      required: ["summary"],
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  };
  const path = join(root, "openapi.weather.json");
  writeFileSync(path, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  return path;
}

function tempRoot() {
  return mkdtempSync(join(tmpdir(), "touba-rest-scaffold-"));
}

function cleanup(root) {
  rmSync(root, { recursive: true, force: true });
}
