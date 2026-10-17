import test from "node:test";
import assert from "node:assert/strict";
import { readStoreFixture, writeStoreFixture } from "./store-fixtures.mjs";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { acceptDecision } from "../src/serve.mjs";

const contractsRoot = fileURLToPath(new URL("../../../contracts/product-surfaces", import.meta.url));
const fixture = name => JSON.parse(readFileSync(join(contractsRoot, "fixtures/valid", `${name}.json`), "utf8"));
const acceptedAt = "2026-06-22T14:00:00.000Z";

for (const [name, mutate, allowed] of [
  ["exact unexpired assignment without global role", () => {}, true],
  ["expired assignment", identity => { identity.assignments[0].expires_at = "2026-06-22T13:59:59.000Z"; }, false],
  ["assignment expires at acceptance", identity => { identity.assignments[0].expires_at = acceptedAt; }, false],
  ["future assignment", identity => { identity.assignments[0].assigned_at = "2026-06-22T14:00:01.000Z"; }, false],
  ["malformed assignment date", identity => { identity.assignments[0].expires_at = "invalid"; }, false],
  ["assignment from another run", identity => { identity.assignments[0].run_id = "run:other"; }, false],
  ["assignment from another trace", identity => { identity.assignments[0].trace_ref = "trace:other"; }, false],
  ["unpaired device", identity => { identity.devices[0].status = "revoked"; }, false],
  ["removed assignment and removed role", identity => { identity.assignments = []; }, false],
  ["explicit global role remains independent of an expired assignment", identity => {
    identity.assignments[0].expires_at = "2026-06-22T13:59:59.000Z";
    identity.users[0].role_refs = ["role:reviewer"];
  }, true],
]) test(`human authority: ${name}`, () => {
  const root = mkdtempSync(join(tmpdir(), "touba-assignment-"));
  try {
    const identity = fixture("touba-product-identity-v1");
    identity.users[0].role_refs = [];
    mutate(identity);
    const productIdentityPath = join(root, "identity.json");
    const humanRequestsPath = join(root, "requests.json");
    const humanDecisionsPath = join(root, "decisions.json");
    writeFileSync(productIdentityPath, JSON.stringify(identity));
    writeStoreFixture(humanRequestsPath, { schema_version: "touba-human-requests-v1",
      approvals: [fixture("touba-approval-request-v1")], reviews: [] });
    const invoke = () => acceptDecision({ contractsRoot, productIdentityPath, humanRequestsPath, humanDecisionsPath,
      decision: fixture("touba-approval-decision-v1"), acceptedAt, requireProjectAuthorization: true });
    if (allowed) assert.equal(invoke().status, "accepted");
    else {
      assert.throws(invoke, error => error.code === "ToubaServeDecisionIdentityUnauthorized");
      assert.equal(existsSync(humanDecisionsPath), false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});
