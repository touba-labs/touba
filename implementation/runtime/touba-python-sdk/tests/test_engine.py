import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import unittest

from touba_sdk import AsyncToubaEngine, ToubaEngine, ToubaEngineError, CompileResult, touba_sdk_metadata
from touba_sdk.engine import _result

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
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory(prefix="touba-python-test-")
        self.addCleanup(self.directory.cleanup)
        self.root = Path(self.directory.name)
        self.options = dict(project_root=self.root, command=NODE, command_args=[str(CLI)])
        self.engine = ToubaEngine(**self.options)
        (self.root / "source.tb").write_text(SOURCE)

    def test_installed_identity_and_sync_async_typed_values(self):
        self.assertEqual(touba_sdk_metadata()["version"], "1.0.0")
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
                       human_checkpoint_out="waiting.json", effect_journal="run.effect-journal.json")
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
        self.assertEqual(marker.read_text(), "invoice\n")
        # Replaying this completed checkpoint must not duplicate its external write.
        try:
            ToubaEngine(**self.options).run(**resumed)
        except ToubaEngineError:
            pass
        self.assertEqual(marker.read_text(), "invoice\n")

    def test_python_approval_host_preserves_roles_separation_and_replay(self):
        self.test_approval_host_separation_resume_and_effect_journal(language="python")

    def test_large_output_and_errors_do_not_leak_stderr(self):
        payload = "é🙂" * 200000
        (self.root / "large.tb").write_text(f'module large\ndefine Payload as Text = {json.dumps(payload, ensure_ascii=False)}\nstrategy Run\n    gives Text\n    do\n        give Payload\n')
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
        (self.root / "descendant.mjs").write_text(f'''import {{spawn}} from "node:child_process";
spawn(process.execPath, ["-e", {json.dumps('setTimeout(()=>require("node:fs").writeFileSync(' + json.dumps(str(marker)) + ',"orphan"),800)')}], {{stdio:["ignore",1,2]}});
process.exit(0);''')
        engine = ToubaEngine(self.root, command=NODE, command_args=[str(self.root / "descendant.mjs")])
        with self.assertRaises(ToubaEngineError) as error:
            engine.run(air_json={}, timeout=.2)
        self.assertEqual(error.exception.code, "EngineTimeout")
        threading.Event().wait(.9)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
