import { describe, it, expect } from 'vitest';
import {
  getClickHouseManifest,
  getRedisQueueManifest,
  CLICKHOUSE_ENCRYPTION_MANIFEST,
  REDIS_QUEUE_ENCRYPTION_MANIFEST,
} from '../index.js';

describe('encryption-manifest', () => {
  describe('getClickHouseManifest', () => {
    it('returns config for registered table ("messages" has "content")', () => {
      const config = getClickHouseManifest('messages');
      expect(config.fieldsToEncrypt).toContain('content');
    });

    it('returns empty fields for non-sensitive table ("llm_metrics")', () => {
      const config = getClickHouseManifest('llm_metrics');
      expect(config.fieldsToEncrypt).toEqual([]);
    });

    it('throws for unregistered table with message containing table name', () => {
      expect(() => getClickHouseManifest('unknown_table')).toThrow(/unknown_table/);
    });
  });

  describe('getRedisQueueManifest', () => {
    it('returns config for registered queue ("llm-requests" has "message")', () => {
      const config = getRedisQueueManifest('llm-requests');
      expect(config.fieldsToEncrypt).toContain('message');
    });

    it('returns empty fields for non-sensitive queue ("search-ingestion")', () => {
      const config = getRedisQueueManifest('search-ingestion');
      expect(config.fieldsToEncrypt).toEqual([]);
    });

    it('throws for unregistered queue', () => {
      expect(() => getRedisQueueManifest('unknown-queue')).toThrow(/unknown-queue/);
    });
  });

  describe('completeness', () => {
    it('every manifest entry has a readonly fieldsToEncrypt array', () => {
      for (const [table, config] of Object.entries(
        CLICKHOUSE_ENCRYPTION_MANIFEST as Record<string, { fieldsToEncrypt: readonly string[] }>,
      )) {
        expect(
          Array.isArray(config.fieldsToEncrypt),
          `ClickHouse table "${table}" missing fieldsToEncrypt array`,
        ).toBe(true);
      }

      for (const [queue, config] of Object.entries(
        REDIS_QUEUE_ENCRYPTION_MANIFEST as Record<string, { fieldsToEncrypt: readonly string[] }>,
      )) {
        expect(
          Array.isArray(config.fieldsToEncrypt),
          `Redis queue "${queue}" missing fieldsToEncrypt array`,
        ).toBe(true);
      }
    });
  });
});
