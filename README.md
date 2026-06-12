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

## Repository Scope

This repository contains the Touba language and runtime core:

- language specifications;
- parser, AST and AIR generation;
- runtime and trace contracts;
- command-line tools;
- SDK and handler contracts;
- examples, fixtures and validation tests.

## Contributing And Feedback

Contributions, bug reports, proposals and documentation feedback are handled
through GitHub Issues and pull requests.

Read `CONTRIBUTING.md`, `FEEDBACK.md`, `SECURITY.md` and
`CODE_OF_CONDUCT.md` before opening a change.

## Authors

Touba is authored by Khadim Lo, Jean-Sebastien Dessureault and Soukaina Alaoui Ismaili. Khadim Lo is the principal maintainer. See `AUTHORS.md` for roles and contact addresses.

## License

This repository is licensed under the MIT License. See `LICENSE`.
