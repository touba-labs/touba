#!/usr/bin/env node
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildManifestRequirements, unapprovedManifest } from "./requirements.mjs";
import { projectPythonCommand } from "./python-sdk-dependency.mjs";
import { normalizeTriggerEntries, positiveInteger } from "./manifest-values.mjs";
export { normalizeTriggerEntries } from "./manifest-values.mjs";

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

  const language = options.language ?? "javascript";
  if (!["javascript", "python"].includes(language)) throw new Error("choose language javascript or python");
  const requirements = buildManifestRequirements([airDocument], {
    handlerCommand: options.handlerCommand ?? (language === "python" ? projectPythonCommand() : "node"),
    handlerRoot: options.handlerRoot ?? "handlers",
    handlerExtension: options.handlerExtension ?? (language === "python" ? "py" : "mjs"),
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
      case "--language":
        options.language = requiredValue(arg, args);
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
  --language <language>             javascript or python. Default: project language, then javascript.
  --out, -o <path>                  Write a manifest JSON artifact. Path must end with .manifest.json.
  --stdout                          Print the manifest JSON to stdout for explicit pipelines.
  --handler-command <command>       Handler executable in generated bindings.
  --handler-root <path>             Handler directory prefix. Default: handlers.
  --handler-extension <ext>         Handler extension. Default: mjs (JavaScript) or py (Python).
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
    // Use the project's canonical parser: malformed config is never ignored.
    let root = process.cwd();
    while (!existsSync(join(root, "touba.project.json")) && dirname(root) !== root) root = dirname(root);
    if (existsSync(join(root, "touba.project.json"))) {
      const { readProjectConfig } = await import("../../touba-project/src/project.mjs");
      const config = readProjectConfig(join(root, "touba.project.json"));
      if (options.language && options.language !== config.language) throw new Error("--language differs from touba.project.json; use the project's SDK language");
      options.language = config.language;
      if (options.handlerCwd === undefined) options.handlerCwd = relative(output.outPath ? dirname(resolve(output.outPath)) : process.cwd(), root) || ".";
    }
    const airDocument = JSON.parse(readFileSync(airPath, "utf8"));
    if (options.handlerCwd === undefined && output.outPath) options.handlerCwd = relative(dirname(resolve(output.outPath)), process.cwd()) || ".";
    const manifest = generateManifestFromAirDocument(airDocument, options);
    assertManifestJson(manifest);
    if (output.stdout === true) {
      process.stdout.write(`${JSON.stringify(manifest, null, 2)}\n`);
    } else writeManifestOutput(output.outPath, manifest);
    process.stderr.write("Generated a draft manifest. Review each effect_contract and grant explicitly. In a project, use touba prepare to review the required configuration.\n");
  } catch (error) {
    process.stderr.write(`touba-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  await main();
}
