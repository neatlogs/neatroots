import fs from "node:fs";
import http from "node:http";
import { afterEach, expect, it, vi } from "vitest";
import { Roots } from "../src/core.js";
import { defaultConfig } from "../src/config.js";
import { batch, freePort, hex, s, span, tmpHome } from "./helpers.js";

// Looking up the Cloud key is asynchronous (the macOS Keychain). An import that lands while an
// auto-forward waits on it must not ride along: the run is checked again after the key arrives,
// with nothing awaited between that check and the payload being encoded.

let releaseKey: (() => void) | undefined;
let keyRequested: (() => void) | undefined;
vi.mock("../src/relay/keychain.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../src/relay/keychain.js")>();
  return {
    ...real,
    getCloudKey: () =>
      new Promise<string>((resolve) => {
        keyRequested?.();
        releaseKey = () => resolve("nl-test-key");
      }),
  };
});

const cleanup: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  for (const c of cleanup.splice(0).reverse()) await c();
});

it("doesn't send a run an import replaced while the key was being looked up", async () => {
  let requests = 0;
  const server = http.createServer((req, res) => {
    requests++;
    req.resume();
    req.on("end", () => res.writeHead(200).end());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  cleanup.push(() => new Promise<void>((r) => server.close(() => r())));

  const home = tmpHome();
  cleanup.push(() => fs.rmSync(home, { recursive: true, force: true }));
  const cfg = defaultConfig();
  cfg.port = await freePort();
  cfg.llm.enabled = false;
  cfg.classifier.backend = "llm";
  cfg.classifier.laya.enabled = false;
  cfg.cloud.endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cfg.projects["test-agent"] = { forward: true };
  const roots = new Roots({ home, config: cfg, noEngine: true });
  cleanup.push(() => roots.close());
  roots.relay.settleMs = 20;

  const t = hex(16);
  const root = hex(8);
  const asked = new Promise<void>((r) => (keyRequested = r));
  roots.ingest([batch([span({ traceId: t, spanId: root, name: "agent", kind: "workflow" })])]);
  await asked;
  // The same trace arrives again from an import while the key lookup is pending.
  const imported = batch([span({ traceId: t, spanId: root, name: "agent", kind: "workflow" })]);
  imported.resource.attributes.push(s("neatroots.import.source", "neatlogs-cloud"));
  roots.ingest([imported]);
  releaseKey!();
  const queued = () => (roots.store.db.prepare("SELECT COUNT(*) AS n FROM auto_forwards").get() as { n: number }).n;
  for (const end = Date.now() + 3000; queued() > 0 && Date.now() < end; ) await new Promise((r) => setTimeout(r, 20));
  expect(queued()).toBe(0);
  await new Promise((r) => setTimeout(r, 300));
  expect(requests).toBe(0);
  expect(roots.store.listForwards()).toEqual([]);
});
