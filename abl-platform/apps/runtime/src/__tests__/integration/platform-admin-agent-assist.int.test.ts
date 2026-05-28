/**
 * Platform Admin Agentic Compat Binding Routes — Integration Tests
 *
 * Real MongoDB via MongoMemoryServer.
 * Tests CRUD via Express + supertest with DI repo (real Mongo adapter).
 * Verifies tenant isolation and unique index enforcement at the HTTP level.
 *
 * No vi.mock. Model injected via DI adapter.
 */

import supertest from 'supertest';
import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { LRUTTLCache } from '@agent-platform/shared-kernel';
import { createAgentAssistBindingRepo } from '../../repos/agent-assist-binding-repo.js';
import {
  setupMongoTestContext,
  type MongoTestContext,
} from '../helpers/agent-assist/mongo-model-adapter.js';
import { buildAdminCompatApp } from '../helpers/agent-assist/admin-compat-app-builder.js';

let ctx: MongoTestContext;

beforeAll(async () => {
  ctx = await setupMongoTestContext();
});

afterEach(async () => {
  await ctx.cleanup();
});

afterAll(async () => {
  await ctx.teardown();
});

function makeRepo() {
  return createAgentAssistBindingRepo({
    cache: new LRUTTLCache({ maxEntries: 100, ttlMs: 60_000 }),
    model: ctx.adapter,
  });
}

describe('platform-admin-agent-assist — integration (real Mongo)', () => {
  test('full CRUD lifecycle via HTTP', async () => {
    const app = buildAdminCompatApp(makeRepo());

    // Create
    const created = await supertest(app)
      .post('/tenants/T1/bindings')
      .send({ projectId: 'P1', appId: 'aa-int', environment: 'dev' });
    expect(created.status).toBe(201);
    expect(created.body.success).toBe(true);
    const id = created.body.data._id;
    expect(id).toBeDefined();
    expect(created.body.data.appId).toBe('aa-int');
    expect(created.body.data.environment).toBe('dev');

    // List
    const listed = await supertest(app).get('/tenants/T1/bindings');
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toHaveLength(1);
    expect(listed.body.data.pagination.total).toBe(1);

    // Get by ID
    const fetched = await supertest(app).get(`/tenants/T1/bindings/${id}`);
    expect(fetched.status).toBe(200);
    expect(fetched.body.data._id).toBe(id);

    // Update
    const updated = await supertest(app)
      .patch(`/tenants/T1/bindings/${id}`)
      .send({ displayName: 'Updated' });
    expect(updated.status).toBe(200);
    expect(updated.body.data.displayName).toBe('Updated');

    // Disable
    const disabled = await supertest(app).post(`/tenants/T1/bindings/${id}/disable`);
    expect(disabled.status).toBe(200);
    expect(disabled.body.data.status).toBe('disabled');

    // Enable
    const enabled = await supertest(app).post(`/tenants/T1/bindings/${id}/enable`);
    expect(enabled.status).toBe(200);
    expect(enabled.body.data.status).toBe('active');

    // Delete
    const deleted = await supertest(app).delete(`/tenants/T1/bindings/${id}`);
    expect(deleted.status).toBe(200);
    expect(deleted.body.data.deleted).toBe(true);

    // Verify deleted — get returns 404
    const after = await supertest(app).get(`/tenants/T1/bindings/${id}`);
    expect(after.status).toBe(404);
  });

  test('duplicate (tenantId, appId, environment) returns 409', async () => {
    const app = buildAdminCompatApp(makeRepo());

    const first = await supertest(app)
      .post('/tenants/T1/bindings')
      .send({ projectId: 'P1', appId: 'aa-dup', environment: 'staging' });
    expect(first.status).toBe(201);

    const second = await supertest(app)
      .post('/tenants/T1/bindings')
      .send({ projectId: 'P2', appId: 'aa-dup', environment: 'staging' });
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('BINDING_DUPLICATE');
  });

  test('tenant isolation — binding from tenant A not visible to tenant B', async () => {
    const app = buildAdminCompatApp(makeRepo());

    const created = await supertest(app)
      .post('/tenants/T1/bindings')
      .send({ projectId: 'P1', appId: 'aa-iso', environment: 'dev' });
    expect(created.status).toBe(201);
    const id = created.body.data._id;

    // List under T2 — should see nothing
    const listed = await supertest(app).get('/tenants/T2/bindings');
    expect(listed.status).toBe(200);
    expect(listed.body.data.items).toHaveLength(0);

    // Get by ID under T2 — should be 404
    const fetched = await supertest(app).get(`/tenants/T2/bindings/${id}`);
    expect(fetched.status).toBe(404);
  });

  test('update returns 404 for nonexistent binding', async () => {
    const app = buildAdminCompatApp(makeRepo());

    const res = await supertest(app)
      .patch('/tenants/T1/bindings/nonexistent-id')
      .send({ displayName: 'X' });
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BINDING_NOT_FOUND');
  });

  test('delete returns 404 for nonexistent binding', async () => {
    const app = buildAdminCompatApp(makeRepo());

    const res = await supertest(app).delete('/tenants/T1/bindings/nonexistent-id');
    expect(res.status).toBe(404);
    expect(res.body.error.code).toBe('BINDING_NOT_FOUND');
  });
});
