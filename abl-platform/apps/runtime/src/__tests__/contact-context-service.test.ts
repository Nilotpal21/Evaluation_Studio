/**
 * ContactContextService Tests
 *
 * Validates cache hit/miss behaviour, fail-open Redis error handling,
 * update + invalidate wiring, and the null-Redis fallback path.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  ContactContextService,
  type ContactContext,
  type ContactContextRepo,
} from '../services/contact-context-service.js';

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-001';
const CONTACT_ID = 'contact-abc';

const SAMPLE_CONTEXT: ContactContext = {
  preferences: { language: 'en', theme: 'dark' },
  dataValues: { plan: 'premium', region: 'us-east' },
  lastDisposition: 'completed',
  lastInteraction: new Date('2026-01-15T10:00:00Z'),
  sessionCount: 3,
  updatedAt: new Date('2026-01-15T10:00:00Z'),
};

// Cache key produced by the service for the fixture IDs
const EXPECTED_CACHE_KEY = `ctx:${TENANT_ID}:${CONTACT_ID}`;

// =============================================================================
// MOCK HELPERS
// =============================================================================

function createMockRedis() {
  return {
    get: vi.fn<[string], Promise<string | null>>(),
    set: vi.fn<[string, string, string, number], Promise<unknown>>(),
    del: vi.fn<string[], Promise<number>>(),
  };
}

function createMockRepo(overrides: Partial<ContactContextRepo> = {}): ContactContextRepo {
  return {
    getContactContext: vi
      .fn<[string, string], Promise<ContactContext | null>>()
      .mockResolvedValue(null),
    updateContactContext: vi
      .fn<[string, string, ContactContext], Promise<void>>()
      .mockResolvedValue(undefined),
    ...overrides,
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('ContactContextService', () => {
  // ---------------------------------------------------------------------------
  // get() — cache hit
  // ---------------------------------------------------------------------------

  describe('get() — cache hit', () => {
    it('returns the parsed cached value without calling the repo', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(JSON.stringify(SAMPLE_CONTEXT));

      const repo = createMockRepo();
      const service = new ContactContextService(redis, repo);

      const result = await service.get(TENANT_ID, CONTACT_ID);

      expect(redis.get).toHaveBeenCalledWith(EXPECTED_CACHE_KEY);
      expect(repo.getContactContext).not.toHaveBeenCalled();
      // JSON round-trip converts Dates to ISO strings — compare the deserialized form
      expect(result).toEqual(JSON.parse(JSON.stringify(SAMPLE_CONTEXT)));
    });

    it('uses the correct composite cache key', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(JSON.stringify(SAMPLE_CONTEXT));

      const service = new ContactContextService(redis, createMockRepo());
      await service.get('other-tenant', 'other-contact');

      expect(redis.get).toHaveBeenCalledWith('ctx:other-tenant:other-contact');
    });
  });

  // ---------------------------------------------------------------------------
  // get() — cache miss
  // ---------------------------------------------------------------------------

  describe('get() — cache miss', () => {
    it('falls through to DB when cache returns null', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(null);
      redis.set.mockResolvedValue('OK');

      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(SAMPLE_CONTEXT),
      });
      const service = new ContactContextService(redis, repo);

      const result = await service.get(TENANT_ID, CONTACT_ID);

      expect(repo.getContactContext).toHaveBeenCalledWith(TENANT_ID, CONTACT_ID);
      expect(result).toEqual(SAMPLE_CONTEXT);
    });

    it('populates the cache after a DB hit', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(null);
      redis.set.mockResolvedValue('OK');

      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(SAMPLE_CONTEXT),
      });
      const service = new ContactContextService(redis, repo);

      await service.get(TENANT_ID, CONTACT_ID);

      expect(redis.set).toHaveBeenCalledWith(
        EXPECTED_CACHE_KEY,
        JSON.stringify(SAMPLE_CONTEXT),
        'EX',
        300,
      );
    });

    it('does not call redis.set when DB returns null', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(null);

      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(null),
      });
      const service = new ContactContextService(redis, repo);

      const result = await service.get(TENANT_ID, CONTACT_ID);

      expect(redis.set).not.toHaveBeenCalled();
      expect(result).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // get() — Redis failure (fail-open)
  // ---------------------------------------------------------------------------

  describe('get() — Redis failure (fail-open)', () => {
    it('falls back to DB when redis.get throws', async () => {
      const redis = createMockRedis();
      redis.get.mockRejectedValue(new Error('ECONNREFUSED'));

      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(SAMPLE_CONTEXT),
      });
      const service = new ContactContextService(redis, repo);

      const result = await service.get(TENANT_ID, CONTACT_ID);

      expect(repo.getContactContext).toHaveBeenCalledWith(TENANT_ID, CONTACT_ID);
      expect(result).toEqual(SAMPLE_CONTEXT);
    });

    it('does not propagate the Redis error to the caller', async () => {
      const redis = createMockRedis();
      redis.get.mockRejectedValue(new Error('Redis timeout'));

      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(null),
      });
      const service = new ContactContextService(redis, repo);

      await expect(service.get(TENANT_ID, CONTACT_ID)).resolves.toBeNull();
    });

    it('still attempts cache population even after a get error, if redis.set is healthy', async () => {
      // get throws but set works fine — we should still try to write on DB hit
      const redis = createMockRedis();
      redis.get.mockRejectedValue(new Error('transient'));
      redis.set.mockResolvedValue('OK');

      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(SAMPLE_CONTEXT),
      });
      const service = new ContactContextService(redis, repo);

      await service.get(TENANT_ID, CONTACT_ID);

      expect(redis.set).toHaveBeenCalledWith(
        EXPECTED_CACHE_KEY,
        JSON.stringify(SAMPLE_CONTEXT),
        'EX',
        300,
      );
    });

    it('does not propagate when redis.set throws after DB hit', async () => {
      const redis = createMockRedis();
      redis.get.mockResolvedValue(null);
      redis.set.mockRejectedValue(new Error('out of memory'));

      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(SAMPLE_CONTEXT),
      });
      const service = new ContactContextService(redis, repo);

      const result = await service.get(TENANT_ID, CONTACT_ID);

      // DB value is still returned even though cache write failed
      expect(result).toEqual(SAMPLE_CONTEXT);
    });
  });

  // ---------------------------------------------------------------------------
  // update()
  // ---------------------------------------------------------------------------

  describe('update()', () => {
    it('calls repo.updateContactContext with the provided context', async () => {
      const redis = createMockRedis();
      redis.del.mockResolvedValue(1);

      const repo = createMockRepo();
      const service = new ContactContextService(redis, repo);

      await service.update(TENANT_ID, CONTACT_ID, SAMPLE_CONTEXT);

      expect(repo.updateContactContext).toHaveBeenCalledWith(TENANT_ID, CONTACT_ID, SAMPLE_CONTEXT);
    });

    it('invalidates the cache after updating the repo', async () => {
      const redis = createMockRedis();
      redis.del.mockResolvedValue(1);

      const repo = createMockRepo();
      const service = new ContactContextService(redis, repo);

      await service.update(TENANT_ID, CONTACT_ID, SAMPLE_CONTEXT);

      expect(redis.del).toHaveBeenCalledWith(EXPECTED_CACHE_KEY);
    });

    it('calls repo.updateContactContext before redis.del', async () => {
      const callOrder: string[] = [];

      const redis = createMockRedis();
      redis.del.mockImplementation(async () => {
        callOrder.push('del');
        return 1;
      });

      const repo = createMockRepo({
        updateContactContext: vi.fn().mockImplementation(async () => {
          callOrder.push('update');
        }),
      });

      const service = new ContactContextService(redis, repo);
      await service.update(TENANT_ID, CONTACT_ID, SAMPLE_CONTEXT);

      expect(callOrder).toEqual(['update', 'del']);
    });
  });

  // ---------------------------------------------------------------------------
  // invalidate()
  // ---------------------------------------------------------------------------

  describe('invalidate()', () => {
    it('calls redis.del with the correct key', async () => {
      const redis = createMockRedis();
      redis.del.mockResolvedValue(1);

      const service = new ContactContextService(redis, createMockRepo());
      await service.invalidate(TENANT_ID, CONTACT_ID);

      expect(redis.del).toHaveBeenCalledWith(EXPECTED_CACHE_KEY);
    });

    it('does not propagate when redis.del throws', async () => {
      const redis = createMockRedis();
      redis.del.mockRejectedValue(new Error('connection lost'));

      const service = new ContactContextService(redis, createMockRepo());

      await expect(service.invalidate(TENANT_ID, CONTACT_ID)).resolves.toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Null Redis — always goes to DB
  // ---------------------------------------------------------------------------

  describe('null redis — always falls through to DB', () => {
    it('get() loads from DB when redis is null', async () => {
      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(SAMPLE_CONTEXT),
      });
      const service = new ContactContextService(null, repo);

      const result = await service.get(TENANT_ID, CONTACT_ID);

      expect(repo.getContactContext).toHaveBeenCalledWith(TENANT_ID, CONTACT_ID);
      expect(result).toEqual(SAMPLE_CONTEXT);
    });

    it('get() returns null from DB when no context exists and redis is null', async () => {
      const repo = createMockRepo({
        getContactContext: vi.fn().mockResolvedValue(null),
      });
      const service = new ContactContextService(null, repo);

      const result = await service.get(TENANT_ID, CONTACT_ID);

      expect(result).toBeNull();
    });

    it('update() calls repo.updateContactContext when redis is null', async () => {
      const repo = createMockRepo();
      const service = new ContactContextService(null, repo);

      await service.update(TENANT_ID, CONTACT_ID, SAMPLE_CONTEXT);

      expect(repo.updateContactContext).toHaveBeenCalledWith(TENANT_ID, CONTACT_ID, SAMPLE_CONTEXT);
    });

    it('invalidate() is a no-op when redis is null', async () => {
      const repo = createMockRepo();
      const service = new ContactContextService(null, repo);

      // Should resolve without throwing and without calling anything on repo
      await expect(service.invalidate(TENANT_ID, CONTACT_ID)).resolves.toBeUndefined();
      expect(repo.getContactContext).not.toHaveBeenCalled();
      expect(repo.updateContactContext).not.toHaveBeenCalled();
    });
  });
});
