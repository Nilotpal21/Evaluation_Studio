import { afterAll, beforeEach, describe, expect, test, vi } from 'vitest';

const { mockStoreLog, mockGetAuditStore } = vi.hoisted(() => ({
  mockStoreLog: vi.fn(),
  mockGetAuditStore: vi.fn(),
}));

vi.mock('../services/audit-store-singleton.js', () => ({
  getAuditStore: () => mockGetAuditStore(),
}));

describe('audit helpers', () => {
  const originalNodeEnv = process.env.NODE_ENV;

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    process.env.NODE_ENV = 'test';
    mockGetAuditStore.mockReturnValue({ log: mockStoreLog });
    mockStoreLog.mockResolvedValue(undefined);
  });

  test('uses the current runtime environment instead of a hardcoded dev label', async () => {
    process.env.NODE_ENV = 'production';

    const { auditContactCreated } = await import('../services/audit-helpers.js');

    await auditContactCreated(
      {
        id: 'contact-1',
        tenantId: 'tenant-1',
        type: 'lead',
        identityType: 'email',
      } as any,
      'user-1',
    );

    expect(mockStoreLog).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contact.created',
        environment: 'production',
      }),
    );
  });

  test('writes workflow execution audit with top-level tenant and project scope', async () => {
    const { auditWorkflowExecuted } = await import('../services/audit-helpers.js');

    await auditWorkflowExecuted(
      {
        tenantId: 'tenant-workflow',
        projectId: 'project-workflow',
        workflowId: 'workflow-1',
        executionId: 'exec-1',
        mode: 'async',
        workflowVersion: 'v1',
        workflowVersionId: 'version-1',
        apiKeyId: 'api-key-1',
      },
      'system-user',
    );

    expect(mockStoreLog).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-workflow',
        projectId: 'project-workflow',
        action: 'workflow.executed',
        resourceId: 'workflow-1',
      }),
    );
  });

  afterAll(() => {
    process.env.NODE_ENV = originalNodeEnv;
  });
});
