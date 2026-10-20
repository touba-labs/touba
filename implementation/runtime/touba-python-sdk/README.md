# Touba Python SDK

Python 3.11+ integration for Touba applications and tool handlers.

The SDK connects Python code to Touba's runtime: it does not implement a
second language runtime. Typed handlers, execution events and governance
decisions follow the same contracts as the JavaScript SDK.

## Install in your application

With a Touba toolchain installed:

```sh
touba sdk install python
```

This installs the bundled wheel in the application's `.venv`. For a new
project with Python handler scaffolding:

```sh
touba init --language python --root my-project
```

See the [Python SDK guide](https://touba-labs.com/docs/guides/sdk-python)
and [handler tutorial](https://touba-labs.com/docs/tutoriels/handlers-python).

## Integration model

- Python handlers run as bounded processes under Touba's execution contract.
- Engine APIs invoke the installed Touba CLI and expose its results and events.
- Approval and decision-provider modules are supplied explicitly by the host.
- Model adapters and bounded RAM/SQLite conversation history use the SDK backend
  included with the toolchain over private stdio.
- MCP stdio integration uses the Python standard library.

Python API options use `snake_case`; model messages and runtime wire keys
retain their protocol spelling. Installing a handler does not grant tools,
secrets or caller permissions.

## Development

From the implementation workspace, run `node tools/check-python-sdk.mjs`.
It builds and installs a wheel in a temporary environment before running the
suite. Configure the offline builder with `TOUBA_PYTHON_BUILD_BIN`; its pinned
requirements are in `build-requirements.txt`.

## License and support

[Apache License 2.0](LICENSE).
Contact [Touba Labs](mailto:contact@touba-labs.com).
