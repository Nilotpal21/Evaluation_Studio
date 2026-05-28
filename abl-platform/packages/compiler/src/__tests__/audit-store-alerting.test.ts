import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';
import { InMemoryAuditStore } from '../platform/stores/audit-store.js';

describe('audit-store alerting', () => {
  const fetchMock = vi.fn();

  beforeEach(() => {
    fetchMock.mockReset();
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test('dispatches critical events to a configured webhook', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const store = new InMemoryAuditStore(
      { type: 'memory' },
      {
        enabled: true,
        webhookUrl: 'https://alerts.example.com/webhook',
        criticalEvents: ['permission.denied'],
      },
    );

    await store.log({
      tenantId: 'tenant-1',
      eventType: 'permission.denied',
      actor: 'user-1',
      actorType: 'user',
      resourceType: 'session',
      resourceId: 'session-1',
      environment: 'production',
      action: 'Permission denied for session access',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://alerts.example.com/webhook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('"eventType":"permission.denied"'),
    });
  });

  test('dispatches Slack alerts for critical events', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const store = new InMemoryAuditStore(
      { type: 'memory' },
      {
        enabled: true,
        slackWebhook: 'https://hooks.slack.com/services/test',
        criticalEvents: ['rate_limit.hit'],
      },
    );

    await store.log({
      tenantId: 'tenant-1',
      eventType: 'rate_limit.hit',
      actor: 'system',
      actorType: 'system',
      resourceType: 'session',
      resourceId: 'session-2',
      environment: 'staging',
      action: 'Rate limit exceeded for API client',
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith('https://hooks.slack.com/services/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: expect.stringContaining('Rate limit exceeded for API client'),
    });
  });

  test('dispatches both webhook and Slack alerts for configured critical events', async () => {
    fetchMock.mockResolvedValue({ ok: true });
    const store = new InMemoryAuditStore(
      { type: 'memory' },
      {
        enabled: true,
        webhookUrl: 'https://alerts.example.com/webhook',
        slackWebhook: 'https://hooks.slack.com/services/test',
        criticalEvents: ['permission.denied'],
      },
    );

    await store.log({
      tenantId: 'tenant-1',
      eventType: 'permission.denied',
      actor: 'user-9',
      actorType: 'user',
      resourceType: 'tool',
      resourceId: 'tool-1',
      environment: 'production',
      action: 'Permission denied for tool execution',
    });

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  test('isolates alert delivery failures from audit persistence', async () => {
    fetchMock.mockRejectedValue(new Error('network down'));
    const store = new InMemoryAuditStore(
      { type: 'memory' },
      {
        enabled: true,
        webhookUrl: 'https://alerts.example.com/webhook',
        slackWebhook: 'https://hooks.slack.com/services/test',
        criticalEvents: [],
      },
    );

    await expect(
      store.log({
        tenantId: 'tenant-1',
        eventType: 'agent.rolled_back',
        actor: 'admin-1',
        actorType: 'admin',
        resourceType: 'agent',
        resourceId: 'agent-1',
        environment: 'production',
        action: 'Rollback triggered after failed deployment',
      }),
    ).resolves.toMatchObject({
      eventType: 'agent.rolled_back',
      actor: 'admin-1',
    });

    const result = await store.query({
      tenantId: 'tenant-1',
      startTime: new Date('2026-01-01T00:00:00.000Z'),
      endTime: new Date('2027-01-01T00:00:00.000Z'),
    });

    expect(result.total).toBe(1);
    expect(result.logs[0]).toMatchObject({
      eventType: 'agent.rolled_back',
      actor: 'admin-1',
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
