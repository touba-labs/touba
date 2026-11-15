import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cachedBuild;
export function currentStateBuild() {
  if (cachedBuild) return cachedBuild;
  const implementation = fileURLToPath(new URL("../../../", import.meta.url));
  const metadata = join(implementation, "../TOOLCHAIN.json");
  if (existsSync(metadata)) {
    const build = JSON.parse(readFileSync(metadata, "utf8")).build;
    if (typeof build?.id !== "string" || !/^[a-f0-9]{64}$/.test(build.id)
        || build.algorithm !== "sha256" || build.identity_scope !== "touba-toolchain-content-v1") throw failure("ToubaServeBuildIdentityInvalid");
    return cachedBuild = build.id;
  }
  if (basename(resolve(implementation)) !== "implementation") return "unknown";
  const hash = createHash("sha256").update("touba-source-state-build-v1\0");
  function visit(path, label) {
    if (lstatSync(path).isDirectory()) {
      for (const name of readdirSync(path).sort()) visit(join(path, name), `${label}/${name}`);
    } else if (/\.(?:mjs|json)$/.test(path)) {
      hash.update(label + "\0"); hash.update(readFileSync(path)); hash.update("\0");
    }
  }
  for (const part of ["runtime/touba-runtime/src", "cli/touba-project-server/src", "contracts/machine"]) visit(join(implementation, part), part);
  return cachedBuild = `source:${hash.digest("hex")}`;
}
function failure(code) { return Object.assign(new Error(code), { code }); }

export function validateStateOrigin(value, projectRoot) {
  const build = id => typeof id === 'string' && /^(?:source:)?[a-f0-9]{64}$/.test(id);
  const keys = (object, names) => Object.keys(object).sort().join(',') === names.sort().join(',');
  if (!value || !build(value.build_id) || value.project_root !== realpathSync(projectRoot)) throw failure('ToubaServeStateOriginInvalid');
  if (value.schema_version === 'touba-serve-state-origin-v1') {
    if (!keys(value, ['schema_version', 'project_root', 'build_id'])) throw failure('ToubaServeStateOriginInvalid');
  } else if (value.schema_version === 'touba-serve-state-origin-v2') {
    if (!keys(value, ['schema_version', 'project_root', 'build_id', 'initial_build_id', 'transitions'])
      || !build(value.initial_build_id) || !Array.isArray(value.transitions) || !value.transitions.length || value.transitions.length > 128) throw failure('ToubaServeStateOriginInvalid');
    let previous = value.initial_build_id;
    for (const row of value.transitions) {
      if (!row || !keys(row, ['from_build_id', 'to_build_id', 'review_digest', 'backup_id', 'recorded_at', 'reason'])
        || row.from_build_id !== previous || !build(row.to_build_id) || row.to_build_id === previous
        || !/^[a-f0-9]{64}$/.test(row.review_digest ?? '') || !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(row.backup_id ?? '')
        || !Number.isFinite(Date.parse(row.recorded_at)) || typeof row.reason !== 'string' || !row.reason.trim()
        || row.reason.length > 500 || /[\u0000-\u001f\u007f]/u.test(row.reason)) throw failure('ToubaServeStateOriginInvalid');
      previous = row.to_build_id;
    }
    if (previous !== value.build_id) throw failure('ToubaServeStateOriginInvalid');
  } else throw failure('ToubaServeStateOriginInvalid');
  return value;
}

export function inspectStateOrigin(projectRoot) {
  const path = join(projectRoot, ".touba/state-origin.json");
  if (!existsSync(path)) return { status: "unrecorded", build_id: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile() || stat.nlink !== 1 || stat.size > 256 * 1024) throw failure("ToubaServeStateOriginInvalid");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw failure("ToubaServeStateOriginInvalid"); }
  if (value?.project_root !== realpathSync(projectRoot)) throw failure("ToubaServeStateProjectMismatch");
  validateStateOrigin(value, projectRoot);
  return { status: value.build_id === currentStateBuild() ? "matching" : "different_build", build_id: value.build_id };
}

export function admitStateOrigin(projectRoot, statePaths) {
  const origin = inspectStateOrigin(projectRoot);
  if (origin.status === "different_build") throw failure("ToubaServeStateBuildMismatch");
  if (origin.status === "unrecorded" && !statePaths.some(existsSync)) {
    const buildId = currentStateBuild();
    if (buildId === "unknown") throw failure("ToubaServeBuildIdentityInvalid");
    const path = join(projectRoot, ".touba/state-origin.json");
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    try { writeFileSync(path, JSON.stringify({ schema_version: "touba-serve-state-origin-v1", project_root: realpathSync(projectRoot), build_id: buildId }) + "\n", { flag: "wx", mode: 0o600 }); }
    catch (error) { if (error.code !== "EEXIST") throw error; }
    if (inspectStateOrigin(projectRoot).status !== "matching") throw failure("ToubaServeStateBuildMismatch");
  }
  // Historical data without provenance is not relabelled. Canonical record
  // validation remains mandatory; preflight reports that origin is unknown.
}
