/**
 * Opt-in TravelDesk live LLM smoke.
 *
 * This file is intentionally excluded from the default runtime E2E inventory.
 * Run with:
 *   RUN_LIVE_LLM_E2E=1 pnpm --filter @agent-platform/runtime test:live:llm
 */

import { describe, expect, it } from 'vitest';
import { resolve } from 'path';
import { config as dotenvConfig } from 'dotenv';

dotenvConfig({ path: resolve(__dirname, '../../.env') });

type LiveProvider = 'openai' | 'anthropic' | 'gemini';

const LIVE_LLM_E2E_ENABLED = process.env.RUN_LIVE_LLM_E2E === '1';
const LIVE_LLM_SKIP_REASON =
  'TravelDesk live LLM smoke skipped. Set RUN_LIVE_LLM_E2E=1 to validate vendor credentials.';
const liveDescribe = LIVE_LLM_E2E_ENABLED ? describe : describe.skip;

function resolveLiveProvider(): { provider: LiveProvider; apiKey: string } {
  const requestedProvider = process.env.LLM_PROVIDER;

  if (requestedProvider) {
    if (!isSupportedLiveProvider(requestedProvider)) {
      throw new Error(
        `RUN_LIVE_LLM_E2E=1 was set, but LLM_PROVIDER=${requestedProvider} is not supported by this smoke test.`,
      );
    }

    const apiKey = getApiKeyForProvider(requestedProvider);
    if (!apiKey) {
      throw new Error(
        `RUN_LIVE_LLM_E2E=1 was set, but no API key is configured for LLM_PROVIDER=${requestedProvider}.`,
      );
    }

    return { provider: requestedProvider, apiKey };
  }

  for (const provider of ['openai', 'anthropic', 'gemini'] as const) {
    const apiKey = getApiKeyForProvider(provider);
    if (apiKey) {
      return { provider, apiKey };
    }
  }

  throw new Error(
    'RUN_LIVE_LLM_E2E=1 was set, but no OPENAI_API_KEY, ANTHROPIC_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY is configured.',
  );
}

function isSupportedLiveProvider(provider: string): provider is LiveProvider {
  return provider === 'openai' || provider === 'anthropic' || provider === 'gemini';
}

function getApiKeyForProvider(provider: LiveProvider): string | undefined {
  if (provider === 'openai') {
    return process.env.OPENAI_API_KEY;
  }

  if (provider === 'anthropic') {
    return process.env.ANTHROPIC_API_KEY;
  }

  return process.env.GEMINI_API_KEY ?? process.env.GOOGLE_API_KEY;
}

async function validateProviderCredential(provider: LiveProvider, apiKey: string): Promise<void> {
  if (provider === 'openai') {
    await validateOpenAiCredential(apiKey);
    return;
  }

  if (provider === 'anthropic') {
    await validateAnthropicCredential(apiKey);
    return;
  }

  await validateGeminiCredential(apiKey);
}

async function validateOpenAiCredential(apiKey: string): Promise<void> {
  const response = await fetch('https://api.openai.com/v1/models', {
    headers: { Authorization: `Bearer ${apiKey}` },
  });

  if (!response.ok) {
    throw new Error(
      `OpenAI credential validation failed before TravelDesk live smoke: HTTP ${response.status}.`,
    );
  }
}

async function validateAnthropicCredential(apiKey: string): Promise<void> {
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'anthropic-version': '2023-06-01',
      'x-api-key': apiKey,
    },
    body: JSON.stringify({
      model: process.env.LIVE_LLM_MODEL ?? 'claude-haiku-4-5-20251001',
      max_tokens: 1,
      messages: [{ role: 'user', content: 'ok' }],
    }),
  });

  if (!response.ok) {
    throw new Error(
      `Anthropic credential validation failed before TravelDesk live smoke: HTTP ${response.status}.`,
    );
  }
}

async function validateGeminiCredential(apiKey: string): Promise<void> {
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`,
  );

  if (!response.ok) {
    throw new Error(
      `Gemini credential validation failed before TravelDesk live smoke: HTTP ${response.status}.`,
    );
  }
}

liveDescribe(LIVE_LLM_E2E_ENABLED ? 'TravelDesk live LLM smoke' : LIVE_LLM_SKIP_REASON, () => {
  it('validates credentials before any vendor-backed TravelDesk smoke coverage runs', async () => {
    const [{ readFileSync }, { compileToResolvedAgent }] = await Promise.all([
      import('fs'),
      import('../services/runtime-executor'),
    ]);
    const salesAgentDsl = readFileSync(
      resolve(__dirname, '../../../../examples/travel/agents/sales_agent.agent.abl'),
      'utf-8',
    );
    const resolved = compileToResolvedAgent([salesAgentDsl], 'Sales_Agent');
    expect(resolved.entryAgent).toBe('Sales_Agent');
    expect(resolved.agents.Sales_Agent).toBeDefined();

    const { provider, apiKey } = resolveLiveProvider();
    await validateProviderCredential(provider, apiKey);

    expect(provider).toMatch(/^(openai|anthropic|gemini)$/);
  }, 30_000);
});
