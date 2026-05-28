/**
 * Session Messages Cursor Pagination Tests
 *
 * Tests `findMessagesForSessionCursor` from session-repo.ts.
 *
 * The function signature:
 *   findMessagesForSessionCursor(
 *     sessionId: string,
 *     tenantId: string,
 *     options: { cursor?: string; limit?: number; direction?: 'asc' | 'desc'; excludeInternalCoordination?: boolean }
 *   ): Promise<{ messages, nextCursor, hasMore }>
 *
 * Strategy: mock `@agent-platform/database/models` so the tests run without
 * a real MongoDB connection, and verify the query logic through the mock's
 * call arguments.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// =============================================================================
// MOCK: @agent-platform/database/models
// =============================================================================

// Mongoose's query builder is chainable: .find().sort().limit().select().lean()
// The mock factory below returns a builder that tracks what was called and
// resolves to the configured `docs` array on .lean().

function makeQueryBuilder(docs: any[]) {
  const builder: any = {
    sort: vi.fn(() => builder),
    limit: vi.fn(() => builder),
    select: vi.fn(() => builder),
    lean: vi.fn(async () => docs),
    // Make the builder thenable so `await Message.find().sort().limit().select()` resolves to docs
    then: vi.fn((resolve: any, reject?: any) => Promise.resolve(docs).then(resolve, reject)),
  };
  return builder;
}

const mockSessionFindOne = vi.fn();
const mockMessageFind = vi.fn();

vi.mock('@agent-platform/database/models', () => ({
  Session: { findOne: (...args: any[]) => mockSessionFindOne(...args) },
  Message: { find: (...args: any[]) => mockMessageFind(...args) },
}));

// =============================================================================
// IMPORT UNDER TEST (after mocks are registered)
// =============================================================================

const { findMessagesForSessionCursor } = await import('../../../repos/session-repo.js');

// =============================================================================
// HELPERS
// =============================================================================

/** Builds a minimal message doc as MongoDB would return from .lean(). */
function makeDoc(
  id: string,
  role = 'user',
  content = 'hello',
  metadata?: Record<string, unknown>,
): any {
  return {
    _id: id,
    role,
    content,
    timestamp: new Date('2025-01-01T00:00:00Z'),
    ...(metadata ? { metadata } : {}),
  };
}

/** Default chainable .lean() for Session.findOne() returning a found session. */
function sessionFoundChain(session: any = { _id: 'sess-1' }) {
  return { lean: vi.fn(async () => session) };
}

/** Default chainable .lean() for Session.findOne() returning null (not found). */
function sessionNotFoundChain() {
  return { lean: vi.fn(async () => null) };
}

// =============================================================================
// TESTS
// =============================================================================

describe('findMessagesForSessionCursor — first page (no cursor)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns the first N messages and hasMore=true when more exist', async () => {
    // Session belongs to tenant
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    // Query returns limit+1 docs → hasMore is true
    const limit = 3;
    const docs = [makeDoc('id-1'), makeDoc('id-2'), makeDoc('id-3'), makeDoc('id-4')]; // 4 docs for limit=3
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const result = await findMessagesForSessionCursor('sess-1', 'tenant-1', { limit });

    expect(result.hasMore).toBe(true);
    expect(result.messages).toHaveLength(limit);
    expect(result.messages[0].id).toBe('id-1');
    expect(result.messages[limit - 1].id).toBe('id-3');
    // nextCursor is the id of the last message in the page
    expect(result.nextCursor).toBe('id-3');
  });

  it('returns hasMore=false and nextCursor=null when all messages fit in one page', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const docs = [makeDoc('id-1'), makeDoc('id-2')];
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const result = await findMessagesForSessionCursor('sess-1', 'tenant-1', { limit: 5 });

    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
    expect(result.messages).toHaveLength(2);
  });

  it('returns empty result when session has no messages', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const result = await findMessagesForSessionCursor('sess-1', 'tenant-1', {});

    expect(result.messages).toHaveLength(0);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();
  });
});

// =============================================================================
// Subsequent page with cursor
// =============================================================================

