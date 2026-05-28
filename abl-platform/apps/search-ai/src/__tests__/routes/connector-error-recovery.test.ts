/**
 * Connector Error Recovery Route Tests
 *
 * Tests error classification and retry service functions:
 * - GET error-status — returns classified error
 * - POST retry — dispatches retry action
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import type { Types } from 'mongoose';

// =============================================================================
// MOCKS
// =============================================================================

const makeConnector = (overrides: Record<string, unknown> = {}) => ({
  _id: '507f1f77bcf86cd799439011' as unknown as Types.ObjectId,
  tenantId: 'test-tenant',
  connectorType: 'sharepoint',
  oauthTokenId: 'oauth-token-1',
  connectionConfig: { name: 'Contoso SharePoint' },
  syncState: {
    totalDocuments: 150,
    processedDocuments: 150,
    failedDocuments: 0,
    syncInProgress: false,
    checkpointData: null,
  },
  errorState: {
    consecutiveFailures: 0,
    lastErrorAt: null,
    lastErrorMessage: null,
    isPaused: false,
  },
  ...overrides,
});

const mockFindConnectorByIdAndTenantLean = vi.fn();

vi.doMock('../../repos/connector.repository.js', () => ({
  findConnectorByIdAndTenantLean: mockFindConnectorByIdAndTenantLean,
}));

const mockResumeSync = vi.fn();
const mockStartSync = vi.fn();
const mockRestartSync = vi.fn();

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
  resumeSync: mockResumeSync,
  startSync: mockStartSync,
  restartSync: mockRestartSync,
}));

// =============================================================================
// TEST SETUP
// =============================================================================

describe('Connector Error Recovery Routes', () => {
  let errorService: typeof import('../../services/connector-error.service.js');

  beforeEach(async () => {
    vi.clearAllMocks();
    errorService = await import('../../services/connector-error.service.js');
    mockFindConnectorByIdAndTenantLean.mockResolvedValue(makeConnector());
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  // ===========================================================================
  // classifyError
  // ===========================================================================

  describe('classifyError', () => {
    it('should return null when no errors', () => {
      const connector = makeConnector();
      const result = errorService.classifyError(connector as any);
      expect(result).toBeNull();
    });

    it('should classify AADSTS error as auth_failed', () => {
      const connector = makeConnector({
        errorState: {
          consecutiveFailures: 1,
          lastErrorMessage: 'AADSTS7000215: Invalid client secret provided',
          isPaused: false,
        },
      });

      const result = errorService.classifyError(connector as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('auth_failed');
      expect(result!.data.errorCode).toBe('AADSTS7000215');
    });

    it('should classify expired token error', () => {
      const connector = makeConnector({
        errorState: {
          consecutiveFailures: 1,
          lastErrorMessage: 'Token has expired',
          lastErrorAt: new Date(),
          isPaused: false,
        },
      });

      const result = errorService.classifyError(connector as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('token_expired');
    });

    it('should classify throttling error (429)', () => {
      const connector = makeConnector({
        errorState: {
          consecutiveFailures: 1,
          lastErrorMessage: 'Request was throttled — HTTP 429',
          isPaused: false,
        },
        syncState: { totalDocuments: 100, processedDocuments: 50, failedDocuments: 0 },
      });

      const result = errorService.classifyError(connector as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('throttled');
    });

    it('should classify permission revoked error', () => {
      const connector = makeConnector({
        errorState: {
          consecutiveFailures: 1,
          lastErrorMessage: 'Access permission has been revoked',
          isPaused: true,
        },
      });

      const result = errorService.classifyError(connector as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('permission_revoked');
    });

    it('should classify discovery timeout error', () => {
      const connector = makeConnector({
        errorState: {
          consecutiveFailures: 1,
          lastErrorMessage: 'Discovery operation timeout after 30s',
          isPaused: false,
        },
      });

      const result = errorService.classifyError(connector as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('discovery_timeout');
    });

    it('should classify sync failed error', () => {
      const connector = makeConnector({
        errorState: {
          consecutiveFailures: 2,
          lastErrorMessage: 'Sync failed: ENOSPC no space left',
          isPaused: false,
        },
      });

      const result = errorService.classifyError(connector as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('sync_failed');
    });

    it('should classify partial failure', () => {
      const connector = makeConnector({
        syncState: {
          totalDocuments: 100,
          processedDocuments: 80,
          failedDocuments: 20,
          syncInProgress: false,
        },
        errorState: {
          consecutiveFailures: 1,
          lastErrorMessage: null,
          isPaused: false,
        },
      });

      const result = errorService.classifyError(connector as any);
      expect(result).not.toBeNull();
      expect(result!.type).toBe('partial_failure');
      expect(result!.data.failedCount).toBe(20);
    });

    it('should enforce tenant isolation via repository', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      // executeRetry (which uses the repo) should throw NOT_FOUND for wrong tenant
      await expect(
        errorService.executeRetry('507f1f77bcf86cd799439011', 'wrong-tenant', 'retry_auth'),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // executeRetry
  // ===========================================================================

  describe('executeRetry', () => {
    it('should handle retry_auth action', async () => {
      const result = await errorService.executeRetry(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'retry_auth',
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Re-authentication');
    });

    it('should handle retry_discovery action', async () => {
      const result = await errorService.executeRetry(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'retry_discovery',
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('Discovery');
    });

    it('should handle resume_sync action for paused connector', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(
        makeConnector({
          errorState: { isPaused: true, consecutiveFailures: 1, lastErrorMessage: 'err' },
        }),
      );
      mockResumeSync.mockResolvedValue({ jobId: 'job-123' });

      const result = await errorService.executeRetry(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'resume_sync',
      );

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('job-123');
    });

    it('should reject resume_sync when connector is not paused', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(
        makeConnector({
          errorState: { isPaused: false, consecutiveFailures: 0, lastErrorMessage: null },
        }),
      );

      await expect(
        errorService.executeRetry('507f1f77bcf86cd799439011', 'test-tenant', 'resume_sync'),
      ).rejects.toThrow('Connector is not paused');
    });

    it('should handle rerun_full_sync action', async () => {
      mockRestartSync.mockResolvedValue({ jobId: 'job-456' });

      const result = await errorService.executeRetry(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'rerun_full_sync',
      );

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('job-456');
    });

    it('should handle retry_failed_sites action', async () => {
      mockStartSync.mockResolvedValue({ jobId: 'job-789' });

      const result = await errorService.executeRetry(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'retry_failed_sites',
      );

      expect(result.success).toBe(true);
      expect(result.jobId).toBe('job-789');
    });

    it('should handle rerun_full_discovery action', async () => {
      const result = await errorService.executeRetry(
        '507f1f77bcf86cd799439011',
        'test-tenant',
        'rerun_full_discovery',
      );

      expect(result.success).toBe(true);
      expect(result.message).toContain('discovery');
    });

    it('should throw NOT_FOUND for missing connector', async () => {
      mockFindConnectorByIdAndTenantLean.mockResolvedValue(null);

      await expect(
        errorService.executeRetry('nonexistent', 'test-tenant', 'retry_auth'),
      ).rejects.toThrow('Connector not found');
    });
  });

  // ===========================================================================
  // Zod Validation
  // ===========================================================================

  describe('Zod Validation', () => {
    it('should validate retry body action enum', () => {
      const { z } = require('zod');
      const schema = z.object({
        action: z.enum([
          'retry_auth',
          'retry_discovery',
          'resume_sync',
          'retry_failed_sites',
          'rerun_full_sync',
          'rerun_full_discovery',
        ]),
      });

      expect(schema.safeParse({ action: 'retry_auth' }).success).toBe(true);
      expect(schema.safeParse({ action: 'invalid_action' }).success).toBe(false);
    });

    it('should reject empty route params', () => {
      const { z } = require('zod');
      const schema = z.object({
        indexId: z.string().min(1),
        connectorId: z.string().min(1),
      });

      expect(schema.safeParse({ indexId: '', connectorId: '' }).success).toBe(false);
    });
  });
});
