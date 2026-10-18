# Accessibility

This proposal describes accessibility goals for neatroots and how to report
barriers. It requires maintainer review and adoption; it is not a claim that
these goals have been met.

## Scope and goals

The goals cover the neatroots web app, command-line interface and repository
documentation. People should be able to understand results and complete tasks
using different input methods, display settings and assistive technologies.

For the web app, the goals are:

- Keyboard access to controls and tasks, with visible focus, a logical focus
  order and usable focus handling when dialogs open and close.
- Clear names and labels for controls, meaningful headings and text alternatives
  for images that convey information.
- Status, errors and findings that can be understood without color alone, and
  updates that assistive technology can identify without unnecessary disruption.
- Readable text and control contrast in light and dark themes.
- Usable zoom and reflow, including access to content in scrolling regions.
- Respect for reduced-motion preferences where motion is used.

For the CLI and documentation, the goals are clear text, understandable errors,
copyable commands, descriptive links and instructions that do not depend only
on screenshots, visual position or colored output.

## Current assessment

The repository's [Playwright configuration](https://github.com/neatlogs/neatroots/blob/main/packages/ui/playwright.config.ts)
runs a Chromium project against a real local server with a mock LLM and seeded
runs, using a desktop viewport. The [browser tests](https://github.com/neatlogs/neatroots/tree/main/packages/ui/e2e) exercise
application flows. For example, the [navigation tests](https://github.com/neatlogs/neatroots/blob/main/packages/ui/e2e/navigation.spec.ts)
check the search keyboard shortcut, search focus and theme-button names.

These are automated functional checks, not certification of screen-reader or
keyboard accessibility. This statement does not establish WCAG conformance,
an accessibility audit, or guaranteed browser or assistive-technology support.

Broader keyboard workflows, screen-reader use, zoom and reflow, contrast,
reduced motion, and CLI and documentation accessibility need assessment beyond
those checks. These are assessment gaps, not a list of confirmed defects.

## Report a barrier

Open an issue in the [neatroots issue tracker](https://github.com/neatlogs/neatroots/issues)
with “Accessibility” in the title. Describe the task you were trying to complete,
what happened, what you expected and enough steps to reproduce it.

Include the neatroots version and relevant environment, such as operating
system, browser or terminal. If relevant, mention keyboard use, zoom settings
or assistive technology and its version. Share whatever details you can;
you do not need to provide medical information or disclose a disability.

A screenshot or recording is optional. Issues are public: remove credentials,
private trace content and other sensitive information before posting text or
attachments. A text description is useful even without an image.

## Contributing and ownership

The [maintainer and core team](https://github.com/neatlogs/neatroots/blob/main/MAINTAINERS.md) review proposals and triage reports
under the repository's contribution process. This proposal does not set a
response or resolution deadline.

For UI changes, follow [AGENTS.md](https://github.com/neatlogs/neatroots/blob/main/AGENTS.md), including screenshots in light
and dark themes and at a 390px width. Also manually exercise the affected task
with a keyboard, check focus and labels, and check zoom and reflow. Where
relevant, check reduced motion and assistive-technology behavior. Describe
what you tested, the environment and any gaps in the pull request; screenshots
alone cannot demonstrate keyboard or screen-reader usability.

Add meaningful regression coverage for behavior changes according to the
project rules. Report automated results separately from manual observations,
and update this statement when reviewed evidence changes its assessment.
