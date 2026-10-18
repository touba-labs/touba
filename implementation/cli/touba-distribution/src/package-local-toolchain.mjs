#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { copyDependency, packageSdk } from "./package-sdk.mjs";
import { toolchainBuildIdentity } from "./build-identity.mjs";
import { packagePythonSdk } from "./package-python-sdk.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const packageRoot = resolve(currentDir, "..");
const implementationRoot = resolve(currentDir, "../../..");
const distRoot = join(packageRoot, "dist");
const platform = `${process.platform}-${process.arch}`;
const toolchainName = `touba-toolchain-${platform}`;
const toolchainRoot = join(distRoot, toolchainName);

const copiedPackages = [
  "cli/touba-project",
  "cli/touba-project-server",
  "cli/touba-run",
  "cli/touba-inspect",
  "cli/touba-audit",
  "cli/touba-supply-chain",
  "cli/touba-manifest",
  "cli/touba-action-plan",
  "cli/touba-trigger-service",
  "cli/touba-deployment",
  "runtime/touba-runtime",
  "runtime/touba-handler-sdk",
];

const nodeModuleAliases = [
  ["runtime/touba-runtime", "@touba/runtime"],
  ["runtime/touba-handler-sdk", "@touba/sdk"],
  // Preserve the source-relative dependency used by the aliased supply-chain
  // package: ../../touba-manifest resolves to this sibling directory.
  ["cli/touba-manifest", "@touba/touba-manifest"],
  ["cli/touba-supply-chain", "@touba/supply-chain"],
  ["cli/touba-deployment", "@touba/deployment"],
];

export function packageLocalToolchain(options = {}) {
  if (options.buildCompiler !== false) {
    buildCompiler();
  }

  rmSync(toolchainRoot, { recursive: true, force: true });
  mkdirSync(join(toolchainRoot, "bin"), { recursive: true });
  mkdirSync(join(toolchainRoot, "lib"), { recursive: true });

  copyNodeRuntime();
  copyCompiler();
  copyToubaPackages();
  for (const packagePath of copiedPackages.filter(path => path !== "runtime/touba-handler-sdk")) {
    const sourceRoot = join(implementationRoot, packagePath);
    const dependencies = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8")).dependencies ?? {};
    const destinations = [join(toolchainRoot, "lib", packagePath), ...nodeModuleAliases
      .filter(([source]) => source === packagePath).map(([, alias]) => join(toolchainRoot, "lib/node_modules", alias))];
    const inventory = new Map();
    for (const [name, version] of Object.entries(dependencies)) {
      if (version.startsWith("workspace:")) continue;
      const source = realpathSync(join(sourceRoot, "node_modules", name));
      if (JSON.parse(readFileSync(join(source, "package.json"), "utf8")).version !== version) throw new Error(`${packagePath} dependency ${name} does not match its exact version`);
      for (const destination of destinations) copyDependency(source, join(destination, "node_modules", name), inventory);
    }
    if (inventory.size) for (const destination of destinations) writeFileSync(join(destination, "DEPENDENCIES.json"), JSON.stringify([...inventory.values()], null, 2) + "\n");
  }
  copyRuntimeContracts();
  mkdirSync(join(toolchainRoot, "lib/tools"), { recursive: true });
  copyFileSync(join(implementationRoot, "tools/validate-product-surface-contracts.mjs"),
    join(toolchainRoot, "lib/tools/validate-product-surface-contracts.mjs"));
  const sdk = packageSdk(implementationRoot, toolchainRoot);
  const pythonSdk = packagePythonSdk(implementationRoot, toolchainRoot);
  writeLaunchers();
  writeMetadata(sdk, pythonSdk);

  if (options.quiet !== true) {
    process.stdout.write(`TOOLCHAIN ${toolchainRoot}\n`);
  }
  return {
    toolchainRoot,
    platform,
  };
}

function buildCompiler() {
  const result = spawnSync(process.env.CARGO ?? "cargo", [
    "build",
    "--locked",
    "-p",
    "touba-cli",
    "--bin",
    "touba-compile",
    "--release",
  ], {
    cwd: implementationRoot,
    stdio: "inherit",
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`cargo build failed with status ${result.status}`);
  }
}

function copyNodeRuntime() {
  const nodeName = process.platform === "win32" ? "node.exe" : "node";
  const nodeSource = resolveNodeRuntimeSource(nodeName);
  copyFileSync(nodeSource, join(toolchainRoot, "bin", nodeName));
  chmodSync(join(toolchainRoot, "bin", nodeName), 0o755);
}

function resolveNodeRuntimeSource(nodeName) {
  const localNode = join(implementationRoot, ".toolchains", `node-v24.15.0-${platform}`, "bin", nodeName);
  if (existsSync(localNode)) {
    return realpathSync(localNode);
  }
  return realpathSync(process.execPath);
}

function copyCompiler() {
  const executableName = process.platform === "win32" ? "touba-compile.exe" : "touba-compile";
  const compilerSource = join(implementationRoot, "target", "release", executableName);
  if (!existsSync(compilerSource)) {
    throw new Error(`missing compiler binary ${compilerSource}`);
  }
  copyFileSync(compilerSource, join(toolchainRoot, "bin", executableName));
  chmodSync(join(toolchainRoot, "bin", executableName), 0o755);
}

