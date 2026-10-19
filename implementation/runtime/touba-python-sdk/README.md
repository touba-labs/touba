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

`touba_sdk.budget.sqlite.create_sqlite_provider_budget` provides the same
durable monetary ledger as the JavaScript SDK, with integer micro-units and
the same SQLite schema. Host tariff adapters establish bounds; unknown usage
retains its reservation. See the provider-cost guide and monetary-budget tutorial.

For SDK development, `node tools/check-python-sdk.mjs` from the implementation
directory builds and installs a wheel in an isolated temporary environment,
then runs the suite. Provision the offline builder via `TOUBA_PYTHON_BUILD_BIN`.
A source-only `PYTHONPATH` invocation does not qualify tool handlers: the Core
intentionally does not pass that environment variable into handler processes.

Model adapters (`create_ai_sdk_decision_provider`, `create_open_ai_decision_provider`,
`create_ollama_decision_provider`) and RAM/SQLite conversation history reuse the
SDK backend included with the installed toolchain over private bounded stdio.
Options use snake_case; model messages and runtime wire keys remain unchanged.
MCP stdio uses the Python standard library directly. Trusted `.py` provider and
approval modules are supported by the CLI. Persistent Engine transport across
runs remains separate from this per-provider lifecycle. Supply-chain generation follows
static Python imports and dependency lock files, without executing project code
or auditing the installed venv. Do not infer full JS SDK parity from
the availability of Python handlers. See `docs/tutoriels/handlers-python.md`.
