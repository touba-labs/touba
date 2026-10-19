"""Same monetary ledger and on-disk contract as @touba/sdk/budget/sqlite.

The host supplies a dated, justified bound. No model prices or token estimates
are inferred here. Integer micro-units remain exact in both SDKs.
"""
from contextlib import contextmanager
from datetime import date, datetime, timezone
import os
from pathlib import Path
import re
import sqlite3
import stat
import threading
import uuid

from ..provider_errors import ToubaAgentDecisionProviderError


def _fail(code, message):
    raise ToubaAgentDecisionProviderError(code, message) from None


def _micros(value):
    return type(value) is int and value >= 0


def _identifier(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}", value) is not None


def _currency(value):
    return isinstance(value, str) and re.fullmatch(r"[A-Z]{3}", value) is not None


def _prepare_file(filename):
    parent = Path(filename).absolute().parent.lstat()
    if not stat.S_ISDIR(parent.st_mode) or (os.name != "nt" and parent.st_mode & 0o022):
        _fail("ProviderBudgetStorageUnsafe", "budget directory must not be writable by other users")
    for suffix in ("", "-wal", "-shm", "-journal"):
        target, fd = filename + suffix, None
        try:
            try:
                before = os.lstat(target)
            except FileNotFoundError:
                before = None
            if before and (not stat.S_ISREG(before.st_mode) or before.st_nlink != 1):
                _fail("ProviderBudgetStorageUnsafe", "budget storage must be private and without links")
            fd = os.open(target, os.O_RDWR | getattr(os, "O_NOFOLLOW", 0) | (0 if suffix else os.O_CREAT), 0o600)
            after = os.fstat(fd)
            if suffix and stat.S_ISREG(after.st_mode) and after.st_nlink == 0:
                continue  # A live SQLite transaction removed this journal.
            if not stat.S_ISREG(after.st_mode) or after.st_nlink != 1:
                _fail("ProviderBudgetStorageUnsafe", "budget storage changed while opening")
            if before and (before.st_dev, before.st_ino) != (after.st_dev, after.st_ino):
                if not suffix:
                    _fail("ProviderBudgetStorageUnsafe", "budget storage changed while opening")
                current = os.lstat(target)
                if not stat.S_ISREG(current.st_mode) or current.st_nlink != 1:
                    _fail("ProviderBudgetStorageUnsafe", "budget storage must be private and without links")
                if (current.st_dev, current.st_ino) != (after.st_dev, after.st_ino):
                    continue
            if os.name != "nt":
                os.fchmod(fd, 0o600)
        except FileNotFoundError:
            if not suffix:
                raise
        finally:
            if fd is not None:
                os.close(fd)


