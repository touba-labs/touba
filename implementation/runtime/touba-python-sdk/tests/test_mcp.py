import asyncio
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from touba_sdk import create_mcp_stdio_tool_bridge, ToubaHandlerError

SERVER = '''import json, os, sys, time
for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message: continue
    if message["method"] == "initialize": result = {"protocolVersion":"2025-06-18", "capabilities":{}}
    else:
        mode = message["params"]["arguments"].get("mode", "ok")
        if mode == "wait": time.sleep(5)
        if mode == "large": print("x" * 10000, flush=True); continue
        if mode == "invalid": print("not-json", flush=True); continue
        if mode == "error": result = {"isError":True, "content":[{"type":"text", "text":"tool failed"}]}
        elif mode == "image": result = {"content":[{"type":"image", "data":"fixture"}]}
        elif mode == "text": result = {"content":[{"type":"text", "text":"value:" + os.environ.get("API_TOKEN", "none")}]}
        else: result = {"structuredContent":{"value":message["params"]["arguments"].get("value"), "unbound":os.environ.get("UNBOUND_SECRET")}}
    print(json.dumps({"jsonrpc":"2.0", "id":message["id"], "result":result}), flush=True)
'''


class McpTests(unittest.TestCase):
    def setUp(self):
        self.folder = tempfile.TemporaryDirectory(prefix="touba-py-mcp-")
        self.addCleanup(self.folder.cleanup)
        self.root = Path(self.folder.name)
        self.server = self.root / "server.py"; self.server.write_text(SERVER)
        self.config = {"mcp_bridge_config_version":"touba-mcp-bridge-config-v1", "server": {
            "transport":"stdio", "command":sys.executable, "args":["-I", str(self.server)],
            "timeout_ms":1000, "max_payload_bytes":4096, "env":{}}}

    def bridge(self, config=None):
        return create_mcp_stdio_tool_bridge(mcp_tool_name="fixture", config=config or self.config)

    def test_real_stdio_and_javascript_parity(self):
        request = {"value":"same"}
        result = asyncio.run(self.bridge()(request, {"env":{"UNBOUND_SECRET":"never forward"}}))
        self.assertEqual(result, {"value":"same", "unbound":None})
        implementation = Path(__file__).resolve().parents[3]
        sdk = (implementation / "runtime/touba-handler-sdk/src/index.mjs").as_uri()
        script = f'''import {{createMcpStdioToolBridge}} from {json.dumps(sdk)};
const bridge = createMcpStdioToolBridge({{mcpToolName:"fixture", config:{json.dumps(self.config)}}});
process.stdout.write(JSON.stringify(await bridge({{request:{json.dumps(request)}, context:{{env:{{UNBOUND_SECRET:"never forward"}}}}}})));'''
        actual = subprocess.check_output([os.environ["TOUBA_TEST_NODE"], "--input-type=module", "-e", script])
        self.assertEqual(result, json.loads(actual))

    def test_refusals_limits_timeout_and_secret_projection(self):
        for mode, code in [("large","McpPayloadTooLarge"), ("invalid","InvalidMcpJson"),
                           ("error","McpToolExecutionError"), ("image","UnsupportedMcpContent"), ("wait","McpRequestTimeout")]:
            with self.subTest(mode=mode), self.assertRaises(ToubaHandlerError) as raised:
                asyncio.run(self.bridge()({"mode":mode}, {"limits":{"timeout_ms":150}}))
            self.assertEqual(raised.exception.code, code)
        self.config["server"]["env"] = {"API_TOKEN":{"from_secret_handle":"MCP_CREDENTIAL"}}
        with self.assertRaises(ToubaHandlerError) as raised:
            asyncio.run(self.bridge()({"mode":"text"}))
        self.assertEqual(raised.exception.code, "McpSecretNotGranted")
        result = asyncio.run(self.bridge()({"mode":"text"}, {"secret_handles":["MCP_CREDENTIAL"], "env":{"MCP_CREDENTIAL":"fixture-secret"}}))
        self.assertNotIn("fixture-secret", json.dumps(result))

    def test_invalid_configs_refuse_without_launch(self):
        for change in [{"transport":"http"}, {"env":{"API_KEY":{"value":"not-permitted"}}}, {"timeout_ms":True}]:
            config = {**self.config, "server":{**self.config["server"], **change}}
            with self.assertRaises(ToubaHandlerError):
                asyncio.run(self.bridge(config)({}))
