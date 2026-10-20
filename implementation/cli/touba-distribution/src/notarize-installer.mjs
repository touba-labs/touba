#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { macCommand, verifyMacSignature } from "./macos-signing.mjs";
import { toolchainBuildIdentity } from "./build-identity.mjs";

function json(path, value) { writeFileSync(path, JSON.stringify(value, null, 2) + "\n"); }
function checksum(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }

export function requireAcceptedNotarization(receipt) {
  if (receipt?.status !== "Accepted" || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(receipt.id ?? "")) {
    throw new Error(`Apple notarization is not accepted (${receipt?.status ?? "unknown"}); inspect NOTARIZATION.json`);
  }
}

export function notarizeInstaller({ installerDir, outputDir, keychainProfile }) {
  if (process.platform !== "darwin") throw new Error("Notarization requires macOS");
  if (!keychainProfile || keychainProfile.startsWith("-") || /[\r\n\0]/.test(keychainProfile)) throw new Error("A keychain profile is required");
  installerDir = resolve(installerDir); outputDir = resolve(outputDir);
  const original = JSON.parse(readFileSync(join(installerDir, "INSTALLER.json"), "utf8"));
  if (original.format !== "dmg" || original.signing_status !== "developer_id_signed") throw new Error("A Developer ID signed DMG is required");
  if (!original.filename || basename(original.filename) !== original.filename || !original.filename.endsWith(".dmg")) throw new Error("Invalid installer filename");
  const sourceDmg = join(installerDir, original.filename);
  if (checksum(sourceDmg) !== original.sha256 || readFileSync(sourceDmg).length !== original.size_bytes) throw new Error("Installer checksum mismatch");
  const sourceApp = join(installerDir, "Install Touba.app");
  const payload = join(sourceApp, "Contents/Resources/payload");
  if (toolchainBuildIdentity(payload).id !== original.build) throw new Error("Signed payload identity mismatch");
  verifyMacSignature(sourceApp, { developerId: true });
  verifyMacSignature(sourceDmg, { developerId: true });
  if (existsSync(outputDir) && readdirSync(outputDir).length) throw new Error("Notarization output must be empty; preserve previous candidates");
  mkdirSync(outputDir, { recursive: true });
  const dmg = join(outputDir, original.filename), app = join(outputDir, "Install Touba.app");
  cpSync(sourceDmg, dmg, { force: false, errorOnExist: true });
  cpSync(sourceApp, app, { recursive: true, force: false, errorOnExist: true });
  // Credentials remain in Keychain. No Apple password, API key or private key is read.
  const result = spawnSync("/usr/bin/xcrun", ["notarytool", "submit", dmg, "--keychain-profile", keychainProfile, "--wait", "--timeout", "20m", "--output-format", "json"], { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout: 22 * 60 * 1000 });
  let receipt;
  try { receipt = JSON.parse(result.stdout); }
  catch { throw new Error(`Notarization did not return a receipt: ${result.error?.message ?? result.stderr}`); }
  json(join(outputDir, "NOTARIZATION.json"), receipt);
  if (result.error || result.status !== 0) throw new Error(`Notarization command failed; inspect NOTARIZATION.json: ${result.error?.message ?? result.stderr}`);
  requireAcceptedNotarization(receipt);
  for (const path of [app, dmg]) {
    macCommand("/usr/bin/xcrun", ["stapler", "staple", path]);
    macCommand("/usr/bin/xcrun", ["stapler", "validate", path]);
    verifyMacSignature(path, { developerId: true });
  }
  macCommand("/usr/sbin/spctl", ["--assess", "--type", "execute", "--verbose=4", app]);
  macCommand("/usr/sbin/spctl", ["--assess", "--type", "open", "--context", "context:primary-signature", "--verbose=4", dmg]);
  macCommand("/usr/bin/hdiutil", ["verify", dmg]);
  const report = { ...original, path: dmg, size_bytes: readFileSync(dmg).length, sha256: checksum(dmg),
    signing_status: "developer_id_notarized", notarization_status: "accepted", notarization_id: receipt.id,
    signed_candidate_sha256: original.sha256, gatekeeper_assessment: "accepted", stapled_ticket: "validated" };
  // Stapling changes the delivered bytes. Emit final checksums only after all checks.
  json(join(outputDir, "INSTALLER.json"), report);
  writeFileSync(join(outputDir, "SHA256SUMS"), `${report.sha256}  ${original.filename}\n`);
  return report;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const args = process.argv.slice(2), options = {};
    if (args.includes("--help")) process.stdout.write("Usage: notarize-installer.mjs --installer-dir <signed-candidate> --out <new-directory> --keychain-profile <profile>\nSubmits to Apple, staples and validates tickets, and checks Gatekeeper. Preserves the input candidate.\n");
    else {
      for (let i = 0; i < args.length; i++) {
        const key = { "--installer-dir": "installerDir", "--out": "outputDir", "--keychain-profile": "keychainProfile" }[args[i]];
        if (!key || options[key] !== undefined || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Invalid notarization option");
        options[key] = args[++i];
      }
      if (!options.installerDir || !options.outputDir || !options.keychainProfile) throw new Error("--installer-dir, --out and --keychain-profile are required");
      process.stdout.write(JSON.stringify(notarizeInstaller(options), null, 2) + "\n");
    }
  } catch (error) { process.stderr.write(`Touba notarization: ${error.message}\n`); process.exitCode = 1; }
}
