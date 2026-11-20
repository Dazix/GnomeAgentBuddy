# Contributing

Thanks for helping. Bug reports, fixes and support for new agents are all welcome.

## Before you start

- For a bug, open an issue with the bug report template. For a security problem, follow [SECURITY.md](SECURITY.md)
  instead and do not open a public issue.
- For a new agent or a larger change, open an issue first so we can agree on the approach before you write code.

## Development

See [Development](README.md#development) in the README: run the extension in a nested shell and run the tests with
`gjs -m tests/run.js` (no dependencies besides `gjs`).

## Pull requests

- Every change goes through a pull request, and the CI `test` job (GSettings schema validation and tests) must pass.
- New logic in the relay, the session model or the hook installer comes with a test in `tests/*.test.js`.
- Keep [What it touches](README.md#what-it-touches-for-reviewers) true. The extension makes no network connection and
  starts no process; a change that would need either is discussed in an issue first.
- Follow the GNOME Shell extension review guidelines: create everything in `enable()`, remove it in `disable()`,
  nothing at import time, no GTK on the shell side.
- Code ported from another project keeps its licence notice in [NOTICE](NOTICE).
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org) (`feat:`, `fix:`, `docs:` …).

By contributing you agree that your contribution is licensed under the [MIT License](LICENSE).
