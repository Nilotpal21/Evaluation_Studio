import { describe, it, expect, vi, beforeEach } from 'vitest';

const { mockLog } = vi.hoisted(() => {
  const mockLog = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
  return { mockLog };
});
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue(mockLog),
}));

import {
  NotificationDispatcher,
  type NotificationChannelAdapter,
  type ResolvedNotification,
  type WorkflowNotificationRule,
  type NotificationEvent,
} from '../notifications/notification-dispatcher.js';
import type { WorkflowContextData } from '../context/expression-resolver.js';

/* ---------- shared test context ---------- */

function createTestContext(overrides?: Partial<WorkflowContextData>): WorkflowContextData {
  return {
    trigger: {
      type: 'webhook',
      payload: { orderId: 'ORD-42', amount: 1500, customer: 'Acme Corp' },
    },
    workflow: { id: 'wf-1', name: 'order-flow', executionId: 'exec-1' },
    tenant: { tenantId: 'tenant-1', projectId: 'proj-1' },
    steps: {
      'fetch-order': {
        output: { status: 'shipped' },
        status: 'completed',
        durationMs: 120,
        completedAt: '2026-03-01T10:00:00.000Z',
      },
    },
    vars: { region: 'us-east' },
    ...overrides,
  };
}

function createMockAdapter(): NotificationChannelAdapter & { send: ReturnType<typeof vi.fn> } {
  return { send: vi.fn().mockResolvedValue(undefined) };
}

/**
 * Build a notification rule in the shape the dispatcher now consumes.
 * Mirrors the CRUD route contract (`events: string[]`, structured channel).
 */
function rule(
  event: string,
  channelType: 'slack' | 'msteams' | 'email' | 'webhook' | 'websocket',
  extra: Partial<WorkflowNotificationRule> = {},
): WorkflowNotificationRule {
  return {
    events: [event],
    channel: { type: channelType, target: extra.channel?.target ?? `target-${channelType}` },
    ...extra,
  };
}

/* ================================================================
 * NotificationDispatcher
 * ================================================================ */
