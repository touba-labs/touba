"""Bounded stdio MCP bridge. Tools execute only after Core admission."""
import asyncio
from copy import deepcopy
import json
import os
from pathlib import Path
import re
from .handlers import ToubaHandlerError

MCP_BRIDGE_CONFIG_VERSION = "touba-mcp-bridge-config-v1"


def _fail(code, message):
    raise ToubaHandlerError(code, message)


def _invalid_constant(value):
    raise ValueError("Non-JSON constant")


def _positive(value, default):
    if value is None:
        return default
    if type(value) is not int or value < 1 or value > 2**53 - 1:
        _fail("InvalidMcpBridgeConfig", "MCP limits must be positive integers")
    return value


def _normalize(config):
    if not isinstance(config, dict) or config.get("mcp_bridge_config_version") != MCP_BRIDGE_CONFIG_VERSION or not isinstance(config.get("server"), dict):
        _fail("InvalidMcpBridgeConfig", "Invalid MCP bridge configuration")
    server = deepcopy(config["server"])
    if server.get("transport") != "stdio":
        _fail("UnsupportedMcpTransport", "Only MCP stdio is supported")
    if not isinstance(server.get("command"), str) or not server["command"].strip():
        _fail("InvalidMcpBridgeConfig", "MCP server command is required")
    args = server.get("args", [])
    if not isinstance(args, list) or any(not isinstance(arg, str) for arg in args):
        _fail("InvalidMcpBridgeConfig", "MCP arguments must be strings")
    server["args"] = args
    server["timeout_ms"] = _positive(server.get("timeout_ms"), 5000)
    server["max_payload_bytes"] = _positive(server.get("max_payload_bytes"), 1048576)
    server["max_text_content_length"] = _positive(server.get("max_text_content_length"), server["max_payload_bytes"])
    env = server.get("env", {})
    if not isinstance(env, dict):
        _fail("InvalidMcpBridgeConfig", "MCP environment must be an object")
    for key, value in env.items():
        if not isinstance(key, str) or not re.fullmatch(r"[A-Z_][A-Z0-9_]*", key) or not isinstance(value, dict):
            _fail("InvalidMcpBridgeConfig", "Invalid MCP environment entry")
        if isinstance(value.get("value"), str) and "from_secret_handle" not in value:
            if re.search(r"KEY|SECRET|TOKEN|PASSWORD|CREDENTIAL", key):
                _fail("InvalidMcpBridgeConfig", "Secret entries require from_secret_handle")
        elif not (isinstance(value.get("from_secret_handle"), str) and value["from_secret_handle"].strip() and "value" not in value):
            _fail("InvalidMcpBridgeConfig", "Environment entry requires one value or secret handle")
    server["env"] = env
    return server


