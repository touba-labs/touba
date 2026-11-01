import asyncio
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
import re
import subprocess
from pathlib import Path
import sys
import tempfile
import threading
import unittest

from touba_sdk import (ToubaEngine, ToubaEngineError, ToubaAgentDecisionProviderError,
                       create_ai_sdk_decision_provider, create_memory_decision_history_store,
                       create_open_ai_decision_provider, create_ollama_decision_provider, create_provider_token_cost_adapter)
from touba_sdk.history.sqlite import create_sqlite_decision_history_store
from touba_sdk.budget.sqlite import create_sqlite_provider_budget

SOURCE = '''module python.providers
agent Worker
    gives Text
    responsibility "Return the requested completion."
    callable_by strategy Run
strategy Run
    gives Text
    uses Worker
    do
        Worker
            into result
        give result
'''


def request(invocation="one"):
    return {"protocol": "touba-agent-decision-v1", "mode": "summary", "run_id": "test-run", "invocation_id": invocation,
            "agent_ref": "agent:python.providers/Worker", "capability_refs": [], "step_index": 0,
            "agent_signature": {"output_type": "builtin:Text"}, "model_input": {"protocol": "touba-agent-model-input-v1",
                "agent": {"responsibility": "Return the supplied result."}, "user_input": {"value": "done"},
                "agent_state": {}, "decision_policy": {}, "output_contract": {}}}


def generated(_options):
    return {"finishReason": "stop", "object": {"decision": {"action": "answer_directly", "source": "python_test",
            "reason": "The requested result is available.", "result": "done"}}}


