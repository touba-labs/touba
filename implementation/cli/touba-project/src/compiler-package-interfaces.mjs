import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Copy the verified interface from memory. The compiler does not reopen package
// manifests, and its arguments stay bounded by paths rather than export counts.
export function snapshotCompilerPackageInterfaces(interfaces = []) {
  if (interfaces.length === 0) return { args: [], dispose() {} };

  const directory = mkdtempSync(join(tmpdir(), "touba-compiler-packages-"));
  const path = join(directory, "interfaces.json");
  const dispose = () => rmSync(directory, { recursive: true, force: true });
  try {
    writeFileSync(path, JSON.stringify(interfaces), { flag: "wx", mode: 0o600 });
    return { args: ["--package-interfaces", path], dispose };
  } catch (error) {
    dispose();
    throw error;
  }
}
