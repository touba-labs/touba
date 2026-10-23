import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ENTRY_REF = /^(strategy|skill|function|tool|trigger):[A-Za-z0-9_.-]+\/[A-Za-z][A-Za-z0-9_]*$/u;
const invalid = message => Object.assign(new Error(message), { code: "ProjectEntrypointsInvalid" });

/** Project-owned execution admission, never inferred from inspection or a client. */
export function projectEntrypoints(config) {
  if (!config || typeof config !== "object" || Array.isArray(config)) throw invalid("project configuration must be an object");
  if (config.entrypoints !== undefined && (!Array.isArray(config.entrypoints) || config.entrypoints.length > 1024)) {
    throw invalid("entrypoints must be an array of at most 1024 explicit AIR references");
  }
  const refs = config.entrypoints ?? [];
  for (const ref of [...refs, ...(config.entry === undefined ? [] : [config.entry])]) {
    if (typeof ref !== "string" || !ENTRY_REF.test(ref)) {
      throw invalid("project entrypoints must name strategies, skills, functions, tools or triggers; agents require an authorized caller");
    }
  }
  if (new Set(refs).size !== refs.length) throw invalid("project entrypoints must be unique");
  return [...new Set([...(config.entry === undefined ? [] : [config.entry]), ...refs])];
}

export function readProjectEntrypoints(root) {
  const path = join(root, "touba.project.json");
  if (!existsSync(path)) return [];
  let config;
  try { config = JSON.parse(readFileSync(path, "utf8")); }
  catch { throw invalid("cannot read touba.project.json execution admission"); }
  return projectEntrypoints(config);
}

export function assertProjectEntrypoint(root, ref) {
  if (!readProjectEntrypoints(root).includes(ref)) {
    throw Object.assign(new Error("execution target is not a declared project entrypoint; declare entry or entrypoints in touba.project.json"), {
      code: "ProjectEntrypointNotAllowed",
    });
  }
}
