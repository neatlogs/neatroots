import fs from "node:fs";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { defaultConfig, saveConfig, type RootsConfig } from "../src/config.js";
import { hex, makeRoots } from "./helpers.js";

const exec = promisify(execFile);
const cwd = fileURLToPath(new URL("..", import.meta.url));
const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { for (const close of cleanup.splice(0)) await close(); });
async function server(config: (c: RootsConfig) => void = () => {}) {
  const tb = await makeRoots({ serve: true, noEngine: true, config }); cleanup.push(tb.close);
  // Deliberately different from live server configuration: diagnostics must use the server.
  const local = defaultConfig(); local.steering.enabled = false; local.projects = {};
  local.llm.enabled = false; local.llm.baseUrl = "http://127.0.0.1:9/v1";
  local.classifier.backend = "llm"; local.classifier.laya.enabled = false; local.classifier.laya.port = 9;
  saveConfig(local, path.join(tb.roots.home, "config.yaml"));
  return tb;
}
async function cli(tb: Awaited<ReturnType<typeof server>>, command: "status" | "doctor", label: string) {
  const result = await exec(process.execPath, ["--import", "tsx", "src/cli.ts", command, "--port", String(tb.roots.config.port)], {
    cwd, timeout: 15_000, env: { ...process.env, HOME: tb.roots.home, USERPROFILE: tb.roots.home, NEATROOTS_HOME: tb.roots.home },
  });
  if (process.env.ISSUE286_EVIDENCE) fs.writeFileSync(path.join(process.env.ISSUE286_EVIDENCE, `${label}-${command}.log`), result.stdout + result.stderr);
  return result.stdout;
}
for (const [label, config, expected] of [
  ["global-off", (c: RootsConfig) => { c.steering.enabled = false; c.projects.agent = { steering: "advisory" }; }, "disabled by global switch"],
  ["no-projects", (_c: RootsConfig) => {}, "no projects have steering enabled"],
  ["default-off", (c: RootsConfig) => { c.projects.agent = { forward: true }; }, "no projects have steering enabled"],
  ["explicit-off", (c: RootsConfig) => { c.projects.agent = { steering: "off" }; }, "no projects have steering enabled"],
] as const) {
  it(`doctor treats ${label} as informational using live effective modes`, async () => {
    const tb = await server(config);
    const status = await (await fetch(`${tb.url}/api/status`)).json();
    expect(status.steering.enabled_project_count).toBe(0);
    const output = await cli(tb, "doctor", label);
    expect(output).toContain(`· steering: ${expected}`);
    expect(output).not.toContain("! steering:");
  });
}
for (const mode of ["advisory", "gate", "self-check"] as const) {
  it(`doctor warns without failing for opted-in ${mode} with no contact`, async () => {
    const tb = await server((c) => { c.projects.agent = { steering: mode }; });
    const status = await (await fetch(`${tb.url}/api/status`)).json();
    expect(status.steering.enabled_project_count).toBe(1);
    const output = await cli(tb, "doctor", mode);
    expect(output).toContain("! steering: no hook contact observed since server start");
    expect(output).toContain("wrap your LLM client"); expect(output).toContain("docs/steering.md");
    expect(output).toContain("trace round trip"); // exec succeeded: optional warning did not fail doctor.
  });
}
for (const [label, timestamp, expected] of [
  ["current", () => Date.now(), "0s ago"],
  ["historical", () => Date.now() - 86400000, "1d ago"],
  ["legacy", () => undefined, "history unknown"],
] as const) {
  it(`doctor describes ${label} contact without claiming connectivity`, async () => {
    const tb = await server((c) => { c.projects.agent = { steering: "advisory" }; });
    tb.roots.steerSeenMs = timestamp() as number;
    const output = await cli(tb, "doctor", label);
    expect(output).toContain("· steering:"); expect(output).not.toContain("! steering:");
    expect(output).toContain(label === "current" ? "since server start" : expected);
    if (label !== "legacy") expect(output).toContain("not current connectivity or delivery");
  });
}
it("global-off status labels recorded contact as historical", async () => {
  const tb = await server((c) => { c.steering.enabled = false; });
  tb.roots.steerSeenMs = Date.now() - 120000;
  const output = await cli(tb, "status", "global-off-historical");
  expect(output).toContain("OFF (global switch)"); expect(output).toContain("historical hook contact since server start");
  expect(output).not.toMatch(/healthy|connected now|active hook/);
});
it("the shipped TypeScript polling hook records contact without a note or a stream", async () => {
  const tb = await server((c) => { c.projects.agent = { steering: "advisory" }; });
  const id = hex(16);
  const sdk = fileURLToPath(new URL("../../steer-ts/src/index.ts", import.meta.url));
  const source = `import {configure,guidance} from ${JSON.stringify(sdk)}; configure({url:${JSON.stringify(tb.url)},disabled:false,neatlogs:{flush:async()=>{}}}); await guidance(${JSON.stringify(id)});`;
  await exec(process.execPath,["--import","tsx","--input-type=module","-e",source],{cwd, timeout:10000});
  expect(tb.roots.steerSeenMs).toEqual(expect.any(Number)); expect(tb.roots.steering.listeners).toBe(0);
  expect(tb.roots.store.getRun(id)).toBeUndefined();
  const output = await cli(tb, "doctor", "typescript-contact");
  expect(output).toContain("not current connectivity or delivery"); expect(output).not.toContain("! steering:");
});
it("contact is process-local and resets for a fresh Roots", async () => {
  const a=await server(); await fetch(`${a.url}/api/steer/claim`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({trace_id:hex(16)})});
  expect(a.roots.steerSeenMs).toEqual(expect.any(Number));
  const b=await server(); expect(b.roots.steerSeenMs).toBeNull();
  const status=await (await fetch(`${b.url}/api/status`)).json(); expect(status.steering.hooks_connected).toBe(0); expect(status.steering.stream_clients).toBe(0);
});
it.runIf(!!process.env.ISSUE286_PYTHON)("the shipped Python listener counts only its live stream and retains historical contact", async () => {
  const tb=await server();
  const sdk=fileURLToPath(new URL("../../../python/neatroots-steer/src",import.meta.url));
  const source=`from neatroots_steer._client import RootsClient; import time; c=RootsClient(${JSON.stringify(tb.url)}); print('ready',flush=True); time.sleep(30)`;
  const child=spawn(process.env.ISSUE286_PYTHON!,["-c",source],{cwd,env:{...process.env,PYTHONPATH:sdk},stdio:["ignore","pipe","pipe"]});
  const exited = new Promise<void>((resolve) => child.once("close", () => resolve()));
  try { await expect.poll(()=>tb.roots.steering.listeners).toBe(1); expect(tb.roots.steerSeenMs).toEqual(expect.any(Number)); }
  finally { child.kill("SIGTERM"); await exited; }
  await expect.poll(()=>tb.roots.steering.listeners).toBe(0); expect(tb.roots.steerSeenMs).toEqual(expect.any(Number));
});
