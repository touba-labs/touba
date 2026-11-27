#!/usr/bin/env node
import { compileCommand } from "./compile-command.mjs";
import { runPassthrough } from "./passthrough.mjs";
import { projectAdmissionFailure, requestsJsonRunOutput } from "./run-admission.mjs";
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { satisfies } from "semver";

import {
  checkProjectSecret,
  initProject,
  listProjectSecrets,
  newModule,
  prepareProject,
  removeProjectSecret,
  renderReport,
  resolveProjectRunArgs,
  setProjectSecret,
} from "./project.mjs";
import { packageCommand } from "./package-command.mjs";
import { triggerStateCommand } from "./trigger-state-command.mjs";
import { sdkCommand } from "./sdk-command.mjs";
import { readHostDecisionsFile } from "./host-decisions.mjs";
import {
  checkRegistry,
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
import {
  buildDeploymentBundle,
  deploymentReadinessChecks,
  deploymentTargetRequest,
  verifyDeploymentBundle,
} from "@touba/deployment";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const packageRoot = resolve(currentDir, "..");
const implementationRoot = resolve(currentDir, "../../..");
const args = process.argv.slice(2);

const DOCTOR_SCHEMA_VERSION = "touba-doctor-v1";
const SCHEMA_VERSIONS = Object.freeze({
  air: "touba-air-v1",
  trace: "touba-trace-v1",
  manifest: "touba-manifest-v1",
  secrets: "touba-secrets-v1",
  ownership: "touba-ownership-v1",
  trace_audit: "trace-audit-v1",
  trace_audit_validation: "trace-audit-validation-v1",
  trace_audit_export: "trace-audit-export-v1-local",
  supply_chain_lock: "touba-lock-v1",
  supply_chain_validation: "touba-supply-chain-validation-v1",
  effective_project: "touba-effective-project-v1",
});
const FEATURE_VERSIONS = Object.freeze({
  packages: "touba-package-v1",
  run_profiles: "touba-run-profile-v1",
  human_checkpoints: "touba-human-approval-checkpoint-v1",
  registry_static_resolve: "touba-static-registry-lock-v1",
  mcp_import: "touba-mcp-import-v1",
  rest_scaffold: "touba-rest-scaffold-v1",
  trigger_ingress: "touba-trigger-ingress-v1",
  project_server: "touba-project-server-v1",
  artifact_lifecycle: "touba-artifacts-v1",
  effective_project: "touba-effective-project-v1",
  deployment: "touba-deployment-bundle-v1",
  project_refresh: "touba-project-refresh-v1",
  trace_output: "touba-trace-v1",
});
const PUBLIC_COMMANDS = Object.freeze({
  explore: true,
  sdk: true,
  package: true,
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
  serve: true,
  fleet: true,
  deploy: true,
  refresh: true,
  manifest_generate: true,
  handler_stub: true,
  version: true,
  update_policy: true,
  verified_update: true,
});
const REQUIRED_COMPONENTS = Object.freeze(["cli", "runtime", "inspect", "audit", "supply_chain", "manifest"]);

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
  if (result.signal) {
    // The child has exited and the temporary forwarding listeners are gone.
    // Preserve signal termination for the calling shell/supervisor.
    process.kill(process.pid, result.signal);
  }
} catch (error) {
  if (args[0] === 'state' && args[1] === 'adopt' && args.includes('--json')) {
    process.stdout.write(JSON.stringify({ schema_version: 'touba-state-adoption-error-v1',
      code: typeof error.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,127}$/.test(error.code) ? error.code : 'ToubaStateAdoptionFailed',
      ...(error.code === 'ToubaStateAdoptionStoreUnsupported' && typeof error.store === 'string' && error.store.length <= 240
        && /^(?:state\/)?[A-Za-z0-9_.-]+$/.test(error.store) && !error.store.split('/').some(part => part === '.' || part === '..') ? { store: error.store } : {}) }) + '\n');
  } else if (args[0] === "package" && args.includes("--json")) {
    const { packageConflictDetails } = await import('../../../runtime/touba-handler-sdk/src/package-conflicts.mjs');
    const { packageDiagnostic } = await import('./package-diagnostics.mjs');
    process.stdout.write(`${JSON.stringify({ status: "error", command: `package ${args[1] ?? ""}`.trim(), code: error.code ?? "PackageCommandFailed", constraints: packageConflictDetails(error.constraints), diagnostics: error.diagnostics ?? [{ code: error.code ?? "PackageCommandFailed", message: packageDiagnostic(error) }] })}\n`);
  } else {
    const message = args[0] === 'package'
      ? (await import('./package-diagnostics.mjs')).packageDiagnostic(error)
      : error instanceof Error ? error.message : String(error);
    process.stderr.write(`touba: ${message}\n`);
  }
  process.exitCode = 2;
}

