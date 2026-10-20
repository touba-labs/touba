import { spawnSync } from "node:child_process";
import { closeSync, lstatSync, openSync, readFileSync, readSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { toolchainBuildIdentity } from "./build-identity.mjs";

const nodeEntitlements = fileURLToPath(new URL("../installers/node-entitlements.plist", import.meta.url));
const machoMagic = new Set(["cffaedfe", "cefaedfe", "feedfacf", "feedface", "cafebabe", "bebafeca", "cafebabf", "bfbafeca"]);

export function macCommand(command, args, timeout = 120000) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024, timeout });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? ""}\n${result.stdout ?? ""}${result.stderr ?? ""}`);
  return result.stdout + result.stderr;
}

export function validateMacSigningIdentity(identity) {
  // A fingerprint selects exactly one keychain identity; never fall back to ad hoc.
  if (!/^[a-fA-F0-9]{40}$/.test(identity ?? "")) throw new Error("macOS signing requires a Developer ID Application SHA-1 fingerprint");
  if (process.platform !== "darwin") throw new Error("macOS signing requires macOS");
  const identities = macCommand("/usr/bin/security", ["find-identity", "-v", "-p", "codesigning"]);
  const match = identities.split("\n").find(line => line.includes(identity.toUpperCase()) && line.includes('"Developer ID Application:'));
  if (!match) throw new Error("A valid Developer ID Application identity with its private key is required");
}

export function nativeMacFiles(root) {
  const files = [];
  function visit(path) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name));
    } else if (stat.isFile()) {
      const header = Buffer.alloc(4), fd = openSync(path, "r");
      try {
        if (readSync(fd, header, 0, 4, 0) === 4 && machoMagic.has(header.toString("hex"))) files.push(path);
      } finally { closeSync(fd); }
    } else {
      throw new Error(`Unsupported signing entry: ${relative(root, path)}`);
    }
  }
  visit(root);
  return files;
}

export function verifyMacSignature(path, { developerId = false } = {}) {
  macCommand("/usr/bin/codesign", ["--verify", "--deep", "--strict", "--verbose=2", path]);
  if (developerId) {
    const details = macCommand("/usr/bin/codesign", ["--display", "--verbose=4", path]);
    if (!/^Authority=Developer ID Application:/m.test(details) || !/^Timestamp=/m.test(details)) {
      throw new Error("A timestamped Developer ID Application signature is required");
    }
    // Check Apple's trust anchor and certificate class, not just its display name.
    macCommand("/usr/bin/codesign", ["--verify", "--strict", "-R=anchor apple generic and certificate 1[field.1.2.840.113635.100.6.2.6] exists and certificate leaf[field.1.2.840.113635.100.6.1.13] exists", path]);
  }
}

function signCode(path, identity, entitlements) {
  const args = ["--force", "--sign", identity, "--timestamp", "--options", "runtime"];
  if (entitlements) args.push("--entitlements", entitlements);
  // The first use of a private key can require local user consent.
  macCommand("/usr/bin/codesign", [...args, path], 5 * 60 * 1000);
  verifyMacSignature(path, { developerId: true });
}

// Operates on a fresh staged copy only. Signing changes the content identity.
export function signMacPayload(root, identity) {
  validateMacSigningIdentity(identity);
  const metadataPath = join(root, "TOOLCHAIN.json");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (metadata.build?.id !== toolchainBuildIdentity(root).id) throw new Error("Cannot sign an altered payload");
  const files = nativeMacFiles(root);
  for (const required of ["node", "touba-compile"]) {
    if (!files.includes(join(root, "bin", required))) throw new Error(`Missing native payload executable: ${required}`);
  }
  for (const file of files) signCode(file, identity, file === join(root, "bin/node") ? nodeEntitlements : undefined);
  const sourceBuild = metadata.build.id;
  metadata.build = toolchainBuildIdentity(root);
  writeFileSync(metadataPath, JSON.stringify(metadata, null, 2) + "\n");
  return { source_build: sourceBuild, build: metadata.build.id, native_files: files.map(file => relative(root, file)) };
}

export function sealMacApp(app, identity) {
  if (identity) {
    validateMacSigningIdentity(identity);
    signCode(app, identity);
  } else {
    // Local candidates still require a valid resource seal. This is not public trust.
    macCommand("/usr/bin/codesign", ["--force", "--sign", "-", app]);
    verifyMacSignature(app);
  }
}

export function signMacDiskImage(path, identity) {
  macCommand("/usr/bin/codesign", ["--sign", identity, "--timestamp", "--identifier", "org.toubalang.installer.disk-image", path], 5 * 60 * 1000);
  verifyMacSignature(path, { developerId: true });
}
