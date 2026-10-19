#!/usr/bin/env node
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const defaultImplementationRoot = resolve(__dir, "..");

export const RELEASE_READINESS_SCHEMA_VERSION = "touba-release-readiness-v1";

const REQUIRED_SCRIPTS = Object.freeze([
  ["v1_local_validation_command", "validate:v1-local"],
  ["runtime_tests_command", "test:runtime"],
  ["installed_sdk_tests_command", "test:distribution-sdk"],
  ["tutorial_recipes_command", "validate:docs-recipes"],
  ["cli_tests_command", "test:cli"],
  ["release_metadata_tests_command", "test:distribution-release"],
  ["release_versioning_command", "release:versioning"],
  ["release_versioning_tests_command", "test:release-versioning"],
  ["release_packaging_command", "package:touba-release"],
  ["release_archive_smoke_command", "check:touba-release-archive"],
  ["public_docs_validation_command", "validate:docs-user"],
  ["public_boundary_validation_command", "validate:docs-public-boundary"],
]);

const REQUIRED_FILES = Object.freeze([
  ["repository_readme", "../README.md"],
  ["public_changelog", "../CHANGELOG.md"],
  ["source_ci_workflow", "../.github/workflows/source-ci.yml"],
  ["external_user_session_kit", "EXTERNAL-USER-SESSION.md"],
  ["public_release_index", "release/releases.json"],
]);

const VERSIONED_PACKAGES = Object.freeze([
  ["touba", "cli/touba-project/package.json"],
  ["runtime", "runtime/touba-runtime/package.json"],
  ["inspect", "cli/touba-inspect/package.json"],
  ["audit", "cli/touba-audit/package.json"],
  ["supply_chain", "cli/touba-supply-chain/package.json"],
  ["manifest", "cli/touba-manifest/package.json"],
  ["distribution", "cli/touba-distribution/package.json"],
]);

export const OBSERVED_RELEASE_GATES = Object.freeze([
  "fresh_v1_local_validation", "installed_sdk_distribution", "published_tutorial_recipes",
  "p0_delivery", "multi_os_ci_observation", "external_user_validation",
  "public_release_artifacts", "public_distribution_channel", "public_docs_site_deployment",
  "industrial_qualification", "desktop_installers", "dependency_security",
  "publisher_signatures", "documentation_review",
]);
const PLATFORMS = ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"];
export const REQUIRED_V1_TASKS = Object.freeze([
  ...["javascript_sdk_distribution","sdk_project_handlers","sdk_tutorials","lexical_runtime_scopes","compiler_lsp_import_diagnostics","air_trace_admission","runtime_secret_redaction","agent_cycle_finalization","skill_pack_workflows","project_manifest_locks","input_admission_boundaries","cli_sdk_inspection_contracts","unified_v1_workflows"],
  "history_independent_serving", "execution_cost_budgets", "typed_multi_agent_coordination", "executable_adoption_recipes", "industrial_v1_qualification", "sdk_choice_graphical_installers", "python_javascript_sdk_parity",
]);
// Only these tasks have explicitly approved V2 slices. An uncompleted V1
// slice cannot be hidden by marking the whole task deferred.
const SPLIT_V1_TASKS = new Set(["typed_multi_agent_coordination", "industrial_v1_qualification", "python_javascript_sdk_parity"]);
export const INDUSTRIAL_CHECKS = Object.freeze([
  "http_load_matrix", "durability_recovery", "backup_restore", "python_process_performance",
  "shared_provider_budgets", "multi_agent_authority_isolation", "parallel_cancel_resume",
  "installed_industrial_paths",
]);
export const INSTALLER_CHECKS = Object.freeze(["install", "update", "cancel", "corruption_refusal", "path", "sdk_javascript", "sdk_python", "uninstall", "graphical_session"]);

function tutorialInventory(implementationRoot) {
  try { return readdirSync(resolve(implementationRoot, "../docs/tutoriels"))
    .filter(name => name.endsWith(".md") && name !== "README.md").sort(); }
  catch { return []; }
}

