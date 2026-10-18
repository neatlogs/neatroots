import fs from "node:fs";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/server/app.js";
import { verifyArchive } from "../src/audit/manifest.js";
import { batch, hex, makeRoots, s, span, until, type TestRoots } from "./helpers.js";

const tests: TestRoots[] = [];
afterEach(async () => { vi.restoreAllMocks(); for (const t of tests.splice(0)) await t.close(); });
async function setup(noEngine = true) {
  const t = await makeRoots({ noEngine }); tests.push(t);
  const app = createApp(t.roots);
  const post = (route: string, body: unknown, origin?: string) => app.request(`http://localhost:${t.roots.config.port}${route}`, {
    method: "POST", headers: { host: `localhost:${t.roots.config.port}`, "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body),
  });
  const traceId = hex(16);
  t.roots.ingest([batch([span({ traceId, name: "agent", kind: "workflow", status: 2, attrs: [s("secret", "alice@example.com"), s("large", "large".repeat(9000))] })])]);
  return { t, app, post, traceId, directory: path.join(t.roots.home, "audit") };
}

it("serializes concurrent exports through the server, with chained heads", async () => {
  const f = await setup();
  const replies = await Promise.all(Array.from({ length: 12 }, () => f.post("/api/audit/export", { trace_id: f.traceId })));
  expect(replies.every((r) => r.ok)).toBe(true);
  const entries = await Promise.all(replies.map((r) => r.json()));
  expect(entries.map((e) => e.seq).sort((a, b) => a - b)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  const result = verifyArchive(f.directory);
  expect(result.ok).toBe(true); expect(result.seq).toBe(12);
  const response = await f.post("/api/audit/verify", { expect_head: result.head });
  expect(await response.json()).toMatchObject({ ok: true, seq: 12, head: result.head });
});

it("keeps all sidecar records original; reimport restores spans and re-derives findings", async () => {
  const f = await setup(false);
  await until(() => f.t.roots.store.findingsForTrace(f.traceId).length > 0);
  expect(await f.t.roots.engine!.waitIdle(f.traceId, 5000)).toBe(true);
  const original = f.t.roots.store.batchesForTraces([f.traceId]);
  const finding = f.t.roots.store.insertFinding({ trace_id: f.traceId, check_id: "original-record-only", check_kind: "rule",
    title: "alice@example.com", probability: null, status: "raised", evidence_span_ids: [original[0].spans[0].spanId],
    detail: { email: "alice@example.com" }, model: null, triage_score: null, explanation_id: null });
  const decision = f.t.roots.store.insertDecision({ trace_id: f.traceId, check_id: "record", span_id: null, probability: 0.5,
    answer: { text: "alice@example.com" }, backend: "local", latency_ms: 1 });
  const explanation = f.t.roots.store.insertExplanation({ target_type: "run", target_id: f.traceId, trace_id: f.traceId,
    cause: "alice@example.com", fix: "original fix", evidence_span_ids: [], grounding: null, model: null });
  const exported = await (await f.post("/api/audit/export", { trace_id: f.traceId })).json();
  const tracePath = path.join(f.directory, exported.path);
  const sidecarPath = path.join(path.dirname(tracePath), "record.json");
  const sidecarBytes = fs.readFileSync(sidecarPath);
  const record = JSON.parse(sidecarBytes.toString());
  expect(record.findings).toContainEqual(finding); expect(record.decisions).toContainEqual(decision);
  expect(record.explanations).toContainEqual(explanation);
  f.t.roots.store.deleteRun(f.traceId);
  f.t.roots.config.projects["test-agent"] = { forward: true };
  const forwarding = vi.spyOn(f.t.roots.relay, "forward").mockResolvedValue({ id: "mock", trace_ids: [],
    endpoint: "http://127.0.0.1", status: "ok", http_status: 200, span_count: 0, bytes: 0,
    redactions: 0, error: null, initiated_by: "auto", created_ms: 0 });
  const restored = await f.post("/api/imports/file", { name: "trace.json", content: fs.readFileSync(tracePath, "utf8") });
  expect(restored.ok).toBe(true);
  expect(f.t.roots.store.batchesForTraces([f.traceId])).toEqual(original);
  await until(() => f.t.roots.store.findingsForTrace(f.traceId).length > 0);
  expect(f.t.roots.store.findingsForTrace(f.traceId).some((x) => x.id === finding.id || x.check_id === finding.check_id)).toBe(false);
  await new Promise((r) => setTimeout(r, 1700));
  expect(forwarding).not.toHaveBeenCalled();
  expect(f.t.roots.store.db.prepare("SELECT COUNT(*) AS n FROM forwards").get()).toEqual({ n: 0 });
  expect(fs.readFileSync(sidecarPath)).toEqual(sidecarBytes);
  expect(verifyArchive(f.directory, exported.head).ok).toBe(true);
});

it("redacts an explicit share copy including nested sidecar strings and previews before writing", async () => {
  const f = await setup();
  f.t.roots.store.insertAnnotation({ trace_id: f.traceId, span_id: null, label: "note", text: "alice@example.com", author: "alice@example.com" });
  f.t.roots.store.insertDecision({ trace_id: f.traceId, span_id: null, check_id: "note", probability: 0.5,
    answer: { "alice@example.com": ["alice@example.com"] }, backend: "local", latency_ms: 0 });
  const exported = await (await f.post("/api/audit/export", { trace_id: f.traceId })).json();
  const originals = ["manifest.jsonl", exported.path, `${path.dirname(exported.path)}/record.json`].map((name) => ({ name, bytes: fs.readFileSync(path.join(f.directory, name)) }));
  f.t.roots.store.deleteRun(f.traceId); // Share from the archive, never rebuild from a live store.
  const output = path.join(f.t.roots.home, "share");
  const options = { trace_id: f.traceId, redacted: true, output };
  expect((await f.post("/api/audit/export", options)).status).toBe(400);
  const preview = await (await f.post("/api/audit/export", { ...options, preview: true })).json();
  expect(preview.redactions.some((h: { where: string }) => h.where.startsWith("audit sidecar"))).toBe(true);
  expect(fs.existsSync(output)).toBe(false);
  expect((await f.post("/api/audit/export", { ...options, output: f.directory, preview_token: preview.preview_token })).status).toBe(400);
  f.t.roots.config.cloud.redactPatterns.push("original-pattern");
  expect((await f.post("/api/audit/export", { ...options, preview_token: "stale" })).status).toBe(400);
  const fresh = await (await f.post("/api/audit/export", { ...options, preview: true })).json();
  const shared = await (await f.post("/api/audit/export", { ...options, preview_token: fresh.preview_token })).json();
  expect(shared.redacted).toBe(true);
  for (const name of [shared.path, `${path.dirname(shared.path)}/record.json`]) {
    const text = fs.readFileSync(path.join(output, name), "utf8");
    expect(text).not.toContain("alice@example.com"); expect(text).toContain("[redacted:email]");
  }
  expect(verifyArchive(output, shared.head).ok).toBe(true);
  for (const { name, bytes } of originals) expect(fs.readFileSync(path.join(f.directory, name))).toEqual(bytes);
});

it("validates local API input and rejects foreign origins", async () => {
  const f = await setup();
  expect((await f.post("/api/audit/export", { trace_id: f.traceId }, "https://evil.test")).status).toBe(403);
  for (const data of [{}, { trace_id: "../bad" }, { trace_id: f.traceId, directory: 123 }, { trace_id: f.traceId, redacted: "false" }]) {
    expect((await f.post("/api/audit/export", data)).status).toBe(400);
  }
  expect(fs.existsSync(f.directory)).toBe(false);
});

it("redacts low-entropy named sidecar credentials from every share artifact and preview", async () => {
  const f = await setup();
  const secrets = ["ordinary-secret-123", "plain-client-value", "quote\"newline\ncredential", "q!z"];
  f.t.roots.store.insertFinding({ trace_id: f.traceId, check_id: "context", check_kind: "rule", title: "context",
    probability: null, status: "raised", evidence_span_ids: [], model: null, triage_score: null, explanation_id: null,
    detail: { password: secrets[0], params: { client_secret: secrets[1] }, nested: [{ password: secrets[2] }], pwd: secrets[3] } });
  f.t.roots.store.insertDecision({ trace_id: f.traceId, span_id: null, check_id: "context", probability: 0.5,
    answer: { params: { client_secret: secrets[0] }, passwords: [{ api_secret: secrets[1] }] }, backend: "local", latency_ms: 0 });
  const exported = await (await f.post("/api/audit/export", { trace_id: f.traceId })).json();
  const names = ["manifest.jsonl", exported.path, `${path.dirname(exported.path)}/record.json`];
  const originals = names.map((name) => fs.readFileSync(path.join(f.directory, name)));
  const options = { trace_id: f.traceId, redacted: true, output: path.join(f.t.roots.home, "credentials-share") };
  const previewResponse = await f.post("/api/audit/export", { ...options, preview: true });
  expect(previewResponse.ok).toBe(true);
  const previewText = await previewResponse.text();
  const preview = JSON.parse(previewText);
  expect(preview.redactions.some((hit: { kind: string }) => hit.kind === "password")).toBe(true);
  const shareResponse = await f.post("/api/audit/export", { ...options, preview_token: preview.preview_token });
  expect(shareResponse.ok).toBe(true);
  const shareText = await shareResponse.text();
  const shared = JSON.parse(shareText);
  const sharedNames = ["manifest.jsonl", shared.path, `${path.dirname(shared.path)}/record.json`];
  const allShareBytes = sharedNames.map((name) => fs.readFileSync(path.join(options.output, name), "utf8")).join("\n");
  for (const secret of secrets) {
    expect(previewText).not.toContain(secret);
    expect(shareText).not.toContain(secret);
    expect(allShareBytes).not.toContain(secret);
    expect(allShareBytes).not.toContain(JSON.stringify(secret).slice(1, -1));
  }
  const record = JSON.parse(fs.readFileSync(path.join(options.output, path.dirname(shared.path), "record.json"), "utf8"));
  expect(record.record.findings[0].detail).toEqual({ password: "[redacted:password]", params: { client_secret: "[redacted:password]" },
    nested: [{ password: "[redacted:password]" }], pwd: "[redacted:password]" });
  names.forEach((name, i) => expect(fs.readFileSync(path.join(f.directory, name))).toEqual(originals[i]));
  expect(verifyArchive(f.directory, exported.head).ok).toBe(true);
});
