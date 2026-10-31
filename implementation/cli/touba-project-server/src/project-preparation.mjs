import { prepareProject } from "../../touba-project/src/project.mjs";
import { readPreparedProject } from "./prepared-project.mjs";

// Fixed development profile; no commands, paths, credentials or grants supplied
// by the HTTP client. Canonical prepare compiles, but never runs tool handlers.
export function createProjectPreparation(root) {
  let busy = false;
  return {
    get busy() { return busy; },
    async prepare() {
      if (busy) throw Object.assign(new Error("Project preparation is already running"), { code: "ToubaServePreparationBusy" });
      busy = true;
      try {
        const report = await prepareProject({ root, runProfile: "dev", mode: "write" });
        if (report.status === "success") readPreparedProject(root);
        return { schema_version: "touba-project-preparation-v1", status: report.status, profile: "dev",
          diagnostics: report.diagnostics.map(({ code, message, severity }) => ({ code, message, severity })),
          actions: report.actions.map(({ kind }) => kind) };
      } finally { busy = false; }
    },
  };
}
