#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";

const MANIFEST_VERSION = "touba-manifest-v1";
const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_MAX_PAYLOAD_BYTES = 1048576;

export function generateManifestFromAirDocument(airDocument, options = {}) {
  if (!airDocument || typeof airDocument !== "object" || Array.isArray(airDocument)) {
    throw new Error("AIR document must be an object");
  }

  const tools = airDocument.definitions?.tools;
  if (!Array.isArray(tools)) {
    throw new Error("AIR document definitions.tools must be an array");
  }

  const manifest = {
    manifest_version: MANIFEST_VERSION,
    bindings: {},
  };

  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || typeof tool.id !== "string") {
      throw new Error("AIR tool entries must contain an id");
    }
    if (!tool.id.startsWith("tool:")) {
      throw new Error(`AIR tool id must start with tool: (${tool.id})`);
    }

    const toolName = typeof tool.name === "string" && tool.name.trim() !== ""
      ? tool.name
      : tool.id.slice(tool.id.lastIndexOf("/") + 1);

    const binding = {
      handler: {
        kind: "process",
        command: options.handlerCommand ?? "__TOUBA_HANDLER_COMMAND__",
        args: [
          `${options.handlerRoot ?? "handlers"}/${toolNameToHandlerFile(toolName, options.handlerExtension ?? "mjs")}`,
        ],
      },
      grants: normalizeStringArray(tool.required_capabilities),
      timeout_ms: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs"),
      max_payload_bytes: positiveInteger(
        options.maxPayloadBytes,
        DEFAULT_MAX_PAYLOAD_BYTES,
        "maxPayloadBytes",
      ),
    };

    if (options.handlerCwd !== undefined) {
      binding.handler.cwd = options.handlerCwd;
    }

    const requiredSecrets = normalizeStringArray(tool.required_secrets);
    if (requiredSecrets.length > 0) {
      binding.secrets = requiredSecrets;
    }

    const memoryAccesses = normalizeMemoryAccesses(tool.memory_accesses);
    if (memoryAccesses.length > 0) {
      binding.memories = memoryAccesses;
    }

    manifest.bindings[tool.id] = binding;
  }

  if (options.includeAgentSecretScopes === true) {
    manifest.agent_secret_scopes = {};
  }

  return manifest;
}

export function toolNameToHandlerFile(toolName, extension = "mjs") {
  const normalizedExtension = String(extension).replace(/^\./, "");
  const snake = String(toolName)
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();

  if (snake === "") {
    throw new Error("tool name cannot be converted to a handler file name");
  }

  return `${snake}.handler.${normalizedExtension}`;
}

function normalizeStringArray(values) {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("AIR tool list field must be an array when present");
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error("AIR tool list entries must be non-empty strings");
    }
    return value;
  });
}

function normalizeMemoryAccesses(values) {
  if (values === undefined) {
    return [];
  }
  if (!Array.isArray(values)) {
    throw new Error("AIR tool memory_accesses must be an array when present");
  }
  return values.map((access) => {
    if (!access || typeof access !== "object" || Array.isArray(access)) {
      throw new Error("AIR memory_accesses entries must be objects");
    }
    if (typeof access.memory_ref !== "string" || !access.memory_ref.startsWith("memory:")) {
      throw new Error("AIR memory_accesses entries must contain memory_ref");
    }
    if (access.access !== "read" && access.access !== "write") {
      throw new Error("AIR memory_accesses access must be read or write");
    }
    return {
      ref: access.memory_ref,
      access: access.access,
    };
  });
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) {
    return fallback;
  }
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function parseArgs(argv) {
  const args = [...argv];
  const options = {};
  const output = {};
  let airPath;

  while (args.length > 0) {
    const arg = args.shift();
    switch (arg) {
      case "--out":
      case "-o":
        output.outPath = requiredValue(arg, args);
        break;
      case "--stdout":
        output.stdout = true;
        break;
      case "--handler-command":
        options.handlerCommand = requiredValue(arg, args);
        break;
      case "--handler-root":
        options.handlerRoot = requiredValue(arg, args);
        break;
      case "--handler-extension":
        options.handlerExtension = requiredValue(arg, args);
        break;
      case "--handler-cwd":
        options.handlerCwd = requiredValue(arg, args);
        break;
      case "--timeout-ms":
        options.timeoutMs = Number(requiredValue(arg, args));
        break;
      case "--max-payload-bytes":
        options.maxPayloadBytes = Number(requiredValue(arg, args));
        break;
      case "--include-agent-secret-scopes":
        options.includeAgentSecretScopes = true;
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
  if (output.outPath !== undefined && output.stdout === true) {
    throw new Error("use either --out <touba.manifest.json> or --stdout, not both");
  }
  if (output.outPath === undefined && output.stdout !== true) {
    throw new Error(
      "touba manifest generate requires an explicit output mode: use --out <touba.manifest.json> or --stdout",
    );
  }

  return { airPath, options, output };
}

function requiredValue(option, args) {
  const value = args.shift();
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printUsage() {
  process.stdout.write(`Usage:
  touba-manifest <air.json> --out <touba.manifest.json> [options]
  touba-manifest <air.json> --stdout [options]

Options:
  --out, -o <path>                  Write a manifest JSON artifact. Path must end with .manifest.json.
  --stdout                          Print the manifest JSON to stdout for explicit pipelines.
  --handler-command <command>       Handler executable in generated bindings.
  --handler-root <path>             Handler directory prefix. Default: handlers.
  --handler-extension <ext>         Handler extension. Default: mjs.
  --handler-cwd <path>              Optional handler cwd.
  --timeout-ms <number>             Binding timeout. Default: ${DEFAULT_TIMEOUT_MS}.
  --max-payload-bytes <number>      Payload limit. Default: ${DEFAULT_MAX_PAYLOAD_BYTES}.
  --include-agent-secret-scopes     Add an empty agent_secret_scopes object.
`);
}

function assertManifestOutputPath(outPath) {
  if (typeof outPath !== "string" || outPath.trim() === "") {
    throw new Error("--out requires a non-empty path");
  }

  const resolvedPath = resolve(outPath);
  const fileName = basename(resolvedPath);
  if (!fileName.endsWith(".manifest.json")) {
    throw new Error("manifest output path must end with .manifest.json");
  }

  if (existsSync(resolvedPath) && statSync(resolvedPath).isDirectory()) {
    throw new Error("manifest output path points to a directory");
  }

  return resolvedPath;
}

function assertManifestJson(manifest) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    throw new Error("generated manifest must be a JSON object");
  }
  if (manifest.manifest_version !== MANIFEST_VERSION) {
    throw new Error("generated manifest must use touba-manifest-v1");
  }
}

function writeManifestOutput(outPath, manifest) {
  const resolvedPath = assertManifestOutputPath(outPath);
  assertManifestJson(manifest);
  mkdirSync(dirname(resolvedPath), { recursive: true });
  writeFileSync(resolvedPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
}

async function main() {
  try {
    const { airPath, options, output } = parseArgs(process.argv.slice(2));
    const airDocument = JSON.parse(readFileSync(airPath, "utf8"));
    const manifest = generateManifestFromAirDocument(airDocument, options);
    assertManifestJson(manifest);
    if (output.stdout === true) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
      return;
    }
    writeManifestOutput(output.outPath, manifest);
  } catch (error) {
    process.stderr.write(`touba-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}
