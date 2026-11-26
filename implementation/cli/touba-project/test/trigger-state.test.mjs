import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const cli = fileURLToPath(new URL("../src/main.mjs", import.meta.url));

test("queue CLI preserves migrated pending work and exposes bounded pages", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-queue-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "queue.json"), destination = join(root, "queue.sqlite");
  writeFileSync(source, JSON.stringify({ trigger_queue_schema_version: "touba-trigger-queue-v1", entries: [
    { queue_id: "queue:1", event_id: "event-1", trigger_ref: "trigger:example/Receive", source_kind: "request", status: "queued", received_at: "2026-01-01T00:00:00.000Z" },
  ] }));
  const run = (...args) => spawnSync(process.execPath, [cli, "trigger", ...args], { encoding: "utf8" });
  let result = run("migrate-queue", source, "--out", destination, "--apply");
  assert.equal(result.status, 0, result.stderr);
  result = run("queue", destination, "--limit", "1");
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).entries[0].status, "queued");
  result = run("archive-queue", destination, "--before", "2027-01-01T00:00:00Z");
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).entry_count, 0);
});

test("CLI migrates only on apply, pages state, archives refusals and rejects ambiguous flags", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-trigger-cli-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "legacy.json"), destination = join(root, "state.sqlite"), archive = join(root, "archive.sqlite");
  writeFileSync(source, JSON.stringify({ trigger_state_schema_version: "touba-trigger-state-v1", triggers: {
    "trigger:example/Receive": { events: ["accepted", "refused"].map((status, i) => ({ event_id: `event-${i}`, run_id: `run-${i}`,
      status, source_kind: "request", observed_at: "2026-01-01T00:00:00.000Z", reason: status === "refused" ? "event_replay" : undefined })) },
  } }));
  const run = (...args) => spawnSync(process.execPath, [cli, "trigger", ...args], { encoding: "utf8" });
  let result = run("migrate-state", source, "--out", destination);
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).applied, false);
  assert.equal(existsSync(destination), false);
  result = run("migrate-state", source, "--out", destination, "--apply");
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(readFileSync(source), readFileSync(JSON.parse(result.stdout).backup));
  result = run("state", destination, "--limit", "1", "--trigger", "trigger:example/Receive");
  assert.equal(result.status, 0, result.stderr);
  const page = JSON.parse(result.stdout); assert.equal(page.items.length, 1); assert.equal(page.summary.refused_count, 1);
  result = run("state", destination, "--after", String(page.next));
  assert.equal(JSON.parse(result.stdout).items[0].event_id, "event-1");
  result = run("archive-state", destination, "--before", "2027-01-01T00:00:00Z", "--out", archive, "--apply");
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).event_count, 1);
  assert.equal(JSON.parse(run("state", archive).stdout).items[0].status, "refused");
  assert.equal(JSON.parse(run("state", destination).stdout).items[0].status, "accepted"); // Migrated outcome remains uncertain.
  assert.notEqual(run("state", destination, "--limit", "1001").status, 0);
  assert.notEqual(run("migrate-state", source, "--out", destination, "--apply").status, 0);
  assert.notEqual(run("state", destination, "--limit", "1", "--limit", "2").status, 0);
});
