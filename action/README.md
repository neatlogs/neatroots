# neatroots saved-run checks

Use the action from this repository after checking out your saved traces:

```yaml
steps:
  - uses: actions/checkout@v4
  - uses: neatlogs/neatroots/action@FULL_ACTION_COMMIT_SHA
    with:
      runs: test/fixtures/runs
      checks: .neatroots/checks
      only: tool-cycle,repeated-tool-call
```

`runs` accepts newline-separated files or directories. Directories recursively
include `.json` and `.jsonl` files; symlinks, including ancestor directory links,
are rejected. `checks` accepts newline-separated extra check directories; each
explicit directory must exist and be a directory without symlink components,
otherwise the action exits 2 before running checks. Paths are relative to the workflow's
working directory; spaces are supported, shell expressions and globs are not
expanded. `only` is passed as comma-separated rule IDs.

Linux and macOS are supported. Replace `FULL_ACTION_COMMIT_SHA` with the reviewed
commit that contains this action. Node 24.14.1 is set up first and remains on
`PATH` for subsequent steps in the caller's job. Run this action after your own
Node-dependent steps, or call `actions/setup-node` again afterward to restore
your required Node version. The bundled
`install.sh` builds the exact public source commit recorded in `source.json`
(`9fe36a7dce4b82d62d29e6311ca73a7f6fe46e45`), with no service,
coding-agent connection, model download or profile edits. The isolated installation
is cached by full source commit, installer/helper digest, Node version, OS and CPU.
The installation cache is saved immediately after a successful install, before
checking saved runs, so findings do not prevent caching and later invocations
in the same job can restore it.
The installer environment is controlled; ambient source/bundle/repository settings
cannot replace the pinned source. Source is fetched by SHA before invoking the
installer because its `git clone --branch` mode cannot fetch a raw commit ID.

The v0.2.8 bundle lacked `neatroots check`. This action retains its tested source
installation design and pins a reviewed commit containing the CLI and current
security fixes, independently of release availability.

Installation downloads public Git source, pinned pnpm and lockfile dependencies,
and builds the app. Checking itself uses
only `neatroots check --json`: no server, model calls or cloud uploads. A temporary
neatroots home prevents ambient user checks from affecting the gate. The action
preserves exits 0 (clean), 1 (finding), and 2 (invalid input/configuration or action
failure). GitHub marks both nonzero exits as failed steps.

Each finding produces an error annotation with its check, trace and evidence span
IDs. A summary table uses the same identifiers. The CLI currently supplies no
severity or rendered message: findings are CI errors with the fixed message
“Rule fired”. To avoid publishing secrets, trace names, paths, custom titles,
finding parameters, raw JSON, stdout/stderr diagnostics and configuration error
text are withheld. IDs must match conservative formats; check IDs should be
non-sensitive slugs. At most 50 annotations, 200 table rows and 20 span IDs per
finding are published; the verdict still considers every finding. JSON output
is limited to 16 MiB and execution to five minutes; excess is exit 2.

Run the wrapper tests with `node --test action/run.test.mjs`. The repository's
action workflow tests known clean and failing traces through the actual composite
action with its pinned CLI on Linux and macOS. Ambient `NEATROOTS_*`
installer controls are cleared so they cannot replace the pinned source build or cached installation.
