import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { assertPackageUnchanged, packageDigest, packageError, readPackage } from "./package-contract.mjs";
import { assertPlainDirectory, findPackageWorkspace } from "./package-store.mjs";
import { packPackage } from "./packages.mjs";
import { checkRegistry } from "./registry.mjs";

const json = value => JSON.stringify(value, null, 2) + "\n";

// Local static publication only. The existing registry reader remains the
// validator and the index is the sole publication boundary.
export async function publishPackage(path, options = {}) {
  if (typeof options.registry !== "string" || !options.registry.trim() || /^\w+:\/\//.test(options.registry)) {
    throw packageError("PackagePublicationTargetInvalid", "publish requires --registry <local-directory>; deploy that directory separately");
  }
  path ??= findPackageWorkspace(options.root, { author: true });
  const author = readPackage(path, { publishing: true });
  let registry = resolve(options.registry);
  // Resolve the selected directory boundary, e.g. macOS /tmp, not its children.
  if (existsSync(registry)) {
    if (lstatSync(registry).isSymbolicLink() || !lstatSync(registry).isDirectory()) throw packageError("PackagePublicationTargetInvalid", "registry must be a directory, not a link or file");
    registry = realpathSync(registry);
  } else {
    registry = join(realpathSync(dirname(registry)), registry.slice(dirname(registry).length + 1));
    assertPlainDirectory(registry);
    mkdirSync(registry);
  }
  const lock = join(registry, ".touba-registry-publishing");
  let fd;
  try { fd = openSync(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") throw packageError("PackagePublicationBusy", "registry has an active or interrupted publication; inspect it before recovery"); throw error; }
  let temporary;
  let stagedIndex;
  try {
    temporary = realpathSync(mkdtempSync(join(tmpdir(), "touba-package-publish-")));
    const indexPath = join(registry, "index.json");
    if (existsSync(indexPath) && (lstatSync(indexPath).isSymbolicLink() || !lstatSync(indexPath).isFile())) throw packageError("RegistryIndexSchemaInvalid", "index must be a regular file");
    const before = existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null;
    if (before !== null) {
      const checked = await checkRegistry({ registry, sourceRoot: registry });
      if (checked.status !== "success") throw packageError("RegistryIndexSchemaInvalid", "existing registry failed validation; repair before publication");
    }
    const index = before === null ? { index_schema_version: "touba-registry-index-v1", packages: [] } : JSON.parse(before);
    const { name, version } = author.document;
    if (index.packages.some(entry => entry.package_ref === `pkg:${name}` && entry.version === version)) {
      throw packageError("RegistryPublishedVersionImmutable", "this identity and version already exists; publish a new version");
    }
    const archivePath = `archives/${name}-${version}.tar.gz`;
    const metadataPath = `metadata/${name}-${version}.json`;
    for (const target of [archivePath, metadataPath]) {
      assertPlainDirectory(dirname(join(registry, target)));
      try { lstatSync(join(registry, target)); throw packageError("PackagePublicationConflict", "unindexed publication files already exist; inspect before recovery"); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    const archive = await packPackage(path, { output: join(temporary, "package.tar.gz"), projectRoot: options.projectRoot });
    assertPackageUnchanged(author);
    const parts = name.split(".");
    const metadata = { schema_version: "touba-registry-package-v1", package_ref: `pkg:${name}`,
      namespace: parts.slice(0, -1).join("."), name: parts.at(-1), version, kind: "touba_package", status: "draft",
      summary: author.document.description,
      source: { type: "package_archive", url: archivePath, path: archivePath, revision: archive.digest },
      compatibility: { touba: author.document.touba.runtime_compatibility, protocols: ["touba-package-v1"] },
      artifacts: [{ kind: "package_archive", path: archivePath, digest: archive.digest }] };
    const metadataBytes = json(metadata);
    index.packages.push({ package_ref: metadata.package_ref, version, kind: metadata.kind, status: metadata.status,
      metadata_path: metadataPath, metadata_digest: packageDigest(Buffer.from(metadataBytes)) });
    index.packages.sort((a, b) => `${a.package_ref}@${a.version}`.localeCompare(`${b.package_ref}@${b.version}`));
    if ((existsSync(indexPath) ? readFileSync(indexPath, "utf8") : null) !== before) throw packageError("PackagePublicationConflict", "registry index changed during publication");
    mkdirSync(dirname(join(registry, archivePath)), { recursive: true });
    mkdirSync(dirname(join(registry, metadataPath)), { recursive: true });
    copyFileSync(archive.output, join(registry, archivePath), constants.COPYFILE_EXCL);
    writeFileSync(join(registry, metadataPath), metadataBytes, { flag: "wx" });
    stagedIndex = mkdtempSync(join(registry, ".index-"));
    writeFileSync(join(stagedIndex, "index.json"), json(index), { flag: "wx" });
    renameSync(join(stagedIndex, "index.json"), indexPath);
    return { status: "success", command: "package publish", package: name, version, path: registry,
      notes: ["Published locally as draft. Review code before installing with --allow-draft. No code was executed or uploaded."] };
  } finally {
    closeSync(fd);
    unlinkSync(lock);
    if (temporary) rmSync(temporary, { recursive: true, force: true });
    if (stagedIndex) rmSync(stagedIndex, { recursive: true, force: true });
  }
}
