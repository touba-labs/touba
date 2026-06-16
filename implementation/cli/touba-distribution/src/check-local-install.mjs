#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import { installLocalToolchain } from "./install-local-toolchain.mjs";
import { packageLocalToolchain } from "./package-local-toolchain.mjs";

try {
  const { toolchainRoot } = packageLocalToolchain();
  checkInstall(toolchainRoot);
} catch (error) {
  process.stderr.write(`touba local install check: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function checkInstall(toolchainRoot) {
  const workspace = mkdtempSync(join(tmpdir(), "touba-install-check-"));
  try {
    const prefix = join(workspace, "prefix");
    const firstInstall = installLocalToolchain({
      source: toolchainRoot,
      prefix,
    });
    assertFile(firstInstall.cli_path);

    const env = {
      HOME: workspace,
      TMPDIR: workspace,
      PATH: [join(prefix, "bin"), "/usr/bin", "/bin"].join(delimiter),
    };
    const version = runTouba(["version", "--json"], env, 0);
    const versionReport = JSON.parse(version.stdout);
    assertEqual(versionReport.distribution.channel, "local-archive", "distribution channel");
    assertEqual(versionReport.commands.doctor, true, "doctor command manifest");

    const doctor = runTouba(["doctor", "--json"], env, 0);
    const doctorReport = JSON.parse(doctor.stdout);
    assertEqual(doctorReport.status, "ok", "doctor status");

    const projectRoot = join(workspace, "project");
    runTouba(["init", "--root", projectRoot], env, 0);
    assertFile(join(projectRoot, ".touba", "secrets.local.json"));

    const update = runTouba(["update"], env, 1);
    if (!update.stdout.includes("Status: manual_reinstall_required")) {
      throw new Error("update command did not explain the local archive policy");
    }
    if (!update.stdout.includes("Expected archive:")) {
      throw new Error("update command did not report the expected archive");
    }

    const secondInstall = installLocalToolchain({
      source: toolchainRoot,
      prefix,
      force: true,
    });
    assertEqual(secondInstall.cli_path, firstInstall.cli_path, "reinstall cli path");
    assertFile(join(prefix, "INSTALLATION.json"));
    const installation = JSON.parse(readFileSync(join(prefix, "INSTALLATION.json"), "utf8"));
    assertEqual(installation.update_policy.includes("manual reinstall"), true, "installation update policy");

    process.stdout.write(`INSTALLED ${prefix}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function runTouba(args, env, expectedStatus) {
  const result = spawnSync("touba", args, {
    env,
    encoding: "utf8",
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
