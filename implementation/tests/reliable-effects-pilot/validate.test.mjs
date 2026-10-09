import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createCompensation } from "../../runtime/touba-runtime/src/compensation.mjs";
import { createFileCompensationStore } from "../../runtime/touba-runtime/src/file-compensation-store.mjs";
import { createFileEffectJournal } from "../../runtime/touba-runtime/src/file-effect-journal.mjs";
import { executeAirDocument, loadSecretsFromJson } from "../../runtime/touba-runtime/src/index.mjs";
import { startLocalReservationService } from "./local-reservation-service.mjs";

const fixtureRoot = path.dirname(fileURLToPath(import.meta.url));
const implementationRoot = path.resolve(fixtureRoot, "../..");
const repositoryRoot = path.resolve(implementationRoot, "../..");
const packageSource = path.join(repositoryRoot, "touba-library/integration-packs/local-reservation-pilot");
const createEntry = "strategy:touba.integrations.local_reservation_pilot/CreateReservationFlow";
const reconcileEntry = "strategy:touba.integrations.local_reservation_pilot/ReconcileReservationFlow";
const token = "local-reservation-test-token";

test("runs the persistent HTTP package through lost receipt, replay, reconcile, and compensation", async () => {
  const workspace = mkdtempSync(path.join(tmpdir(), "touba-reliable-effects-pilot-"));
  const materializedPackage = path.join(workspace, "package");
  const statePath = path.join(workspace, "service-state.json");
  const journalPath = path.join(workspace, "effect-journal.json");
  const compensationPath = path.join(workspace, "compensations.json");
  let service;
  try {
    verifyPackageDigests();
    cpSync(packageSource, materializedPackage, { recursive: true });
    cpSync(
      path.join(implementationRoot, "runtime/touba-handler-sdk"),
      path.join(materializedPackage, "node_modules/@touba/sdk"),
      { recursive: true },
    );
    const air = compile(path.join(materializedPackage, "src/local-reservation-pilot.tb"));
    const manifest = JSON.parse(readFileSync(path.join(materializedPackage, "touba.manifest.json"), "utf8"));
    for (const binding of Object.values(manifest.bindings)) {
      binding.handler.command = process.execPath;
      binding.handler.cwd = materializedPackage;
    }
    const journal = createFileEffectJournal(journalPath, { secretValues: [token] });

    service = await startLocalReservationService({ statePath, token, dropFirstCreateResponse: true });
    let secrets = secretStore(service.url);
    const common = {
      entryRef: createEntry,
      inputs: { reservation_id: "reservation-17" },
      effectScopeId: "operation:reservation-pilot-1",
      effectJournal: journal,
      toolBindingManifest: manifest,
      secretStore: secrets,
    };
    const interrupted = await executeAirDocument(air, { ...common, runId: "run:create-lost-receipt" });
    assert.equal(interrupted.status, "failure");
    if (!existsSync(statePath)) throw new Error(`service was not mutated observations=${JSON.stringify(service.observations)}\n${JSON.stringify(interrupted.trace, null, 2)}`);
    let [original] = journal.entriesForScope(common.effectScopeId);
    assert.equal(original.state, "unknown");
    assert.equal(JSON.parse(readFileSync(statePath, "utf8")).reservations["reservation-17"].status, "active");

    await service.close();
    service = await startLocalReservationService({ statePath, token });
    secrets = secretStore(service.url);
    const retried = await executeAirDocument(air, {
      ...common,
      runId: "run:create-retry",
      secretStore: secrets,
    });
    assert.equal(retried.status, "success");
    [original] = journal.entriesForScope(common.effectScopeId);
    assert.equal(original.state, "applied");
    assert.equal(original.attempt_count, 2);

    const replay = await request(service.url, "/reservations", {
      reservation_id: "reservation-17",
      idempotency_key: original.effect_id,
    });
    assert.equal(replay.status, 200);
    assert.equal(replay.body.replayed, true);
    const conflict = await request(service.url, "/reservations", {
      reservation_id: "reservation-divergent",
      idempotency_key: original.effect_id,
    });
    assert.equal(conflict.status, 409);
    const reconciled = await executeAirDocument(air, {
      entryRef: reconcileEntry,
      inputs: { effect_id: original.effect_id },
      runId: "run:reconcile-create",
      toolBindingManifest: manifest,
      secretStore: secrets,
    });
    assert.equal(reconciled.status, "success");
    assert.equal(reconciled.result, "applied");

    const compensated = await createCompensation({
      compensation_request_id: "request:reservation-pilot-1",
      compensates_effect_id: original.effect_id,
      requester_ref: "principal:pilot-test",
      journal_scope_ref: "effect-journal:reservation-pilot",
    }, {
      airDocument: air,
      toolBindingManifest: manifest,
      effectJournal: journal,
      compensationStore: createFileCompensationStore(compensationPath, { secretValues: [token] }),
      compensationAuthorityProvider: { check: () => true },
      secretStore: secrets,
      compensationAuthorityTimeoutMs: 250,
    });
    assert.equal(compensated.record.result, "completed");
    const state = JSON.parse(readFileSync(statePath, "utf8"));
    assert.equal(state.reservations["reservation-17"].status, "released");
    assert.equal(Object.keys(state.operations).length, 2);

    const evidence = [
      readFileSync(statePath, "utf8"),
      readFileSync(journalPath, "utf8"),
      readFileSync(compensationPath, "utf8"),
      JSON.stringify(interrupted.trace),
      JSON.stringify(retried.trace),
      JSON.stringify(reconciled.trace),
      JSON.stringify(compensated.trace),
    ].join("\n");
    assert.equal(evidence.includes(token), false);
    assert.equal(evidence.includes(service.url), false);
  } finally {
    if (service) await service.close().catch(() => {});
    rmSync(workspace, { recursive: true, force: true });
  }
});

function verifyPackageDigests() {
  const metadata = JSON.parse(readFileSync(path.join(packageSource, "touba.package.json"), "utf8"));
  assert.equal(metadata.version, "0.1.0");
  for (const file of metadata.files) {
    const digest = `sha256:${createHash("sha256")
      .update(readFileSync(path.join(packageSource, file.path)))
      .digest("hex")}`;
    assert.equal(digest, file.digest, `digest drift for ${file.path}`);
  }
}

function compile(sourcePath) {
  const result = spawnSync(
    process.env.CARGO ?? "cargo",
    ["run", "-p", "touba-cli", "--bin", "touba-compile", "--quiet", "--", sourcePath],
    { cwd: implementationRoot, encoding: "utf8" },
  );
  if (result.status !== 0) throw new Error(`compile failed\n${result.stderr}`);
  return JSON.parse(result.stdout);
}

function secretStore(url) {
  return loadSecretsFromJson(JSON.stringify({
    secrets_version: "touba-secrets-v1",
    secrets: {
      LOCAL_RESERVATION_TOKEN: { source: "env", name: "LOCAL_RESERVATION_TOKEN" },
      LOCAL_RESERVATION_URL: { source: "env", name: "LOCAL_RESERVATION_URL" },
    },
  }), { env: { LOCAL_RESERVATION_TOKEN: token, LOCAL_RESERVATION_URL: url } });
}

async function request(baseUrl, pathname, body) {
  const response = await fetch(`${baseUrl}${pathname}`, {
    method: body ? "POST" : "GET",
    headers: {
      authorization: `Bearer ${token}`,
      ...(body ? { "content-type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: response.status, body: await response.json() };
}
