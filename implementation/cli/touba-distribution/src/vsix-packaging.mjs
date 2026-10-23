import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

export const VSIX_TARGETS = Object.freeze(["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]);

export function nativeVsixTarget(platform = process.platform, arch = process.arch) {
  const target = `${platform}-${arch}`;
  if (!VSIX_TARGETS.includes(target)) {
    throw new Error(`Unsupported native VSIX target: ${target}`);
  }
  return target;
}

export function vsixFilename(manifest, target = nativeVsixTarget()) {
  if (typeof manifest?.version !== "string" || manifest.version.trim() !== manifest.version ||
      !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(manifest.version)) {
    throw new Error("VSIX version must be MAJOR.MINOR.PATCH without a label or leading zeros");
  }
  if (!VSIX_TARGETS.includes(target)) {
    throw new Error(`Unsupported native VSIX target: ${target}`);
  }
  return `touba-vscode-v${manifest.version}-${target}.vsix`;
}

// Generated from the exact bytes sent to the publisher, not the staging tree.
// This receipt records packaging only; installation checks remain separate.
export function writeVsixReceipt(file, manifest, build) {
  const target = nativeVsixTarget(build.platform, build.arch);
  if (build.target !== target || build.version !== manifest.version
      || basename(file) !== vsixFilename(manifest, target)
      || !/^[a-z0-9][a-z0-9-]*$/i.test(manifest.publisher ?? "")
      || !/^[a-f0-9]{64}$/.test(build.build_id ?? "")) {
    throw new Error("VSIX identity, target or build metadata mismatch");
  }
  const bytes = readFileSync(file);
  const receipt = {
    schema_version: "touba-vsix-package-v1",
    extension_id: `${manifest.publisher}.${manifest.name}`,
    publisher: manifest.publisher,
    version: manifest.version,
    target,
    license: manifest.license,
    vscode: manifest.engines.vscode,
    filename: basename(file),
    size_bytes: bytes.length,
    sha256: createHash("sha256").update(bytes).digest("hex"),
    build_id: build.build_id,
    built_at: build.built_at,
    sources: build.sources ?? null,
    validation_status: "packaged_unqualified",
  };
  writeFileSync(`${file}.json`, JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
  return receipt;
}

// A target label must describe the binary bytes, not just the packaging host.
// Reject cross-target Cargo output and unknown formats. Cargo checks freshness.
export function assertCompilerTarget(file, target = nativeVsixTarget()) {
  const bytes = readFileSync(file);
  let actual;
  if (bytes.length >= 32 && bytes.readUInt32LE(0) === 0xfeedfacf) {
    const cpu = bytes.readUInt32LE(4);
    actual = cpu === 0x0100000c ? "darwin-arm64" : cpu === 0x01000007 ? "darwin-x64" : undefined;
  } else if (bytes.length >= 64 && bytes.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))
      && bytes[4] === 2 && bytes[5] === 1 && bytes.readUInt16LE(18) === 0x3e) {
    actual = "linux-x64";
  } else if (bytes.length >= 64 && bytes.toString("ascii", 0, 2) === "MZ") {
    const pe = bytes.readUInt32LE(60);
    if (pe >= 64 && pe + 24 <= bytes.length && bytes.readUInt32LE(pe) === 0x4550
        && bytes.readUInt16LE(pe + 4) === 0x8664) actual = "win32-x64";
  }
  if (actual !== target) throw new Error(`Compiler target mismatch: expected ${target}, found ${actual ?? "unknown format"}`);
}
