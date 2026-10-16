interface ResponseRequest {
  asResponse(): Promise<Response>;
  withResponse(): Promise<unknown>;
}

/** Wait for guidance without assimilating the SDK promise or consuming its response body. */
export class SteeredRequest extends Promise<unknown> {
  private parsed?: Promise<unknown>;

  constructor(
    private readonly request: Promise<{ value: unknown }>,
    private readonly helpers?: ResponseRequest,
  ) {
    super((resolve) => resolve(undefined));
  }

  private parse(): Promise<unknown> {
    return (this.parsed ??= this.request.then(({ value }) => value));
  }

  override then<T = unknown, U = never>(
    fulfilled?: ((value: unknown) => T | PromiseLike<T>) | null,
    rejected?: ((reason: unknown) => U | PromiseLike<U>) | null,
  ): Promise<T | U> {
    return this.parse().then(fulfilled, rejected);
  }

  override catch<T = never>(rejected?: ((reason: unknown) => T | PromiseLike<T>) | null): Promise<unknown | T> {
    return this.parse().catch(rejected);
  }

  override finally(settled?: (() => void) | null): Promise<unknown> {
    return this.parse().finally(settled);
  }

  /** openai-node's create() calls this on its own promise; parse() helpers call it on the one create() returns. */
  _thenUnwrap<T>(transform: (value: unknown) => T | PromiseLike<T>): SteeredRequest {
    return new SteeredRequest(this.parse().then((value) => ({ value: transform(value) })), this);
  }

  asResponse(): Promise<Response> {
    if (this.helpers) return this.helpers.asResponse();
    return this.request.then(({ value }) => (value as ResponseRequest).asResponse());
  }

  withResponse(): Promise<unknown> {
    if (!this.helpers) return this.request.then(({ value }) => (value as ResponseRequest).withResponse());
    return this.helpers.withResponse().then(async (res) => {
      const data = await this.parse();
      return res && typeof res === "object" && "data" in res ? { ...(res as Record<string, unknown>), data } : res;
    });
  }
}
