import http from "node:http";
import { decodeTraceJson } from "../src/otlp/codec.js";
import { afterEach, describe, expect, it } from "vitest";
import { batch, hex, makeRoots, s, span } from "./helpers.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
});

async function sink(): Promise<{ url: string; requests: () => number }> {
  let count = 0;
  const server = http.createServer((req, res) => {
    count++;
    req.resume();
    req.on("end", () => res.writeHead(200).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `http://127.0.0.1:${(server.address() as { port: number }).port}`, requests: () => count };
}

describe("local diagnostic export", () => {
  it("does not export credential fragments from truncated run previews", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(tb.close);
    const traceId = hex(16);
    const fragment = "SyntheticPrivateKeyMaterial".repeat(30);
    const secret = `-----BEGIN PRIVATE KEY-----\n${fragment}\n-----END PRIVATE KEY-----`;
    tb.roots.ingest([batch([span({
      traceId,
      name: "credential preview regression",
      kind: "workflow",
      attrs: [s("neatlogs.workflow.input", secret), s("neatlogs.workflow.output", secret)],
    })])]);
    const storedRun = tb.roots.store.getRun(traceId)!;
    for (const preview of [storedRun.input_preview, storedRun.output_preview]) {
      expect(preview).toContain("SyntheticPrivateKeyMaterial");
      expect(preview).not.toContain("-----END PRIVATE KEY-----");
    }
    const before = JSON.stringify(tb.roots.store.batchesForTraces([traceId]));

    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    const prepared = await response.json() as { bundle: { run: Record<string, unknown> } };
    // The UI previews and downloads this entire bundle, not just its trace field.
    const downloadedJson = JSON.stringify(prepared.bundle);
    expect(downloadedJson).toContain("[redacted:private_key]");
    expect(JSON.stringify(prepared)).not.toContain("SyntheticPrivateKeyMaterial");
    expect(downloadedJson).not.toContain("-----BEGIN PRIVATE KEY-----");
    expect(prepared.bundle.run).not.toHaveProperty("input_preview");
    expect(prepared.bundle.run).not.toHaveProperty("output_preview");
    expect(JSON.stringify(tb.roots.store.batchesForTraces([traceId]))).toBe(before);
    expect(tb.roots.store.getRun(traceId)).toEqual(storedRun);
  });

  it("redacts nested data with forwarding rules, preserves stored spans and never forwards", async () => {
    const receiver = await sink();
    const tb = await makeRoots({
      serve: true,
      noEngine: true,
      config: (config) => {
        config.cloud.endpoint = receiver.url;
        config.cloud.redactPatterns = ["CLIENT-SECRET-[0-9]+"];
      },
    });
    cleanup.push(tb.close);

    const traceId = hex(16);
    const spanId = hex(8);
    const email = "supporter@example.com";
    const apiKey = "sk-live-4f9a8b7c6d5e4f3a2b1c0d9e8f7a6b5c";
    const customSecret = "CLIENT-SECRET-7865";
    tb.roots.ingest([
      batch([
        span({
          traceId,
          spanId,
          name: "support run",
          kind: "workflow",
          attrs: [
            s("neatlogs.workflow.input", `${email} ${apiKey} ${customSecret}`),
            s("process.cwd", tb.roots.home),
            s("process.env", apiKey),
            s("tool.path", tb.roots.home),
            s("tool.settings", "timeout=30s"),
          ],
        }),
      ]),
    ]);
    const check = {
      id: "support.secret-check",
      title: "Detect CLIENT-SECRET-3322",
      kind: "rule" as const,
      rule: { type: "match" as const, field: "output" as const, pattern: "CLIENT-SECRET-[0-9]+" },
    };
    tb.roots.checks.save(check, "db", "planner");
    const plan = tb.roots.store.insertPlan({ workflow: "test-agent", created_by: "user", model: null, rationale: null, check_ids: [check.id, "removed.check"], params: {}, tools: [] });
    tb.roots.store.setRunPlan(traceId, plan.id);
    tb.roots.store.insertFinding({
      trace_id: traceId,
      check_id: check.id,
      check_kind: "rule",
      title: `Unexpected contact ${email}`,
      probability: 0.9,
      status: "raised",
      evidence_span_ids: [spanId],
      detail: {
        [`${customSecret}-field`]: `leaked ${apiKey}`,
        nested: [`reach ${email}`, customSecret],
        machine_path: tb.roots.home,
        environment_variables: { TEST_TOKEN: apiKey },
      },
      model: null,
      triage_score: 3,
      explanation_id: null,
    });

    const before = JSON.stringify(tb.roots.store.batchesForTraces([traceId]));
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    const { bundle, preview } = (await response.json()) as {
      bundle: { format: string; schema_version: number; version: { neatroots: string }; run: Record<string, unknown>; trace: { resourceSpans: unknown[] }; findings: Record<string, unknown>[]; checks: { historical: Record<string, unknown>; current_definitions: { check_id: string; available: boolean; definition: unknown }[] }; redactions: { matches: { kind: string; count: number }[] } };
      preview: { span_count: number; finding_count: number; check_count: number };
    };
    const json = JSON.stringify(bundle);

    expect(bundle).toMatchObject({ format: "neatroots.diagnostic-export", schema_version: 1, run: { trace_id: traceId } });
    expect(bundle.version.neatroots).toMatch(/^\d+\.\d+\.\d+/);
    expect(bundle.trace.resourceSpans).toHaveLength(1);
    expect((bundle.trace.resourceSpans[0] as { scopeSpans?: unknown[] }).scopeSpans).toHaveLength(1);
    expect(bundle.findings).toHaveLength(1);
    const alias = bundle.findings[0].check_id;
    const recorded = bundle.checks.historical.recorded_check_ids as string[];
    expect(recorded[0]).toBe(alias);
    expect(recorded.every((id) => /^check-[a-f0-9]{16}-\d+$/.test(id))).toBe(true);
    expect(bundle.checks.historical).toMatchObject({ historical_definitions: "not-retained" });
    expect(bundle.checks.current_definitions).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ check_id: alias, available: true, definition: null, definition_omitted: "unverified-provenance" }),
        expect.objectContaining({ check_id: recorded[1], available: false, definition: null }),
      ]),
    );
    expect(preview).toEqual({ span_count: 1, finding_count: 1, check_count: bundle.checks.current_definitions.length });
    for (const raw of [email, apiKey, customSecret, "CLIENT-SECRET-3322"]) expect(json).not.toContain(raw);
    expect(json).toContain("[redacted:email]");
    expect(json).toContain("[redacted:api_key]");
    expect(json).toContain("[redacted:custom]");
    expect(json).toContain(tb.roots.home.replaceAll("\\", "\\\\"));
    expect(json).toContain("tool.path");
    expect(json).toContain("tool.settings");
    expect(json).toContain("timeout=30s");
    expect(bundle.findings[0].detail).toEqual({});
    expect(json).not.toContain("machine_path");
    expect(json).not.toContain("environment_variables");
    expect(bundle.redactions.matches).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "email" }), expect.objectContaining({ kind: "api_key" }), expect.objectContaining({ kind: "custom" })]));
    expect(JSON.stringify(tb.roots.store.batchesForTraces([traceId]))).toBe(before);
    expect(receiver.requests()).toBe(0);
    expect(tb.roots.store.forwardedTraceIds().has(traceId)).toBe(false);
  });

  it("preserves OTLP resource and scope schema URLs through export and import", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(tb.close);
    const traceId = hex(16);
    const recorded = batch([span({ traceId, name: "schema run", kind: "workflow" })]);
    recorded.resource.schemaUrl = "https://example.org/resource-schema/v1";
    recorded.scope.schemaUrl = "https://example.org/scope-schema/v2";
    tb.roots.ingest([recorded]);
    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    const { bundle } = await response.json() as { bundle: { trace: unknown } };
    const decoded = decodeTraceJson(bundle.trace);
    expect(decoded[0].resource.schemaUrl).toBe(recorded.resource.schemaUrl);
    expect(decoded[0].scope.schemaUrl).toBe(recorded.scope.schemaUrl);
    expect(decoded[0].spans[0].traceId).toBe(traceId);
  });

  it("returns not found for an unavailable run", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(tb.close);
    const response = await fetch(`${tb.url}/api/runs/${hex(16)}/diagnostic-export`);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "run not found" });
  });

  it("includes currently applicable enabled rules on a clean run without calling them historical", async () => {
    const tb = await makeRoots({ serve: true, noEngine: true });
    cleanup.push(tb.close);
    const traceId = hex(16);
    tb.roots.ingest([batch([span({ traceId, name: "clean agent", kind: "workflow" })], "diagnostic-app")]);
    const expectedExistingRules = tb.roots.checks.rules().map(({ check }) => ({ ...check, id: expect.any(String) }));
    const applicable = {
      id: "diagnostics.current-applicable",
      kind: "rule" as const,
      applies_to: { project: "diagnostic-app" },
      rule: { type: "count" as const, at_least: 99 },
    };
    tb.roots.checks.save(applicable, "db", "planner");
    tb.roots.checks.save({ ...applicable, id: "diagnostics.other-project", applies_to: { project: "other-app" }, rule: { type: "count", at_least: 100 } }, "db", "planner");
    tb.roots.checks.save({ ...applicable, id: "diagnostics.disabled", enabled: false, rule: { type: "count", at_least: 101 } }, "db", "planner");

    const response = await fetch(`${tb.url}/api/runs/${traceId}/diagnostic-export`);
    expect(response.status).toBe(200);
    const { bundle, preview } = (await response.json()) as {
      bundle: {
        findings: unknown[];
        checks: {
          historical: { plan_available: boolean; recorded_check_ids: string[]; historical_definitions: string };
          decisions: unknown[];
          current_definitions: { check_id: string; enabled_now: boolean; currently_applicable_rule: boolean; definition: Record<string, unknown> | null; rule_summary?: unknown }[];
        };
      };
      preview: { span_count: number; finding_count: number; check_count: number };
    };

    expect(bundle.findings).toEqual([]);
    expect(bundle.checks.decisions).toEqual([]);
    expect(bundle.checks.historical).toMatchObject({ plan_available: false, recorded_check_ids: [], historical_definitions: "not-retained" });
    // Exact curated bodies plus one metadata-only rule. Numeric rule shape proves neither
    // other-project(100) nor disabled(101) can substitute for the applicable count(99) rule.
    expect(bundle.checks.current_definitions).toHaveLength(expectedExistingRules.length + 1);
    expect(bundle.checks.current_definitions.filter((d) => d.definition).map((d) => d.definition)).toEqual(expect.arrayContaining(expectedExistingRules));
    expect(bundle.checks.current_definitions.filter((d) => !d.definition)).toEqual([
      expect.objectContaining({ definition: null, definition_omitted: "unverified-provenance", rule_summary: { type: "count", at_least: 99 } }),
    ]);
    expect(bundle.checks.current_definitions.every((d) => d.enabled_now && d.currently_applicable_rule)).toBe(true);
    expect(preview).toEqual({ span_count: 1, finding_count: 0, check_count: expectedExistingRules.length + 1 });
  });
});
