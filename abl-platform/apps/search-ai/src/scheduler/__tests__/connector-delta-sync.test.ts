/**
 * Connector Delta Sync Scheduler Tests
 *
 * Tests for the background job that triggers delta syncs for stale connectors.
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import { triggerStaleDeltaSyncs, cleanupOrphanedDeltaTokens } from '../connector-delta-sync.js';

// Mock database models
vi.mock('@agent-platform/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database')>();
  return {
    ...actual,
    ConnectorConfig: {
      find: vi.fn(),
      findOne: vi.fn(),
      updateOne: vi.fn(),
    },
    DriveDeltaToken: {
      countDocuments: vi.fn(),
      distinct: vi.fn(),
      deleteMany: vi.fn(),
      findOne: vi.fn().mockReturnValue({ lean: vi.fn() }),
    },
  };
});

// Import mocked models
import { ConnectorConfig, DriveDeltaToken } from '@agent-platform/database';

describe('Connector Delta Sync Scheduler', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('triggerStaleDeltaSyncs', () => {
    it('should trigger delta sync for stale connectors', async () => {
      // Mock stale connectors
      const mockConnectors = [
        {
          _id: 'connector-1',
          tenantId: 'tenant-1',
          syncState: {
            lastDeltaSyncAt: new Date(Date.now() - 2 * 60 * 60 * 1000), // 2 hours ago
            lastFullSyncAt: new Date(),
          },
          errorState: { isPaused: false },
        },
        {
          _id: 'connector-2',
          tenantId: 'tenant-1',
          syncState: {
            lastDeltaSyncAt: new Date(Date.now() - 3 * 60 * 60 * 1000), // 3 hours ago
            lastFullSyncAt: new Date(),
          },
          errorState: { isPaused: false },
        },
      ];

      vi.mocked(ConnectorConfig.find).mockResolvedValue(mockConnectors as any);
      vi.mocked(DriveDeltaToken.countDocuments).mockResolvedValue(5); // Has delta tokens
      vi.mocked(ConnectorConfig.updateOne).mockResolvedValue({ acknowledged: true } as any);

      // Execute
      const result = await triggerStaleDeltaSyncs();

      // Verify
      expect(result.processed).toBe(2);
      expect(result.succeeded).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);

      // Verify delta token check includes tenantId
      expect(DriveDeltaToken.countDocuments).toHaveBeenCalledTimes(2);
      expect(DriveDeltaToken.countDocuments).toHaveBeenCalledWith({
        connectorId: 'connector-1',
        tenantId: 'tenant-1',
      });
      expect(DriveDeltaToken.countDocuments).toHaveBeenCalledWith({
        connectorId: 'connector-2',
        tenantId: 'tenant-1',
      });

      // Verify update calls include tenantId
      expect(ConnectorConfig.updateOne).toHaveBeenCalledTimes(2);
      expect(ConnectorConfig.updateOne).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          $set: expect.objectContaining({
            'syncState.lastDeltaSyncAt': expect.any(Date),
            'errorState.consecutiveFailures': 0,
          }),
        }),
      );
    });

    it('should skip connectors without delta tokens', async () => {
      const mockConnectors = [
        {
          _id: 'connector-1',
          tenantId: 'tenant-1',
          syncState: {
            lastDeltaSyncAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
            lastFullSyncAt: new Date(),
          },
          errorState: { isPaused: false },
        },
      ];

      vi.mocked(ConnectorConfig.find).mockResolvedValue(mockConnectors as any);
      vi.mocked(DriveDeltaToken.countDocuments).mockResolvedValue(0); // No delta tokens

      // Execute
      const result = await triggerStaleDeltaSyncs();

      // Verify
      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(1);

      // Should not update connector
      expect(ConnectorConfig.updateOne).not.toHaveBeenCalled();
    });

    it('should skip paused connectors', async () => {
      const mockConnectors: any[] = [];

      vi.mocked(ConnectorConfig.find).mockResolvedValue(mockConnectors);

      // Execute
      const result = await triggerStaleDeltaSyncs();

      // Verify - query should filter out paused connectors
      expect(ConnectorConfig.find).toHaveBeenCalledWith(
        expect.objectContaining({
          'errorState.isPaused': false,
        }),
      );

      expect(result.processed).toBe(0);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(0);
      expect(result.skipped).toBe(0);
    });

    it('should skip connectors without completed full sync', async () => {
      const mockConnectors: any[] = [];

      vi.mocked(ConnectorConfig.find).mockResolvedValue(mockConnectors);

      // Execute
      await triggerStaleDeltaSyncs();

      // Verify - query should filter connectors without full sync
      expect(ConnectorConfig.find).toHaveBeenCalledWith(
        expect.objectContaining({
          'syncState.lastFullSyncAt': { $ne: null },
        }),
      );
    });

    it('should handle errors gracefully and record failures', async () => {
      const mockConnectors = [
        {
          _id: 'connector-1',
          tenantId: 'tenant-1',
          syncState: {
            lastDeltaSyncAt: new Date(Date.now() - 2 * 60 * 60 * 1000),
            lastFullSyncAt: new Date(),
          },
          errorState: { isPaused: false },
        },
      ];

      vi.mocked(ConnectorConfig.find).mockResolvedValue(mockConnectors as any);
      vi.mocked(DriveDeltaToken.countDocuments).mockResolvedValue(5);
      vi.mocked(ConnectorConfig.updateOne)
        .mockRejectedValueOnce(new Error('Database connection lost'))
        .mockResolvedValue({ acknowledged: true } as any);

      // Execute
      const result = await triggerStaleDeltaSyncs();

      // Verify
      expect(result.processed).toBe(1);
      expect(result.succeeded).toBe(0);
      expect(result.failed).toBe(1);

      // Verify error was recorded with tenantId
      expect(ConnectorConfig.updateOne).toHaveBeenCalledWith(
        { _id: 'connector-1', tenantId: 'tenant-1' },
        expect.objectContaining({
          $set: expect.objectContaining({
            'errorState.lastErrorMessage': 'Database connection lost',
          }),
          $inc: {
            'errorState.consecutiveFailures': 1,
          },
        }),
      );
    });

    it('should find connectors with lastDeltaSyncAt older than 1 hour', async () => {
      vi.mocked(ConnectorConfig.find).mockResolvedValue([]);

      await triggerStaleDeltaSyncs();

      // Verify the stale threshold calculation
      const calls = vi.mocked(ConnectorConfig.find).mock.calls as any[];
      expect(calls.length).toBeGreaterThan(0);
      const callArgs = calls[0][0];
      expect(callArgs).toHaveProperty('$or');

      const orConditions = (callArgs as any).$or;
      expect(orConditions).toHaveLength(2);

      // First condition: lastDeltaSyncAt < staleThreshold
      expect(orConditions[0]).toHaveProperty('syncState.lastDeltaSyncAt');
      expect(orConditions[0]['syncState.lastDeltaSyncAt']).toHaveProperty('$lt');

      // Verify threshold is approximately 1 hour ago (within 10 seconds tolerance)
      const threshold = orConditions[0]['syncState.lastDeltaSyncAt'].$lt;
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);
      const diffMs = Math.abs(threshold.getTime() - oneHourAgo.getTime());
      expect(diffMs).toBeLessThan(10000); // Within 10 seconds
    });
  });

  describe('cleanupOrphanedDeltaTokens', () => {
    /** Helper to mock DriveDeltaToken.findOne().lean() chain */
    function mockDeltaTokenFindOne(...results: Array<Record<string, unknown> | null>) {
      const leanResults = [...results];
      vi.mocked(DriveDeltaToken.findOne).mockImplementation(
        () =>
          ({
            lean: vi.fn().mockResolvedValueOnce(leanResults.shift() ?? null),
          }) as any,
      );
    }

    it('should delete tokens for non-existent connectors', async () => {
      // Mock distinct connector IDs
      vi.mocked(DriveDeltaToken.distinct).mockResolvedValue(['connector-1', 'connector-2']);

      // Mock DriveDeltaToken.findOne().lean() — returns sample tokens with tenantId
      const findOneLean = vi
        .fn()
        .mockResolvedValueOnce({ connectorId: 'connector-1', tenantId: 'tenant-1' })
        .mockResolvedValueOnce({ connectorId: 'connector-2', tenantId: 'tenant-1' });
      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({ lean: findOneLean } as any);

      // Mock connector lookups with tenantId — connector-2 doesn't exist
      vi.mocked(ConnectorConfig.findOne)
        .mockResolvedValueOnce({ _id: 'connector-1' } as any)
        .mockResolvedValueOnce(null);

      // Mock token deletion
      vi.mocked(DriveDeltaToken.deleteMany).mockResolvedValue({ deletedCount: 3 } as any);

      // Execute
      const result = await cleanupOrphanedDeltaTokens();

      // Verify
      expect(result.deleted).toBe(3);
      expect(ConnectorConfig.findOne).toHaveBeenCalledWith({
        _id: 'connector-1',
        tenantId: 'tenant-1',
      });
      expect(ConnectorConfig.findOne).toHaveBeenCalledWith({
        _id: 'connector-2',
        tenantId: 'tenant-1',
      });
      expect(DriveDeltaToken.deleteMany).toHaveBeenCalledWith({ connectorId: 'connector-2' });
      expect(DriveDeltaToken.deleteMany).toHaveBeenCalledTimes(1);
    });

    it('should not delete tokens for existing connectors', async () => {
      // Mock distinct connector IDs
      vi.mocked(DriveDeltaToken.distinct).mockResolvedValue(['connector-1', 'connector-2']);

      // Mock DriveDeltaToken.findOne().lean()
      const findOneLean = vi
        .fn()
        .mockResolvedValueOnce({ connectorId: 'connector-1', tenantId: 'tenant-1' })
        .mockResolvedValueOnce({ connectorId: 'connector-2', tenantId: 'tenant-1' });
      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({ lean: findOneLean } as any);

      // Mock connector lookups - both exist
      vi.mocked(ConnectorConfig.findOne)
        .mockResolvedValueOnce({ _id: 'connector-1' } as any)
        .mockResolvedValueOnce({ _id: 'connector-2' } as any);

      // Execute
      const result = await cleanupOrphanedDeltaTokens();

      // Verify
      expect(result.deleted).toBe(0);
      expect(DriveDeltaToken.deleteMany).not.toHaveBeenCalled();
    });

    it('should handle empty token list', async () => {
      vi.mocked(DriveDeltaToken.distinct).mockResolvedValue([]);

      // Execute
      const result = await cleanupOrphanedDeltaTokens();

      // Verify
      expect(result.deleted).toBe(0);
      expect(ConnectorConfig.findOne).not.toHaveBeenCalled();
      expect(DriveDeltaToken.deleteMany).not.toHaveBeenCalled();
    });

    it('should handle multiple orphaned connectors', async () => {
      // Mock distinct connector IDs
      vi.mocked(DriveDeltaToken.distinct).mockResolvedValue([
        'connector-1',
        'connector-2',
        'connector-3',
      ]);

      // Mock DriveDeltaToken.findOne().lean() — each call returns token with tenantId
      const findOneLean = vi
        .fn()
        .mockResolvedValueOnce({ connectorId: 'connector-1', tenantId: 'tenant-1' })
        .mockResolvedValueOnce({ connectorId: 'connector-2', tenantId: 'tenant-2' })
        .mockResolvedValueOnce({ connectorId: 'connector-3', tenantId: 'tenant-1' });
      vi.mocked(DriveDeltaToken.findOne).mockReturnValue({ lean: findOneLean } as any);

      // Mock connector lookups - connector-1 and connector-3 don't exist
      vi.mocked(ConnectorConfig.findOne)
        .mockResolvedValueOnce(null) // connector-1
        .mockResolvedValueOnce({ _id: 'connector-2' } as any) // connector-2
        .mockResolvedValueOnce(null); // connector-3

      // Mock token deletion
      vi.mocked(DriveDeltaToken.deleteMany)
        .mockResolvedValueOnce({ deletedCount: 5 } as any)
        .mockResolvedValueOnce({ deletedCount: 2 } as any);

      // Execute
      const result = await cleanupOrphanedDeltaTokens();

      // Verify
      expect(result.deleted).toBe(7);
      expect(DriveDeltaToken.deleteMany).toHaveBeenCalledTimes(2);
      expect(DriveDeltaToken.deleteMany).toHaveBeenCalledWith({ connectorId: 'connector-1' });
      expect(DriveDeltaToken.deleteMany).toHaveBeenCalledWith({ connectorId: 'connector-3' });
    });
  });
});
