import type { Command } from "commander";
import { CLIENTS, connectClient, disconnectClient, findClient, listClients, manualSnippet, serverCommand, type ClientStatus } from "../mcp/clients.js";
import { ask } from "./util.js";

function table(rows: ClientStatus[]): void {
  const w = Math.max(...rows.map((r) => r.label.length));
  for (const r of rows) {
    const state = r.connected ? "connected" : r.detected ? "found, not connected" : "not found";
    console.log(`  ${r.connected ? "✓" : r.detected ? "·" : " "} ${r.label.padEnd(w)}  ${state.padEnd(20)}  ${r.connected || r.detected ? r.where : ""}`);
  }
}

function report(results: { id: string; ok: boolean; message: string }[]): void {
  for (const r of results) {
    const c = findClient(r.id)!;
    console.log(`${r.ok ? "✓" : "✗"} ${c.label}: ${r.message}`);
    if (r.ok && c.note) console.log(`  ${c.note}`);
  }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

/** neatroots connect: register the MCP server with the coding agents on this machine. */
export function registerConnectCommand(program: Command): void {
  program
    .command("connect")
    .argument("[agents...]", `coding agents to connect: ${CLIENTS.map((c) => c.id).join(", ")}`)
    .description("Let coding agents (Claude Code, Codex, Cursor, …) read neatroots' runs and findings over MCP")
    .option("--detected", "connect every agent found on this machine")
    .option("-y, --yes", "don't ask before connecting")
    .option("--remove", "disconnect the named agents (or every connected one with --detected)")
    .option("--list", "show which agents are found and connected")
    .option("--list-detected", "print the agents found but not connected, comma-separated (for scripts)")
    .option("--print <agent>", "print what to add by hand for one agent")
    .addHelpText("after", `\nExamples:\n  neatroots connect                 # pick from the agents found here\n  neatroots connect cursor codex\n  neatroots connect --detected -y\n  neatroots connect --remove cursor`)
    .action(async (names: string[], opts) => {
      const rows = listClients();
      if (opts.listDetected) {
        console.log(rows.filter((r) => r.detected && !r.connected).map((r) => r.label).join(", "));
        return;
      }
      if (opts.print) {
        const c = findClient(opts.print);
        if (!c) throw new Error(`unknown agent "${opts.print}". Known: ${CLIENTS.map((x) => x.id).join(", ")}`);
        console.log(manualSnippet(c));
        return;
      }
      if (opts.list) {
        table(rows);
        const cmd = serverCommand();
        console.log(`\nServer command: ${[cmd.command, ...cmd.args].join(" ")}`);
        return;
      }

      let targets = names.map((n) => {
        const c = findClient(n);
        if (!c) throw new Error(`unknown agent "${n}". Known: ${CLIENTS.map((x) => x.id).join(", ")}`);
        return c;
      });
      if (opts.remove) {
        if (!targets.length && opts.detected) targets = CLIENTS.filter((c) => rows.find((r) => r.id === c.id)?.connected);
        if (!targets.length) throw new Error("name the agents to disconnect, e.g. neatroots connect --remove cursor");
        report(targets.map(disconnectClient));
        return;
      }

      if (!targets.length) {
        const found = rows.filter((r) => r.detected && !r.connected);
        if (!found.length) {
          table(rows);
          console.log(rows.some((r) => r.connected) ? "\nEvery agent found here is connected." : "\nNo coding agents found. Name one to connect it anyway, e.g. neatroots connect cursor");
          return;
        }
        if (!opts.detected && !opts.yes && !process.stdin.isTTY) {
          table(rows);
          console.log(`\nRun neatroots connect --detected -y to connect ${found.map((r) => r.label).join(", ")}.`);
          return;
        }
        if (!opts.yes) {
          const answer = (await ask(`Connect neatroots to ${found.map((r) => r.label).join(", ")}? [Y/n] `)).trim().toLowerCase();
          if (answer && answer !== "y" && answer !== "yes") return;
        }
        targets = found.map((r) => findClient(r.id)!);
      }
      report(targets.map((c) => connectClient(c)));
      console.log(`\nThen ask your coding agent: "What did neatroots find in my last run?"`);
    });
}
