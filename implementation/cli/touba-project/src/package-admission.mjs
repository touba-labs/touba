import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { packageDigest, packageError } from "./package-contract.mjs";
import { PACKAGE_LOCK, verifyInstalledPackages } from "./package-store.mjs";
import { normalizeConsumerPolicies, normalizePackageContracts } from "./package-governance.mjs";
import { combineToolApprovalPolicies } from "../../../contracts/tool-approval-policy.mjs";
import { issuePackageAdmission } from "../../../contracts/package-admission.mjs";
import { isDeepStrictEqual } from "node:util";

// Called before dispatch by CLI and both SDK transports. Files remain owned by
// the host. This verifies a prepared snapshot, not a hostile host filesystem.
export function admitPreparedPackages(planPath, plan, airPath, manifestPath) {
  if (plan.project === undefined) return undefined; // standalone AIR/legacy plan
  if (typeof plan.project !== "string" || !plan.project.trim()) throw packageError("PackageGovernanceInvalid", "invalid project path in run plan");
  const configPath = resolve(dirname(planPath), plan.project), root = dirname(configPath);
  const config = JSON.parse(readFileSync(configPath, "utf8"));
  const lock = verifyInstalledPackages(root, config.packages ?? []);
  const policies = normalizeConsumerPolicies(config.configuration?.tool_policies);
  const contracts = normalizePackageContracts(config.configuration?.package_contracts);
  if (typeof plan.profile !== "string" || !/^[a-z][a-z0-9_-]*$/.test(plan.profile)) {
    throw packageError("PackageGovernanceInvalid", "invalid prepared profile");
  }
  const effectivePath = join(root, ".touba/build", plan.profile, "touba.effective-project.json");
  const effective = JSON.parse(readFileSync(effectivePath, "utf8"));
  const files = [["project", configPath], ["run_plan", planPath], ["air", airPath]];
  if (manifestPath) files.push(["manifest", manifestPath]);
  const lockPath = join(root, PACKAGE_LOCK);
  if (existsSync(lockPath)) files.push(["package_lock", lockPath]);
  const digests = {};
  for (const [kind, path] of files) {
    const digest = packageDigest(readFileSync(path));
    if (!effective.inputs?.some(input => input.kind === kind && resolve(root, input.path) === resolve(path) && input.digest_sha256 === digest)) {
      throw packageError("PackagePreparationStale", "prepared project changed; run touba prepare --mode write");
    }
    digests[kind] = digest;
  }
  const air = JSON.parse(readFileSync(airPath, "utf8"));
  const manifest = manifestPath ? JSON.parse(readFileSync(manifestPath, "utf8")) : {};
  for (const tool of air.definitions?.tools ?? []) {
    const floor = policies[tool.id];
    if (floor == null) continue;
    const actual = manifest.bindings?.[tool.id]?.approval_policy;
    if (actual === undefined || !isDeepStrictEqual(actual, combineToolApprovalPolicies(actual, floor))) {
      throw packageError("PackageGovernanceStale", "prepared manifest does not enforce the consumer approval policy");
    }
  }
  return issuePackageAdmission({ authority: "project_admission", project_digest: digests.project,
    supply_chain: { state: "absent", required: false },
    package_lock_digest: digests.package_lock ?? null, run_plan_digest: digests.run_plan,
    manifest_digest: digests.manifest ?? null,
    packages: lock.packages.map(pkg => ({ name: pkg.name, version: pkg.version, digest: pkg.digest,
      verification: "installed_integrity", tools: Object.keys(contracts[pkg.name]?.tools ?? {}).sort() })),
    policy_digest: packageDigest(Buffer.from(JSON.stringify(policies))),
    editable_packages: (config.packages ?? []).filter(pkg => pkg.editable === true).length });
}
