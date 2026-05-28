export interface ModelDisplayIdentity {
  id?: string | null;
  name?: string | null;
  displayName?: string | null;
  modelId?: string | null;
  provider?: string | null;
}

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: 'Anthropic',
  azure: 'Azure OpenAI',
  bedrock: 'AWS Bedrock',
  cohere: 'Cohere',
  custom: 'Custom',
  deepseek: 'DeepSeek',
  fireworks: 'Fireworks',
  gemini: 'Gemini',
  google: 'Google AI',
  google_vertex: 'Vertex AI',
  groq: 'Groq',
  microsoft_foundry_anthropic: 'Microsoft Foundry Anthropic',
  mistral: 'Mistral AI',
  openai: 'OpenAI',
  openrouter: 'OpenRouter',
  perplexity: 'Perplexity',
  togetherai: 'Together AI',
  ultravox: 'Ultravox',
  xai: 'xAI',
};

function nonEmpty(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

export function getProviderDisplayName(provider: string | null | undefined): string | null {
  const normalized = nonEmpty(provider)?.toLowerCase();
  if (!normalized) return null;
  return PROVIDER_LABELS[normalized] ?? normalized;
}

export function getModelPrimaryName(model: ModelDisplayIdentity): string {
  return (
    nonEmpty(model.displayName) ??
    nonEmpty(model.name) ??
    nonEmpty(model.modelId) ??
    model.id ??
    'Unknown model'
  );
}

export function getCanonicalModelId(model: ModelDisplayIdentity): string | null {
  return nonEmpty(model.modelId);
}

export function formatModelOptionLabel(model: ModelDisplayIdentity): string {
  const primary = getModelPrimaryName(model);
  const provider = getProviderDisplayName(model.provider);
  const modelId = getCanonicalModelId(model);
  const details = [provider, modelId].filter(
    (part): part is string => Boolean(part) && part !== primary,
  );

  return details.length > 0 ? `${primary} · ${details.join(' · ')}` : primary;
}

export function formatModelIdentityLine(model: ModelDisplayIdentity): string {
  const provider = getProviderDisplayName(model.provider);
  const modelId = getCanonicalModelId(model);
  return [provider, modelId].filter(Boolean).join(' · ');
}
