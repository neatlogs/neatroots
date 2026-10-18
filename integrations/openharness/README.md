# neatroots for OpenHarness

This package depends on the OpenCode Neatlogs plugin. Exporter variables alone do
not instrument other engines. It sends to same-machine loopback neatroots only.

## Install

Once this package is published, pin the exact repository commit:

    harness dsh install https://github.com/neatlogs/neatroots --path integrations/openharness --ref <published-commit>
    harness dsh doctor neatlogs/neatroots

For development:

    harness dsh install /path/to/neatroots/integrations/openharness --link

The nested package is self-contained; no parent checkout is required at runtime.
OpenHarness contract tested against commit 7476ac0303000ad62f9ff7f6f9f317abda62e0fd.
Full integration receipts and limitations are recorded in the source repository's
docs/openharness.md. A local Git install is not a public publication receipt.

## Prerequisites and workspace preservation

Node 22+, npm, curl, OpenCode and an already running loopback neatroots are required.
Workspace initialization installs locked neatlogs 1.1.28 into a private
.harness/neatroots-sdk directory. It does not edit your package.json, lockfile,
opencode.json, NOTES.md or other plugin files. An existing conflicting
.opencode/plugin/neatlogs.ts is refused; inspect and explicitly relocate it before
retrying. SDK install errors are failures, not successful instrumentation.

The success marker .harness/neatroots-instrumentation-v1.json is written only after
the pinned plugin imports. It is deliberately absent from the template, so failed
initialization remains retryable even when NOTES.md exists. The official static
checker warns about this deliberate success-marker arrangement. OpenHarness
reports init failures as warnings; do not treat a created pane as proof of tracing.
The doctor checks machine prerequisites and bounded HTTP health; with
HARNESS_WORKSPACE set, it also checks that workspace's SDK import.

## Verify one synthetic run

Copy test/fixtures/marker.yaml into an isolated test neatroots home's checks/
directory before starting that server with its engine enabled. Ask the mock-backed
OpenCode to produce OPENHARNESS_SMOKE_MARKER through a tool. For the exact trace:

    node toolchain/verify-run.mjs http://127.0.0.1:4100 <32-hex-trace-id> openharness-smoke

The verifier requests only that trace, requires completed root/LLM/tool spans and
an actual rule finding referencing recorded spans, and reports coverage separately.
No finding, incomplete coverage, redirects, non-loopback URLs, oversized responses
or the 30-second deadline produce success. Output contains identifiers/counts only.
Rules-only acceptance does not establish model-backed check coverage.

Developer checks: node --test test/*.test.mjs; sh -n toolchain/*.sh.
