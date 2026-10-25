"""Validation of Core trace references/pages; no database access in the SDK."""
import hashlib
import json
import re


def _json(value):
    return json.dumps(value, ensure_ascii=False, separators=(",", ":"), allow_nan=False).encode("utf-8")


def _digest(value):
    return "sha256:" + hashlib.sha256(_json(value)).hexdigest()


def _sha(value):
    return isinstance(value, str) and re.fullmatch(r"sha256:[a-f0-9]{64}", value) is not None


def _integer(value):
    return type(value) is int and abs(value) <= 9007199254740991


def validate_reference(value):
    fields = {"schema_version", "segment_id", "run_id", "start_index", "event_count", "header_digest", "trace_digest", "terminal"}
    if not isinstance(value, dict) or set(value) != fields:
        raise ValueError("InvalidTraceReference")
    start, count, terminal = value["start_index"], value["event_count"], value["terminal"]
    if (value["schema_version"] != "touba-trace-reference-v1" or not isinstance(value["segment_id"], str)
            or re.fullmatch(r"[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}", value["segment_id"]) is None
            or not isinstance(value["run_id"], str) or not value["run_id"]
            or not _integer(start) or start < 0 or not _integer(count) or count < 2 or not _integer(start + count)
            or not _sha(value["header_digest"]) or not _sha(value["trace_digest"])
            or not isinstance(terminal, dict) or set(terminal) != {"event_id", "digest", "status", "reason"}
            or terminal["event_id"] != f"event:{value['run_id']}:{start + count}" or not _sha(terminal["digest"])
            or terminal["status"] not in ("success", "stopped", "cancelled", "failure")
            or not isinstance(terminal["reason"], str) or not terminal["reason"] or len(_json(value)) > 32768):
        raise ValueError("InvalidTraceReference")
    return value


def validate_page(page, reference, after, limit):
    # Python treats True == 1 and False == 0; dictionary equality alone is
    # insufficient for the embedded protocol reference.
    validate_reference(page.get("reference") if isinstance(page, dict) else None)
    end = reference["start_index"] + reference["event_count"] - 1
    if (not isinstance(page, dict) or set(page) != {"schema_version", "reference", "header", "events", "next", "done"}
            or page["schema_version"] != "touba-trace-page-v1" or page["reference"] != reference
            or _digest(page["header"]) != reference["header_digest"] or not isinstance(page["events"], list)
            or len(page["events"]) > limit or not _integer(page["next"]) or type(page["done"]) is not bool
            or page["next"] != after + len(page["events"]) or page["next"] > end
            or page["done"] != (page["next"] == end) or (not page["done"] and not page["events"])):
        raise ValueError("InvalidTracePage")
    for index, event in enumerate(page["events"]):
        sequence = after + index + 1
        if (not isinstance(event, dict) or not _integer(event.get("sequence_index")) or event.get("sequence_index") != sequence
                or event.get("run_id") != reference["run_id"] or event.get("event_id") != f"event:{reference['run_id']}:{sequence + 1}"
                or not isinstance(event.get("kind"), str)):
            raise ValueError("InvalidTracePage")
        if sequence != end and event["kind"] == "run_completed":
            raise ValueError("InvalidTracePage")
        if sequence == end and (event["kind"] != "run_completed" or _digest(event) != reference["terminal"]["digest"]
                or event.get("payload", {}).get("status") != reference["terminal"]["status"]
                or event.get("payload", {}).get("reason") != reference["terminal"]["reason"]):
            raise ValueError("InvalidTracePage")
    return page
