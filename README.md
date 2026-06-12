# Touba

Touba is a programming language and runtime for governed agentic systems.

Touba means `Thinking Orchestration Using Bounded Agency`.

The official source extension is `.tb`.

## Why Touba

Touba gives agentic software an explicit programming model. It separates what a
system can do from who is allowed to invoke it, under which policies, with which
budgets, memories, tools, traces and review gates.

The core model is:

- `tool`: a bounded external action;
- `skill`: a typed composition of capabilities;
- `agent`: the responsibility and invocation authority attached to execution.

This distinction makes agentic behavior easier to analyze, test, govern and
operate than prompt-only orchestration.

## Quick Start

Install the macOS Apple Silicon bundle (`touba-v0.1.0-darwin-arm64.tar.gz`),
then check the CLI:

```sh
sh install.sh
touba version
```

Create `hello.tb`:

```text
module examples.hello

strategy Hello
    do
        show
            with message as "Touba ready"
```

Compile and run:

```sh
touba compile hello.tb --out hello.air.json
touba run hello.air.json
```

The run prints `Touba ready`. Add `--output trace` to see the structured
execution trace of the same run.

## Example

A minimal governed composition with `tool`, `skill`, `agent` and `callable_by`:

```text
module examples.agent_simple

type DatasetRequest
    query is Text

type DatasetBrief
    summary is Text

tool SearchDatasets
    takes request as DatasetRequest
    gives DatasetBrief
    requires network

skill BuildDatasetBrief
    takes request as DatasetRequest
    gives DatasetBrief
    uses SearchDatasets
    do
        SearchDatasets
            with request as request
            into result
        give result

agent Researcher
    uses BuildDatasetBrief
    callable_by strategy RunDatasetResearch

strategy RunDatasetResearch
    uses Researcher
    do
        Researcher
```

The `tool` declares a bounded external action, the `skill` composes it into a
typed capability, the `agent` carries the responsibility for selecting what to
execute, and `callable_by` declares who is allowed to invoke that agent. The
runtime refuses anything outside these declarations before any external effect.

## Architecture

```text
source .tb -> compiler -> AIR JSON -> runtime -> traces
```

- the compiler turns `.tb` sources into AIR, an explicit intermediate
 representation of every executable node;
- the runtime executes AIR only: callers, grants, secrets, budgets and payload
 limits are checked before any external effect;
- every run can emit structured trace events that reference AIR nodes and
 source locations.

Nothing executes outside this pipeline: no hidden prompt orchestration and no
implicit tool discovery.

## Repository Scope

This repository contains the Touba language and runtime core:

- language specifications;
- parser, AST and AIR generation;
- runtime and trace contracts;
- command-line tools;
- SDK and handler contracts;
- examples, fixtures and validation tests.

## Building From Source

Prerequisites:

- Node `>=24 <25`;
- pnpm `10.33.2`;
- Rust `1.95.0`, pinned by `implementation/rust-toolchain.toml`.

```sh
cd implementation
pnpm install
cargo test -p touba-compiler
pnpm validate:v1-local
```

`pnpm validate:v1-local` aggregates the runtime, CLI, project, SDK, corpus and
fixture validations used to qualify a local build.

## Platform Support

| Platform | Status | Artifact |
| --- | --- | --- |
| macOS Apple Silicon | Available | `touba-v0.1.0-darwin-arm64.tar.gz` |
| VS Code extension | Available | `touba-vscode-0.1.0.vsix` |
| macOS Intel | Prepared | `darwin-x64` |
| Linux | Prepared | `linux-x64 / linux-arm64` |
| Windows | Prepared | `win32-x64` |

Prepared channels are published once their bundles reach the same validation
level as macOS Apple Silicon.

## Use This Repository For

- understanding the Touba language model;
- following the AIR, runtime and trace contracts;
- working on the compiler, CLI, SDK and handler interfaces;
- validating examples, fixtures and governed execution behavior;
- connecting editor, documentation, skills and registry work to the language
 core.

## Contributing And Feedback

Contributions, bug reports, proposals and documentation feedback are handled
through GitHub Issues and pull requests.

Read `CONTRIBUTING.md`, `FEEDBACK.md`, `SECURITY.md` and
`CODE_OF_CONDUCT.md` before opening a change.

## How To Cite

```bibtex
@software{touba2026,
  author  = {Lo, Khadim and Dessureault, Jean-S{\'e}bastien and Alaoui Ismaili, Soukaina},
  title   = {Touba: A Programming Language and Runtime for Governed Agentic Systems},
  year    = {2026},
  url     = {https://github.com/khadimbambalo/touba},
  version = {0.1.0}
}
```

GitHub also renders this metadata from `CITATION.cff` through the
`Cite this repository` button.

## Authors

Touba is authored by Khadim Lo, Professor Jean-Sebastien Dessureault and Soukaina Alaoui Ismaili. Khadim Lo is the principal maintainer; Jean-Sebastien Dessureault is the research supervisor. See `AUTHORS.md` for roles and contact addresses.

## License

This repository is licensed under the MIT License. See `LICENSE`.
