/**
 * Tenant Policy Store tests
 *
 * Tests the MongoDB-based tenant policy store including:
 * - Domain pattern matching (exact and wildcard)
 * - Strategy restrictions
 * - Resource limits
 * - Compliance flags
 * - CRUD operations
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MongoTenantPolicyStore } from '../../decision/tenant-policy-store.js';
import type { TenantPolicy, CrawlStrategy } from '../../decision/interfaces.js';
import { TenantCrawlPolicy, type ITenantCrawlPolicy } from '@agent-platform/database/models';

// Mock the database model
vi.mock('@agent-platform/database/models', () => ({
  TenantCrawlPolicy: {
    findOne: vi.fn(),
    find: vi.fn(),
    create: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
  },
}));

// ========================================
// Test Fixtures
// ========================================

const createMockPolicy = (overrides: Partial<ITenantCrawlPolicy> = {}): ITenantCrawlPolicy => ({
  _id: 'policy-123',
  tenantId: 'tenant-789',
  domainPattern: 'example.com',
  allowedStrategies: ['bulk', 'hybrid'],
  limits: {
    maxBatchSize: 100,
    maxConcurrency: 20,
    maxMemoryMB: 512,
    maxDurationMinutes: 30,
  },
  compliance: {
    respectRobotsTxt: true,
    maxRequestsPerSecond: 10,
    userAgent: 'CrawlerBot/1.0',
  },
  createdBy: 'admin-user',
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-15'),
  ...overrides,
});

// ========================================
// Tests
// ========================================

describe('MongoTenantPolicyStore', () => {
  let store: MongoTenantPolicyStore;

  beforeEach(() => {
    store = new MongoTenantPolicyStore();
    vi.clearAllMocks();
  });

  describe('getPolicy()', () => {
    test('finds exact match policy', async () => {
      const mockPolicy = createMockPolicy();
      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPolicy),
      } as any);

      const result = await store.getPolicy('tenant-789', 'example.com');

      expect(result).toBeDefined();
      expect(result?.id).toBe('policy-123');
      expect(result?.domainPattern).toBe('example.com');
      expect(result?.allowedStrategies).toEqual(['bulk', 'hybrid']);
    });

    test('normalizes domain when searching', async () => {
      const mockPolicy = createMockPolicy();
      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPolicy),
      } as any);

      await store.getPolicy('tenant-789', 'EXAMPLE.COM');

      expect(TenantCrawlPolicy.findOne).toHaveBeenCalledWith({
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
      });
    });

    test('extracts domain from URL', async () => {
      const mockPolicy = createMockPolicy();
      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPolicy),
      } as any);

      await store.getPolicy('tenant-789', 'https://example.com/path');

      expect(TenantCrawlPolicy.findOne).toHaveBeenCalledWith({
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
      });
    });

    test('returns null when no policy found', async () => {
      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as any);

      const result = await store.getPolicy('tenant-789', 'example.com');

      expect(result).toBeNull();
    });

    test('matches wildcard pattern *.example.com', async () => {
      const mockPolicy = createMockPolicy({
        domainPattern: '*.example.com',
      });

      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([mockPolicy]),
      } as any);

      const result = await store.getPolicy('tenant-789', 'sub.example.com');

      expect(result).toBeDefined();
      expect(result?.domainPattern).toBe('*.example.com');
    });

    test('wildcard pattern matches base domain', async () => {
      const mockPolicy = createMockPolicy({
        domainPattern: '*.example.com',
      });

      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([mockPolicy]),
      } as any);

      const result = await store.getPolicy('tenant-789', 'example.com');

      expect(result).toBeDefined();
    });

    test('wildcard pattern does not match unrelated domain', async () => {
      const mockPolicy = createMockPolicy({
        domainPattern: '*.example.com',
      });

      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([mockPolicy]),
      } as any);

      const result = await store.getPolicy('tenant-789', 'other.com');

      expect(result).toBeNull();
    });

    test('prefers exact match over wildcard', async () => {
      const exactPolicy = createMockPolicy({
        _id: 'exact-123',
        domainPattern: 'sub.example.com',
      });

      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(exactPolicy),
      } as any);

      const result = await store.getPolicy('tenant-789', 'sub.example.com');

      expect(result?.id).toBe('exact-123');
      expect(result?.domainPattern).toBe('sub.example.com');

      // Should not check wildcards if exact match found
      expect(TenantCrawlPolicy.find).not.toHaveBeenCalled();
    });

    test('respects tenant isolation', async () => {
      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as any);

      await store.getPolicy('tenant-A', 'example.com');

      expect(TenantCrawlPolicy.findOne).toHaveBeenCalledWith({
        tenantId: 'tenant-A',
        domainPattern: 'example.com',
      });
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      } as any);

      await expect(store.getPolicy('tenant-789', 'example.com')).rejects.toThrow(
        'Failed to get tenant policy',
      );
    });
  });

  describe('createPolicy()', () => {
    test('creates new policy with all fields', async () => {
      const mockResult = createMockPolicy({
        _id: 'new-policy-123',
      });

      vi.mocked(TenantCrawlPolicy.create).mockResolvedValue({
        toObject: () => mockResult,
      } as any);

      const input: Omit<TenantPolicy, 'id' | 'createdAt' | 'updatedAt'> = {
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
        allowedStrategies: ['bulk', 'hybrid'],
        limits: {
          maxBatchSize: 100,
          maxConcurrency: 20,
          maxMemoryMB: 512,
          maxDurationMinutes: 30,
        },
        compliance: {
          respectRobotsTxt: true,
          maxRequestsPerSecond: 10,
          userAgent: 'CrawlerBot/1.0',
        },
        createdBy: 'admin-user',
      };

      const result = await store.createPolicy(input);

      expect(result.id).toBe('new-policy-123');
      expect(result.allowedStrategies).toEqual(['bulk', 'hybrid']);
      expect(result.limits.maxBatchSize).toBe(100);
      expect(result.compliance?.respectRobotsTxt).toBe(true);
    });

    test('creates policy without compliance', async () => {
      const mockResult = createMockPolicy({
        _id: 'policy-no-compliance',
        compliance: undefined,
      });

      vi.mocked(TenantCrawlPolicy.create).mockResolvedValue({
        toObject: () => mockResult,
      } as any);

      const input: Omit<TenantPolicy, 'id' | 'createdAt' | 'updatedAt'> = {
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
        allowedStrategies: ['browser'],
        limits: {
          maxBatchSize: 10,
          maxConcurrency: 2,
          maxMemoryMB: 256,
          maxDurationMinutes: 15,
        },
        createdBy: 'admin-user',
      };

      const result = await store.createPolicy(input);

      expect(result.id).toBe('policy-no-compliance');
      expect(result.compliance).toBeUndefined();
    });

    test('normalizes domain pattern', async () => {
      const mockResult = createMockPolicy({
        domainPattern: 'example.com',
      });

      vi.mocked(TenantCrawlPolicy.create).mockResolvedValue({
        toObject: () => mockResult,
      } as any);

      const input: Omit<TenantPolicy, 'id' | 'createdAt' | 'updatedAt'> = {
        tenantId: 'tenant-789',
        domainPattern: 'EXAMPLE.COM',
        allowedStrategies: ['bulk'],
        limits: {
          maxBatchSize: 50,
          maxConcurrency: 10,
          maxMemoryMB: 512,
          maxDurationMinutes: 30,
        },
        createdBy: 'admin-user',
      };

      await store.createPolicy(input);

      expect(TenantCrawlPolicy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          domainPattern: 'example.com',
        }),
      );
    });

    test('handles wildcard patterns', async () => {
      const mockResult = createMockPolicy({
        domainPattern: '*.example.com',
      });

      vi.mocked(TenantCrawlPolicy.create).mockResolvedValue({
        toObject: () => mockResult,
      } as any);

      const input: Omit<TenantPolicy, 'id' | 'createdAt' | 'updatedAt'> = {
        tenantId: 'tenant-789',
        domainPattern: '*.example.com',
        allowedStrategies: ['hybrid'],
        limits: {
          maxBatchSize: 20,
          maxConcurrency: 5,
          maxMemoryMB: 256,
          maxDurationMinutes: 20,
        },
        createdBy: 'admin-user',
      };

      const result = await store.createPolicy(input);

      expect(result.domainPattern).toBe('*.example.com');
    });

    test('respects tenant isolation', async () => {
      const mockResult = createMockPolicy({
        tenantId: 'tenant-A',
      });

      vi.mocked(TenantCrawlPolicy.create).mockResolvedValue({
        toObject: () => mockResult,
      } as any);

      const input: Omit<TenantPolicy, 'id' | 'createdAt' | 'updatedAt'> = {
        tenantId: 'tenant-A',
        domainPattern: 'example.com',
        allowedStrategies: ['bulk'],
        limits: {
          maxBatchSize: 50,
          maxConcurrency: 10,
          maxMemoryMB: 512,
          maxDurationMinutes: 30,
        },
        createdBy: 'admin-user',
      };

      await store.createPolicy(input);

      expect(TenantCrawlPolicy.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-A',
        }),
      );
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(TenantCrawlPolicy.create).mockRejectedValue(new Error('Duplicate key'));

      const input: Omit<TenantPolicy, 'id' | 'createdAt' | 'updatedAt'> = {
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
        allowedStrategies: ['bulk'],
        limits: {
          maxBatchSize: 50,
          maxConcurrency: 10,
          maxMemoryMB: 512,
          maxDurationMinutes: 30,
        },
        createdBy: 'admin-user',
      };

      await expect(store.createPolicy(input)).rejects.toThrow('Failed to create tenant policy');
    });
  });

  describe('updatePolicy()', () => {
    test('updates policy fields', async () => {
      const mockResult = createMockPolicy({
        _id: 'policy-123',
        allowedStrategies: ['browser', 'bulk', 'hybrid'],
        limits: {
          maxBatchSize: 150,
          maxConcurrency: 30,
          maxMemoryMB: 1024,
          maxDurationMinutes: 60,
        },
      });

      vi.mocked(TenantCrawlPolicy.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const result = await store.updatePolicy('policy-123', {
        allowedStrategies: ['browser', 'bulk', 'hybrid'],
        limits: {
          maxBatchSize: 150,
          maxConcurrency: 30,
          maxMemoryMB: 1024,
          maxDurationMinutes: 60,
        },
      });

      expect(result.id).toBe('policy-123');
      expect(result.allowedStrategies).toEqual(['browser', 'bulk', 'hybrid']);
      expect(result.limits.maxBatchSize).toBe(150);
    });

    test('updates domain pattern', async () => {
      const mockResult = createMockPolicy({
        domainPattern: 'newdomain.com',
      });

      vi.mocked(TenantCrawlPolicy.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const result = await store.updatePolicy('policy-123', {
        domainPattern: 'NEWDOMAIN.COM',
      });

      expect(result.domainPattern).toBe('newdomain.com');
    });

    test('updates compliance settings', async () => {
      const mockResult = createMockPolicy({
        compliance: {
          respectRobotsTxt: false,
          maxRequestsPerSecond: 20,
          userAgent: 'NewBot/2.0',
        },
      });

      vi.mocked(TenantCrawlPolicy.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const result = await store.updatePolicy('policy-123', {
        compliance: {
          respectRobotsTxt: false,
          maxRequestsPerSecond: 20,
          userAgent: 'NewBot/2.0',
        },
      });

      expect(result.compliance?.respectRobotsTxt).toBe(false);
      expect(result.compliance?.maxRequestsPerSecond).toBe(20);
    });

    test('updates partial fields', async () => {
      const mockResult = createMockPolicy({
        allowedStrategies: ['bulk'],
      });

      vi.mocked(TenantCrawlPolicy.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const result = await store.updatePolicy('policy-123', {
        allowedStrategies: ['bulk'],
      });

      expect(result.allowedStrategies).toEqual(['bulk']);
    });

    test('throws error when policy not found', async () => {
      vi.mocked(TenantCrawlPolicy.findOneAndUpdate).mockResolvedValue(null);

      await expect(
        store.updatePolicy('nonexistent', {
          allowedStrategies: ['bulk'],
        }),
      ).rejects.toThrow('Failed to update tenant policy');
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(TenantCrawlPolicy.findOneAndUpdate).mockRejectedValue(new Error('Database error'));

      await expect(
        store.updatePolicy('policy-123', {
          allowedStrategies: ['bulk'],
        }),
      ).rejects.toThrow('Failed to update tenant policy');
    });
  });

  describe('deletePolicy()', () => {
    test('deletes existing policy', async () => {
      vi.mocked(TenantCrawlPolicy.deleteOne).mockResolvedValue({
        deletedCount: 1,
      } as any);

      const result = await store.deletePolicy('policy-123');

      expect(result).toBe(true);
      expect(TenantCrawlPolicy.deleteOne).toHaveBeenCalledWith({ _id: 'policy-123' });
    });

    test('returns false when policy not found', async () => {
      vi.mocked(TenantCrawlPolicy.deleteOne).mockResolvedValue({
        deletedCount: 0,
      } as any);

      const result = await store.deletePolicy('nonexistent');

      expect(result).toBe(false);
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(TenantCrawlPolicy.deleteOne).mockRejectedValue(new Error('Database error'));

      await expect(store.deletePolicy('policy-123')).rejects.toThrow(
        'Failed to delete tenant policy',
      );
    });
  });

  describe('listPolicies()', () => {
    test('lists all policies for tenant', async () => {
      const mockPolicies = [
        createMockPolicy({ _id: 'policy-1', domainPattern: 'example.com' }),
        createMockPolicy({ _id: 'policy-2', domainPattern: '*.example.com' }),
        createMockPolicy({ _id: 'policy-3', domainPattern: 'other.com' }),
      ];

      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockPolicies),
        }),
      } as any);

      const result = await store.listPolicies('tenant-789');

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('policy-1');
      expect(result[1].id).toBe('policy-2');
      expect(result[2].id).toBe('policy-3');
    });

    test('sorts by createdAt descending', async () => {
      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await store.listPolicies('tenant-789');

      const findResult = TenantCrawlPolicy.find({ tenantId: 'tenant-789' });

      expect(findResult.sort).toHaveBeenCalledWith({ createdAt: -1 });
    });

    test('returns empty array when no policies', async () => {
      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await store.listPolicies('tenant-789');

      expect(result).toEqual([]);
    });

    test('respects tenant isolation', async () => {
      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await store.listPolicies('tenant-A');

      expect(TenantCrawlPolicy.find).toHaveBeenCalledWith({
        tenantId: 'tenant-A',
      });
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(TenantCrawlPolicy.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('Query timeout')),
        }),
      } as any);

      await expect(store.listPolicies('tenant-789')).rejects.toThrow(
        'Failed to list tenant policies',
      );
    });
  });

  describe('Edge Cases', () => {
    test('handles policy with minimal compliance', async () => {
      const mockPolicy = createMockPolicy({
        compliance: undefined,
      });

      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPolicy),
      } as any);

      const result = await store.getPolicy('tenant-789', 'example.com');

      expect(result).toBeDefined();
      expect(result?.compliance).toBeUndefined();
    });

    test('handles very long domain patterns', async () => {
      const longPattern = 'very.long.subdomain.structure.example.com';
      const mockPolicy = createMockPolicy({
        domainPattern: longPattern,
      });

      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPolicy),
      } as any);

      const result = await store.getPolicy('tenant-789', longPattern);

      expect(result?.domainPattern).toBe(longPattern);
    });

    test('handles different strategy combinations', async () => {
      const combinations: CrawlStrategy[][] = [
        ['browser'],
        ['bulk'],
        ['hybrid'],
        ['browser', 'bulk'],
        ['browser', 'hybrid'],
        ['bulk', 'hybrid'],
        ['browser', 'bulk', 'hybrid'],
      ];

      for (const strategies of combinations) {
        const mockPolicy = createMockPolicy({ allowedStrategies: strategies });

        vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockPolicy),
        } as any);

        const result = await store.getPolicy('tenant-789', 'example.com');

        expect(result?.allowedStrategies).toEqual(strategies);
      }
    });

    test('handles extreme resource limits', async () => {
      const mockPolicy = createMockPolicy({
        limits: {
          maxBatchSize: 1,
          maxConcurrency: 1,
          maxMemoryMB: 64,
          maxDurationMinutes: 1,
        },
      });

      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPolicy),
      } as any);

      const result = await store.getPolicy('tenant-789', 'example.com');

      expect(result?.limits.maxBatchSize).toBe(1);
      expect(result?.limits.maxConcurrency).toBe(1);
    });

    test('handles high resource limits', async () => {
      const mockPolicy = createMockPolicy({
        limits: {
          maxBatchSize: 10000,
          maxConcurrency: 1000,
          maxMemoryMB: 8192,
          maxDurationMinutes: 1440, // 24 hours
        },
      });

      vi.mocked(TenantCrawlPolicy.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPolicy),
      } as any);

      const result = await store.getPolicy('tenant-789', 'example.com');

      expect(result?.limits.maxBatchSize).toBe(10000);
      expect(result?.limits.maxDurationMinutes).toBe(1440);
    });
  });
});