describe('NotificationDispatcher', () => {
  let dispatcher: NotificationDispatcher;
  let slackAdapter: ReturnType<typeof createMockAdapter>;
  let emailAdapter: ReturnType<typeof createMockAdapter>;
  let ctx: WorkflowContextData;

  beforeEach(() => {
    slackAdapter = createMockAdapter();
    emailAdapter = createMockAdapter();
    const adapters = new Map<string, NotificationChannelAdapter>([
      ['slack', slackAdapter],
      ['email', emailAdapter],
    ]);
    dispatcher = new NotificationDispatcher(adapters);
    ctx = createTestContext();
  });

  /* ---------- rule filtering ---------- */
  it('filters rules by event type', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.started', 'slack', { template: 'Started' }),
      rule('workflow.completed', 'email', { template: 'Done' }),
      rule('workflow.started', 'email', { template: 'Also started' }),
    ];

    const resolved = await dispatcher.dispatch('workflow.started', rules, ctx);

    expect(resolved).toHaveLength(2);
    expect(resolved[0].channel).toBe('slack');
    expect(resolved[1].channel).toBe('email');
  });

  it('returns empty array when no rules match', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.completed', 'slack', { template: 'Done' }),
    ];

    const resolved = await dispatcher.dispatch('workflow.started', rules, ctx);

    expect(resolved).toEqual([]);
    expect(slackAdapter.send).not.toHaveBeenCalled();
  });

  /* ---------- template resolution ---------- */
  it('resolves {{expression}} templates using workflow context', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.completed', 'slack', {
        template: 'Order {{trigger.payload.orderId}} completed',
        body: 'Customer: {{trigger.payload.customer}}, Region: {{context.vars.region}}',
      }),
    ];

    const resolved = await dispatcher.dispatch('workflow.completed', rules, ctx);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toBe('Order ORD-42 completed');
    expect(resolved[0].body).toBe('Customer: Acme Corp, Region: us-east');
  });

  it('uses default title when template is not provided', async () => {
    const rules: WorkflowNotificationRule[] = [rule('workflow.started', 'slack')];

    const resolved = await dispatcher.dispatch('workflow.started', rules, ctx);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toBe('Workflow notification: workflow.started');
    expect(resolved[0].body).toBe('');
  });

  it('handles missing expressions gracefully (returns empty string)', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.started', 'slack', {
        template: 'Value: {{trigger.payload.nonExistent}}',
        body: 'Also: {{context.vars.doesNotExist}}',
      }),
    ];

    const resolved = await dispatcher.dispatch('workflow.started', rules, ctx);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toBe('Value: ');
    expect(resolved[0].body).toBe('Also: ');
  });

  it('resolves step output expressions', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('step.completed', 'slack', {
        template: 'Fetch status: {{steps.fetch-order.output.status}}',
      }),
    ];

    const resolved = await dispatcher.dispatch('step.completed', rules, ctx);

    expect(resolved[0].title).toBe('Fetch status: shipped');
  });

  /* ---------- adapter dispatch ---------- */
  it('calls registered adapter send()', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.completed', 'slack', { template: 'Done', body: 'All good' }),
    ];

    await dispatcher.dispatch('workflow.completed', rules, ctx);

    expect(slackAdapter.send).toHaveBeenCalledTimes(1);
    const notification = slackAdapter.send.mock.calls[0][0] as ResolvedNotification;
    expect(notification.title).toBe('Done');
    expect(notification.body).toBe('All good');
    expect(notification.channel).toBe('slack');
    expect(notification.event).toBe('workflow.completed');
  });

  it('works with no adapters registered (just resolves)', async () => {
    const bareDispatcher = new NotificationDispatcher();
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.started', 'slack', { template: 'Started' }),
    ];

    const resolved = await bareDispatcher.dispatch('workflow.started', rules, ctx);

    expect(resolved).toHaveLength(1);
    expect(resolved[0].title).toBe('Started');
  });

  it('handles adapter errors gracefully (does not throw)', async () => {
    slackAdapter.send.mockRejectedValue(new Error('Slack API timeout'));
    mockLog.error.mockClear();

    const rules: WorkflowNotificationRule[] = [
      rule('workflow.failed', 'slack', { template: 'Failed!' }),
    ];

    const resolved = await dispatcher.dispatch('workflow.failed', rules, ctx);

    expect(resolved).toHaveLength(1);
    expect(mockLog.error).toHaveBeenCalledWith('Failed to send notification', {
      event: 'workflow.failed',
      channel: 'slack',
      error: 'Slack API timeout',
    });
  });

  it('handles non-Error adapter rejections gracefully', async () => {
    slackAdapter.send.mockRejectedValue('raw string error');
    mockLog.error.mockClear();

    const rules: WorkflowNotificationRule[] = [
      rule('workflow.failed', 'slack', { template: 'Failed!' }),
    ];

    const resolved = await dispatcher.dispatch('workflow.failed', rules, ctx);

    expect(resolved).toHaveLength(1);
    expect(mockLog.error).toHaveBeenCalledWith('Failed to send notification', {
      event: 'workflow.failed',
      channel: 'slack',
      error: 'raw string error',
    });
  });

  /* ---------- multiple rules ---------- */
  it('dispatches all matching rules to their respective adapters', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.completed', 'slack', { template: 'Slack notification' }),
      rule('workflow.completed', 'email', { template: 'Email notification' }),
      rule('workflow.failed', 'slack', { template: 'Should not match' }),
    ];

    const resolved = await dispatcher.dispatch('workflow.completed', rules, ctx);

    expect(resolved).toHaveLength(2);
    expect(slackAdapter.send).toHaveBeenCalledTimes(1);
    expect(emailAdapter.send).toHaveBeenCalledTimes(1);
  });

  /* ---------- metadata ---------- */
  it('includes workflow context metadata in resolved notification', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.started', 'slack', {
        template: 'Started',
        metadata: { priority: 'high', source: 'api' },
      }),
    ];

    const resolved = await dispatcher.dispatch('workflow.started', rules, ctx);

    expect(resolved[0].metadata).toEqual({
      workflowId: 'wf-1',
      executionId: 'exec-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      ruleId: undefined,
      ruleName: undefined,
      priority: 'high',
      source: 'api',
    });
  });

  it('includes context metadata even when rule has no extra metadata', async () => {
    const rules: WorkflowNotificationRule[] = [
      rule('workflow.started', 'slack', { template: 'Started' }),
    ];

    const resolved = await dispatcher.dispatch('workflow.started', rules, ctx);

    expect(resolved[0].metadata).toEqual({
      workflowId: 'wf-1',
      executionId: 'exec-1',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      ruleId: undefined,
      ruleName: undefined,
    });
  });

  /* ---------- registerAdapter ---------- */
  it('registerAdapter adds a new channel', async () => {
    const webhookAdapter = createMockAdapter();
    dispatcher.registerAdapter('webhook', webhookAdapter);

    const rules: WorkflowNotificationRule[] = [
      rule('workflow.started', 'webhook', { template: 'Hit' }),
    ];

    await dispatcher.dispatch('workflow.started', rules, ctx);

    expect(webhookAdapter.send).toHaveBeenCalledTimes(1);
  });

  /* ---------- empty rules ---------- */
  it('handles empty rules array', async () => {
    const resolved = await dispatcher.dispatch('workflow.started', [], ctx);
    expect(resolved).toEqual([]);
  });
});
