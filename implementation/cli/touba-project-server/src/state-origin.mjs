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

export function inspectStateOrigin(projectRoot) {
  const path = join(projectRoot, ".touba/state-origin.json");
  if (!existsSync(path)) return { status: "unrecorded", build_id: null };
  const stat = lstatSync(path);
  if (stat.isSymbolicLink() || !stat.isFile()) throw failure("ToubaServeStateOriginInvalid");
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); } catch { throw failure("ToubaServeStateOriginInvalid"); }
  if (value?.schema_version !== "touba-serve-state-origin-v1" || typeof value.project_root !== "string"
      || typeof value.build_id !== "string" || !/^(?:source:)?[a-f0-9]{64}$/.test(value.build_id)
      || Object.keys(value).sort().join(",") !== "build_id,project_root,schema_version") throw failure("ToubaServeStateOriginInvalid");
  if (value.project_root !== realpathSync(projectRoot)) throw failure("ToubaServeStateProjectMismatch");
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
