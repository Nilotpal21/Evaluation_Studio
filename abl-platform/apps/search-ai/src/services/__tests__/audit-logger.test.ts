import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  logCustomDomainCreated,
  logCustomDomainAccessed,
  logCustomDomainDeleted,
  logTaxonomyRefined,
  logTaxonomyRolledBack,
  getAuditLogsForResource,
  getAuditLogsForUser,
  getRecentAuditLogs,
} from '../audit-logger.js';

const {
  mockBuildSearchAIAuditPipelineEvent,
  mockPublishSearchAIAuditPipelineEvent,
  mockQuerySearchAIAuditLogsFromClickHouse,
  mockLogger,
} = vi.hoisted(() => ({
  mockBuildSearchAIAuditPipelineEvent: vi.fn((input) => ({ ...input, auditId: 'audit-1' })),
  mockPublishSearchAIAuditPipelineEvent: vi.fn(),
  mockQuerySearchAIAuditLogsFromClickHouse: vi.fn(),
  mockLogger: {
    info: vi.fn(),
    error: vi.fn(),
  },
}));

vi.mock('../search-ai-audit-pipeline-writer.js', () => ({
  buildSearchAIAuditPipelineEvent: mockBuildSearchAIAuditPipelineEvent,
  publishSearchAIAuditPipelineEvent: mockPublishSearchAIAuditPipelineEvent,
}));

vi.mock('../search-ai-clickhouse-audit-reader.js', () => ({
  querySearchAIAuditLogsFromClickHouse: mockQuerySearchAIAuditLogsFromClickHouse,
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => mockLogger),
}));

