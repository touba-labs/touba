#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { packageLocalToolchain } from "./package-local-toolchain.mjs";

const currentFile = fileURLToPath(import.meta.url);
const currentDir = dirname(currentFile);
const packageRoot = resolve(currentDir, "..");
const implementationRoot = resolve(currentDir, "../../..");
const releaseRoot = join(packageRoot, "dist", "release");

export const VALIDATED_RELEASE_PLATFORMS = Object.freeze({
  "darwin-arm64": Object.freeze({
    channel: "macos-local-release",
    releaseProfile: "touba-local-release-v0.2",
    installationProfile: "touba-local-release-install-v0.2",
    validationStatus: "local_verified",
    platformLimitation: "only darwin-arm64 has a local release smoke validation in this repository",
  }),
});

const EXPERIMENTAL_RELEASE_PROFILE = "touba-local-release-experimental-v0.1";
const EXPERIMENTAL_INSTALLATION_PROFILE = "touba-local-release-install-experimental-v0.1";
const EXPERIMENTAL_CHANNEL = "local-release-experimental";
const LOCAL_RELEASE_SCOPE = "local_validation";

export function packageRelease(options = {}) {
  const plan = createReleasePlan(options);
  const { toolchainRoot, platform } = packageLocalToolchain({
    buildCompiler: options.buildCompiler,
    quiet: options.quiet,
  });
  if (platform !== plan.platform) {
    throw new Error(`toolchain platform ${platform} does not match release platform ${plan.platform}`);
  }

  rmSync(plan.releaseDir, { recursive: true, force: true });
  mkdirSync(plan.releaseRoot, { recursive: true });
  cpSync(toolchainRoot, join(plan.releaseDir, "touba-toolchain"), { recursive: true });
  writeInstallScript(plan);
  writeUninstallScript(plan);
  writeInstallPowerShell(plan);
  writeUninstallPowerShell(plan);
  writeReleaseReadme(plan);
  writeReleaseMetadata(plan, toolchainRoot);

  rmSync(plan.tarballPath, { force: true });
  const tar = spawnSync("tar", ["-czf", plan.tarballPath, "-C", plan.releaseRoot, plan.releaseName], {
    stdio: "inherit",
  });
  if (tar.error) {
    throw tar.error;
  }
  if (tar.status !== 0) {
    throw new Error(`tar failed with status ${tar.status}`);
  }

  const tarballSha256 = sha256File(plan.tarballPath);
  writeChecksums(plan, tarballSha256);

  const release = {
    release_name: plan.releaseName,
    release_dir: plan.releaseDir,
    tarball_path: plan.tarballPath,
    checksums_path: plan.checksumsPath,
    checksums_json_path: plan.checksumsJsonPath,
    platform: plan.platform,
    channel: plan.channel,
    validation_status: plan.validationStatus,
    sha256: tarballSha256,
  };
  if (options.quiet !== true) {
    process.stdout.write(`RELEASE ${plan.tarballPath}\n`);
    process.stdout.write(`CHECKSUMS ${plan.checksumsPath}\n`);
  }
  return release;
}

export function createReleasePlan(options = {}) {
  const hostPlatform = options.hostPlatform ?? currentPlatform();
  const platform = normalizePlatform(options.platform ?? hostPlatform);
  if (platform !== hostPlatform && options.allowOtherPlatform !== true) {
    throw new Error(`cross-platform release packaging is not supported: requested ${platform}, host is ${hostPlatform}`);
  }

  const validated = VALIDATED_RELEASE_PLATFORMS[platform];
  if (!validated && options.experimental !== true) {
    throw new Error(`release platform ${platform} is not validated; use --experimental to create a clearly marked local artifact`);
  }

  const toubaVersion = options.toubaVersion ?? readPackageVersion(join(implementationRoot, "cli", "touba-project", "package.json"));
  const releaseName = `touba-v${toubaVersion}-${platform}`;
  const root = options.releaseRoot ?? releaseRoot;
  const channel = normalizeLocalReleaseChannel(options.channel ?? validated?.channel ?? EXPERIMENTAL_CHANNEL);
  const validationStatus = validated?.validationStatus ?? "experimental_unvalidated";
  const releaseProfile = validated?.releaseProfile ?? EXPERIMENTAL_RELEASE_PROFILE;
  const installationProfile = validated?.installationProfile ?? EXPERIMENTAL_INSTALLATION_PROFILE;
  const platformLimitation = validated?.platformLimitation ?? `platform ${platform} has not passed a Touba release validation gate`;

  return {
    hostPlatform,
    platform,
    toubaVersion,
    releaseName,
    releaseRoot: root,
    releaseDir: join(root, releaseName),
    tarballPath: join(root, `${releaseName}.tar.gz`),
    checksumsPath: join(root, "SHA256SUMS"),
    checksumsJsonPath: join(root, "CHECKSUMS.json"),
    channel,
    validationStatus,
    releaseProfile,
    installationProfile,
    releaseScope: LOCAL_RELEASE_SCOPE,
    platformLimitation,
    publicRelease: false,
    limitations: releaseLimitations(platformLimitation, validationStatus),
  };
}

