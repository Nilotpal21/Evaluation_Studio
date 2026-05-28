/**
 * Project Runtime Config Route Tests — Project-Level Object:Operation RBAC + Happy-Path
 *
 * Verifies that `requireProjectPermission` enforces project-level permissions
 * on the project-runtime-config router using object:operation format, AND that
 * the GET/PUT/DELETE handlers return correct data (platform defaults, saved config,
 * upserted config, reset defaults).
 *
 * Resolution order in requireProjectPermission:
 *   1. Tenant OWNER/ADMIN → workspace authority (project:* bypass)
 *   2. Project existence → 404 if not found (tenant isolation)
 *   3. Project owner → full access (ownerId match)
 *   4. Project member role → permission check via PROJECT_ROLE_PERMISSIONS
 *   5. No membership → 404 (concealed as not found)
 *
 * Permission mapping:
 *   GET    / → runtime_config:read   (read config)
 *   PUT    / → runtime_config:write  (upsert config)
 *   DELETE / → runtime_config:write  (reset config)
 *
 * Note: `runtime_config:read` and `runtime_config:write` are NOT in the default
 * developer or viewer project role permissions. Only project admin (*:*) and
 * workspace authority (tenant OWNER/ADMIN) pass.
 *
 * Project role → permissions for runtime_config:
 *   admin     → *:* (all) — passes runtime_config:read AND runtime_config:write
 *   developer → does NOT have runtime_config:* — DENIED for both read and write
 *   viewer    → does NOT have runtime_config:read — DENIED for both read and write
 */

import { describe, test, expect, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';

// =============================================================================
// MOCKS — must be declared before any import that transitively pulls them in
// =============================================================================

vi.mock('../middleware/auth.js', () => ({
  authMiddleware: vi.fn((_req: any, _res: any, next: any) => next()),
}));

vi.mock('../middleware/rate-limiter.js', () => ({
  tenantRateLimit: vi.fn(() => (_req: any, _res: any, next: any) => next()),
}));

// Keep real hasPermission but stub requireProjectScope (API key scoping — tested separately)
vi.mock('@agent-platform/shared', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/shared')>();
  return {
    ...actual,
    requireProjectScope: vi.fn(() => (_req: any, _res: any, next: any) => next()),
  };
});

vi.mock('../openapi/registry.js', () => ({
  runtimeRegistry: {},
}));

