import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { verifyInstalledPackages } from "./package-store.mjs";

// Direct AIR execution still consumes the installation contract of a project
// hosting its manifest or handler. Omitting context activation cannot bypass it.
export function verifyManifestPackages(manifestPath, manifest) {
  const roots = new Set();
  function inspect(path) {
    if (!existsSync(path)) return;
    let directory = dirname(realpathSync(path));
    for (;;) {
      const config = join(directory, "touba.project.json");
      if (existsSync(config)) { roots.add(directory); return; }
      const parent = dirname(directory);
      if (parent === directory) return;
      directory = parent;
    }
  }
  inspect(manifestPath);
  for (const binding of Object.values(manifest.bindings ?? {})) {
    const cwd = resolve(dirname(manifestPath), binding?.handler?.cwd ?? ".");
    for (const arg of binding?.handler?.args ?? []) {
      if (typeof arg === "string" && /\.(?:mjs|cjs|js|py)$/.test(arg) && !arg.startsWith("-")) inspect(resolve(cwd, arg));
    }
  }
  for (const root of roots) {
    const config = JSON.parse(readFileSync(join(root, "touba.project.json"), "utf8"));
    verifyInstalledPackages(root, config.packages ?? []);
  }
}