function completeTutorials(observation, documents) {
  if (!documents.length || observation.scope !== "all" || observation.live !== true) return false;
  const expected = ["fr", "en"].flatMap(locale => documents.map(document => `${locale}/${document}`)).sort();
  const results = observation.results;
  return Array.isArray(results) && results.length === expected.length
    && observation.total === expected.length && observation.passed === expected.length && observation.failed === 0
    && ["fr", "en"].every(locale => observation.locales?.includes(locale))
    && results.every(row => row.status === "passed" && Number.isInteger(row.commands) && row.commands > 0)
    && results.map(row => `${row.locale}/${row.document}`).sort().every((id, index) => id === expected[index]);
}

// Qualification observations are inputs to this existing report, not a second registry.
// They must be reviewed; structural validation cannot establish that a human test occurred.
function observedGates({ qualification, candidate, implementationVersion, tutorialDocuments, now = Date.now() }) {
  return OBSERVED_RELEASE_GATES.map(id => {
    const observation = qualification?.observations?.[id];
    const gate = { id, required: true, evidence: observation?.evidence ?? [] };
    if (!observation) return { ...gate, status: "blocked", reason: "missing current-candidate observation" };
    let reason;
    if (!candidate || !/^[a-f0-9]{64}$/.test(candidate.sha256 ?? "") || !candidate.source_revision
      || qualification.candidate_sha256 !== candidate.sha256
      || qualification.source_revision !== candidate.source_revision
      || qualification.version !== candidate.version || candidate.version !== implementationVersion) reason = "qualification does not identify this candidate and source revision";
    const time = Date.parse(observation.observed_at);
    if (!Number.isFinite(time) || time > now || now - time > 7 * 86400000) reason = "observation is missing, future-dated or older than seven days";
    if (!Array.isArray(gate.evidence) || !gate.evidence.length || gate.evidence.some(item => typeof item !== "string" || !item.trim())) reason = "missing evidence references";
    if (observation.status !== "satisfied") reason = "observation did not pass";
    if (id === "p0_delivery" && REQUIRED_V1_TASKS.some(task => observation.tasks?.[task] !== "completed"
      && !(SPLIT_V1_TASKS.has(task) && observation.tasks?.[task] === "v1_completed"))) reason = "a required V1 task or V1 slice is not delivered";
    if (["multi_os_ci_observation", "public_release_artifacts"].includes(id)
      && PLATFORMS.some(platform => observation.platforms?.[platform] !== "passed")) reason = "a claimed platform remains unqualified";
    if (id === "installed_sdk_distribution" && PLATFORMS.some(platform => ["javascript", "python"].some(language =>
      observation.sdks?.[platform]?.[language] !== "passed"))) reason = "an installed SDK/platform pair remains unqualified";
    if (id === "published_tutorial_recipes" && !completeTutorials(observation, tutorialDocuments)) reason = "the exact current FR/EN tutorial inventory is not qualified";
    if (id === "industrial_qualification" && INDUSTRIAL_CHECKS.some(check => observation.checks?.[check] !== "passed")) reason = "an industrial qualification check remains open";
    if (id === "desktop_installers" && PLATFORMS.some(platform => INSTALLER_CHECKS.some(check =>
      observation.platforms?.[platform]?.[check] !== "passed"))) reason = "a native installer or graphical session remains unqualified";
    if (id === "publisher_signatures" && ["darwin-arm64", "darwin-x64", "win32-x64"].some(platform =>
      observation.platforms?.[platform] !== "passed")) reason = "a publisher signature/notarization check remains open";
    if (id === "documentation_review" && ["fr", "en"].some(locale => observation.locales?.[locale] !== "passed")) reason = "a documentation review remains open";
    if (id === "public_docs_site_deployment" && observation.restore_test !== "passed") reason = "production backup restoration remains unqualified";
    return { ...gate, status: reason ? "failed" : "satisfied", ...(reason ? { reason } : {}), details: observation };
  });
}

