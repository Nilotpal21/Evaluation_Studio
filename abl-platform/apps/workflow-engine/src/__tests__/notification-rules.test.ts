import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import {
  createNotificationRuleRouter,
  type NotificationRuleDeps,
  type NotificationRule,
} from '../routes/notification-rules.js';

function makeWorkflow(rules: NotificationRule[] = []) {
  return {
    _id: 'wf-1',
    tenantId: 't1',
    projectId: 'p1',
    notificationRules: rules,
  };
}

function makeRule(overrides: Partial<NotificationRule> = {}): NotificationRule {
  return {
    _id: 'rule-1',
    name: 'Notify on failure',
    events: ['workflow.failed'],
    channel: { type: 'slack' as const, connectionId: 'conn-1', target: '#alerts' },
    enabled: true,
    ...overrides,
  };
}

function makeDeps(overrides: Partial<NotificationRuleDeps> = {}): NotificationRuleDeps {
  return {
    workflowModel: {
      findOne: vi.fn().mockResolvedValue(makeWorkflow([makeRule()])),
      findOneAndUpdate: vi.fn().mockResolvedValue(makeWorkflow([makeRule()])),
    },
    dispatcher: {
      sendTest: vi.fn().mockResolvedValue({ sent: true }),
    },
    ...overrides,
  };
}

function createApp(deps: NotificationRuleDeps, opts: { withTenant?: boolean } = {}) {
  const app = express();
  app.use(express.json());
  if (opts.withTenant !== false) {
    app.use((req: any, _res, next) => {
      req.tenantContext = { tenantId: 't1', userId: 'user-1' };
      next();
    });
  }
  app.use(
    '/api/projects/:projectId/workflows/:workflowId/notifications',
    createNotificationRuleRouter(deps),
  );
  return app;
}

