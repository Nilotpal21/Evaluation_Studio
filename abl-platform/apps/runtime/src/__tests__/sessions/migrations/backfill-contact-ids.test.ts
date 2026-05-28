/**
 * Backfill Message ContactId Migration Tests
 *
 * Verifies:
 * - Sessions with contactId → messages get backfilled
 * - Sessions without contactId → messages unchanged
 * - Already-backfilled messages → no-op (idempotent)
 * - Messages across multiple sessions → each gets correct contactId
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { migration } from '../../../../../../packages/database/src/migrations/scripts/20260305_009_backfill_message_contact_ids.js';

// ── In-memory mock for MongoDB Db ───────────────────────────────────────

interface MockDoc {
  _id: string;
  [key: string]: unknown;
}

function createMockDb(collections: Record<string, MockDoc[]>) {
  return {
    collection(name: string) {
      const docs = collections[name] ?? [];

      return {
        find(
          filter: Record<string, unknown>,
          opts?: { projection?: unknown; sort?: unknown; limit?: number },
        ) {
          let results = docs.filter((doc) => {
            for (const [key, condition] of Object.entries(filter)) {
              const val = doc[key];
              if (condition && typeof condition === 'object' && '$ne' in condition) {
                if (val === (condition as { $ne: unknown }).$ne) return false;
              } else if (condition && typeof condition === 'object' && '$gt' in condition) {
                if (String(val) <= String((condition as { $gt: unknown }).$gt)) return false;
              } else if (condition && typeof condition === 'object' && '$or' in condition) {
                // Skip $or at top level — handled separately
              } else if (key === '$or') {
                const orConditions = condition as Record<string, unknown>[];
                const matches = orConditions.some((orCond) =>
                  Object.entries(orCond).every(([k, v]) => {
                    if (v && typeof v === 'object' && '$exists' in v) {
                      return (v as { $exists: boolean }).$exists ? k in doc : !(k in doc);
                    }
                    return doc[k] === v;
                  }),
                );
                if (!matches) return false;
              } else {
                if (val !== condition) return false;
              }
            }
            return true;
          });

          if (opts?.sort && typeof opts.sort === 'object') {
            const sortKey = Object.keys(opts.sort as object)[0];
            results = [...results].sort((a, b) =>
              String(a[sortKey]).localeCompare(String(b[sortKey])),
            );
          }

          if (opts?.limit) {
            results = results.slice(0, opts.limit);
          }

          return {
            toArray: async () => results,
          };
        },

        async updateMany(
          filter: Record<string, unknown>,
          update: { $set: Record<string, unknown> },
        ) {
          let modifiedCount = 0;
          for (const doc of docs) {
            let matches = true;
            for (const [key, condition] of Object.entries(filter)) {
              if (key === '$or') {
                const orConditions = condition as Record<string, unknown>[];
                const orMatch = orConditions.some((orCond) =>
                  Object.entries(orCond).every(([k, v]) => {
                    if (v && typeof v === 'object' && '$exists' in v) {
                      return (v as { $exists: boolean }).$exists ? k in doc : !(k in doc);
                    }
                    return doc[k] === v;
                  }),
                );
                if (!orMatch) matches = false;
              } else {
                if (doc[key] !== condition) matches = false;
              }
            }
            if (matches) {
              Object.assign(doc, update.$set);
              modifiedCount++;
            }
          }
          return { modifiedCount };
        },
      };
    },
  } as any;
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Migration: backfill-message-contact-ids', () => {
  it('has correct version and description', () => {
    expect(migration.version).toBe('20260305_010');
    expect(migration.description).toContain('Backfill contactId');
  });

  it('backfills messages for sessions with contactId', async () => {
    const messages: MockDoc[] = [
      { _id: 'msg-1', sessionId: 'sess-1', tenantId: 't1', contactId: null },
      { _id: 'msg-2', sessionId: 'sess-1', tenantId: 't1', contactId: null },
    ];
    const sessions: MockDoc[] = [{ _id: 'sess-1', tenantId: 't1', contactId: 'contact-1' }];

    const db = createMockDb({ sessions, messages });
    await migration.up(db);

    expect(messages[0].contactId).toBe('contact-1');
    expect(messages[1].contactId).toBe('contact-1');
  });

  it('does not touch messages when session has no contactId', async () => {
    const messages: MockDoc[] = [
      { _id: 'msg-1', sessionId: 'sess-1', tenantId: 't1', contactId: null },
    ];
    const sessions: MockDoc[] = [{ _id: 'sess-1', tenantId: 't1', contactId: null }];

    const db = createMockDb({ sessions, messages });
    await migration.up(db);

    // Session has contactId: null, so it's filtered out by { $ne: null }
    expect(messages[0].contactId).toBeNull();
  });

  it('is idempotent — already-backfilled messages are not modified', async () => {
    const messages: MockDoc[] = [
      { _id: 'msg-1', sessionId: 'sess-1', tenantId: 't1', contactId: 'contact-1' },
    ];
    const sessions: MockDoc[] = [{ _id: 'sess-1', tenantId: 't1', contactId: 'contact-1' }];

    const db = createMockDb({ sessions, messages });
    await migration.up(db);

    // contactId was already set — should remain unchanged
    expect(messages[0].contactId).toBe('contact-1');
  });

  it('backfills messages across multiple sessions with correct contactId', async () => {
    const messages: MockDoc[] = [
      { _id: 'msg-1', sessionId: 'sess-1', tenantId: 't1', contactId: null },
      { _id: 'msg-2', sessionId: 'sess-2', tenantId: 't1', contactId: null },
      { _id: 'msg-3', sessionId: 'sess-2', tenantId: 't1', contactId: null },
    ];
    const sessions: MockDoc[] = [
      { _id: 'sess-1', tenantId: 't1', contactId: 'contact-A' },
      { _id: 'sess-2', tenantId: 't1', contactId: 'contact-B' },
    ];

    const db = createMockDb({ sessions, messages });
    await migration.up(db);

    expect(messages[0].contactId).toBe('contact-A');
    expect(messages[1].contactId).toBe('contact-B');
    expect(messages[2].contactId).toBe('contact-B');
  });

  it('down migration is a no-op', async () => {
    const db = createMockDb({ sessions: [], messages: [] });
    // Should not throw
    await migration.down(db);
  });
});
