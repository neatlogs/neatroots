import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { makeRoots, poll } from "./helpers.js";
import { codexServerNames } from "../src/agents/codex-permissions.js";
import { createApp } from "../src/server/app.js";

const cleanup: (() => Promise<void>)[] = [];
const previous = process.env.NEATROOTS_CODEX_BIN;
afterEach(async () => {
  for (const close of cleanup.splice(0)) await close();
  if (previous === undefined) delete process.env.NEATROOTS_CODEX_BIN;
  else process.env.NEATROOTS_CODEX_BIN = previous;
});
const combinations = [[false, false], [true, false], [false, true], [true, true]] as const;

it("rejects nonboolean API permissions and preserves independent readback", async () => {
  const tb = await makeRoots({ noEngine: true }); cleanup.push(tb.close);
  const app = createApp(tb.roots);
  for (const bad of ["false", 1, null, {}]) {
    const response = await app.request("http://localhost/api/chat/sessions", { method: "POST", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ agent: "codex", cwd: os.tmpdir(), allow_edits: bad }) });
    expect(response.status).toBe(400);
  }
  for (const [allow_edits, allow_commands] of combinations) {
    const s = tb.roots.chats.create({ agent: "codex", cwd: os.tmpdir(), allow_edits, allow_commands });
    const response = await app.request(`http://localhost/api/chat/sessions/${s.id}`, { method: "PATCH", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ allow_edits: !allow_edits, allow_commands: !allow_commands }) });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ allow_edits: !allow_edits, allow_commands: !allow_commands });
    const invalid = await app.request(`http://localhost/api/chat/sessions/${s.id}`, { method: "PATCH", headers: { "content-type": "application/json", host: "localhost" }, body: JSON.stringify({ allow_commands: "true" }) });
    expect(invalid.status).toBe(400);
    expect(tb.roots.chats.get(s.id)?.allow_commands).toBe(!allow_commands);
  }
});

describe.skipIf(process.platform === "win32")("Codex CLI invocation", () => {
  for (const [allow_edits, allow_commands] of combinations) {
    it(`reapplies policy on create and resume (${allow_edits}/${allow_commands})`, async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-codex-permissions-"));
      const log = path.join(dir, "argv.jsonl"); const bin = path.join(dir, "codex");
      fs.writeFileSync(bin, `#!/usr/bin/env node\nconst fs=require('node:fs');const a=process.argv.slice(2);if(a[0]==='mcp'){console.log(JSON.stringify([{name:'neatroots'},{name:'neatroots_app'},{name:'other'}]));process.exit(0);}fs.appendFileSync(${JSON.stringify(log)},JSON.stringify(a)+'\\n');console.log(JSON.stringify({type:'thread.started',thread_id:'thread_test'}));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:1,output_tokens:1}}));\n`, { mode: 0o755 });
      process.env.NEATROOTS_CODEX_BIN = bin;
      const tb = await makeRoots({ noEngine: true });
      cleanup.push(async () => { await tb.close(); fs.rmSync(dir, { recursive: true, force: true }); });
      const s = tb.roots.chats.create({ agent: "codex", cwd: dir, allow_edits, allow_commands });
      await tb.roots.chats.send(s.id, "first"); await tb.roots.chats.send(s.id, "-second");
      const calls: string[][] = fs.readFileSync(log, "utf8").trim().split("\n").map((line) => JSON.parse(line));
      expect(calls).toHaveLength(2); expect(calls[1].slice(0, 3)).toEqual(["exec", "resume", "thread_test"]);
      for (const call of calls) {
        expect(call).toContain("--strict-config"); expect(call).toContain(`features.shell_tool=${allow_commands}`);
        expect(call).toContain(`sandbox_mode="${allow_edits ? "workspace-write" : "read-only"}"`);
        expect(call).toContain('approval_policy="never"'); expect(call.at(-2)).toBe("--");
      }
      expect(calls[1].at(-1)).toBe("-second");
    });
  }
});


