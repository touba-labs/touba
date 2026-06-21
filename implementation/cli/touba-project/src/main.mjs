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
import {
  renderRegistryResolution,
  resolveRegistryPackage,
} from "./registry.mjs";
import {
  importMcpTools,
  renderMcpImportReport,
} from "./mcp-import.mjs";
import {
  renderRestScaffoldReport,
  scaffoldRestTool,
} from "./rest-scaffold.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const packageRoot = resolve(currentDir, "..");
const implementationRoot = resolve(currentDir, "../../..");
const args = process.argv.slice(2);

const TOUBA_VERSION = "0.1.0";
const DOCTOR_SCHEMA_VERSION = "touba-doctor-v0.1";
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
const FEATURE_VERSIONS = Object.freeze({
  run_profiles: "touba-run-profile-v0.1",
  human_checkpoints: "touba-run-checkpoint-v0.1",
  registry_static_resolve: "touba-static-registry-lock-v0.1",
  mcp_import: "touba-mcp-import-v0.1",
  rest_scaffold: "touba-rest-scaffold-v0.1",
  trigger_ingress: "touba-trigger-ingress-v0.1",
  trace_output: "trace-minimal-v0.1",
});
const PUBLIC_COMMANDS = Object.freeze({
  compile: true,
  run: true,
  run_profile: true,
  doctor: true,
  trigger_run: true,
  trigger_serve: true,
  inspect: true,
  audit: true,
  supply_chain_validate: true,
  registry_resolve: true,
  mcp_import: true,
  rest_scaffold: true,
  manifest_generate: true,
  handler_stub: true,
  version: true,
  update_policy: true,
});
const REQUIRED_COMPONENTS = Object.freeze(["cli", "runtime", "inspect", "audit", "supply_chain", "manifest"]);
const TOUBA_HUB_URL = "https://pap-touba.github.io/documentation-site/hub/";
const TOUBA_INSTALLATION_GUIDE_URL = "https://pap-touba.github.io/documentation-site/docs/demarrer/installation";
const TOUBA_RELEASE_BASE_URL = "https://github.com/pap-touba/touba/releases/download";
const UPDATE_PLATFORM_PROFILES = Object.freeze({
  "darwin-arm64": Object.freeze({
    label: "macOS Apple Silicon",
    installer: "sh",
  }),
  "darwin-x64": Object.freeze({
    label: "macOS Intel",
    installer: "sh",
  }),
  "linux-x64": Object.freeze({
    label: "Linux x64",
    installer: "sh",
  }),
  "win32-x64": Object.freeze({
    label: "Windows x64",
    installer: "powershell",
  }),
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
  if (command === "registry") {
    return registryCommand(rest);
  }
  if (command === "mcp") {
    return mcpCommand(rest);
  }
  if (command === "rest") {
    return restCommand(rest);
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
  if (command === "doctor") {
    return doctorCommand(rest);
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
  if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    return { text: runUsage(), exitCode: 0 };
  }
  const profiledArgs = applyRunProfileToArgs(rawArgs);
  return runNodeScript(["cli", "touba-run", "src", "run.mjs"], profiledArgs);
}

function runUsage() {
  return [
    "Usage: touba run <program.air.json> [--profile dev|prod] [runtime options]",
    "",
    "Project profiles are read from touba.project.json in the current directory.",
    "The default prod profile requires touba.lock.json and enables strict supply-chain validation before dispatch.",
    "",
    "Common runtime options:",
    "  --manifest <touba.manifest.json>",
    "  --secrets <touba.secrets.json>",
    "  --resource-bindings <touba.resources.json> [--require-resource-bindings]",
    "  --supply-chain-lock <touba.lock.json> [--require-supply-chain-lock]",
    "  --inputs-json <json-object>",
    "  --human-decisions <path> | --human-decisions-json <json-object>",
    "  --human-checkpoint-out <path> | --human-resume-checkpoint <path>",
    "  --agent-decision-provider <path>",
    "  --max-agent-steps <n> --max-provider-calls <n> --max-tool-calls <n>",
    "  --entry <air-ref>",
    "  --output show|result|trace|all",
    "  --trace-out <path>",
    "  --evidence-out <run.evidence.json> [--evidence-ref <label=uri>...]",
  ].join("\n");
}

function triggerCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (subcommand === "run") {
    return runCommand(tail);
  }
  if (subcommand === "serve") {
    return runNodeScript(["cli", "touba-trigger-service", "src", "serve.mjs"], tail);
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      text: [
        "Usage: touba trigger run <air.json> --manifest <path> --trigger <trigger_ref> --max-runs <n> --state <touba.trigger-state.json> [--trace-out <path>] [--output show|result|trace|all]",
        "       touba trigger serve <air.json> --manifest <path> --state <touba.trigger-state.json> --queue <touba.trigger-queue.json> [--host 127.0.0.1] [--port 8787] [--auth-token-env NAME] [--signature-secret-env NAME] [--max-attempts n]",
      ].join("\n"),
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

async function registryCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (subcommand === "resolve") {
    const options = parseRegistryResolveOptions(tail);
    if (options.help === true) {
      return { text: registryResolveUsage(), exitCode: 0 };
    }
    const lock = await resolveRegistryPackage(options);
    if (options.out !== undefined) {
      assertJsonOutputPath(options.out, "touba registry resolve --out");
      const outputPath = resolve(options.out);
      mkdirSync(dirname(outputPath), { recursive: true });
      writeFileSync(outputPath, `${JSON.stringify(lock, null, 2)}\n`, "utf8");
    }
    if (options.json === true) {
      return { report: lock, json: true, exitCode: 0 };
    }
    const prefix = options.out === undefined ? "" : `wrote registry lock ${resolve(options.out)}\n`;
    return { text: `${prefix}${renderRegistryResolution(lock)}`, exitCode: 0 };
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      text: registryResolveUsage(),
      exitCode: 0,
    };
  }
  throw new Error(`unknown registry command ${subcommand}`);
}

async function mcpCommand(rawArgs) {
  const [subcommand, configPath, ...tail] = rawArgs;
  if (subcommand === "import" && configPath && configPath !== "--help" && configPath !== "-h") {
    const options = parseMcpImportOptions(tail);
    if (options.help === true) {
      return { text: mcpImportUsage(), exitCode: 0 };
    }
    const report = importMcpTools({ ...options, configPath });
    if (options.json === true) {
      return { report, json: true, exitCode: report.status === "error" ? 1 : 0 };
    }
    return { text: renderMcpImportReport(report), exitCode: report.status === "error" ? 1 : 0 };
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h" || (subcommand === "import" && (configPath === "--help" || configPath === "-h"))) {
    return { text: mcpImportUsage(), exitCode: 0 };
  }
  throw new Error("usage: touba mcp import <config.json> --module <module.name> --out <dir> [--mode plan|write|check] [--select <tool>] [--force] [--json]");
}

async function restCommand(rawArgs) {
  const [subcommand, configPath, ...tail] = rawArgs;
  if (subcommand === "scaffold" && configPath && configPath !== "--help" && configPath !== "-h") {
    const options = parseRestScaffoldOptions(tail);
    if (options.help === true) {
      return { text: restScaffoldUsage(), exitCode: 0 };
    }
    const report = scaffoldRestTool({ ...options, configPath });
    if (options.json === true) {
      return { report, json: true, exitCode: report.status === "error" ? 1 : 0 };
    }
    return { text: renderRestScaffoldReport(report), exitCode: report.status === "error" ? 1 : 0 };
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h" || (subcommand === "scaffold" && (configPath === "--help" || configPath === "-h"))) {
    return { text: restScaffoldUsage(), exitCode: 0 };
  }
  throw new Error("usage: touba rest scaffold <config.json> --module <module.name> --out <dir> [--mode plan|write|check] [--force] [--json]");
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

function assertJsonOutputPath(path, label) {
  if (!path.endsWith(".json")) {
    throw new Error(`${label} requires a .json output path`);
  }
  if (existsSync(path) && statSync(path).isDirectory()) {
    throw new Error(`${label} must target a file, not a directory`);
  }
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

function doctorCommand(rawArgs) {
  const options = parseDoctorOptions(rawArgs);
  if (options.help === true) {
    return {
      text: "Usage: touba doctor [--json]",
      exitCode: 0,
    };
  }
  const report = toubaDoctor();
  if (options.json === true) {
    return {
      text: JSON.stringify(report, null, 2),
      exitCode: report.status === "error" ? 1 : 0,
    };
  }
  return {
    text: renderDoctorText(report),
    exitCode: report.status === "error" ? 1 : 0,
  };
}

function updateCommand(rawArgs) {
  const options = parseUpdateOptions(rawArgs);
  if (options.help === true) {
    return {
      text: "Usage: touba update [--json]",
      exitCode: 0,
    };
  }
  const report = toubaUpdatePolicy();
  if (options.json === true) {
    return {
      text: JSON.stringify(report, null, 2),
      exitCode: 1,
    };
  }
  return {
    text: renderUpdatePolicyText(report),
    exitCode: 1,
  };
}

function parseUpdateOptions(rawArgs) {
  const options = { json: false, help: false };
  for (const arg of rawArgs) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function parseDoctorOptions(rawArgs) {
  const options = { json: false, help: false };
  for (const arg of rawArgs) {
    if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function toubaUpdatePolicy() {
  const versions = toubaVersions();
  const tag = `v${versions.cli}`;
  const platform = versions.distribution.platform;
  const profile = UPDATE_PLATFORM_PROFILES[platform];
  const releaseName = profile === undefined ? null : `touba-${tag}-${platform}`;
  const archiveName = releaseName === null ? null : `${releaseName}.tar.gz`;
  const archiveUrl = archiveName === null ? null : `${TOUBA_RELEASE_BASE_URL}/${tag}/${archiveName}`;
  return {
    update_schema_version: "touba-update-policy-v0.1",
    status: "manual_reinstall_required",
    automatic_update: false,
    installed_version: versions.cli,
    channel: versions.distribution.channel,
    platform,
    platform_label: profile?.label ?? "Unsupported platform",
    hub_url: TOUBA_HUB_URL,
    installation_guide_url: TOUBA_INSTALLATION_GUIDE_URL,
    release_tag: tag,
    expected_archive: archiveName === null
      ? {
        supported: false,
        name: null,
        url: null,
      }
      : {
        supported: true,
        name: archiveName,
        url: archiveUrl,
      },
    reinstall: {
      summary: archiveName === null
        ? "Use Touba Hub to choose a supported archive or build from source for this platform."
        : "Download the expected archive, extract it, then rerun the installer with replacement enabled.",
      commands: reinstallCommands({ archiveName, releaseName, installer: profile?.installer }),
    },
  };
}

function reinstallCommands({ archiveName, releaseName, installer }) {
  if (archiveName === null || releaseName === null) {
    return [];
  }
  if (installer === "powershell") {
    return [
      `tar -xzf ${archiveName}`,
      `powershell -ExecutionPolicy Bypass -File .\\${releaseName}\\install.ps1 -Prefix "$HOME\\.touba" -Force`,
    ];
  }
  return [
    `tar -xzf ${archiveName}`,
    `sh ${releaseName}/install.sh --prefix "$HOME/.touba" --force`,
  ];
}

function renderUpdatePolicyText(report) {
  const lines = [
    "Touba Update",
    `Status: ${report.status}`,
    "Automatic update: unavailable for this channel",
    `Installed version: ${report.installed_version}`,
    `Channel: ${report.channel}`,
    `Platform: ${report.platform}`,
    `Hub: ${report.hub_url}`,
    `Installation guide: ${report.installation_guide_url}`,
  ];
  if (report.expected_archive.supported === true) {
    lines.push(`Expected archive: ${report.expected_archive.name}`);
    lines.push(`Download: ${report.expected_archive.url}`);
    lines.push("Reinstall:");
    for (const command of report.reinstall.commands) {
      lines.push(`  ${command}`);
    }
  } else {
    lines.push("Expected archive: no published archive for this platform");
    lines.push(`Reinstall: ${report.reinstall.summary}`);
  }
  lines.push("No automatic update was performed.");
  return lines.join("\n");
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
    features: FEATURE_VERSIONS,
    commands: PUBLIC_COMMANDS,
    build: {
      id: process.env.TOUBA_BUILD_ID ?? process.env.GITHUB_SHA?.slice(0, 12) ?? "source-local",
      node: process.version,
    },
    distribution: {
      channel: process.env.TOUBA_DISTRIBUTION_CHANNEL ?? "local-development",
      platform: `${process.platform}-${process.arch}`,
    },
  };
}

function toubaDoctor() {
  const version = toubaVersions();
  const checks = [
    checkNodeVersion(),
    checkComponentVersions(version),
    checkCommandSurface(),
    checkCurrentProjectProfiles(),
  ];
  const status = aggregateDoctorStatus(checks);
  return {
    doctor_schema_version: DOCTOR_SCHEMA_VERSION,
    status,
    executable: {
      node: process.execPath,
      cli_entrypoint: process.argv[1] ?? null,
      cwd: process.cwd(),
    },
    version,
    checks,
  };
}

function checkNodeVersion() {
  const [majorText] = process.versions.node.split(".");
  const major = Number.parseInt(majorText, 10);
  const ok = major >= 24 && major < 25;
  return {
    id: "node_version",
    status: ok ? "ok" : "error",
    message: ok ? `Node ${process.versions.node} satisfies >=24 <25` : `Node ${process.versions.node} does not satisfy >=24 <25`,
    details: {
      node: process.versions.node,
      expected: ">=24 <25",
    },
  };
}

function checkComponentVersions(version) {
  const invalid = REQUIRED_COMPONENTS.filter((component) => {
    const value = version[component];
    return value === undefined || value === "unknown" || value === "0.0.0";
  });
  return {
    id: "component_versions",
    status: invalid.length === 0 ? "ok" : "error",
    message: invalid.length === 0
      ? "All public components report concrete versions"
      : `Invalid component versions: ${invalid.join(", ")}`,
    details: Object.fromEntries(REQUIRED_COMPONENTS.map((component) => [component, version[component] ?? "unknown"])),
  };
}

function checkCommandSurface() {
  const requiredScripts = {
    run: join(implementationRoot, "cli", "touba-run", "src", "run.mjs"),
    trigger_serve: join(implementationRoot, "cli", "touba-trigger-service", "src", "serve.mjs"),
    inspect: join(implementationRoot, "cli", "touba-inspect", "src", "inspect.mjs"),
    audit: join(implementationRoot, "cli", "touba-audit", "src", "audit.mjs"),
    supply_chain_validate: join(implementationRoot, "cli", "touba-supply-chain", "src", "validate.mjs"),
    manifest_generate: join(implementationRoot, "cli", "touba-manifest", "src", "generate.mjs"),
    handler_stub: join(implementationRoot, "cli", "touba-manifest", "src", "stub.mjs"),
  };
  const missing = Object.entries(requiredScripts)
    .filter(([, path]) => !existsSync(path))
    .map(([command]) => command);
  return {
    id: "public_command_surface",
    status: missing.length === 0 ? "ok" : "error",
    message: missing.length === 0
      ? "Public command scripts are present"
      : `Missing public command scripts: ${missing.join(", ")}`,
    details: {
      commands: PUBLIC_COMMANDS,
      missing,
    },
  };
}

function checkCurrentProjectProfiles() {
  const configPath = resolve(process.cwd(), "touba.project.json");
  if (!existsSync(configPath)) {
    return {
      id: "project_run_profiles",
      status: "info",
      message: "No touba.project.json in the current directory; --profile requires a Touba project root",
      details: {
        project_config_path: configPath,
        present: false,
      },
    };
  }
  try {
    const config = JSON.parse(readFileSync(configPath, "utf8"));
    const profiles = config?.run_profiles && typeof config.run_profiles === "object" && !Array.isArray(config.run_profiles)
      ? config.run_profiles
      : {};
    const hasDev = profiles.dev !== undefined;
    const hasProd = profiles.prod !== undefined;
    const prodRequiresLock = profiles.prod?.require_supply_chain_lock === true
      && typeof profiles.prod?.supply_chain_lock === "string"
      && profiles.prod.supply_chain_lock.length > 0;
    const ok = hasDev && hasProd && prodRequiresLock;
    return {
      id: "project_run_profiles",
      status: ok ? "ok" : "warning",
      message: ok
        ? "Project declares dev and prod run profiles; prod requires a supply-chain lock"
        : "Project run profiles are present but incomplete for the default V1 dev/prod workflow",
      details: {
        project_config_path: configPath,
        present: true,
        profiles: Object.keys(profiles).sort(),
        prod_requires_supply_chain_lock: prodRequiresLock,
      },
    };
  } catch (error) {
    return {
      id: "project_run_profiles",
      status: "error",
      message: `Cannot read touba.project.json: ${error instanceof Error ? error.message : String(error)}`,
      details: {
        project_config_path: configPath,
        present: true,
      },
    };
  }
}

function aggregateDoctorStatus(checks) {
  if (checks.some((check) => check.status === "error")) {
    return "error";
  }
  if (checks.some((check) => check.status === "warning")) {
    return "warning";
  }
  return "ok";
}

function renderDoctorText(report) {
  const lines = [
    `Touba Doctor ${report.doctor_schema_version}`,
    `Status ${report.status}`,
    `CLI ${report.version.cli}`,
    `Runtime ${report.version.runtime}`,
    `Distribution ${report.version.distribution.channel} ${report.version.distribution.platform}`,
    `Node ${report.version.build.node}`,
    "",
    "Checks",
  ];
  for (const check of report.checks) {
    lines.push(`- ${check.status} ${check.id}: ${check.message}`);
  }
  return lines.join("\n");
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

function parseRegistryResolveOptions(rawArgs) {
  const options = {
    json: false,
    allowDraft: false,
    allowDeprecated: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--registry") {
      options.registry = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--registry=")) {
      options.registry = arg.slice("--registry=".length);
    } else if (arg === "--package") {
      options.packageRef = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--package=")) {
      options.packageRef = arg.slice("--package=".length);
    } else if (arg === "--version") {
      options.version = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--version=")) {
      options.version = arg.slice("--version=".length);
    } else if (arg === "--source-root") {
      options.sourceRoot = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--source-root=")) {
      options.sourceRoot = arg.slice("--source-root=".length);
    } else if (arg === "--out") {
      options.out = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
    } else if (arg === "--allow-draft") {
      options.allowDraft = true;
    } else if (arg === "--allow-deprecated") {
      options.allowDeprecated = true;
    } else if (arg === "--generated-on") {
      options.generatedOn = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--generated-on=")) {
      options.generatedOn = arg.slice("--generated-on=".length);
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function parseMcpImportOptions(rawArgs) {
  const options = {
    json: false,
    mode: "plan",
    selectedTools: [],
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--root") {
      options.root = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--module") {
      options.moduleName = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--module=")) {
      options.moduleName = arg.slice("--module=".length);
    } else if (arg === "--out") {
      options.out = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
    } else if (arg === "--mode") {
      options.mode = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--select") {
      options.selectedTools.push(requiredValue(arg, rawArgs, ++index));
    } else if (arg.startsWith("--select=")) {
      options.selectedTools.push(arg.slice("--select=".length));
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function parseRestScaffoldOptions(rawArgs) {
  const options = {
    root: process.cwd(),
    mode: "plan",
    force: false,
    json: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--root") {
      options.root = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--root=")) {
      options.root = arg.slice("--root=".length);
    } else if (arg === "--module") {
      options.moduleName = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--module=")) {
      options.moduleName = arg.slice("--module=".length);
    } else if (arg === "--out") {
      options.out = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--out=")) {
      options.out = arg.slice("--out=".length);
    } else if (arg === "--mode") {
      options.mode = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--mode=")) {
      options.mode = arg.slice("--mode=".length);
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function mcpImportUsage() {
  return [
    "Usage: touba mcp import <config.json> --module <module.name> --out <dir> [--mode plan|write|check] [--select <tool>] [--force] [--json]",
    "",
    "Generates reviewable Touba source, manifest fragment, secrets template, handler bridge and import report from an explicit MCP tools snapshot.",
    "Authority remains in manifest, secrets, approvals and runtime policy.",
  ].join("\n");
}

function restScaffoldUsage() {
  return [
    "Usage: touba rest scaffold <config.json> --module <module.name> --out <dir> [--mode plan|write|check] [--force] [--json]",
    "",
    "Generates reviewable Touba source, manifest fragment, secrets template, minimal HTTP handler and scaffold report from an explicit REST/OpenAPI operation.",
    "Authority remains in manifest, secrets, approvals and runtime policy.",
  ].join("\n");
}

function registryResolveUsage() {
  return [
    "Usage: touba registry resolve --registry <path-or-url> --package <pkg:namespace/name> --version <semver> [--source-root <path>] [--allow-draft] [--allow-deprecated] [--generated-on YYYY-MM-DD] [--out <lock.json>] [--json]",
    "",
    "Reads a static registry index and package metadata, verifies metadata digests, optionally verifies source artifact digests, and prints a local lock.",
    "It does not install package content or execute scripts.",
  ].join("\n");
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
  touba trigger run <program.air.json> --manifest <path> --trigger <trigger_ref> --max-runs <n> --state <touba.trigger-state.json>
  touba trigger serve <program.air.json> --manifest <path> --state <touba.trigger-state.json> --queue <touba.trigger-queue.json> [--auth-token-env NAME] [--signature-secret-env NAME] [--max-attempts n]
  touba inspect <artifact> [inspect options] [--report-out <report.inspect.txt>]
  touba audit --trace <trace.json> [--air <air.json>] [--source <file.tb>] [--manifest <touba.manifest.json>] [--audit-manifest <trace-audit.json>] [--export <export.json>] [--report-out <report.trace-audit-report.json>] [--output text|json]
  touba supply-chain validate --lock <touba.lock.json> --air <program.air.json> [--manifest <touba.manifest.json>] [--report-out <report.supply-chain-report.json>] [--output text|json] [--strict] [--require-review]
  touba registry resolve --registry <path-or-url> --package <pkg:namespace/name> --version <semver> [--source-root <path>] [--allow-draft] [--allow-deprecated] [--generated-on YYYY-MM-DD] [--out <lock.json>] [--json]
  touba mcp import <config.json> --module <module.name> --out <dir> [--mode plan|write|check] [--select <tool>] [--force] [--json]
  touba rest scaffold <config.json> --module <module.name> --out <dir> [--mode plan|write|check] [--force] [--json]
  touba manifest generate <air.json> --out <touba.manifest.json>
  touba manifest generate <air.json> --stdout
  touba handler stub <air.json> [--tool-ref <tool_ref>] [--handler-root <path>] [--force]
  touba version [--json]
  touba doctor [--json]
  touba update [--json]
`);
}
