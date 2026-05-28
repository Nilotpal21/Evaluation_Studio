/**
 * Unit tests for the PublishKafka Restate activity service.
 *
 * Tests missing field validation, message key template substitution,
 * and graceful degradation when the messaging module is not installed.
 */
import { describe, test, expect, vi, beforeEach } from 'vitest';
import type { PipelineStepContext, StepOutput } from '../pipeline/types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockContext(): any {
  return {
    run: async (_label: string, fn: () => any) => fn(),
  };
}

function makeInput(overrides: Partial<PipelineStepContext> = {}): PipelineStepContext {
  return {
    tenantId: 'tenant-1',
    projectId: 'project-1',
    config: {},
    previousSteps: {},
    pipelineInput: { tenantId: 'tenant-1' },
    ...overrides,
  };
}

function getExecute(svc: any): (ctx: any, input: PipelineStepContext) => Promise<StepOutput> {
  return (svc as any).service.execute;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('PublishKafkaService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('returns fail when topic is missing from config', async () => {
    const { publishKafkaService } = await import('../pipeline/services/publish-kafka.service.js');
    const execute = getExecute(publishKafkaService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { payload: { event: 'test' } },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'topic' and 'payload'");
  });

  test('returns fail when payload is missing from config', async () => {
    const { publishKafkaService } = await import('../pipeline/services/publish-kafka.service.js');
    const execute = getExecute(publishKafkaService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { topic: 'events.pipeline' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'topic' and 'payload'");
  });

  test('successful publish returns topic and key', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@agent-platform/messaging/kafka', () => ({
      getKafkaProducer: vi.fn().mockResolvedValue({ send: mockSend }),
    }));

    const { publishKafkaService } = await import('../pipeline/services/publish-kafka.service.js');
    const execute = getExecute(publishKafkaService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        topic: 'events.pipeline-results',
        key: 'static-key',
        payload: { event: 'completed', score: 0.95 },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.topic).toBe('events.pipeline-results');
    expect(result.data.key).toBe('static-key');
    expect(result.data.published).toBe(true);

    // Verify producer.send was called with correct args
    expect(mockSend).toHaveBeenCalledWith({
      topic: 'events.pipeline-results',
      messages: [
        {
          key: 'static-key',
          value: JSON.stringify({ event: 'completed', score: 0.95 }),
        },
      ],
    });
  });

  test('message key template substitution', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@agent-platform/messaging/kafka', () => ({
      getKafkaProducer: vi.fn().mockResolvedValue({ send: mockSend }),
    }));

    const { publishKafkaService } = await import('../pipeline/services/publish-kafka.service.js');
    const execute = getExecute(publishKafkaService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        topic: 'events.results',
        key: '{{input.tenantId}}-{{input.sessionId}}',
        payload: { result: 'done' },
      },
      pipelineInput: {
        tenantId: 'tenant-1',
        sessionId: 'sess-abc',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.key).toBe('tenant-1-sess-abc');

    const sentMessages = mockSend.mock.calls[0][0].messages;
    expect(sentMessages[0].key).toBe('tenant-1-sess-abc');
  });

  test('publishes without key when key is not specified', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@agent-platform/messaging/kafka', () => ({
      getKafkaProducer: vi.fn().mockResolvedValue({ send: mockSend }),
    }));

    const { publishKafkaService } = await import('../pipeline/services/publish-kafka.service.js');
    const execute = getExecute(publishKafkaService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        topic: 'events.results',
        payload: { data: 'value' },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.published).toBe(true);

    const sentMessages = mockSend.mock.calls[0][0].messages;
    expect(sentMessages[0].key).toBeUndefined();
  });

  test('graceful degradation when messaging/kafka module is not found', async () => {
    vi.doMock('@agent-platform/messaging/kafka', () => ({
      getKafkaProducer: () => {
        throw new Error('Cannot find module @agent-platform/messaging/kafka');
      },
    }));

    const { publishKafkaService } = await import('../pipeline/services/publish-kafka.service.js');
    const execute = getExecute(publishKafkaService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        topic: 'events.results',
        payload: { data: 'value' },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Kafka producer not available');
    expect(result.data.topic).toBe('events.results');
  });

  test('returns fail when producer.send throws a runtime error', async () => {
    vi.doMock('@agent-platform/messaging/kafka', () => ({
      getKafkaProducer: vi.fn().mockResolvedValue({
        send: vi.fn().mockRejectedValue(new Error('Broker not available')),
      }),
    }));

    const { publishKafkaService } = await import('../pipeline/services/publish-kafka.service.js');
    const execute = getExecute(publishKafkaService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        topic: 'events.results',
        payload: { data: 'value' },
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Failed to publish to Kafka');
    expect(result.data.error).toContain('Broker not available');
  });
});
