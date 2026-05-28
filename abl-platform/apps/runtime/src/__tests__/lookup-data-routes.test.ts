/**
 * Lookup Data Routes Tests
 *
 * Tests CRUD API for collection-backed lookup table entries:
 *   POST   /:tableName/entries   — Bulk upsert
 *   GET    /:tableName/entries   — Paginated list
 *   DELETE /:tableName/entries   — Delete all
 *   POST   /:tableName/upload    — CSV/JSON upload
 *
 * Also tests pure parsing functions independently.
 */

import { describe, test, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before importing the router
// =============================================================================

const mockBulkWrite = vi.fn().mockResolvedValue({ upsertedCount: 0, modifiedCount: 0 });
const mockFind = vi.fn().mockReturnValue({
  skip: vi.fn().mockReturnValue({
    limit: vi.fn().mockReturnValue({
      lean: vi.fn().mockResolvedValue([]),
    }),
  }),
});
const mockCountDocuments = vi.fn().mockResolvedValue(0);
const mockDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@agent-platform/shared-auth', () => ({
  requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  getRequestAccessDeniedReporter: vi.fn(() => vi.fn()),
}));

vi.mock('../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    return {
      router,
      route: (method: string, path: string, _schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        (router as any)[method](path, ...middlewares, lastHandler);
      },
    };
  }),
}));

vi.mock('@abl/compiler/platform', async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('@agent-platform/database/models', () => ({
  LookupEntry: {
    bulkWrite: (...args: any[]) => mockBulkWrite(...args),
    find: (...args: any[]) => mockFind(...args),
    countDocuments: (...args: any[]) => mockCountDocuments(...args),
    deleteMany: (...args: any[]) => mockDeleteMany(...args),
  },
}));

// =============================================================================
// IMPORTS (after mocks)
// =============================================================================

import express from 'express';
import { parseCSVValues, parseJSONValues } from '../routes/lookup-data.js';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';

// =============================================================================
// HELPERS
// =============================================================================

const PROJECT_ID = 'proj-1';
const BASE = `/api/projects/${PROJECT_ID}/lookup-tables`;

function createApp(tenantId: string, userId: string, role: string) {
  const app = express();
  // JSON body parser
  app.use(
    express.json({
      limit: '2mb',
      verify: (req: any, _res, buf) => {
        req.rawBody = buf;
      },
    }),
  );
  // Text body parser for CSV
  app.use(express.text({ type: 'text/csv', limit: '2mb' }));
  app.use(injectTenantContext(makeTenantContext(tenantId, userId, role as any)));
  return app;
}

let server: http.Server;
let baseUrl: string;

async function startServer(app: express.Express): Promise<void> {
  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve();
    });
  });
}

function stopServer(): void {
  server?.close();
}

async function request(
  method: string,
  path: string,
  opts?: { body?: any; contentType?: string; rawBody?: string },
): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {};
  let bodyContent: string | undefined;

  if (opts?.contentType) {
    headers['Content-Type'] = opts.contentType;
  } else if (opts?.body) {
    headers['Content-Type'] = 'application/json';
  }

  if (opts?.rawBody !== undefined) {
    bodyContent = opts.rawBody;
  } else if (opts?.body) {
    bodyContent = JSON.stringify(opts.body);
  }

  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers,
    body: bodyContent,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

// =============================================================================
// PURE FUNCTION TESTS — parseCSVValues
// =============================================================================

describe('parseCSVValues', () => {
  test('parses simple values', () => {
    const result = parseCSVValues('apple\nbanana\ncherry');
    expect(result.values).toEqual(['apple', 'banana', 'cherry']);
    expect(result.errors).toEqual([]);
  });

  test('handles quoted values with commas', () => {
    const result = parseCSVValues('"value with, comma"\nplain');
    expect(result.values).toEqual(['value with, comma', 'plain']);
  });

  test('skips comment lines starting with #', () => {
    const result = parseCSVValues('# header comment\napple\n# another comment\nbanana');
    expect(result.values).toEqual(['apple', 'banana']);
  });

  test('skips blank lines', () => {
    const result = parseCSVValues('apple\n\n\nbanana\n  \ncherry');
    expect(result.values).toEqual(['apple', 'banana', 'cherry']);
  });

  test('trims whitespace', () => {
    const result = parseCSVValues('  apple  \n  banana  ');
    expect(result.values).toEqual(['apple', 'banana']);
  });

  test('returns empty for empty content', () => {
    const result = parseCSVValues('');
    expect(result.values).toEqual([]);
    expect(result.errors).toEqual([]);
  });

  test('returns empty for content with only comments', () => {
    const result = parseCSVValues('# just comments\n# nothing else');
    expect(result.values).toEqual([]);
  });
});

