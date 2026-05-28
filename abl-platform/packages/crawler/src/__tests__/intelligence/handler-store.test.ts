/**
 * MongoHandlerStore tests
 *
 * Tests handler storage, retrieval, success/failure tracking, and tenant isolation.
 */

import { describe, test, expect, beforeEach, vi } from 'vitest';
import { MongoHandlerStore } from '../../intelligence/handler-store/mongo-handler-store.js';
import type {
  HandlerTemplateModel,
  HandlerTemplateDoc,
} from '../../intelligence/handler-store/mongo-handler-store.js';
import type { IPageHandler } from '../../intelligence/types.js';
import type { SaveHandlerInput } from '../../intelligence/handler-store/interfaces.js';

// ---------------------------------------------------------------------------
// Mock model factory
// ---------------------------------------------------------------------------

function createMockModel(): HandlerTemplateModel & {
  _data: Map<string, HandlerTemplateDoc>;
  _reset: () => void;
} {
  const data = new Map<string, HandlerTemplateDoc>();

  function key(tenantId: string, domain: string, fingerprint: string): string {
    return `${tenantId}:${domain}:${fingerprint}`;
  }

  const model = {
    _data: data,
    _reset: () => data.clear(),

    findOneAndUpdate: vi.fn(
      async (
        filter: Record<string, unknown>,
        update: Record<string, unknown>,
        options: Record<string, unknown>,
      ) => {
        const k = key(
          filter.tenantId as string,
          filter.domain as string,
          filter.fingerprint as string,
        );
        const existing = data.get(k);
        const $set = (update as any).$set ?? {};
        const $setOnInsert = (update as any).$setOnInsert ?? {};

        if (existing) {
          const updated = { ...existing, ...$set, updatedAt: new Date() };
          data.set(k, updated);
          return (options as any).new ? updated : existing;
        }

        if ((options as any).upsert) {
          const newDoc: HandlerTemplateDoc = {
            _id: `handler_${Math.random().toString(36).slice(2)}`,
            tenantId: filter.tenantId as string,
            domain: filter.domain as string,
            fingerprint: filter.fingerprint as string,
            urlPattern: '',
            handler: {} as IPageHandler,
            trainedOn: [],
            successCount: 0,
            failureCount: 0,
            confidence: 0,
            lastUsedAt: new Date(),
            createdAt: new Date(),
            updatedAt: new Date(),
            ...$setOnInsert,
            ...$set,
          };
          data.set(k, newDoc);
          return newDoc;
        }

        return null;
      },
    ),

    findOne: vi.fn((filter: Record<string, unknown>) => {
      const k = key(
        filter.tenantId as string,
        filter.domain as string,
        filter.fingerprint as string,
      );
      const result = data.get(k) ?? null;
      return {
        lean: vi.fn(() => Promise.resolve(result)),
      };
    }),

    find: vi.fn((filter: Record<string, unknown>) => {
      const results: HandlerTemplateDoc[] = [];
      for (const doc of data.values()) {
        if (doc.tenantId === filter.tenantId && doc.domain === filter.domain) {
          results.push(doc);
        }
      }
      return {
        sort: vi.fn((sortSpec: Record<string, unknown>) => {
          // Sort by confidence descending if requested
          if ((sortSpec as any).confidence === -1) {
            results.sort((a, b) => b.confidence - a.confidence);
          }
          return {
            lean: vi.fn(() => Promise.resolve(results)),
          };
        }),
      };
    }),

    updateOne: vi.fn((filter: Record<string, unknown>, update: Record<string, unknown>) => {
      const execute = () => {
        const k = key(
          filter.tenantId as string,
          filter.domain as string,
          filter.fingerprint as string,
        );
        const existing = data.get(k);

        if (!existing) {
          return { modifiedCount: 0 };
        }

        const updated = { ...existing };
        const $set = (update as any).$set;
        const $inc = (update as any).$inc;

        if ($set) {
          Object.assign(updated, $set);
        }
        if ($inc) {
          if ($inc.successCount) {
            updated.successCount = (updated.successCount || 0) + $inc.successCount;
          }
          if ($inc.failureCount) {
            updated.failureCount = (updated.failureCount || 0) + $inc.failureCount;
          }
        }
        updated.updatedAt = new Date();
        data.set(k, updated);
        return { modifiedCount: 1 };
      };

      return {
        exec: vi.fn(() => Promise.resolve(execute())),
      };
    }),

    deleteMany: vi.fn(async (filter: Record<string, unknown>) => {
      let count = 0;
      const keysToDelete: string[] = [];
      for (const [k, doc] of data.entries()) {
        if (doc.tenantId === filter.tenantId && doc.domain === filter.domain) {
          keysToDelete.push(k);
          count++;
        }
      }
      keysToDelete.forEach((k) => data.delete(k));
      return { deletedCount: count };
    }),
  };

  return model as HandlerTemplateModel & {
    _data: Map<string, HandlerTemplateDoc>;
    _reset: () => void;
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const mockHandler: IPageHandler = {
  urlPattern: '/articles/*',
  description: 'Extract article content',
  steps: [
    { action: 'navigate', value: '/articles/1', description: 'Go to article' },
    { action: 'extract', selector: '.content', description: 'Extract content' },
  ],
  extractionSelectors: {
    title: 'h1',
    content: '.article-body',
  },
};

function makeInput(overrides?: Partial<SaveHandlerInput>): SaveHandlerInput {
  return {
    tenantId: 'tenant1',
    domain: 'example.com',
    urlPattern: '/articles/*',
    fingerprint: 'abc123def456',
    handler: mockHandler,
    trainedOn: ['https://example.com/articles/1', 'https://example.com/articles/2'],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MongoHandlerStore', () => {
  let model: ReturnType<typeof createMockModel>;
  let store: MongoHandlerStore;

  beforeEach(() => {
    model = createMockModel();
    store = new MongoHandlerStore(model);
    model._reset();
    vi.clearAllMocks();
  });

  describe('saveHandler()', () => {
    test('saves a new handler', async () => {
      await store.saveHandler(makeInput());

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: 'tenant1', domain: 'example.com', fingerprint: 'abc123def456' },
        expect.objectContaining({
          $set: expect.objectContaining({
            urlPattern: '/articles/*',
            handler: mockHandler,
            trainedOn: expect.any(Array),
          }),
          $setOnInsert: expect.objectContaining({
            tenantId: 'tenant1',
            domain: 'example.com',
            fingerprint: 'abc123def456',
            successCount: 0,
            failureCount: 0,
            confidence: 0,
          }),
        }),
        { upsert: true, new: true },
      );
    });

    test('upserts an existing handler', async () => {
      await store.saveHandler(makeInput());

      const updatedHandler = { ...mockHandler, description: 'Updated handler' };
      await store.saveHandler(makeInput({ handler: updatedHandler }));

      expect(model.findOneAndUpdate).toHaveBeenCalledTimes(2);

      // Verify the stored data was updated
      const found = await store.findByFingerprint('tenant1', 'example.com', 'abc123def456');
      expect(found).not.toBeNull();
      expect(found?.handler.description).toBe('Updated handler');
    });

    test('includes tenantId in filter', async () => {
      await store.saveHandler(makeInput({ tenantId: 'tenantX' }));

      expect(model.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: 'tenantX' }),
        expect.any(Object),
        expect.any(Object),
      );
    });
  });

  describe('findByFingerprint()', () => {
    test('returns handler when found', async () => {
      await store.saveHandler(makeInput());

      const result = await store.findByFingerprint('tenant1', 'example.com', 'abc123def456');

      expect(result).not.toBeNull();
      expect(result?.tenantId).toBe('tenant1');
      expect(result?.domain).toBe('example.com');
      expect(result?.fingerprint).toBe('abc123def456');
      expect(result?.handler).toEqual(mockHandler);
      expect(result?.trainedOn).toEqual([
        'https://example.com/articles/1',
        'https://example.com/articles/2',
      ]);
    });

    test('returns null when not found', async () => {
      const result = await store.findByFingerprint('tenant1', 'example.com', 'nonexistent');

      expect(result).toBeNull();
    });

    test('touches lastUsedAt on read', async () => {
      await store.saveHandler(makeInput());

      await store.findByFingerprint('tenant1', 'example.com', 'abc123def456');

      // updateOne should be called to touch lastUsedAt
      expect(model.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant1', domain: 'example.com', fingerprint: 'abc123def456' },
        { $set: { lastUsedAt: expect.any(Date) } },
      );
    });

    test('respects tenant isolation', async () => {
      await store.saveHandler(makeInput({ tenantId: 'tenant1' }));

      const result = await store.findByFingerprint('tenant2', 'example.com', 'abc123def456');

      expect(result).toBeNull();
    });
  });

  describe('findByDomain()', () => {
    test('returns all handlers for a domain sorted by confidence desc', async () => {
      await store.saveHandler(makeInput({ fingerprint: 'fp1' }));
      await store.saveHandler(makeInput({ fingerprint: 'fp2' }));
      await store.saveHandler(makeInput({ fingerprint: 'fp3' }));

      // Manually set different confidence values in the mock data
      const data = model._data;
      for (const [k, doc] of data.entries()) {
        if (k.endsWith(':fp1')) doc.confidence = 0.5;
        if (k.endsWith(':fp2')) doc.confidence = 0.9;
        if (k.endsWith(':fp3')) doc.confidence = 0.7;
      }

      const results = await store.findByDomain('tenant1', 'example.com');

      expect(results).toHaveLength(3);
      // Should be sorted by confidence descending
      expect(results[0].confidence).toBe(0.9);
      expect(results[1].confidence).toBe(0.7);
      expect(results[2].confidence).toBe(0.5);
    });

    test('returns empty array when no handlers exist', async () => {
      const results = await store.findByDomain('tenant1', 'nonexistent.com');

      expect(results).toEqual([]);
    });

    test('respects tenant isolation', async () => {
      await store.saveHandler(makeInput({ tenantId: 'tenant1' }));
      await store.saveHandler(makeInput({ tenantId: 'tenant2', fingerprint: 'fp2' }));

      const results = await store.findByDomain('tenant1', 'example.com');

      expect(results).toHaveLength(1);
      expect(results[0].tenantId).toBe('tenant1');
    });
  });

  describe('recordSuccess()', () => {
    test('increments successCount and recalculates confidence', async () => {
      await store.saveHandler(makeInput());

      await store.recordSuccess('tenant1', 'example.com', 'abc123def456');

      const result = await store.findByFingerprint('tenant1', 'example.com', 'abc123def456');

      expect(result).not.toBeNull();
      expect(result?.successCount).toBe(1);
      // confidence = 1 / (1 + 0) = 1.0
      expect(result?.confidence).toBe(1);
    });

    test('updates lastUsedAt', async () => {
      await store.saveHandler(makeInput());

      await store.recordSuccess('tenant1', 'example.com', 'abc123def456');

      // updateOne is called with lastUsedAt in $set
      expect(model.updateOne).toHaveBeenCalledWith(
        { tenantId: 'tenant1', domain: 'example.com', fingerprint: 'abc123def456' },
        expect.objectContaining({
          $inc: { successCount: 1 },
          $set: { lastUsedAt: expect.any(Date) },
        }),
      );
    });

    test('calculates confidence correctly with mixed results', async () => {
      await store.saveHandler(makeInput());

      // Manually set counts to simulate 3 successes, 1 failure
      const k = 'tenant1:example.com:abc123def456';
      const doc = model._data.get(k);
      if (doc) {
        doc.successCount = 3;
        doc.failureCount = 1;
      }

      await store.recordSuccess('tenant1', 'example.com', 'abc123def456');

      const result = await store.findByFingerprint('tenant1', 'example.com', 'abc123def456');
      // After recordSuccess: successCount = 4, failureCount = 1
      // confidence = 4 / (4 + 1) = 0.8
      expect(result?.successCount).toBe(4);
      expect(result?.confidence).toBe(0.8);
    });
  });

  describe('recordFailure()', () => {
    test('increments failureCount and recalculates confidence', async () => {
      await store.saveHandler(makeInput());

      // Give it one success first
      const k = 'tenant1:example.com:abc123def456';
      const doc = model._data.get(k);
      if (doc) {
        doc.successCount = 1;
      }

      await store.recordFailure('tenant1', 'example.com', 'abc123def456');

      const result = await store.findByFingerprint('tenant1', 'example.com', 'abc123def456');

      expect(result).not.toBeNull();
      expect(result?.failureCount).toBe(1);
      // confidence = 1 / (1 + 1) = 0.5
      expect(result?.confidence).toBe(0.5);
    });

    test('does not update lastUsedAt on failure', async () => {
      await store.saveHandler(makeInput());

      await store.recordFailure('tenant1', 'example.com', 'abc123def456');

      // The updateOne for recordFailure should NOT have lastUsedAt in $set
      const failureCall = model.updateOne.mock.calls.find((call: unknown[]) => {
        const update = call[1] as Record<string, unknown>;
        return (update as any).$inc?.failureCount === 1;
      });
      expect(failureCall).toBeDefined();
      // $set should not contain lastUsedAt for failure
      expect((failureCall?.[1] as any)?.$set?.lastUsedAt).toBeUndefined();
    });
  });

  describe('deleteByDomain()', () => {
    test('deletes all handlers for a domain', async () => {
      await store.saveHandler(makeInput({ fingerprint: 'fp1' }));
      await store.saveHandler(makeInput({ fingerprint: 'fp2' }));
      await store.saveHandler(makeInput({ fingerprint: 'fp3' }));

      const deleted = await store.deleteByDomain('tenant1', 'example.com');

      expect(deleted).toBe(3);

      const results = await store.findByDomain('tenant1', 'example.com');
      expect(results).toHaveLength(0);
    });

    test('returns 0 when no handlers exist', async () => {
      const deleted = await store.deleteByDomain('tenant1', 'nonexistent.com');

      expect(deleted).toBe(0);
    });

    test('respects tenant isolation', async () => {
      await store.saveHandler(makeInput({ tenantId: 'tenant1', fingerprint: 'fp1' }));
      await store.saveHandler(makeInput({ tenantId: 'tenant2', fingerprint: 'fp2' }));

      const deleted = await store.deleteByDomain('tenant1', 'example.com');

      expect(deleted).toBe(1);

      // tenant2's handler should still exist
      const results = await store.findByDomain('tenant2', 'example.com');
      expect(results).toHaveLength(1);
    });

    test('includes tenantId in deleteMany filter', async () => {
      await store.deleteByDomain('tenant1', 'example.com');

      expect(model.deleteMany).toHaveBeenCalledWith({
        tenantId: 'tenant1',
        domain: 'example.com',
      });
    });
  });
});
