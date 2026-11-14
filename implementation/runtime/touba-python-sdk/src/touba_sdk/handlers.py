"""Python handlers for the same governed process protocol as the JavaScript SDK.

The Core owns admission and structural type checks. These helpers validate the
wire envelope and receipts; they never grant capabilities or retry an effect.
"""
from __future__ import annotations

from copy import deepcopy
from dataclasses import dataclass
import hashlib
import inspect
import json
import math
import os
import re
import sys
import traceback
from typing import Any, Callable, Mapping

TOOL_HANDLER_PROTOCOL_VERSION = "touba-tool-handler-v1"
_DIGEST = re.compile(r"sha256:[0-9a-f]{64}\Z")
_EFFECT = re.compile(r"effect:sha256:[0-9a-f]{64}\Z")
_COMPENSATION = re.compile(r"compensation:sha256:[0-9a-f]{64}\Z")
_MISSING = object()


class ToubaHandlerError(Exception):
    """An intentionally public error. Never put credentials in its message."""
    def __init__(self, code: str, message: str, details: Mapping[str, Any] | None = None):
        super().__init__(message)
        self.code = code
        self.details = dict(details or {})


def _error(code, message):
    raise ToubaHandlerError(code, message)


def _configuration(value):
    def fail():
        _error("HandlerConfigurationInvalid", "invalid handler configuration")
    if type(value) is not dict or len(value) > 64:
        fail()
    for key, item in value.items():
        if not isinstance(key, str) or not re.fullmatch(r"[A-Za-z][A-Za-z0-9_]{0,63}", key) or key in ("constructor", "prototype"):
            fail()
        if type(item) is str:
            try:
                if "\0" in item or len(item.encode("utf-8")) > 4096:
                    fail()
            except UnicodeEncodeError:
                fail()
        elif type(item) is bool:
            pass
        elif type(item) in (int, float):
            if abs(item) > 9007199254740991 or not math.isfinite(item):
                fail()
        else:
            fail()
    size = 2 + sum(len(key) + 4 + (len(json.dumps(item, ensure_ascii=False).encode("utf-8")) if type(item) is str
                                  else 5 if type(item) is bool else 32) for key, item in value.items())
    if size > 16384:
        fail()
    return deepcopy(value)


def _object(value, fields, code):
    if type(value) is not dict or set(value) - set(fields):
        _error(code, "Invalid object or unknown fields")
    return value


def _text(value):
    return isinstance(value, str) and bool(value.strip())


def _matches(pattern, value):
    return isinstance(value, str) and pattern.fullmatch(value) is not None


def _strings(value, code="InvalidHandlerRequest", nonempty=False):
    if not isinstance(value, (list, tuple)) or any(not isinstance(item, str) or (nonempty and not item.strip()) for item in value):
        _error(code, "Expected a list of strings")
    return list(value)


def _effect(value):
    value = _object(value, ["effect_id", "attempt_index", "request_digest"], "InvalidEffect")
    if not _matches(_EFFECT, value.get("effect_id")) or not _matches(_DIGEST, value.get("request_digest")):
        _error("InvalidEffect", "Invalid effect identity or digest")
    attempt = value.get("attempt_index")
    if type(attempt) is not int or not 0 < attempt <= 9007199254740991:
        _error("InvalidEffect", "Attempt index must be a positive safe integer")
    return deepcopy(value)


