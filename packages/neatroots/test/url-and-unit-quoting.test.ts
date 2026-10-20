import { describe, expect, it } from "vitest";
import { systemdExecArg, systemdQuoted } from "../src/cli/service.js";
import { cloudApiBase } from "../src/ingest/importers/neatlogs-cloud.js";
import { trimSlash } from "../src/util/url.js";

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
