"""Model adapters sharing the installed JS SDK contracts, without a new runtime.

Python options use snake_case. Runtime requests, decisions, model-generation
messages and provider-specific dictionaries keep their canonical wire keys.
"""
import asyncio
import inspect
from ._backend import MicroUnits, Remote
from .provider_errors import ToubaAgentDecisionProviderError


def _options(value, keys):
    unknown = set(value) - set(keys)
    if unknown:
        raise ToubaAgentDecisionProviderError("InvalidDecisionProviderOptions", "Unknown SDK option")
    return {keys[key]: item for key, item in value.items()}


COMMON = {"model": "model", "source": "source", "decision_interface": "decisionInterface",
          "temperature": "temperature", "max_retries": "maxRetries", "max_output_tokens": "maxOutputTokens",
          "allow_human_review": "allowHumanReview", "native_tool_choice": "nativeToolChoice",
          "system": "system", "instructions": "instructions", "provider_options": "providerOptions",
          "history": "history", "context": "context", "max_provider_request_bytes": "maxProviderRequestBytes"}
HISTORY = {"store": "store", "namespace": "namespace", "max_bytes": "maxBytes", "max_messages": "maxMessages",
           "max_retained_bytes": "maxRetainedBytes", "max_summary_bytes": "maxSummaryBytes", "summarize": "summarize",
           "on_event": "onEvent", "max_sessions": "maxSessions", "max_store_bytes": "maxStoreBytes", "ttl_ms": "ttlMs"}
CONTEXT = {"context_window_tokens": "contextWindowTokens", "safety_margin_tokens": "safetyMarginTokens",
           "input_token_multiplier": "inputTokenMultiplier", "timeout_ms": "timeoutMs", "on_event": "onEvent"}
HTTP = {"base_url": "baseURL", "api_key_env_names": "apiKeyEnvNames", "organization": "organization",
        "project": "project", "headers": "headers", "token_cost": "tokenCost",
        "fetch": "fetch", "count_fetch": "countFetch"}


def _provider(kind, options, extra):
    normalized = _options(options, {**COMMON, **extra})
    if isinstance(normalized.get("history"), dict):
        normalized["history"] = _options(normalized["history"], HISTORY)
    if isinstance(normalized.get("context"), dict):
        normalized["context"] = _options(normalized["context"], CONTEXT)
    return Remote(kind, normalized)


def create_ai_sdk_decision_provider(**options):
    # Python generation callbacks consume a portable JSON schema, not a JS
    # validation object containing functions and symbols.
    options.setdefault("json_schema", lambda schema: schema)
    return _provider("ai", options, {"generate_text": "generateText", "generate_object": "generateObject",
                                     "json_schema": "jsonSchema", "response_protocol": "responseProtocol"})


def create_open_ai_decision_provider(**options):
    return _provider("openai", options, HTTP)


def create_ollama_decision_provider(**options):
    return _provider("ollama", options, {key: value for key, value in HTTP.items() if key != "token_cost"})


def create_provider_token_cost_adapter(*, protocol, model, tariff, input_token_bound, budget, max_body_bytes=8388608, counting=None):
    """Host-owned tariff; return the token_cost configuration of an HTTP factory.

    input_token_bound receives {url, method, headers, body}; return
    {basis: "upper_bound", tokens: n}, never an estimate dressed as a bound.
    Rates are integer micro-units per million tokens, not floating-point prices.
    """
    if not isinstance(tariff, dict) or not isinstance(tariff.get("rates"), dict) or not callable(input_token_bound):
        raise ToubaAgentDecisionProviderError("InvalidProviderBudgetOptions", "Tariff rates and a complete-input upper bound are required")
    if counting is not None and (not isinstance(counting, dict) or set(counting) != {"quote", "read_usage"}
                                 or not all(callable(value) for value in counting.values())):
        raise ToubaAgentDecisionProviderError("InvalidProviderBudgetOptions", "Counting requires explicit quote and read_usage callbacks")
    prices = _options(tariff["rates"], {"input": "input", "output": "output", "cache_read": "cacheRead",
                                      "cache_write_5m": "cacheWrite5m", "cache_write_1h": "cacheWrite1h"})
    if any(type(rate) is not int or rate < 0 for rate in prices.values()):
        raise ToubaAgentDecisionProviderError("InvalidProviderBudgetOptions", "Rates require nonnegative integer micro-units")
    async def count_quote(request):
        result = counting["quote"](request)
        result = await result if inspect.isawaitable(result) else result
        value = _options(result, {"basis":"basis", "max_cost_micros":"maxCostMicros", "currency":"currency", "tariff_id":"tariffId", "tariff_date":"tariffDate"})
        if type(value.get("maxCostMicros")) is not int:
            raise ToubaAgentDecisionProviderError("ProviderCostBoundUnavailable", "Counting bound requires integer micro-units")
        value["maxCostMicros"] = MicroUnits(value["maxCostMicros"])
        return value

    async def count_usage(response, quote):
        result = counting["read_usage"](response, {"basis":quote["basis"], "max_cost_micros":int(quote["maxCostMicros"]),
            "currency":quote["currency"], "tariff_id":quote["tariffId"], "tariff_date":quote["tariffDate"]})
        result = await result if inspect.isawaitable(result) else result
        value = _options(result, {"kind":"kind", "cost_micros":"costMicros"})
        if "costMicros" in value:
            if type(value["costMicros"]) is not int:
                raise ToubaAgentDecisionProviderError("ProviderCostUsageInvalid", "Counting usage requires integer micro-units")
            value["costMicros"] = MicroUnits(value["costMicros"])
        return value

    return {"protocol": protocol, "model": model, "tariff": {**tariff, "rates": {key: MicroUnits(rate) for key, rate in prices.items()}},
            "inputTokenBound": input_token_bound, "budget": budget._provider_backend_options(), "maxBodyBytes": max_body_bytes,
            **({"counting": {"quote": count_quote, "readUsage": count_usage}} if counting is not None else {})}


class DecisionHistoryStore(Remote):
    def read(self, key):
        return self.call("read", key).result(timeout=181)

    def delete(self, key):
        return self.call("delete", key).result(timeout=181)

    async def transact(self, key, operation):
        return await asyncio.wrap_future(self.call("transact", key, operation))

    def recover(self, key, *, worker_stopped=False):
        return self.call("recover", key, {"workerStopped": worker_stopped}).result(timeout=181)


def create_memory_decision_history_store(**options):
    return DecisionHistoryStore("memory", _options(options, {"max_sessions": "maxSessions", "max_bytes": "maxBytes", "ttl_ms": "ttlMs"}))
