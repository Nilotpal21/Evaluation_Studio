/**
 * Transcript Routes Tests
 *
 * Tests the async file I/O transcript API routes using mocked fs/promises
 * and the TestSessionService.
 */

import { describe, test, expect, vi, beforeEach, afterEach } from 'vitest';
import * as path from 'node:path';

// =============================================================================
// MOCKS
// =============================================================================

// In-memory filesystem store for mocked fs/promises
let memoryFS: Map<string, string>;
let directoryExists: boolean;

vi.mock('node:fs/promises', () => ({
  readdir: vi.fn(async (dir: string) => {
    const files: string[] = [];
    for (const key of memoryFS.keys()) {
      if (key.startsWith(dir + '/') || key.startsWith(dir + path.sep)) {
        const relative = key.slice(dir.length + 1);
        if (!relative.includes('/') && !relative.includes(path.sep)) {
          files.push(relative);
        }
      }
    }
    return files;
  }),
  readFile: vi.fn(async (filePath: string) => {
    const content = memoryFS.get(filePath);
    if (content === undefined) {
      const err: any = new Error(`ENOENT: no such file or directory, open '${filePath}'`);
      err.code = 'ENOENT';
      throw err;
    }
    return content;
  }),
  writeFile: vi.fn(async (filePath: string, data: string) => {
    memoryFS.set(filePath, data);
  }),
  unlink: vi.fn(async (filePath: string) => {
    if (!memoryFS.has(filePath)) {
      const err: any = new Error(`ENOENT: no such file or directory, unlink '${filePath}'`);
      err.code = 'ENOENT';
      throw err;
    }
    memoryFS.delete(filePath);
  }),
  mkdir: vi.fn(async () => {
    directoryExists = true;
  }),
  access: vi.fn(async (filePath: string) => {
    // For directory access checks
    if (filePath === transcriptsDir) {
      if (!directoryExists) {
        const err: any = new Error(`ENOENT: no such file or directory, access '${filePath}'`);
        err.code = 'ENOENT';
        throw err;
      }
      return;
    }
    // For file access checks
    if (!memoryFS.has(filePath)) {
      const err: any = new Error(`ENOENT: no such file or directory, access '${filePath}'`);
      err.code = 'ENOENT';
      throw err;
    }
  }),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return {
    ...actual,
    constants: actual.constants,
  };
});

// Mock crypto.randomUUID to return predictable IDs
let uuidCounter = 0;
vi.mock('crypto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('crypto')>();
  return {
    ...actual,
    default: {
      ...actual,
      randomUUID: vi.fn(() => `test-uuid-${++uuidCounter}`),
    },
  };
});

// Mock RuntimeExecutor
const mockSessionDetails = new Map<string, any>();

vi.mock('../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    getSessionDetail: vi.fn((id: string) => mockSessionDetails.get(id)),
    getSession: vi.fn((id: string) => mockSessionDetails.get(id)?.runtimeSession),
  })),
}));

// Mock TraceStore
vi.mock('../services/trace-store.js', () => ({
  getTraceStore: vi.fn(() => ({
    getEvents: vi.fn(() => []),
  })),
}));

vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  evaluateProjectPermission: vi.fn(async (req: any, _permission: string, projectId: string) => ({
    allowed: req.tenantContext?.tenantId === 'tenant-1' && projectId === 'project-1',
  })),
}));

// Compute the expected TRANSCRIPTS_DIR (matches the route module)
const transcriptsDir = path.resolve(process.cwd(), 'output/transcripts');

// =============================================================================
// HELPERS
// =============================================================================

function createMockReq(overrides: Record<string, any> = {}): any {
  return {
    body: {},
    params: {},
    query: {},
    tenantContext: {
      tenantId: 'tenant-1',
      userId: 'user-1',
      role: 'VIEWER',
      permissions: ['session:read'],
    },
    ...overrides,
  };
}

function createMockRes(): any {
  const res: any = {
    statusCode: 200,
    body: null,
    status: vi.fn(function (this: any, code: number) {
      this.statusCode = code;
      return this;
    }),
    json: vi.fn(function (this: any, data: any) {
      this.body = data;
      return this;
    }),
  };
  return res;
}

