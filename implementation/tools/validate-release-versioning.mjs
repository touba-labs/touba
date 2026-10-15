#!/usr/bin/env node
import {
  existsSync,
  readdirSync,
  readFileSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_VERSIONING_SCHEMA_VERSION = "touba-release-versioning-report-v1";

const RELEASE_INDEX_SCHEMA_VERSION = "touba-release-index-v1";
const RELEASE_STATUSES = new Set(["planned", "candidate", "published", "retired", "yanked"]);
const CHANNELS = new Set(["github_release", "touba_hub"]);
const PUBLIC_PLATFORMS = Object.freeze(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);
const SEMVER_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/;
const DATE_PATTERN = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
const RELEASE_NOTE_REQUIRED_HEADINGS = Object.freeze([
  "Executive Summary",
  "Added",
  "Changed",
  "Fixed",
  "Security And Governance",
  "Breaking Changes",
  "Migration",
  "Validation Evidence",
  "Known Limits",
]);

export function buildReleaseVersioningReport(options = {}) {
  const implementationRoot = resolve(options.implementationRoot ?? new URL("..", import.meta.url).pathname);
  const repoRoot = resolve(options.repoRoot ?? join(implementationRoot, ".."));
  const expectedVersion = options.expectedVersion;
  const diagnostics = [];

  const rootPackage = readJson(join(implementationRoot, "package.json"), diagnostics);
  const releaseIndex = readJson(join(implementationRoot, "release", "releases.json"), diagnostics);
  const packageVersions = collectPackageVersions(implementationRoot, diagnostics);

  validateReleaseIndex(releaseIndex, diagnostics, implementationRoot);
  validateExpectedVersion({ expectedVersion, rootPackage, releaseIndex, diagnostics });
  validatePackageVersions({ packageVersions, currentVersion: releaseIndex?.current_version, diagnostics });
  validateChangelog({ repoRoot, currentVersion: releaseIndex?.current_version, diagnostics });
  validateWorkflow({ repoRoot, diagnostics });

  return {
    schema_version: RELEASE_VERSIONING_SCHEMA_VERSION,
    product: "touba",
    current_version: releaseIndex?.current_version ?? "unknown",
    expected_version: expectedVersion ?? null,
    status: diagnostics.some((item) => item.severity === "error") ? "failed" : "ok",
    diagnostics,
    summary: {
      package_count: packageVersions.length,
      release_version_count: Array.isArray(releaseIndex?.versions) ? releaseIndex.versions.length : 0,
      public_platforms: PUBLIC_PLATFORMS,
    },
  };
}

export function parseReleaseVersioningArgs(rawArgs) {
  const options = { pretty: true };
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--version") {
      options.expectedVersion = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--version=")) {
      options.expectedVersion = valueFromEquals(arg, "--version");
    } else if (arg === "--compact") {
      options.pretty = false;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function validateReleaseIndex(index, diagnostics, implementationRoot) {
  if (!isObject(index)) {
    diagnostics.push(error("ReleaseIndexInvalid", "release/releases.json must be a JSON object", "release/releases.json"));
    return;
  }
  if (index.schema_version !== RELEASE_INDEX_SCHEMA_VERSION) {
    diagnostics.push(error("ReleaseIndexSchemaMismatch", `schema_version must be ${RELEASE_INDEX_SCHEMA_VERSION}`, "release/releases.json"));
  }
  validateSemver(index.current_version, "current_version", "release/releases.json", diagnostics);
  if (!Array.isArray(index.platforms)) {
    diagnostics.push(error("ReleaseIndexSchemaMismatch", "platforms must be an array", "release/releases.json"));
  } else {
    for (const platform of PUBLIC_PLATFORMS) {
      if (!index.platforms.includes(platform)) {
        diagnostics.push(error("ReleasePlatformMissing", `platforms must include ${platform}`, "release/releases.json"));
      }
    }
  }
  if (!Array.isArray(index.versions) || index.versions.length === 0) {
    diagnostics.push(error("ReleaseIndexSchemaMismatch", "versions must be a non-empty array", "release/releases.json"));
    return;
  }

  const seenVersions = new Set();
  let currentEntry = null;
  for (const [entryIndex, entry] of index.versions.entries()) {
    const label = `versions[${entryIndex}]`;
    if (!isObject(entry)) {
      diagnostics.push(error("ReleaseIndexSchemaMismatch", `${label} must be an object`, "release/releases.json"));
      continue;
    }
    validateSemver(entry.version, `${label}.version`, "release/releases.json", diagnostics);
    if (entry.tag !== `v${entry.version}`) {
      diagnostics.push(error("ReleaseTagMismatch", `${label}.tag must be v${entry.version}`, "release/releases.json"));
    }
    if (typeof entry.status !== "string" || !RELEASE_STATUSES.has(entry.status)) {
      diagnostics.push(error("ReleaseStatusInvalid", `${label}.status is invalid`, "release/releases.json"));
    }
    if (seenVersions.has(entry.version)) {
      diagnostics.push(error("ReleaseVersionDuplicate", `version ${entry.version} is listed more than once`, "release/releases.json"));
    }
    seenVersions.add(entry.version);
    if (entry.version === index.current_version) {
      currentEntry = entry;
    }
    validateChannels(entry, label, diagnostics);
    validateReleaseEntryDocumentation(entry, label, implementationRoot, diagnostics);
    validateArtifacts(entry, label, diagnostics);
    validateRetirement(entry, label, diagnostics);
  }

  if (currentEntry === null) {
    diagnostics.push(error("CurrentReleaseMissing", `current version ${index.current_version} is not listed`, "release/releases.json"));
  } else if (currentEntry.status === "retired" || currentEntry.status === "yanked") {
    diagnostics.push(error("CurrentReleaseRetired", `current version ${index.current_version} cannot be ${currentEntry.status}`, "release/releases.json"));
  }
}

function validateReleaseEntryDocumentation(entry, label, implementationRoot, diagnostics) {
  if (entry.status === "published" || entry.status === "retired" || entry.status === "yanked") {
    if (typeof entry.released_on !== "string" || !DATE_PATTERN.test(entry.released_on)) {
      diagnostics.push(error("ReleaseDateInvalid", `${label}.released_on must be YYYY-MM-DD for published releases`, "release/releases.json"));
    }
  }
  validateNonEmptyString(entry.summary, `${label}.summary`, "release/releases.json", diagnostics);
  validateStringArray(entry.breaking_changes, `${label}.breaking_changes`, "release/releases.json", diagnostics);
  if (entry.migration_guide !== null && entry.migration_guide !== undefined && typeof entry.migration_guide !== "string") {
    diagnostics.push(error("ReleaseMigrationGuideInvalid", `${label}.migration_guide must be a string or null`, "release/releases.json"));
  }
  validateStringArray(entry.evidence, `${label}.evidence`, "release/releases.json", diagnostics);
  if (entry.compare_url !== null && entry.compare_url !== undefined) {
    validateUrl(entry.compare_url, `${label}.compare_url`, "release/releases.json", diagnostics);
  }
  if (typeof entry.release_notes !== "string" || entry.release_notes.trim() === "") {
    diagnostics.push(error("ReleaseNotesMissing", `${label}.release_notes is required`, "release/releases.json"));
    return;
  }
  const notePath = resolve(implementationRoot, entry.release_notes);
  if (!notePath.startsWith(`${implementationRoot}${sep}`)) {
    diagnostics.push(error("ReleaseNotesPathInvalid", `${label}.release_notes must stay inside implementation/`, "release/releases.json"));
    return;
  }
  if (!existsSync(notePath)) {
    diagnostics.push(error("ReleaseNotesMissing", `${entry.release_notes} does not exist`, entry.release_notes));
    return;
  }
  const note = readFileSync(notePath, "utf8");
  if (!new RegExp(`^#\\s+Touba\\s+${escapeRegExp(entry.version)}\\s*$`, "mu").test(note)) {
    diagnostics.push(error("ReleaseNotesTitleMismatch", `${entry.release_notes} must start with '# Touba ${entry.version}'`, entry.release_notes));
  }
  for (const heading of RELEASE_NOTE_REQUIRED_HEADINGS) {
    if (!new RegExp(`^##\\s+${escapeRegExp(heading)}\\s*$`, "mu").test(note)) {
      diagnostics.push(error("ReleaseNotesSectionMissing", `${entry.release_notes} must contain section '${heading}'`, entry.release_notes));
    }
  }
}

function validateChannels(entry, label, diagnostics) {
  if (!Array.isArray(entry.channels) || entry.channels.length === 0) {
    diagnostics.push(error("ReleaseChannelsInvalid", `${label}.channels must be a non-empty array`, "release/releases.json"));
    return;
  }
  for (const channel of entry.channels) {
    if (!CHANNELS.has(channel)) {
      diagnostics.push(error("ReleaseChannelsInvalid", `${label}.channels contains unsupported channel ${channel}`, "release/releases.json"));
    }
  }
}

function validateArtifacts(entry, label, diagnostics) {
  if (!Array.isArray(entry.artifacts) || entry.artifacts.length === 0) {
    diagnostics.push(error("ReleaseArtifactsInvalid", `${label}.artifacts must be a non-empty array`, "release/releases.json"));
    return;
  }
  for (const platform of PUBLIC_PLATFORMS) {
    const expected = `touba-v${entry.version}-${platform}.tar.gz`;
    if (!entry.artifacts.includes(expected)) {
      diagnostics.push(error("ReleaseArtifactMissing", `${label}.artifacts must include ${expected}`, "release/releases.json"));
    }
  }
  for (const artifact of ["SHA256SUMS", "CHECKSUMS.json"]) {
    if (!entry.artifacts.includes(artifact)) {
      diagnostics.push(error("ReleaseArtifactMissing", `${label}.artifacts must include ${artifact}`, "release/releases.json"));
    }
  }
}

function validateNonEmptyString(value, label, path, diagnostics) {
  if (typeof value !== "string" || value.trim() === "") {
    diagnostics.push(error("ReleaseFieldInvalid", `${label} must be a non-empty string`, path));
  }
}

function validateStringArray(value, label, path, diagnostics) {
  if (!Array.isArray(value)) {
    diagnostics.push(error("ReleaseFieldInvalid", `${label} must be an array`, path));
    return;
  }
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string" || item.trim() === "") {
      diagnostics.push(error("ReleaseFieldInvalid", `${label}[${index}] must be a non-empty string`, path));
    }
  }
}

