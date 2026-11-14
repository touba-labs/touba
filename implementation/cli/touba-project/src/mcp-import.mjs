import {
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { renderImportedField, renderJsonFieldAdapters } from "./import-field-adapters.mjs";
import { validateImportFiles, importedObjectSchemaError } from './import-files.mjs';

export const TOUBA_MCP_IMPORT_CONFIG_VERSION = "touba-mcp-import-config-v1";
export const TOUBA_MCP_IMPORT_REPORT_VERSION = "touba-mcp-import-report-v1";
export const TOUBA_BINDING_FRAGMENT_SCHEMA_VERSION = "touba-binding-fragment-v1";
export const TOUBA_SECRETS_VERSION = "touba-secrets-v1";
export const TOUBA_MCP_BRIDGE_CONFIG_VERSION = "touba-mcp-bridge-config-v1";

const MODULE_NAME_PATTERN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SERVER_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const SECRET_HANDLE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1048576;
const SUPPORTED_TRANSPORTS = new Set(["snapshot"]);

export function importMcpTools(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const mode = options.mode ?? "plan";
  if (!["plan", "write", "check"].includes(mode)) {
    throw new Error("--mode must be plan, write or check");
  }
  const configPath = options.configDocument === undefined ? resolve(root, requiredString(options.configPath, "config path")) : null;
  const outputRoot = resolve(root, requiredString(options.out, "out"));
  const moduleName = requiredString(options.moduleName, "module");
  assertModuleName(moduleName);
  assertInside(root, outputRoot, "out");

  if (options.configDocument !== undefined && mode !== 'plan') throw new Error('In-memory import is preview-only');
  const config = options.configDocument ?? readConfig(configPath);
  const generation = generateMcpImport({
    root,
    outputRoot,
    moduleName,
    config,
    selectedTools: options.selectedTools ?? [],
  });

  const diagnostics = [...generation.diagnostics];
  validateImportFiles(root, generation.files, { mode, force: options.force });
  const actions = generation.files.map((file) => fileAction(file, mode));

  if (mode === "write") {
    for (const file of generation.files) {
      writeGeneratedFile(file, options);
    }
  } else if (mode === "check") {
    for (const file of generation.files) {
      checkGeneratedFile(file, diagnostics);
    }
  }

  const status = diagnostics.some((diagnostic) => diagnostic.severity === "error") ? "error" : "success";
  return {
    report_schema_version: TOUBA_MCP_IMPORT_REPORT_VERSION,
    command: "mcp import",
    mode,
    status,
    root,
    config_path: configPath,
    server: generation.server,
    module_name: moduleName,
    output_root: outputRoot,
    imported_tools: generation.importedTools,
    refused_tools: generation.refusedTools,
    files: generation.files.map((file) => ({
      kind: file.kind,
      path: file.path,
      relative_path: relative(root, file.path),
      ...(options.includeContents === true ? { content: file.content } : {}),
    })),
    actions,
    diagnostics,
    notes: [
      "MCP import generates reviewable Touba artifacts; authority remains in manifest, secrets, approvals and runtime policy.",
      "This command consumes an explicit MCP tools snapshot config.",
      "Generated secret templates contain handles only, never values.",
    ],
  };
}

export function renderMcpImportReport(report) {
  const lines = [
    `Touba MCP import (${report.mode})`,
    `Status: ${report.status}`,
    `Server: ${report.server.name}`,
    `Module: ${report.module_name}`,
    `Output: ${report.output_root}`,
  ];
  if (report.imported_tools.length > 0) {
    lines.push("Imported tools:");
    for (const tool of report.imported_tools) {
      lines.push(`- ${tool.mcp_name} -> ${tool.tool_ref}`);
    }
  }
  if (report.refused_tools.length > 0) {
    lines.push("Refused tools:");
    for (const tool of report.refused_tools) {
      lines.push(`- ${tool.mcp_name}: ${tool.reason}`);
    }
  }
  if (report.actions.length > 0) {
    lines.push("Actions:");
    for (const action of report.actions) {
      lines.push(`- ${action.kind} ${action.path}`);
    }
  }
  if (report.diagnostics.length > 0) {
    lines.push("Diagnostics:");
    for (const diagnostic of report.diagnostics) {
      lines.push(`- ${diagnostic.severity} ${diagnostic.code}: ${diagnostic.message}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function generateMcpImport({ root, outputRoot, moduleName, config, selectedTools }) {
  const diagnostics = [];
  const server = validateConfig(config, diagnostics);
  const selected = new Set(selectedTools);
  const tools = [];
  const refusedTools = [];
  const usedTypeNames = new Set();
  const usedToolNames = new Set();

  for (const tool of config.tools ?? []) {
    if (selected.size > 0 && !selected.has(tool.name)) {
      continue;
    }
    const mapped = mapTool(tool, moduleName, server.secretHandles, usedTypeNames, usedToolNames);
    if (mapped.refusal) {
      refusedTools.push({
        mcp_name: typeof tool?.name === "string" ? tool.name : "<invalid>",
        reason: mapped.refusal,
      });
      diagnostics.push(warningDiagnostic("McpToolNotMappable", mapped.refusal, { tool: tool?.name ?? null }));
      continue;
    }
    tools.push(mapped.tool);
  }

  for (const selectedTool of selected) {
    if (!config.tools.some((tool) => tool.name === selectedTool)) {
      diagnostics.push(errorDiagnostic("McpToolSelectionMissing", `selected MCP tool ${selectedTool} is not present in config`, {
        tool: selectedTool,
      }));
    }
  }
  if (!tools.length) diagnostics.push(errorDiagnostic('McpNoMappableTools', 'No selected tool has a supported contract; no artifacts were generated'));

  const generatedFiles = buildFiles({
    root,
    outputRoot,
    moduleName,
    server,
    tools,
  });

  return {
    server,
    diagnostics,
    importedTools: tools.map((tool) => ({
      mcp_name: tool.mcpName,
      tool_name: tool.toolName,
      tool_ref: tool.toolRef,
      input_type: tool.inputTypeName,
      output_type: tool.outputTypeName,
      secret_handles: tool.secretHandles,
    })),
    refusedTools,
    files: diagnostics.some(item => item.severity === 'error') ? [] : generatedFiles,
  };
}

function readConfig(configPath) {
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new Error(`MCP import config does not exist: ${configPath}`);
  }
  if (statSync(configPath).size > 4 * 1024 * 1024) throw new Error('MCP import config exceeds 4 MiB');
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`MCP import config is not valid JSON: ${error.message}`);
  }
}

function validateConfig(config, diagnostics) {
  if (!isPlainObject(config)) {
    throw new Error("MCP import config must be a JSON object");
  }
  if (config.mcp_import_config_version !== TOUBA_MCP_IMPORT_CONFIG_VERSION) {
    throw new Error(`mcp_import_config_version must be ${TOUBA_MCP_IMPORT_CONFIG_VERSION}`);
  }
  if (!isPlainObject(config.server)) {
    throw new Error("MCP import config must contain server object");
  }
  const name = requiredString(config.server.name, "server.name");
  if (!SERVER_NAME_PATTERN.test(name)) {
    throw new Error("server.name must use lowercase package-safe characters: a-z, 0-9 and hyphen");
  }
  const transport = requiredString(config.server.transport, "server.transport");
  if (!SUPPORTED_TRANSPORTS.has(transport)) {
    throw new Error(`server.transport ${transport} is not supported by this V1 importer`);
  }
  if (!Array.isArray(config.tools)) {
    throw new Error("MCP import config must contain tools array");
  }
  const secrets = Array.isArray(config.server.secret_handles) ? config.server.secret_handles : [];
  for (const handle of secrets) {
    if (typeof handle !== "string" || !SECRET_HANDLE_PATTERN.test(handle)) {
      diagnostics.push(errorDiagnostic("McpSecretHandleInvalid", "server.secret_handles must contain uppercase Touba secret handles", {
        handle,
      }));
    }
  }
  return {
    name,
    transport,
    secretHandles: [...new Set(secrets)].sort(),
    timeoutMs: positiveIntegerOrDefault(config.server.timeout_ms, DEFAULT_TIMEOUT_MS),
    maxPayloadBytes: positiveIntegerOrDefault(config.server.max_payload_bytes, DEFAULT_MAX_PAYLOAD_BYTES),
  };
}

function mapTool(tool, moduleName, serverSecretHandles, usedTypeNames, usedToolNames) {
  if (!isPlainObject(tool)) {
    return { refusal: "MCP tool entry must be an object" };
  }
  if (typeof tool.name !== "string" || tool.name.trim() === "") {
    return { refusal: "MCP tool name must be a non-empty string" };
  }
  const toolBase = pascalCase(tool.name);
  if (!IDENTIFIER_PATTERN.test(toolBase)) {
    return { refusal: `MCP tool ${tool.name} cannot produce a Touba identifier` };
  }
  const toolName = uniqueName(toolBase, usedToolNames);
  const inputTypeName = uniqueName(`${toolName}Request`, usedTypeNames);
  const outputTypeName = uniqueName(`${toolName}Result`, usedTypeNames);
  const inputFields = schemaObjectFields(tool.inputSchema, "inputSchema");
  if (inputFields.refusal) {
    return { refusal: `${tool.name}: ${inputFields.refusal}` };
  }
  const outputFields = tool.outputSchema === undefined
    ? { fields: [{ name: "content", originalName: "content", type: "Text", required: true }], fallback: true }
    : schemaObjectFields(tool.outputSchema, "outputSchema");
  if (outputFields.refusal) {
    return { refusal: `${tool.name}: ${outputFields.refusal}` };
  }
  const toolSecretHandles = Array.isArray(tool.secret_handles)
    ? [...new Set(tool.secret_handles)].sort()
    : [];
  for (const handle of toolSecretHandles) {
    if (typeof handle !== "string" || !SECRET_HANDLE_PATTERN.test(handle)) {
      return { refusal: `${tool.name}: secret_handles must contain uppercase Touba secret handles` };
    }
  }
  const secretHandles = [...new Set([...serverSecretHandles, ...toolSecretHandles])].sort();
  return {
    tool: {
      mcpName: tool.name,
      description: typeof tool.description === "string" ? tool.description : "",
      toolName,
      toolRef: `tool:${moduleName}/${toolName}`,
      inputTypeName,
      outputTypeName,
      inputFields: inputFields.fields,
      outputFields: outputFields.fields,
      outputFallback: outputFields.fallback === true,
      secretHandles,
    },
  };
}

function schemaObjectFields(schema, label) {
  if (!isPlainObject(schema)) {
    return { refusal: `${label} must be a JSON Schema object` };
  }
  if (schema.type !== "object") {
    return { refusal: `${label}.type must be object` };
  }
  if (!isPlainObject(schema.properties)) {
    return { refusal: `${label}.properties must be an object` };
  }
  const objectError = importedObjectSchemaError(schema, label);
  if (objectError) return { refusal: objectError };
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const fields = [];
  for (const [rawName, property] of Object.entries(schema.properties)) {
    const name = snakeCase(rawName);
    if (!/^[a-z_][a-z0-9_]*$/u.test(name)) {
      return { refusal: `${label}.${rawName} cannot produce a Touba field name` };
    }
    if (fields.some(field => field.name === name)) {
      return { refusal: `${label}.${rawName} collides with another field after name conversion` };
    }
    const type = mapJsonSchemaType(property);
    if (type === null) {
      return { refusal: `${label}.${rawName} uses an unsupported schema shape` };
    }
    fields.push({
      name,
      originalName: rawName,
      type,
      required: required.has(rawName),
      description: isPlainObject(property) && typeof property.description === "string" ? property.description : "",
    });
  }
  if (fields.length === 0) {
    return { refusal: `${label}.properties must contain at least one field` };
  }
  return { fields };
}

function mapJsonSchemaType(property) {
  if (!isPlainObject(property)) {
    return null;
  }
  if (Array.isArray(property.type)) {
    return null;
  }
  if (Object.keys(property).some(key => !["type", "items", "description", "title", "$comment", "examples"].includes(key))) return null;
  if (property.type === "string") {
    return "Text";
  }
  if (property.type === "boolean") {
    return "Boolean";
  }
  if (property.type === "integer") {
    return "Int";
  }
  if (property.type === "number") {
    return "Float";
  }
  if (property.type === "array" && isPlainObject(property.items)) {
    const itemType = mapJsonSchemaType(property.items);
    return itemType === null ? null : `List of ${itemType}`;
  }
  return null;
}

function buildFiles({ root, outputRoot, moduleName, server, tools }) {
  const sourcePath = join(outputRoot, "src", `${moduleName.split(".").at(-1)}.tb`);
  const manifestPath = join(outputRoot, "touba.manifest.fragment.json");
  const bridgeConfigPath = join(outputRoot, "mcp.bridge.config.json");
  const secretsPath = join(outputRoot, "touba.secrets.template.json");
  const reportPath = join(outputRoot, "mcp-import-report.json");
  const readmePath = join(outputRoot, "README.md");
  const handlerFiles = tools.map((tool) => ({
    kind: "handler_bridge",
    path: join(outputRoot, "handlers", `${snakeCase(tool.toolName).replaceAll("_", "-")}.mcp-bridge.mjs`),
    content: renderHandlerBridge(server, tool),
  }));
  const report = {
    report_schema_version: TOUBA_MCP_IMPORT_REPORT_VERSION,
    server,
    module_name: moduleName,
    generated_files: [
      relative(root, sourcePath),
      relative(root, manifestPath),
      relative(root, bridgeConfigPath),
      ...handlerFiles.map((file) => relative(root, file.path)),
      relative(root, secretsPath),
      relative(root, readmePath),
    ],
    imported_tools: tools.map((tool) => ({
      mcp_name: tool.mcpName,
      tool_ref: tool.toolRef,
      input_type: tool.inputTypeName,
      output_type: tool.outputTypeName,
      secret_handles: tool.secretHandles,
    })),
  };
  return [
    { kind: "source", path: sourcePath, content: renderToubaSource(moduleName, tools) },
    { kind: "binding_fragment", path: manifestPath, content: renderManifestFragment(server, tools, handlerFiles, root, moduleName) },
    { kind: "mcp_bridge_config", path: bridgeConfigPath, content: renderMcpBridgeConfig(server, tools) },
    ...handlerFiles,
    { kind: "secrets_template", path: secretsPath, content: renderSecretsTemplate(server, tools) },
    { kind: "import_report", path: reportPath, content: `${JSON.stringify(report, null, 2)}\n` },
    { kind: "readme", path: readmePath, content: renderReadme(server, moduleName, tools) },
  ];
}

function renderToubaSource(moduleName, tools) {
  const lines = [
    `module ${moduleName}`,
    "",
  ];
  for (const tool of tools) {
    lines.push(`type ${tool.inputTypeName}`);
    for (const field of tool.inputFields) {
      lines.push(renderImportedField(field));
    }
    lines.push("");
    lines.push(`type ${tool.outputTypeName}`);
    for (const field of tool.outputFields) {
      lines.push(renderImportedField(field));
    }
    lines.push("");
    lines.push(`tool ${tool.toolName}`);
    lines.push(`    takes request as ${tool.inputTypeName}`);
    lines.push(`    gives ${tool.outputTypeName}`);
    lines.push("    requires network");
    if (tool.secretHandles.length > 0) {
      lines.push("    requires secret_read");
      lines.push(`    secrets ${tool.secretHandles.join(", ")}`);
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/u, "\n");
}

function renderManifestFragment(server, tools, handlerFiles, root, moduleName) {
  const bindings = {};
  for (const [index, tool] of tools.entries()) {
    bindings[tool.toolRef] = {
      handler: {
        kind: "process",
        command: "node",
        args: [relative(root, handlerFiles[index].path)],
        cwd: ".",
      },
      grants: tool.secretHandles.length > 0 ? ["network", "secret_read"] : ["network"],
      secrets: tool.secretHandles,
      effect_contract: { kind: "external_write", retry_mode: "none" },
      timeout_ms: server.timeoutMs,
      max_payload_bytes: server.maxPayloadBytes,
    };
  }
  return `${JSON.stringify({
    fragment_schema_version: TOUBA_BINDING_FRAGMENT_SCHEMA_VERSION,
    source: { kind: "module", module: moduleName },
    bindings,
  }, null, 2)}\n`;
}

function renderHandlerBridge(server, tool) {
  return `import {
  ToubaHandlerError,
  createMcpStdioToolBridge,
  defineTool,
} from "@touba/sdk";

const MCP_TOOL_NAME = ${JSON.stringify(tool.mcpName)};
const MCP_BRIDGE_CONFIG = new URL("../mcp.bridge.config.json", import.meta.url);
const callMcp = createMcpStdioToolBridge({ mcpToolName: MCP_TOOL_NAME, configPath: MCP_BRIDGE_CONFIG });

${renderJsonFieldAdapters(tool)}

await defineTool({
  toolRef: ${JSON.stringify(tool.toolRef)},
  inputSignature: [{ name: "request", type_ref: ${JSON.stringify(`type:${tool.toolRef.slice("tool:".length).split("/")[0]}/${tool.inputTypeName}`)} }],
  outputType: ${JSON.stringify(`type:${tool.toolRef.slice("tool:".length).split("/")[0]}/${tool.outputTypeName}`)},
  requiredGrants: ${JSON.stringify(tool.secretHandles.length > 0 ? ["network", "secret_read"] : ["network"])},
  requiredSecretHandles: ${JSON.stringify(tool.secretHandles)},
  run: async ({ request, context }) => fromJsonResult(await callMcp({ request: toJsonRequest(request), context })),
});
`;
}

function renderMcpBridgeConfig(server, tools) {
  const env = {};
  for (const handle of [...new Set(tools.flatMap((tool) => tool.secretHandles))].sort()) {
    env[handle] = {
      from_secret_handle: handle,
    };
  }
  return `${JSON.stringify({
    mcp_bridge_config_version: TOUBA_MCP_BRIDGE_CONFIG_VERSION,
    server: {
      transport: "stdio",
      command: "",
      args: [],
      timeout_ms: server.timeoutMs,
      max_payload_bytes: server.maxPayloadBytes,
      max_text_content_length: server.maxPayloadBytes,
      env,
    },
  }, null, 2)}\n`;
}

function renderSecretsTemplate(server, tools) {
  const handles = [...new Set([
    ...server.secretHandles,
    ...tools.flatMap((tool) => tool.secretHandles),
  ])].sort();
  const secrets = {};
  for (const handle of handles) {
    secrets[handle] = {
      source: "env",
      env: handle,
      status: "active",
    };
  }
  return `${JSON.stringify({
    secrets_schema_version: TOUBA_SECRETS_VERSION,
    secrets,
  }, null, 2)}\n`;
}

function renderReadme(server, moduleName, tools) {
  return `# ${server.name} MCP Import

Generated Touba contracts for an MCP tools snapshot.

Module: \`${moduleName}\`

## Handler runtime

These handlers use JavaScript, including in a Python project. Install a Node.js
version supported by Touba and the matching \`@touba/sdk\` before execution.
Reading this snapshot, generation and preparation never start the MCP server.

## Imported Tools

${tools.map((tool) => `- \`${tool.mcpName}\` -> \`${tool.toolRef}\``).join("\n")}

## Review Required

- Review the generated Touba source before importing it into an agent.
- Review grants and secret handles in \`touba.manifest.fragment.json\`.
- Configure \`mcp.bridge.config.json\` with an approved stdio MCP server before execution.
- Keep secrets as handles only; never commit secret values.
- Run with \`--trace-out\` when validating the integration.
`;
}

function fileAction(file, mode) {
  return {
    kind: mode === "write" ? (existsSync(file.path) ? "overwrite" : "create") : mode,
    path: file.path,
  };
}

function writeGeneratedFile(file, options) {
  if (existsSync(file.path) && options.force !== true) {
    const current = readFileSync(file.path, "utf8");
    if (current !== file.content) {
      throw new Error(`refusing to overwrite generated file without --force: ${file.path}`);
    }
  }
  mkdirSync(dirname(file.path), { recursive: true });
  writeFileSync(file.path, file.content, "utf8");
}

function checkGeneratedFile(file, diagnostics) {
  if (!existsSync(file.path)) {
    diagnostics.push(errorDiagnostic("McpImportFileMissing", `generated file is missing: ${file.path}`, {
      path: file.path,
    }));
    return;
  }
  const current = readFileSync(file.path, "utf8");
  if (current !== file.content) {
    diagnostics.push(errorDiagnostic("McpImportFileDrift", `generated file differs from expected content: ${file.path}`, {
      path: file.path,
    }));
  }
}

function pascalCase(value) {
  return value
    .replace(/[^A-Za-z0-9]+/gu, " ")
    .trim()
    .split(/\s+/u)
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join("");
}

function snakeCase(value) {
  return value
    .replace(/([a-z0-9])([A-Z])/gu, "$1_$2")
    .replace(/[^A-Za-z0-9]+/gu, "_")
    .replace(/^_+|_+$/gu, "")
    .toLowerCase();
}

function uniqueName(base, used) {
  let candidate = base;
  let index = 2;
  while (used.has(candidate)) {
    candidate = `${base}${index}`;
    index += 1;
  }
  used.add(candidate);
  return candidate;
}

function requiredString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value;
}

function positiveIntegerOrDefault(value, fallback) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("timeout and payload limits must be positive integers");
  }
  return value;
}

function assertModuleName(moduleName) {
  if (!MODULE_NAME_PATTERN.test(moduleName)) {
    throw new Error("--module must be a lowercase dotted Touba module name");
  }
}

function assertInside(root, target, label) {
  if (isAbsolute(relative(root, target)) || relative(root, target).startsWith("..")) {
    throw new Error(`--${label} must stay inside project root`);
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function warningDiagnostic(code, message, details = {}) {
  return { severity: "warning", code, message, details };
}

function errorDiagnostic(code, message, details = {}) {
  return { severity: "error", code, message, details };
}