describe.skipIf(process.platform === "win32")("asynchronous Codex preflight", () => {
  async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "neatroots-preflight-"));
    const bin = path.join(dir, "codex");
    fs.writeFileSync(bin, `#!/usr/bin/env node
const fs=require('node:fs'),path=require('node:path'); const dir=${JSON.stringify(dir)};
if(process.argv[2]==='mcp') {
 fs.writeFileSync(path.join(dir,'entered'),'yes');
 const mode=fs.existsSync(path.join(dir,'bad'));
 if(mode){console.log('invalid JSON');process.exit(0);}
 const timer=setInterval(()=>{if(fs.existsSync(path.join(dir,'release'))){clearInterval(timer);console.log('[]');}},10);
} else {
 fs.writeFileSync(path.join(dir,'launched'),'yes');
 console.log(JSON.stringify({type:'thread.started',thread_id:'test'}));
 console.log(JSON.stringify({type:'turn.completed'}));
}
`, { mode: 0o755 });
    process.env.NEATROOTS_CODEX_BIN = bin;
    const tb = await makeRoots({ noEngine: true });
    cleanup.push(async () => { await tb.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const s = tb.roots.chats.create({ agent: "codex", cwd: dir });
    return { dir, bin, tb, s };
  }

  it("keeps the API responsive while reserving the turn and its permissions", async () => {
    const { dir, tb, s } = await setup();
    const work = tb.roots.chats.send(s.id, "first");
    await poll(() => fs.existsSync(path.join(dir, "entered")));
    await expect(tb.roots.chats.send(s.id, "duplicate")).rejects.toThrow("still answering");
    expect(() => tb.roots.chats.update(s.id, { allow_commands: true })).toThrow("Stop the current message");
    const response = await createApp(tb.roots).request("http://localhost/api/chat/sessions", { headers: { host: "localhost" } });
    expect(response.status).toBe(200);
    const bypass = await createApp(tb.roots).request(`http://localhost/api/chat/sessions/${s.id}`, { method: "PATCH", headers: { host: "localhost", "content-type": "application/json" }, body: JSON.stringify({ state: "idle", allow_commands: true }) });
    expect(bypass.status).toBe(400);
    expect(tb.roots.chats.get(s.id)?.state).toBe("running");
    fs.writeFileSync(path.join(dir, "release"), "yes");
    await work;
    expect(tb.roots.chats.get(s.id)?.state).toBe("idle");
    expect(tb.roots.chats.events(s.id).filter((e) => e.kind === "user")).toHaveLength(1);
  });

  for (const action of ["stop", "delete"]) it(`does not launch after ${action} during preflight`, async () => {
    const { dir, tb, s } = await setup();
    const work = tb.roots.chats.send(s.id, "first");
    await poll(() => fs.existsSync(path.join(dir, "entered")));
    if (action === "stop") expect(tb.roots.chats.stop(s.id)).toBe(true);
    else tb.roots.chats.remove(s.id);
    await work;
    expect(fs.existsSync(path.join(dir, "launched"))).toBe(false);
    expect(tb.roots.chats.get(s.id)?.state).toBe(action === "stop" ? "idle" : undefined);
    if (action === "delete") expect(tb.roots.chats.events(s.id)).toEqual([]);
  });

  it("releases a failed preflight so the session can be retried", async () => {
    const { dir, tb, s } = await setup();
    fs.writeFileSync(path.join(dir, "bad"), "yes");
    await expect(tb.roots.chats.send(s.id, "first")).rejects.toThrow("Could not read Codex");
    expect(tb.roots.chats.get(s.id)?.state).toBe("error");
    fs.unlinkSync(path.join(dir, "bad")); fs.writeFileSync(path.join(dir, "release"), "yes");
    await tb.roots.chats.send(s.id, "retry");
    expect(tb.roots.chats.get(s.id)?.state).toBe("idle");
  });

  it("does not query closed storage or launch after Roots.close during preflight", async () => {
    const { dir, tb, s } = await setup();
    const work = tb.roots.chats.send(s.id, "first");
    await poll(() => fs.existsSync(path.join(dir, "entered")));
    tb.roots.close();
    await work;
    expect(fs.existsSync(path.join(dir, "launched"))).toBe(false);
    expect((tb.roots.chats as unknown as { preflights: Map<string, unknown> }).preflights.size).toBe(0);
  });

  it("bounds discovery time without launching a turn", async () => {
    const { bin, dir } = await setup();
    await expect(codexServerNames(bin, dir, undefined, 50)).rejects.toThrow("Could not inspect Codex");
    expect(fs.existsSync(path.join(dir, "launched"))).toBe(false);
  });
});
