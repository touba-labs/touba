import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { sdkBuildIdentity } from "./sdk-build-identity.mjs";

export const SDK_INSTALL_HINT = 'Install the SDK tarball reported by `touba version --json` (distribution.sdk_archive) with `npm install --offline --ignore-scripts --save-exact <archive.tgz>` in the project. Do not link to the CLI installation.';

// Read-only resolution, never execute user modules or install anything.
export function inspectSdkDependency(root, expectedVersion, expectedRoot) {
  const projectRequire = createRequire(join(root, "package.json"));
  let entry;
  try { entry = projectRequire.resolve("@touba/sdk"); }
  catch { return issue("HandlerSdkMissing", SDK_INSTALL_HINT); }
  let sdkRoot = dirname(entry);
  for (;;) {
    const path = join(sdkRoot, "package.json");
    if (existsSync(path)) {
      try { if (JSON.parse(readFileSync(path, "utf8")).name === "@touba/sdk") break; } catch { /* report below */ }
    }
    if (dirname(sdkRoot) === sdkRoot) return issue("HandlerSdkInvalid", SDK_INSTALL_HINT);
    sdkRoot = dirname(sdkRoot);
  }
  const manifest = JSON.parse(readFileSync(join(sdkRoot, "package.json"), "utf8"));
  if (manifest.version !== expectedVersion) return issue("HandlerSdkIncompatible", `Project SDK version ${manifest.version} differs from CLI SDK ${expectedVersion}. Upgrade explicitly from the matching archive; no dependency was changed.`);
  let build;
  if (expectedRoot) {
    try {
      build = sdkBuildIdentity(sdkRoot);
      const expected = sdkBuildIdentity(expectedRoot);
      if (build !== expected) return { ...issue("HandlerSdkBuildMismatch", `Project SDK source differs from this toolchain despite the same version. ${SDK_INSTALL_HINT}`), build, expected_build: expected };
    } catch { return issue("HandlerSdkInvalid", SDK_INSTALL_HINT); }
  }
  const sdkRequire = createRequire(join(sdkRoot, "package.json"));
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    try { sdkRequire.resolve(name); }
    catch { return issue("HandlerSdkDependencyMissing", `SDK runtime dependency ${name} is unavailable. ${SDK_INSTALL_HINT}`); }
  }
  const packagePath = join(root, "package.json");
  const project = existsSync(packagePath) ? JSON.parse(readFileSync(packagePath, "utf8")) : {};
  if (!project.dependencies?.["@touba/sdk"]) return issue("HandlerSdkDependencyUndeclared", `Declare @touba/sdk in this project's runtime dependencies. ${SDK_INSTALL_HINT}`);
  return { status: "ready", version: manifest.version, path: sdkRoot, ...(build ? { build } : {}) };
}

function issue(code, message) { return { status: "unavailable", code, message }; }
