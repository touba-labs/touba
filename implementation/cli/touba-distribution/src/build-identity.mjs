import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Hash the assembled payload, not timestamps, absolute paths or metadata that
// contains the hash itself. Framing separates paths, sizes and file contents.
export function toolchainBuildIdentity(root) {
  const hash = createHash("sha256");
  hash.update("touba-toolchain-content-v1\0");
  function visit(relativePath) {
    const path = join(root, ...relativePath.split("/"));
    const stat = lstatSync(path);
    if (stat.isDirectory()) {
      hash.update(`directory\0${relativePath}\0`);
      for (const name of readdirSync(path).sort()) visit(`${relativePath}/${name}`);
    } else if (stat.isFile()) {
      const bytes = readFileSync(path);
      hash.update(`file\0${relativePath}\0${bytes.length}\0`);
      hash.update(bytes);
    } else {
      throw new Error(`unsupported build identity entry: ${relativePath}`);
    }
  }
  for (const directory of ["bin", "lib", "sdk"]) visit(directory);
  return {
    id: hash.digest("hex"),
    algorithm: "sha256",
    identity_scope: "touba-toolchain-content-v1",
  };
}
