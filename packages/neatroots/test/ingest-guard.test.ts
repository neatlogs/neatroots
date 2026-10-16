import { describe, expect, it } from "vitest";
import { ingestAllowOriginHeader, ingestOriginAllowed, isLoopbackOrigin } from "../src/server/ingest-guard.js";

describe("ingest origin guard", () => {
  it("lets in requests with no Origin (SDKs, exporters, curl)", () => {
    expect(ingestOriginAllowed(undefined, [])).toBe(true);
  });

  it("lets in pages served from this machine on any port", () => {
    for (const o of ["http://localhost:8000", "http://127.0.0.1:5173", "http://[::1]:3000", "https://localhost", "HTTP://LOCALHOST:8000"]) {
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
