import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defineTool, createToolResult, ToubaHandlerError } from "@touba/sdk";
await defineTool({ toolRef: "tool:examples.incident_remediation/RecordRemediation",
  inputSignature: [{ name: "plan", type_ref: "type:examples.incident_remediation/RemediationPlan" }],
  outputType: "type:examples.incident_remediation/ExecutionReceipt",
  requiredGrants: ["filesystem_write", "memory_write", "secret_read"], requiredSecretHandles: ["REMEDIATION_TOKEN"],
  run: async ({ request: plan, context }) => {
    if (!context.effect) throw new ToubaHandlerError("EffectContextRequired", "A ledger write requires an effect context.");
    let attempted = false;
    try {
      const memory = context.resourceBindings.find(item => item.resource_ref === "memory:examples.incident_remediation/RemediationLedger");
      if (!memory || memory.provider !== "host.local.remediation_ledger" || !context.env.REMEDIATION_TOKEN)
        throw new Error("Ledger configuration or credential unavailable");
      const result = { ...plan, receipt: randomUUID() };
      const file = await open(memory.config.path, "a", 0o600);
      try { attempted = true; await file.writeFile(JSON.stringify(result) + "\n"); await file.sync(); }
      finally { await file.close(); }
      return createToolResult(result, { effectReceipt: context.createEffectReceipt({ outcome: "applied" }) });
    } catch {
      throw new ToubaHandlerError("LedgerWriteUnconfirmed", "The ledger write did not return a confirmed result.", {
        effect_receipt: context.createEffectReceipt({ outcome: attempted ? "unknown" : "not_applied" }),
      });
    }
  },
});