function normalizeLocalReleaseChannel(channel) {
  if (typeof channel !== "string" || channel.trim() === "") {
    throw new Error("release channel must be a non-empty string");
  }
  if (channel === "macos-local-release" || channel === EXPERIMENTAL_CHANNEL || channel.startsWith("local-")) {
    return channel;
  }
  throw new Error(`release channel ${channel} is not allowed for local-only artifacts`);
}

export function parsePackageReleaseArgs(rawArgs) {
  const options = {};
  for (let index = 0; index < rawArgs.length; index += 1) {
    const arg = rawArgs[index];
    if (arg === "--platform") {
      options.platform = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--platform=")) {
      options.platform = valueFromEquals(arg, "--platform");
    } else if (arg === "--channel") {
      options.channel = requiredValue(arg, rawArgs, ++index);
    } else if (arg.startsWith("--channel=")) {
      options.channel = valueFromEquals(arg, "--channel");
    } else if (arg === "--experimental") {
      options.experimental = true;
    } else if (arg === "--allow-other-platform") {
      options.allowOtherPlatform = true;
    } else if (arg === "--no-build-compiler") {
      options.buildCompiler = false;
    } else if (arg === "--json") {
      options.json = true;
    } else if (arg === "--help" || arg === "-h") {
      options.help = true;
    } else {
      throw new Error(`unknown option ${arg}`);
    }
  }
  return options;
}

