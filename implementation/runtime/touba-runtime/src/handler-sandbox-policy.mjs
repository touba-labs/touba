// @ts-check
import { existsSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
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
  const cryptoConfig = ["/etc/ssl/openssl.cnf", "/private/etc/ssl/openssl.cnf", "/opt/homebrew/etc/openssl@3/openssl.cnf", "/usr/local/etc/openssl@3/openssl.cnf"]
    .filter(existsSync).map(canonicalPath);
  for (const path of [...paths.code, ...runtimeLibraries(paths.command), ...cryptoConfig]) rules.push(`(allow file-read* (literal ${JSON.stringify(path)}))`);
  for (const [items, operation] of [[paths.read, "file-read*"], [paths.write, "file-write*"]]) {
    for (const path of items) rules.push(`(allow ${operation} (subpath ${JSON.stringify(path)}))`);
  }
  if (paths.grants.has("process")) rules.push("(allow process-fork)", "(allow process-exec)");
  if (paths.grants.has("network")) rules.push("(allow network*)");
  for (const path of paths.sockets) rules.push(`(allow network-outbound (remote unix-socket (path-literal ${JSON.stringify(path)})))`);
  return rules.join("\n");
}
