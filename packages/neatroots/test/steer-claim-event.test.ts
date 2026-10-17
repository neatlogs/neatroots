import { afterEach, expect, it } from "vitest";
import { batch, hex, llmSpan, makeRoots } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0)) await c();
});

it("emits finding update on roots.bus when claim transitions a finding to active", async () => {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { system: "s", user: "u" })], "test-agent")]);
  const f = tb.roots.store.insertFinding({
    trace_id: t,
    check_id: "test-check",
    check_kind: "rule",
    title: "Test Check",
    probability: null,
    status: "raised",
    evidence_span_ids: [],
    detail: {},
    model: null,
    triage_score: null,
    explanation_id: null,
  });

  tb.roots.steering.setMode("test-agent", "advisory");
  tb.roots.steering.push({ traceId: t, findingId: f.id, kind: "template", text: "Guidance note" });

  const events: any[] = [];
  tb.roots.bus.on("finding", (finding) => events.push(finding));

  const note = tb.roots.steering.claim(t);
  expect(note).toBeDefined();

  expect(events.length).toBe(1);
  expect(events[0].id).toBe(f.id);
  expect(events[0].status).toBe("active");
});

it("tracks steering hook contacts separately from SSE stream subscribers", async () => {
  const tb = await makeRoots({ serve: true, noEngine: true });
  cleanup.push(tb.close);
  const status = async () => {
    const res = await fetch(`${tb.url}/api/status`);
    expect(res.status).toBe(200);
    return res.json() as Promise<any>;
  };

  const before = await status();
  expect(before.steering.hooks_connected).toBe(0);

  // A TypeScript-style claim succeeds even when there is no note to deliver.
  const claim = await fetch(`${tb.url}/api/steer/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ trace_id: hex(16), project: "polling-agent" }),
  });
  expect(claim.status).toBe(200);
  expect((await claim.json()).note).toBeNull();
  const polled = await status();
  expect(polled.steering.hooks_connected).toBe(0);

  const controller = new AbortController();
  let streaming: any;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${tb.url}/api/steer/stream`, { signal: controller.signal });
    expect(response.status).toBe(200);
    reader = response.body!.getReader();
    const hello = await reader.read();
    expect(new TextDecoder().decode(hello.value ?? new Uint8Array())).toContain("event: hello");
    streaming = await status();
    expect(streaming.steering.hooks_connected).toBe(1);
  } finally {
    controller.abort();
    if (reader) await reader.cancel().catch(() => undefined);
  }
  let disconnected = await status();
  for (let attempt = 0; disconnected.steering.hooks_connected !== 0 && attempt < 60; attempt++) {
    await new Promise((resolve) => setTimeout(resolve, 25));
    disconnected = await status();
  }
  expect(disconnected.steering.hooks_connected).toBe(0);

  // These assertions fail on the old status shape after exercising the legacy 0 -> 1 -> 0
  // subscriber count and a successful empty claim.
  expect(polled.steering.last_seen_ms).toEqual(expect.any(Number));
  expect(before.steering.last_seen_ms).toBeNull();
  expect(before.steering.stream_clients).toBe(0);
  expect(polled.steering.stream_clients).toBe(0);
  expect(streaming.steering.stream_clients).toBe(1);
  expect(streaming.steering.last_seen_ms).toBeGreaterThanOrEqual(polled.steering.last_seen_ms);
  expect(disconnected.steering.stream_clients).toBe(0);
  expect(disconnected.steering.last_seen_ms).toBe(streaming.steering.last_seen_ms);
});
