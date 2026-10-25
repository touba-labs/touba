import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** Resolve a host-owned journal, never a path taken from the AIR document. */
export function projectTracePath(inputPath, runPlanPath) {
  const base = dirname(resolve(runPlanPath ?? inputPath));
  for (let directory = base; ; directory = dirname(directory)) {
    if (existsSync(join(directory, "touba.project.json"))) return join(directory, ".touba", "traces.sqlite");
    if (dirname(directory) === directory) break;
  }
  return join(base, ".touba", "traces.sqlite");
}
