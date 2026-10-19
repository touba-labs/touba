from concurrent.futures import ThreadPoolExecutor
import json
import os
from pathlib import Path
import shutil
import subprocess
import re
import sys
import tempfile
import unittest

from touba_sdk import ToubaAgentDecisionProviderError, touba_sdk_metadata
from touba_sdk.budget.sqlite import create_sqlite_provider_budget


def quote(amount=10):
    return {"basis": "upper_bound", "max_cost_micros": amount, "currency": "USD", "tariff_id": "test-contract", "tariff_date": "2026-10-18"}


class ProviderBudgetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="touba-python-budget-")
        self.config = {"filename": str(Path(self.temp.name) / "budget.sqlite"), "budget_id": "business-run", "currency": "USD", "limit_micros": 100}
        self.stores = []
        self.budget = self.open()

    def tearDown(self):
        for store in self.stores:
            store.close()
        self.temp.cleanup()

    def open(self, **changes):
        store = create_sqlite_provider_budget(**{**self.config, **changes})
        self.stores.append(store)
        return store

    def error(self, code, call):
        with self.assertRaises(ToubaAgentDecisionProviderError) as raised:
            call()
        self.assertEqual(raised.exception.code, code)

    def test_reported_unknown_estimated_and_reconciliation(self):
        ids = [self.budget.reserve(quote()) for _ in range(3)]
        self.budget.settle(ids[0], {"kind": "reported", "cost_micros": 3})
        self.budget.settle(ids[1], {"kind": "unknown"})
        self.budget.settle(ids[2], {"kind": "estimated", "cost_micros": 1})
        self.assertEqual(self.budget.snapshot()["committed_micros"], 23)
        self.assertIsNone(self.budget.attempt(ids[1])["cost_micros"])
        self.error("ProviderBudgetSettlementConflict", lambda: self.budget.settle(ids[2], {"kind": "unknown"}))
        self.budget.settle(ids[2], {"kind": "estimated", "cost_micros": 1})
        self.budget.settle(ids[1], {"kind": "reported", "cost_micros": 2})
        self.budget.settle(ids[1], {"kind": "reported", "cost_micros": 2})
        self.assertEqual(self.budget.snapshot()["committed_micros"], 15)
        self.error("ProviderBudgetSettlementConflict", lambda: self.budget.settle(ids[1], {"kind": "reported", "cost_micros": 0}))

    def test_breach_is_persisted_before_error_and_blocks_next_attempt(self):
        attempt = self.budget.reserve(quote())
        self.error("ProviderCostBoundViolated", lambda: self.budget.settle(attempt, {"kind": "reported", "cost_micros": 110}))
        reopened = self.open()
        self.assertTrue(reopened.snapshot()["blocked"])
        self.assertEqual(reopened.attempt(attempt)["cost_micros"], 110)
        self.assertEqual(reopened.snapshot()["remaining_micros"], 0)
        self.error("ProviderBudgetBlocked", lambda: reopened.reserve(quote(0)))

    def test_reopen_restricts_and_preserves_pending_without_reset(self):
        attempt = self.budget.reserve(quote(40))
        self.open(limit_micros=45)
        self.assertEqual(self.budget.snapshot()["limit_micros"], 45)
        self.assertEqual(self.open(limit_micros=1000).snapshot()["limit_micros"], 45)
        self.error("ProviderCostBudgetExceeded", lambda: self.budget.reserve(quote()))
        self.error("ProviderBudgetMismatch", lambda: self.open(currency="EUR"))
        self.error("ProviderBudgetAttemptUnknown", lambda: self.open(budget_id="other").settle(attempt, {"kind": "reported", "cost_micros": 0}))

    def test_exact_large_integers_and_no_bool_or_float(self):
        huge = 10 ** 30
        budget = self.open(budget_id="huge", limit_micros=huge)
        attempt = budget.reserve(quote(huge - 1))
        budget.settle(attempt, {"kind": "reported", "cost_micros": huge - 3})
        self.assertEqual(budget.snapshot()["remaining_micros"], 3)
        for value in (None, True, False, 1.5, -1, "1"):
            self.error("InvalidProviderBudgetOptions", lambda: self.open(limit_micros=value))
            self.error("ProviderCostBoundUnavailable", lambda: self.budget.reserve(quote(value)))

    def test_invalid_quotes_and_usage_do_not_change_accounting(self):
        for changes in ({"basis": "estimate"}, {"currency": "EUR"}, {"tariff_date": "2026-02-30"}, {"tariff_id": "SECRET TOKEN"}, {"tariff_date": "0000-01-01"}):
            self.error("ProviderCostBoundUnavailable", lambda: self.budget.reserve({**quote(), **changes}))
        self.assertEqual(self.budget.snapshot()["committed_micros"], 0)
        attempt = self.budget.reserve(quote())
        for usage in (None, {}, {"kind": "reported", "cost_micros": True}, {"kind": "unknown", "cost_micros": 0}, {"kind": "estimated", "cost_micros": -1}):
            self.error("ProviderCostUsageInvalid", lambda: self.budget.settle(attempt, usage))
        self.assertEqual(self.budget.attempt(attempt)["status"], "pending")

    def test_private_file_and_symlink_refusal(self):
        if os.name != "nt":
            self.assertEqual(os.stat(self.config["filename"]).st_mode & 0o777, 0o600)
            alias = str(Path(self.temp.name) / "alias.sqlite")
            os.symlink(self.config["filename"], alias)
            self.error("ProviderBudgetStorageUnsafe", lambda: self.open(filename=alias))
        self.error("InvalidProviderBudgetOptions", lambda: self.open(filename=":memory:"))

    def test_concurrent_threads_share_the_same_last_permission(self):
        def reserve(_):
            try:
                self.budget.reserve(quote())
                return 1
            except ToubaAgentDecisionProviderError as error:
                self.assertEqual(error.code, "ProviderCostBudgetExceeded")
                return 0
        with ThreadPoolExecutor(max_workers=8) as pool:
            self.assertEqual(sum(pool.map(reserve, range(40))), 10)
        self.assertEqual(self.budget.snapshot()["committed_micros"], 100)

    def test_pending_attempts_remain_discoverable_after_restart(self):
        ids = [self.budget.reserve(quote()) for _ in range(5)]
        self.budget.settle(ids[0], {"kind": "unknown"})
        reopened = self.open()
        first = reopened.list_attempts(limit=2)
        second = reopened.list_attempts(after_id=first[-1]["id"], limit=3)
        self.assertEqual([row["id"] for row in first + second], sorted(ids))
        self.assertEqual(len(reopened.list_attempts(status="pending")), 4)
        self.assertEqual(self.open(budget_id="other").list_attempts(), [])
        for options in ({"limit": 0}, {"limit": 1001}, {"limit": True}, {"status": "PRIVATE"}, {"after_id": 1}):
            self.error("InvalidProviderBudgetOptions", lambda: reopened.list_attempts(**options))

    def test_javascript_and_python_share_a_single_ledger_and_error_contract(self):
        node = os.environ.get("TOUBA_TEST_NODE", shutil.which("node"))
        self.assertIsNotNone(node, "cross-SDK parity requires Node")
        source = Path(__file__).resolve().parents[2] / "touba-handler-sdk/src/sqlite-provider-budget.mjs"
        attempt = self.budget.reserve(quote(40))
        script = f'''import {{createSqliteProviderBudget}} from {json.dumps(source.as_uri())};
          const b=createSqliteProviderBudget({{filename:process.argv[1],budgetId:"business-run",currency:"USD",limitMicros:100n}});
          b.settle(process.argv[2], {{kind:"reported",costMicros:15n}});
          const id=b.reserve({{basis:"upper_bound",maxCostMicros:70n,currency:"USD",tariffId:"test",tariffDate:"2026-10-18"}});
          process.stdout.write(JSON.stringify({{id, snapshot:b.snapshot()}}, (_,v)=>typeof v==="bigint"?String(v):v));
          process.exit(0);'''
        result = subprocess.run([node, "--input-type=module", "-e", script, self.config["filename"], attempt], text=True, capture_output=True, timeout=15)
        self.assertEqual(result.returncode, 0, result.stderr)
        state = json.loads(result.stdout)
        self.assertEqual(state["snapshot"]["committedMicros"], "85")
        self.assertEqual(self.budget.attempt(attempt)["cost_micros"], 15)
        self.assertEqual(self.budget.attempt(state["id"])["status"], "pending")
        self.budget.settle(state["id"], {"kind": "reported", "cost_micros": 10})
        self.assertEqual(self.budget.snapshot()["committed_micros"], 25)

    def test_python_sdk_identity_matches_static_javascript_including_subpackages(self):
        import touba_sdk
        root = Path(__file__).resolve().parents[3]
        identity = root / "cli/touba-manifest/src/python-sdk-dependency.mjs"
        script = f'''import {{pythonSdkSourceIdentity}} from {json.dumps(identity.as_uri())};
          process.stdout.write(pythonSdkSourceIdentity(process.argv[1]));'''
        result = subprocess.check_output([os.environ.get("TOUBA_TEST_NODE", shutil.which("node")),
            "--input-type=module", "-e", script, str(Path(touba_sdk.__file__).parent)], text=True)
        self.assertEqual(result, touba_sdk_metadata()["build_sha256"])

    def test_published_python_guide_and_tutorial_execute(self):
        docs = Path(__file__).resolve().parents[4] / "docs"
        for page, expected in [("guides/couts-fournisseurs", "10000000"), ("tutoriels/budget-financier", "BUDGET_OK")]:
            with self.subTest(page=page), tempfile.TemporaryDirectory(prefix="touba-python-budget-doc-") as cwd:
                content = (docs / (page + ".md")).read_text()
                code = re.search(r"```python\n([\s\S]*?)```", content).group(1)
                result = subprocess.run([sys.executable, "-c", code], cwd=cwd, text=True, capture_output=True, timeout=10)
                self.assertEqual(result.returncode, 0, result.stderr)
                self.assertEqual(result.stdout.strip(), expected)


if __name__ == "__main__":
    unittest.main()
