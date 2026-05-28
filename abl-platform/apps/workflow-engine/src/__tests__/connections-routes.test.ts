import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createConnectionRouter, type ConnectionRouteDeps } from '../routes/connections.js';
import type { ConnectionRecord } from '@agent-platform/connectors/services';

function makeConnection(overrides: Partial<ConnectionRecord> = {}): ConnectionRecord {
  return {
    _id: 'conn-1',
    tenantId: 't1',
    projectId: 'p1',
    connectorName: 'slack',
    displayName: 'Slack Production',
    scope: 'tenant',
    authProfileId: 'ap-1',
    status: 'active',
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ConnectionRouteDeps> = {}): ConnectionRouteDeps {
  return {
    connectionModel: {
      find: vi.fn().mockReturnValue({
        sort: vi.fn().mockReturnValue({
          lean: vi.fn().mockResolvedValue([makeConnection()]),
        }),
      }),
      findOne: vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(makeConnection()) }),
      create: vi.fn().mockImplementation(async (data) => ({ ...makeConnection(), ...data })),
      findOneAndUpdate: vi.fn().mockResolvedValue(makeConnection()),
      findOneAndDelete: vi.fn().mockResolvedValue(makeConnection()),
    },
    registry: {
      has: vi.fn().mockReturnValue(true),
      get: vi.fn().mockReturnValue({
        name: 'slack',
        actions: [{ name: 'test_connection', run: vi.fn().mockResolvedValue({ ok: true }) }],
        triggers: [],
      }),
      listConnectors: vi.fn().mockReturnValue([]),
    } as any,
    authProfileResolver: {
      resolve: vi.fn().mockResolvedValue({ apiKey: 'sk-123' }),
    },
    ...overrides,
  };
}

