# Contributing to neatroots

Thanks for helping. neatroots gets more pull requests than the team can review, so these rules keep
reviews moving and put your work where it helps people using neatroots most.
[MAINTAINERS.md](MAINTAINERS.md) says who decides and how issues are triaged.

## Before you write code

- **Start with an issue.** Search first, and comment on an existing issue rather than opening a new one.
  - **Bugs** need steps to reproduce, the version (`neatroots --version`) and what you expected.
    Issues labeled `needs-repro` wait for those.
  - **Features** need the `accepted` label before a pull request. Open a feature request, describe the
    problem first, and wait for a maintainer to agree on the approach. Questions and ideas you want to
    talk through go to [Discussions](https://github.com/neatlogs/neatroots/discussions).
- **Claim the issue.** Comment that you're working on it, and a maintainer assigns it to you. One pull
  request per issue: if someone already has one open, review theirs instead of opening another.
- Issues labeled `good first issue` and `help wanted` are ready to pick up.

## Limits

- At most **5 open pull requests** per contributor, drafts included. GitHub won't let you open another
  until one of yours is merged or closed.
- Small, focused changes are reviewed first. Aim for under 400 changed lines, and split bigger work into
  steps agreed on the issue.

## Setting up and testing

```bash
pnpm install && pnpm build
pnpm test                                        # server and TypeScript steering tests
pnpm typecheck                                   # all workspaces
(cd python/neatroots-steer && python -m pytest)  # Python steering hook (needs a venv with pytest)
pnpm --filter @neatlogs/neatroots-ui e2e         # UI end-to-end tests (run pnpm build first)
sh examples/run-all.sh                           # the examples, against a running neatroots
```

For manual testing, give neatroots its own home and ports, so it doesn't touch a neatroots you use:

```bash
NEATROOTS_HOME="$(mktemp -d)" node packages/neatroots/dist/cli.js start --port 4999 --grpc-port 0 --no-laya
```

[AGENTS.md](AGENTS.md) has the code conventions, and [docs/architecture.md](docs/architecture.md) the code map.

## What a pull request needs

- **One problem**, linked to its issue (`Fixes #123` in the description).
- **A test that fails without your change.** New UI flows get an e2e spec in `packages/ui/e2e/` that
  passes with `--repeat-each=3`. UI changes also need screenshots in light, dark and at a 390px width.
- **A conventional title**: `fix(store): …`, `feat(checks): …`, `docs: …`, `perf(ingest): …`.
- **CI green, and every review comment answered.** CodeRabbit reviews each pull request first: reply to
  or resolve each of its comments before asking for a maintainer's review.
- Leave `.github/`, the release scripts and the installer alone unless an issue asks for the change.

## AI-assisted contributions

Welcome, on the same terms as any other: you have run the tests, you understand every line, and you can
explain and change it in review. Pull requests generated in bulk, and automated comments such as
`/claim`, are closed.

## Reviews and response times

Maintainers review in this order: `accepted` roadmap work, bugs with a reproduction, small fixes, then
the rest. We aim to respond within a week. Review decisions are final for that pull request; a closed
one can come back once its issue is agreed.

## Bounties

Only issues labeled `bounty`, with the amount posted on the issue before work starts, are eligible. See
[MAINTAINERS.md](MAINTAINERS.md#bounties).

## Security and conduct

Report vulnerabilities privately, never in a public issue: see [SECURITY.md](SECURITY.md). Everyone
taking part follows the [code of conduct](CODE_OF_CONDUCT.md).

## License

Contributions are licensed under the project's [Apache-2.0](LICENSE) license.
