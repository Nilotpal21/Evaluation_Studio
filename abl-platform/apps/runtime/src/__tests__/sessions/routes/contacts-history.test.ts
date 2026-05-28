/**
 * Contact History Endpoint Tests
 *
 * Tests the GET /:id/history route added to apps/runtime/src/routes/contacts.ts.
 *
 * The handler:
 *   1. Verifies the requesting tenant owns the contact (Contact.findOne)
 *   2. Builds a $lt cursor filter on message timestamp (descending, newest first)
 *   3. Fetches limit+1 docs from Message to determine hasMore
 *   4. Returns { success, messages, nextCursor, hasMore }
 *
 * Strategy: mock `@agent-platform/database/models` to control what the
 * queries return, then call the Express handler directly with fabricated
 * req/res objects — no supertest / network required.
 */

import { describe, it, expect, vi, beforeEach, beforeAll } from 'vitest';

// =============================================================================
// MOCK: @agent-platform/database/models
// =============================================================================

// Mongoose chainable query builder: .find().sort().limit().select().lean()
// and .findOne().lean()

function makeQueryBuilder(docs: any[]) {
  const builder: any = {
    sort: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    select: vi.fn(() => builder),
    lean: vi.fn(async () => docs),
  };
  return builder;
}

function makeFindOneChain(result: any) {
  return { lean: vi.fn(async () => result) };
}

const mockContactFindOne = vi.fn();
const mockMessageFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Contact: { findOne: (...args: any[]) => mockContactFindOne(...args) },
  Message: { find: (...args: any[]) => mockMessageFind(...args) },
  // Other models the route barrel may export — just stub them out
  Session: { findOne: vi.fn() },
}));

// =============================================================================
// MOCK: Express middleware dependencies (needed so the router module can load)
// =============================================================================

vi.mock('../../../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../../../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(() => true),
}));

vi.mock('../../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    contact: {
      create: vi.fn(),
      getById: vi.fn(),
      query: vi.fn(),
      findByIdentity: vi.fn(),
      update: vi.fn(),
      softDelete: vi.fn(),
      touchLastSeen: vi.fn(),
    },
    conversation: { linkContact: vi.fn() },
  })),
}));

vi.mock('../../../repos/session-repo.js', () => ({
  unlinkContactFromSessions: vi.fn(async () => {}),
}));

vi.mock('../../../services/audit-helpers.js', () => ({
  auditContactCreated: vi.fn(async () => {}),
  auditContactUpdated: vi.fn(async () => {}),
  auditContactDeleted: vi.fn(async () => {}),
  auditContactLinked: vi.fn(async () => {}),
}));

vi.mock('../../../openapi/registry.js', () => ({
  runtimeRegistry: { registerPath: vi.fn(), definitions: {} },
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router();
    return {
      router,
      route: vi.fn((method: string, path: string, _schema: any, handler: any) => {
        (router as any)[method](path, handler);
      }),
    };
  }),
}));

// =============================================================================
// HELPER: fabricate Express req / res objects
// =============================================================================

function makeReq(
  overrides: Partial<{
    params: Record<string, string>;
    query: Record<string, string>;
    tenantContext: { tenantId: string; userId?: string };
  }> = {},
): any {
  return {
    params: { id: 'contact-1' },
    query: {},
    tenantContext: { tenantId: 'tenant-1', userId: 'user-1' },
    body: {},
    ...overrides,
  };
}

function makeRes(): any {
  const res: any = {
    _status: 200,
    _body: undefined,
    status: vi.fn((code: number) => {
      res._status = code;
      return res;
    }),
    json: vi.fn((body: any) => {
      res._body = body;
      return res;
    }),
  };
  return res;
}

/** Extracts the /:id/history handler from the contacts router. */
async function getHistoryHandler() {
  // Import the router — it will register routes against Express Router
  const routerModule = await import('../../../routes/contacts.js');
  const router = (routerModule as any).default as any;

  // Walk the router's stack to find the handler registered for /:id/history
  const historyLayer = router.stack?.find((layer: any) => {
    return layer?.route?.path === '/:id/history';
  });

  if (!historyLayer) {
    throw new Error('/:id/history route not found in contacts router stack');
  }

  // The last handler in the stack is the actual implementation
  const handlers: any[] = historyLayer.route.stack.map((s: any) => s.handle);
  return handlers[handlers.length - 1];
}

