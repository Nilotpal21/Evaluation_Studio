/**
 * Connector Delta Sync Routes Tests
 *
 * Tests for delta sync API endpoints:
 * - POST /connectors/:connectorId/sync/delta
 * - GET /connectors/:connectorId/delta-tokens
 * - DELETE /connectors/:connectorId/delta-tokens/:driveId
 */

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest';
import express, { type Express } from 'express';
import request from 'supertest';

// Mock the repository layer
vi.mock('../../repos/connector.repository.js', () => ({
  findConnectorByIdAndTenantLean: vi.fn(),
  findConnectorByIdAndTenant: vi.fn(),
  countDeltaTokens: vi.fn(),
  updateConnectorDeltaSyncTimestamp: vi.fn(),
  findDeltaTokens: vi.fn(),
  deleteDeltaToken: vi.fn(),
}));

// Mock auth middleware
vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1' };
    next();
  },
}));

vi.mock('../../routes/searchai-route-ownership.js', () => ({
  assertSearchIndexAccess: vi.fn().mockResolvedValue(true),
  assertConnectorIndexAccess: vi.fn().mockResolvedValue(true),
}));

// Mock logger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn().mockReturnValue({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import * as repo from '../../repos/connector.repository.js';
import connectorRoutes from '../../routes/connectors.js';