describe('Audit Logger', () => {
  const mockTenantId = 'tenant-123';
  const mockUserId = 'user-456';
  const mockDomainId = 'domain-789';
  const mockTaxonomyId = 'taxonomy-abc';
  const mockIndexId = 'index-def';

  beforeEach(() => {
    mockBuildSearchAIAuditPipelineEvent.mockReset();
    mockBuildSearchAIAuditPipelineEvent.mockImplementation((input) => ({
      ...input,
      auditId: 'audit-1',
    }));
    mockPublishSearchAIAuditPipelineEvent.mockReset();
    mockQuerySearchAIAuditLogsFromClickHouse.mockReset();
    mockLogger.info.mockReset();
    mockLogger.error.mockReset();
  });

  describe('logCustomDomainCreated', () => {
    it('logs custom domain creation with all fields', async () => {
      await logCustomDomainCreated({
        tenantId: mockTenantId,
        userId: mockUserId,
        domainId: mockDomainId,
        domainName: 'b2b-saas-hr',
        industry: 'B2B SaaS',
        generatedByLLM: true,
        ipAddress: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
      });

      expect(mockBuildSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'custom_domain_created',
          action: 'custom_domain.create',
          actorId: mockUserId,
          tenantId: mockTenantId,
          resourceType: 'custom_domain',
          resourceId: mockDomainId,
          ipAddress: '1.2.3.4',
          userAgent: 'Mozilla/5.0',
          metadata: {
            eventType: 'custom_domain_created',
            resourceType: 'custom_domain',
            resourceId: mockDomainId,
            domainName: 'b2b-saas-hr',
            industry: 'B2B SaaS',
            generatedByLLM: true,
          },
        }),
      );
      expect(mockPublishSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({ auditId: 'audit-1' }),
        mockTenantId,
      );
      expect(mockLogger.info).toHaveBeenCalledWith(
        'Audit event logged',
        expect.objectContaining({
          eventType: 'custom_domain_created',
          tenantId: mockTenantId,
          userId: mockUserId,
        }),
      );
    });

    it('does not throw on audit logging failure', async () => {
      mockPublishSearchAIAuditPipelineEvent.mockImplementation(() => {
        throw new Error('Kafka error');
      });

      await expect(
        logCustomDomainCreated({
          tenantId: mockTenantId,
          userId: mockUserId,
          domainId: mockDomainId,
          domainName: 'test',
          industry: 'Test',
          generatedByLLM: false,
        }),
      ).resolves.not.toThrow();

      expect(mockLogger.error).toHaveBeenCalledWith(
        'Failed to log audit event',
        expect.objectContaining({ error: 'Kafka error' }),
      );
    });
  });

  describe('other write helpers', () => {
    it('logs custom domain access', async () => {
      await logCustomDomainAccessed({
        tenantId: mockTenantId,
        userId: mockUserId,
        domainId: mockDomainId,
        domainName: 'test-domain',
        ipAddress: '1.2.3.4',
        userAgent: 'Mozilla/5.0',
      });

      expect(mockBuildSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'custom_domain_accessed',
          action: 'custom_domain.read',
          resourceId: mockDomainId,
        }),
      );
    });

    it('logs custom domain deletion', async () => {
      await logCustomDomainDeleted({
        tenantId: mockTenantId,
        userId: mockUserId,
        domainId: mockDomainId,
        domainName: 'test-domain',
      });

      expect(mockBuildSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'custom_domain_deleted',
          action: 'custom_domain.delete',
          resourceId: mockDomainId,
        }),
      );
    });

    it('logs taxonomy refinement', async () => {
      await logTaxonomyRefined({
        tenantId: mockTenantId,
        userId: mockUserId,
        taxonomyId: mockTaxonomyId,
        indexId: mockIndexId,
        refinementAction: 'add-product',
        affectedDocCount: 23,
        estimatedCost: 0.028,
      });

      expect(mockBuildSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'taxonomy_refined',
          action: 'taxonomy.update',
          resourceId: mockTaxonomyId,
          metadata: expect.objectContaining({
            indexId: mockIndexId,
            refinementAction: 'add-product',
            affectedDocCount: 23,
            estimatedCost: 0.028,
          }),
        }),
      );
    });

    it('logs taxonomy rollback', async () => {
      await logTaxonomyRolledBack({
        tenantId: mockTenantId,
        userId: mockUserId,
        taxonomyId: mockTaxonomyId,
        indexId: mockIndexId,
        targetVersion: '1.0.0',
        rollbackReason: 'Accuracy degraded',
      });

      expect(mockBuildSearchAIAuditPipelineEvent).toHaveBeenCalledWith(
        expect.objectContaining({
          eventType: 'taxonomy_rolled_back',
          action: 'taxonomy.update',
          resourceId: mockTaxonomyId,
          metadata: expect.objectContaining({
            indexId: mockIndexId,
            targetVersion: '1.0.0',
            rollbackReason: 'Accuracy degraded',
          }),
        }),
      );
    });
  });

  describe('read helpers', () => {
    it('retrieves audit logs for a specific resource', async () => {
      mockQuerySearchAIAuditLogsFromClickHouse.mockResolvedValue([{ id: 'log-1' }]);

      const logs = await getAuditLogsForResource({
        tenantId: mockTenantId,
        resourceType: 'custom_domain',
        resourceId: mockDomainId,
        limit: 50,
      });

      expect(mockQuerySearchAIAuditLogsFromClickHouse).toHaveBeenCalledWith({
        tenantId: mockTenantId,
        resourceType: 'custom_domain',
        resourceId: mockDomainId,
        limit: 50,
      });
      expect(logs).toEqual([{ id: 'log-1' }]);
    });

    it('retrieves audit logs for a specific user', async () => {
      mockQuerySearchAIAuditLogsFromClickHouse.mockResolvedValue([]);

      await getAuditLogsForUser({
        tenantId: mockTenantId,
        userId: mockUserId,
      });

      expect(mockQuerySearchAIAuditLogsFromClickHouse).toHaveBeenCalledWith({
        tenantId: mockTenantId,
        actor: mockUserId,
        limit: 100,
      });
    });

    it('retrieves recent audit logs for tenant', async () => {
      mockQuerySearchAIAuditLogsFromClickHouse.mockResolvedValue([]);

      await getRecentAuditLogs({
        tenantId: mockTenantId,
      });

      expect(mockQuerySearchAIAuditLogsFromClickHouse).toHaveBeenCalledWith({
        tenantId: mockTenantId,
        eventType: undefined,
        limit: 100,
      });
    });

    it('filters by eventType when provided', async () => {
      mockQuerySearchAIAuditLogsFromClickHouse.mockResolvedValue([]);

      await getRecentAuditLogs({
        tenantId: mockTenantId,
        eventType: 'custom_domain_created',
        limit: 25,
      });

      expect(mockQuerySearchAIAuditLogsFromClickHouse).toHaveBeenCalledWith({
        tenantId: mockTenantId,
        eventType: 'custom_domain_created',
        limit: 25,
      });
    });
  });
});
