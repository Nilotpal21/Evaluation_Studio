import { describe, expect, it } from 'vitest';
import { getModelCapabilitiesUrl } from '@/lib/model-capabilities-url';

describe('model capabilities URL helper', () => {
  it('uses a query parameter so provider-native slash model IDs stay intact', () => {
    expect(getModelCapabilitiesUrl('meta-llama/Llama-3.3-70B-Instruct-Turbo')).toBe(
      '/api/model-capabilities?modelId=meta-llama%2FLlama-3.3-70B-Instruct-Turbo',
    );
  });
});
