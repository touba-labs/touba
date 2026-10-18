import asyncio
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import threading
import unittest

from touba_sdk import AsyncEngine, Engine, EngineError, sdk_metadata
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
        self.engine = Engine(**self.options)
        (self.root / "source.tb").write_text(SOURCE)

    def test_installed_identity_and_sync_async_typed_values(self):
        self.assertEqual(sdk_metadata()["version"], "0.1.0")
        self.assertEqual(len(sdk_metadata()["build_sha256"]), 64)
        self.assertEqual(self.engine.version()["schemas"]["air"], "touba-air-v1")
        air = self.engine.compile("source.tb")
        self.assertEqual(self.engine.run(air_document=air, entry_ref="strategy:python.test/Echo", inputs={"value": "é🙂"}).result, "é🙂")
        async def parallel():
            engine = AsyncEngine(**self.options)
            return await asyncio.gather(*(engine.run(air_document=air, entry_ref="strategy:python.test/Echo", inputs={"value": str(i)}) for i in range(8)))
        self.assertEqual([r.result for r in asyncio.run(parallel())], [str(i) for i in range(8)])

    def test_controlled_outcomes_and_runtime_error(self):
        air = self.engine.compile("source.tb")
        for entry, flags, status, reason in [
            ("Stop", {}, "stopped", "explicit_stop"),
            ("Ask", {}, "stopped", "user_input_pending"),
            ("Ask", {"cancel_on_pause": True}, "cancelled", "user_input_cancelled"),
        ]:
            result = self.engine.run(air_document=air, entry_ref=f"strategy:python.test/{entry}", **flags)
            self.assertEqual(result.status, status)
            self.assertIsInstance(result.reason, str)
        with self.assertRaises(EngineError) as raised:
            self.engine.run(air_document=air, entry_ref="strategy:python.test/Fail", inputs={"divisor": 0})
        self.assertEqual(raised.exception.phase, "run")
        self.assertEqual(raised.exception.details["status"], "failure")
        self.assertIn("trace", raised.exception.details)

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

    def test_approval_host_separation_resume_and_effect_journal(self):
        fixture = IMPLEMENTATION / "grammar/tree-sitter-touba/examples/human-approval-v1/positive/approval-policy.tb"
        (self.root / "source.tb").write_bytes(fixture.read_bytes())
        (self.root / "authority.mjs").write_text('''import {readFileSync} from "node:fs";
export const initiatorRef = "initiator";
export function attestHumanApproval({request,decision,evidenceRef}) {
 const signer = JSON.parse(readFileSync(new URL("./signer.json",import.meta.url)));
 if (evidenceRef !== "receipt") throw new Error("Evidence unavailable");
 return {request_id:request.request_id,run_id:request.run_id,decision,...signer};
}''')
        marker = self.root / "effects.txt"
        (self.root / "handler.mjs").write_text(f'''import {{appendFileSync}} from "node:fs";
let raw=""; for await(const chunk of process.stdin) raw+=chunk; const r=JSON.parse(raw);
appendFileSync({json.dumps(str(marker))},r.arguments.value+"\\n");
process.stdout.write(JSON.stringify({{ok:true,value:r.arguments.value,effect_receipt:{{effect_id:r.effect.effect_id,request_digest:r.effect.request_digest,outcome:"applied"}}}}));''')
        binding = dict(handler=dict(kind="process", command=NODE, args=[str(self.root / "handler.mjs")]), grants=[],
                       timeout_ms=2000, max_payload_bytes=65536, effect_contract=dict(kind="external_write", retry_mode="none"))
        (self.root / "manifest.json").write_text(json.dumps(dict(manifest_version="touba-manifest-v1", bindings={"tool:approval_policy/Commit": binding})))
        options = dict(source="source.tb", entry_ref="strategy:approval_policy/ApproveTwice", manifest="manifest.json",
                       human_approval_host="authority.mjs", human_checkpoint_out="waiting.json", effect_journal="run.effect-journal.json")
        self.assertEqual(self.engine.run(**options, inputs={"dossier": "invoice"}).reason, "human_approval_pending")
        for index, signer in enumerate(["one", "two"]):
            checkpoint = json.loads((self.root / "waiting.json").read_text())
            resumed = dict(**options, human_resume_checkpoint="waiting.json", human_decisions={checkpoint["approval_ref"]: {"decision": "approved", "evidence_ref": "receipt"}})
            (self.root / "signer.json").write_text(json.dumps(dict(subject_ref="initiator" if index == 0 else "one", roles=["finance"])))
            with self.assertRaises(EngineError) as raised:
                Engine(**self.options).run(**resumed)
            self.assertIn("Signer", raised.exception.code)
            self.assertFalse(marker.exists())
            (self.root / "signer.json").write_text(json.dumps(dict(subject_ref=signer, roles=["finance"])))
            result = Engine(**self.options).run(**resumed)
            self.assertEqual(result.status, "stopped" if index == 0 else "success")
        self.assertEqual(marker.read_text(), "invoice\n")
        # Replaying this completed checkpoint must not duplicate its external write.
        try:
            Engine(**self.options).run(**resumed)
        except EngineError:
            pass
        self.assertEqual(marker.read_text(), "invoice\n")

    def test_large_output_and_errors_do_not_leak_stderr(self):
        payload = "é🙂" * 200000
        (self.root / "large.tb").write_text(f'module large\ndefine Payload as Text = {json.dumps(payload, ensure_ascii=False)}\nstrategy Run\n    gives Text\n    do\n        give Payload\n')
        self.assertEqual(self.engine.run(source="large.tb").result, payload)
        (self.root / "invalid.tb").write_text("SECRET_COMPILER_INPUT not Touba")
        with self.assertRaises(EngineError) as error:
            self.engine.compile("invalid.tb")
        self.assertEqual(error.exception.code, "CompilationFailed")
        self.assertNotIn("SECRET", str(error.exception.details))

    def test_options_and_protocol_are_closed(self):
        for options in [dict(source="source.tb", mystery=True), dict(source="source.tb", air="elsewhere"),
                        dict(air_document={}, max_agent_steps=True), dict(air_document={}, inputs={"bad": float("nan")})]:
            with self.assertRaises(EngineError) as error:
                self.engine.run(**options)
            self.assertEqual(error.exception.phase, "options")
        for raw in [b'{}', b'[]', b'{"status":"success","status":"success"}', b'NaN']:
            with self.assertRaises(EngineError):
                _result(raw, 0)

    def test_timeout_and_sync_cancellation_kill_dedicated_process(self):
        (self.root / "blocked.mjs").write_text('setInterval(()=>{}, 1000);')
        engine = Engine(self.root, command=NODE, command_args=[str(self.root / "blocked.mjs")])
        with self.assertRaises(EngineError) as error:
            engine.run(air_document={}, timeout=.1)
        self.assertEqual(error.exception.code, "EngineTimeout")
        event = threading.Event()
        timer = threading.Timer(.1, event.set); timer.start()
        try:
            with self.assertRaises(EngineError) as error:
                engine.run(air_document={}, cancel_event=event)
            self.assertEqual(error.exception.code, "EngineCancelled")
        finally:
            timer.join()

    def test_async_cancellation_and_sync_misuse(self):
        (self.root / "blocked.mjs").write_text('setInterval(()=>{}, 1000);')
        async def exercise():
            with self.assertRaises(EngineError) as error:
                self.engine.version()
            self.assertEqual(error.exception.code, "UseAsyncEngineInEventLoop")
            engine = AsyncEngine(self.root, command=NODE, command_args=[str(self.root / "blocked.mjs")])
            pending = asyncio.create_task(engine.run(air_document={}))
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
        engine = Engine(self.root, command=NODE, command_args=[str(self.root / "descendant.mjs")])
        with self.assertRaises(EngineError) as error:
            engine.run(air_document={}, timeout=.2)
        self.assertEqual(error.exception.code, "EngineTimeout")
        threading.Event().wait(.9)
        self.assertFalse(marker.exists())


if __name__ == "__main__":
    unittest.main()
