import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { npmCommand } from "./npm-command.mjs";
import { sdkBuildIdentity } from "../../touba-manifest/src/sdk-build-identity.mjs";

// Package the exact installed, locked dependency tree, including licenses.
// No install, network access, lifecycle scripts or global project dependency.
export function packageSdk(implementationRoot, toolchainRoot) {
  const source = join(implementationRoot, "runtime/touba-handler-sdk");
  const staging = mkdtempSync(join(tmpdir(), "touba-sdk-package-"));
  try {
    const root = join(staging, "package");
    mkdirSync(root);
    cpSync(join(source, "src"), join(root, "src"), { recursive: true });
    // Materialize the canonical pure contract in the independently installed SDK.
    // Source uses a forwarding module; no maintained copy or external dependency.
    cpSync(join(implementationRoot, "contracts/machine/value-contracts.mjs"), join(root, "src/value-contracts.mjs"));
    cpSync(join(implementationRoot, "../LICENSE"), join(root, "LICENSE"));
    const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
    const inventory = new Map();
    for (const name of Object.keys(manifest.dependencies ?? {})) {
      const dependency = locateDependency(source, name);
      copyDependency(dependency, join(root, "node_modules", name), inventory);
      manifest.dependencies[name] = JSON.parse(readFileSync(join(dependency, "package.json"), "utf8")).version;
    }
    manifest.bundledDependencies = Object.keys(manifest.dependencies);
    manifest.files = ["src", "LICENSE", "DEPENDENCIES.json"];
    delete manifest.scripts;
    writeFileSync(join(root, "package.json"), JSON.stringify(manifest, null, 2) + "\n");
    const lockBytes = readFileSync(join(implementationRoot, "pnpm-lock.yaml"));
    const lockText = lockBytes.toString("utf8");
    for (const dependency of inventory.values()) {
      const key = `${dependency.name}@${dependency.version}`;
      if (!lockText.includes(`\n  ${key}:`) && !lockText.includes(`\n  '${key}':`)) {
        throw new Error(`SDK dependency ${key} is absent from the lockfile; reinstall with --frozen-lockfile`);
      }
    }
    const lockDigest = createHash("sha256").update(lockBytes).digest("hex");
    writeFileSync(join(root, "DEPENDENCIES.json"), JSON.stringify({
      lock_sha256: lockDigest,
      packages: [...inventory.values()].sort((a, b) => `${a.name}@${a.version}`.localeCompare(`${b.name}@${b.version}`)),
    }, null, 2) + "\n");
    const output = join(toolchainRoot, "sdk");
    mkdirSync(output, { recursive: true });
    const npm = npmCommand(["pack", "--offline", "--ignore-scripts", "--json", "--pack-destination", output]);
    const pack = spawnSync(npm.command, npm.args, {
        cwd: root, encoding: "utf8", env: { ...process.env, npm_config_cache: join(staging, "cache") },
      });
    if (pack.error || pack.status !== 0) throw new Error(`SDK packaging failed: ${pack.error?.message ?? pack.stderr}`);
    const packedFilename = JSON.parse(pack.stdout)[0].filename;
    const build = sdkBuildIdentity(root);
    const archiveDigest = createHash("sha256").update(readFileSync(join(output, packedFilename))).digest("hex");
    const filename = `touba-sdk-${manifest.version}-${archiveDigest.slice(0, 16)}.tgz`;
    renameSync(join(output, packedFilename), join(output, filename));
    // The toolchain's SDK copy must also work when inspected directly. User
    // projects install the tarball, never link to this mutable installation.
    for (const destination of ["lib/runtime/touba-handler-sdk", "lib/node_modules/@touba/sdk"]) {
      cpSync(root, join(toolchainRoot, destination), { recursive: true });
    }
    return { name: manifest.name, version: manifest.version, build, archive: `sdk/${filename}`,
      sha256: createHash("sha256").update(readFileSync(join(output, filename))).digest("hex") };
  } finally { rmSync(staging, { recursive: true, force: true }); }
}

function locateDependency(parent, name) {
  for (let dir = parent; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name);
    if (existsSync(join(candidate, "package.json"))) return realpathSync(candidate);
    if (dirname(dir) === dir) throw new Error(`SDK dependency missing: ${name}; install the workspace with its frozen lockfile before packaging`);
  }
}

// Preserve each installed dependency's own resolution tree. Flattening by name
// silently substitutes versions when two providers pin different releases.
export function copyDependency(source, destination, inventory, ancestors = new Map(), parentDestination = null) {
  source = realpathSync(source);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (ancestors.has(source)) {
    // A required peer may point back to its parent (pg-pool -> pg). Node must
    // resolve that edge to the exact ancestor already copied, not a different
    // version or a checkout/global package. No symlink or duplicate is needed.
    if (parentDestination && locateDependency(parentDestination, manifest.name) === realpathSync(ancestors.get(source))) return;
    throw new Error("SDK dependency cycle requires an explicit packaging layout");
  }
  inventory.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, version: manifest.version, license: manifest.license ?? null });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true,
    filter: file => basename(file) !== "node_modules" && basename(file) !== ".git" });
  const next = new Map(ancestors).set(source, destination);
  const dependencies = { ...manifest.dependencies, ...manifest.optionalDependencies };
  // Required peer dependencies are part of the runtime closure as well.
  for (const name of Object.keys(manifest.peerDependencies ?? {})) {
    if (manifest.peerDependenciesMeta?.[name]?.optional !== true) dependencies[name] = manifest.peerDependencies[name];
  }
  for (const name of Object.keys(dependencies)) {
    let dependency;
    try { dependency = locateDependency(source, name); } catch (error) {
      if (Object.hasOwn(manifest.optionalDependencies ?? {}, name)) continue;
      throw error;
    }
    copyDependency(dependency, join(destination, "node_modules", name), inventory, next, destination);
  }
}
