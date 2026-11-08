import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { readPackage } from "../../touba-project/src/package-contract.mjs";
import { readPackageWorkspace, readPackageLock, assertOnlyInventory, PACKAGE_LOCK, PACKAGE_TRANSACTION } from "../../touba-project/src/package-store.mjs";

const hash = bytes => `sha256:${createHash("sha256").update(bytes).digest("hex")}`;

// Folder discovery is not installation evidence. Every package is inspected
// against the consumer declaration, canonical lock and complete file inventory.
export function inspectPackageInstallation(root, manifest, manifestDigest) {
  const base = { status: "unregistered", digest: manifestDigest, digest_kind: "manifest",
    manifest_digest: manifestDigest, lock_digest: null, expected_digest: null };
  try {
    if (existsSync(join(root, PACKAGE_TRANSACTION))) return { ...base, status: "invalid", issue: "PackageInstallationIncomplete" };
    const workspace = readPackageWorkspace(root), lock = readPackageLock(root);
    if (existsSync(join(root, PACKAGE_LOCK))) base.lock_digest = hash(readFileSync(join(root, PACKAGE_LOCK)));
    const entry = lock.packages.find(item => item.manifest === manifest);
    const record = workspace.records.find(item => resolve(root, item.manifest) === resolve(root, manifest));
    const pkg = readPackage(join(root, manifest));
    base.digest = pkg.digest; base.digest_kind = "package";
    if (!entry && !record) return base;
    base.expected_digest = entry?.digest ?? null;
    if (!entry || !record || record.editable === true || record.version !== entry.version
      || pkg.document.name !== entry.name || pkg.document.version !== entry.version
      || pkg.digest !== entry.digest || JSON.stringify(pkg.files) !== JSON.stringify(entry.files)) {
      return { ...base, status: "invalid", issue: "PackageLockMismatch" };
    }
    assertOnlyInventory(pkg);
    return { ...base, status: "installed" };
  } catch (error) {
    return { ...base, status: "invalid", issue: error.code ?? "PackageInspectionInvalid" };
  }
}