async function dispatch(rawArgs) {
  const [command, ...rest] = rawArgs;
  if (command === 'validation') {
    const { validationPlanCommand } = await import('./validation-plan-command.mjs');
    return validationPlanCommand(rest);
  }
  if (command === "compensation") {
    const { compensationCommand } = await import("./compensation-command.mjs");
    return compensationCommand(rest);
  }
  if (command === "state") {
    const { stateCommand } = await import("./state-command.mjs");
    return stateCommand(rest);
  }
  if (command === "trace") {
    if (rest[0] === "explore") {
      if (process.env.TOUBA_EXPERIMENTAL_TRACE_VIEWER !== "1") {
        throw new Error("The graphical trace viewer is not available in this build. Use touba inspect or touba audit.");
      }
      const { traceExploreCommand } = await import("../../touba-inspect/src/trace-explorer/server.mjs");
      await traceExploreCommand(rest.slice(1));
      return { passthrough: true, exitCode: 0 };
    }
    const { traceCommand } = await import("../../touba-run/src/trace-command.mjs");
    return traceCommand(rest);
  }
  if (command === "explore") {
    const { exploreCommand } = await import("../../touba-inspect/src/explorer/server.mjs");
    await exploreCommand(rest);
    return { passthrough: true, exitCode: 0 };
  }
  if (command === "engine-worker") {
    if (rest.length !== 0) throw new Error("engine-worker accepts only the private SDK protocol");
    const { startEngineWorker } = await import("../../touba-run/src/engine-worker.mjs");
    await startEngineWorker();
    return { passthrough: true, exitCode: 0 };
  }
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
  if (command === "package") return packageCommand(rest);
  if (command === "sdk" && rest.length === 1 && rest[0] === "service") {
    const { servePythonSdk } = await import("../../../runtime/touba-handler-sdk/src/python-service.mjs");
    await servePythonSdk();
    // This private subcommand is a dedicated worker, not an embedded service.
    // EOF closes resources and must not leave an in-flight HTTP client alive.
    process.exit(0);
  }
  if (command === "sdk") return sdkCommand(rest);
  if (command === 'fleet') {
    const { fleetCommand } = await import('../../touba-project-server/src/fleet-command.mjs');
    return fleetCommand(rest);
  }
  if (command === "skill") throw Object.assign(new Error("SkillCommandRemoved: use touba package new <name> --org <organization> --context; migrate skill.json to touba.package.json. No legacy pack is loaded."), { code: "SkillCommandRemoved" });
  if (command === "compile") {
    return compileCommand(rest);
  }
  if (command === "run") {
    return runCommand(rest);
  }
  if (command === "trigger") {
    return triggerCommand(rest);
  }
  if (command === "serve") {
    return serveCommand(rest);
  }
  if (command === "deploy") {
    return deployCommand(rest);
  }
  if (command === "refresh") {
    return refreshCommand(rest);
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
  if (command === "version" || command === "--version" || command === "-v") {
    return versionCommand(rest);
  }
  if (command === "doctor") {
    return doctorCommand(rest);
  }
  if (command === "update") {
    const { updateCommand } = await import("./update/command.mjs");
    return updateCommand(rest, resolve(implementationRoot, ".."));
  }
  process.stderr.write("Unknown command. Run touba --help for available commands.\n");
  return { usage: true, exitCode: 2 };
}

function runCommand(rawArgs) {
  if (rawArgs.length === 0 || rawArgs.includes("--help") || rawArgs.includes("-h")) {
    return { text: runUsage(), exitCode: 0 };
  }
  let profiledArgs;
  try { profiledArgs = resolveProjectRunArgs(rawArgs); }
  catch (error) {
    const refusal = projectAdmissionFailure(error);
    if (!refusal || !requestsJsonRunOutput(rawArgs)) throw error;
    return { text: JSON.stringify(refusal), exitCode: 2 };
  }
  return runNodeScript(["cli", "touba-run", "src", "run.mjs"], profiledArgs);
}

function runUsage() {
  return [
    "Usage: touba run <source.tb|program.air.json> [--profile pure|dev|prod] [runtime options]",
    "       touba run --run-plan <touba.run-plan.json> [runtime options]",
    "       touba run --project <path> [--entry <air-ref>] [--profile pure|dev|prod] [runtime options]",
    "",
    "A .tb input is compiled to temporary AIR before execution.",
    "Project profiles are read from touba.project.json in the current directory.",
    "Project runs default to dev. The explicit prod profile requires touba.lock.json, enables strict supply-chain validation,",
    "and starts agentic decision providers in capabilities mode unless explicitly overridden.",
    "",
    "Common runtime options:",
    "  --manifest <touba.manifest.json>",
    "  --secrets <touba.secrets.json>",
    "  --resource-bindings <touba.resources.json> [--require-resource-bindings]",
    "  --supply-chain-lock <touba.lock.json> [--require-supply-chain-lock]",
    "  --effect-journal <run.effect-journal.sqlite> (durable journal required for external writes)",
    "  --inputs-json <json-object>",
    "  --human-decisions <path> | --human-decisions-json <json-object>",
    "  --human-approval-host <path|pkg:organization.name/host-id> (trusted identity and role attestation)",
    "  --human-approval-authority-timeout-ms <1..60000> (default 5000)",
    "  --trace-pure-functions full|calls (default full)",
    "  --human-checkpoint-out <path> [--human-resume-checkpoint <path>]",
    "  On resume, checkpoint-out saves the next approval pause; earlier instructions are not replayed.",
    "  --user-inputs <path> | --user-inputs-json <json-object> | --interactive-user-inputs",
    "  --cancel-before-dispatch | --cancel-on-pause | --kill-switch-enabled",
    "  --agent-decision-provider <path|pkg:organization.name/host-id>",
    "  --skill-pack <directory> (repeatable; discovery only)",
    "  --activate-skill-pack <skill_pack:namespace/id> (repeatable)",
    "  --skill-pack-discovery-max-bytes <n> --skill-pack-activation-max-bytes <n>",
    "  --agent-model-input-max-bytes <n>",
    "  --max-agent-steps <n> --max-provider-calls <n> --max-tool-calls <n>",
    "  --entry <air-ref>",
    "  --output show|result|trace|all|run-summary|json|json-reference",
    "  --trace-out <path>",
    "  --trace-store <path.sqlite> (durable trace journal)",
    "  --evidence-out <run.evidence.json> [--evidence-ref <label=uri>...]",
    "Exit codes: 0 success, 1 execution/admission error, 2 usage error, 3 pending input/approval, 4 stopped/refused, 5 cancelled.",
  ].join("\n");
}

function triggerCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (["state", "migrate-state", "archive-state", "queue", "migrate-queue", "archive-queue"].includes(subcommand)) return triggerStateCommand(subcommand, tail);
  if (subcommand === "run") {
    return runCommand(tail);
  }
  if (subcommand === "serve") {
    return runNodeScript(["cli", "touba-trigger-service", "src", "serve.mjs"], tail);
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      text: [
        "Usage: touba trigger run <air.json> --manifest <path> --trigger <trigger_ref> --max-runs <n> [--state <path.sqlite>] [--trace-out <path>] [--output show|result|trace|all|run-summary|json]",
        "       touba trigger serve <air.json> --manifest <path> [--state <path.sqlite>] [--queue <path.sqlite>] [--host 127.0.0.1] [--port 8787] [--auth-token-env NAME] [--signature-secret-env NAME] [--max-attempts n]",
        "       touba trigger state <path.sqlite> [--trigger <ref>] [--after <cursor>] [--limit <1..1000>]",
        "       touba trigger migrate-state <old.json> --out <new.sqlite> [--apply]",
        "       touba trigger archive-state <path.sqlite> --before <ISO date> [--out <new.sqlite> --apply]",
        "       touba trigger queue <path.sqlite> [--after <cursor>] [--limit <1..1000>]",
        "       touba trigger migrate-queue <old.json> --out <new.sqlite> [--apply]",
        "       touba trigger archive-queue <path.sqlite> --before <ISO date> [--out <new.sqlite> --apply]",
        "",
        "trigger run accepts the runtime options of touba run, including:",
        "  --secrets <path> --agent-decision-provider <path> --human-approval-host <path>",
        "  --human-checkpoint-out <path> --effect-journal <path.sqlite>",
        "trigger serve supports --secrets <path> and requires --effect-journal <path.sqlite> for external writes.",
        "Use touba trigger serve --help for service options and touba run --help for run options.",
      ].join("\n"),
      exitCode: 0,
    };
  }
  throw new Error(`unknown trigger command ${subcommand}`);
}

