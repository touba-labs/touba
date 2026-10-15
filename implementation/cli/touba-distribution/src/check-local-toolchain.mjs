#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { packageLocalToolchain } from "./package-local-toolchain.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const implementationRoot = join(currentDir, "../../..");

import { smokeSource, writeSmokeBinding } from "./distribution-smoke.mjs";

try {
  const { toolchainRoot } = packageLocalToolchain();
  checkToolchain(toolchainRoot);
} catch (error) {
  process.stderr.write(`touba distribution check: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function checkToolchain(toolchainRoot) {
  const workspace = mkdtempSync(join(tmpdir(), "touba-toolchain-check-"));
  try {
    const toubaBin = join(toolchainRoot, "bin", process.platform === "win32" ? "touba.cmd" : "touba");
    if (!existsSync(toubaBin)) {
      throw new Error(`missing touba launcher ${toubaBin}`);
    }
    const env = {
      HOME: workspace,
      TMPDIR: workspace,
      PATH: join(toolchainRoot, "bin"),
      TOUBA_DISTRIBUTION_CHANNEL: "local-archive-check",
    };

    const version = runTouba(["version", "--json"], { env });
    const versionReport = JSON.parse(version.stdout);
    assertEqual(versionReport.schemas.air, "touba-air-v1", "AIR schema");
    assertEqual(versionReport.distribution.channel, "local-archive-check", "distribution channel");
    assertEqual(versionReport.commands.doctor, true, "doctor command manifest");

    const doctor = runTouba(["doctor", "--json"], { env });
    const doctorReport = JSON.parse(doctor.stdout);
    assertEqual(doctorReport.status, "ok", "doctor status");
    assertEqual(doctorReport.version.commands.run_profile, true, "doctor run profile command manifest");

    const projectRoot = join(workspace, "project");
    runTouba(["init", "--root", projectRoot], { env });
    assertFile(join(projectRoot, ".touba", "state", "secrets.local.json"));

    const smokeManifest = writeSmokeBinding(projectRoot, join(toolchainRoot, "bin", process.platform === "win32" ? "node.exe" : "node"));
    const sourceDir = join(projectRoot, "src", "examples");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "linear_skill.tb");
    const airPath = join(workspace, "linear_skill.air.json");
    writeFileSync(sourcePath, smokeSource, "utf8");

    runTouba(["compile", sourcePath, "--out", airPath], { env });
    const air = JSON.parse(readFileSync(airPath, "utf8"));
    assertEqual(air.air_schema_version, "touba-air-v1", "compiled AIR schema");

    const inspect = runTouba(["inspect", airPath], { env });
    if (!inspect.stdout.includes("Touba Inspect touba-inspect-v1")) {
      throw new Error("inspect output did not contain the expected header");
    }

    const run = runTouba([
      "run",
      airPath,
      "--inputs-json",
      JSON.stringify({ request: { topic: "distribution" } }),
      "--manifest",
      smokeManifest,
      "--output",
      "trace",
    ], { env });
    const trace = JSON.parse(run.stdout);
    assertEqual(trace.trace_protocol_version, "touba-trace-v1", "trace protocol");
    assertEqual(trace.events.at(-1).payload.status, "success", "runtime status");

    process.stdout.write(`CHECKED ${toolchainRoot}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runTouba(args, options) {
  const env = {
    ...options.env,
    PATH: [options.env.PATH, "/usr/bin", "/bin"].join(delimiter),
  };
  const result = spawnSync("touba", args, {
    cwd: options.cwd ?? implementationRoot,
    env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error([
      `touba ${args.join(" ")} failed with status ${result.status}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
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