/** Seed a transcript file into the in-memory FS */
function seedTranscript(id: string, overrides: Record<string, any> = {}) {
  const transcript = {
    id,
    name: overrides.name || `transcript-${id}`,
    agentId: overrides.agentId || 'agent-1',
    agentName: overrides.agentName || 'TestAgent',
    createdAt: overrides.createdAt || '2026-01-15T10:00:00.000Z',
    messages: overrides.messages || [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there!' },
    ],
    traceEvents: overrides.traceEvents || [],
    finalState: overrides.finalState || {},
    scope: Object.prototype.hasOwnProperty.call(overrides, 'scope')
      ? overrides.scope
      : {
          tenantId: 'tenant-1',
          projectId: 'project-1',
          userId: 'user-1',
          sessionId: `session-${id}`,
        },
  };
  const filePath = path.join(transcriptsDir, `${id}.json`);
  memoryFS.set(filePath, JSON.stringify(transcript, null, 2));
  return transcript;
}

/** Seed a mock session detail in RuntimeExecutor */
function seedSession(sessionId: string, agentName = 'TestAgent') {
  const detail = {
    agentName,
    messages: [{ role: 'user', content: 'Hello' }],
    traceEvents: [],
    state: { phase: 'active' },
    runtimeSession: {
      id: sessionId,
      tenantId: 'tenant-1',
      projectId: 'project-1',
      userId: 'user-1',
    },
  };
  mockSessionDetails.set(sessionId, detail);
  return detail;
}

// =============================================================================
// ROUTE HANDLER EXTRACTION
// =============================================================================

/**
 * Extract route handlers from the Express router.
 * Express stores them in router.stack as Layer objects.
 */
async function getRouteHandlers() {
  const mod = await import('../routes/transcripts.js');
  const router = mod.default;
  const stack = (router as any).stack as any[];

  const handlers: Record<string, any> = {};
  for (const layer of stack) {
    if (layer.route) {
      const routePath = layer.route.path;
      for (const routeLayer of layer.route.stack) {
        const method = routeLayer.method;
        const key = `${method.toUpperCase()} ${routePath}`;
        handlers[key] = routeLayer.handle;
      }
    }
  }
  return handlers;
}

// =============================================================================
// TESTS
// =============================================================================