function serveCommand(rawArgs) {
  if (rawArgs.length === 1 && (rawArgs[0] === "--help" || rawArgs[0] === "-h")) {
    return {
      text: serveUsage(),
      exitCode: 0,
    };
  }
  return runNodeScript(["cli", "touba-project-server", "src", "serve.mjs"], rawArgs);
}

function serveUsage() {
  return [
    "Usage: touba serve [--project-root <path>] [--secrets <touba.secrets.json>] [--contracts-root <path>] [--human-decisions <human-decisions.sqlite>] [--human-requests <path>] [--change-proposals <path>] [--event-journal <path>] [--event-journal-limit <n>] [--run-summary <path>] [--trace-timeline <path>] [--trigger-status <path>] [--deployment-target-url <url>] [--deployment-target-token-env NAME] [--identity-control-plane-url URL] [--identity-service-token-env NAME] [--host 127.0.0.1] [--port 8791] [--auth-token-env NAME] [--strict] [--quiet]",
    "",
    "Starts the Touba project server for authenticated project clients.",
    "--config touba.server.json loads an explicit, validated server profile from the project; secret values stay in the system vault or host environment.",
    "--identity-service-token-vault reads the project key from the system vault for each authorization, including after rotation.",
    "touba serve login --config touba.server.json --token-stdin stores the service key from standard input; logout removes this project's stored key.",
    "--max-pending-approvals <n> sets pending approval capacity (default 100, maximum 10000).",
    "--schedule-triggers runs enabled schedule entrypoints with the server's reviewed hosts and secrets; inspect and review interruptions through the project client.",
    "--request-triggers admits enabled request triggers on the project listener; --webhook-signature-secret-env NAME supplies the signing secret through the host environment.",
    "--mcp-discovery-config <path> selects a private inventory of approved local MCP servers; discovery requires explicit consent.",
    "--cloud-notifications forwards minimized operational events to the configured Cloud identity service in the background.",
    "--validation-plan <path> authorizes reviewed host test suites for clients, with bounded execution and durable results.",
    "touba validation plan --id <suite> --test <file> [--input <file>] [--engine node|python|package] [--python <absolute-path>] [--out <plan.json>]",
    "  [--kind contract|business|package] [--label <text>] [--tool <tool-ref>] [--env <name>] [--timeout-ms <ms>] [--root <path>]",
    "touba validation plan --refresh [--out <plan.json>] recalculates a reviewed plan's fingerprints without running tests.",
    "  Preview first, then repeat with --apply --review-digest <sha256:...> to write the reviewed plan.",
    "--check-state validates stored state offline, without loading host modules.",
    "--package-registry URL --package-registry-trust FILE enables signed Library previews with local trust.",
    "--trigger-state <path.sqlite> --trigger-queue <path.sqlite> observes existing trigger stores read-only.",
    "--archive-state previews reversible archival of completed state; --apply performs it.",
    "--archive-state --abandon-waits --reason <text> reviews offline abandonment of human waits; --apply requires --review-digest <sha256> from that preview. No effect or decision is executed.",
    "--archive-state --abandon-operations --reason <text> also reviews interrupted operations and incompatible decision claims, after stopped-state, custody and effect checks.",
    "--client-origin <https://host[:port]> authorizes one exact HTTPS browser origin; loopback browser origins need no flag. Authentication remains required.",
    "--restore-state <archive-id> previews restoration; --apply restores without overwriting current state.",
    "",
    "Defaults:",
    "  host: 127.0.0.1",
    "  port: 8791",
    "  secrets: touba.secrets.dev.json when present",
    "  human_decisions: .touba/human-decisions.sqlite",
    "  change_proposals: .touba/studio-change-proposals.json",
    "  event_journal: .touba/project-events.jsonl",
    "  event_journal_limit: 200",
    "  run_summary: .touba/current-run-summary.json",
    "  trace_timeline: .touba/current-trace-timeline.json",
    "  trigger_state: .touba/triggers.sqlite",
    "  trigger_queue: .touba/trigger-queue.sqlite",
    "  trigger_status: .touba/trigger-status.json (optional legacy observation override)",
    "  human_requests: .touba/human-requests.sqlite",
    "",
    "The server exposes versioned project contracts, governed change proposals, deployment revisions and replayable live events.",
    "Sandbox entrypoints are invoked only through the Touba runtime and the authority declared by the project.",
    "",
    "Agent decision provider (trusted host module, never a request field):",
    "  --agent-decision-provider <path|pkg:organization.name/host-id>",
    "  --human-approval-host <path|pkg:organization.name/host-id>",
    "  --human-approval-authority-timeout-ms <1..60000> (default 5000)",
    "  --trace-pure-functions full|calls (default full)",
    "  --agent-decision-provider-metadata-json <json-object>",
    "  --agent-decision-provider-content-mode inline|opaque_refs",
    "  --agent-decision-provider-initial-mode summary|capabilities",
    "  --agent-decision-provider-timeout-ms <positive-integer>",
    "  --agent-decision-provider-max-retries <non-negative-integer>",
    "Run entrypoints: POST /runs/sandbox. Fire triggers: POST /triggers/fire.",
    "  --identity <project-identity.json>  Host-managed touba-product-identity-v1 document inside the project root.",
  ].join("\n");
}

