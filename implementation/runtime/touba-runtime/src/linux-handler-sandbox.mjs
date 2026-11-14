import { existsSync, realpathSync, statSync, mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { resolve, dirname, basename, join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { handlerSandboxPaths } from "./handler-sandbox-policy.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";

/** @param {string} code @param {string} message @returns {never} */
const fail = (code, message) => { throw new RuntimeFailure(message, {}, code); };

export function linuxSandboxOptions(env = process.env) {
  const bundled = join(dirname(process.execPath), "touba-sandbox");
  const development = fileURLToPath(new URL("../../../target/debug/touba-sandbox", import.meta.url));
  return { bwrap: env.TOUBA_BWRAP_COMMAND || "/usr/bin/bwrap",
    launcher: env.TOUBA_SANDBOX_LAUNCHER || (existsSync(bundled) ? bundled : development) };
}

/** @param {string} launcher */
function landlockVersion(launcher) {
  const probe = spawnSync(launcher, ["--probe"], { encoding: "utf8", timeout: 2000, maxBuffer: 4096, env: {} });
  try {
    const result = JSON.parse(probe.stdout);
    if (probe.status === 0 && result.protocol === "touba-sandbox-probe-v1" && Number.isSafeInteger(result.landlock_abi)) return result.landlock_abi;
  } catch { /* stable public failure below */ }
  fail("HandlerSandboxUnavailable", "The native sandbox launcher could not verify Landlock");
}

export function probeLinuxSandbox(env = process.env) {
  const result = { available: false, platform: "linux", mechanism: "bubblewrap-seccomp-landlock", version: "1" };
  if (process.platform !== "linux") return { ...result, reason: "native_host_required" };
  let root, filter, policy;
  try {
    const plan = linuxHandlerSandboxPlan({ handler: { command: "/usr/bin/true", args: [], cwd: "/" }, grants: [], sandbox: {} }, "/usr/bin/true", linuxSandboxOptions(env));
    root = mkdtempSync(join(tmpdir(), "touba-sandbox-probe-"));
    writeFileSync(join(root, "filter"), plan.seccomp, { mode: 0o600 });
    writeFileSync(join(root, "policy"), plan.policy, { mode: 0o600 });
    filter = openSync(join(root, "filter"), "r"); policy = openSync(join(root, "policy"), "r");
    const probe = spawnSync(plan.command, plan.args, { timeout: 2000, maxBuffer: 4096, env: {}, stdio: ["ignore", "pipe", "pipe", "ignore", filter, policy] });
    return { ...result, available: probe.status === 0, ...(probe.status === 0 ? {} : { reason: "policy_execution_failed" }) };
  } catch (error) { return { ...result, reason: error instanceof RuntimeFailure ? error.code : "policy_execution_failed" }; }
  finally {
    if (filter !== undefined) closeSync(filter);
    if (policy !== undefined) closeSync(policy);
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

/** Linux x86-64 seccomp BPF. No 32-bit/x32 syscall bypass; clone3 deliberately
 * returns ENOSYS so libc can use clone with inspectable scalar flags. Thread
 * creation remains available to Node/Python without granting child processes.
 */
export function linuxHandlerSeccomp({ processAllowed = false, networkAllowed = false, localSockets = false, arch = process.arch } = {}) {
  if (arch !== "x64") fail("HandlerSandboxUnsupportedPlatform", "Linux sandbox currently requires x86-64");
  /** @type {Array<[number, number, number, number]>} */
  const program = [];
  /** @param {number} code @param {number} jt @param {number} jf @param {number} k */
  const emit = (code, jt, jf, k) => program.push([code, jt, jf, k]);
  /** @param {number} offset */
  const load = offset => emit(0x20, 0, 0, offset);
  /** @param {number} value */
  const ret = value => emit(0x06, 0, 0, value);
  /** @param {number} value @param {number} yes @param {number} no */
  const eq = (value, yes, no) => emit(0x15, yes, no, value);
  const deny = 0x00050001, allow = 0x7fff0000;
  load(4); eq(0xc000003e, 1, 0); ret(0x80000000); // audit architecture
  load(0); emit(0x35, 0, 1, 0x40000000); ret(0x80000000); // x32 / invalid numbers
  for (const nr of [101, 155, 165, 166, 167, 168, 169, 246, 248, 249, 250, 272, 298, 303, 304, 308, 310, 311, 320, 321, 323, 425, 426, 427]) {
    eq(nr, 0, 1); ret(deny);
  }
  eq(435, 0, 1); ret(0x00050026); // ENOSYS, not a permission error fallback loop
  if (!networkAllowed) {
    if (!localSockets) { eq(41, 0, 1); ret(deny); } // socket, including pathname AF_UNIX
    else {
      eq(41, 0, 4); load(16); eq(1, 0, 1); ret(allow); ret(deny); // AF_UNIX only, Landlock validates path
      load(0);
    }
  }
  if (!processAllowed) for (const nr of [57, 58]) { eq(nr, 0, 1); ret(deny); }
  // All clone callers must stay in the established namespaces.
  eq(56, 0, processAllowed ? 4 : 8);
  load(16); emit(0x54, 0, 0, 0x7e020000); eq(0, 1, 0); ret(deny);
  if (!processAllowed) {
    load(16); emit(0x54, 0, 0, 0x00010900); eq(0x00010900, 1, 0); ret(deny);
  }
  ret(allow);
  const buffer = Buffer.alloc(program.length * 8);
  program.forEach(([code, jt, jf, k], index) => {
    buffer.writeUInt16LE(code, index * 8); buffer[index * 8 + 2] = jt; buffer[index * 8 + 3] = jf;
    buffer.writeUInt32LE(k, index * 8 + 4);
  });
  return buffer;
}

/**
 * @param {Pick<import('./handler-protocol.mjs').ProcessToolBinding, 'handler' | 'grants' | 'sandbox'>} binding
 * @param {string} command
 * @param {{bwrap?: string | undefined, launcher?: string | undefined, arch?: NodeJS.Architecture | undefined, landlockAbi?: number | undefined}} options
 * @returns {import('./handler-protocol.mjs').HandlerSandboxPlan & {seccomp: Buffer, policy: Buffer}}
 */
export function linuxHandlerSandboxPlan(binding, command, { bwrap = "/usr/bin/bwrap", launcher, arch = process.arch, landlockAbi } = {}) {
  if (!existsSync(bwrap) || !statSync(bwrap).isFile()) fail("HandlerSandboxUnavailable", "bubblewrap is required for the Linux handler sandbox");
  const paths = handlerSandboxPaths(binding, command);
  if (!launcher || !existsSync(launcher) || !statSync(launcher).isFile()) fail("HandlerSandboxUnavailable", "The matching native Touba sandbox launcher is required");
  launcher = realpathSync(launcher);
  const abi = landlockAbi ?? landlockVersion(launcher);
  if (abi < 3) fail("HandlerSandboxUnavailable", "Linux sandbox requires Landlock ABI 3 or newer");
  if (paths.sockets.length && !paths.grants.has("network") && abi < 9) fail("HandlerSandboxUnsupportedPolicy", "Exact Unix socket scopes require Landlock ABI 9 or newer");
  /** @type {Map<string, {source: string, writable: boolean}>} */
  const mounts = new Map();
  /** @param {string} path @param {boolean} writable */
  const mount = (path, writable = false) => {
    if (!existsSync(path)) fail("HandlerSandboxPathInvalid", "Linux sandbox paths must exist; use an existing dedicated output directory for new files");
    mounts.set(path, { source: realpathSync(path), writable: writable || mounts.get(path)?.writable === true });
  };
  // Fixed OS loader/library surface only. No /usr, /etc, home, project or /tmp
  // wholesale bind. A different interpreter supplies its own explicit code.
  const systemLibraries = ["/usr/lib", "/lib", "/lib64", "/usr/lib64"].filter(existsSync);
  for (const path of [...systemLibraries, "/etc/ld.so.cache", "/etc/ssl/openssl.cnf", "/etc/ssl/certs"]) {
    if (existsSync(path)) mount(path);
  }
  // DNS/NSS configuration is required for an explicitly network-enabled
  // interpreter. Do not grant all of /etc or expose it to offline handlers.
  if (paths.grants.has("network")) for (const path of ["/etc/resolv.conf", "/etc/hosts", "/etc/nsswitch.conf", "/etc/gai.conf"]) {
    if (existsSync(path)) mount(path);
  }
  for (const path of paths.code) mount(path);
  // Preserve the configured launch path, notably .venv/bin/python. Bind the
  // already selected executable at this alias without exposing its directory.
  const launchPath = join(realpathSync(dirname(command)), basename(command));
  mount(launchPath);
  mount(launcher);
  for (const path of paths.read) mount(path);
  for (const path of paths.write) mount(path, true);
  for (const path of paths.sockets) {
    if (!existsSync(path) || !statSync(path).isSocket()) fail("HandlerSandboxPathInvalid", "local_sockets must select existing Unix sockets");
    mount(path);
  }
  const args = ["--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--new-session", "--die-with-parent", "--cap-drop", "ALL"];
  if (!paths.grants.has("network")) args.push("--unshare-net");
  // Parent mounts first, then narrower writable/read scopes. Bubblewrap creates
  // missing mountpoint ancestors in its private root, never on the host.
  for (const [target, spec] of [...mounts].sort(([a], [b]) => a.split("/").length - b.split("/").length || a.localeCompare(b))) {
    args.push(spec.writable ? "--bind" : "--ro-bind", spec.source, target);
  }
  args.push("--proc", "/proc", "--remount-ro", "/proc", "--dev", "/dev");
  const cwd = realpathSync(binding.handler.cwd ?? process.cwd());
  args.push("--dir", cwd, "--chdir", cwd, "--seccomp", "4");
  // FD 3 is the optional diagnostic channel. FD 4 is consumed as a filter.
  args.push("--", launcher, "--", launchPath, ...binding.handler.args.map((arg, index) => {
    const file = resolve(cwd, arg);
    return index === 0 && !arg.startsWith("-") && /\.(mjs|cjs|js|py)$/.test(arg) && existsSync(file) ? file : arg;
  }));
  const read = [...mounts].filter(([, spec]) => !spec.writable).map(([target]) => target);
  // Python import discovery lists directories. Give READ_DIR separately from
  // READ_FILE so a selected code sibling never makes write-only data readable.
  // These directories contain only explicit mounts in the private filesystem.
  const readDirectories = new Set([cwd, ...paths.code.map(dirname)]);
  for (const path of paths.code) if (basename(path) === "__init__.py") readDirectories.add(dirname(dirname(path)));
  // A writable mount is not automatically readable: only explicit read scopes
  // (plus executable code) receive Landlock read rights.
  const policy = { protocol: "touba-linux-sandbox-policy-v1", read: [...new Set([...read, ...paths.read, ...paths.code, "/proc", "/dev/null", "/dev/urandom", "/dev/random"])],
    read_directories: [...readDirectories], write: [...paths.write, "/dev/null"],
    execute: [...paths.code, launchPath, ...systemLibraries], sockets: paths.sockets, network: paths.grants.has("network") };
  return { enabled: true, mechanism: "bubblewrap-seccomp-landlock", command: bwrap, args, policy: Buffer.from(JSON.stringify(policy)),
    evidenceFiles: [launcher],
    seccomp: linuxHandlerSeccomp({ arch, processAllowed: paths.grants.has("process"), networkAllowed: paths.grants.has("network"), localSockets: paths.sockets.length > 0 }) };
}
