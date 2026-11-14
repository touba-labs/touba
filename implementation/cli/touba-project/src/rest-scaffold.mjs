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

export const TOUBA_REST_SCAFFOLD_CONFIG_VERSION = "touba-rest-scaffold-config-v1";
export const TOUBA_REST_SCAFFOLD_REPORT_VERSION = "touba-rest-scaffold-report-v1";
export const TOUBA_REST_HANDLER_CONFIG_VERSION = "touba-rest-handler-config-v1";
export const TOUBA_BINDING_FRAGMENT_SCHEMA_VERSION = "touba-binding-fragment-v1";
export const TOUBA_SECRETS_VERSION = "touba-secrets-v1";

const MODULE_NAME_PATTERN = /^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)+$/;
const IDENTIFIER_PATTERN = /^[A-Za-z][A-Za-z0-9_]*$/;
const SERVICE_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;
const SECRET_HANDLE_PATTERN = /^[A-Z][A-Z0-9_]*$/;
const SUPPORTED_METHODS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE"]);
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1048576;

export function scaffoldRestTool(options = {}) {
  const root = resolve(options.root ?? process.cwd());
  const mode = options.mode ?? "plan";
  if (!["plan", "write", "check"].includes(mode)) {
    throw new Error("--mode must be plan, write or check");
  }
  const configPath = resolve(root, requiredString(options.configPath, "config path"));
  const outputRoot = resolve(root, requiredString(options.out, "out"));
  const moduleName = requiredString(options.moduleName, "module");
  assertModuleName(moduleName);
  assertInside(root, outputRoot, "out");

  const config = readConfig(configPath);
  const selectedIds = config.operation_ids;
  if (selectedIds !== undefined && (!Array.isArray(selectedIds) || !selectedIds.length || selectedIds.length > 64
    || selectedIds.some(id => typeof id !== 'string' || !id.trim()) || new Set(selectedIds).size !== selectedIds.length
    || config.operation_id !== undefined || config.operation !== undefined || !isPlainObject(config.openapi))) {
    throw new Error('operation_ids must select 1 to 64 distinct OpenAPI operations, without operation or operation_id');
  }
  const generations = (selectedIds ?? [null]).map(id => generateRestScaffold({ root, outputRoot, moduleName,
    config: id === null ? config : { ...config, operation_id: id } }));
  const generation = generations[0];
  const tools = generations.flatMap(item => item.tool ? [item.tool] : []);
  const names = tools.flatMap(tool => [tool.toolName, tool.inputTypeName, tool.outputTypeName]);
  if (new Set(names).size !== names.length) throw new Error('selected operations produce colliding Touba names; rename the operations explicitly');
  const generationErrors = generations.flatMap(item => item.diagnostics);
  generation.files = generationErrors.some(item => item.severity === 'error') ? []
    : buildFiles({ root, outputRoot, moduleName, service: generation.service, tools });

  const diagnostics = [...generationErrors];
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
    report_schema_version: TOUBA_REST_SCAFFOLD_REPORT_VERSION,
    command: "rest scaffold",
    mode,
    status,
    root,
    config_path: configPath,
    service: generation.service,
    module_name: moduleName,
    output_root: outputRoot,
    operation: generation.operationSummary,
    operations: generations.map(item => item.operationSummary),
    generated_tools: tools.map(tool => ({ operation_name: tool.operationName, tool_ref: tool.toolRef,
      input_type: tool.inputTypeName, output_type: tool.outputTypeName, secret_handles: tool.secretHandles })),
    generated_tool: generation.tool === null ? null : {
      operation_name: generation.tool.operationName,
      tool_name: generation.tool.toolName,
      tool_ref: generation.tool.toolRef,
      input_type: generation.tool.inputTypeName,
      output_type: generation.tool.outputTypeName,
      secret_handles: generation.tool.secretHandles,
    },
    refused_operation: generation.refusedOperation,
    files: generation.files.map((file) => ({
      kind: file.kind,
      path: file.path,
      relative_path: relative(root, file.path),
    })),
    actions,
    diagnostics,
    notes: [
      "REST scaffold generates reviewable Touba artifacts; authority remains in manifest, secrets, approvals and runtime policy.",
      "Generated handlers are minimal HTTP adapters and must be reviewed before live use.",
      "Generated secret templates contain handles only, never values.",
    ],
  };
}

