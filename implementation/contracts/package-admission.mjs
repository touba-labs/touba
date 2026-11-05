// Host-side admission capability, never a provider/handler JSON field.
// Only trusted host admission code should issue these tokens.
import { createHash } from "node:crypto";
const records = new WeakMap();
export function issuePackageAdmission(metadata) {
  const serialized = JSON.stringify(metadata);
  if (Buffer.byteLength(serialized) > 1024 * 1024) throw new Error("PackageAdmissionTooLarge");
  const value = JSON.parse(serialized);
  value.admission_id = `sha256:${createHash("sha256").update(serialized).digest("hex")}`;
  const token = Object.freeze({});
  records.set(token, value);
  return token;
}
export function packageAdmissionEvidence(token) {
  if (token === undefined) return null;
  const value = records.get(token);
  if (!value) throw Object.assign(new Error("package admission must come from trusted host verification"), { code: "PackageAdmissionInvalid" });
  return structuredClone(value);
}
export function withSupplyChainAdmission(token, supplyChain) {
  const previous = packageAdmissionEvidence(token) ?? { authority: "supply_chain_admission", packages: [] };
  delete previous.admission_id;
  return issuePackageAdmission({ ...previous, supply_chain: supplyChain });
}
