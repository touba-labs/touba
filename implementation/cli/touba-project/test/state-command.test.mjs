import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stateCommand } from "../src/state-command.mjs";

for (const [kind, schema, fields] of [
  ["effects", "touba-effect-journal-v1", { entries: {} }],
  ["compensations", "touba-compensation-store-v1", { records: {} }],
  ["checkpoints", "touba-sandbox-checkpoints-v1", { records: [] }],
  ["human-requests", "touba-human-requests-v1", { approvals: [], reviews: [] }],
  ["human-decisions", "touba-human-decisions-v1", { decisions: [] }],
  ["interaction-sessions", "touba-interaction-sessions-v1", { sessions: [] }],
  ["interaction-assets", "touba-interaction-assets-v1", { assets: [] }],
]) test(`state migration ${kind}: preview, backup, no replacement and strict validation`, async t => {
  const directory = mkdtempSync(join(tmpdir(), "touba-state-cli-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const source = join(directory, "source.json"), destination = join(directory, "state.sqlite");
  const document = { schema_version: schema, ...fields };
  const bytes = JSON.stringify(document);
  writeFileSync(source, bytes);
  let result = await stateCommand(["migrate", kind, source, "--out", destination]);
  assert.equal(JSON.parse(result.text).applied, false); assert.equal(existsSync(destination), false);
  result = await stateCommand(["migrate", kind, source, "--out", destination, "--apply"]);
  assert.equal(JSON.parse(result.text).applied, true);
  assert.equal(readFileSync(source, "utf8"), bytes);
  assert.equal(readFileSync(JSON.parse(result.text).backup, "utf8"), bytes);
  await assert.rejects(stateCommand(["migrate", kind, source, "--out", destination, "--apply"]));
  writeFileSync(source, JSON.stringify({ ...document, authority: "invented" }));
  await assert.rejects(stateCommand(["migrate", kind, source, "--out", join(directory, "invalid.sqlite")]));
  if (Array.isArray(Object.values(fields)[0])) {
    writeFileSync(source, JSON.stringify({ ...document, [Object.keys(fields)[0]]: [{}] }));
    await assert.rejects(stateCommand(["migrate", kind, source, "--out", join(directory, "invalid.sqlite")]));
  }
  assert.equal(existsSync(join(directory, "invalid.sqlite")), false);
});

test("state command refuses duplicate options and unsupported kinds without running host code", async () => {
  await assert.rejects(stateCommand(["migrate", "effects", "source.json", "--out", "x.sqlite", "--out", "y.sqlite"]));
  await assert.rejects(stateCommand(["migrate", "unknown", "source.json", "--out", "x.sqlite"]));
  await assert.rejects(stateCommand(["list", "unknown", "state.sqlite"]));
});
