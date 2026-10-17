# Contributing to neatroots

Start with the [README](README.md) and [architecture](docs/architecture.md).
Follow [AGENTS.md](AGENTS.md) for project boundaries and coding/UI conventions, and
[MAINTAINERS.md](https://github.com/neatlogs/neatroots/blob/main/MAINTAINERS.md) for ownership and how contributions are handled.

## Reporting an issue

Search the [existing issues](https://github.com/neatlogs/neatroots/issues) first.
Use the [bug report](https://github.com/neatlogs/neatroots/issues/new?template=bug-report.yml)
for defects or the [tester report](https://github.com/neatlogs/neatroots/issues/new?template=tester-report.yml)
for feedback from the [tester guide](docs/tester-guide.md).
Include the version or commit, OS, reproduction steps, and expected versus actual behavior.
Use synthetic traces or mock-backed examples, and remove API keys and customer data from logs.

## Local setup

Use macOS or Linux, or WSL on Windows, with Node.js 22 or newer and the pnpm version in
[package.json](package.json). [.nvmrc](.nvmrc) selects the development Node major version.
These commands use a POSIX shell and start at the repository root:

```bash
pnpm install --frozen-lockfile
pnpm build
```

For development, run these in separate terminals (server port 4100, UI port 5173):

```bash
NEATROOTS_DEV_ORIGIN=http://localhost:5173 pnpm --filter @neatlogs/neatroots dev
```

```bash
pnpm --filter @neatlogs/neatroots-ui dev
```

For Python steering work, create a virtual environment and install its test extra:

```bash
python3 -m venv .venv
. .venv/bin/activate
python -m pip install --upgrade pip
python -m pip install -e "python/neatroots-steer[test]"
```

See [pyproject.toml](python/neatroots-steer/pyproject.toml) for supported Python versions.

## Validating a change

[ci.yml](.github/workflows/ci.yml) is the source of truth for checks and runtime versions.
For code changes, run:

```bash
pnpm build
pnpm typecheck
pnpm test
git diff --check
```

The root test command covers the server and TypeScript steering suites. For Python changes,
run `python -m pytest python/neatroots-steer -q` with the virtual environment activated.
For UI changes, build first, then run:

```bash
pnpm --filter @neatlogs/neatroots-ui exec playwright install --with-deps chromium
pnpm --filter @neatlogs/neatroots-ui e2e
pnpm --filter @neatlogs/neatroots-ui e2e --repeat-each=3
```

Include light/dark and 390px screenshots, following the UI conventions in AGENTS.md.
For ingestion, SDK, steering, or replay changes, run the relevant
[examples](examples/README.md). After building, start the server in one terminal:

```bash
NEATROOTS_HOME="$PWD/.neatroots-dev" node packages/neatroots/dist/cli.js start
```

In another terminal at the repository root:

```bash
NEATROOTS_BIN="node $PWD/packages/neatroots/dist/cli.js" sh examples/run-all.sh
```

The runner needs `uv`, Node.js, `python3`, and `curl`, and starts a mock LLM if needed.
Use a checkout path without spaces: the runner splits `NEATROOTS_BIN` into arguments.
If port 4100 is occupied, start the server with `NEATROOTS_PORT=4101` and run the examples
with `NEATROOTS_URL=http://localhost:4101`. Examples use mocks unless `REAL_LLM=1` is set.

## Preparing a pull request

Explain the problem and resulting behavior, link the issue, and list validation results.
Include regression coverage for behavioral fixes and screenshots for UI changes.
Keep affected documentation current. For documentation-only changes, check links, command
accuracy, and `git diff --check`; application tests are unnecessary unless behavior changes.
