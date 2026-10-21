import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { describe, expect, it, vi } from "vitest";
import { registerServiceCommands, systemdExecArg, systemdQuoted } from "../src/cli/service.js";
import { cloudApiBase } from "../src/ingest/importers/neatlogs-cloud.js";
import { trimSlash } from "../src/util/url.js";
import { VERSION } from "../src/version.js";
import { makeRoots, tmpHome, type TestRoots } from "./helpers.js";

// From CodeQL's first scan of the repository.
describe("URL and service-unit helpers", () => {
  it("trims trailing slashes, in linear time on a long run of them", () => {
    expect(trimSlash("http://localhost:4100/")).toBe("http://localhost:4100");
    expect(trimSlash("http://localhost:4100///")).toBe("http://localhost:4100");
    expect(trimSlash("http://localhost:4100")).toBe("http://localhost:4100");
    expect(trimSlash("/")).toBe("");
    // `/\/+$/` backtracks over every slash from every start position: about 14 s on this input.
    const long = `${"/".repeat(200_000)}x`;
    const t0 = performance.now();
    expect(trimSlash(long)).toBe(long);
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("derives the Neatlogs API host only for neatlogs.com and its subdomains", () => {
    expect(cloudApiBase("https://ingest.neatlogs.com")).toBe("https://app.neatlogs.com/api/v1/public");
    expect(cloudApiBase("https://ingest.eu.neatlogs.com")).toBe("https://app.eu.neatlogs.com/api/v1/public");
    expect(cloudApiBase("https://ingest.evilneatlogs.com")).toBe("https://ingest.evilneatlogs.com/api/v1/public");
  });

  it("quotes values for a systemd unit: backslashes, quotes and % specifiers", () => {
    expect(systemdQuoted("/usr/bin/node")).toBe('"/usr/bin/node"');
    expect(systemdQuoted('NEATROOTS_HOME=/home/a "b" \\c 100%')).toBe('"NEATROOTS_HOME=/home/a \\"b\\" \\\\c 100%%"');
    // systemd expands $NAME in ExecStart= but not in Environment=, so only exec arguments double it.
    expect(systemdExecArg("/opt/${NAME}/cli.js")).toBe('"/opt/$${NAME}/cli.js"');
    expect(systemdQuoted("NAME=${NAME}")).toBe('"NAME=${NAME}"');
  });
});

describe("update's build comparison (#597)", () => {
  it.each([
    { name: "warns for an RC-to-final update at the same version and commit", final: true },
    { name: "stays quiet when reinstalling the running build", final: false },
  ])("$name", async ({ final }) => {
    const dir = tmpHome();
    const argv = process.argv;
    let server: TestRoots | undefined;
    try {
      const bundle = path.join(dir, "app");
      const cli = path.join(bundle, "neatroots", "dist", "cli.js");
      const rc = `v${VERSION}-rc.1`;
      const next = final ? `v${VERSION}` : rc;
      fs.mkdirSync(path.dirname(cli), { recursive: true });
      fs.writeFileSync(cli, `console.log(${JSON.stringify(VERSION)});\n`);
      fs.writeFileSync(path.join(bundle, ".neatroots-bundle"), JSON.stringify({ tag: rc, commit: "abc1234" }));
      fs.writeFileSync(path.join(dir, "next.json"), JSON.stringify({ tag: next, commit: "abc1234" }));
      // Exercise the actual update action with an installer that only replaces bundle metadata.
      fs.writeFileSync(path.join(bundle, "install.sh"), 'cp "$NEATROOTS_INSTALL_DIR/next.json" "$NEATROOTS_INSTALL_DIR/app/.neatroots-bundle"\n');
      process.argv = [process.execPath, cli];
      vi.spyOn(os, "homedir").mockReturnValue(dir); // Keep the developer's service out of the test.
      vi.stubEnv("NEATROOTS_HOME", path.join(dir, "home"));
      server = await makeRoots({ serve: true, noEngine: true });
      vi.stubEnv("NEATROOTS_PORT", String(server.roots.config.port));
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      const program = new Command();
      registerServiceCommands(program);
      await program.parseAsync(["update"], { from: "user" });

      const message = output.mock.calls.map((args) => args.join(" ")).join("\n");
      expect(message.includes("Restart it to use")).toBe(final);
      if (final) {
        expect(message).toContain(`${VERSION} (${rc})`);
        expect(message).toContain(`${VERSION} (${next})`);
      }
      // Updating files on disk must not change the running server's reported identity.
      const status = await fetch(`${server.url}/api/status`).then((r) => r.json());
      expect(status).toMatchObject({ version: VERSION, build: rc });
    } finally {
      await server?.close();
      process.argv = argv;
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
