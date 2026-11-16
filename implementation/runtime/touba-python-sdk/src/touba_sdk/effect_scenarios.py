"""Explicit author-test assertions, not provider certification or automatic retries."""
import re
from .handlers import create_effect_receipt


def _check(condition, message):
    # Keep checks enabled under python -O, like the other public test helpers.
    if not condition:
        raise AssertionError(message)


def _fields(value, required, optional=()):
    _check(type(value) is dict, "Expected a scenario object")
    _check(set(required) <= set(value) <= set(required) | set(optional), "Unexpected or missing scenario field")


def _counts(value, calls, writes):
    _fields(value, ("calls", "writes"))
    _check(type(value["calls"]) is int and type(value["writes"]) is int, "Service counters must be integers")
    _check(value == {"calls": calls, "writes": writes}, "Unexpected requests or committed writes observed by the test service")


def assert_effect_scenario(scenario, observations):
    """Check service and reopened-journal observations from one synthetic experiment.

    The caller executes the test in isolation and supplies its observations.
    This function performs no I/O, grants nothing and never retries an effect.
    """
    _fields(scenario, ("schema_version", "id", "tool_ref", "case"))
    _check(scenario["schema_version"] == "touba-effect-scenario-v1", "Unsupported scenario schema")
    _check(type(scenario["id"]) is str and re.fullmatch(r"[a-z][a-z0-9-]{0,79}", scenario["id"]), "Invalid scenario id")
    _check(type(scenario["tool_ref"]) is str and re.fullmatch(r"tool:[a-z_][a-z0-9_.]*/[A-Za-z_][A-Za-z0-9_]*", scenario["tool_ref"]), "Invalid tool reference")
    case = scenario["case"]
    _check(type(case) is str and case in ("duplicate", "lost_reply", "reconciliation_required"), "Unsupported effect scenario")
    _fields(observations, ("before", "runs"))
    _counts(observations["before"], 0, 0)
    _check(type(observations["runs"]) is list and len(observations["runs"]) == 3, "Observe execution, reopen/resume, then reopen/replay")
    identity, evidence = None, []
    for index, run in enumerate(observations["runs"]):
        _fields(run, ("status", "reason", "effect", "service"))
        effect = run["effect"]
        _fields(effect, ("tool_ref", "effect_id", "request_digest", "state", "attempt_count"), ("receipt",))
        _check(effect["tool_ref"] == scenario["tool_ref"], "Effect belongs to another tool")
        _check(type(effect["effect_id"]) is str and re.fullmatch(r"effect:sha256:[a-f0-9]{64}", effect["effect_id"]), "Invalid effect identity")
        _check(type(effect["request_digest"]) is str and re.fullmatch(r"sha256:[a-f0-9]{64}", effect["request_digest"]), "Invalid request digest")
        current = (effect["effect_id"], effect["request_digest"])
        identity = identity or current
        _check(identity == current, "Replay must retain exact effect identity and arguments")
        interrupted = case != "duplicate" and index == 0
        applied = not interrupted and case != "reconciliation_required"
        calls = 2 if case == "lost_reply" and index > 0 else 1
        _check(type(effect["attempt_count"]) is int and effect["attempt_count"] == calls, "Unexpected handler dispatch count")
        _counts(run["service"], calls, 1)
        _check(run["status"] == ("success" if applied else "failure"), "Unexpected run status")
        _check(effect["state"] == ("applied" if applied else "unknown"), "Unexpected effect state")
        if interrupted:
            _check(type(run["reason"]) is str and run["reason"] in ("ToolHandlerTimeout", "ToolHandlerReportedError", "ToolHandlerNonZeroExit", "EffectReceiptInvalid"), "Expected a post-dispatch interruption")
        else:
            _check(run["reason"] == ("completed" if applied else "EffectReconciliationRequired"), "Unexpected completion or refusal")
        if applied:
            receipt = effect.get("receipt")
            _check(type(receipt) is dict and receipt.get("outcome") == "applied", "Missing applied receipt")
            options = {key: value for key, value in receipt.items() if key not in ("effect_id", "request_digest")}
            _check(receipt == create_effect_receipt({"effect_id": effect["effect_id"], "request_digest": effect["request_digest"],
                "attempt_index": effect["attempt_count"]}, options), "Receipt must match the observed effect")
        else:
            _check("receipt" not in effect, "Interrupted scenario must preserve uncertainty")
        evidence.append({"status": run["status"], "reason": run["reason"], "state": effect["state"], "calls": calls, "writes": 1})
    return {"schema_version": "touba-effect-scenario-result-v1", "scenario": dict(scenario),
            "scope": "author_test_synthetic_service", "status": "passed", "observations": evidence}
