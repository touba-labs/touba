# Versioning

Touba uses separate version families for packages, schemas and distribution
channels.

## Packages

Implementation packages use `0.1.0` for the current V1 RC development line.
Package versions must not remain at `0.0.0` once a package is part of a public
README, CLI report, bundle name or developer workflow.

The public `touba version` command reads package versions from the installed
package files and falls back only when a package file is missing from an old or
broken build.

From the source workspace, use:

```sh
pnpm --dir touba/implementation exec touba version --json
```

This must resolve the workspace-local `touba` binary and report package versions
as `0.1.0` with the `local-development` distribution channel.

## Schemas

Schema and protocol versions are independent from package versions. Examples:

- `air-minimal-v0.1`
- `trace-minimal-v0.1`
- `touba-manifest-v1`
- `touba-lock-v0.1`

Do not replace these schema identifiers with npm package versions.

## Runtime Baseline

Node.js is accepted as a range:

```text
>=24 <25
```

The pinned `24.15.0` value may appear in reproducibility notes or local caches,
but package `engines.node` should use the range unless a component has a
documented reason to require an exact patch.

## Distribution Channels

`touba version --json` reports a distribution channel:

| Channel | Meaning |
| --- | --- |
| `local-development` | command executed from the source workspace |
| `local-archive` | local archive installation |
| `macos-local-release` | macOS release archive installed with a manual reinstall policy |
| `github-release` | public archive installed from a GitHub Release asset |

Seeing `0.0.0` or `unknown` in `touba version` indicates an old or incomplete
installation, not the current source state. Rebuild and reinstall the local
toolchain before investigating runtime behavior.

## Public Release Index

The machine-readable public release index lives at
`implementation/release/releases.json`. It records the current Touba version,
the expected public platforms, the release tag, the archive names, checksum
assets and the status of each managed version.

Each managed version must also point to a structured release note under
`implementation/release/notes/v<version>.md`. The note is the canonical
human-readable description of the delta from the previous published version:
what was added, what changed, what was fixed, what affects security and
governance, whether a migration is required, what validation evidence supports
the release and which known limits remain on the roadmap.

Use `implementation/release/notes/TEMPLATE.md` for every new version. Do not
publish a version from ad hoc commit inspection alone. The release index must
carry the matching `summary`, `released_on`, `release_notes`,
`breaking_changes`, `migration_guide`, `evidence` and `compare_url` fields so
agents, maintainers and external users can understand version differences
without reverse-engineering the repository history.

Published versions are retained by default. A version is not removed from the
release index because a newer version exists. If a version must no longer be
recommended, the maintainer marks it `retired` or `yanked` with an explicit
decision record in the `retirement` object. GitHub Release assets should remain
available unless the principal maintainer explicitly decides otherwise.

Before publishing a version, run:

```sh
pnpm --dir touba/implementation release:versioning -- --version 0.1.0
pnpm --dir touba/implementation test:release-versioning
```

The release workflow runs the same gates before building archives. It refuses a
version when `package.json`, `release/releases.json`, the structured release
note, `CHANGELOG.md` and the GitHub Release workflow are not aligned.

## Public Release Workflow

The public CLI release is produced by `.github/workflows/release.yml` through a
manual `workflow_dispatch` run. The workflow:

1. validates the requested semver against the release index;
2. builds and smoke-tests native archives for macOS Apple Silicon, macOS Intel,
   Linux x64 and Windows x64;
3. assembles a single publishable asset set with `SHA256SUMS`,
   `CHECKSUMS.json` and release notes generated from the canonical version
   note;
4. creates or updates the GitHub Release without deleting previous versions.

The workflow can create a draft release first. Publication remains a maintainer
decision; the pipeline provides the reproducible artifact path.
