"""Python clients of the Touba CLI admission path, not a second runtime."""
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from .package_resources import resolve_package_resource, PackageDependencyError
    from .engine import AsyncToubaEngine, ToubaEngine, ToubaEngineError, CompileResult, RunOptions, RunResult, touba_sdk_metadata
    from .handlers import (ToubaHandlerError, ToolResult, TOOL_HANDLER_PROTOCOL_VERSION,
                           create_tool_handler, create_tool_result, handle_tool_request,
                           define_tool, create_effect_receipt, create_compensation_receipt)
    from .provider_errors import ToubaAgentDecisionProviderError
    from .mcp import create_mcp_stdio_tool_bridge, MCP_BRIDGE_CONFIG_VERSION
    from .providers import (create_ai_sdk_decision_provider, create_open_ai_decision_provider,
                            create_ollama_decision_provider, create_memory_decision_history_store,
                            create_provider_token_cost_adapter)

__all__ = ["AsyncToubaEngine", "ToubaEngine", "ToubaEngineError", "CompileResult", "RunOptions", "RunResult", "touba_sdk_metadata",
           "ToubaHandlerError", "ToolResult", "TOOL_HANDLER_PROTOCOL_VERSION", "create_tool_handler",
           "create_tool_result", "handle_tool_request", "define_tool", "create_effect_receipt",
           "create_compensation_receipt", "ToubaAgentDecisionProviderError",
           "create_ai_sdk_decision_provider", "create_open_ai_decision_provider", "create_ollama_decision_provider",
           "create_memory_decision_history_store", "create_provider_token_cost_adapter",
           "create_mcp_stdio_tool_bridge", "MCP_BRIDGE_CONFIG_VERSION", "resolve_package_resource", "PackageDependencyError"]

_MODULE_EXPORTS = {
    "package_resources": ["resolve_package_resource", "PackageDependencyError"],
    "engine": ["AsyncToubaEngine", "ToubaEngine", "ToubaEngineError", "CompileResult", "RunOptions", "RunResult", "touba_sdk_metadata"],
    "handlers": ["ToubaHandlerError", "ToolResult", "TOOL_HANDLER_PROTOCOL_VERSION", "create_tool_handler",
                 "create_tool_result", "handle_tool_request", "define_tool", "create_effect_receipt", "create_compensation_receipt"],
    "provider_errors": ["ToubaAgentDecisionProviderError"],
    "providers": ["create_ai_sdk_decision_provider", "create_open_ai_decision_provider", "create_ollama_decision_provider",
                  "create_memory_decision_history_store", "create_provider_token_cost_adapter"],
    "mcp": ["create_mcp_stdio_tool_bridge", "MCP_BRIDGE_CONFIG_VERSION"],
}
_EXPORT_MODULE = {name: module for module, names in _MODULE_EXPORTS.items() for name in names}


def __getattr__(name: str):
    """Preserve the public API while loading only the requested integration."""
    module = _EXPORT_MODULE.get(name)
    if module is None:
        raise AttributeError(f"module {__name__!r} has no attribute {name!r}")
    from importlib import import_module
    value = getattr(import_module(f".{module}", __name__), name)
    globals()[name] = value
    return value


def __dir__():
    return sorted(set(globals()) | set(__all__))
