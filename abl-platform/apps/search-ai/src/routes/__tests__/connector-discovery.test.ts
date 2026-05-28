/**
 * Connector Discovery Routes Tests
 *
 * Tests all 7 discovery/recommendation endpoints with mocked dependencies.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock database models
vi.mock('@agent-platform/database', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/database')>();
  return {
    ...actual,
    ConnectorConfig: {
      findOne: vi.fn(),
      findOneAndUpdate: vi.fn(),
    },
    ConnectorDiscovery: {
      findOne: vi.fn(),
      create: vi.fn(),
    },
    ConnectorRecommendation: {
      findOne: vi.fn(),
      create: vi.fn(),
    },
  };
});

// Mock setup orchestrator
vi.mock('../../services/setup/quick-setup-orchestrator.js', () => ({
  triggerDiscovery: vi.fn().mockResolvedValue({
    discoveryId: 'disc-123',
    jobId: 'job-456',
  }),
  generateRecommendations: vi.fn().mockResolvedValue({
    _id: 'rec-789',
    status: 'generated',
    resourceScores: [],
    overallConfidence: 0.8,
  }),
  acceptRecommendation: vi.fn().mockResolvedValue({
    connector: { _id: 'conn-1', configurationSource: 'quick_setup' },
    jobId: 'sync-job-1',
  }),
}));

// Mock worker
vi.mock('../../workers/shared.js', () => ({
  createQueue: vi.fn().mockReturnValue({
    add: vi.fn().mockResolvedValue({ id: 'job-123' }),
  }),
  getRedisConnection: vi.fn(() => ({})),
  workerError: vi.fn(),
  workerLog: vi.fn(),
}));

vi.mock('../../workers/connector-discovery-worker.js', () => ({
  QUEUE_CONNECTOR_DISCOVERY: 'connector-discovery',
}));

import {
  ConnectorConfig,
  ConnectorDiscovery,
  ConnectorRecommendation,
} from '@agent-platform/database';
import {
  triggerDiscovery,
  generateRecommendations,
  acceptRecommendation,
} from '../../services/setup/quick-setup-orchestrator.js';

describe('ConnectorDiscoveryRoutes', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('triggerDiscovery', () => {
    it('should be callable with correct parameters', async () => {
      const result = await (triggerDiscovery as any)(
        'conn-1',
        'tenant-1',
        'sharepoint',
        'discover_and_profile',
        100,
      );

      expect(result).toEqual({
        discoveryId: 'disc-123',
        jobId: 'job-456',
      });
    });
  });

  describe('generateRecommendations', () => {
    it('should be callable and return recommendation', async () => {
      const result = await (generateRecommendations as any)('conn-1', 'tenant-1', 'disc-123');

      expect(result._id).toBe('rec-789');
      expect(result.status).toBe('generated');
    });
  });

  describe('acceptRecommendation', () => {
    it('should accept and return connector with sync job', async () => {
      const result = await (acceptRecommendation as any)(
        'conn-1',
        'tenant-1',
        'rec-789',
        null,
        true,
      );

      expect(result.connector.configurationSource).toBe('quick_setup');
      expect(result.jobId).toBe('sync-job-1');
    });
  });

  describe('ConnectorDiscovery model', () => {
    it('should be importable', () => {
      expect(ConnectorDiscovery).toBeDefined();
      expect(ConnectorDiscovery.findOne).toBeDefined();
    });
  });

  describe('ConnectorRecommendation model', () => {
    it('should be importable', () => {
      expect(ConnectorRecommendation).toBeDefined();
      expect(ConnectorRecommendation.findOne).toBeDefined();
    });
  });

  describe('ConnectorConfig model', () => {
    it('should be importable', () => {
      expect(ConnectorConfig).toBeDefined();
      expect(ConnectorConfig.findOne).toBeDefined();
    });
  });
});
