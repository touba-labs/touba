import { readFileSync, statSync } from "node:fs";
import { basename, dirname, extname, join, resolve } from "node:path";

const isFile = path => { try { return statSync(path).isFile(); } catch { return false; } };

/** Resolve our installed Windows batch entry point without evaluating batch text.
 * Custom executable commands keep their ordinary process transport. This is
 * installation discovery, not a signature or supply-chain attestation.
 */
export function resolveEngineCommand({ command, args = [], cwd, env, platform = process.platform }) {
  if (platform === "win32") {
    // Match Node's case-insensitive child-process environment: the first
    // lexicographic spelling wins, with no duplicate Path/PATH entries.
    const seen = new Set();
    env = Object.fromEntries(Object.keys(env).sort().filter(key => {
      const name = key.toUpperCase();
      if (seen.has(name)) return false;
      seen.add(name); return true;
    }).map(key => [key, env[key]]));
  }
  const unchanged = { command, args: [...args], env: { ...env } };
  if (platform !== "win32") return unchanged;
  const pathKey = Object.keys(env).find(key => key.toLowerCase() === "path") ?? "PATH";
  const explicit = /[\\/]/u.test(command);
  const names = extname(command) ? [command] : [`${command}.exe`, `${command}.com`, `${command}.cmd`, `${command}.bat`];
  const candidates = explicit ? names.map(name => resolve(cwd, name)) : (env[pathKey] ?? "").split(";")
    .filter(Boolean).flatMap(directory => names.map(name => resolve(cwd, directory.replace(/^"|"$/gu, ""), name)));
  const selected = candidates.find(isFile);
  if (!selected) return unchanged;
  if (!/\.(cmd|bat)$/iu.test(selected)) return { ...unchanged, command: selected };
  if (basename(selected).toLowerCase() === "touba.cmd") {
    const parent = resolve(dirname(selected), "..");
    for (const root of [parent, join(parent, "touba-toolchain")]) {
      let metadata;
      try { metadata = JSON.parse(readFileSync(join(root, "TOOLCHAIN.json"), "utf8")); } catch { continue; }
      const node = join(root, "bin/node.exe");
      const compiler = join(root, "bin/touba-compile.exe");
      const cli = join(root, "lib/cli/touba-project/src/main.mjs");
      if (metadata?.toolchain_profile !== "touba-local-toolchain-v1" || metadata.platform !== "win32-x64"
          || ![node, compiler, cli].every(isFile)) continue;
      const nextEnv = { ...env, TOUBA_COMPILE_BIN: compiler, [pathKey]: `${join(root, "bin")};${env[pathKey] ?? ""}` };
      const channelKey = Object.keys(env).find(key => key.toUpperCase() === "TOUBA_DISTRIBUTION_CHANNEL");
      if (!channelKey || !env[channelKey]) nextEnv[channelKey ?? "TOUBA_DISTRIBUTION_CHANNEL"] = "local-archive";
      // One case-insensitive Windows environment key per setting.
      for (const key of Object.keys(nextEnv)) if (key.toUpperCase() === "TOUBA_COMPILE_BIN" && key !== "TOUBA_COMPILE_BIN") delete nextEnv[key];
      return { command: node, args: [cli, ...args], env: nextEnv };
    }
  }
  throw Object.assign(new Error("Use an installed Touba CLI or an executable command, not a batch script"), { code: "EngineBatchLauncherUnsupported" });
}
