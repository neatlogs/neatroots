interface ResponseRequest {
  asResponse(): Promise<Response>;
  withResponse(): Promise<unknown>;
  _thenUnwrap<T>(transform: (data: unknown, props: unknown) => T): unknown;
}

/** Wait for guidance without assimilating the SDK promise or consuming its response body. */
export class SteeredRequest extends Promise<unknown> {
  private parsed?: Promise<unknown>;
  private readonly fallbackResponse = new Response(null);

  constructor(private readonly request: Promise<{ value: unknown }>) {
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

  _thenUnwrap<T>(transform: (data: unknown, props: unknown) => T): SteeredRequest {
    return new SteeredRequest(
      this.request.then(({ value }) => ({
        value:
          typeof (value as Partial<ResponseRequest>)?._thenUnwrap === "function"
            ? (value as ResponseRequest)._thenUnwrap(transform)
            : Promise.resolve(value).then((data) => transform(data, { response: this.fallbackResponse })),
      })),
    );
  }

  asResponse(): Promise<Response> {
    return this.request.then(({ value }) =>
      typeof (value as Partial<ResponseRequest>)?.asResponse === "function" ? (value as ResponseRequest).asResponse() : this.fallbackResponse,
    );
  }

  withResponse(): Promise<unknown> {
    return this.request.then(async ({ value }) =>
      typeof (value as Partial<ResponseRequest>)?.withResponse === "function"
        ? (value as ResponseRequest).withResponse()
        : { data: await value, response: this.fallbackResponse, request_id: null },
    );
  }
}
