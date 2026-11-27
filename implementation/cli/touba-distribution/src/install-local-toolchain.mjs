#!/usr/bin/env node
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { installToolchainPayload } from "./install-toolchain-payload.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const packageRoot = resolve(currentDir, "..");
const platform = `${process.platform}-${process.arch}`;
const defaultSource = join(packageRoot, "dist", `touba-toolchain-${platform}`);

export function installLocalToolchain(options) {
  const source = resolve(options.source ?? defaultSource);
  const prefix = resolve(options.prefix);
  const installRoot = join(prefix, "touba-toolchain");
  const binRoot = join(prefix, "bin");

  if (!existsSync(source)) {
    throw new Error(`missing local toolchain source ${source}`);
  }
  if (existsSync(installRoot) && options.force !== true) {
    throw new Error(`installation already exists at ${installRoot}; pass --force to replace it`);
  }

  const transition = installToolchainPayload({ source, prefix, force: options.force === true });
  mkdirSync(binRoot, { recursive: true });
  writeLaunchers(prefix);
  writeInstallationMetadata(source, prefix);

  return {
    source,
    prefix,
    install_root: installRoot,
    ...transition,
    cli_path: join(binRoot, process.platform === "win32" ? "touba.cmd" : "touba"),
  };
}

function writeLaunchers(prefix) {
  const binRoot = join(prefix, "bin");
  const installRoot = join(prefix, "touba-toolchain");
  const shellPath = join(installRoot, "bin", "touba").replaceAll("'", "'\\''");
  const shellLauncher = `#!/bin/sh
exec '${shellPath}' "$@"
`;
  writeFileSync(join(binRoot, "touba"), shellLauncher, "utf8");
  chmodSync(join(binRoot, "touba"), 0o755);

  const cmdPath = join(installRoot, "bin", "touba.cmd").replaceAll("%", "%%");
  const cmdLauncher = `@echo off
setlocal DisableDelayedExpansion
"${cmdPath}" %*
`;
  writeFileSync(join(binRoot, "touba.cmd"), cmdLauncher, "utf8");
}

function writeInstallationMetadata(source, prefix) {
  let toolchain = {};
  const metadataPath = join(source, "TOOLCHAIN.json");
  if (existsSync(metadataPath)) {
    toolchain = JSON.parse(readFileSync(metadataPath, "utf8"));
  }
  writeFileSync(join(prefix, "INSTALLATION.json"), `${JSON.stringify({
    installation_profile: "touba-local-install-v1",
    channel: "local-archive",
    prefix,
    toolchain_profile: toolchain.toolchain_profile ?? null,
    platform,
    update_policy: "signed-catalogue; project SDKs are updated separately",
  }, null, 2)}\n`, "utf8");
}

function parseArgs(rawArgs) {
  const options = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--source") {
      options.source = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--source=")) {
      options.source = arg.slice("--source=".length);
    } else if (arg === "--prefix") {
      options.prefix = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--prefix=")) {
      options.prefix = arg.slice("--prefix=".length);
    } else if (arg === "--force") {
      options.force = true;
    } else if (arg === "--help" || arg === "-h") {
      printUsage();
      return null;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  if (!options.prefix) {
    throw new Error("--prefix is required");
  }
  return options;
}

function requiredValue(option, args, index) {
  const value = args[index];
  if (value === undefined || value.startsWith("--")) {
    throw new Error(`${option} requires a value`);
  }
  return value;
}

function printUsage() {
  process.stdout.write("Usage: node install-local-toolchain.mjs --prefix <dir> [--source <toolchain-dir>] [--force]\n");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options) {
      const result = installLocalToolchain(options);
      process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    }
  } catch (error) {
    process.stderr.write(`touba local install: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
