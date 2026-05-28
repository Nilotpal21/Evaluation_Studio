/**
 * Unit tests for the SendSlack Restate activity service.
 *
 * Tests missing field validation, webhook path with mocked global.fetch,
 * graceful degradation when notifications module not found.
 */
import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
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

describe('SendSlackService', () => {
  const mockFetch = vi.fn();

  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
    mockFetch.mockReset();
    vi.stubGlobal('fetch', mockFetch);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('returns fail when channel is missing from config', async () => {
    const { sendSlackService } = await import('../pipeline/services/send-slack.service.js');
    const execute = getExecute(sendSlackService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { message: 'Hello!' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'channel' and 'message'");
  });

  test('returns fail when message is missing from config', async () => {
    const { sendSlackService } = await import('../pipeline/services/send-slack.service.js');
    const execute = getExecute(sendSlackService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { channel: '#general' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'channel' and 'message'");
  });

  test('webhook path: successful POST returns success with via=webhook', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    const { sendSlackService } = await import('../pipeline/services/send-slack.service.js');
    const execute = getExecute(sendSlackService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        channel: '#alerts',
        message: 'Pipeline completed successfully',
        webhookUrl: 'https://hooks.slack.com/services/T123/B456/xyz',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.sent).toBe(true);
    expect(result.data.via).toBe('webhook');
    expect(result.data.channel).toBe('#alerts');

    // Verify fetch was called correctly
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://hooks.slack.com/services/T123/B456/xyz');
    expect(options.method).toBe('POST');
    expect(options.headers['Content-Type']).toBe('application/json');
    const body = JSON.parse(options.body);
    expect(body.channel).toBe('#alerts');
    expect(body.text).toBe('Pipeline completed successfully');
  });

  test('webhook path: returns fail on non-ok response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      statusText: 'Forbidden',
    });

    const { sendSlackService } = await import('../pipeline/services/send-slack.service.js');
    const execute = getExecute(sendSlackService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        channel: '#alerts',
        message: 'Hello',
        webhookUrl: 'https://hooks.slack.com/services/T123/B456/xyz',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('403');
    expect(result.data.error).toContain('Forbidden');
  });

  test('webhook path: template substitution in channel and message', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
    });

    const { sendSlackService } = await import('../pipeline/services/send-slack.service.js');
    const execute = getExecute(sendSlackService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        channel: '{{input.slackChannel}}',
        message: 'Score: {{nodeOutputs.eval.data.score}}',
        webhookUrl: 'https://hooks.slack.com/services/T123/B456/xyz',
      },
      previousSteps: {
        eval: { status: 'success', data: { score: 0.95 } },
      },
      pipelineInput: {
        tenantId: 'tenant-1',
        slackChannel: '#monitoring',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    const body = JSON.parse(mockFetch.mock.calls[0][1].body);
    expect(body.channel).toBe('#monitoring');
    expect(body.text).toBe('Score: 0.95');
  });

  test('graceful degradation when notifications/slack module is not found (no webhook)', async () => {
    vi.doMock('@agent-platform/notifications/slack', () => ({
      getSlackClient: () => {
        throw new Error('Cannot find module @agent-platform/notifications/slack');
      },
    }));

    const { sendSlackService } = await import('../pipeline/services/send-slack.service.js');
    const execute = getExecute(sendSlackService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        channel: '#alerts',
        message: 'Test message',
        // No webhookUrl — falls through to integration path
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Slack integration not available');
  });

  test('integration path: success when module is available', async () => {
    const mockPostMessage = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@agent-platform/notifications/slack', () => ({
      getSlackClient: vi.fn().mockResolvedValue({
        postMessage: mockPostMessage,
      }),
    }));

    const { sendSlackService } = await import('../pipeline/services/send-slack.service.js');
    const execute = getExecute(sendSlackService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        channel: '#alerts',
        message: 'Hello from pipeline',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.sent).toBe(true);
    expect(result.data.via).toBe('integration');
    expect(mockPostMessage).toHaveBeenCalledWith({
      channel: '#alerts',
      text: 'Hello from pipeline',
    });
  });
});
