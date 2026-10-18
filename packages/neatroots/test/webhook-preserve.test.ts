import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import YAML from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig, saveConfig } from "../src/config.js";
import { Roots } from "../src/core.js";
import { createApp } from "../src/server/app.js";
import { batch, toolSpan } from "./helpers.js";

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const fn of cleanups.splice(0).reverse()) await fn();
  vi.unstubAllEnvs();
});
function homeWith(raw: unknown) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-preserve-"));
  cleanups.push(() => fs.rmSync(home, { recursive: true, force: true }));
  vi.stubEnv("NEATROOTS_HOME", home);
  const file = path.join(home, "config.yaml");
  fs.writeFileSync(file, YAML.stringify({ port: 1, webhooks: raw }));
  return { home, file, read: () => YAML.parse(fs.readFileSync(file, "utf8")) };
}
const invalid = [
  "PRIVATE_SCALAR", 42, null, { url: "PRIVATE_OBJECT" }, ["PRIVATE_ARRAY"],
  [{ url: "http://127.0.0.1:1/PRIVATE_PATH", events: ["finding"] }, { url: "PRIVATE_INVALID" }],
];
describe("invalid webhook configuration preservation", () => {
  it.each(invalid.map((raw, i) => ({ raw, i })))("preserves raw shape $i on unrelated saves and reloads", ({ raw }) => {
    const x = homeWith(raw);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const config = loadConfig();
    expect(config.webhooks).toEqual([]);
    expect(JSON.stringify(config)).not.toContain("PRIVATE_");
    config.retention.days = 23;
    saveConfig(config, x.file);
    expect(x.read().webhooks).toEqual(raw);
    expect(x.read().retention.days).toBe(23);
    saveConfig(loadConfig(), x.file);
    expect(x.read().webhooks).toEqual(raw);
    expect(warn.mock.calls.flat().join(" ")).not.toContain("PRIVATE_");
  });

  it.each([[], [{ url: "http://127.0.0.1:1/replacement", events: ["finding"], format: "json" }]].map((replacement) => ({ replacement })))(
    "persists explicit replacement $replacement and does not resurrect invalid input", ({ replacement }) => {
      const x = homeWith("PRIVATE_SCALAR");
      const config = loadConfig();
      config.webhooks = replacement as NonNullable<typeof config.webhooks>;
      saveConfig(config, x.file);
      expect(x.read().webhooks).toEqual(replacement);
      config.retention.days = 19;
      saveConfig(config, x.file);
      expect(x.read().webhooks).toEqual(replacement);
      expect(loadConfig().webhooks).toEqual(replacement);
    },
  );

  it("retains raw state after failed Roots clears and replacements before an unrelated save", () => {
    const raw = { url: "PRIVATE_RAW" };
    const x = homeWith(raw);
    const roots = new Roots({ home: x.home, config: loadConfig(), noEngine: true });
    cleanups.push(() => roots.close());
    const write = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (String(args[0]) === x.file) throw new Error("write denied");
      return Reflect.apply(write, fs, args);
    });
    for (const replacement of [[], [{ url: "http://127.0.0.1:1/new", events: ["finding"] as ["finding"], format: "json" as const }]]) {
      roots.config.webhooks = replacement;
      expect(() => roots.saveConfig()).toThrow("write denied");
      expect(roots.config.webhooks).toEqual([]);
      expect(x.read().webhooks).toEqual(raw);
    }
    spy.mockRestore();
    roots.config.retention.days = 27;
    roots.saveConfig();
    expect(x.read().webhooks).toEqual(raw);
    expect(roots.webhooks.stats.accepted).toBe(0);
  });

  it("preserves raw input through API failures, then replaces and clears explicitly", async () => {
    const received: string[] = [];
    const server = http.createServer(async (req, res) => {
      let body = ""; for await (const part of req) body += part;
      received.push(body); res.end("ok");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((r) => server.close(() => r())); });
    const url = "http://127.0.0.1:" + (server.address() as import("node:net").AddressInfo).port + "/PRIVATE_DEST";
    const raw = [{ url, events: ["finding"] }, { url: "PRIVATE_INVALID" }];
    const x = homeWith(raw);
    const roots = new Roots({ home: x.home, config: loadConfig(), noEngine: true });
    cleanups.push(() => roots.close());
    const app = createApp(roots);
    const post = (body: unknown) => app.request("/api/settings", { method: "POST",
      headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify(body) });
    const trace = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    roots.ingest([batch([toolSpan(trace, "0123456789abcdef", "tool", "", "")])]);
    const finding = roots.store.insertFinding({ trace_id: trace, check_id: "check", check_kind: "rule",
      title: "title", status: "raised", probability: null, evidence_span_ids: [], detail: {},
      model: null, triage_score: null, explanation_id: null });
    const emit = () => roots.bus.emit("finding", finding);
    expect((await post({ retention_days: 31 })).status).toBe(200);
    expect(x.read().webhooks).toEqual(raw);
    emit(); await new Promise((r) => setTimeout(r, 20));
    expect(received).toEqual([]);
    const status = await (await app.request("/api/status", { headers: { host: "localhost" } })).text();
    expect(status).not.toContain("PRIVATE_");

    const write = fs.writeFileSync.bind(fs);
    const spy = vi.spyOn(fs, "writeFileSync").mockImplementation((...args) => {
      if (String(args[0]) === x.file) throw new Error("PRIVATE_WRITE_FAILURE");
      return Reflect.apply(write, fs, args);
    });
    for (const webhooks of [[], [{ url, events: ["finding"], format: "json" }]]) {
      const response = await post({ webhooks });
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain("PRIVATE_");
      expect(roots.config.webhooks).toEqual([]);
      expect(x.read().webhooks).toEqual(raw);
      emit();
    }
    spy.mockRestore();
    // A later unrelated successful save must still preserve the raw value after rollback.
    expect((await post({ retention_days: 32 })).status).toBe(200);
    expect(x.read().webhooks).toEqual(raw);
    expect(received).toEqual([]);
    expect((await post({ webhooks: [{ url, events: ["finding"], format: "json" }] })).status).toBe(200);
    emit(); await vi.waitFor(() => expect(received).toHaveLength(1));
    expect((await post({ webhooks: [] })).status).toBe(200);
    expect((await post({ retention_days: 33 })).status).toBe(200);
    expect(x.read().webhooks).toEqual([]);
    expect(loadConfig().webhooks).toEqual([]);
  });
});
