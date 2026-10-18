import { closeSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, realpathSync, renameSync, rmSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { toolchainBuildIdentity } from "./build-identity.mjs";

function fail(code) { throw Object.assign(new Error(code), { code }); }
function regularDirectory(path) {
  const stat = lstatSync(path);
  if (!stat.isDirectory() || stat.isSymbolicLink()) fail("InstallationPathUnsafe");
}
function pathExists(path) {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === "ENOENT") return false; throw error; }
}
function canonicalTarget(path) {
  let parent = path;
  const parts = [];
  while (!pathExists(parent)) {
    parts.unshift(relative(dirname(parent), parent)); parent = dirname(parent);
  }
  return resolve(realpathSync(parent), ...parts);
}
function overlap(a, b) {
  const inside = (root, path) => { const rel = relative(root, path); return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel)); };
  return inside(a, b) || inside(b, a);
}
function identity(root, requireDeclared = false) {
  const actual = toolchainBuildIdentity(root);
  const metadata = JSON.parse(readFileSync(join(root, "TOOLCHAIN.json"), "utf8"));
  if ((requireDeclared || metadata.build) && (metadata.build?.id !== actual.id
      || metadata.build.algorithm !== actual.algorithm || metadata.build.identity_scope !== actual.identity_scope)) {
    fail("InstallationBuildMismatch");
  }
  return actual.id;
}

/** Preserve the prior payload; never migrate application state or run handlers. */
export function installToolchainPayload({ source, prefix, force = false }) {
  source = resolve(source); prefix = resolve(prefix);
  regularDirectory(source);
  if (dirname(prefix) === prefix) fail("InstallationPrefixUnsafe");
  if (overlap(realpathSync(source), canonicalTarget(prefix))) fail("InstallationPathsOverlap");
  mkdirSync(prefix, { recursive: true }); regularDirectory(prefix);
  const installRoot = join(prefix, "touba-toolchain");
  const archives = join(prefix, "builds");
  // Compare physical parents as well as user spelling, before staging or rename.
  if (overlap(realpathSync(source), realpathSync(prefix))) fail("InstallationPathsOverlap");
  const lock = join(prefix, ".install.lock");
  let lockFd;
  try { lockFd = openSync(lock, "wx", 0o600); }
  catch (error) { if (error.code === "EEXIST") fail("InstallationInProgress"); throw error; }
  let staging, archived, moved = false;
  try {
    const nextId = identity(source, true);
    if (pathExists(installRoot)) {
      regularDirectory(installRoot);
      if (!force) fail("InstallationExists");
      const previousId = identity(installRoot);
      if (previousId === nextId) return { install_root: installRoot, build_id: nextId, preserved_build: null, unchanged: true };
      mkdirSync(archives, { recursive: true }); regularDirectory(archives);
      archived = join(archives, previousId);
      if (pathExists(archived)) {
        regularDirectory(archived);
        if (identity(archived) !== previousId) fail("InstallationArchiveConflict");
        // Do not overwrite even a duplicate archive. The active copy is kept
        // under another explicit recovery location for this transition.
        archived = join(mkdtempSync(join(archives, `${previousId}-copy-`)), "touba-toolchain");
      }
    }
    staging = mkdtempSync(join(prefix, ".install-stage-"));
    const candidate = join(staging, "touba-toolchain");
    cpSync(source, candidate, { recursive: true, errorOnExist: true, force: false });
    if (identity(candidate, true) !== nextId) fail("InstallationBuildMismatch");
    if (archived) { renameSync(installRoot, archived); moved = true; }
    try { renameSync(candidate, installRoot); }
    catch (error) { if (moved && !existsSync(installRoot)) { renameSync(archived, installRoot); moved = false; } throw error; }
    return { install_root: installRoot, build_id: nextId, preserved_build: archived ?? null, unchanged: false };
  } finally {
    if (staging) rmSync(staging, { recursive: true, force: true });
    closeSync(lockFd); unlinkSync(lock);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href) {
  try {
    const options = {};
    for (let i = 2; i < process.argv.length; i++) {
      const flag = process.argv[i];
      if (flag === "--force") options.force = true;
      else if (["--source", "--prefix"].includes(flag) && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) options[flag.slice(2)] = process.argv[++i];
      else fail("InstallationOptionInvalid");
    }
    if (!options.source || !options.prefix) fail("InstallationOptionInvalid");
    process.stdout.write(JSON.stringify(installToolchainPayload(options)) + "\n");
  } catch (error) {
    process.stderr.write(`Touba installation refused: ${error.code ?? "InstallationFailed"}\n`);
    process.exitCode = 1;
  }
}
