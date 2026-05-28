/**
 * Phase 0 — Verifies that requireServiceAuth cross-checks tenantId between
 * the verified service token and the request body/params/query, returning
 * 403 FORBIDDEN on mismatch.
 *
 * Pattern: real Express + supertest + real createServiceToken JWT + real
 * runtime loadConfig (no platform mocks per CLAUDE.md test-architecture rule).
 */

import express from 'express';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createServiceToken } from '@agent-platform/shared-auth';
import { loadConfig } from '../config/index.js';
import { requireServiceAuth } from '../middleware/internal-service-auth.js';

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

function buildApp() {
  const app = express();
  app.use(express.json());
  app.post('/api/internal/echo', requireServiceAuth, (req, res) => {
    res.status(200).json({ success: true, data: { body: req.body } });
  });
  return app;
}

describe('requireServiceAuth — projectId cross-check (existing behavior)', () => {
  it('passes when token projectId matches body projectId', async () => {
    const token = createServiceToken(TEST_JWT_SECRET, {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'workflow-engine',
    });

    const res = await request(buildApp())
      .post('/api/internal/echo')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tA', projectId: 'pA', payload: 'ok' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      success: true,
      data: { body: { tenantId: 'tA', projectId: 'pA', payload: 'ok' } },
    });
  });

  it('returns 403 FORBIDDEN when token projectId !== body projectId', async () => {
    const token = createServiceToken(TEST_JWT_SECRET, {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'workflow-engine',
    });

    const res = await request(buildApp())
      .post('/api/internal/echo')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tA', projectId: 'pB' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Project ID mismatch with service token' },
    });
  });
});

describe('requireServiceAuth — tenantId cross-check (Phase 0 addition)', () => {
  it('passes when token tenantId matches body tenantId', async () => {
    const token = createServiceToken(TEST_JWT_SECRET, {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'workflow-engine',
    });

    const res = await request(buildApp())
      .post('/api/internal/echo')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tA', projectId: 'pA' });

    expect(res.status).toBe(200);
  });

  it('returns 403 FORBIDDEN when token tenantId !== body tenantId', async () => {
    const token = createServiceToken(TEST_JWT_SECRET, {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'workflow-engine',
    });

    const res = await request(buildApp())
      .post('/api/internal/echo')
      .set('Authorization', `Bearer ${token}`)
      .send({ tenantId: 'tB', projectId: 'pA' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'FORBIDDEN', message: 'Tenant ID mismatch with service token' },
    });
  });

  it('returns 403 FORBIDDEN when tenantId mismatch in query string', async () => {
    const token = createServiceToken(TEST_JWT_SECRET, {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'workflow-engine',
    });

    const app = express();
    app.use(express.json());
    app.get('/api/internal/echo', requireServiceAuth, (_req, res) => {
      res.status(200).json({ success: true, data: {} });
    });

    const res = await request(app)
      .get('/api/internal/echo?tenantId=tB&projectId=pA')
      .set('Authorization', `Bearer ${token}`);

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Tenant ID mismatch with service token');
  });

  it('returns 403 FORBIDDEN when tenantId mismatch in route params', async () => {
    const token = createServiceToken(TEST_JWT_SECRET, {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'workflow-engine',
    });

    const app = express();
    app.use(express.json());
    app.post('/api/internal/echo/:tenantId', requireServiceAuth, (_req, res) => {
      res.status(200).json({ success: true, data: {} });
    });

    const res = await request(app)
      .post('/api/internal/echo/tB')
      .set('Authorization', `Bearer ${token}`)
      .send({});

    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(res.body.error.message).toBe('Tenant ID mismatch with service token');
  });

  it('passes when body has no tenantId (cross-check is opt-in)', async () => {
    const token = createServiceToken(TEST_JWT_SECRET, {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'workflow-engine',
    });

    const res = await request(buildApp())
      .post('/api/internal/echo')
      .set('Authorization', `Bearer ${token}`)
      .send({ payload: 'no-ids' });

    expect(res.status).toBe(200);
  });
});

describe('requireServiceAuth — auth gating (regression)', () => {
  it('returns 401 UNAUTHORIZED when Authorization header is missing', async () => {
    const res = await request(buildApp()).post('/api/internal/echo').send({ tenantId: 'tA' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Missing service authorization' },
    });
  });

  it('returns 401 UNAUTHORIZED when token signed with a different secret', async () => {
    const tamperedToken = createServiceToken('wrong-secret-' + 'x'.repeat(48), {
      tenantId: 'tA',
      projectId: 'pA',
      serviceName: 'workflow-engine',
    });

    const res = await request(buildApp())
      .post('/api/internal/echo')
      .set('Authorization', `Bearer ${tamperedToken}`)
      .send({ tenantId: 'tA' });

    expect(res.status).toBe(401);
    expect(res.body).toEqual({
      success: false,
      error: { code: 'UNAUTHORIZED', message: 'Invalid or expired service token' },
    });
  });
});
