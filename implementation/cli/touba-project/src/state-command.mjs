import { migrateEffectJournal, createSqliteEffectJournal } from "../../../runtime/touba-runtime/src/sqlite-effect-journal.mjs";
import { migrateCompensationStore, createSqliteCompensationStore } from "../../../runtime/touba-runtime/src/sqlite-compensation-store.mjs";

const usage = [
  "Usage: touba state migrate <kind> <source.json> --out <new.sqlite> [--apply]",
  "       touba state adopt --project <directory> --reason <text> [--accept <review-digest>] [--max-backup-bytes <bytes>]",
  "       touba state adopt --project <directory> --recover",
  "       touba state list effects|compensations <path.sqlite> [--after <cursor>] [--limit <1..1000>]",
  "Kinds: effects, compensations, checkpoints, human-requests, human-decisions, changes, interaction-sessions, interaction-assets",
  "Migration previews validation; --apply creates a new database and an exact source backup.",
  "Stop state writers before migration. Sources and existing destinations are never overwritten.",
  "For server state, migrate related collections together, then run touba serve --check-state.",
].join("\n");

export async function stateCommand(args) {
  if (!args.length || ["--help", "-h"].includes(args[0])) return { text: usage, exitCode: 0 };
  if (args[0] === 'adopt') {
    const fields = { '--project': 'projectRoot', '--reason': 'reason', '--accept': 'accept', '--max-backup-bytes': 'maxBackupBytes', '--recover': 'recover' }, options = {};
    for (let i = 1; i < args.length; i++) {
      const flag = args[i], key = fields[flag];
      if (flag === '--json' && args.indexOf(flag) === i) continue;
      if (!key || Object.hasOwn(options, key)) throw new Error(`unexpected option ${flag}`);
      if (key === 'recover') { options[key] = true; continue; }
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
      options[key] = key === 'maxBackupBytes' ? Number(value) : value;
    }
    if (options.recover && (options.reason !== undefined || options.accept !== undefined)) throw new Error('--recover cannot be combined with --reason or --accept');
    const { adoptProjectState, recoverStateAdoption } = await import('../../touba-project-server/src/state-adoption.mjs');
    const { checkToubaProjectState } = await import('../../touba-project-server/src/serve.mjs');
    const result = options.recover ? recoverStateAdoption(options) : adoptProjectState(options, checkToubaProjectState);
    return { text: JSON.stringify(result, null, 2), exitCode: 0 };
  }
  const [command, kind, source, ...flags] = args;
  if (!["migrate", "list"].includes(command) || !source || source.startsWith("--")) throw new Error(usage);
  const options = {};
  for (let index = 0; index < flags.length; index++) {
    const key = flags[index], allowed = command === "migrate" ? ["--out", "--apply"] : ["--after", "--limit"];
    if (!allowed.includes(key) || Object.hasOwn(options, key)) throw new Error(`unexpected option ${key}`);
    if (key === "--apply") { options[key] = true; continue; }
    const value = flags[++index];
    if (!value || value.startsWith("--")) throw new Error(`${key} requires a value`);
    options[key] = value;
  }
  let result;
  if (command === "list") {
    const factory = { effects: createSqliteEffectJournal, compensations: createSqliteCompensationStore }[kind];
    if (!factory) throw new Error("state list supports effects and compensations");
    result = factory(source, { readOnly: true }).page({ after: options["--after"], limit: options["--limit"] === undefined ? 100 : Number(options["--limit"]) });
  } else {
    if (!options["--out"]) throw new Error("state migrate requires --out <new.sqlite>");
    let migrate = { effects: migrateEffectJournal, compensations: migrateCompensationStore }[kind];
    if (kind === "checkpoints") migrate = (await import("../../touba-project-server/src/serve.mjs")).migrateSandboxCheckpoints;
    if (kind === "changes") migrate = (await import("../../touba-project-server/src/change-store.mjs")).migrateChangeProposals;
    if (["human-requests", "human-decisions"].includes(kind)) {
      const module = await import("../../touba-project-server/src/human-stores.mjs");
      migrate = kind === "human-requests" ? module.migrateHumanRequests : module.migrateHumanDecisions;
    }
    if (["interaction-sessions", "interaction-assets"].includes(kind)) {
      const module = await import("../../touba-project-server/src/interactions.mjs");
      migrate = kind === "interaction-sessions" ? module.migrateInteractionSessions : module.migrateInteractionAssets;
    }
    if (!migrate) throw new Error("unknown state migration kind");
    result = migrate({ source, destination: options["--out"], apply: options["--apply"] === true });
  }
  return { text: JSON.stringify(result, null, 2), exitCode: 0 };
}