async function deployCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return { text: deployUsage(), exitCode: 0 };
  }
  if (subcommand === "target") {
    const [action, ...targetArgs] = tail;
    if (action !== "serve") {
      throw new Error("usage: touba deploy target serve [target options]");
    }
    return runNodeScript(["cli", "touba-deployment", "src", "serve.mjs"], targetArgs);
  }
  const options = parseDeployOptions(tail);
  if (subcommand === "plan") {
    const bundle = buildDeploymentBundle({
      projectRoot: options.root,
      profile: options.profile,
    });
    verifyDeploymentBundle(bundle);
    return {
      json: true,
      report: deploymentPlanReport(bundle, options.target !== undefined),
      exitCode: 0,
    };
  }
  if (subcommand === "publish") {
    const token = deploymentToken(options);
    const bundle = buildDeploymentBundle({
      projectRoot: options.root,
      profile: options.profile,
    });
    verifyDeploymentBundle(bundle);
    const plan = deploymentPlanReport(bundle, options.target !== undefined);
    if (plan.status !== "ready") {
      const blocked = plan.checks
        .filter((check) => check.status === "blocked")
        .map((check) => check.message)
        .join(" ");
      throw new Error(`deployment blocked: ${blocked}`);
    }
    const published = await deploymentTargetRequest({
      targetUrl: requiredDeployOption(options.target, "--target"),
      token,
      method: "POST",
      path: "/revisions",
      body: {
        bundle,
        published_by: options.actor,
      },
    });
    if (!options.activate) {
      return { json: true, report: published, exitCode: 0 };
    }
    const activated = await deploymentTargetRequest({
      targetUrl: options.target,
      token,
      method: "POST",
      path: `/revisions/${bundle.bundle_sha256}/activate`,
      body: { activated_by: options.actor, expected_state: published.state_digest },
    });
    return { json: true, report: activated, exitCode: 0 };
  }
  if (subcommand === "activate") {
    const token = deploymentToken(options);
    const revision = requiredDeployOption(options.revision, "--revision");
    const state = await deploymentTargetRequest({ targetUrl: requiredDeployOption(options.target, "--target"), token, path: "/revisions" });
    const result = await deploymentTargetRequest({
      targetUrl: requiredDeployOption(options.target, "--target"),
      token,
      method: "POST",
      path: `/revisions/${encodeURIComponent(revision)}/activate`,
      body: { activated_by: options.actor, expected_state: state.state_digest },
    });
    return { json: true, report: result, exitCode: 0 };
  }
  if (subcommand === "rollback") {
    const token = deploymentToken(options);
    const state = await deploymentTargetRequest({ targetUrl: requiredDeployOption(options.target, "--target"), token, path: "/revisions" });
    const result = await deploymentTargetRequest({
      targetUrl: requiredDeployOption(options.target, "--target"),
      token,
      method: "POST",
      path: "/rollback",
      body: { rolled_back_by: options.actor, expected_state: state.state_digest },
    });
    return { json: true, report: result, exitCode: 0 };
  }
  if (subcommand === "list") {
    const token = deploymentToken(options);
    const result = await deploymentTargetRequest({
      targetUrl: requiredDeployOption(options.target, "--target"),
      token,
      path: "/revisions",
    });
    return { json: true, report: result, exitCode: 0 };
  }
  throw new Error(`unknown deploy command ${subcommand}`);
}