describe('Transcript Routes (Async I/O)', () => {
  let handlers: Record<string, any>;

  beforeEach(async () => {
    memoryFS = new Map();
    directoryExists = true;
    uuidCounter = 0;
    mockSessionDetails.clear();
    vi.clearAllMocks();
    handlers = await getRouteHandlers();
  }, 30000);

  // ---------------------------------------------------------------------------
  // GET /api/v1/transcripts
  // ---------------------------------------------------------------------------

  describe('GET / — List transcripts', () => {
    test('returns empty list when no transcripts exist', async () => {
      const req = createMockReq();
      const res = createMockRes();

      await handlers['GET /']!(req, res);

      expect(res.body).toEqual({
        success: true,
        total: 0,
        transcripts: [],
      });
    });

    test('returns all transcripts with metadata', async () => {
      seedTranscript('tx-1', { name: 'Booking Flow', agentName: 'HotelAgent' });
      seedTranscript('tx-2', { name: 'Support Chat', agentName: 'SupportAgent' });

      const req = createMockReq();
      const res = createMockRes();

      await handlers['GET /']!(req, res);

      expect(res.body.success).toBe(true);
      expect(res.body.total).toBe(2);
      expect(res.body.transcripts).toHaveLength(2);

      const names = res.body.transcripts.map((t: any) => t.name);
      expect(names).toContain('Booking Flow');
      expect(names).toContain('Support Chat');
    });

    test('hides transcripts outside the authenticated tenant scope', async () => {
      seedTranscript('visible', { name: 'Visible Transcript' });
      seedTranscript('foreign', {
        name: 'Foreign Transcript',
        scope: {
          tenantId: 'tenant-2',
          projectId: 'project-2',
          userId: 'user-2',
          sessionId: 'session-foreign',
        },
      });

      const req = createMockReq();
      const res = createMockRes();

      await handlers['GET /']!(req, res);

      expect(res.body.total).toBe(1);
      expect(res.body.transcripts[0].id).toBe('visible');
    });

    test('keeps legacy unscoped transcripts visible to tenant admins only', async () => {
      seedTranscript('legacy-admin', { scope: undefined });

      const viewerReq = createMockReq();
      const viewerRes = createMockRes();
      await handlers['GET /']!(viewerReq, viewerRes);
      expect(viewerRes.body.total).toBe(0);

      const adminReq = createMockReq({
        tenantContext: {
          tenantId: 'tenant-1',
          userId: 'admin-1',
          role: 'ADMIN',
          permissions: ['project:*'],
        },
      });
      const adminRes = createMockRes();
      await handlers['GET /']!(adminReq, adminRes);

      expect(adminRes.body.total).toBe(1);
      expect(adminRes.body.transcripts[0].id).toBe('legacy-admin');
    });

    test('returns correct metadata fields per transcript', async () => {
      seedTranscript('tx-meta', {
        name: 'MetaTest',
        agentId: 'a-99',
        agentName: 'MetaAgent',
        messages: [
          { role: 'user', content: 'A' },
          { role: 'assistant', content: 'B' },
          { role: 'user', content: 'C' },
        ],
      });

      const req = createMockReq();
      const res = createMockRes();

      await handlers['GET /']!(req, res);

      const tx = res.body.transcripts[0];
      expect(tx.id).toBe('tx-meta');
      expect(tx.name).toBe('MetaTest');
      expect(tx.agentId).toBe('a-99');
      expect(tx.agentName).toBe('MetaAgent');
      expect(tx.messageCount).toBe(3);
      expect(tx.createdAt).toBeDefined();
    });

    test('ignores non-JSON files in directory', async () => {
      seedTranscript('valid-1');
      // Add a non-JSON file manually
      memoryFS.set(path.join(transcriptsDir, 'README.md'), '# Notes');

      const req = createMockReq();
      const res = createMockRes();

      await handlers['GET /']!(req, res);

      expect(res.body.total).toBe(1);
      expect(res.body.transcripts[0].id).toBe('valid-1');
    });

    test('creates directory if it does not exist', async () => {
      directoryExists = false;
      const { mkdir } = await import('node:fs/promises');

      const req = createMockReq();
      const res = createMockRes();

      await handlers['GET /']!(req, res);

      expect(mkdir).toHaveBeenCalledWith(transcriptsDir, { recursive: true });
      expect(res.body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // GET /api/v1/transcripts/:id
  // ---------------------------------------------------------------------------

  describe('GET /:id — Get transcript by ID', () => {
    test('returns full transcript for existing ID', async () => {
      const seeded = seedTranscript('tx-get-1', {
        name: 'Detail Test',
        messages: [{ role: 'user', content: 'Hello' }],
      });

      const req = createMockReq({ params: { id: 'tx-get-1' } });
      const res = createMockRes();

      await handlers['GET /:id']!(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.transcript.id).toBe('tx-get-1');
      expect(res.body.transcript.name).toBe('Detail Test');
      expect(res.body.transcript.messages).toHaveLength(1);
    });

    test('returns 404 for a transcript outside the authenticated tenant scope', async () => {
      seedTranscript('foreign-get', {
        scope: {
          tenantId: 'tenant-2',
          projectId: 'project-2',
          userId: 'user-2',
          sessionId: 'session-foreign-get',
        },
      });

      const req = createMockReq({ params: { id: 'foreign-get' } });
      const res = createMockRes();

      await handlers['GET /:id']!(req, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('foreign-get');
    });

    test('returns 404 for non-existent ID', async () => {
      const req = createMockReq({ params: { id: 'does-not-exist' } });
      const res = createMockRes();

      await handlers['GET /:id']!(req, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('does-not-exist');
    });
  });

  // ---------------------------------------------------------------------------
  // POST /api/v1/transcripts
  // ---------------------------------------------------------------------------

  describe('POST / — Create transcript', () => {
    test('creates transcript from valid session', async () => {
      seedSession('session-1', 'BookingAgent');

      const req = createMockReq({
        body: { sessionId: 'session-1', name: 'My Booking' },
      });
      const res = createMockRes();

      await handlers['POST /']!(req, res);

      expect(res.statusCode).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.transcript.id).toBe('test-uuid-1');
      expect(res.body.transcript.name).toBe('My Booking');

      // Verify file was written to in-memory FS
      const filePath = path.join(transcriptsDir, 'test-uuid-1.json');
      expect(memoryFS.has(filePath)).toBe(true);

      // Verify the content is valid JSON with correct structure
      const written = JSON.parse(memoryFS.get(filePath)!);
      expect(written.id).toBe('test-uuid-1');
      expect(written.name).toBe('My Booking');
      expect(written.agentName).toBe('BookingAgent');
      expect(written.messages).toHaveLength(1);
      expect(written.scope).toMatchObject({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        userId: 'user-1',
        sessionId: 'session-1',
      });
    });

    test('uses auto-generated name when none provided', async () => {
      seedSession('session-2', 'SupportAgent');

      const req = createMockReq({
        body: { sessionId: 'session-2' },
      });
      const res = createMockRes();

      await handlers['POST /']!(req, res);

      expect(res.statusCode).toBe(201);
      // Auto-generated name should include agent name and date
      expect(res.body.transcript.name).toContain('SupportAgent');
    });

    test('returns 400 when sessionId is missing', async () => {
      const req = createMockReq({ body: {} });
      const res = createMockRes();

      await handlers['POST /']!(req, res);

      expect(res.statusCode).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('sessionId');
    });

    test('returns 404 when session does not exist', async () => {
      const req = createMockReq({
        body: { sessionId: 'nonexistent-session' },
      });
      const res = createMockRes();

      await handlers['POST /']!(req, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('nonexistent-session');
    });

    test('returns 404 when the live session belongs to another tenant', async () => {
      mockSessionDetails.set('foreign-session', {
        agentName: 'ForeignAgent',
        messages: [{ role: 'user', content: 'Hello' }],
        traceEvents: [],
        state: { phase: 'active' },
        runtimeSession: {
          id: 'foreign-session',
          tenantId: 'tenant-2',
          projectId: 'project-2',
          userId: 'user-2',
        },
      });

      const req = createMockReq({ body: { sessionId: 'foreign-session' } });
      const res = createMockRes();

      await handlers['POST /']!(req, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('foreign-session');
    });

    test('written file uses async writeFile (not sync)', async () => {
      seedSession('session-3');
      const { writeFile } = await import('node:fs/promises');

      const req = createMockReq({ body: { sessionId: 'session-3' } });
      const res = createMockRes();

      await handlers['POST /']!(req, res);

      expect(writeFile).toHaveBeenCalledTimes(1);
      expect(writeFile).toHaveBeenCalledWith(
        expect.stringContaining('test-uuid'),
        expect.any(String),
      );
    });

    test('writes transcript messages and traces through the PII read boundary', async () => {
      mockSessionDetails.set('session-pii-export', {
        agentName: 'SensitiveAgent',
        messages: [
          {
            id: 'msg-1',
            role: 'user',
            content: 'Email jane.doe@example.com',
            rawContent: { email: 'jane.doe@example.com' },
          },
        ],
        traceEvents: [
          {
            id: 'trace-1',
            type: 'tool_call',
            data: {
              response: 'Email jane.doe@example.com',
              requestHeaders: { authorization: 'Bearer internal-secret-token' },
            },
          },
        ],
        state: { phase: 'active' },
        runtimeSession: {
          id: 'session-pii-export',
          tenantId: 'tenant-1',
          projectId: 'project-1',
          userId: 'user-1',
        },
      });

      const req = createMockReq({
        body: { sessionId: 'session-pii-export', name: 'PII Export' },
      });
      const res = createMockRes();

      await handlers['POST /']!(req, res);

      const filePath = path.join(transcriptsDir, 'test-uuid-1.json');
      const written = JSON.parse(memoryFS.get(filePath)!);
      const serializedTranscript = JSON.stringify(written);
      expect(res.statusCode).toBe(201);
      expect(serializedTranscript).toContain('[REDACTED_EMAIL]');
      expect(serializedTranscript).not.toContain('jane.doe@example.com');
      expect(serializedTranscript).not.toContain('internal-secret-token');
    });
  });

  // ---------------------------------------------------------------------------
  // DELETE /api/v1/transcripts/:id
  // ---------------------------------------------------------------------------

  describe('DELETE /:id — Delete transcript', () => {
    test('deletes existing transcript', async () => {
      seedTranscript('tx-del-1');
      const filePath = path.join(transcriptsDir, 'tx-del-1.json');

      // Confirm it exists before delete
      expect(memoryFS.has(filePath)).toBe(true);

      const req = createMockReq({ params: { id: 'tx-del-1' } });
      const res = createMockRes();

      await handlers['DELETE /:id']!(req, res);

      expect(res.statusCode).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.message).toBe('Transcript deleted');

      // Verify file was removed from in-memory FS
      expect(memoryFS.has(filePath)).toBe(false);
    });

    test('returns 404 when transcript does not exist', async () => {
      const req = createMockReq({ params: { id: 'ghost-transcript' } });
      const res = createMockRes();

      await handlers['DELETE /:id']!(req, res);

      expect(res.statusCode).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error).toContain('ghost-transcript');
    });

    test('uses async unlink (not sync)', async () => {
      seedTranscript('tx-del-async');
      const { unlink } = await import('node:fs/promises');

      const req = createMockReq({ params: { id: 'tx-del-async' } });
      const res = createMockRes();

      await handlers['DELETE /:id']!(req, res);

      expect(unlink).toHaveBeenCalledTimes(1);
      expect(unlink).toHaveBeenCalledWith(path.join(transcriptsDir, 'tx-del-async.json'));
    });
  });

  // ---------------------------------------------------------------------------
  // Full lifecycle: create → read → list → delete → confirm gone
  // ---------------------------------------------------------------------------

  describe('Full lifecycle', () => {
    test('create → get → list → delete → confirm removed', async () => {
      // 1. Create: seed a session and save a transcript
      seedSession('lifecycle-session', 'LifecycleAgent');

      const createReq = createMockReq({
        body: { sessionId: 'lifecycle-session', name: 'Lifecycle Test' },
      });
      const createRes = createMockRes();
      await handlers['POST /']!(createReq, createRes);

      expect(createRes.statusCode).toBe(201);
      const transcriptId = createRes.body.transcript.id;

      // 2. Get: retrieve the transcript by ID
      const getReq = createMockReq({ params: { id: transcriptId } });
      const getRes = createMockRes();
      await handlers['GET /:id']!(getReq, getRes);

      expect(getRes.statusCode).toBe(200);
      expect(getRes.body.transcript.name).toBe('Lifecycle Test');
      expect(getRes.body.transcript.agentName).toBe('LifecycleAgent');

      // 3. List: confirm it appears in listing
      const listReq = createMockReq();
      const listRes = createMockRes();
      await handlers['GET /']!(listReq, listRes);

      expect(listRes.body.total).toBe(1);
      expect(listRes.body.transcripts[0].id).toBe(transcriptId);

      // 4. Delete
      const deleteReq = createMockReq({ params: { id: transcriptId } });
      const deleteRes = createMockRes();
      await handlers['DELETE /:id']!(deleteReq, deleteRes);

      expect(deleteRes.statusCode).toBe(200);

      // 5. Confirm removed: get returns 404, list returns empty
      const getAfterReq = createMockReq({ params: { id: transcriptId } });
      const getAfterRes = createMockRes();
      await handlers['GET /:id']!(getAfterReq, getAfterRes);
      expect(getAfterRes.statusCode).toBe(404);

      const listAfterReq = createMockReq();
      const listAfterRes = createMockRes();
      await handlers['GET /']!(listAfterReq, listAfterRes);
      expect(listAfterRes.body.total).toBe(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Async I/O verification
  // ---------------------------------------------------------------------------

  describe('Async I/O verification', () => {
    test('all fs operations use async fs/promises (no sync calls)', async () => {
      // Read the source file to confirm no sync fs calls remain
      const fs = await import('node:fs');
      const sourceContent = fs.readFileSync(
        path.resolve(__dirname, '../routes/transcripts.ts'),
        'utf-8',
      );

      // These sync APIs should NOT be present
      expect(sourceContent).not.toContain('readFileSync');
      expect(sourceContent).not.toContain('writeFileSync');
      expect(sourceContent).not.toContain('readdirSync');
      expect(sourceContent).not.toContain('existsSync');
      expect(sourceContent).not.toContain('unlinkSync');
      expect(sourceContent).not.toContain('mkdirSync');

      // These async imports should be present
      expect(sourceContent).toContain("from 'node:fs/promises'");
      expect(sourceContent).toContain('readdir');
      expect(sourceContent).toContain('readFile');
      expect(sourceContent).toContain('writeFile');
      expect(sourceContent).toContain('unlink');
    });

    test('listing reads files concurrently via Promise.all', async () => {
      // Seed multiple transcripts
      seedTranscript('concurrent-1');
      seedTranscript('concurrent-2');
      seedTranscript('concurrent-3');

      const { readFile } = await import('node:fs/promises');

      const req = createMockReq();
      const res = createMockRes();

      await handlers['GET /']!(req, res);

      // readFile should have been called once per JSON file (concurrently via Promise.all)
      expect(readFile).toHaveBeenCalledTimes(3);
      expect(res.body.total).toBe(3);
    });

    test('route handlers are async (return promises)', async () => {
      const req = createMockReq();
      const res = createMockRes();

      // Calling the handler should return a promise (async function)
      const result = handlers['GET /']!(req, res);
      expect(result).toBeInstanceOf(Promise);
      await result;
    });
  });
});
