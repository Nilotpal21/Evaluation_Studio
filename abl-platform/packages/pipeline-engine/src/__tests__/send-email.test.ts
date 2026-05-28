/**
 * Unit tests for the SendEmail Restate activity service.
 *
 * Tests missing field validation, template substitution, and
 * graceful degradation when the notifications module is not installed.
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

describe('SendEmailService', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.restoreAllMocks();
  });

  test('returns fail when "to" is missing from config', async () => {
    const { sendEmailService } = await import('../pipeline/services/send-email.service.js');
    const execute = getExecute(sendEmailService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { subject: 'Hello', body: 'World' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'to', 'subject', and 'body'");
  });

  test('returns fail when "subject" is missing from config', async () => {
    const { sendEmailService } = await import('../pipeline/services/send-email.service.js');
    const execute = getExecute(sendEmailService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { to: 'user@example.com', body: 'World' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'to', 'subject', and 'body'");
  });

  test('returns fail when "body" is missing from config', async () => {
    const { sendEmailService } = await import('../pipeline/services/send-email.service.js');
    const execute = getExecute(sendEmailService);

    const ctx = createMockContext();
    const input = makeInput({
      config: { to: 'user@example.com', subject: 'Hello' },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain("'to', 'subject', and 'body'");
  });

  test('template substitution in to, subject, and body', async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    vi.doMock('@agent-platform/notifications/email', () => ({
      getEmailTransport: vi.fn().mockResolvedValue({ send: mockSend }),
    }));

    const { sendEmailService } = await import('../pipeline/services/send-email.service.js');
    const execute = getExecute(sendEmailService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        to: '{{input.recipientEmail}}',
        subject: 'Report for {{input.projectName}}',
        body: 'Score: {{nodeOutputs.eval.data.score}}',
      },
      previousSteps: {
        eval: { status: 'success', data: { score: 95 } },
      },
      pipelineInput: {
        tenantId: 'tenant-1',
        recipientEmail: 'alice@example.com',
        projectName: 'My Project',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('success');
    expect(result.data.sent).toBe(true);
    expect(result.data.to).toBe('alice@example.com');
    expect(result.data.subject).toBe('Report for My Project');

    // Verify the transport was called with substituted values
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'alice@example.com',
        subject: 'Report for My Project',
        body: 'Score: 95',
      }),
    );
  });

  test('graceful degradation when notifications module is not found', async () => {
    vi.doMock('@agent-platform/notifications/email', () => ({
      getEmailTransport: () => {
        throw new Error('Cannot find module @agent-platform/notifications/email');
      },
    }));

    const { sendEmailService } = await import('../pipeline/services/send-email.service.js');
    const execute = getExecute(sendEmailService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        to: 'user@example.com',
        subject: 'Test',
        body: 'Body text',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Email integration not available');
    expect(result.data.to).toBe('user@example.com');
    expect(result.data.subject).toBe('Test');
  });

  test('returns fail when transport.send throws a runtime error', async () => {
    vi.doMock('@agent-platform/notifications/email', () => ({
      getEmailTransport: vi.fn().mockResolvedValue({
        send: vi.fn().mockRejectedValue(new Error('SMTP connection refused')),
      }),
    }));

    const { sendEmailService } = await import('../pipeline/services/send-email.service.js');
    const execute = getExecute(sendEmailService);

    const ctx = createMockContext();
    const input = makeInput({
      config: {
        to: 'user@example.com',
        subject: 'Test',
        body: 'Body text',
      },
    });

    const result = await execute(ctx, input);

    expect(result.status).toBe('fail');
    expect(result.data.error).toContain('Failed to send email');
    expect(result.data.error).toContain('SMTP connection refused');
  });
});