// =============================================================================
// MODULE PRELOAD
// =============================================================================

// Preload the contacts module in beforeAll so the first test doesn't bear the
// cold dynamic-import overhead (~15s), which would exceed vitest.fast testTimeout.
beforeAll(async () => {
  await import('../../../routes/contacts.js');
}, 30_000);

// =============================================================================
// HELPERS
// =============================================================================

function makeMessageDoc(
  id: string,
  sessionId = 'sess-1',
  role = 'user',
  content = 'hi',
  timestamp = new Date('2025-06-01T10:00:00.000Z'),
): any {
  return { _id: id, sessionId, role, content, timestamp };
}

// =============================================================================
// TESTS
// =============================================================================

describe('GET /contacts/:id/history — authentication guard', () => {
  it('returns 401 when tenantContext is missing', async () => {
    const handler = await getHistoryHandler();

    const req = makeReq({ tenantContext: undefined as any });
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(401);
    expect(res._body.success).toBe(false);
  });
});

describe('GET /contacts/:id/history — contact ownership', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns 404 when contact does not belong to the tenant', async () => {
    const handler = await getHistoryHandler();

    // Contact.findOne returns null → contact not found for this tenant
    mockContactFindOne.mockReturnValueOnce(makeFindOneChain(null));

    const req = makeReq({ params: { id: 'contact-unknown' } });
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(404);
    expect(res._body.success).toBe(false);
    // Message.find must not be called if contact lookup fails
    expect(mockMessageFind).not.toHaveBeenCalled();
  });

  it('queries Contact.findOne with contactId and tenantId for isolation', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(
      makeFindOneChain({ _id: 'contact-1', type: 'customer' }),
    );
    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({ params: { id: 'contact-1' } });
    const res = makeRes();

    await handler(req, res);

    const [filter, projection] = mockContactFindOne.mock.calls[0];
    expect(filter._id).toBe('contact-1');
    expect(filter.tenantId).toBe('tenant-1');
    expect(projection).toMatchObject({ _id: 1, type: 1 });
  });
});

describe('GET /contacts/:id/history — first page', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns messages across sessions with hasMore=true when more exist', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-1', type: 'customer' }));

    const limit = 2;
    // Return limit+1 docs to trigger hasMore=true
    const docs = [
      makeMessageDoc('msg-3', 'sess-2', 'user', 'third'),
      makeMessageDoc('msg-2', 'sess-1', 'assistant', 'second'),
      makeMessageDoc('msg-1', 'sess-1', 'user', 'first'),
    ];
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({
      params: { id: 'c-1' },
      query: { limit: String(limit) },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res._body.success).toBe(true);
    expect(res._body.hasMore).toBe(true);
    expect(res._body.messages).toHaveLength(limit);
    // nextCursor is the ISO timestamp of the last message in the page
    expect(res._body.nextCursor).toBe(new Date('2025-06-01T10:00:00.000Z').toISOString());
  });

  it('returns hasMore=false and nextCursor=null when all messages fit on one page', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-2', type: 'customer' }));

    const docs = [makeMessageDoc('msg-a'), makeMessageDoc('msg-b')];
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({
      params: { id: 'c-2' },
      query: { limit: '10' },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res._body.success).toBe(true);
    expect(res._body.hasMore).toBe(false);
    expect(res._body.nextCursor).toBeNull();
    expect(res._body.messages).toHaveLength(2);
  });

  it('includes sessionId in each returned message', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-3', type: 'customer' }));

    const docs = [makeMessageDoc('m-1', 'session-A'), makeMessageDoc('m-2', 'session-B')];
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({ params: { id: 'c-3' } });
    const res = makeRes();

    await handler(req, res);

    expect(res._body.messages[0].sessionId).toBe('session-A');
    expect(res._body.messages[1].sessionId).toBe('session-B');
  });
});