describe('findMessagesForSessionCursor — cursor-based pagination', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('applies $lt filter on _id when direction is desc and cursor is provided', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const docs = [makeDoc('id-10'), makeDoc('id-9')];
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-1', 'tenant-1', {
      cursor: 'id-11',
      limit: 5,
      direction: 'desc',
    });

    // Message.find() must have been called with the cursor $lt filter
    const findArgs = mockMessageFind.mock.calls[0][0];
    expect(findArgs._id).toEqual({ $lt: 'id-11' });
  });

  it('applies $gt filter on _id when direction is asc and cursor is provided', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const docs = [makeDoc('id-3'), makeDoc('id-4')];
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-1', 'tenant-1', {
      cursor: 'id-2',
      limit: 5,
      direction: 'asc',
    });

    const findArgs = mockMessageFind.mock.calls[0][0];
    expect(findArgs._id).toEqual({ $gt: 'id-2' });
  });

  it('does not include _id filter when no cursor is provided', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([makeDoc('id-1')]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-1', 'tenant-1', { limit: 5 });

    const findArgs = mockMessageFind.mock.calls[0][0];
    expect(findArgs._id).toBeUndefined();
  });

  it('can exclude internal coordination messages in the database query', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([makeDoc('id-1')]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-1', 'tenant-1', {
      limit: 5,
      excludeInternalCoordination: true,
    });

    const findArgs = mockMessageFind.mock.calls[0][0];
    expect(findArgs.$and).toEqual([
      {
        $or: [
          { 'metadata.responseVisibility': { $exists: false } },
          { 'metadata.responseVisibility': { $ne: 'internal' } },
        ],
      },
      {
        $or: [
          { 'metadata.coordination.visibility': { $exists: false } },
          { 'metadata.coordination.visibility': { $ne: 'internal' } },
        ],
      },
    ]);
  });

  it('nextCursor points to the last message id in the returned page', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    // 3 docs returned for limit=2 → hasMore=true, nextCursor=second message id
    const docs = [makeDoc('msg-a'), makeDoc('msg-b'), makeDoc('msg-c')];
    const queryBuilder = makeQueryBuilder(docs);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const result = await findMessagesForSessionCursor('sess-1', 'tenant-1', { limit: 2 });

    expect(result.hasMore).toBe(true);
    expect(result.messages).toHaveLength(2);
    expect(result.nextCursor).toBe('msg-b');
  });

  it('preserves message metadata when present on stored messages', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([
      makeDoc('id-meta', 'assistant', 'reply', {
        isLlmGenerated: true,
        responseProvenance: {
          schemaVersion: 1,
          kind: 'llm',
          disclaimerRequired: true,
          usedLlmInternally: true,
        },
      }),
    ]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    const result = await findMessagesForSessionCursor('sess-1', 'tenant-1', { limit: 5 });

    expect(result.messages).toHaveLength(1);
    expect(result.messages[0].metadata).toEqual({
      isLlmGenerated: true,
      responseProvenance: {
        schemaVersion: 1,
        kind: 'llm',
        disclaimerRequired: true,
        usedLlmInternally: true,
      },
    });
    expect(queryBuilder.select).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: 1,
      }),
    );
  });
});

// =============================================================================
// Tenant isolation
// =============================================================================

describe('findMessagesForSessionCursor — tenant isolation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('returns empty result when session does not belong to the requesting tenant', async () => {
    // Session.findOne returns null (wrong tenant)
    mockSessionFindOne.mockReturnValueOnce(sessionNotFoundChain());

    const result = await findMessagesForSessionCursor('sess-1', 'wrong-tenant', {});

    expect(result.messages).toEqual([]);
    expect(result.hasMore).toBe(false);
    expect(result.nextCursor).toBeNull();

    // Message.find must NOT have been called at all
    expect(mockMessageFind).not.toHaveBeenCalled();
  });

  it('passes both sessionId and tenantId to Session.findOne for ownership check', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-abc', 'tenant-xyz', {});

    const [filter] = mockSessionFindOne.mock.calls[0];
    expect(filter._id).toBe('sess-abc');
    expect(filter.tenantId).toBe('tenant-xyz');
  });

  it('also passes tenantId to Message.find for row-level scoping', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-abc', 'tenant-xyz', {});

    const [msgFilter] = mockMessageFind.mock.calls[0];
    expect(msgFilter.tenantId).toBe('tenant-xyz');
    expect(msgFilter.sessionId).toBe('sess-abc');
  });
});

// =============================================================================
// Limit parameter
// =============================================================================

describe('findMessagesForSessionCursor — limit capping', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('caps limit at 200 even when a higher value is requested', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-1', 'tenant-1', { limit: 9999 });

    // The query builder's .limit() should have been called with at most 201 (200 + 1 for hasMore)
    const limitCall = queryBuilder.limit.mock.calls[0][0];
    expect(limitCall).toBeLessThanOrEqual(201);
  });

  it('uses default page size of 50 when limit is not specified', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-1', 'tenant-1', {});

    // Default is 50, so limit+1 = 51
    const limitCall = queryBuilder.limit.mock.calls[0][0];
    expect(limitCall).toBe(51);
  });
});

// =============================================================================
// Sort direction
// =============================================================================

describe('findMessagesForSessionCursor — sort direction', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sorts by _id descending (-1) by default', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-1', 'tenant-1', {});

    const sortArg = queryBuilder.sort.mock.calls[0][0];
    expect(sortArg).toEqual({ _id: -1 });
  });

  it('sorts by _id ascending (1) when direction=asc', async () => {
    mockSessionFindOne.mockReturnValueOnce(sessionFoundChain());

    const queryBuilder = makeQueryBuilder([]);
    mockMessageFind.mockReturnValueOnce(queryBuilder);

    await findMessagesForSessionCursor('sess-1', 'tenant-1', { direction: 'asc' });

    const sortArg = queryBuilder.sort.mock.calls[0][0];
    expect(sortArg).toEqual({ _id: 1 });
  });
});
