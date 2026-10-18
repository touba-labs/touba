import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Uses a provisioned builder; never installs build tools or downloads at release time.
export function packagePythonSdk(implementationRoot, toolchainRoot) {
  const python = process.env.TOUBA_PYTHON_BUILD_BIN || "python3";
  const output = join(toolchainRoot, "sdk");
  mkdirSync(output, { recursive: true });
  const source = join(implementationRoot, "runtime/touba-python-sdk");
  const result = spawnSync(python, ["-m", "build", "--wheel", "--no-isolation", "--outdir", output, source], {
    encoding: "utf8", maxBuffer: 1024 * 1024,
  });
  if (result.error || result.status !== 0) throw new Error("Python SDK build failed: provision runtime/touba-python-sdk/build-requirements.txt in an isolated builder and set TOUBA_PYTHON_BUILD_BIN to its Python executable");
  const version = JSON.parse(readFileSync(join(implementationRoot, "runtime/touba-handler-sdk/package.json"))).version;
  const filename = `touba_sdk-${version}-py3-none-any.whl`;
  const sha256 = createHash("sha256").update(readFileSync(join(output, filename))).digest("hex");
  return { name: "touba-sdk", version, archive: `sdk/${filename}`, sha256, requires_python: ">=3.11" };
}
