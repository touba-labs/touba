"""Installed-wheel engineering probe, without providers or external effects.

python -I engine_performance.py --touba /path/to/installed/touba
Thresholds are fixed before measurement, not a production latency SLA.
"""
import argparse
import asyncio
import json
import math
import os
from pathlib import Path
import platform
import statistics
import tempfile
import time
import touba_sdk
from touba_sdk import AsyncToubaEngine, ToubaEngine


def distribution(values):
    ordered = sorted(values)
    return {"n": len(values), "p50_ms": statistics.median(values),
            "p95_ms": ordered[math.ceil(len(values) * .95) - 1],
            "p99_ms": ordered[math.ceil(len(values) * .99) - 1], "samples_ms": values}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--touba", required=True)
    options = parser.parse_args()
    if "site-packages" not in Path(touba_sdk.__file__).parts:
        raise RuntimeError("An installed wheel is required, not PYTHONPATH source imports")
    thresholds = {"cold_ms": 3000, "sequential_p95_ms": 1500, "eight_concurrent_batch_p95_ms": 8000,
                  "source_compile_and_run_p95_ms": 2000}
    report = {"scope": "installed Python process transport, local deterministic echo only",
              "python": platform.python_version(), "platform": platform.platform(), "cpu_count": os.cpu_count(),
              "thresholds": thresholds, "samples_per_size": 20, "batches_per_size": 5, "results": [], "status": "passed"}
    with tempfile.TemporaryDirectory(prefix="touba-python-performance-") as directory:
        root = Path(directory)
        (root / "program.tb").write_text('module overhead\nstrategy Echo\n    takes value as Text\n    gives Text\n    do\n        give value\n')
        engine = ToubaEngine(project_root=root, command=options.touba)
        report["candidate"] = engine.version()
        compiled = engine.compile("program.tb").air_document
        for size in (64, 65536):
            value = "a" * size
            run_options = dict(air_json=compiled, entry_ref="strategy:overhead/Echo", inputs={"value": value})
            def run():
                assert engine.run(**run_options).result == value
            started = time.perf_counter(); run(); cold = (time.perf_counter() - started) * 1000
            sequential = []
            for _ in range(20):
                started = time.perf_counter(); run(); sequential.append((time.perf_counter() - started) * 1000)
            async def batches():
                async_engine = AsyncToubaEngine(project_root=root, command=options.touba)
                values = []
                for _ in range(5):
                    started = time.perf_counter()
                    results = await asyncio.gather(*(async_engine.run(**run_options) for _ in range(8)))
                    assert all(result.result == value for result in results)
                    values.append((time.perf_counter() - started) * 1000)
                return values
            row = {"payload_bytes": size, "cold_ms": cold, "sequential": distribution(sequential),
                   "eight_concurrent_batch": distribution(asyncio.run(batches()))}
            row["passed"] = cold <= thresholds["cold_ms"] and row["sequential"]["p95_ms"] <= thresholds["sequential_p95_ms"] and row["eight_concurrent_batch"]["p95_ms"] <= thresholds["eight_concurrent_batch_p95_ms"]
            report["results"].append(row)
        values = []
        for _ in range(5):
            started = time.perf_counter()
            assert engine.run(source="program.tb", inputs={"value": "source"}).result == "source"
            values.append((time.perf_counter() - started) * 1000)
        report["source_compile_and_run"] = distribution(values)
        if not all(row["passed"] for row in report["results"]) or report["source_compile_and_run"]["p95_ms"] > thresholds["source_compile_and_run_p95_ms"]:
            report["status"] = "failed"
    print(json.dumps(report, indent=2))
    return 0 if report["status"] == "passed" else 1


if __name__ == "__main__":
    raise SystemExit(main())
