/**
 * User Preference Store tests
 *
 * Tests the MongoDB-based user preference store including:
 * - Domain pattern matching (exact and wildcard)
 * - Tenant isolation
 * - Usage tracking
 * - CRUD operations
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MongoUserPreferenceStore } from '../../decision/user-preference-store.js';
import type { UserPreference, CrawlStrategy } from '../../decision/interfaces.js';
import { UserCrawlPreference, type IUserCrawlPreference } from '@agent-platform/database/models';

// Mock the database model
vi.mock('@agent-platform/database/models', () => ({
  UserCrawlPreference: {
    findOne: vi.fn(),
    find: vi.fn(),
    findOneAndUpdate: vi.fn(),
    deleteOne: vi.fn(),
    updateOne: vi.fn(),
  },
}));

// ========================================
// Test Fixtures
// ========================================

const createMockPreference = (
  overrides: Partial<IUserCrawlPreference> = {},
): IUserCrawlPreference => ({
  _id: 'pref-123',
  userId: 'user-456',
  tenantId: 'tenant-789',
  domainPattern: 'example.com',
  strategy: 'bulk',
  batchSize: 50,
  concurrency: 10,
  autoDecide: true,
  useCount: 5,
  lastUsed: new Date('2024-01-15'),
  createdAt: new Date('2024-01-01'),
  updatedAt: new Date('2024-01-15'),
  ...overrides,
});

// ========================================
// Tests
// ========================================

describe('MongoUserPreferenceStore', () => {
  let store: MongoUserPreferenceStore;

  beforeEach(() => {
    store = new MongoUserPreferenceStore();
    vi.clearAllMocks();
  });

  describe('getPreference()', () => {
    test('finds exact match preference', async () => {
      const mockPref = createMockPreference();
      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPref),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'example.com');

      expect(result).toBeDefined();
      expect(result?.id).toBe('pref-123');
      expect(result?.domainPattern).toBe('example.com');
      expect(result?.strategy).toBe('bulk');
      expect(result?.useCount).toBe(5);
    });

    test('normalizes domain when searching', async () => {
      const mockPref = createMockPreference();
      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPref),
      } as any);

      await store.getPreference('user-456', 'tenant-789', 'EXAMPLE.COM');

      expect(UserCrawlPreference.findOne).toHaveBeenCalledWith({
        userId: 'user-456',
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
      });
    });

    test('extracts domain from URL', async () => {
      const mockPref = createMockPreference();
      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPref),
      } as any);

      await store.getPreference('user-456', 'tenant-789', 'https://example.com/path');

      expect(UserCrawlPreference.findOne).toHaveBeenCalledWith({
        userId: 'user-456',
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
      });
    });

    test('returns null when no preference found', async () => {
      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'example.com');

      expect(result).toBeNull();
    });

    test('matches wildcard pattern *.example.com', async () => {
      const mockPref = createMockPreference({
        domainPattern: '*.example.com',
      });

      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([mockPref]),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'sub.example.com');

      expect(result).toBeDefined();
      expect(result?.domainPattern).toBe('*.example.com');
    });

    test('wildcard pattern matches base domain', async () => {
      const mockPref = createMockPreference({
        domainPattern: '*.example.com',
      });

      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([mockPref]),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'example.com');

      expect(result).toBeDefined();
    });

    test('wildcard pattern does not match unrelated domain', async () => {
      const mockPref = createMockPreference({
        domainPattern: '*.example.com',
      });

      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([mockPref]),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'other.com');

      expect(result).toBeNull();
    });

    test('prefers exact match over wildcard', async () => {
      const exactPref = createMockPreference({
        _id: 'exact-123',
        domainPattern: 'sub.example.com',
      });

      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(exactPref),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'sub.example.com');

      expect(result?.id).toBe('exact-123');
      expect(result?.domainPattern).toBe('sub.example.com');

      // Should not check wildcards if exact match found
      expect(UserCrawlPreference.find).not.toHaveBeenCalled();
    });

    test('respects tenant isolation', async () => {
      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(null),
      } as any);

      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        lean: vi.fn().mockResolvedValue([]),
      } as any);

      await store.getPreference('user-456', 'tenant-A', 'example.com');

      expect(UserCrawlPreference.findOne).toHaveBeenCalledWith({
        userId: 'user-456',
        tenantId: 'tenant-A',
        domainPattern: 'example.com',
      });
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockRejectedValue(new Error('Database connection failed')),
      } as any);

      await expect(store.getPreference('user-456', 'tenant-789', 'example.com')).rejects.toThrow(
        'Failed to get user preference',
      );
    });
  });

  describe('savePreference()', () => {
    test('creates new preference', async () => {
      const mockResult = createMockPreference({
        _id: 'new-pref-123',
        useCount: 0,
      });

      vi.mocked(UserCrawlPreference.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const input: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: 'user-456',
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
        strategy: 'bulk',
        batchSize: 50,
        concurrency: 10,
        autoDecide: true,
        useCount: 0,
        lastUsed: new Date(),
      };

      const result = await store.savePreference(input);

      expect(result.id).toBe('new-pref-123');
      expect(result.strategy).toBe('bulk');
      expect(result.batchSize).toBe(50);
      expect(result.concurrency).toBe(10);
    });

    test('updates existing preference', async () => {
      const mockResult = createMockPreference({
        _id: 'existing-123',
        strategy: 'hybrid',
        batchSize: 20,
        useCount: 10,
      });

      vi.mocked(UserCrawlPreference.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const input: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: 'user-456',
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
        strategy: 'hybrid',
        batchSize: 20,
        autoDecide: true,
        useCount: 10,
        lastUsed: new Date(),
      };

      const result = await store.savePreference(input);

      expect(result.id).toBe('existing-123');
      expect(result.strategy).toBe('hybrid');
      expect(result.batchSize).toBe(20);
    });

    test('normalizes domain pattern', async () => {
      const mockResult = createMockPreference({
        domainPattern: 'example.com',
      });

      vi.mocked(UserCrawlPreference.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const input: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: 'user-456',
        tenantId: 'tenant-789',
        domainPattern: 'EXAMPLE.COM',
        strategy: 'bulk',
        autoDecide: true,
        useCount: 0,
        lastUsed: new Date(),
      };

      await store.savePreference(input);

      expect(UserCrawlPreference.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          domainPattern: 'example.com',
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    test('handles wildcard patterns', async () => {
      const mockResult = createMockPreference({
        domainPattern: '*.example.com',
      });

      vi.mocked(UserCrawlPreference.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const input: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: 'user-456',
        tenantId: 'tenant-789',
        domainPattern: '*.example.com',
        strategy: 'hybrid',
        autoDecide: true,
        useCount: 0,
        lastUsed: new Date(),
      };

      const result = await store.savePreference(input);

      expect(result.domainPattern).toBe('*.example.com');
    });

    test('respects tenant isolation', async () => {
      const mockResult = createMockPreference({
        tenantId: 'tenant-A',
      });

      vi.mocked(UserCrawlPreference.findOneAndUpdate).mockResolvedValue(mockResult as any);

      const input: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: 'user-456',
        tenantId: 'tenant-A',
        domainPattern: 'example.com',
        strategy: 'bulk',
        autoDecide: true,
        useCount: 0,
        lastUsed: new Date(),
      };

      await store.savePreference(input);

      expect(UserCrawlPreference.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-A',
        }),
        expect.anything(),
        expect.anything(),
      );
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(UserCrawlPreference.findOneAndUpdate).mockRejectedValue(new Error('Duplicate key'));

      const input: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: 'user-456',
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
        strategy: 'bulk',
        autoDecide: true,
        useCount: 0,
        lastUsed: new Date(),
      };

      await expect(store.savePreference(input)).rejects.toThrow('Failed to save user preference');
    });

    test('throws error when result is null', async () => {
      vi.mocked(UserCrawlPreference.findOneAndUpdate).mockResolvedValue(null);

      const input: Omit<UserPreference, 'id' | 'createdAt' | 'updatedAt'> = {
        userId: 'user-456',
        tenantId: 'tenant-789',
        domainPattern: 'example.com',
        strategy: 'bulk',
        autoDecide: true,
        useCount: 0,
        lastUsed: new Date(),
      };

      await expect(store.savePreference(input)).rejects.toThrow('Failed to save user preference');
    });
  });

  describe('deletePreference()', () => {
    test('deletes existing preference', async () => {
      vi.mocked(UserCrawlPreference.deleteOne).mockResolvedValue({
        deletedCount: 1,
      } as any);

      const result = await store.deletePreference('pref-123');

      expect(result).toBe(true);
      expect(UserCrawlPreference.deleteOne).toHaveBeenCalledWith({ _id: 'pref-123' });
    });

    test('returns false when preference not found', async () => {
      vi.mocked(UserCrawlPreference.deleteOne).mockResolvedValue({
        deletedCount: 0,
      } as any);

      const result = await store.deletePreference('nonexistent');

      expect(result).toBe(false);
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(UserCrawlPreference.deleteOne).mockRejectedValue(new Error('Database error'));

      await expect(store.deletePreference('pref-123')).rejects.toThrow(
        'Failed to delete user preference',
      );
    });
  });

  describe('listPreferences()', () => {
    test('lists all preferences for user and tenant', async () => {
      const mockPrefs = [
        createMockPreference({ _id: 'pref-1', domainPattern: 'example.com' }),
        createMockPreference({ _id: 'pref-2', domainPattern: '*.example.com' }),
        createMockPreference({ _id: 'pref-3', domainPattern: 'other.com' }),
      ];

      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockPrefs),
        }),
      } as any);

      const result = await store.listPreferences('user-456', 'tenant-789');

      expect(result).toHaveLength(3);
      expect(result[0].id).toBe('pref-1');
      expect(result[1].id).toBe('pref-2');
      expect(result[2].id).toBe('pref-3');
    });

    test('sorts by lastUsed descending', async () => {
      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await store.listPreferences('user-456', 'tenant-789');

      const findResult = UserCrawlPreference.find({
        userId: 'user-456',
        tenantId: 'tenant-789',
      });

      expect(findResult.sort).toHaveBeenCalledWith({ lastUsed: -1 });
    });

    test('returns empty array when no preferences', async () => {
      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      const result = await store.listPreferences('user-456', 'tenant-789');

      expect(result).toEqual([]);
    });

    test('respects tenant isolation', async () => {
      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([]),
        }),
      } as any);

      await store.listPreferences('user-456', 'tenant-A');

      expect(UserCrawlPreference.find).toHaveBeenCalledWith({
        userId: 'user-456',
        tenantId: 'tenant-A',
      });
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(UserCrawlPreference.find).mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockRejectedValue(new Error('Query timeout')),
        }),
      } as any);

      await expect(store.listPreferences('user-456', 'tenant-789')).rejects.toThrow(
        'Failed to list user preferences',
      );
    });
  });

  describe('trackUsage()', () => {
    test('increments useCount and updates lastUsed', async () => {
      vi.mocked(UserCrawlPreference.updateOne).mockResolvedValue({} as any);

      await store.trackUsage('pref-123');

      expect(UserCrawlPreference.updateOne).toHaveBeenCalledWith(
        { _id: 'pref-123' },
        expect.objectContaining({
          $inc: { useCount: 1 },
          $set: expect.objectContaining({ lastUsed: expect.any(Date) }),
        }),
      );
    });

    test('throws DecisionError on database error', async () => {
      vi.mocked(UserCrawlPreference.updateOne).mockRejectedValue(new Error('Update failed'));

      await expect(store.trackUsage('pref-123')).rejects.toThrow(
        'Failed to track preference usage',
      );
    });
  });

  describe('Edge Cases', () => {
    test('handles preferences with minimal fields', async () => {
      const minimalPref = createMockPreference({
        batchSize: undefined,
        concurrency: undefined,
      });

      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(minimalPref),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'example.com');

      expect(result).toBeDefined();
      expect(result?.batchSize).toBeUndefined();
      expect(result?.concurrency).toBeUndefined();
    });

    test('handles autoDecide false', async () => {
      const mockPref = createMockPreference({
        autoDecide: false,
      });

      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPref),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'example.com');

      expect(result?.autoDecide).toBe(false);
    });

    test('handles very long domain patterns', async () => {
      const longPattern = 'very.long.subdomain.structure.example.com';
      const mockPref = createMockPreference({
        domainPattern: longPattern,
      });

      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPref),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', longPattern);

      expect(result?.domainPattern).toBe(longPattern);
    });

    test('handles zero useCount', async () => {
      const mockPref = createMockPreference({
        useCount: 0,
      });

      vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
        lean: vi.fn().mockResolvedValue(mockPref),
      } as any);

      const result = await store.getPreference('user-456', 'tenant-789', 'example.com');

      expect(result?.useCount).toBe(0);
    });

    test('handles different strategy types', async () => {
      const strategies: CrawlStrategy[] = ['browser', 'bulk', 'hybrid'];

      for (const strategy of strategies) {
        const mockPref = createMockPreference({ strategy });

        vi.mocked(UserCrawlPreference.findOne).mockReturnValue({
          lean: vi.fn().mockResolvedValue(mockPref),
        } as any);

        const result = await store.getPreference('user-456', 'tenant-789', 'example.com');

        expect(result?.strategy).toBe(strategy);
      }
    });
  });
});
