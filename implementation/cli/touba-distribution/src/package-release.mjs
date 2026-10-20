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
    releaseProfile: "touba-local-release-v1",
    installationProfile: "touba-local-release-install-v1",
    validationStatus: "pending_validation",
    platformLimitation: "this build requires its own installed-archive smoke and qualification",
  }),
});

export const PUBLIC_RELEASE_PLATFORMS = Object.freeze({
  "darwin-arm64": publicReleasePlatform("macOS Apple Silicon"),
  "darwin-x64": publicReleasePlatform("macOS Intel"),
  "linux-x64": publicReleasePlatform("Linux x64"),
  "win32-x64": publicReleasePlatform("Windows x64"),
});

const EXPERIMENTAL_RELEASE_PROFILE = "touba-local-release-experimental-v1";
const EXPERIMENTAL_INSTALLATION_PROFILE = "touba-local-release-install-experimental-v1";
const EXPERIMENTAL_CHANNEL = "local-release-experimental";
const LOCAL_RELEASE_SCOPE = "local_validation";
const PUBLIC_RELEASE_SCOPE = "public_distribution";

function publicReleasePlatform(label) {
  return Object.freeze({
    channel: "github-release",
    releaseProfile: "touba-github-release-v1",
    installationProfile: "touba-github-release-install-v1",
    validationStatus: "pending_validation",
    platformLimitation: `${label} archive requires successful smoke tests and reviewed candidate qualification before promotion`,
  });
}

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
  mkdirSync(join(plan.releaseDir, "support"));
  for (const file of ["install-toolchain-payload.mjs", "build-identity.mjs"]) {
    cpSync(join(currentDir, file), join(plan.releaseDir, "support", file));
  }
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
  writeGithubReleaseDraft(plan, tarballSha256);

  const release = {
    release_name: plan.releaseName,
    release_dir: plan.releaseDir,
    tarball_path: plan.tarballPath,
    checksums_path: plan.checksumsPath,
    checksums_json_path: plan.checksumsJsonPath,
    draft_path: plan.draftPath,
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

  const publicRelease = options.publicRelease === true;
  const validated = publicRelease ? PUBLIC_RELEASE_PLATFORMS[platform] : VALIDATED_RELEASE_PLATFORMS[platform];
  if (!validated && publicRelease) {
    throw new Error(`release platform ${platform} is not part of the public release platform set`);
  }
  if (!validated && options.experimental !== true) {
    throw new Error(`release platform ${platform} is not validated; use --experimental to create a clearly marked local artifact`);
  }

  const toubaVersion = options.toubaVersion ?? readPackageVersion(join(implementationRoot, "cli", "touba-project", "package.json"));
  const releaseName = `touba-v${toubaVersion}-${platform}`;
  const root = options.releaseRoot ?? releaseRoot;
  const channel = publicRelease
    ? normalizePublicReleaseChannel(options.channel ?? validated.channel)
    : normalizeLocalReleaseChannel(options.channel ?? validated?.channel ?? EXPERIMENTAL_CHANNEL);
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
    draftPath: join(root, "GITHUB_RELEASE_DRAFT.md"),
    channel,
    validationStatus,
    releaseProfile,
    installationProfile,
    releaseScope: publicRelease ? PUBLIC_RELEASE_SCOPE : LOCAL_RELEASE_SCOPE,
    platformLimitation,
    publicRelease,
    limitations: releaseLimitations({ platformLimitation, validationStatus, publicRelease }),
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

function normalizePublicReleaseChannel(channel) {
  if (typeof channel !== "string" || channel.trim() === "") {
    throw new Error("release channel must be a non-empty string");
  }
  if (channel === "github-release") {
    return channel;
  }
  throw new Error(`release channel ${channel} is not allowed for public release artifacts`);
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
    } else if (arg === "--public") {
      options.publicRelease = true;
    } else if (arg === "--allow-other-platform") {
      options.allowOtherPlatform = true;
    } else if (arg === "--no-build-compiler") {
      options.buildCompiler = false;
    } else if (arg === "--release-root") {
      options.releaseRoot = resolve(requiredValue(arg, rawArgs, ++index));
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
set -- --source "$SOURCE" --prefix "$PREFIX"
if [ "$FORCE" = "1" ]; then set -- "$@" --force; fi
"$SOURCE/bin/node" "$SCRIPT_DIR/support/install-toolchain-payload.mjs" "$@"

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
  "update_policy": "${plan.publicRelease ? "reinstall from a newer GitHub Release archive or package-manager channel" : "rerun install.sh --force from a newer local release archive"}",
  "public_release": ${String(plan.publicRelease)}
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

if [ -t 0 ] && [ -n "$SHELL_RC" ] && ! grep -q "$PREFIX/bin" "$SHELL_RC" 2>/dev/null; then
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
$InstallArguments = @("--source", $Source, "--prefix", $Prefix)
if ($Force) { $InstallArguments += "--force" }
& (Join-Path $Source "bin\\node.exe") (Join-Path $ScriptDir "support\\install-toolchain-payload.mjs") @InstallArguments
if ($LASTEXITCODE -ne 0) { throw "Touba payload transition refused; existing builds are preserved" }

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
  update_policy = "${plan.publicRelease ? "reinstall from a newer GitHub Release archive or package-manager channel" : "rerun install.ps1 -Force from a newer local release archive"}"
  public_release = $${plan.publicRelease ? "true" : "false"}
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
$Root = [System.IO.Path]::GetPathRoot($Prefix)
if ($Prefix.TrimEnd('\\') -eq $Root.TrimEnd('\\') -or $Prefix.TrimEnd('\\') -eq $HOME.TrimEnd('\\')) {
  throw "Refusing to uninstall from a filesystem root or home directory"
}
if (!(Test-Path -LiteralPath $Prefix)) { return }
$Metadata = Join-Path $Prefix "INSTALLATION.json"
$Bin = Join-Path $Prefix "bin"
$Payload = Join-Path $Prefix "touba-toolchain"
$Launcher = Join-Path $Prefix "bin\\touba.cmd"
# Validate all owned paths before removing anything. Never follow a junction.
foreach ($Path in @($Prefix, $Metadata, $Bin, $Payload, $Launcher)) {
  if ((Test-Path -LiteralPath $Path) -and ((Get-Item -LiteralPath $Path -Force).Attributes -band [IO.FileAttributes]::ReparsePoint)) {
    throw "Refusing to uninstall through a reparse point: $Path"
  }
}
if (!(Test-Path -LiteralPath $Metadata -PathType Leaf)) {
  throw "No Touba installation metadata at $Prefix"
}
$Installation = Get-Content -LiteralPath $Metadata -Raw | ConvertFrom-Json
$Profiles = @("touba-local-release-install-v1", "touba-local-release-install-experimental-v1", "touba-github-release-install-v1")
if ($Installation.installation_profile -notin $Profiles -or $Installation.platform -ne "win32-x64" -or $Installation.prefix -ne $Prefix -or $Installation.cli_path -ne $Launcher) {
  throw "Touba installation metadata does not match this directory"
}
if (Test-Path -LiteralPath $Payload) {
  $Links = @(Get-ChildItem -LiteralPath $Payload -Recurse -Force | Where-Object { $_.Attributes -band [IO.FileAttributes]::ReparsePoint })
  if ($Links.Count -gt 0) { throw "Refusing to uninstall a payload containing reparse points" }
}
if (Test-Path -LiteralPath $Launcher) { Remove-Item -LiteralPath $Launcher -Force }
if (Test-Path -LiteralPath $Payload) { Remove-Item -LiteralPath $Payload -Recurse -Force }
Remove-Item -LiteralPath $Metadata -Force
# Saved builds and user files stay intact. Delete containers only when empty;
# Remove-Item on a nonempty directory can prompt in Windows PowerShell 5.1.
foreach ($Directory in @($Bin, $Prefix)) {
  if ((Test-Path -LiteralPath $Directory -PathType Container) -and @(Get-ChildItem -LiteralPath $Directory -Force).Count -eq 0) {
    [IO.Directory]::Delete($Directory, $false)
  }
}
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
  const releaseScopeLines = plan.publicRelease
    ? [
      "This archive is a Touba GitHub Release artifact.",
      "Verify the downloaded archive with SHA256SUMS or CHECKSUMS.json before installing.",
    ]
    : [
      "This bundle is a local release validation artifact.",
      "It is not signed, not notarized and not distributed through a public update channel.",
    ];
  writeFileSync(join(plan.releaseDir, "README.txt"), [
    plan.publicRelease ? "Touba release bundle" : "Touba local release bundle",
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
    ...releaseScopeLines,
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
    checksum_profile: "touba-release-checksums-v1",
    touba_version: plan.toubaVersion,
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

function writeGithubReleaseDraft(plan, tarballSha256) {
  const lines = [
    `# Touba v${plan.toubaVersion} ${plan.platform}`,
    "",
    plan.publicRelease
      ? "GitHub Release notes for the Touba public archive generated by the release pipeline."
      : "Manual GitHub Release draft. Keep this release unpublished until the V1 Go/No-Go gate is explicitly passed.",
    "",
    "## Artifacts",
    "",
    `- \`${plan.releaseName}.tar.gz\``,
    "- `SHA256SUMS`",
    "- `CHECKSUMS.json`",
    "",
    "## Verification",
    "",
    `- sha256: \`${tarballSha256}\``,
    `- channel: \`${plan.channel}\``,
    `- validation_status: \`${plan.validationStatus}\``,
    `- public_release: \`${String(plan.publicRelease)}\``,
    "- generated by Touba release packaging; verify the CI run before publishing",
    "",
    "## Install",
    "",
    ...releaseInstallInstructions(plan),
    "",
  ];
  if (plan.limitations.length > 0) {
    lines.push("## Notes", "", ...plan.limitations.map((item) => `- ${item}`), "");
  }
  writeFileSync(plan.draftPath, lines.join("\n"), "utf8");
}

function releaseInstallInstructions(plan) {
  if (plan.platform.startsWith("win32-")) {
    return [
      "Windows PowerShell:",
      "",
      "```powershell",
      "tar -xzf " + `${plan.releaseName}.tar.gz`,
      `powershell -ExecutionPolicy Bypass -File ${plan.releaseName}\\install.ps1 -Prefix "$HOME\\.touba" -Force`,
      "touba version --json",
      "```",
    ];
  }
  return [
    "POSIX shells:",
    "",
    "```sh",
    "tar -xzf " + `${plan.releaseName}.tar.gz`,
    `sh ${plan.releaseName}/install.sh --prefix "$HOME/.touba" --force`,
    "touba version --json",
    "```",
  ];
}

function releaseLimitations({ platformLimitation, validationStatus, publicRelease }) {
  if (publicRelease) {
    return [
      "packaging does not qualify this build; promotion requires current-candidate release-readiness evidence",
      "manual update policy; automatic self-update is not enabled in V1",
      "signing and package-manager channels are separate release hardening tracks",
    ];
  }
  const limitations = [
    "local release bundle only",
    "not signed",
    "not notarized",
    "not published through a public update channel",
    "no Homebrew, Winget, Scoop, npm global or remote installer publication",
    platformLimitation,
  ];
  if (validationStatus === "experimental_unvalidated") {
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
    "Usage: package-release [--platform <platform>] [--release-root <directory>] [--public] [--experimental] [--json]",
    "",
    "Creates a Touba release bundle for the current host platform.",
    "Cross-platform packaging is refused by default.",
    "Use --public only from the release workflow for validated public platforms.",
    "Unvalidated local platforms require --experimental and remain non-public artifacts.",
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