vi.mock('@agent-platform/openapi/express', () => ({
  createOpenAPIRouter: vi.fn((_registry: any, _opts: any) => {
    const { Router } = require('express');
    const router = Router({ mergeParams: true });
    const validate = (schema: any) => (req: any, res: any, next: any) => {
      const validated: Record<string, unknown> = {};
      if (schema?.body) {
        const result = schema.body.safeParse(req.body);
        if (!result.success) {
          if (_opts?.onValidationError) {
            _opts.onValidationError(result.error, req, res, next);
            return;
          }
          next(result.error);
          return;
        }
        validated.body = result.data;
      }
      res.locals.openapi = {
        ...(res.locals.openapi ?? {}),
        validated: {
          ...(res.locals.openapi?.validated ?? {}),
          ...validated,
        },
      };
      next();
    };
    return {
      router,
      route: (method: string, path: string, schema: any, ...handlers: any[]) => {
        const lastHandler = handlers[handlers.length - 1];
        const middlewares = handlers.slice(0, -1);
        const routeHandlers = _opts?.validateRequests
          ? [validate(schema), ...middlewares, lastHandler]
          : [...middlewares, lastHandler];
        (router as any)[method](path, ...routeHandlers);
      },
    };
  }),
  getValidatedRequestData: vi.fn((res: any) => res.locals.openapi?.validated),
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

// --- Project repo: returns project with ownerId + membership lookup ---
vi.mock('../repos/project-repo.js', () => ({
  findProjectByIdAndTenant: vi.fn().mockImplementation((projectId: string, tenantId: string) => {
    // Only return project for tenant-A (cross-tenant returns null → 404)
    if (tenantId === 'tenant-A' && projectId === 'proj-1') {
      return Promise.resolve({
        _id: 'proj-1',
        tenantId: 'tenant-A',
        ownerId: 'project-owner',
      });
    }
    return Promise.resolve(null);
  }),
  findProjectMember: vi.fn().mockImplementation((_projectId: string, userId: string) => {
    const memberships: Record<string, { role: string }> = {
      'proj-admin-user': { role: 'admin' },
      'proj-dev-user': { role: 'developer' },
      'proj-viewer-user': { role: 'viewer' },
    };
    return Promise.resolve(memberships[userId] ?? null);
  }),
}));

vi.mock('../repos/auth-repo.js', () => ({
  shutdownAuditLogs: vi.fn(),
  _resetAuthAuditBufferStateForTests: vi.fn(),
  writeAuditLog: vi.fn(),
}));

// --- ProjectRuntimeConfig model mock ---
const {
  mockFindOneLean,
  mockFindOneAndUpdateLean,
  mockProjectRuntimeConfigDeleteOne,
  mockProjectLLMFindOneLean,
  mockProjectLLMFindOneAndUpdateLean,
  mockProjectLLMDeleteOne,
  mockModelConfigDistinct,
  mockTenantModelFindLean,
  mockTenantModelDistinct,
  mockPromptLibraryVersionFindOne,
  mockTenantConfigGetConfig,
  mockResolveAdvancedNluEntitlement,
  mockInvalidateModelResolutionCaches,
  mockBumpPIIConfigEpoch,
} = vi.hoisted(() => ({
  mockFindOneLean: vi.fn(),
  mockFindOneAndUpdateLean: vi.fn(),
  mockProjectRuntimeConfigDeleteOne: vi.fn(),
  mockProjectLLMFindOneLean: vi.fn(),
  mockProjectLLMFindOneAndUpdateLean: vi.fn(),
  mockProjectLLMDeleteOne: vi.fn(),
  mockModelConfigDistinct: vi.fn(),
  mockTenantModelFindLean: vi.fn(),
  mockTenantModelDistinct: vi.fn(),
  mockPromptLibraryVersionFindOne: vi.fn(),
  mockTenantConfigGetConfig: vi.fn().mockResolvedValue({ features: { advancedNlu: true } }),
  mockResolveAdvancedNluEntitlement: vi.fn().mockResolvedValue({ allowed: true }),
  mockInvalidateModelResolutionCaches: vi.fn(),
  mockBumpPIIConfigEpoch: vi.fn(),
}));

vi.mock('@agent-platform/project-io/import', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@agent-platform/project-io/import')>();
  return {
    ...actual,
    resolveAdvancedNluEntitlement: (...args: unknown[]) =>
      mockResolveAdvancedNluEntitlement(...args),
  };
});

vi.mock('@agent-platform/database/models', () => ({
  ProjectRuntimeConfig: {
    findOne: vi.fn().mockReturnValue({
      lean: mockFindOneLean,
    }),
    findOneAndUpdate: vi.fn().mockReturnValue({
      lean: mockFindOneAndUpdateLean,
    }),
    deleteOne: (...args: unknown[]) => mockProjectRuntimeConfigDeleteOne(...args),
  },
  ProjectLLMConfig: {
    findOne: vi.fn().mockReturnValue({
      lean: mockProjectLLMFindOneLean,
    }),
    findOneAndUpdate: vi.fn().mockReturnValue({
      lean: mockProjectLLMFindOneAndUpdateLean,
    }),
    deleteOne: (...args: unknown[]) => mockProjectLLMDeleteOne(...args),
  },
  ModelConfig: {
    distinct: (...args: unknown[]) => mockModelConfigDistinct(...args),
  },
  TenantModel: {
    find: (...args: unknown[]) => ({
      lean: () => mockTenantModelFindLean(...args),
    }),
    distinct: (...args: unknown[]) => mockTenantModelDistinct(...args),
  },
  PromptLibraryVersion: {
    findOne: (...args: unknown[]) => ({
      lean: () => mockPromptLibraryVersionFindOne(...args),
    }),
  },
}));

vi.mock('../services/llm/model-cache-invalidation.js', () => ({
  invalidateModelResolutionCaches: (...args: unknown[]) =>
    mockInvalidateModelResolutionCaches(...args),
}));

vi.mock('../services/pii/pii-epoch.js', () => ({
  bumpPIIConfigEpoch: (...args: unknown[]) => mockBumpPIIConfigEpoch(...args),
}));

vi.mock('../services/tenant-config.js', () => ({
  getTenantConfigService: () => ({
    getConfigAsync: (...args: unknown[]) => mockTenantConfigGetConfig(...args),
  }),
}));

// =============================================================================
// IMPORTS — after mocks
// =============================================================================

import express from 'express';
import { makeTenantContext, injectTenantContext } from './helpers/auth-context.js';
import { ProjectLLMConfig, ProjectRuntimeConfig } from '@agent-platform/database/models';

// =============================================================================
// HELPERS
// =============================================================================

const CONFIG_BASE = '/api/projects/proj-1/runtime-config';

async function request(baseUrl: string, method: string, path: string, opts?: { body?: any }) {
  const res = await fetch(`${baseUrl}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
  });
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json };
}

async function createServerForUser(
  tenantRole: 'OWNER' | 'ADMIN' | 'OPERATOR' | 'MEMBER' | 'VIEWER',
  userId: string,
  tenantId = 'tenant-A',
) {
  const app = express();
  app.use(express.json());
  const ctx = makeTenantContext(tenantId, userId, tenantRole);
  app.use(injectTenantContext(ctx));
  const configRouter = (await import('../routes/project-runtime-config.js')).default;
  app.use('/api/projects/:projectId/runtime-config', configRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

async function createUnauthenticatedServer() {
  const app = express();
  app.use(express.json());
  const configRouter = (await import('../routes/project-runtime-config.js')).default;
  app.use('/api/projects/:projectId/runtime-config', configRouter);

  return new Promise<{ baseUrl: string; server: http.Server }>((resolve) => {
    const server = http.createServer(app);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ baseUrl: `http://127.0.0.1:${addr.port}`, server });
    });
  });
}

