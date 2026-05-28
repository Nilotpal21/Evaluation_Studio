import { describe, expect, it } from 'vitest';
import {
  formatModelIdentityLine,
  formatModelOptionLabel,
  getProviderDisplayName,
} from '@/lib/model-display';

describe('model display helpers', () => {
  it('shows the canonical model id next to Azure catalog names', () => {
    expect(
      formatModelOptionLabel({
        displayName: 'GPT-4.1 (Azure)',
        modelId: 'GPT-4.1',
        provider: 'azure',
      }),
    ).toBe('GPT-4.1 (Azure) · Azure OpenAI · GPT-4.1');
  });

  it('shows custom project names with provider and model id', () => {
    expect(
      formatModelOptionLabel({
        name: 'Call Forwarder default',
        modelId: 'GPT-4.1',
        provider: 'azure',
      }),
    ).toBe('Call Forwarder default · Azure OpenAI · GPT-4.1');
  });

  it('formats compact identity lines for secondary UI text', () => {
    expect(formatModelIdentityLine({ provider: 'openai', modelId: 'gpt-4.1' })).toBe(
      'OpenAI · gpt-4.1',
    );
  });

  it('normalizes known provider labels', () => {
    expect(getProviderDisplayName('microsoft_foundry_anthropic')).toBe(
      'Microsoft Foundry Anthropic',
    );
    expect(getProviderDisplayName('openrouter')).toBe('OpenRouter');
  });
});
