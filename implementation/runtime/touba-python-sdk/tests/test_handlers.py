import asyncio
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

from touba_sdk import (ToubaHandlerError, create_tool_handler, create_tool_result,
                      create_effect_receipt, create_compensation_receipt, handle_tool_request)

ROOT = Path(__file__).resolve().parents[3]
NODE = os.environ.get("TOUBA_TEST_NODE", shutil.which("node"))
TOOL = "tool:python/Read"
EFFECT = {"effect_id": "effect:sha256:" + "a" * 64, "request_digest": "sha256:" + "b" * 64, "attempt_index": 1}


def request(**values):
    return {"protocol": "touba-tool-handler-v1", "operation": "invoke", "tool_ref": TOOL, "arguments": {"value": "invoice"}, **values}


class HandlerTests(unittest.TestCase):
    def test_real_python_effect_error_keeps_cause_through_core_process_protocol(self):
        with tempfile.TemporaryDirectory(prefix="touba-python-effect-error-") as folder:
            handler = Path(folder) / "handler.py"
            module = (ROOT / "runtime/touba-runtime/src/handler-protocol.mjs").as_uri()
            for failure, expected in [("ToubaHandlerError('ExternalServiceDown', 'Database unavailable')", "ExternalServiceDown"),
                                      ("RuntimeError('private database details')", "UnhandledHandlerError")]:
                handler.write_text(f'''import asyncio
from touba_sdk import ToubaHandlerError, define_tool
def run(request, context):
    raise {failure}
asyncio.run(define_tool(tool_ref="tool:python/Read", run=run))
''')
                script = f'''import {{runProcessToolHandler}} from {json.dumps(module)};
try {{ await runProcessToolHandler({{
 toolRef:{json.dumps(TOOL)}, binding:{{handler:{{command:{json.dumps(sys.executable)},args:[{json.dumps(str(handler))}]}},
 limits:{{timeout_ms:5000,max_payload_bytes:65536}}}},
 request:{{protocol:"touba-tool-handler-v1",operation:"invoke",tool_ref:{json.dumps(TOOL)},call_id:"test",arguments:{{}},effect:{json.dumps(EFFECT)}}},
 secretHandles:[],secretStore:null
}}); throw new Error("unexpected success"); }} catch(error) {{ console.log(JSON.stringify({{code:error.code,details:error.details}})); }}'''
                result = json.loads(subprocess.check_output([NODE, "--input-type=module", "-e", script]))
                self.assertEqual(result["code"], "ToolHandlerReportedError")
                self.assertEqual(result["details"]["handlerErrorCode"], expected)
                self.assertEqual(result["details"]["receiptErrorCode"], "EffectReceiptInvalid")
                self.assertEqual(result["details"]["state"], "unknown")
                self.assertNotIn("private database details", json.dumps(result))

    def invoke(self, value, run, **options):
        handler = create_tool_handler(tool_ref=TOOL, run=run, input_signature=[{"name": "value", "type_ref": "builtin:Text"}], **options)
        return asyncio.run(handle_tool_request(json.dumps(value), TOOL, handler,
                           required_grants=options.get("required_grants", []),
                           required_secret_handles=options.get("required_secret_handles", [])))

    def test_sync_async_and_named_arguments(self):
        self.assertEqual(self.invoke(request(), lambda request, context: request), {"ok": True, "value": "invoice"})
        async def async_run(request, context):
            await asyncio.sleep(0)
            self.assertEqual(context["tool_ref"], TOOL)
            self.assertEqual(context["arguments"], {"value": "invoice"})
            return request
        self.assertEqual(self.invoke(request(), async_run)["value"], "invoice")
        handler = create_tool_handler(tool_ref=TOOL, run=lambda request, context: request)
        result = asyncio.run(handle_tool_request(json.dumps(request()), TOOL, handler))
        self.assertEqual(result["value"], {"value": "invoice"})

    def test_refusals_before_business_code_and_javascript_parity(self):
        cases = [
            (request(protocol="wrong"), {}, "InvalidProtocol"),
            (request(operation="execute"), {}, "InvalidHandlerOperation"),
            (request(tool_ref="tool:wrong/Read"), {}, "InvalidToolRef"),
            (request(arguments=[]), {}, "InvalidArguments"),
            (request(grants=[]), {"required_grants": ["network"]}, "MissingGrant"),
            (request(secret_handles=[]), {"required_secret_handles": ["TOKEN"]}, "MissingSecretHandle"),
            (request(unexpected="data"), {}, "InvalidHandlerRequest"),
            (request(compensation={}), {}, "InvalidCompensation"),
            (request(effect={**EFFECT, "attempt_index": True}), {}, "InvalidEffect"),
        ]
        def forbidden(request, context):
            self.fail("handler called before admission")
        observed = []
        for value, options, code in cases:
            result = self.invoke(value, forbidden, **options)
            self.assertFalse(result["ok"])
            self.assertEqual(result["error"]["code"], code)
            observed.append(code)
        js_cases = [{"request": value, "options": {"requiredGrants": options.get("required_grants", []), "requiredSecretHandles": options.get("required_secret_handles", [])}} for value, options, _ in cases]
        module = (ROOT / "runtime/touba-handler-sdk/src/index.mjs").as_uri()
        script = f'''import {{handleToolRequest}} from {json.dumps(module)};
const cases = {json.dumps(js_cases)}; const results=[];
for (const c of cases) {{ const r=await handleToolRequest(JSON.stringify(c.request), {json.dumps(TOOL)}, () => {{throw new Error("must not run")}}, c.options); results.push(r.error.code); }}
console.log(JSON.stringify(results));'''
        self.assertEqual(json.loads(subprocess.check_output([NODE, "--input-type=module", "-e", script])), observed)

    def test_explicit_metadata_envelope_not_business_object(self):
        business = {"value": 3, "memory_metadata": "ordinary field"}
        self.assertEqual(self.invoke(request(), lambda request, context: business)["value"], business)
        provenance = [{"memory_ref": "memory:app/Records", "operation": "read"}]
        response = self.invoke(request(), lambda request, context: create_tool_result("value", memory_metadata=provenance))
        self.assertEqual(response, {"ok": True, "value": "value", "memory_metadata": provenance})
        with self.assertRaises(ToubaHandlerError):
            create_tool_result("value", memory_metadata=[{"memory_ref": "memory:a/B", "operation": "read", "authority": "admin"}])
        result = self.invoke(request(), lambda request, context: create_tool_result("value", effect_receipt={}))
        self.assertEqual(result["error"]["code"], "InvalidToolResult")

    def test_effect_receipts_exact_correlation_and_errors(self):
        receipt = create_effect_receipt(EFFECT, {"outcome": "applied", "receipt_ref": "invoice-42"})
        response = self.invoke(request(effect=EFFECT), lambda request, context: create_tool_result(request, effect_receipt=context["create_effect_receipt"]({"outcome": "applied", "receipt_ref": "invoice-42"})))
        self.assertEqual(response["effect_receipt"], receipt)
        for output, code in [("unreceipted", "EffectReceiptRequired"), ({"value": 1, "effect_receipt": {**receipt, "effect_id": "other"}}, "EffectReceiptInvalid")]:
            self.assertEqual(self.invoke(request(effect=EFFECT), lambda request, context: output)["error"]["code"], code)
        def safe_error(request, context):
            raise ToubaHandlerError("Unavailable", "Retry explicitly", {"effect_receipt": context["create_effect_receipt"]({"outcome": "not_applied"})})
        self.assertEqual(self.invoke(request(effect=EFFECT), safe_error)["effect_receipt"]["outcome"], "not_applied")

    def test_compensation_is_correlated_and_digest_checked(self):
        original = create_effect_receipt(EFFECT, {"outcome": "applied", "receipt_ref": "invoice-42"})
        digest = "sha256:" + hashlib.sha256(json.dumps(original, sort_keys=True, separators=(",", ":")).encode()).hexdigest()
        compensation = {"compensation_id": "compensation:sha256:" + "c" * 64, "compensates_effect_id": EFFECT["effect_id"],
                        "plan_digest": "sha256:" + "d" * 64, "execution_request_digest": "sha256:" + "e" * 64,
                        "original_tool_ref": TOOL, "original_request_digest": EFFECT["request_digest"],
                        "original_effect_receipt_digest": digest, "original_effect_receipt": original}
        inverse = {**EFFECT, "effect_id": "effect:sha256:" + "f" * 64}
        def compensate(request, context):
            return create_tool_result("reversed", effect_receipt=context["create_effect_receipt"]({"outcome": "applied"}),
                                      compensation_receipt=context["create_compensation_receipt"]({"result": "completed"}))
        response = self.invoke(request(operation="compensate", effect=inverse, compensation=compensation), compensate)
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["compensation_receipt"], create_compensation_receipt(compensation, inverse, {"result": "completed"}))
        corrupted = {**compensation, "original_effect_receipt_digest": "sha256:" + "0" * 64}
        self.assertEqual(self.invoke(request(operation="compensate", effect=inverse, compensation=corrupted), compensate)["error"]["code"], "InvalidCompensation")

    def test_business_mutation_cannot_rebind_receipt_identity(self):
        def mutate(request, context):
            context["effect"]["effect_id"] = "effect:sha256:" + "f" * 64
            context["request"]["effect"]["request_digest"] = "sha256:" + "0" * 64
            return create_tool_result("done", effect_receipt=context["create_effect_receipt"]({"outcome": "applied"}))
        response = self.invoke(request(effect=EFFECT), mutate)
        self.assertTrue(response["ok"], response)
        self.assertEqual(response["effect_receipt"]["effect_id"], EFFECT["effect_id"])
        self.assertEqual(response["effect_receipt"]["request_digest"], EFFECT["request_digest"])

    def test_unsafe_exceptions_and_non_json_results_are_not_success(self):
        def fail(request, context):
            raise ValueError("TOP_SECRET_DO_NOT_PRINT")
        result = self.invoke(request(), fail)
        self.assertEqual(result["error"]["code"], "UnhandledHandlerError")
        self.assertNotIn("TOP_SECRET", json.dumps(result))
        for value in [float("nan"), float("inf"), {1, 2}]:
            self.assertFalse(self.invoke(request(), lambda request, context: value)["ok"])

    def test_definition_rejects_duplicates_and_invalid_shapes(self):
        for signature in [[{"name": "v", "type_ref": "builtin:Text"}] * 2, [{"name": "v"}], "v"]:
            with self.assertRaises(ToubaHandlerError):
                create_tool_handler(tool_ref=TOOL, run=lambda request, context: request, input_signature=signature)

    def test_stdio_handler_process(self):
        with tempfile.TemporaryDirectory() as directory:
            file = Path(directory) / "handler.py"
            file.write_text('''import asyncio
from touba_sdk import define_tool
def run(request, context):
    return request.upper()
asyncio.run(define_tool(tool_ref="tool:python/Read", run=run, input_signature=[{"name":"value","type_ref":"builtin:Text"}]))
''')
            result = subprocess.run([sys.executable, str(file)], input=json.dumps(request()), text=True, capture_output=True)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(json.loads(result.stdout), {"ok": True, "value": "INVOICE"})


if __name__ == "__main__":
    unittest.main()
