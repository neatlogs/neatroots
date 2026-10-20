// Copies the built app UI into dist/ui so the published package serves it.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const src = path.resolve(here, "../../ui/dist");
const dest = path.resolve(here, "../dist/ui");
if (!fs.existsSync(path.join(src, "index.html"))) {
  console.warn("[neatroots] UI not built (packages/ui/dist missing); the server will show a placeholder page");
  process.exit(0);
}
fs.rmSync(dest, { recursive: true, force: true });
fs.cpSync(src, dest, { recursive: true });
console.log(`[neatroots] copied UI to ${path.relative(process.cwd(), dest)}`);
