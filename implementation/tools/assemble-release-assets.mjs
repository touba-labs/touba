#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export const RELEASE_ASSETS_SCHEMA_VERSION = "touba-github-release-assets-v1";
export const PUBLIC_RELEASE_PLATFORMS = Object.freeze([
  "darwin-arm64",
  "darwin-x64",
  "linux-x64",
  "win32-x64",
]);
const DEFAULT_IMPLEMENTATION_ROOT = resolve(new URL("..", import.meta.url).pathname);

export function assembleReleaseAssets(options = {}) {
  const inputDir = resolveRequiredDir(options.inputDir, "inputDir");
  const outputDir = resolve(options.outputDir ?? join(inputDir, "publish"));
  const version = normalizeVersion(options.version);
  const tag = `v${version}`;
  const releaseNotesPath = resolve(options.releaseNotesPath ?? join(DEFAULT_IMPLEMENTATION_ROOT, "release", "notes", `${tag}.md`));
  const canonicalReleaseNotes = readCanonicalReleaseNotes(releaseNotesPath, version);

  const tarballs = collectFiles(inputDir)
    .filter((path) => basename(path).startsWith(`touba-v${version}-`) && basename(path).endsWith(".tar.gz"))
    .map((path) => ({
      path,
      filename: basename(path),
      platform: platformFromArchiveName(basename(path), version),
    }))
    .sort((left, right) => left.filename.localeCompare(right.filename));

  validateTarballs(tarballs, version);

  rmSync(outputDir, { recursive: true, force: true });
  mkdirSync(outputDir, { recursive: true });

  const assets = [];
  const checksumLines = [];
  for (const item of tarballs) {
    const target = join(outputDir, item.filename);
    copyFileSync(item.path, target);
    const sha256 = sha256File(target);
    checksumLines.push(`${sha256}  ${item.filename}`);
    assets.push({
      name: item.filename,
      platform: item.platform,
      sha256,
      size_bytes: readFileSync(target).byteLength,
    });
  }

  const manifest = {
    schema_version: RELEASE_ASSETS_SCHEMA_VERSION,
    product: "touba",
    version,
    tag,
    channel: "github-release",
    platforms: PUBLIC_RELEASE_PLATFORMS,
    assets,
    verification: {
      checksum_algorithm: "sha256",
      checksum_file: "SHA256SUMS",
      checksum_manifest: "CHECKSUMS.json",
    },
  };

  writeFileSync(join(outputDir, "SHA256SUMS"), `${checksumLines.join("\n")}\n`, "utf8");
  writeFileSync(join(outputDir, "CHECKSUMS.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  writeFileSync(join(outputDir, "GITHUB_RELEASE_NOTES.md"), renderReleaseNotes(manifest, canonicalReleaseNotes), "utf8");

  return {
    output_dir: outputDir,
    checksum_file: join(outputDir, "SHA256SUMS"),
    checksum_manifest: join(outputDir, "CHECKSUMS.json"),
    notes_file: join(outputDir, "GITHUB_RELEASE_NOTES.md"),
    manifest,
  };
}

export function parseAssembleArgs(rawArgs) {
  const options = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--") {
      continue;
    } else if (arg === "--input") {
      options.inputDir = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--input=")) {
      options.inputDir = valueFromEquals(arg, "--input");
    } else if (arg === "--out") {
      options.outputDir = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--out=")) {
      options.outputDir = valueFromEquals(arg, "--out");
    } else if (arg === "--version") {
      options.version = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--version=")) {
      options.version = valueFromEquals(arg, "--version");
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function readCanonicalReleaseNotes(path, version) {
  if (!existsSync(path)) {
    throw new Error(`release notes are required for ${version}: ${path}`);
  }
  const source = readFileSync(path, "utf8").trim();
  if (!new RegExp(`^#\\s+Touba\\s+${escapeRegExp(version)}\\s*$`, "mu").test(source)) {
    throw new Error(`release notes for ${version} must start with '# Touba ${version}'`);
  }
  return source;
}

function renderReleaseNotes(manifest, canonicalReleaseNotes) {
  return [
    canonicalReleaseNotes,
    "",
    "## Release Assets",
    "",
    ...manifest.assets.map((asset) => `- \`${asset.name}\` (${asset.platform})`),
    "",
    "## Verification",
    "",
    "Download `SHA256SUMS` or `CHECKSUMS.json` from this release and compare the SHA-256 digest of the archive before installation.",
    "",
    "Installation instructions are maintained in the Touba documentation:",
    "https://pap-touba.github.io/documentation-site/docs/demarrer/installation",
    "",
  ].join("\n");
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function validateTarballs(tarballs, version) {
  const seen = new Set();
  for (const item of tarballs) {
    if (seen.has(item.filename)) {
      throw new Error(`duplicate release asset ${item.filename}`);
    }
    seen.add(item.filename);
  }

  const byPlatform = new Map(tarballs.map((item) => [item.platform, item]));
  for (const platform of PUBLIC_RELEASE_PLATFORMS) {
    if (!byPlatform.has(platform)) {
      throw new Error(`missing public release archive touba-v${version}-${platform}.tar.gz`);
    }
  }
  if (tarballs.length !== PUBLIC_RELEASE_PLATFORMS.length) {
    const extra = tarballs.filter((item) => !PUBLIC_RELEASE_PLATFORMS.includes(item.platform));
    throw new Error(`unexpected public release archive(s): ${extra.map((item) => item.filename).join(", ")}`);
  }
}

function platformFromArchiveName(filename, version) {
  const prefix = `touba-v${version}-`;
  const suffix = ".tar.gz";
  if (!filename.startsWith(prefix) || !filename.endsWith(suffix)) {
    throw new Error(`invalid Touba archive name ${filename}`);
  }
  return filename.slice(prefix.length, -suffix.length);
}

function collectFiles(root) {
  const files = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectFiles(path));
    } else if (entry.isFile()) {
      files.push(path);
    }
  }
  return files;
}

function resolveRequiredDir(path, label) {
  if (typeof path !== "string" || path.trim() === "") {
    throw new Error(`${label} is required`);
  }
  const resolved = resolve(path);
  if (!existsSync(resolved)) {
    throw new Error(`${label} does not exist: ${resolved}`);
  }
  return resolved;
}

function normalizeVersion(version) {
  if (typeof version !== "string" || !/^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?$/u.test(version)) {
    throw new Error("version must be a semver-like string");
  }
  return version;
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function requiredValue(flag, args, index) {
  const value = args[index];
  if (value === undefined || value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function valueFromEquals(arg, flag) {
  const value = arg.slice(`${flag}=`.length);
  if (value.length === 0) {
    throw new Error(`${flag} requires a value`);
  }
  return value;
}

function usage() {
  return "Usage: assemble-release-assets --input <dir> --out <dir> --version <x.y.z>";
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseAssembleArgs(process.argv.slice(2));
    if (options.help === true) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const report = assembleReleaseAssets(options);
      process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`touba release assets: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
