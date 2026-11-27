#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { assertDistinctHandlerPaths, handlerRelativePathForTool } from "./requirements.mjs";
import { SDK_INSTALL_HINT } from "./sdk-dependency.mjs";
import { generatePythonHandler, generatePythonContractTest } from "./python-stub.mjs";

const DEFAULT_HANDLER_ROOT = "handlers";
const DEFAULT_HANDLER_EXTENSION = "mjs";
const DEFAULT_SDK_IMPORT = "@touba/sdk";
const HANDLER_STUB_GENERATOR_METADATA = Object.freeze({
  tool: "touba handler stub",
  version: JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")).version,
});

export function generateHandlerStubFromAirTool(tool, options = {}) {
  const normalizedTool = normalizeTool(tool);
  if (options.language === "python" || options.handlerExtension === "py" || options.sdkImport === "touba-sdk") return generatePythonHandler(normalizedTool);
  const sdkImport = options.sdkImport ?? DEFAULT_SDK_IMPORT;
  const requiredGrants = normalizeStringArray(normalizedTool.required_capabilities, "required_capabilities");
  const requiredSecretHandles = normalizeStringArray(normalizedTool.required_secrets, "required_secrets");
  const inputs = normalizeInputs(normalizedTool.signature?.inputs);
  const outputType = typeof normalizedTool.signature?.output_type === "string"
    ? normalizedTool.signature.output_type
    : null;

  return `import {
  ToubaHandlerError,
  defineTool,
  toubaSdkMetadata,
} from ${JSON.stringify(sdkImport)};
import { pathToFileURL } from "node:url";

const TOOL_REF = ${JSON.stringify(normalizedTool.id)};
export const TOUBA_HANDLER_SDK = toubaSdkMetadata();
export const TOUBA_HANDLER_GENERATED_BY = ${JSON.stringify(HANDLER_STUB_GENERATOR_METADATA, null, 2)};
const REQUIRED_GRANTS = ${JSON.stringify(requiredGrants)};
const REQUIRED_SECRET_HANDLES = ${JSON.stringify(requiredSecretHandles)};
const INPUT_SIGNATURE = ${JSON.stringify(inputs, null, 2)};
const OUTPUT_TYPE = ${JSON.stringify(outputType)};

export async function run({ request, context }) {
  void request;
  void context;
  void TOUBA_HANDLER_SDK;
  void TOUBA_HANDLER_GENERATED_BY;
  void INPUT_SIGNATURE;
  void OUTPUT_TYPE;

  // stdout is reserved for the JSON protocol. Send logs to stderr without secrets.
  // Implement the bounded external effect here. Touba runtime already validates
  // structural input/output; keep domain-specific validation inside this handler.
  throw new ToubaHandlerError(
    "HandlerNotImplemented",
    \`handler stub for \${TOOL_REF} is not implemented\`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await defineTool({
    toolRef: TOOL_REF,
    requiredGrants: REQUIRED_GRANTS,
    requiredSecretHandles: REQUIRED_SECRET_HANDLES,
    inputSignature: INPUT_SIGNATURE,
    outputType: OUTPUT_TYPE,
    run,
  });
}
`;
}