export function identifyReleaseCandidate(path, sourceRevision) {
  const bytes = readFileSync(path);
  const manifest = JSON.parse(bytes);
  const assets = manifest.assets ?? manifest.artifacts;
  if (!Array.isArray(assets) || assets.length === 0) throw new Error("Candidate checksums contain no artifacts");
  const version = manifest.version ?? manifest.touba_version;
  if (!/^[0-9]+\.[0-9]+\.[0-9]+$/.test(version ?? "")) throw new Error("Invalid candidate version");
  const expected = new Set(PLATFORMS.flatMap(platform => [
    `touba-v${version}-${platform}.tar.gz`,
    `touba-v${version}-${platform}-setup.${platform.startsWith("darwin") ? "dmg" : platform === "win32-x64" ? "exe" : "deb"}`,
  ]));
  const seen = new Set();
  for (const asset of assets) {
    const name = asset.name ?? asset.path;
    if (!expected.has(name) || seen.has(name)) throw new Error("Invalid or duplicate candidate artifact name");
    seen.add(name);
    const file = resolve(dirname(path), name);
    if (!lstatSync(file).isFile()) throw new Error("Candidate artifact must be a regular file");
    const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
    if (hash !== asset.sha256) throw new Error("Candidate artifact checksum mismatch: " + name);
  }
  if (seen.size !== expected.size) throw new Error("Candidate must contain all four archives and graphical installers");
  return { sha256: createHash("sha256").update(bytes).digest("hex"), source_revision: sourceRevision,
    version };
}

/**
 * @typedef {"satisfied" | "pending" | "blocked" | "failed"} GateStatus
 * @typedef {{ id: string, status: GateStatus, required: boolean, evidence: string[], reason?: string, details?: Record<string, unknown> }} ReleaseGate
 */

/**
 * @param {{ implementationRoot?: string, packageJson?: Record<string, any>, pathExists?: (relativePath: string) => boolean, readJson?: (relativePath: string) => Record<string, any> }} [options]
 */
export function buildReleaseReadinessReport(options = {}) {
  const implementationRoot = options.implementationRoot ?? defaultImplementationRoot;
  const packageJson = options.packageJson ?? readJsonFile(resolve(implementationRoot, "package.json"));
  const pathExists = options.pathExists ?? ((relativePath) => existsSync(resolve(implementationRoot, relativePath)));
  const readJson = options.readJson ?? ((relativePath) => readJsonFile(resolve(implementationRoot, relativePath)));

  /** @type {ReleaseGate[]} */
  const gates = [
    ...scriptGates(packageJson),
    ...fileGates(pathExists),
    currentReleaseNoteGate(packageJson, pathExists),
    packageVersionGate(readJson),
    ...observedGates({ ...options, implementationVersion: packageJson.version,
      tutorialDocuments: options.tutorialDocuments ?? tutorialInventory(implementationRoot) }),
  ];
  const counts = countGateStatuses(gates);

  return {
    schema_version: RELEASE_READINESS_SCHEMA_VERSION,
    product: "touba",
    release_track: "v1-public",
    implementation_version: packageJson.version ?? "unknown",
    candidate: options.candidate ?? null,
    overall_status: overallStatus(gates),
    gates,
    counts,
  };
}

/**
 * @param {Record<string, any>} packageJson
 * @returns {ReleaseGate[]}
 */
function scriptGates(packageJson) {
  const scripts = packageJson.scripts ?? {};
  return REQUIRED_SCRIPTS.map(([id, scriptName]) => {
    if (typeof scripts[scriptName] === "string" && scripts[scriptName].trim() !== "") {
      return {
        id,
        status: "satisfied",
        required: true,
        evidence: [`implementation/package.json#scripts.${scriptName}`],
      };
    }
    return {
      id,
      status: "failed",
      required: true,
      evidence: [`implementation/package.json#scripts.${scriptName}`],
      reason: `missing package script ${scriptName}`,
    };
  });
}

/**
 * @param {(relativePath: string) => boolean} pathExists
 * @returns {ReleaseGate[]}
 */
function fileGates(pathExists) {
  return REQUIRED_FILES.map(([id, relativePath]) => {
    const evidence = [publicEvidencePath(relativePath)];
    if (pathExists(relativePath)) {
      return {
        id,
        status: "satisfied",
        required: true,
        evidence,
      };
    }
    return {
      id,
      status: "failed",
      required: true,
      evidence,
      reason: `missing required release file ${publicEvidencePath(relativePath)}`,
    };
  });
}

/**
 * @param {Record<string, any>} packageJson
 * @param {(relativePath: string) => boolean} pathExists
 * @returns {ReleaseGate}
 */
function currentReleaseNoteGate(packageJson, pathExists) {
  const version = typeof packageJson.version === "string" ? packageJson.version : "unknown";
  const relativePath = `release/notes/v${version}.md`;
  const evidence = [publicEvidencePath(relativePath)];
  if (version !== "unknown" && pathExists(relativePath)) {
    return {
      id: "current_release_note",
      status: "satisfied",
      required: true,
      evidence,
    };
  }
  return {
    id: "current_release_note",
    status: "failed",
    required: true,
    evidence,
    reason: `missing structured release note ${publicEvidencePath(relativePath)}`,
  };
}

