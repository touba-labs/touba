"""Provider diagnostics shared by host adapters, never a second runtime."""


def provider_diagnostic_details(value):
    """Only non-content, bounded provider diagnostics cross the bridge."""
    if not isinstance(value, dict):
        return {}
    result = {}
    status = value.get("http_status")
    if type(status) is int and 100 <= status <= 599:
        result["http_status"] = status
    for key, allowed in (
        ("finish_reason", ("stop", "length", "content-filter", "tool-calls", "error", "other", "unknown")),
        ("incomplete_reason", ("max_output_tokens", "content_filter", "unknown")),
    ):
        if value.get(key) in allowed:
            result[key] = value[key]
    return result


class ToubaAgentDecisionProviderError(Exception):
    def __init__(self, code: str, message: str, details=None):
        super().__init__(message)
        self.code = code
        self.details = provider_diagnostic_details(details)