function writeInstallScript(plan) {
  const script = `#!/bin/sh
set -eu

PREFIX="\${TOUBA_PREFIX:-$HOME/.touba}"
FORCE=0

usage() {
  cat <<'USAGE'
Usage: sh install.sh [--prefix <dir>] [--force]

Installs Touba from this local release bundle.
The default prefix is $HOME/.touba.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--prefix requires a value" >&2
        exit 2
      fi
      PREFIX="$1"
      ;;
    --prefix=*)
      PREFIX="\${1#--prefix=}"
      ;;
    --force)
      FORCE=1
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown option $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$PREFIX" ]; then
  echo "prefix must not be empty" >&2
  exit 2
fi

case "$PREFIX" in
  /*) ;;
  *)
    echo "--prefix must be an absolute path" >&2
    exit 2
    ;;
esac

if [ "$PREFIX" = "/" ]; then
  echo "--prefix must not be /" >&2
  exit 2
fi

case "$0" in
  */*) SCRIPT_DIR="\${0%/*}" ;;
  *) SCRIPT_DIR="." ;;
esac
SCRIPT_DIR="$(CDPATH= cd "$SCRIPT_DIR" && pwd)"
SOURCE="$SCRIPT_DIR/touba-toolchain"

if [ ! -x "$SOURCE/bin/touba" ]; then
  echo "missing Touba toolchain in $SOURCE" >&2
  exit 1
fi

if [ -e "$PREFIX/touba-toolchain" ] && [ "$FORCE" != "1" ]; then
  echo "Touba is already installed at $PREFIX; rerun with --force to replace it" >&2
  exit 1
fi

mkdir -p "$PREFIX/bin"
rm -rf "$PREFIX/touba-toolchain"
cp -R "$SOURCE" "$PREFIX/touba-toolchain"

cat > "$PREFIX/bin/touba" <<EOF
#!/bin/sh
export TOUBA_DISTRIBUTION_CHANNEL="\\\${TOUBA_DISTRIBUTION_CHANNEL:-${plan.channel}}"
exec "$PREFIX/touba-toolchain/bin/touba" "\\$@"
EOF
chmod 755 "$PREFIX/bin/touba"

cat > "$PREFIX/INSTALLATION.json" <<EOF
{
  "installation_profile": "${plan.installationProfile}",
  "channel": "${plan.channel}",
  "touba_version": "${plan.toubaVersion}",
  "platform": "${plan.platform}",
  "validation_status": "${plan.validationStatus}",
  "prefix": "$PREFIX",
  "cli_path": "$PREFIX/bin/touba",
  "update_policy": "rerun install.sh --force from a newer local release archive",
  "public_release": false
}
EOF

echo "Installed Touba ${plan.toubaVersion} at $PREFIX"
echo ""

SHELL_RC=""
if [ -f "$HOME/.zshrc" ]; then
  SHELL_RC="$HOME/.zshrc"
elif [ -f "$HOME/.bashrc" ]; then
  SHELL_RC="$HOME/.bashrc"
elif [ -f "$HOME/.profile" ]; then
  SHELL_RC="$HOME/.profile"
fi

if [ -n "$SHELL_RC" ] && ! grep -q "$PREFIX/bin" "$SHELL_RC" 2>/dev/null; then
  printf "Add $PREFIX/bin to PATH in %s? [Y/n] " "$SHELL_RC"
  read REPLY
  case "\${REPLY:-Y}" in
    [Yy]*)
      printf "\\n# Touba\\nexport PATH=\\"%s/bin:\\$PATH\\"\\n" "$PREFIX" >> "$SHELL_RC"
      echo "PATH added to $SHELL_RC"
      echo "Run: source $SHELL_RC"
      ;;
    *)
      echo "Skipped. Add manually: export PATH=\\"$PREFIX/bin:\\$PATH\\""
      ;;
  esac
else
  echo "Add $PREFIX/bin to PATH, then run: touba version"
fi
`;
  const scriptPath = join(plan.releaseDir, "install.sh");
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);
}

function writeUninstallScript(plan) {
  const script = `#!/bin/sh
set -eu

PREFIX="\${TOUBA_PREFIX:-$HOME/.touba}"

usage() {
  cat <<'USAGE'
Usage: sh uninstall.sh [--prefix <dir>]

Removes the files installed by the local Touba release bundle.
USAGE
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --prefix)
      shift
      if [ "$#" -eq 0 ]; then
        echo "--prefix requires a value" >&2
        exit 2
      fi
      PREFIX="$1"
      ;;
    --prefix=*)
      PREFIX="\${1#--prefix=}"
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown option $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [ -z "$PREFIX" ]; then
  echo "prefix must not be empty" >&2
  exit 2
fi

if [ "$PREFIX" = "/" ]; then
  echo "--prefix must not be /" >&2
  exit 2
fi

rm -f "$PREFIX/bin/touba" "$PREFIX/bin/touba.cmd"
rm -rf "$PREFIX/touba-toolchain"
rm -f "$PREFIX/INSTALLATION.json"
rmdir "$PREFIX/bin" 2>/dev/null || true
rmdir "$PREFIX" 2>/dev/null || true

echo "Removed Touba files from $PREFIX"
`;
  const scriptPath = join(plan.releaseDir, "uninstall.sh");
  writeFileSync(scriptPath, script, "utf8");
  chmodSync(scriptPath, 0o755);
}

export function renderWindowsCmdLauncher(plan) {
  return `@echo off
if "%TOUBA_DISTRIBUTION_CHANNEL%"=="" set "TOUBA_DISTRIBUTION_CHANNEL=${plan.channel}"
set "TOUBA_COMPILE_BIN=%~dp0..\\touba-toolchain\\bin\\touba-compile.exe"
set "PATH=%~dp0..\\touba-toolchain\\bin;%PATH%"
"%~dp0..\\touba-toolchain\\bin\\node.exe" "%~dp0..\\touba-toolchain\\lib\\cli\\touba-project\\src\\main.mjs" %*
`;
}