function copyToubaPackages() {
  for (const relativePackage of copiedPackages) {
    copyPackage(relativePackage, join(toolchainRoot, "lib", relativePackage));
  }

  for (const [relativePackage, alias] of nodeModuleAliases) {
    copyPackage(relativePackage, join(toolchainRoot, "lib", "node_modules", ...alias.split("/")));
  }
}

function copyPackage(relativePackage, destination) {
  const source = join(implementationRoot, relativePackage);
  if (!existsSync(source)) {
    throw new Error(`missing package source ${source}`);
  }
  mkdirSync(destination, { recursive: true });
  copyFileSync(join(source, "package.json"), join(destination, "package.json"));
  const sourceDirectory = join(source, "src");
  if (existsSync(sourceDirectory)) {
    cpSync(sourceDirectory, join(destination, "src"), { recursive: true });
  }
}

function copyRuntimeContracts() {
  for (const root of ["lib/contracts", "lib/node_modules/contracts"]) {
    mkdirSync(join(toolchainRoot, root), { recursive: true });
    copyFileSync(join(implementationRoot, "contracts/resource-bindings.mjs"), join(toolchainRoot, root, "resource-bindings.mjs"));
    copyFileSync(join(implementationRoot, "contracts/run-outcome.mjs"), join(toolchainRoot, root, "run-outcome.mjs"));
  }
  for (const family of ["machine", "product-surfaces", "hardened", "packages"]) {
    const source = join(implementationRoot, "contracts", family);
    for (const destination of [
      join(toolchainRoot, "lib", "contracts", family),
      join(toolchainRoot, "lib", "node_modules", "contracts", family),
    ]) {
      mkdirSync(destination, { recursive: true });
      cpSync(source, destination, { recursive: true });
    }
  }
}

function writeLaunchers() {
  const shellLauncher = `#!/bin/sh
case "$0" in
  */*) SCRIPT_DIR="\${0%/*}" ;;
  *) SCRIPT_DIR="." ;;
esac
ROOT="$(CDPATH= cd "$SCRIPT_DIR/.." && pwd)"
export TOUBA_DISTRIBUTION_CHANNEL="\${TOUBA_DISTRIBUTION_CHANNEL:-local-archive}"
export TOUBA_COMPILE_BIN="$ROOT/bin/touba-compile"
export PATH="$ROOT/bin:$PATH"
exec "$ROOT/bin/node" "$ROOT/lib/cli/touba-project/src/main.mjs" "$@"
`;
  writeFileSync(join(toolchainRoot, "bin", "touba"), shellLauncher, "utf8");
  chmodSync(join(toolchainRoot, "bin", "touba"), 0o755);

  const cmdLauncher = `@echo off
set "ROOT=%~dp0.."
if "%TOUBA_DISTRIBUTION_CHANNEL%"=="" set "TOUBA_DISTRIBUTION_CHANNEL=local-archive"
set "TOUBA_COMPILE_BIN=%ROOT%\\bin\\touba-compile.exe"
set "PATH=%ROOT%\\bin;%PATH%"
"%ROOT%\\bin\\node.exe" "%ROOT%\\lib\\cli\\touba-project\\src\\main.mjs" %*
`;
  writeFileSync(join(toolchainRoot, "bin", "touba.cmd"), cmdLauncher, "utf8");
}

function writeMetadata(sdk, pythonSdk) {
  const metadata = {
    toolchain_profile: "touba-local-toolchain-v1",
    platform,
    sdk,
    python_sdk: pythonSdk,
    build: toolchainBuildIdentity(toolchainRoot),
    touba_version: readPackageVersion(join(implementationRoot, "cli", "touba-project", "package.json")),
    node_source: resolveNodeRuntimeSource(process.platform === "win32" ? "node.exe" : "node"),
    entrypoints: {
      cli: "bin/touba",
      compiler: process.platform === "win32" ? "bin/touba-compile.exe" : "bin/touba-compile",
      node: process.platform === "win32" ? "bin/node.exe" : "bin/node",
    },
    included_components: [
      "touba public CLI facade",
      "touba-compile release binary",
      "Touba runtime Node packages",
      "Touba inspect and manifest CLI tools",
      "Touba trigger ingress service",
      "Touba project server",
      "Installable SDK tarball with locked runtime dependencies and licenses",
      "Installable Python SDK wheel without Python runtime dependencies",
      "Node runtime used to package the archive",
    ],
    excluded_prerequisites_for_users: [
      "Rust toolchain",
      "Cargo",
      "pnpm",
      "repository checkout",
    ],
    limitations: [
      "local archive profile only",
      "manual reinstall update policy",
      "checksums and signatures are applied by release packaging, not by this local toolchain archive",
    ],
  };
  writeFileSync(join(toolchainRoot, "TOOLCHAIN.json"), `${JSON.stringify(metadata, null, 2)}\n`, "utf8");
  writeFileSync(join(toolchainRoot, "README.txt"), [
    "Touba local toolchain archive",
    "",
    "Add the bin directory to PATH, then run: touba version",
    "This local archive is a packaging validation artifact, not a signed public release.",
    "",
  ].join("\n"), "utf8");
}

function readPackageVersion(packageJsonPath) {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    packageLocalToolchain();
  } catch (error) {
    process.stderr.write(`touba distribution: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
