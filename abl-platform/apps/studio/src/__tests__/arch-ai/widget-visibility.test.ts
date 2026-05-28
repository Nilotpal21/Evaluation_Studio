import { describe, expect, it } from 'vitest';
import type { ArchSession, ChatMessage } from '@agent-platform/arch-ai/types';
import { shouldRenderToolCallMessage } from '@/lib/arch-ai/ui/widget-visibility';

function makeSession(
  pendingInteraction: ArchSession['metadata']['pendingInteraction'] = null,
  options: { phase?: ArchSession['metadata']['phase']; buildStage?: string } = {},
): ArchSession {
  const metadata: ArchSession['metadata'] = {
    phase: options.phase ?? 'INTERVIEW',
    mode: 'ONBOARDING',
    specification: {
      version: 1,
      projectName: 'SupportHub',
      description: null,
      channels: [],
      language: 'English',
      uploadedFiles: [],
      conversationNotes: [],
    },
    pendingInteraction,
    messages: [],
    topologyApproved: false,
    topology: null,
    files: {},
  };
  if (options.buildStage) {
    metadata.buildProgress = {
      stage: options.buildStage,
    } as ArchSession['metadata']['buildProgress'];
  }

  return {
    id: 'sess-widget',
    tenantId: 'tenant-1',
    userId: 'user-1',
    state: 'ACTIVE',
    metadata,
    createdAt: '2026-04-20T10:00:00.000Z',
    updatedAt: '2026-04-20T10:00:00.000Z',
  };
}

function makeToolCall(
  overrides: Partial<NonNullable<ChatMessage['toolCall']>> = {},
): NonNullable<ChatMessage['toolCall']> {
  return {
    toolCallId: 'tool-1',
    toolName: 'ask_user',
    input: { widgetType: 'TextInput', question: 'What should this agent handle?' },
    ...overrides,
  };
}

describe('shouldRenderToolCallMessage', () => {
  it('keeps the current pending widget visible', () => {
    expect(
      shouldRenderToolCallMessage(
        makeToolCall(),
        makeSession({
          kind: 'widget',
          id: 'tool-1',
          payload: { widgetType: 'TextInput' },
          createdAt: '2026-04-20T10:00:00.000Z',
        }),
      ),
    ).toBe(true);
  });

  it('keeps answered widgets visible as readonly summaries', () => {
    expect(
      shouldRenderToolCallMessage(
        makeToolCall({ result: 'Handles order status and refunds.' }),
        makeSession(null),
      ),
    ).toBe(true);
  });

  it('hides obsolete interactive widgets once the pending interaction moved on', () => {
    expect(
      shouldRenderToolCallMessage(
        makeToolCall(),
        makeSession({
          kind: 'widget',
          id: 'tool-2',
          payload: { widgetType: 'TextInput' },
          createdAt: '2026-04-20T10:00:00.000Z',
        }),
      ),
    ).toBe(false);
  });

  it('hides unanswered widgets when there is no pending interaction to resume', () => {
    expect(shouldRenderToolCallMessage(makeToolCall(), makeSession(null))).toBe(false);
  });

  it('keeps BuildComplete visible when a completed build can resume from durable state', () => {
    expect(
      shouldRenderToolCallMessage(
        makeToolCall({
          input: { widgetType: 'BuildComplete', options: [{ value: 'create' }] },
        }),
        makeSession(null, { phase: 'BUILD', buildStage: 'agents_complete' }),
      ),
    ).toBe(true);
  });

  it('hides BuildComplete without pending interaction before build completion', () => {
    expect(
      shouldRenderToolCallMessage(
        makeToolCall({
          input: { widgetType: 'BuildComplete', options: [{ value: 'create' }] },
        }),
        makeSession(null, { phase: 'BUILD', buildStage: 'generating' }),
      ),
    ).toBe(false);
  });

  it('hides internal non-interactive tool-call messages from the chat surface', () => {
    expect(
      shouldRenderToolCallMessage(
        makeToolCall({
          toolName: 'recommend_model',
          input: { constraintCount: 3 },
        }),
        makeSession(null),
      ),
    ).toBe(false);
  });

  it('keeps explicitly renderable non-interactive widgets visible once they have a result', () => {
    expect(
      shouldRenderToolCallMessage(
        makeToolCall({
          toolName: 'recommend_model',
          input: { constraintCount: 3 },
          result: {
            summary: 'GPT-5.4 is the best fit for this workflow.',
          },
        }),
        makeSession(null),
      ),
    ).toBe(true);
  });
});
