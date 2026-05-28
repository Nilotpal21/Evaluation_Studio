#!/usr/bin/env tsx
/**
 * List all models from LLM providers at runtime
 *
 * Usage:
 *   ANTHROPIC_API_KEY=sk-... tsx scripts/list-provider-models.ts anthropic
 *   OPENAI_API_KEY=sk-... tsx scripts/list-provider-models.ts openai
 *   GOOGLE_API_KEY=... tsx scripts/list-provider-models.ts google
 */

import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import { createGoogleGenerativeAI } from '@ai-sdk/google';

async function listOpenAIModels(apiKey: string) {
  console.log('📦 Fetching OpenAI models...\n');

  const response = await fetch('https://api.openai.com/v1/models', {
    headers: {
      Authorization: `Bearer ${apiKey}`,
    },
  });

  const data = await response.json();
  const models = data.data
    .filter((m: any) => m.id.startsWith('gpt-') || m.id.startsWith('o1') || m.id.startsWith('o3'))
    .sort((a: any, b: any) => a.id.localeCompare(b.id));

  console.log(`Found ${models.length} OpenAI chat models:\n`);
  models.forEach((m: any) => {
    console.log(`  - ${m.id} (created: ${new Date(m.created * 1000).toISOString().split('T')[0]})`);
  });
}

async function listGoogleModels(apiKey: string) {
  console.log('📦 Fetching Google Gemini models...\n');

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}`,
  );

  const data = await response.json();
  const models = data.models
    .filter((m: any) => m.supportedGenerationMethods?.includes('generateContent'))
    .sort((a: any, b: any) => a.name.localeCompare(b.name));

  console.log(`Found ${models.length} Gemini models:\n`);
  models.forEach((m: any) => {
    const name = m.name.replace('models/', '');
    const tokens = m.inputTokenLimit || 'unknown';
    console.log(`  - ${name} (context: ${tokens} tokens)`);
  });
}

async function listAnthropicModels() {
  console.log('📦 Anthropic models (from our registry):\n');

  // Anthropic doesn't provide a models API endpoint
  // List from our MODEL_REGISTRY instead
  const anthropicModels = [
    'claude-opus-4-20250514',
    'claude-sonnet-4-5-20250929',
    'claude-sonnet-4-20250514',
    'claude-haiku-4-5-20251001',
    'claude-3-5-sonnet-20241022',
    'claude-3-5-sonnet-20240620',
    'claude-3-5-haiku-20241022',
  ];

  console.log(`${anthropicModels.length} Claude models:\n`);
  anthropicModels.forEach((id) => {
    console.log(`  - ${id}`);
  });

  console.log('\nNote: Anthropic does not provide a public models API.');
  console.log('See: https://docs.anthropic.com/en/docs/about-claude/models');
}

async function listFromRegistry() {
  console.log('📦 Models from our MODEL_REGISTRY:\n');

  const { MODEL_REGISTRY } =
    await import('../packages/compiler/dist/platform/llm/model-registry.js');

  const byProvider: Record<string, string[]> = {};

  Object.entries(MODEL_REGISTRY).forEach(([id, model]: [string, any]) => {
    if (!byProvider[model.provider]) {
      byProvider[model.provider] = [];
    }
    byProvider[model.provider].push(id);
  });

  console.log(`Total: ${Object.keys(MODEL_REGISTRY).length} models\n`);

  Object.entries(byProvider)
    .sort(([, a], [, b]) => b.length - a.length)
    .forEach(([provider, models]) => {
      console.log(`\n${provider.toUpperCase()} (${models.length} models):`);
      models.slice(0, 10).forEach((id) => {
        const model = MODEL_REGISTRY[id];
        console.log(`  - ${id} (${model.displayName})`);
      });
      if (models.length > 10) {
        console.log(`  ... and ${models.length - 10} more`);
      }
    });
}

// Main
const provider = process.argv[2] || 'registry';

(async () => {
  try {
    switch (provider) {
      case 'openai':
        if (!process.env.OPENAI_API_KEY) {
          console.error('❌ OPENAI_API_KEY environment variable required');
          process.exit(1);
        }
        await listOpenAIModels(process.env.OPENAI_API_KEY);
        break;

      case 'google':
      case 'gemini':
        if (!process.env.GOOGLE_API_KEY) {
          console.error('❌ GOOGLE_API_KEY environment variable required');
          process.exit(1);
        }
        await listGoogleModels(process.env.GOOGLE_API_KEY);
        break;

      case 'anthropic':
        await listAnthropicModels();
        break;

      case 'registry':
      default:
        await listFromRegistry();
        break;
    }
  } catch (error) {
    console.error('Error:', error);
    process.exit(1);
  }
})();
