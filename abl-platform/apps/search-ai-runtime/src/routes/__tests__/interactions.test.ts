import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import express, { type Express } from 'express';

// ─── Mock Dependencies ──────────────────────────────────────────────────

const { mockWriteEvents } = vi.hoisted(() => ({
  mockWriteEvents: vi.fn(),
}));

vi.mock('../../services/browse/interaction-writer.js', () => ({
  InteractionWriter: class MockInteractionWriter {
    writeEvents = mockWriteEvents;
    flush = vi.fn().mockResolvedValue(undefined);
    close = vi.fn().mockResolvedValue(undefined);
  },
}));

vi.mock('../../middleware/auth.js', () => ({
  authMiddleware: (req: any, _res: any, next: any) => {
    if (req.headers['x-no-auth']) {
      // Simulate missing tenant context for 401 test
      next();
      return;
    }
    req.tenantContext = { tenantId: 'tenant_123', userId: 'user_456' };
    if (req.headers['x-empty-user']) {
      // Simulate auth that passes but user has no id
      req.user = { id: '' };
    } else {
      req.user = { id: 'auth_user_789' };
    }
    next();
  },
}));

vi.mock('../../middleware/verify-index-ownership.js', () => ({
  verifyIndexOwnership: (_req: any, _res: any, next: any) => next(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock ClickHouse (transitively imported by interaction-writer)
vi.mock('@agent-platform/database/clickhouse', () => ({
  getClickHouseClient: () => ({}),
  BufferedClickHouseWriter: vi.fn().mockImplementation(() => ({
    insert: vi.fn(),
    flush: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  })),
}));

// ─── Tests ──────────────────────────────────────────────────────────────

describe('Interactions Router', () => {
  let app: Express;

  beforeEach(async () => {
    vi.clearAllMocks();
    vi.resetModules();

    const { createInteractionsRouter } = await import('../interactions.js');
    app = express();
    app.use(express.json());
    app.use(createInteractionsRouter());
  });

  const validEvent = {
    attributeType: 'category',
    productType: 'software',
    facetValue: 'IDE',
    interactionType: 'click' as const,
  };

  describe('POST /:indexId/browse/interactions', () => {
    it('valid batch returns { accepted: N }', async () => {
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events: [validEvent, { ...validEvent, interactionType: 'impression' }] })
        .expect(200);

      expect(res.body).toEqual({ accepted: 2 });
      expect(mockWriteEvents).toHaveBeenCalledTimes(1);
      expect(mockWriteEvents.mock.calls[0][0]).toHaveLength(2);
    });

    it('empty events array returns 400', async () => {
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events: [] })
        .expect(400);

      expect(res.body.error).toBe('Invalid request body');
    });

    it('>100 events returns 400', async () => {
      const events = Array.from({ length: 101 }, () => validEvent);
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events })
        .expect(400);

      expect(res.body.error).toBe('Invalid request body');
    });

    it('event without optional fields (attributeType, productType, facetValue) succeeds', async () => {
      const minimalEvent = { interactionType: 'search' as const };
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events: [minimalEvent] })
        .expect(200);

      expect(res.body).toEqual({ accepted: 1 });
      const writtenEvents = mockWriteEvents.mock.calls[0][0];
      expect(writtenEvents[0].attributeType).toBeUndefined();
      expect(writtenEvents[0].productType).toBeUndefined();
      expect(writtenEvents[0].facetValue).toBeUndefined();
    });

    it('invalid interactionType returns 400', async () => {
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events: [{ ...validEvent, interactionType: 'hover' }] })
        .expect(400);

      expect(res.body.error).toBe('Invalid request body');
    });

    it('missing tenant context returns 401', async () => {
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .set('x-no-auth', 'true')
        .send({ events: [validEvent] })
        .expect(401);

      expect(res.body.error).toBe('Missing tenant context');
    });

    it('facetValue exceeding 2000 chars returns 400', async () => {
      const longValue = 'x'.repeat(2001);
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events: [{ ...validEvent, facetValue: longValue }] })
        .expect(400);

      expect(res.body.error).toBe('Invalid request body');
    });

    it('userId is always server-derived from auth context, not from client body', async () => {
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events: [validEvent] })
        .expect(200);

      expect(res.body).toEqual({ accepted: 1 });
      // Verify the event passed to writeEvents has the auth userId, not any client-supplied one
      const writtenEvents = mockWriteEvents.mock.calls[0][0];
      expect(writtenEvents[0].userId).toBe('auth_user_789');
      expect(writtenEvents[0].tenantId).toBe('tenant_123');
      expect(writtenEvents[0].indexId).toBe('idx_123');
    });

    it('accepts all valid interaction types', async () => {
      const types = [
        'impression',
        'click',
        'filter',
        'expand',
        'remove',
        'search',
        'browse',
      ] as const;
      const events = types.map((t) => ({ ...validEvent, interactionType: t }));

      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events })
        .expect(200);

      expect(res.body).toEqual({ accepted: 7 });
    });

    it('accepts categoryId as optional field', async () => {
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events: [{ ...validEvent, categoryId: 'cat_123' }] })
        .expect(200);

      expect(res.body).toEqual({ accepted: 1 });
      const writtenEvents = mockWriteEvents.mock.calls[0][0];
      expect(writtenEvents[0].categoryId).toBe('cat_123');
    });

    it('exactly 100 events succeeds (boundary test)', async () => {
      const events = Array.from({ length: 100 }, () => validEvent);
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({ events })
        .expect(200);

      expect(res.body).toEqual({ accepted: 100 });
    });

    it('client-supplied userId in body is stripped by Zod (not forwarded)', async () => {
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .send({
          events: [{ ...validEvent, userId: 'attacker_user_999' }],
        })
        .expect(200);

      // Zod strips unknown keys; userId always from auth context
      const writtenEvents = mockWriteEvents.mock.calls[0][0];
      expect(writtenEvents[0].userId).toBe('auth_user_789');
      expect(writtenEvents[0].userId).not.toBe('attacker_user_999');
    });

    it('returns 401 when auth user has no id (empty userId)', async () => {
      const res = await request(app)
        .post('/idx_123/browse/interactions')
        .set('x-empty-user', 'true')
        .send({ events: [validEvent] })
        .expect(401);

      expect(res.body.error).toBe('Missing user identity');
    });
  });
});
