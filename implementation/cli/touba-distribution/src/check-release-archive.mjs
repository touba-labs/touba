#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  createReleasePlan,
  parsePackageReleaseArgs,
} from "./package-release.mjs";

try {
  const options = parsePackageReleaseArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write("Usage: check-release-archive [--platform <platform>] [--experimental]\n");
  } else {
    checkReleaseArchive(createReleasePlan(options));
  }
} catch (error) {
  process.stderr.write(`touba release archive check: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}

function checkReleaseArchive(plan) {
  assertFile(plan.tarballPath);
  assertFile(plan.checksumsPath);
  assertFile(plan.checksumsJsonPath);
  assertFile(plan.draftPath);
  verifyChecksums(plan);

  const workspace = mkdtempSync(join(tmpdir(), "touba-release-archive-check-"));
  try {
    const extractRoot = join(workspace, "extract");
    const installPrefix = join(workspace, "prefix");
    mkdirSync(extractRoot, { recursive: true });
    runCommand("tar", ["-xzf", plan.tarballPath, "-C", extractRoot]);

    const releaseDir = join(extractRoot, plan.releaseName);
    assertFile(join(releaseDir, "README.txt"));
    assertFile(join(releaseDir, "RELEASE.json"));
    assertFile(join(releaseDir, "install.sh"));
    assertFile(join(releaseDir, "install.ps1"));
    verifyReleaseMetadata(plan, join(releaseDir, "RELEASE.json"));

    if (process.platform === "win32") {
      runCommand("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(releaseDir, "install.ps1"),
        "-Prefix",
        installPrefix,
        "-Force",
      ], { env: releaseEnv(workspace) });
    } else {
      runCommand("sh", [join(releaseDir, "install.sh"), "--prefix", installPrefix, "--force"], {
        env: releaseEnv(workspace),
      });
    }

    const cliPath = join(installPrefix, "bin", process.platform === "win32" ? "touba.cmd" : "touba");
    assertFile(cliPath);
    const version = runTouba(cliPath, ["version", "--json"], releaseEnv(workspace, installPrefix));
    const versionReport = JSON.parse(version.stdout);
    assertEqual(versionReport.cli, plan.toubaVersion, "CLI version");
    assertEqual(versionReport.distribution.channel, plan.channel, "distribution channel");
    assertEqual(versionReport.distribution.platform, plan.platform, "distribution platform");
    assertEqual(versionReport.commands.doctor, true, "doctor command manifest");
    assertEqual(versionReport.commands.run_profile, true, "run profile command manifest");

    const doctor = runTouba(cliPath, ["doctor", "--json"], releaseEnv(workspace, installPrefix));
    const doctorReport = JSON.parse(doctor.stdout);
    assertEqual(doctorReport.status, "ok", "doctor status");
    assertEqual(doctorReport.version.cli, plan.toubaVersion, "doctor CLI version");
    assertEqual(doctorReport.version.commands.supply_chain_validate, true, "doctor supply-chain command manifest");

    const update = runTouba(cliPath, ["update"], releaseEnv(workspace, installPrefix), 1);
    if (!update.stdout.includes("Status: manual_reinstall_required")) {
      throw new Error("update command did not explain the release update policy");
    }
    if (!update.stdout.includes("Expected archive:")) {
      throw new Error("update command did not report the expected archive");
    }

    if (process.platform === "win32") {
      runCommand("powershell.exe", [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        join(releaseDir, "uninstall.ps1"),
        "-Prefix",
        installPrefix,
      ], { env: releaseEnv(workspace) });
    } else {
      runCommand("sh", [join(releaseDir, "uninstall.sh"), "--prefix", installPrefix], {
        env: releaseEnv(workspace),
      });
    }

    process.stdout.write(`CHECKED_RELEASE_ARCHIVE ${plan.tarballPath}\n`);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function verifyChecksums(plan) {
  const expectedLine = readFileSync(plan.checksumsPath, "utf8").trim();
  const [expectedHash, artifactName] = expectedLine.split(/\s+/u);
  assertEqual(artifactName, `${plan.releaseName}.tar.gz`, "checksum artifact name");
  assertEqual(sha256File(plan.tarballPath), expectedHash, "tarball sha256");

  const manifest = JSON.parse(readFileSync(plan.checksumsJsonPath, "utf8"));
  assertEqual(manifest.release_name, plan.releaseName, "checksum manifest release name");
  assertEqual(manifest.platform, plan.platform, "checksum manifest platform");
  assertEqual(manifest.channel, plan.channel, "checksum manifest channel");
  assertEqual(manifest.artifacts[0].sha256, expectedHash, "checksum manifest sha256");
}

function verifyReleaseMetadata(plan, metadataPath) {
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  assertEqual(metadata.release_name, plan.releaseName, "release metadata name");
  assertEqual(metadata.touba_version, plan.toubaVersion, "release metadata version");
  assertEqual(metadata.platform, plan.platform, "release metadata platform");
  assertEqual(metadata.channel, plan.channel, "release metadata channel");
  assertEqual(metadata.validation_status, plan.validationStatus, "release metadata validation status");
  assertEqual(metadata.public_release, false, "release metadata public flag");
}

function releaseEnv(workspace, installPrefix) {
  const pathEntries = [];
  if (installPrefix) {
    pathEntries.push(join(installPrefix, "bin"));
  }
  if (process.env.PATH) {
    pathEntries.push(process.env.PATH);
  }
  if (process.platform !== "win32") {
    pathEntries.push("/usr/bin", "/bin");
  }
  return {
    ...process.env,
    HOME: workspace,
    USERPROFILE: workspace,
    TMPDIR: workspace,
    TMP: workspace,
    TEMP: workspace,
    PATH: pathEntries.join(delimiter),
  };
}

function runTouba(cliPath, args, env, expectedStatus = 0) {
  const result = spawnSync(cliPath, args, {
    env,
    encoding: "utf8",
    shell: process.platform === "win32",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== expectedStatus) {
    throw new Error([
      `${cliPath} ${args.join(" ")} exited with status ${result.status}, expected ${expectedStatus}`,
      result.stdout,
      result.stderr,
    ].filter(Boolean).join("\n"));
  }
  return result;
}

function runCommand(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error([
      `${command} ${args.join(" ")} failed with status ${result.status}`,
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

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}
