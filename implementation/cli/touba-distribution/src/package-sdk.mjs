import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { npmCommand } from "./npm-command.mjs";

// Package the exact installed, locked dependency tree, including licenses.
// No install, network access, lifecycle scripts or global project dependency.
export function packageSdk(implementationRoot, toolchainRoot) {
  const source = join(implementationRoot, "runtime/touba-handler-sdk");
  const staging = mkdtempSync(join(tmpdir(), "touba-sdk-package-"));
  try {
    const root = join(staging, "package");
    mkdirSync(root);
    cpSync(join(source, "src"), join(root, "src"), { recursive: true });
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
    const filename = JSON.parse(pack.stdout)[0].filename;
    // The toolchain's SDK copy must also work when inspected directly. User
    // projects install the tarball, never link to this mutable installation.
    for (const destination of ["lib/runtime/touba-handler-sdk", "lib/node_modules/@touba/sdk"]) {
      cpSync(root, join(toolchainRoot, destination), { recursive: true });
    }
    return { name: manifest.name, version: manifest.version, archive: `sdk/${filename}`,
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
export function copyDependency(source, destination, inventory, ancestors = new Set()) {
  if (ancestors.has(source)) throw new Error("SDK dependency cycle requires an explicit packaging layout");
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  inventory.set(`${manifest.name}@${manifest.version}`, { name: manifest.name, version: manifest.version, license: manifest.license ?? null });
  mkdirSync(dirname(destination), { recursive: true });
  cpSync(source, destination, { recursive: true, dereference: true,
    filter: file => basename(file) !== "node_modules" && basename(file) !== ".git" });
  const next = new Set(ancestors).add(source);
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
    copyDependency(dependency, join(destination, "node_modules", name), inventory, next);
  }
}