// =============================================================================
// PURE FUNCTION TESTS — parseJSONValues
// =============================================================================

describe('parseJSONValues', () => {
  test('parses array of strings', () => {
    const result = parseJSONValues('["apple", "banana", "cherry"]');
    expect(result.values).toEqual(['apple', 'banana', 'cherry']);
    expect(result.errors).toEqual([]);
  });

  test('parses array of {value} objects', () => {
    const result = parseJSONValues('[{"value": "apple"}, {"value": "banana"}]');
    expect(result.values).toEqual(['apple', 'banana']);
    expect(result.errors).toEqual([]);
  });

  test('handles mixed arrays', () => {
    const result = parseJSONValues('["apple", {"value": "banana"}, "cherry"]');
    expect(result.values).toEqual(['apple', 'banana', 'cherry']);
    expect(result.errors).toEqual([]);
  });

  test('reports errors for invalid items', () => {
    const result = parseJSONValues('["apple", 42, {"value": "banana"}, null]');
    expect(result.values).toEqual(['apple', 'banana']);
    expect(result.errors).toHaveLength(2);
    expect(result.errors[0]).toContain('index 1');
    expect(result.errors[1]).toContain('index 3');
  });

  test('rejects non-array JSON', () => {
    const result = parseJSONValues('{"key": "value"}');
    expect(result.values).toEqual([]);
    expect(result.errors).toEqual(['JSON must be an array']);
  });

  test('rejects invalid JSON', () => {
    const result = parseJSONValues('not json at all');
    expect(result.values).toEqual([]);
    expect(result.errors).toEqual(['Invalid JSON']);
  });

  test('returns empty for empty array', () => {
    const result = parseJSONValues('[]');
    expect(result.values).toEqual([]);
    expect(result.errors).toEqual([]);
  });
});

// =============================================================================
// ROUTE TESTS — OWNER (all endpoints pass via *:*)
// =============================================================================

