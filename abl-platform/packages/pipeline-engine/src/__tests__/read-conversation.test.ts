import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the service
// ---------------------------------------------------------------------------

const mockReadSession = vi.fn();
vi.mock('../pipeline/services/conversation-reader.js', () => ({
  ConversationReader: class {
    readSession = mockReadSession;
    formatTranscript(data: any) {
      return data.messages
        .map((m: any) => {
          const labels: Record<string, string> = {
            user: 'User',
            assistant: 'Assistant',
            system: 'System',
            tool: 'Tool',
          };
          return `${labels[m.role] ?? m.role}: ${m.content}`;
        })
        .join('\n');
    }
  },
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

vi.mock('mongoose', () => ({
  default: { connection: { readyState: 1 } },
  connection: { readyState: 1 },
}));

vi.mock('@agent-platform/database/models', () => ({
  ProjectRuntimeConfig: {
    findOne: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue({
        pii_redaction: { enabled: true, redact_input: true, redact_output: true },
      }),
    }),
  },
  PIIPattern: {
    find: vi.fn().mockReturnValue({
      sort: vi.fn().mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      }),
    }),
  },
}));

const { readConversationService } =
  await import('../pipeline/services/read-conversation.service.js');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Minimal restate.Context mock: ctx.run executes fn() directly. */
function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

const execute = getExecute(readConversationService);

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'acme-corp',
    projectId: 'support-bot',
    sessionId: 'sess-001',
    config: {
      enrichWithTraces: true,
    },
    previousSteps: {},
    pipelineInput: {
      tenantId: 'acme-corp',
      projectId: 'support-bot',
      sessionId: 'sess-001',
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('ReadConversation service', () => {
  beforeEach(() => {
    mockReadSession.mockReset();
  });

  test('reads conversation and returns transcript + messages', async () => {
    mockReadSession.mockResolvedValue({
      tenantId: 'acme-corp',
      sessionId: 'sess-001',
      messages: [
        { messageId: 'msg-1', role: 'user', content: 'Hello', timestamp: '2025-01-01T00:00:00Z' },
        {
          messageId: 'msg-2',
          role: 'assistant',
          content: 'Hi there!',
          timestamp: '2025-01-01T00:00:01Z',
        },
      ],
      toolCalls: [
        {
          toolName: 'lookupOrder',
          arguments: { orderId: '123' },
          result: { status: 'shipped' },
          success: true,
          timestamp: '2025-01-01T00:00:00.500Z',
          durationMs: 50,
        },
      ],
      escalations: [],
      metadata: {
        agentName: 'SupportBot',
        channel: 'web_chat',
        messageCount: 2,
        durationMs: 1000,
      },
    });

    const result = await execute(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.transcript).toContain('User: Hello');
    expect(result.data.transcript).toContain('Assistant: Hi there!');
    expect(result.data.messages).toHaveLength(2);
    expect(result.data.toolCalls).toHaveLength(1);
    expect(result.data.toolCalls[0].toolName).toBe('lookupOrder');
    expect(result.data.metadata.agentName).toBe('SupportBot');
    expect(result.data.metadata.messageCount).toBe(2);
    expect(mockReadSession).toHaveBeenCalledWith('acme-corp', 'sess-001', {
      enrichWithTraces: true,
      roles: undefined,
    });
  });

  test('fails when sessionId is missing', async () => {
    const input = makeInput({
      sessionId: undefined,
      pipelineInput: {
        tenantId: 'acme-corp',
        projectId: 'support-bot',
      },
    });

    const result = await execute(ctx(), input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('sessionId');
  });

  test('renders message-trigger payloads through the pipeline PII boundary', async () => {
    const result = await execute(
      ctx(),
      makeInput({
        pipelineInput: {
          type: 'message.user',
          tenantId: 'acme-corp',
          projectId: 'support-bot',
          sessionId: 'sess-001',
          payload: {
            messageId: 'msg-1',
            content: 'email john.doe@gmail.com',
            messageIndex: 0,
          },
          timestamp: '2025-01-01T00:00:00Z',
          channel: 'web_chat',
          agentName: 'SupportBot',
        },
      }),
    );

    expect(result.status).toBe('success');
    expect(result.data.transcript).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(JSON.stringify(result.data)).not.toContain('john.doe@gmail.com');
    expect(mockReadSession).not.toHaveBeenCalled();
  });
});
