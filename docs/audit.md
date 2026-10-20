# Local audit export and verification

`audit export` saves an original, unredacted local record. `audit verify` checks its
bytes and append-only manifest. Optional audit mode archives covered runs before
retention or explicit deletion releases their live copy. It does not claim that every
agent on this machine is traced.

Start neatroots, then use a full trace ID:

```sh
neatroots audit export 0123456789abcdef0123456789abcdef
neatroots audit verify
neatroots audit verify --expect-head <previously-saved-head>
```

Both commands use the running local server (`--port` selects its port). The default
directory is `audit/` inside that server's neatroots home, normally `~/.neatroots/audit`.
Use `--directory /absolute/path/to/archive` on either command to select another local
folder. The CLI resolves explicitly supplied relative paths in the caller's working
directory before sending them to the server; an omitted path retains the server-owned
default. Direct API paths are interpreted on the server's machine. The commands print `seq` and
`head`; verification exits nonzero on any reported problem. Save the head outside the
archive, for example in a separately retained note, ticket, or Git commit.

Archives are **plaintext, unencrypted**. New directories have mode 0700 and files 0600
on POSIX. An existing POSIX destination must have user-only permissions. On Windows,
new archive directories receive a protected ACL granting inheritable Full control to
the current account, SYSTEM and local Administrators. Windows mode 0700 is not treated
as ACL evidence. An existing Windows destination is inspected, never automatically
repermissioned: inherited access, other allowed principals, or missing inheritable access
for the current account produces an actionable error before any archive data is written.
Choose a new destination or review the selected folder's Advanced Security settings;
the command never changes permissions on unrelated existing contents. The selected archive
directory cannot itself be a symlink. POSIX ancestors may use root-owned system aliases,
such as macOS `/var` and `/tmp`, only when the link's parents and target path are also
root-controlled (root-owned sticky temporary directories are supported). User-controlled
aliases, unsafe target components, all native Windows directory links, traversal components,
hard-linked archive files, filesystem roots, and unrelated directory contents are refused.
File handles are fsynced on Windows as well as POSIX. POSIX directory fsync is also used;
Node does not establish an equivalent native Windows directory-flush guarantee, so no
equivalent power-loss guarantee for directory entries is claimed on Windows. Nothing here
deletes archives or limits their disk usage. Keep enough space and protect your backups.


## Archive before release (opt-in)

Audit mode is off by default. Set global defaults and per-project overrides in the
server home's `config.yaml`, following the existing `projects` convention:

```yaml
audit:
  enabled: false
  directory: "" # empty uses this server's home/audit; otherwise use an absolute local path
projects:
  payments:
    audit: true
  scratch:
    audit: false
```

With `audit.enabled: true`, projects inherit coverage unless they explicitly set
`audit: false`. A missing project override inherits the global setting. Runs without
a project and synthetic doctor probes are always exempt. Merely connecting a coding
agent over MCP does not trace that agent. Settings → Audit controls archive protection
separately from capture evidence; connection discovery cannot enumerate uninstrumented agents.

Covered runs are archived, unredacted, after a root/completion marker and idle checks.
Automatic archiving coalesces change events with a single 1.5-second timer and
processes at most 32 runs per synchronous batch. Every 30 seconds it also scans the
next page of up to 32 live runs, including after restart, to capture manual edits
without events and retry eligible work. Periodic pages get space even while change
events keep arriving. A complete periodic pass can take more than 30 seconds on a
large store; this is not a 30-second capture guarantee. A batch verifies the whole
archive once, and once more if it appends versions. Large histories or individual
snapshots can still block the server while this synchronous work runs. The engine's delayed
end work and on-demand investigations/explanations/rechecks count as processing.
An intentionally disabled/missing engine or unfinished/interrupted checks holds the
run visibly. Restore the engine or re-run interrupted work to release it. Settled
failed checks are still archivable evidence: audit preserves the recorded outcomes,
not a certificate of successful checks. An agent's error status is also archivable.

Both explicit run deletion and retention require a newly verified archive of the
current snapshot. Late spans, findings, decisions, summaries, explanations, annotations
or run-row changes append another immutable version; unchanged snapshots do not.
The comparison uses the actual stored OTLP and sidecar bytes, with no synthesized
completion markers. Archive writes and the delete guard are synchronous in the
running server, so ingest/check callbacks cannot interleave verification and removal.
A failed write or verification leaves the run live; explicit DELETE returns HTTP 409
with the hold reason. Recovery does not silently remove interrupted archive artifacts.

