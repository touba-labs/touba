# Contributing

Contributions and feedback are welcome when they strengthen the repository
scope described in `README.md`.

## Contribution Principles

- Keep changes focused and reviewable.
- Match the public concepts and terminology used by the project.
- Add or update tests when behavior changes.
- Update documentation when user-facing behavior, commands, formats or concepts
  change.
- Do not commit secrets, credentials, private data, generated build outputs or
  machine-specific configuration.
- Do not overstate security, compliance, production readiness or guarantees
  that are not implemented and documented.
- Attribute work to the human or organization responsible for the contribution.
  Do not add automation tools as authors, signatories or co-authors.

## Before Opening A Pull Request

1. Read the repository `README.md`.
2. Check existing issues and pull requests for related work.
3. For substantial changes, open an issue first and describe the problem,
   proposed direction and impact.
4. Keep the pull request scoped to one topic.
5. Include validation notes: tests run, documentation checked and known limits.

## Commit Messages

Use clear, scoped commit messages:

```text
docs: clarify runtime trace terminology
runtime: reject unauthorized tool invocation
tests: add governed skill fallback fixture
```

Avoid vague messages such as `update`, `fix`, `changes` or `misc`.

## Review Standard

Reviewers check:

- correctness of the change;
- alignment with the repository scope;
- test and documentation coverage;
- security and governance implications;
- clarity of public terminology.

Changes that affect authority, execution, tools, skills, memory, traces,
packages or external effects require extra care and explicit validation.