export function generateHandlerContractTestFromAirTool(tool, options = {}) {
  const normalizedTool = normalizeTool(tool);
  if (options.language === "python" || options.handlerExtension === "py" || options.sdkImport === "touba-sdk") return generatePythonContractTest(normalizedTool, options.handlerImport ?? "handler.py");
  const sdkImport = options.sdkImport ?? DEFAULT_SDK_IMPORT;
  const handlerImport = options.handlerImport ?? "./handler.mjs";
  const requiredGrants = normalizeStringArray(normalizedTool.required_capabilities, "required_capabilities");
  const requiredSecretHandles = normalizeStringArray(normalizedTool.required_secrets, "required_secrets");
  const inputs = normalizeInputs(normalizedTool.signature?.inputs);
  const outputType = typeof normalizedTool.signature?.output_type === "string"
    ? normalizedTool.signature.output_type
    : null;

  return `// Admission contract checks only: these tests do not exercise business success.
// Add domain tests that call run({ request, context }) with representative inputs
// and assert actual outputs and effects. A single declared input is unwrapped
// into request; multiple inputs form a named object. Never test external effects
// against production services or treat these generated checks as business coverage.
import test from "node:test";
import assert from "node:assert/strict";
import {
  createToolHandler,
  handleToolRequest,
} from ${JSON.stringify(sdkImport)};
import {
  TOUBA_HANDLER_SDK,
  TOUBA_HANDLER_GENERATED_BY,
  run,
} from ${JSON.stringify(handlerImport)};

const TOOL_REF = ${JSON.stringify(normalizedTool.id)};
const REQUIRED_GRANTS = ${JSON.stringify(requiredGrants)};
const REQUIRED_SECRET_HANDLES = ${JSON.stringify(requiredSecretHandles)};
const INPUT_SIGNATURE = ${JSON.stringify(inputs, null, 2)};
const OUTPUT_TYPE = ${JSON.stringify(outputType)};

test("handler exposes SDK metadata without granting runtime authority", () => {
  assert.equal(TOUBA_HANDLER_SDK.name, "@touba/sdk");
  assert.equal(TOUBA_HANDLER_SDK.protocol, "touba-tool-handler-v1");
  assert.equal(TOUBA_HANDLER_SDK.status, "ok");
  assert.equal(Object.hasOwn(TOUBA_HANDLER_SDK, "grants"), false);
  assert.equal(Object.hasOwn(TOUBA_HANDLER_SDK, "secrets"), false);
  assert.equal(TOUBA_HANDLER_GENERATED_BY.tool, "touba handler stub");
  assert.equal(typeof TOUBA_HANDLER_GENERATED_BY.version, "string");
});

test.todo("business behavior: add domain inputs, output assertions and independent effect checks; admission tests alone do not cover it");

test("handler contract refuses an unexpected tool ref before business code", async () => {
  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      operation: "invoke",
      tool_ref: "tool:contract/UnexpectedTool",
      arguments: sampleArguments(),
      grants: REQUIRED_GRANTS,
      secret_handles: REQUIRED_SECRET_HANDLES,
      limits: { timeout_ms: 5000, max_payload_bytes: 1048576 },
    }),
    TOOL_REF,
    contractHandler(),
    contractOptions(),
  );

  assert.equal(response.ok, false);
  assert.equal(response.error.code, "InvalidToolRef");
});

test("handler contract enforces declared grants and secret handles before business code", async () => {
  if (REQUIRED_GRANTS.length === 0 && REQUIRED_SECRET_HANDLES.length === 0) {
    assert.deepEqual(REQUIRED_GRANTS, []);
    assert.deepEqual(REQUIRED_SECRET_HANDLES, []);
    return;
  }

  const response = await handleToolRequest(
    JSON.stringify({
      protocol: "touba-tool-handler-v1",
      operation: "invoke",
      tool_ref: TOOL_REF,
      arguments: sampleArguments(),
      grants: [],
      secret_handles: [],
      limits: { timeout_ms: 5000, max_payload_bytes: 1048576 },
    }),
    TOOL_REF,
    contractHandler(),
    contractOptions(),
  );

  const expectedCode = REQUIRED_GRANTS.length > 0 ? "MissingGrant" : "MissingSecretHandle";
  assert.equal(response.ok, false);
  assert.equal(response.error.code, expectedCode);
});

function contractHandler() {
  return createToolHandler({
    toolRef: TOOL_REF,
    requiredGrants: REQUIRED_GRANTS,
    requiredSecretHandles: REQUIRED_SECRET_HANDLES,
    inputSignature: INPUT_SIGNATURE,
    outputType: OUTPUT_TYPE,
    run,
  });
}

function contractOptions() {
  return {
    requiredGrants: REQUIRED_GRANTS,
    requiredSecretHandles: REQUIRED_SECRET_HANDLES,
  };
}

function sampleArguments() {
  return Object.fromEntries(INPUT_SIGNATURE.map((input) => [input.name, sampleValue(input.type_ref)]));
}

function sampleValue(typeRef) {
  if (typeRef === "builtin:Text") {
    return "text";
  }
  if (typeRef === "builtin:Int") {
    return 1;
  }
  if (typeRef === "builtin:Float") {
    return 1.5;
  }
  if (typeRef === "builtin:Boolean") {
    return true;
  }
  if (typeRef.startsWith("list:")) {
    return [];
  }
  return {};
}
`;
}

export function planHandlerStubsFromAirDocument(airDocument, options = {}) {
  if (!airDocument || typeof airDocument !== "object" || Array.isArray(airDocument)) {
    throw new Error("AIR document must be an object");
  }
  const tools = airDocument.definitions?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("AIR document definitions.tools must be an array");
  }

  const selectedTools = options.toolRef === undefined
    ? tools
    : tools.filter((tool) => tool?.id === options.toolRef);

  if (selectedTools.length === 0) {
    throw new Error(`AIR tool not found: ${options.toolRef}`);
  }

  const handlerRoot = options.handlerRoot ?? DEFAULT_HANDLER_ROOT;
  const handlerExtension = options.handlerExtension ?? (options.language === "python" ? "py" : DEFAULT_HANDLER_EXTENSION);
  const planned = selectedTools.map((tool) => {
    const normalizedTool = normalizeTool(tool);
    const targetPath = handlerRelativePathForTool(normalizedTool, { handlerRoot, handlerExtension });
    return {
      toolRef: normalizedTool.id,
      path: targetPath,
      content: generateHandlerStubFromAirTool(normalizedTool, options),
    };
  });
  assertDistinctHandlerPaths(planned);
  return planned;
}

