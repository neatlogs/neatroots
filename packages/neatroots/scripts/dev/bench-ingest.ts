// Dev aid: ingest a long run in batches and time it, with the engine on.
import { Roots } from "../../src/core.js";
import { defaultConfig } from "../../src/config.js";
import { batch, hex, llmSpan, tmpHome, toolSpan } from "../../test/helpers.js";

const cfg = defaultConfig();
cfg.llm.enabled = false;
cfg.classifier.laya.enabled = false;
cfg.classifier.backend = "llm";
const roots = new Roots({ home: tmpHome(), config: cfg });
const t = hex(16);
const root = hex(8);
const started = Date.now();
for (let i = 0; i < 200; i++) {
  roots.ingest([batch([llmSpan(t, root, { user: `step ${i}`, out: `thinking ${i}`, tools: ["lookup"] }), toolSpan(t, root, "lookup", JSON.stringify({ i }), JSON.stringify({ ok: i }))])]);
}
await roots.engine!.waitIdle(t, 30_000);
console.log(`400 spans in 200 batches with rules: ${Date.now() - started} ms; findings: ${roots.store.findingsForTrace(t).map((f) => f.check_id).join(", ")}`);
roots.close();
