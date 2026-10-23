"""Private, bounded process transport for explicitly trusted Python modules."""
import asyncio
from concurrent.futures import ThreadPoolExecutor
import importlib.util
import inspect
import json
from pathlib import Path
import sys
import threading
from .provider_errors import ToubaAgentDecisionProviderError, provider_diagnostic_details
from ._host_context import execution_context

MAX_BYTES = 8 * 1024 * 1024


def main():
    output = sys.stdout.buffer
    sys.stdout = sys.stderr  # Module prints never corrupt the private channel.
    lock, active, event_waiters = threading.Lock(), threading.BoundedSemaphore(32), {}
    event_next = 0

    def send(value):
        data = (json.dumps(value, ensure_ascii=False, allow_nan=False) + "\n").encode()
        if len(data) > MAX_BYTES:
            raise ValueError("payload limit")
        with lock:
            output.write(data); output.flush()

    filename = Path(sys.argv[1]).resolve()
    sys.path.insert(0, str(filename.parent))  # Explicitly trusted host imports.
    spec = importlib.util.spec_from_file_location("touba_application_host", filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    decide = getattr(module, "decide_agent_capability", getattr(module, "decide", None))
    attest = getattr(module, "attest_human_approval", None)
    resolve_initiator = getattr(module, "resolve_initiator", None)

    def record_cost(request_id, value, event="provider_cost"):
        nonlocal event_next
        with lock:
            event_next += 1
            event_id = event_next
            state = {"event": threading.Event(), "accepted": False}
            event_waiters[event_id] = state
        try:
            send({"protocol": "touba-python-host-v1", "id": request_id, "event": event, "event_id": event_id, "value": value})
            if not state["event"].wait(180):
                raise ToubaAgentDecisionProviderError("PythonHostTimeout", "host evidence response timed out")
            return state["accepted"]
        finally:
            with lock:
                event_waiters.pop(event_id, None)

    def perform(message):
        request_id = message["id"]
        token = execution_context.set(lambda value, event="provider_cost": record_cost(request_id, value, event))
        try:
            if message["method"] == "describe":
                result = {"decide": callable(decide), "attest": callable(attest),
                          "resolve_initiator": callable(resolve_initiator),
                          "initiator_ref": getattr(module, "initiator_ref", None),
                          "initial_modes": getattr(module, "initial_modes", None),
                          "provider_metadata": getattr(module, "provider_metadata", None)}
            else:
                function = {"decide": decide, "attest": attest, "resolve_initiator": resolve_initiator}.get(message["method"])
                if not callable(function):
                    raise ValueError("host function unavailable")
                result = function(message["request"])
                if inspect.isawaitable(result):
                    result = asyncio.run(result)
            send({"protocol": "touba-python-host-v1", "id": request_id, "result": result})
        except BaseException as error:
            code = error.code if isinstance(error, ToubaAgentDecisionProviderError) else "PythonHostUnavailable"
            send({"protocol": "touba-python-host-v1", "id": request_id, "error": {"code": code,
                "details": provider_diagnostic_details(getattr(error, "details", None))}})
        finally:
            execution_context.reset(token)
            active.release()

    executor = ThreadPoolExecutor(max_workers=32)
    try:
        while True:
            raw = sys.stdin.buffer.readline(MAX_BYTES + 1)
            if not raw:
                break
            if len(raw) > MAX_BYTES or not raw.endswith(b"\n"):
                raise ValueError("payload limit")
            message = json.loads(raw)
            if message.get("protocol") != "touba-python-host-v1":
                raise ValueError("protocol mismatch")
            if "event_reply" in message:
                with lock:
                    state = event_waiters.get(message["event_reply"])
                    if state is None or type(message.get("accepted")) is not bool:
                        raise ValueError("unknown event")
                    state["accepted"] = message["accepted"]; state["event"].set()
            elif type(message.get("id")) is int and active.acquire(blocking=False):
                executor.submit(perform, message)
            else:
                raise ValueError("concurrency limit")
    finally:
        from ._backend import close_backend
        close_backend()
        with lock:
            for state in event_waiters.values():
                state["event"].set()
        executor.shutdown(wait=False, cancel_futures=True)


if __name__ == "__main__":
    try:
        main()
    except BaseException:
        sys.exit(1)  # No raw module exception or credential on stdout/stderr.
