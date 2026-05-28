import type { LanguageModel } from 'ai';
import { describe, expect, it, vi } from 'vitest';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

const { resolveFillerModel } = await import('../services/filler/model-resolver.js');
const { DEFAULT_FILLER_RUNTIME_CONFIG } = await import('../services/filler/types.js');

const responseModel = { modelId: 'response-model' } as unknown as LanguageModel;
const toolSelectionModel = { modelId: 'tool-selection-model' } as unknown as LanguageModel;

describe('resolveFillerModel', () => {
  it('uses response generation model for promptRef-based filler prompts', async () => {
    const session = {
      llmClient: {
        resolveLanguageModel: vi.fn().mockResolvedValue(responseModel),
      },
    };

    const result = await resolveFillerModel(
      {
        ...DEFAULT_FILLER_RUNTIME_CONFIG,
        promptRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      },
      session,
    );

    expect(result).toBe(responseModel);
    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('response_gen');
  });

  it('falls back to tool selection when promptRef response model is unavailable', async () => {
    const session = {
      llmClient: {
        resolveLanguageModel: vi
          .fn()
          .mockResolvedValueOnce(null)
          .mockResolvedValueOnce(toolSelectionModel),
      },
    };

    const result = await resolveFillerModel(
      {
        ...DEFAULT_FILLER_RUNTIME_CONFIG,
        promptRef: {
          promptId: 'prompt-1',
          versionId: 'version-1',
        },
      },
      session,
    );

    expect(result).toBe(toolSelectionModel);
    expect(session.llmClient.resolveLanguageModel).toHaveBeenNthCalledWith(1, 'response_gen');
    expect(session.llmClient.resolveLanguageModel).toHaveBeenNthCalledWith(2, 'tool_selection');
  });

  it('keeps non-prompt filler resolution on the existing tool selection lane', async () => {
    const session = {
      llmClient: {
        resolveLanguageModel: vi.fn().mockResolvedValue(toolSelectionModel),
      },
    };

    const result = await resolveFillerModel(DEFAULT_FILLER_RUNTIME_CONFIG, session);

    expect(result).toBe(toolSelectionModel);
    expect(session.llmClient.resolveLanguageModel).toHaveBeenCalledWith('tool_selection');
  });
});
