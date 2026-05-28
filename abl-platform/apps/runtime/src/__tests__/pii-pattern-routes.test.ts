import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import http from 'http';
import type { AddressInfo } from 'net';

const mockTestPattern = vi.fn();
const mockValidatePattern = vi.fn();
const mockFindAll = vi.fn();
const mockFindById = vi.fn();
const mockFindByName = vi.fn();
const mockFindBuiltinOverride = vi.fn();
const mockCreate = vi.fn();
const mockUpsertBuiltinOverride = vi.fn();
const mockUpdate = vi.fn();
const mockRemove = vi.fn();
const mockWriteAuditLog = vi.fn();
const mockRequireProjectPermission = vi.fn();

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rbac.js', () => ({
  requirePermissionInline: vi.fn(),
  requireProjectPermission: (...args: unknown[]) => mockRequireProjectPermission(...args),
}));

vi.mock('@agent-platform/shared-observability', () => ({
  getCurrentRequestId: vi.fn(() => 'req-test-1'),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: (...args: unknown[]) => mockWriteAuditLog(...args),
}));

vi.mock('../repos/pii-pattern-repo.js', () => ({
  findAll: (...args: unknown[]) => mockFindAll(...args),
  findScopedByPatternId: (...args: unknown[]) => mockFindById(...args),
  findByName: (...args: unknown[]) => mockFindByName(...args),
  findBuiltinOverride: (...args: unknown[]) => mockFindBuiltinOverride(...args),
  create: (...args: unknown[]) => mockCreate(...args),
  upsertBuiltinOverride: (...args: unknown[]) => mockUpsertBuiltinOverride(...args),
  update: (...args: unknown[]) => mockUpdate(...args),
  remove: (...args: unknown[]) => mockRemove(...args),
}));

vi.mock('../services/pii/pattern-service.js', () => ({
  validatePattern: (...args: unknown[]) => mockValidatePattern(...args),
  testPattern: (...args: unknown[]) => mockTestPattern(...args),
  normalizePatternConsumerAccess: (consumerAccess: unknown, defaultRenderMode: unknown) => {
    const normalized = Array.isArray(consumerAccess)
      ? consumerAccess.map((rule) => {
          const record =
            typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>) : {};
          const rawConsumer =
            typeof record.consumer === 'string'
              ? record.consumer.trim()
              : String(record.consumer ?? '');
          const consumer = rawConsumer.toLowerCase() === 'llm' ? 'llm' : rawConsumer;
          const renderMode =
            consumer.toLowerCase() === 'llm' && record.renderMode === 'original'
              ? 'tokenized'
              : typeof record.renderMode === 'string'
                ? record.renderMode
                : 'redacted';
          return { consumer, renderMode };
        })
      : [];
    const hasLlmRule = normalized.some((rule) => rule.consumer.toLowerCase() === 'llm');
    return !hasLlmRule && defaultRenderMode === 'original'
      ? [...normalized, { consumer: 'llm', renderMode: 'tokenized' }]
      : normalized;
  },
  normalizePatternPayloadForStorage: (payload: Record<string, unknown>) => {
    const normalized = Array.isArray(payload.consumerAccess)
      ? payload.consumerAccess.map((rule) => {
          const record =
            typeof rule === 'object' && rule !== null ? (rule as Record<string, unknown>) : {};
          const rawConsumer =
            typeof record.consumer === 'string'
              ? record.consumer.trim()
              : String(record.consumer ?? '');
          const consumer = rawConsumer.toLowerCase() === 'llm' ? 'llm' : rawConsumer;
          const renderMode =
            consumer.toLowerCase() === 'llm' && record.renderMode === 'original'
              ? 'tokenized'
              : typeof record.renderMode === 'string'
                ? record.renderMode
                : 'redacted';
          return { consumer, renderMode };
        })
      : [];
    const hasLlmRule = normalized.some((rule) => rule.consumer.toLowerCase() === 'llm');
    return {
      ...payload,
      consumerAccess:
        !hasLlmRule && payload.defaultRenderMode === 'original'
          ? [...normalized, { consumer: 'llm', renderMode: 'tokenized' }]
          : normalized,
    };
  },
  isBuiltinPIIType: (piiType?: string) =>
    ['email', 'phone', 'ssn', 'credit_card', 'ip_address'].includes(piiType ?? ''),
}));

