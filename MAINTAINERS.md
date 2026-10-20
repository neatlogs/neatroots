# Maintainers

neatroots is built and maintained by the Neatlogs team.

| Role | People |
| --- | --- |
| Maintainer | [@akshay-neatlogs](https://github.com/akshay-neatlogs) |
| Core team | [@harshk-neatlogs](https://github.com/harshk-neatlogs), [@taranum-neatlogs](https://github.com/taranum-neatlogs) |

The maintainer decides what goes into neatroots and when it ships. The core team reviews and
merges pull requests and triages issues, and their reviews speak for the project.

## Areas

Pull requests ask each area's owners for a review automatically ([.github/CODEOWNERS](.github/CODEOWNERS)).
The maintainer co-owns every area.

| Area | Owner |
| --- | --- |
| Checks and the check library (`packages/neatroots/src/checks`, `packages/neatroots/library`), docs | [@harshk-neatlogs](https://github.com/harshk-neatlogs) |
| Store and ingest (`packages/neatroots/src/store`, `packages/neatroots/src/ingest`) | [@taranum-neatlogs](https://github.com/taranum-neatlogs) |
| Everything else, including CI, releases and the installer | [@akshay-neatlogs](https://github.com/akshay-neatlogs) |

## How contributions are handled

[CONTRIBUTING.md](CONTRIBUTING.md) has the details. In short:

- **Start with an issue.** Features need the `accepted` label before a pull request; bugs need steps
  to reproduce.
- **One problem per pull request**, linked to its issue, with a test that fails without the change.
- **One pull request per issue.** If someone already has a fix up for an issue, review it instead of
  opening another.
- **At most 5 open pull requests per contributor, drafts included.** GitHub's pull request limit
  (Settings → Moderation options → Interaction limits) blocks a sixth until one is merged or closed.
  Trusted contributors can go on its bypass list.
- **Review decisions are final for that pull request.** The team may close pull requests that
  duplicate another, change behaviour the project decided against, touch `.github/` or release
  scripts without being asked, or don't change code for a code bug.

## Triage

Every new issue starts as `needs-triage`. The maintainer or the core team looks at it within a few
days and labels it:

| Label | Meaning |
| --- | --- |
| `bug`, `enhancement`, `documentation`, `performance`, `security`, `question` | What kind of issue it is |
| `area: …` | The part of neatroots it touches (pull requests get these automatically) |
| `needs-repro` | Waits for steps to reproduce |
| `accepted` | Agreed on; pull requests welcome |
| `good first issue`, `help wanted` | Ready for a contributor to pick up |
| `waiting-on-author` | Waits for the author; closed after three weeks without a reply |
| `blocked` | Waits on another issue or decision |
| `bounty` | A bounty is offered; the amount is in the issue |
| `duplicate`, `wontfix`, `invalid` | Closed, with a link or a reason |

## Bounties

We sometimes offer a bounty on an issue we want done. It depends on the issue: the maintainers decide,
and say so on the issue (labeled `bounty`, with the amount) before work starts. Asking for a bounty in
an issue or pull request doesn't make it eligible.

## Releases

neatroots releases every two weeks from a milestone, after a release candidate.
[docs/releasing.md](docs/releasing.md) is the checklist.
