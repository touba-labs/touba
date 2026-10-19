"""SQLite history with the same records, leases and explicit recovery as JS."""
from ..providers import DecisionHistoryStore, _options


def create_sqlite_decision_history_store(*, filename, max_sessions=128, max_bytes=33554432, ttl_ms=86400000):
    return DecisionHistoryStore("sqlite", {"filename": str(filename), "maxSessions": max_sessions,
                                           "maxBytes": max_bytes, "ttlMs": ttl_ms})
