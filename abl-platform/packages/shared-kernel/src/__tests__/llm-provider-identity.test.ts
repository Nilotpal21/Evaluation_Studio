import { describe, expect, it } from 'vitest';
import {
  DEFAULT_LLM_ALLOWED_PROVIDERS,
  areLlmProvidersPolicyEquivalent,
  canonicalizeLlmProviderName,
  getLlmProviderPolicyAliases,
  isLegacyDefaultLlmAllowedProviders,
  isLlmProviderAllowed,
  mergeDefaultLlmAllowedProviders,
} from '../llm-provider-identity.js';

describe('llm provider identity', () => {
  it('treats google and gemini as one policy identity', () => {
    expect(canonicalizeLlmProviderName('gemini')).toBe('google');
    expect(areLlmProvidersPolicyEquivalent('gemini', 'google')).toBe(true);
    expect(isLlmProviderAllowed(['gemini'], 'google')).toBe(true);
    expect(isLlmProviderAllowed(['google'], 'gemini')).toBe(true);
    expect(getLlmProviderPolicyAliases('google')).toEqual(['google', 'gemini']);
    expect(getLlmProviderPolicyAliases('gemini')).toEqual(['google', 'gemini']);
  });

  it('keeps azure distinct from openai', () => {
    expect(canonicalizeLlmProviderName('azure')).toBe('azure');
    expect(areLlmProvidersPolicyEquivalent('openai', 'azure')).toBe(false);
    expect(isLlmProviderAllowed(['openai'], 'azure')).toBe(false);
  });

  it('expands only the old untouched default provider policy', () => {
    expect(isLegacyDefaultLlmAllowedProviders(['anthropic', 'openai', 'gemini'])).toBe(true);
    expect(mergeDefaultLlmAllowedProviders(['anthropic', 'openai', 'gemini'])).toEqual(
      DEFAULT_LLM_ALLOWED_PROVIDERS,
    );
    expect(mergeDefaultLlmAllowedProviders(['openai'])).toEqual(['openai']);
  });
});