export function renderInstallPowerShell(plan) {
  const launcher = renderWindowsCmdLauncher(plan).replace(/\n$/u, "");
  return `param(
  [string]$Prefix = $env:TOUBA_PREFIX,
  [switch]$Force
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Prefix)) {
  $Prefix = Join-Path $HOME ".touba"
}

$Prefix = [System.IO.Path]::GetFullPath($Prefix)
$Root = [System.IO.Path]::GetPathRoot($Prefix)
if ($Prefix.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar) -eq $Root.TrimEnd([System.IO.Path]::DirectorySeparatorChar, [System.IO.Path]::AltDirectorySeparatorChar)) {
  throw "--prefix must not be a filesystem root"
}

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
$Source = Join-Path $ScriptDir "touba-toolchain"
$SourceCmd = Join-Path $Source "bin\\touba.cmd"
if (!(Test-Path $SourceCmd)) {
  throw "missing Touba Windows launcher in $Source"
}

$InstallRoot = Join-Path $Prefix "touba-toolchain"
if ((Test-Path $InstallRoot) -and -not $Force) {
  throw "Touba is already installed at $Prefix; rerun with -Force to replace it"
}

New-Item -ItemType Directory -Force -Path (Join-Path $Prefix "bin") | Out-Null
if (Test-Path $InstallRoot) {
  Remove-Item -Recurse -Force $InstallRoot
}
Copy-Item -Recurse -Force $Source $InstallRoot

$Launcher = @"
${launcher}
"@
Set-Content -Path (Join-Path $Prefix "bin\\touba.cmd") -Value $Launcher -Encoding ASCII

$Installation = [ordered]@{
  installation_profile = "${plan.installationProfile}"
  channel = "${plan.channel}"
  touba_version = "${plan.toubaVersion}"
  platform = "${plan.platform}"
  validation_status = "${plan.validationStatus}"
  prefix = $Prefix
  cli_path = (Join-Path $Prefix "bin\\touba.cmd")
  update_policy = "rerun install.ps1 -Force from a newer local release archive"
  public_release = $false
}
$Installation | ConvertTo-Json -Depth 4 | Set-Content -Path (Join-Path $Prefix "INSTALLATION.json") -Encoding UTF8

Write-Output "Installed Touba ${plan.toubaVersion} at $Prefix"
Write-Output "Add $(Join-Path $Prefix "bin") to PATH, then run: touba version"
`;
}

function writeInstallPowerShell(plan) {
  const script = renderInstallPowerShell(plan);
  const scriptPath = join(plan.releaseDir, "install.ps1");
  writeFileSync(scriptPath, script, "utf8");
}

export function renderUninstallPowerShell() {
  return `param(
  [string]$Prefix = $env:TOUBA_PREFIX
)

$ErrorActionPreference = "Stop"

if ([string]::IsNullOrWhiteSpace($Prefix)) {
  $Prefix = Join-Path $HOME ".touba"
}

$Prefix = [System.IO.Path]::GetFullPath($Prefix)
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "bin\\touba"), (Join-Path $Prefix "bin\\touba.cmd")
Remove-Item -Recurse -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "touba-toolchain")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "INSTALLATION.json")
Remove-Item -Force -ErrorAction SilentlyContinue (Join-Path $Prefix "bin")
Remove-Item -Force -ErrorAction SilentlyContinue $Prefix
Write-Output "Removed Touba files from $Prefix"
`;
}

function writeUninstallPowerShell(plan) {
  const script = renderUninstallPowerShell(plan);
  writeFileSync(join(plan.releaseDir, "uninstall.ps1"), script, "utf8");
}

function writeReleaseReadme(plan) {
  const platformLine = plan.validationStatus === "local_verified"
    ? `Platform validation: ${plan.validationStatus}`
    : `Platform validation: ${plan.validationStatus} (${plan.platformLimitation})`;
  writeFileSync(join(plan.releaseDir, "README.txt"), [
    "Touba local release bundle",
    "",
    "Install on POSIX shells:",
    "  sh install.sh --prefix \"$HOME/.touba\" --force",
    "",
    "Install on Windows PowerShell:",
    "  powershell -ExecutionPolicy Bypass -File install.ps1 -Prefix \"$HOME\\.touba\" -Force",
    "",
    "Use:",
    "  touba version",
    "",
    "Uninstall:",
    "  sh uninstall.sh --prefix \"$HOME/.touba\"",
    "  powershell -ExecutionPolicy Bypass -File uninstall.ps1 -Prefix \"$HOME\\.touba\"",
    "",
    platformLine,
    "This bundle is a local release validation artifact.",
    "It is not signed, not notarized and not distributed through a public update channel.",
    "",
    `Archive name: ${plan.releaseName}.tar.gz`,
    "",
  ].join("\n"), "utf8");
}

