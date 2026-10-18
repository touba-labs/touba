import asyncio
import unittest
from touba_sdk import ToubaEngineError
from touba_sdk.testing import (create_scripted_decision_provider, assert_run_succeeded,
                               assert_run_refused, assert_trace_events)


class TestingTests(unittest.TestCase):
    def test_script_routing_repetition_isolation_and_exhaustion(self):
        proposal = {"action": "select_capability", "target_ref": "tool:app/Read", "arguments": {}}
        provider = create_scripted_decision_provider([
            {"expect": {"mode": "capabilities", "step_index": i}, "decision": proposal} for i in (0, 1)])
        proposal["target_ref"] = "mutated"
        async def check():
            with self.assertRaises(AssertionError):
                await provider({"mode": "summary", "step_index": 0})
            for i in (0, 1):
                value = await provider({"mode": "capabilities", "step_index": i, "inputs": "DO_NOT_LOG"})
                self.assertEqual(value["target_ref"], "tool:app/Read")
            provider.assert_consumed()
            with self.assertRaises(AssertionError):
                await provider({})
        asyncio.run(check())
        self.assertNotIn("DO_NOT_LOG", str(provider.calls))
        for steps in ([], None, [{}], [{"expect": {"typo": 0}, "decision": {}}]):
            with self.assertRaises(ValueError):
                create_scripted_decision_provider(steps)

    def test_runtime_assertions_do_not_accept_launch_errors(self):
        assert_run_succeeded({"status": "success", "reason": "completed", "result": 42}, 42)
        with self.assertRaises(AssertionError):
            assert_run_succeeded({"status": "stopped", "reason": "human_approval_pending", "result": None}, None)
        async def refused():
            raise ToubaEngineError("run", "ToolCapabilityNotGranted", {"status": "failure", "reason": "ToolCapabilityNotGranted"})
        asyncio.run(assert_run_refused(refused, "ToolCapabilityNotGranted"))
        async def bad_launch():
            raise ToubaEngineError("run", "LaunchFailed")
        with self.assertRaises(AssertionError):
            asyncio.run(assert_run_refused(bad_launch, "ToolCapabilityNotGranted"))

    def test_exact_trace_counts_and_sync_filters(self):
        trace = {"events": [{"kind": "call_started"}, {"kind": "call_started"}]}
        self.assertEqual(len(assert_trace_events(trace, kind="call_started", count=2)), 2)
        with self.assertRaises(AssertionError):
            assert_trace_events(trace, kind="call_started", count=1)
        async def filter_async(event):
            return True
        with self.assertRaises(ValueError):
            assert_trace_events(trace, kind="call_started", count=2, where=filter_async)
