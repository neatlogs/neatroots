/** Preferred models per memory tier, best first. Installed models are always preferred over downloads. */
export type MemoryTier = "large" | "medium" | "small";

export const TIER_PREFERENCES: Record<MemoryTier, string[]> = {
  large: ["qwen3:14b", "gemma4", "gemma3:12b", "qwen3:8b", "llama3.1:8b", "mistral-nemo"],
  medium: ["qwen3:8b", "gemma4", "llama3.1:8b", "gemma3:4b", "qwen3:4b", "llama3.2:3b"],
  small: ["qwen3:4b", "llama3.2:3b", "gemma3:4b", "qwen3:1.7b", "gemma3:1b"],
};

export interface LocalModelMetadata {
  name: string;
  parameterSize?: string;
}

// Auto selection keeps the configured tier's ranking, then considers lower-tier preferences.
// Tier size guidance is an upper capacity limit, not a minimum: a smaller supported chat model
// stays usable on a larger machine. Ceilings use the largest rounded preference tag per tier: 4B small, 8B medium, 14B large.
// 10% tolerance accounts for providers reporting exact sizes just above rounded model tags.
//
// /api/tags parameter_size describes size, not chat capability. Unknown model families therefore
// cannot qualify through size alone. Only chat families represented in TIER_PREFERENCES can use
// metadata-sized fallback. When optional metadata is unavailable, only exact, size-tagged
// preferences can be selected; otherwise callers receive explicit-model guidance.
const TIER_CAPACITY_BILLIONS: Record<MemoryTier, number> = {
  small: 4,
  medium: 8,
  large: 14,
};
const SIZE_TOLERANCE = 0.1;
const ORDERED_TIERS: MemoryTier[] = ["large", "medium", "small"];

function parameterSizeInBillions(value?: string): number | undefined {
  const match = value?.trim().match(/^(\d+(?:\.\d+)?)\s*([KMGT]?B|[KMGT])?$/i);
  if (!match) return undefined;
  const size = Number(match[1]);
  if (!Number.isFinite(size) || size <= 0) return undefined;
  const unit = (match[2] ?? "B").toUpperCase().replace(/B$/, "");
  const scale = unit === "T" ? 1_000 : unit === "G" || unit === "B" ? 1 : unit === "M" ? 0.001 : unit === "K" ? 0.000001 : 1;
  return size * scale;
}

function normalizedModelName(value: string): string {
  return value.trim().replace(/^models\//i, "").toLowerCase();
}

function modelFamilyName(value: string): string {
  const normalized = normalizedModelName(value);
  const tag = normalized.lastIndexOf(":");
  return tag < 0 ? normalized : normalized.slice(0, tag);
}

const SUPPORTED_CHAT_FAMILIES = new Set(
  Object.values(TIER_PREFERENCES).flatMap((preferences) => preferences.map(modelFamilyName)),
);

function metadataForModel(modelId: string, metadata: LocalModelMetadata[]): LocalModelMetadata | undefined {
  const normalized = normalizedModelName(modelId);
  const exact = metadata.filter((entry) => normalizedModelName(entry.name) === normalized);
  if (exact.length === 1) return exact[0];
  if (exact.length > 1) return undefined;
  const withoutLatest = normalized.replace(/:latest$/, "");
  const aliases = metadata.filter((entry) => normalizedModelName(entry.name).replace(/:latest$/, "") === withoutLatest);
  return aliases.length === 1 ? aliases[0] : undefined;
}

function modelSize(modelId: string, metadata: LocalModelMetadata[]): number | undefined {
  return parameterSizeInBillions(metadataForModel(modelId, metadata)?.parameterSize);
}

function preferenceSize(preference: string): number | undefined {
  const tag = preference.slice(preference.lastIndexOf(":") + 1);
  const match = tag.match(/^(\d+(?:\.\d+)?\s*[KMGT]?B)/i);
  return match ? parameterSizeInBillions(match[1]) : undefined;
}

function withinCapacity(size: number, tier: MemoryTier): boolean {
  return size <= TIER_CAPACITY_BILLIONS[tier] * (1 + SIZE_TOLERANCE);
}

function samePreferredSize(actual: number, preferred: number): boolean {
  return Math.abs(actual - preferred) <= preferred * SIZE_TOLERANCE;
}

function compareModelIds(a: string, b: string): number {
  const left = normalizedModelName(a);
  const right = normalizedModelName(b);
  return left < right ? -1 : left > right ? 1 : a < b ? -1 : a > b ? 1 : 0;
}

function preferencesForTier(tier: MemoryTier): string[] {
  const tierIndex = ORDERED_TIERS.indexOf(tier);
  const seen = new Set<string>();
  return ORDERED_TIERS.slice(tierIndex)
    .flatMap((candidateTier) => TIER_PREFERENCES[candidateTier])
    .filter((preference) => {
      const normalized = normalizedModelName(preference);
      if (seen.has(normalized)) return false;
      seen.add(normalized);
      return true;
    });
}

/** Pick ranked preferences first, then the largest known chat-family variant that fits capacity. */
export function selectLocalModel(tier: MemoryTier, models: string[], metadata: LocalModelMetadata[]): string | undefined {
  const preferences = preferencesForTier(tier);
  for (const preference of preferences) {
    const preferredFamily = modelFamilyName(preference);
    const preferredSize = preferenceSize(preference);
    const matches = models.filter((modelId) => {
      const normalized = normalizedModelName(modelId);
      const exact = normalized === normalizedModelName(preference);
      const family = modelFamilyName(modelId);
      if (family !== preferredFamily || !SUPPORTED_CHAT_FAMILIES.has(family)) return false;

      const reportedSize = modelSize(modelId, metadata);
      const size = reportedSize ?? (exact ? preferredSize : undefined);
      if (size === undefined || !withinCapacity(size, tier)) return false;
      if (exact) return preferredSize === undefined || samePreferredSize(size, preferredSize);
      return preferredSize === undefined || samePreferredSize(size, preferredSize);
    });
    matches.sort((a, b) => {
      const aExact = normalizedModelName(a) === normalizedModelName(preference);
      const bExact = normalizedModelName(b) === normalizedModelName(preference);
      return Number(bExact) - Number(aExact) || compareModelIds(a, b);
    });
    if (matches.length) return matches[0];
  }

  return models
    .map((modelId) => ({ modelId, family: modelFamilyName(modelId), size: modelSize(modelId, metadata) }))
    .filter((candidate): candidate is { modelId: string; family: string; size: number } =>
      SUPPORTED_CHAT_FAMILIES.has(candidate.family) &&
      candidate.size !== undefined &&
      withinCapacity(candidate.size, tier))
    .sort((a, b) => b.size - a.size || compareModelIds(a.modelId, b.modelId))[0]?.modelId;
}
