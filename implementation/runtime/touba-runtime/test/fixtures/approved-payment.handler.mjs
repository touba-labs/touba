import { DatabaseSync } from "node:sqlite";
import { defineTool, createToolResult, ToubaHandlerError } from "../../../touba-handler-sdk/src/index.mjs";

// Synthetic service: the trusted order and its unique key belong to storage.
// The runtime's effect identity protects a run; invoice_id protects the business
// operation across distinct runs. Both checks and the write share a transaction.
await defineTool({
  toolRef: "tool:operation_approval/Pay",
  run: ({ context }) => {
    const db = new DatabaseSync(process.argv[2], { timeout: 5000 });
    try {
      db.exec("BEGIN IMMEDIATE");
      const proposed = context.arguments.payment ?? { invoice_id: "INV-001", vendor: "vendor:trusted", amount: context.arguments.amount };
      const order = db.prepare("SELECT * FROM orders WHERE invoice_id = ?").get(proposed.invoice_id);
      if (!order || proposed.amount !== order.amount || proposed.vendor !== order.vendor) throw new ToubaHandlerError("BusinessContractMismatch", "Payment differs from the trusted order");
      if (db.prepare("SELECT 1 FROM payments WHERE invoice_id = ?").get(order.invoice_id)) {
        throw new ToubaHandlerError("DuplicateBusinessOperation", "Invoice already paid");
      }
      db.prepare("INSERT INTO payments VALUES (?, ?, ?, ?)").run(order.invoice_id, order.amount,
        context.request.call_id, JSON.stringify(context.executionContext));
      db.exec("COMMIT");
      return createToolResult(order.amount, { effectReceipt: context.createEffectReceipt({ outcome: "applied" }) });
    } catch (error) {
      if (db.isTransaction) db.exec("ROLLBACK");
      if (error instanceof ToubaHandlerError) error.details = { effect_receipt: context.createEffectReceipt({ outcome: "not_applied" }) };
      throw error;
    } finally { db.close(); }
  },
});
