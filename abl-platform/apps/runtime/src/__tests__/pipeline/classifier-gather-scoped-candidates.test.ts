import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import { classify } from '../../services/pipeline/classifier.js';
import { DEFAULT_PIPELINE_CONFIG } from '../../services/pipeline/types.js';

const mockGenerateText = vi.mocked(generateText);

describe('classifier gather-scoped candidates', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
  });

  it('filters prompt categories to the finite gather candidate surface', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'branch_locator',
            confidence: 0.93,
            summary: 'find a nearby branch',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 28,
        outputTokens: 9,
      },
    } as any);

    const result = await classify({ modelId: 'pipeline-model' } as any, {
      mode: 'gather_scoped',
      userMessage: 'Where is the nearest branch?',
      categories: [
        { name: 'branch_locator' },
        { name: 'billing_support' },
        { name: 'card_activation', description: 'Activate a new debit card' },
      ],
      candidateSurface: {
        kind: 'parent_supervisor_route',
        size: 1,
        candidates: ['branch_locator'],
      },
      config: DEFAULT_PIPELINE_CONFIG,
    });

    const prompt = (mockGenerateText.mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt;

    expect(result.intents[0]?.category).toBe('branch_locator');
    expect(prompt).toContain('Categories: branch_locator');
    expect(prompt).toContain('Allowed candidates: branch_locator');
    expect(prompt).not.toContain('billing_support');
    expect(prompt).not.toContain('card_activation');
  });

  it('rejects classifier categories outside the gather candidate surface', async () => {
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          {
            category: 'billing_support',
            confidence: 0.91,
            summary: 'billing help',
          },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 24,
        outputTokens: 8,
      },
    } as any);

    const result = await classify({ modelId: 'pipeline-model' } as any, {
      mode: 'gather_scoped',
      userMessage: 'Where is the nearest branch?',
      categories: [{ name: 'branch_locator' }, { name: 'billing_support' }],
      candidateSurface: {
        kind: 'parent_supervisor_route',
        size: 1,
        candidates: ['branch_locator'],
      },
      config: DEFAULT_PIPELINE_CONFIG,
    });

    expect(result.intents).toEqual([{ category: null, confidence: 0, summary: 'unknown' }]);
  });
});
