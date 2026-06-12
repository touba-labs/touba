# Touba

Touba is a programming language and runtime for governed agentic systems.

Touba means `Thinking Orchestration Using Bounded Agency`.

The official source extension is `.tb`.

## Scope

This repository contains the core Touba language work:

- public language specifications;
- parser, AST and AIR generation;
- runtime and trace contracts;
- command-line tools;
- SDK and handler contracts;
- examples and tests required to validate the core implementation.

Touba separates capability from authority. A `tool` represents a bounded
external action, a `skill` composes capabilities, and an `agent` carries
responsibility and invocation authority.

## Repository Boundary

This repository is for the language and runtime core.

The public documentation site is prepared separately in `documentation-site`.
The VS Code/editor product is prepared separately in `touba-ide`.

This repository must not publish private notes, journals, draft-only files,
generated builds, secrets or workspace-only reports. Files and directories used
only for internal coordination are ignored before the first public push.

## Status

Status: `initial_public_repo_preparation`

## Remote

Target remote:

```sh
git remote add origin https://github.com/khadimbambalo/touba.git
```