export function writeHandlerStubsFromAirDocument(airDocument, options = {}) {
  const planned = planHandlerStubsFromAirDocument(airDocument, options);

  if (options.force !== true) {
    const existing = planned.filter((stub) => existsSync(stub.path)).map((stub) => stub.path);
    if (existing.length > 0) {
      throw new Error(`handler stub already exists: ${existing.join(", ")}`);
    }
  }

  for (const stub of planned) {
    mkdirSync(dirname(stub.path), { recursive: true });
    writeFileSync(stub.path, stub.content, { encoding: "utf8", flag: options.force === true ? "w" : "wx" });
  }

  return planned;
}

function normalizeTool(tool) {
  if (!tool || typeof tool !== "object" || Array.isArray(tool)) {
    throw new Error("AIR tool must be an object");
  }
  if (typeof tool.id !== "string" || !tool.id.startsWith("tool:")) {
    throw new Error("AIR tool must contain a tool: id");
  }
  const fallbackName = tool.id.slice(tool.id.lastIndexOf("/") + 1);
  const name = typeof tool.name === "string" && tool.name.trim() !== "" ? tool.name : fallbackName;
  return { ...tool, name };
}

function normalizeInputs(inputs) {
  if (inputs === undefined) {
    return [];
  }
  if (!Array.isArray(inputs)) {
    throw new Error("AIR tool signature.inputs must be an array when present");
  }
  return inputs.map((input) => {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
      throw new Error("AIR tool signature inputs must be objects");
    }
    if (typeof input.name !== "string" || input.name.trim() === "") {
      throw new Error("AIR tool signature input must contain a name");
    }
    if (typeof input.type_ref !== "string" || input.type_ref.trim() === "") {
      throw new Error("AIR tool signature input must contain a type_ref");
    }
    return {
      name: input.name,
      type_ref: input.type_ref,
    };
  });
}

function normalizeStringArray(values, label) {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error(`AIR tool ${label} must be an array when present`);
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`AIR tool ${label} entries must be non-empty strings`);
    }
    return value;
  });
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {};
  let airPath;

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--tool-ref":
        options.toolRef = requiredValue(arg, args);
        break;
      case "--handler-root":
        options.handlerRoot = requiredValue(arg, args);
        break;
      case "--handler-extension":
        options.handlerExtension = requiredValue(arg, args);
        break;
      case "--sdk-import":
        options.sdkImport = requiredValue(arg, args);
        break;
      case "--language":
        options.language = requiredValue(arg, args);
        if (!["javascript", "python"].includes(options.language)) throw new Error("choose language javascript or python");
        break;
      case "--force":
        options.force = true;
        break;
      case "--help":
        printUsage();
        process.exit(0);
      default:
        if (arg.startsWith("--")) {
          throw new Error(`unknown option ${arg}`);
        }
        if (airPath !== undefined) {
          throw new Error("only one AIR JSON path is accepted");
        }
        airPath = arg;
        break;
    }
  }

  if (airPath === undefined) {
    throw new Error("AIR JSON path is required");
  }

  return { airPath, options };
}

function requiredValue(option, args) {
  const value = args.shift();
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printUsage() {
  process.stdout.write(`Usage: touba-handler-stub <air.json> [options]

Options:
  --tool-ref <tool_ref>        Generate only one tool stub.
  --language <language>        javascript (default) or python.
  --handler-root <path>        Handler directory. Default: ${DEFAULT_HANDLER_ROOT}.
  --handler-extension <ext>    Handler extension. Default: ${DEFAULT_HANDLER_EXTENSION}.
  --sdk-import <specifier>     SDK import specifier. Default: ${DEFAULT_SDK_IMPORT}.
  --force                      Overwrite existing stub files.
`);
}

async function main() {
  try {
    const { airPath, options } = parseArgs(process.argv.slice(2));
    const airDocument = JSON.parse(readFileSync(airPath, "utf8"));
    const written = writeHandlerStubsFromAirDocument(airDocument, options);
    for (const stub of written) {
      process.stdout.write(`generated ${stub.path} for ${stub.toolRef}\n`);
    }
    process.stdout.write(`${options.language === "python" || options.handlerExtension === "py" || options.sdkImport === "touba-sdk"
      ? "Run touba sdk install python in this project before executing the generated handlers."
      : SDK_INSTALL_HINT}\n`);
  } catch (error) {
    process.stderr.write(`touba-handler-stub: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.main) {
  await main();
}
