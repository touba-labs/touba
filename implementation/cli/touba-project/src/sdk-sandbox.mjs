import { spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { inspectPythonSdkDependency } from "../../touba-manifest/src/python-sdk-dependency.mjs";
import { inspectSdkDependency } from "../../touba-manifest/src/sdk-dependency.mjs";
import { sdkSourceFiles } from "../../touba-manifest/src/sdk-build-identity.mjs";

const fail = message => { throw Object.assign(new Error(message), { code: "SdkSandboxConfigurationInvalid" }); };
const implementation = fileURLToPath(new URL("../../../", import.meta.url));

// Inspect metadata from the explicitly selected host interpreter, never from
// package code. Only exact library files inside that installation are selected.
export function pythonSharedLibraryFiles(metadata) {
  if (![0, 1, null, undefined].includes(metadata.shared)) fail("Invalid Python shared library metadata.");
  if (metadata.shared !== 1) return [];
  if (typeof metadata.base_prefix !== "string" || !isAbsolute(metadata.base_prefix)
      || !Number.isSafeInteger(metadata.version?.[1])) fail("Invalid Python interpreter metadata.");
  const base = realpathSync(metadata.base_prefix);
  const inside = path => {
    const suffix = relative(base, path);
    return suffix !== "" && suffix !== ".." && !suffix.startsWith(`..${sep}`) && !isAbsolute(suffix);
  };
  if (typeof metadata.libdir !== "string" || !isAbsolute(metadata.libdir) || metadata.libdir.includes("\0")
      || !existsSync(metadata.libdir) || !statSync(metadata.libdir).isDirectory()) fail("Invalid Python library directory.");
  const directory = realpathSync(metadata.libdir);
  if (!inside(directory)) fail("Python library directory must belong to its interpreter installation.");
  const expected = new RegExp(`^libpython3\\.${metadata.version[1]}[a-z]*\\.so(?:\\.[0-9]+)*$`);
  const files = [];
  for (const name of new Set([metadata.ldlibrary, metadata.instsoname].filter(value => value != null && value !== ""))) {
    if (typeof name !== "string" || !expected.test(name)) fail("Invalid Python shared library name.");
    if (!existsSync(join(directory, name))) fail("Python shared library file is missing.");
    const file = realpathSync(join(directory, name));
    if (!inside(file) || !statSync(file).isFile()) fail("Python shared library must be an individual file inside its installation.");
    files.push(file);
  }
  if (!files.length) fail("Python shared library metadata is missing.");
  return [...new Set(files)];
}

// An explicit host command: inspect the trusted project interpreter with site
// hooks and environment injection disabled. Never called by prepare or run.
// No package/handler is imported, installed or executed to discover dependencies.
export function sandboxSdkConfig(language, { root = process.cwd(), handler } = {}) {
  if (!["javascript", "python"].includes(language)) fail("Choose javascript or python.");
  root = realpathSync(root);
  if (!handler) fail("Select the handler file with --handler <path>.");
  const entry = realpathSync(resolve(root, handler));
  const entryRelative = relative(root, entry);
  if (entryRelative.startsWith(`..${sep}`) || entryRelative === ".." || isAbsolute(entryRelative) || !statSync(entry).isFile()) {
    fail("The handler must be an existing file inside this project.");
  }
  const files = new Set([entry]);
  const add = path => {
    if (!existsSync(path) || !statSync(path).isFile()) return;
    files.add(realpathSync(path));
    if (files.size > 4096) fail("Code inventory exceeds 4096 files; select a smaller isolated environment.");
  };
  let command;
  if (language === "javascript") {
    const sdk = join(implementation, "runtime/touba-handler-sdk");
    const version = JSON.parse(readFileSync(join(sdk, "package.json"), "utf8")).version;
    const installed = inspectSdkDependency(root, version, sdk);
    if (installed.status !== "ready") fail(installed.message ?? "Install this toolchain's JavaScript SDK first.");
    command = process.execPath;
    for (const file of ["package.json", ...sdkSourceFiles(installed.path)]) add(join(installed.path, file));
  } else {
    const installed = inspectPythonSdkDependency(root);
    if (installed.status !== "ready") fail(installed.message);
    command = resolve(root, installed.command);
    const probe = spawnSync(command, ["-I", "-S", "-B", "-c", "import json,sys,sysconfig; print(json.dumps({'base_prefix':sys.base_prefix,'version':list(sys.version_info[:2]),'shared':sysconfig.get_config_var('Py_ENABLE_SHARED'),'libdir':sysconfig.get_config_var('LIBDIR'),'ldlibrary':sysconfig.get_config_var('LDLIBRARY'),'instsoname':sysconfig.get_config_var('INSTSONAME')}))"], {
      cwd: root, env: { PATH: process.env.PATH ?? "", ...(process.platform === "win32" ? { SystemRoot: process.env.SystemRoot } : {}) },
      encoding: "utf8", timeout: 10000, maxBuffer: 65536, windowsHide: true,
    });
    if (probe.error || probe.status !== 0) fail("Cannot inspect the project's trusted Python interpreter. Check .venv and its executable.");
    let metadata;
    try { metadata = JSON.parse(probe.stdout); } catch { fail("Invalid Python interpreter metadata."); }
    if (typeof metadata.base_prefix !== "string" || !isAbsolute(metadata.base_prefix)
        || metadata.version?.[0] !== 3 || !Number.isSafeInteger(metadata.version[1]) || metadata.version[1] < 11) {
      fail("Python 3.11 or newer is required.");
    }
    let visited = 0;
    const seen = new Set();
    const walk = directory => {
      directory = realpathSync(directory);
      if (seen.has(directory)) return;
      seen.add(directory);
      for (const item of readdirSync(directory, { withFileTypes: true })) {
        if (++visited > 50000) fail("Python code inventory exceeds its scan limit.");
        if (["__pycache__", "site-packages", "test", "tests", "node_modules"].includes(item.name)) continue;
        const path = join(directory, item.name);
        // Do not traverse linked directories into unrelated installations/data.
        if (item.isDirectory()) walk(path);
        else if (/\.(?:py|so|dylib|zip|pyd)$/.test(item.name) || ["Python", "Python3"].includes(item.name)) add(path);
      }
    };
    const base = realpathSync(metadata.base_prefix);
    if (base === "/" || base === root) fail("Python base prefix is not an isolated interpreter installation.");
    if (process.platform === "linux") for (const file of pythonSharedLibraryFiles(metadata)) add(file);
    // Distribution installs may use /usr: enumerate only the standard library,
    // not that entire system prefix. Framework installs also need their dylib.
    const stdlib = join(base, "lib", `python3.${metadata.version[1]}`);
    if (existsSync(stdlib)) walk(stdlib);
    else if (existsSync(join(base, "Lib"))) walk(join(base, "Lib"));
    else fail("Cannot locate the Python standard library.");
    for (const file of [join(base, "Python"), join(base, "Python3"),
      join(base, "Resources/Python.app/Contents/MacOS/Python"), join(root, ".venv/pyvenv.cfg")]) add(file);
    walk(installed.path);
  }
  add(command);
  return { handler: { kind: "process", command, args: [entryRelative.split(sep).join("/")], cwd: root },
    sandbox: { required: true, code_paths: [...files].sort() } };
}
