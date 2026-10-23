import { afterEach, describe, expect, it } from "vitest";
import { parseTraceFile } from "../src/ingest/importers/file.js";
import { importSource } from "../src/server/api-explore.js";
import { buildView } from "../src/semantics/view.js";
import { closeTrackedStores, hex, makeRoots, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => {
  await t?.close();
  t = undefined;
  closeTrackedStores();
});

describe("file import source and Neatlogs export span fields", () => {
  it("marks OTLP JSON, Neatlogs HTTP trace, and Neatlogs export files with neatroots.import.source = 'file'", async () => {
    t = await makeRoots({ noEngine: true });
    const otlpTid = hex(16);
    const exportTid = hex(16);
    const otlp = JSON.stringify({
      resourceSpans: [
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [{ traceId: otlpTid, spanId: hex(8), name: "otlp-root", kind: 1, startTimeUnixNano: "1000000", endTimeUnixNano: "2000000", status: {} }],
            },
          ],
        },
      ],
    });
    const httpTrace = JSON.stringify({ name: "http-root", children: [{ name: "child-tool" }] });
    const exportTrace = JSON.stringify({
      data: {
        schemaVersion: 1,
        trace: { traceId: exportTid, workflowName: "wf" },
        spans: [
          {
            traceId: exportTid,
            spanId: "1234567890abcdef",
            parentSpanId: null,
            spanName: "export-root",
            spanType: "workflow",
            startedAt: "2026-10-09T10:00:00Z",
            endedAt: "2026-10-09T10:00:01Z",
            durationMs: 1000,
            status: "OK",
          },
        ],
      },
    });

    const uOtlp = t.roots.ingest(parseTraceFile(otlp, "otlp.json"));
    const uHttp = t.roots.ingest(parseTraceFile(httpTrace, "http.json"));
    const uExport = t.roots.ingest(parseTraceFile(exportTrace, "export.json"));

    expect(importSource(t.roots, uOtlp[0].traceId)).toBe("file");
    expect(t.roots.store.getRun(uOtlp[0].traceId)?.project).toBe("imported");
    expect(importSource(t.roots, uHttp[0].traceId)).toBe("file");
    expect(importSource(t.roots, uExport[0].traceId)).toBe("file");
  });

  it("preserves span error messages and toolName in Neatlogs trace exports", () => {
    const tid = hex(16);
    const sid = "abcdef0123456789";
    const exportWithError = JSON.stringify({
      data: {
        schemaVersion: 1,
        trace: { traceId: tid, workflowName: "billing-agent" },
        spans: [
          {
            traceId: tid,
            spanId: sid,
            parentSpanId: null,
            spanName: "charge_card",
            spanType: "TOOL",
            toolName: "stripe_charge",
            startedAt: "2026-10-09T10:00:00Z",
            endedAt: "2026-10-09T10:00:01Z",
            durationMs: 1000,
            status: "ERROR",
            error: "Card declined: insufficient funds",
            input: { amount: 5000 },
            output: null,
          },
        ],
      },
    });

    const batches = parseTraceFile(exportWithError, "export.json");
    const span = batches[0].spans[0];
    expect(span.status.code).toBe(2);
    expect(span.status.message).toBe("Card declined: insufficient funds");
    const view = buildView(span, batches[0].resource.attributes);
    expect(view.error).toBe("Card declined: insufficient funds");
    expect(view.toolName).toBe("stripe_charge");
  });

  it("preserves neatlogs.workflow.name resource and span aliases without overwriting with 'imported'", async () => {
    t = await makeRoots({ noEngine: true });
    const resourceAliasTid = hex(16);
    const spanAliasTid = hex(16);
    const otlpWithAliases = JSON.stringify({
      resourceSpans: [
        {
          resource: {
            attributes: [{ key: "neatlogs.workflow.name", value: { stringValue: "existing-workflow" } }],
          },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [
                {
                  traceId: resourceAliasTid,
                  spanId: hex(8),
                  name: "resource-alias-root",
                  kind: 1,
                  startTimeUnixNano: "1000000",
                  endTimeUnixNano: "2000000",
                  status: {},
                },
              ],
            },
          ],
        },
        {
          resource: { attributes: [] },
          scopeSpans: [
            {
              scope: { name: "test" },
              spans: [
                {
                  traceId: spanAliasTid,
                  spanId: hex(8),
                  name: "span-alias-root",
                  kind: 1,
                  startTimeUnixNano: "1000000",
                  endTimeUnixNano: "2000000",
                  attributes: [{ key: "neatlogs.workflow.name", value: { stringValue: "span-workflow" } }],
                  status: {},
                },
              ],
            },
          ],
        },
      ],
    });

    const batches = parseTraceFile(otlpWithAliases, "aliases.json");
    expect(buildView(batches[0].spans[0], batches[0].resource.attributes).workflow).toBe("existing-workflow");
    expect(buildView(batches[1].spans[0], batches[1].resource.attributes).workflow).toBe("span-workflow");

    const ingested = t.roots.ingest(batches);
    expect(importSource(t.roots, ingested[0].traceId)).toBe("file");
    expect(t.roots.store.getRun(ingested[0].traceId)?.project).toBe("existing-workflow");
    expect(importSource(t.roots, ingested[1].traceId)).toBe("file");
    expect(t.roots.store.getRun(ingested[1].traceId)?.project).toBe("span-workflow");

    const explicitBatches = parseTraceFile(otlpWithAliases, "aliases.json", "override-project");
    expect(buildView(explicitBatches[0].spans[0], explicitBatches[0].resource.attributes).workflow).toBe("override-project");
    expect(buildView(explicitBatches[1].spans[0], explicitBatches[1].resource.attributes).workflow).toBe("override-project");
  });
});

