import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const implementationRoot = fileURLToPath(new URL("../../../", import.meta.url));
const hint = "Run touba sdk install python in this project; prepare never imports handlers or installs dependencies.";
export const projectPythonCommand = () => process.platform === "win32" ? "./.venv/Scripts/python.exe" : "./.venv/bin/python";

export function pythonSdkSourceIdentity(root) {
  const digest = createHash("sha256");
  const names = [];
  const visit = (directory, prefix = "") => {
    for (const name of readdirSync(directory)) {
      if (name === "__pycache__") continue;
      const relative = prefix + name, file = join(directory, name), stat = lstatSync(file);
      if (stat.isSymbolicLink()) throw new Error("Python SDK source must not contain links");
      if (stat.isDirectory()) visit(file, relative + "/");
      else if (name.endsWith(".py")) {
        if (!stat.isFile()) throw new Error("Python SDK source must contain regular files");
        names.push(relative);
      }
    }
  };
  visit(root);
  for (const name of names.sort()) {
    const file = join(root, name), stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw new Error("Python SDK source must contain regular files without links");
    digest.update(name); digest.update("\0"); digest.update(readFileSync(file));
  }
  return digest.digest("hex");
}

export function inspectPythonSdkDependency(root) {
  const issue = (code, message = hint) => ({ status: "unavailable", code, message });
  const venv = join(root, ".venv");
  // lstat also identifies dangling links: they are an invalid project layout,
  // not a missing SDK that another install would repair.
  const venvStat = lstatSync(venv, { throwIfNoEntry: false });
  if (venvStat?.isSymbolicLink()) return issue("HandlerSdkInvalid",
    "The project .venv is a symbolic link. Create a dedicated .venv directory in this project, then run touba sdk install python.");
  if (!venvStat || !existsSync(join(venv, "pyvenv.cfg"))) return issue("HandlerSdkMissing");
  let candidates = [];
  if (process.platform === "win32") candidates = [join(venv, "Lib/site-packages/touba_sdk")];
  else if (existsSync(join(venv, "lib"))) candidates = readdirSync(join(venv, "lib"))
    .filter(name => /^python3\.\d+$/.test(name)).map(name => join(venv, "lib", name, "site-packages/touba_sdk"));
  candidates = candidates.filter(existsSync);
  if (candidates.length !== 1) return issue("HandlerSdkMissing");
  try {
    const installed = candidates[0];
    if (lstatSync(installed).isSymbolicLink()) return issue("HandlerSdkInvalid",
      "The installed touba_sdk directory is a symbolic link. Install a materialized SDK in the project environment with touba sdk install python.");
    const build = pythonSdkSourceIdentity(installed);
    const source = join(implementationRoot, "runtime/touba-python-sdk/src/touba_sdk");
    const toolchainMetadata = join(implementationRoot, "../TOOLCHAIN.json");
    const expected = existsSync(source) ? pythonSdkSourceIdentity(source)
      : JSON.parse(readFileSync(toolchainMetadata, "utf8")).python_sdk?.build_sha256;
    if (!expected) return issue("HandlerSdkInvalid", "This distribution has no Python SDK build identity; reinstall a complete distribution.");
    if (build !== expected) return { ...issue("HandlerSdkBuildMismatch", `Python SDK source differs from this toolchain. ${hint}`), build, expected_build: expected };
    return { status: "ready", path: installed, build, command: projectPythonCommand() };
  } catch { return issue("HandlerSdkInvalid",
    "The Python SDK source inventory cannot be verified. Use regular SDK files without linked directories or hard-linked source files. Run touba sdk install python to install this toolchain's SDK."); }
}