describe('Connector Delta Sync Routes', () => {
  let app: Express;

  beforeEach(() => {
    app = express();
    app.use(express.json());
    app.use('/api', connectorRoutes);
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('POST /api/connectors/:connectorId/sync/delta', () => {
    const mockConnector = {
      _id: 'connector-1',
      tenantId: 'tenant-1',
      syncState: {
        lastFullSyncAt: new Date('2024-01-15T00:00:00Z'),
        lastDeltaSyncAt: new Date('2024-01-15T01:00:00Z'),
      },
      errorState: {
        isPaused: false,
      },
    };

    it('should trigger delta sync successfully', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.countDeltaTokens).mockResolvedValue(5);
      vi.mocked(repo.updateConnectorDeltaSyncTimestamp).mockResolvedValue();

      const response = await request(app)
        .post('/api/connectors/connector-1/sync/delta')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Delta sync triggered');
      expect(response.body.connector.id).toBe('connector-1');
      expect(response.body.connector.tokenCount).toBe(5);

      // Verify connector was updated (includes tenantId for tenant isolation)
      expect(repo.updateConnectorDeltaSyncTimestamp).toHaveBeenCalledWith(
        'connector-1',
        'tenant-1',
      );
    });

    it('should return 404 if connector not found', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(null);

      const response = await request(app)
        .post('/api/connectors/connector-999/sync/delta')
        .expect(404);

      expect(response.body.error.message).toBe('Connector not found');
    });

    it('should return 400 if connector is paused', async () => {
      const pausedConnector = {
        ...mockConnector,
        errorState: { isPaused: true },
      };
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(pausedConnector as any);

      const response = await request(app)
        .post('/api/connectors/connector-1/sync/delta')
        .expect(400);

      expect(response.body.error.message).toBe('Connector is paused');
    });

    it('should return 400 if full sync not completed', async () => {
      const noFullSyncConnector = {
        ...mockConnector,
        syncState: {
          lastFullSyncAt: null,
        },
      };
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(noFullSyncConnector as any);

      const response = await request(app)
        .post('/api/connectors/connector-1/sync/delta')
        .expect(400);

      expect(response.body.error.message).toBe(
        'Connector must complete full sync before delta sync',
      );
    });

    it('should return 400 if no delta tokens exist', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.countDeltaTokens).mockResolvedValue(0);

      const response = await request(app)
        .post('/api/connectors/connector-1/sync/delta')
        .expect(400);

      expect(response.body.error.message).toBe('No delta tokens found');
    });

    it('should verify tenant isolation', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.countDeltaTokens).mockResolvedValue(5);
      vi.mocked(repo.updateConnectorDeltaSyncTimestamp).mockResolvedValue();

      await request(app).post('/api/connectors/connector-1/sync/delta').expect(200);

      // Verify tenant was included in query
      expect(repo.findConnectorByIdAndTenantLean).toHaveBeenCalledWith('connector-1', 'tenant-1');
    });
  });

  describe('GET /api/connectors/:connectorId/delta-tokens', () => {
    const mockConnector = {
      _id: 'connector-1',
      tenantId: 'tenant-1',
    };

    const mockTokens = [
      {
        driveId: 'drive-1',
        lastSyncAt: new Date(Date.now() - 30 * 60 * 1000), // 30 min ago
        itemsProcessedSinceToken: 150,
        createdAt: new Date('2024-01-15T00:00:00Z'),
      },
      {
        driveId: 'drive-2',
        lastSyncAt: new Date(Date.now() - 90 * 60 * 1000), // 90 min ago (stale)
        itemsProcessedSinceToken: 200,
        createdAt: new Date('2024-01-15T00:00:00Z'),
      },
      {
        driveId: 'drive-3',
        lastSyncAt: new Date(Date.now() - 15 * 60 * 1000), // 15 min ago
        itemsProcessedSinceToken: 50,
        createdAt: new Date('2024-01-15T00:00:00Z'),
      },
    ];

    it('should list all delta tokens with status', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.findDeltaTokens).mockResolvedValue(mockTokens);

      const response = await request(app)
        .get('/api/connectors/connector-1/delta-tokens')
        .expect(200);

      expect(response.body.connectorId).toBe('connector-1');
      expect(response.body.totalTokens).toBe(3);
      expect(response.body.staleTokens).toBe(1); // drive-2 is stale
      expect(response.body.tokens).toHaveLength(3);

      // Verify token structure
      const token1 = response.body.tokens.find((t: any) => t.driveId === 'drive-1');
      expect(token1).toMatchObject({
        driveId: 'drive-1',
        itemsProcessedSinceToken: 150,
        isStale: false, // 30 min < 1 hour
      });

      const token2 = response.body.tokens.find((t: any) => t.driveId === 'drive-2');
      expect(token2).toMatchObject({
        driveId: 'drive-2',
        itemsProcessedSinceToken: 200,
        isStale: true, // 90 min > 1 hour
      });
    });

    it('should return 404 if connector not found', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(null);

      const response = await request(app)
        .get('/api/connectors/connector-999/delta-tokens')
        .expect(404);

      expect(response.body.error.message).toBe('Connector not found');
    });

    it('should return empty list if no tokens exist', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.findDeltaTokens).mockResolvedValue([]);

      const response = await request(app)
        .get('/api/connectors/connector-1/delta-tokens')
        .expect(200);

      expect(response.body.totalTokens).toBe(0);
      expect(response.body.staleTokens).toBe(0);
      expect(response.body.tokens).toEqual([]);
    });

    it('should calculate hoursSinceSync correctly', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.findDeltaTokens).mockResolvedValue(mockTokens);

      const response = await request(app)
        .get('/api/connectors/connector-1/delta-tokens')
        .expect(200);

      // Verify hoursSinceSync is approximately correct (within tolerance)
      const token1 = response.body.tokens.find((t: any) => t.driveId === 'drive-1');
      expect(token1.hoursSinceSync).toBeCloseTo(0.5, 1); // ~30 min = 0.5 hours

      const token2 = response.body.tokens.find((t: any) => t.driveId === 'drive-2');
      expect(token2.hoursSinceSync).toBeCloseTo(1.5, 1); // ~90 min = 1.5 hours
    });

    it('should verify tenant isolation', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.findDeltaTokens).mockResolvedValue([]);

      await request(app).get('/api/connectors/connector-1/delta-tokens').expect(200);

      // Verify tenant was included in query
      expect(repo.findDeltaTokens).toHaveBeenCalledWith('connector-1', 'tenant-1');
    });
  });

  describe('DELETE /api/connectors/:connectorId/delta-tokens/:driveId', () => {
    const mockConnector = {
      _id: 'connector-1',
      tenantId: 'tenant-1',
    };

    it('should reset delta token successfully', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.deleteDeltaToken).mockResolvedValue(1);

      const response = await request(app)
        .delete('/api/connectors/connector-1/delta-tokens/drive-1')
        .expect(200);

      expect(response.body.success).toBe(true);
      expect(response.body.message).toBe('Delta token reset');
      expect(response.body.drive.driveId).toBe('drive-1');
      expect(response.body.drive.note).toContain('full sync');

      // Verify token was deleted
      expect(repo.deleteDeltaToken).toHaveBeenCalledWith('connector-1', 'tenant-1', 'drive-1');
    });

    it('should return 404 if connector not found', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(null);

      const response = await request(app)
        .delete('/api/connectors/connector-999/delta-tokens/drive-1')
        .expect(404);

      expect(response.body.error.message).toBe('Connector not found');
    });

    it('should return 404 if token not found', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.deleteDeltaToken).mockResolvedValue(0);

      const response = await request(app)
        .delete('/api/connectors/connector-1/delta-tokens/drive-999')
        .expect(404);

      expect(response.body.error.message).toBe('Delta token not found for this drive');
    });

    it('should verify tenant isolation', async () => {
      vi.mocked(repo.findConnectorByIdAndTenantLean).mockResolvedValue(mockConnector as any);
      vi.mocked(repo.deleteDeltaToken).mockResolvedValue(1);

      await request(app).delete('/api/connectors/connector-1/delta-tokens/drive-1').expect(200);

      // Verify tenant was included in both queries
      expect(repo.findConnectorByIdAndTenantLean).toHaveBeenCalledWith('connector-1', 'tenant-1');
      expect(repo.deleteDeltaToken).toHaveBeenCalledWith('connector-1', 'tenant-1', 'drive-1');
    });
  });
});
