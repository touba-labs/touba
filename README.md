# Touba

A programming language and runtime for governed agentic systems.

An agent's instructions describe what it should do. Touba also makes explicit
what it may do: which capabilities it can invoke, which resources those
capabilities require, and where execution must wait for a human decision.

Touba means **Thinking Orchestration Using Bounded Agency**. Programs use the
`.tb` extension and compile to AIR, the intermediate representation executed
by the runtime.

[Documentation](https://toubalang.org/) ·
[Downloads](https://toubalang.org/hub/) ·
[Research](https://toubalang.org/recherche/) ·
[Contact Touba Labs](mailto:contact@touba-labs.com)

## What you can build

- Typed tools and skills for business operations.
- Agents that choose among declared capabilities, with explicit caller rules.
- Multi-agent workflows and bounded parallel execution.
- Human approval steps with host-attested identity and role requirements.
- Resource-aware execution with secrets, scoped memory and declared budgets.
- Reusable packages containing declarations, handlers or contextual procedures.
- JavaScript and Python applications that run Touba and consume its events.

The compiler checks source contracts. During execution, the runtime mediates
calls, resource access, budgets and approval gates and produces structured
traces. The host remains responsible for credentials, identity and the behavior
of external systems. These controls bound execution; they do not guarantee the
correctness of a model's answer.

## Get started

The first public release, `1.0.0`, is being qualified. Public downloads are not
open yet. The instructions below apply to a Touba build supplied by the
maintainers.

The [installation guide](https://toubalang.org/docs/demarrer/installation)
covers archives, graphical installers and checksum verification. The release
targets macOS Apple Silicon, macOS Intel, Linux x64 and Windows x64.

After installation:

```sh
touba version
touba doctor
```

Create `hello.tb`:

<!-- touba-example: compile -->
```touba
module examples.hello

strategy Hello
    do
        show
            with message as "Touba ready"
```

Compile and run it:

```sh
touba compile hello.tb --out hello.air.json
touba run hello.air.json
```

Add `--output trace` to the run command to inspect the execution events.

Export with `--trace-out trace.json`, then use `touba inspect trace.json`
for a summary or **Touba: Render Trace** in VS Code to read the events.

For a project with generated handler scaffolding, choose the host language:

```sh
touba init --language javascript --root my-project
# Or create a separate Python project:
touba init --language python --root my-python-project
```

Install a host SDK from your application's directory with
`touba sdk install javascript` or `touba sdk install python`. The SDKs come
with the toolchain; you do not need to find an unpublished package on npm or
PyPI. Both use Touba's runtime and governance contracts.

## A small set of concepts

| Construct | Role |
| --- | --- |
| `tool` | A typed operation implemented by a host handler. |
| `skill` | A reusable composition of declared capabilities. |
| `agent` | A declared responsibility and capability-selection boundary. |
| `strategy` | An executable workflow. |
| Package | A versioned unit of reuse, with one `touba.package.json` manifest. |

Strategies and skills can also execute directly. Traces preserve the actual
structural caller instead of attributing those operations to an invented agent.

The [concepts](https://toubalang.org/docs/concepts/composants-touba),
[guides](docs/guides/) and [tutorials](docs/tutoriels/) explain the language,
handler integration, multi-agent composition, parallelism and execution history.

## Reusable packages

Create an author project:

```sh
touba package new review --org acme --license Apache-2.0 --yes
cd review
touba package check --publishing
touba package test
touba package pack
```

A package can contain executable declarations, contextual procedures, or both.
Consumers install an archive, a reviewed local directory, or an exact version
from an explicitly selected registry. The installer checks identity,
compatibility and content before updating the managed `packages/` directory.
It does not run author tests or install hooks.

Installation does not grant runtime authority. The consuming program still
declares its callers, bindings and permissions.

See the [package guide](docs/guides/creer-partager-package.md) and the
[complete author-to-consumer tutorial](docs/tutoriels/package-reutilisable.md).

## Integration and observability

JavaScript and Python SDKs provide host integration and typed tool handlers.
Explicit MCP snapshots and REST/OpenAPI descriptions can generate reviewable
Touba contracts and handlers. Existing application code can be called through
those handlers; it does not become trusted merely by being imported.

The project server exposes HTTP and event-stream interfaces for host
applications. Those applications supply their identity and access policy.
AIR inspection, execution traces and audit commands help connect an observed
action or refusal to its source declaration.

## Research and evaluation

Touba implements **Probabilistic Agentic Programming (PAP)**. The paradigm's
responsibility-boundary principles are distinct from Touba's syntax and runtime
implementation.

The [benchmark page](https://toubalang.org/benchmarks/) presents the current
multi-provider interface study, including business outcomes and governance
evidence. Deterministic invariant tests are reported separately from model
performance. The [research page](https://toubalang.org/recherche/) links the
manuscripts and explains the scope of their formal results.

## Building from source

Use Node.js 24.22.1 or a newer patched 24.x release, pnpm 10.33.2 and the Rust toolchain pinned in
`implementation/rust-toolchain.toml`.

```sh
cd implementation
pnpm install --frozen-lockfile
cargo test -p touba-compiler
pnpm validate:v1-local
```

Source checks do not by themselves qualify a downloadable release. Platform
installation checks apply to the actual archives. Release maintenance is
described in the [version and release reference](https://toubalang.org/docs/reference/versions-releases).

## Contributing and feedback

Read [CONTRIBUTING.md](CONTRIBUTING.md) before proposing a change.
For questions and access-independent feedback, contact
[contact@touba-labs.com](mailto:contact@touba-labs.com).
Follow [SECURITY.md](SECURITY.md) for security reports.

## Authors and citation

Touba is authored by Khadim Lo, Jean-Sebastien Dessureault and Soukaina Alaoui
Ismaili. See [AUTHORS.md](AUTHORS.md) and [CITATION.cff](CITATION.cff).

## License

The Touba language implementation, runtime, CLI and SDK code in this repository
are open-source software under the [Apache License 2.0](LICENSE).
Third-party dependencies retain their respective licenses.
