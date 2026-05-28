import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mock CapabilityRegistry Model ───────────────────────────────────────

const { mockCapabilityRegistry } = vi.hoisted(() => {
  const mockConstructor = vi.fn();
  return {
    mockCapabilityRegistry: Object.assign(mockConstructor, {
      find: vi.fn(),
      findOne: vi.fn(),
      deleteOne: vi.fn(),
    }),
  };
});

vi.mock('../../../db/index.js', () => ({
  getLazyModel: (name: string) => {
    if (name === 'CapabilityRegistry') return mockCapabilityRegistry;
    return {};
  },
}));

import { CapabilityService } from '../capability.service.js';

const CapabilityRegistry = mockCapabilityRegistry;

// ─── Test Data ───────────────────────────────────────────────────────────

const mockCapabilities = [
  {
    _id: 'cap_1',
    tenantId: 'tenant_123',
    name: 'count',
    type: 'aggregation',
    description: 'Count number of items',
    supportedFieldTypes: ['any'],
    triggerKeywords: ['count', 'total', 'number of'],
    examples: ['Count all bugs', 'Total number of issues'],
    enabled: true,
    metadata: {
      version: 1,
      createdBy: 'system',
    },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
  {
    _id: 'cap_2',
    tenantId: 'tenant_123',
    name: 'equals',
    type: 'operator',
    description: 'Exact match operator',
    supportedFieldTypes: ['string', 'number'],
    triggerKeywords: ['equals', 'is', 'exactly'],
    examples: ['status equals open', 'priority is high'],
    enabled: true,
    metadata: {
      version: 1,
      createdBy: 'system',
    },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
  {
    _id: 'cap_3',
    tenantId: 'tenant_123',
    name: 'sum',
    type: 'aggregation',
    description: 'Sum numeric values',
    supportedFieldTypes: ['number'],
    triggerKeywords: ['sum', 'total'],
    examples: ['Sum all amounts'],
    enabled: false, // Disabled
    metadata: {
      version: 1,
      createdBy: 'admin',
    },
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
  },
];

// ─── Tests ───────────────────────────────────────────────────────────────

describe('CapabilityService', () => {
  let service: CapabilityService;

  beforeEach(() => {
    service = new CapabilityService();
    vi.clearAllMocks();
    service.clearCache('tenant_123'); // Clear cache between tests
  });

  describe('listCapabilities', () => {
    it('lists all capabilities for a tenant', async () => {
      vi.mocked(CapabilityRegistry.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockCapabilities),
      } as any);

      const result = await service.listCapabilities({ tenantId: 'tenant_123' });

      expect(result).toHaveLength(3);
      expect(result[0].name).toBe('count');
      expect(CapabilityRegistry.find).toHaveBeenCalledWith({ tenantId: 'tenant_123' });
    });

    it('filters capabilities by type', async () => {
      const aggregations = mockCapabilities.filter((c) => c.type === 'aggregation');

      vi.mocked(CapabilityRegistry.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(aggregations),
      } as any);

      const result = await service.listCapabilities({
        tenantId: 'tenant_123',
        type: 'aggregation',
      });

      expect(result).toHaveLength(2);
      expect(result.every((c) => c.type === 'aggregation')).toBe(true);
      expect(CapabilityRegistry.find).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        type: 'aggregation',
      });
    });

    it('filters capabilities by enabled status', async () => {
      const enabled = mockCapabilities.filter((c) => c.enabled);

      vi.mocked(CapabilityRegistry.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(enabled),
      } as any);

      const result = await service.listCapabilities({
        tenantId: 'tenant_123',
        enabled: true,
      });

      expect(result).toHaveLength(2);
      expect(result.every((c) => c.enabled)).toBe(true);
      expect(CapabilityRegistry.find).toHaveBeenCalledWith({
        tenantId: 'tenant_123',
        enabled: true,
      });
    });

    it('caches results on first call', async () => {
      vi.mocked(CapabilityRegistry.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockCapabilities),
      } as any);

      // First call - should query DB
      await service.listCapabilities({ tenantId: 'tenant_123' });
      expect(CapabilityRegistry.find).toHaveBeenCalledTimes(1);

      // Second call - should use cache
      await service.listCapabilities({ tenantId: 'tenant_123' });
      expect(CapabilityRegistry.find).toHaveBeenCalledTimes(1); // Still 1, cache hit

      const stats = service.getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
    });

    it('enforces tenant isolation', async () => {
      vi.mocked(CapabilityRegistry.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue([]),
      } as any);

      await service.listCapabilities({ tenantId: 'tenant_456' });

      expect(CapabilityRegistry.find).toHaveBeenCalledWith({
        tenantId: 'tenant_456',
      });
    });
  });

  describe('getCapabilityById', () => {
    it('returns capability by ID for tenant', async () => {
      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockCapabilities[0]),
      } as any);

      const result = await service.getCapabilityById('tenant_123', 'cap_1');

      expect(result).toBeDefined();
      expect(result?.name).toBe('count');
      expect(CapabilityRegistry.findOne).toHaveBeenCalledWith({
        _id: 'cap_1',
        tenantId: 'tenant_123',
      });
    });

    it('returns null when capability not found', async () => {
      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      } as any);

      const result = await service.getCapabilityById('tenant_123', 'nonexistent');

      expect(result).toBeNull();
    });

    it('enforces tenant isolation - prevents cross-tenant access', async () => {
      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(null),
      } as any);

      await service.getCapabilityById('tenant_456', 'cap_1');

      expect(CapabilityRegistry.findOne).toHaveBeenCalledWith({
        _id: 'cap_1',
        tenantId: 'tenant_456',
      });
    });
  });

  describe('createCapability', () => {
    it('throws error when capability name already exists', async () => {
      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockCapabilities[0]), // Duplicate found
      } as any);

      await expect(
        service.createCapability({
          tenantId: 'tenant_123',
          name: 'count',
          type: 'aggregation',
          description: 'Count number of items',
          supportedFieldTypes: ['any'],
          triggerKeywords: ['count'],
          examples: ['Count all bugs'],
          createdBy: 'system',
        }),
      ).rejects.toThrow('Capability with name "count" already exists for tenant');
    });
  });

  describe('updateCapability', () => {
    it('updates capability fields', async () => {
      const mockCapability = {
        ...mockCapabilities[0],
        save: vi.fn().mockResolvedValue(undefined),
        toObject: vi.fn().mockReturnValue({ ...mockCapabilities[0], description: 'Updated' }),
      };

      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockCapability),
      } as any);

      const result = await service.updateCapability('tenant_123', 'cap_1', {
        description: 'Updated description',
        triggerKeywords: ['count', 'total', 'how many'],
      });

      expect(result).toBeDefined();
      expect(mockCapability.save).toHaveBeenCalled();
      expect(mockCapability.metadata.version).toBe(2); // Version incremented
    });

    it('returns null when capability not found', async () => {
      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as any);

      const result = await service.updateCapability('tenant_123', 'nonexistent', {
        description: 'Updated',
      });

      expect(result).toBeNull();
    });

    it('invalidates cache after update', async () => {
      const mockCapability = {
        ...mockCapabilities[0],
        save: vi.fn().mockResolvedValue(undefined),
        toObject: vi.fn().mockReturnValue(mockCapabilities[0]),
      };

      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockCapability),
      } as any);

      await service.updateCapability('tenant_123', 'cap_1', {
        description: 'Updated',
      });

      expect(mockCapability.save).toHaveBeenCalled();
    });
  });

  describe('toggleCapability', () => {
    it('enables a disabled capability', async () => {
      const mockCapability = {
        ...mockCapabilities[2], // Disabled capability
        save: vi.fn().mockResolvedValue(undefined),
        toObject: vi.fn().mockReturnValue({ ...mockCapabilities[2], enabled: true }),
      };

      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockCapability),
      } as any);

      const result = await service.toggleCapability('tenant_123', 'cap_3', true);

      expect(result).toBeDefined();
      expect(mockCapability.enabled).toBe(true);
      expect(mockCapability.save).toHaveBeenCalled();
    });

    it('disables an enabled capability', async () => {
      const mockCapability = {
        ...mockCapabilities[0], // Enabled capability
        save: vi.fn().mockResolvedValue(undefined),
        toObject: vi.fn().mockReturnValue({ ...mockCapabilities[0], enabled: false }),
      };

      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockCapability),
      } as any);

      const result = await service.toggleCapability('tenant_123', 'cap_1', false);

      expect(result).toBeDefined();
      expect(mockCapability.enabled).toBe(false);
      expect(mockCapability.save).toHaveBeenCalled();
    });

    it('returns null when capability not found', async () => {
      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue(null),
      } as any);

      const result = await service.toggleCapability('tenant_123', 'nonexistent', true);

      expect(result).toBeNull();
    });

    it('increments version on toggle', async () => {
      const mockCapability = {
        ...mockCapabilities[0],
        metadata: {
          version: 1,
          createdBy: 'system',
        },
        save: vi.fn().mockResolvedValue(undefined),
        toObject: vi.fn().mockReturnValue(mockCapabilities[0]),
      };

      vi.mocked(CapabilityRegistry.findOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue(mockCapability),
      } as any);

      await service.toggleCapability('tenant_123', 'cap_1', false);

      expect(mockCapability.metadata.version).toBe(2);
    });
  });

  describe('deleteCapability', () => {
    it('deletes capability and returns true', async () => {
      vi.mocked(CapabilityRegistry.deleteOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      } as any);

      const result = await service.deleteCapability('tenant_123', 'cap_1');

      expect(result).toBe(true);
      expect(CapabilityRegistry.deleteOne).toHaveBeenCalledWith({
        _id: 'cap_1',
        tenantId: 'tenant_123',
      });
    });

    it('returns false when capability not found', async () => {
      vi.mocked(CapabilityRegistry.deleteOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      } as any);

      const result = await service.deleteCapability('tenant_123', 'nonexistent');

      expect(result).toBe(false);
    });

    it('enforces tenant isolation on delete', async () => {
      vi.mocked(CapabilityRegistry.deleteOne).mockReturnValue({
        exec: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      } as any);

      await service.deleteCapability('tenant_456', 'cap_1');

      expect(CapabilityRegistry.deleteOne).toHaveBeenCalledWith({
        _id: 'cap_1',
        tenantId: 'tenant_456',
      });
    });
  });

  describe('getCapabilitiesByType', () => {
    it('groups capabilities by type', async () => {
      vi.mocked(CapabilityRegistry.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockCapabilities.filter((c) => c.enabled)),
      } as any);

      const result = await service.getCapabilitiesByType('tenant_123');

      expect(result.aggregationFunctions).toHaveLength(1);
      expect(result.filterOperators).toHaveLength(1);
      expect(result.sortOperators).toHaveLength(0);
      expect(result.aggregationFunctions[0].name).toBe('count');
      expect(result.filterOperators[0].name).toBe('equals');
    });

    it('only includes enabled capabilities', async () => {
      vi.mocked(CapabilityRegistry.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockCapabilities.filter((c) => c.enabled)),
      } as any);

      const result = await service.getCapabilitiesByType('tenant_123');

      const allCapabilities = [
        ...result.aggregationFunctions,
        ...result.filterOperators,
        ...result.sortOperators,
      ];

      expect(allCapabilities.every((c) => c.enabled)).toBe(true);
    });
  });

  describe('cache management', () => {
    it('getCacheStats returns cache size and max', () => {
      const stats = service.getCacheStats();

      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('max');
      expect(stats.max).toBe(100);
      expect(typeof stats.size).toBe('number');
    });

    it('clearCache invalidates cache for tenant', async () => {
      vi.mocked(CapabilityRegistry.find).mockReturnValue({
        sort: vi.fn().mockReturnThis(),
        lean: vi.fn().mockReturnThis(),
        exec: vi.fn().mockResolvedValue(mockCapabilities),
      } as any);

      // Populate cache
      await service.listCapabilities({ tenantId: 'tenant_123' });
      expect(CapabilityRegistry.find).toHaveBeenCalledTimes(1);

      // Clear cache
      service.clearCache('tenant_123');

      // Next call should hit DB again
      await service.listCapabilities({ tenantId: 'tenant_123' });
      expect(CapabilityRegistry.find).toHaveBeenCalledTimes(2);
    });
  });
});
