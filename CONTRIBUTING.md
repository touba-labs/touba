# Contributing to Touba

Thank you for helping build a language for governed agentic systems.
Contributions and feedback are welcome when they strengthen the repository
scope described in the [README](README.md).

> [!IMPORTANT]
> Never report a vulnerability, a leaked secret or an authority bypass in a
> public issue or pull request. Follow [SECURITY.md](SECURITY.md).

## Ways to contribute

| You want to | Start here |
| --- | --- |
| Report a problem | Open a [bug report](https://github.com/touba-labs/touba/issues/new/choose) with a minimal `.tb` program. |
| Propose a capability | Open a feature request that starts from your use case. |
| Improve the documentation | Open a documentation issue, or send a focused pull request. |
| Ask about a design choice | Open a question. [FEEDBACK.md](FEEDBACK.md) explains what makes feedback useful. |
| Write code | Look for issues labeled [`good first issue`](https://github.com/touba-labs/touba/labels/good%20first%20issue) or [`help wanted`](https://github.com/touba-labs/touba/labels/help%20wanted). |

For substantial changes, open an issue first and describe the problem, the
proposed direction and its impact. It saves everyone a rewrite.

## Your first pull request

1. **Fork and clone** the repository, then build it from source as described in
   [Building from source](README.md#building-from-source).
2. **Branch** from the default branch with a short, scoped name such as
   `feat/<topic>`, `fix/<topic>` or `docs/<topic>`.
3. **Make one focused change.** Add or update tests when behavior changes, and
   update the documentation when commands, formats or concepts change.
4. **Run the checks** that cover your change. From `implementation`:

   ```sh
   cargo fmt --all --check
   cargo clippy --locked --all-targets -- -D warnings
   cargo test --locked
   pnpm validate:v1-local
   ```

   [DEVELOPMENT.md](DEVELOPMENT.md) lists the documentation, manifest and SDK
   checks as well.
5. **Open the pull request** against the default branch, unless a maintainer
   names another integration branch. The template asks for a summary, the checks
   you actually ran, the public impact and the known risks.

Maintainers review every change before merging it or publishing a release.

## Commit messages

Write `type(scope): summary`, in the imperative, with an optional scope.

| Type | Use it for |
| --- | --- |
| `feat` | A new capability. |
| `fix` | A bug fix. |
| `docs` | Documentation only. |
| `test` | Tests only. |
| `refactor` | A change that preserves behavior. |
| `ci` | Workflows and automation. |
| `chore` | Maintenance with no user-facing effect. |

```text
docs: clarify runtime trace terminology
fix(runtime): reject unauthorized tool invocation
test: add governed skill fallback fixture
```

Avoid vague messages such as `update`, `fix`, `changes` or `misc`.

## Contribution principles

- Keep changes focused and reviewable.
- Match the public concepts and terminology used by the project.
- Do not commit secrets, credentials, private data, generated build outputs or
  machine-specific configuration.
- Do not overstate security, compliance, production readiness or guarantees
  that are not implemented and documented.
- Attribute work to the human or organization responsible for the contribution.
  Do not add automation tools as authors, signatories or co-authors.

## Review standard

Reviewers check the correctness of the change, its alignment with the
repository scope, test and documentation coverage, security and governance
implications, and the clarity of public terminology.

> [!WARNING]
> Changes that affect authority, execution, tools, skills, memory, traces,
> packages or external effects require extra care and explicit validation.
> Say in the pull request which of these areas your change touches.

## License

Touba is licensed under the [Apache License 2.0](LICENSE). Unless you state
otherwise, contributions you submit for inclusion are provided under the same
license, as set out in its section 5.

Participation follows the [code of conduct](CODE_OF_CONDUCT.md).