// Platform defaults expected in GET response when no config exists
const PLATFORM_DEFAULTS = {
  projectId: 'proj-1',
  operationTierOverrides: {},
  extraction: {
    strategy: 'auto',
    correction_detection: 'ml',
    sidecar_timeout_ms: 500,
    sidecar_circuit_breaker_threshold: 5,
    nlu_provider: 'standard',
    advanced_sidecar_timeout_ms: 3000,
    advanced_sidecar_circuit_breaker_threshold: 5,
  },
  multi_intent: {
    enabled: true,
    strategy: 'primary_queue',
    max_intents: 3,
    confidence_threshold: 0.6,
    queue_max_age_ms: 600_000,
  },
  inference: {
    confidence: 0.8,
    confirm: true,
    model_tier: 'fast',
    max_fields_per_pass: 3,
  },
  conversion: {
    currency_mode: 'static',
  },
  pii_redaction: {
    enabled: true,
    redact_input: true,
    redact_output: false,
    tier: 'basic',
    latency_budget_ms: 200,
    confidence_threshold: 0.5,
    enabled_recognizer_packs: ['core'],
  },
  lookup_tables: [],
  filler: {
    enabled: true,
    chatEnabled: true,
    voiceEnabled: true,
    chatDelayMs: 1200,
    voiceDelayMs: 500,
    cooldownMs: 3000,
    maxPerTurn: 5,
    piggybackEnabled: true,
    pipelineGenerationEnabled: true,
    modelSource: 'system',
  },
};

const SAVED_CONFIG_DOC = {
  _id: 'config-1',
  tenantId: 'tenant-A',
  projectId: 'proj-1',
  operationTierOverrides: { extract: 'premium' },
  extraction: {
    strategy: 'hybrid',
    correction_detection: 'llm',
    sidecar_timeout_ms: 800,
    sidecar_circuit_breaker_threshold: 3,
  },
  multi_intent: {
    enabled: false,
    strategy: 'sequential',
    max_intents: 5,
    confidence_threshold: 0.7,
    queue_max_age_ms: 300_000,
  },
  inference: {
    confidence: 0.9,
    confirm: false,
    model_tier: 'balanced',
    max_fields_per_pass: 5,
  },
  conversion: {
    currency_mode: 'live',
    currency_api_url: 'https://api.exchangerate.host/latest',
  },
  lookup_tables: [{ name: 'cities', source: 'inline', values: ['New York', 'London', 'Tokyo'] }],
};

const PUT_BODY = {
  extraction: { strategy: 'hybrid' },
};

// =============================================================================
// TESTS — AUTHORIZATION
// =============================================================================

