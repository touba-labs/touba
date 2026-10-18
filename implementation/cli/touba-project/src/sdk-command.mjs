import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const toolchainRoot = fileURLToPath(new URL("../../../../", import.meta.url));
const languages = { javascript: "sdk", python: "python_sdk" };
const help = `Usage:
  touba sdk install javascript [--root <project>]
  touba sdk install python [--root <project>] [--python <executable>]
  touba sdk path javascript|python

Install the matching bundled SDK offline in this project, never globally.
JavaScript requires npm; Python requires Python 3.11+ with venv and pip.
Python creates or reuses .venv. --python selects its base interpreter.
The archives are copied into vendor/touba-sdk for reproducible installations.
Both SDKs can coexist. Choose generated handlers with init --language javascript|python.
Other package managers can use the verified archive returned by sdk path.`;

function fail(message) { throw new Error(message); }
function digest(path) { return createHash("sha256").update(readFileSync(path)).digest("hex"); }
function inside(root, path) {
  const rel = relative(root, path);
  return rel !== "" && !rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) && rel !== ".." && !isAbsolute(rel);
}
function regular(path, directory = false) {
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || (directory ? !stat.isDirectory() : !stat.isFile())) fail(`SDK path must be a regular ${directory ? "directory" : "file"}: ${path}`);
}
function directory(path) {
  if (!existsSync(path)) mkdirSync(path);
  regular(path, true);
}

/** The caller cannot choose an arbitrary download or a toolchain via environment. */
export function bundledSdk(language, root = toolchainRoot) {
  if (!Object.hasOwn(languages, language)) fail("Choose SDK javascript or python.");
  const metadataPath = join(root, "TOOLCHAIN.json");
  if (!existsSync(metadataPath)) fail("SDK archive unavailable: install a packaged Touba toolchain first. Source checkouts must build their distribution explicitly.");
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const entry = metadata[languages[language]];
  if (!entry || typeof entry.archive !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256 ?? "")) fail("Invalid bundled SDK metadata.");
  const path = resolve(root, entry.archive);
  if (!inside(join(root, "sdk"), path)) fail("Bundled SDK archive must be inside the toolchain sdk directory.");
  regular(join(root, "sdk"), true); regular(path);
  if (!inside(realpathSync(join(root, "sdk")), realpathSync(path))) fail("Bundled SDK archive escapes its directory.");
  if (digest(path) !== entry.sha256) fail("Bundled SDK checksum mismatch; reinstall Touba from a verified distribution.");
  if (!(language === "python" ? path.endsWith(".whl") : path.endsWith(".tgz"))) fail("Invalid bundled SDK archive format.");
  return { ...entry, path };
}

function run(command, args, root, env = {}) {
  const result = spawnSync(command, args, {
    cwd: root, encoding: "utf8", maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, ...env }, windowsHide: true, timeout: 120_000,
  });
  if (result.error || result.status !== 0) fail(`SDK command failed (${basename(command)}): ${result.error?.message ?? result.stderr?.trim() ?? result.status}`);
  return result.stdout.trim();
}

