import zlib from "node:zlib";
import crypto from "node:crypto";
import type { Roots } from "../core.js";
import { encodeTraceRequest } from "../otlp/codec.js";
import { plainToAny, type KeyValue, type OtlpResource, type OtlpSpan, type ResourceSpansBatch } from "../otlp/types.js";
import { COMPLETE_MARKER } from "../semantics/view.js";
import { compileRules, redactBatches, RedactionPatternError, type RedactionHit } from "./redact.js";
import { getCloudKey } from "./keychain.js";
import { projectSettings } from "../config.js";
import type { ForwardRow } from "../types.js";
import { log } from "../util/log.js";
import { trimSlash } from "../util/url.js";
import { VERSION } from "../version.js";
import { endpointProblem } from "./endpoint.js";

export interface ForwardPreview {
  trace_ids: string[];
  span_count: number;
  redactions: { kind: string; count: number; samples: { where: string; sample: string }[] }[];
  endpoint: string;
  has_key: boolean;
}

/**
 * The cloud relay. neatroots reaches Neatlogs Cloud exactly the way an SDK does: OTLP/protobuf
 * to the public ingest endpoint with the user's own x-api-key. Stored spans are re-exported
 * without loss, redacted first, closed with the public neatlogs.trace.complete marker, and
 * carry neatroots findings as neatroots.* attributes.
 */
const isRedirect = (res: Response) => res.status >= 300 && res.status < 400;
const redirectError = (res: Response) =>
  `the endpoint redirected to ${res.headers.get("location") ?? "another URL"}; neatroots doesn't follow redirects with your API key, so set the endpoint to the final URL`;

/** How many times a completion marker is tried, and the first backoff (doubling) between tries. */
const MARKER_ATTEMPTS = 3;
const MARKER_BACKOFF_MS = 500;

/**
 * Auto-forward: the wait before a finished run is sent (so checks finish and findings travel with
 * it), the first retry delay after a failure that may pass on its own (doubling, at most an hour),
 * and how many sends are tried before giving up (about half an hour of retries).
 */
const AUTO_SETTLE_MS = 1500;
const AUTO_RETRY_MS = 60_000;
const AUTO_RETRY_CAP_MS = 3_600_000;
const AUTO_ATTEMPTS = 6;
/**
 * How long a neatroots holds a queued run it is sending, so another neatroots on the same store
 * doesn't send it too. Longer than one send can take: the wait for checks, the request, its marker.
 */
const AUTO_LEASE_MS = 10 * 60_000;
/** Most auto-forwards sent at once, so a backlog (after a restart, say) goes out a few at a time. */
const AUTO_CONCURRENCY = 4;

/** An import marks its resource with neatroots.import.source; "http" (the live /v1/trace API) and "replay" aren't imports, as in importSource(). */
function importedResource(r: OtlpResource): boolean {
  return r.attributes.some((a) => a.key === "neatroots.import.source" && "stringValue" in a.value && a.value.stringValue !== "http" && a.value.stringValue !== "replay");
}

type Queued = { trace_id: string; attempts: number };
/** When a queued run can next be taken, in SQL: when it is due and nobody holds it. */
const DUE_AT = "MAX(next_ms, COALESCE(claimed_until, 0))";

export class Relay {
  /** Wait before a queued run is first sent. */
  settleMs = AUTO_SETTLE_MS;
  /** First delay before a failed send is tried again. */
  retryBaseMs = AUTO_RETRY_MS;
  private timer?: NodeJS.Timeout;
  /** Runs this neatroots is auto-forwarding, each with the send under way (a send by hand waits for it). */
  private sending = new Map<string, Promise<void>>();
  /** Runs being sent outside the queue (by hand, a confirmed push), with how many such sends are under way. */
  private sendingOutside = new Map<string, number>();
  private closed = false;