/**
 * @param {(relativePath: string) => Record<string, any>} readJson
 * @returns {ReleaseGate}
 */
function packageVersionGate(readJson) {
  const versions = VERSIONED_PACKAGES.map(([component, relativePath]) => {
    let version = "unknown";
    try {
      version = readJson(relativePath).version ?? "unknown";
    } catch {
      version = "unknown";
    }
    return { component, version };
  });
  const invalid = versions.filter((entry) => entry.version === "unknown" || entry.version === "0.0.0");
  if (invalid.length === 0) {
    return {
      id: "package_versions",
      status: "satisfied",
      required: true,
      evidence: VERSIONED_PACKAGES.map(([, relativePath]) => `implementation/${relativePath}`),
      details: { versions },
    };
  }
  return {
    id: "package_versions",
    status: "failed",
    required: true,
    evidence: VERSIONED_PACKAGES.map(([, relativePath]) => `implementation/${relativePath}`),
    reason: "package versions must not be unknown or 0.0.0 for public release readiness",
    details: { versions, invalid },
  };
}

/**
 * @param {ReleaseGate[]} gates
 */
function overallStatus(gates) {
  if (gates.some((gate) => gate.status === "failed")) {
    return "failed";
  }
  if (gates.some((gate) => gate.status === "blocked")) {
    return "blocked";
  }
  if (gates.some((gate) => gate.status === "pending")) {
    return "pending";
  }
  return "ready";
}

/**
 * @param {ReleaseGate[]} gates
 */
function countGateStatuses(gates) {
  return gates.reduce(
    (counts, gate) => {
      counts[gate.status] += 1;
      return counts;
    },
    { satisfied: 0, pending: 0, blocked: 0, failed: 0 },
  );
}

function publicEvidencePath(relativePath) {
  return relativePath.startsWith("../")
    ? relativePath.slice(3)
    : `implementation/${relativePath}`;
}

function readJsonFile(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

export function parseReleaseReadinessArgs(rawArgs) {
  const options = {
    allowBlocked: false,
    pretty: true,
  };
  for (let index = 0; index < rawArgs.length; index++) {
    const arg = rawArgs[index];
    if (arg === "--") {
      continue;
    }
    if (["--candidate", "--qualification", "--source-revision"].includes(arg)) {
      const value = rawArgs[++index];
      if (!value || value.startsWith("--")) throw new Error("Missing value for " + arg);
      options[arg.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase())] = value;
    } else if (arg === "--allow-blocked") {
      options.allowBlocked = true;
    } else if (arg === "--compact") {
      options.pretty = false;
    } else if (arg === "--pretty") {
      options.pretty = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

export function renderReleaseReadinessReport(report, options = {}) {
  return JSON.stringify(report, null, options.pretty === false ? 0 : 2);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const options = parseReleaseReadinessArgs(process.argv.slice(2));
    if (options.help === true) {
      process.stdout.write(
        [
          "Usage: node tools/release-readiness.mjs [--candidate CHECKSUMS.json --qualification observation.json] [--source-revision SHA] [--allow-blocked] [--pretty|--compact]",
          "",
          "Exits with code 1 unless every required release gate is ready.",
        ].join("\n"),
      );
      process.stdout.write("\n");
    } else {
      const sourceRevision = options.sourceRevision ?? process.env.GITHUB_SHA
        ?? execFileSync("git", ["rev-parse", "HEAD"], { cwd: defaultImplementationRoot, encoding: "utf8" }).trim();
      const candidate = options.candidate ? identifyReleaseCandidate(resolve(options.candidate), sourceRevision) : null;
      const qualification = options.qualification ? readJsonFile(resolve(options.qualification))
        : process.env.TOUBA_RELEASE_QUALIFICATION ? JSON.parse(process.env.TOUBA_RELEASE_QUALIFICATION) : null;
      const report = buildReleaseReadinessReport({ candidate, qualification });
      process.stdout.write(`${renderReleaseReadinessReport(report, options)}\n`);
      process.exitCode = report.overall_status === "ready" || (options.allowBlocked && report.overall_status === "blocked") ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`release-readiness: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
