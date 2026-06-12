#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyRunProfileToArgs,
  checkProjectSecret,
  initProject,
  listProjectSecrets,
  newModule,
  prepareProject,
  removeProjectSecret,
  renderReport,
  setProjectSecret,
} from "./project.mjs";
import {
  newSkillPack,
  validateSkillPacks,
} from "./skill-packs.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const packageRoot = resolve(currentDir, "..");
const implementationRoot = resolve(currentDir, "../../..");
const args = process.argv.slice(2);

const TOUBA_VERSION = "0.1.0";
const SCHEMA_VERSIONS = Object.freeze({
  air: "air-minimal-v0.1",
  trace: "trace-minimal-v0.1",
  manifest: "touba-manifest-v1",
  secrets: "touba-secrets-v1",
  ownership: "touba-ownership-v0.1",
  trace_audit: "trace-audit-v0.1",
  trace_audit_validation: "trace-audit-validation-v0.1",
  trace_audit_export: "trace-audit-export-v0.1-local",
  supply_chain_lock: "touba-lock-v0.1",
  supply_chain_validation: "touba-supply-chain-validation-v0.1",
});

try {
  const result = await dispatch(args);
  if (result.usage === true) {
    process.exitCode = result.exitCode ?? 0;
  } else if (result.passthrough === true) {
    process.exitCode = result.exitCode ?? 0;
  } else if (result.text !== undefined) {
    process.stdout.write(`${String(result.text).replace(/\n$/u, "")}\n`);
  } else if (result.json === true) {
    process.stdout.write(`${JSON.stringify(result.report, null, 2)}\n`);
  } else {
    process.stdout.write(renderReport(result.report));
  }
  if (result.exitCode !== undefined) {
    process.exitCode = result.exitCode;
  }
} catch (error) {
  process.stderr.write(`touba: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 2;
}

async function dispatch(rawArgs) {
  const [command, ...rest] = rawArgs;
  if (command === undefined || command === "--help" || command === "-h") {
    printUsage();
    return { usage: true, exitCode: 0 };
  }
  if (command === "init") {
    const options = parseInitOptions(rest);
    const report = initProject(options);
    return { report, json: options.json, exitCode: 0 };
  }
  if (command === "new") {
    const [kind, name, ...tail] = rest;
    if (kind !== "module" || !name) {
      throw new Error("usage: touba new module <domain.module> [--root <path>] [--force]");
    }
    const options = parseCommonOptions(tail);
    const report = newModule(name, options);
    return { report, json: options.json, exitCode: 0 };
  }
  if (command === "prepare") {
    const options = parsePrepareOptions(rest);
    const report = await prepareProject(options);
    const exitCode = report.status === "error" && options.mode !== "plan" ? 1 : 0;
    return { report, json: options.json, exitCode };
  }
  if (command === "secret") {
    const [action, handle, ...tail] = rest;
    if (action === "set" && handle) {
      const options = parseSecretOptions(tail);
      const value = secretValueFromOptions(options);
      const report = setProjectSecret(handle, value, options);
      return { report, json: options.json, exitCode: 0 };
    }
    if (action === "list") {
      const options = parseSecretOptions(handle === undefined ? tail : [handle, ...tail]);
      const report = listProjectSecrets(options);
      return { report, json: options.json, exitCode: 0 };
    }
    if (action === "check" && handle) {
      const options = parseSecretOptions(tail);
      const report = checkProjectSecret(handle, options);
      return { report, json: options.json, exitCode: report.present ? 0 : 1 };
    }
    if (action === "remove" && handle) {
      const options = parseSecretOptions(tail);
      const report = removeProjectSecret(handle, options);
      return { report, json: options.json, exitCode: 0 };
    }
    throw new Error("usage: touba secret set|list|check|remove ...");
  }
  if (command === "skill") {
    const [action, target, ...tail] = rest;
    if (action === "new" && target) {
      const options = parseCommonOptions(tail);
      const report = newSkillPack(target, options);
      return { report, json: options.json, exitCode: 0 };
    }
    if (action === "validate") {
      const options = parseSkillValidateOptions(target === undefined ? tail : [target, ...tail]);
      const report = validateSkillPacks(options);
      return { report, json: options.json, exitCode: report.status === "error" ? 1 : 0 };
    }
    if (action === undefined || action === "--help" || action === "-h") {
      return {
        text: "Usage: touba skill new <skill-id> [--root <path>] [--force]\n       touba skill validate [<skill-id|path>] [--root <path>]",
        exitCode: 0,
      };
    }
    throw new Error("usage: touba skill new|validate ...");
  }
  if (command === "compile") {
    return compileCommand(rest);
  }
  if (command === "run") {
    return runCommand(rest);
  }
  if (command === "trigger") {
    return triggerCommand(rest);
  }
  if (command === "inspect") {
    return inspectCommand(rest);
  }
  if (command === "audit") {
    return auditCommand(rest);
  }
  if (command === "supply-chain") {
    return supplyChainCommand(rest);
  }
  if (command === "manifest") {
    return manifestCommand(rest);
  }
  if (command === "handler") {
    return handlerCommand(rest);
  }
  if (command === "version") {
    return versionCommand(rest);
  }
  if (command === "update") {
    return updateCommand(rest);
  }
  printUsage();
  return { usage: true, exitCode: 2 };
}

function compileCommand(rawArgs) {
  const options = parseCompileOptions(rawArgs);
  if (options.help === true) {
    return { text: compileUsage(), exitCode: 0 };
  }
  if (options.out !== undefined && options.stdout === true) {
    throw new Error("touba compile cannot combine --out and --stdout");
  }
  if (options.out === undefined && options.stdout === true) {
    return runCompilerPassthrough(options.compilerArgs);
  }
  if (options.out === undefined) {
    throw new Error("touba compile requires an explicit output mode: use --out <program.air.json> or --stdout");
  }

  assertCompileOutputPath(options.out);
  const compiler = compileCommandSpec(options.compilerArgs);
  const result = spawnSync(compiler.command, compiler.args, {
    cwd: compiler.cwd ?? process.cwd(),
    env: process.env,
    stdio: ["inherit", "pipe", "pipe"],
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
  });

  if (result.error) {
    throw result.error;
  }
  if (result.stderr) {
    process.stderr.write(result.stderr);
  }
  if ((result.status ?? 1) !== 0) {
    return { passthrough: true, exitCode: result.status ?? 1 };
  }

  assertAirJsonOutput(result.stdout ?? "");
  const outputPath = resolve(options.out);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, ensureTrailingNewline(result.stdout ?? ""), "utf8");
  return {
    text: `wrote AIR JSON ${outputPath}`,
    exitCode: 0,
  };
}

function runCompilerPassthrough(rawArgs) {
  const compiler = compileCommandSpec(rawArgs);
  return runPassthrough(compiler.command, compiler.args, { cwd: compiler.cwd });
}

function compileCommandSpec(rawArgs) {
  if (process.env.TOUBA_COMPILE_BIN) {
    return { command: process.env.TOUBA_COMPILE_BIN, args: rawArgs };
  }

  const localCompiler = newestExistingCompiler([
    join(implementationRoot, "target", "release", "touba-compile"),
    join(implementationRoot, "target", "debug", "touba-compile"),
  ]);
  if (existsSync(localCompiler)) {
    return { command: localCompiler, args: rawArgs };
  }

  return {
    command: process.env.CARGO ?? "cargo",
    args: [
      "run",
      "-q",
      "-p",
      "touba-cli",
      "--bin",
      "touba-compile",
      "--",
      ...rawArgs,
    ],
    cwd: implementationRoot,
  };
}

function parseCompileOptions(rawArgs) {
  const compilerArgs = [];
  let out;
  let stdout = false;
  let help = false;
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--out" || arg === "-o") {
      if (out !== undefined) {
        throw new Error("touba compile accepts only one --out");
      }
      out = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--out=")) {
      if (out !== undefined) {
        throw new Error("touba compile accepts only one --out");
      }
      out = arg.slice("--out=".length);
      if (out.length === 0) {
        throw new Error("--out requires a value");
      }
    } else if (arg === "--stdout") {
      stdout = true;
    } else if (arg === "--help" || arg === "-h") {
      help = true;
    } else {
      compilerArgs.push(arg);
    }
  }
  return { compilerArgs, out, stdout, help };
}

function assertCompileOutputPath(path) {
  if (!path.endsWith(".air.json")) {
    throw new Error("touba compile --out requires a .air.json output path");
  }
  if (existsSync(path) && statSync(path).isDirectory()) {
    throw new Error("touba compile --out must target a file, not a directory");
  }
}

function assertAirJsonOutput(text) {
  let document;
  try {
    document = JSON.parse(text);
  } catch {
    throw new Error("compiler output is not valid JSON; refusing to write --out");
  }
  if (!document || typeof document !== "object" || typeof document.air_schema_version !== "string") {
    throw new Error("compiler output is not an AIR JSON document; refusing to write --out");
  }
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function compileUsage() {
  return [
    "Usage: touba compile <source.tb> --out <program.air.json>",
    "       touba compile <source.tb> --stdout",
    "",
    "Use --out for normal project work. It validates the .air.json extension and AIR JSON output before writing.",
    "Use --stdout only for explicit pipelines or advanced tooling.",
  ].join("\n");
}

function newestExistingCompiler(paths) {
  let selected = null;
  for (const path of paths) {
    if (!existsSync(path)) {
      continue;
    }
    const stat = statSync(path);
    if (!selected || stat.mtimeMs > selected.mtimeMs) {
      selected = { path, mtimeMs: stat.mtimeMs };
    }
  }
  return selected?.path ?? paths[0];
}

function runCommand(rawArgs) {
  const profiledArgs = applyRunProfileToArgs(rawArgs);
  return runNodeScript(["cli", "touba-run", "src", "run.mjs"], profiledArgs);
}

function triggerCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (subcommand === "run") {
    return runCommand(tail);
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      text: "Usage: touba trigger run <air.json> --manifest <path> --trigger <trigger_ref> --max-runs <n> [--state <touba.trigger-state.json>] [--trace-out <path>] [--output show|result|trace|all]",
      exitCode: 0,
    };
  }
  throw new Error(`unknown trigger command ${subcommand}`);
}

function inspectCommand(rawArgs) {
  return runNodeScript(["cli", "touba-inspect", "src", "inspect.mjs"], rawArgs);
}

function auditCommand(rawArgs) {
  return runNodeScript(["cli", "touba-audit", "src", "audit.mjs"], rawArgs);
}

function supplyChainCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (subcommand === "validate") {
    return runNodeScript(["cli", "touba-supply-chain", "src", "validate.mjs"], tail);
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      text: "Usage: touba supply-chain validate --lock <touba.lock.json> --air <program.air.json> [--manifest <touba.manifest.json>] [--report-out <report.supply-chain-report.json>] [--output text|json] [--strict] [--require-review]",
      exitCode: 0,
    };
  }
  throw new Error(`unknown supply-chain command ${subcommand}`);
}

function manifestCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (subcommand === "generate") {
    return runNodeScript(["cli", "touba-manifest", "src", "generate.mjs"], tail);
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      text: "Usage: touba manifest generate <air.json> --out <touba.manifest.json> [--handler-command <command>] [--handler-root <path>]\n       touba manifest generate <air.json> --stdout [--handler-command <command>] [--handler-root <path>]",
      exitCode: 0,
    };
  }
  throw new Error(`unknown manifest command ${subcommand}`);
}

function handlerCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (subcommand === "stub") {
    return runNodeScript(["cli", "touba-manifest", "src", "stub.mjs"], tail);
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      text: "Usage: touba handler stub <air.json> [--tool-ref <tool_ref>] [--handler-root <path>] [--force]",
      exitCode: 0,
    };
  }
  throw new Error(`unknown handler command ${subcommand}`);
}

function versionCommand(rawArgs) {
  if (rawArgs.length === 0) {
    return {
      text: renderVersionsText(toubaVersions()),
      exitCode: 0,
    };
  }
  if (rawArgs.length === 1 && rawArgs[0] === "--json") {
    return {
      text: JSON.stringify(toubaVersions(), null, 2),
      exitCode: 0,
    };
  }
  if (rawArgs.length === 1 && (rawArgs[0] === "--help" || rawArgs[0] === "-h")) {
    return {
      text: "Usage: touba version [--json]",
      exitCode: 0,
    };
  }
  throw new Error(`unknown option ${rawArgs[0]}`);
}

function updateCommand(rawArgs) {
  if (rawArgs.length > 0 && rawArgs[0] !== "--help" && rawArgs[0] !== "-h") {
    throw new Error(`unknown option ${rawArgs[0]}`);
  }
  const channel = process.env.TOUBA_DISTRIBUTION_CHANNEL ?? "local-development";
  return {
    text: [
      "Touba self-update is not available for this installation channel.",
      `Current channel: ${channel}`,
      "Use the installer, archive, or package manager that installed Touba.",
    ].join("\n"),
    exitCode: 1,
  };
}

function runNodeScript(relativePath, rawArgs) {
  const scriptPath = join(implementationRoot, ...relativePath);
  if (!existsSync(scriptPath)) {
    throw new Error(`missing Touba script ${scriptPath}`);
  }
  return runPassthrough(process.execPath, [scriptPath, ...rawArgs]);
}

function runPassthrough(command, rawArgs, options = {}) {
  const interactive = process.stdout.isTTY && process.stderr.isTTY;
  const result = spawnSync(command, rawArgs, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: interactive ? "inherit" : ["inherit", "pipe", "pipe"],
    encoding: interactive ? undefined : "utf8",
  });

  if (result.error) {
    throw result.error;
  }
  if (!interactive) {
    if (result.stdout) {
      process.stdout.write(result.stdout);
    }
    if (result.stderr) {
      process.stderr.write(result.stderr);
    }
  }
  return {
    passthrough: true,
    exitCode: result.status ?? 1,
  };
}

function toubaVersions() {
  return {
    cli: readPackageVersion(join(packageRoot, "package.json"), TOUBA_VERSION),
    runtime: readPackageVersion(join(implementationRoot, "runtime", "touba-runtime", "package.json"), TOUBA_VERSION),
    inspect: readPackageVersion(join(implementationRoot, "cli", "touba-inspect", "package.json"), TOUBA_VERSION),
    audit: readPackageVersion(join(implementationRoot, "cli", "touba-audit", "package.json"), TOUBA_VERSION),
    supply_chain: readPackageVersion(join(implementationRoot, "cli", "touba-supply-chain", "package.json"), TOUBA_VERSION),
    manifest: readPackageVersion(join(implementationRoot, "cli", "touba-manifest", "package.json"), TOUBA_VERSION),
    schemas: SCHEMA_VERSIONS,
    distribution: {
      channel: process.env.TOUBA_DISTRIBUTION_CHANNEL ?? "local-development",
      platform: `${process.platform}-${process.arch}`,
    },
  };
}

function renderVersionsText(info) {
  return [
    `touba ${info.cli}`,
    `runtime ${info.runtime}`,
    `inspect ${info.inspect}`,
    `audit ${info.audit}`,
    `supply_chain ${info.supply_chain}`,
    `manifest ${info.manifest}`,
    `air ${info.schemas.air}`,
    `trace ${info.schemas.trace}`,
    `ownership ${info.schemas.ownership}`,
    `trace_audit ${info.schemas.trace_audit}`,
    `trace_audit_validation ${info.schemas.trace_audit_validation}`,
    `trace_audit_export ${info.schemas.trace_audit_export}`,
    `supply_chain_lock ${info.schemas.supply_chain_lock}`,
    `supply_chain_validation ${info.schemas.supply_chain_validation}`,
    `distribution ${info.distribution.channel} ${info.distribution.platform}`,
  ].join("\n");
}

function readPackageVersion(packageJsonPath, fallback = "unknown") {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return packageJson.version ?? fallback;
  } catch {
    return fallback;
  }
}

function parseCommonOptions(rawArgs) {
  const options = { json: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--root") {
      options.root = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function parseInitOptions(rawArgs) {
  const options = { json: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--root") {
      options.root = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--language") {
      options.language = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--language=")) {
      options.language = arg.slice("--language=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function parsePrepareOptions(rawArgs) {
  const options = {
    json: false,
    mode: "plan",
    sourcePaths: [],
    airPaths: [],
    packagePaths: [],
    bindingFragmentPaths: [],
    resourceBindingsPaths: [],
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--root") {
      options.root = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--mode") {
      options.mode = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--source") {
      options.sourcePaths.push(requiredValue(arg, rawArgs, ++index));
    } else if (arg.startsWith("--source=")) {
      options.sourcePaths.push(arg.slice("--source=".length));
    } else if (arg === "--air") {
      options.airPaths.push(requiredValue(arg, rawArgs, ++index));
    } else if (arg.startsWith("--air=")) {
      options.airPaths.push(arg.slice("--air=".length));
    } else if (arg === "--package") {
      options.packagePaths.push(requiredValue(arg, rawArgs, ++index));
    } else if (arg.startsWith("--package=")) {
      options.packagePaths.push(arg.slice("--package=".length));
    } else if (arg === "--binding-fragment") {
      options.bindingFragmentPaths.push(requiredValue(arg, rawArgs, ++index));
    } else if (arg.startsWith("--binding-fragment=")) {
      options.bindingFragmentPaths.push(arg.slice("--binding-fragment=".length));
    } else if (arg === "--resource-bindings") {
      options.resourceBindingsPaths.push(requiredValue(arg, rawArgs, ++index));
    } else if (arg.startsWith("--resource-bindings=")) {
      options.resourceBindingsPaths.push(arg.slice("--resource-bindings=".length));
    } else if (arg === "--require-resource-bindings") {
      options.requireResourceBindings = true;
    } else if (arg === "--run-plan") {
      options.runPlanPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--run-plan=")) {
      options.runPlanPath = arg.slice("--run-plan=".length);
    } else if (arg === "--ownership") {
      options.ownershipPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--ownership=")) {
      options.ownershipPath = arg.slice("--ownership=".length);
    } else if (arg === "--require-ownership") {
      options.requireOwnership = true;
    } else if (arg === "--entry") {
      options.entryRef = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--entry=")) {
      options.entryRef = arg.slice("--entry=".length);
    } else if (arg === "--profile") {
      options.runProfile = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--profile=")) {
      options.runProfile = arg.slice("--profile=".length);
    } else if (arg === "--manifest") {
      options.manifestPath = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--manifest=")) {
      options.manifestPath = arg.slice("--manifest=".length);
    } else if (arg === "--handler-root") {
      options.handlerRoot = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--handler-root=")) {
      options.handlerRoot = arg.slice("--handler-root=".length);
    } else if (arg === "--handler-command") {
      options.handlerCommand = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--handler-command=")) {
      options.handlerCommand = arg.slice("--handler-command=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function parseSecretOptions(rawArgs) {
  const options = { json: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--root") {
      options.root = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--store") {
      options.storePath = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--store=")) {
      options.storePath = arg.slice("--store=".length);
    } else if (arg === "--value") {
      options.value = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--value=")) {
      options.value = arg.slice("--value=".length);
    } else if (arg === "--value-stdin") {
      options.valueStdin = true;
    } else if (arg === "--json") {
      options.json = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  if (options.value !== undefined && options.valueStdin === true) {
    throw new Error("--value cannot be combined with --value-stdin");
  }
  return options;
}

function parseSkillValidateOptions(rawArgs) {
  const options = { json: false };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--root") {
      options.root = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (!arg.startsWith("--") && options.target === undefined) {
      options.target = arg;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function secretValueFromOptions(options) {
  if (options.value !== undefined) {
    return options.value;
  }
  if (options.valueStdin === true) {
    return readFileSync(0, "utf8").replace(/\r?\n$/u, "");
  }
  throw new Error("touba secret set requires --value-stdin");
}

function requiredValue(option, args, index) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printUsage() {
  process.stdout.write(`Usage:
  touba init [--root <path>] [--language javascript]
  touba new module <domain.module> [--root <path>] [--force]
  touba skill new <skill-id> [--root <path>] [--force]
  touba skill validate [<skill-id|path>] [--root <path>]
  touba prepare [--root <path>] [--mode plan|check|write] [--source <file.tb>] [--air <file.air.json>] [--package <touba.package.json>] [--binding-fragment <fragment.json>] [--resource-bindings <resources.json>] [--require-resource-bindings] [--run-plan <path>] [--ownership <touba.ownership.json>] [--require-ownership] [--entry <air-ref>] [--profile dev|prod] [--manifest <path>] [--handler-root <path>] [--handler-command <path>] [--json]
  touba secret set <HANDLE> [--root <path>] [--store <path>] --value-stdin
  touba secret list [--root <path>] [--store <path>]
  touba secret check <HANDLE> [--root <path>] [--store <path>]
  touba secret remove <HANDLE> [--root <path>] [--store <path>]
  touba compile <source.tb> --out <program.air.json>
  touba compile <source.tb> --stdout
  touba run <program.air.json> [--profile dev|prod] [runtime options]
  touba trigger run <program.air.json> --manifest <path> --trigger <trigger_ref> --max-runs <n> [--state <touba.trigger-state.json>]
  touba inspect <artifact> [inspect options] [--report-out <report.inspect.txt>]
  touba audit --trace <trace.json> [--air <air.json>] [--source <file.tb>] [--manifest <touba.manifest.json>] [--audit-manifest <trace-audit.json>] [--export <export.json>] [--report-out <report.trace-audit-report.json>] [--output text|json]
  touba supply-chain validate --lock <touba.lock.json> --air <program.air.json> [--manifest <touba.manifest.json>] [--report-out <report.supply-chain-report.json>] [--output text|json] [--strict] [--require-review]
  touba manifest generate <air.json> --out <touba.manifest.json>
  touba manifest generate <air.json> --stdout
  touba handler stub <air.json> [--tool-ref <tool_ref>] [--handler-root <path>] [--force]
  touba version [--json]
  touba update
`);
}