def _quote(value, currency):
    valid_date = False
    if isinstance(value, dict) and isinstance(value.get("tariff_date"), str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", value["tariff_date"]):
        try:
            valid_date = date.fromisoformat(value["tariff_date"]).isoformat() == value["tariff_date"]
        except ValueError:
            pass
    if (not isinstance(value, dict) or value.get("basis") != "upper_bound"
            or not _micros(value.get("max_cost_micros")) or value.get("currency") != currency
            or not _identifier(value.get("tariff_id")) or not valid_date):
        _fail("ProviderCostBoundUnavailable", "a dated host tariff and a known upper cost bound in the budget currency are required")
    return {key: value[key] for key in ("basis", "max_cost_micros", "currency", "tariff_id", "tariff_date")}


def _usage(value):
    if (not isinstance(value, dict) or value.get("kind") not in ("reported", "estimated", "unknown")
            or ("cost_micros" in value if value["kind"] == "unknown" else not _micros(value.get("cost_micros")))):
        _fail("ProviderCostUsageInvalid", "usage must distinguish reported, estimated and unknown cost")


class _SqliteProviderBudget:
    def __init__(self, *, filename, budget_id, currency, limit_micros):
        if (not isinstance(filename, (str, os.PathLike)) or not str(filename) or str(filename) == ":memory:"
                or not _identifier(budget_id) or not _currency(currency) or not _micros(limit_micros)):
            _fail("InvalidProviderBudgetOptions", "a persistent filename, stable budget id, currency and integer micro-unit limit are required")
        self._budget_id, self._currency = budget_id, currency
        self._filename = str(Path(filename).absolute())
        self._lock = threading.RLock()
        self._db = None
        try:
            _prepare_file(str(filename))
            self._db = sqlite3.connect(str(filename), timeout=5, isolation_level=None, check_same_thread=False)
            self._db.row_factory = sqlite3.Row
            self._db.executescript("""
                PRAGMA synchronous = FULL;
                CREATE TABLE IF NOT EXISTS touba_provider_budgets (
                  id TEXT PRIMARY KEY, protocol TEXT NOT NULL, currency TEXT NOT NULL,
                  limit_micros TEXT NOT NULL, committed_micros TEXT NOT NULL, blocked INTEGER NOT NULL DEFAULT 0
                );
                CREATE TABLE IF NOT EXISTS touba_provider_cost_attempts (
                  id TEXT PRIMARY KEY, budget_id TEXT NOT NULL, reserved_micros TEXT NOT NULL,
                  cost_micros TEXT, status TEXT NOT NULL, tariff_id TEXT NOT NULL,
                  tariff_date TEXT NOT NULL, created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS touba_provider_cost_budget ON touba_provider_cost_attempts(budget_id);
                CREATE TABLE IF NOT EXISTS touba_provider_cost_context (
                  attempt_id TEXT PRIMARY KEY, run_id TEXT NOT NULL, invocation_id TEXT NOT NULL,
                  agent_ref TEXT NOT NULL, step_index INTEGER NOT NULL
                );
            """)
            with self._transaction():
                row = self._account()
                if row is None:
                    self._db.execute("INSERT INTO touba_provider_budgets VALUES (?, 'touba-provider-budget-v1', ?, ?, '0', 0)", (budget_id, currency, str(limit_micros)))
                else:
                    if row["protocol"] != "touba-provider-budget-v1" or row["currency"] != currency:
                        _fail("ProviderBudgetMismatch", "persisted budget protocol or currency differs")
                    if limit_micros < int(row["limit_micros"]):
                        self._db.execute("UPDATE touba_provider_budgets SET limit_micros = ? WHERE id = ?", (str(limit_micros), budget_id))
        except (OSError, sqlite3.Error, ToubaAgentDecisionProviderError) as error:
            if self._db is not None:
                self._db.close()
            if isinstance(error, ToubaAgentDecisionProviderError):
                raise
            _fail("ProviderBudgetStorageUnavailable", "cannot open the durable provider budget")

    @property
    def currency(self):
        return self._currency

    def _provider_backend_options(self):
        from .._backend import MicroUnits
        return {"filename": self._filename, "budgetId": self._budget_id, "currency": self._currency,
                "limitMicros": MicroUnits(self.snapshot()["limit_micros"])}

    @contextmanager
    def _transaction(self):
        with self._lock:
            try:
                self._db.execute("BEGIN IMMEDIATE")
                try:
                    yield
                    self._db.execute("COMMIT")
                except BaseException:
                    if self._db.in_transaction:
                        self._db.rollback()
                    raise
            except sqlite3.Error:
                _fail("ProviderBudgetStorageUnavailable", "provider budget storage operation failed")

    def _account(self):
        return self._db.execute("SELECT * FROM touba_provider_budgets WHERE id = ?", (self._budget_id,)).fetchone()

    def _attempt(self, attempt_id):
        return self._db.execute("SELECT * FROM touba_provider_cost_attempts WHERE id = ? AND budget_id = ?", (attempt_id, self._budget_id)).fetchone()

    def reserve(self, quote, context=None):
        quote = _quote(quote, self.currency)
        if context is not None and (not isinstance(context, dict)
                or set(context) != {"run_id", "invocation_id", "agent_ref", "step_index"}
                or any(not isinstance(context[key], str) or re.fullmatch(r"[A-Za-z0-9_:/.-]{1,512}", context[key]) is None
                       for key in ("run_id", "invocation_id", "agent_ref"))
                or type(context["step_index"]) is not int or not 0 <= context["step_index"] <= 9007199254740991):
            _fail("InvalidProviderBudgetOptions", "invalid runtime cost correlation")
        with self._transaction():
            row = self._account()
            if row["blocked"]:
                _fail("ProviderBudgetBlocked", "a reported cost violated its reservation; this budget is blocked")
            committed = int(row["committed_micros"]) + quote["max_cost_micros"]
            if committed > int(row["limit_micros"]):
                _fail("ProviderCostBudgetExceeded", "provider request exceeds the remaining monetary budget")
            attempt_id = str(uuid.uuid4())
            created_at = datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
            self._db.execute("INSERT INTO touba_provider_cost_attempts VALUES (?, ?, ?, NULL, 'pending', ?, ?, ?)",
                             (attempt_id, self._budget_id, str(quote["max_cost_micros"]), quote["tariff_id"], quote["tariff_date"], created_at))
            if context is not None:
                self._db.execute("INSERT INTO touba_provider_cost_context VALUES (?, ?, ?, ?, ?)",
                                 (attempt_id, context["run_id"], context["invocation_id"], context["agent_ref"], context["step_index"]))
            self._db.execute("UPDATE touba_provider_budgets SET committed_micros = ? WHERE id = ?", (str(committed), self._budget_id))
            return attempt_id

    def settle(self, attempt_id, usage):
        _usage(usage)
        kind, cost = usage["kind"], usage.get("cost_micros")
        with self._transaction():
            row = self._attempt(attempt_id)
            if row is None:
                _fail("ProviderBudgetAttemptUnknown", "attempt does not belong to this budget")
            reserved = int(row["reserved_micros"])
            if row["status"] == "reported":
                if kind != "reported" or str(cost) != row["cost_micros"]:
                    _fail("ProviderBudgetSettlementConflict", "reported usage cannot be replaced")
                violated = cost > reserved
            else:
                if row["status"] == "estimated" and kind != "reported" and (kind != "estimated" or str(cost) != row["cost_micros"]):
                    _fail("ProviderBudgetSettlementConflict", "estimated usage can only be refined by reported usage")
                violated = kind == "reported" and cost > reserved
                if kind == "reported":
                    used = int(self._account()["committed_micros"]) - reserved + cost
                    self._db.execute("UPDATE touba_provider_budgets SET committed_micros = ?, blocked = MAX(blocked, ?) WHERE id = ?", (str(used), int(violated), self._budget_id))
                self._db.execute("UPDATE touba_provider_cost_attempts SET status = ?, cost_micros = ? WHERE id = ?", (kind, None if cost is None else str(cost), attempt_id))
        if violated:
            _fail("ProviderCostBoundViolated", "reported provider cost exceeds the reserved upper bound")

    def attempt(self, attempt_id):
        with self._transaction():
            return self._describe(self._attempt(attempt_id))

    def _describe(self, row):
        if row is None:
            return None
        context = self._db.execute("SELECT run_id, invocation_id, agent_ref, step_index FROM touba_provider_cost_context WHERE attempt_id = ?", (row["id"],)).fetchone()
        return {"id": row["id"], "status": row["status"], "reserved_micros": int(row["reserved_micros"]),
                "cost_micros": None if row["cost_micros"] is None else int(row["cost_micros"]),
                "tariff_id": row["tariff_id"], "tariff_date": row["tariff_date"], "created_at": row["created_at"],
                "context": None if context is None else dict(context)}

    def list_attempts(self, *, status=None, after_id="", limit=100):
        if ((status is not None and status not in ("pending", "reported", "estimated", "unknown"))
                or (after_id != "" and not _identifier(after_id)) or type(limit) is not int or not 1 <= limit <= 1000):
            _fail("InvalidProviderBudgetOptions", "invalid attempt filter or page size")
        with self._transaction():
            return [self._describe(row) for row in self._db.execute(
                "SELECT * FROM touba_provider_cost_attempts WHERE budget_id = ? AND id > ? AND (? IS NULL OR status = ?) ORDER BY id LIMIT ?",
                (self._budget_id, after_id, status, status, limit))]

    def snapshot(self):
        with self._transaction():
            row = self._account()
            limit, committed = int(row["limit_micros"]), int(row["committed_micros"])
            attempts = dict.fromkeys(("pending", "reported", "estimated", "unknown"), 0)
            for entry in self._db.execute("SELECT status, COUNT(*) AS n FROM touba_provider_cost_attempts WHERE budget_id = ? GROUP BY status", (self._budget_id,)):
                attempts[entry["status"]] = entry["n"]
            return {"budget_id": self._budget_id, "currency": self.currency, "limit_micros": limit,
                    "committed_micros": committed, "remaining_micros": max(0, limit - committed),
                    "blocked": row["blocked"] == 1, "attempts": attempts}

    def close(self):
        with self._lock:
            self._db.close()


def create_sqlite_provider_budget(*, filename, budget_id, currency, limit_micros):
    return _SqliteProviderBudget(filename=filename, budget_id=budget_id, currency=currency, limit_micros=limit_micros)
