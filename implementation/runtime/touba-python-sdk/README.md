# Touba Python SDK

Python 3.11+ client for an installed Touba toolchain, using its governed CLI
and JSON contracts. No Python runtime dependencies, no network service and
no direct bypass of Core admission. Choose the SDK from your project root:

```sh
touba sdk install python
source .venv/bin/activate
```

```python
from touba_sdk import ToubaEngine

engine = ToubaEngine(project_root=".")
run = engine.run(source="src/program.tb", inputs={"value": "Invoice 42"})
print(run.status, run.reason, run.result)
```

Use `await AsyncToubaEngine(...).run(...)` inside asyncio. `ToubaEngineError` carries
`phase`, `code` and safe structured details. Pauses, explicit stops and human
refusals remain `RunResult` outcomes. See the Touba Python SDK guide for
checkpoint resumes, host authority, cancellation and orchestrator examples.

For Python tool handlers, create the project with `touba init --language python`.
`touba prepare --mode write` generates Python handlers and contract tests after
you declare tools. Implement `run(request, context)` as a sync or async function;
the generated `define_tool` entry point keeps the JSON process protocol.
The SDK also provides controlled errors, memory provenance, effect and
compensation receipts, and testing helpers in `touba_sdk.testing`.

Model-provider adapters, conversation-history stores, MCP and persistent
transport do not yet have Python equivalents. Supply-chain generation follows
static Python imports and dependency lock files, without executing project code
or auditing the installed venv. Do not infer full JS SDK parity from
the availability of Python handlers. See `docs/tutoriels/handlers-python.md`.
