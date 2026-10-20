import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { batch, hex, llmSpan, makeRoots, span, type TestRoots } from "./helpers.js";

// A coding agent's push waits for the user to confirm it in the app, and the app shows it in every
// open tab. Sending takes a while (two requests to Cloud), and a second answer can arrive meanwhile.

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  delete process.env.NEATLOGS_CLOUD_API_KEY;
  vi.restoreAllMocks();
  for (const c of cleanup.splice(0).reverse()) await c();
});

/** A Cloud ingest that answers 200 after `delayMs`, counting requests. */
async function slowCloud(delayMs: number) {
  const seen = { requests: 0 };
  const server = http.createServer((req, res) => {
    seen.requests++;
    req.resume();
    req.on("end", () => setTimeout(() => res.writeHead(200).end(), delayMs));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, seen };
}

async function setup(delayMs = 300) {
  const cloud = await slowCloud(delayMs);
  process.env.NEATLOGS_CLOUD_API_KEY = "nl-test-key";
  const tb: TestRoots = await makeRoots({ serve: true, noEngine: true, config: (c) => (c.cloud.endpoint = cloud.url) });
  cleanup.push(tb.close);
  const t = hex(16);
  const root = hex(8);
  tb.roots.ingest([batch([llmSpan(t, root, { system: "sys", user: "hi", out: "ok" }), span({ traceId: t, spanId: root, name: "agent", kind: "workflow" })])]);
  const id = `push_${hex(4)}`;
  tb.roots.pushes.set(id, { id, trace_ids: [t], requested_by: "coding-agent", created_ms: Date.now(), status: "pending" });
  const answer = async (action: "confirm" | "decline") =>
    (await (await fetch(`${tb.url}/api/pushes/${id}/${action}`, { method: "POST", headers: { "content-type": "application/json" } })).json()) as { status: string };
  const pushes = async () => ((await (await fetch(`${tb.url}/api/pushes`)).json()) as { pushes: { id: string; status: string }[] }).pushes;
  return { tb, cloud, id, answer, pushes };
}

it("sends a push once when it is confirmed twice while sending", async () => {
  const { tb, cloud, id, answer } = await setup();
  const [a, b] = await Promise.all([answer("confirm"), answer("confirm")]);
  expect(cloud.seen.requests).toBe(2); // the spans and the completion marker, once
  expect(tb.roots.store.listForwards()).toHaveLength(1);
  expect(tb.roots.pushes.get(id)?.status).toBe("sent");
  expect([a.status, b.status]).toContain("sent");
});

it("doesn't report a push as declined once its send has started", async () => {
  const { tb, cloud, id, answer, pushes } = await setup();
  const confirm = answer("confirm");
  // Wait until the send is under way (the first request reached Cloud).
  for (const end = Date.now() + 3000; cloud.seen.requests === 0 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 10));
  expect(cloud.seen.requests).toBeGreaterThan(0);
  // The runs are on their way: a decline from another tab can't say nothing was sent.
  const declined = await answer("decline");
  expect(declined.status).not.toBe("declined");
  // Other tabs see it as sending, so they don't offer Send or Decline for it.
  expect((await pushes()).find((p) => p.id === id)?.status).toBe("sending");
  expect((await confirm).status).toBe("sent");
  expect(tb.roots.pushes.get(id)?.status).toBe("sent");
  expect(cloud.seen.requests).toBe(2);
});

it("marks a push failed, not sending, when the send throws", async () => {
  const { tb, cloud, id, answer } = await setup(0);
  vi.spyOn(tb.roots.relay, "forward").mockRejectedValueOnce(new Error("database is closed"));
  const r = (await answer("confirm")) as { status: string; error?: string };
  expect(r).toMatchObject({ status: "failed", error: "database is closed" });
  expect(tb.roots.pushes.get(id)?.status).toBe("failed");
  expect(cloud.seen.requests).toBe(0);
});

it("tells open tabs about a push request and its send, so they refresh the banner", async () => {
  const { tb, answer } = await setup(0);
  const ac = new AbortController();
  cleanup.push(() => ac.abort());
  const reader = (await fetch(`${tb.url}/api/events`, { signal: ac.signal })).body!.getReader();
  let text = "";
  const read = async (until: (t: string) => boolean) => {
    for (const end = Date.now() + 3000; !until(text) && Date.now() < end; ) text += new TextDecoder().decode((await reader.read()).value);
  };
  await read((t) => t.includes("event: hello"));
  tb.roots.bus.emit("activity", { kind: "push-request", message: "push_x" });
  await answer("confirm");
  const kinds = () =>
    text
      .split("\n\n")
      .filter((m) => m.includes("event: activity"))
      .map((m) => JSON.parse(m.split("\n").find((l) => l.startsWith("data:"))!.slice(5)).kind);
  await read(() => kinds().length >= 3);
  // The app refetches pushes only for activity whose kind starts with "push"; the stream dropped the kind.
  expect(kinds()).toEqual(["push-request", "push", "push"]);
});

it("doesn't leave a push sending when telling the app about the send fails", async () => {
  const { tb, cloud, id, answer } = await setup(0);
  tb.roots.bus.on("activity", (e) => {
    if (e.message === "sending") throw new Error("listener broke");
  });
  await answer("confirm");
  expect(tb.roots.pushes.get(id)).toMatchObject({ status: "failed", error: "listener broke" });
  expect(cloud.seen.requests).toBe(0);
});

it("sends nothing for a push declined before it is confirmed", async () => {
  const { tb, cloud, id, answer } = await setup(0);
  expect((await answer("decline")).status).toBe("declined");
  expect((await answer("confirm")).status).toBe("declined");
  expect(cloud.seen.requests).toBe(0);
  expect(tb.roots.store.listForwards()).toEqual([]);
  expect(tb.roots.pushes.get(id)?.status).toBe("declined");
});
