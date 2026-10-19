import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { nativeVsixTarget, vsixFilename, assertCompilerTarget, writeVsixReceipt } from "../src/vsix-packaging.mjs";

test("VSIX receipt binds the exact archive bytes to its publisher and target", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-vsix-receipt-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const manifest = { name: "touba-vscode", publisher: "example-labs", version: "1.0.0", license: "Apache-2.0", engines: { vscode: "^1.119.0" } };
  const build = { version: "1.0.0", platform: "darwin", arch: "arm64", target: "darwin-arm64", build_id: "a".repeat(64), built_at: "2026-10-19T00:00:00.000Z" };
  const file = join(root, vsixFilename(manifest, build.target));
  const bytes = Buffer.from("receipt test bytes; not an extension qualification");
  writeFileSync(file, bytes);
  const receipt = writeVsixReceipt(file, manifest, build);
  assert.equal(receipt.sha256, createHash("sha256").update(bytes).digest("hex"));
  assert.equal(receipt.size_bytes, bytes.length);
  assert.equal(receipt.extension_id, "example-labs.touba-vscode");
  assert.equal(receipt.target, "darwin-arm64");
  assert.equal(receipt.validation_status, "packaged_unqualified");
  assert.deepEqual(JSON.parse(readFileSync(`${file}.json`)), receipt);
  assert.throws(() => writeVsixReceipt(file, manifest, build), /EEXIST/);
  for (const changed of [{ ...build, target: "win32-x64" }, { ...build, version: "2.0.0" }]) {
    assert.throws(() => writeVsixReceipt(file, manifest, changed), /mismatch/);
  }
  assert.throws(() => writeVsixReceipt(file, { ...manifest, publisher: "" }, build), /mismatch/);
});

test("native VSIX names distinguish all four supported targets", () => {
  const names = new Set();
  for (const target of ["darwin-arm64", "darwin-x64", "linux-x64", "win32-x64"]) {
    const [platform, arch] = target.split("-");
    assert.equal(nativeVsixTarget(platform, arch), target);
    names.add(vsixFilename({ name: "touba-vscode", version: "1.0.0" }, target));
  }
  assert.equal(names.size, 4);
  assert.throws(() => nativeVsixTarget("linux", "arm64"), /Unsupported/);
  assert.throws(() => nativeVsixTarget("freebsd", "x64"), /Unsupported/);
});

test("compiler headers must agree with their VSIX target", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-vsix-headers-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, "compiler");
  const headers = new Map();
  for (const [target, cpu] of [["darwin-arm64", 0x0100000c], ["darwin-x64", 0x01000007]]) {
    const bytes = Buffer.alloc(64); bytes.writeUInt32LE(0xfeedfacf); bytes.writeUInt32LE(cpu, 4);
    headers.set(target, bytes);
  }
  const elf = Buffer.alloc(64); elf.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]); elf.writeUInt16LE(0x3e, 18);
  headers.set("linux-x64", elf);
  const pe = Buffer.alloc(128); pe.write("MZ"); pe.writeUInt32LE(64, 60); pe.writeUInt32LE(0x4550, 64); pe.writeUInt16LE(0x8664, 68);
  headers.set("win32-x64", pe);
  for (const [actual, bytes] of headers) {
    writeFileSync(file, bytes);
    for (const target of headers.keys()) {
      if (target === actual) assert.doesNotThrow(() => assertCompilerTarget(file, target));
      else assert.throws(() => assertCompilerTarget(file, target), /target mismatch/);
    }
  }
  for (const bytes of [Buffer.alloc(0), Buffer.from("not executable"), pe.subarray(0, 64)]) {
    writeFileSync(file, bytes);
    assert.throws(() => assertCompilerTarget(file, "win32-x64"), /unknown format/);
  }
});
