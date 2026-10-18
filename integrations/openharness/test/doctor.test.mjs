import test from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
const script = fileURLToPath(new URL("../toolchain/doctor.sh", import.meta.url));
function run(base, bin) {
  return new Promise(resolve => {
    const child = spawn("/bin/sh", [script], { env: { ...process.env, HARNESS_WORKSPACE: "", NEATLOGS_ENDPOINT: base, PATH: bin + ":" + process.env.PATH }, stdio: ["ignore", "pipe", "pipe"] });
    let text = ""; child.stdout.on("data", d => text += d); child.stderr.on("data", d => text += d);
    child.on("close", code => resolve({ code, text }));
  });
}
test("doctor checks health with a fixed deadline and never follows redirects", async t => {
  const bin = fs.mkdtempSync(path.join(os.tmpdir(), "openharness-doctor-"));
  t.after(() => fs.rmSync(bin, { recursive: true, force: true }));
  fs.writeFileSync(path.join(bin, "opencode"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
  let mode = "ok", requests = 0;
  const server = http.createServer((_req, res) => {
    requests++;
    if (mode === "ok") res.end("ok");
    else if (mode === "redirect") { res.writeHead(302, { location: "http://example.invalid" }); res.end(); }
  });
  await new Promise(r => server.listen(0, "127.0.0.1", r));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = "http://127.0.0.1:" + server.address().port;
  assert.equal((await run(base, bin)).code, 0);
  mode = "redirect"; assert.notEqual((await run(base, bin)).code, 0);
  mode = "stall"; const start = Date.now();
  assert.notEqual((await run(base, bin)).code, 0); assert.ok(Date.now() - start < 7000);
  const before = requests;
  assert.notEqual((await run("https://example.com", bin)).code, 0); assert.equal(requests, before);
});
