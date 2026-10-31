import { ExplorerSession } from "../../touba-inspect/src/explorer/project.mjs";
import { realpathSync } from "node:fs";

// One shared, bounded Core projection per project, not one compiler per client.
export function createProjectExplorerSurface(projectRoot) {
  const root = realpathSync(projectRoot);
  let session;
  return {
    state() {
      if (!session) { session = new ExplorerSession(root); void session.start(); }
      return { schema_version: "touba-project-explorer-state-v1", ...session.state };
    },
    source(id, revision) {
      if (!session?.state.graph || revision !== session.state.graph.revision) {
        throw Object.assign(new Error("Explorer revision changed; refresh the view"), { code: "ToubaServeExplorerRevisionConflict" });
      }
      return session.source(id);
    },
    close() { session?.close(); },
  };
}
