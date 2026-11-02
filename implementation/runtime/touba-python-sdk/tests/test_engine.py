import asyncio
import json
import hashlib
import os
from pathlib import Path
import shutil
import signal
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
import queue
import re
import urllib.request
import unittest
from contextlib import closing
from unittest.mock import patch

from touba_sdk import AsyncToubaEngine, ToubaEngine, ToubaEngineError, CompileResult, touba_sdk_metadata
from touba_sdk.engine import _result, _kill
from touba_sdk._trace_reference import validate_reference, validate_page

IMPLEMENTATION = Path(__file__).resolve().parents[3]
NODE = os.environ.get("TOUBA_TEST_NODE", shutil.which("node"))
CLI = Path(os.environ.get("TOUBA_TEST_CLI", IMPLEMENTATION / "cli/touba-project/src/main.mjs"))

SOURCE = '''module python.test
strategy Echo
    takes value as Text
    gives Text
    do
        give value
strategy Stop
    do
        stop
strategy Ask
    do
        ask
            with prompt as "Continue?"
            into answer
strategy Fail
    takes divisor as Int
    gives Int
    do
        give 1 // divisor
'''


class EngineTests(unittest.TestCase):
    def test_published_python_approval_tutorial(self):
        page = (IMPLEMENTATION.parent / "docs/tutoriels/approbations-roles-delais.md").read_text()
        for language, filename in [("touba", "approval.tb"), ("python", "host.py"), ("python", "exercise.py")]:
            match = re.search(r'```' + language + r' title="' + re.escape(filename) + r'"\n(.*?)```', page, re.S)
            self.assertIsNotNone(match, filename)
            content = match[1]
            if filename == "exercise.py":
                content = content.replace('ToubaEngine(project_root=".")',
                    f'ToubaEngine(project_root=".", command={NODE!r}, command_args={[str(CLI)]!r}, env={{"TOUBA_HOST_PYTHON": {sys.executable!r}}})')
            (self.root / filename).write_text(content)
        result = subprocess.run([sys.executable, "exercise.py"], cwd=self.root, capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("APPROVAL_ROLE_AND_RESUME_OK", result.stdout)

    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="touba-python-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.options = dict(project_root=self.root, command=NODE, command_args=[str(CLI)])
        self.engine = ToubaEngine(**self.options)
        (self.root / "source.tb").write_text(SOURCE)
        transports = []
        create_process = asyncio.create_subprocess_exec

        async def observe_process(*args, **kwargs):
            child = await create_process(*args, **kwargs)
            transports.append(child._transport)
            return child

        observer = patch("asyncio.create_subprocess_exec", observe_process)
        observer.start()
        self.addCleanup(observer.stop)
        self.addCleanup(lambda: self.assertTrue(all(transport.is_closing() for transport in transports),
                                               "SDK must close all owned subprocess transports before returning"))

    def test_sync_async_paged_traces_use_core_and_match_the_canonical_export(self):
        async def exercise():
            for engine in [self.engine, AsyncToubaEngine(**self.options)]:
                async def invoke(method, **kwargs):
                    if isinstance(engine, AsyncToubaEngine):
                        return await method(**kwargs)
                    return await asyncio.to_thread(method, **kwargs)
                result = await invoke(engine.run, source="source.tb", entry_ref="strategy:python.test/Echo",
                                      inputs={"value": "é🙂"}, trace_store="traces.sqlite", trace_mode="reference",
                                      trace_out="export.json")
                self.assertEqual(result.result, "é🙂")
                self.assertIsNone(result.trace)
                reference = result.trace_reference
                before = (self.root / "traces.sqlite").read_bytes()
                events, after = [], None
                while True:
                    page = await invoke(engine.read_trace, trace_store="traces.sqlite", reference=reference, after=after, limit=2)
                    events.extend(page["events"])
                    after = page["next"]
                    if page["done"]:
                        break
                document = json.loads((self.root / "export.json").read_text())
                self.assertEqual(dict(page["header"], events=events), document)
                raw = json.dumps(document, ensure_ascii=False, separators=(",", ":")).encode()
                self.assertEqual(reference["trace_digest"], "sha256:" + hashlib.sha256(raw).hexdigest())
                self.assertEqual((self.root / "traces.sqlite").read_bytes(), before)
                for options in [{"limit": True}, {"after": -2}, {"limit": 1001}]:
                    with self.assertRaises(ToubaEngineError):
                        await invoke(engine.read_trace, trace_store="traces.sqlite", reference=reference, **options)
                bad_reference = dict(reference, trace_digest="sha256:" + "0" * 64)
                with self.assertRaises(ToubaEngineError):
                    await invoke(engine.read_trace, trace_store="traces.sqlite", reference=bad_reference)
        asyncio.run(exercise())

    def test_reference_mode_keeps_controlled_outcomes_and_failure_evidence(self):
        options = dict(source="source.tb", trace_store="traces.sqlite", trace_mode="reference")
        for entry, flags, status in [("Stop", {}, "stopped"), ("Ask", {}, "stopped"),
                                      ("Ask", {"cancel_on_pause": True}, "cancelled")]:
            result = self.engine.run(**options, entry_ref=f"strategy:python.test/{entry}", **flags)
            self.assertEqual(result.status, status)
            page = self.engine.read_trace(trace_store="traces.sqlite", reference=result.trace_reference)
            self.assertEqual(page["events"][-1]["payload"]["status"], status)
        with self.assertRaises(ToubaEngineError) as raised:
            self.engine.run(**options, entry_ref="strategy:python.test/Fail", inputs={"divisor": 0})
        page = self.engine.read_trace(trace_store="traces.sqlite", reference=raised.exception.details["trace_reference"])
        self.assertEqual(page["events"][-1]["payload"]["status"], "failure")
        with self.assertRaises(ToubaEngineError):
            self.engine.run(source="source.tb", trace_mode="reference")
        with self.assertRaises(ToubaEngineError) as invalid_input:
            self.engine.run(**options, entry_ref="strategy:python.test/Echo", inputs={"unknown": "refuse"})
        self.assertEqual(invalid_input.exception.details["trace_reference"]["terminal"]["reason"], "EntryInputSchemaInvalid")
        air = self.engine.compile("source.tb").air_document
        air["air_schema_version"] = "unsupported"
        with self.assertRaises(ToubaEngineError) as admission:
            self.engine.run(air_json=air, trace_store="traces.sqlite", trace_mode="reference")
        self.assertNotIn("trace_reference", admission.exception.details)
        self.assertEqual(admission.exception.details["trace"]["run"]["admission"], "refused")

    def test_reference_and_page_protocol_rejects_malformed_data(self):
        result = self.engine.run(source="source.tb", entry_ref="strategy:python.test/Echo", inputs={"value": "ok"},
                                 trace_store="traces.sqlite", trace_mode="reference")
        reference = result.trace_reference
        for change in [{"start_index": True}, {"event_count": 1}, {"segment_id": "../db"},
                       {"extra": 1}, {"header_digest": "wrong"}, {"run_id": "other"}]:
            with self.assertRaises(ValueError):
                validate_reference(dict(reference, **change))
        page = self.engine.read_trace(trace_store="traces.sqlite", reference=reference, limit=1)
        for change in [{"next": True}, {"done": True}, {"events": []}, {"extra": 1}, {"header": {}}]:
            with self.assertRaises(ValueError):
                validate_page(dict(page, **change), reference, -1, 1)
        with self.assertRaises(ValueError):
            validate_page(dict(page, reference=dict(reference, start_index=False)), reference, -1, 1)
        bad = json.loads(json.dumps(page))
        bad["events"][0]["sequence_index"] = False
        with self.assertRaises(ValueError):
            validate_page(bad, reference, -1, 1)
        envelope = dict(schema_version="touba-run-reference-v1", status=result.status, reason=result.reason,
                        result=result.result, messages=result.messages, trace_reference=reference)
        with self.assertRaises(ToubaEngineError):
            _result(json.dumps(envelope).encode(), 0)
        self.assertEqual(_result(json.dumps(envelope).encode(), 0, "reference").result, "ok")
        envelope["reason"] = "forged"
        with self.assertRaises(ToubaEngineError):
            _result(json.dumps(envelope).encode(), 0, "reference")

    def test_sync_async_trace_storage_survives_the_engine_process(self):
        options = dict(source="source.tb", entry_ref="strategy:python.test/Echo",
                       inputs={"value": "durable"}, trace_store="traces.sqlite")
        first = self.engine.run(**options)
        async def run():
            return await AsyncToubaEngine(**self.options).run(**options)
        second = asyncio.run(run())
        with closing(sqlite3.connect(self.root / "traces.sqlite")) as connection:
            segments = connection.execute("SELECT id, closed FROM touba_trace_segments").fetchall()
            self.assertEqual(len(segments), 2)
            self.assertTrue(all(closed == 1 for _, closed in segments))
            for result in [first, second]:
                self.assertEqual(result.result, "durable")
                body = json.dumps(result.trace["events"][-1], separators=(",", ":"), ensure_ascii=False)
                self.assertEqual(connection.execute("SELECT count(*) FROM touba_trace_events WHERE body=?", (body,)).fetchone()[0], 1)

    def test_default_journal_belongs_to_project_even_for_temporary_air(self):
        air = self.engine.compile("source.tb").air_document
        async def exercise():
            for engine in [self.engine, AsyncToubaEngine(**self.options)]:
                async def invoke(method, **kwargs):
                    if isinstance(engine, AsyncToubaEngine):
                        return await method(**kwargs)
                    return await asyncio.to_thread(method, **kwargs)
                result = await invoke(engine.run, air_json=air, entry_ref="strategy:python.test/Echo",
                                      inputs={"value": "default journal"}, trace_mode="reference")
                self.assertEqual(result.result, "default journal")
                self.assertIsNone(result.trace)
                page = await invoke(engine.read_trace, trace_store=".touba/traces.sqlite",
                                    reference=result.trace_reference)
                self.assertTrue(page["done"])
                self.assertEqual(page["events"][-1]["payload"]["status"], "success")
        asyncio.run(exercise())
        with closing(sqlite3.connect(self.root / ".touba/traces.sqlite")) as connection:
            self.assertEqual(connection.execute("SELECT count(*) FROM touba_trace_segments WHERE closed=1").fetchone()[0], 2)

    def test_installed_identity_and_sync_async_typed_values(self):
        from touba_sdk._version import VERSION
        self.assertEqual(touba_sdk_metadata()["version"], VERSION)
        self.assertEqual(len(touba_sdk_metadata()["build_sha256"]), 64)
        self.assertEqual(self.engine.version()["schemas"]["air"], "touba-air-v1")
        air = self.engine.compile("source.tb").air_document
        self.assertEqual(self.engine.run(air_json=air, entry_ref="strategy:python.test/Echo", inputs={"value": "é🙂"}).result, "é🙂")
        async def parallel():
            engine = AsyncToubaEngine(**self.options)
            return await asyncio.gather(*(engine.run(air_json=air, entry_ref="strategy:python.test/Echo", inputs={"value": str(i)}) for i in range(8)))
        self.assertEqual([r.result for r in asyncio.run(parallel())], [str(i) for i in range(8)])

    def test_parallel_questions_are_public_and_resume_by_occurrence(self):
        (self.root / "parallel.tb").write_text('''module public_questions
skill Question
    takes topic as Text
    gives Text
    do
        ask
            with prompt as topic
            into answer
        give answer
strategy Batch
    takes topics as List of Text
    gives List of Text
    uses Question
    do
        parallel Question
            each topic in topics
            with topic as topic
            max_concurrency 2
            max_items 4
            into answers
        give answers
''')
        config = dict(source="parallel.tb", entry_ref="strategy:public_questions/Batch", parallel_checkpoint_out="progress.json")
        result = self.engine.run(**config, inputs={"topics": ["first", "second"]})
        for _ in range(4):
            if result.status != "stopped":
                break
            self.assertTrue(result.pending_interactions)
            self.assertEqual(result.pending_interaction, result.pending_interactions[0])
            self.assertTrue(all(set(item) == {"interaction_ref", "prompt"} for item in result.pending_interactions))
            result = self.engine.run(**config, parallel_resume_checkpoint="progress.json",
                user_inputs={item["interaction_ref"]: item["prompt"] + "!" for item in result.pending_interactions})
        self.assertEqual(result.result, ["first!", "second!"])
        self.assertEqual(result.pending_interactions, [])

    def test_controlled_outcomes_and_runtime_error(self):
        air = self.engine.compile("source.tb").air_document
        for entry, flags, status, reason in [
            ("Stop", {}, "stopped", "explicit_stop"),
            ("Ask", {}, "stopped", "user_input_pending"),
            ("Ask", {"cancel_on_pause": True}, "cancelled", "user_input_cancelled"),
        ]:
            result = self.engine.run(air_json=air, entry_ref=f"strategy:python.test/{entry}", **flags)
            self.assertEqual(result.status, status)
            self.assertIsInstance(result.reason, str)
        with self.assertRaises(ToubaEngineError) as raised:
            self.engine.run(air_json=air, entry_ref="strategy:python.test/Fail", inputs={"divisor": 0})
        self.assertEqual(raised.exception.phase, "run")
        self.assertEqual(raised.exception.details["status"], "failure")
        self.assertIn("trace", raised.exception.details)
        self.assertIsNone(raised.exception.__context__)

    def test_compilation_and_public_vocabulary_match_javascript(self):
        import touba_sdk
        from touba_sdk import testing
        mapping = {
            "ToubaEngine": "ToubaEngine", "ToubaEngineError": "ToubaEngineError",
            "ToubaHandlerError": "ToubaHandlerError", "toubaSdkMetadata": "touba_sdk_metadata",
            "defineTool": "define_tool", "createToolHandler": "create_tool_handler",
            "handleToolRequest": "handle_tool_request", "createToolResult": "create_tool_result",
            "createEffectReceipt": "create_effect_receipt", "createCompensationReceipt": "create_compensation_receipt",
        }
        helpers = {"createScriptedDecisionProvider": "create_scripted_decision_provider",
                   "assertRunSucceeded": "assert_run_succeeded", "assertRunRefused": "assert_run_refused",
                   "assertTraceEvents": "assert_trace_events"}
        for module, names in [(touba_sdk, mapping), (testing, helpers)]:
            for name in names.values():
                self.assertTrue(callable(getattr(module, name)), name)
        for name in ["Engine", "AsyncEngine", "EngineError", "HandlerError", "sdk_metadata"]:
            self.assertFalse(hasattr(touba_sdk, name), "No pre-release aliases: " + name)
        compiled = self.engine.compile("source.tb")
        self.assertIsInstance(compiled, CompileResult)
        self.assertEqual(json.loads(compiled.air_json), compiled.air_document)
        for air in [compiled.air_json, compiled.air_document]:
            self.assertEqual(self.engine.run(air_json=air, entry_ref="strategy:python.test/Echo", inputs={"value": "same"}).result, "same")
        sdk = (IMPLEMENTATION / "runtime/touba-handler-sdk/src/index.mjs").as_uri()
        sdk_testing = (IMPLEMENTATION / "runtime/touba-handler-sdk/src/testing.mjs").as_uri()
        script = f'''import * as sdk from {json.dumps(sdk)};
import * as testing from {json.dumps(sdk_testing)};
import assert from "node:assert/strict";
for (const name of {json.dumps(list(mapping))}) assert.equal(typeof sdk[name], "function", name);
for (const name of {json.dumps(list(helpers))}) assert.equal(typeof testing[name], "function", name);
const engine = new sdk.ToubaEngine({{projectRoot:{json.dumps(str(self.root))},command:process.execPath,commandArgs:[{json.dumps(str(CLI))}]}});
const compiled = await engine.compile({{source:"source.tb"}});
assert.deepEqual(JSON.parse(compiled.airJson), compiled.airDocument);
for (const airJson of [compiled.airJson, compiled.airDocument]) {{
 const run = await engine.run({{airJson,entryRef:"strategy:python.test/Echo",inputs:{{value:"same"}}}});
 assert.equal(run.result, "same");
}}
process.stdout.write(JSON.stringify(compiled.airDocument));'''
        document = json.loads(subprocess.check_output([NODE, "--input-type=module", "-e", script], cwd=self.root))
        self.assertEqual(document, compiled.air_document)

    def test_same_outcomes_as_javascript_sdk(self):
        script = self.root / "parity.mjs"
        sdk = (IMPLEMENTATION / "runtime/touba-handler-sdk/src/index.mjs").as_uri()
        script.write_text(f'''import {{ToubaEngine}} from {json.dumps(sdk)};
const engine = new ToubaEngine({{projectRoot:{json.dumps(str(self.root))},command:process.execPath,commandArgs:[{json.dumps(str(CLI))}]}});
const outcomes = [];
for (const entry of ["Echo", "Stop", "Ask"]) {{
 const run = await engine.run({{source:"source.tb",entryRef:`strategy:python.test/${{entry}}`,...(entry==="Echo"?{{inputs:{{value:"parity"}}}}:{{}})}});
 outcomes.push({{status:run.status,reason:run.reason,result:run.result}});
}}
process.stdout.write(JSON.stringify(outcomes));''')
        js = json.loads(subprocess.check_output([NODE, str(script)], cwd=self.root))
        py = []
        for entry in ["Echo", "Stop", "Ask"]:
            run = self.engine.run(source="source.tb", entry_ref=f"strategy:python.test/{entry}", **({"inputs": {"value": "parity"}} if entry == "Echo" else {}))
            py.append(dict(status=run.status, reason=run.reason, result=run.result))
        self.assertEqual(py, js)

    def test_approval_host_separation_resume_and_effect_journal(self, language="javascript"):
        fixture = IMPLEMENTATION / "grammar/tree-sitter-touba/examples/human-approval-v1/positive/approval-policy.tb"
        (self.root / "source.tb").write_bytes(fixture.read_bytes())
        (self.root / "authority.mjs").write_text('''import {readFileSync} from "node:fs";
export const initiatorRef = "initiator";
export function attestHumanApproval({request,decision,evidenceRef}) {
 const signer = JSON.parse(readFileSync(new URL("./signer.json",import.meta.url)));
 if (evidenceRef !== "receipt") throw new Error("Evidence unavailable");
 return {request_id:request.request_id,run_id:request.run_id,decision,...signer};
}''')
        if language == "python":
            (self.root / "authority.py").write_text('''import json
from pathlib import Path
initiator_ref = "initiator"
def attest_human_approval(payload):
    if payload["evidenceRef"] != "receipt": raise ValueError("unavailable evidence")
    signer = json.loads((Path(__file__).parent / "signer.json").read_text())
    request = payload["request"]
    return {"request_id":request["request_id"], "run_id":request["run_id"], "decision":payload["decision"], **signer}
''')
        marker = self.root / "effects.txt"
        (self.root / "handler.py").write_text(f'''import asyncio
from touba_sdk import define_tool, create_tool_result
def run(request, context):
    with open({str(marker)!r}, "a") as stream:
        stream.write(request + "\\n")
    return create_tool_result(request, effect_receipt=context["create_effect_receipt"]({{"outcome": "applied"}}))
asyncio.run(define_tool(tool_ref="tool:approval_policy/Commit", run=run,
                       input_signature=[{{"name":"value", "type_ref":"builtin:Text"}}]))
''')
        binding = dict(handler=dict(kind="process", command=sys.executable, args=[str(self.root / "handler.py")]), grants=[],
                       timeout_ms=2000, max_payload_bytes=65536, effect_contract=dict(kind="external_write", retry_mode="none"))
        (self.root / "manifest.json").write_text(json.dumps(dict(manifest_version="touba-manifest-v1", bindings={"tool:approval_policy/Commit": binding})))
        options = dict(source="source.tb", entry_ref="strategy:approval_policy/ApproveTwice", manifest="manifest.json",
                       human_approval_host="authority.py" if language == "python" else "authority.mjs",
                       human_approval_authority_timeout_ms=12000,
                       trace_pure_functions="calls",
                       human_checkpoint_out="waiting.json", effect_journal="run.effect-journal.sqlite")
        self.assertEqual(self.engine.run(**options, inputs={"dossier": "invoice"}).reason, "human_approval_pending")
        for index, signer in enumerate(["one", "two"]):
            checkpoint = json.loads((self.root / "waiting.json").read_text())
            resumed = dict(**options, human_resume_checkpoint="waiting.json", human_decisions={checkpoint["approval_ref"]: {"decision": "approved", "evidence_ref": "receipt"}})
            (self.root / "signer.json").write_text(json.dumps(dict(subject_ref="initiator" if index == 0 else "one", roles=["finance"])))
            with self.assertRaises(ToubaEngineError) as raised:
                ToubaEngine(**self.options).run(**resumed)
            self.assertIn("Signer", raised.exception.code)
            self.assertFalse(marker.exists())
            (self.root / "signer.json").write_text(json.dumps(dict(subject_ref=signer, roles=["finance"])))
            result = ToubaEngine(**self.options).run(**resumed)
            self.assertEqual(result.status, "stopped" if index == 0 else "success")
            self.assertEqual(result.trace["run"]["pure_function_detail"], "calls")
        self.assertEqual(marker.read_text(), "invoice\n")
        # Replaying this completed checkpoint must not duplicate its external write.
        with self.assertRaises(ToubaEngineError) as raised:
            ToubaEngine(**self.options).run(**resumed)
        self.assertEqual(raised.exception.code, "HumanApprovalCheckpointAlreadyConsumed")
        self.assertEqual(marker.read_text(), "invoice\n")

    def test_python_approval_host_preserves_roles_separation_and_replay(self):
        self.test_approval_host_separation_resume_and_effect_journal(language="python")

    def _write_shared_python_host(self):
        (self.root / "host.py").write_text('''from pathlib import Path
import os
import atexit
atexit.register(lambda: (Path(__file__).parent / "host-closed.txt").write_text("closed"))
with (Path(__file__).parent / "host-loads.txt").open("a") as stream: stream.write(str(os.getpid()) + "\\n")
initiator_ref = "test-initiator"
def decide_agent_capability(request):
    return {"action":"answer_directly", "result":"served by Python", "reason":"Summary complete.", "source":"test"}
def attest_human_approval(payload):
    request = payload["request"]
    return {"request_id":request["request_id"], "run_id":request["run_id"], "decision":payload["decision"], "subject_ref":"reviewer", "roles":["finance"]}
''')

    def test_shared_python_host_closes_gracefully(self):
        self._write_shared_python_host()
        loader = (CLI.parents[2] / "touba-run/src/host-modules.mjs").as_uri()
        script = f'''import assert from "node:assert/strict";
import {{ createHostModuleLoader }} from {json.dumps(loader)};
const loader = createHostModuleLoader();
try {{
  const provider = await loader.decisionProvider("./host.py");
  const approval = await loader.approvalHost("./host.py");
  assert.equal((await provider({{}})).result, "served by Python");
  assert.equal(approval.humanApprovalInitiator, "test-initiator");
  assert.equal((await approval.humanApprovalAuthority({{
    request: {{ request_id: "approval-test", run_id: "run-test" }}, decision: "approved"
  }})).subject_ref, "reviewer");
}} finally {{ loader.close(); }}
'''
        result = subprocess.run([NODE, "--input-type=module", "-e", script], cwd=self.root,
            env={**os.environ, "TOUBA_HOST_PYTHON": sys.executable}, capture_output=True, text=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(len((self.root / "host-loads.txt").read_text().splitlines()), 1)
        # A normal loader close must execute Python cleanup, including on Windows.
        self.assertEqual((self.root / "host-closed.txt").read_text(), "closed")

    def test_serve_reuses_host_and_terminates_process_tree(self):
        (self.root / "source.tb").write_text('''module python.host
agent Reader
    gives Text
    responsibility "Return the supplied document summary."
    callable_by strategy Run
strategy Run
    gives Text
    uses Reader
    do
        Reader
            into result
        give result
''')
        air = self.engine.compile("source.tb").air_document
        air_dir = self.root / ".touba" / "air"
        air_dir.mkdir(parents=True)
        (air_dir / "host.air.json").write_text(json.dumps(air))
        (self.root / "touba.project.json").write_text(json.dumps({"entry": "strategy:python.host/Run"}))
        self._write_shared_python_host()
        errors = tempfile.TemporaryFile(mode="w+t")
        self.addCleanup(errors.close)
        child = subprocess.Popen([NODE, str(CLI), "serve", "--project-root", str(self.root), "--port", "0",
            "--agent-decision-provider", str(self.root / "host.py"), "--human-approval-host", str(self.root / "host.py")],
            cwd=self.root, env={**os.environ, "TOUBA_HOST_PYTHON": sys.executable},
            stdout=subprocess.PIPE, stderr=errors, text=True)
        lines = queue.Queue()
        def collect():
            for line in child.stdout: lines.put(line)
        reader = threading.Thread(target=collect, daemon=True)
        reader.start()
        host_handle = None
        try:
            while True:
                event = json.loads(lines.get(timeout=15))
                if event.get("event") == "touba_project_server_started": break
            body = {"schema_version":"touba-sandbox-run-request-v1", "execution_kind":"entrypoint",
                "target_ref":"strategy:python.host/Run", "inputs":{}, "effect_policy":"runtime_only",
                "requested_by":{"kind":"service", "id":"python-host-test"}, "reason":"Verify Python host integration"}
            request = urllib.request.Request(f'http://127.0.0.1:{event["port"]}/runs/sandbox',
                data=json.dumps(body).encode(), headers={"Content-Type":"application/json"})
            with urllib.request.urlopen(request, timeout=15) as response:
                result = json.load(response)
            self.assertEqual(result["result"], "served by Python", result)
            host_pids = (self.root / "host-loads.txt").read_text().splitlines()
            self.assertEqual(len(host_pids), 1)
            if os.name == "nt":
                # An atexit marker precedes actual process termination. Windows
                # retains the child's working directory until that termination,
                # so keep a handle to this exact process before closing its parent.
                import ctypes
                from ctypes import wintypes
                kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
                kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
                kernel32.OpenProcess.restype = wintypes.HANDLE
                kernel32.WaitForSingleObject.argtypes = [wintypes.HANDLE, wintypes.DWORD]
                kernel32.WaitForSingleObject.restype = wintypes.DWORD
                kernel32.CloseHandle.argtypes = [wintypes.HANDLE]
                kernel32.CloseHandle.restype = wintypes.BOOL
                host_handle = kernel32.OpenProcess(0x00100000, False, int(host_pids[0]))  # SYNCHRONIZE
                self.assertTrue(host_handle, f"cannot observe Python host exit: {ctypes.get_last_error()}")
                self.addCleanup(kernel32.CloseHandle, host_handle)
            self.assertIsNone(child.poll(), "server must still be alive before the requested termination")
        finally:
            child.terminate()
            child.wait(timeout=10)
            reader.join(timeout=10)
            self.assertFalse(reader.is_alive(), "server descendants must release stdout")
            child.stdout.close()
            errors.seek(0)
            error = errors.read()
        # CPython Popen.terminate() uses TerminateProcess(handle, 1) on Windows;
        # POSIX reports termination by SIGTERM as a negative return code.
        self.assertEqual(child.returncode, 1 if os.name == "nt" else -signal.SIGTERM, error)
        if host_handle is not None:
            self.assertEqual(kernel32.WaitForSingleObject(host_handle, 10000), 0,
                             "the shared Python host must terminate, not only write its atexit marker")
            # TerminateProcess closes libuv's KILL_ON_JOB_CLOSE job, then the
            # Python venv launcher's job. This is forced process-tree teardown;
            # atexit is guaranteed only by the separate graceful-close test.
            return
        closed = self.root / "host-closed.txt"
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            if closed.exists() and closed.read_text() == "closed":
                break
            time.sleep(.02)
        self.assertTrue(closed.exists(), "the shared Python host must close after the forwarded POSIX signal")
        self.assertEqual(closed.read_text(), "closed")

    def test_large_output_and_errors_do_not_leak_stderr(self):
        payload = "é🙂" * 200000
        (self.root / "large.tb").write_text(f'module large\ndefine Payload as Text = {json.dumps(payload, ensure_ascii=False)}\nstrategy Run\n    gives Text\n    do\n        give Payload\n', encoding="utf-8")
        self.assertEqual(self.engine.run(source="large.tb").result, payload)
        (self.root / "invalid.tb").write_text("SECRET_COMPILER_INPUT not Touba")
        with self.assertRaises(ToubaEngineError) as error:
            self.engine.compile("invalid.tb")
        self.assertEqual(error.exception.code, "CompilationFailed")
        self.assertNotIn("SECRET", str(error.exception.details))

    def test_options_and_protocol_are_closed(self):
        for options in [dict(source="source.tb", mystery=True), dict(source="source.tb", air="elsewhere"),
                        dict(air_document={}), dict(air_json="[]"), dict(air_json="{broken"),
                        dict(air_json={}, max_agent_steps=True), dict(air_json={}, inputs={"bad": float("nan")})]:
            with self.assertRaises(ToubaEngineError) as error:
                self.engine.run(**options)
            self.assertEqual(error.exception.phase, "options")
        for raw in [b'{}', b'[]', b'{"status":"success","status":"success"}', b'NaN']:
            with self.assertRaises(ToubaEngineError):
                _result(raw, 0)

    def test_timeout_and_sync_cancellation_kill_dedicated_process(self):
        (self.root / "blocked.mjs").write_text('setInterval(()=>{}, 1000);')
        engine = ToubaEngine(self.root, command=NODE, command_args=[str(self.root / "blocked.mjs")])
        with self.assertRaises(ToubaEngineError) as error:
            engine.run(air_json={}, timeout=.1)
        self.assertEqual(error.exception.code, "EngineTimeout")
        event = threading.Event()
        timer = threading.Timer(.1, event.set); timer.start()
        try:
            with self.assertRaises(ToubaEngineError) as error:
                engine.run(air_json={}, cancel_event=event)
            self.assertEqual(error.exception.code, "EngineCancelled")
        finally:
            timer.join()

    def test_async_cancellation_and_sync_misuse(self):
        (self.root / "blocked.mjs").write_text('setInterval(()=>{}, 1000);')
        async def exercise():
            with self.assertRaises(ToubaEngineError) as error:
                self.engine.version()
            self.assertEqual(error.exception.code, "UseAsyncToubaEngineInEventLoop")
            engine = AsyncToubaEngine(self.root, command=NODE, command_args=[str(self.root / "blocked.mjs")])
            pending = asyncio.create_task(engine.run(air_json={}))
            await asyncio.sleep(.1); pending.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await pending
        asyncio.run(exercise())

    @unittest.skipUnless(os.name == "posix", "dedicated POSIX process groups")
    def test_timeout_reaps_descendant_when_parent_already_exited(self):
        marker = self.root / "escaped.txt"
        ready = self.root / "ready.txt"
        release = self.root / "release.txt"
        # The descendant may act only after the SDK has returned. A wall-clock
        # delay inside the child races with scheduling on shared native runners.
        child_code = f'''const fs=require("node:fs");
fs.writeFileSync({json.dumps(str(ready))},String(process.pid));
const poll=setInterval(()=>{{if(fs.existsSync({json.dumps(str(release))})){{
fs.writeFileSync({json.dumps(str(marker))},"orphan");process.exit(0);}}}},20);
setTimeout(()=>process.exit(0),10000);'''
        (self.root / "descendant.mjs").write_text(f'''import {{spawn}} from "node:child_process";
import {{existsSync}} from "node:fs";
spawn(process.execPath,["-e",{json.dumps(child_code)}],{{stdio:["ignore",1,2]}});
setInterval(()=>{{if(existsSync({json.dumps(str(ready))}))process.exit(0);}},10);
setTimeout(()=>process.exit(2),10000);''', encoding="utf-8")
        engine = ToubaEngine(self.root, command=NODE, command_args=[str(self.root / "descendant.mjs")])
        parent_codes = []
        def kill_and_record(child):
            parent_codes.append(child.returncode)
            _kill(child)
        with patch("touba_sdk.engine._kill", side_effect=kill_and_record):
            with self.assertRaises(ToubaEngineError) as error:
                engine.run(air_json={}, timeout=2)
        self.assertEqual(error.exception.code, "EngineTimeout")
        self.assertTrue(ready.exists(), "descendant must be running before the timeout")
        self.assertEqual(parent_codes, [0], "the parent must already have exited when its group is killed")
        release.write_text("continue", encoding="utf-8")
        threading.Event().wait(.5)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
