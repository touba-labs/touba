"""Synthetic provider with durable atomic deduplication, not a provider certification."""
import asyncio
import json
from pathlib import Path
import sqlite3
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[4] / "touba-python-sdk" / "src"))
from touba_sdk import handle_tool_request, create_tool_result

database, mode = sys.argv[1:]


async def handler(context):
    effect = context["effect"]
    identity, digest, attempt = effect["effect_id"], effect["request_digest"], effect["attempt_index"]
    value = "created:" + context["arguments"]["query"]
    connection = sqlite3.connect(database, timeout=5)
    try:
        connection.execute("BEGIN IMMEDIATE")
        connection.execute("INSERT INTO calls VALUES (?, ?, ?)", (identity, digest, attempt))
        existing = connection.execute("SELECT digest FROM effects WHERE id = ?", (identity,)).fetchone()
        if existing and existing[0] != digest:
            raise ValueError("Provider request conflict")
        connection.execute("INSERT OR IGNORE INTO effects VALUES (?, ?, ?)", (identity, digest, value))
        connection.commit()
    finally:
        connection.close()
    if attempt == 1:
        if mode == "missing":
            return value
        if mode == "throw":
            raise ValueError("Synthetic failure after committed write")
        if mode == "timeout":
            await asyncio.Event().wait()
    receipt = context["create_effect_receipt"]({"outcome": "applied", "receipt_ref": "synthetic:created"})
    if attempt == 1 and mode == "invalid":
        receipt["request_digest"] = "sha256:" + "f" * 64
    return create_tool_result(value, effect_receipt=receipt)


print(json.dumps(asyncio.run(handle_tool_request(sys.stdin.read(), "tool:test/Create", handler))))