  constructor(private readonly roots: Roots) {
    // Runs waiting to be auto-forwarded live in the store, so a failed send can be tried again and
    // a restart doesn't lose them.
    roots.store.db.exec("CREATE TABLE IF NOT EXISTS auto_forwards (trace_id TEXT PRIMARY KEY, attempts INTEGER NOT NULL DEFAULT 0, next_ms INTEGER NOT NULL, claimed_until INTEGER)");
    roots.bus.on("trace", (u) => {
      if (this.closed || (!u.rootEnded && !u.completed)) return;
      // A listener that throws stops ingest after the spans are stored and keeps the checks from
      // seeing the run, so a store that can't queue it (busy, full) only costs this auto-forward.
      try {
        if (!this.eligible(u.traceId)) return;
        roots.store.db.prepare("INSERT OR IGNORE INTO auto_forwards (trace_id, attempts, next_ms) VALUES (?, 0, ?)").run(u.traceId, Date.now() + this.settleMs);
        this.schedule();
      } catch (err) {
        log.warn(`couldn't queue ${u.traceId.slice(0, 8)} for auto-forward: ${(err as Error).message}`);
      }
    });
  }

  /**
   * Whether a run may be auto-forwarded now: it is stored, it is live (not a doctor probe, and no
   * span came from an import: imported runs are never sent back automatically, docs/cloud.md),
   * forwarding is on for its project, and it hasn't been sent already.
   */
  private eligible(traceId: string): boolean {
    const run = this.roots.store.getRun(traceId);
    if (!run || run.doctor || !run.project || !projectSettings(this.roots.config, run.project).forward) return false;
    const resources = this.roots.store.db.prepare("SELECT DISTINCT resource_id FROM spans WHERE trace_id = ?").all(traceId) as { resource_id: string }[];
    if (resources.some((r) => importedResource(this.roots.store.getResource(r.resource_id)))) return false;
    return !this.roots.store.wasForwarded(traceId);
  }

  /** Sends the runs a previous neatroots queued for auto-forward but didn't get to (a restart or a crash). */
  resume(): void {
    if (this.closed) return;
    this.roots.store.db.prepare("UPDATE auto_forwards SET next_ms = MIN(next_ms, ?)").run(Date.now() + this.settleMs);
    this.schedule();
  }

  /**
   * Stops auto-forwarding before the store closes; queued runs stay queued for the next start. Runs
   * this neatroots was sending are released, so the next start can take them at once.
   */
  close(): void {
    this.closed = true;
    clearTimeout(this.timer);
    if (!this.roots.store.db.open || !this.sending.size) return;
    // Best effort: neatroots still has to stop Laya and close the store. A claim left behind
    // only delays that run until its lease runs out.
    try {
      const release = this.roots.store.db.prepare("UPDATE auto_forwards SET claimed_until = NULL WHERE trace_id = ?");
      for (const id of this.sending.keys()) release.run(id);
    } catch (err) {
      log.warn(`couldn't release auto-forward claims: ${(err as Error).message}`);
    }
  }

  /** The runs this neatroots is sending, as a JSON array for json_each, so the queue is read in SQL rather than loaded. */
  private notSending(): string {
    return JSON.stringify([...this.sending.keys()]);
  }

  private schedule(): void {
    if (this.closed) return;
    clearTimeout(this.timer);
    // At the limit, a send finishing schedules the next one; a timer now would only spin.
    if (this.sending.size >= AUTO_CONCURRENCY) return;
    // When a queued run can next be taken: when it is due and nobody holds it.
    const { t } = this.roots.store.db
      .prepare(`SELECT MIN(${DUE_AT}) AS t FROM auto_forwards WHERE trace_id NOT IN (SELECT value FROM json_each(?))`)
      .get(this.notSending()) as { t: number | null };
    if (t === null) return;
    this.timer = setTimeout(() => this.drain(), Math.max(0, t - Date.now()));
    this.timer.unref();
  }