describe('ProjectRuntimeConfig route authorization — project-level object:operation RBAC', () => {
  // ---------------------------------------------------------------------------
  // Tenant OWNER — *:* includes project:* → workspace bypass → all pass
  // ---------------------------------------------------------------------------
  describe('Tenant OWNER (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      mockFindOneLean.mockResolvedValue(null);
      mockFindOneAndUpdateLean.mockResolvedValue(SAVED_CONFIG_DOC);
      ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
    });
    afterAll(() => server?.close());

    test('GET / passes (runtime_config:read — workspace authority)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('PUT / passes (runtime_config:write — workspace authority)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Tenant ADMIN — project:* → workspace bypass → all pass
  // ---------------------------------------------------------------------------
  describe('Tenant ADMIN (workspace authority)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      mockFindOneLean.mockResolvedValue(null);
      mockFindOneAndUpdateLean.mockResolvedValue(SAVED_CONFIG_DOC);
      ({ baseUrl, server } = await createServerForUser('ADMIN', 'admin-user'));
    });
    afterAll(() => server?.close());

    test('GET / passes (runtime_config:read — workspace authority)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('PUT / passes (runtime_config:write — workspace authority)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Project owner (OPERATOR tenant role) — ownerId match → full access
  // ---------------------------------------------------------------------------
  describe('Project owner (ownerId match)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      mockFindOneLean.mockResolvedValue(null);
      mockFindOneAndUpdateLean.mockResolvedValue(SAVED_CONFIG_DOC);
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'project-owner'));
    });
    afterAll(() => server?.close());

    test('GET / passes (runtime_config:read — project owner)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('PUT / passes (runtime_config:write — project owner)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Project admin member (OPERATOR tenant role) → admin: *:* → all pass
  // ---------------------------------------------------------------------------
  describe('Project admin member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      mockFindOneLean.mockResolvedValue(null);
      mockFindOneAndUpdateLean.mockResolvedValue(SAVED_CONFIG_DOC);
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-admin-user'));
    });
    afterAll(() => server?.close());

    test('GET / passes (admin has *:* → runtime_config:read)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });

    test('PUT / passes (admin has *:* → runtime_config:write)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).not.toBe(403);
      expect(status).not.toBe(401);
      expect(status).toBe(200);
      expect(body.success).toBe(true);
    });
  });

  // ---------------------------------------------------------------------------
  // Project developer member (OPERATOR tenant role) → lacks runtime_config:*
  // Developer does NOT have runtime_config:read or runtime_config:write
  // ---------------------------------------------------------------------------
  describe('Project developer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      mockFindOneLean.mockResolvedValue(null);
      mockFindOneAndUpdateLean.mockResolvedValue(SAVED_CONFIG_DOC);
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'proj-dev-user'));
    });
    afterAll(() => server?.close());

    test('GET / returns 403 (developer lacks runtime_config:read)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('runtime_config:read');
    });

    test('PUT / returns 403 (developer lacks runtime_config:write)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('developer');
      expect(body.message).toContain('runtime_config:write');
    });
  });

  // ---------------------------------------------------------------------------
  // Project viewer member (MEMBER tenant role) → lacks runtime_config:*
  // ---------------------------------------------------------------------------
  describe('Project viewer member', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      mockFindOneLean.mockResolvedValue(null);
      mockFindOneAndUpdateLean.mockResolvedValue(SAVED_CONFIG_DOC);
      ({ baseUrl, server } = await createServerForUser('MEMBER', 'proj-viewer-user'));
    });
    afterAll(() => server?.close());

    test('GET / returns 403 (viewer lacks runtime_config:read)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('runtime_config:read');
    });

    test('PUT / returns 403 (viewer lacks runtime_config:write)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).toBe(403);
      expect(body.error).toMatchObject({ message: 'Forbidden' });
      expect(body.message).toContain('viewer');
      expect(body.message).toContain('runtime_config:write');
    });
  });

  // ---------------------------------------------------------------------------
  // Non-member (OPERATOR tenant role, no project membership) → all 404
  // This is the key test: tenant-level permissions alone are NOT enough
  // ---------------------------------------------------------------------------
  describe('Non-member (OPERATOR without project membership)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      mockFindOneLean.mockResolvedValue(null);
      mockFindOneAndUpdateLean.mockResolvedValue(SAVED_CONFIG_DOC);
      ({ baseUrl, server } = await createServerForUser('OPERATOR', 'non-member-user'));
    });
    afterAll(() => server?.close());

    test('GET / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
      expect(body.message).toBeUndefined();
    });

    test('PUT / returns 404 (project existence concealed from non-members)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ message: 'Project not found' });
      expect(body.message).toBeUndefined();
    });
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant access — Tenant B tries to access Tenant A's project → 404
  // Enforces tenant isolation: cross-tenant must return 404, not 403
  // ---------------------------------------------------------------------------
  describe('Cross-tenant access (tenant isolation)', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      mockFindOneLean.mockResolvedValue(null);
      mockFindOneAndUpdateLean.mockResolvedValue(SAVED_CONFIG_DOC);
      // Use OPERATOR role from tenant-B — findProjectByIdAndTenant returns null for tenant-B
      ({ baseUrl, server } = await createServerForUser(
        'OPERATOR',
        'cross-tenant-user',
        'tenant-B',
      ));
    });
    afterAll(() => server?.close());

    test('GET / returns 404 for cross-tenant project (not 403)', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
    });

    test('PUT / returns 404 for cross-tenant project (not 403)', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).toBe(404);
      expect(body.error).toMatchObject({ code: 'PROJECT_NOT_FOUND', message: 'Project not found' });
    });
  });

  // ---------------------------------------------------------------------------
  // Unauthenticated — no tenant context → all 401
  // ---------------------------------------------------------------------------
  describe('Unauthenticated requests', () => {
    let baseUrl: string;
    let server: http.Server;

    beforeAll(async () => {
      ({ baseUrl, server } = await createUnauthenticatedServer());
    });
    afterAll(() => server?.close());

    test('GET / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });

    test('PUT / returns 401', async () => {
      const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, { body: PUT_BODY });
      expect(status).toBe(401);
      expect(body.error).toMatchObject({ message: 'Authentication required' });
    });
  });
});

// =============================================================================
// TESTS — HAPPY PATH (data correctness)
// =============================================================================

