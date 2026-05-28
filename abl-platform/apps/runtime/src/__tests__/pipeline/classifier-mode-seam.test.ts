import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('ai', () => ({
  generateText: vi.fn(),
}));

import { generateText } from 'ai';
import { classify } from '../../services/pipeline/classifier.js';
import { DEFAULT_PIPELINE_CONFIG } from '../../services/pipeline/types.js';

const mockGenerateText = vi.mocked(generateText);

describe('classifier mode seam', () => {
  beforeEach(() => {
    mockGenerateText.mockReset();
    mockGenerateText.mockResolvedValue({
      text: JSON.stringify({
        intents: [
          { category: 'branch_locator', confidence: 0.88, summary: 'find nearby branches' },
        ],
      }),
      finishReason: 'stop',
      usage: {
        inputTokens: 32,
        outputTokens: 9,
      },
    } as any);
  });

  it('gather_scoped mode injects finite candidate surface guidance into the prompt', async () => {
    await classify({ modelId: 'pipeline-model' } as any, {
      mode: 'gather_scoped',
      userMessage: 'show me nearby branches',
      categories: [{ name: 'branch_locator' }],
      candidateSurface: {
        kind: 'parent_supervisor_route',
        size: 1,
        candidates: ['branch_locator'],
      },
      config: DEFAULT_PIPELINE_CONFIG,
    });

    const prompt = (mockGenerateText.mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt;

    expect(prompt).toContain(
      'Gather interrupt candidate surface: parent_supervisor_route (1 candidates)',
    );
    expect(prompt).toContain('Only choose from this finite candidate surface or return null.');
  });

  it('global mode keeps the prompt free of gather-scoped instructions', async () => {
    await classify({ modelId: 'pipeline-model' } as any, {
      mode: 'global',
      userMessage: 'show me nearby branches',
      categories: [{ name: 'branch_locator' }],
      config: DEFAULT_PIPELINE_CONFIG,
    });

    const prompt = (mockGenerateText.mock.calls[0]?.[0] as { prompt?: string } | undefined)?.prompt;

    expect(prompt).not.toContain('Gather interrupt candidate surface:');
    expect(prompt).not.toContain('finite candidate surface');
  });
});
