# Working on neatroots

neatroots checks AI agents on the developer's machine. Read `README.md` and `docs/architecture.md` first.

## Ground rules

- Public inputs only: the public Neatlogs SDKs and their telemetry schema and doctor contract,
  OpenTelemetry, MCP, publicly documented APIs (Jev), openly licensed models. Never copy code,
  prompts, schemas or logic from Neatlogs' internal services. UI components are the exception: the
  primitives in `packages/ui/src/components/{ui,neat-ui,list-page,detail,kpi}` are shared with the
  Neatlogs app's design system; keep them in step with it rather than restyling them here.
- Local by default. Nothing leaves the machine unless the user turns it on (cloud forward, Jev cloud, a hosted LLM).
- Keep `/v1/traces` and the doctor read-back compatible with what the public SDKs send to
  ingest.neatlogs.com; keep stored spans lossless so cloud forwarding stays exact.

## Commands

```bash
pnpm install && pnpm build
pnpm test                                  # server and TypeScript steering tests (vitest)
(cd python/neatroots-steer && python -m pytest)  # needs a venv with pytest
pnpm typecheck                            # all pnpm workspaces
pnpm --filter @neatlogs/neatroots-ui e2e   # Playwright: builds nothing, so pnpm build first
sh examples/run-all.sh                     # agent and HTTP API examples against a running neatroots; browser, import-files, refund-agent, samples by hand
node scripts/perf-smoke.mjs                # performance smoke test on a generated store (runs nightly; pnpm build first)
```

## Conventions

- Node ≥ 22, ESM, TypeScript strict. Files under 500 lines (shared UI primitives are kept as the app has them).
- The server logs to stderr only (stdout belongs to `neatroots mcp`).
- UI: build pages from the shared primitives: `ListPageLayout` (+ `ListPageTable`) for list pages,
  `DetailLayout` with a property rail for a run, `Panel`, `Sheet` for one item's detail, `EmptyState`.
  Tailwind v4 semantic tokens only (no raw colors), Hugeicons through `components/ui/icon.tsx`,
  StatusPill for state and NeatBadge for categories, one primary (default) Button per view,
  `PendingButton` for actions that run, Verb + Noun labels on actions.
- UI layout: rows in a list share one fixed height; anything that can grow (problem lists, traces,
  panels on Home, sheet bodies) sits in a fixed-height box that scrolls inside, so neighbours stay
  aligned. Check light, dark and a 390px width with screenshots before calling UI work done.
- Checks: library YAML in `packages/neatroots/library/`; yes/no questions are phrased as failures.
- The name is always lowercase: neatroots, in prose, the UI and docs (code identifiers such as
  `NeatrootsHalt` follow their language's conventions).
- New UI flows get an e2e spec in `packages/ui/e2e/`; tests must pass when repeated
  (`--repeat-each=3`), so don't depend on state another test changes.
- Examples default to the mock LLM and need no API keys; `REAL_LLM=1` switches to real providers.
