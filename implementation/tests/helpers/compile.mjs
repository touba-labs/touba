import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// Source tests may use an explicitly qualified compiler without rebuilding it.
// Without the override, Cargo remains the default and errors propagate unchanged.
export function compileTestAir(...args) {
  const command = process.env.TOUBA_COMPILE_BIN ?? "cargo";
  const prefix = process.env.TOUBA_COMPILE_BIN ? [] : ["run", "--quiet", "--manifest-path",
    fileURLToPath(new URL("../../Cargo.toml", import.meta.url)), "-p", "touba-cli", "--bin", "touba-compile", "--"];
  return JSON.parse(execFileSync(command, [...prefix, ...args], { encoding: "utf8" }));
}