class ProviderTests(unittest.TestCase):
    def test_chat_http_both_interfaces_history_and_invalid_responses(self):
        received = []
        response_mode = ["valid"]
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append((self.path, body))
                native = any(tool.get("function", {}).get("name") == "touba_finish" for tool in body.get("tools", []))
                message = {"role": "assistant", "content": json.dumps(generated({})["object"])}
                if response_mode[0] == "history":
                    message["content"] = json.dumps({"decision": {"action": "request_capabilities", "reason": "Read available contracts."}})
                if native:
                    message.update(content=None, tool_calls=[{"id": "call_local", "type": "function", "function": {
                        "name": "touba_finish", "arguments": json.dumps({"reason": "Complete.", "result": "done"})}}])
                if response_mode[0] in ("truncated", "invalid"):
                    message = {"role": "assistant", "content": '{"decision":'}
                result = {"id": "chatcmpl_local", "object": "chat.completion", "created": 1, "model": "fixture-model",
                    "choices": [{"index": 0, "message": message, "finish_reason": "length" if response_mode[0] == "truncated" else "tool_calls" if native else "stop"}],
                    "usage": {"prompt_tokens": 2, "completion_tokens": 1, "total_tokens": 3}}
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps(result).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            for interface in ("structured", "native"):
                with self.subTest(interface=interface):
                    provider = create_ollama_decision_provider(model="fixture-model", transport="chat", decision_interface=interface,
                        base_url=f"http://127.0.0.1:{server.server_port}/v1", timeout_ms=5000)
                    try:
                        req = request(interface); req.update(mode="capabilities", capabilities=[])
                        self.assertEqual(asyncio.run(provider(req))["result"], "done")
                    finally:
                        provider.close()
            provider = create_ollama_decision_provider(model="fixture-model", transport="chat",
                base_url=f"http://127.0.0.1:{server.server_port}/v1", timeout_ms=5000)
            try:
                response_mode[0] = "history"
                req = request("chat-history")
                for step in range(2):
                    req["step_index"] = step
                    self.assertEqual(asyncio.run(provider(req))["action"], "request_capabilities")
                self.assertTrue(any(message["role"] == "assistant" for message in received[-1][1]["messages"]))
            finally:
                provider.close()
            for mode in ("truncated", "invalid"):
                response_mode[0] = mode
                before = len(received)
                provider = create_ollama_decision_provider(model="fixture-model", transport="chat", history=False,
                    base_url=f"http://127.0.0.1:{server.server_port}/v1", timeout_ms=5000)
                try:
                    with self.assertRaises(ToubaAgentDecisionProviderError):
                        asyncio.run(provider(request(mode)))
                    self.assertEqual(len(received), before + 1, "No hidden retry")
                finally:
                    provider.close()
            self.assertTrue(all(path == "/v1/chat/completions" for path, _ in received))
            self.assertTrue(all(body.get("max_tokens", body.get("max_completion_tokens")) == 4096 for _, body in received))
        finally:
            server.shutdown(); server.server_close(); thread.join(timeout=2)

    def test_bounded_diagnostics_survive_backend_and_host_runtime_bridges(self):
        def incomplete(options):
            return {"finishReason": "length", "object": {}}
        provider = create_ai_sdk_decision_provider(model="fixture", generate_object=incomplete,
            json_schema=lambda schema: schema, history=False)
        try:
            with self.assertRaises(ToubaAgentDecisionProviderError) as raised:
                asyncio.run(provider(request()))
            self.assertEqual(raised.exception.details, {"finish_reason": "length"})
        finally:
            provider.close()

        with tempfile.TemporaryDirectory(prefix="touba-py-diagnostic-") as folder:
            root = Path(folder)
            (root / "main.tb").write_text(SOURCE)
            (root / "provider.py").write_text('''from touba_sdk import ToubaAgentDecisionProviderError
def decide_agent_capability(request):
    raise ToubaAgentDecisionProviderError("ProviderContextCountUnavailable", "private message", {
        "http_status":404, "finish_reason":"length", "incomplete_reason":"max_output_tokens",
        "private":"must-not-cross-the-boundary"})
''')
            engine = ToubaEngine(project_root=root, command=os.environ["TOUBA_TEST_NODE"], command_args=[os.environ["TOUBA_TEST_CLI"]],
                                env={"TOUBA_HOST_PYTHON": sys.executable})
            with self.assertRaises(ToubaEngineError) as raised:
                engine.run(source="main.tb", entry_ref="strategy:python.providers/Run", agent_decision_provider="provider.py", timeout=20)
            events = raised.exception.details["trace"]["events"]
            failure = next(event["payload"] for event in events if event["kind"] == "failure_detected")
            self.assertEqual(failure["provider_http_status"], 404)
            self.assertEqual(failure["provider_finish_reason"], "length")
            self.assertEqual(failure["provider_incomplete_reason"], "max_output_tokens")
            self.assertNotIn("must-not-cross-the-boundary", json.dumps(raised.exception.details))

    def test_python_context_counting_and_generation_share_exact_budget(self):
        with tempfile.TemporaryDirectory(prefix="touba-py-counting-") as folder:
            budget = create_sqlite_provider_budget(filename=Path(folder) / "cost.sqlite", budget_id="counting", currency="USD", limit_micros=1000)
            calls, events = [], []
            async def transport(req):
                calls.append(req)
                self.assertEqual(budget.snapshot()["attempts"]["pending"], 1)
                if req["url"].endswith("/input_tokens"):
                    body = {"input_tokens": 2}
                else:
                    body = {"id": "resp_local", "created_at": 1, "model": "fixture-model", "status": "completed", "output": [
                        {"type": "message", "id": "msg_local", "role": "assistant", "status": "completed", "content": [
                            {"type": "output_text", "annotations": [], "text": json.dumps(generated({})["object"])}]}],
                        "usage": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3}}
                return {"status": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(body)}
            def quote(req):
                self.assertTrue(req["url"].endswith("/input_tokens"))
                return {"basis": "upper_bound", "max_cost_micros": 2, "currency": "USD", "tariff_id": "fixture-count", "tariff_date": "2026-10-19"}
            def usage(response, quoted):
                self.assertEqual(json.loads(response["body"])["input_tokens"], 2)
                self.assertEqual(quoted["max_cost_micros"], 2)
                return {"kind": "reported", "cost_micros": 1}
            adapter = create_provider_token_cost_adapter(protocol="openai-responses", model="fixture-model", budget=budget,
                tariff={"id": "fixture", "date": "2026-10-19", "currency": "USD", "rates": {"input": 1000000, "output": 1000000}},
                input_token_bound=lambda req: {"basis": "upper_bound", "tokens": 100}, counting={"quote": quote, "read_usage": usage})
            provider = create_open_ai_decision_provider(model="fixture-model", history=False, api_key_env_names=["TOUBA_OFFLINE_FIXTURE_KEY"],
                fetch=transport, count_fetch=transport, max_output_tokens=64, max_retries=0, token_cost=adapter,
                context={"context_window_tokens": 1000, "safety_margin_tokens": 0, "on_event": events.append})
            try:
                self.assertEqual(asyncio.run(provider(request()))["result"], "done")
                self.assertEqual(len(calls), 2)
                self.assertEqual(budget.snapshot()["committed_micros"], 4)
                self.assertTrue(events[-1]["fits"])
            finally:
                provider.close(); budget.close()

    def test_ollama_factory_uses_the_same_response_contract_and_native_completion(self):
        calls = []
        def transport(req):
            calls.append(req)
            body = json.loads(req["body"])
            self.assertEqual(body["model"], "offline-ollama-fixture")
            self.assertTrue(any(tool["name"] == "touba_finish" for tool in body["tools"]))
            response = {"id": "resp_local", "created_at": 1, "model": body["model"], "status": "completed", "output": [
                {"type": "function_call", "id": "fc_local", "call_id": "call_local", "name": "touba_finish", "status": "completed",
                 "arguments": json.dumps({"reason": "Complete.", "result": "done"})}]}
            return {"status": 200, "headers": {"content-type": "application/json"}, "body": json.dumps(response)}
        provider = create_ollama_decision_provider(model="offline-ollama-fixture", decision_interface="native", history=False,
            fetch=transport, max_retries=0, max_output_tokens=64, base_url="http://127.0.0.1:11434/v1")
        try:
            req = request(); req.update(mode="capabilities", capabilities=[])
            self.assertEqual(asyncio.run(provider(req))["result"], "done")
            self.assertEqual(len(calls), 1)
        finally:
            provider.close()

    def test_native_history_preserves_repeated_calls_ids_and_signed_metadata(self):
        seen = []
        target = "tool:python.providers/Write"
        def generation(options):
            seen.append(options)
            name = next(key for key in options["tools"] if key not in {"touba_finish", "touba_human_review"})
            call = {"toolCallId": f"original-{len(seen)}", "toolName": name, "input": {"text": "same"}}
            return {"finishReason": "tool-calls", "toolCalls": [call], "response": {"messages": [
                {"role": "assistant", "content": [{"type": "tool-call", **call,
                    "providerOptions": {"google": {"thoughtSignature": "original-signature"}}}]}]}}
        def summary(options):
            seen.append(options)
            return generated(options)
        provider = create_ai_sdk_decision_provider(model="offline-fixture", decision_interface="native",
            allow_human_review=False, generate_text=generation, generate_object=summary, json_schema=lambda schema: schema)
        self.addCleanup(provider.close)
        req = request("native-history")
        req.update(mode="capabilities", inputs={"text": "same"}, observations=[], content_mode="inline", capability_refs=[target],
                   capabilities=[{"target_ref": target, "name": "Write", "kind": "tool", "signature": {
                       "inputs": [{"name": "text", "type_ref": "builtin:Text"}], "output_type": "builtin:Text"}}])
        async def exercise():
            for step in range(2):
                result = await provider(req)
                self.assertEqual(result["target_ref"], target)
                req["observations"].append({"step_index": step, "action": "select_capability", "target_ref": target,
                    "arguments": {"text": "same"}, "value": f"receipt-{step}"})
                req["step_index"] += 1
            req["mode"] = "finalization"
            self.assertEqual((await provider(req))["result"], "done")
        asyncio.run(exercise())
        parts = [part for message in seen[-1]["messages"] if isinstance(message["content"], list) for part in message["content"]]
        calls = [part for part in parts if part["type"] == "tool-call"]
        self.assertEqual([part["toolCallId"] for part in calls], ["original-1", "original-2"])
        self.assertEqual([part["output"]["value"] for part in parts if part["type"] == "tool-result"], ["receipt-0", "receipt-1"])
        self.assertTrue(all(part["providerOptions"]["google"]["thoughtSignature"] == "original-signature" for part in calls))

    def test_python_callbacks_compact_context_without_erasing_sqlite_history(self):
        with tempfile.TemporaryDirectory(prefix="touba-py-compaction-") as folder:
            filename = Path(folder) / "history.sqlite"
            events, seen = [], []
            async def generate(options):
                seen.append(options)
                return {"finishReason": "stop", "object": {"decision": {"action": "request_capabilities", "result": ""}}}
            req = request("compaction")
            for start in (0, 4):
                store = create_sqlite_decision_history_store(filename=filename)
                provider = create_ai_sdk_decision_provider(model="offline-fixture", generate_object=generate,
                    json_schema=lambda schema: schema, history={"store": store, "namespace": "test", "max_messages": 5, "on_event": events.append})
                try:
                    async def exercise():
                        for step in range(start, start + 4):
                            req["step_index"] = step
                            await provider(req)
                    asyncio.run(exercise())
                    saved = store.read(events[-1]["sessionKey"])
                    self.assertEqual(len(saved["turns"]), start + 4)
                    self.assertGreater(saved["contextStart"], 0)
                finally:
                    provider.close(); store.close()
            self.assertTrue(all(len(call["messages"]) <= 5 for call in seen))
            self.assertTrue(any(event.get("droppedTurns", 0) > 0 for event in events))

    def test_concurrent_python_decisions_keep_history_sessions_separate(self):
        async def exercise():
            entered, release = asyncio.Event(), asyncio.Event()
            count = 0
            async def generate(options):
                nonlocal count
                count += 1
                entered.set()
                await release.wait()
                return generated(options)
            provider = create_ai_sdk_decision_provider(model="offline-fixture", generate_object=generate, json_schema=lambda schema: schema)
            try:
                first = asyncio.create_task(provider(request("parallel-one")))
                await entered.wait()
                with self.assertRaises(ToubaAgentDecisionProviderError) as raised:
                    await provider(request("parallel-one"))
                self.assertEqual(raised.exception.code, "DecisionHistoryBusy")
                second = asyncio.create_task(provider(request("parallel-two")))
                release.set()
                results = await asyncio.gather(first, second)
                self.assertEqual([value["result"] for value in results], ["done", "done"])
                self.assertEqual(count, 2)
            finally:
                provider.close()
        asyncio.run(exercise())

    def test_published_provider_tutorial_runs_with_installed_wheel(self):
        tutorial = Path(__file__).resolve().parents[4] / "docs/tutoriels/sdk-engine-provider-python.md"
        text = tutorial.read_text()
        with tempfile.TemporaryDirectory(prefix="touba-py-provider-tutorial-") as folder:
            root = Path(folder)
            for language, name, body in re.findall(r'```(touba|python) title="([^"]+)"\n(.*?)\n```', text, re.S):
                (root / name).write_text(body)
            engine = ToubaEngine(project_root=root, command=os.environ["TOUBA_TEST_NODE"], command_args=[os.environ["TOUBA_TEST_CLI"]],
                                env={"TOUBA_HOST_PYTHON": sys.executable})
            result = engine.run(source="program.tb", entry_ref="strategy:sdk.provider/Run", agent_decision_provider="provider.py", timeout=20)
            self.assertEqual(result.result, "Ready")
            self.assertTrue((root / ".touba/private/history.sqlite").is_file())

    def test_generic_provider_preserves_runtime_contract_and_context(self):
        calls = []
        async def generate(options):
            calls.append(options)
            self.assertIsInstance(options["schema"]["properties"], dict)
            return generated(options)
        provider = create_ai_sdk_decision_provider(model="offline-fixture", generate_object=generate,
            history=False)
        self.addCleanup(provider.close)
        result = asyncio.run(provider(request()))
        self.assertEqual(result["result"], "done")
        self.assertEqual(len(calls), 1)
        self.assertNotIn("recordProviderCost", json.dumps(calls))

    def test_memory_and_sqlite_stores_share_records_and_refuse_closed_invocation(self):
        with tempfile.TemporaryDirectory(prefix="touba-py-history-") as folder:
            for store in [create_memory_decision_history_store(), create_sqlite_decision_history_store(filename=Path(folder) / "history.sqlite")]:
                try:
                    async def save():
                        return await store.transact("fixture", lambda old: {"record": {"old": old, "value": 1}, "result": "stored"})
                    self.assertEqual(asyncio.run(save()), "stored")
                    self.assertEqual(store.read("fixture")["value"], 1)
                    provider = create_ai_sdk_decision_provider(model="offline-fixture", generate_object=generated,
                        json_schema=lambda schema: schema, history={"store": store, "namespace": "tenant-test"})
                    try:
                        self.assertEqual(asyncio.run(provider(request()))["result"], "done")
                        with self.assertRaises(ToubaAgentDecisionProviderError) as raised:
                            asyncio.run(provider(request()))
                        self.assertEqual(raised.exception.code, "DecisionHistoryClosed")
                    finally:
                        provider.close()
                finally:
                    store.close()

    def test_python_host_runs_through_real_cli_and_refuses_unknown_capability(self):
        with tempfile.TemporaryDirectory(prefix="touba-py-host-") as folder:
            root = Path(folder)
            (root / "main.tb").write_text(SOURCE)
            (root / "provider.py").write_text('''from touba_sdk import create_ai_sdk_decision_provider
def generate(options):
    return {"finishReason":"stop", "object":{"decision":{"action":"answer_directly", "source":"python_test", "reason":"Complete.", "result":"done"}}}
decide_agent_capability = create_ai_sdk_decision_provider(model="fixture", generate_object=generate, json_schema=lambda schema: schema)
''')
            engine = ToubaEngine(project_root=root, command=os.environ["TOUBA_TEST_NODE"], command_args=[os.environ["TOUBA_TEST_CLI"]],
                                env={"TOUBA_HOST_PYTHON": sys.executable})
            result = engine.run(source="main.tb", entry_ref="strategy:python.providers/Run", agent_decision_provider="provider.py", timeout=20)
            self.assertEqual(result.result, "done")
            (root / "provider.py").write_text('''def decide(request):
    return {"action":"select_capability", "target_ref":"tool:python.providers/Undeclared", "source":"python_test", "reason":"Try an unavailable tool.", "arguments":{}}
''')
            with self.assertRaises(ToubaEngineError) as raised:
                engine.run(source="main.tb", entry_ref="strategy:python.providers/Run", agent_decision_provider="provider.py", timeout=20,
                           agent_decision_provider_initial_mode="capabilities")
            self.assertIn("trace", raised.exception.details)
            self.assertNotEqual(raised.exception.code, "DecisionProviderInvalid")

    def test_host_errors_are_classified_without_private_content(self):
        for source, expected in [
            ('import missing_private_dependency\n', 'PythonHostImportFailed'),
            ('def decide_agent_capability(request):\n    raise ValueError("private-client@example.test")\n', 'PythonHostCallbackFailed'),
            ('import ssl\ndef decide_agent_capability(request):\n    raise ssl.SSLError("private-client@example.test")\n', 'PythonHostTlsFailed'),
            ('def decide_agent_capability(request):\n    raise ConnectionError("private-client@example.test")\n', 'PythonHostTransportFailed'),
            ('def decide_agent_capability(request):\n    raise TimeoutError("private-client@example.test")\n', 'PythonHostTimeout'),
        ]:
            with self.subTest(expected=expected), tempfile.TemporaryDirectory(prefix="touba-py-diagnostic-") as folder:
                root = Path(folder)
                (root / "main.tb").write_text(SOURCE)
                (root / "provider.py").write_text(source)
                diagnostic = root / "diagnostic.jsonl"
                env = {"TOUBA_HOST_PYTHON": sys.executable,
                       "TOUBA_PYTHON_HOST_DIAGNOSTICS": str(diagnostic)}
                engine = ToubaEngine(project_root=root, command=os.environ["TOUBA_TEST_NODE"],
                    command_args=[os.environ["TOUBA_TEST_CLI"]], env=env)
                with self.assertRaises(ToubaEngineError) as raised:
                    engine.run(source="main.tb", entry_ref="strategy:python.providers/Run", agent_decision_provider="provider.py", timeout=20)
                self.assertEqual(raised.exception.code, expected)
                self.assertNotIn("private-client@example.test", json.dumps(raised.exception.details))
                self.assertNotIn("missing_private_dependency", json.dumps(raised.exception.details))
                records = [json.loads(line) for line in diagnostic.read_text().splitlines()]
                self.assertTrue(records)
                self.assertTrue(all(set(row) <= {"kind", "error_class", "handler_arg_index", "line", "column"} for row in records))
                if os.name != "nt":
                    self.assertEqual(diagnostic.stat().st_mode & 0o777, 0o600)

    def test_http_provider_native_and_structured_share_the_exact_ledger(self):
        received = []
        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *args):
                pass
            def do_POST(self):
                body = json.loads(self.rfile.read(int(self.headers["Content-Length"])))
                received.append(body)
                native = any(tool.get("name") == "touba_finish" for tool in body.get("tools", []))
                output = [{"type": "function_call", "id": "fc_local", "call_id": "call_local", "name": "touba_finish",
                    "arguments": json.dumps({"reason": "Complete.", "result": "done"}), "status": "completed"}] if native else [
                    {"type": "message", "id": "msg_local", "role": "assistant", "status": "completed", "content": [
                    {"type": "output_text", "annotations": [], "text": json.dumps(generated({})["object"])}]}]
                result = {"id": "resp_local", "created_at": 1, "model": "fixture-model", "status": "completed", "output": output,
                          "usage": {"input_tokens": 2, "output_tokens": 1, "total_tokens": 3}}
                self.send_response(200); self.send_header("Content-Type", "application/json"); self.end_headers()
                self.wfile.write(json.dumps(result).encode())
        server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True); thread.start()
        try:
            with tempfile.TemporaryDirectory(prefix="touba-py-cost-") as folder:
                budget = create_sqlite_provider_budget(filename=Path(folder) / "cost.sqlite", budget_id="test", currency="USD", limit_micros=1000)
                try:
                    for mode in ["structured", "native"]:
                        adapter = create_provider_token_cost_adapter(protocol="openai-responses", model="fixture-model", budget=budget,
                            tariff={"id": "fixture", "date": "2026-10-19", "currency": "USD", "rates": {"input": 1000000, "output": 1000000}},
                            input_token_bound=lambda request: {"basis": "upper_bound", "tokens": 100})
                        provider = create_open_ai_decision_provider(model="fixture-model", api_key_env_names=["TOUBA_OFFLINE_FIXTURE_KEY"],
                            base_url=f"http://127.0.0.1:{server.server_port}/v1", decision_interface=mode,
                            max_output_tokens=64, max_retries=0, history=False, token_cost=adapter)
                        try:
                            req = request(mode); req["mode"] = "capabilities"; req["capabilities"] = []
                            self.assertEqual(asyncio.run(provider(req))["result"], "done")
                        finally:
                            provider.close()
                    self.assertEqual(budget.snapshot()["committed_micros"], 6)
                    self.assertEqual(len(received), 2)
                    # This time cross both stdio boundaries and the real Core.
                    # The pending accounting event must precede HTTP dispatch;
                    # final settlement must retain the same invocation identity.
                    root = Path(folder)
                    (root / "main.tb").write_text(SOURCE)
                    (root / "provider.py").write_text(f'''from touba_sdk import create_open_ai_decision_provider, create_provider_token_cost_adapter
from touba_sdk.budget.sqlite import create_sqlite_provider_budget
budget = create_sqlite_provider_budget(filename={str(root / "cost.sqlite")!r}, budget_id="test", currency="USD", limit_micros=1000)
adapter = create_provider_token_cost_adapter(protocol="openai-responses", model="fixture-model", budget=budget,
    tariff={{"id":"fixture", "date":"2026-10-19", "currency":"USD", "rates":{{"input":1000000, "output":1000000}}}},
    input_token_bound=lambda request: {{"basis":"upper_bound", "tokens":100}})
provider = create_open_ai_decision_provider(model="fixture-model", api_key_env_names=["TOUBA_OFFLINE_FIXTURE_KEY"],
    base_url="http://127.0.0.1:{server.server_port}/v1", max_output_tokens=64, max_retries=0, history=False, token_cost=adapter)
async def decide_agent_capability(request):
    return await provider(request)
''')
                    engine = ToubaEngine(project_root=root, command=os.environ["TOUBA_TEST_NODE"], command_args=[os.environ["TOUBA_TEST_CLI"]],
                                        env={"TOUBA_HOST_PYTHON": sys.executable})
                    result = engine.run(source="main.tb", entry_ref="strategy:python.providers/Run", agent_decision_provider="provider.py", timeout=20)
                    events = [event for event in result.trace["events"] if event["kind"] == "provider_cost_recorded"]
                    self.assertEqual([event["payload"]["status"] for event in events], ["pending", "reported"])
                    self.assertEqual(events[-1]["payload"]["cost_micros"], "3")
                    self.assertEqual(budget.attempt(events[0]["payload"]["attempt_id"])["context"]["invocation_id"], events[0]["payload"]["invocation_id"])
                    self.assertEqual(budget.snapshot()["committed_micros"], 9)
                    self.assertEqual(len(received), 3)
                    # Tightening this same durable budget must refuse the next
                    # call, even across a fresh Python provider process.
                    narrowed = create_sqlite_provider_budget(filename=root / "cost.sqlite", budget_id="test", currency="USD", limit_micros=9)
                    narrowed.close()
                    with self.assertRaises(ToubaEngineError) as raised:
                        engine.run(source="main.tb", entry_ref="strategy:python.providers/Run", agent_decision_provider="provider.py", timeout=20)
                    trace = raised.exception.details["trace"]
                    failures = [event for event in trace["events"] if event["kind"] == "failure_detected"]
                    self.assertEqual(failures[-1]["payload"]["runtime_error_code"], "ProviderCostBudgetExceeded")
                    self.assertEqual(len(received), 3)
                finally:
                    budget.close()
        finally:
            server.shutdown(); server.server_close(); thread.join()