Within one retention sweep, a shared archive access or verification failure holds
remaining covered candidates without rescanning the failed archive. Run-specific
payload failures do not block healthy runs. The next sweep retries, and successful
selection never replaces fresh verification at final deletion.

Retention retains its age cutoff, pin exemption, oldest-first size selection and
low-water target. It skips held candidates and counts their bytes as still present;
shared blobs held by those runs are not counted as freed. Once archiving succeeds,
normal retention can release the live copy. If held/pinned runs or fixed database
pages prevent meeting the cap, live storage can remain above it. A pin continues to
exempt a run from scheduled retention, not an explicit delete request. Archives are
outside the live-store cap, survive live deletion, and grow without an automatic
retention/delete policy. Plan archive disk capacity separately.

`neatroots audit status` (or `GET /api/audit/status`) reports covered live runs,
held runs, current archived live runs, historical archived runs/version entries,
failures and hold reasons, and `seq`/`head`. `held_bytes` and `archived_live_bytes`
use the last observed serialized snapshot size while local revisions match, otherwise
an inline metadata estimate that excludes offloaded payloads and shared-blob attribution.
Retention uses database-plus-blob accounting; status `live_store_bytes` reports allocated
SQLite pages only. `archive_bytes` is the last successfully observed bundle and manifest
size, including historical versions and excluding filesystem metadata; totals remain
unknown until a successful observation. Status is read-only and reports no span/sidecar
content. It does not re-verify archive contents. Explicit verification and archive operations
inspect contents, so large histories can still make deletion slow. Local permissions and the threat model below
still apply; the hold cannot prevent another same-user program deleting files.

Observations and snapshot measurements are scoped to their archive directory. The process
retains the 16 most recently observed directories; older entries become unknown rather
than verified. None of these cached observations authorizes deletion.

The existing Settings API accepts `audit_enabled` (boolean), `audit_directory`
(absolute path or empty for default), and `project` plus `audit` (boolean, or null to
restore inheritance). Reserved project names `__proto__`, `constructor`, and
`prototype` are rejected before any setting changes. Inherited object properties
never supply audit overrides. Settings appear as `config.audit` in `/api/status` and the effective
`settings.audit` in `/api/projects`. Invalid requests apply no partial settings.
Permission/path failures are surfaced at archive time and in audit status. Changing
the configured directory chooses a new trail; keep old trails and their saved heads.
Explicit export/verify use this configured directory unless `--directory` overrides it.

## Contents and reimport

Each explicit export appends a fresh version, even if the run has not changed.
Automatic archiving and deletion checks reuse the last verified version when both
current snapshot files have exactly the same bytes:

```text
audit/
  manifest.jsonl
  00000001-<uuid>/
    trace.json
    record.json
  00000002-<uuid>/
    trace.json
    record.json
```

`trace.json` is actual OTLP JSON accepted by the existing file importer. It contains
the stored resource, scope, and span fields, with hydrated large payloads and typed
values preserved. Missing or corrupt referenced payloads cause export to fail.
The export does not attach findings to the spans, redact them, or synthesize completion
markers. A run that was incomplete stays incomplete. Existing markers stay unchanged.

`record.json` has format `neatroots-audit-record-v1`: the original run row, all its
findings, decisions and explanations, summary, annotations, and recorded import source.
These are a historical record, not instructions to the importer to recreate database rows.
The snapshot is read in one SQLite transaction before writing either file.

```sh
neatroots import /absolute/path/to/archive/00000001-<uuid>/trace.json
```

Import spans from `trace.json`, not `record.json` or `manifest.jsonl`. With the check
engine enabled, findings are re-derived by the checks currently installed. Original
finding IDs and decisions are not restored. An imported run is never automatically
forwarded to Neatlogs Cloud, even in a project with forwarding enabled; an explicit
cloud-forward command remains available. Import provenance is stored beside the run,
without modifying the imported spans or resources, and persists across restart. Only that
local metadata establishes import provenance: a sender's `neatroots.import.source` field
is preserved as data and cannot suppress configured forwarding. Older records with only
that field have unknown provenance. Import metadata and span replacements commit together
before replaced payloads are reclaimed or trace events are emitted. If a
deleted run's old checks are still active, reimport fails with a retry message rather
than mixing old check state with the new run. `--project` on import deliberately changes
the project resource attributes, as it does for any other file import.
The existing file-import API has a 64 MiB request limit (including JSON wrapping).
Larger archives still preserve the original data, but need to be split into smaller
OTLP requests for reimport; this stage does not change that limit.

