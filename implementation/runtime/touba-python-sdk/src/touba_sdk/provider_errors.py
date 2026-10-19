"""Provider diagnostics shared by host adapters, never a second runtime."""


class ToubaAgentDecisionProviderError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code