  private drain(): void {
    if (this.closed) return;
    const now = Date.now();
    const claim = this.roots.store.db.prepare("UPDATE auto_forwards SET claimed_until = ? WHERE trace_id = ? AND (claimed_until IS NULL OR claimed_until <= ?)");
    const due = this.roots.store.db
      .prepare(`SELECT trace_id, attempts FROM auto_forwards WHERE ${DUE_AT} <= ? AND trace_id NOT IN (SELECT value FROM json_each(?)) ORDER BY next_ms LIMIT ?`)
      .all(now, this.notSending(), Math.max(0, AUTO_CONCURRENCY - this.sending.size)) as Queued[];
    for (const r of due) {
      if (this.sending.size >= AUTO_CONCURRENCY) break;
      // Taken in one statement, so two neatroots on the same store never both send a run.
      if (claim.run(now + AUTO_LEASE_MS, r.trace_id, now).changes !== 1) continue;
      this.sending.set(
        r.trace_id,
        this.autoForward(r.trace_id, r.attempts)
          .catch((err) => void (!this.closed && log.warn(`auto-forward of ${r.trace_id.slice(0, 8)} failed: ${(err as Error).message}`)))
          .finally(() => {
            this.sending.delete(r.trace_id);
            this.schedule();
          }),
      );
    }
    this.schedule();
  }

  private async autoForward(traceId: string, attempts: number): Promise<void> {
    const done = () => void this.roots.store.db.prepare("DELETE FROM auto_forwards WHERE trace_id = ?").run(traceId);
    const later = (why: string) => {
      if (attempts + 1 >= AUTO_ATTEMPTS) {
        log.warn(`auto-forward of ${traceId.slice(0, 8)} failed: ${why}`);
        return done();
      }
      const delay = Math.min(this.retryBaseMs * 2 ** attempts, AUTO_RETRY_CAP_MS);
      this.roots.store.db.prepare("UPDATE auto_forwards SET attempts = ?, next_ms = ?, claimed_until = NULL WHERE trace_id = ?").run(attempts + 1, Date.now() + delay, traceId);
      log.warn(`auto-forward of ${traceId.slice(0, 8)} failed: ${why}; trying again in ${Math.round(delay / 1000)}s`);
    };
    // Looked at again shortly, without counting a try.
    const wait = () => void this.roots.store.db.prepare("UPDATE auto_forwards SET next_ms = ?, claimed_until = NULL WHERE trace_id = ?").run(Date.now() + this.settleMs, traceId);
    try {
      // Let checks finish so findings travel with the run.
      if (this.roots.engine) await this.roots.engine.waitIdle(traceId, 120_000);
      if (this.closed) return;
      // The key is looked up before the checks below: from them to the payload attempt() encodes,
      // nothing is awaited, so an import or a settings change can't slip in between.
      const key = (await getCloudKey()) ?? "";
      if (this.closed) return;
      // Being sent by hand right now: the run is recorded as sent only once Cloud answers, so sending
      // it here too could send it twice. Wait for that send; if it fails, this one still goes.
      if (this.sendingOutside.has(traceId)) return wait();
      // Deleted, replaced by an import, sent by hand meanwhile, or forwarding turned off: nothing to send.
      if (!this.eligible(traceId)) return done();
      const out = { retry: false };
      const row = await this.attempt([traceId], "auto", { apiKey: key }, out);
      if (this.closed) return;
      if (row.status === "ok") return done();
      if (out.retry) return later(row.error ?? "error");
      log.warn(`auto-forward of ${traceId.slice(0, 8)} failed: ${row.error}`);
      done();
    } catch (err) {
      // Anything unexpected waits and is tried again like a failed send, never in a tight loop.
      if (!this.closed) later((err as Error).message);
    }
  }

  endpoint(): string {
    return trimSlash(this.roots.config.cloud.endpoint).replace(/\/v1\/traces$/, "");
  }

  private prepared(traceIds: string[]): { batches: ResourceSpansBatch[]; hits: RedactionHit[]; markers: ResourceSpansBatch[]; spanCount: number } {
    const raw = this.roots.store.batchesForTraces(traceIds);
    const withFindings = this.attachFindings(raw, traceIds);
    const rules = compileRules(this.roots.config.cloud.redactPatterns);
    const { batches, hits } = redactBatches(withFindings, rules);
    // Markers go in a second request after their roots, as the SDKs send them.
    const main: ResourceSpansBatch[] = [];
    const markers: ResourceSpansBatch[] = [];
    for (const b of batches) {
      const normal = b.spans.filter((s) => s.name !== COMPLETE_MARKER);
      const mk = b.spans.filter((s) => s.name === COMPLETE_MARKER);
      if (normal.length) main.push({ ...b, spans: normal });
      if (mk.length) markers.push({ ...b, spans: mk });
    }
    for (const traceId of traceIds) {
      if (markers.some((b) => b.spans.some((s) => s.traceId === traceId))) continue;
      const m = this.synthesizeMarker(traceId, main);
      if (m) markers.push(m);
    }
    const spanCount = main.reduce((n, b) => n + b.spans.length, 0);
    return { batches: main, hits, markers, spanCount };
  }

