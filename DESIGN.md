# neatroots finding review

Use the existing Neatlogs app design system. This is a dense local review workflow:
scan findings, inspect evidence, record a judgment, continue. References and their
specific uses are in [docs/design-references](docs/design-references/README.md).

- Typography: existing font-sans for body and controls, font-pixel for page titles
  and navigation, font-mono for span IDs. Body 14px, metadata 12px, no new font.
- Colors: existing semantic background, surface-subtle, foreground, muted-foreground,
  border, success, warning and danger tokens. Both theme variants come from the
  shared tokens; no raw colors, gradients, shaders or theme overrides.
- Layout: ListPageLayout and ListPageTable, 56px rows, sticky filters/header.
  Main finding title truncates; full text lives in a Sheet. Filter controls wrap.
  Secondary table columns hide at narrow widths. No document-level overflow at 390px.
- Detail: right Sheet, full viewport width on phones, at most 40rem on desktop.
  Header and action footer stay fixed; evidence/form body scrolls independently.
  Evidence cards use Panel, 16px padding, 12px gaps and bounded scrolling.
- Components: existing Button, PendingButton, Select, Textarea, StatusPill and
  NeatBadge. Review status uses words as well as color. Finding lifecycle status
  stays distinct from review judgment. One primary action: Save review and next.
- Borders/radii/shadows: use inherited shared component styles. No new shadows or
  custom radii. Keep shared primitives unchanged.
- States: visible loading, empty queue, API error, stale evidence and save conflict.
  Save failures keep the draft. No default verdict. Successful saves advance only
  after persistence. Existing reviews prefill for editing.
- Interaction: keyboard-accessible row buttons and labelled form fields; native
  focus styling. Existing Sheet motion only, respect reduced motion. Counts are
  static tabular numerals; animation provides no benefit here.
- Verification: isolated real-server e2e repeated three times, plus light, dark
  and 390px screenshots. Review uses no model or external service.