function validateUrl(value, label, path, diagnostics) {
  if (typeof value !== "string" || value.trim() === "") {
    diagnostics.push(error("ReleaseFieldInvalid", `${label} must be a URL string or null`, path));
    return;
  }
  try {
    new URL(value);
  } catch {
    diagnostics.push(error("ReleaseFieldInvalid", `${label} must be a valid URL`, path));
  }
}

function validateRetirement(entry, label, diagnostics) {
  const retirement = entry.retirement;
  if (!isObject(retirement) || typeof retirement.status !== "string") {
    diagnostics.push(error("ReleaseRetirementInvalid", `${label}.retirement.status is required`, "release/releases.json"));
    return;
  }
  if (entry.status === "retired" || entry.status === "yanked") {
    for (const field of ["decided_by", "decided_on", "reason"]) {
      if (typeof retirement[field] !== "string" || retirement[field].trim() === "") {
        diagnostics.push(error("ReleaseRetirementInvalid", `${label}.retirement.${field} is required for retired or yanked versions`, "release/releases.json"));
      }
    }
  }
}

function validateExpectedVersion({ expectedVersion, rootPackage, releaseIndex, diagnostics }) {
  if (expectedVersion !== undefined && expectedVersion !== releaseIndex?.current_version) {
    diagnostics.push(error("ExpectedVersionMismatch", `expected ${expectedVersion} but release index current_version is ${releaseIndex?.current_version}`, "release/releases.json"));
  }
  if (rootPackage?.version !== releaseIndex?.current_version) {
    diagnostics.push(error("RootPackageVersionMismatch", `implementation package version ${rootPackage?.version} must match current_version ${releaseIndex?.current_version}`, "package.json"));
  }
}

