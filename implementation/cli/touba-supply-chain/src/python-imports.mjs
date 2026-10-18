import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

// The scanner is trusted toolchain code, never a handler or its interpreter.
// -I -S excludes PYTHONPATH, sitecustomize, .pth files and user site packages.
export function pythonImportClosure(entrypoint, { packageRoot, python = process.platform === "win32" ? "python" : "python3", maxFiles = 4096, maxBytes = 16 * 1024 * 1024 } = {}) {
  const result = spawnSync(python, ["-I", "-S", fileURLToPath(new URL("./python-imports.py", import.meta.url))], {
    input: JSON.stringify({ entrypoint, package_root: packageRoot, max_files: maxFiles, max_bytes: maxBytes }),
    encoding: "utf8", timeout: 30000, maxBuffer: 4 * 1024 * 1024, windowsHide: true,
  });
  let report;
  try { report = JSON.parse(result.stdout); } catch { /* No raw source or interpreter output in diagnostics. */ }
  if (result.error || result.status !== 0 || !report?.files) {
    throw Object.assign(new Error(report?.message ?? "Python import analysis failed; select a trusted Python 3.11+ interpreter with --python."), { code: report?.code ?? "HandlerImportInvalid" });
  }
  return report;
}