describe('ProjectRuntimeConfig route — happy-path data correctness', () => {
  let baseUrl: string;
  let server: http.Server;

  beforeAll(async () => {
    ({ baseUrl, server } = await createServerForUser('OWNER', 'owner-user'));
  });
  afterAll(() => server?.close());

  // ---------------------------------------------------------------------------
  // GET / — returns platform defaults when no config exists
  // ---------------------------------------------------------------------------
  test('GET / returns platform defaults when no config exists', async () => {
    mockFindOneLean.mockResolvedValue(null);

    const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toEqual(PLATFORM_DEFAULTS);
  });

  // ---------------------------------------------------------------------------
  // GET / — returns saved config when it exists
  // ---------------------------------------------------------------------------
  test('GET / returns saved config when one exists', async () => {
    mockFindOneLean.mockResolvedValue(SAVED_CONFIG_DOC);

    const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.projectId).toBe('proj-1');
    expect(body.data.operationTierOverrides).toEqual({ extract: 'premium' });
    expect(body.data.extraction.strategy).toBe('hybrid');
    expect(body.data.extraction.correction_detection).toBe('llm');
    expect(body.data.extraction.sidecar_timeout_ms).toBe(800);
    expect(body.data.multi_intent.enabled).toBe(false);
    expect(body.data.multi_intent.strategy).toBe('sequential');
    expect(body.data.multi_intent.max_intents).toBe(5);
    expect(body.data.inference.confidence).toBe(0.9);
    expect(body.data.inference.confirm).toBe(false);
    expect(body.data.inference.model_tier).toBe('balanced');
    expect(body.data.conversion.currency_mode).toBe('live');
    expect(body.data.conversion.currency_api_url).toBe('https://api.exchangerate.host/latest');
    expect(body.data.lookup_tables).toHaveLength(1);
    expect(body.data.lookup_tables[0].name).toBe('cities');
  });

  // ---------------------------------------------------------------------------
  // GET / — merges saved config with platform defaults for missing sections
  // ---------------------------------------------------------------------------
  test('GET / merges partial saved config with platform defaults', async () => {
    // Doc only has extraction set — all other sections should be platform defaults
    mockFindOneLean.mockResolvedValue({
      _id: 'config-partial',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      extraction: {
        strategy: 'hybrid',
      },
    });

    const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    // extraction should merge saved with defaults
    expect(body.data.extraction.strategy).toBe('hybrid');
    // defaults fill in for missing extraction keys
    expect(body.data.extraction.correction_detection).toBe('ml');
    expect(body.data.extraction.sidecar_timeout_ms).toBe(500);
    // other sections should be full platform defaults
    expect(body.data.multi_intent).toEqual(PLATFORM_DEFAULTS.multi_intent);
    expect(body.data.inference).toEqual(PLATFORM_DEFAULTS.inference);
    expect(body.data.conversion).toEqual(PLATFORM_DEFAULTS.conversion);
    expect(body.data.lookup_tables).toEqual([]);
  });

  // ---------------------------------------------------------------------------
  // PUT / — creates config on first PUT (upsert)
  // ---------------------------------------------------------------------------
  test('PUT / creates config on first PUT (upsert)', async () => {
    const upsertedDoc = {
      _id: 'config-new',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      extraction: {
        strategy: 'hybrid',
      },
    };
    mockFindOneAndUpdateLean.mockResolvedValue(upsertedDoc);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { extraction: { strategy: 'hybrid' } },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.projectId).toBe('proj-1');
    expect(body.data.extraction.strategy).toBe('hybrid');
    // Defaults fill in for missing extraction keys
    expect(body.data.extraction.correction_detection).toBe('ml');
  });

  test('PUT / rejects invalid correction_detection before persistence', async () => {
    mockFindOneAndUpdateLean.mockClear();

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { extraction: { correction_detection: 'heuristic' } },
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: { code: 'VALIDATION_ERROR' },
    });
    expect(mockFindOneAndUpdateLean).not.toHaveBeenCalled();
  });

  // ---------------------------------------------------------------------------
  // PUT / — updates existing config with partial payload
  // ---------------------------------------------------------------------------
  test('PUT / updates existing config with partial payload', async () => {
    mockFindOneLean.mockResolvedValue({
      _id: 'config-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      extraction: {
        strategy: 'hybrid',
        correction_detection: 'llm',
        sidecar_timeout_ms: 800,
        sidecar_circuit_breaker_threshold: 3,
        nlu_provider: 'standard',
      },
    });
    const updatedDoc = {
      _id: 'config-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: { extract: 'premium' },
      extraction: {
        strategy: 'hybrid',
        correction_detection: 'llm',
        sidecar_timeout_ms: 1000,
        sidecar_circuit_breaker_threshold: 3,
      },
      multi_intent: {
        enabled: true,
        strategy: 'primary_queue',
        max_intents: 3,
        confidence_threshold: 0.6,
        queue_max_age_ms: 600_000,
      },
      inference: {
        confidence: 0.8,
        confirm: true,
        model_tier: 'fast',
        max_fields_per_pass: 3,
      },
      conversion: {
        currency_mode: 'static',
      },
      lookup_tables: [],
    };
    mockFindOneAndUpdateLean.mockResolvedValue(updatedDoc);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { extraction: { sidecar_timeout_ms: 1000 } },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.extraction.sidecar_timeout_ms).toBe(1000);
    expect(body.data.extraction.strategy).toBe('hybrid');
    expect(body.data.extraction.correction_detection).toBe('llm');

    const [, update] = vi.mocked(ProjectRuntimeConfig.findOneAndUpdate).mock.calls.at(-1) as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set.extraction).toEqual({
      strategy: 'hybrid',
      correction_detection: 'llm',
      sidecar_timeout_ms: 1000,
      sidecar_circuit_breaker_threshold: 3,
      nlu_provider: 'standard',
    });
  });

  test('PUT / validates advanced NLU entitlement against the final merged config', async () => {
    mockResolveAdvancedNluEntitlement.mockResolvedValueOnce({ allowed: false });
    mockFindOneLean.mockResolvedValue({
      _id: 'config-advanced',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      extraction: {
        strategy: 'hybrid',
        correction_detection: 'llm',
        sidecar_timeout_ms: 800,
        sidecar_circuit_breaker_threshold: 3,
        nlu_provider: 'advanced',
        advanced_sidecar_url: 'https://advanced-nlu.example.com',
        advanced_sidecar_timeout_ms: 3000,
        advanced_sidecar_circuit_breaker_threshold: 5,
      },
    });
    mockFindOneAndUpdateLean.mockClear();

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { extraction: { sidecar_timeout_ms: 1000 } },
    });

    expect(status).toBe(403);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'PLAN_FEATURE_UNAVAILABLE',
        message: 'Advanced NLU provider requires an Enterprise plan',
      },
    });
    expect(mockFindOneAndUpdateLean).not.toHaveBeenCalled();
  });

  test('PUT / rejects stale project model refs preserved by partial updates', async () => {
    mockModelConfigDistinct.mockClear();
    mockModelConfigDistinct.mockResolvedValue([]);
    mockFindOneLean.mockResolvedValue({
      _id: 'config-stale-model',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      filler: {
        enabled: true,
        chatEnabled: true,
        voiceEnabled: true,
        chatDelayMs: 1200,
        voiceDelayMs: 500,
        cooldownMs: 3000,
        maxPerTurn: 5,
        piggybackEnabled: true,
        pipelineGenerationEnabled: true,
        modelSource: 'project',
        modelId: 'deleted-model',
      },
    });
    mockFindOneAndUpdateLean.mockClear();

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { filler: { chatDelayMs: 2500 } },
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('deleted-model'),
      },
    });
    expect(mockModelConfigDistinct).toHaveBeenCalledWith('modelId', {
      modelId: { $in: ['deleted-model'] },
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });
    expect(mockFindOneAndUpdateLean).not.toHaveBeenCalled();
  });

  test('PUT / persists and returns project compaction overrides', async () => {
    mockFindOneLean.mockResolvedValue(null);
    const compaction = {
      tool_results: {
        strategy: 'truncate',
        max_chars: 4096,
        keep_recent: 1,
        essential_fields: {
          search_hotels: ['name', 'price'],
        },
      },
      prior_turns: {
        strategy: 'compact',
        assistant_preview_chars: 80,
      },
    };
    mockFindOneAndUpdateLean.mockResolvedValue({
      _id: 'config-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      compaction,
    });

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { compaction },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.compaction).toEqual(compaction);
  });

  test('PUT / mirrors operationTierOverrides into canonical ProjectLLMConfig', async () => {
    mockFindOneLean.mockResolvedValue(null);
    const updatedDoc = {
      _id: 'config-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: { response_gen: 'powerful' },
    };
    mockFindOneAndUpdateLean.mockResolvedValue(updatedDoc);
    mockProjectLLMFindOneAndUpdateLean.mockResolvedValue(updatedDoc);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { operationTierOverrides: { response_gen: 'powerful' } },
    });

    expect(status).toBe(200);
    expect(body.data.operationTierOverrides).toEqual({ response_gen: 'powerful' });
    expect(ProjectLLMConfig.findOneAndUpdate).toHaveBeenCalledWith(
      { tenantId: 'tenant-A', projectId: 'proj-1' },
      {
        $set: {
          tenantId: 'tenant-A',
          projectId: 'proj-1',
          operationTierOverrides: { response_gen: 'powerful' },
        },
      },
      { new: true, upsert: true, setDefaultsOnInsert: true },
    );
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
  });

  test('PUT / invalidates model resolution caches when runtime model sections change', async () => {
    vi.mocked(ProjectLLMConfig.findOneAndUpdate).mockClear();
    mockInvalidateModelResolutionCaches.mockClear();
    mockFindOneLean.mockResolvedValue(null);
    mockFindOneAndUpdateLean.mockResolvedValue({
      _id: 'config-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      pipeline: {
        enabled: true,
        mode: 'parallel',
        modelSource: 'default',
      },
    });

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: {
        pipeline: {
          enabled: true,
          mode: 'parallel',
          modelSource: 'default',
        },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(ProjectLLMConfig.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
  });

  test('PUT / rejects invalid operationTierOverrides before compatibility mirroring', async () => {
    vi.mocked(ProjectLLMConfig.findOneAndUpdate).mockClear();
    mockInvalidateModelResolutionCaches.mockClear();

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: { operationTierOverrides: { extract: 'premium' } },
    });

    expect(status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: expect.stringContaining('Invalid operation-tier overrides'),
      },
    });
    expect(ProjectLLMConfig.findOneAndUpdate).not.toHaveBeenCalled();
    expect(mockInvalidateModelResolutionCaches).not.toHaveBeenCalled();
  });

  test('PUT / validates project-selected filler models within the current tenant and project', async () => {
    mockModelConfigDistinct.mockClear();
    mockModelConfigDistinct.mockResolvedValue(['model-1']);
    mockTenantModelFindLean.mockResolvedValue([]);
    mockFindOneAndUpdateLean.mockResolvedValue({
      _id: 'config-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      filler: {
        enabled: true,
        chatEnabled: true,
        voiceEnabled: true,
        chatDelayMs: 1200,
        voiceDelayMs: 500,
        cooldownMs: 3000,
        maxPerTurn: 5,
        piggybackEnabled: true,
        pipelineGenerationEnabled: true,
        modelSource: 'project',
        modelId: 'model-1',
      },
    });

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: {
        filler: {
          enabled: true,
          chatEnabled: true,
          voiceEnabled: true,
          chatDelayMs: 1200,
          voiceDelayMs: 500,
          cooldownMs: 3000,
          maxPerTurn: 5,
          piggybackEnabled: true,
          pipelineGenerationEnabled: true,
          modelSource: 'project',
          modelId: 'model-1',
        },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockModelConfigDistinct).toHaveBeenCalledWith('modelId', {
      modelId: { $in: ['model-1'] },
      projectId: 'proj-1',
      tenantId: 'tenant-A',
    });
  });

  test('PUT / persists normalized tenant model ids from portable runtime model refs', async () => {
    mockTenantModelFindLean.mockResolvedValue([
      {
        _id: 'tm-voice-1',
        provider: 'openai',
        modelId: 'gpt-4.1-mini',
        capabilities: ['realtime_voice'],
      },
    ]);
    mockTenantModelDistinct.mockResolvedValue(['tm-voice-1']);
    mockFindOneAndUpdateLean.mockResolvedValue({
      _id: 'config-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      filler: {
        enabled: true,
        chatEnabled: true,
        voiceEnabled: true,
        chatDelayMs: 1200,
        voiceDelayMs: 500,
        cooldownMs: 3000,
        maxPerTurn: 5,
        piggybackEnabled: true,
        pipelineGenerationEnabled: true,
        modelSource: 'tenant',
        tenantModelId: 'tm-voice-1',
      },
    });

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: {
        filler: {
          enabled: true,
          chatEnabled: true,
          voiceEnabled: true,
          chatDelayMs: 1200,
          voiceDelayMs: 500,
          cooldownMs: 3000,
          maxPerTurn: 5,
          piggybackEnabled: true,
          pipelineGenerationEnabled: true,
          modelSource: 'tenant',
          tenantModelRef: {
            provider: 'openai',
            modelId: 'gpt-4.1-mini',
            tier: 'voice',
            capabilities: ['realtime_voice'],
          },
        },
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(mockTenantModelFindLean).toHaveBeenCalledWith({
      tenantId: 'tenant-A',
      provider: 'openai',
      modelId: 'gpt-4.1-mini',
      isActive: true,
      inferenceEnabled: { $ne: false },
    });
    expect(ProjectRuntimeConfig.findOneAndUpdate).toHaveBeenCalled();
    const [, update] = vi.mocked(ProjectRuntimeConfig.findOneAndUpdate).mock.calls.at(-1) as [
      unknown,
      { $set: Record<string, unknown> },
    ];
    expect(update.$set.filler).toEqual(
      expect.objectContaining({
        modelSource: 'tenant',
        tenantModelId: 'tm-voice-1',
      }),
    );
    expect((update.$set.filler as Record<string, unknown>).tenantModelRef).toBeUndefined();
  });

  test('PUT / rejects tenant-selected runtime models outside the current tenant', async () => {
    mockTenantModelDistinct.mockClear();
    mockTenantModelDistinct.mockResolvedValue(['tm-pipeline']);
    mockTenantModelFindLean.mockResolvedValue([]);
    mockFindOneAndUpdateLean.mockClear();
    mockPromptLibraryVersionFindOne.mockResolvedValue(null);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: {
        pipeline: {
          enabled: true,
          mode: 'parallel',
          modelSource: 'tenant',
          tenantModelId: 'tm-pipeline',
        },
        filler: {
          enabled: true,
          chatEnabled: true,
          voiceEnabled: true,
          chatDelayMs: 1200,
          voiceDelayMs: 500,
          cooldownMs: 3000,
          maxPerTurn: 5,
          piggybackEnabled: true,
          pipelineGenerationEnabled: true,
          modelSource: 'tenant',
          tenantModelId: 'tm-other-tenant',
        },
      },
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Selected tenant model must belong to this tenant',
      },
    });
    expect(mockTenantModelDistinct).toHaveBeenCalledWith('_id', {
      _id: { $in: ['tm-pipeline', 'tm-other-tenant'] },
      tenantId: 'tenant-A',
      isActive: true,
      inferenceEnabled: { $ne: false },
    });
    expect(mockFindOneAndUpdateLean).not.toHaveBeenCalled();
  });

  test('PUT / rejects archived filler prompt overrides', async () => {
    mockPromptLibraryVersionFindOne.mockResolvedValue({
      _id: 'prompt-version-1',
      promptId: 'prompt-1',
      status: 'archived',
    });

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: {
        filler: {
          enabled: true,
          chatEnabled: true,
          voiceEnabled: true,
          chatDelayMs: 1200,
          voiceDelayMs: 500,
          cooldownMs: 3000,
          maxPerTurn: 5,
          piggybackEnabled: true,
          pipelineGenerationEnabled: true,
          modelSource: 'system',
          promptRef: {
            promptId: 'prompt-1',
            versionId: 'prompt-version-1',
          },
        },
      },
    });

    expect(status).toBe(400);
    expect(body).toMatchObject({
      success: false,
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Selected prompt version must belong to this project and be available',
      },
    });
    expect(mockFindOneAndUpdateLean).not.toHaveBeenCalled();
  });

  test('DELETE / resets runtime config and clears canonical LLM overrides', async () => {
    mockProjectRuntimeConfigDeleteOne.mockClear();
    mockProjectLLMDeleteOne.mockClear();
    mockBumpPIIConfigEpoch.mockClear();
    mockInvalidateModelResolutionCaches.mockClear();
    mockProjectRuntimeConfigDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockProjectLLMDeleteOne.mockResolvedValue({ deletedCount: 1 });
    mockBumpPIIConfigEpoch.mockResolvedValue(undefined);

    const { status, body } = await request(baseUrl, 'DELETE', CONFIG_BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.operationTierOverrides).toEqual({});
    expect(mockProjectRuntimeConfigDeleteOne).toHaveBeenCalledWith({
      tenantId: 'tenant-A',
      projectId: 'proj-1',
    });
    expect(mockProjectLLMDeleteOne).toHaveBeenCalledWith({
      tenantId: 'tenant-A',
      projectId: 'proj-1',
    });
    expect(mockBumpPIIConfigEpoch).toHaveBeenCalledWith('tenant-A', 'proj-1');
    expect(mockInvalidateModelResolutionCaches).toHaveBeenCalledWith('tenant-A');
  });

  // ---------------------------------------------------------------------------
  // PUT / — updates lookup_tables
  // ---------------------------------------------------------------------------
  test('PUT / updates lookup_tables', async () => {
    const updatedDoc = {
      _id: 'config-1',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      lookup_tables: [
        { name: 'cities', source: 'inline', values: ['Berlin', 'Paris', 'Madrid'] },
        { name: 'currencies', source: 'collection', table_name: 'currency_codes' },
      ],
    };
    mockFindOneAndUpdateLean.mockResolvedValue(updatedDoc);

    const { status, body } = await request(baseUrl, 'PUT', CONFIG_BASE, {
      body: {
        lookup_tables: [
          { name: 'cities', source: 'inline', values: ['Berlin', 'Paris', 'Madrid'] },
          { name: 'currencies', source: 'collection', table_name: 'currency_codes' },
        ],
      },
    });

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.lookup_tables).toHaveLength(2);
    expect(body.data.lookup_tables[0].name).toBe('cities');
    expect(body.data.lookup_tables[1].name).toBe('currencies');
  });

  // ---------------------------------------------------------------------------
  // GET / — handles Map-type operationTierOverrides from Mongoose
  // ---------------------------------------------------------------------------
  test('GET / normalizes Map-type operationTierOverrides from Mongoose doc', async () => {
    const mapOverrides = new Map([
      ['extract', 'premium'],
      ['classify', 'fast'],
    ]);
    mockFindOneLean.mockResolvedValue({
      _id: 'config-map',
      tenantId: 'tenant-A',
      projectId: 'proj-1',
      operationTierOverrides: mapOverrides,
    });

    const { status, body } = await request(baseUrl, 'GET', CONFIG_BASE);

    expect(status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.operationTierOverrides).toEqual({ extract: 'premium', classify: 'fast' });
  });
});
