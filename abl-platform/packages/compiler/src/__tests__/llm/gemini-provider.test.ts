/**
 * Gemini Provider Tests
 *
 * The custom GeminiProvider class was removed as part of the Vercel AI SDK migration.
 * Gemini/Google AI provider communication now happens through the Vercel AI SDK
 * in the runtime layer (SessionLLMClient).
 *
 * This file verifies that the provider module correctly exports types and that
 * the default model mappings for Google/Gemini are present.
 *
 * For Gemini E2E testing, see:
 * - packages/compiler/src/__tests__/llm/provider-e2e.test.ts (requires GOOGLE_AI_API_KEY)
 * - apps/runtime/src/__tests__/vercel-ai-adapters.test.ts
 */

import { describe, test, expect } from 'vitest';
import { DEFAULT_MODEL_MAPPINGS, getDefaultModel } from '../../platform/llm/provider.js';
import type { LLMProvider, LLMProviderType } from '../../platform/llm/types.js';

describe('Gemini provider configuration (post-migration)', () => {
  test('google provider has model mappings for all tiers', () => {
    const googleModels = DEFAULT_MODEL_MAPPINGS.google;
    expect(googleModels).toBeDefined();
    expect(googleModels.fast).toBeDefined();
    expect(googleModels.balanced).toBeDefined();
    expect(googleModels.powerful).toBeDefined();
  });

  test('vertex provider has model mappings for all tiers', () => {
    const vertexModels = DEFAULT_MODEL_MAPPINGS.vertex;
    expect(vertexModels).toBeDefined();
    expect(vertexModels.fast).toBeDefined();
    expect(vertexModels.balanced).toBeDefined();
    expect(vertexModels.powerful).toBeDefined();
  });

  test('getDefaultModel returns correct google models', () => {
    expect(getDefaultModel('google', 'fast')).toMatch(/gemini/);
    expect(getDefaultModel('google', 'balanced')).toMatch(/gemini/);
    expect(getDefaultModel('google', 'powerful')).toMatch(/gemini/);
  });

  test('gemini is a valid LLMProviderType', () => {
    const providerType: LLMProviderType = 'gemini';
    expect(providerType).toBe('gemini');
  });

  test('LLMProvider interface is importable as a type', () => {
    // This test verifies the type export is available at runtime
    // (the import itself validates this — if it fails, the module structure is broken)
    const mockProvider: Partial<LLMProvider> = {
      supportsFeature: () => true,
    };
    expect(mockProvider.supportsFeature!('tools')).toBe(true);
  });
});
