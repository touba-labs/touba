# Developing Touba

Use the versions pinned in `implementation/rust-toolchain.toml` and
`implementation/package.json`. Follow the build instructions in [README](README.md).
Build `touba-compile` before running the JavaScript suites: compiler library
unit tests alone do not build the CLI executable used by those suites.

From `implementation`, the principal checks are:

```sh
cargo test --locked
cargo fmt --all --check
cargo clippy --locked --all-targets -- -D warnings
pnpm validate:v1-local
pnpm validate:docs-user
pnpm test:manifest
pnpm test:sdk
```

Provision the Python builder listed in the README for installed SDK packaging
checks. Packaging also requires an official, relocatable Node distribution
with its complete license, and the native release compiler. Source validation
and installed distribution qualification are separate checks.

## HTTP and PostgreSQL integration

The integration pilot needs the source packages `touba.http-api` and
`touba.sql-effects` and a disposable PostgreSQL instance. Point
`TOUBA_TEST_LIBRARY` at a directory with both packages under `packages/`.

```sh
TOUBA_TEST_LIBRARY=/path/to/package-sources pnpm validate:reliable-effects-pilot
```

The pilot uses Docker by default. For a native installation, set
`TOUBA_TEST_POSTGRES_DRIVER=native` and point `TOUBA_TEST_POSTGRES_BIN` to
the directory containing the PostgreSQL binaries. The pilot runs separately
from `validate:v1-local`.

Tests own their executable examples and synthetic data. Keep test effects in
temporary directories, use local fixtures and assert both success and refusal.
Do not turn a missing component or an unexecuted platform check into success.
Commands selecting workspace packages fail if their filter matches nothing.

AIR and traces are shared machine contracts. Check their consumers when changing
expressions, references, authority, limits or persisted state. Keep unknown
fields and versions observable as refusals. Handler stdout carries the JSON
protocol; diagnostics belong on stderr and must not include secrets.

Prepare changes against the repository's default branch, keep each pull request
focused and document the checks actually run. A source test does not authorize
publishing or replacing a release. Existing release artifacts retain their
identity; changes are qualified and distributed separately.
