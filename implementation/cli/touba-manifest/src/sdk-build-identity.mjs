import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Identity of Touba's SDK implementation, not an attestation of third-party
// dependencies. Packaging and installed-project inspection use the same bytes.
export function sdkBuildIdentity(root) {
  const hash = createHash("sha256").update("touba-sdk-source-v1\0");
  function visit(relative) {
    const path = join(root, relative), stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      const bytes = readFileSync(path);
      hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
    } else throw new Error("SDK implementation must contain regular files and directories");
  }
  visit("src");
  return `sha256:${hash.digest("hex")}`;
}
