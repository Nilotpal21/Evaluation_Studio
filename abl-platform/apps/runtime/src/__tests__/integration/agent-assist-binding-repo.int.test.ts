/**
 * Agentic Compat Binding Repo — Integration Tests
 *
 * Real MongoDB via MongoMemoryServer (setup helper).
 * Verifies: tenant isolation, unique index, CRUD lifecycle, cascade.
 * No vi.mock. Model injected via DI adapter.
 */

import { describe, test, expect, beforeAll, afterEach, afterAll } from 'vitest';
import { LRUTTLCache } from '@agent-platform/shared-kernel';
import { createAgentAssistBindingRepo } from '../../repos/agent-assist-binding-repo.js';
import {
  setupMongoTestContext,
  type MongoTestContext,
} from '../helpers/agent-assist/mongo-model-adapter.js';

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

function createRepo() {
  return createAgentAssistBindingRepo({
    cache: new LRUTTLCache({ maxEntries: 100, ttlMs: 60_000 }),
    model: ctx.adapter,
  });
}

describe('AgentAssistBindingRepo — integration (real Mongo)', () => {
  test('unique index (tenantId, appId, environment) is present', async () => {
    const indexes = await ctx.model.collection.indexes();
    const uniqueIndex = indexes.find(
      (idx: any) =>
        idx.unique === true &&
        idx.key?.tenantId === 1 &&
        idx.key?.appId === 1 &&
        idx.key?.environment === 1,
    );
    expect(uniqueIndex).toBeDefined();
  });

  test('CRUD lifecycle', async () => {
    const repo = createRepo();
    const actorCtx = { tenantId: 'tenant-int-1', actor: 'user-int-1' };

    // Create
    const created = await repo.create(actorCtx, {
      projectId: 'proj-1',
      appId: 'aa-int-test',
      environment: 'Production',
      displayName: 'Integration Test',
    });
    expect(created.tenantId).toBe('tenant-int-1');
    expect(created.appId).toBe('aa-int-test');
    expect(created.environment).toBe('production');
    expect(created.status).toBe('active');
    expect(created.displayName).toBe('Integration Test');
    expect(created.createdBy).toBe('user-int-1');

    // Get
    const fetched = await repo.get(
      { tenantId: 'tenant-int-1' },
      { appId: 'aa-int-test', environment: 'production' },
    );
    expect(fetched).toBeTruthy();
    expect(fetched!._id).toBe(created._id);

    // findByIdForTenant
    const byId = await repo['findByIdForTenant']({ tenantId: 'tenant-int-1' }, created._id);
    expect(byId).toBeTruthy();
    expect(byId!.appId).toBe('aa-int-test');

    // Update
    const updated = await repo.update(actorCtx, created._id, {
      displayName: 'Updated Name',
    });
    expect(updated.displayName).toBe('Updated Name');
    expect(updated.updatedBy).toBe('user-int-1');

    // List
    const list = await repo.list({ tenantId: 'tenant-int-1' }, { offset: 0, limit: 10 });
    expect(list.total).toBe(1);
    expect(list.items).toHaveLength(1);

    // SetStatus disabled
    const disabled = await repo.setStatus(actorCtx, created._id, 'disabled');
    expect(disabled.status).toBe('disabled');
    expect(disabled.disabledAt).toBeTruthy();
    expect(disabled.disabledBy).toBe('user-int-1');

    // SetStatus re-enabled
    const reEnabled = await repo.setStatus(actorCtx, created._id, 'active');
    expect(reEnabled.status).toBe('active');
    expect(reEnabled.disabledAt).toBeNull();
    expect(reEnabled.disabledBy).toBeNull();

    // Remove (hard delete)
    await repo.remove(actorCtx, created._id);
    const afterDelete = await repo['findByIdForTenant']({ tenantId: 'tenant-int-1' }, created._id);
    expect(afterDelete).toBeNull();
  });

  test('duplicate appId + environment within same tenant is rejected', async () => {
    const repo = createRepo();
    const actorCtx = { tenantId: 'tenant-dup', actor: 'user-1' };

    await repo.create(actorCtx, {
      projectId: 'proj-1',
      appId: 'aa-dup',
      environment: 'dev',
    });

    await expect(
      repo.create(actorCtx, {
        projectId: 'proj-2',
        appId: 'aa-dup',
        environment: 'dev',
      }),
    ).rejects.toThrow(/duplicate|already exists/i);
  });

  test('same appId + environment in different tenants is allowed', async () => {
    const repo = createRepo();

    await repo.create(
      { tenantId: 'tenant-A', actor: 'user-1' },
      { projectId: 'proj-1', appId: 'aa-shared', environment: 'prod' },
    );

    const second = await repo.create(
      { tenantId: 'tenant-B', actor: 'user-2' },
      { projectId: 'proj-2', appId: 'aa-shared', environment: 'prod' },
    );

    expect(second.tenantId).toBe('tenant-B');
  });

  test('cross-tenant get() returns null (tenant isolation)', async () => {
    const repo = createRepo();

    await repo.create(
      { tenantId: 'tenant-iso-1', actor: 'user-1' },
      { projectId: 'proj-1', appId: 'aa-iso', environment: 'prod' },
    );

    const result = await repo.get(
      { tenantId: 'tenant-iso-2' },
      { appId: 'aa-iso', environment: 'prod' },
    );
    expect(result).toBeNull();
  });

  test('cross-tenant findByIdForTenant() returns null', async () => {
    const repo = createRepo();

    const created = await repo.create(
      { tenantId: 'tenant-cross-1', actor: 'user-1' },
      { projectId: 'proj-1', appId: 'aa-cross', environment: 'prod' },
    );

    const result = await repo['findByIdForTenant']({ tenantId: 'tenant-cross-2' }, created._id);
    expect(result).toBeNull();
  });

  test('cross-tenant list() returns empty', async () => {
    const repo = createRepo();

    await repo.create(
      { tenantId: 'tenant-list-1', actor: 'user-1' },
      { projectId: 'proj-1', appId: 'aa-list', environment: 'prod' },
    );

    const result = await repo.list({ tenantId: 'tenant-list-2' }, { offset: 0, limit: 10 });
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
  });

  test('cascadeOnProjectDelete removes all bindings for project', async () => {
    const repo = createRepo();
    const actorCtx = { tenantId: 'tenant-cascade', actor: 'user-1' };

    await repo.create(actorCtx, { projectId: 'proj-del', appId: 'aa-c1', environment: 'prod' });
    await repo.create(actorCtx, { projectId: 'proj-del', appId: 'aa-c2', environment: 'prod' });
    await repo.create(actorCtx, {
      projectId: 'proj-keep',
      appId: 'aa-c3',
      environment: 'prod',
    });

    const deleted = await repo.cascadeOnProjectDelete('tenant-cascade', 'proj-del');
    expect(deleted).toBe(2);

    const remaining = await repo.list({ tenantId: 'tenant-cascade' }, { offset: 0, limit: 10 });
    expect(remaining.total).toBe(1);
    expect(remaining.items[0].projectId).toBe('proj-keep');
  });

  test('environment is case-insensitive (normalized to lowercase)', async () => {
    const repo = createRepo();
    const actorCtx = { tenantId: 'tenant-case', actor: 'user-1' };

    const created = await repo.create(actorCtx, {
      projectId: 'proj-1',
      appId: 'aa-case',
      environment: 'PRODUCTION',
    });
    expect(created.environment).toBe('production');

    const fetched = await repo.get(
      { tenantId: 'tenant-case' },
      { appId: 'aa-case', environment: 'Production' },
    );
    expect(fetched).toBeTruthy();
    expect(fetched!._id).toBe(created._id);
  });

  test('get() returns disabled bindings so callers can enforce status-aware policy', async () => {
    const repo = createRepo();
    const actorCtx = { tenantId: 'tenant-status', actor: 'user-1' };

    const created = await repo.create(actorCtx, {
      projectId: 'proj-1',
      appId: 'aa-status',
      environment: 'prod',
    });

    await repo.setStatus(actorCtx, created._id, 'disabled');

    const result = await repo.get(
      { tenantId: 'tenant-status' },
      { appId: 'aa-status', environment: 'prod' },
    );
    expect(result).toBeTruthy();
    expect(result?.status).toBe('disabled');
    expect(result?.disabledAt).toBeTruthy();
  });
});
