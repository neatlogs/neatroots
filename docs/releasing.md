# Releasing neatroots

neatroots releases every two weeks from a milestone. A release candidate (RC) comes first, and only fixes
land between the RC and the release.

## 1. Prepare

- [ ] Everything in the milestone is merged or moved to the next one.
- [ ] CI is green on `main`, and so is the latest nightly run.
- [ ] Security pass over what changed in this release:
  - ingest limits (body size, nesting, field types) and malformed input on `/v1/traces`, `/v1/trace` and gRPC
  - keys from traces reaching object prototypes (`__proto__`, `constructor`)
  - redaction still fails closed, and new credential formats are covered (`packages/neatroots/src/relay/redact.ts`)
  - the local API: Host and Origin checks, framing headers, the warning for a non-loopback `host`
  - MCP tool limits (`query_sql` time and row caps, id prefixes)
  - coding-agent chats: read-only stays read-only
  - time limits on regexes from checks and redaction patterns
  - open Dependabot and code-scanning alerts
- [ ] A version bump pull request, like #444: `packages/neatroots/package.json`,
  `packages/neatroots/src/version.ts`, `packages/ui/package.json`, `packages/steer-ts/package.json`,
  `python/neatroots-steer/pyproject.toml` and `python/neatroots-steer/src/neatroots_steer/__init__.py`.

## 2. Release candidate

- [ ] Tag the merged commit and push the tag:
  `git tag -a vX.Y.Z-rc.1 <commit> -m "neatroots X.Y.Z rc.1" && git push origin vX.Y.Z-rc.1`.
  The release workflow tests, builds the bundle, installs it on macOS and Linux, and publishes a
  pre-release; `latest` still points at the previous release.
- [ ] The team updates with `neatroots update --version vX.Y.Z-rc.1` and uses it for a day or two.
  From 0.2.8 or earlier, use `NEATROOTS_VERSION=vX.Y.Z-rc.1 neatroots update`: its `--version` flag
  prints the version instead.
- [ ] Fixes found in the RC go to `main`. Tag `-rc.2` unless they're trivial.

## 3. Release

- [ ] Tag the verified commit `vX.Y.Z` and push the tag.
- [ ] Replace the generated notes with curated ones (`gh release edit vX.Y.Z --notes-file …`): changes in
  behaviour first, then security, then features and fixes by area, known issues, and thanks to
  contributors.
- [ ] Anyone on the RC restarts neatroots after `neatroots update`. The RC and the release report the same
  version, so `update` doesn't say a restart is needed.
- [ ] Announce on Discord and close the milestone.

Release tags can't be moved or deleted (a repository rule), so tag only a commit that CI has verified.
