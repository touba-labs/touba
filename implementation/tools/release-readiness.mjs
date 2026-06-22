#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const defaultImplementationRoot = resolve(__dir, "..");

export const RELEASE_READINESS_SCHEMA_VERSION = "touba-release-readiness-v0.1";

const REQUIRED_SCRIPTS = Object.freeze([
  ["v1_local_validation_command", "validate:v1-local"],
  ["runtime_tests_command", "test:runtime"],
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

const CURRENT_RELEASE_GATES = Object.freeze([
  {
    id: "fresh_v1_local_validation",
    status: "satisfied",
    required: true,
    evidence: [
      "implementation/package.json#scripts.validate:v1-local",
      "implementation/VALIDATION-REPORT.md",
    ],
    details: {
      last_observed_status: "success",
      last_observed_date: "2026-06-13",
    },
  },
  {
    id: "multi_os_ci_observation",
    status: "satisfied",
    required: true,
    evidence: [
      ".github/workflows/source-ci.yml",
      "https://github.com/pap-touba/touba/actions/runs/27456539602",
    ],
    details: {
      last_observed_status: "success",
      last_observed_date: "2026-06-13",
      jobs: {
        "linux-x64-full": "success",
        "macos-intel-core": "success",
        "macos-arm64-core": "success",
        "windows-x64-core": "success",
      },
      release_artifacts: [
        "touba-release-linux-x64",
        "touba-release-darwin-x64",
        "touba-release-darwin-arm64",
        "touba-release-win32-x64",
      ],
    },
  },
  {
    id: "external_user_validation",
    status: "blocked",
    required: true,
    evidence: ["implementation/EXTERNAL-USER-SESSION.md"],
    reason: "an external user must complete the documented installation and first-run session",
  },
  {
    id: "public_release_artifacts",
    status: "satisfied",
    required: true,
    evidence: [
      "implementation/package.json#scripts.package:touba-release",
      "implementation/package.json#scripts.check:touba-release-archive",
      ".github/workflows/source-ci.yml",
      "https://github.com/pap-touba/touba/actions/runs/27456539602",
    ],
    details: {
      run_status: "success",
      run_date: "2026-06-13",
      artifacts: [
        "touba-release-linux-x64",
        "touba-release-darwin-x64",
        "touba-release-darwin-arm64",
        "touba-release-win32-x64",
      ],
      attached_files: [
        "*.tar.gz",
        "SHA256SUMS",
        "CHECKSUMS.json",
        "GITHUB_RELEASE_DRAFT.md",
      ],
      publication: "manual Go/No-Go only",
    },
  },
  {
    id: "public_distribution_channel",
    status: "satisfied",
    required: true,
    evidence: [
      "implementation/release/releases.json",
      ".github/workflows/release.yml",
      "implementation/tools/assemble-release-assets.mjs",
    ],
    details: {
      channel: "github-release",
      publication: "manual workflow_dispatch with preserved GitHub Release assets",
    },
  },
  {
    id: "public_docs_site_deployment",
    status: "blocked",
    required: true,
    evidence: ["https://pap-touba.github.io/documentation-site/"],
    reason: "the public documentation site must be deployed and reachable before V1 public release",
  },
]);

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
    ...CURRENT_RELEASE_GATES,
  ];
  const counts = countGateStatuses(gates);

  return {
    schema_version: RELEASE_READINESS_SCHEMA_VERSION,
    product: "touba",
    release_track: "v1-public",
    implementation_version: packageJson.version ?? "unknown",
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
  for (const arg of rawArgs) {
    if (arg === "--") {
      continue;
    }
    if (arg === "--allow-blocked") {
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
          "Usage: node tools/release-readiness.mjs [--allow-blocked] [--pretty|--compact]",
          "",
          "Exits with code 1 unless every required release gate is ready.",
        ].join("\n"),
      );
      process.stdout.write("\n");
    } else {
      const report = buildReleaseReadinessReport();
      process.stdout.write(`${renderReleaseReadinessReport(report, options)}\n`);
      process.exitCode = report.overall_status === "ready" || options.allowBlocked ? 0 : 1;
    }
  } catch (error) {
    process.stderr.write(`release-readiness: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
