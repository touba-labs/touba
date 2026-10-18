# Touba Python SDK

Python 3.11+ client for an installed Touba toolchain, using its governed CLI
and JSON contracts. No Python runtime dependencies, no network service and
no direct handler calls. Install the supplied wheel in your virtual environment:

```sh
python -m pip install --no-index --no-deps ./touba_sdk-0.1.0-py3-none-any.whl
```

```python
from touba_sdk import Engine

engine = Engine(project_root=".")
run = engine.run(source="src/program.tb", inputs={"value": "Invoice 42"})
print(run.status, run.reason, run.result)
```

Use `await AsyncEngine(...).run(...)` inside asyncio. `EngineError` carries
`phase`, `code` and safe structured details. Pauses, explicit stops and human
refusals remain `RunResult` outcomes. See the Touba Python SDK guide for
checkpoint resumes, host authority, cancellation and orchestrator examples.
