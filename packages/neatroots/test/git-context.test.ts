import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Command } from "commander";
import { readGitContext, registerGitContextCommand } from "../src/cli/git-context.js";

const dirs: string[] = [];
function dir(): string { const d = fs.mkdtempSync(path.join(os.tmpdir(), "roots git ; ")); dirs.push(d); return d; }
function git(repo: string, ...args: string[]): string {
  return execFileSync("git", ["-C", repo, ...args], {encoding: "utf8"}).trim();
}
function repo(): string {
  const d = dir(); git(d, "init", "-q"); git(d, "config", "user.name", "Test"); git(d, "config", "user.email", "test@example.invalid");
  fs.writeFileSync(path.join(d, "file"), "first"); git(d, "add", "."); git(d, "commit", "-qm", "first"); return d;
}
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); for (const d of dirs.splice(0)) fs.rmSync(d, {recursive:true,force:true}); });

describe("git checkout context", () => {
  it("reads a committed checkout without changing refs or files", async () => {
    const d=repo(); const refs=git(d,"show-ref"); const before=fs.readFileSync(path.join(d,"file"),"utf8");
    expect(await readGitContext(d, true)).toMatchObject({commit:git(d,"rev-parse","HEAD"),branch:git(d,"branch","--show-current"),dirty:false});
    expect(git(d,"show-ref")).toBe(refs); expect(fs.readFileSync(path.join(d,"file"),"utf8")).toBe(before);
  });
  it("marks tracked, staged and untracked changes dirty without including their names", async () => {
    const d=repo();
    for (const mode of ["tracked","staged","untracked"]) {
      git(d,"reset","--hard","-q"); git(d,"clean","-fdq");
      fs.writeFileSync(path.join(d,mode==="untracked"?"private-name":"file"),"changed");
      if(mode==="staged") git(d,"add","file");
      const context=await readGitContext(d); expect(context.dirty).toBe(true); expect(Object.keys(context).sort()).toEqual(["commit","dirty","observed_at"]);
      expect(JSON.stringify(context)).not.toContain("private-name");
    }
  });
  it("supports a nested directory, detached HEAD and a worktree", async () => {
    const d=repo(); const nested=path.join(d,"nested");fs.mkdirSync(nested);
    expect((await readGitContext(nested)).commit).toBe(git(d,"rev-parse","HEAD"));
    const w=dir();git(d,"worktree","add","--detach",w,"HEAD");
    expect(await readGitContext(w,true)).toMatchObject({commit:git(d,"rev-parse","HEAD"),branch:null,dirty:false});
  });
  it("rejects a missing path, non-repo and unborn checkout", async () => {
    const d=dir(); for(const p of [path.join(d,"missing"),d]) await expect(readGitContext(p)).rejects.toThrow("could not read git context");
    git(d,"init","-q");await expect(readGitContext(d)).rejects.toThrow("could not read git context");
  });
  it("does not execute a configured fsmonitor command", async () => {
    const d=repo();const marker=path.join(d,"ran-hook");git(d,"config","core.fsmonitor",`touch '${marker}'`);
    await readGitContext(d);expect(fs.existsSync(marker)).toBe(false);
  });
  it("labels 120 real checkout reads correctly, 60 dirty and 60 clean", async () => {
    const d=repo(); let clean=0,dirty=0;
    for(let n=0;n<120;n++) {
      fs.writeFileSync(path.join(d,"file"),n%2?"changed":"first");
      const c=await readGitContext(d);expect(c.dirty).toBe(Boolean(n%2));c.dirty?dirty++:clean++;
    }
    expect({clean,dirty}).toEqual({clean:60,dirty:60});
  });
});

