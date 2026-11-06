// @ts-check
import { existsSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { RuntimeFailure } from "./runtime-errors.mjs";
// Node supplies its own loaded-library inventory. Do not execute the handler
// or a system inspection tool to discover dependencies. Other interpreters
// declare additional library files explicitly in sandbox.code_paths.
/** @type {string[] | undefined} */
let nodeLibraries;
/** @param {string} executable */
function runtimeLibraries(executable) {
  if (process.platform !== "darwin" || executable !== realpathSync(process.execPath)) return [];
  if (!nodeLibraries) {
    const report = /** @type {{sharedObjects?: string[]}} */ (process.report.getReport());
    nodeLibraries = (report.sharedObjects ?? []).filter(path => path.startsWith("/")
      && !path.startsWith("/usr/lib/") && !path.startsWith("/System/Library/") && existsSync(path)).map(path => realpathSync(path));
  }
  return nodeLibraries;
}

/** @param {string} path */
function canonicalPath(path) {
  let parent = resolve(path), suffix = [];
  while (!existsSync(parent)) {
    if (dirname(parent) === parent) break;
    suffix.unshift(parent.slice(dirname(parent).length + 1)); parent = dirname(parent);
  }
  return join(realpathSync(parent), ...suffix);
}

/** @param {any} binding @param {string} command */
export function handlerSandboxPaths(binding, command) {
  const sandbox = binding.sandbox ?? {}, cwd = binding.handler.cwd ?? process.cwd();
  if (!isAbsolute(command) || !existsSync(command) || !statSync(command).isFile()) {
    throw new RuntimeFailure("required sandbox needs an existing absolute executable path", {}, "HandlerSandboxPathInvalid");
  }
  const grants = new Set(binding.grants ?? []);
  const code = new Set([canonicalPath(command)]);
  for (const arg of binding.handler.args) {
    if (!arg.startsWith("-") && /\.(?:mjs|cjs|js|py)$/.test(arg)) {
      const file = canonicalPath(resolve(cwd, arg));
      if (existsSync(file) && statSync(file).isFile()) {
        code.add(file);
        // Node reads package type metadata while loading the entry module.
        for (let dir = dirname(file); dirname(dir) !== dir; dir = dirname(dir)) {
          if (existsSync(join(dir, "package.json"))) code.add(join(dir, "package.json"));
        }
      }
    }
  }
  /** @param {string} key @param {string | null} grant */
  function paths(key, grant) {
    const values = sandbox[key] ?? [];
    if (values.length && grant && !grants.has(grant)) throw new RuntimeFailure(`sandbox.${key} requires ${grant}`, {}, "HandlerSandboxGrantMissing");
    return values.map(/** @param {string} path */ path => canonicalPath(isAbsolute(path) ? path : resolve(cwd, path)));
  }
  const codePaths = paths("code_paths", null);
  if (codePaths.some(/** @param {string} path */ path => !existsSync(path) || !statSync(path).isFile())) throw new RuntimeFailure("sandbox.code_paths must select existing individual code files", {}, "HandlerSandboxPathInvalid");
  return { code: [...code, ...codePaths], read: paths("read_paths", "filesystem_read"), write: paths("write_paths", "filesystem_write"),
    sockets: paths("local_sockets", "network_local"), command: canonicalPath(command), grants };
}

/** @param {any} binding @param {string} command */
export function macosHandlerPolicy(binding, command) {
  const paths = handlerSandboxPaths(binding, command);
  const rules = ["(version 1)", "(deny default)", "(allow file-read-metadata)", "(allow file-read* (literal \"/\"))", "(allow sysctl-read)",
    `(allow process-exec (literal ${JSON.stringify(paths.command)}))`,
    '(allow file-read* (subpath "/System/Library") (subpath "/usr/lib") (subpath "/Library/Apple/System/Library"))',
    '(allow file-read* (literal "/dev/null") (literal "/dev/urandom") (literal "/dev/random"))',
    '(allow file-write* (literal "/dev/null"))'];
  // Homebrew Node may link OpenSSL 3 or 4. Grant only the configuration file,
  // never its parent directory, keys or arbitrary user-provided OPENSSL_CONF.
  const cryptoConfig = ["/etc/ssl/openssl.cnf", "/private/etc/ssl/openssl.cnf",
    "/opt/homebrew/etc/openssl@3/openssl.cnf", "/usr/local/etc/openssl@3/openssl.cnf",
    "/opt/homebrew/etc/openssl@4/openssl.cnf", "/usr/local/etc/openssl@4/openssl.cnf"]
    .filter(existsSync).map(canonicalPath);
  for (const path of [...paths.code, ...runtimeLibraries(paths.command), ...cryptoConfig]) rules.push(`(allow file-read* (literal ${JSON.stringify(path)}))`);
  // Python's import finder enumerates the directory containing each selected
  // module. Literal directory reads allow that inventory, never file contents
  // below the directory (unlike a subpath read grant).
  const directories = new Set(paths.code.map(dirname));
  // macOS getcwd needs access to this directory itself. A literal directory
  // permission allows its names to be listed, never the contents of its files.
  directories.add(canonicalPath(binding.handler.cwd ?? process.cwd()));
  // A package import first enumerates the search directory containing that
  // package, then its selected __init__.py. No recursive content read is added.
  for (const path of paths.code) if (basename(path) === "__init__.py") directories.add(dirname(dirname(path)));
  for (const directory of directories) {
    rules.push(`(allow file-read-data (literal ${JSON.stringify(directory)}))`);
  }
  for (const [items, operation] of [[paths.read, "file-read*"], [paths.write, "file-write*"]]) {
    for (const path of items) rules.push(`(allow ${operation} (subpath ${JSON.stringify(path)}))`);
  }
  if (paths.grants.has("process")) rules.push("(allow process-fork)", "(allow process-exec)");
  if (paths.grants.has("network")) rules.push("(allow network*)");
  for (const path of paths.sockets) rules.push(`(allow network-outbound (remote unix-socket (path-literal ${JSON.stringify(path)})))`);
  return rules.join("\n");
}

/** Resolve CPython's framework launcher without granting general process exec.
 * The host must select the real interpreter as a code file. The launch path
 * (including .venv) is preserved using CPython's own launcher protocol.
 * @param {any} binding @param {string} command
 */
export function macosHandlerLaunch(binding, command) {
  const paths = handlerSandboxPaths(binding, command);
  const match = /^(.*\/Python\.framework\/Versions\/3\.\d+)\/bin\/python3(?:\.\d+)?$/.exec(paths.command);
  if (!match) return { command, environment: undefined };
  const native = join(match[1], "Resources/Python.app/Contents/MacOS/Python");
  if (!existsSync(native) || !statSync(native).isFile() || !paths.code.includes(realpathSync(native))) {
    throw new RuntimeFailure("Python framework interpreter is missing from sandbox.code_paths; generate the inventory with touba sdk sandbox python", {}, "HandlerSandboxPythonRuntimeMissing");
  }
  return { command: realpathSync(native), environment: { __PYVENV_LAUNCHER__: command } };
}
