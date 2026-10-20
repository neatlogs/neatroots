import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditArchive, comparisonDirectory } from "../src/audit/archive.js";
import { readFile } from "../src/audit/files.js";
import { batch, hex, makeRoots, span, type TestRoots } from "./helpers.js";

let t: TestRoots | undefined;
afterEach(async () => { vi.restoreAllMocks(); await t?.close(); });

it("rejects an inaccessible filesystem root with bounded ancestor traversal", () => {
  let probes = 0;
  vi.spyOn(fs, "existsSync").mockImplementation(() => {
    if (++probes > 20) throw new Error("ancestor traversal did not terminate");
    return false;
  });
  expect(() => comparisonDirectory(path.resolve("missing", "share"))).toThrow(/filesystem root does not exist or is inaccessible/);
  expect(probes).toBeLessThanOrEqual(20);
});

describe.skipIf(process.platform === "win32")("nonblocking archive reads", () => {
  it("rejects a different regular file substituted during the read", async () => {
    t = await makeRoots({ noEngine: true });
    const file = path.join(t.roots.home, "original");
    fs.writeFileSync(file, "original");
    const originalRead = fs.readFileSync;
    vi.spyOn(fs, "readFileSync").mockImplementationOnce((fd) => {
      const bytes = originalRead(fd);
      fs.renameSync(file, file + ".preserved");
      fs.writeFileSync(file, "replacement");
      return bytes;
    });
    expect(() => readFile(file)).toThrow(/changed while reading/);
    expect(originalRead(file + ".preserved", "utf8")).toBe("original");
  });

  it.each(["manifest.jsonl", "trace.json", "record.json", "swapped-fifo"])("rejects %s promptly in an isolated child", async (name) => {
    t = await makeRoots({ noEngine: true });
    const traceId = hex(16);
    t.roots.ingest([batch([span({ traceId, name: "fifo test", kind: "workflow" })])]);
    const exported = new AuditArchive(t.roots).export(traceId);
    const directory = path.join(t.roots.home, "audit");
    const target = name === "manifest.jsonl" ? path.join(directory, name)
      : path.join(directory, path.dirname(exported.path!), name === "swapped-fifo" ? "trace.json" : name);
    if (name !== "swapped-fifo") {
      fs.unlinkSync(target);
      execFileSync("mkfifo", [target]);
    }
    // The race case replaces a previously regular file after lstat, immediately before open.
    // A regression can hang only this disposable child; timeout never blocks the test process.
    const script = `
      import fs from 'node:fs';
      import { execFileSync } from 'node:child_process';
      import { verifyArchive } from './src/audit/manifest.ts';
      const target = ${JSON.stringify(target)};
      if (${JSON.stringify(name)} === 'swapped-fifo') {
        const open = fs.openSync;
        let swapped = false;
        fs.openSync = function(file, ...args) {
          if (file === target && !swapped) {
            swapped = true; fs.unlinkSync(target); execFileSync('mkfifo', [target]);
          }
          return open.call(fs, file, ...args);
        };
      }
      const report = verifyArchive(${JSON.stringify(directory)});
      console.log(JSON.stringify(report));
      process.exitCode = report.ok ? 2 : 0;
    `;
    const child = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "-e", script], {
      cwd: path.resolve(import.meta.dirname, ".."), encoding: "utf8", timeout: 4000,
    });
    expect(child.error, child.stderr).toBeUndefined();
    expect(child.signal, child.stderr).toBeNull();
    expect(child.status, child.stderr).toBe(0);
    expect(JSON.parse(child.stdout).errors.join()).toContain("unsafe archive file");
  });
});
