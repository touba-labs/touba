import { existsSync } from "node:fs";
import { Pool } from "pg";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { createPostgresTraceDestination } from "../../../runtime/touba-runtime/src/postgres-trace-destination.mjs";
import { createTraceExportWorker } from "../../../runtime/touba-runtime/src/trace-export-worker.mjs";

export function traceExportOptions(args, environment = process.env) {
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    if (!["--store", "--postgres-env", "--watch", "--batch-size", "--max-batches", "--name", "--schema"].includes(key)
        || Object.hasOwn(options, key)) throw new Error("unknown or duplicate trace export option");
    if (key === "--watch") { options[key] = true; continue; }
    const value = args[++index];
    if (!value || value.startsWith("--") || value.includes("\0")) throw new Error("trace export option requires a value");
    options[key] = value;
  }
  if (!options["--store"] || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(options["--postgres-env"] ?? "")) throw new Error("trace export requires --store and --postgres-env <NAME>");
  const connectionString = environment[options["--postgres-env"]];
  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error("PostgreSQL connection environment variable must contain a valid URL"); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("PostgreSQL URL requires postgres or postgresql protocol");
  const local = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
  // Connection-string SSL options can override pg's ssl object. Refuse
  // weakening options before constructing the pool and never print the URL.
  for (const [key, value] of url.searchParams) if (key.startsWith("ssl") && !(key === "sslmode" && (value === "verify-full" || local && value === "disable"))) throw new Error("PostgreSQL TLS options must preserve certificate and hostname validation");
  if (!local && url.searchParams.get("sslmode") !== "verify-full") url.searchParams.set("sslmode", "verify-full");
  const batchSize = Number(options["--batch-size"] ?? 100), maxBatches = Number(options["--max-batches"] ?? 100);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000 || !Number.isSafeInteger(maxBatches) || maxBatches < 1 || maxBatches > 100000) throw new Error("invalid export batch limit");
  if (options["--watch"] && options["--max-batches"]) throw new Error("--max-batches applies to a single export pass; omit it with --watch");
  return { filename: options["--store"], connectionString: url.toString(), watch: options["--watch"] === true,
    name: options["--name"] ?? "primary", schema: options["--schema"] ?? "touba_traces", batchSize, maxBatches };
}

export async function traceExportCommand(args) {
  const options = traceExportOptions(args);
  if (!existsSync(options.filename)) throw new Error("trace journal does not exist");
  const store = createSqliteTraceStore({ filename: options.filename });
  const pool = new Pool({ connectionString: options.connectionString, max: 1, connectionTimeoutMillis: 5000, query_timeout: 15000 });
  pool.on("error", () => {}); // Failed operations are retried by the export loop.
  const abort = new AbortController(), stop = () => abort.abort();
  let worker;
  try {
    const destination = await createPostgresTraceDestination({ pool, schema: options.schema });
    worker = createTraceExportWorker({ store, destination, name: options.name, batchSize: options.batchSize });
    if (options.watch) {
      process.once("SIGINT", stop); process.once("SIGTERM", stop);
      await worker.watch({ signal: abort.signal, onError() { process.stderr.write("trace export: destination unavailable or batch refused; local evidence retained\n"); } });
    } else {
      for (let i = 0; i < options.maxBatches; i++) if ((await worker.step()).status !== "exported") break;
    }
    return { json: true, report: { schema_version: "touba-trace-export-status-v1", ...store.exportStatus(options.name) }, exitCode: 0 };
  } catch (error) {
    // Driver diagnostics can contain URLs, addresses or user-controlled values.
    const known = /^TraceExport[A-Za-z]+$/.test(error.code ?? "") ? error.code : "TraceExportUnavailable";
    throw Object.assign(new Error(`${known}: export did not complete; local evidence retained`), { code: known });
  } finally {
    process.removeListener("SIGINT", stop); process.removeListener("SIGTERM", stop);
    try { await worker?.close(); } catch { /* lease expires; no cursor is acknowledged here */ }
    await pool.end(); store.close();
  }
}
