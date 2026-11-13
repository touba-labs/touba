import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, renameSync, symlinkSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { archiveProjectState, restoreProjectState, acquireStateLease } from "../src/state-maintenance.mjs";
import { checkToubaProjectState } from "../src/serve.mjs";
import { createInteractionSession, enqueueInteractionOperation } from "../src/interactions.mjs";
import { withNativeTrace, readNativeTraceExport } from "../src/native-traces.mjs";

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "touba-state-archive-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".touba"));
  const session = createInteractionSession({ sessionsPath: join(root, ".touba/interaction-sessions.sqlite"),
    request: { target_ref: "strategy:demo/Run", target_kind: "strategy", presentation: "conversation", effect_policy: "runtime_only", requested_by: { kind: "studio", id: "isolated-test" } } });
  writeFileSync(join(root, ".touba/current-run-summary.json"), "{}\n");
  writeFileSync(join(root, "touba.secrets.dev.json"), "do not archive");
  return { projectRoot: root, session };
}

test("state archive previews, preserves bytes, restores and leaves project configuration alone", async t => {
  const options = fixture(t), root = join(options.projectRoot, ".touba");
  const trace = JSON.parse(readFileSync(new URL("../../../tests/traces/tb-v01-003-branch.trace.json", import.meta.url)));
  await withNativeTrace({ projectRoot: options.projectRoot, runId: trace.run.run_id, phase: "initial" }, async () => ({ status: "success", trace }));
  const evidence = readNativeTraceExport(options.projectRoot, trace.run.run_id);
  const original = readFileSync(join(root, "interaction-sessions.sqlite"));
  const preview = archiveProjectState(options, checkToubaProjectState);
  assert.equal(preview.status, "preview");
  assert.ok(existsSync(join(root, "interaction-sessions.sqlite")));
  const archive = archiveProjectState({ ...options, applyState: true }, checkToubaProjectState);
  assert.equal(archive.status, "archived");
  assert.equal(existsSync(join(root, "interaction-sessions.sqlite")), false);
  assert.equal(existsSync(join(root, "native-traces.sqlite")), false);
  assert.equal(existsSync(join(root, "traces.sqlite")), false);
  assert.equal(readFileSync(join(options.projectRoot, "touba.secrets.dev.json"), "utf8"), "do not archive");
  const restore = { ...options, restoreState: archive.archive_id };
  assert.equal(restoreProjectState(restore).status, "restore_preview");
  assert.equal(restoreProjectState({ ...restore, applyState: true }).status, "restored");
  assert.deepEqual(readFileSync(join(root, "interaction-sessions.sqlite")), original);
  assert.deepEqual(readNativeTraceExport(options.projectRoot, trace.run.run_id), evidence);
  assert.equal(checkToubaProjectState(options).status, "structurally_valid");
});

test("state maintenance refuses a live owner, pending operations, custom paths and symlinks", t => {
  const options = fixture(t), root = join(options.projectRoot, ".touba");
  const release = acquireStateLease(options.projectRoot);
  assert.throws(() => archiveProjectState(options, checkToubaProjectState), { code: "ToubaStateInUse" });
  release();
  assert.throws(() => archiveProjectState({ ...options, humanDecisionsPath: "/elsewhere" }, checkToubaProjectState), { code: "ToubaStateCustomPathsUnsupported" });
  symlinkSync(join(options.projectRoot, "touba.secrets.dev.json"), join(root, "cost-observatory.json"));
  assert.throws(() => archiveProjectState(options, checkToubaProjectState), { code: "ToubaStatePathInvalid" });
  rmSync(join(root, "cost-observatory.json"));
  symlinkSync(join(options.projectRoot, 'missing.json'), join(root, 'cost-observatory.json'));
  assert.throws(() => archiveProjectState(options, checkToubaProjectState), { code: 'ToubaStatePathInvalid' });
  rmSync(join(root, 'cost-observatory.json'));
  enqueueInteractionOperation({ sessionsPath: join(root, "interaction-sessions.sqlite"), sessionId: options.session.session_id,
    runId: "run-active", message: { message_id: "active", display_text: "hello", attachments: [], requested_by: { kind: "studio", id: "isolated-test" } } });
  assert.throws(() => archiveProjectState({ ...options, applyState: true }, checkToubaProjectState), { code: "ToubaStateNotQuiescent" });
});

test("interrupted archival is recoverable and corruption or overwrite is refused", t => {
  const options = fixture(t), root = join(options.projectRoot, ".touba");
  const archive = archiveProjectState({ ...options, applyState: true }, checkToubaProjectState);
  const source = join(root, "state-archives", archive.archive_id);
  const restore = { ...options, restoreState: archive.archive_id, applyState: true };
  writeFileSync(join(root, "state-archive.pending.json"), JSON.stringify({ archive_id: archive.archive_id }));
  renameSync(join(source, "current-run-summary.json"), join(root, "current-run-summary.json"));
  assert.throws(() => acquireStateLease(options.projectRoot), { code: "ToubaStateArchiveInterrupted" });
  assert.equal(restoreProjectState(restore).status, "restored");
  const again = archiveProjectState({ ...options, applyState: true }, checkToubaProjectState);
  const restoreAgain = { ...options, restoreState: again.archive_id, applyState: true };
  writeFileSync(join(root, "project-events.jsonl"), "new state\n");
  assert.throws(() => restoreProjectState(restoreAgain), { code: "ToubaStateRestoreConflict" });
  rmSync(join(root, "project-events.jsonl"));
  writeFileSync(join(root, "state-archives", again.archive_id, "current-run-summary.json"), "corrupt\n");
  assert.throws(() => restoreProjectState(restoreAgain), { code: "ToubaStateArchiveIntegrityMismatch" });
  assert.throws(() => restoreProjectState({ ...options, restoreState: "../outside" }), { code: "ToubaStateArchiveIdInvalid" });
});

test("archival never discards queued trigger deliveries", t => {
  const options = fixture(t), file = join(options.projectRoot, ".touba/trigger-status.json");
  const check = () => ({ diagnostics: [], stores: [] });
  for (const field of ["pending", "processing", "dead_letter"]) {
    writeFileSync(file, JSON.stringify({ triggers: [{ queue: { pending: 0, processing: 0, dead_letter: 0, [field]: 1 } }] }));
    assert.throws(() => archiveProjectState(options, check), { code: "ToubaStateNotQuiescent" });
  }
  writeFileSync(file, JSON.stringify({ triggers: [{ queue: { pending: 0, processing: 0, dead_letter: 0 } }] }));
  assert.equal(archiveProjectState(options, check).status, "preview");
});
