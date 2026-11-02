import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { installToolchainPayload } from "./install-toolchain-payload.mjs";

function regular(path, directory = false) {
  let stat;
  try { stat = lstatSync(path); } catch (error) { if (error.code === "ENOENT") return; throw error; }
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) throw new Error(`InstallerPathUnsafe: ${path}`);
}

export function desktopLauncher(platform) {
  if (platform === "win32") return '@echo off\r\n"%~dp0..\\touba-toolchain\\bin\\touba.cmd" %*\r\n';
  return '#!/bin/sh\nROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"\nexec "$ROOT/touba-toolchain/bin/touba" "$@"\n';
}

/** No package downloads, no project/secret migration, and no administrator request. */
export function installDesktop({ source, prefix = join(homedir(), ".touba"), force = false, addPath = false }) {
  source = resolve(source); prefix = resolve(prefix);
  const metadata = JSON.parse(readFileSync(join(source, "TOOLCHAIN.json"), "utf8"));
  if (metadata.platform !== `${process.platform}-${process.arch}`) throw new Error("InstallerPlatformMismatch");
  const bin = join(prefix, "bin");
  const launcher = join(bin, process.platform === "win32" ? "touba.cmd" : "touba");
  regular(prefix, true); regular(bin, true); regular(launcher); regular(join(prefix, "INSTALLATION.json"));
  if (existsSync(launcher) && !existsSync(join(prefix, "INSTALLATION.json"))) throw new Error("InstallerUnmanagedLauncher: refusing to overwrite an unrecognized installation");
  // Check shell files before installing; PATH changes are opt-in and limited to
  // our canonical per-user prefix, never a user-provided shell expression.
  const rcPaths = process.platform === "darwin" ? [join(homedir(), ".zprofile"), join(homedir(), ".zshrc")] : [];
  if (addPath && prefix !== join(homedir(), ".touba")) throw new Error("InstallerPathRegistrationRequiresDefaultPrefix");
  if (addPath && process.platform !== "darwin") throw new Error("InstallerPathRegistrationUnsupported: the Windows wizard manages the user PATH");
  if (addPath) for (const rc of rcPaths) regular(rc);
  const installed = installToolchainPayload({ source, prefix, force });
  mkdirSync(bin, { recursive: true });
  writeFileSync(launcher, desktopLauncher(process.platform));
  if (process.platform !== "win32") chmodSync(launcher, 0o755);
  writeFileSync(join(prefix, "INSTALLATION.json"), JSON.stringify({
    installation_profile: "touba-desktop-install-v1", prefix, cli_path: launcher,
    channel: "local-desktop", platform: metadata.platform, touba_version: metadata.touba_version,
    build: metadata.build, validation_status: "pending_validation", public_release: false,
    update_policy: "signed-catalogue; project SDKs are updated separately",
  }, null, 2) + "\n");
  const check = spawnSync(join(installed.install_root, "bin", process.platform === "win32" ? "node.exe" : "node"),
    [join(installed.install_root, "lib/cli/touba-project/src/main.mjs"), "version", "--json"], { encoding: "utf8", windowsHide: true });
  if (check.error || check.status !== 0 || JSON.parse(check.stdout).build.id !== metadata.build.id) throw new Error("InstallerVerificationFailed: files installed, but CLI validation failed; inspect before using Touba");
  if (addPath) {
    if (process.platform === "darwin") {
      const entry = 'export PATH="$HOME/.touba/bin:$PATH"';
      for (const rc of rcPaths) {
        const old = existsSync(rc) ? readFileSync(rc, "utf8") : "";
        if (!old.split(/\r?\n/).includes(entry)) writeFileSync(rc, old + `\n# Touba CLI (user installation)\n${entry}\n`);
      }
    }
  }
  return { ...installed, cli_path: launcher, path_registered: addPath };
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const arg = process.argv[i];
      if (["--source", "--prefix"].includes(arg) && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) options[arg.slice(2)] = process.argv[++i];
      else if (arg === "--force") options.force = true;
      else if (arg === "--add-path") options.addPath = true;
      else throw new Error(`Unknown installer option: ${arg}`);
    }
    if (!options.source) throw new Error("Installer source required");
    process.stdout.write(JSON.stringify(installDesktop(options)) + "\n");
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}
