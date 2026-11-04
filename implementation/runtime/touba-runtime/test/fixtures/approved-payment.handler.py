import asyncio
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[3] / "touba-python-sdk" / "src"))
from touba_sdk import define_tool, create_tool_result, ToubaHandlerError


def run(request, context):
    db = sqlite3.connect(sys.argv[1], timeout=5)
    try:
        db.execute("BEGIN IMMEDIATE")
        proposed = context["arguments"].get("payment", {"invoice_id": "INV-001", "vendor": "vendor:trusted", "amount": context["arguments"].get("amount")})
        order = db.execute("SELECT invoice_id, amount, vendor FROM orders WHERE invoice_id = ?", (proposed["invoice_id"],)).fetchone()
        if not order or proposed["amount"] != order[1] or proposed["vendor"] != order[2]:
            raise ToubaHandlerError("BusinessContractMismatch", "Payment differs from the trusted order")
        invoice, amount, _ = order
        if db.execute("SELECT 1 FROM payments WHERE invoice_id = ?", (invoice,)).fetchone():
            raise ToubaHandlerError("DuplicateBusinessOperation", "Invoice already paid")
        db.execute("INSERT INTO payments VALUES (?, ?, ?, ?)",
                   (invoice, amount, context["request"]["call_id"], json.dumps(context["execution_context"])))
        db.commit()
        return create_tool_result(amount, effect_receipt=context["create_effect_receipt"]({"outcome": "applied"}))
    except Exception as error:
        db.rollback()
        if isinstance(error, ToubaHandlerError):
            error.details["effect_receipt"] = context["create_effect_receipt"]({"outcome": "not_applied"})
        raise
    finally:
        db.close()


asyncio.run(define_tool(tool_ref="tool:operation_approval/Pay", run=run))
