import { writeFileSync } from "node:fs";
const manifest = { manifest_version: "touba-manifest-v1", bindings: {
  "tool:examples.scenario_external_approval/RecordPayment": {
    handler: { kind: "process", command: process.execPath, args: ["handlers/ledger.mjs"], cwd: "." },
    grants: ["filesystem_write", "secret_read"], secrets: ["LEDGER_TOKEN"],
    effect_contract: { kind: "external_write", retry_mode: "none" }, timeout_ms: 10000, max_payload_bytes: 65536,
  } },
};
writeFileSync("touba.manifest.json", JSON.stringify(manifest, null, 2) + "\n");
manifest.bindings["tool:examples.scenario_external_approval/RecordPayment"].grants = ["secret_read"];
writeFileSync("denied.manifest.json", JSON.stringify(manifest, null, 2) + "\n");