def create_effect_receipt(effect: dict, receipt: dict) -> dict:
    effect = _effect(effect)
    receipt = _object(receipt, ["outcome", "receipt_ref", "receipt_digest"], "EffectReceiptInvalid")
    if receipt.get("outcome") not in ("applied", "not_applied", "unknown"):
        _error("EffectReceiptInvalid", "Invalid effect outcome")
    if "receipt_ref" in receipt and (not _text(receipt["receipt_ref"]) or len(receipt["receipt_ref"].encode("utf-16-le")) // 2 > 512):
        _error("EffectReceiptInvalid", "Receipt reference must be a bounded non-empty string")
    if "receipt_digest" in receipt and not _matches(_DIGEST, receipt["receipt_digest"]):
        _error("EffectReceiptInvalid", "Invalid receipt digest")
    return {"effect_id": effect["effect_id"], "request_digest": effect["request_digest"], **deepcopy(receipt)}


def _receipt(value, effect):
    if type(value) is not dict:
        _error("EffectReceiptRequired", "An effect receipt is required")
    _object(value, ["effect_id", "request_digest", "outcome", "receipt_ref", "receipt_digest"], "EffectReceiptInvalid")
    if value.get("effect_id") != effect["effect_id"] or value.get("request_digest") != effect["request_digest"]:
        _error("EffectReceiptInvalid", "Receipt does not match the effect request")
    return create_effect_receipt(effect, {key: val for key, val in value.items() if key not in ("effect_id", "request_digest")})


def _compensation(value):
    fields = ["compensation_id", "compensates_effect_id", "plan_digest", "execution_request_digest",
              "original_tool_ref", "original_request_digest", "original_effect_receipt_digest", "original_effect_receipt"]
    _object(value, fields, "InvalidCompensation")
    if not _matches(_COMPENSATION, value.get("compensation_id")) or not _matches(_EFFECT, value.get("compensates_effect_id")):
        _error("InvalidCompensation", "Invalid compensation identity")
    for field in ("plan_digest", "execution_request_digest", "original_request_digest", "original_effect_receipt_digest"):
        if not _matches(_DIGEST, value.get(field)):
            _error("InvalidCompensation", "Invalid compensation digest")
    if not _text(value.get("original_tool_ref")) or len(value["original_tool_ref"].encode("utf-16-le")) // 2 > 512:
        _error("InvalidCompensation", "Invalid original tool reference")
    original = value.get("original_effect_receipt")
    effect = {"effect_id": value["compensates_effect_id"], "request_digest": value["original_request_digest"], "attempt_index": 1}
    try:
        receipt = _receipt(original, effect)
        if receipt["outcome"] != "applied" or not _text(receipt.get("receipt_ref")):
            _error("InvalidCompensation", "Original applied receipt required")
    except ToubaHandlerError:
        _error("InvalidCompensation", "Original receipt is not correlated")
    canonical = json.dumps(receipt, sort_keys=True, ensure_ascii=False, separators=(",", ":"))
    if "sha256:" + hashlib.sha256(canonical.encode()).hexdigest() != value["original_effect_receipt_digest"]:
        _error("InvalidCompensation", "Original receipt digest mismatch")
    return deepcopy(value)


def create_compensation_receipt(compensation: dict, effect: dict, receipt: dict) -> dict:
    compensation = _compensation(compensation)
    effect = _effect(effect)
    _object(receipt, ["result"], "CompensationReceiptInvalid")
    if receipt.get("result") not in ("completed", "partial"):
        _error("CompensationReceiptInvalid", "Compensation result must be completed or partial")
    return {"compensation_id": compensation["compensation_id"],
            "compensates_effect_id": compensation["compensates_effect_id"],
            "inverse_effect_id": effect["effect_id"], "result": receipt["result"]}


def _memory(entries):
    fields = {"memory_ref", "operation", "source_kind", "source_ref", "integrity_evidence",
              "writer_ref", "written_at", "digest_kind", "digest", "schema_ref", "version_ref"}
    if not isinstance(entries, list):
        _error("MemoryMetadataInvalid", "Memory metadata must be a list")
    for entry in entries:
        _object(entry, fields, "MemoryMetadataInvalid")
        if any(not isinstance(value, str) for value in entry.values()) or not entry.get("memory_ref", "").startswith("memory:") or entry.get("operation") not in ("read", "write"):
            _error("MemoryMetadataInvalid", "Invalid memory provenance")


@dataclass(frozen=True)
class ToolResult:
    value: Any
    metadata: dict


def create_tool_result(value: Any, *, memory_metadata=_MISSING, effect_receipt=_MISSING, compensation_receipt=_MISSING) -> ToolResult:
    metadata = {}
    if memory_metadata is not _MISSING:
        _memory(memory_metadata)
        metadata["memory_metadata"] = deepcopy(memory_metadata)
    for name, item in (("effect_receipt", effect_receipt), ("compensation_receipt", compensation_receipt)):
        if item is not _MISSING:
            metadata[name] = deepcopy(item)
    return ToolResult(value, metadata)


def _definition(tool_ref, run, input_signature, output_type, required_grants, required_secret_handles):
    if not _text(tool_ref) or not callable(run) or (output_type is not None and not _text(output_type)):
        _error("InvalidToolDefinition", "Tool reference, callable run and valid output type required")
    if not isinstance(input_signature, (list, tuple)):
        _error("InvalidToolDefinition", "Input signature must be a list")
    names = set()
    for item in input_signature:
        _object(item, ["name", "type_ref"], "InvalidToolDefinition")
        if not _text(item.get("name")) or not _text(item.get("type_ref")) or item["name"] in names:
            _error("InvalidToolDefinition", "Unique input names and type references required")
        names.add(item["name"])
    _strings(required_grants, "InvalidToolDefinition", True)
    _strings(required_secret_handles, "InvalidToolDefinition", True)


def create_tool_handler(*, tool_ref: str, run: Callable, input_signature=(), output_type=None,
                        required_grants=(), required_secret_handles=()) -> Callable:
    _definition(tool_ref, run, input_signature, output_type, required_grants, required_secret_handles)
    signature = deepcopy(input_signature)

    async def handler(envelope):
        arguments = envelope.get("arguments", {})
        request = arguments.get(signature[0]["name"]) if len(signature) == 1 else arguments
        context = {**envelope, "tool_ref": tool_ref, "input_signature": deepcopy(signature), "output_type": output_type}
        value = run(request=request, context=context)
        return await value if inspect.isawaitable(value) else value
    return handler


def _envelope(request, tool_ref, required_grants, required_secret_handles):
    if type(request) is not dict:
        _error("InvalidHandlerRequest", "Handler request must be an object")
    if request.get("protocol") != TOOL_HANDLER_PROTOCOL_VERSION:
        _error("InvalidProtocol", "Unsupported handler protocol")
    if request.get("operation") not in ("invoke", "compensate"):
        _error("InvalidHandlerOperation", "Operation must be invoke or compensate")
    if request.get("tool_ref") != tool_ref:
        _error("InvalidToolRef", "Unexpected tool reference")
    if "arguments" in request and type(request["arguments"]) is not dict:
        _error("InvalidArguments", "Arguments must be an object")
    grants = _strings(request.get("grants", []))
    secrets = _strings(request.get("secret_handles", []))
    if any(grant not in grants for grant in required_grants):
        _error("MissingGrant", "Required grant missing from handler request")
    if any(handle not in secrets for handle in required_secret_handles):
        _error("MissingSecretHandle", "Required secret handle missing from handler request")
    _object(request, ["protocol", "operation", "tool_ref", "call_id", "arguments", "grants", "memory_accesses",
                      "resource_bindings", "secret_handles", "limits", "effect", "compensation", "execution_context", "configuration"],
            "InvalidCompensation" if request["operation"] == "compensate" else "InvalidHandlerRequest")
    if "execution_context" in request:
        context = request["execution_context"]
        def identity(value):
            return isinstance(value, str) and 0 < len(value) <= 1024 and not any(ord(c) < 32 or ord(c) == 127 for c in value)
        if (type(context) is not dict or set(context) != {"run_id", "caller_ref", "agent_ref", "agent_invocation_id"}
                or not identity(context["run_id"])
                or any(context[key] is not None and not identity(context[key]) for key in ("caller_ref", "agent_ref", "agent_invocation_id"))
                or (context["agent_ref"] is None and context["agent_invocation_id"] is not None)):
            _error("InvalidHandlerRequest", "Invalid runtime execution context")
    if request["operation"] == "compensate":
        return _effect(request.get("effect")), _compensation(request.get("compensation"))
    if "compensation" in request:
        _error("InvalidCompensation", "Invoke cannot carry a compensation envelope")
    return (_effect(request["effect"]) if "effect" in request else None), None


def _success(value, effect, compensation):
    if isinstance(value, ToolResult):
        if effect is None:
            if set(value.metadata) - {"memory_metadata"}:
                _error("InvalidToolResult", "Receipts require a governed effect request")
            return {"ok": True, "value": value.value, **deepcopy(value.metadata)}
        value = {"value": value.value, **deepcopy(value.metadata)}
    if effect is None:
        return {"ok": True, "value": value}
    code = "CompensationReceiptRequired" if compensation is not None else "EffectReceiptRequired"
    fields = ["value", "effect_receipt", "memory_metadata"] + (["compensation_receipt"] if compensation is not None else [])
    _object(value, fields, code)
    if "value" not in value:
        _error(code, "Value and correlated receipts required")
    receipt = _receipt(value.get("effect_receipt"), effect)
    response = {"ok": True, "value": value["value"], "effect_receipt": receipt}
    if "memory_metadata" in value:
        _memory(value["memory_metadata"])
        response["memory_metadata"] = deepcopy(value["memory_metadata"])
    if compensation is not None:
        if receipt["outcome"] != "applied":
            _error("CompensationReceiptInvalid", "Successful compensation requires an applied effect receipt")
        actual = value.get("compensation_receipt")
        if type(actual) is not dict:
            _error("CompensationReceiptRequired", "Compensation receipt required")
        expected = create_compensation_receipt(compensation, effect, {"result": actual.get("result")})
        if actual != expected:
            _error("CompensationReceiptInvalid", "Compensation receipt does not match the request")
        response["compensation_receipt"] = expected
    return response


def _diagnostic(error):
    if os.environ.get("TOUBA_LOCAL_DIAGNOSTIC_FD") != "3":
        return
    try:
        sources = json.loads(os.environ.get("TOUBA_LOCAL_DIAGNOSTIC_SOURCES", "[]"))
        if not isinstance(sources, list) or len(sources) > 8:
            return
        classes = (PermissionError, FileNotFoundError, ModuleNotFoundError, ImportError,
                   OSError, TypeError, SyntaxError, ValueError, RuntimeError)
        error_class = next((kind.__name__ for kind in classes if isinstance(error, kind)),
                           "ReferenceError" if isinstance(error, NameError) else "Error")
        data = {"error_class": error_class}
        for frame in reversed(traceback.extract_tb(error.__traceback__, limit=32)):
            found = next((source for source in sources if type(source) is dict and source.get("path") == frame.filename and type(source.get("index")) is int), None)
            if found:
                data.update(handler_arg_index=found["index"], line=frame.lineno, column=(frame.colno or 0) + 1)
                break
        os.write(3, (json.dumps(data) + "\n").encode())
    except (OSError, ValueError, TypeError, AttributeError):
        pass  # Optional diagnostics never change the governed result.


async def handle_tool_request(raw_input: str, expected_tool_ref: str, handler: Callable,
                              *, required_grants=(), required_secret_handles=()) -> dict:
    effect = compensation = None
    try:
        try:
            request = json.loads(raw_input, parse_constant=lambda _: _error("InvalidHandlerJson", "Non-finite JSON value"))
        except (ValueError, TypeError):
            _error("InvalidHandlerJson", "Handler request must be valid JSON")
        effect, compensation = _envelope(request, expected_tool_ref, required_grants, required_secret_handles)
        configuration = _configuration(request["configuration"]) if "configuration" in request else None
        envelope = {"request": request, "raw_input": raw_input, "arguments": request.get("arguments", {}),
                    "grants": request.get("grants", []), "memory_accesses": request.get("memory_accesses", []),
                    "execution_context": deepcopy(request.get("execution_context")),
                    "configuration": configuration,
                    "resource_bindings": request.get("resource_bindings", []), "secret_handles": request.get("secret_handles", []),
                    "limits": request.get("limits", {}), "env": dict(os.environ),
                    "effect": deepcopy(effect), "compensation": deepcopy(compensation),
                    "create_effect_receipt": (lambda receipt: create_effect_receipt(effect, receipt)) if effect else None,
                    "create_compensation_receipt": (lambda receipt: create_compensation_receipt(compensation, effect, receipt)) if compensation else None}
        value = handler(envelope)
        if inspect.isawaitable(value):
            value = await value
        response = _success(value, effect, compensation)
        json.dumps(response, allow_nan=False)  # Refuse non-wire results before writing stdout.
        return response
    except Exception as error:
        _diagnostic(error)
        code = error.code if isinstance(error, ToubaHandlerError) else "UnhandledHandlerError"
        message = str(error) if isinstance(error, ToubaHandlerError) else "Handler failed; reproduce in a local business test and use ToubaHandlerError for safe diagnostics"
        response = {"ok": False, "error": {"code": code, "message": message}}
        if effect and isinstance(error, ToubaHandlerError) and "effect_receipt" in error.details:
            try:
                receipt = _receipt(error.details["effect_receipt"], effect)
                if compensation and receipt["outcome"] == "applied":
                    _error("CompensationReceiptInvalid", "Compensation errors require not_applied or unknown outcome")
                response["effect_receipt"] = receipt
            except ToubaHandlerError as invalid:
                response["error"] = {"code": invalid.code, "message": str(invalid)}
        return response


async def define_tool(*, tool_ref: str, run: Callable, input_signature=(), output_type=None,
                      required_grants=(), required_secret_handles=()) -> None:
    handler = create_tool_handler(tool_ref=tool_ref, run=run, input_signature=input_signature, output_type=output_type,
                                  required_grants=required_grants, required_secret_handles=required_secret_handles)
    response = await handle_tool_request(sys.stdin.read(), tool_ref, handler,
                                        required_grants=required_grants, required_secret_handles=required_secret_handles)
    sys.stdout.write(json.dumps(response, ensure_ascii=False, allow_nan=False))
    sys.stdout.flush()
