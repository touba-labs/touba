import { randomUUID } from "node:crypto";
import { setTimeout as wait } from "node:timers/promises";

// Runs outside the execution path. The durable local journal is the outbox.
// A lost response after remote COMMIT leaves the cursor unchanged for retry.
export function createTraceExportWorker({ store, destination, name = "primary", batchSize = 100, owner = randomUUID() }) {
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) throw new TypeError("batchSize must be between 1 and 1000");
  const config = store.configureExport({ name, destinationId: destination.destinationId });
  let lease = null, busy = false;
  async function step() {
    if (busy) throw Object.assign(new Error("export step already running"), { code: "TraceExportBusy" });
    busy = true;
    try {
      if (!lease) {
        lease = await destination.acquire(config.sourceId, owner);
        if (!lease) return { status: "owned_by_peer" };
        store.exportLease(name, lease);
      } else await destination.renew(config.sourceId, lease);
      const batch = store.nextExport(name, lease, batchSize);
      if (!batch) return { status: "caught_up", ...store.exportStatus(name) };
      const ack = await destination.deliver(config.sourceId, lease, batch);
      if (ack?.segmentId !== batch.segmentId || ack?.through !== batch.through || ack?.headerDigest !== batch.headerDigest) {
        throw Object.assign(new Error("destination acknowledgement does not match the batch"), { code: "TraceExportAckInvalid" });
      }
      store.acknowledgeExport(name, lease, batch);
      return { status: "exported", events: batch.events.length, ...store.exportStatus(name) };
    } catch (error) {
      if (error.code === "TraceExportLeaseStale") lease = null;
      throw error;
    } finally { busy = false; }
  }
  return Object.freeze({ step,
    async watch({ signal, pollMs = 1000, onError = () => {} } = {}) {
      if (!Number.isSafeInteger(pollMs) || pollMs < 50 || pollMs > 60000) throw new TypeError("pollMs must be between 50 and 60000");
      let failures = 0;
      while (!signal?.aborted) {
        let result;
        try { result = await step(); failures = 0; }
        catch (error) {
          onError(error); failures++;
          if (String(error.code ?? "").startsWith("TraceExport") && error.code !== "TraceExportLeaseStale") throw error;
        }
        const delay = failures ? Math.min(30000, pollMs * 2 ** Math.min(failures - 1, 10)) : result?.status === "exported" ? 0 : pollMs;
        try { await wait(delay, undefined, { signal }); }
        catch (error) { if (error.name !== "AbortError") throw error; }
      }
    },
    async close() {
      if (busy) throw Object.assign(new Error("wait for the active export step before closing"), { code: "TraceExportBusy" });
      if (lease) { const current = lease; lease = null; await destination.release(config.sourceId, current); }
    },
  });
}
