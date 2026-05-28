/**
 * Canonical LLM provider identity helpers.
 *
 * Provider names arrive from multiple systems: model registries, tenant policy,
 * credentials, LiteLLM model IDs, and provider SDKs. Keep equivalence rules here
 * so policy checks do not grow local string aliases that drift apart.
 */

export const DEFAULT_LLM_ALLOWED_PROVIDERS = [
  'anthropic',
  'openai',
  'gemini',
  'google',
  'azure',
] as const;

export type DefaultLlmAllowedProvider = (typeof DEFAULT_LLM_ALLOWED_PROVIDERS)[number];

export interface LlmProviderIdentity {
  canonical: string;
  policyAliases: readonly string[];
  displayName: string;
}

export const LLM_PROVIDER_IDENTITIES = [
  {
    canonical: 'anthropic',
    policyAliases: ['anthropic'],
    displayName: 'Anthropic',
  },
  {
    canonical: 'openai',
    policyAliases: ['openai'],
    displayName: 'OpenAI',
  },
  {
    canonical: 'google',
    policyAliases: ['google', 'gemini'],
    displayName: 'Google Gemini',
  },
  {
    canonical: 'azure',
    policyAliases: ['azure'],
    displayName: 'Azure OpenAI',
  },
  {
    canonical: 'bedrock',
    policyAliases: ['bedrock', 'aws-bedrock', 'aws_bedrock'],
    displayName: 'Amazon Bedrock',
  },
] as const satisfies readonly LlmProviderIdentity[];

const PROVIDER_ALIAS_TO_CANONICAL = new Map<string, string>(
  LLM_PROVIDER_IDENTITIES.flatMap((identity) =>
    identity.policyAliases.map((alias) => [normalizeLlmProviderName(alias), identity.canonical]),
  ),
);

const PROVIDER_CANONICAL_TO_ALIASES = new Map<string, readonly string[]>(
  LLM_PROVIDER_IDENTITIES.map((identity) => [identity.canonical, identity.policyAliases]),
);

export function normalizeLlmProviderName(provider: string): string {
  return provider.trim().toLowerCase();
}

export function canonicalizeLlmProviderName(provider: string): string {
  const normalized = normalizeLlmProviderName(provider);
  return PROVIDER_ALIAS_TO_CANONICAL.get(normalized) ?? normalized;
}

export function areLlmProvidersPolicyEquivalent(
  allowedProvider: string,
  resolvedProvider: string,
): boolean {
  return (
    canonicalizeLlmProviderName(allowedProvider) === canonicalizeLlmProviderName(resolvedProvider)
  );
}

export function getLlmProviderPolicyAliases(provider: string): string[] {
  const normalizedProvider = normalizeLlmProviderName(provider);
  const canonical = canonicalizeLlmProviderName(provider);
  const aliases = PROVIDER_CANONICAL_TO_ALIASES.get(canonical) ?? [normalizedProvider];
  return Array.from(new Set([...aliases, normalizedProvider].map(normalizeLlmProviderName)));
}

export function isLlmProviderAllowed(
  allowedProviders: readonly string[] | undefined,
  resolvedProvider: string,
): boolean {
  if (!allowedProviders || allowedProviders.length === 0) {
    return true;
  }

  return allowedProviders.some((allowedProvider) =>
    areLlmProvidersPolicyEquivalent(allowedProvider, resolvedProvider),
  );
}

export function isLegacyDefaultLlmAllowedProviders(
  allowedProviders: readonly string[] | undefined,
): boolean {
  if (!allowedProviders) {
    return false;
  }

  const normalized = new Set(allowedProviders.map(normalizeLlmProviderName));
  return (
    normalized.size === 3 &&
    normalized.has('anthropic') &&
    normalized.has('openai') &&
    normalized.has('gemini')
  );
}

export function mergeDefaultLlmAllowedProviders(
  allowedProviders: readonly string[] | undefined,
): string[] {
  if (!allowedProviders || isLegacyDefaultLlmAllowedProviders(allowedProviders)) {
    return [...DEFAULT_LLM_ALLOWED_PROVIDERS];
  }

  return [...allowedProviders];
}
