# Security policy

## Supported versions

Security fixes go into the latest release. Update with `neatroots update`.

## Reporting a vulnerability

Report it privately, never in a public issue, pull request or discussion:

1. Open the repository's [Security tab](https://github.com/neatlogs/neatroots/security) and choose
   **Report a vulnerability** (GitHub's private vulnerability reporting).
2. Describe the problem, how to reproduce it, the version (`neatroots --version`), and what an attacker
   could do with it. Don't include real traces, API keys or customer data.

We acknowledge reports within 3 business days and agree on a fix and a disclosure date with you. The
fix ships with a GitHub Security Advisory that credits you, unless you'd rather not be named.

## Scope

This repository: the local server and CLI, the web app, ingest, storage and search, checks, MCP tools,
replay, cloud forwarding and redaction, the installer, and the steering hooks (`packages/steer-ts`,
`python/neatroots-steer`).

The hosted Neatlogs services and the SDKs in other repositories are out of scope here; report those to
Neatlogs through their own channels.

[What leaves your machine](README.md#what-leaves-your-machine) and the security notes in
[docs/architecture.md](docs/architecture.md#security) describe neatroots' boundaries.
