import { join } from "node:path";
import { PACKAGE_MANIFEST, PACKAGE_NAME, packageError, packageFile, readPackage } from "./package-contract.mjs";
import { findPackageWorkspace, readPackageWorkspace, verifyInstalledPackages } from "./package-store.mjs";

// Selection is an application decision. Never infer a host role from package contents.
export function resolvePackageHost(selection, kind, start = process.cwd()) {
  const match = typeof selection === "string" && /^pkg:([^/]+)\/([a-z][a-z0-9-]*)$/.exec(selection);
  if (!match || !PACKAGE_NAME.test(match[1])) throw packageError("PackageHostSelectionInvalid", "use pkg:organization.name/host-id");
  const root = findPackageWorkspace(start);
  const workspace = readPackageWorkspace(root);
  const lock = verifyInstalledPackages(root, workspace.records);
  const installed = lock.packages.find(item => item.name === match[1]);
  if (!installed) throw packageError("PackageNotInstalled", "the selected host package must be installed and locked");
  const pkg = readPackage(join(root, "packages", installed.name, PACKAGE_MANIFEST));
  if (!pkg.requirements.compatible) throw packageError("PackageRequirementMissing", pkg.requirements.missing.join("; "));
  const host = pkg.document.hosts?.find(item => item.id === match[2]);
  if (!host || host.kind !== kind) throw packageError("PackageHostSelectionInvalid", "the selected package host must declare the requested role");
  return { path: packageFile(pkg.root, host.path), root,
    identity: JSON.stringify(lock.packages.map(item => [item.name, item.version, item.digest]).sort()) };
}