let baseUrl: string;
let server: http.Server;

beforeAll(async () => {
  const app = express();
  app.use(express.json());
  app.use((req: any, _res: any, next: any) => {
    req.tenantContext = { tenantId: 'tenant-1', userId: 'user-1' };
    req.user = { id: 'user-1', email: 'test@example.com' };
    next();
  });

  const piiPatternRouter = (await import('../routes/pii-patterns.js')).default;
  app.use('/api/projects/:projectId/pii-patterns', piiPatternRouter);

  await new Promise<void>((resolve) => {
    server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address() as AddressInfo;
      baseUrl = `http://127.0.0.1:${address.port}`;
      resolve();
    });
  });
});

afterAll(() => {
  server?.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockValidatePattern.mockResolvedValue({ valid: true, errors: [] });
  mockTestPattern.mockReturnValue({
    detections: [{ match: 'alice@example.com', index: 6, length: 17 }],
    consumerPreviews: { default: 'Email a***@example.com' },
  });
  mockFindAll.mockResolvedValue([]);
  mockFindById.mockResolvedValue(null);
  mockFindByName.mockResolvedValue(null);
  mockRequireProjectPermission.mockResolvedValue(true);
  mockCreate.mockImplementation(async (payload: Record<string, unknown>) => ({
    _id: 'pat-1',
    ...payload,
  }));
  mockFindBuiltinOverride.mockResolvedValue(null);
  mockUpsertBuiltinOverride.mockImplementation(
    async (
      tenantId: string,
      projectId: string,
      piiType: string,
      payload: Record<string, unknown>,
    ) => ({
      pattern: {
        _id: 'builtin-override-1',
        tenantId,
        projectId,
        piiType,
        builtinOverride: true,
        ...payload,
      },
      created: true,
    }),
  );
  mockUpdate.mockImplementation(
    async (
      _tenantId: string,
      _projectId: string,
      patternId: string,
      updates: Record<string, unknown>,
    ) => ({
      _id: patternId,
      tenantId: 'tenant-1',
      projectId: 'project-1',
      createdBy: 'user-1',
      ...updates,
    }),
  );
  mockRemove.mockResolvedValue({ _id: 'pat-1', name: 'Custom Email' });
});

function makePatternPayload(overrides: Record<string, unknown> = {}) {
  return {
    name: 'Custom Email',
    piiType: 'custom',
    regex: '[^\\s]+@example\\.com',
    validate: '^.+@example\\.com$',
    redaction: { type: 'predefined', label: '[REDACTED_EMAIL]' },
    consumerAccess: [],
    defaultRenderMode: 'redacted',
    enabled: true,
    builtinOverride: false,
    ...overrides,
  };
}

