import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockPublishStudioAuditPipelineEvent, mockQueryStudioAuditLogsFromClickHouse } = vi.hoisted(
  () => ({
    mockPublishStudioAuditPipelineEvent: vi.fn(),
    mockQueryStudioAuditLogsFromClickHouse: vi.fn(),
  }),
);

vi.mock('@/lib/studio-audit-pipeline-writer', () => ({
  publishStudioAuditPipelineEvent: (...args: unknown[]) =>
    mockPublishStudioAuditPipelineEvent(...args),
}));

vi.mock('@/lib/studio-clickhouse-audit-reader', () => ({
  queryStudioAuditLogsFromClickHouse: (...args: unknown[]) =>
    mockQueryStudioAuditLogsFromClickHouse(...args),
}));

describe('studio audit service', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPublishStudioAuditPipelineEvent.mockReset();
    mockQueryStudioAuditLogsFromClickHouse.mockResolvedValue({ logs: [], total: 0 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  test('sanitizes sensitive metadata and publishes canonical shared audit fields', async () => {
    const { logAuditEvent, AuditActions } = await import('@/services/audit-service');

    await logAuditEvent({
      userId: 'user-1',
      tenantId: 'tenant-1',
      action: AuditActions.CREDENTIAL_CREATED,
      ip: '127.0.0.1',
      userAgent: 'vitest',
      metadata: {
        password: 'super-secret',
        sessionToken: 'token-value',
        projectId: 'project-1',
        resourceType: 'credential',
        resourceId: 'credential-1',
        traceId: 'trace-1',
        environment: 'production',
        safe: 'keep-me',
      },
    });

    expect(mockPublishStudioAuditPipelineEvent).toHaveBeenCalledTimes(1);
    const [pipelineEvent, tenantId] = mockPublishStudioAuditPipelineEvent.mock.calls[0];

    expect(tenantId).toBe('tenant-1');
    expect(pipelineEvent).toMatchObject({
      stream: 'shared',
      source: 'studio',
      eventType: AuditActions.CREDENTIAL_CREATED,
      action: AuditActions.CREDENTIAL_CREATED,
      actorId: 'user-1',
      actorType: 'user',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      resourceType: 'credential',
      resourceId: 'credential-1',
      traceId: 'trace-1',
      environment: 'production',
      ipAddress: '127.0.0.1',
      metadataEncoding: 'object',
      retentionClass: 'crud',
      metadata: {
        password: '[REDACTED]',
        sessionToken: '[REDACTED]',
        safe: 'keep-me',
        projectId: 'project-1',
        resourceType: 'credential',
        resourceId: 'credential-1',
        traceId: 'trace-1',
        environment: 'production',
      },
    });
    expect(pipelineEvent.auditId).toEqual(expect.any(String));
    expect(pipelineEvent.timestamp).toBeInstanceOf(Date);
  });

  test('audit publish failures stay non-fatal and emit fallback stderr output', async () => {
    const stderrWriteSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    mockPublishStudioAuditPipelineEvent.mockImplementation(() => {
      throw new Error('producer unavailable');
    });

    const { logAuditEvent, AuditActions } = await import('@/services/audit-service');

    await expect(
      logAuditEvent({
        action: AuditActions.LOGIN,
        userId: 'user-2',
        metadata: { safe: 'value' },
      }),
    ).resolves.toBeUndefined();

    expect(stderrWriteSpy).toHaveBeenCalledTimes(1);
    expect(stderrWriteSpy.mock.calls[0][0]).toContain('"type":"audit_fallback"');
    expect(stderrWriteSpy.mock.calls[0][0]).toContain('producer unavailable');
  });

  test('normalizes forwarded IP chains before publishing the audit record', async () => {
    const { logAuditEvent, AuditActions } = await import('@/services/audit-service');

    await logAuditEvent({
      userId: 'user-3',
      tenantId: 'tenant-3',
      action: AuditActions.LOGIN,
      ip: '198.51.100.10, 10.0.0.5',
    });

    expect(mockPublishStudioAuditPipelineEvent).toHaveBeenCalledTimes(1);
    const [pipelineEvent] = mockPublishStudioAuditPipelineEvent.mock.calls[0];
    expect(pipelineEvent.ipAddress).toBe('10.0.0.5');
  });

  test('records invitation acceptance and member join when acceptance creates membership', async () => {
    const { logWorkspaceInvitationAcceptanceAudit, AuditActions } =
      await import('@/services/audit-service');

    await logWorkspaceInvitationAcceptanceAudit({
      userId: 'user-joined',
      tenantId: 'tenant-1',
      role: 'MEMBER',
      membershipCreated: true,
      invitationId: 'inv-1',
      acceptMethod: 'picker',
      ip: '203.0.113.10',
      userAgent: 'vitest',
    });

    expect(mockPublishStudioAuditPipelineEvent).toHaveBeenCalledTimes(2);
    expect(mockPublishStudioAuditPipelineEvent.mock.calls[0][0]).toMatchObject({
      action: AuditActions.INVITATION_ACCEPTED,
      actorId: 'user-joined',
      tenantId: 'tenant-1',
      resourceType: 'invitation',
      resourceId: 'inv-1',
      metadata: expect.objectContaining({
        role: 'MEMBER',
        acceptMethod: 'picker',
        membershipCreated: true,
      }),
    });
    expect(mockPublishStudioAuditPipelineEvent.mock.calls[1][0]).toMatchObject({
      action: AuditActions.MEMBER_JOINED,
      actorId: 'user-joined',
      tenantId: 'tenant-1',
      resourceType: 'tenant_member',
      resourceId: 'user-joined',
      metadata: expect.objectContaining({
        role: 'MEMBER',
        acceptMethod: 'picker',
        source: 'invitation',
      }),
    });
  });

  test('does not record member join when accepting an invitation for an existing member', async () => {
    const { logWorkspaceInvitationAcceptanceAudit, AuditActions } =
      await import('@/services/audit-service');

    await logWorkspaceInvitationAcceptanceAudit({
      userId: 'user-existing',
      tenantId: 'tenant-1',
      role: 'ADMIN',
      membershipCreated: false,
      invitationId: 'inv-2',
      acceptMethod: 'auto',
    });

    expect(mockPublishStudioAuditPipelineEvent).toHaveBeenCalledTimes(1);
    expect(mockPublishStudioAuditPipelineEvent.mock.calls[0][0]).toMatchObject({
      action: AuditActions.INVITATION_ACCEPTED,
      actorId: 'user-existing',
      resourceType: 'invitation',
      resourceId: 'inv-2',
      metadata: expect.objectContaining({
        role: 'ADMIN',
        acceptMethod: 'auto',
        membershipCreated: false,
      }),
    });
  });

  test('getUserAuditLogs queries ClickHouse with tenant-safe personal scope', async () => {
    const mockLogs = [{ id: 'log-1', actor: 'user-1', action: 'login' }];
    mockQueryStudioAuditLogsFromClickHouse.mockResolvedValueOnce({
      logs: mockLogs,
      total: 1,
    });

    const { getUserAuditLogs } = await import('@/services/audit-service');
    const result = await getUserAuditLogs('user-1', 'tenant-1');

    expect(result).toEqual(mockLogs);
    expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith({
      scope: 'personal',
      personalScopeMode: 'tenant-safe',
      userId: 'user-1',
      tenantId: 'tenant-1',
      action: undefined,
      from: undefined,
      to: undefined,
      limit: 50,
      offset: 0,
    });
  });

  test('getRecentAuditLogs queries ClickHouse with workspace scope', async () => {
    const mockLogs = [{ id: 'log-2', actor: 'user-2', action: 'login' }];
    const since = new Date('2026-01-01T00:00:00.000Z');
    mockQueryStudioAuditLogsFromClickHouse.mockResolvedValueOnce({
      logs: mockLogs,
      total: 1,
    });

    const { getRecentAuditLogs } = await import('@/services/audit-service');
    const result = await getRecentAuditLogs('tenant-1', {
      limit: 25,
      action: 'login',
      since,
    });

    expect(result).toEqual(mockLogs);
    expect(mockQueryStudioAuditLogsFromClickHouse).toHaveBeenCalledWith({
      scope: 'workspace',
      personalScopeMode: 'tenant-safe',
      userId: '',
      tenantId: 'tenant-1',
      action: 'login',
      from: since.toISOString(),
      to: null,
      limit: 25,
      offset: 0,
    });
  });
});
