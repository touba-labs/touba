from contextvars import ContextVar

# Trusted execution channel, never attached to a provider/model request.
execution_context = ContextVar("touba_host_execution", default=None)