describe('PII pattern routes', () => {
  it.each([
    { method: 'GET', path: '', permission: 'pii-pattern:read' },
    {
      method: 'POST',
      path: '',
      permission: 'pii-pattern:write',
      body: makePatternPayload(),
    },
    {
      method: 'POST',
      path: '/test',
      permission: 'pii-pattern:read',
      body: { piiType: 'email', text: 'Email alice@example.com' },
    },
    { method: 'GET', path: '/pat-1', permission: 'pii-pattern:read' },
    {
      method: 'PUT',
      path: '/pat-1',
      permission: 'pii-pattern:write',
      body: makePatternPayload({ name: 'Updated Pattern' }),
    },
    { method: 'DELETE', path: '/pat-1', permission: 'pii-pattern:write' },
  ])(
    'authorizes $method $path through project RBAC',
    async ({ method, path, permission, body }) => {
      await fetch(`${baseUrl}/api/projects/project-1/pii-patterns${path}`, {
        method,
        headers: body ? { 'Content-Type': 'application/json' } : undefined,
        body: body ? JSON.stringify(body) : undefined,
      });

      expect(mockRequireProjectPermission).toHaveBeenLastCalledWith(
        expect.any(Object),
        expect.any(Object),
        permission,
      );
    },
  );

  it('accepts built-in preview requests without a stored regex', async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        piiType: 'email',
        text: 'Email alice@example.com',
      }),
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ success: true });
  });

  it('normalizes LLM original consumer access before building preview payloads', async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        piiType: 'email',
        text: 'Email alice@example.com',
        consumerAccess: [{ consumer: 'llm', renderMode: 'original' }],
        defaultRenderMode: 'redacted',
      }),
    });

    expect(response.status).toBe(200);
    expect(mockTestPattern).toHaveBeenCalledWith(
      undefined,
      'Email alice@example.com',
      undefined,
      undefined,
      [{ consumer: 'llm', renderMode: 'tokenized' }],
      'redacted',
      'email',
    );
  });

  it('rejects preview requests that omit both regex and a supported built-in piiType', async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        piiType: 'custom',
        text: 'Email alice@example.com',
      }),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Missing required field: regex or a supported built-in piiType',
      },
    });
    expect(mockTestPattern).not.toHaveBeenCalled();
  });

  it('creates patterns with server-owned tenant, project, and creator fields', async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePatternPayload({
          tenantId: 'evil-tenant',
          projectId: 'evil-project',
          _id: 'evil-id',
          createdBy: 'evil-user',
        }),
      ),
    });

    expect(response.status).toBe(201);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        _id: 'pat-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        createdBy: 'user-1',
        name: 'Custom Email',
      },
    });
    expect(body.data.tenantId).not.toBe('evil-tenant');
    expect(body.data.projectId).not.toBe('evil-project');
    expect(body.data.createdBy).not.toBe('evil-user');
  });

  it('normalizes LLM original consumer access before storing created patterns', async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePatternPayload({
          consumerAccess: [{ consumer: 'llm', renderMode: 'original' }],
        }),
      ),
    });

    expect(response.status).toBe(201);
    expect(mockCreate).toHaveBeenCalledWith(
      expect.objectContaining({
        consumerAccess: [{ consumer: 'llm', renderMode: 'tokenized' }],
      }),
    );
  });

  it('rejects creates when validation fails', async () => {
    mockValidatePattern.mockResolvedValue({ valid: false, errors: ['regex required'] });

    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePatternPayload()),
    });

    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'regex required',
      },
    });
    expect(mockCreate).not.toHaveBeenCalled();
  });

  it('returns 409 when creating a duplicate pattern name', async () => {
    mockCreate.mockRejectedValue(Object.assign(new Error('duplicate key'), { code: 11000 }));

    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePatternPayload()),
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: 'DUPLICATE',
        message: 'A PII pattern with this name already exists',
      },
    });
  });

  it('returns a pattern by id when it exists', async () => {
    mockFindById.mockResolvedValue({
      _id: 'pat-1',
      ...makePatternPayload(),
      tenantId: 'tenant-1',
      projectId: 'project-1',
      createdBy: 'user-1',
    });

    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/pat-1`);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        _id: 'pat-1',
        name: 'Custom Email',
      },
    });
  });

  it('returns 404 when the requested pattern does not exist', async () => {
    mockFindById.mockResolvedValue(null);

    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/missing`);

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'PII pattern not found',
      },
    });
  });

  it('updates patterns while keeping protected fields server-owned', async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/pat-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePatternPayload({
          name: 'Updated Pattern',
          tenantId: 'evil-tenant',
          projectId: 'evil-project',
          _id: 'evil-id',
          createdBy: 'evil-user',
        }),
      ),
    });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      success: true,
      data: {
        _id: 'pat-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        createdBy: 'user-1',
        name: 'Updated Pattern',
      },
    });
    expect(body.data.tenantId).not.toBe('evil-tenant');
    expect(body.data.projectId).not.toBe('evil-project');
    expect(body.data.createdBy).not.toBe('evil-user');
  });

  it('adds an explicit LLM tokenized override before storing original-default updates', async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/pat-1`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(
        makePatternPayload({
          defaultRenderMode: 'original',
          consumerAccess: [],
        }),
      ),
    });

    expect(response.status).toBe(200);
    expect(mockUpdate).toHaveBeenCalledWith(
      'tenant-1',
      'project-1',
      'pat-1',
      expect.objectContaining({
        defaultRenderMode: 'original',
        consumerAccess: [{ consumer: 'llm', renderMode: 'tokenized' }],
      }),
    );
  });

  it('returns 404 when updating a missing pattern', async () => {
    mockUpdate.mockResolvedValue(null);

    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/missing`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(makePatternPayload()),
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'PII pattern not found',
      },
    });
  });

  it('deletes patterns and returns the deleted id', async () => {
    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/pat-1`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: { id: 'pat-1' },
    });
  });

  it('returns 404 when deleting a missing pattern', async () => {
    mockRemove.mockResolvedValue(null);

    const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns/missing`, {
      method: 'DELETE',
    });

    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({
      success: false,
      error: {
        code: 'NOT_FOUND',
        message: 'PII pattern not found',
      },
    });
  });

  // ─── ABLP-1197: built-in override upsert ─────────────────────────────────

  describe('POST with builtinOverride: true — upsert semantics (ABLP-1197)', () => {
    it('creates a new override when none exists for the piiType (returns 201)', async () => {
      const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makePatternPayload({
            name: 'Email Address',
            piiType: 'email',
            builtinOverride: true,
            redaction: {
              type: 'masked',
              maskConfig: { showFirst: 0, showLast: 0, maskChar: '*' },
            },
          }),
        ),
      });

      expect(response.status).toBe(201);
      const body = await response.json();
      expect(body).toMatchObject({
        success: true,
        data: { piiType: 'email', builtinOverride: true, name: 'Email Address' },
      });
      expect(mockUpsertBuiltinOverride).toHaveBeenCalledWith(
        'tenant-1',
        'project-1',
        'email',
        expect.objectContaining({
          piiType: 'email',
          builtinOverride: true,
          name: 'Email Address',
          createdBy: 'user-1',
        }),
      );
      // The legacy create path MUST NOT run for built-in overrides.
      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('updates the existing override on a second POST (returns 200, idempotent)', async () => {
      mockUpsertBuiltinOverride.mockImplementationOnce(
        async (
          tenantId: string,
          projectId: string,
          piiType: string,
          payload: Record<string, unknown>,
        ) => ({
          pattern: {
            _id: 'builtin-override-1',
            tenantId,
            projectId,
            piiType,
            builtinOverride: true,
            ...payload,
          },
          created: false,
        }),
      );

      const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          makePatternPayload({
            name: 'Email Address',
            piiType: 'email',
            builtinOverride: true,
            redaction: {
              type: 'masked',
              maskConfig: { showFirst: 4, showLast: 0, maskChar: '*' },
            },
          }),
        ),
      });

      expect(response.status).toBe(200);
      const body = await response.json();
      expect(body.success).toBe(true);
      expect(body.data.builtinOverride).toBe(true);
      expect(mockWriteAuditLog).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'pii-pattern:update' }),
      );
    });

    it('rejects when piiType is missing on a built-in override POST (400)', async () => {
      const response = await fetch(`${baseUrl}/api/projects/project-1/pii-patterns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: 'Bad Override',
          builtinOverride: true,
          redaction: { type: 'predefined', label: '[REDACTED]' },
          consumerAccess: [],
          defaultRenderMode: 'redacted',
          enabled: true,
        }),
      });

      expect(response.status).toBe(400);
      const body = await response.json();
      expect(body).toMatchObject({
        success: false,
        error: {
          code: 'VALIDATION_ERROR',
          message: expect.stringContaining('piiType'),
        },
      });
      expect(mockUpsertBuiltinOverride).not.toHaveBeenCalled();
    });

    it('does NOT use upsert path for custom (non-override) patterns', async () => {
      await fetch(`${baseUrl}/api/projects/project-1/pii-patterns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(makePatternPayload({ builtinOverride: false })),
      });

      expect(mockUpsertBuiltinOverride).not.toHaveBeenCalled();
      expect(mockCreate).toHaveBeenCalled();
    });
  });
});
