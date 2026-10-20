/**
 * External LLM providers neatroots can use instead of the local LLM. Opt-in: when one is on,
 * the run content an LLM task needs (planning, questions, investigations, notes, summaries)
 * is sent to that provider. Rules, storage and the app stay on this machine.
 */

export type ProviderApi = "anthropic" | "openai";

export interface ProviderPreset {
  id: string;
  label: string;
  api: ProviderApi;
  /** Default base URL; "" means the user must give one. */
  baseUrl: string;
  /** Default model; "" means the user picks one (neatroots llm models lists them). */
  defaultModel: string;
  suggested: string[];
  /** Environment variables read for the key when none is stored. */
  keyEnv: string[];
  keyUrl: string;
  /** Whether the API returns token logprobs, which make decision probabilities calibrated. */
  logprobs: boolean;
}

export const PROVIDERS: ProviderPreset[] = [
  {
    id: "anthropic",
    label: "Anthropic (Claude)",
    api: "anthropic",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-opus-5-5",
    suggested: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
    keyEnv: ["ANTHROPIC_API_KEY"],
    keyUrl: "https://platform.claude.com",
    logprobs: false,
  },
  {
    id: "openai",
    label: "OpenAI",
    api: "openai",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "",
    suggested: [],
    keyEnv: ["OPENAI_API_KEY"],
    keyUrl: "https://platform.openai.com/api-keys",
    logprobs: true,
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    api: "openai",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "",
    suggested: [],
    keyEnv: ["OPENROUTER_API_KEY"],
    keyUrl: "https://openrouter.ai/keys",
    logprobs: false,
  },
  {
    id: "gemini",
    label: "Google Gemini",
    api: "openai",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    defaultModel: "",
    suggested: [],
    keyEnv: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyUrl: "https://aistudio.google.com/apikey",
    logprobs: false,
  },
  {
    id: "groq",
    label: "Groq",
    api: "openai",
    baseUrl: "https://api.groq.com/openai/v1",
    defaultModel: "",
    suggested: [],
    keyEnv: ["GROQ_API_KEY"],
    keyUrl: "https://console.groq.com/keys",
    logprobs: false,
  },
  {
    id: "mistral",
    label: "Mistral",
    api: "openai",
    baseUrl: "https://api.mistral.ai/v1",
    defaultModel: "",
    suggested: [],
    keyEnv: ["MISTRAL_API_KEY"],
    keyUrl: "https://console.mistral.ai/api-keys",
    logprobs: false,
  },
  {
    id: "together",
    label: "Together AI",
    api: "openai",
    baseUrl: "https://api.together.xyz/v1",
    defaultModel: "",
    suggested: [],
    keyEnv: ["TOGETHER_API_KEY"],
    keyUrl: "https://api.together.ai",
    logprobs: true,
  },
  {
    id: "custom",
    label: "Any OpenAI-compatible server",
    api: "openai",
    baseUrl: "",
    defaultModel: "",
    suggested: [],
    keyEnv: [],
    keyUrl: "",
    logprobs: false,
  },
];

export function providerById(id: string): ProviderPreset | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/** Keychain account name for a provider's key. */
export function llmKeyName(provider: string): `llm-api-key-${string}` {
  return `llm-api-key-${provider}`;
}

/** True when a base URL points at this machine. */
export function isLocalUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === "localhost" || h === "127.0.0.1" || h === "[::1]" || h === "::1" || h.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * Rewrites a JSON schema into the strict subset hosted structured-output APIs accept:
 * every object closed (additionalProperties: false) and no numeric or length constraints.
 * OpenAI's strict mode also needs every property listed as required.
 */
export function strictSchema(schema: Record<string, unknown>, opts: { allRequired?: boolean } = {}): Record<string, unknown> {
  const drop = new Set(["minItems", "maxItems", "minLength", "maxLength", "minimum", "maximum", "exclusiveMinimum", "exclusiveMaximum", "multipleOf"]);
  const walk = (node: unknown): unknown => {
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== "object") return node;
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
      if (drop.has(k)) continue;
      if (k === "properties" && v && typeof v === "object") {
        out.properties = Object.fromEntries(Object.entries(v as Record<string, unknown>).map(([pk, pv]) => [pk, walk(pv)]));
      } else if (k === "items" || k === "anyOf" || k === "allOf" || k === "$defs") {
        out[k] = walk(v);
      } else if (k !== "additionalProperties") {
        out[k] = v;
      }
    }
    if (out.type === "object") {
      const props = (out.properties as Record<string, unknown> | undefined) ?? {};
      out.properties = props;
      out.additionalProperties = false;
      out.required = opts.allRequired ? Object.keys(props) : ((out.required as string[] | undefined) ?? []).filter((r) => r in props);
    }
    return out;
  };
  return walk(schema) as Record<string, unknown>;
}
