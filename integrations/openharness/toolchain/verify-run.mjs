import { pathToFileURL } from "node:url";
export function loopback(value) {
  const u = new URL(value);
  if (!["http:", "https:"].includes(u.protocol) || !["localhost", "127.0.0.1", "[::1]"].includes(u.hostname) ||
      u.username || u.password || u.search || u.hash || !["", "/"].includes(u.pathname)) throw new Error("A loopback base URL without credentials is required");
  return u.origin;
}
export function inspectRun(data, trace, check) {
  const run = data?.run, spans = data?.spans;
  if (run?.trace_id !== trace || !Array.isArray(spans) || !Array.isArray(data.findings)) return null;
  const root = spans.find(s => s.span_id === run.root_span_id && ["AGENT", "WORKFLOW"].includes(s.span_kind));
  const ids = new Set(spans.map(s => s.span_id));
  const belongs = s => {
    const seen = new Set();
    while (s && s.span_id !== root?.span_id && !seen.has(s.span_id)) {
      seen.add(s.span_id); s = spans.find(p => p.span_id === s.parent_span_id);
    }
    return !!root && s?.span_id === root.span_id;
  };
  if (spans.some(s => s.trace_id !== trace) || !root || !spans.some(s => s.span_kind === "LLM" && belongs(s)) || !spans.some(s => s.span_kind === "TOOL" && belongs(s)) ||
      run.status === "running" || !run.complete) return null;
  const finding = data.findings.find(f => f.trace_id === trace && f.check_id === check && f.check_kind === "rule" &&
    ["raised", "active"].includes(f.status) && f.evidence_span_ids?.length && f.evidence_span_ids.every(id => ids.has(id)));
  if (!finding || !data.coverage || !["done", "rules-only"].includes(data.coverage.state) || data.coverage.pending !== 0) return null;
  return { trace_id: trace, root_span_id: root.span_id, check_id: check, finding_id: finding.id,
    coverage: data.coverage.state, llm_spans: spans.filter(s => s.span_kind === "LLM").length, tool_spans: spans.filter(s => s.span_kind === "TOOL").length };
}
export async function verifyRun(base, trace, check, timeoutMs = 30_000) {
  base = loopback(base);
  if (!/^[a-f0-9]{32}$/i.test(trace) || !/^[a-zA-Z0-9_.-]{1,128}$/.test(check)) throw new Error("Explicit trace id and check id required");
  const deadline = Date.now() + Math.min(Math.max(timeoutMs, 1), 30_000);
  while (Date.now() < deadline) {
    try {
      const response = await fetch(base + "/api/runs/" + trace, { redirect: "manual", signal: AbortSignal.timeout(Math.max(1, Math.min(5000, deadline - Date.now()))) });
      if (response.status !== 404 && response.status !== 200) throw new Error("Unexpected local response");
      if (response.status === 200) {
        let size = 0; const chunks = [];
        for await (const chunk of response.body) { size += chunk.length; if (size > 1024 * 1024) throw new Error("Response too large"); chunks.push(chunk); }
        const result = inspectRun(JSON.parse(Buffer.concat(chunks).toString()), trace, check);
        if (result) return result;
      } else await response.body?.cancel();
    } catch { /* bounded polling; never print payloads or URL-bearing errors */ }
    await new Promise(r => setTimeout(r, Math.min(250, Math.max(0, deadline - Date.now()))));
  }
  throw new Error("Exact trace/check evidence did not become complete within the deadline");
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyRun(process.argv[2] || "http://localhost:4100", process.argv[3] || "", process.argv[4] || "")
    .then(r => console.log(JSON.stringify(r))).catch(() => { console.error("Verification failed: require loopback URL and complete exact trace/check evidence"); process.exitCode = 1; });
}
