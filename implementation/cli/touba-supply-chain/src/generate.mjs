import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadSupplyChainArtifacts, resolveExecutable, sha256Text, SUPPLY_CHAIN_LOCK_SCHEMA_VERSION, validateSupplyChainArtifacts } from "./validate.mjs";
import { localImportClosure } from "./local-imports.mjs";
import { pythonImportClosure } from "./python-imports.mjs";

const dependencyNames = ["package-lock.json", "npm-shrinkwrap.json", "pnpm-lock.yaml", "yarn.lock"];
const pythonDependencyNames = ["pylock.toml", "uv.lock", "poetry.lock"];
const posix = (value) => value.split(path.sep).join("/");
function relativeFile(root, file) {
  const relative = path.relative(root, file);
  const physical = path.relative(realpathSync(root), realpathSync(file));
  if ([relative, physical].some((value) => value === ".." || value.startsWith(`..${path.sep}`) || path.isAbsolute(value)) || !statSync(file).isFile()) {
    throw new Error(`artifact must be a regular file confined to ${root}: ${file}`);
  }
  return posix(relative);
}
const digest = (file) => ({ kind: "sha256", value: sha256Text(readFileSync(file)) });

export function generateSupplyChainLock(options) {
  for (const field of ["air", "out"]) if (!options[field]) throw new Error(`--${field} is required`);
  const output = path.resolve(options.out);
  if (!output.endsWith(".lock.json")) throw new Error("--out must end with .lock.json");
  if (existsSync(output)) throw new Error("lock already exists; choose a new output path and review the new lock explicitly");
  const root = path.dirname(output);
  // The lock is the root of confinement. Its directory must already exist.
  const packageRoot = path.resolve(root, options.packageRoot ?? ".");
  const packagePath = path.join(packageRoot, "package.json");
  const artifacts = loadSupplyChainArtifacts(options);
  const additionalAir = (options.additionalAir ?? []).map(air => loadSupplyChainArtifacts({ air }).air);
  if ([artifacts.air, ...additionalAir].some(artifact => artifact.json.definitions?.tools?.length) && !artifacts.manifest) {
    throw new Error("AIR tools require --manifest");
  }
  const bindings = artifacts.manifest?.json.bindings ?? {};
  const files = new Set((options.files ?? []).map((file) => path.resolve(packageRoot, file)));
  const dependencies = new Set();
  const timestamp = new Date().toISOString();
  const record = (file, base = root) => ({ path: relativeFile(base, file), digest: digest(file) });
  const lock = {
    lock_schema_version: SUPPLY_CHAIN_LOCK_SCHEMA_VERSION,
    lock_kind: "supply_chain",
    generated_at: timestamp,
    generated_by: { tool: "touba supply-chain generate" },
    provenance: { prepared_by: { kind: "tool", id: "touba:supply-chain-generate" }, prepared_at: timestamp, source: { kind: "workspace", ref: "." } },
    review: { status: "pending" },
    air: record(artifacts.air.path),
    ...(additionalAir.length ? { additional_air: additionalAir.map(artifact => record(artifact.path)) } : {}),
    ...(artifacts.manifest ? { manifest: record(artifacts.manifest.path) } : {}),
    handlers: [],
  };
  const index = options.entrypointArg ?? 0;
  const sdkMetadata = options.sdkMetadataJson === undefined ? undefined : JSON.parse(options.sdkMetadataJson);
  if (index !== "command" && (!Number.isInteger(index) || index < 0)) throw new Error("--entrypoint-arg must be a non-negative index or command");
  for (const [toolRef, binding] of Object.entries(bindings)) {
    const handler = binding.handler;
    if (handler?.kind !== "process") throw new Error(`${toolRef}: a process binding is required`);
    const cwd = path.resolve(path.dirname(artifacts.manifest.path), handler.cwd ?? ".");
    const command = resolveExecutable(handler.command, cwd);
    if (!command) throw new Error(`${toolRef}: handler command is missing or not executable`);
    const argument = index === "command" ? command : handler.args?.[index];
    if (typeof argument !== "string" || argument.startsWith("-")) throw new Error(`${toolRef}: select the actual entrypoint with --entrypoint-arg`);
    const entrypoint = path.resolve(cwd, argument);
    // Confinement precedes parsing, including for an entrypoint in another tree.
    relativeFile(packageRoot, entrypoint);
    const isPython = entrypoint.endsWith(".py");
    const metadataPath = isPython ? path.join(packageRoot, "pyproject.toml") : packagePath;
    relativeFile(root, metadataPath);
    let identity, hasDependencies;
    if (isPython) {
      identity = pythonImportClosure(entrypoint, { packageRoot, python: options.python });
      hasDependencies = identity.has_dependencies;
      for (const file of identity.files) files.add(file);
    } else {
      identity = JSON.parse(readFileSync(packagePath, "utf8"));
      if (!identity.name || !identity.version) throw new Error("package.json must declare name and version");
      hasDependencies = Object.keys(identity.dependencies ?? {}).length || Object.keys(identity.devDependencies ?? {}).length;
      for (const file of localImportClosure(entrypoint)) files.add(file);
    }
    files.add(metadataPath);
    const dependencyFiles = (isPython ? pythonDependencyNames : dependencyNames).map(name => path.join(packageRoot, name)).filter(existsSync);
    if (hasDependencies && !dependencyFiles.length) {
      throw new Error(`${isPython ? "Python" : "JavaScript"} package dependencies require a real dependency lockfile before generating a supply-chain lock`);
    }
    for (const file of dependencyFiles) dependencies.add(file);
    lock.handlers.push({
      tool_ref: toolRef, path: relativeFile(root, entrypoint),
      command: handler.command, cwd: handler.cwd ?? ".", args: handler.args ?? [], digest: digest(entrypoint),
      ...(sdkMetadata === undefined ? {} : { sdk: structuredClone(sdkMetadata) }),
      handler_package: { kind: "local", name: identity.name, version: identity.version,
        package_root: posix(path.relative(root, packageRoot) || "."), entrypoint: relativeFile(packageRoot, entrypoint) },
    });
  }
  for (const handler of lock.handlers) {
    handler.handler_package.files = [...files].sort().map((file) => record(file, packageRoot));
    if (dependencies.size) handler.handler_package.dependency_artifacts = [...dependencies].sort().map((file) => record(file, packageRoot));
  }
  // SDK identity is explicitly supplied, never inferred from an import string.
  // Generation does not execute package code or approve these declarations.
  const report = validateSupplyChainArtifacts({ ...artifacts, lock: { path: output, json: lock } });
  if (report.status === "error") throw new Error(report.diagnostics.filter((item) => item.severity === "error").map((item) => `${item.code}: ${item.message}`).join("\n"));
  mkdirSync(root, { recursive: true });
  writeFileSync(output, `${JSON.stringify(lock, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
  return { path: output, review_status: "pending", diagnostics: report.diagnostics };
}

export function main(argv) {
  const options = { files: [], additionalAir: [] };
  const keys = { "--air": "air", "--manifest": "manifest", "--out": "out", "--package-root": "packageRoot", "--entrypoint-arg": "entrypointArg", "--sdk-metadata-json": "sdkMetadataJson", "--python": "python" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--help") {
      process.stdout.write("Usage: touba supply-chain generate --air <program.air.json> [--air <module.air.json> ...] [--manifest <touba.manifest.json>] --out <touba.lock.json> [--package-root <relative-dir>] [--file <package-relative-file> ...] [--entrypoint-arg <index|command>] [--sdk-metadata-json <object>] [--python <trusted-interpreter>]\nThe lock remains pending review. No existing file is overwritten. Static local JavaScript and Python script imports are included transitively, without running handlers. Detected dynamic imports are refused. Python uses pyproject.toml and an isolated Python 3.11+ scanner. Add other assets with --file. Declared dependencies require their package-manager lock; installed dependencies are not audited.\n");
      return;
    }
    if (!keys[flag] && flag !== "--file") throw new Error(`unknown option ${flag}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) throw new Error(`${flag} requires a value`);
    if (flag === "--file") options.files.push(value);
    else if (flag === "--air" && options.air) options.additionalAir.push(value);
    else options[keys[flag]] = flag === "--entrypoint-arg" && value !== "command" ? Number(value) : value;
  }
  process.stdout.write(`${JSON.stringify(generateSupplyChainLock(options), null, 2)}\n`);
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(process.argv.slice(2)); } catch (error) { process.stderr.write(`supply chain generation error: ${error.message}\n`); process.exitCode = 1; }
}
