import { StreamOutput } from "./stream-output.js";

/** The public neatlogs trace API; no provider internals or synthetic HTTP responses are used. */
export interface RequestTelemetry {
  trace<T>(options: { name: string; kind: "LLM"; input: unknown; attributes: Record<string, string | number | boolean> }, fn: (span: unknown) => T | Promise<T>): Promise<T>;
}
interface RawRequest extends PromiseLike<unknown> {
  asResponse(): Promise<Response>;
  withResponse(): Promise<{ data: unknown; response: Response; request_id?: string | null }>;
  _thenUnwrap(transform: (data: unknown, props: unknown) => unknown): RawRequest;
}
interface Span {
  setAttribute(key: string, value: string | number | boolean): unknown;
}
interface Lifetime {
  finish(value?: unknown): void;
  fail(error: unknown): void;
  observe(value: unknown): unknown;
  response(response: Response): void;
}

/** Observe consumption, not construction: asResponse must leave the original HTTP body unread. */
class TracedRequest implements PromiseLike<unknown> {
  constructor(private raw: RawRequest, private lifetime: Lifetime) {}
  then<TResult1 = unknown, TResult2 = never>(
    yes?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    no?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ): Promise<TResult1 | TResult2> {
    return Promise.resolve(this.raw).then(
      (value) => this.lifetime.observe(value),
      (error) => { this.lifetime.fail(error); throw error; },
    ).then(yes, no);
  }
  async asResponse(): Promise<Response> {
    try {
      const response = await this.raw.asResponse();
      this.lifetime.response(response);
      this.lifetime.finish();
      return response;
    } catch (error) { this.lifetime.fail(error); throw error; }
  }
  async withResponse(): Promise<{ data: unknown; response: Response; request_id?: string | null }> {
    try {
      const result = await this.raw.withResponse();
      this.lifetime.response(result.response);
      return { ...result, data: this.lifetime.observe(result.data) };
    } catch (error) { this.lifetime.fail(error); throw error; }
  }
  _thenUnwrap(transform: (data: unknown, props: unknown) => unknown): TracedRequest {
    return new TracedRequest(this.raw._thenUnwrap(transform), this.lifetime);
  }
}

export async function instrumentRequest(
  telemetry: RequestTelemetry, provider: string, path: string, input: Record<string, unknown>, invoke: () => unknown,
): Promise<{ value: unknown }> {
  let resolveRequest!: (value: { value: unknown }) => void;
  let rejectRequest!: (error: unknown) => void;
  const ready = new Promise<{ value: unknown }>((resolve, reject) => { resolveRequest = resolve; rejectRequest = reject; });
  let finish!: (value: unknown) => void;
  let fail!: (error: unknown) => void;
  const completed = new Promise<unknown>((resolve, reject) => { finish = resolve; fail = reject; });
  // This promise is deliberately observed even if provider construction throws.
  void completed.catch(() => undefined);
  let settled = false;
  let invoked = false;
  const start = (span?: unknown) => {
    if (invoked) return completed;
    invoked = true;
    const attribute = (key: string, value: string | number | boolean) => {
      try { (span as Span | undefined)?.setAttribute(key, value); }
      catch { /* Telemetry must not change the provider outcome. */ }
    };
    const streams = new WeakMap<object, AsyncIterable<unknown>>();
    const lifetime: Lifetime = {
      finish(value) { if (!settled) { settled = true; finish(value); } },
      fail(error) { if (!settled) { settled = true; fail(error); } },
      response(response) {
        attribute("http.response.status_code", response.status);
        const id = response.headers.get("x-request-id") ?? response.headers.get("request-id");
        if (id) attribute("neatlogs.llm.request_id", id);
      },
      observe(value) {
        if (value && typeof value === "object" && Symbol.asyncIterator in value) {
          let wrapped = streams.get(value);
          if (!wrapped) { wrapped = observeStream(value as AsyncIterable<unknown>, lifetime, attribute, provider); streams.set(value, wrapped); }
          return wrapped;
        }
        usage(value, attribute);
        lifetime.finish(value);
        return value;
      },
    };
    try { resolveRequest({ value: new TracedRequest(invoke() as RawRequest, lifetime) }); }
    catch (error) { rejectRequest(error); lifetime.fail(error); }
    return completed;
  };
  try {
    // The public SDK enters its span context and calls start synchronously. Keep
    // provider construction there; adapters that defer/omit it fall back below.
    void Promise.resolve(telemetry.trace({
      name: `${provider}.${path}`, kind: "LLM", input,
      attributes: {
        "neatlogs.llm.provider": provider,
        "neatlogs.llm.model_name": String(input.model ?? ""),
        "neatlogs.llm.is_streaming": input.stream === true,
      },
    }, start)).catch(() => undefined);
  } catch { /* A broken adapter cannot suppress the provider request. */ }
  start();
  return ready;
}

function usage(value: unknown, attribute: (key: string, value: number) => void): void {
  if (!value || typeof value !== "object") return;
  const record = value as Record<string, unknown>;
  const stats = (record.usage ?? (record.message as Record<string, unknown> | undefined)?.usage ?? (record.response as Record<string, unknown> | undefined)?.usage) as Record<string, unknown> | undefined;
  if (!stats) return;
  for (const [key, alternatives] of Object.entries({
    prompt: ["input_tokens", "prompt_tokens"], completion: ["output_tokens", "completion_tokens"], total: ["total_tokens"],
  })) {
    const count = alternatives.map((name) => stats[name]).find((v) => typeof v === "number");
    if (typeof count === "number") attribute(`neatlogs.llm.token_count.${key}`, count);
  }
}

/** Retain stream methods/controller, and end the span at EOF, cancellation or iteration failure. */
function observeStream(stream: AsyncIterable<unknown>, lifetime: Lifetime, attribute: (key: string, value: string | number | boolean) => void, provider: string): AsyncIterable<unknown> {
  const output = new StreamOutput(provider);
  let count = 0;
  let ended = false;
  const publish = () => {
    attribute("gen_ai.output.messages", JSON.stringify(output.output()));
    attribute("neatroots.stream.event_count", count);
  };
  const signal = (stream as { controller?: AbortController }).controller?.signal;
  const aborted = () => {
    ended = true;
    publish();
    attribute("neatroots.stream.termination", "cancelled");
    lifetime.fail(signal?.reason ?? new Error("Stream aborted"));
  };
  if (signal?.aborted) aborted();
  else signal?.addEventListener("abort", aborted, { once: true });
  return new Proxy(stream, {
    get(target, key, receiver) {
      if (key === Symbol.asyncIterator) return async function* () {
        try {
          for await (const item of target) {
            count++; output.add(item); usage(item, attribute); yield item;
          }
          ended = true;
          attribute("neatroots.stream.termination", "eof");
          lifetime.finish(output.output());
        } catch (error) {
          ended = true;
          publish(); attribute("neatroots.stream.termination", signal?.aborted ? "cancelled" : "error");
          lifetime.fail(error); throw error;
        } finally {
          signal?.removeEventListener("abort", aborted);
          if (!ended) attribute("neatroots.stream.termination", "closed");
          publish(); lifetime.finish(output.output());
        }
      };
      const value = Reflect.get(target, key, receiver);
      return typeof value === "function" ? value.bind(receiver) : value;
    },
  });
}
