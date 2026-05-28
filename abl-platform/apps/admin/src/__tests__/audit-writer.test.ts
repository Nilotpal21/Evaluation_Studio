import { beforeEach, describe, expect, test, vi } from 'vitest';

const { mockPublishAdminAuditPipelineEvent } = vi.hoisted(() => ({
  mockPublishAdminAuditPipelineEvent: vi.fn(),
}));

vi.mock('../lib/admin-audit-pipeline-writer', () => ({
  publishAdminAuditPipelineEvent: (...args: unknown[]) =>
    mockPublishAdminAuditPipelineEvent(...args),
}));

describe('admin audit writer', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  test('publishes admin audit events to Kafka', async () => {
    const { logAdminAction } = await import('../lib/audit-logger');
    await logAdminAction({
      actor: 'admin-1',
      actorRole: 'ADMIN',
      action: 'secret_rotate',
      target: 'secrets/prod/api-key',
      environment: 'production',
      ipAddress: '10.0.0.1',
      metadata: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        traceId: 'trace-1',
      },
    });

    expect(mockPublishAdminAuditPipelineEvent).toHaveBeenCalledTimes(1);
    const [pipelineEvent, tenantId] = mockPublishAdminAuditPipelineEvent.mock.calls[0];

    expect(tenantId).toBe('tenant-1');
    expect(pipelineEvent).toMatchObject({
      stream: 'shared',
      source: 'admin',
      eventType: 'secret_rotate',
      action: 'secret_rotate',
      actorId: 'admin-1',
      actorType: 'admin',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'secret',
      resourceId: 'secrets/prod/api-key',
      environment: 'production',
      traceId: 'trace-1',
      ipAddress: '10.0.0.1',
      metadataEncoding: 'object',
      retentionClass: 'crud',
      metadata: {
        tenantId: 'tenant-1',
        projectId: 'project-1',
        traceId: 'trace-1',
        target: 'secrets/prod/api-key',
        actorRole: 'ADMIN',
      },
    });
    expect(pipelineEvent.auditId).toEqual(expect.any(String));
    expect(pipelineEvent.timestamp).toBeInstanceOf(Date);
  });

  test('does not throw when pipeline publish throws synchronously', async () => {
    mockPublishAdminAuditPipelineEvent.mockImplementation(() => {
      throw new Error('producer unavailable');
    });

    const { logAdminAction } = await import('../lib/audit-logger');
    await expect(
      logAdminAction({
        actor: 'admin-2',
        actorRole: 'VIEWER',
        action: 'secret_list',
        target: 'secrets/shared',
        environment: 'dev',
      }),
    ).resolves.toBeUndefined();

    expect(mockPublishAdminAuditPipelineEvent).toHaveBeenCalledTimes(1);
  });
});
