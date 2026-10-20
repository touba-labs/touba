#!/usr/bin/env node
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";

assert.equal(process.platform, "win32", "Native Windows installer qualification required");
const installerRoot = resolve(process.argv[2]);
const report = JSON.parse(readFileSync(join(installerRoot, "INSTALLER.json"), "utf8"));
const root = mkdtempSync(join(tmpdir(), "touba-installer-check-"));
const prefix = join(root, "account install");
const run = (command, args, options = {}) => {
  const result = spawnSync(command, args, { encoding: "utf8", timeout: 120000, ...options });
  assert.equal(result.status, 0, result.error?.message ?? result.stderr);
  return result.stdout;
};
try {
  // Use an isolated prefix and leave this account's PATH unchanged.
  run(join(installerRoot, report.filename), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", "/TASKS=", `/DIR=${prefix}`, `/LOG=${join(root, "install.log")}`]);
  const metadata = JSON.parse(readFileSync(join(prefix, "INSTALLATION.json"), "utf8"));
  assert.equal(metadata.installation_profile, "touba-desktop-install-v1");
  assert.equal(metadata.build.id, report.build);
  const launcher = join(prefix, "bin/touba.cmd");
  const version = JSON.parse(run(process.env.ComSpec ?? "cmd.exe", ["/d", "/s", "/c", '""%TOUBA_INSTALLER_LAUNCHER%" version --json"'], {
    env: { ...process.env, TOUBA_INSTALLER_LAUNCHER: launcher }, windowsVerbatimArguments: true,
  }));
  assert.equal(version.build.id, report.build);
  // The archive qualification separately verifies a real preserved build and
  // checkpoint. Here sentinel files test the wizard's removal boundaries.
  const kept = ["builds/retained-build/data", "projects/customer/data"];
  for (const file of kept) {
    const target = join(prefix, file); mkdirSync(join(target, ".."), { recursive: true });
    writeFileSync(target, "retained");
  }
  run(join(prefix, "unins000.exe"), ["/VERYSILENT", "/SUPPRESSMSGBOXES", "/NORESTART", `/LOG=${join(root, "uninstall.log")}`]);
  // Inno may finish in a temporary child process after its original exits.
  for (let attempt = 0; attempt < 30 && existsSync(launcher); attempt++) await setTimeout(1000);
  for (const file of ["bin/touba.cmd", "touba-toolchain", "INSTALLATION.json"]) assert.equal(existsSync(join(prefix, file)), false, `removed ${file}`);
  for (const file of kept) assert.equal(readFileSync(join(prefix, file), "utf8"), "retained");
  console.log("CHECKED_WINDOWS_INSTALLER exact payload, real launcher, isolated install/uninstall, user data retained");
} finally {
  rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
}