def create_mcp_stdio_tool_bridge(*, mcp_tool_name, config=None, config_path=None):
    if not isinstance(mcp_tool_name, str) or not mcp_tool_name.strip() or (config is None and config_path is None):
        _fail("InvalidMcpBridgeOptions", "MCP tool name and configuration are required")
    snapshot = deepcopy(config)

    async def bridge(request, context=None):
        context = context or {}
        if not isinstance(request, dict):
            _fail("InvalidMcpArguments", "MCP tool arguments must be an object")
        document = snapshot
        if document is None:
            try:
                with Path(config_path).open("rb") as file:
                    raw = file.read(1048577)
                if len(raw) > 1048576:
                    raise ValueError()
                document = json.loads(raw, parse_constant=_invalid_constant)
            except (OSError, ValueError):
                _fail("InvalidMcpBridgeConfig", "MCP configuration could not be read")
        server = _normalize(document)
        limits = context.get("limits", {})
        timeout_ms = min(server["timeout_ms"], _positive(limits.get("timeout_ms"), server["timeout_ms"]))
        max_bytes = min(server["max_payload_bytes"], _positive(limits.get("max_payload_bytes"), server["max_payload_bytes"]))
        max_text = min(max_bytes, server["max_text_content_length"])
        environment, secrets = {}, []
        for name, value in server["env"].items():
            if "value" in value:
                environment[name] = value["value"]
            else:
                handle = value["from_secret_handle"]
                if handle not in context.get("secret_handles", []):
                    _fail("McpSecretNotGranted", "MCP secret handle is not granted")
                secret = context.get("env", os.environ).get(handle)
                if not isinstance(secret, str) or not secret:
                    _fail("McpSecretMissing", "MCP secret is unavailable")
                environment[name] = secret
                if len(secret) >= 4:
                    secrets.append(secret)
        try:
            child = await asyncio.create_subprocess_exec(server["command"], *server["args"], cwd=server.get("cwd"), env=environment,
                stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE,
                limit=max_bytes + 1)
        except (OSError, ValueError):
            _fail("McpServerProcessError", "MCP server could not start")
        stdout_bytes = 0

        async def drain_stderr():
            size = 0
            while chunk := await child.stderr.read(4096):
                size += len(chunk)
                if size > max_bytes:
                    _fail("McpPayloadTooLarge", "MCP stderr exceeded payload limit")

        async def send(value):
            try:
                data = (json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode()
            except (ValueError, TypeError):
                _fail("InvalidMcpArguments", "MCP arguments must be JSON data")
            if len(data) > max_bytes:
                _fail("McpPayloadTooLarge", "MCP request exceeded payload limit")
            child.stdin.write(data); await child.stdin.drain()

        async def call(request_id, method, params):
            nonlocal stdout_bytes
            await send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
            while True:
                try:
                    line = await child.stdout.readline()
                except ValueError:
                    _fail("McpPayloadTooLarge", "MCP stdout exceeded payload limit")
                stdout_bytes += len(line)
                if stdout_bytes > max_bytes:
                    _fail("McpPayloadTooLarge", "MCP stdout exceeded payload limit")
                if not line:
                    _fail("McpServerClosed", "MCP server closed before responding")
                if not line.strip():
                    continue
                try:
                    message = json.loads(line, parse_constant=_invalid_constant)
                except ValueError:
                    _fail("InvalidMcpJson", "Invalid MCP JSON response")
                if not isinstance(message, dict):
                    _fail("InvalidMcpMessage", "Invalid MCP message")
                if message.get("id") != request_id:
                    continue
                if "error" in message:
                    _fail("McpProtocolError", "MCP protocol request failed")
                if "result" not in message:
                    _fail("InvalidMcpResponse", "MCP response is missing its result")
                return message["result"]

        stderr_task = asyncio.create_task(drain_stderr())
        async def bounded_call(*args):
            task = asyncio.create_task(call(*args))
            deadline = asyncio.get_running_loop().time() + timeout_ms / 1000
            try:
                done, _ = await asyncio.wait([task, stderr_task], timeout=timeout_ms / 1000, return_when=asyncio.FIRST_COMPLETED)
                if stderr_task in done:
                    stderr_task.result()
                    # Closed stderr is not necessarily a failed server.
                    return await asyncio.wait_for(task, max(0, deadline - asyncio.get_running_loop().time()))
                if task in done:
                    return task.result()
                _fail("McpRequestTimeout", "MCP request timed out")
            finally:
                if not task.done():
                    task.cancel()
                    await asyncio.gather(task, return_exceptions=True)
        try:
            await bounded_call(1, "initialize", {"protocolVersion": "2025-06-18", "capabilities": {},
                "clientInfo": {"name": "touba-mcp-bridge", "version": "1.0.0"}})
            await send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
            result = await bounded_call(2, "tools/call", {"name": mcp_tool_name, "arguments": request})
            if not isinstance(result, dict):
                _fail("InvalidMcpToolResult", "MCP result must be an object")
            if result.get("isError") is True:
                _fail("McpToolExecutionError", "MCP tool returned an execution error")
            if isinstance(result.get("structuredContent"), dict):
                return result["structuredContent"]
            parts = []
            content = result.get("content", [])
            if not isinstance(content, list):
                _fail("InvalidMcpToolResult", "MCP content must be an array")
            for item in content:
                if not isinstance(item, dict) or (item.get("type") == "text" and not isinstance(item.get("text"), str)):
                    _fail("InvalidMcpToolResult", "Invalid MCP text content")
                if item.get("type") != "text":
                    _fail("UnsupportedMcpContent", "Only MCP text content is supported")
                parts.append(item["text"])
            text = "\n".join(parts)
            for secret in secrets:
                text = text.replace(secret, "[REDACTED]")
            if len(text.encode("utf-16-le")) // 2 > max_text:
                _fail("McpResultTooLarge", "MCP text exceeded result limit")
            return {"content": text}
        except (asyncio.TimeoutError, BrokenPipeError, ConnectionResetError) as error:
            _fail("McpRequestTimeout" if isinstance(error, asyncio.TimeoutError) else "McpServerClosed", "MCP transport interrupted")
        finally:
            child.stdin.close()
            try:
                await asyncio.wait_for(child.wait(), 0.2)
            except asyncio.TimeoutError:
                child.kill(); await child.wait()
            stderr_task.cancel(); await asyncio.gather(stderr_task, return_exceptions=True)
    return bridge
