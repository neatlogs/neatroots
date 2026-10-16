import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { ingestAllowOriginHeader, ingestOriginAllowed, isLoopbackOrigin } from "../src/server/ingest-guard.js";

describe("ingest origin guard", () => {
  it("lets in requests with no Origin (SDKs, exporters, curl)", () => {
    expect(ingestOriginAllowed(undefined, [])).toBe(true);
  });

  it("lets in pages served from this machine on any port", () => {
    for (const o of ["http://localhost:8000", "http://127.0.0.1:5173", "http://[::1]:3000", "https://localhost", "HTTP://LOCALHOST:8000", "http://app.localhost:3000"]) {
      expect(isLoopbackOrigin(o)).toBe(true);
      expect(ingestOriginAllowed(o, [])).toBe(true);
    }
  });

  it("refuses other websites, file:// pages and look-alike hosts by default", () => {
    for (const o of ["https://evil.example.com", "null", "http://localhost.evil.com", "http://127.0.0.1.nip.io", "chrome-extension://abc", "not a url"]) {
      expect(ingestOriginAllowed(o, [])).toBe(false);
    }
  });

  it("lets in listed origins, matched exactly after normalising case and a trailing slash", () => {
    const allowed = ["https://Staging.Example.com/"];
    expect(ingestOriginAllowed("https://staging.example.com", allowed)).toBe(true);
    expect(ingestOriginAllowed("http://staging.example.com", allowed)).toBe(false);
    expect(ingestOriginAllowed("https://staging.example.com:8443", allowed)).toBe(false);
    expect(ingestOriginAllowed("https://evil-staging.example.com", allowed)).toBe(false);
  });

  it('"*" restores the old open behaviour', () => {
    expect(ingestOriginAllowed("https://evil.example.com", ["*"])).toBe(true);
    expect(ingestAllowOriginHeader("https://evil.example.com", ["*"])).toBe("*");
  });

  it("echoes an allowed browser origin instead of *", () => {
    expect(ingestAllowOriginHeader("http://localhost:8000", [])).toBe("http://localhost:8000");
    expect(ingestAllowOriginHeader(undefined, [])).toBe("*");
  });
});

describe("ingest config", () => {
  const prev = process.env.NEATROOTS_HOME;
  afterEach(() => {
    if (prev === undefined) delete process.env.NEATROOTS_HOME;
    else process.env.NEATROOTS_HOME = prev;
  });

  const load = (yaml: string) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-ingest-"));
    fs.writeFileSync(path.join(home, "config.yaml"), yaml);
    process.env.NEATROOTS_HOME = home;
    return loadConfig();
  };

  it("survives an origin written straight under ingest", () => {
    expect(load("ingest: https://staging.example.com\n").ingest).toEqual({ allowedOrigins: [] });
  });

  it("accepts allowedOrigins written as a single string", () => {
    expect(load("ingest:\n  allowedOrigins: https://staging.example.com\n").ingest.allowedOrigins).toEqual(["https://staging.example.com"]);
  });
});
