import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import fs from "node:fs";
import { afterEach, expect, it } from "vitest";
import { makeRoots } from "./helpers.js";

const exec = promisify(execFile);
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });

for (const mode of ["off", "advisory"] as const) {
  for (const contact of [null, "current", "legacy"] as const) {
    it(`status and doctor handle ${mode} steering with ${contact} contact`, async () => {
      const tb = await makeRoots({ serve: true, noEngine: true, config: (cfg) => {
        cfg.projects.agent = { steering: mode };
      } });
      cleanup.push(tb.close);
      if (contact === "current") tb.roots.steerSeenMs = Date.now() - 120_000;
      // Undefined is omitted from JSON, matching an older server's status payload.
      if (contact === "legacy") tb.roots.steerSeenMs = undefined as unknown as null;
      fs.writeFileSync(`${tb.roots.home}/config.yaml`, "llm:\n  enabled: false\n  baseUrl: http://127.0.0.1:9/v1\nclassifier:\n  backend: llm\n  laya:\n    enabled: false\n    port: 9\n");
      const run = (command: string) => exec(process.execPath,
        ["--import", "tsx", "src/cli.ts", command, "--port", String(tb.roots.config.port)], {
          cwd: fileURLToPath(new URL("..", import.meta.url)),
          env: { ...process.env, NEATROOTS_HOME: tb.roots.home },
        });
      const status = (await run("status")).stdout;
      expect(status).toContain("steering hook · last contact since server start");
      expect(status).not.toMatch(/SSE|hooks connected|stream clients/);
      expect(status).toContain(contact === null ? "no contact observed" : contact === "legacy" ? "unknown" : "2m ago");
      const doctor = (await run("doctor")).stdout;
      expect(doctor).toContain("trace round trip through /v1/traces and the doctor read-back");
      // Reduced scope: doctor does not assess optional steering at all.
      expect(doctor).not.toMatch(/steering hook contact|steering hook contact time/);
    });
  }
}
