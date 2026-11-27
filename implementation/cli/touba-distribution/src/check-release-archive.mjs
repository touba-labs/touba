#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { npmCommand } from "./npm-command.mjs";
import { toolchainBuildIdentity } from "./build-identity.mjs";
import { installToolchainPayload } from "./install-toolchain-payload.mjs";

import {
  createReleasePlan,
  parsePackageReleaseArgs,
} from "./package-release.mjs";

try {
  const options = parsePackageReleaseArgs(process.argv.slice(2));
  if (options.help === true) {
    process.stdout.write("Usage: check-release-archive [--platform <platform>] [--release-root <directory>] [--experimental]\n");
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
    // Resolve both paths in Node so GNU tar receives neither a drive letter
    // for the archive nor escaped Windows separators in a -C argument.
    const archive = openSync(plan.tarballPath, "r");
    try {
      runCommand("tar", ["-xzf", "-"], { cwd: extractRoot, stdin: archive });
    } finally {
      closeSync(archive);
    }

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
    const cliEnv = releaseEnv(workspace, installPrefix);
    if (process.platform === "win32") {
      // Verify the real archive launcher before using literal-argument Node
      // calls. Read its actual channel instead of injecting the expected one.
      const launched = spawnSync(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", '""%TOUBA_ARCHIVE_LAUNCHER%" version --json"'], {
        env: { ...cliEnv, TOUBA_ARCHIVE_LAUNCHER: cliPath },
        windowsVerbatimArguments: true, encoding: "utf8", timeout: 30_000,
      });
      if (launched.error || launched.status !== 0) throw new Error(`Archive launcher failed: ${launched.error?.message ?? launched.stderr}`);
      const launcherVersion = JSON.parse(launched.stdout);
      assertEqual(launcherVersion.distribution.channel, plan.channel, "archive launcher channel");
      cliEnv.TOUBA_DISTRIBUTION_CHANNEL = launcherVersion.distribution.channel;
      cliEnv.TOUBA_COMPILE_BIN = join(installPrefix, "touba-toolchain/bin/touba-compile.exe");
      cliEnv.PATH = join(installPrefix, "touba-toolchain/bin") + delimiter + cliEnv.PATH;
    }
    const version = runTouba(cliPath, ["version", "--json"], cliEnv);
    const versionReport = JSON.parse(version.stdout);
    assertEqual(versionReport.cli, plan.toubaVersion, "CLI version");
    assertEqual(versionReport.distribution.channel, plan.channel, "distribution channel");
    assertEqual(versionReport.distribution.platform, plan.platform, "distribution platform");
    assertEqual(versionReport.commands.doctor, true, "doctor command manifest");
    assertEqual(versionReport.commands.run_profile, true, "run profile command manifest");
    const expectedBuild = toolchainBuildIdentity(join(installPrefix, "touba-toolchain"));
    assertEqual(versionReport.build.id, expectedBuild.id, "installed payload build identity");
    assertEqual(versionReport.build.algorithm, expectedBuild.algorithm, "build identity algorithm");
    assertEqual(versionReport.build.identity_scope, expectedBuild.identity_scope, "build identity scope");
    const humanVersion = runTouba(cliPath, ["version"], cliEnv);
    assertEqual(humanVersion.stdout, `touba ${plan.toubaVersion}\nbuild ${expectedBuild.id.slice(0, 12)}\n`, "concise version output");

    const doctor = runTouba(cliPath, ["doctor", "--json"], cliEnv);
    const doctorReport = JSON.parse(doctor.stdout);
    assertEqual(doctorReport.status, "ok", "doctor status");
    assertEqual(doctorReport.version.cli, plan.toubaVersion, "doctor CLI version");
    assertEqual(doctorReport.version.commands.supply_chain_validate, true, "doctor supply-chain command manifest");

    const hello = join(workspace, "hello source.tb");
    writeFileSync(hello, `module release.hello

strategy Hello
    do
        show
            with message as "Touba ready"
`);
    const helloRun = runTouba(cliPath, ["run", hello], cliEnv);
    assertEqual(helloRun.stdout, "Touba ready\n", "installed CLI runs source directly");
    process.stdout.write("CHECKED_RELEASE_RUN_SOURCE\n");

    const project = join(workspace, "independent SDK project");
    mkdirSync(project);
    writeFileSync(join(project, "package.json"), JSON.stringify({ name: "release-sdk-check", private: true }));
    const sdkArchive = versionReport.distribution.sdk_archive;
    assertFile(sdkArchive);
    const sdkEnv = { ...cliEnv };
    sdkEnv.npm_config_cache = join(workspace, "empty npm cache");
    const npm = npmCommand(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", "--save-exact", sdkArchive]);
    runCommand(npm.command, npm.args,
      { cwd: project, env: sdkEnv });
    writeFileSync(join(project, "sdk-smoke.mjs"), readFileSync(new URL("./sdk-smoke-program.mjs", import.meta.url)));
    const installedRoot = join(installPrefix, "touba-toolchain");
    const sdkSmoke = runCommand(join(installedRoot, "bin", process.platform === "win32" ? "node.exe" : "node"),
      ["sdk-smoke.mjs", join(installedRoot, "lib/cli/touba-project/src/main.mjs")], { cwd: project, env: sdkEnv });
    if (!sdkSmoke.stdout.includes("SDK_ARCHIVE_OK")) throw new Error("Installed SDK smoke did not complete");
    process.stdout.write("CHECKED_RELEASE_SDK positive and negative cases\n");

    if (process.platform !== "win32") {
      const signalTests = fileURLToPath(new URL("../../touba-project/test/signals.test.mjs", import.meta.url));
      runCommand(join(installedRoot, "bin", "node"), ["--test", signalTests], {
        cwd: workspace,
        env: { ...sdkEnv, TOUBA_SIGNAL_TEST_CLI: cliPath },
      });
      process.stdout.write("CHECKED_RELEASE_SIGNALS launcher PID, group, child exit and port reuse\n");
    }

    const update = runTouba(cliPath, ["update", "--help"], cliEnv, 0);
    if (!update.stdout.includes("--check | --rollback")) throw new Error("verified update command is unavailable");

    const stateProject = join(workspace, "pending operation");
    const stateProbe = fileURLToPath(new URL("./state-transition-smoke.mjs", import.meta.url));
    runCommand(join(installedRoot, "bin", process.platform === "win32" ? "node.exe" : "node"),
      [stateProbe, installedRoot, stateProject, "pause"], { env: sdkEnv });
    const statePath = join(stateProject, ".touba/sandbox-checkpoints.sqlite");
    const beforeTransition = readFileSync(statePath);
    // A changed candidate payload has a distinct verified identity. No state
    // or format is fabricated to make the new build accept the old wait.
    const candidate = join(workspace, "second build");
    cpSync(installedRoot, candidate, { recursive: true });
    writeFileSync(join(candidate, "lib/qualification-build-marker.txt"), "isolated second build\n");
    const candidateMetadataPath = join(candidate, "TOOLCHAIN.json");
    const candidateMetadata = JSON.parse(readFileSync(candidateMetadataPath, "utf8"));
    candidateMetadata.build = toolchainBuildIdentity(candidate);
    writeFileSync(candidateMetadataPath, JSON.stringify(candidateMetadata));
    const transition = installToolchainPayload({ source: candidate, prefix: installPrefix, force: true });
    assertEqual(transition.preserved_build, join(installPrefix, "builds", expectedBuild.id), "preserved build location");
    const refused = JSON.parse(runTouba(cliPath, ["serve", "--project-root", stateProject, "--check-state"], sdkEnv, 1).stdout);
    assertEqual(refused.diagnostics[0].code, "ToubaServeStateBuildMismatch", "new-build preflight refusal");
    assertEqual(readFileSync(statePath).equals(beforeTransition), true, "state unchanged after transition refusal");
    assertEqual(existsSync(join(stateProject, "external-effect.txt")), false, "no premature effect");
    runCommand(join(transition.preserved_build, "bin", process.platform === "win32" ? "node.exe" : "node"),
      [stateProbe, transition.preserved_build, stateProject, "resume"], { env: sdkEnv });
    assertEqual(toolchainBuildIdentity(transition.preserved_build).id, expectedBuild.id, "preserved payload remains exact");
    process.stdout.write("CHECKED_RELEASE_TRANSITION real wait, new-build refusal, preserved-build resume, one effect\n");

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

    assertEqual(existsSync(cliPath), false, "uninstall removed launcher");
    assertEqual(existsSync(installedRoot), false, "uninstall removed active payload");
    assertEqual(existsSync(join(installPrefix, "INSTALLATION.json")), false, "uninstall removed metadata");
    assertEqual(toolchainBuildIdentity(transition.preserved_build).id, expectedBuild.id, "uninstall preserved recovery build");
    assertFile(statePath);
    assertFile(join(stateProject, "external-effect.txt"));
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
  assertEqual(metadata.public_release, plan.publicRelease, "release metadata public flag");
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
  const env = {
    ...process.env,
    TMPDIR: workspace,
    TMP: workspace,
    TEMP: workspace,
    PATH: pathEntries.join(delimiter),
  };
  for (const name of ["NODE_PATH", "TOUBA_IMPLEMENTATION_DIR", "TOUBA_COMPILE_BIN"]) delete env[name];
  return env;
}

function runTouba(cliPath, args, env, expectedStatus = 0) {
  // The .cmd launcher is exercised by check-desktop-install. Here use the
  // installed Node directly so paths and JSON arguments stay literal on Windows.
  const toolchain = join(dirname(dirname(cliPath)), "touba-toolchain");
  const command = process.platform === "win32" ? join(toolchain, "bin/node.exe") : cliPath;
  const argv = process.platform === "win32" ? [join(toolchain, "lib/cli/touba-project/src/main.mjs"), ...args] : args;
  const result = spawnSync(command, argv, {
    env,
    encoding: "utf8",
    shell: false,
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
    stdio: [options.stdin ?? "pipe", "pipe", "pipe"],
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