  /** A completion marker for a run whose SDK never sent one (e.g. interrupted). */
  private synthesizeMarker(traceId: string, batches: ResourceSpansBatch[]): ResourceSpansBatch | undefined {
    const run = this.roots.store.getRun(traceId);
    if (!run?.root_span_id) return undefined;
    const rootBatch = batches.find((b) => b.spans.some((s) => s.spanId === run.root_span_id));
    if (!rootBatch) return undefined;
    const root = rootBatch.spans.find((s) => s.spanId === run.root_span_id)!;
    const span: OtlpSpan = {
      traceId,
      spanId: crypto.randomBytes(8).toString("hex"),
      parentSpanId: root.spanId,
      name: COMPLETE_MARKER,
      kind: 1,
      startTimeUnixNano: root.endTimeUnixNano,
      endTimeUnixNano: root.endTimeUnixNano,
      attributes: [
        { key: COMPLETE_MARKER, value: { boolValue: true } },
        { key: "neatlogs.internal", value: { boolValue: true } },
        { key: "neatlogs.span.kind", value: { stringValue: "Neatlogs.INTERNAL" } },
        { key: "neatroots.synthesized", value: { boolValue: true } },
      ],
      events: [],
      links: [],
      status: { code: 0 },
    };
    return { resource: rootBatch.resource, scope: { name: "neatlogs.internal", attributes: [] }, spans: [span] };
  }

  private attachFindings(batches: ResourceSpansBatch[], traceIds: string[]): ResourceSpansBatch[] {
    const bySpan = new Map<string, { id: string; check: string; title: string; probability: number | null; status: string }[]>();
    const rootExtra = new Map<string, KeyValue[]>();
    for (const traceId of traceIds) {
      const run = this.roots.store.getRun(traceId);
      const findings = this.roots.store.findingsForTrace(traceId).filter((f) => f.status !== "failed" && f.status !== "dismissed");
      for (const f of findings) {
        for (const sid of f.evidence_span_ids) {
          const list = bySpan.get(`${traceId}:${sid}`) ?? [];
          list.push({ id: f.id, check: f.check_id, title: f.title, probability: f.probability, status: f.status });
          bySpan.set(`${traceId}:${sid}`, list);
        }
      }
      const extra: KeyValue[] = [{ key: "neatroots.findings.count", value: { intValue: String(findings.length) } }];
      const summary = this.roots.store.getSummary(traceId);
      if (summary) extra.push({ key: "neatroots.run.summary", value: { stringValue: summary.text } });
      const exp = this.roots.store.explanationFor("run", traceId);
      if (exp) extra.push({ key: "neatroots.run.explanation", value: { stringValue: exp.cause } });
      if (run?.root_span_id) rootExtra.set(`${traceId}:${run.root_span_id}`, extra);
    }
    return batches.map((b) => ({
      ...b,
      spans: b.spans.map((s) => {
        const key = `${s.traceId}:${s.spanId}`;
        const add: KeyValue[] = [];
        const fs = bySpan.get(key);
        if (fs) {
          add.push({ key: "neatroots.findings", value: { stringValue: JSON.stringify(fs) } });
          add.push({ key: "neatroots.finding.checks", value: plainToAny(fs.map((f) => f.check)) });
        }
        add.push(...(rootExtra.get(key) ?? []));
        if (!add.length) return s;
        return { ...s, attributes: [...s.attributes.filter((a) => !a.key.startsWith("neatroots.")), ...add] };
      }),
    }));
  }

