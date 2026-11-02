import { createServer, type ServerResponse } from "node:http";
import { fileURLToPath } from "node:url";
import { build } from "vite";

let bundle: Promise<string> | undefined;
function harnessBundle() {
  return bundle ??= (async () => {
    const result = await build({
      configFile: false,
      logLevel: "silent",
      resolve: { alias: { "@": fileURLToPath(new URL("../../src", import.meta.url)) } },
      define: { "process.env.NODE_ENV": '"production"' },
      build: {
        write: false,
        minify: false,
        lib: { entry: fileURLToPath(new URL("./live-events-harness.tsx", import.meta.url)), name: "LiveEventsHarness", formats: ["iife"] },
      },
    });
    const output = Array.isArray(result) ? result[0] : result;
    if (!("output" in output)) throw new Error("Expected a harness bundle");
    const chunk = output.output.find((item) => item.type === "chunk");
    if (!chunk || chunk.type !== "chunk") throw new Error("Missing harness JavaScript");
    return chunk.code;
  })();
}

/** Real EventSource connections, with controllable outages and run read-back data. */
export async function liveEventsServer() {
  const js = await harnessBundle();
  const streams = new Set<ServerResponse>();
  const waiting = new Set<ServerResponse>();
  const counts = new Map<string, number>();
  const values: Record<string, string> = { a: "original-a", b: "original-b", inactive: "original-inactive" };
  let paused = false;
  let attempts = 0;
  const connect = (res: ServerResponse) => {
    waiting.delete(res);
    streams.add(res);
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store" });
    res.write('event: hello\ndata: {}\n\n');
  };
  const run = (id: string) => ({ trace_id: id, input_preview: values[id], output_preview: values[id] });
  const server = createServer((req, res) => {
    const url = new URL(req.url!, "http://localhost");
    if (url.pathname === "/") {
      res.writeHead(200, { "content-type": "text/html" });
      res.end('<div id="root"></div><script src="/harness.js"></script>');
    } else if (url.pathname === "/harness.js") {
      res.writeHead(200, { "content-type": "text/javascript" });
      res.end(js);
    } else if (url.pathname === "/api/events") {
      attempts++;
      res.on("close", () => { streams.delete(res); waiting.delete(res); });
      if (paused) waiting.add(res);
      else connect(res);
    } else {
      counts.set(url.pathname, (counts.get(url.pathname) ?? 0) + 1);
      const id = url.pathname.split("/")[3];
      let body: unknown = { value: values.a };
      if (url.pathname === "/api/runs") body = { runs: [run("a"), run("b")], total: 2 };
      else if (url.pathname === "/api/conversation") body = { session_id: "session", runs: [run("a")] };
      else if (url.pathname.endsWith("/chat")) body = { root: "span", items: [{ role: "assistant", text: values.a }] };
      else if (url.pathname.endsWith("/replay-options")) body = { default_input: values.a, replays: [] };
      else if (/^\/api\/runs\/[^/]+$/.test(url.pathname)) body = { run: run(id) };
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      res.end(JSON.stringify(body));
    }
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing server port");
  return {
    url: `http://127.0.0.1:${address.port}`,
    values,
    count: (route: string) => counts.get(route) ?? 0,
    get attempts() { return attempts; },
    get connections() { return streams.size; },
    emit(traceId: string) {
      for (const res of streams) res.write(`event: trace\ndata: ${JSON.stringify({ trace_id: traceId })}\n\n`);
    },
    pause() {
      paused = true;
      for (const res of streams) res.destroy();
    },
    resume() {
      paused = false;
      for (const res of waiting) connect(res);
    },
    async close() {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((err) => err ? reject(err) : resolve()));
    },
  };
}