// Invoke npm's JavaScript entry point, not a .cmd through a shell on Windows.
function npmEntrypoint() {
  const candidates = [join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js")];
  for (const dir of (process.env.PATH ?? "").split(delimiter).filter(Boolean)) {
    const executable = join(dir, "npm");
    if (existsSync(executable)) candidates.push(realpathSync(executable));
    candidates.push(join(dir, "node_modules/npm/bin/npm-cli.js"));
  }
  const entry = candidates.find(path => basename(path) === "npm-cli.js" && existsSync(path));
  if (!entry) fail("npm is required for the JavaScript SDK. Install Node.js with npm, or use touba sdk path javascript with your package manager.");
  return entry;
}

function preserveArchive(root, sdk) {
  const vendor = join(root, "vendor"); directory(vendor);
  const sdks = join(vendor, "touba-sdk"); directory(sdks);
  const revision = join(sdks, sdk.sha256); directory(revision);
  const target = join(revision, basename(sdk.path));
  if (existsSync(target)) { regular(target); if (digest(target) !== sdk.sha256) fail("Project SDK archive checksum mismatch; existing file was not overwritten."); }
  else copyFileSync(sdk.path, target, 1 /* COPYFILE_EXCL */);
  if (digest(target) !== sdk.sha256) fail("Copied SDK archive checksum mismatch.");
  return target;
}

export function installSdk(language, { root = process.cwd(), python, distributionRoot = toolchainRoot } = {}) {
  const sdk = bundledSdk(language, distributionRoot);
  root = realpathSync(resolve(root)); regular(root, true);
  if (language === "javascript") {
    if (python) fail("--python applies only to the Python SDK.");
    for (const lock of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"]) {
      if (existsSync(join(root, lock))) fail(`Project uses ${lock}; use touba sdk path javascript with that package manager. No lockfile was changed.`);
    }
    const npm = npmEntrypoint();
    for (const file of ["package.json", "package-lock.json", "node_modules"]) {
      const path = join(root, file);
      if (existsSync(path)) regular(path, file === "node_modules");
    }
    const archive = preserveArchive(root, sdk);
    const manifest = join(root, "package.json");
    if (!existsSync(manifest)) writeFileSync(manifest, '{"private":true}\n', { flag: "wx" });
    run(process.execPath, [npm, "install", "--prefix", root, "--offline", "--ignore-scripts", "--save-exact", "--no-audit", "--no-fund", "--workspaces=false", "--", archive], root);
    run(process.execPath, ["--input-type=module", "-e", 'import { ToubaEngine } from "@touba/sdk"; if (typeof ToubaEngine !== "function") process.exit(1);'], root);
    return { language, archive, root, package: sdk.name, version: sdk.version, verify: 'node --input-type=module -e \'import { ToubaEngine } from "@touba/sdk"; console.log(typeof ToubaEngine)\'' };
  }
  const venv = join(root, ".venv");
  if (existsSync(venv)) { regular(venv, true); regular(join(venv, "pyvenv.cfg")); }
  const executable = join(venv, process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
  const pythonEnv = { PYTHONNOUSERSITE: "1", PIP_NO_INPUT: "1", PIP_DISABLE_PIP_VERSION_CHECK: "1" };
  if (!existsSync(venv)) {
    const base = python ?? (process.platform === "win32" ? "python" : "python3");
    run(base, ["-I", "-c", 'import sys; assert sys.version_info >= (3, 11), "Python 3.11 or newer is required"'], root, pythonEnv);
    run(base, ["-I", "-m", "venv", venv], root, pythonEnv);
  }
  const actualPrefix = run(executable, ["-I", "-c", 'import sys; assert sys.version_info >= (3, 11); assert sys.prefix != sys.base_prefix, "A virtual environment is required"; print(sys.prefix)'], root, pythonEnv);
  if (realpathSync(actualPrefix) !== realpathSync(venv)) fail("Python interpreter does not belong to this project's .venv.");
  const archive = preserveArchive(root, sdk);
  run(executable, ["-I", "-m", "pip", "--isolated", "install", "--no-index", "--no-deps", "--force-reinstall", archive], root, pythonEnv);
  run(executable, ["-I", "-c", "from touba_sdk import ToubaEngine, AsyncToubaEngine; assert callable(ToubaEngine) and callable(AsyncToubaEngine)"], root, pythonEnv);
  return { language, archive, root, package: sdk.name, version: sdk.version, python: executable, verify: process.platform === "win32" ? '.venv\\Scripts\\python.exe -c "from touba_sdk import ToubaEngine; print(ToubaEngine)"' : '.venv/bin/python -c "from touba_sdk import ToubaEngine; print(ToubaEngine)"' };
}

export function sdkCommand(args) {
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) return { text: help, exitCode: 0 };
  const [action, language, ...rest] = args;
  if (!["path", "install"].includes(action)) fail(help);
  const options = {};
  for (let i = 0; i < rest.length; i++) {
    const flag = rest[i];
    if (action !== "install" || !["--root", "--python"].includes(flag) || !rest[i + 1] || rest[i + 1].startsWith("--")) fail(`Unknown or incomplete SDK option: ${flag}`);
    options[flag.slice(2)] = rest[++i];
  }
  if (action === "path") return { text: bundledSdk(language).path, exitCode: 0 };
  const report = installSdk(language, options);
  return { text: `Installed ${report.package} ${report.version} (${language}) in ${report.root}\nArchive: ${report.archive}\nVerify: ${report.verify}\nCommit vendor/touba-sdk with your dependency declarations; do not commit .venv or node_modules.`, exitCode: 0 };
}