describe('lookup-data routes', () => {
  beforeAll(async () => {
    const app = createApp('tenant-A', 'owner-user', 'OWNER');
    const router = (await import('../routes/lookup-data.js')).default;
    app.use(`/api/projects/:projectId/lookup-tables`, router);
    await startServer(app);
  });

  afterAll(() => stopServer());

  beforeEach(() => {
    vi.clearAllMocks();
    // Reset mock return values
    mockBulkWrite.mockResolvedValue({ upsertedCount: 2, modifiedCount: 1 });
    mockFind.mockReturnValue({
      skip: vi.fn().mockReturnValue({
        limit: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([
            {
              _id: 'entry-1',
              value: 'apple',
              createdAt: '2026-01-01T00:00:00.000Z',
              updatedAt: '2026-01-01T00:00:00.000Z',
            },
          ]),
        }),
      }),
    });
    mockCountDocuments.mockResolvedValue(1);
    mockDeleteMany.mockResolvedValue({ deletedCount: 5 });
  });

  // ─── POST /:tableName/entries — Bulk Upsert ─────────────────────────

  test('POST entries succeeds with valid data', async () => {
    const { status, body } = await request('POST', `${BASE}/cities/entries`, {
      body: {
        entries: [
          { value: 'New York' },
          { value: 'London', field: 'city' },
          { value: 'Tokyo', metadata: { country: 'Japan' } },
        ],
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(3);
    expect(body.data.upserted).toBe(3); // 2 upserted + 1 modified
    expect(mockBulkWrite).toHaveBeenCalledOnce();

    // Verify bulkWrite was called with correct ops structure
    const ops = mockBulkWrite.mock.calls[0][0];
    expect(ops).toHaveLength(3);
    expect(ops[0].updateOne.filter).toEqual({
      tenantId: 'tenant-A',
      projectId: PROJECT_ID,
      tableName: 'cities',
      value: 'New York',
    });
    expect(ops[0].updateOne.upsert).toBe(true);
  });

  test('POST entries rejects empty entries array', async () => {
    const { status, body } = await request('POST', `${BASE}/cities/entries`, {
      body: { entries: [] },
    });

    expect(status).toBe(400);
    expect(body.success).toBe(false);
  });

  // ─── GET /:tableName/entries — Paginated List ────────────────────────

  test('GET returns paginated entries', async () => {
    const { status, body } = await request('GET', `${BASE}/cities/entries?limit=10&offset=0`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.entries).toHaveLength(1);
    expect(body.data.total).toBe(1);
    expect(body.data.limit).toBe(10);
    expect(body.data.offset).toBe(0);
    expect(mockFind).toHaveBeenCalledWith({
      tenantId: 'tenant-A',
      projectId: PROJECT_ID,
      tableName: 'cities',
    });
  });

  test('GET uses default pagination', async () => {
    const { status, body } = await request('GET', `${BASE}/cities/entries`);

    expect(status).toBe(200);
    expect(body.data.limit).toBe(100); // DEFAULT_PAGE_LIMIT
    expect(body.data.offset).toBe(0);
  });

  // ─── DELETE /:tableName/entries — Delete All ─────────────────────────

  test('DELETE removes all entries', async () => {
    const { status, body } = await request('DELETE', `${BASE}/cities/entries`);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.deleted).toBe(5);
    expect(mockDeleteMany).toHaveBeenCalledWith({
      tenantId: 'tenant-A',
      projectId: PROJECT_ID,
      tableName: 'cities',
    });
  });

  // ─── Table Name Validation ───────────────────────────────────────────

  test('rejects invalid tableName with uppercase', async () => {
    const { status, body } = await request('GET', `${BASE}/InvalidName/entries`);
    expect(status).toBe(400);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('INVALID_TABLE_NAME');
  });

  test('rejects tableName starting with number', async () => {
    const { status, body } = await request('GET', `${BASE}/123table/entries`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('INVALID_TABLE_NAME');
  });

  test('rejects tableName with special characters', async () => {
    const { status, body } = await request('GET', `${BASE}/my-table/entries`);
    expect(status).toBe(400);
    expect(body.error.code).toBe('INVALID_TABLE_NAME');
  });

  test('accepts valid tableName with underscores', async () => {
    const { status, body } = await request('GET', `${BASE}/my_table_123/entries`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  test('accepts tableName starting with underscore', async () => {
    const { status, body } = await request('GET', `${BASE}/_private_table/entries`);
    expect(status).toBe(200);
    expect(body.success).toBe(true);
  });

  // ─── POST /:tableName/upload — CSV Upload ───────────────────────────

  test('CSV upload parses and stores values', async () => {
    const csvContent = '# Cities list\napple\nbanana\ncherry\n';
    const { status, body } = await request('POST', `${BASE}/fruits/upload`, {
      rawBody: csvContent,
      contentType: 'text/csv',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(3);
    expect(mockBulkWrite).toHaveBeenCalledOnce();
  });

  // ─── POST /:tableName/upload — JSON Upload ──────────────────────────

  test('JSON upload parses array of strings', async () => {
    const { status, body } = await request('POST', `${BASE}/fruits/upload`, {
      body: ['apple', 'banana', 'cherry'],
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(3);
    expect(mockBulkWrite).toHaveBeenCalledOnce();
  });

  test('JSON upload parses array of {value} objects', async () => {
    const { status, body } = await request('POST', `${BASE}/fruits/upload`, {
      body: [{ value: 'apple' }, { value: 'banana' }],
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(2);
  });

  // ─── Upload Size Limits ──────────────────────────────────────────────

  test('upload rejects body exceeding 1MB', async () => {
    // Create a string just over 1MB
    const largeContent = 'x'.repeat(1_048_577);
    const { status, body } = await request('POST', `${BASE}/fruits/upload`, {
      rawBody: largeContent,
      contentType: 'text/csv',
    });

    expect(status).toBe(413);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('PAYLOAD_TOO_LARGE');
  });

  test('upload rejects more than 10K values', async () => {
    // Create an array with 10,001 items
    const values = Array.from({ length: 10_001 }, (_, i) => `val${i}`);
    const { status, body } = await request('POST', `${BASE}/fruits/upload`, {
      body: values,
    });

    expect(status).toBe(413);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('TOO_MANY_VALUES');
  });

  test('upload rejects unsupported content type', async () => {
    const { status, body } = await request('POST', `${BASE}/fruits/upload`, {
      rawBody: '<xml>data</xml>',
      contentType: 'application/xml',
    });

    expect(status).toBe(415);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe('UNSUPPORTED_CONTENT_TYPE');
  });

  test('upload returns empty result for empty CSV', async () => {
    const { status, body } = await request('POST', `${BASE}/fruits/upload`, {
      rawBody: '# just comments\n',
      contentType: 'text/csv',
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.total).toBe(0);
    expect(body.data.stored).toBe(0);
    expect(mockBulkWrite).not.toHaveBeenCalled();
  });
});
