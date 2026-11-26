import { writeFileSync } from "node:fs";
const manifest = { manifest_version: "touba-manifest-v1", bindings: {
  "tool:examples.incident_remediation/RecordRemediation": {
    handler: { kind: "process", command: process.execPath, args: ["handlers/ledger.mjs"], cwd: "." },
    grants: ["filesystem_write", "memory_write", "secret_read"], secrets: ["REMEDIATION_TOKEN"],
    memories: [{ ref: "memory:examples.incident_remediation/RemediationLedger", access: "write" }],
    effect_contract: { kind: "external_write", retry_mode: "none" }, timeout_ms: 10000, max_payload_bytes: 65536,
  },
}, agent_secret_scopes: { "agent:examples.incident_remediation/ExecutionAgent": ["REMEDIATION_TOKEN"] } };
writeFileSync("touba.manifest.json", JSON.stringify(manifest, null, 2));
const denied = structuredClone(manifest); denied.bindings["tool:examples.incident_remediation/RecordRemediation"].grants = ["memory_write", "secret_read"];
writeFileSync("denied.manifest.json", JSON.stringify(denied, null, 2));
