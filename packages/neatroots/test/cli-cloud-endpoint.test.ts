import { describe, expect, it } from "vitest";
import { checkedCloudApiBase } from "../src/cli/data.js";
import { defaultConfig } from "../src/config.js";

// `neatroots cloud token` and `cloud project` send the service-account token. They must refuse the
// same endpoints the server refuses, instead of sending it over plain http or to another host.

const cfgWith = (apiBase: string | undefined, trustEndpoint = false) => {
  const c = defaultConfig();
  c.cloud.apiBase = apiBase;
  c.cloud.trustEndpoint = trustEndpoint;
  return c;
};

describe("the CLI's Neatlogs Cloud API base", () => {
  it("refuses plain http to another host, and another https host unless trusted", () => {
    expect(() => checkedCloudApiBase(cfgWith("http://api.example.test"))).toThrow(/plain http|refus/i);
    expect(() => checkedCloudApiBase(cfgWith("https://api.example.test"))).toThrow();
    expect(checkedCloudApiBase(cfgWith("https://api.example.test", true))).toBe("https://api.example.test");
  });

  it("allows the default Neatlogs API and localhost", () => {
    expect(checkedCloudApiBase(cfgWith(undefined))).toMatch(/^https:\/\/[a-z.]*neatlogs\.com/);
    expect(checkedCloudApiBase(cfgWith("http://localhost:4999"))).toBe("http://localhost:4999");
  });
});