function writeReleaseMetadata(plan, toolchainRoot) {
  writeFileSync(join(plan.releaseDir, "RELEASE.json"), `${JSON.stringify({
    release_profile: plan.releaseProfile,
    release_scope: plan.releaseScope,
    release_name: plan.releaseName,
    touba_version: plan.toubaVersion,
    platform: plan.platform,
    host_platform: plan.hostPlatform,
    channel: plan.channel,
    validation_status: plan.validationStatus,
    toolchain_profile: readToolchainProfile(join(toolchainRoot, "TOOLCHAIN.json")),
    entrypoints: {
      install_posix: "install.sh",
      uninstall_posix: "uninstall.sh",
      install_windows: "install.ps1",
      uninstall_windows: "uninstall.ps1",
      cli_after_posix_install: "$PREFIX/bin/touba",
      cli_after_windows_install: "$Prefix\\bin\\touba.cmd",
    },
    verification: {
      checksum_file: "SHA256SUMS",
      checksum_manifest: "CHECKSUMS.json",
      checksum_algorithm: "sha256",
    },
    public_release: plan.publicRelease,
    limitations: plan.limitations,
  }, null, 2)}\n`, "utf8");
}

function writeChecksums(plan, tarballSha256) {
  writeFileSync(plan.checksumsPath, `${tarballSha256}  ${plan.releaseName}.tar.gz\n`, "utf8");
  writeFileSync(plan.checksumsJsonPath, `${JSON.stringify({
    checksum_profile: "touba-release-checksums-v0.2",
    algorithm: "sha256",
    release_name: plan.releaseName,
    platform: plan.platform,
    channel: plan.channel,
    validation_status: plan.validationStatus,
    public_release: plan.publicRelease,
    artifacts: [
      {
        path: `${plan.releaseName}.tar.gz`,
        sha256: tarballSha256,
      },
    ],
    limitations: plan.limitations,
  }, null, 2)}\n`, "utf8");
}

function releaseLimitations(platformLimitation, validationStatus) {
  const limitations = [
    "local release bundle only",
    "not signed",
    "not notarized",
    "not published through a public update channel",
    "no Homebrew, Winget, Scoop, npm global or remote installer publication",
    platformLimitation,
  ];
  if (validationStatus !== "local_verified") {
    limitations.unshift("experimental artifact; not a supported platform release");
  }
  return limitations;
}

function readToolchainProfile(path) {
  if (!existsSync(path)) {
    return null;
  }
  return JSON.parse(readFileSync(path, "utf8")).toolchain_profile ?? null;
}

function sha256File(path) {
  const hash = createHash("sha256");
  hash.update(readFileSync(path));
  return hash.digest("hex");
}

function currentPlatform() {
  return `${process.platform}-${process.arch}`;
}

function normalizePlatform(platform) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new Error("platform must not be empty");
  }
  if (!/^[a-z0-9]+-[a-z0-9_]+$/u.test(platform)) {
    throw new Error(`invalid platform ${platform}`);
  }
  return platform;
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

function readPackageVersion(packageJsonPath) {
  return JSON.parse(readFileSync(packageJsonPath, "utf8")).version;
}

function usage() {
  return [
    "Usage: package-release [--platform <platform>] [--experimental] [--json]",
    "",
    "Creates a local Touba release bundle for the current host platform.",
    "Cross-platform packaging is refused by default.",
    "Unvalidated platforms require --experimental and remain non-public artifacts.",
  ].join("\n");
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const options = parsePackageReleaseArgs(process.argv.slice(2));
    if (options.help === true) {
      process.stdout.write(`${usage()}\n`);
    } else {
      const release = packageRelease({
        ...options,
        quiet: options.json === true,
      });
      if (options.json === true) {
        process.stdout.write(`${JSON.stringify(release, null, 2)}\n`);
      }
    }
  } catch (error) {
    process.stderr.write(`touba release package: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
