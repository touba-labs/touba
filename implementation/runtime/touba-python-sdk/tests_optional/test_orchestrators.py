"""Optional real-framework integration; no model, credentials or network calls."""
import os
from pathlib import Path
import shutil
import tempfile
from typing import TypedDict
import unittest

from langchain_core.tools import tool
from langgraph.graph import StateGraph, START, END
from touba_sdk import Engine, EngineError


class State(TypedDict, total=False):
    value: str
    status: str
    reason: str
    result: str


class OrchestrationTests(unittest.TestCase):
    def test_framework_node_and_tool_preserve_governed_outcomes(self):
        with tempfile.TemporaryDirectory(prefix="touba-python-framework-") as directory:
            root = Path(directory)
            implementation = Path(__file__).resolve().parents[3]
            cli = os.environ.get("TOUBA_TEST_CLI", str(implementation / "cli/touba-project/src/main.mjs"))
            engine = Engine(root, command=os.environ.get("TOUBA_TEST_NODE", shutil.which("node")), command_args=[cli])
            (root / "program.tb").write_text('''module integration
strategy Review
    takes value as Text
    gives Text
    do
        human.approve
            with context as value
            into approval
        give value
''')

            @tool
            def review_invoice(value: str) -> dict:
                """Submit an invoice for governed review; a pause is not an approval."""
                run = engine.run(source="program.tb", inputs={"value": value})
                return {"status": run.status, "reason": run.reason, "result": run.result}

            def review_node(state: State) -> dict:
                return review_invoice.invoke({"value": state["value"]})

            builder = StateGraph(State)
            builder.add_node("review", review_node)
            builder.add_edge(START, "review")
            builder.add_edge("review", END)
            graph = builder.compile()
            for result in (graph.invoke({"value": "invoice"}), review_invoice.invoke({"value": "invoice"})):
                self.assertEqual(result["status"], "stopped")
                self.assertEqual(result["reason"], "human_approval_pending")
                self.assertIsNone(result["result"])
            # A framework invocation cannot bypass the Core input contract.
            with self.assertRaises(EngineError):
                engine.run(source="program.tb", inputs={"value": 42})


if __name__ == "__main__":
    unittest.main()
