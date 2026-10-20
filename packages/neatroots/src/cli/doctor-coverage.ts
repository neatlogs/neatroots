type Line = (pass: boolean | "warn", message: string) => void;

/** Optional, bounded and nonfatal; call only after the existing doctor probe handling. */
export async function doctorCoverage(port: number, line: Line): Promise<void> {
  try {
    const response = await fetch(`http://localhost:${port}/api/audit/status`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error("unavailable");
    const body = await response.json() as { coverage?: Record<string, unknown> };
    const c = body?.coverage;
    const keys = ["observed_runs", "traced_runs", "imported_runs", "unclassified_runs", "guidance_delivered_runs"] as const;
    if (!c || c.scope !== "current_local_store" || !keys.every(k => Number.isSafeInteger(c[k]) && (c[k] as number) >= 0)
      || c.observed_runs !== (c.traced_runs as number) + (c.imported_runs as number) + (c.unclassified_runs as number)
      || (c.guidance_delivered_runs as number) > (c.observed_runs as number)) throw new Error("invalid response");
    line(true, `capture coverage (retained non-doctor runs): ${c.traced_runs} received, ${c.imported_runs} imported, ${c.unclassified_runs} unknown`);
    line(true, `guidance delivered to ${c.guidance_delivered_runs} retained runs (overlaps capture; does not prove it was followed)`);
    const connections = c.connections as { state?: string } | undefined;
    if (connections?.state !== "available") line("warn", "connection inventory unavailable; stored-run counts remain available");
    line("warn", "an MCP connection reads neatroots over MCP — its own runs are not captured; independent instrumentation may exist");
    line("warn", "closed, web and unknown agents without telemetry cannot be enumerated; capture is separate from archive protection");
  } catch {
    line("warn", "audit coverage unavailable (older server, invalid response or failed request); trace checks are unchanged");
  }
}
