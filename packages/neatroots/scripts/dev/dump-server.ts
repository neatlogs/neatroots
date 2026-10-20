// Dev aid: receive OTLP on a port and append decoded batches as JSON lines.
import http from "node:http";
import zlib from "node:zlib";
import fs from "node:fs";
import { decodeTraceProtobuf, decodeTraceJson, encodeTraceResponse } from "../../src/otlp/codec.js";

const port = Number(process.argv[2] ?? 4199);
const out = process.argv[3] ?? "dump.jsonl";
http
  .createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body = Buffer.concat(chunks);
      if (req.headers["content-encoding"] === "gzip") body = zlib.gunzipSync(body);
      const ct = String(req.headers["content-type"] ?? "");
      const rec: any = { method: req.method, url: req.url, headers: req.headers, ct, len: body.length };
      try {
        if (req.url?.startsWith("/v1/traces")) {
          rec.batches = ct.includes("json") ? decodeTraceJson(JSON.parse(body.toString())) : decodeTraceProtobuf(body);
        } else {
          rec.body = body.toString("utf8").slice(0, 2000);
        }
      } catch (e) {
        rec.error = String(e);
      }
      fs.appendFileSync(out, JSON.stringify(rec) + "\n");
      if (req.url?.startsWith("/v1/traces")) {
        res.writeHead(200, { "content-type": "application/x-protobuf" });
        res.end(Buffer.from(encodeTraceResponse()));
      } else {
        res.writeHead(404, { "content-type": "application/json" });
        res.end("{}");
      }
    });
  })
  .listen(port, "127.0.0.1", () => console.log(`dump server on ${port} -> ${out}`));