describe("annotate-git command", () => {
  function command() { const p=new Command();registerGitContextCommand(p);return p; }
  it("checks the selected run before writing only a git-context note", async () => {
    const d=repo();const calls:{url:string,init:RequestInit|undefined}[]=[];
    vi.spyOn(console,"log").mockImplementation(()=>{});
    vi.stubGlobal("fetch",vi.fn(async (url,init)=>{calls.push({url:String(url),init});return new Response(JSON.stringify({id:"note"}),{status:200});}));
    await command().parseAsync(["node","test","annotate-git","trace/one","--repo",d]);
    expect(calls.map(c=>new URL(c.url).pathname)).toEqual(["/health","/api/runs/trace%2Fone","/api/annotations"]);
    const body=JSON.parse(String(calls[2].init?.body));expect(body.trace_id).toBe("trace/one");expect(body.label).toBe("note");expect(body.text).toContain("not run provenance");expect(body.text).not.toContain(d);
  });
  it("does not write if the run is missing or the server is offline", async () => {
    const d=repo();for(const offline of [false,true]) {
      const fetch=vi.fn(async (url)=>new Response(JSON.stringify({error:"run not found"}),{status:String(url).endsWith("/health")&&!offline?200:404}));vi.stubGlobal("fetch",fetch);
      await expect(command().parseAsync(["node","test","annotate-git","missing","--repo",d])).rejects.toThrow();
      expect(fetch.mock.calls.some(([,init])=>(init as RequestInit|undefined)?.method==="POST")).toBe(false);
    }
  });
});

it("ignores inherited GIT_DIR and GIT_WORK_TREE instead of tagging the wrong checkout", async () => {
  const wanted=repo(), other=repo();fs.writeFileSync(path.join(other,"file"),"other");git(other,"add",".");git(other,"commit","-qm","other");
  vi.stubEnv("GIT_DIR",path.join(other,".git"));vi.stubEnv("GIT_WORK_TREE",other);
  try { const c=await readGitContext(wanted);expect(c.dirty).toBe(false);expect(c.commit).not.toBe(execFileSync("git",["rev-parse","HEAD"],{cwd:other,encoding:"utf8"}).trim()); }
  finally {vi.unstubAllEnvs();}
});

it("omits branch by default and includes it only on request", async () => {
  const d=repo();git(d,"branch","-m","customer-private-ticket");
  const c=await readGitContext(d);expect(c).not.toHaveProperty("branch");expect(JSON.stringify(c)).not.toContain("customer-private-ticket");expect(Number.isNaN(Date.parse(c.observed_at))).toBe(false);
  expect((await readGitContext(d,true)).branch).toBe("customer-private-ticket");
});

it("reads the selected submodule rather than the enclosing repository", async () => {
  const d=repo(), source=repo();
  fs.writeFileSync(path.join(source,"file"),"submodule");git(source,"add",".");git(source,"commit","-qm","submodule");
  git(d,"-c","protocol.file.allow=always","submodule","add","-q",source,"child");
  const c=await readGitContext(path.join(d,"child"));expect(c.commit).toBe(git(source,"rev-parse","HEAD"));expect(c.commit).not.toBe(git(d,"rev-parse","HEAD"));
});

it.each(["head-change","bad-head","bad-status","failed-status","bad-branch","timeout"])("aborts on %s without writing an annotation", async (scenario) => {
  const d=dir();const bin=path.join(d,"bin");fs.mkdirSync(bin);const file=path.join(bin,"git");
  fs.writeFileSync(file,`#!${process.execPath}\nconst fs=require('node:fs');const p=${JSON.stringify(path.join(d,"calls"))};let n=0;try{n=Number(fs.readFileSync(p,'utf8'))}catch{}fs.writeFileSync(p,String(n+1));const s=${JSON.stringify(scenario)};const args=process.argv.slice(2);if(s==='timeout'){setTimeout(()=>{},20000)}else if(args.includes('rev-parse')){console.log(s==='bad-branch'&&args.includes('--abbrev-ref')?'invalid branch':s==='bad-head'?'invalid':s==='head-change'&&n>1?'b'.repeat(40):'a'.repeat(40))}else if(s==='failed-status'){process.exit(1)}else if(s==='bad-status'){console.log('not a status')}\n`);fs.chmodSync(file,0o755);
  vi.stubEnv("PATH",bin+path.delimiter+process.env.PATH);
  const fetch=vi.fn();vi.stubGlobal("fetch",fetch);
  try {const start=Date.now();await expect(new Command().addCommand((()=>{const p=new Command();registerGitContextCommand(p);return p.commands[0]})()).parseAsync(["node","test","annotate-git","run","--repo",d,"--include-branch"])).rejects.toThrow();expect(fetch).not.toHaveBeenCalled();expect(Date.now()-start).toBeLessThan(11000);}
  finally{vi.unstubAllEnvs();}
});
