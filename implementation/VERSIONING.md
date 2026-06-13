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
| `macos-local-release` | local macOS bundle, not signed, not notarized, no public update channel |

Seeing `0.0.0` or `unknown` in `touba version` indicates an old or incomplete
installation, not the current source state. Rebuild and reinstall the local
toolchain before investigating runtime behavior.