function validatePackageVersions({ packageVersions, currentVersion, diagnostics }) {
  for (const item of packageVersions) {
    // This standalone package is released independently of the CLI workspace.
    // Its version still passes the semver validation in collectPackageVersions.
    if (item.relative_path === "contracts/package.json" && item.name === "@touba/machine-conformance") continue;
    if (item.version !== currentVersion) {
      diagnostics.push(error("PackageVersionMismatch", `${item.relative_path} version ${item.version} must match ${currentVersion}`, item.relative_path));
    }
  }
}

function validateChangelog({ repoRoot, currentVersion, diagnostics }) {
  const changelogPath = join(repoRoot, "CHANGELOG.md");
  if (!existsSync(changelogPath)) {
    diagnostics.push(error("ChangelogMissing", "CHANGELOG.md is required for public releases", "CHANGELOG.md"));
    return;
  }
  const changelog = readFileSync(changelogPath, "utf8");
  if (!new RegExp(`^##\\s+${escapeRegExp(currentVersion)}\\b`, "mu").test(changelog)) {
    diagnostics.push(error("ChangelogVersionMissing", `CHANGELOG.md must contain a section for ${currentVersion}`, "CHANGELOG.md"));
  }
}

function validateWorkflow({ repoRoot, diagnostics }) {
  const releaseWorkflow = join(repoRoot, ".github", "workflows", "release.yml");
  if (!existsSync(releaseWorkflow)) {
    diagnostics.push(error("ReleaseWorkflowMissing", ".github/workflows/release.yml is required", ".github/workflows/release.yml"));
    return;
  }
  const source = readFileSync(releaseWorkflow, "utf8");
  for (const term of ["workflow_dispatch", "gh release", "assemble-release-assets", "package:release --public", "GITHUB_REF_TYPE", "refs/tags/", "--verify-tag", "--draft", "Release already exists"]) {
    if (!source.includes(term)) {
      diagnostics.push(error("ReleaseWorkflowIncomplete", `.github/workflows/release.yml must include ${term}`, ".github/workflows/release.yml"));
    }
  }
  if (source.includes("--clobber") || /gh\s+release\s+upload/.test(source)) {
    diagnostics.push(error("MutableReleaseWorkflow", "Release workflow must never replace existing assets", ".github/workflows/release.yml"));
  }
}

