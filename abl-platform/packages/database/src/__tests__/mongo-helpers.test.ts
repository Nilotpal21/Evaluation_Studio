/**
 * MongoDB Helpers Tests
 *
 * Tests for: pagination, aggregation pipeline builders, retry & circuit breaker
 *
 * Pipeline builder tests are pure-logic (no MongoDB needed).
 * Pagination integration tests that need a real DB use mongoAvailable guard.
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import mongoose from 'mongoose';
import {
  setupTestMongo,
  teardownTestMongo,
  clearCollections,
  isMongoReady,
} from './helpers/setup-mongo.js';

import {
  buildOffsetPaginationPipeline,
  parseOffsetPaginationResult,
  buildCursorPaginationPipeline,
  parseCursorPaginationResult,
  normalizePaginationOptions,
  normalizeCursorOptions,
} from '../mongo/helpers/pagination.js';

import {
  buildTenantPipeline,
  buildDateRangeStage,
  buildDateRangePipeline,
  buildPaginatedPipeline,
  buildTimeBucketPipeline,
  buildLookupStage,
  buildLookupOneStage,
  buildCountByFieldPipeline,
} from '../mongo/helpers/aggregation.js';

import { withRetry, CircuitBreaker, CircuitBreakerOpenError } from '../mongo/helpers/retry.js';

import { uuidv7 } from '../mongo/base-document.js';

// =============================================================================
// SETUP / TEARDOWN
// =============================================================================

beforeAll(async () => {
  await setupTestMongo();
});

afterAll(async () => {
  await teardownTestMongo();
});

beforeEach(async () => {
  await clearCollections();
});

// =============================================================================
// HELPERS
// =============================================================================

let modelCounter = 0;
function uniqueModelName(prefix: string): string {
  return `${prefix}_${++modelCounter}_${Date.now()}`;
}

function createNetworkError(): Error {
  const error = new Error('ECONNREFUSED');
  error.name = 'MongoNetworkError';
  return error;
}

// =============================================================================
// PAGINATION HELPERS (pure logic)
// =============================================================================

describe('Pagination Helpers', () => {
  describe('buildOffsetPaginationPipeline', () => {
    test('builds pipeline with defaults', () => {
      const pipeline = buildOffsetPaginationPipeline();
      expect(pipeline).toHaveLength(2);
      expect(pipeline[0]).toHaveProperty('$sort');
      expect(pipeline[1]).toHaveProperty('$facet');
    });

    test('applies custom page and limit', () => {
      const pipeline = buildOffsetPaginationPipeline({ page: 3, limit: 10 });
      const facet = (pipeline[1] as any).$facet;
      expect(facet.data[0].$skip).toBe(20);
      expect(facet.data[1].$limit).toBe(10);
    });

    test('clamps page to minimum 1', () => {
      const pipeline = buildOffsetPaginationPipeline({ page: -5 });
      const facet = (pipeline[1] as any).$facet;
      expect(facet.data[0].$skip).toBe(0);
    });

    test('clamps limit to maximum 100', () => {
      const pipeline = buildOffsetPaginationPipeline({ limit: 500 });
      const facet = (pipeline[1] as any).$facet;
      expect(facet.data[1].$limit).toBe(100);
    });

    test('applies custom sort', () => {
      const pipeline = buildOffsetPaginationPipeline({ sort: { name: 1 } });
      expect((pipeline[0] as any).$sort).toEqual({ name: 1 });
    });
  });

  describe('parseOffsetPaginationResult', () => {
    test('parses a normal page result', () => {
      const result = parseOffsetPaginationResult(
        { data: [{ id: '1' }, { id: '2' }], total: [{ count: 50 }] },
        { page: 1, limit: 20 },
      );
      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(50);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.totalPages).toBe(3);
      expect(result.hasNext).toBe(true);
      expect(result.hasPrev).toBe(false);
    });

    test('handles empty results', () => {
      const result = parseOffsetPaginationResult({ data: [], total: [] }, { page: 1, limit: 20 });
      expect(result.data).toHaveLength(0);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
      expect(result.hasNext).toBe(false);
      expect(result.hasPrev).toBe(false);
    });

    test('sets hasPrev for pages > 1', () => {
      const result = parseOffsetPaginationResult(
        { data: [{ id: '1' }], total: [{ count: 50 }] },
        { page: 2, limit: 20 },
      );
      expect(result.hasPrev).toBe(true);
    });

    test('last page has no hasNext', () => {
      const result = parseOffsetPaginationResult(
        { data: [{ id: '1' }], total: [{ count: 10 }] },
        { page: 1, limit: 20 },
      );
      expect(result.totalPages).toBe(1);
      expect(result.hasNext).toBe(false);
    });
  });

  describe('buildCursorPaginationPipeline', () => {
    test('builds pipeline without cursor', () => {
      const pipeline = buildCursorPaginationPipeline();
      expect(pipeline.some((s: any) => s.$sort)).toBe(true);
      expect(pipeline.some((s: any) => s.$limit)).toBe(true);
    });

    test('builds pipeline with cursor (forward, descending)', () => {
      const pipeline = buildCursorPaginationPipeline({
        cursor: 'abc',
        sort: { _id: -1 },
        direction: 'forward',
      });
      const matchStage = pipeline.find((s: any) => s.$match);
      expect((matchStage as any).$match._id.$lt).toBe('abc');
    });

    test('builds pipeline with cursor (forward, ascending)', () => {
      const pipeline = buildCursorPaginationPipeline({
        cursor: 'abc',
        sort: { _id: 1 },
        direction: 'forward',
      });
      const matchStage = pipeline.find((s: any) => s.$match);
      expect((matchStage as any).$match._id.$gt).toBe('abc');
    });

    test('builds pipeline with cursor (backward, descending)', () => {
      const pipeline = buildCursorPaginationPipeline({
        cursor: 'abc',
        sort: { _id: -1 },
        direction: 'backward',
      });
      const matchStage = pipeline.find((s: any) => s.$match);
      expect((matchStage as any).$match._id.$gt).toBe('abc');
    });

    test('fetches limit+1 for hasMore detection', () => {
      const pipeline = buildCursorPaginationPipeline({ limit: 10 });
      const limitStage = pipeline.find((s: any) => s.$limit);
      expect((limitStage as any).$limit).toBe(11);
    });
  });

  describe('parseCursorPaginationResult', () => {
    test('detects hasMore when extra doc present', () => {
      const docs = [{ _id: 'a' }, { _id: 'b' }, { _id: 'c' }] as any[];
      const result = parseCursorPaginationResult(docs, 2, false);
      expect(result.hasMore).toBe(true);
      expect(result.data).toHaveLength(2);
      expect(result.nextCursor).toBe('b');
    });

    test('no hasMore when exact docs', () => {
      const docs = [{ _id: 'a' }, { _id: 'b' }] as any[];
      const result = parseCursorPaginationResult(docs, 2, false);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
    });

    test('sets prevCursor when hasCursor is true', () => {
      const docs = [{ _id: 'a' }, { _id: 'b' }] as any[];
      const result = parseCursorPaginationResult(docs, 5, true);
      expect(result.prevCursor).toBe('a');
    });

    test('no prevCursor when hasCursor is false', () => {
      const docs = [{ _id: 'a' }] as any[];
      const result = parseCursorPaginationResult(docs, 5, false);
      expect(result.prevCursor).toBeNull();
    });

    test('handles empty results', () => {
      const result = parseCursorPaginationResult([], 20, false);
      expect(result.data).toHaveLength(0);
      expect(result.hasMore).toBe(false);
      expect(result.nextCursor).toBeNull();
      expect(result.prevCursor).toBeNull();
    });
  });

  describe('normalizePaginationOptions', () => {
    test('applies defaults for empty options', () => {
      const opts = normalizePaginationOptions({});
      expect(opts.page).toBe(1);
      expect(opts.limit).toBe(20);
      expect(opts.sort).toEqual({ createdAt: -1 });
    });

    test('clamps page to minimum 1', () => {
      expect(normalizePaginationOptions({ page: 0 }).page).toBe(1);
    });

    test('clamps limit to maximum 100', () => {
      expect(normalizePaginationOptions({ limit: 200 }).limit).toBe(100);
    });

    test('clamps limit to minimum 1', () => {
      expect(normalizePaginationOptions({ limit: 0 }).limit).toBe(1);
    });
  });

  describe('normalizeCursorOptions', () => {
    test('applies defaults for empty options', () => {
      const opts = normalizeCursorOptions({});
      expect(opts.cursor).toBe('');
      expect(opts.limit).toBe(20);
      expect(opts.sort).toEqual({ _id: -1 });
      expect(opts.direction).toBe('forward');
    });

    test('clamps limit to maximum 100', () => {
      expect(normalizeCursorOptions({ limit: 999 }).limit).toBe(100);
    });
  });

  describe('offset pagination with real MongoDB', () => {
    test('returns correct page', async () => {
      if (!isMongoReady()) return;
      const name = uniqueModelName('PaginationIntTest');
      const schema = new mongoose.Schema({
        _id: { type: String, default: uuidv7 },
        name: String,
        createdAt: { type: Date, default: Date.now },
      });
      const TestModel = mongoose.model(name, schema);
      const docs = Array.from({ length: 25 }, (_, i) => ({
        name: `item-${String(i).padStart(2, '0')}`,
      }));
      await TestModel.insertMany(docs);

      const pipeline = [{ $match: {} }, ...buildOffsetPaginationPipeline({ page: 1, limit: 10 })];
      const [result] = await TestModel.aggregate(pipeline);
      expect(result.data).toHaveLength(10);
      expect(result.total[0].count).toBe(25);
    });

    test('last page has fewer items', async () => {
      if (!isMongoReady()) return;
      const name = uniqueModelName('PaginationIntTest2');
      const schema = new mongoose.Schema({
        _id: { type: String, default: uuidv7 },
        name: String,
        createdAt: { type: Date, default: Date.now },
      });
      const TestModel = mongoose.model(name, schema);
      const docs = Array.from({ length: 25 }, (_, i) => ({ name: `item-${i}` }));
      await TestModel.insertMany(docs);

      const pipeline = [{ $match: {} }, ...buildOffsetPaginationPipeline({ page: 3, limit: 10 })];
      const [result] = await TestModel.aggregate(pipeline);
      expect(result.data).toHaveLength(5);
    });
  });
});

// =============================================================================
// AGGREGATION HELPERS (pure logic)
// =============================================================================

describe('Aggregation Helpers', () => {
  describe('buildTenantPipeline', () => {
    test('prepends $match by tenantId', () => {
      const stages = buildTenantPipeline('t1', [{ $group: { _id: null, count: { $sum: 1 } } }]);
      expect(stages[0]).toEqual({ $match: { tenantId: 't1' } });
      expect(stages).toHaveLength(2);
    });

    test('works with empty stages array', () => {
      const stages = buildTenantPipeline('t1', []);
      expect(stages).toHaveLength(1);
    });
  });

  describe('buildDateRangeStage', () => {
    test('builds $match with $gte and $lt', () => {
      const start = new Date('2024-01-01');
      const end = new Date('2024-02-01');
      const stage = buildDateRangeStage('createdAt', start, end);
      expect(stage).toEqual({ $match: { createdAt: { $gte: start, $lt: end } } });
    });
  });

  describe('buildDateRangePipeline', () => {
    test('builds pipeline without tenant', () => {
      const stages = buildDateRangePipeline(
        'createdAt',
        new Date('2024-01-01'),
        new Date('2024-02-01'),
      );
      expect(stages).toHaveLength(1);
    });

    test('builds pipeline with tenant and additional stages', () => {
      const stages = buildDateRangePipeline(
        'createdAt',
        new Date('2024-01-01'),
        new Date('2024-02-01'),
        {
          tenantId: 't1',
          additionalStages: [{ $group: { _id: null, count: { $sum: 1 } } }],
        },
      );
      expect(stages).toHaveLength(3);
      expect(stages[0]).toEqual({ $match: { tenantId: 't1' } });
    });
  });

  describe('buildPaginatedPipeline', () => {
    test('builds $facet with sort, skip, limit', () => {
      const stages = buildPaginatedPipeline({ status: 'active' }, { createdAt: -1 }, 1, 10);
      expect(stages[0]).toEqual({ $match: { status: 'active' } });
      const facet = (stages[1] as any).$facet;
      expect(facet.data).toBeDefined();
      expect(facet.total).toBeDefined();
    });

    test('clamps page to minimum 1', () => {
      const stages = buildPaginatedPipeline({}, { _id: 1 }, -1, 10);
      const facet = (stages[1] as any).$facet;
      expect(facet.data[1].$skip).toBe(0);
    });

    test('clamps limit to maximum 100', () => {
      const stages = buildPaginatedPipeline({}, { _id: 1 }, 1, 200);
      const facet = (stages[1] as any).$facet;
      expect(facet.data[2].$limit).toBe(100);
    });

    test('includes preFacetStages', () => {
      const stages = buildPaginatedPipeline({}, { _id: 1 }, 1, 10, {
        preFacetStages: [
          { $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' } },
        ],
      });
      expect(stages).toHaveLength(3);
    });
  });

  describe('buildTimeBucketPipeline', () => {
    test('builds time bucket pipeline', () => {
      const stages = buildTimeBucketPipeline('createdAt', 'day', { count: { $sum: 1 } });
      expect(stages.some((s: any) => s.$group)).toBe(true);
      expect(stages.some((s: any) => s.$sort)).toBe(true);
    });

    test('includes tenant filter when provided', () => {
      const stages = buildTimeBucketPipeline(
        'createdAt',
        'hour',
        { count: { $sum: 1 } },
        { tenantId: 't1' },
      );
      expect(stages[0]).toEqual({ $match: { tenantId: 't1' } });
    });

    test('includes date range when provided', () => {
      const stages = buildTimeBucketPipeline(
        'createdAt',
        'month',
        { count: { $sum: 1 } },
        {
          start: new Date('2024-01-01'),
          end: new Date('2024-02-01'),
        },
      );
      const dateMatch = stages.find((s: any) => s.$match?.createdAt);
      expect(dateMatch).toBeDefined();
    });
  });

  describe('buildLookupStage', () => {
    test('builds a $lookup stage', () => {
      const stage = buildLookupStage('users', 'userId', '_id', 'user');
      expect(stage).toEqual({
        $lookup: { from: 'users', localField: 'userId', foreignField: '_id', as: 'user' },
      });
    });
  });

  describe('buildLookupOneStage', () => {
    test('builds $lookup + $unwind stages', () => {
      const stages = buildLookupOneStage('users', 'userId', '_id', 'user');
      expect(stages).toHaveLength(2);
      expect(stages[0]).toHaveProperty('$lookup');
      expect(stages[1]).toHaveProperty('$unwind');
      expect((stages[1] as any).$unwind.preserveNullAndEmptyArrays).toBe(true);
    });
  });

  describe('buildCountByFieldPipeline', () => {
    test('builds group + sort + project pipeline', () => {
      const stages = buildCountByFieldPipeline('status');
      expect(stages).toHaveLength(3);
      expect((stages[0] as any).$group._id).toBe('$status');
      expect((stages[1] as any).$sort.count).toBe(-1);
      expect((stages[2] as any).$project._id).toBe(0);
    });

    test('includes filter when provided', () => {
      const stages = buildCountByFieldPipeline('status', { tenantId: 't1' });
      expect(stages).toHaveLength(4);
      expect(stages[0]).toEqual({ $match: { tenantId: 't1' } });
    });

    test('works with real MongoDB', async () => {
      if (!isMongoReady()) return;
      const name = uniqueModelName('CountByFieldTest');
      const schema = new mongoose.Schema({
        _id: { type: String, default: uuidv7 },
        status: String,
      });
      const TestModel = mongoose.model(name, schema);
      await TestModel.insertMany([
        { status: 'active' },
        { status: 'active' },
        { status: 'inactive' },
      ]);
      const result = await TestModel.aggregate(buildCountByFieldPipeline('status'));
      expect(result).toHaveLength(2);
      const activeEntry = result.find((r: any) => r.value === 'active');
      expect(activeEntry?.count).toBe(2);
    });
  });
});

// =============================================================================
// RETRY & CIRCUIT BREAKER (pure logic)
// =============================================================================

describe('Retry Helpers', () => {
  describe('withRetry', () => {
    test('returns result on first attempt success', async () => {
      const fn = vi.fn().mockResolvedValue('success');
      const result = await withRetry(fn, { maxRetries: 3 });
      expect(result).toBe('success');
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('retries on transient error and succeeds', async () => {
      const fn = vi.fn().mockRejectedValueOnce(createNetworkError()).mockResolvedValue('recovered');
      const result = await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, jitter: false });
      expect(result).toBe('recovered');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('does not retry on non-transient errors', async () => {
      const error = new Error('ValidationError');
      error.name = 'ValidationError';
      const fn = vi.fn().mockRejectedValue(error);
      await expect(withRetry(fn, { maxRetries: 3, baseDelayMs: 1 })).rejects.toThrow(
        'ValidationError',
      );
      expect(fn).toHaveBeenCalledTimes(1);
    });

    test('gives up after maxRetries', async () => {
      const fn = vi.fn().mockRejectedValue(createNetworkError());
      await expect(
        withRetry(fn, { maxRetries: 2, baseDelayMs: 1, jitter: false }),
      ).rejects.toThrow();
      expect(fn).toHaveBeenCalledTimes(3);
    });

    test('calls onRetry callback on each retry', async () => {
      const onRetry = vi.fn();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createNetworkError())
        .mockRejectedValueOnce(createNetworkError())
        .mockResolvedValue('ok');
      await withRetry(fn, { maxRetries: 3, baseDelayMs: 1, jitter: false, onRetry });
      expect(onRetry).toHaveBeenCalledTimes(2);
      expect(onRetry.mock.calls[0][1]).toBe(1);
      expect(onRetry.mock.calls[1][1]).toBe(2);
    });

    test('uses custom shouldRetry predicate', async () => {
      const fn = vi
        .fn()
        .mockRejectedValueOnce(new Error('custom-retryable'))
        .mockResolvedValue('ok');
      const result = await withRetry(fn, {
        maxRetries: 3,
        baseDelayMs: 1,
        jitter: false,
        shouldRetry: (e) => (e as Error).message === 'custom-retryable',
      });
      expect(result).toBe('ok');
      expect(fn).toHaveBeenCalledTimes(2);
    });

    test('caps delay at maxDelayMs', async () => {
      const onRetry = vi.fn();
      const fn = vi
        .fn()
        .mockRejectedValueOnce(createNetworkError())
        .mockRejectedValueOnce(createNetworkError())
        .mockRejectedValueOnce(createNetworkError())
        .mockResolvedValue('ok');
      await withRetry(fn, {
        maxRetries: 5,
        baseDelayMs: 1000,
        maxDelayMs: 2000,
        jitter: false,
        onRetry,
      });
      const thirdDelay = onRetry.mock.calls[2]?.[2];
      if (thirdDelay !== undefined) {
        expect(thirdDelay).toBeLessThanOrEqual(2000);
      }
    });
  });

  describe('CircuitBreaker', () => {
    test('starts in closed state', () => {
      expect(new CircuitBreaker().state).toBe('closed');
    });

    test('allows execution in closed state', async () => {
      const cb = new CircuitBreaker();
      expect(await cb.execute(() => Promise.resolve('ok'))).toBe('ok');
    });

    test('transitions to open after failure threshold', async () => {
      const onStateChange = vi.fn();
      const cb = new CircuitBreaker({ failureThreshold: 3, onStateChange });
      for (let i = 0; i < 3; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }
      expect(cb.state).toBe('open');
      expect(onStateChange).toHaveBeenCalledWith('closed', 'open');
    });

    test('throws CircuitBreakerOpenError when open', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      await expect(cb.execute(() => Promise.resolve('ok'))).rejects.toThrow(
        CircuitBreakerOpenError,
      );
    });

    test('resets failure count on success', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      for (let i = 0; i < 2; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }
      await cb.execute(() => Promise.resolve('ok'));
      for (let i = 0; i < 2; i++) {
        await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      }
      expect(cb.state).toBe('closed');
    });

    test('transitions open -> half-open after resetTimeout', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      expect(cb.state).toBe('open');
      await new Promise((r) => setTimeout(r, 20));
      expect(cb.state).toBe('half-open');
    });

    test('transitions half-open -> closed after successful attempts', async () => {
      const cb = new CircuitBreaker({
        failureThreshold: 1,
        resetTimeoutMs: 10,
        halfOpenMaxAttempts: 2,
      });
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
      expect(cb.state).toBe('half-open');
      await cb.execute(() => Promise.resolve('ok'));
      await cb.execute(() => Promise.resolve('ok'));
      expect(cb.state).toBe('closed');
    });

    test('transitions half-open -> open on failure', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 10 });
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      await new Promise((r) => setTimeout(r, 20));
      expect(cb.state).toBe('half-open');
      await cb.execute(() => Promise.reject(new Error('fail again'))).catch(() => {});
      expect(cb.state).toBe('open');
    });

    test('reset() returns to closed state', async () => {
      const cb = new CircuitBreaker({ failureThreshold: 1 });
      await cb.execute(() => Promise.reject(new Error('fail'))).catch(() => {});
      expect(cb.state).toBe('open');
      cb.reset();
      expect(cb.state).toBe('closed');
    });

    test('CircuitBreakerOpenError has correct name', () => {
      const error = new CircuitBreakerOpenError('test');
      expect(error.name).toBe('CircuitBreakerOpenError');
      expect(error.message).toBe('test');
    });
  });
});
