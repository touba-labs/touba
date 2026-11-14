import test from "node:test";
import assert from "node:assert/strict";
import { proposePackageGovernance, normalizePackageContracts, normalizeConsumerPolicies } from "../src/package-governance.mjs";
import { combineToolApprovalPolicies } from "../../../contracts/tool-approval-policy.mjs";
import { performance } from "node:perf_hooks";

const ref = "tool:example.export/Publish";
const policy = { role: "reviewer", timeout_ms: 60000, distinct_from: "initiator" };
const make = (approval = policy, hash = "a") => ({ mode: "write", packages: [{ name: "example.export", version: "1.0.0", digest: `sha256:${hash.repeat(64)}` }],
  entries: [{ packageName: "example.export", document: { definitions: { tools: [{ id: ref,
    ...(approval === null ? {} : { approval_policy: approval }), signature: {}, required_capabilities: ["filesystem_write"] }] } } }] });

test("consumer approval survives a reviewed removal, empty packages and reinstallation", () => {
  const initial = proposePackageGovernance(make());
  assert.deepEqual(initial.policies[ref], policy);
  const removal = proposePackageGovernance({ ...make(null, "b"), configuration: initial.configuration });
  assert.equal(removal.diagnostics[0].code, "PackageGovernanceReviewRequired");
  const reviewed = proposePackageGovernance({ ...make(null, "b"), configuration: initial.configuration,
    decisions: { review_packages: { "example.export": `sha256:${"b".repeat(64)}` } } });
  assert.equal(reviewed.diagnostics.length, 0);
  assert.deepEqual(reviewed.policies[ref], policy);
  const removed = proposePackageGovernance({ configuration: reviewed.configuration, mode: "write" });
  const reinstalled = proposePackageGovernance({ ...make(null, "b"), configuration: removed.configuration });
  assert.deepEqual(reinstalled.policies[ref], policy);
});

test('effect recommendations require review when removed and never become consumer grants or policies', () => {
  const source = make();
  source.packages[0].handlers = [{ tool: ref, effect_contract: { kind: 'external_write', retry_mode: 'idempotency_key' } }];
  const initial = proposePackageGovernance(source);
  assert.equal(initial.configuration.package_contracts['example.export'].tools[ref].recommended_effect.kind, 'external_write');
  assert.deepEqual(initial.policies[ref], policy);
  const removed = proposePackageGovernance({ ...make(null, 'b'), configuration: initial.configuration });
  assert.equal(removed.diagnostics[0].code, 'PackageGovernanceReviewRequired');
  assert.deepEqual(removed.policies[ref], policy);
  assert.equal(Object.hasOwn(removed.configuration, 'bindings'), false);
  const invalid = structuredClone(initial.configuration.package_contracts);
  invalid['example.export'].tools[ref].recommended_effect = { kind: 'none', retry_mode: 'none' };
  assert.throws(() => normalizePackageContracts(invalid), { code: 'EffectRetryModeForbidden' });
});

test("a first migration preserves the existing AIR policy and exposes an intervening downgrade", () => {
  const proposal = proposePackageGovernance({ ...make(null), previous: make().entries.map(e => e.document) });
  assert.equal(proposal.diagnostics[0].code, "PackageGovernanceReviewRequired");
  assert.deepEqual(proposal.policies[ref], policy);
});

test("review is bound to the exact digest and does not implicitly change the consumer floor", () => {
  const initial = proposePackageGovernance(make());
  assert.throws(() => proposePackageGovernance({ ...make(null, "b"), configuration: initial.configuration,
    decisions: { review_packages: { "example.export": `sha256:${"a".repeat(64)}` } } }), { code: "PackageGovernanceStale" });
  const explicit = proposePackageGovernance({ ...make(), configuration: initial.configuration, decisions: { tool_policies: { [ref]: null } } });
  assert.equal(explicit.policies[ref], null);
  assert.equal(explicit.changes[0].kind, "configure_consumer_approval");
});

test("policy composition has one effective obligation and never ranks roles", () => {
  assert.deepEqual(combineToolApprovalPolicies(policy, { role: "reviewer", timeout_ms: 1000, distinct_from: "previous" }),
    { role: "reviewer", timeout_ms: 1000, distinct_from: "initiator_and_previous" });
  assert.throws(() => combineToolApprovalPolicies(policy, { role: "admin" }), { code: "ToolApprovalPolicyConflict" });
  assert.deepEqual(combineToolApprovalPolicies(undefined, {}), {});
  assert.throws(() => normalizeConsumerPolicies({ [ref]: false }), { code: "ToolApprovalPolicyInvalid" });
  assert.throws(() => normalizePackageContracts({ "example.export": { version: "1", digest: "bad", tools: {} } }), { code: "PackageGovernanceInvalid" });
});

test("contract change review covers required capabilities, secrets, memory and signatures", () => {
  const initial = proposePackageGovernance(make());
  for (const [key, value] of Object.entries({ required_capabilities: ["network"], required_secrets: ["API_KEY"],
    memory_accesses: [{ memory_ref: "memory:example.export/Archive", access: "write" }], signature: { output_type: "builtin:Int" } })) {
    const next = make(); next.entries[0].document.definitions.tools[0][key] = value;
    const result = proposePackageGovernance({ ...next, configuration: initial.configuration });
    assert.equal(result.diagnostics[0].code, "PackageGovernanceReviewRequired", key);
  }
});

test("transitive imported declarations retain their owning package and consumer floor", () => {
  const child = make(), parent = { name: "example.parent", version: "1.0.0", digest: `sha256:${"b".repeat(64)}` };
  child.entries[0].document.module = { name: "example.export" };
  const inherited = structuredClone(child.entries[0].document.definitions.tools);
  const result = proposePackageGovernance({ ...child, packages: [...child.packages, parent],
    entries: [...child.entries, { packageName: parent.name, document: { module: { name: parent.name }, definitions: { tools: inherited } } }] });
  assert.ok(result.configuration.package_contracts["example.export"].tools[ref]);
  assert.deepEqual(result.configuration.package_contracts["example.parent"].tools, {});
  assert.deepEqual(result.policies[ref], policy);
});

test("large governance inventory stays bounded and repeat preparation is stable", t => {
  const packages = [], entries = [];
  for (let i = 0; i < 100; i++) {
    const name = `example.p${i}`;
    packages.push({ name, version: "1.0.0", digest: `sha256:${"a".repeat(64)}` });
    entries.push({ packageName: name, document: { module: { name }, definitions: { tools:
      Array.from({ length: 16 }, (_, j) => ({ id: `tool:${name}/Export${j}`, approval_policy: policy, signature: {} })) } } });
  }
  const start = performance.now();
  const first = proposePackageGovernance({ packages, entries, mode: "write" });
  const adopted = performance.now();
  const repeated = proposePackageGovernance({ packages, entries, configuration: first.configuration, mode: "check" });
  assert.equal(repeated.changed, false); assert.deepEqual(repeated.diagnostics, []);
  assert.equal(Object.keys(first.policies).length, 1600);
  t.diagnostic(JSON.stringify({ packages: 100, tools: 1600, first_ms: +(adopted-start).toFixed(2),
    check_ms: +(performance.now()-adopted).toFixed(2), configuration_bytes: Buffer.byteLength(JSON.stringify(first.configuration)),
    process_max_rss_kib: process.resourceUsage().maxRSS }));
});
