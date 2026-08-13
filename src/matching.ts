import type { CpaModel } from "./cpa.ts";
import type { ModelsDevCatalog, ModelsDevMetadata } from "./types.ts";

// Vendors that the CLIProxyAPI gateway reports in `owned_by` do not match the
// canonical models.dev provider prefixes. Map the gateway owners we recognise
// to the models.dev provider so owner-based matching can resolve them.
const OWNER_TO_VENDOR: Record<string, string> = {
  antigravity: "google",
  commandcode: "deepseek",
  madewgn: "deepseek",
  sekai: "deepseek",
  zenmux: "zhipuai",
  routeforme: "deepseek",
  claudecode: "anthropic",
};

// Gateway model ids are sometimes prefixed with a vendor/route slug
// (e.g. "ds/deepseek-v4-flash", "route/deepseek-v4-pro"). Strip a leading
// "<slug>/" so the bare model id can match models.dev via suffix.
function stripGatewayPrefix(id: string): string {
  const idx = id.indexOf("/");
  if (idx <= 0 || idx === id.length - 1) return id;
  return id.slice(idx + 1);
}

const CANONICAL_OWNER_PREFIXES: Record<string, string> = {
  openai: "openai",
  anthropic: "anthropic",
  google: "google",
  deepseek: "deepseek",
  mistral: "mistral",
  xai: "xai",
  zhipuai: "zhipuai",
  alibaba: "alibaba",
  moonshotai: "moonshotai",
  minimax: "minimax",
  nvidia: "nvidia",
  cohere: "cohere",
};

export type MetadataMatchMethod = "alias" | "exact" | "owner-prefix" | "owner-hint" | "suffix" | "normalized-suffix" | "provider-fallback";

export interface MetadataMatch {
  metadataId: string;
  metadata: ModelsDevMetadata;
  method: MetadataMatchMethod;
}

export function normalizeModelName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

// Aggressive normalization that drops gateway-specific decoration so that
// non-standard labels map to the canonical models.dev id by context.
// Tokenizes, drops noise words (free/agent/preview), 4-digit dates and the
// "extra-" tier prefix, then de-duplicates repeated tokens (e.g. a label like
// "DeepSeek: DeepSeek V4 Flash" repeats the vendor). Tier/family words
// (low/medium/high/lite/pro/max/flash/opus) are kept so variants stay distinct.
function fuzzyNormalize(value: string): string {
  const NOISE = new Set(["free", "agent", "preview", "extra"]);
  const tokens = value
    .toLowerCase()
    .replace(/[():]/g, " ")
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .filter((t) => !NOISE.has(t))
    .filter((t) => !/^\d{4}$/.test(t)); // 4-digit dates like 0731
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const t of tokens) {
    if (seen.has(t)) continue;
    seen.add(t);
    deduped.push(t);
  }
  return deduped.join("");
}

function metadataModelName(metadataId: string, metadata: ModelsDevMetadata): string {
  return metadata.id.split("/").at(-1) ?? metadataId.split("/").at(-1) ?? metadataId;
}

function oneMatch(candidates: string[]): string | undefined {
  const unique = [...new Set(candidates)];
  return unique.length === 1 ? unique[0] : undefined;
}

function identifierTokens(value: string): string[] {
  return value.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
}

function containsContiguousTokens(container: string[], sequence: string[]): boolean {
  if (sequence.length === 0 || sequence.length > container.length) return false;
  return container.some((_, start) =>
    start + sequence.length <= container.length &&
    sequence.every((token, offset) => container[start + offset] === token)
  );
}

function sourceProvider(metadataId: string, metadata: ModelsDevMetadata): string {
  // sourceProvider is retained by current catalog snapshots. The prefix fallback
  // keeps older bundled/cache snapshots useful until they are refreshed.
  return metadata.sourceProvider ?? metadataId.split("/")[0] ?? metadataId;
}

function ownerHintMatch(
  owner: string | undefined,
  candidates: string[],
  catalog: ModelsDevCatalog,
): string | undefined {
  if (!owner) return undefined;
  const ownerTokens = identifierTokens(owner);
  const matches = candidates.flatMap((metadataId) => {
    const metadata = catalog[metadataId];
    if (!metadata) return [];
    const provider = sourceProvider(metadataId, metadata);
    const providerTokens = identifierTokens(provider);
    if (!containsContiguousTokens(ownerTokens, providerTokens)) return [];
    return [{ metadataId, tokenCount: providerTokens.length, characterCount: provider.length }];
  });
  if (matches.length === 0) return undefined;

  const bestTokenCount = Math.max(...matches.map((match) => match.tokenCount));
  const mostTokens = matches.filter((match) => match.tokenCount === bestTokenCount);
  const bestCharacterCount = Math.max(...mostTokens.map((match) => match.characterCount));
  return oneMatch(
    mostTokens
      .filter((match) => match.characterCount === bestCharacterCount)
      .map((match) => match.metadataId),
  );
}

