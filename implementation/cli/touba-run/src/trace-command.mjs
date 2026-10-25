import { createSqliteTraceStore } from "../../../runtime/touba-runtime/src/sqlite-trace-store.mjs";
import { validateTraceReference } from "../../../contracts/trace-reference.mjs";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const USAGE = "touba trace read --store <path.sqlite> --reference-json <json> [--after <n>] [--limit <1..1000>]\ntouba trace archive --store <path.sqlite> [--destination <new.sqlite> --apply]\ntouba trace export --store <path.sqlite> --postgres-env <NAME> [--watch] [--batch-size <1..1000>] [--max-batches <n>] [--name <name>] [--schema <name>]";
export function traceCommand(args) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) return { text: USAGE, exitCode: 0 };
  if (args[0] === "archive") return archiveCommand(args.slice(1));
  if (args[0] === "export") return import("./trace-export-command.mjs").then(module => module.traceExportCommand(args.slice(1)));
  if (args[0] !== "read") throw new Error(USAGE);
  const options = {};
  for (let index = 1; index < args.length; index += 2) {
    const key = args[index], value = args[index + 1];
    if (!["--store", "--reference-json", "--after", "--limit"].includes(key) || Object.hasOwn(options, key)
      || typeof value !== "string" || !value || value.includes("\0") || value.startsWith("--")) throw new Error(USAGE);
    options[key] = value;
  }
  if (!options["--store"] || !options["--reference-json"] || Buffer.byteLength(options["--reference-json"]) > 32768) throw new Error(USAGE);
  const reference = validateTraceReference(JSON.parse(options["--reference-json"]));
  const page = {};
  for (const key of ["after", "limit"]) if (options[`--${key}`] !== undefined) {
    const raw = options[`--${key}`];
    if (!/^-?\d+$/u.test(raw) || !Number.isSafeInteger(Number(raw))) throw new Error(USAGE);
    page[key] = Number(raw);
  }
  const store = createSqliteTraceStore({ filename: options["--store"], readOnly: true });
  try { return { report: store.readReference(reference, page), json: true, exitCode: 0 }; }
  finally { store.close(); }
}

function archiveCommand(args) {
  const options = {};
  for (let i = 0; i < args.length; i++) {
    const key = args[i];
    if (!["--store", "--destination", "--apply"].includes(key) || key in options) throw new Error(USAGE);
    if (key === "--apply") { options[key] = true; continue; }
    const value = args[++i];
    if (!value || value.startsWith("--") || value.includes("\0")) throw new Error(USAGE);
    options[key] = value;
  }
  if (!options["--store"] || (options["--apply"] && !options["--destination"])) throw new Error(USAGE);
  const parent = dirname(resolve(options["--store"]));
  if (["native-traces.sqlite", "sandbox-checkpoints.sqlite", "server-state.lock"].some(name => existsSync(join(parent, name)))) {
    throw new Error("Use project state archival for a server journal: checkpoints and native exports must stay together");
  }
  if (!existsSync(options["--store"])) throw new Error("Trace journal does not exist");
  const store = createSqliteTraceStore({ filename: options["--store"] });
  try { return { report: store.archive({ destination: options["--destination"], apply: options["--apply"] ?? false }), json: true, exitCode: 0 }; }
  finally { store.close(); }
}
