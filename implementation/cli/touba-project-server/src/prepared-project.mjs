import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { validateObject } from "../../../tools/validate-product-surface-contracts.mjs";
import { loadResourceBindingFiles, selectResourceBindings } from "../../../contracts/resource-binding-files.mjs";
import { admitPreparedPackages } from "../../touba-project/src/package-admission.mjs";

export function loadPreparedPackageAdmission(projectRoot, airPath) {
  const prepared = readPreparedProject(projectRoot);
  const planRecord = prepared?.inputs.find(input => input.kind === "run_plan");
  if (!planRecord) return undefined;
  const planPath = resolve(projectRoot, planRecord.path);
  const manifest = prepared.inputs.find(input => input.kind === "manifest");
  return admitPreparedPackages(planPath, JSON.parse(readFileSync(planPath, "utf8")), resolve(projectRoot, airPath),
    manifest ? resolve(projectRoot, manifest.path) : undefined);
}

export function loadPreparedResourceBindings(projectRoot, air) {
  const prepared = readPreparedProject(projectRoot);
  const entries = prepared?.inputs.filter(input => input.kind === "resource_bindings") ?? [];
  return selectResourceBindings(loadResourceBindingFiles(entries, projectRoot), air);
}

const schema = JSON.parse(readFileSync(new URL("../../../contracts/product-surfaces/schemas/touba-effective-project-v1.schema.json", import.meta.url), "utf8"));

// The local sandbox uses the development preparation, never an arbitrary
// profile found by directory order. Production activation belongs to deploy.
export function readPreparedProject(projectRoot, { verify = true } = {}) {
  const path = join(projectRoot, ".touba/build/dev/touba.effective-project.json");
  if (!existsSync(path)) return null;
  let prepared;
  try {
    confinedFile(projectRoot, path);
    prepared = JSON.parse(readFileSync(path, "utf8"));
    if (validateObject(schema, prepared).length || prepared.project.profile !== "dev") throw new Error("invalid effective project");
    for (const input of prepared.inputs) {
      if (isAbsolute(input.path)) throw new Error("absolute artifact path");
      const inputPath = confinedFile(projectRoot, resolve(projectRoot, input.path));
      if (verify) {
        const digest = `sha256:${createHash("sha256").update(readFileSync(inputPath)).digest("hex")}`;
        if (digest !== input.digest_sha256) throw new Error(`artifact changed: ${input.path}`);
      }
    }
  } catch (cause) {
    const error = new Error(`development preparation is missing, invalid or stale; run touba prepare --profile dev --mode write (${cause.message})`);
    error.code = "ToubaServePreparedProjectInvalid";
    throw error;
  }
  return prepared;
}

function confinedFile(root, path) {
  const base = realpathSync(root);
  for (const [origin, candidate] of [[resolve(root), resolve(path)], [base, realpathSync(path)]]) {
    const rel = relative(origin, candidate);
    if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw new Error("artifact escapes project root");
  }
  if (!statSync(path).isFile()) throw new Error("artifact must be a regular file");
  return path;
}
