/**
 * Unit tests for the trigger HTTP routes.
 *
 * The router delegates every call to the injected TriggerEngine, so these
 * tests fake the engine and verify:
 *   - HTTP status + envelope shape for happy paths
 *   - 400 guards on missing tenant/project context
 *   - Zod validation failures on POST /
 *   - 404 vs 500 routing on fire-trigger errors
 *   - Error propagation (500 envelope) when the engine throws
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTriggerRouter, type TriggerRouteDeps } from '../routes/triggers.js';

function makeDeps(overrides: Partial<TriggerRouteDeps['triggerEngine']> = {}): TriggerRouteDeps {
  return {
    triggerEngine: {
      list: vi.fn().mockResolvedValue([
        { _id: 'reg-1', triggerType: 'webhook', status: 'active' },
        { _id: 'reg-2', triggerType: 'cron', status: 'active' },
      ]),
      register: vi.fn().mockResolvedValue({ registrationId: 'reg-new' }),
      updateTrigger: vi.fn().mockResolvedValue(undefined),
      deregister: vi.fn().mockResolvedValue(undefined),
      pause: vi.fn().mockResolvedValue(undefined),
      resume: vi.fn().mockResolvedValue(undefined),
      fireWebhookTrigger: vi.fn().mockResolvedValue({ executionId: 'exec-123' }),
      getLastFirePayload: vi.fn().mockResolvedValue({ foo: 'bar' }),
      ...overrides,
    },
  };
}

function createApp(deps: TriggerRouteDeps, options: { withTenant?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  if (options.withTenant !== false) {
    app.use((req: any, _res, next) => {
      req.tenantContext = { tenantId: 't1', userId: 'user-1' };
      next();
    });
  }
  app.use('/api/projects/:projectId/triggers', createTriggerRouter(deps));
  return app;
}

describe('Trigger Routes', () => {
  let deps: TriggerRouteDeps;

  beforeEach(() => {
    deps = makeDeps();
  });

  // ─── GET / ──────────────────────────────────────────────────────────────

  describe('GET /triggers', () => {
    it('lists registrations scoped by tenant + project', async () => {
      const app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/triggers');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toHaveLength(2);
      expect(deps.triggerEngine.list).toHaveBeenCalledWith('t1', 'p1', undefined);
    });

    it('forwards workflowId query param to the engine', async () => {
      const app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/triggers?workflowId=wf-9');
      expect(res.status).toBe(200);
      expect(deps.triggerEngine.list).toHaveBeenCalledWith('t1', 'p1', 'wf-9');
    });

    it('returns 400 when tenant context missing', async () => {
      const app = createApp(deps, { withTenant: false });
      const res = await request(app).get('/api/projects/p1/triggers');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 500 envelope when engine throws', async () => {
      deps = makeDeps({ list: vi.fn().mockRejectedValue(new Error('db offline')) });
      const app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/triggers');
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
    });
  });

  // ─── POST / ─────────────────────────────────────────────────────────────

  describe('POST /triggers', () => {
    it('registers a webhook trigger and returns 201', async () => {
      const app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/triggers')
        .send({
          workflowId: 'wf-1',
          triggerType: 'webhook',
          config: { path: '/incoming' },
        });
      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.registrationId).toBe('reg-new');
      expect(deps.triggerEngine.register).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 't1',
          projectId: 'p1',
          workflowId: 'wf-1',
          triggerType: 'webhook',
          config: { path: '/incoming' },
        }),
      );
    });

    it('defaults config to empty object', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers').send({
        workflowId: 'wf-1',
        triggerType: 'cron',
      });
      expect(res.status).toBe(201);
      expect(deps.triggerEngine.register).toHaveBeenCalledWith(
        expect.objectContaining({ config: {} }),
      );
    });

    it('passes optional environment through when provided', async () => {
      const app = createApp(deps);
      await request(app).post('/api/projects/p1/triggers').send({
        workflowId: 'wf-1',
        triggerType: 'event',
        environment: 'staging',
      });
      expect(deps.triggerEngine.register).toHaveBeenCalledWith(
        expect.objectContaining({ environment: 'staging' }),
      );
    });

    it('returns 400 VALIDATION_ERROR when triggerType invalid', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers').send({
        workflowId: 'wf-1',
        triggerType: 'ftp',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(deps.triggerEngine.register).not.toHaveBeenCalled();
    });

    it('returns 400 VALIDATION_ERROR when workflowId missing', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers').send({
        triggerType: 'webhook',
      });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });

    it('returns 400 when tenant context missing', async () => {
      const app = createApp(deps, { withTenant: false });
      const res = await request(app).post('/api/projects/p1/triggers').send({
        workflowId: 'wf-1',
        triggerType: 'webhook',
      });
      expect(res.status).toBe(400);
    });

    it('returns 500 when engine register rejects', async () => {
      deps = makeDeps({ register: vi.fn().mockRejectedValue(new Error('boom')) });
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers').send({
        workflowId: 'wf-1',
        triggerType: 'webhook',
      });
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('INTERNAL_ERROR');
    });
  });

  // ─── DELETE /:registrationId ────────────────────────────────────────────

  describe('PUT /triggers/:registrationId', () => {
    it('updates a cron trigger and returns 200', async () => {
      const app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/triggers/reg-1')
        .send({ config: { preset: 'daily', timezone: 'UTC', time: '09:00' } });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(deps.triggerEngine.updateTrigger).toHaveBeenCalledWith(
        'reg-1',
        { preset: 'daily', timezone: 'UTC', time: '09:00' },
        't1',
        'p1',
      );
    });

    it('accepts once preset config and returns 200', async () => {
      const app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/triggers/reg-1')
        .send({
          config: {
            preset: 'once',
            timezone: 'America/New_York',
            datetime: '2026-07-16T02:02',
          },
        });
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(deps.triggerEngine.updateTrigger).toHaveBeenCalledWith(
        'reg-1',
        { preset: 'once', timezone: 'America/New_York', datetime: '2026-07-16T02:02' },
        't1',
        'p1',
      );
    });

    it('returns 400 VALIDATION_ERROR when body invalid', async () => {
      const app = createApp(deps);
      const res = await request(app).put('/api/projects/p1/triggers/reg-1').send({});
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(deps.triggerEngine.updateTrigger).not.toHaveBeenCalled();
    });

    it('returns 400 when tenant context missing', async () => {
      const app = createApp(deps, { withTenant: false });
      const res = await request(app)
        .put('/api/projects/p1/triggers/reg-1')
        .send({ config: { preset: 'cron', timezone: 'UTC', cronExpression: '* * * * *' } });
      expect(res.status).toBe(400);
      expect(deps.triggerEngine.updateTrigger).not.toHaveBeenCalled();
    });

    it('returns 404 TRIGGER_NOT_FOUND when engine reports not found', async () => {
      deps = makeDeps({
        updateTrigger: vi.fn().mockRejectedValue(new Error('Trigger not found')),
      });
      const app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/triggers/reg-1')
        .send({ config: { preset: 'daily', timezone: 'UTC' } });
      expect(res.status).toBe(404);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('TRIGGER_NOT_FOUND');
    });

    it('returns 500 TRIGGER_UPDATE_FAILED when engine throws', async () => {
      deps = makeDeps({
        updateTrigger: vi.fn().mockRejectedValue(new Error('db down')),
      });
      const app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/triggers/reg-1')
        .send({ config: { preset: 'daily', timezone: 'UTC' } });
      expect(res.status).toBe(500);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('TRIGGER_UPDATE_FAILED');
    });

    it('returns 503 CONNECTOR_RUNTIME_UNAVAILABLE when engine reports connector runtime unavailable', async () => {
      deps = makeDeps({
        updateTrigger: vi.fn().mockRejectedValue(new Error('CONNECTOR_RUNTIME_UNAVAILABLE')),
      });
      const app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/triggers/reg-1')
        .send({ config: { connectorName: 'gmail', triggerName: 'new_email', connectionId: 'c1' } });
      expect(res.status).toBe(503);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('CONNECTOR_RUNTIME_UNAVAILABLE');
    });

    it('returns 400 VALIDATION_ERROR with the engine message when preset/time parsing fails', async () => {
      deps = makeDeps({
        updateTrigger: vi
          .fn()
          .mockRejectedValue(new Error('Invalid time format: 25:99. Expected HH:MM')),
      });
      const app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/triggers/reg-1')
        .send({ config: { preset: 'daily', timezone: 'UTC', time: '25:99' } });
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(res.body.error.message).toContain('Invalid time format');
    });

    it('returns 400 VALIDATION_ERROR when cronExpression cannot be parsed', async () => {
      deps = makeDeps({
        updateTrigger: vi.fn().mockRejectedValue(new Error('Invalid cron expression: not-a-cron.')),
      });
      const app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/triggers/reg-1')
        .send({ config: { preset: 'cron', timezone: 'UTC', cronExpression: 'not-a-cron' } });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  describe('DELETE /triggers/:registrationId', () => {
    it('deregisters the trigger', async () => {
      const app = createApp(deps);
      const res = await request(app).delete('/api/projects/p1/triggers/reg-1');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(deps.triggerEngine.deregister).toHaveBeenCalledWith('reg-1', 't1', 'p1');
    });

    it('returns 400 when tenant context missing', async () => {
      const app = createApp(deps, { withTenant: false });
      const res = await request(app).delete('/api/projects/p1/triggers/reg-1');
      expect(res.status).toBe(400);
    });

    it('returns 500 when engine throws', async () => {
      deps = makeDeps({ deregister: vi.fn().mockRejectedValue(new Error('kaboom')) });
      const app = createApp(deps);
      const res = await request(app).delete('/api/projects/p1/triggers/reg-1');
      expect(res.status).toBe(500);
    });
  });

  // ─── POST /:registrationId/pause ────────────────────────────────────────

  describe('POST /triggers/:registrationId/pause', () => {
    it('pauses the trigger', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/pause');
      expect(res.status).toBe(200);
      expect(deps.triggerEngine.pause).toHaveBeenCalledWith('reg-1', 't1', 'p1');
    });

    it('returns 400 when tenant context missing', async () => {
      const app = createApp(deps, { withTenant: false });
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/pause');
      expect(res.status).toBe(400);
    });

    it('returns 500 when engine throws', async () => {
      deps = makeDeps({ pause: vi.fn().mockRejectedValue(new Error('engine down')) });
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/pause');
      expect(res.status).toBe(500);
    });
  });

  // ─── POST /:registrationId/resume ───────────────────────────────────────

  describe('POST /triggers/:registrationId/resume', () => {
    it('resumes the trigger', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/resume');
      expect(res.status).toBe(200);
      expect(deps.triggerEngine.resume).toHaveBeenCalledWith('reg-1', 't1', 'p1');
    });

    it('returns 400 when tenant context missing', async () => {
      const app = createApp(deps, { withTenant: false });
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/resume');
      expect(res.status).toBe(400);
    });

    it('returns 500 when engine throws', async () => {
      deps = makeDeps({ resume: vi.fn().mockRejectedValue(new Error('engine down')) });
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/resume');
      expect(res.status).toBe(500);
    });
  });

  // ─── POST /:registrationId/fire ─────────────────────────────────────────

  describe('POST /triggers/:registrationId/fire', () => {
    it('fires a webhook trigger and returns 202 + executionId', async () => {
      const app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/triggers/reg-1/fire')
        .send({ key: 'value' });
      expect(res.status).toBe(202);
      expect(res.body.success).toBe(true);
      expect(res.body.data.executionId).toBe('exec-123');
      expect(deps.triggerEngine.fireWebhookTrigger).toHaveBeenCalledWith(
        'reg-1',
        { key: 'value' },
        't1',
        'p1',
      );
    });

    it('defaults the payload to {} when body is empty', async () => {
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/fire').send({});
      expect(res.status).toBe(202);
      expect(deps.triggerEngine.fireWebhookTrigger).toHaveBeenCalledWith('reg-1', {}, 't1', 'p1');
    });

    it('returns 400 VALIDATION_ERROR when payload is not an object', async () => {
      const app = createApp(deps);
      const res = await request(app)
        .post('/api/projects/p1/triggers/reg-1/fire')
        .set('Content-Type', 'application/json')
        .send(JSON.stringify(['arr', 'not', 'obj']));
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
      expect(deps.triggerEngine.fireWebhookTrigger).not.toHaveBeenCalled();
    });

    it('returns 400 when tenant context missing', async () => {
      const app = createApp(deps, { withTenant: false });
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/fire').send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 TRIGGER_FIRE_FAILED when engine reports not found', async () => {
      deps = makeDeps({
        fireWebhookTrigger: vi.fn().mockRejectedValue(new Error('Registration reg-1 not found')),
      });
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/fire').send({});
      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('TRIGGER_FIRE_FAILED');
      expect(res.body.error.message).toBe('Trigger not found');
    });

    it('returns 500 TRIGGER_FIRE_FAILED for other errors', async () => {
      deps = makeDeps({
        fireWebhookTrigger: vi.fn().mockRejectedValue(new Error('restate upstream 503')),
      });
      const app = createApp(deps);
      const res = await request(app).post('/api/projects/p1/triggers/reg-1/fire').send({});
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('TRIGGER_FIRE_FAILED');
      expect(res.body.error.message).toBe('Failed to fire trigger');
    });
  });

  // ─── GET /:registrationId/sample-payload ────────────────────────────────

  describe('GET /triggers/:registrationId/sample-payload', () => {
    it('returns the last fired payload wrapped in the data envelope', async () => {
      const app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/triggers/reg-1/sample-payload');
      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data).toEqual({ payload: { foo: 'bar' } });
      expect(deps.triggerEngine.getLastFirePayload).toHaveBeenCalledWith('reg-1', 't1', 'p1');
    });

    it('returns { payload: null } when the trigger has no history', async () => {
      deps = makeDeps({ getLastFirePayload: vi.fn().mockResolvedValue(null) });
      const app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/triggers/reg-1/sample-payload');
      expect(res.status).toBe(200);
      expect(res.body.data).toEqual({ payload: null });
    });

    it('returns 400 when tenant context missing', async () => {
      const app = createApp(deps, { withTenant: false });
      const res = await request(app).get('/api/projects/p1/triggers/reg-1/sample-payload');
      expect(res.status).toBe(400);
      expect(res.body.success).toBe(false);
    });

    it('returns 500 SAMPLE_PAYLOAD_LOOKUP_FAILED when the engine throws', async () => {
      deps = makeDeps({
        getLastFirePayload: vi.fn().mockRejectedValue(new Error('mongo down')),
      });
      const app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/triggers/reg-1/sample-payload');
      expect(res.status).toBe(500);
      expect(res.body.error.code).toBe('SAMPLE_PAYLOAD_LOOKUP_FAILED');
    });
  });
});