export function findMetadataMatch(
  cpaModel: Pick<CpaModel, "id" | "owned_by">,
  catalog: ModelsDevCatalog,
  aliases: Record<string, string>,
  fallbackProvider?: string | null,
): MetadataMatch | undefined {
  const alias = aliases[cpaModel.id];
  if (alias && catalog[alias]) {
    return { metadataId: alias, metadata: catalog[alias], method: "alias" };
  }

  if (catalog[cpaModel.id]) {
    return { metadataId: cpaModel.id, metadata: catalog[cpaModel.id], method: "exact" };
  }

  const catalogKeys = Object.keys(catalog);
  const exactMetadataCandidates = catalogKeys.filter((key) => catalog[key]?.id === cpaModel.id);
  const exactMetadataKey = oneMatch(exactMetadataCandidates);
  if (exactMetadataKey) {
    return { metadataId: exactMetadataKey, metadata: catalog[exactMetadataKey], method: "exact" };
  }

  const suffixCandidates = catalogKeys.filter((key) =>
    metadataModelName(key, catalog[key]) === cpaModel.id
  );
  const normalizedId = normalizeModelName(cpaModel.id);
  const normalizedSuffixCandidates = catalogKeys.filter(
    (key) => normalizeModelName(metadataModelName(key, catalog[key])) === normalizedId,
  );
  const owner = cpaModel.owned_by?.trim().toLowerCase();
  const canonicalOwner = owner ? (CANONICAL_OWNER_PREFIXES[owner] ?? OWNER_TO_VENDOR[owner]) : undefined;
  if (canonicalOwner) {
    const ownerKey = `${canonicalOwner}/${cpaModel.id}`;
    if (catalog[ownerKey]) {
      return { metadataId: ownerKey, metadata: catalog[ownerKey], method: "owner-prefix" };
    }
  }

  const hintedKey = ownerHintMatch(owner, normalizedSuffixCandidates, catalog);
  if (hintedKey) {
    return { metadataId: hintedKey, metadata: catalog[hintedKey], method: "owner-hint" };
  }

  const suffixKey = oneMatch(suffixCandidates);
  if (suffixKey) {
    return { metadataId: suffixKey, metadata: catalog[suffixKey], method: "suffix" };
  }

  const normalizedSuffixKey = oneMatch(normalizedSuffixCandidates);
  if (normalizedSuffixKey) {
    return { metadataId: normalizedSuffixKey, metadata: catalog[normalizedSuffixKey], method: "normalized-suffix" };
  }

  // Gateway-prefixed ids (e.g. "ds/deepseek-v4-flash"): strip the slug and retry
  // suffix matching against the bare model id.
  const bareId = stripGatewayPrefix(cpaModel.id);
  if (bareId !== cpaModel.id) {
    const bareSuffixCandidates = catalogKeys.filter(
      (key) => metadataModelName(key, catalog[key]) === bareId,
    );
    const bareKey = oneMatch(bareSuffixCandidates);
    if (bareKey) {
      return { metadataId: bareKey, metadata: catalog[bareKey], method: "suffix" };
    }
    const bareNormalized = normalizeModelName(bareId);
    const bareNormCandidates = catalogKeys.filter(
      (key) => normalizeModelName(metadataModelName(key, catalog[key])) === bareNormalized,
    );
    const bareNormKey = oneMatch(bareNormCandidates);
    if (bareNormKey) {
      return { metadataId: bareNormKey, metadata: catalog[bareNormKey], method: "normalized-suffix" };
    }
    if (fallbackProvider) {
      const normalizedFallbackProvider = fallbackProvider.trim().toLowerCase();
      const fbKey = oneMatch(bareNormCandidates.filter((metadataId) => {
        const metadata = catalog[metadataId];
        return metadata && sourceProvider(metadataId, metadata).toLowerCase() === normalizedFallbackProvider;
      }));
      if (fbKey) {
        return { metadataId: fbKey, metadata: catalog[fbKey], method: "provider-fallback" };
      }
    }
  }

  // Fuzzy match: strip gateway-specific decoration (free/agent/preview/dates)
  // and compare the bare context. Catches labels like
  // "DeepSeek: DeepSeek V4 Flash 0731 (Free)" -> deepseek/deepseek-v4-flash.
  const fuzzyId = fuzzyNormalize(cpaModel.id);
  if (fuzzyId) {
    let fuzzyCandidates = catalogKeys.filter(
      (key) => fuzzyNormalize(metadataModelName(key, catalog[key])) === fuzzyId,
    );
    // Disambiguate: prefer official vendor entries (vendor/model, vendor in the
    // canonical list, no nested path and no dated variant) over aggregator or
    // dated entries (anyapi/deepseek/..., alibaba/deepseek-v4-flash-0731).
    const official = fuzzyCandidates.filter((key) => {
      const parts = key.split("/");
      const vendor = parts[0];
      return vendor in CANONICAL_OWNER_PREFIXES && parts.length === 2 && !/\d{4}/.test(key);
    });
    if (official.length >= 1) fuzzyCandidates = official;
    const fuzzyKey = oneMatch(fuzzyCandidates);
    if (fuzzyKey) {
      return { metadataId: fuzzyKey, metadata: catalog[fuzzyKey], method: "normalized-suffix" };
    }
    if (fallbackProvider) {
      const normalizedFallbackProvider = fallbackProvider.trim().toLowerCase();
      const fbKey = oneMatch(fuzzyCandidates.filter((metadataId) => {
        const metadata = catalog[metadataId];
        return metadata && sourceProvider(metadataId, metadata).toLowerCase() === normalizedFallbackProvider;
      }));
      if (fbKey) {
        return { metadataId: fbKey, metadata: catalog[fbKey], method: "provider-fallback" };
      }
    }
  }

  if (fallbackProvider) {
    const normalizedFallbackProvider = fallbackProvider.trim().toLowerCase();
    const fallbackKey = oneMatch(normalizedSuffixCandidates.filter((metadataId) => {
      const metadata = catalog[metadataId];
      return metadata && sourceProvider(metadataId, metadata).toLowerCase() === normalizedFallbackProvider;
    }));
    if (fallbackKey) {
      return { metadataId: fallbackKey, metadata: catalog[fallbackKey], method: "provider-fallback" };
    }
  }

  return undefined;
}