  async preview(traceIds: string[]): Promise<ForwardPreview> {
    const p = this.prepared(traceIds);
    const kinds = new Map<string, { count: number; samples: { where: string; sample: string }[] }>();
    for (const h of p.hits) {
      const k = kinds.get(h.kind) ?? { count: 0, samples: [] };
      k.count++;
      if (k.samples.length < 5) k.samples.push({ where: h.where, sample: h.sample });
      kinds.set(h.kind, k);
    }
    return {
      trace_ids: traceIds,
      span_count: p.spanCount,
      redactions: [...kinds.entries()].map(([kind, v]) => ({ kind, ...v })),
      endpoint: this.endpoint(),
      has_key: !!(await getCloudKey()),
    };
  }

  /** Builds the exact OTLP request bodies a forward would send (used by tests and dry runs). */
  encode(traceIds: string[]): { main: Uint8Array; markers: Uint8Array | null; spanCount: number; redactions: number } {
    const p = this.prepared(traceIds);
    return {
      main: encodeTraceRequest(p.batches),
      markers: p.markers.length ? encodeTraceRequest(p.markers) : null,
      spanCount: p.spanCount,
      redactions: p.hits.length,
    };
  }

  async forward(traceIds: string[], initiatedBy: string, opts: { endpoint?: string; apiKey?: string } = {}): Promise<ForwardRow> {
    // An auto-forward of one of these runs is under way: a run counts as sent only once Cloud
    // answers it, so wait for that answer instead of sending the run a second time meanwhile.
    const waited = new Set<string>();
    for (let busy = traceIds.filter((id) => this.sending.has(id)); busy.length; busy = traceIds.filter((id) => this.sending.has(id))) {
      for (const id of busy) waited.add(id);
      await Promise.all(busy.map((id) => this.sending.get(id)));
    }
    // From here to attempt()'s marking below nothing is awaited, so no auto-forward can start in between.
    // A run counts as just sent only if it went to the endpoint this send is for; sent elsewhere, it goes again.
    const target = trimSlash(opts.endpoint ?? this.endpoint());
    const sentBy = new Map<string, ForwardRow>();
    for (const id of traceIds) {
      const row = waited.has(id) ? this.roots.store.lastForwardOf(id) : undefined;
      if (row?.endpoint === target) sentBy.set(id, row);
    }
    const rest = traceIds.filter((id) => !sentBy.has(id));
    if (traceIds.length && !rest.length) {
      const ids = [...new Set([...sentBy.values()].map((r) => r.id))];
      // One auto-forward sent them all (the usual single run): its record answers this send.
      if (ids.length === 1) return sentBy.get(traceIds[0])!;
      // Several did: one record of this send, covering every run and naming those forwards.
      return this.roots.store.insertForward({
        trace_ids: traceIds,
        endpoint: target,
        initiated_by: initiatedBy,
        status: "ok",
        http_status: null,
        span_count: 0,
        bytes: 0,
        redactions: 0,
        error: `already sent by auto-forward: ${ids.join(", ")}`,
      });
    }
    // The runs left to send: all of them unless an auto-forward just sent some here.
    const send = rest;
    // A queued auto-forward of these runs waits until this send has its answer.
    for (const id of send) this.sendingOutside.set(id, (this.sendingOutside.get(id) ?? 0) + 1);
    try {
      return await this.attempt(send, initiatedBy, opts, { retry: false });
    } finally {
      for (const id of send) {
        const n = (this.sendingOutside.get(id) ?? 1) - 1;
        if (n > 0) this.sendingOutside.set(id, n);
        else this.sendingOutside.delete(id);
      }
    }
  }

