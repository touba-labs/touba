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
    assertEqual(versionReport.schemas.air, "air-minimal-v0.1", "AIR schema");
    assertEqual(versionReport.distribution.channel, "local-archive-check", "distribution channel");

    const projectRoot = join(workspace, "project");
    runTouba(["init", "--root", projectRoot], { env });
    assertFile(join(projectRoot, ".touba", "secrets.local.json"));

    const sourceDir = join(projectRoot, "src", "examples");
    mkdirSync(sourceDir, { recursive: true });
    const sourcePath = join(sourceDir, "linear_skill.tb");
    const airPath = join(workspace, "linear_skill.air.json");
    writeFileSync(sourcePath, smokeSource, "utf8");

    runTouba(["compile", sourcePath, "--out", airPath], { env });
    const air = JSON.parse(readFileSync(airPath, "utf8"));
    assertEqual(air.air_schema_version, "air-minimal-v0.1", "compiled AIR schema");

    const inspect = runTouba(["inspect", airPath], { env });
    if (!inspect.stdout.includes("Touba Inspect touba-inspect-v0.1")) {
      throw new Error("inspect output did not contain the expected header");
    }

    const run = runTouba([
      "run",
      airPath,
      "--inputs-json",
      JSON.stringify({ request: { topic: "distribution" } }),
      "--local-fetch-source-text",
      "distribution smoke source",
      "--output",
      "trace",
    ], { env });
    const trace = JSON.parse(run.stdout);
    assertEqual(trace.trace_protocol_version, "trace-minimal-v0.1", "trace protocol");
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
