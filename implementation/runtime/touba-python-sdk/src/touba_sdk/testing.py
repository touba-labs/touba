"""Explicit test proposals and assertions; never grant authority or invent success."""
from copy import deepcopy
import inspect
from .engine import ToubaEngineError
from .handlers import create_effect_receipt


def assert_effect_receipt(response, effect, outcome):
    """Check a test receipt; this does not prove a provider performed the effect."""
    if type(response) is not dict or type(response.get("ok")) is not bool:
        raise AssertionError("Expected a handler response")
    receipt = response.get("effect_receipt")
    if type(receipt) is not dict or receipt.get("outcome") != outcome:
        raise AssertionError("Expected an effect receipt with the selected outcome")
    options = {key: value for key, value in receipt.items() if key not in ("effect_id", "request_digest")}
    if receipt != create_effect_receipt(effect, options):
        raise AssertionError("Receipt must match the exact effect request")
    return receipt


class ScriptedDecisionProvider:
    def __init__(self, steps):
        if not isinstance(steps, list) or not steps:
            raise ValueError("Decision steps must be a non-empty list")
        self._steps = []
        for step in steps:
            if (type(step) is not dict or set(step) != {"expect", "decision"}
                or type(step["expect"]) is not dict or set(step["expect"]) - {"mode", "agent_ref", "step_index"}
                or not (callable(step["decision"]) or type(step["decision"]) is dict)):
                raise ValueError("Each step needs explicit expectations and a decision object or callable")
            self._steps.append({"expect": deepcopy(step["expect"]), "decision": deepcopy(step["decision"])})
        self._cursor = 0
        self._calls = []

    async def __call__(self, request):
        if self._cursor >= len(self._steps):
            raise AssertionError("Scripted decision provider exhausted")
        step = self._steps[self._cursor]
        for key, expected in step["expect"].items():
            if request.get(key) != expected:
                raise AssertionError(f"Unexpected decision routing field {key} at step {self._cursor}")
        self._cursor += 1
        self._calls.append({key: request.get(key) for key in ("mode", "agent_ref", "step_index")})
        decision = step["decision"](request) if callable(step["decision"]) else step["decision"]
        if inspect.isawaitable(decision):
            decision = await decision
        return deepcopy(decision)

    @property
    def calls(self):
        return deepcopy(self._calls)

    def assert_consumed(self):
        if self._cursor != len(self._steps):
            raise AssertionError("Unused scripted decision steps")


def create_scripted_decision_provider(steps):
    return ScriptedDecisionProvider(steps)


def _field(value, name):
    return value.get(name) if isinstance(value, dict) else getattr(value, name, None)


def assert_run_succeeded(result, expected_value):
    if _field(result, "status") != "success" or _field(result, "reason") != "completed" or _field(result, "result") != expected_value:
        raise AssertionError("Expected runtime completion with the exact business result")
    return result


async def assert_run_refused(run, expected_code):
    if not callable(run) or not isinstance(expected_code, str) or not expected_code:
        raise ValueError("Provide a run callable and an exact refusal code")
    try:
        value = run()
        if inspect.isawaitable(value):
            await value
    except ToubaEngineError as error:
        if error.phase == "run" and error.details.get("status") == "failure" and error.details.get("reason") == expected_code:
            return {"status": "failure", "reason": expected_code, "trace": error.details.get("trace")}
        raise AssertionError("Expected a runtime refusal, not a launch/compile failure or another code") from error
    raise AssertionError("Expected a runtime refusal")


def assert_trace_events(trace, *, kind, count, where=lambda event: True):
    if type(trace) is not dict or not isinstance(trace.get("events"), list) or not isinstance(kind, str) or not kind or type(count) is not int or count < 0 or not callable(where):
        raise ValueError("Provide a native trace, event kind, exact non-negative count and synchronous filter")
    selected = []
    for event in trace["events"]:
        if event.get("kind") != kind:
            continue
        match = where(event)
        if type(match) is not bool:
            if inspect.iscoroutine(match):
                match.close()
            raise ValueError("Event filter must return a synchronous boolean")
        if match:
            selected.append(event)
    if len(selected) != count:
        raise AssertionError(f"Unexpected event count for {kind}")
    return selected
