import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  PUBLIC_RELEASE_PLATFORMS,
  RELEASE_ASSETS_SCHEMA_VERSION,
  assembleReleaseAssets,
  parseAssembleArgs,
} from "./assemble-release-assets.mjs";

test("assembles public release assets with global checksums", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-release-assets-test-"));
  try {
    const input = join(workspace, "input");
    const nested = join(input, "jobs");
    const output = join(workspace, "publish");
    const note = join(workspace, "v1.2.3.md");
    mkdirSync(nested, { recursive: true });

    for (const platform of PUBLIC_RELEASE_PLATFORMS) {
      writeFileSync(join(nested, `touba-v1.2.3-${platform}.tar.gz`), `archive:${platform}`, "utf8");
      const extension = platform.startsWith("darwin") ? "dmg" : platform === "win32-x64" ? "exe" : "deb";
      writeFileSync(join(nested, `touba-v1.2.3-${platform}-setup.${extension}`), `installer:${platform}`, "utf8");
    }
    writeFileSync(note, releaseNote("1.2.3"), "utf8");

    const report = assembleReleaseAssets({
      inputDir: input,
      outputDir: output,
      version: "1.2.3",
      releaseNotesPath: note,
    });

    assert.equal(report.manifest.schema_version, RELEASE_ASSETS_SCHEMA_VERSION);
    assert.equal(report.manifest.version, "1.2.3");
    assert.equal(report.manifest.tag, "v1.2.3");
    assert.equal(report.manifest.channel, "github-release");
    assert.equal(report.manifest.assets.length, PUBLIC_RELEASE_PLATFORMS.length * 2);
    assert.match(readFileSync(join(output, "SHA256SUMS"), "utf8"), /touba-v1\.2\.3-linux-x64\.tar\.gz/u);
    assert.equal(JSON.parse(readFileSync(join(output, "CHECKSUMS.json"), "utf8")).assets.length, PUBLIC_RELEASE_PLATFORMS.length * 2);
    const preserved = readFileSync(join(output, "CHECKSUMS.json"), "utf8");
    assert.throws(() => assembleReleaseAssets({ inputDir: input, outputDir: output, version: "1.2.3", releaseNotesPath: note }), /output directory must be empty/);
    assert.equal(readFileSync(join(output, "CHECKSUMS.json"), "utf8"), preserved);
    rmSync(join(nested, "touba-v1.2.3-win32-x64-setup.exe"));
    assert.throws(() => assembleReleaseAssets({ inputDir: input, outputDir: join(workspace, "another"), version: "1.2.3", releaseNotesPath: note }), /missing public installer/);
    const releaseNotes = readFileSync(join(output, "GITHUB_RELEASE_NOTES.md"), "utf8");
    assert.match(releaseNotes, /^# Touba 1\.2\.3/mu);
    assert.match(releaseNotes, /## Release Assets/u);
    assert.match(releaseNotes, /https:\/\/toubalang\.org\/docs\/demarrer\/installation/u);
    assert.doesNotMatch(releaseNotes, /https:\/\/touba-labs\.com/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("refuses incomplete public release asset sets", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-release-assets-test-"));
  try {
    const input = join(workspace, "input");
    mkdirSync(input, { recursive: true });
    writeFileSync(join(input, "touba-v1.2.3-linux-x64.tar.gz"), "archive", "utf8");

    assert.throws(() => assembleReleaseAssets({
      inputDir: input,
      outputDir: join(workspace, "publish"),
      version: "1.2.3",
      releaseNotesPath: writeReleaseNote(workspace, "1.2.3"),
    }), /missing public release archive/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("requires canonical release notes before publishing assets", () => {
  const workspace = mkdtempSync(join(tmpdir(), "touba-release-assets-test-"));
  try {
    const input = join(workspace, "input");
    mkdirSync(input, { recursive: true });

    for (const platform of PUBLIC_RELEASE_PLATFORMS) {
      writeFileSync(join(input, `touba-v1.2.3-${platform}.tar.gz`), `archive:${platform}`, "utf8");
    }

    assert.throws(() => assembleReleaseAssets({
      inputDir: input,
      outputDir: join(workspace, "publish"),
      version: "1.2.3",
      releaseNotesPath: join(workspace, "missing.md"),
    }), /release notes are required/u);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("parses assemble release asset CLI flags", () => {
  assert.deepEqual(parseAssembleArgs([
    "--input",
    "artifacts",
    "--out=publish",
    "--version",
    "1.2.3",
  ]), {
    inputDir: "artifacts",
    outputDir: "publish",
    version: "1.2.3",
  });
});

function writeReleaseNote(workspace, version) {
  const path = join(workspace, `v${version}.md`);
  writeFileSync(path, releaseNote(version), "utf8");
  return path;
}

function releaseNote(version) {
  return [
    `# Touba ${version}`,
    "",
    "## Executive Summary",
    "",
    "Fixture release.",
    "",
  ].join("\n");
}
