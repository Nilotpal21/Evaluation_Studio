/**
 * Tests for FactStore
 *
 * Tests persistent memory storage with TTL, namespacing, and batch operations.
 */

import { describe, test, expect, beforeEach, afterEach, vi } from 'vitest';
import { InMemoryFactStore, type FactStoreConfig } from '../../platform/stores/fact-store.js';

describe('InMemoryFactStore', () => {
  let store: InMemoryFactStore;
  const config: FactStoreConfig = {
    type: 'memory',
    environment: 'dev',
    keyPrefix: 'test:',
  };

  beforeEach(() => {
    store = new InMemoryFactStore(config);
    vi.useFakeTimers();
  });

  afterEach(() => {
    store.stop();
    vi.useRealTimers();
  });

  describe('Basic Operations', () => {
    describe('set and get', () => {
      test('should store and retrieve a value', async () => {
        await store.set({ key: 'key1', value: 'value1' });
        const result = await store.get({ key: 'key1' });

        expect(result?.value).toBe('value1');
      });

      test('should store complex objects', async () => {
        const obj = { name: 'John', age: 30, nested: { data: 'test' } };
        await store.set({ key: 'user', value: obj });
        const result = await store.get({ key: 'user' });

        expect(result?.value).toEqual(obj);
      });

      test('should return null for non-existent key', async () => {
        const result = await store.get({ key: 'nonexistent' });

        expect(result).toBeNull();
      });

      test('should overwrite existing value', async () => {
        await store.set({ key: 'key', value: 'original' });
        await store.set({ key: 'key', value: 'updated' });
        const result = await store.get({ key: 'key' });

        expect(result?.value).toBe('updated');
      });

      test('should preserve created date on update', async () => {
        await store.set({ key: 'key', value: 'original' });
        const first = await store.get({ key: 'key' });

        vi.advanceTimersByTime(1000);

        await store.set({ key: 'key', value: 'updated' });
        const second = await store.get({ key: 'key' });

        expect(second?.createdAt).toEqual(first?.createdAt);
        expect(second?.updatedAt.getTime()).toBeGreaterThan(first?.updatedAt.getTime() || 0);
      });
    });

    describe('exists', () => {
      test('should return true for existing key', async () => {
        await store.set({ key: 'key', value: 'value' });

        expect(await store.exists('key')).toBe(true);
      });

      test('should return false for non-existent key', async () => {
        expect(await store.exists('nonexistent')).toBe(false);
      });
    });

    describe('delete', () => {
      test('should delete existing key', async () => {
        await store.set({ key: 'key', value: 'value' });
        const deleted = await store.delete('key');

        expect(deleted).toBe(true);
        expect(await store.get({ key: 'key' })).toBeNull();
      });

      test('should return false for non-existent key', async () => {
        const deleted = await store.delete('nonexistent');

        expect(deleted).toBe(false);
      });
    });
  });

  describe('TTL (Time-To-Live)', () => {
    test('should store value with TTL', async () => {
      await store.set({ key: 'temp', value: 'value', ttlMs: 1000 });

      expect((await store.get({ key: 'temp' }))?.value).toBe('value');
    });

    test('should expire value after TTL', async () => {
      await store.set({ key: 'temp', value: 'value', ttlMs: 1000 });

      // Advance time past TTL
      vi.advanceTimersByTime(1001);

      expect(await store.get({ key: 'temp' })).toBeNull();
    });

    test('should not expire value before TTL', async () => {
      await store.set({ key: 'temp', value: 'value', ttlMs: 1000 });

      // Advance time but not past TTL
      vi.advanceTimersByTime(500);

      expect((await store.get({ key: 'temp' }))?.value).toBe('value');
    });

    test('should update TTL on overwrite', async () => {
      await store.set({ key: 'key', value: 'value1', ttlMs: 1000 });

      // Advance time partially
      vi.advanceTimersByTime(800);

      // Overwrite with new TTL
      await store.set({ key: 'key', value: 'value2', ttlMs: 1000 });

      // Original would have expired, but new TTL should still be valid
      vi.advanceTimersByTime(500);

      expect((await store.get({ key: 'key' }))?.value).toBe('value2');
    });
  });

  describe('Query Operations', () => {
    test('should query by prefix', async () => {
      await store.set({ key: 'user.1', value: 'a' });
      await store.set({ key: 'user.2', value: 'b' });
      await store.set({ key: 'system.1', value: 'c' });

      const userFacts = await store.query({ prefix: 'user.' });

      expect(userFacts).toHaveLength(2);
      expect(userFacts.map((f) => f.key)).toContain('user.1');
      expect(userFacts.map((f) => f.key)).toContain('user.2');
    });

    test('should filter by source type', async () => {
      await store.set({ key: 'key1', value: 'a', source: { type: 'agent', agentName: 'Test' } });
      await store.set({ key: 'key2', value: 'b', source: { type: 'system' } });

      const agentFacts = await store.query({ sourceType: 'agent' });

      expect(agentFacts).toHaveLength(1);
      expect(agentFacts[0].key).toBe('key1');
    });

    test('should exclude expired facts by default', async () => {
      await store.set({ key: 'active', value: 'a' });
      await store.set({ key: 'expired', value: 'b', ttlMs: 100 });

      vi.advanceTimersByTime(200);

      const facts = await store.query({});

      expect(facts.map((f) => f.key)).toContain('active');
      expect(facts.map((f) => f.key)).not.toContain('expired');
    });

    test('should include expired facts when requested', async () => {
      await store.set({ key: 'active', value: 'a' });
      await store.set({ key: 'expired', value: 'b', ttlMs: 100 });

      vi.advanceTimersByTime(200);

      const facts = await store.query({ includeExpired: true });

      expect(facts).toHaveLength(2);
    });

    test('should limit results', async () => {
      await store.set({ key: 'key1', value: 'a' });
      await store.set({ key: 'key2', value: 'b' });
      await store.set({ key: 'key3', value: 'c' });

      const facts = await store.query({ limit: 2 });

      expect(facts).toHaveLength(2);
    });
  });

  describe('Batch Operations', () => {
    describe('batchSet', () => {
      test('should store multiple values at once', async () => {
        const facts = await store.batchSet({
          facts: [
            { key: 'key1', value: 'value1' },
            { key: 'key2', value: 'value2' },
            { key: 'key3', value: 'value3' },
          ],
        });

        expect(facts).toHaveLength(3);
        expect((await store.get({ key: 'key1' }))?.value).toBe('value1');
        expect((await store.get({ key: 'key2' }))?.value).toBe('value2');
        expect((await store.get({ key: 'key3' }))?.value).toBe('value3');
      });

      test('should support TTL in batch operations', async () => {
        await store.batchSet({
          facts: [
            { key: 'temp1', value: 'value1', ttlMs: 1000 },
            { key: 'temp2', value: 'value2', ttlMs: 2000 },
          ],
        });

        vi.advanceTimersByTime(1500);

        expect(await store.get({ key: 'temp1' })).toBeNull();
        expect((await store.get({ key: 'temp2' }))?.value).toBe('value2');
      });
    });

    describe('batchDelete', () => {
      test('should delete multiple values', async () => {
        await store.set({ key: 'key1', value: 'a' });
        await store.set({ key: 'key2', value: 'b' });
        await store.set({ key: 'key3', value: 'c' });

        const deleted = await store.batchDelete(['key1', 'key2']);

        expect(deleted).toBe(2);
        expect(await store.exists('key1')).toBe(false);
        expect(await store.exists('key2')).toBe(false);
        expect(await store.exists('key3')).toBe(true);
      });
    });
  });

  describe('User Facts', () => {
    test('should store and retrieve user facts', async () => {
      await store.setUserFact('user123', 'name', 'John');
      await store.setUserFact('user123', 'tier', 'gold');

      expect(await store.getUserFact('user123', 'name')).toBe('John');
      expect(await store.getUserFact('user123', 'tier')).toBe('gold');
    });

    test('should isolate facts between users', async () => {
      await store.setUserFact('user1', 'pref', 'A');
      await store.setUserFact('user2', 'pref', 'B');

      expect(await store.getUserFact('user1', 'pref')).toBe('A');
      expect(await store.getUserFact('user2', 'pref')).toBe('B');
    });

    test('should list all facts for a user', async () => {
      await store.setUserFact('user123', 'fact1', 'value1');
      await store.setUserFact('user123', 'fact2', 'value2');
      await store.setUserFact('other', 'fact3', 'value3');

      const facts = await store.getForUser('user123');

      expect(facts).toHaveLength(2);
      expect(facts.map((f) => f.value)).toContain('value1');
      expect(facts.map((f) => f.value)).toContain('value2');
    });
  });

  describe('System Facts', () => {
    test('should store and retrieve system facts', async () => {
      await store.setSystemFact('version', '1.0');
      await store.setSystemFact('enabled', true);

      expect(await store.getSystemFact('version')).toBe('1.0');
      expect(await store.getSystemFact('enabled')).toBe(true);
    });
  });

  describe('Session Facts', () => {
    test('should store and retrieve session facts', async () => {
      const sessionKey = 'session123.started';
      await store.set({ key: sessionKey, value: new Date().toISOString() });

      const result = await store.get({ key: sessionKey });
      expect(result?.value).toBeDefined();
    });

    test('should query session facts', async () => {
      await store.set({ key: 'session.123.fact1', value: 'value1' });
      await store.set({ key: 'session.123.fact2', value: 'value2' });
      await store.set({ key: 'session.456.fact3', value: 'value3' });

      const facts = await store.query({ prefix: 'session.123.' });

      expect(facts).toHaveLength(2);
    });
  });

  describe('Cleanup', () => {
    test('should cleanup expired facts', async () => {
      await store.set({ key: 'active', value: 'a' });
      await store.set({ key: 'expired1', value: 'b', ttlMs: 100 });
      await store.set({ key: 'expired2', value: 'c', ttlMs: 100 });

      vi.advanceTimersByTime(200);

      const cleaned = await store.cleanup();

      expect(cleaned).toBe(2);
    });
  });

  describe('Clear', () => {
    test('should clear all facts', async () => {
      await store.set({ key: 'key1', value: 'a' });
      await store.set({ key: 'key2', value: 'b' });

      const cleared = await store.clear();

      expect(cleared).toBe(2);
      expect(await store.exists('key1')).toBe(false);
      expect(await store.exists('key2')).toBe(false);
    });
  });

  describe('Edge Cases', () => {
    test('should handle empty key', async () => {
      await store.set({ key: '', value: 'value' });
      const result = await store.get({ key: '' });
      expect(result?.value).toBe('value');
    });

    test('should handle null and undefined values', async () => {
      await store.set({ key: 'null', value: null });

      const nullResult = await store.get({ key: 'null' });
      expect(nullResult?.value).toBeNull();
    });

    test('should handle special characters in keys', async () => {
      await store.set({ key: 'key:with:colons', value: 'value1' });
      await store.set({ key: 'key/with/slashes', value: 'value2' });
      await store.set({ key: 'key.with.dots', value: 'value3' });

      expect((await store.get({ key: 'key:with:colons' }))?.value).toBe('value1');
      expect((await store.get({ key: 'key/with/slashes' }))?.value).toBe('value2');
      expect((await store.get({ key: 'key.with.dots' }))?.value).toBe('value3');
    });

    test('should handle large values', async () => {
      const largeValue = 'x'.repeat(100000); // 100KB string
      await store.set({ key: 'large', value: largeValue });

      expect((await store.get({ key: 'large' }))?.value).toBe(largeValue);
    });
  });

  describe('getValue convenience method', () => {
    test('should return value directly', async () => {
      await store.set({ key: 'test', value: 'hello' });

      const value = await store.getValue<string>('test');
      expect(value).toBe('hello');
    });

    test('should return default value when key not found', async () => {
      const value = await store.getValue<string>('nonexistent', 'default');
      expect(value).toBe('default');
    });
  });
});