function parseDeployOptions(rawArgs) {
  const options = {
    root: process.cwd(),
    profile: "prod",
    actor: "cli:touba",
    activate: false,
  };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--root") options.root = resolve(requiredValue(arg, rawArgs, ++index));
    else if (arg === "--profile") options.profile = requiredValue(arg, rawArgs, ++index);
    else if (arg === "--target") options.target = requiredValue(arg, rawArgs, ++index);
    else if (arg === "--auth-token-env") options.authTokenEnv = requiredValue(arg, rawArgs, ++index);
    else if (arg === "--revision") options.revision = requiredValue(arg, rawArgs, ++index);
    else if (arg === "--actor") options.actor = requiredValue(arg, rawArgs, ++index);
    else if (arg === "--activate") options.activate = true;
    else if (arg === "--json") {
      // Deployment commands always emit their versioned JSON contracts.
    } else {
      throw new Error(`unknown deploy option ${arg}`);
    }
  }
  if (!["dev", "prod"].includes(options.profile)) {
    throw new Error("--profile must be dev or prod");
  }
  return options;
}

function deploymentPlanReport(bundle, targetConfigured) {
  const checks = deploymentReadinessChecks(bundle, { targetConfigured });
  return {
    schema_version: "touba-deployment-plan-v1",
    status: checks.some((item) => item.status === "blocked") ? "blocked" : "ready",
    profile: bundle.profile,
    bundle_id: bundle.bundle_id,
    bundle_sha256: bundle.bundle_sha256,
    artifact_count: bundle.artifacts.length,
    source_revision: bundle.source_revision,
    source_dirty: bundle.source_dirty,
    target_configured: targetConfigured,
    checks,
  };
}

function deploymentToken(options) {
  const envName = requiredDeployOption(options.authTokenEnv, "--auth-token-env");
  const token = process.env[envName];
  if (typeof token !== "string" || token.length < 32) {
    throw new Error(`environment variable ${envName} must contain at least 32 characters`);
  }
  return token;
}

