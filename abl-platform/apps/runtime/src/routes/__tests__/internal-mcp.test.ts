/**
 * Route-level test for /api/internal/mcp/reset-project-init.
 *
 * Uses real Express + supertest + real createServiceToken JWT (no platform
 * mocks per CLAUDE.md test-architecture rule). The MCP provider is the only
 * dependency injected into the route — we provide a test double with a
 * `resetProjectInit` spy so we can assert how the route routes its inputs.
 */

import express, { Router } from 'express';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { createServiceToken } from '@agent-platform/shared-auth';
import { loadConfig } from '../../config/index.js';
import { requireServiceAuth } from '../../middleware/internal-service-auth.js';
import { registerInternalMcpRoutes } from '../internal-mcp.js';
import type { RuntimeMcpClientProvider } from '../../services/mcp/runtime-mcp-provider.js';

const TEST_JWT_SECRET = 'unit-test-jwt-secret-' + 'x'.repeat(48);

const PRESERVED_ENV: Record<string, string | undefined> = {};
const TEST_ENV: Record<string, string> = {
  NODE_ENV: 'test',
  JWT_SECRET: TEST_JWT_SECRET,
};

beforeAll(async () => {
  for (const [key, value] of Object.entries(TEST_ENV)) {
    PRESERVED_ENV[key] = process.env[key];
    process.env[key] = value;
  }
  await loadConfig({ logSummary: false });
});

afterAll(() => {
  for (const key of Object.keys(TEST_ENV)) {
    if (PRESERVED_ENV[key] === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = PRESERVED_ENV[key];
    }
  }
});

interface ProviderDouble {
  resetProjectInit: ReturnType<typeof vi.fn>;
}

function buildApp(provider: ProviderDouble) {
  const app = express();
  app.use(express.json());
  const internalMcpRouter: Router = Router();
  internalMcpRouter.use(requireServiceAuth);
  registerInternalMcpRoutes(internalMcpRouter, provider as unknown as RuntimeMcpClientProvider);
  app.use('/api/internal/mcp', internalMcpRouter);
  return app;
}

function makeProvider(): ProviderDouble {
  return { resetProjectInit: vi.fn() };
}

function tokenFor(opts: { tenantId: string; projectId?: string }): string {
  return createServiceToken(TEST_JWT_SECRET, {
    tenantId: opts.tenantId,
    projectId: opts.projectId,
    serviceName: 'studio-mcp-cache-invalidation',
  });
}

describe('POST /api/internal/mcp/reset-project-init — happy path', () => {
  let provider: ProviderDouble;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('returns 200 and invokes provider.resetProjectInit(tenantId, projectId)', async () => {
    const token = tokenFor({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tA', projectId: 'pA' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(provider.resetProjectInit).toHaveBeenCalledTimes(1);
    expect(provider.resetProjectInit).toHaveBeenCalledWith('tA', 'pA');
  });
});

describe('POST /api/internal/mcp/reset-project-init — body validation', () => {
  let provider: ProviderDouble;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('returns 400 BAD_REQUEST when tenantId is missing', async () => {
    const token = tokenFor({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${token}`)
      .send({ projectId: 'pA' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'tenantId required' },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_REQUEST when tenantId is an empty string', async () => {
    const token = tokenFor({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: '', projectId: 'pA' });

    // requireServiceAuth runs first; an empty body tenantId is treated as
    // "no claim cross-check" by the middleware (truthy check), so we hit our
    // own 400 validator.
    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'tenantId required' },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_REQUEST when projectId is missing', async () => {
    const token = tokenFor({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tA' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'projectId required' },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });

  it('returns 400 BAD_REQUEST when projectId is an empty string', async () => {
    const token = tokenFor({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tA', projectId: '' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'BAD_REQUEST', message: 'projectId required' },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/mcp/reset-project-init — auth gating', () => {
  let provider: ProviderDouble;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('returns 401 UNAUTHORIZED when Authorization header is missing', async () => {
    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .send({ tenantId: 'tA', projectId: 'pA' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing service authorization' },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });

  it('returns 401 UNAUTHORIZED when token signed with a different secret', async () => {
    const tampered = createServiceToken('wrong-secret-' + 'x'.repeat(48), {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'studio-mcp-cache-invalidation',
    });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${tampered}`)
      .send({ tenantId: 'tA', projectId: 'pA' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired service token' },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });
});

describe('POST /api/internal/mcp/reset-project-init — claim cross-checks', () => {
  let provider: ProviderDouble;

  beforeEach(() => {
    provider = makeProvider();
  });

  it('returns 403 FORBIDDEN when token tenantId !== body tenantId (middleware)', async () => {
    const token = tokenFor({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tB', projectId: 'pA' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Tenant ID mismatch with service token' },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN when token projectId !== body projectId (middleware)', async () => {
    const token = tokenFor({ tenantId: 'tA', projectId: 'pA' });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tA', projectId: 'pB' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Project ID mismatch with service token' },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });

  it('returns 403 FORBIDDEN when token has no projectId claim (defense-in-depth)', async () => {
    const tenantOnlyToken = tokenFor({ tenantId: 'tA' });

    const res = await request(buildApp(provider))
      .post('/api/internal/mcp/reset-project-init')
      .set('Authorization', `Bearer ${tenantOnlyToken}`)
      .send({ tenantId: 'tA', projectId: 'pA' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: {
        code: 'FORBIDDEN',
        message: 'Service token must carry a projectId for project-scoped operations',
      },
    });
    expect(provider.resetProjectInit).not.toHaveBeenCalled();
  });
});
