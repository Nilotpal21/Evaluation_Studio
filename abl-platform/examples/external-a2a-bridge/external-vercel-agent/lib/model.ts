import { createAnthropic } from '@ai-sdk/anthropic';
import { createGoogleGenerativeAI } from '@ai-sdk/google';
import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModel } from 'ai';

type HostedAgentProvider = 'anthropic' | 'openai' | 'google';

export interface HostedAgentModelChoice {
  provider: HostedAgentProvider;
  modelId: string;
  model: LanguageModel;
}

const DEFAULT_PROVIDER_ORDER: HostedAgentProvider[] = ['anthropic', 'openai', 'google'];

function readEnv(name: string): string | null {
  const value = process.env[name]?.trim();
  return value || null;
}

function isHostedAgentProvider(value: string): value is HostedAgentProvider {
  return DEFAULT_PROVIDER_ORDER.includes(value as HostedAgentProvider);
}

function resolveRequestedProviderOrder(): HostedAgentProvider[] {
  const configured =
    readEnv('HOSTED_AGENT_PROVIDER') || readEnv('HOSTED_AGENT_PROVIDER_ORDER') || 'auto';

  if (configured === 'auto') {
    return DEFAULT_PROVIDER_ORDER;
  }

  const requestedProviders = configured
    .split(',')
    .map((part) => part.trim().toLowerCase())
    .filter((part): part is HostedAgentProvider => isHostedAgentProvider(part));

  return requestedProviders.length > 0 ? requestedProviders : DEFAULT_PROVIDER_ORDER;
}

function buildAnthropicChoice(): HostedAgentModelChoice | null {
  const anthropicApiKey = readEnv('ANTHROPIC_API_KEY');
  if (!anthropicApiKey) {
    return null;
  }

  const modelId =
    readEnv('ANTHROPIC_MODEL') ||
    readEnv('CLAUDE_MODEL') ||
    readEnv('ANTHROPIC_DEFAULT_MODEL') ||
    'claude-sonnet-4-6';
  const anthropic = createAnthropic({ apiKey: anthropicApiKey });
  return {
    provider: 'anthropic',
    modelId,
    model: anthropic(modelId),
  };
}

function buildOpenAIChoice(): HostedAgentModelChoice | null {
  const openAiApiKey = readEnv('OPENAI_API_KEY');
  if (!openAiApiKey) {
    return null;
  }

  const modelId = readEnv('OPENAI_MODEL') || readEnv('OPENAI_DEFAULT_MODEL') || 'gpt-4o-mini';
  const openai = createOpenAI({ apiKey: openAiApiKey });
  return {
    provider: 'openai',
    modelId,
    model: openai(modelId),
  };
}

function buildGoogleChoice(): HostedAgentModelChoice | null {
  const googleApiKey =
    readEnv('GOOGLE_GENERATIVE_AI_API_KEY') ||
    readEnv('GEMINI_API_KEY') ||
    readEnv('GOOGLE_API_KEY');
  if (!googleApiKey) {
    return null;
  }

  const modelId = readEnv('GOOGLE_MODEL') || readEnv('GEMINI_MODEL') || 'gemini-2.5-flash';
  const google = createGoogleGenerativeAI({ apiKey: googleApiKey });
  return {
    provider: 'google',
    modelId,
    model: google(modelId),
  };
}

function buildModelChoice(provider: HostedAgentProvider): HostedAgentModelChoice | null {
  switch (provider) {
    case 'anthropic':
      return buildAnthropicChoice();
    case 'openai':
      return buildOpenAIChoice();
    case 'google':
      return buildGoogleChoice();
  }
}

export function resolveHostedAgentModels(): HostedAgentModelChoice[] {
  const choices = resolveRequestedProviderOrder()
    .map((provider) => buildModelChoice(provider))
    .filter((choice): choice is HostedAgentModelChoice => choice !== null);

  if (choices.length === 0) {
    throw new Error(
      'Hosted bridge agent requires ANTHROPIC_API_KEY, OPENAI_API_KEY, or GOOGLE_GENERATIVE_AI_API_KEY / GEMINI_API_KEY / GOOGLE_API_KEY',
    );
  }

  return choices;
}