describe('GET /contacts/:id/history — cursor pagination', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies $lt filter on timestamp when a cursor is provided', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-1', type: 'customer' }));

    const queryBuilder = makeQueryBuilder([makeMessageDoc('msg-old')]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const cursorTs = '2025-06-01T10:00:00.000Z';
    const req = makeReq({
      params: { id: 'c-1' },
      query: { cursor: cursorTs },
    });
    const res = makeRes();

    await handler(req, res);

    const [msgFilter] = mockMessageFind.mock.calls[0];
    expect(msgFilter.timestamp).toEqual({ $lt: new Date(cursorTs) });
  });

  it('does not include timestamp filter when no cursor is given', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-2', type: 'customer' }));

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({ params: { id: 'c-2' } });
    const res = makeRes();

    await handler(req, res);

    const [msgFilter] = mockMessageFind.mock.calls[0];
    expect(msgFilter.timestamp).toBeUndefined();
  });

  it('fetches limit+1 docs to determine hasMore flag correctly', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-3', type: 'customer' }));

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({
      params: { id: 'c-3' },
      query: { limit: '5' },
    });
    const res = makeRes();

    await handler(req, res);

    // .limit() should have been called with 6 (limit + 1)
    const limitArg = queryBuilder.limit.mock.calls[0][0];
    expect(limitArg).toBe(6);
  });

  it('nextCursor is the ISO timestamp of the last message in the page', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-4', type: 'customer' }));

    const ts1 = new Date('2025-06-01T12:00:00.000Z');
    const ts2 = new Date('2025-06-01T11:00:00.000Z');
    const ts3 = new Date('2025-06-01T10:00:00.000Z');
    // 3 docs for limit=2 → hasMore=true, nextCursor=timestamp of second message
    const docs = [
      makeMessageDoc('msg-10', 'sess-1', 'user', 'hi', ts1),
      makeMessageDoc('msg-9', 'sess-1', 'user', 'hi', ts2),
      makeMessageDoc('msg-8', 'sess-1', 'user', 'hi', ts3),
    ];
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({
      params: { id: 'c-4' },
      query: { limit: '2' },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res._body.hasMore).toBe(true);
    expect(res._body.messages).toHaveLength(2);
    expect(res._body.nextCursor).toBe(ts2.toISOString());
  });
});

describe('GET /contacts/:id/history — limit capping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('caps limit to 200 even when a higher value is requested', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-1', type: 'customer' }));

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({
      params: { id: 'c-1' },
      query: { limit: '9999' },
    });
    const res = makeRes();

    await handler(req, res);

    // limit should be capped to 200, so .limit(201) is the most we'd ever call
    const limitArg = queryBuilder.limit.mock.calls[0][0];
    expect(limitArg).toBeLessThanOrEqual(201);
  });

  it('returns 400 for an invalid (non-positive) limit value', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-1', type: 'customer' }));

    const req = makeReq({
      params: { id: 'c-1' },
      query: { limit: '0' },
    });
    const res = makeRes();

    await handler(req, res);

    expect(res._status).toBe(400);
    expect(res._body.success).toBe(false);
    expect(res._body.error?.code).toBe('INVALID_LIMIT');
  });

  it('uses default page size of 50 when limit is not specified', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-2', type: 'customer' }));

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({ params: { id: 'c-2' } });
    const res = makeRes();

    await handler(req, res);

    // Default limit is 50, so .limit(51) is called
    const limitArg = queryBuilder.limit.mock.calls[0][0];
    expect(limitArg).toBe(51);
  });
});

describe('GET /contacts/:id/history — Message query scoping', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scopes Message.find to both tenantId and contactId', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-1', type: 'customer' }));

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({
      params: { id: 'c-1' },
      tenantContext: { tenantId: 'tenant-42', userId: 'u-1' },
    });
    const res = makeRes();

    await handler(req, res);

    const [msgFilter] = mockMessageFind.mock.calls[0];
    expect(msgFilter.tenantId).toBe('tenant-42');
    expect(msgFilter.contactId).toBe('c-1');
  });

  it('sorts messages by timestamp descending (newest first)', async () => {
    const handler = await getHistoryHandler();

    mockContactFindOne.mockReturnValueOnce(makeFindOneChain({ _id: 'c-1', type: 'customer' }));

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const req = makeReq({ params: { id: 'c-1' } });
    const res = makeRes();

    await handler(req, res);

    const sortArg = queryBuilder.sort.mock.calls[0][0];
    expect(sortArg).toEqual({ timestamp: -1 });
  });
});
