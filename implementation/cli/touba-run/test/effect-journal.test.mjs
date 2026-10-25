import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { openCliEffectJournal } from "../src/effect-journal.mjs";

test("CLI journal lease excludes another writer through root aliases and releases explicitly", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-cli-effects-"));
  let host;
  try {
    const path = join(root, "run.effect-journal.sqlite");
    host = openCliEffectJournal(path);
    symlinkSync(root, join(root, "alias"), "dir");
    assert.throws(() => openCliEffectJournal(join(root, "alias", "run.effect-journal.sqlite")), { code: "EffectJournalBusy" });
    assert.equal(JSON.parse(readFileSync(path + ".lock", "utf8")).pid, process.pid);
    host.close(); host.close();
    assert.equal(existsSync(path + ".lock"), false);
    openCliEffectJournal(path).close();
  } finally { host?.close(); rmSync(root, { recursive: true, force: true }); }
});

test("CLI refuses linked or invalid journals without deleting a pre-existing lease", () => {
  const root = mkdtempSync(join(tmpdir(), "touba-cli-effects-refusal-"));
  try {
    const path = join(root, "run.effect-journal.sqlite");
    writeFileSync(join(root, "target.json"), "{}");
    symlinkSync(join(root, "target.json"), path);
    assert.throws(() => openCliEffectJournal(path), { code: "EffectJournalPathInvalid" });
    const invalid = join(root, "invalid.effect-journal.sqlite");
    writeFileSync(invalid, "{invalid}");
    assert.throws(() => openCliEffectJournal(invalid), { code: "EffectJournalInvalid" });
    assert.equal(existsSync(invalid + ".lock"), false);
    writeFileSync(invalid + ".lock", "owner evidence");
    assert.throws(() => openCliEffectJournal(invalid), { code: "EffectJournalBusy" });
    assert.equal(readFileSync(invalid + ".lock", "utf8"), "owner evidence");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