  /**
   * One forward. `out.retry` says whether a failure may pass on its own (ingest answered 408, 429
   * or 5xx, or couldn't be reached), so auto-forward tries again later.
   */
  private async attempt(traceIds: string[], initiatedBy: string, opts: { endpoint?: string; apiKey?: string }, out: { retry: boolean }): Promise<ForwardRow> {
    const endpoint = trimSlash(opts.endpoint ?? this.endpoint());
    const key = opts.apiKey ?? (await getCloudKey());
    const base = { trace_ids: traceIds, endpoint, initiated_by: initiatedBy };
    const problem = endpointProblem(endpoint, !!this.roots.config.cloud.trustEndpoint);
    if (problem) return this.roots.store.insertForward({ ...base, status: "error", http_status: null, span_count: 0, bytes: 0, redactions: 0, error: problem });
    const unknown = traceIds.filter((id) => !this.roots.store.getRun(id));
    if (unknown.length) {
      return this.roots.store.insertForward({ ...base, status: "error", http_status: null, span_count: 0, bytes: 0, redactions: 0, error: `no run with id ${unknown.join(", ")}` });
    }
    if (!key) {
      return this.roots.store.insertForward({ ...base, status: "error", http_status: null, span_count: 0, bytes: 0, redactions: 0, error: "No Neatlogs Cloud API key. Add one with `neatroots cloud login` or in the app." });
    }
    let enc: ReturnType<Relay["encode"]>;
    try {
      enc = this.encode(traceIds);
    } catch (err) {
      const error = err instanceof RedactionPatternError ? err.message : `encode failed: ${(err as Error).message}`;
      return this.roots.store.insertForward({ ...base, status: "error", http_status: null, span_count: 0, bytes: 0, redactions: 0, error });
    }
    const send = async (body: Uint8Array) => {
      const gz = zlib.gzipSync(body);
      const res = await fetch(`${endpoint}/v1/traces`, {
        method: "POST",
        headers: { "content-type": "application/x-protobuf", "content-encoding": "gzip", "x-api-key": key, "user-agent": `neatroots/${VERSION}` },
        body: gz,
        // A redirect would carry x-api-key to another host (fetch drops only Authorization), so it's an error.
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
      });
      return { res, bytes: gz.length };
    };
    let bytes = 0;
    // Set once the run's spans are accepted: from then on the run is in the cloud, and a failed
    // completion marker mustn't make it look unsent (auto-forward would send it all again).
    let accepted: number | null = null;
    const sentWithoutMarker = (why: string) =>
      this.roots.store.insertForward({ ...base, status: "ok", http_status: accepted, span_count: enc.spanCount, bytes, redactions: enc.redactions, error: `sent, but the completion marker failed: ${why}` });
    try {
      const a = await send(enc.main);
      bytes += a.bytes;
      if (!a.res.ok) {
        const text = isRedirect(a.res) ? redirectError(a.res) : (await a.res.text().catch(() => "")).slice(0, 300);
        out.retry = a.res.status === 408 || a.res.status === 429 || a.res.status >= 500;
        return this.roots.store.insertForward({ ...base, status: "error", http_status: a.res.status, span_count: enc.spanCount, bytes, redactions: enc.redactions, error: `ingest returned HTTP ${a.res.status}${text ? `: ${text}` : ""}` });
      }
      accepted = a.res.status;
      if (enc.markers) {
        // Like the SDK's OTLP exporter: a 408, a 5xx or a connection error is retried with backoff,
        // a few times, then given up on. A timeout isn't retried (the request may have landed), and
        // the spans are never sent again.
        let why = "";
        for (let attempt = 0; attempt < MARKER_ATTEMPTS; attempt++) {
          if (attempt) await new Promise((r) => setTimeout(r, MARKER_BACKOFF_MS * 2 ** (attempt - 1)));
          try {
            const b = await send(enc.markers);
            bytes += b.bytes;
            if (b.res.ok) {
              why = "";
              break;
            }
            why = isRedirect(b.res) ? `HTTP ${b.res.status}: ${redirectError(b.res)}` : `HTTP ${b.res.status}`;
            if (b.res.status !== 408 && b.res.status < 500) break;
          } catch (err) {
            why = (err as Error).message;
            if ((err as Error).name === "TimeoutError") break;
          }
        }
        if (why) return sentWithoutMarker(why);
      }
      return this.roots.store.insertForward({ ...base, status: "ok", http_status: a.res.status, span_count: enc.spanCount, bytes, redactions: enc.redactions, error: null });
    } catch (err) {
      if (accepted !== null) return sentWithoutMarker((err as Error).message);
      // A timeout isn't retried: the spans may have landed.
      out.retry = (err as Error).name !== "TimeoutError";
      return this.roots.store.insertForward({ ...base, status: "error", http_status: null, span_count: enc.spanCount, bytes, redactions: enc.redactions, error: (err as Error).message });
    }
  }
}