function requiredDeployOption(value, option) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${option} is required`);
  }
  return value.trim();
}

function deployUsage() {
  return [
    "Usage:",
    "  touba deploy plan [--root <path>] [--profile dev|prod] [--target <url>] [--json]",
    "  touba deploy publish --target <url> --auth-token-env NAME [--root <path>] [--profile dev|prod] [--actor <id>] [--activate] [--json]",
    "  touba deploy list --target <url> --auth-token-env NAME [--json]",
    "  touba deploy activate --target <url> --auth-token-env NAME --revision <sha256> [--actor <id>] [--json]",
    "  touba deploy rollback --target <url> --auth-token-env NAME [--actor <id>] [--json]",
    "  touba deploy target serve --storage <path> --auth-token-env NAME [--host 127.0.0.1] [--port 8792] [--tls-cert <path> --tls-key <path>]",
  ].join("\n");
}

async function refreshCommand(rawArgs) {
  const options = parseRefreshOptions(rawArgs);
  if (options.help === true) {
    return {
      text: "Usage: touba refresh --url <touba-serve-url> [--auth-token-env NAME] [--reason <text>]",
      exitCode: 0,
    };
  }
  const endpoint = new URL("/project/refresh", options.url.replace(/\/$/u, ""));
  const headers = { "content-type": "application/json" };
  if (options.authTokenEnv !== undefined) {
    const token = process.env[options.authTokenEnv];
    if (!token || token.trim() === "") {
      throw new Error(`environment variable ${options.authTokenEnv} is required`);
    }
    headers.authorization = `Bearer ${token}`;
  }
  const response = await fetch(endpoint, {
    method: "POST",
    headers,
    body: JSON.stringify({
      schema_version: "touba-project-refresh-request-v1",
      requested_by: { kind: "cli", id: "touba refresh" },
      reason: options.reason,
    }),
  });
  const body = await response.text();
  let report;
  try {
    report = JSON.parse(body);
  } catch {
    throw new Error(`touba refresh received non-JSON response from ${endpoint}`);
  }
  if (report === null || typeof report !== "object" || Array.isArray(report)) {
    throw new Error("touba refresh requires a JSON object response");
  }
  if (!response.ok) {
    const code = report.code ? ` [${report.code}]` : "";
    throw new Error(`touba refresh failed${code}: ${report.message ?? response.status}`);
  }
  if (report.schema_version !== FEATURE_VERSIONS.project_refresh || report.status !== "refreshed") {
    throw new Error("touba refresh received an invalid refresh report");
  }
  return { json: true, report, exitCode: 0 };
}

function parseRefreshOptions(rawArgs) {
  const options = { help: false, reason: "cli-refresh" };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else if (arg === "--url") {
      options.url = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--auth-token-env") {
      options.authTokenEnv = requiredValue(arg, rawArgs, ++index);
    } else if (arg === "--reason") {
      options.reason = requiredValue(arg, rawArgs, ++index);
    } else {
      throw new Error(`unknown refresh option ${arg}`);
    }
  }
  if (options.help !== true && options.url === undefined) {
    throw new Error("touba refresh requires --url <touba-serve-url>");
  }
  if (options.url !== undefined) {
    try {
      const parsed = new URL(options.url);
      if (!["http:", "https:"].includes(parsed.protocol)) {
        throw new Error("unsupported protocol");
      }
    } catch {
      throw new Error("touba refresh --url must be an http(s) URL");
    }
  }
  return options;
}

function inspectCommand(rawArgs) {
  return runNodeScript(["cli", "touba-inspect", "src", "inspect.mjs"], rawArgs);
}

function auditCommand(rawArgs) {
  return runNodeScript(["cli", "touba-audit", "src", "audit.mjs"], rawArgs);
}

function supplyChainCommand(rawArgs) {
  const [subcommand, ...tail] = rawArgs;
  if (subcommand === "generate") {
    return runNodeScript(["cli", "touba-supply-chain", "src", "generate.mjs"], tail);
  }
  if (subcommand === "validate") {
    return runNodeScript(["cli", "touba-supply-chain", "src", "validate.mjs"], tail);
  }
  if (subcommand === undefined || subcommand === "--help" || subcommand === "-h") {
    return {
      text: "Usage: touba supply-chain generate --air <program.air.json> [--air <module.air.json> ...] --manifest <touba.manifest.json> --out <touba.lock.json> [--package-root <relative-dir>] [--file <file> ...]\n       touba supply-chain validate --lock <touba.lock.json> --air <program.air.json> [--manifest <touba.manifest.json>] [--report-out <report.supply-chain-report.json>] [--output text|json] [--strict] [--require-review]",
      exitCode: 0,
    };
  }
  throw new Error(`unknown supply-chain command ${subcommand}`);
}

async function registryCommand(rawArgs) {
  if (rawArgs[0] === "check") {
    if (rawArgs.length === 2 && ["--help", "-h"].includes(rawArgs[1])) {
      return { text: registryCheckUsage(), exitCode: 0 };
    }
    const options = {};
    for (let i = 1; i < rawArgs.length; i++) {
      if (rawArgs[i] === "--json") options.json = true;
      else if (["--registry", "--source-root", "--previous", "--trust"].includes(rawArgs[i]) && rawArgs[i + 1] && !rawArgs[i + 1].startsWith("--")) {
        const key = rawArgs[i] === "--registry" ? "registry" : rawArgs[i] === "--previous" ? "previous" : rawArgs[i] === "--trust" ? "trust" : "sourceRoot";
        options[key] = rawArgs[++i];
      } else throw new Error("usage: touba registry check --registry <directory|URL> [--trust <keys.json>] [--source-root <directory>] [--previous <prior-snapshot>] [--json]");
    }
    const report = await checkRegistry(options);
    return { text: JSON.stringify(report, null, 2), exitCode: report.status === "error" ? 1 : 0 };
  }
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
      text: `${registryResolveUsage()}\n\n${registryCheckUsage()}`,
      exitCode: 0,
    };
  }
  throw new Error(`unknown registry command ${subcommand}`);
}

async function mcpCommand(rawArgs) {
  const [subcommand, configPath, ...tail] = rawArgs;
  if (subcommand === "discover" && configPath && tail.length === 2 && tail[1] === "--confirm-process") {
    const { createMcpDiscovery } = await import("./mcp-discovery.mjs");
    const report = await createMcpDiscovery(configPath).discover({ target: tail[0], confirm_process: true });
    return { report, json: true, exitCode: 0 };
  }
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
      text: "Usage: touba handler stub <air.json> [--language javascript|python] [--tool-ref <tool_ref>] [--handler-root <path>] [--force]",
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

function runNodeScript(relativePath, rawArgs) {
  const scriptPath = join(implementationRoot, ...relativePath);
  if (!existsSync(scriptPath)) {
    throw new Error(`missing Touba script ${scriptPath}`);
  }
  return runPassthrough(process.execPath, [scriptPath, ...rawArgs]);
}

function toubaVersions() {
  const metadataPath = join(implementationRoot, "..", "TOOLCHAIN.json");
  const metadata = existsSync(metadataPath) ? JSON.parse(readFileSync(metadataPath, "utf8")) : null;
  const build = metadata?.build;
  const identified = build?.algorithm === "sha256"
    && build?.identity_scope === "touba-toolchain-content-v1"
    && typeof build?.id === "string" && /^[a-f0-9]{64}$/.test(build.id);
  return {
    cli: readPackageVersion(join(packageRoot, "package.json")),
    runtime: readPackageVersion(join(implementationRoot, "runtime", "touba-runtime", "package.json")),
    inspect: readPackageVersion(join(implementationRoot, "cli", "touba-inspect", "package.json")),
    audit: readPackageVersion(join(implementationRoot, "cli", "touba-audit", "package.json")),
    supply_chain: readPackageVersion(join(implementationRoot, "cli", "touba-supply-chain", "package.json")),
    manifest: readPackageVersion(join(implementationRoot, "cli", "touba-manifest", "package.json")),
    sdk: readPackageVersion(join(implementationRoot, "runtime", "touba-handler-sdk", "package.json")),
    schemas: SCHEMA_VERSIONS,
    features: FEATURE_VERSIONS,
    commands: PUBLIC_COMMANDS,
    build: {
      // Runtime environment variables cannot identify the assembled artifact.
      ...(identified ? { id: build.id, algorithm: build.algorithm, identity_scope: build.identity_scope } : {
        id: !metadata && basename(implementationRoot) === "implementation" ? "source-local" : "unknown",
      }),
      node: process.version,
    },
    distribution: {
      channel: process.env.TOUBA_DISTRIBUTION_CHANNEL ?? "local-development",
      platform: `${process.platform}-${process.arch}`,
      sdk_archive: installedSdkArchive(metadata),
      python_sdk_archive: installedSdkArchive(metadata, "python_sdk"),
    },
  };
}

function installedSdkArchive(metadata, key = "sdk") {
  if (!metadata?.[key]?.archive) return null;
  const archive = resolve(implementationRoot, "..", metadata[key].archive);
  return existsSync(archive) ? archive : null;
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
  const expected = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).engines.node;
  const ok = satisfies(process.versions.node, expected);
  return {
    id: "node_version",
    status: ok ? "ok" : "error",
    message: ok ? `Node ${process.versions.node} satisfies ${expected}` : `Node ${process.versions.node} does not satisfy ${expected}`,
    details: {
      node: process.versions.node,
      expected,
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
    serve: join(implementationRoot, "cli", "touba-project-server", "src", "serve.mjs"),
    deploy: join(implementationRoot, "cli", "touba-deployment", "src", "index.mjs"),
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
    `build ${info.build.id.slice(0, 12)}`,
  ].join("\n");
}

function readPackageVersion(packageJsonPath) {
  try {
    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8"));
    return packageJson.version ?? "unknown";
  } catch {
    return "unknown";
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
    } else if (arg === "--host-decisions" || arg.startsWith("--host-decisions=")) {
      if (options.hostDecisions !== undefined || options.hostDecisionsPath !== undefined) throw new Error("host decisions must be supplied once");
      options.hostDecisionsPath = arg === "--host-decisions" ? requiredValue(arg, rawArgs, ++index)
        : arg.slice("--host-decisions=".length);
    } else if (arg === "--host-decisions-json" || arg.startsWith("--host-decisions-json=")) {
      if (options.hostDecisions !== undefined || options.hostDecisionsPath !== undefined) throw new Error("host decisions must be supplied once");
      const input = arg === "--host-decisions-json" ? requiredValue(arg, rawArgs, ++index)
        : arg.slice("--host-decisions-json=".length);
      try {
        if (Buffer.byteLength(input) > 65536) throw new Error();
        options.hostDecisions = JSON.parse(input);
      } catch { throw new Error("HostDecisionJsonInvalid: expected a JSON object within 64 KiB"); }
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
  if (options.hostDecisionsPath !== undefined) {
    options.hostDecisions = readHostDecisionsFile(resolve(options.root ?? process.cwd(), options.hostDecisionsPath));
    delete options.hostDecisionsPath;
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
    } else if (arg === "--trust") {
      options.trust = requiredValue(arg, rawArgs, ++index);
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
    "       touba mcp discover <targets.json> <target-id> --confirm-process",
    "",
    "Generates reviewable Touba source, manifest fragment, secrets template, handler bridge and import report from an explicit MCP tools snapshot.",
    "Authority remains in manifest, secrets, approvals and runtime policy.",
    "Discovery explicitly starts an operator-approved local stdio server and lists its tools; it never sends tools/call.",
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
    "Usage: touba registry resolve --registry <path-or-url> --package <pkg:organization.name> --version <semver> [--trust <keys.json>] [--source-root <path>] [--allow-draft] [--allow-deprecated] [--generated-on YYYY-MM-DD] [--out <lock.json>] [--json]",
    "",
    "Reads a static registry index and package metadata, verifies metadata digests, optionally verifies source artifact digests, and prints a local lock.",
    "It does not install package content or execute scripts.",
  ].join("\n");
}

function registryCheckUsage() {
  return [
    "Usage: touba registry check --registry <path-or-url> [--trust <keys.json>] [--source-root <path>] [--previous <prior-snapshot>] [--json]",
    "",
    "Validates the registry index, package metadata and available source artifacts. An optional prior snapshot checks published-version immutability.",
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
  touba init [--root <path>] [--language javascript|python]
  touba sdk install javascript|python [--root <path>] [--python <executable>]
  touba sdk path javascript|python
  touba fleet plan|start|upgrade --config <fleet.json> (touba fleet --help)
  touba sdk sandbox javascript|python --handler <path> [--root <path>]
  touba new module <domain.module> [--root <path>] [--force]
  touba package new|check|test|version|pack|checkout|submit|publish|add|list|remove ... (touba package --help)
  touba prepare [--root <path>] [--mode plan|check|write] [--source <file.tb>] [--air <file.air.json>] [--package <touba.package.json>] [--binding-fragment <fragment.json>] [--host-decisions <file.json> | --host-decisions-json <json>] [--resource-bindings <resources.json>] [--require-resource-bindings] [--run-plan <path>] [--ownership <touba.ownership.json>] [--require-ownership] [--entry <air-ref>] [--profile pure|dev|prod] [--manifest <path>] [--handler-root <path>] [--handler-command <path>] [--json]
  touba secret set <HANDLE> [--root <path>] [--store <path>] --value-stdin
  touba secret list [--root <path>] [--store <path>]
  touba secret check <HANDLE> [--root <path>] [--store <path>]
  touba secret remove <HANDLE> [--root <path>] [--store <path>]
  touba compile <source.tb> --out <program.air.json>
  touba compile <source.tb> --stdout
  touba run (<source.tb|program.air.json> | --project <path> | --run-plan <path>) [--profile pure|dev|prod] [runtime options]
  touba trace read --store <traces.sqlite> --reference-json <json> [--after <n>] [--limit <1..1000>]
  touba trace export --store <traces.sqlite> --postgres-env <NAME> [--watch] [--batch-size <1..1000>]
  touba state migrate <kind> <source.json> --out <new.sqlite> [--apply]
  touba state list effects|compensations <path.sqlite> [--after <cursor>] [--limit <1..1000>]
  touba compensation create|resume --air <air.json> --manifest <manifest.json> --effect-journal <journal.effect-journal.sqlite> --store <compensations.sqlite> --authority-host <host.mjs|host.py> --request-json <json>
  touba serve [--project-root <path>] [--contracts-root <path>] [--human-decisions <human-decisions.sqlite>] [--human-requests <path>] [--change-proposals <path>] [--event-journal <path>] [--event-journal-limit <n>] [--run-summary <path>] [--trace-timeline <path>] [--trigger-status <path>] [--identity-control-plane-url URL] [--identity-service-token-env NAME] [--host 127.0.0.1] [--port 8791] [--auth-token-env NAME] [--strict]
  touba deploy plan|publish|list|activate|rollback|target ...
  touba refresh --url <touba-serve-url> [--auth-token-env NAME] [--reason <text>]
  touba trigger run <program.air.json> --manifest <path> --trigger <trigger_ref> --max-runs <n> [--state <path.sqlite>]
  touba trigger serve <program.air.json> --manifest <path> [--state <path.sqlite>] [--queue <path.sqlite>] [--auth-token-env NAME] [--signature-secret-env NAME] [--max-attempts n]
  touba inspect <artifact> [inspect options] [--report-out <report.inspect.txt>]
  touba explore [project] [--port <number>] [--no-open]
  touba audit --trace <trace.json> [--air <air.json>] [--source <file.tb>] [--manifest <touba.manifest.json>] [--audit-manifest <trace-audit.json>] [--export <export.json>] [--report-out <report.trace-audit-report.json>] [--timeline-out <timeline.trace-timeline.json>] [--output text|json]
  touba supply-chain validate --lock <touba.lock.json> --air <program.air.json> [--manifest <touba.manifest.json>] [--report-out <report.supply-chain-report.json>] [--output text|json] [--strict] [--require-review]
  touba supply-chain generate --air <program.air.json> [--air <module.air.json> ...] --manifest <touba.manifest.json> --out <touba.lock.json> [--package-root <relative-dir>] [--file <file> ...] [--entrypoint-arg <index|command>]
  touba registry resolve --registry <path-or-url> --package <pkg:organization.name> --version <semver> [--trust <keys.json>] [--source-root <path>] [--allow-draft] [--allow-deprecated] [--generated-on YYYY-MM-DD] [--out <lock.json>] [--json]
  touba registry check --registry <path-or-url> [--trust <keys.json>] [--source-root <path>] [--previous <prior-snapshot>] [--json]
  touba mcp import <config.json> --module <module.name> --out <dir> [--mode plan|write|check] [--select <tool>] [--force] [--json]
  touba rest scaffold <config.json> --module <module.name> --out <dir> [--mode plan|write|check] [--force] [--json]
  touba manifest generate <air.json> --out <touba.manifest.json>
  touba manifest generate <air.json> --stdout
  touba handler stub <air.json> [--language javascript|python] [--tool-ref <tool_ref>] [--handler-root <path>] [--force]
  touba version [--json]
  touba doctor [--json]
  touba update [--check | --rollback] [--yes] [--json]
`);
}
