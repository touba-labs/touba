import test from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { checkToubaProjectState } from "../src/serve.mjs";
import { createInteractionSession, storeInteractionAsset } from "../src/interactions.mjs";

test("offline preflight covers interactions without changing bytes or importing host code", t => {
  const root = mkdtempSync(join(tmpdir(), "touba-state-preflight-test-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, ".touba"));
  const sessionsPath = join(root, ".touba/interaction-sessions.sqlite");
  const assetsPath = join(root, ".touba/interaction-assets.sqlite");
  createInteractionSession({ sessionsPath, request: { target_ref: "agent:demo/Coordinator", target_kind: "agent",
    presentation: "conversation", effect_policy: "runtime_only", requested_by: { kind: "studio", id: "isolated-test" } } });
  storeInteractionAsset({ assetsPath, assetsDirectory: join(root, ".touba/interaction-assets"),
    buffer: Buffer.from("isolated state"), contentKind: "document", mediaType: "text/plain", name: "sample.txt" });
  const before = [sessionsPath, assetsPath].map(path => readFileSync(path));
  writeFileSync(join(root, "forbidden-host.mjs"), 'throw new Error("Host code must not load during preflight");');
  const raw = execFileSync(process.execPath, [new URL("../src/serve.mjs", import.meta.url).pathname,
    "--project-root", root, "--check-state", "--human-approval-host", join(root, "forbidden-host.mjs"),
    "--agent-decision-provider", join(root, "forbidden-host.mjs")], { encoding: "utf8" });
  const checked = JSON.parse(raw);
  assert.equal(checked.status, "structurally_valid");
  assert.equal(checked.origin.status, "unrecorded");
  for (const key of ["interactionSessionsPath", "interactionAssetsPath"]) {
    assert.equal(checked.stores.find(store => store.store === key).records, 1);
    assert.ok(checked.stores.find(store => store.store === key).schema_version);
  }
  assert.equal(checked.stores.length, 6);
  assert.equal(existsSync(join(root, ".touba/state-origin.json")), false);
  [sessionsPath, assetsPath].forEach((path, index) => assert.deepEqual(readFileSync(path), before[index]));
  writeFileSync(assetsPath + "-wal", "unqualified snapshot");
  assert.ok(checkToubaProjectState({ projectRoot: root }).diagnostics.some(d => d.code === "ToubaServeStateSnapshotRequired"));
  rmSync(assetsPath + "-wal");
  writeFileSync(assetsPath, "not SQLite");
  assert.ok(checkToubaProjectState({ projectRoot: root }).diagnostics.some(d => d.code === "ToubaStoreFormatIncompatible"));
});