function createApp(deps: ConnectionRouteDeps, opts: { withTenant?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  if (opts.withTenant !== false) {
    app.use((req: any, _res, next) => {
      req.tenantContext = { tenantId: 't1', userId: 'user-1' };
      next();
    });
  }
  app.use('/api/projects/:projectId/connections', createConnectionRouter(deps));
  return app;
}

describe('Connection Routes', () => {
  let deps: ConnectionRouteDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  describe('GET /connections', () => {
    it('lists connections scoped by tenant and project', async () => {
      const res = await request(app).get('/api/projects/p1/connections');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(1);
      expect(deps.connectionModel.find).toHaveBeenCalledWith({ tenantId: 't1', projectId: 'p1' });
    });
  });

  describe('POST /connections', () => {
    it('creates a connection with authProfileId', async () => {
      const res = await request(app).post('/api/projects/p1/connections').send({
        connectorName: 'slack',
        displayName: 'Slack Dev',
        authProfileId: 'ap-1',
      });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      // ConnectionService.create now upserts via findOneAndUpdate against the
      // {tenantId, projectId, connectorName, authProfileId} unique key (per
      // ABLP-1015) so the bridge-row race with auth-profiles POST is idempotent.
      expect(deps.connectionModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: 't1', projectId: 'p1', connectorName: 'slack', authProfileId: 'ap-1' },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({ scope: 'tenant', status: 'active' }),
          $set: expect.objectContaining({ displayName: 'Slack Dev' }),
        }),
        expect.objectContaining({ upsert: true, returnDocument: 'after' }),
      );
    });

    it('returns 400 for missing required fields', async () => {
      const res = await request(app)
        .post('/api/projects/p1/connections')
        .send({ connectorName: 'slack' });
      expect(res.status).toBe(400);
    });

    it('passes userId for user-scoped connections', async () => {
      const res = await request(app).post('/api/projects/p1/connections').send({
        connectorName: 'slack',
        displayName: 'My Slack',
        authProfileId: 'ap-2',
        scope: 'user',
      });
      expect(res.status).toBe(201);
      expect(deps.connectionModel.findOneAndUpdate).toHaveBeenCalledWith(
        { tenantId: 't1', projectId: 'p1', connectorName: 'slack', authProfileId: 'ap-2' },
        expect.objectContaining({
          $setOnInsert: expect.objectContaining({ scope: 'user', userId: 'user-1' }),
        }),
        expect.objectContaining({ upsert: true }),
      );
    });
  });

  describe('GET /connections/:connectionId', () => {
    it('returns connection detail', async () => {
      const res = await request(app).get('/api/projects/p1/connections/conn-1');
      expect(res.status).toBe(200);
      expect(res.body.data.displayName).toBe('Slack Production');
      expect(res.body.data.authProfileId).toBe('ap-1');
    });

    it('returns 404 for unknown connection', async () => {
      deps.connectionModel.findOne = vi
        .fn()
        .mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
      app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/connections/nonexistent');
      expect(res.status).toBe(404);
    });

    it('scopes lookup by tenant and project', async () => {
      await request(app).get('/api/projects/p1/connections/conn-1');
      expect(deps.connectionModel.findOne).toHaveBeenCalledWith({
        _id: 'conn-1',
        tenantId: 't1',
        projectId: 'p1',
      });
    });
  });

  describe('PUT /connections/:connectionId', () => {
    it('updates connection name', async () => {
      const res = await request(app)
        .put('/api/projects/p1/connections/conn-1')
        .send({ displayName: 'Updated Name' });
      expect(res.status).toBe(200);
      expect(deps.connectionModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'conn-1', tenantId: 't1', projectId: 'p1' },
        expect.objectContaining({
          $set: expect.objectContaining({ displayName: 'Updated Name' }),
        }),
        { returnDocument: 'after' },
      );
    });

    it('returns 404 when connection not found', async () => {
      deps.connectionModel.findOneAndUpdate = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/connections/nonexistent')
        .send({ name: 'Test' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /connections/:connectionId', () => {
    it('deletes a connection', async () => {
      const res = await request(app).delete('/api/projects/p1/connections/conn-1');
      expect(res.status).toBe(200);
      expect(deps.connectionModel.findOneAndDelete).toHaveBeenCalledWith({
        _id: 'conn-1',
        tenantId: 't1',
        projectId: 'p1',
      });
    });

    it('returns 404 when connection not found', async () => {
      deps.connectionModel.findOneAndDelete = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app).delete('/api/projects/p1/connections/nonexistent');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /connections/:connectionId/test', () => {
    it('tests a connection and returns result', async () => {
      const res = await request(app).post('/api/projects/p1/connections/conn-1/test');
      expect(res.status).toBe(200);
      expect(res.body.data.success).toBe(true);
    });

    it('updates status based on test result', async () => {
      await request(app).post('/api/projects/p1/connections/conn-1/test');
      expect(deps.connectionModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: 'conn-1', tenantId: 't1', projectId: 'p1' },
        expect.objectContaining({
          $set: expect.objectContaining({ status: 'active' }),
        }),
      );
    });

    it('returns 404 when connection not found', async () => {
      deps.connectionModel.findOne = vi
        .fn()
        .mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
      app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/connections/nonexistent/test');
      expect(res.status).toBe(404);
    });

    it('returns 502 when auth profile resolver not configured', async () => {
      const depsNoResolver = makeDeps({ authProfileResolver: undefined });
      const appNoResolver = createApp(depsNoResolver);
      const res = await request(appNoResolver).post('/api/projects/p1/connections/conn-1/test');
      expect(res.status).toBe(502);
      expect(res.body.error).toContain('Auth profile resolver not configured');
    });
  });

  // ─── missing-tenant 400 branches (detail/update/delete/test) ──────────────
  //
  // The tenantContext middleware is what gates access to these routes. Without
  // it, every handler must short-circuit with 400 BEFORE touching the model.
  describe('missing tenant context (400)', () => {
    it('GET /:connectionId returns 400', async () => {
      const appNoTenant = createApp(deps, { withTenant: false });
      const res = await request(appNoTenant).get('/api/projects/p1/connections/conn-1');
      expect(res.status).toBe(400);
      expect(deps.connectionModel.findOne).not.toHaveBeenCalled();
    });

    it('PUT /:connectionId returns 400', async () => {
      const appNoTenant = createApp(deps, { withTenant: false });
      const res = await request(appNoTenant)
        .put('/api/projects/p1/connections/conn-1')
        .send({ displayName: 'x' });
      expect(res.status).toBe(400);
      expect(deps.connectionModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('DELETE /:connectionId returns 400', async () => {
      const appNoTenant = createApp(deps, { withTenant: false });
      const res = await request(appNoTenant).delete('/api/projects/p1/connections/conn-1');
      expect(res.status).toBe(400);
      expect(deps.connectionModel.findOneAndDelete).not.toHaveBeenCalled();
    });

    it('POST /:connectionId/test returns 400', async () => {
      const appNoTenant = createApp(deps, { withTenant: false });
      const res = await request(appNoTenant).post('/api/projects/p1/connections/conn-1/test');
      expect(res.status).toBe(400);
    });
  });
});
