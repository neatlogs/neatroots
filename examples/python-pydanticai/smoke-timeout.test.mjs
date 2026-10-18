import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import { EventEmitter } from "node:events";
import test from "node:test";

// Execute the actual helper with a deterministic child and clock: no 60s wait.
const source = fs.readFileSync(new URL("./smoke.mjs", import.meta.url), "utf8");
const helper = source.slice(source.indexOf("const run ="), source.indexOf("let roots,"));
for (const timeout of [false, true]) test(`child diagnostics: timeout=${timeout}`, async () => {
  const child = new EventEmitter(); child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  let timer, killed;
  child.kill = signal => { killed = signal; child.emit("exit", null); };
  const run = vm.runInNewContext(`${helper}; run`, {
    process: { env: {} }, here: ".", spawn: () => child,
    setTimeout: callback => { timer = callback; return 1; }, clearTimeout: () => {},
  });
  const result = run([], {});
  child.stderr.emit("data", "child output");
  if (timeout) timer(); else child.emit("exit", 0);
  const receipt = await result;
  if (timeout) { assert.equal(killed, "SIGKILL"); assert.match(receipt.output, /timed out after 60000ms/); }
  else { assert.equal(receipt.code, 0); assert.equal(receipt.output, "child output"); }
});
