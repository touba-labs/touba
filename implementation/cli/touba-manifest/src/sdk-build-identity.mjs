import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Identity of Touba's SDK implementation, not an attestation of third-party
// dependencies. Packaging and installed-project inspection use the same bytes.
export function sdkBuildIdentity(root) {
  const hash = createHash("sha256").update("touba-sdk-source-v1\0");
  for (const relative of sdkSourceFiles(root)) {
    let bytes = readFileSync(join(root, relative));
    // Compare workspace and installed SDKs using the exact contract bytes
    // materialized by packageSdk, rather than the workspace forwarding module.
    if (relative === "src/value-contracts.mjs" && bytes.toString("utf8").trim() === 'export * from "../../../contracts/machine/value-contracts.mjs";') {
      bytes = readFileSync(join(root, "../../contracts/machine/value-contracts.mjs"));
    }
    hash.update(`${relative}\0${bytes.length}\0`).update(bytes);
  }
  return `sha256:${hash.digest("hex")}`;
}

// Same regular-file inventory for identity and explicit sandbox manifests.
export function sdkSourceFiles(root) {
  const files = [];
  function visit(relative) {
    const path = join(root, relative), stat = lstatSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(`${relative}/${name}`);
    } else if (stat.isFile()) {
      files.push(relative);
      if (files.length > 4095) throw new Error("SDK source inventory exceeds its file limit");
    } else throw new Error("SDK implementation must contain regular files and directories");
  }
  visit("src");
  return files;
}
