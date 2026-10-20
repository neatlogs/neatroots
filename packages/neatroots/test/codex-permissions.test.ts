import { expect, it } from "vitest";
import { codexMcpTools, codexPermissionArgs } from "../src/agents/codex-permissions.js";

const combinations = [[false, false], [true, false], [false, true], [true, true]] as const;

for (const [allow_edits, allow_commands] of combinations) {
  it(`scopes permissions independently: edits=${allow_edits} commands=${allow_commands}`, () => {
    const args = codexPermissionArgs({ allow_edits, allow_commands }, ["neatroots", "neatroots_app", "other"], "http://localhost:9999/mcp");
    const configs = args.filter((_v, i) => i % 2 === 1);
    expect(configs).toContain('approval_policy="never"');
    expect(configs).toContain(`sandbox_mode="${allow_edits ? "workspace-write" : "read-only"}"`);
    expect(configs).toContain(`features.shell_tool=${allow_commands}`);
    expect(configs.some((v) => v.startsWith("mcp_servers.other"))).toBe(false);
    expect(configs.some((v) => v.includes(".url="))).toBe(false);
    for (const name of ["neatroots", "neatroots_app"]) {
      const tools = JSON.parse(configs.find((v) => v.startsWith(`mcp_servers.${name}.enabled_tools=`))!.split("=")[1]) as string[];
      expect(tools).toContain("get_span");
      expect(tools.includes("create_check")).toBe(allow_edits);
      expect(tools.includes("replay")).toBe(allow_edits);
      expect(tools.includes("rerun")).toBe(allow_edits && allow_commands);
    }
  });
}

it("injects one scoped server if neither known name exists", () => {
  const args = codexPermissionArgs({ allow_edits: false, allow_commands: false }, ["other"], 'http://localhost:9999/mcp');
  expect(args).toContain('mcp_servers.neatroots.url="http://localhost:9999/mcp"');
  expect(args.some((v) => v.includes("neatroots_app"))).toBe(false);
  expect(codexMcpTools({ allow_edits: false, allow_commands: true })).not.toContain("rerun");
});

