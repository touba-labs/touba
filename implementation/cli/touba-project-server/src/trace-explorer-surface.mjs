import { existsSync, realpathSync } from "node:fs";
import { join, relative, isAbsolute, sep } from "node:path";
import { TraceClient } from "../../touba-inspect/src/trace-explorer/client.mjs";

const METHODS = new Set(["list", "select", "query", "detail", "graph", "source", "export", "cancel"]);
const failure = code => Object.assign(new Error(code), { code });

// Each reader has its own selected segment. A second browser/user can never
// replace another reader's selection. Reader processes and idle lifetime are bounded.
export function createProjectTraceExplorer(projectRoot, { maxReaders = 2, idleMs = 300000,
  createClient = options => new TraceClient(options), resolveAir = null, now = Date.now } = {}) {
  const root = realpathSync(projectRoot), filename = join(root, ".touba", "traces.sqlite");
  const readers = new Map();
  let closed = false;
  async function release(key) {
    const item = readers.get(key); if (!item) return;
    // A closing process still occupies a slot until it actually exits.
    item.closing ??= Promise.resolve().then(() => item.client.close()).finally(() => {
      if (readers.get(key) === item) readers.delete(key);
    });
    await item.closing;
  }
  async function expire() {
    for (const [key, item] of readers) if (!item.pending && now() - item.touched >= idleMs) await release(key);
  }
  const timer = setInterval(() => { void expire().catch(() => {}); }, Math.min(idleMs, 30000)); timer.unref?.();
  return {
    async request(principal, body) {
      if (closed) throw failure("ToubaServeTraceExplorerClosed");
      if (typeof principal !== "string" || !principal || !body || typeof body !== "object"
        || !/^[a-zA-Z0-9-]{16,80}$/u.test(body.client_id ?? "") || !METHODS.has(body.method)
        || !body.args || typeof body.args !== "object" || Array.isArray(body.args)
        || JSON.stringify(body).length > 16384) throw failure("ToubaServeTraceExplorerInvalid");
      const key = JSON.stringify([principal, body.client_id]);
      if (body.method === "cancel") { await release(key); return {}; }
      if (!existsSync(filename)) {
        if (body.method === "list") return { segments: [], next: null };
        throw failure("ToubaServeNativeTraceUnavailable");
      }
      const path = realpathSync(filename), rel = relative(root, path);
      if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) throw failure("ToubaServeTraceExplorerPathRejected");
      await expire();
      let item = readers.get(key);
      if (item?.closing) throw failure("ToubaServeTraceExplorerBusy");
      if (!item) {
        if (readers.size >= maxReaders) throw failure("ToubaServeTraceExplorerBusy");
        item = { client: createClient({ root, filename: path }), touched: now(), pending: 0 };
        readers.set(key, item);
      }
      item.pending++;
      try {
        const result = await item.client.request(body.method, body.args);
        if (body.method === "select" && resolveAir && result?.header?.run?.entry_ref) {
          // Source context comes only from the project's prepared AIR, never a
          // path supplied by the browser. The reader verifies the trace digest.
          let air;
          try { air = resolveAir(result.header.run.entry_ref); } catch { air = null; }
          if (air) return await item.client.request("attachAir", { filename: air });
        }
        return result;
      }
      catch (error) {
        if (item.client.closed) await release(key);
        // Reader messages may contain filesystem paths: transport only its code.
        const code = String(error.message).split(":")[0];
        throw failure(/^Trace[A-Za-z]+$/u.test(code) ? code : "ToubaServeTraceExplorerReadFailed");
      } finally { item.pending--; item.touched = now(); }
    },
    async close() { closed = true; clearInterval(timer); await Promise.all([...readers.keys()].map(release)); },
  };
}