describe('Notification Rule Routes', () => {
  let deps: NotificationRuleDeps;
  let app: express.Express;

  beforeEach(() => {
    deps = makeDeps();
    app = createApp(deps);
  });

  describe('GET /notifications', () => {
    it('lists notification rules for a workflow', async () => {
      const res = await request(app).get('/api/projects/p1/workflows/wf-1/notifications');
      expect(res.status).toBe(200);
      expect(res.body.data).toHaveLength(1);
      expect(res.body.data[0].name).toBe('Notify on failure');
    });

    it('returns 404 when workflow not found', async () => {
      deps.workflowModel.findOne = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app).get('/api/projects/p1/workflows/wf-1/notifications');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /notifications', () => {
    it('creates a notification rule', async () => {
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/notifications')
        .send({
          name: 'Alert on complete',
          events: ['workflow.completed'],
          channel: { type: 'slack', connectionId: 'conn-1', target: '#general' },
        });
      expect(res.status).toBe(201);
      expect(res.body.data.name).toBe('Alert on complete');
      expect(res.body.data._id).toBeDefined();
    });

    it('returns 400 for missing name', async () => {
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/notifications')
        .send({
          events: ['workflow.completed'],
          channel: { type: 'slack', connectionId: 'c', target: '#t' },
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid events', async () => {
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/notifications')
        .send({
          name: 'Test',
          events: ['invalid.event'],
          channel: { type: 'slack', connectionId: 'c', target: '#t' },
        });
      expect(res.status).toBe(400);
      expect(res.body.error).toContain('Invalid events');
    });

    it('returns 400 for empty events array', async () => {
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/notifications')
        .send({
          name: 'Test',
          events: [],
          channel: { type: 'slack', connectionId: 'c', target: '#t' },
        });
      expect(res.status).toBe(400);
    });

    it('returns 400 for invalid channel type', async () => {
      const res = await request(app)
        .post('/api/projects/p1/workflows/wf-1/notifications')
        .send({
          name: 'Test',
          events: ['workflow.completed'],
          channel: { type: 'invalid', connectionId: 'c', target: '#t' },
        });
      expect(res.status).toBe(400);
    });
  });

  describe('PUT /notifications/:ruleId', () => {
    it('updates a notification rule', async () => {
      const res = await request(app)
        .put('/api/projects/p1/workflows/wf-1/notifications/rule-1')
        .send({ name: 'Updated name', enabled: false });
      expect(res.status).toBe(200);
      expect(deps.workflowModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ 'notificationRules._id': 'rule-1' }),
        expect.objectContaining({
          $set: expect.objectContaining({
            'notificationRules.$.name': 'Updated name',
            'notificationRules.$.enabled': false,
          }),
        }),
        { new: true },
      );
    });

    it('returns 400 when no fields provided', async () => {
      const res = await request(app)
        .put('/api/projects/p1/workflows/wf-1/notifications/rule-1')
        .send({});
      expect(res.status).toBe(400);
    });

    it('returns 404 when rule not found', async () => {
      deps.workflowModel.findOneAndUpdate = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app)
        .put('/api/projects/p1/workflows/wf-1/notifications/nonexistent')
        .send({ name: 'New name' });
      expect(res.status).toBe(404);
    });
  });

  describe('DELETE /notifications/:ruleId', () => {
    it('deletes a notification rule', async () => {
      const res = await request(app).delete('/api/projects/p1/workflows/wf-1/notifications/rule-1');
      expect(res.status).toBe(200);
      expect(deps.workflowModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'wf-1', tenantId: 't1', projectId: 'p1' }),
        { $pull: { notificationRules: { _id: 'rule-1' } } },
        { new: true },
      );
    });

    it('returns 400 when tenant context is missing', async () => {
      const appNoTenant = createApp(deps, { withTenant: false });
      const res = await request(appNoTenant).delete(
        '/api/projects/p1/workflows/wf-1/notifications/rule-1',
      );
      expect(res.status).toBe(400);
      expect(deps.workflowModel.findOneAndUpdate).not.toHaveBeenCalled();
    });

    it('returns 404 when workflow not found', async () => {
      deps.workflowModel.findOneAndUpdate = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app).delete('/api/projects/p1/workflows/wf-1/notifications/rule-1');
      expect(res.status).toBe(404);
    });
  });

  describe('POST /notifications/:ruleId/test', () => {
    it('sends a test notification', async () => {
      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/notifications/rule-1/test',
      );
      expect(res.status).toBe(200);
      expect(res.body.sent).toBe(true);
      expect(deps.dispatcher.sendTest).toHaveBeenCalledWith(
        expect.objectContaining({ _id: 'rule-1' }),
        't1',
      );
    });

    it('returns 404 when rule not found', async () => {
      deps.workflowModel.findOne = vi.fn().mockResolvedValue(makeWorkflow([]));
      app = createApp(deps);
      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/notifications/nonexistent/test',
      );
      expect(res.status).toBe(404);
    });

    it('returns 502 when notification delivery fails', async () => {
      deps.dispatcher.sendTest = vi.fn().mockRejectedValue(new Error('Slack API error'));
      app = createApp(deps);
      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/notifications/rule-1/test',
      );
      expect(res.status).toBe(502);
      expect(res.body.error).toContain('Slack API error');
    });

    it('returns 400 when tenant context is missing', async () => {
      const appNoTenant = createApp(deps, { withTenant: false });
      const res = await request(appNoTenant).post(
        '/api/projects/p1/workflows/wf-1/notifications/rule-1/test',
      );
      expect(res.status).toBe(400);
      expect(deps.dispatcher.sendTest).not.toHaveBeenCalled();
    });

    it('returns 404 when workflow not found', async () => {
      deps.workflowModel.findOne = vi.fn().mockResolvedValue(null);
      app = createApp(deps);
      const res = await request(app).post(
        '/api/projects/p1/workflows/wf-1/notifications/rule-1/test',
      );
      expect(res.status).toBe(404);
      expect(res.body.error).toMatch(/workflow not found/i);
    });
  });
});
