// @ts-check
import { constants, copyFileSync, existsSync, statSync, realpathSync, mkdtempSync, writeFileSync, openSync, closeSync, rmSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { handlerSandboxPaths } from "./handler-sandbox-policy.mjs";
import { RuntimeFailure } from "./runtime-errors.mjs";

/** @param {Record<string, string | undefined>} [env] */
export function windowsSandboxOptions(env = process.env) {
  const bundled = join(dirname(process.execPath), "touba-sandbox.exe");
  const development = fileURLToPath(new URL("../../../target/debug/touba-sandbox.exe", import.meta.url));
  return { launcher: env.TOUBA_SANDBOX_LAUNCHER || (existsSync(bundled) ? bundled : development),
    environment: { SystemRoot: env.SystemRoot ?? env.SYSTEMROOT ?? process.env.SystemRoot,
      LOCALAPPDATA: env.LOCALAPPDATA ?? process.env.LOCALAPPDATA } };
}

/** @param {any} binding @param {string} command
 * @param {{launcher: string, environment: Record<string, string | undefined>, diagnostic?: boolean}} options */
export function windowsHandlerSandboxPlan(binding, command, options) {
  if (!existsSync(options.launcher) || !statSync(options.launcher).isFile()) {
    throw new RuntimeFailure("native Windows sandbox launcher is unavailable", {}, "HandlerSandboxUnavailable");
  }
  if (!options.environment.SystemRoot || !options.environment.LOCALAPPDATA) {
    throw new RuntimeFailure("Windows sandbox requires host OS and local application-data locations", {}, "HandlerSandboxEnvironmentInvalid");
  }
  const paths = handlerSandboxPaths(binding, command);
  if (paths.sockets.length) throw new RuntimeFailure("exact local socket scopes are not supported by the Windows backend", {}, "HandlerSandboxUnsupportedPolicy");
  if ([...paths.read, ...paths.write].some(path => !existsSync(path))) {
    throw new RuntimeFailure("Windows sandbox scopes must already exist; select an existing output directory to create files", {}, "HandlerSandboxPathInvalid");
  }
  const cwd = realpathSync(binding.handler.cwd ?? process.cwd());
  const args = binding.handler.args.map(/** @param {string} arg @param {number} index */ (arg, index) =>
    index === 0 && !arg.startsWith("-") && /\.(?:mjs|cjs|js|py)$/.test(arg) && existsSync(resolve(cwd, arg)) ? realpathSync(resolve(cwd, arg)) : arg);
  // Node's default realpath walker lstats the drive root, which LPAC cannot
  // enumerate. Preserve the selected module paths instead of granting disk
  // root access. Confined packages must use materialized, non-link layouts.
  if (basename(paths.command).toLowerCase() === "node.exe" || paths.command === realpathSync(process.execPath)) {
    args.unshift("--preserve-symlinks", "--preserve-symlinks-main");
  }
  return { enabled: true, mechanism: "windows-lpac-job", command: options.launcher, args: [], environment: options.environment,
    policy: Buffer.from(JSON.stringify({ protocol: "touba-windows-sandbox-policy-v1", command: paths.command, args, cwd,
      code: paths.code, read: paths.read, write: paths.write, network: paths.grants.has("network"),
      process: paths.grants.has("process"), diagnostic: options.diagnostic === true, env_keys: [] })) };
}

/** @param {ReturnType<typeof windowsSandboxOptions>} options @param {string} root */
export function windowsSandboxProbePlan(options, root) {
  // Cargo may hard-link the development executable into target/debug/deps.
  // Never lease ACLs on the running supervisor or its build aliases. Probe a
  // fresh copy, just as the distribution materializes its executable files.
  const probe = join(root, "touba-sandbox-probe.exe");
  copyFileSync(options.launcher, probe, constants.COPYFILE_EXCL);
  return windowsHandlerSandboxPlan({ handler: { command: probe, args: ["--probe-child"], cwd: root }, sandbox: {}, grants: [] }, probe, options);
}

/** Runs an actual, token-checked LPAC child through the same launcher path.
 * @param {Record<string, string | undefined>} [env] */
export function probeWindowsSandbox(env = process.env) {
  const base = { available: false, platform: "win32", mechanism: "windows-lpac-job", version: "0" };
  if (process.platform !== "win32") return { ...base, reason: "host_platform_mismatch" };
  let root, fd;
  try {
    root = realpathSync(mkdtempSync(join(tmpdir(), "touba-windows-probe-")));
    const options = windowsSandboxOptions(env);
    const plan = windowsSandboxProbePlan(options, root);
    const policy = join(root, "policy.json"); writeFileSync(policy, plan.policy); fd = openSync(policy, "r");
    const result = spawnSync(plan.command, plan.args, { cwd: root, env: plan.environment, timeout: 10_000,
      encoding: "utf8", windowsHide: true, stdio: ["pipe", "pipe", "pipe", "ignore", "pipe", fd], input: "" });
    const output = result.status === 0 ? JSON.parse(result.stdout ?? "null") : null;
    const completion = JSON.parse(String(result.output?.[4] ?? "") || "null");
    return completion?.protocol === "touba-windows-sandbox-result-v1" && completion.ok === true && completion.exit_code === 0
      && output?.available === true && output.mechanism === base.mechanism && output.version === "1"
      ? { ...base, available: true, version: "1" } : { ...base, reason: "native_probe_failed",
        probe_exit_code: result.status, probe_error: /** @type {NodeJS.ErrnoException | undefined} */ (result.error)?.code ?? null,
        ...(completion?.protocol === "touba-windows-sandbox-result-v1" && completion.ok === false
          && /^HandlerSandbox[A-Za-z]+$/.test(completion.code) ? { sandbox_code: completion.code } : {}) };
  } catch { return { ...base, reason: "native_probe_failed" }; }
  finally { if (fd !== undefined) closeSync(fd); if (root) rmSync(root, { recursive: true, force: true }); }
}
