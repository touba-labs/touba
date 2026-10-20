#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { toolchainBuildIdentity } from "./build-identity.mjs";

const sourceDir = dirname(fileURLToPath(import.meta.url));
const templates = resolve(sourceDir, "../installers");
const formats = { "darwin-arm64": "dmg", "darwin-x64": "dmg", "win32-x64": "exe", "linux-x64": "deb" };

// Match the minimum OS of the bundled Node 24 binary, not the builder's OS.
const macosMinimum = "13.5";
export function macosInstallerTarget(platform) {
  if (!["darwin-arm64", "darwin-x64"].includes(platform)) throw new Error("A native macOS target is required");
  return `${platform === "darwin-arm64" ? "arm64" : "x86_64"}-apple-macos${macosMinimum}`;
}

export function installerPlan(release) {
  if (!formats[release.platform]) throw new Error("Unsupported desktop installer platform");
  if (!/^\d+\.\d+\.\d+$/.test(release.touba_version ?? "")) throw new Error("Installer version must be a numeric three-part version");
  return {
    platform: release.platform, version: release.touba_version, format: formats[release.platform],
    filename: `touba-v${release.touba_version}-${release.platform}-setup.${formats[release.platform]}`,
    validation_status: "pending_native_validation", signing_status: "unsigned_local_candidate",
  };
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stdout + result.stderr}`);
  return result.stdout;
}
function write(path, content, executable = false) {
  mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, content);
  if (executable) chmodSync(path, 0o755);
}
function copySupport(destination) {
  mkdirSync(join(destination, "src"), { recursive: true });
  for (const name of ["desktop-install.mjs", "install-toolchain-payload.mjs", "build-identity.mjs"]) cpSync(join(sourceDir, name), join(destination, "src", name));
}

export function debianControl(version) {
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error("Invalid Debian package version");
  // The release worker is Ubuntu 24.04; do not advertise older glibc support.
  return `Package: touba\nVersion: ${version}\nSection: devel\nPriority: optional\nArchitecture: amd64\nMaintainer: Touba Labs\nDepends: libc6 (>= 2.39), libstdc++6, libgcc-s1\nDescription: Touba language and governed execution runtime\n Includes the compiler, runtime and offline JavaScript/Python SDK archives.\n SDKs are installed explicitly per project.\n`;
}

export function packageInstallers({ releaseDir, outputDir }) {
  releaseDir = resolve(releaseDir); outputDir = resolve(outputDir);
  const release = JSON.parse(readFileSync(join(releaseDir, "RELEASE.json"), "utf8"));
  const plan = installerPlan(release);
  if (plan.platform !== `${process.platform}-${process.arch}`) throw new Error("Build desktop installers on their target OS and architecture; cross-packaging is not qualification.");
  const source = join(releaseDir, "touba-toolchain");
  const metadata = JSON.parse(readFileSync(join(source, "TOOLCHAIN.json"), "utf8"));
  if (metadata.platform !== plan.platform || metadata.touba_version !== plan.version || metadata.build?.id !== toolchainBuildIdentity(source).id) throw new Error("Installer payload metadata or build identity mismatch");
  // A partial prior build must not be relabelled by overwriting its manifest.
  if (existsSync(outputDir) && readdirSync(outputDir).length !== 0) throw new Error("Installer output directory must be empty; preserve previous candidates.");
  mkdirSync(outputDir, { recursive: true });
  const destination = join(outputDir, plan.filename);
  if (existsSync(destination)) throw new Error("Installer artifact already exists; use a fresh output directory.");
  const staging = mkdtempSync(join(outputDir, ".installer-build-"));
  let app;
  try {
    if (plan.format === "dmg") {
      const volume = join(staging, "volume");
      app = join(volume, "Install Touba.app");
      const contents = join(app, "Contents");
      mkdirSync(join(contents, "MacOS"), { recursive: true });
      mkdirSync(join(contents, "Resources"));
      cpSync(source, join(contents, "Resources/payload"), { recursive: true });
      copySupport(join(contents, "Resources/support"));
      write(join(contents, "Info.plist"), `<?xml version="1.0" encoding="UTF-8"?>\n<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">\n<plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.touba-labs.installer</string><key>CFBundleName</key><string>Install Touba</string><key>CFBundleExecutable</key><string>ToubaInstaller</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleShortVersionString</key><string>${plan.version}</string><key>CFBundleVersion</key><string>${plan.version}</string><key>LSMinimumSystemVersion</key><string>${macosMinimum}</string><key>NSHighResolutionCapable</key><true/></dict></plist>\n`);
      run("swiftc", [join(templates, "Installer.swift"), "-target", macosInstallerTarget(plan.platform), "-module-cache-path", join(staging, "swift-cache"), "-o", join(contents, "MacOS/ToubaInstaller"), "-framework", "AppKit"]);
      write(join(volume, "Read me.txt"), "Open Install Touba.app to install for this account. No admin password.\nThis local candidate is not a signed/notarized public release. Do not disable Gatekeeper.\nThe installer does not install Python or npm, or change project SDKs.\n");
      run("hdiutil", ["create", "-volname", "Touba Installer", "-srcfolder", volume, "-format", "UDZO", destination]);
      run("hdiutil", ["verify", destination]);
      // Keep an inspectable .app beside the DMG for native smoke/UI qualification.
      cpSync(app, join(outputDir, "Install Touba.app"), { recursive: true, force: false, errorOnExist: true });
    } else if (plan.format === "exe") {
      const payload = join(staging, "payload"); cpSync(source, payload, { recursive: true });
      const support = join(staging, "support"); copySupport(support);
      const welcome = join(staging, "Welcome.txt");
      write(welcome, "Install Touba for this account without an administrator password.\r\nCompiler, runtime and both SDK archives are included.\r\nStop Touba services before updating. No project data or SDK is modified.\r\nAfter installation, open a new terminal. In your project choose:\r\n  touba sdk install javascript\r\n  touba sdk install python\r\nPython 3.11+ or npm is required only for the SDK you choose.\r\nThis is an unsigned local candidate, not a public release.\r\n");
      run(process.env.TOUBA_ISCC ?? "ISCC.exe", [`/DToubaVersion=${plan.version}`, `/DPayloadDir=${payload}`, `/DSupportDir=${support}`, `/DWelcomeFile=${welcome}`, `/DOutputDir=${outputDir}`, `/DOutputName=${plan.filename.slice(0, -4)}`, join(templates, "windows.iss")]);
    } else {
      const deb = join(staging, "deb");
      cpSync(source, join(deb, "opt/touba/toolchain"), { recursive: true });
      write(join(deb, "DEBIAN/control"), debianControl(plan.version));
      write(join(deb, "usr/bin/touba"), '#!/bin/sh\nexec /opt/touba/toolchain/bin/touba "$@"\n', true);
      write(join(deb, "usr/share/doc/touba/README"), "Install/remove with the system package manager. User projects and SDKs are not managed by this package. Stop Touba services before upgrading; an upgrade replaces the system toolchain and does not resume checkpoints.\nIn a project: touba sdk install javascript or touba sdk install python.\n");
      run("dpkg-deb", ["--root-owner-group", "--build", deb, destination]);
      run("dpkg-deb", ["--info", destination]);
    }
    const bytes = readFileSync(destination);
    const report = { ...plan, build: metadata.build.id, path: destination, size_bytes: bytes.length,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      prerequisite: plan.format === "deb" ? "Ubuntu 24.04+ or compatible Debian with glibc >= 2.39, x64"
        : plan.format === "dmg" ? `macOS ${macosMinimum}+ (${plan.platform})` : plan.platform,
    };
    write(join(outputDir, "INSTALLER.json"), JSON.stringify(report, null, 2) + "\n");
    write(join(outputDir, "SHA256SUMS"), `${report.sha256}  ${plan.filename}\n`);
    return report;
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const options = {};
    const args = process.argv.slice(2);
    if (args.includes("--help")) process.stdout.write("Usage: package-installers.mjs --release-dir <extracted-release> --out <new-output-directory>\nBuilds an unsigned native candidate on the current OS only.\n");
    else {
      for (let i = 0; i < args.length; i++) {
        if (!["--release-dir", "--out"].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith("--")) throw new Error("Invalid installer builder option");
        const key = args[i] === "--release-dir" ? "releaseDir" : "outputDir";
        options[key] = args[++i];
      }
      if (!options.releaseDir || !options.outputDir) throw new Error("--release-dir and --out are required");
      process.stdout.write(JSON.stringify(packageInstallers(options), null, 2) + "\n");
    }
  } catch (error) { process.stderr.write(`Touba installer packaging: ${error.message}\n`); process.exitCode = 1; }
}
