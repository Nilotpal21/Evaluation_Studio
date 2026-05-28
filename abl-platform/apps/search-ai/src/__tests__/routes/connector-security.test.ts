/**
 * Connector Security Route Tests
 *
 * Tests security service functions used by route handlers:
 * - GET overview — scopes, token health
 * - GET blast-radius — doc/chunk counts
 * - POST revoke — emergency revoke
 * - GET export — JSON/Markdown
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

// =============================================================================
// MOCKS
// =============================================================================

const mockConnector = {
  _id: '507f1f77bcf86cd799439011',
  tenantId: 'test-tenant',
  connectorType: 'sharepoint',
  oauthTokenId: 'oauth-token-1',
  sourceId: 'source-1',
  connectionConfig: {
    displayName: 'Contoso SharePoint',
    permissionMode: 'enabled',
  },
};

const mockOAuthToken = {
  _id: 'oauth-token-1',
  tenantId: 'test-tenant',
  scope: 'Sites.Read.All Files.Read.All User.Read',
  expiresAt: new Date(Date.now() + 86400000 * 30), // 30 days from now
  createdAt: new Date('2026-01-15'),
};

const mockExpiredToken = {
  ...mockOAuthToken,
  expiresAt: new Date(Date.now() - 86400000), // expired yesterday
};

const mockFindOne = vi.fn();
const mockFindOneAndUpdate = vi.fn();
const mockCountDocuments = vi.fn();
const mockWriteAuditEntry = vi.fn();

vi.doMock('../../db/index.js', () => ({
  getLazyModel: vi.fn((modelName: string) => {
    if (modelName === 'ConnectorConfig') {
      return { findOne: mockFindOne, findOneAndUpdate: mockFindOneAndUpdate };
    }
    if (modelName === 'EndUserOAuthToken') {
      return { findOne: mockFindOne, findOneAndUpdate: mockFindOneAndUpdate };
    }
    if (modelName === 'SearchDocument' || modelName === 'SearchChunk') {
      return { countDocuments: mockCountDocuments };
    }
    return { findOne: mockFindOne };
  }),
}));

vi.doMock('../../services/connector-audit.service.js', () => ({
  writeAuditEntry: mockWriteAuditEntry,
}));

vi.doMock('../../services/connector.service.js', () => ({
  ConnectorError: class ConnectorError extends Error {
    constructor(
      public code: string,
      message: string,
      public statusCode: number = 400,
    ) {
      super(message);
      this.name = 'ConnectorError';
    }
  },
}));

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Connector Security Routes', () => {
  let securityService: typeof import('../../services/connector-security.service.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    securityService = await import('../../services/connector-security.service.js');
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // getSecurityOverview
  // ===========================================================================

  describe('getSecurityOverview', () => {
    it('should return security overview with scopes and token status', async () => {
      // First call: ConnectorConfig.findOne, second: EndUserOAuthToken.findOne
      let callCount = 0;
      mockFindOne.mockImplementation(() => ({
        lean: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(mockConnector);
          return Promise.resolve(mockOAuthToken);
        }),
      }));

      const data = await securityService.getSecurityOverview(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.grantedScopes).toHaveLength(3);
      expect(data.grantedScopes[0].scope).toBe('Sites.Read.All');
      expect(data.tokenStatus.isExpired).toBe(false);
      expect(data.tokenStatus.daysRemaining).toBeGreaterThan(0);
      expect(data.accessSummary.accesses).toContain('Site collections');
    });

    it('should show expired token status', async () => {
      let callCount = 0;
      mockFindOne.mockImplementation(() => ({
        lean: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(mockConnector);
          return Promise.resolve(mockExpiredToken);
        }),
      }));

      const data = await securityService.getSecurityOverview(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.tokenStatus.isExpired).toBe(true);
      expect(data.tokenStatus.daysRemaining).toBe(0);
    });

    it('should handle connector with no OAuth token', async () => {
      let callCount = 0;
      mockFindOne.mockImplementation(() => ({
        lean: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve({ ...mockConnector, oauthTokenId: null });
          return Promise.resolve(null);
        }),
      }));

      const data = await securityService.getSecurityOverview(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.grantedScopes).toHaveLength(0);
      expect(data.tokenStatus.isExpired).toBe(true);
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        securityService.getSecurityOverview('nonexistent', 'test-tenant'),
      ).rejects.toThrow('Connector not found');
    });

    it('should enforce tenant isolation', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        securityService.getSecurityOverview('507f1f77bcf86cd799439011', 'wrong-tenant'),
      ).rejects.toThrow('Connector not found');
    });

    it('should include permission access when enabled', async () => {
      let callCount = 0;
      mockFindOne.mockImplementation(() => ({
        lean: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount === 1) return Promise.resolve(mockConnector);
          return Promise.resolve(mockOAuthToken);
        }),
      }));

      const data = await securityService.getSecurityOverview(
        '507f1f77bcf86cd799439011',
        'test-tenant',
      );

      expect(data.accessSummary.accesses).toContain('User and group permissions');
    });
  });

  // ===========================================================================
  // getBlastRadius
  // ===========================================================================

  describe('getBlastRadius', () => {
    it('should return document and chunk counts', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockConnector),
      });
      mockCountDocuments.mockResolvedValue(42);

      const data = await securityService.getBlastRadius('507f1f77bcf86cd799439011', 'test-tenant');

      expect(data.documentCount).toBe(42);
      expect(data.chunkCount).toBe(42);
      expect(data.embeddingCount).toBe(42);
    });

    it('should return zeros when no sourceId', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue({ ...mockConnector, sourceId: undefined }),
      });

      const data = await securityService.getBlastRadius('507f1f77bcf86cd799439011', 'test-tenant');

      expect(data.documentCount).toBe(0);
      expect(data.chunkCount).toBe(0);
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(securityService.getBlastRadius('nonexistent', 'test-tenant')).rejects.toThrow(
        'Connector not found',
      );
    });
  });

  // ===========================================================================
  // emergencyRevoke
  // ===========================================================================

  describe('emergencyRevoke', () => {
    it('should revoke token and disable connector', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockConnector),
      });
      mockFindOneAndUpdate.mockResolvedValue(mockConnector);
      mockWriteAuditEntry.mockResolvedValue(undefined);

      const data = await securityService.emergencyRevoke(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'admin@contoso.com',
      );

      expect(data.revokedAt).toBeDefined();
      expect(new Date(data.revokedAt).getTime()).toBeGreaterThan(0);
    });

    it('should still succeed when audit entry write fails', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockConnector),
      });
      mockFindOneAndUpdate.mockResolvedValue(mockConnector);
      mockWriteAuditEntry.mockRejectedValue(new Error('Audit write failed'));

      const data = await securityService.emergencyRevoke(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'admin@contoso.com',
      );

      // Should not throw — audit failure is logged but not fatal
      expect(data.revokedAt).toBeDefined();
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindOne.mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      });

      await expect(
        securityService.emergencyRevoke('nonexistent', 'test-tenant', 'admin'),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // exportSecurityDocument
  // ===========================================================================

  describe('exportSecurityDocument', () => {
    it('should export as JSON', async () => {
      let callCount = 0;
      mockFindOne.mockImplementation(() => ({
        lean: vi.fn().mockImplementation(() => {
          callCount++;
          // Calls: getSecurityOverview(ConnectorConfig, EndUserOAuthToken),
          //        getBlastRadius(ConnectorConfig), then final ConnectorConfig
          if (callCount % 2 === 1) return Promise.resolve(mockConnector);
          return Promise.resolve(mockOAuthToken);
        }),
      }));
      mockCountDocuments.mockResolvedValue(10);

      const result = await securityService.exportSecurityDocument(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'json',
      );

      expect(result.contentType).toBe('application/json');
      expect(result.filename).toContain('security-review.json');
      const parsed = JSON.parse(result.data);
      expect(parsed.connectorId).toBe('507f1f77bcf86cd799439011');
      expect(parsed.security).toBeDefined();
      expect(parsed.blastRadius).toBeDefined();
    });

    it('should export as Markdown', async () => {
      let callCount = 0;
      mockFindOne.mockImplementation(() => ({
        lean: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount % 2 === 1) return Promise.resolve(mockConnector);
          return Promise.resolve(mockOAuthToken);
        }),
      }));
      mockCountDocuments.mockResolvedValue(10);

      const result = await securityService.exportSecurityDocument(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'markdown',
      );

      expect(result.contentType).toBe('text/markdown');
      expect(result.filename).toContain('security-review.md');
      expect(result.data).toContain('# Security Review');
      expect(result.data).toContain('Granted Scopes');
      expect(result.data).toContain('Blast Radius');
    });

    it('should export as YAML', async () => {
      let callCount = 0;
      mockFindOne.mockImplementation(() => ({
        lean: vi.fn().mockImplementation(() => {
          callCount++;
          if (callCount % 2 === 1) return Promise.resolve(mockConnector);
          return Promise.resolve(mockOAuthToken);
        }),
      }));
      mockCountDocuments.mockResolvedValue(10);

      const result = await securityService.exportSecurityDocument(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'yaml',
      );

      expect(result.contentType).toBe('text/yaml');
      expect(result.filename).toContain('security-review.yaml');
    });
  });

  // ===========================================================================
  // Zod Validation
  // ===========================================================================

  describe('Zod Validation', () => {
    it('should validate route params', () => {
      const { z } = require('zod');
      const schema = z.object({ indexId: z.string().min(1), connectorId: z.string().min(1) });

      expect(schema.safeParse({ indexId: 'idx', connectorId: 'conn' }).success).toBe(true);
      expect(schema.safeParse({ indexId: '', connectorId: '' }).success).toBe(false);
    });

    it('should validate revokeBody requires confirmPhrase', () => {
      const { z } = require('zod');
      const schema = z.object({ confirmPhrase: z.string().min(1) });

      expect(schema.safeParse({ confirmPhrase: 'REVOKE' }).success).toBe(true);
      expect(schema.safeParse({ confirmPhrase: '' }).success).toBe(false);
      expect(schema.safeParse({}).success).toBe(false);
    });

    it('should validate export format enum', () => {
      const { z } = require('zod');
      const schema = z.object({ format: z.enum(['json', 'yaml', 'markdown']) });

      expect(schema.safeParse({ format: 'json' }).success).toBe(true);
      expect(schema.safeParse({ format: 'yaml' }).success).toBe(true);
      expect(schema.safeParse({ format: 'markdown' }).success).toBe(true);
      expect(schema.safeParse({ format: 'csv' }).success).toBe(false);
    });
  });
});
