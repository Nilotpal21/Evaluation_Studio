import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import { CapabilityService } from '../services/capability/capability.service.js';
import { CapabilityRegistry } from '@agent-platform/database/models';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
  vi.clearAllMocks();
});

// ─── Helper Functions ────────────────────────────────────────────────────

const createCapability = async (data: {
  tenantId?: string;
  name: string;
  type: 'aggregation' | 'operator' | 'sort';
  description: string;
  supportedFieldTypes: string[];
  triggerKeywords: string[];
  examples: string[];
  enabled?: boolean;
  createdBy?: 'system' | 'admin';
}) => {
  return await CapabilityRegistry.create({
    tenantId: data.tenantId || 'global',
    name: data.name,
    type: data.type,
    description: data.description,
    supportedFieldTypes: data.supportedFieldTypes,
    triggerKeywords: data.triggerKeywords,
    examples: data.examples,
    enabled: data.enabled ?? true,
    metadata: {
      version: 1,
      createdBy: data.createdBy || 'system',
    },
  });
};

// ─── Tests ───────────────────────────────────────────────────────────────

describe('CapabilityService', () => {
  describe('constructor', () => {
    it('initializes with LRU cache', () => {
      const service = new CapabilityService();
      const stats = service.getCacheStats();

      expect(stats.max).toBe(100);
      expect(stats.size).toBe(0);
    });
  });

  describe('listCapabilities', () => {
    it('returns all capabilities for a tenant', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create capabilities
      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count aggregation',
        supportedFieldTypes: ['number', 'text'],
        triggerKeywords: ['count', 'total'],
        examples: ['count bugs by status'],
      });

      await createCapability({
        tenantId: 'tenant-1',
        name: 'equals',
        type: 'operator',
        description: 'Equality operator',
        supportedFieldTypes: ['number', 'text'],
        triggerKeywords: ['equals', 'is'],
        examples: ['priority equals high'],
      });

      const service = new CapabilityService();
      const capabilities = await service.listCapabilities({ tenantId: 'tenant-1' });

      expect(capabilities).toHaveLength(2);
      expect(capabilities[0].name).toBe('count');
      expect(capabilities[0].type).toBe('aggregation');
      expect(capabilities[1].name).toBe('equals');
      expect(capabilities[1].type).toBe('operator');
    });

    it('filters capabilities by type', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      // Create capabilities of different types
      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count aggregation',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      await createCapability({
        tenantId: 'tenant-1',
        name: 'equals',
        type: 'operator',
        description: 'Equality operator',
        supportedFieldTypes: ['text'],
        triggerKeywords: ['equals'],
        examples: ['field equals value'],
      });

      const service = new CapabilityService();

      // Filter by aggregation
      const aggregations = await service.listCapabilities({
        tenantId: 'tenant-1',
        type: 'aggregation',
      });
      expect(aggregations).toHaveLength(1);
      expect(aggregations[0].name).toBe('count');

      // Filter by operator
      const operators = await service.listCapabilities({
        tenantId: 'tenant-1',
        type: 'operator',
      });
      expect(operators).toHaveLength(1);
      expect(operators[0].name).toBe('equals');
    });

    it('filters capabilities by enabled status', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count aggregation',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
        enabled: true,
      });

      await createCapability({
        tenantId: 'tenant-1',
        name: 'sum',
        type: 'aggregation',
        description: 'Sum aggregation',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['sum'],
        examples: ['sum revenue'],
        enabled: false,
      });

      const service = new CapabilityService();

      // Only enabled
      const enabled = await service.listCapabilities({
        tenantId: 'tenant-1',
        enabled: true,
      });
      expect(enabled).toHaveLength(1);
      expect(enabled[0].name).toBe('count');

      // Only disabled
      const disabled = await service.listCapabilities({
        tenantId: 'tenant-1',
        enabled: false,
      });
      expect(disabled).toHaveLength(1);
      expect(disabled[0].name).toBe('sum');

      // All (no filter)
      const all = await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(all).toHaveLength(2);
    });

    it('returns empty array when no capabilities exist', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const service = new CapabilityService();
      const capabilities = await service.listCapabilities({ tenantId: 'tenant-1' });

      expect(capabilities).toHaveLength(0);
    });

    it('caches capabilities on first load', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();

      // First call - cache miss
      const capabilities1 = await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(capabilities1).toHaveLength(1);

      // Second call - cache hit
      const capabilities2 = await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(capabilities2).toHaveLength(1);

      // Verify cache is populated
      const stats = service.getCacheStats();
      expect(stats.size).toBeGreaterThan(0);
    });

    it('isolates capabilities by tenant', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      await createCapability({
        tenantId: 'tenant-2',
        name: 'sum',
        type: 'aggregation',
        description: 'Sum',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['sum'],
        examples: ['sum revenue'],
      });

      const service = new CapabilityService();

      const tenant1Caps = await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(tenant1Caps).toHaveLength(1);
      expect(tenant1Caps[0].name).toBe('count');

      const tenant2Caps = await service.listCapabilities({ tenantId: 'tenant-2' });
      expect(tenant2Caps).toHaveLength(1);
      expect(tenant2Caps[0].name).toBe('sum');
    });
  });

  describe('getCapabilityById', () => {
    it('retrieves capability by ID', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const created = await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count aggregation',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();
      const capability = await service.getCapabilityById('tenant-1', created._id);

      expect(capability).not.toBeNull();
      expect(capability!.name).toBe('count');
      expect(capability!._id).toBe(created._id);
    });

    it('returns null when capability not found', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const service = new CapabilityService();
      const capability = await service.getCapabilityById('tenant-1', 'non-existent-id');

      expect(capability).toBeNull();
    });

    it('returns null when wrong tenant ID is used', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const created = await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();
      const capability = await service.getCapabilityById('tenant-2', created._id);

      expect(capability).toBeNull();
    });
  });

  describe('createCapability', () => {
    it('creates new capability', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const service = new CapabilityService();
      const capability = await service.createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count aggregation function',
        supportedFieldTypes: ['number', 'text'],
        triggerKeywords: ['count', 'total', 'number of'],
        examples: ['count bugs by status', 'total issues'],
        createdBy: 'admin',
      });

      expect(capability).toBeDefined();
      expect(capability.name).toBe('count');
      expect(capability.type).toBe('aggregation');
      expect(capability.description).toBe('Count aggregation function');
      expect(capability.supportedFieldTypes).toEqual(['number', 'text']);
      expect(capability.triggerKeywords).toEqual(['count', 'total', 'number of']);
      expect(capability.examples).toEqual(['count bugs by status', 'total issues']);
      expect(capability.enabled).toBe(true);
      expect(capability.metadata.version).toBe(1);
      expect(capability.metadata.createdBy).toBe('admin');
    });

    it('throws error when capability name already exists for tenant', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();

      await expect(
        service.createCapability({
          tenantId: 'tenant-1',
          name: 'count',
          type: 'aggregation',
          description: 'Duplicate count',
          supportedFieldTypes: ['number'],
          triggerKeywords: ['count'],
          examples: ['count items'],
          createdBy: 'admin',
        }),
      ).rejects.toThrow('Capability with name "count" already exists for tenant');
    });

    it('allows same capability name for different tenants', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const service = new CapabilityService();

      const cap1 = await service.createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
        createdBy: 'system',
      });

      const cap2 = await service.createCapability({
        tenantId: 'tenant-2',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
        createdBy: 'system',
      });

      expect(cap1.name).toBe('count');
      expect(cap2.name).toBe('count');
      expect(cap1._id).not.toBe(cap2._id);
    });

    it('invalidates cache after creation', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const service = new CapabilityService();

      // Populate cache
      await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(service.getCacheStats().size).toBeGreaterThan(0);

      // Create capability - should invalidate cache
      await service.createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
        createdBy: 'system',
      });

      // List capabilities - should get fresh data
      const capabilities = await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(capabilities).toHaveLength(1);
    });
  });

  describe('updateCapability', () => {
    it('updates capability fields', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const created = await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Old description',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();
      const updated = await service.updateCapability('tenant-1', created._id, {
        description: 'New description',
        supportedFieldTypes: ['number', 'text'],
        triggerKeywords: ['count', 'total'],
        examples: ['count items', 'total revenue'],
      });

      expect(updated).not.toBeNull();
      expect(updated!.description).toBe('New description');
      expect(updated!.supportedFieldTypes).toEqual(['number', 'text']);
      expect(updated!.triggerKeywords).toEqual(['count', 'total']);
      expect(updated!.examples).toEqual(['count items', 'total revenue']);
      expect(updated!.metadata.version).toBe(2);
    });

    it('returns null when capability not found', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const service = new CapabilityService();
      const updated = await service.updateCapability('tenant-1', 'non-existent-id', {
        description: 'New description',
      });

      expect(updated).toBeNull();
    });

    it('invalidates cache after update', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const created = await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Old',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();

      // Populate cache
      await service.listCapabilities({ tenantId: 'tenant-1' });

      // Update
      await service.updateCapability('tenant-1', created._id, {
        description: 'New',
      });

      // Fresh data should reflect update
      const capabilities = await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(capabilities[0].description).toBe('New');
    });
  });

  describe('toggleCapability', () => {
    it('enables/disables capability', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const created = await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
        enabled: true,
      });

      const service = new CapabilityService();

      // Disable
      const disabled = await service.toggleCapability('tenant-1', created._id, false);
      expect(disabled!.enabled).toBe(false);
      expect(disabled!.metadata.version).toBe(2);

      // Enable
      const enabled = await service.toggleCapability('tenant-1', created._id, true);
      expect(enabled!.enabled).toBe(true);
      expect(enabled!.metadata.version).toBe(3);
    });

    it('returns null when capability not found', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const service = new CapabilityService();
      const toggled = await service.toggleCapability('tenant-1', 'non-existent-id', false);

      expect(toggled).toBeNull();
    });

    it('invalidates cache after toggle', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const created = await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
        enabled: true,
      });

      const service = new CapabilityService();

      // Populate cache
      await service.listCapabilities({ tenantId: 'tenant-1' });

      // Toggle
      await service.toggleCapability('tenant-1', created._id, false);

      // Fresh data should reflect toggle
      const capabilities = await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(capabilities[0].enabled).toBe(false);
    });
  });

  describe('deleteCapability', () => {
    it('deletes capability', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const created = await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();
      const deleted = await service.deleteCapability('tenant-1', created._id);

      expect(deleted).toBe(true);

      // Verify it's gone
      const capability = await service.getCapabilityById('tenant-1', created._id);
      expect(capability).toBeNull();
    });

    it('returns false when capability not found', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const service = new CapabilityService();
      const deleted = await service.deleteCapability('tenant-1', 'non-existent-id');

      expect(deleted).toBe(false);
    });

    it('invalidates cache after deletion', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      const created = await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();

      // Populate cache
      await service.listCapabilities({ tenantId: 'tenant-1' });

      // Delete
      await service.deleteCapability('tenant-1', created._id);

      // Fresh data should not include deleted capability
      const capabilities = await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(capabilities).toHaveLength(0);
    });
  });

  describe('getCapabilitiesByType', () => {
    it('groups capabilities by type', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      await createCapability({
        tenantId: 'tenant-1',
        name: 'sum',
        type: 'aggregation',
        description: 'Sum',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['sum'],
        examples: ['sum revenue'],
      });

      await createCapability({
        tenantId: 'tenant-1',
        name: 'equals',
        type: 'operator',
        description: 'Equals',
        supportedFieldTypes: ['text'],
        triggerKeywords: ['equals'],
        examples: ['field equals value'],
      });

      await createCapability({
        tenantId: 'tenant-1',
        name: 'asc',
        type: 'sort',
        description: 'Ascending',
        supportedFieldTypes: ['number', 'text'],
        triggerKeywords: ['ascending'],
        examples: ['sort asc'],
      });

      const service = new CapabilityService();
      const grouped = await service.getCapabilitiesByType('tenant-1');

      expect(grouped.aggregationFunctions).toHaveLength(2);
      expect(grouped.aggregationFunctions[0].name).toBe('count');
      expect(grouped.aggregationFunctions[1].name).toBe('sum');

      expect(grouped.filterOperators).toHaveLength(1);
      expect(grouped.filterOperators[0].name).toBe('equals');

      expect(grouped.sortOperators).toHaveLength(1);
      expect(grouped.sortOperators[0].name).toBe('asc');
    });

    it('only includes enabled capabilities', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
        enabled: true,
      });

      await createCapability({
        tenantId: 'tenant-1',
        name: 'sum',
        type: 'aggregation',
        description: 'Sum',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['sum'],
        examples: ['sum revenue'],
        enabled: false,
      });

      const service = new CapabilityService();
      const grouped = await service.getCapabilitiesByType('tenant-1');

      expect(grouped.aggregationFunctions).toHaveLength(1);
      expect(grouped.aggregationFunctions[0].name).toBe('count');
    });
  });

  describe('cache management', () => {
    it('clears cache for tenant', async (ctx) => {
      if (!isMongoReady()) return ctx.skip();

      await createCapability({
        tenantId: 'tenant-1',
        name: 'count',
        type: 'aggregation',
        description: 'Count',
        supportedFieldTypes: ['number'],
        triggerKeywords: ['count'],
        examples: ['count items'],
      });

      const service = new CapabilityService();

      // Populate cache
      await service.listCapabilities({ tenantId: 'tenant-1' });
      expect(service.getCacheStats().size).toBeGreaterThan(0);

      // Clear cache
      service.clearCache('tenant-1');

      // Verify cache is cleared for tenant-1
      const stats = service.getCacheStats();
      expect(stats.size).toBe(0);
    });

    it('provides cache statistics', () => {
      const service = new CapabilityService();
      const stats = service.getCacheStats();

      expect(stats).toHaveProperty('size');
      expect(stats).toHaveProperty('max');
      expect(typeof stats.size).toBe('number');
      expect(typeof stats.max).toBe('number');
    });
  });
});
