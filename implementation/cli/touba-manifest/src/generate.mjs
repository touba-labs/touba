#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestRequirements, unapprovedManifest } from "./requirements.mjs";

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

  const requirements = buildManifestRequirements([airDocument], {
    handlerCommand: options.handlerCommand ?? process.execPath,
    handlerRoot: options.handlerRoot ?? "handlers",
    handlerExtension: options.handlerExtension ?? "mjs",
    handlerCwd: options.handlerCwd ?? ".",
    timeoutMs: positiveInteger(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs"),
    maxPayloadBytes: positiveInteger(options.maxPayloadBytes, DEFAULT_MAX_PAYLOAD_BYTES, "maxPayloadBytes"),
  });
  const manifest = unapprovedManifest(requirements);

  const triggers = normalizeTriggerEntries(airDocument.definitions?.triggers);
  if (Object.keys(triggers).length > 0) {
    manifest.triggers = triggers;
  }


  return manifest;
}

export { toolNameToHandlerFile } from "./requirements.mjs";

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

function normalizeTriggerEntries(values) {
  if (values === undefined) {
    return {};
  }
  if (!Array.isArray(values)) {
    throw new Error("AIR definitions.triggers must be an array when present");
  }

  const triggers = {};
  for (const trigger of values) {
    if (!trigger || typeof trigger !== "object" || Array.isArray(trigger)) {
      throw new Error("AIR trigger entries must be objects");
    }
    if (typeof trigger.id !== "string" || !trigger.id.startsWith("trigger:")) {
      throw new Error("AIR trigger entries must contain trigger:id");
    }
    const sourceKind = trigger.event?.kind;
    if (sourceKind !== "schedule" && sourceKind !== "request") {
      throw new Error(`AIR trigger ${trigger.id} must use schedule or request source kind`);
    }

    const entry = {
      enabled: false,
      source: {
        kind: sourceKind,
      },
      limits: normalizeTriggerLimits(trigger.limits, trigger.id),
    };

    if (trigger.payload !== undefined) {
      entry.payload = normalizeTriggerPayload(trigger.payload, trigger.id);
    }

    triggers[trigger.id] = entry;
  }

  return triggers;
}

function normalizeTriggerLimits(limits, triggerId) {
  if (!limits || typeof limits !== "object" || Array.isArray(limits)) {
    throw new Error(`AIR trigger ${triggerId} must contain limits`);
  }
  return {
    max_runs_per_day: positiveInteger(limits.max_runs_per_day, undefined, "max_runs_per_day"),
    timeout_ms: positiveInteger(limits.timeout_ms, undefined, "timeout_ms"),
  };
}

function normalizeTriggerPayload(payload, triggerId) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error(`AIR trigger ${triggerId} payload must be an object`);
  }
  const format = payload.format ?? "json";
  if (format !== "json") {
    throw new Error(`AIR trigger ${triggerId} payload format must be json`);
  }
  const contentTypes = normalizeOptionalStringArray(
    payload.content_types,
    ["application/json"],
    "content_types",
  );
  const maxBytes = positiveInteger(payload.max_bytes, 65536, "max_bytes");
  if (!payload.map || typeof payload.map !== "object" || Array.isArray(payload.map)) {
    throw new Error(`AIR trigger ${triggerId} payload.map must be an object`);
  }
  const map = {};
  for (const [inputName, jsonPath] of Object.entries(payload.map)) {
    if (typeof inputName !== "string" || inputName.trim() === "") {
      throw new Error(`AIR trigger ${triggerId} payload.map input names must be non-empty`);
    }
    if (typeof jsonPath !== "string" || !/^\$(\.[A-Za-z_][A-Za-z0-9_]*)+$/u.test(jsonPath)) {
      throw new Error(`AIR trigger ${triggerId} payload.map values must use $.field JSON paths`);
    }
    map[inputName] = jsonPath;
  }
  return {
    format,
    content_types: contentTypes,
    max_bytes: maxBytes,
    map,
  };
}

function normalizeOptionalStringArray(values, fallback, label) {
  if (values === undefined) {
    return fallback;
  }
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array when present`);
  }
  return values.map((value) => {
    if (typeof value !== "string" || value.trim() === "") {
      throw new Error(`${label} entries must be non-empty strings`);
    }
    return value;
  });
}

function positiveInteger(value, fallback, label) {
  if (value === undefined) {
    if (fallback === undefined) {
      throw new Error(`${label} is required`);
    }
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
  writeFileSync(resolvedPath, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
}

async function main() {
  try {
    const { airPath, options, output } = parseArgs(process.argv.slice(2));
    const airDocument = JSON.parse(readFileSync(airPath, "utf8"));
    if (options.handlerCwd === undefined && output.outPath) options.handlerCwd = relative(dirname(resolve(output.outPath)), process.cwd()) || ".";
    const manifest = generateManifestFromAirDocument(airDocument, options);
    process.stderr.write("Generated a draft manifest without host grants or trigger activation. Review required_capabilities, required_secrets, memory_accesses and agent secret scopes in the AIR before granting them explicitly.\n");
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

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
