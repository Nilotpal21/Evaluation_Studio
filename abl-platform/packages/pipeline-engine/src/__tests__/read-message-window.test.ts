import { describe, expect, test, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

const mockQuery = vi.fn();
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({ query: mockQuery }),
}));

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

const mockDecryptForTenantAuto = vi.fn();
vi.mock('@agent-platform/shared/encryption', () => ({
  decryptForTenantAuto: (...args: unknown[]) => mockDecryptForTenantAuto(...args),
}));

const { readMessageWindowService } =
  await import('../pipeline/services/read-message-window.service.js');

function ctx(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
    console: { log: () => {} },
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

function chResult(rows: Record<string, unknown>[]) {
  return { json: async () => ({ data: rows }) };
}

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    sessionId: 'sess-1',
    config: { windowSize: 2, includeToolCalls: true },
    previousSteps: {},
    pipelineInput: {
      tenantId: 'tenant-1',
      projectId: 'project-1',
      sessionId: 'sess-1',
      agentName: 'SupportBot',
      channel: 'web_chat',
      payload: {
        messageId: 'msg-3',
        content: 'trigger email john.doe@gmail.com',
        role: 'user',
        messageIndex: 3,
      },
    },
    ...overrides,
  };
}

describe('ReadMessageWindow service', () => {
  beforeEach(() => {
    mockQuery.mockReset();
    mockDecryptForTenantAuto.mockReset();
  });

  test('renders trigger, window messages, and tool calls through pipeline PII boundary', async () => {
    mockQuery
      .mockResolvedValueOnce(
        chResult([
          {
            message_id: 'msg-1',
            role: 'assistant',
            content: 'encrypted-message',
            created_at: '2025-01-01T00:00:00Z',
            channel: 'web_chat',
            metadata: '{}',
          },
        ]),
      )
      .mockResolvedValueOnce(chResult([{ total: '3' }]))
      .mockResolvedValueOnce(
        chResult([
          {
            agent_name: 'SupportBot',
            data: 'encrypted-trace',
            timestamp: '2025-01-01T00:00:01Z',
            duration_ms: 12,
            has_error: 0,
          },
        ]),
      );

    mockDecryptForTenantAuto.mockImplementation(async (value: string) => {
      if (value === 'encrypted-message') {
        return 'window email jane.doe@gmail.com';
      }
      if (value === 'encrypted-trace') {
        return JSON.stringify({
          toolName: 'sendEmail',
          arguments: { email: 'tool.user@gmail.com' },
          result: { status: 'sent', email: 'tool.user@gmail.com' },
        });
      }
      return value;
    });

    const result = await getExecute(readMessageWindowService)(ctx(), makeInput());

    expect(result.status).toBe('success');
    expect(result.data.triggeringMessage.content).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(result.data.windowMessages[0].content).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(result.data.toolCalls[0].arguments.email).toMatch(/\{\{PII:email:[a-f0-9-]+\}\}/);
    expect(JSON.stringify(result.data)).not.toContain('john.doe@gmail.com');
    expect(JSON.stringify(result.data)).not.toContain('jane.doe@gmail.com');
    expect(JSON.stringify(result.data)).not.toContain('tool.user@gmail.com');
  });
});
