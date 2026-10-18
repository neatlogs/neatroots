import { execFile } from "node:child_process";
import { TOOLS } from "../mcp/tools.js";
import { EXPLORE_TOOLS } from "../mcp/explore-tools.js";

export interface ChatPermissions { allow_edits: boolean; allow_commands: boolean }

export function validateChatPermissions(value: { allow_edits?: unknown; allow_commands?: unknown }): void {
  for (const key of ["allow_edits", "allow_commands"] as const) {
    if (value[key] !== undefined && typeof value[key] !== "boolean") throw new Error(`${key} must be a boolean`);
  }
}

// Only known operations gain write access. A new unclassified mutator stays unavailable.
const WRITES = new Set(["explain_run", "ask", "judge", "create_check", "preview_check", "annotate", "replay", "import_cloud_trace", "push_to_cloud"]);
export function codexMcpTools(permissions: ChatPermissions): string[] {
  return [...TOOLS, ...EXPLORE_TOOLS]
    .filter((tool) => tool.readOnly || (permissions.allow_edits && WRITES.has(tool.name)) || (permissions.allow_edits && permissions.allow_commands && tool.name === "rerun"))
    .map((tool) => tool.name);
}

/** Ask the CLI for effective user/project server names without starting a model or changing config. */
export async function codexServerNames(bin: string, cwd: string, signal?: AbortSignal, timeout = 10_000): Promise<string[]> {
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(bin, ["mcp", "list", "--json"], { cwd, encoding: "utf8", timeout, maxBuffer: 4 * 1024 * 1024, windowsHide: true, signal }, (error, output) => {
      if (error) reject(new Error("Could not inspect Codex MCP configuration. Update Codex and try again.", { cause: error }));
      else resolve(output);
    });
  });
  try {
    const servers: unknown = JSON.parse(stdout);
    if (!Array.isArray(servers) || servers.some((s) => !s || typeof s.name !== "string")) throw new Error("invalid server list");
    return servers.map((s) => s.name);
  } catch {
    throw new Error("Could not read Codex MCP configuration; chat was not started.");
  }
}

/** Per-invocation overrides preserve each existing server's transport and credentials. */
export function codexPermissionArgs(permissions: ChatPermissions, names: string[], url: string): string[] {
  const values = [
    `approval_policy="never"`,
    `sandbox_mode="${permissions.allow_edits ? "workspace-write" : "read-only"}"`,
    `features.shell_tool=${permissions.allow_commands}`,
  ];
  const ours = names.filter((name) => name === "neatroots" || name === "neatroots_app");
  if (!ours.length) { ours.push("neatroots"); values.push(`mcp_servers.neatroots.url=${JSON.stringify(url)}`); }
  for (const name of ours) values.push(`mcp_servers.${name}.enabled_tools=${JSON.stringify(codexMcpTools(permissions))}`);
  return values.flatMap((value) => ["-c", value]);
}
