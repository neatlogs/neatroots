// Dev aid: talk to `neatroots mcp` over stdio like a coding agent would.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [cli, port] = [process.argv[2], process.argv[3]];
const transport = new StdioClientTransport({ command: process.execPath, args: [cli, "mcp", "--port", port], env: { ...process.env } as Record<string, string> });
const client = new Client({ name: "stdio-test", version: "1.0.0" });
const t0 = Date.now();
await client.connect(transport);
console.log("connected in", Date.now() - t0, "ms; server:", client.getServerVersion()?.name);
const tools = await client.listTools();
console.log("tools:", tools.tools.map((t) => t.name).join(", "));
const r = await client.callTool({ name: "search_runs", arguments: { limit: 3 } });
console.log("search_runs:", (r.content as { text: string }[])[0].text.slice(0, 300));
const cur = await client.callTool({ name: "get_current_run", arguments: { max_spans: 10 } });
console.log("get_current_run:", (cur.content as { text: string }[])[0].text.slice(0, 400));
await client.close();
