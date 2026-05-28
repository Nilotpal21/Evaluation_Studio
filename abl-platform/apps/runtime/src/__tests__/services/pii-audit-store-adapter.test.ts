import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockWriteAuditEvent } = vi.hoisted(() => ({
  mockWriteAuditEvent: vi.fn(async () => {}),
}));

vi.mock('../../services/audit-store-singleton.js', () => ({
  getAuditStore: vi.fn(),
  writeAuditEvent: (...args: unknown[]) => mockWriteAuditEvent(...args),
}));

describe('RuntimePIIAuditStore', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  test('emits pii audit entries into the runtime audit pipeline', async () => {
    const { getAuditStore } = await import('../../services/execution/pii-audit-store-adapter.js');

    await getAuditStore().insert({
      tenantId: 'tenant-a',
      projectId: 'project-a',
      sessionId: 'session-1',
      tokenId: 'token-1',
      piiType: 'email',
      consumer: 'tools',
      action: 'render',
      metadata: {
        renderMode: 'masked',
        toolName: 'lookup-contact',
      },
      expireAt: new Date('2026-07-22T09:31:00.000Z'),
    });

    expect(mockWriteAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockWriteAuditEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        stream: 'pii',
        source: 'runtime-store',
        eventType: 'pii.accessed',
        action: 'render',
        tenantId: 'tenant-a',
        projectId: 'project-a',
        actorId: 'tools',
        actorType: 'system',
        resourceType: 'pii_token',
        resourceId: 'token-1',
        expiresAt: new Date('2026-07-22T09:31:00.000Z'),
        metadata: expect.objectContaining({
          sessionId: 'session-1',
          tokenId: 'token-1',
          piiType: 'email',
          consumer: 'tools',
          renderMode: 'masked',
          toolName: 'lookup-contact',
        }),
      }),
    );
  });
});
