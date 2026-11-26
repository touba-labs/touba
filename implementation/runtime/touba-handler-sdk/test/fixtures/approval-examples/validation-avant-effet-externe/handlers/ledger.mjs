import { open } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { defineTool, createToolResult, ToubaHandlerError } from "@touba/sdk";
await defineTool({
  toolRef: "tool:examples.scenario_external_approval/RecordPayment",
  inputSignature: [{ name: "request", type_ref: "type:examples.scenario_external_approval/PaymentRequest" }],
  outputType: "type:examples.scenario_external_approval/PaymentResult",
  requiredGrants: ["filesystem_write", "secret_read"], requiredSecretHandles: ["LEDGER_TOKEN"],
  run: async ({ request, context }) => {
    if (!context.effect) throw new ToubaHandlerError("EffectContextRequired", "A ledger write requires an effect context.");
    let attempted = false;
    try {
      if (!context.env.LEDGER_TOKEN) throw new Error("Credential unavailable");
      if (request.amount_cents <= 0) throw new Error("Amount must be positive");
      const receipt = randomUUID();
      const file = await open("payment-ledger.ndjson", "a", 0o600);
      try {
        attempted = true;
        await file.writeFile(JSON.stringify({ ...request, receipt }) + "\n");
        await file.sync();
      } finally { await file.close(); }
      return createToolResult({ receipt }, { effectReceipt: context.createEffectReceipt({ outcome: "applied" }) });
    } catch {
      throw new ToubaHandlerError("LedgerWriteUnconfirmed", "The ledger write did not return a confirmed result.", {
        effect_receipt: context.createEffectReceipt({ outcome: attempted ? "unknown" : "not_applied" }),
      });
    }
  },
});