function collectPackageVersions(root, diagnostics) {
  const packages = [];
  for (const path of collectFiles(root)) {
    if (!path.endsWith(`${sep}package.json`) && !path.endsWith("/package.json")) {
      continue;
    }
    const rel = toPosix(relative(root, path));
    if (isIgnoredPackage(rel)) {
      continue;
    }
    const parsed = readJson(path, diagnostics);
    if (!isObject(parsed)) {
      continue;
    }
    if (typeof parsed.version !== "string" || !SEMVER_PATTERN.test(parsed.version)) {
      diagnostics.push(error("PackageVersionInvalid", `${rel} must contain a semver-like version`, rel));
      continue;
    }
    packages.push({
      relative_path: rel,
      name: parsed.name ?? null,
      version: parsed.version,
    });
  }
  packages.sort((left, right) => left.relative_path.localeCompare(right.relative_path));
  return packages;
}

function isIgnoredPackage(relativePath) {
  return [
    "node_modules/",
    "dist/",
    "target/",
    ".vscode-test/",
    ".git/",
  ].some((prefix) => relativePath.startsWith(prefix));
}

function collectFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    if (["node_modules", "dist", "target", ".vscode-test", ".git"].includes(entry.name)) {
      continue;
    }
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function readJson(path, diagnostics) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    diagnostics.push(errorDiagnostic("JsonReadFailed", `cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`, path));
    return null;
  }
}

function validateSemver(value, label, path, diagnostics) {
  if (typeof value !== "string" || !SEMVER_PATTERN.test(value)) {
    diagnostics.push(error("ReleaseVersionInvalid", `${label} must be semver-like`, path));
  }
}

function error(code, message, path) {
  return errorDiagnostic(code, message, path);
}

function errorDiagnostic(code, message, path) {
  return {
    severity: "error",
    code,
    message,
    path,
  };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function toPosix(path) {
  return path.split(sep).join("/");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function requiredValue(flag, args, index) {
  const value = args[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function valueFromEquals(arg, flag) {
  const value = arg.slice(`${flag}=`.length);
  if (value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage() {
  return "Usage: validate-release-versioning [--version <x.y.z>] [--compact]";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseReleaseVersioningArgs(process.argv.slice(2));
    if (options.help === true) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const report = buildReleaseVersioningReport(options);
      process.stdout.write(`${JSON.stringify(report, null, options.pretty ? 2 : 0)}\n`);
      if (report.status !== "ok") {
        process.exitCode = 1;
      }
    }
  } catch (error) {
    process.stderr.write(`touba release versioning: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
