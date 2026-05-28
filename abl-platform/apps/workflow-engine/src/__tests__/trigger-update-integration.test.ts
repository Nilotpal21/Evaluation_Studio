/**
 * Trigger update — end-to-end route + engine integration
 *
 * Wires the real `TriggerEngine` (with in-memory model/scheduler/connector
 * deps) to the real `createTriggerRouter` and drives it via supertest. This
 * is the F-7 boundary test from the data-flow audit
 * (`docs/sdlc-logs/ABLP-155-trigger-edit/data-flow-audit.md`).
 *
 * It catches contract regressions that layer-isolated tests can't see:
 * - Route serialization preserves the engine's strict-mode validation errors.
 * - Audit emission survives the HTTP boundary unchanged.
 * - F-2: the connector engine sees only the typed named params, never the
 *   `callbackAccessToken` display value, even when piped through PUT.
 * - F-3: a connector-engine throw with a Bearer-shaped error message
 *   appears in the audit event as `Bearer [REDACTED]`, never as the raw
 *   token.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createTriggerRouter } from '../routes/triggers.js';
import {
  TriggerEngine,
  type TriggerAuditEvent,
  type TriggerEngineDeps,
} from '../services/trigger-engine.js';

interface MemTrigger {
  _id: string;
  workflowId: string;
  tenantId: string;
  projectId: string;
  triggerType: string;
  status: string;
  config: Record<string, unknown>;
}

function buildHarness(seed: MemTrigger) {
  const store = new Map<string, MemTrigger>([[seed._id, { ...seed }]]);
  const auditEvents: TriggerAuditEvent[] = [];
  const connectorCalls: Array<{
    kind: 'register' | 'deregister';
    input: Record<string, unknown>;
  }> = [];

  const triggerModel: TriggerEngineDeps['triggerModel'] = {
    create: vi.fn().mockResolvedValue({ _id: seed._id }),
    find: vi.fn().mockReturnValue({ lean: () => Promise.resolve([]) }),
    findOne: vi.fn(async (filter: Record<string, unknown>) => {
      const doc = store.get(filter._id as string);
      if (!doc || doc.tenantId !== filter.tenantId) return null;
      return { ...doc };
    }),
    findOneAndUpdate: vi.fn(
      async (filter: Record<string, unknown>, update: Record<string, unknown>) => {
        const doc = store.get(filter._id as string);
        if (!doc) return null;
        const next: MemTrigger = { ...doc };
        const $set = (update.$set ?? {}) as Record<string, unknown>;
        for (const [k, v] of Object.entries($set)) {
          if (k === 'config') next.config = v as Record<string, unknown>;
          else (next as unknown as Record<string, unknown>)[k] = v;
        }
        store.set(filter._id as string, next);
        return next;
      },
    ),
  };

  const workflowModel: TriggerEngineDeps['workflowModel'] = {
    findOne: vi.fn().mockResolvedValue({ _id: seed.workflowId, name: 'wf' }),
    findOneAndUpdate: vi.fn().mockResolvedValue({ _id: seed.workflowId }),
  };

  return {
    store,
    auditEvents,
    connectorCalls,
    engine: (overrides: Partial<TriggerEngineDeps> = {}) =>
      new TriggerEngine({
        triggerModel,
        workflowModel,
        restateClient: { startWorkflow: vi.fn().mockResolvedValue(undefined) },
        auditEmitter: (e) => {
          auditEvents.push(e);
        },
        ...overrides,
      }),
  };
}

function makeApp(triggerEngine: TriggerEngine): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantContext: { tenantId: string } }).tenantContext = {
      tenantId: 't1',
    };
    next();
  });
  app.use(
    '/api/projects/:projectId/triggers',
    createTriggerRouter({
      triggerEngine: triggerEngine as unknown as Parameters<
        typeof createTriggerRouter
      >[0]['triggerEngine'],
    }),
  );
  return app;
}

describe('PUT /triggers/:registrationId — end-to-end route + engine integration', () => {
  let h: ReturnType<typeof buildHarness>;

  beforeEach(() => {
    h = buildHarness({
      _id: 'reg-1',
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      triggerType: 'cron',
      status: 'active',
      config: { preset: 'daily', timezone: 'UTC', time: '09:00' },
    });
  });

  it('200 on valid update; audit success event survives the HTTP boundary', async () => {
    const app = makeApp(h.engine());
    const res = await request(app)
      .put('/api/projects/p1/triggers/reg-1')
      .send({ config: { preset: 'daily', timezone: 'UTC', time: '11:00' } });
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(h.auditEvents.at(-1)).toMatchObject({
      action: 'trigger.updated',
      outcome: 'success',
    });
  });

  it('400 VALIDATION_ERROR on invalid cron; no audit success emitted', async () => {
    const app = makeApp(h.engine());
    const res = await request(app)
      .put('/api/projects/p1/triggers/reg-1')
      .send({ config: { preset: 'cron', timezone: 'UTC', cronExpression: 'not-a-cron' } });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(h.auditEvents.find((e) => e.action === 'trigger.updated')).toBeUndefined();
  });

  it('F-2: connector engine receives only the narrow typed params, no `config` blob', async () => {
    // Seed as connector trigger so the connector branch fires on update.
    h = buildHarness({
      _id: 'reg-conn',
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      triggerType: 'webhook',
      status: 'active',
      config: {
        connectorName: 'gmail',
        triggerName: 'new_email',
        connectionId: 'conn-1',
        callbackUrl: 'https://customer/cb',
        callbackAccessToken: 'display-token-only',
      },
    });
    const connector: NonNullable<TriggerEngineDeps['connectorTriggerEngine']> = {
      registerTrigger: vi.fn(async (input) => {
        h.connectorCalls.push({
          kind: 'register',
          input: input as unknown as Record<string, unknown>,
        });
        return { triggerType: 'webhook' };
      }),
      deregisterTrigger: vi.fn(async (id: string) => {
        h.connectorCalls.push({ kind: 'deregister', input: { registrationId: id } });
      }),
    };
    const app = makeApp(h.engine({ connectorTriggerEngine: connector }));

    const res = await request(app)
      .put('/api/projects/p1/triggers/reg-conn')
      .send({
        config: {
          connectorName: 'gmail',
          triggerName: 'new_email',
          connectionId: 'conn-2',
          callbackAccessToken: 'still-do-not-forward',
        },
      });
    expect(res.status).toBe(200);

    const registerCall = h.connectorCalls.find((c) => c.kind === 'register');
    expect(registerCall).toBeDefined();
    // F-2 boundary contract: the wider config blob must never reach the
    // connector engine's register call, regardless of how the user shapes
    // their PUT body.
    expect((registerCall as { input: Record<string, unknown> }).input.config).toBeUndefined();
    const serialized = JSON.stringify(registerCall?.input);
    expect(serialized).not.toContain('display-token-only');
    expect(serialized).not.toContain('still-do-not-forward');
  });

  it('F-3: connector-engine error with Bearer-token message produces redacted audit', async () => {
    h = buildHarness({
      _id: 'reg-conn-2',
      workflowId: 'wf-1',
      tenantId: 't1',
      projectId: 'p1',
      triggerType: 'webhook',
      status: 'active',
      config: { connectorName: 'gmail', triggerName: 'new_email', connectionId: 'c1' },
    });
    const connector: NonNullable<TriggerEngineDeps['connectorTriggerEngine']> = {
      registerTrigger: vi
        .fn()
        .mockRejectedValue(
          new Error('gmail returned 401: Bearer leaked-bearer-from-upstream-error'),
        ),
      deregisterTrigger: vi.fn().mockResolvedValue(undefined),
    };
    const app = makeApp(h.engine({ connectorTriggerEngine: connector }));

    const res = await request(app)
      .put('/api/projects/p1/triggers/reg-conn-2')
      .send({
        config: { connectorName: 'gmail', triggerName: 'new_email', connectionId: 'c-new' },
      });
    // Engine surfaces the original throw — route maps the unknown error to 500.
    expect(res.status).toBe(500);

    const failed = h.auditEvents.find((e) => e.action === 'trigger.update_failed');
    expect(failed).toBeDefined();
    const serialized = JSON.stringify(failed?.metadata ?? {});
    // Boundary assertion: the upstream bearer literal is never persisted in
    // the audit event. The redaction MUST happen before the emit.
    expect(serialized).not.toContain('leaked-bearer-from-upstream-error');
    expect(serialized).toContain('Bearer [REDACTED]');
  });

  it('cross-tenant PUT returns 404 (isolation regression test)', async () => {
    const app = makeApp(h.engine());
    // Override the tenantContext to a different tenant — request should miss.
    const customApp = express();
    customApp.use(express.json());
    customApp.use((req, _res, next) => {
      (req as unknown as { tenantContext: { tenantId: string } }).tenantContext = {
        tenantId: 'other-tenant',
      };
      next();
    });
    customApp.use(
      '/api/projects/:projectId/triggers',
      createTriggerRouter({
        triggerEngine: h.engine() as unknown as Parameters<
          typeof createTriggerRouter
        >[0]['triggerEngine'],
      }),
    );

    const res = await request(customApp)
      .put('/api/projects/p1/triggers/reg-1')
      .send({ config: { preset: 'daily', timezone: 'UTC', time: '12:00' } });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('TRIGGER_NOT_FOUND');
  });
});
