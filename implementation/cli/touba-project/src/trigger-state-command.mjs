import { createSqliteTriggerStore, migrateTriggerState } from "../../../runtime/touba-runtime/src/sqlite-trigger-store.mjs";
import { createSqliteTriggerQueue, migrateTriggerQueue } from "../../touba-trigger-service/src/sqlite-queue.mjs";

export function triggerStateCommand(command, args) {
  const queue = command.endsWith("queue"), migrate = command.startsWith("migrate-"), archive = command.startsWith("archive-");
  const [filename, ...rest] = args;
  if (!filename || filename.startsWith("--")) throw new Error(`touba trigger ${command} requires a state path`);
  const options = {};
  for (let index = 0; index < rest.length; index++) {
    const key = rest[index];
    const allowed = migrate ? ["--out", "--apply"]
      : archive ? ["--out", "--before", "--apply"] : queue ? ["--after", "--limit"] : ["--after", "--limit", "--trigger"];
    if (!allowed.includes(key) || Object.hasOwn(options, key)) throw new Error(`unexpected option ${key}`);
    if (key === "--apply") { options[key] = true; continue; }
    const value = rest[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    options[key] = value;
  }
  if (migrate) {
    if (!options["--out"]) throw new Error(`${command} requires --out <new.sqlite>`);
    return { text: JSON.stringify((queue ? migrateTriggerQueue : migrateTriggerState)({ source: filename, destination: options["--out"], apply: options["--apply"] === true }), null, 2), exitCode: 0 };
  }
  const store = (queue ? createSqliteTriggerQueue : createSqliteTriggerStore)({ filename, readOnly: !archive || !options["--apply"] });
  try {
    if (archive) return { text: JSON.stringify(store.archive({ before: options["--before"],
      destination: options["--out"], apply: options["--apply"] === true }), null, 2), exitCode: 0 };
    const triggerRef = options["--trigger"];
    const result = store.page({ triggerRef, after: queue ? options["--after"] ?? "" : options["--after"] === undefined ? 0 : Number(options["--after"]),
      limit: options["--limit"] === undefined ? 100 : Number(options["--limit"]) });
    return { text: JSON.stringify({ ...result, ...(triggerRef ? { summary: store.summary(triggerRef) } : {}) }, null, 2), exitCode: 0 };
  } finally { store.close(); }
}