## Redacted sharing

An original archive must exist first. To preview a share copy of its latest version:

```sh
neatroots audit export <trace-id> --redacted --preview
neatroots audit export <trace-id> --redacted --output /absolute/path/to/share
```

The second command prints the preview and asks before writing. `--yes` accepts that
displayed preview for unattended use. The API similarly requires the current preview
token before writing. Share output must be a separate directory outside the original
archive, with its own manifest; it never replaces the original. Sharing works after the
live run is deleted. The share sidecar is marked `redacted: true` and identifies its
source entry hash; its `record` member holds the redacted historical record.

Span redaction uses the same configured rules, field coverage, and masked-hit preview
as cloud forwarding. Every sidecar string value and key, including nested decision
answers and explanation text, is passed through those rules too. JSON field names stay
available to context-sensitive credential rules: a `password` or `client_secret` leaf is
masked as a whole, including short strings, numeric and boolean values, and escaped suffixes.
Other primitive values retain their types. Invalid rules fail
closed. Changed content/rules invalidate a preview token when the resulting bytes
change. Redaction is pattern-based, not a guarantee that a file contains no confidential
information: review the share files before sending them. In particular, the existing
span rules do not scan every OTLP structural string (such as schema URLs, trace state,
or attribute keys); those limitations also apply here. Masked previews retain short
prefixes/suffixes under the existing preview convention. Redacted copies intentionally
lose information and are never described as the original audit record.

## Hash format and durability

Each manifest line is compact UTF-8 JSON followed by LF. Genesis is fixed:

```json
{"seq":0,"ts":"1970-01-01T00:00:00.000Z","trace_id":"","path":"","bundle_sha256":"","sidecar_sha256":"","prev":"0000000000000000000000000000000000000000000000000000000000000000"}
```

The actual genesis line also has `entry_sha256`, calculated as below. Subsequent lines
have these same fields and `entry_sha256`. `seq` increments by one, `ts` is the export's
ISO timestamp, and `path` is the relative version-directory path to `trace.json`.
`bundle_sha256` hashes the **exact written trace.json bytes**; `sidecar_sha256` hashes
the **exact written record.json bytes**. This extra sidecar hash binds both artifacts.
`prev` is the previous entry's `entry_sha256`.

Entry hashing is SHA-256 over UTF-8 `JSON.stringify` of a newly constructed object in
exactly this key order, with no whitespace or newline:

```text
seq, ts, trace_id, path, bundle_sha256, sidecar_sha256, prev
```

The hash excludes `entry_sha256` itself. File hashes include their trailing LF and
formatting; verification does not recreate them from the live store or reserialize them.

The server is the sole writer. Each synchronous export also exclusively creates
`.writer.lock`, preventing another server from writing to the same folder. Each artifact
is written to a new temporary file, fsynced, then published using an exclusive hard link;
its directory is fsynced before the manifest line is appended and fsynced. Existing
versions are never overwritten. Filesystems must support hard links and fsync correctly.
These are durability operations, not proof of hardware persistence. Native Windows
supports the file-handle fsync steps, but this implementation cannot establish equivalent
directory-flush guarantees there. A sudden power loss can therefore affect directory
entries differently; verification reports missing or partial artifacts after recovery.

Verification walks the manifest and directory together and reports edited, missing,
unsafe, extra, and out-of-chain artifacts, malformed entries, and broken sequence/hash
links. Special files such as FIFOs are refused; nonblocking opens and identity checks
also detect replacement around a read. Failed writes can leave a partial manifest line, orphan version directory,
temporary file, or stale lock. These are reported and block further exports; they are
not silently repaired or deleted. Preserve the folder for investigation. Before manually
moving interrupted artifacts to a separate recovery folder or removing a stale lock,
confirm no server is still writing and retain the original evidence and saved head.

## Threat model