export function renderRestScaffoldReport(report) {
  const lines = [
    `Touba REST scaffold (${report.mode})`,
    `Status: ${report.status}`,
    `Service: ${report.service.name}`,
    `Module: ${report.module_name}`,
    `Output: ${report.output_root}`,
  ];
  if (report.generated_tools?.length) {
    lines.push("Generated tools:");
    for (const tool of report.generated_tools) lines.push(`- ${tool.operation_name} -> ${tool.tool_ref}`);
  }
  if (report.refused_operation !== null) {
    lines.push("Refused operation:");
    lines.push(`- ${report.refused_operation.reason}`);
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

function generateRestScaffold({ root, outputRoot, moduleName, config }) {
  const diagnostics = [];
  const service = validateConfig(config, diagnostics);
  const normalizedOperation = normalizeOperationConfig(config, diagnostics);
  const operationSummary = normalizedOperation.summary;
  const mapped = mapOperation(normalizedOperation.operation, moduleName, service);
  const refusedOperation = mapped.refusal === null ? null : {
    operation_name: normalizedOperation.operation?.name ?? normalizedOperation.operation?.operationId ?? "<invalid>",
    reason: mapped.refusal,
  };
  if (mapped.refusal !== null) {
    diagnostics.push(errorDiagnostic("RestOperationNotMappable", mapped.refusal, {
      operation: refusedOperation.operation_name,
    }));
  }
  const hasBlockingDiagnostic = diagnostics.some((diagnostic) => diagnostic.severity === "error");

  const files = mapped.tool === null || hasBlockingDiagnostic
    ? []
    : buildFiles({
      root,
      outputRoot,
      moduleName,
      service,
      tools: [mapped.tool],
    });

  return {
    service,
    diagnostics,
    operationSummary,
    tool: hasBlockingDiagnostic ? null : mapped.tool,
    refusedOperation,
    files,
  };
}

function readConfig(configPath) {
  if (!existsSync(configPath) || !statSync(configPath).isFile()) {
    throw new Error(`REST scaffold config does not exist: ${configPath}`);
  }
  if (statSync(configPath).size > 4 * 1024 * 1024) throw new Error('REST scaffold config exceeds 4 MiB');
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch (error) {
    throw new Error(`REST scaffold config is not valid JSON: ${error.message}`);
  }
}

function validateConfig(config, diagnostics) {
  if (!isPlainObject(config)) {
    throw new Error("REST scaffold config must be a JSON object");
  }
  if (config.rest_scaffold_config_version !== TOUBA_REST_SCAFFOLD_CONFIG_VERSION) {
    throw new Error(`rest_scaffold_config_version must be ${TOUBA_REST_SCAFFOLD_CONFIG_VERSION}`);
  }
  if (!isPlainObject(config.service)) {
    throw new Error("REST scaffold config must contain service object");
  }
  const name = requiredString(config.service.name, "service.name");
  if (!SERVICE_NAME_PATTERN.test(name)) {
    throw new Error("service.name must use lowercase package-safe characters: a-z, 0-9 and hyphen");
  }
  const baseUrl = requiredString(config.service.base_url, "service.base_url");
  try {
    const url = new URL(baseUrl);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
  } catch {
    throw new Error("service.base_url must be an HTTP(S) URL without credentials, query or fragment");
  }
  const secrets = Array.isArray(config.service.secret_handles) ? config.service.secret_handles : [];
  for (const handle of secrets) {
    if (typeof handle !== "string" || !SECRET_HANDLE_PATTERN.test(handle)) {
      diagnostics.push(errorDiagnostic("RestSecretHandleInvalid", "service.secret_handles must contain uppercase Touba secret handles", {
        handle,
      }));
    }
  }
  return {
    name,
    baseUrl,
    secretHandles: [...new Set(secrets)].sort(),
    timeoutMs: positiveIntegerOrDefault(config.service.timeout_ms, DEFAULT_TIMEOUT_MS),
    maxPayloadBytes: positiveIntegerOrDefault(config.service.max_payload_bytes, DEFAULT_MAX_PAYLOAD_BYTES),
  };
}

function normalizeOperationConfig(config) {
  if (isPlainObject(config.operation)) {
    return {
      summary: {
        source: "operation",
        operation_id: config.operation.operationId ?? config.operation.name ?? null,
      },
      operation: config.operation,
    };
  }
  if (isPlainObject(config.openapi)) {
    const operationId = requiredString(config.operation_id, "operation_id");
    const operation = operationFromOpenApi(config.openapi, operationId);
    if (operation === null) {
      throw new Error(`operation_id ${operationId} was not found in OpenAPI document`);
    }
    return {
      summary: {
        source: "openapi",
        operation_id: operationId,
        method: operation.method,
        path: operation.path,
      },
      operation,
    };
  }
  throw new Error("REST scaffold config must contain operation or openapi + operation_id");
}

function operationFromOpenApi(openapi, operationId) {
  if (!isPlainObject(openapi.paths)) {
    throw new Error("openapi.paths must be an object");
  }
  const matches = [];
  for (const [path, pathItem] of Object.entries(openapi.paths)) {
    if (!isPlainObject(pathItem)) {
      continue;
    }
    for (const [rawMethod, operation] of Object.entries(pathItem)) {
      const method = rawMethod.toUpperCase();
      if (!SUPPORTED_METHODS.has(method) || !isPlainObject(operation)) {
        continue;
      }
      if (operation.operationId !== operationId) {
        continue;
      }
      if (pathItem.$ref || pathItem.parameters?.length || operation.$ref) throw new Error('OpenAPI references and path-level parameters require explicit resolution before import');
      const parameters = operation.parameters ?? [];
      if (!Array.isArray(parameters) || parameters.some(p => !isPlainObject(p) || p.$ref || p.in !== 'query' || p.style || p.explode !== undefined
        || !isPlainObject(p.schema) || ['array', 'object'].includes(p.schema.type))
        || new Set(parameters.map(p => p.name)).size !== parameters.length
        || (parameters.length && (operation.requestBody || !['GET', 'DELETE'].includes(method)))) {
        throw new Error('OpenAPI parameters require explicit scalar query mappings on GET/DELETE; mixed body, path, header and serialization mappings are not supported');
      }
      if (operation.requestBody?.$ref || Object.values(operation.responses ?? {}).some(response => response?.$ref)) throw new Error('OpenAPI references require explicit resolution before import');
      matches.push({
        name: operation.operationId,
        operationId: operation.operationId,
        description: operation.summary ?? operation.description ?? "",
        method,
        path,
        secret_handles: operation["x-touba-secret-handles"],
        inputSchema: inputSchemaFromOpenApiOperation(operation),
        outputSchema: outputSchemaFromOpenApiOperation(operation),
      });
    }
  }
  if (matches.length > 1) throw new Error(`operation_id ${operationId} is ambiguous in OpenAPI document`);
  return matches[0] ?? null;
}

function inputSchemaFromOpenApiOperation(operation) {
  const requestBodySchema = operation.requestBody?.content?.["application/json"]?.schema;
  if (isPlainObject(requestBodySchema)) {
    return requestBodySchema;
  }
  const properties = {};
  const required = [];
  for (const parameter of Array.isArray(operation.parameters) ? operation.parameters : []) {
    if (!isPlainObject(parameter) || typeof parameter.name !== "string") {
      continue;
    }
    properties[parameter.name] = isPlainObject(parameter.schema) ? parameter.schema : { type: "string" };
    if (parameter.required === true) {
      required.push(parameter.name);
    }
  }
  return {
    type: "object",
    properties,
    required,
  };
}

function outputSchemaFromOpenApiOperation(operation) {
  const responses = isPlainObject(operation.responses) ? operation.responses : {};
  for (const code of ["200", "201", "202", "default"]) {
    const schema = responses[code]?.content?.["application/json"]?.schema;
    if (isPlainObject(schema)) {
      return schema;
    }
  }
  return {
    type: "object",
    properties: {
      content: { type: "string" },
    },
    required: ["content"],
  };
}

function mapOperation(operation, moduleName, service) {
  if (!isPlainObject(operation)) {
    return { tool: null, refusal: "operation must be an object" };
  }
  const operationName = requiredOperationName(operation);
  if (operationName === null) {
    return { tool: null, refusal: "operation.name or operation.operationId must be a non-empty string" };
  }
  const method = typeof operation.method === "string" ? operation.method.toUpperCase() : "";
  if (!SUPPORTED_METHODS.has(method)) {
    return { tool: null, refusal: `${operationName}: method must be one of ${[...SUPPORTED_METHODS].join(", ")}` };
  }
  if (typeof operation.path !== "string" || !operation.path.startsWith("/")) {
    return { tool: null, refusal: `${operationName}: path must start with /` };
  }
  const target = new URL(operation.path, service.baseUrl);
  if (target.origin !== new URL(service.baseUrl).origin || target.search || target.hash || /[{}\\\\\s]/u.test(operation.path)) {
    return { tool: null, refusal: `${operationName}: path must stay on the configured service without unresolved parameters` };
  }
  const toolName = pascalCase(operationName);
  if (!IDENTIFIER_PATTERN.test(toolName)) {
    return { tool: null, refusal: `${operationName}: cannot produce a Touba tool identifier` };
  }
  const inputFields = schemaObjectFields(operation.inputSchema, "inputSchema");
  if (inputFields.refusal) {
    return { tool: null, refusal: `${operationName}: ${inputFields.refusal}` };
  }
  const outputFields = operation.outputSchema === undefined
    ? { fields: [{ name: "content", originalName: "content", type: "Text", required: true, description: "" }], fallback: true }
    : schemaObjectFields(operation.outputSchema, "outputSchema");
  if (outputFields.refusal) {
    return { tool: null, refusal: `${operationName}: ${outputFields.refusal}` };
  }
  if (operation.body_mode !== undefined && !['json', 'query'].includes(operation.body_mode)) return { tool: null, refusal: `${operationName}: unsupported body_mode` };
  const bodyMode = operation.body_mode ?? (['POST', 'PUT', 'PATCH'].includes(method) ? 'json' : 'query');
  if (bodyMode === 'query' && inputFields.fields.some(field => field.type.startsWith('List of '))) return { tool: null, refusal: `${operationName}: list query serialization requires an explicit adapter` };
  if (bodyMode === 'json' && method === 'GET') return { tool: null, refusal: `${operationName}: GET does not support a JSON body` };
  const operationSecretHandles = Array.isArray(operation.secret_handles)
    ? [...new Set(operation.secret_handles)].sort()
    : [];
  for (const handle of operationSecretHandles) {
    if (typeof handle !== "string" || !SECRET_HANDLE_PATTERN.test(handle)) {
      return { tool: null, refusal: `${operationName}: secret_handles must contain uppercase Touba secret handles` };
    }
  }
  const secretHandles = [...new Set([...service.secretHandles, ...operationSecretHandles])].sort();
  let auth;
  try {
    auth = normalizeAuth(operation.auth, secretHandles);
  } catch (error) {
    return { tool: null, refusal: `${operationName}: ${error.message}` };
  }
  return {
    tool: {
      operationName,
      description: typeof operation.description === "string" ? operation.description : "",
      method,
      path: operation.path,
      bodyMode,
      toolName,
      toolRef: `tool:${moduleName}/${toolName}`,
      inputTypeName: `${toolName}Request`,
      outputTypeName: `${toolName}Result`,
      inputFields: inputFields.fields,
      outputFields: outputFields.fields,
      outputFallback: outputFields.fallback === true,
      secretHandles,
      auth,
    },
    refusal: null,
  };
}

function requiredOperationName(operation) {
  const raw = typeof operation.name === "string" && operation.name.trim() !== ""
    ? operation.name
    : operation.operationId;
  return typeof raw === "string" && raw.trim() !== "" ? raw : null;
}

function normalizeAuth(auth, secretHandles) {
  if (!isPlainObject(auth)) {
    if (secretHandles.length === 0) {
      return { type: "none" };
    }
    return { type: "bearer", secret_handle: secretHandles[0] };
  }
  if (auth.type === "none") {
    return { type: "none" };
  }
  if (auth.type !== "bearer" && auth.type !== "header") {
    throw new Error("operation.auth.type must be none, bearer or header");
  }
  const secretHandle = requiredString(auth.secret_handle, "operation.auth.secret_handle");
  if (!secretHandles.includes(secretHandle)) {
    throw new Error("operation.auth.secret_handle must be declared in service.secret_handles or operation.secret_handles");
  }
  if (auth.type === "header") {
    return {
      type: "header",
      header_name: requiredString(auth.header_name, "operation.auth.header_name"),
      secret_handle: secretHandle,
    };
  }
  return {
    type: "bearer",
    secret_handle: secretHandle,
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
  if (!isPlainObject(property) || Array.isArray(property.type)) {
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

function buildFiles({ root, outputRoot, moduleName, service, tools }) {
  if (!tools.length) return [];
  if (tools.length > 1) {
    const batches = tools.map(tool => buildFiles({ root, outputRoot, moduleName, service, tools: [tool] }));
    const file = kind => batches[0].find(item => item.kind === kind);
    const fragment = JSON.parse(file('binding_fragment').content);
    fragment.bindings = Object.assign({}, ...batches.map(batch => JSON.parse(batch.find(item => item.kind === 'binding_fragment').content).bindings));
    const secrets = JSON.parse(file('secrets_template').content);
    secrets.secrets = Object.assign({}, ...batches.map(batch => JSON.parse(batch.find(item => item.kind === 'secrets_template').content).secrets));
    const perTool = batches.flatMap((batch, i) => {
      const configName = `${snakeCase(tools[i].toolName)}.rest.handler.config.json`;
      return [{ ...batch.find(item => item.kind === 'rest_handler_config'), path: join(outputRoot, configName) },
        { ...batch.find(item => item.kind === 'handler'), content: renderHandler(tools[i], configName) }];
    });
    return [
      { ...file('source'), content: `module ${moduleName}\n\n` + tools.map(tool => renderToubaSource(moduleName, tool).split('\n').slice(2).join('\n')).join('\n') },
      { ...file('binding_fragment'), content: JSON.stringify(fragment, null, 2) + '\n' },
      ...perTool,
      { ...file('secrets_template'), content: JSON.stringify(secrets, null, 2) + '\n' },
      { ...file('scaffold_report'), content: JSON.stringify({ report_schema_version: TOUBA_REST_SCAFFOLD_REPORT_VERSION, service, module_name: moduleName,
        generated_tools: tools.map(tool => ({ operation_name: tool.operationName, tool_ref: tool.toolRef })) }, null, 2) + '\n' },
      { ...file('readme'), content: renderReadme(service, moduleName, tools) },
    ];
  }
  const [tool] = tools;
  const sourcePath = join(outputRoot, "src", `${moduleName.split(".").at(-1)}.tb`);
  const manifestPath = join(outputRoot, "touba.manifest.fragment.json");
  const handlerConfigPath = join(outputRoot, "rest.handler.config.json");
  const handlerPath = join(outputRoot, "handlers", `${snakeCase(tool.toolName).replaceAll("_", "-")}.rest-handler.mjs`);
  const secretsPath = join(outputRoot, "touba.secrets.template.json");
  const reportPath = join(outputRoot, "rest-scaffold-report.json");
  const readmePath = join(outputRoot, "README.md");
  const report = {
    report_schema_version: TOUBA_REST_SCAFFOLD_REPORT_VERSION,
    service,
    module_name: moduleName,
    generated_files: [
      relative(root, sourcePath),
      relative(root, manifestPath),
      relative(root, handlerConfigPath),
      relative(root, handlerPath),
      relative(root, secretsPath),
      relative(root, readmePath),
    ],
    generated_tool: {
      operation_name: tool.operationName,
      tool_ref: tool.toolRef,
      input_type: tool.inputTypeName,
      output_type: tool.outputTypeName,
      secret_handles: tool.secretHandles,
    },
  };
  return [
    { kind: "source", path: sourcePath, content: renderToubaSource(moduleName, tool) },
    { kind: "binding_fragment", path: manifestPath, content: renderManifestFragment(service, tool, handlerPath, root, moduleName) },
    { kind: "rest_handler_config", path: handlerConfigPath, content: renderHandlerConfig(service, tool) },
    { kind: "handler", path: handlerPath, content: renderHandler(tool) },
    { kind: "secrets_template", path: secretsPath, content: renderSecretsTemplate(service, tool) },
    { kind: "scaffold_report", path: reportPath, content: `${JSON.stringify(report, null, 2)}\n` },
    { kind: "readme", path: readmePath, content: renderReadme(service, moduleName, tools) },
  ];
}

function renderToubaSource(moduleName, tool) {
  const lines = [
    `module ${moduleName}`,
    "",
    `type ${tool.inputTypeName}`,
  ];
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
  lines.push(tool.secretHandles.length > 0 ? "    requires network, secret_read" : "    requires network");
  if (tool.secretHandles.length > 0) {
    lines.push(`    secrets ${tool.secretHandles.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n").replace(/\n+$/u, "\n");
}

function renderManifestFragment(service, tool, handlerPath, root, moduleName) {
  return `${JSON.stringify({
    fragment_schema_version: TOUBA_BINDING_FRAGMENT_SCHEMA_VERSION,
    source: { kind: "module", module: moduleName },
    bindings: {
      [tool.toolRef]: {
        handler: {
          kind: "process",
          command: "node",
          args: [relative(root, handlerPath)],
          cwd: ".",
        },
        grants: tool.secretHandles.length > 0 ? ["network", "secret_read"] : ["network"],
        secrets: tool.secretHandles,
        effect_contract: { kind: "external_write", retry_mode: "none" },
        timeout_ms: service.timeoutMs,
        max_payload_bytes: service.maxPayloadBytes,
      },
    },
  }, null, 2)}\n`;
}

function renderHandlerConfig(service, tool) {
  return `${JSON.stringify({
    rest_handler_config_version: TOUBA_REST_HANDLER_CONFIG_VERSION,
    service: {
      name: service.name,
      base_url: service.baseUrl,
      timeout_ms: service.timeoutMs,
      max_payload_bytes: service.maxPayloadBytes,
    },
    operation: {
      name: tool.operationName,
      method: tool.method,
      path: tool.path,
      body_mode: tool.bodyMode,
      auth: tool.auth,
      request_fields: tool.inputFields.map((field) => ({
        field: field.name,
        source_name: field.originalName,
        required: field.required,
      })),
    },
  }, null, 2)}\n`;
}

function renderHandler(tool, configName = 'rest.handler.config.json') {
  return `import {
  ToubaHandlerError,
  defineTool,
} from "@touba/sdk";

import config from ${JSON.stringify('../' + configName)} with { type: "json" };

${renderJsonFieldAdapters(tool)}

await defineTool({
  toolRef: ${JSON.stringify(tool.toolRef)},
  inputSignature: [{ name: "request", type_ref: ${JSON.stringify(`type:${tool.toolRef.slice("tool:".length).split("/")[0]}/${tool.inputTypeName}`)} }],
  outputType: ${JSON.stringify(`type:${tool.toolRef.slice("tool:".length).split("/")[0]}/${tool.outputTypeName}`)},
  requiredGrants: ${JSON.stringify(tool.secretHandles.length > 0 ? ["network", "secret_read"] : ["network"])},
  requiredSecretHandles: ${JSON.stringify(tool.secretHandles)},
  run: async ({ request, context }) => {
    if (!request || typeof request !== "object" || Array.isArray(request)) {
      throw new ToubaHandlerError("InvalidArguments", "request must be an object");
    }

    const operation = config.operation;
    const wireRequest = toJsonRequest(request);
    const service = config.service;
    const url = new URL(operation.path, service.base_url);
    const headers = { Accept: "application/json" };
    let body;

    for (const field of operation.request_fields) {
      const value = wireRequest[field.source_name];
      if ((value === undefined || value === null) && field.required === true) {
        throw new ToubaHandlerError("InvalidArguments", \`request.\${field.field} is required\`);
      }
      if (value === undefined || value === null) {
        continue;
      }
      if (operation.body_mode === "query") {
        url.searchParams.set(field.source_name, String(value));
      }
    }

    if (operation.body_mode === "json") {
      body = JSON.stringify(wireRequest);
      headers["Content-Type"] = "application/json";
    }

    applyAuth(headers, operation.auth, context.env);

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), service.timeout_ms);
    try {
      const response = await fetch(url, {
        method: operation.method,
        headers,
        body,
        signal: controller.signal,
        redirect: "error",
      });
      const text = await readBoundedBody(response, service.max_payload_bytes);
      if (!response.ok) {
        throw new ToubaHandlerError("RestHttpError", \`REST endpoint returned HTTP \${response.status}\`);
      }
      if (text.trim() === "") {
        return fromJsonResult({ content: "" });
      }
      let result;
      try { result = JSON.parse(text); }
      catch { result = { content: text }; }
      return fromJsonResult(result);
    } finally {
      clearTimeout(timeout);
    }
  },
});

async function readBoundedBody(response, limit) {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) {
        await reader.cancel();
        throw new ToubaHandlerError("RestPayloadTooLarge", "REST response exceeded max_payload_bytes");
      }
      chunks.push(value);
    }
    return Buffer.concat(chunks).toString("utf8");
  } finally { reader.releaseLock(); }
}

function applyAuth(headers, auth, env) {
  if (!auth || auth.type === "none") {
    return;
  }
  const value = env?.[auth.secret_handle];
  if (typeof value !== "string" || value === "") {
    throw new ToubaHandlerError("MissingSecretValue", \`\${auth.secret_handle} value missing from handler environment\`);
  }
  if (auth.type === "bearer") {
    headers.Authorization = \`Bearer \${value}\`;
    return;
  }
  if (auth.type === "header") {
    headers[auth.header_name] = value;
    return;
  }
  throw new ToubaHandlerError("InvalidRestHandlerConfig", "unsupported auth type");
}
`;
}

function renderSecretsTemplate(service, tool) {
  const handles = [...new Set([...service.secretHandles, ...tool.secretHandles])].sort();
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

function renderReadme(service, moduleName, tools) {
  return `# ${service.name} REST Scaffold

Generated Touba contracts for selected REST or OpenAPI operations.

Module: \`${moduleName}\`

${tools.map(tool => `Generated tool: \`${tool.toolRef}\``).join('\n')}

## Handler runtime

These handlers use JavaScript, including in a Python project. Install a Node.js
version supported by Touba and the matching \`@touba/sdk\` before execution.
Generation, preview and preparation never contact the service.

## Review Required

- Review the generated Touba source before importing it into an agent.
- Review grants and secret handles in \`touba.manifest.fragment.json\`.
- Review the generated \`*.handler.config.json\` before live network use.
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
    diagnostics.push(errorDiagnostic("RestScaffoldFileMissing", `generated file is missing: ${file.path}`, {
      path: file.path,
    }));
    return;
  }
  const current = readFileSync(file.path, "utf8");
  if (current !== file.content) {
    diagnostics.push(errorDiagnostic("RestScaffoldFileDrift", `generated file differs from expected content: ${file.path}`, {
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

function errorDiagnostic(code, message, details = {}) {
  return { severity: "error", code, message, details };
}
