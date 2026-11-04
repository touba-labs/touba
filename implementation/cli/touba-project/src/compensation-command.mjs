import { lstatSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { loadAirFromJson, loadSecretsFromJson } from "../../../runtime/touba-runtime/src/index.mjs";
import { createCompensation, resumeCompensation } from "../../../runtime/touba-runtime/src/compensation.mjs";
import { createSqliteCompensationStore } from "../../../runtime/touba-runtime/src/sqlite-compensation-store.mjs";
import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { secretValuesForRedaction } from "../../../runtime/touba-runtime/src/secret-redaction.mjs";
import { createHostModuleLoader } from "../../touba-run/src/host-modules.mjs";
import { openCliEffectJournal, effectJournalPathDiagnostic } from "../../touba-run/src/effect-journal.mjs";
import { verifyManifestPackages } from "./handler-packages.mjs";
import { loadResourceBindingFiles } from "../../../contracts/resource-binding-files.mjs";

const usage = "Usage: touba compensation create|resume --air <air.json> --manifest <manifest.json> --effect-journal <journal.effect-journal.sqlite> --store <compensations.sqlite> --authority-host <host.mjs|host.py> --request-json <command> [--secrets <profile.json>] [--resource-bindings <resources.json>] [--trace-store <traces.sqlite>] [--run-limits-json <limits>] [--authority-timeout-ms <1..5000>]";
const fail = code => { throw Object.assign(new Error(code), { code }); };
const json = text => {
  if (Buffer.byteLength(text) > 2 * 1024 * 1024) fail("CompensationRequestInvalid");
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) fail("CompensationRequestInvalid");
  return value;
};
const regular = path => {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) fail("CompensationStorageInvalid");
};

export async function compensationCommand(args) {
  if (!args.length || ["--help", "-h"].includes(args[0])) return { text: usage, exitCode: 0 };
  const [operation, ...flags] = args;
  const required = ["air", "manifest", "effect-journal", "store", "authority-host", "request-json"];
  const allowed = new Set([...required, "secrets", "resource-bindings", "trace-store", "run-limits-json", "authority-timeout-ms"]);
  const options = Object.create(null);
  const modules = createHostModuleLoader();
  let lease, store, traceStorage, journalOpenError;
  try {
    if (!["create", "resume"].includes(operation)) fail("CompensationRequestInvalid");
    for (let index = 0; index < flags.length; index += 2) {
      const key = flags[index].replace(/^--/, ""), value = flags[index + 1];
      if (!flags[index].startsWith("--") || !allowed.has(key) || Object.hasOwn(options, key)
        || typeof value !== "string" || !value || value.includes("\0")) fail("CompensationRequestInvalid");
      options[key] = value;
    }
    if (required.some(key => !options[key]) || effectJournalPathDiagnostic(options["effect-journal"])
      || !options.store.endsWith(".sqlite")) fail("CompensationRequestInvalid");
    const request = json(options["request-json"]);
    const airDocument = loadAirFromJson(readFileSync(resolve(options.air), "utf8"));
    const manifestPath = resolve(options.manifest);
    const manifest = json(readFileSync(manifestPath, "utf8"));
    verifyManifestPackages(manifestPath, manifest);
    for (const binding of Object.values(manifest.bindings ?? {})) {
      if (binding?.handler) binding.handler.cwd = resolve(dirname(manifestPath), binding.handler.cwd ?? ".");
    }
    const secretStore = options.secrets ? loadSecretsFromJson(readFileSync(resolve(options.secrets), "utf8"), { baseDir: dirname(resolve(options.secrets)) }) : undefined;
    const secretValues = secretValuesForRedaction(secretStore);
    const resources = options["resource-bindings"] ? loadResourceBindingFiles([{ path: options["resource-bindings"] }], process.cwd()) : undefined;
    const authority = await modules.compensationHost(options["authority-host"]);
    const journalPath = resolve(options["effect-journal"]), storePath = resolve(options.store);
    if (journalPath === storePath || options["trace-store"] && [journalPath, storePath].includes(resolve(options["trace-store"]))) fail("CompensationStorageInvalid");
    // Delayed open: neither journal existence nor record contents are inspected before lookup authorization.
    const journal = () => {
      if (!lease) {
        try { regular(journalPath); lease = openCliEffectJournal(journalPath, secretValues); }
        catch (error) { journalOpenError = error; throw error; }
      }
      return lease.journal;
    };
    const records = () => {
      journal(); // One lease covers both stores and every dispatch, including create replay.
      if (!store) {
        if (operation === "resume") regular(storePath);
        store = createSqliteCompensationStore(storePath, { secretValues });
      }
      if (options["trace-store"] && !traceStorage) {
        traceStorage = createSqliteTraceStore({ filename: resolve(options["trace-store"]) });
        runtimeOptions.traceStorage = traceStorage;
      }
      return store;
    };
    const runtimeOptions = { ...(options["run-limits-json"] ? { runLimits: json(options["run-limits-json"]) } : {}) };
    const result = await (operation === "create" ? createCompensation : resumeCompensation)(request, {
      airDocument, toolBindingManifest: manifest, secretStore, resourceBindings: resources, runtimeOptions,
      compensationAuthorityProvider: authority,
      compensationAuthorityTimeoutMs: options["authority-timeout-ms"] === undefined ? 1000 : Number(options["authority-timeout-ms"]),
      effectJournal: { schemaVersion: "touba-effect-journal-v1",
        readEntry: id => journal().readEntry(id), writeEntry: entry => journal().writeEntry(entry),
        entriesForScope: scope => journal().entriesForScope(scope) },
      compensationStore: { schemaVersion: "touba-compensation-store-v1",
        read: id => records().read(id), createIfAbsent: record => records().createIfAbsent(record),
        compareAndSwap: (...values) => records().compareAndSwap(...values) },
    });
    return { text: JSON.stringify({ schema_version: "touba-compensation-result-v1", record: result.record }), exitCode: 0 };
  } catch (error) {
    // The store adapter deliberately masks arbitrary read failures. Preserve only
    // our own bounded journal-open diagnostic (e.g. a concurrent CLI lease).
    const failure = journalOpenError ?? error;
    const code = /^(Compensation|EffectJournal|Invalid|ToolBinding|ResourceBinding)[A-Za-z]+$/.test(failure.code ?? "") ? failure.code : "CompensationCommandFailed";
    return { text: JSON.stringify({ schema_version: "touba-compensation-error-v1", code }), exitCode: 1 };
  } finally { traceStorage?.close(); lease?.close(); modules.close(); }
}
