import { beforeEach, describe, expect, test, vi } from 'vitest';

const mockExecuteMessage = vi.fn();
const mockEnqueueLLMRequest = vi.fn();
const mockPersistMessage = vi.fn(async () => {});
const mockPersistMessageRecord = vi.fn(async () => {});
const mockPersistTurnMetrics = vi.fn(async () => {});

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    executeMessage: (...args: unknown[]) => mockExecuteMessage(...args),
  })),
}));

vi.mock('../../services/llm/llm-queue.js', () => ({
  enqueueLLMRequest: (...args: unknown[]) => mockEnqueueLLMRequest(...args),
}));

vi.mock('../../services/message-persistence-queue.js', () => ({
  persistMessage: (...args: unknown[]) => mockPersistMessage(...args),
  persistMessageRecord: (...args: unknown[]) => mockPersistMessageRecord(...args),
  persistTurnMetrics: (...args: unknown[]) => mockPersistTurnMetrics(...args),
}));

import { executeAndPersist } from '../../channels/pipeline/message-pipeline.js';

describe('message pipeline persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('persists assistant structured output and response metadata without text-only downgrade', async () => {
    const responseMetadata = {
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1 as const,
        kind: 'llm' as const,
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    };
    const richContent = { markdown: '**Choose a payment card**' };
    const actions = {
      elements: [{ type: 'button', id: 'card_9876', label: 'Platinum Rewards' }],
    };
    const voiceConfig = { plain_text: 'Choose a payment card.' };

    mockExecuteMessage.mockResolvedValueOnce({
      response: 'Choose a payment card.',
      action: { type: 'continue' },
      richContent,
      actions,
      voiceConfig,
      responseMetadata,
    });

    await executeAndPersist({
      sessionId: 'runtime-session-1',
      userText: 'I want to make a payment',
      useLLMQueue: false,
      persistence: {
        dbSessionId: 'db-session-1',
        channel: 'web_chat',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        projectId: 'project-1',
      },
    });

    expect(mockPersistMessage).toHaveBeenCalledWith(
      'db-session-1',
      'assistant',
      'Choose a payment card.',
      'web_chat',
      'tenant-1',
      undefined,
      'contact-1',
      'project-1',
      undefined,
      {
        richContent,
        actions,
        voiceConfig,
      },
      responseMetadata,
    );
  });
});
