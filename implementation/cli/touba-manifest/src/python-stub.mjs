const literal = value => `json.loads(${JSON.stringify(JSON.stringify(value))})`;
function constants(tool) {
  return `TOOL_REF = ${literal(tool.id)}
REQUIRED_GRANTS = ${literal(tool.required_capabilities ?? [])}
REQUIRED_SECRET_HANDLES = ${literal(tool.required_secrets ?? [])}
INPUT_SIGNATURE = ${literal((tool.signature?.inputs ?? []).map(({ name, type_ref }) => ({ name, type_ref })))}
OUTPUT_TYPE = ${literal(tool.signature?.output_type ?? null)}`;
}

export function generatePythonHandler(tool) {
  return `import asyncio
import json
from touba_sdk import ToubaHandlerError, define_tool, touba_sdk_metadata

${constants(tool)}
TOUBA_HANDLER_SDK = touba_sdk_metadata()
TOUBA_HANDLER_GENERATED_BY = {"tool": "touba handler stub", "version": "0.1.0"}


async def run(request, context):
    # Implement business behavior here. The Core owns admission and type checks.
    raise ToubaHandlerError("HandlerNotImplemented", "Handler is not implemented")


if __name__ == "__main__":
    asyncio.run(define_tool(tool_ref=TOOL_REF, run=run,
                           required_grants=REQUIRED_GRANTS,
                           required_secret_handles=REQUIRED_SECRET_HANDLES,
                           input_signature=INPUT_SIGNATURE, output_type=OUTPUT_TYPE))
`;
}

export function generatePythonContractTest(tool, handlerImport) {
  return `# Admission checks only. Add independent tests of business outputs and effects.
import asyncio
import importlib.util
import json
from pathlib import Path
import unittest
from touba_sdk import create_tool_handler, handle_tool_request

${constants(tool)}
spec = importlib.util.spec_from_file_location("touba_business_handler", Path(__file__).parent / ${JSON.stringify(handlerImport)})
handler_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(handler_module)


class HandlerContract(unittest.TestCase):
    def test_metadata(self):
        self.assertEqual(handler_module.TOUBA_HANDLER_SDK["name"], "touba-sdk")
        self.assertEqual(handler_module.TOUBA_HANDLER_SDK["protocol"], "touba-tool-handler-v1")
        self.assertNotIn("grants", handler_module.TOUBA_HANDLER_SDK)

    def check_refusal(self, tool_ref, grants, secrets, expected):
        called = False
        def forbidden(request, context):
            nonlocal called
            called = True
            raise AssertionError("Business code must not run")
        handler = create_tool_handler(tool_ref=TOOL_REF, run=forbidden, input_signature=INPUT_SIGNATURE)
        request = {"protocol": "touba-tool-handler-v1", "operation": "invoke", "tool_ref": tool_ref,
                   "arguments": {}, "grants": grants, "secret_handles": secrets}
        result = asyncio.run(handle_tool_request(json.dumps(request), TOOL_REF, handler,
                            required_grants=REQUIRED_GRANTS, required_secret_handles=REQUIRED_SECRET_HANDLES))
        self.assertFalse(called)
        self.assertFalse(result["ok"])
        self.assertEqual(result["error"]["code"], expected)

    def test_wrong_tool(self):
        self.check_refusal("tool:contract/UnexpectedTool", REQUIRED_GRANTS, REQUIRED_SECRET_HANDLES, "InvalidToolRef")

    def test_required_authority(self):
        if REQUIRED_GRANTS or REQUIRED_SECRET_HANDLES:
            self.check_refusal(TOOL_REF, [], [], "MissingGrant" if REQUIRED_GRANTS else "MissingSecretHandle")


if __name__ == "__main__":
    unittest.main()
`;
}