This is tamper **evidence**, not tamper prevention. A process running as your account
can delete files, rewrite the entire chain, change permissions, or race filesystem
operations. Directory checks and exclusive writes protect against ordinary mistakes,
not a hostile same-user process. Internal hashes detect inconsistencies, but a rewritten
consistent history or a removed tail can only be detected against a head saved elsewhere.
Verification without an external head cannot distinguish an intentionally shorter valid
archive from a truncated one. It does not prove that a crash-durable write reached faulty
hardware, that a trace producer was truthful, or that uninstrumented work was captured.
The chain protects the record after export; it does not authenticate the original agent.

The local API routes are `POST /api/audit/export` (`trace_id`, optional `directory`,
`redacted`, `output`, `preview`, `preview_token`) and `POST /api/audit/verify`
(`directory`, optional `expect_head`). They use the existing loopback Host/Origin checks.
Verification is read-only. Export and verification currently scan the full archive; large
archives can block the local server while the synchronous operation completes.

## Capture coverage

Settings → Audit and `neatroots audit status` distinguish retained capture evidence
from archive protection. Counts exclude synthetic doctor probes and describe the
current local store, not lifetime executions or archived-only history. A stored run
with spans and trusted local import metadata counts as imported. A run with spans
and no local import metadata counts as received/traced. Sender-supplied import
attributes do not count as trusted provenance. A row without spans or with unusable
local provenance is unknown. These three categories are disjoint.

Guidance delivered counts distinct retained runs with a locally recorded delivered
note. It overlaps capture categories and does not prove the agent obeyed a note.
No telemetry payload, note text, replay command or connection configuration path is
included in the coverage response. Project-level counts expose only project labels,
counts, effective protection and explicit overrides.

MCP connection discovery reuses the existing known-client file/configuration checks,
without running agent commands. Results are cached for 30 seconds. A connected client “reads neatroots over MCP — its own runs are not captured”.
That label describes the connection itself: independent instrumentation may exist,
but connection metadata does not establish it. Discovery failure is reported separately
from stored-run counts. Closed, web and unknown agents that send no telemetry cannot
be enumerated or measured here. This page does not claim complete machine coverage.

The Audit page has global protection and per-project Inherit/On/Off controls, separate
from capture evidence. Save failures retain edits. The doctor command renders optional
coverage after its existing probe handling; unavailable, malformed or older-server
responses are nonfatal and do not change its transport exit status or probe flow.


### Status observations and upgrade privacy

Status, Settings and doctor reads use SQL aggregates and the last archive observation;
they do not walk or hash archive files or hydrate stored payloads. `verified` is null
on status reads: only explicit verification or archive operations inspect contents.
`last_observed_verified` and `observed_ms` describe that earlier operation.
`observation_state` is unknown on a cold start or after choosing another directory,
current when observed local revisions and directory/manifest metadata still match,
stale after local evidence or observed directory metadata changes, and error after
an archive operation fails. Current metadata is not proof against external file edits.
Deletion always freshly verifies contents, regardless of these status observations.

Archive counts and bytes are the last observed totals, with `archive_totals_known`
false until a successful observation supplies totals. A later failure retains only
those explicitly last-known totals. Live bytes use the last measured snapshot only while its local
revision matches; otherwise they estimate stored inline metadata and exclude offloaded
blob contents. `byte_estimate` identifies this mixed estimate. `live_store_bytes` on
status is allocated SQLite pages only, explicitly marked by `live_store_bytes_kind`;
it is not the retention cap's database-plus-blob measurement. Changed findings,
annotations, spans and run metadata invalidate observed snapshots. Only the existing
bounded capture lane refreshes them automatically; status does not trigger a rescan.

At the first provenance cutover, existing trace IDs lacking trusted local import
metadata are durably classified as unknown. They are excluded from automatic cloud
forwarding across later updates, deletion/redelivery and restarts. No sender attribute
is used to infer an authentic import. This deliberately protects old traced runs too
when their origin cannot be established. New received runs remain eligible for
configured automatic forwarding; new local imports remain excluded. Explicit
user-requested forwarding is separate from this automatic privacy guard.

Audit settings are saved before the active policy changes. A failed config write keeps
the prior saved file and active protection, including project overrides and archive
directory; mixed settings requests do not emit a successful settings event on failure.
