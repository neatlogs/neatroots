import type { ResourceSpansBatch } from "../../otlp/types.js";

/** A credential or option an import source asks for. */
export interface ImportField {
  name: string;
  label: string;
  /** Kept out of logs and job status. */
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  /** Environment variable the CLI reads it from when the flag is missing. */
  env?: string;
  default?: string;
}

export interface ImportOptions {
  /** Credentials and options, by ImportField name. */
  values: Record<string, string>;
  /** Earliest trace start to import (ms). */
  sinceMs: number;
  untilMs: number;
  /** Most traces to import. */
  limit: number;
  /** Local project name for the runs; defaults to the source's own project or name. */
  project?: string;
  signal: AbortSignal;
  /** The local run a source trace must not replace (one captured here), so it isn't downloaded. */
  kept?: (sourceId: string) => string | undefined;
}

/** One trace, ready to ingest. */
export interface ImportedTrace {
  sourceId: string;
  batches: ResourceSpansBatch[];
  /** Set when this one trace couldn't be read; the import counts it as failed and carries on. */
  error?: string;
  /** The local run this trace already is; it isn't imported over it. */
  kept?: string;
}

export interface ImportSource {
  id: string;
  label: string;
  /** One line on where the data comes from. */
  description: string;
  fields: ImportField[];
  /** Yields traces one at a time, so a long import stores as it goes and can be cancelled. */
  traces(opts: ImportOptions): AsyncGenerator<ImportedTrace>;
}

export class ImportError extends Error {}

/** fetch with a timeout, the abort signal, and a readable error that never echoes credentials. */
export async function getJson<T>(url: string, init: RequestInit & { signal: AbortSignal; timeoutMs?: number }): Promise<T> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? 30_000);
  const res = await fetch(url, { ...init, signal: AbortSignal.any([init.signal, timeout]) });
  const text = await res.text();
  if (!res.ok) {
    const short = text.replace(/\s+/g, " ").slice(0, 300);
    throw new ImportError(`${new URL(url).host} answered ${res.status}${short ? `: ${short}` : ""}`);
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ImportError(`${new URL(url).host} did not return JSON`);
  }
}

export const iso = (ms: number) => new Date(ms).toISOString();

export { trimSlash } from "../../util/url.js";
