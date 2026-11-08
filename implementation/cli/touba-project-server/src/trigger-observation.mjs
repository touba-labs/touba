import { existsSync } from "node:fs";
import { createSqliteTriggerStore } from "../../../runtime/touba-runtime/src/sqlite-trigger-store.mjs";
import { createSqliteTriggerQueue } from "../../touba-trigger-service/src/sqlite-queue.mjs";
import { buildTriggerStatusContract } from "../../touba-trigger-service/src/serve.mjs";

/** Read the service's own ledgers without creating a store or changing a claim. */
export function observeTriggerStores({ documents, manifest, statePath, queuePath, generatedAt }) {
  let state, queue;
  try {
    if (existsSync(statePath)) state = createSqliteTriggerStore({ filename: statePath, readOnly: true });
    if (existsSync(queuePath)) queue = createSqliteTriggerQueue({ filename: queuePath, readOnly: true });
    const entries = new Map();
    for (const document of documents) {
      const status = buildTriggerStatusContract({ document, manifest, state, queue, generatedAt });
      for (const entry of status.triggers) {
        const previous = entries.get(entry.trigger_ref);
        if (previous && JSON.stringify(previous) !== JSON.stringify(entry)) {
          throw Object.assign(new Error("compiled trigger definitions disagree; prepare the project again"),
            { code: "ToubaServeTriggerDefinitionConflict" });
        }
        entries.set(entry.trigger_ref, entry);
      }
    }
    return { schema_version: "touba-trigger-status-v1", generated_at: generatedAt,
      triggers: [...entries.values()].sort((a, b) => a.trigger_ref.localeCompare(b.trigger_ref)) };
  } finally { state?.close(); queue?.close(); }
}
