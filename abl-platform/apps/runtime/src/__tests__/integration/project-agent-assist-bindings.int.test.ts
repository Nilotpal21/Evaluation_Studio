/**
 * Integration tests for project-scoped agentic compat binding routes.
 *
 * Uses a real MongoMemoryServer to verify end-to-end CRUD including
 * project isolation (a binding created under projectA MUST NOT appear
 * when listing projectB).
 */

import supertest from 'supertest';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createAgentAssistBindingRepo } from '../../repos/agent-assist-binding-repo.js';
import { buildProjectCompatApp } from '../helpers/agent-assist/project-compat-app-builder.js';
import {
  setupMongoTestContext,
  type MongoTestContext,
} from '../helpers/agent-assist/mongo-model-adapter.js';

let ctx: MongoTestContext;

beforeAll(async () => {
  ctx = await setupMongoTestContext();
}, 30_000);

afterEach(async () => {
  await ctx.cleanup();
});

afterAll(async () => {
  await ctx.teardown();
});

function buildApp(tenantId = 'T1') {
  const repo = createAgentAssistBindingRepo({ model: ctx.adapter });
  return buildProjectCompatApp(repo, { tenantId });
}

describe('project-agent-assist-bindings (integration)', () => {
  it('CRUD: create, get, list, update, disable, enable, delete', async () => {
    const app = buildApp();

    // Create
    const createRes = await supertest(app)
      .post('/projects/P1/bindings')
      .send({ appId: 'aa-int-1', environment: 'dev' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.success).toBe(true);
    const bindingId = createRes.body.data._id;
    expect(bindingId).toBeTruthy();
    expect(createRes.body.data.projectId).toBe('P1');
    expect(createRes.body.data.status).toBe('active');

    // Get
    const getRes = await supertest(app).get(`/projects/P1/bindings/${bindingId}`);
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.appId).toBe('aa-int-1');

    // List
    const listRes = await supertest(app).get('/projects/P1/bindings');
    expect(listRes.status).toBe(200);
    expect(listRes.body.data.items).toHaveLength(1);

    // Update
    const updateRes = await supertest(app)
      .patch(`/projects/P1/bindings/${bindingId}`)
      .send({ displayName: 'Integration Test' });
    expect(updateRes.status).toBe(200);
    expect(updateRes.body.data.displayName).toBe('Integration Test');

    // Disable
    const disableRes = await supertest(app).post(`/projects/P1/bindings/${bindingId}/disable`);
    expect(disableRes.status).toBe(200);
    expect(disableRes.body.data.status).toBe('disabled');

    // Enable
    const enableRes = await supertest(app).post(`/projects/P1/bindings/${bindingId}/enable`);
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.data.status).toBe('active');

    // Delete
    const deleteRes = await supertest(app).delete(`/projects/P1/bindings/${bindingId}`);
    expect(deleteRes.status).toBe(200);
    expect(deleteRes.body.data.deleted).toBe(true);

    // Verify deleted
    const getDeletedRes = await supertest(app).get(`/projects/P1/bindings/${bindingId}`);
    expect(getDeletedRes.status).toBe(404);
  });

  it('project isolation: projectA binding not visible to projectB', async () => {
    const app = buildApp();

    // Create binding under P1
    const createRes = await supertest(app)
      .post('/projects/P1/bindings')
      .send({ appId: 'aa-isolated', environment: 'prod' });
    expect(createRes.status).toBe(201);
    const bindingId = createRes.body.data._id;

    // List under P1 — should see it
    const listP1 = await supertest(app).get('/projects/P1/bindings');
    expect(listP1.body.data.items).toHaveLength(1);

    // List under P2 — should NOT see it
    const listP2 = await supertest(app).get('/projects/P2/bindings');
    expect(listP2.body.data.items).toHaveLength(0);

    // Get under P2 — should return 404
    const getP2 = await supertest(app).get(`/projects/P2/bindings/${bindingId}`);
    expect(getP2.status).toBe(404);

    // Disable under P2 — should return 404
    const disableP2 = await supertest(app).post(`/projects/P2/bindings/${bindingId}/disable`);
    expect(disableP2.status).toBe(404);

    // Delete under P2 — should return 404
    const deleteP2 = await supertest(app).delete(`/projects/P2/bindings/${bindingId}`);
    expect(deleteP2.status).toBe(404);
  });

  it('duplicate binding returns 409', async () => {
    const app = buildApp();

    await supertest(app)
      .post('/projects/P1/bindings')
      .send({ appId: 'aa-dup', environment: 'dev' });

    const dupRes = await supertest(app)
      .post('/projects/P1/bindings')
      .send({ appId: 'aa-dup', environment: 'dev' });

    expect(dupRes.status).toBe(409);
    expect(dupRes.body.error.code).toBe('BINDING_DUPLICATE');
  });

  it('status toggle via PATCH updates status correctly', async () => {
    const app = buildApp();

    const createRes = await supertest(app)
      .post('/projects/P1/bindings')
      .send({ appId: 'aa-toggle', environment: 'stg' });
    const bindingId = createRes.body.data._id;

    // Disable via PATCH
    const patchRes = await supertest(app)
      .patch(`/projects/P1/bindings/${bindingId}`)
      .send({ status: 'disabled' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.status).toBe('disabled');

    // Re-enable via PATCH
    const enableRes = await supertest(app)
      .patch(`/projects/P1/bindings/${bindingId}`)
      .send({ status: 'active' });
    expect(enableRes.status).toBe(200);
    expect(enableRes.body.data.status).toBe('active');
  });

  it('environment is normalized to lowercase', async () => {
    const app = buildApp();

    const createRes = await supertest(app)
      .post('/projects/P1/bindings')
      .send({ appId: 'aa-case', environment: 'PROD' });

    expect(createRes.status).toBe(201);
    expect(createRes.body.data.environment).toBe('prod');
  });
});
