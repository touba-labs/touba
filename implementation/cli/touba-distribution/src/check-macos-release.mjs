#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { packageMacosRelease } from "./package-macos-release.mjs";

const smokeSource = `module examples.linear_skill

type SourceRequest
    topic is Text

type SourceText
    content is Text

type SourceNote
    summary is Text

tool FetchSource
    takes request as SourceRequest
    gives SourceText

skill BuildNote
    takes request as SourceRequest
    gives SourceNote
    uses FetchSource
    do
        FetchSource
        give SourceNote

agent Researcher
    uses BuildNote
    callable_by strategy RunSourcedNote

strategy RunSourcedNote
    uses Researcher
    do
        Researcher
        give SourceNote
`;

try {
  const release = packageMacosRelease();
  checkRelease(release);
} catch (error) {
  process.stderr.write(`touba macOS release check: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function checkRelease(release) {
  verifyChecksum(release);
  const workspace = mkdtempSync(join(tmpdir(), "touba-macos-release-check-"));
  try {
    const prefix = join(workspace, "prefix");
    const shellEnv = { ...process.env, HOME: workspace, TMPDIR: workspace };
    runShell(join(release.release_dir, "install.sh"), ["--prefix", prefix, "--force"], 0, shellEnv);
    assertFile(join(prefix, "bin", "touba"));
    assertFile(join(prefix, "INSTALLATION.json"));

    const env = {
      HOME: workspace,
      TMPDIR: workspace,
      PATH: [join(prefix, "bin"), "/usr/bin", "/bin"].join(delimiter),
    };

    const version = runTouba(["version", "--json"], env, 0);
    const versionReport = JSON.parse(version.stdout);
    assertEqual(versionReport.cli, "0.1.0", "CLI version");
    assertEqual(versionReport.runtime, "0.1.0", "runtime version");
    assertEqual(versionReport.inspect, "0.1.0", "inspect version");
    assertEqual(versionReport.audit, "0.1.0", "audit version");
    assertEqual(versionReport.supply_chain, "0.1.0", "supply chain version");
    assertEqual(versionReport.manifest, "0.1.0", "manifest version");
    assertEqual(versionReport.distribution.channel, "macos-local-release", "distribution channel");
    assertEqual(versionReport.distribution.platform, "darwin-arm64", "distribution platform");
    assertEqual(versionReport.commands.doctor, true, "doctor command manifest");

    const doctor = runTouba(["doctor", "--json"], env, 0);
    const doctorReport = JSON.parse(doctor.stdout);
    assertEqual(doctorReport.status, "ok", "doctor status");

    const projectRoot = join(workspace, "project");
    runTouba(["init", "--root", projectRoot], env, 0);
    assertFile(join(projectRoot, ".touba", "secrets.local.json"));

    const setSecret = runTouba([
      "secret",
      "set",
      "DEMO_API_KEY",
      "--root",
      projectRoot,
      "--value-stdin",
    ], env, 0, "dev-only-local-token\n");
    if (setSecret.stdout.includes("dev-only-local-token")) {
      throw new Error("secret value leaked to stdout");
    }
    runTouba(["secret", "check", "DEMO_API_KEY", "--root", projectRoot], env, 0);
    const listSecret = runTouba(["secret", "list", "--root", projectRoot], env, 0);
    if (!listSecret.stdout.includes("DEMO_API_KEY")) {
      throw new Error("secret list did not show DEMO_API_KEY");
    }
    if (listSecret.stdout.includes("dev-only-local-token")) {
      throw new Error("secret value leaked in secret list");
    }

    const sourceDir = join(projectRoot, "src", "examples");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "linear_skill.tb");
    const airPath = join(workspace, "linear_skill.air.json");
    writeFileSync(sourcePath, smokeSource, "utf8");

    runTouba(["compile", sourcePath, "--out", airPath], env, 0);
    const air = JSON.parse(readFileSync(airPath, "utf8"));
    assertEqual(air.air_schema_version, "air-minimal-v0.1", "compiled AIR schema");

    const inspect = runTouba(["inspect", airPath], env, 0);
    if (!inspect.stdout.includes("Touba Inspect touba-inspect-v0.1")) {
      throw new Error("inspect output did not contain the expected header");
    }

    const manifest = runTouba([
      "manifest",
      "generate",
      airPath,
      "--stdout",
      "--handler-command",
      "node",
      "--handler-root",
      "handlers",
    ], env, 0);
    const manifestDocument = JSON.parse(manifest.stdout);
    if (!manifestDocument.bindings["tool:examples.linear_skill/FetchSource"]) {
      throw new Error("generated manifest does not bind FetchSource");
    }

    const prepare = runTouba([
      "prepare",
      "--root",
      projectRoot,
      "--source",
      sourcePath,
      "--mode",
      "write",
      "--handler-command",
      "node",
      "--json",
    ], env, 0);
    const prepareReport = JSON.parse(prepare.stdout);
    assertEqual(prepareReport.status, "success", "prepare status");
    assertFile(join(projectRoot, ".touba", "air", "examples", "linear_skill.air.json"));
    assertFile(join(projectRoot, "touba.manifest.json"));

    const run = runTouba([
      "run",
      airPath,
      "--inputs-json",
      JSON.stringify({ request: { topic: "release" } }),
      "--local-fetch-source-text",
      "release smoke source",
      "--output",
      "trace",
    ], env, 0);
    const trace = JSON.parse(run.stdout);
    assertEqual(trace.trace_protocol_version, "trace-minimal-v0.1", "trace protocol");
    assertEqual(trace.events.at(-1).payload.status, "success", "runtime status");

    const update = runTouba(["update"], env, 1);
    if (!update.stdout.includes("Status: manual_reinstall_required")) {
      throw new Error("update command did not explain the local release policy");
    }
    if (!update.stdout.includes("Expected archive:")) {
      throw new Error("update command did not report the expected archive");
    }

    runShell(join(release.release_dir, "install.sh"), ["--prefix", prefix, "--force"], 0, shellEnv);
    assertFile(join(prefix, "bin", "touba"));

    runShell(join(release.release_dir, "uninstall.sh"), ["--prefix", prefix], 0, shellEnv);
    if (existsSync(join(prefix, "bin", "touba"))) {
      throw new Error("uninstall left bin/touba behind");
    }
    if (existsSync(join(prefix, "touba-toolchain"))) {
      throw new Error("uninstall left touba-toolchain behind");
    }

    process.stdout.write(`CHECKED_RELEASE ${release.tarball_path}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function verifyChecksum(release) {
  const expectedLine = readFileSync(release.checksums_path, "utf8").trim();
  const [expectedHash, artifactName] = expectedLine.split(/\s+/u);
  if (artifactName !== `${release.release_name}.tar.gz`) {
    throw new Error(`checksum file points to ${artifactName}`);
  }
  const actualHash = sha256File(release.tarball_path);
  assertEqual(actualHash, expectedHash, "release archive sha256");
}

function runShell(scriptPath, args, expectedStatus, env) {
  const result = spawnSync("sh", [scriptPath, ...args], {
    encoding: "utf8",
    ...(env ? { env } : {}),
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== expectedStatus) {
    throw new Error([
      `sh ${scriptPath} ${args.join(" ")} exited with status ${result.status}, expected ${expectedStatus}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function runTouba(args, env, expectedStatus, input) {
  const result = spawnSync("touba", args, {
    env,
    encoding: "utf8",
    input,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== expectedStatus) {
    throw new Error([
      `touba ${args.join(" ")} exited with status ${result.status}, expected ${expectedStatus}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function assertFile(path) {
  if (!existsSync(path)) {
    throw new Error(`missing expected file ${path}`);
  }
}

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}
