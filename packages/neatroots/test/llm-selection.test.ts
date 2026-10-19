import http from "node:http";
import os from "node:os";
import type net from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultConfig } from "../src/config.js";
import { LlmClient } from "../src/models/llm.js";

interface OllamaModel {
  name: string;
  details?: { family?: string; parameter_size?: string };
}

const closers: (() => Promise<void>)[] = [];
afterEach(async () => {
  while (closers.length) await closers.pop()!();
  vi.restoreAllMocks();
});

async function localModels(models: string[], metadata?: OllamaModel[]) {
  const paths: string[] = [];
  const server = http.createServer((req, res) => {
    paths.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    if (req.url === "/v1/models") {
      res.end(JSON.stringify({ data: models.map((id) => ({ id })) }));
      return;
    }
    if (req.url === "/api/tags" && metadata !== undefined) {
      res.end(JSON.stringify({ models: metadata }));
      return;
    }
    res.statusCode = 404;
    res.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as net.AddressInfo).port;
  closers.push(() => new Promise((resolve) => server.close(() => resolve())));
  return { baseUrl: `http://127.0.0.1:${port}/v1`, paths };
}

async function probeAtMemory(totalGb: number, modelIds: string[], metadata?: OllamaModel[]) {
  vi.spyOn(os, "totalmem").mockReturnValue(totalGb * 1024 ** 3);
  const server = await localModels(modelIds, metadata);
  const config = defaultConfig().llm;
  config.baseUrl = server.baseUrl;
  config.model = "auto";
  return { result: await new LlmClient(config).probe(true), paths: server.paths };
}

const tag = (name: string, parameter_size: string, family?: string): OllamaModel => ({ name, details: { family, parameter_size } });

describe("local auto model selection", () => {
  it("matches an installed :latest alias only when local metadata confirms its preferred size", async () => {
    const metadata = [
      tag("pythia-160m:latest", "160M", "pythia"),
      tag("llama3.2:latest", "3.2B", "llama"),
    ];
    const forward = await probeAtMemory(24, ["pythia-160m:latest", "llama3.2:latest"], metadata);
    const reverse = await probeAtMemory(24, ["llama3.2:latest", "pythia-160m:latest"], [...metadata].reverse());

    expect(forward.result).toMatchObject({ ok: true, model: "llama3.2:latest" });
    expect(forward.paths).toContain("/api/tags");
    expect(reverse.result).toMatchObject({ ok: true, model: forward.result.model });
  });

  it("ranks a metadata-mismatched :latest alias below a valid preferred model", async () => {
    const { result } = await probeAtMemory(24, ["llama3.2:latest", "qwen3:4b"], [
      tag("llama3.2:latest", "1B", "llama"),
      tag("qwen3:4b", "4B", "qwen3"),
    ]);

    expect(result).toMatchObject({ ok: true, model: "qwen3:4b" });
    expect(result.model).not.toBe("llama3.2:latest");
  });

  it("uses the best supported preference within each hardware tier", async () => {
    const models = ["qwen3:14b", "qwen3:8b", "qwen3:4b", "pythia-160m:latest"];
    const metadata = [tag("qwen3:14b", "14.8B", "qwen3"), tag("qwen3:8b", "8.2B", "qwen3"), tag("qwen3:4b", "4B", "qwen3"), tag("pythia-160m:latest", "160M", "pythia")];

    await expect(probeAtMemory(8, models, metadata).then((x) => x.result.model)).resolves.toBe("qwen3:4b");
    await expect(probeAtMemory(24, models, metadata).then((x) => x.result.model)).resolves.toBe("qwen3:8b");
    await expect(probeAtMemory(48, models, metadata).then((x) => x.result.model)).resolves.toBe("qwen3:14b");
  });

  it("uses a supported smaller preferred model on a large host while capping oversized candidates", async () => {
    const { result } = await probeAtMemory(
      48,
      ["qwen3:32b", "llama3.2:3b"],
      [tag("qwen3:32b", "32B", "qwen3"), tag("llama3.2:3b", "3B", "llama")],
    );

    expect(result).toMatchObject({ ok: true, model: "llama3.2:3b" });
  });

  it("restricts metadata fallback to supported chat families and ignores inventory order", async () => {
    const chat = "qwen3:7b";
    const embedding = "nomic-embed-text:latest";
    const metadata = [tag(embedding, "8B", "nomic-bert"), tag(chat, "7B", "qwen3")];
    const forward = await probeAtMemory(24, [embedding, chat], metadata);
    const reverse = await probeAtMemory(24, [chat, embedding], [...metadata].reverse());

    expect(forward.result).toMatchObject({ ok: true, model: chat });
    expect(reverse.result).toMatchObject({ ok: true, model: chat });
  });

  it("returns explicit-model guidance for inventories without a supported chat model", async () => {
    const models = ["nomic-embed-text:latest", "unknown-14b:stable"];
    const metadata = [tag(models[0]!, "8B", "nomic-bert"), tag(models[1]!, "14B", "unknown")];
    const forward = await probeAtMemory(48, models, metadata);
    const reverse = await probeAtMemory(48, [...models].reverse(), [...metadata].reverse());

    expect(forward.result.ok).toBe(false);
    expect(forward.result.model).toBeUndefined();
    expect(forward.result.error).toMatch(/set llm\.model explicitly/i);
    expect(reverse.result).toMatchObject({ ok: false, error: forward.result.error });
  });

  it("does not report an embedding-only inventory as an installed chat model", async () => {
    const embedding = "nomic-embed-text:latest";
    const { result } = await probeAtMemory(24, [embedding], [tag(embedding, "8B", "nomic-bert")]);

    expect(result.ok).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.error).toMatch(/no chat model installed/i);
    expect(result.error).toMatch(/set llm\.model explicitly/i);
  });

  it("does not infer chat support for a :latest alias when metadata lookup fails", async () => {
    const { result, paths } = await probeAtMemory(48, ["llama3.2:latest"]);

    expect(paths).toContain("/api/tags");
    expect(result.ok).toBe(false);
    expect(result.model).toBeUndefined();
    expect(result.error).toMatch(/set llm\.model explicitly/i);
  });

  it("keeps the selected tier's preferred models ahead of lower-tier fallbacks", async () => {
    const { result } = await probeAtMemory(
      48,
      ["llama3.2:3b", "qwen3:14b"],
      [tag("llama3.2:3b", "3B", "llama"), tag("qwen3:14b", "14B", "qwen3")],
    );

    expect(result).toMatchObject({ ok: true, model: "qwen3:14b" });
  });

  it("chooses a stable metadata-sized fallback within a supported chat family regardless of list order", async () => {
    const metadata = [tag("qwen3:6b", "6B", "qwen3"), tag("qwen3:7b", "7B", "qwen3")];
    const forward = await probeAtMemory(24, ["qwen3:6b", "qwen3:7b"], metadata);
    const reverse = await probeAtMemory(24, ["qwen3:7b", "qwen3:6b"], [...metadata].reverse());

    expect(forward.result.model).toBe("qwen3:7b");
    expect(reverse.result.model).toBe(forward.result.model);
  });

  it("does not select an unknown model or the first model when metadata is absent", async () => {
    const { result } = await probeAtMemory(24, ["unknown-z:latest", "unknown-a:latest"]);

    expect(result.ok).toBe(false);
    expect(result.model).toBeUndefined();
    expect(result.error).toMatch(/set llm\.model explicitly/i);
  });

  it("reports an empty local model list without choosing a fallback", async () => {
    const { result } = await probeAtMemory(24, [], []);

    expect(result.ok).toBe(false);
    expect(result.model).toBeUndefined();
    expect(result.error).toMatch(/no chat model installed/i);
  });

  it("preserves an explicitly selected model even when it is absent from the installed list", async () => {
    const server = await localModels(["different-model"]);
    vi.spyOn(os, "totalmem").mockReturnValue(24 * 1024 ** 3);
    const config = defaultConfig().llm;
    config.baseUrl = server.baseUrl;
    config.model = "explicit-model";

    expect(await new LlmClient(config).probe(true)).toMatchObject({ ok: true, model: "explicit-model" });
  });

  it("still recognizes an installed canonical preference without Ollama metadata", async () => {
    const { result } = await probeAtMemory(24, ["llama3.2:3b"]);

    expect(result).toMatchObject({ ok: true, model: "llama3.2:3b" });
  });
});