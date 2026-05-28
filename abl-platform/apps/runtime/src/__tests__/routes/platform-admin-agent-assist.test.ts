/**
 * Unit tests for Platform Admin — Agentic Compat Binding Routes
 *
 * Uses DI to inject a fake repo and bypass auth middleware.
 * No vi.mock — only dependency injection via the shared app builder.
 */

import supertest from 'supertest';
import { describe, expect, it } from 'vitest';
import type { IAgentAssistBinding } from '@agent-platform/database/models';
import {
  type AgentAssistBindingResolver,
  AgentAssistBindingDuplicateError,
  AgentAssistBindingNotFoundError,
} from '../../repos/agent-assist-binding-repo.js';
import { buildAdminCompatApp } from '../helpers/agent-assist/admin-compat-app-builder.js';
import { createInMemoryApiKeyStore } from '../helpers/agent-assist/project-compat-app-builder.js';

// ─── Helpers ──────────────────────────────────────────────────────────────

/** Minimal binding document for tests */
function makeBinding(overrides?: Partial<IAgentAssistBinding>): IAgentAssistBinding {
  return {
    _id: 'binding-1',
    tenantId: 'T1',
    projectId: 'P1',
    appId: 'aa-test',
    environment: 'dev',
    status: 'active',
    deploymentId: null,
    apiKeyId: null,
    displayName: null,
    createdBy: 'admin-1',
    updatedBy: null,
    disabledAt: null,
    disabledBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as IAgentAssistBinding;
}

/** Build a full fake repo from partial overrides */
function fakeRepo(overrides: Partial<AgentAssistBindingResolver>): AgentAssistBindingResolver {
  return {
    get: overrides.get ?? (async () => null),
    invalidate: overrides.invalidate ?? (() => {}),
    list: overrides.list ?? (async () => ({ items: [], total: 0 })),
    ['findByIdForTenant']: overrides['findByIdForTenant'] ?? (async () => null),
    create: overrides.create ?? (async () => makeBinding()),
    update: overrides.update ?? (async () => makeBinding()),
    setStatus: overrides.setStatus ?? (async () => makeBinding()),
    remove: overrides.remove ?? (async () => {}),
    cascadeOnProjectDelete: overrides.cascadeOnProjectDelete ?? (async () => 0),
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe('platform-admin-agent-assist routes (unit)', () => {
  describe('GET /tenants/:tenantId/bindings — list', () => {
    it('returns paginated list', async () => {
      const binding = makeBinding();
      const app = buildAdminCompatApp(
        fakeRepo({
          list: async () => ({ items: [binding], total: 1 }),
        }),
      );

      const res = await supertest(app).get('/tenants/T1/bindings');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0]._id).toBe('binding-1');
      expect(res.body.data.pagination.total).toBe(1);
    });

    it('returns empty list when no bindings', async () => {
      const app = buildAdminCompatApp(
        fakeRepo({
          list: async () => ({ items: [], total: 0 }),
        }),
      );

      const res = await supertest(app).get('/tenants/T1/bindings');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(0);
    });
  });

  describe('POST /tenants/:tenantId/bindings — create', () => {
    it('creates binding and returns 201', async () => {
      const app = buildAdminCompatApp(
        fakeRepo({
          create: async (_ctx, input) => makeBinding({ appId: input.appId }),
        }),
      );

      const res = await supertest(app)
        .post('/tenants/T1/bindings')
        .send({ projectId: 'P1', appId: 'aa-new', environment: 'dev' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.appId).toBe('aa-new');
    });

    it('returns 409 on duplicate binding', async () => {
      const app = buildAdminCompatApp(
        fakeRepo({
          create: async () => {
            throw new AgentAssistBindingDuplicateError('T1', 'aa-dup', 'dev');
          },
        }),
      );

      const res = await supertest(app)
        .post('/tenants/T1/bindings')
        .send({ projectId: 'P1', appId: 'aa-dup', environment: 'dev' });

      expect(res.status).toBe(409);
      expect(res.body.success).toBe(false);
      expect(res.body.error.code).toBe('BINDING_DUPLICATE');
    });
  });

  describe('GET /tenants/:tenantId/bindings/:bindingId — get', () => {
    it('returns binding when found', async () => {
      const binding = makeBinding();
      const app = buildAdminCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => binding,
        }),
      );

      const res = await supertest(app).get('/tenants/T1/bindings/binding-1');

      expect(res.status).toBe(200);
      expect(res.body.data._id).toBe('binding-1');
    });

    it('returns 404 when not found', async () => {
      const app = buildAdminCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => null,
        }),
      );

      const res = await supertest(app).get('/tenants/T1/bindings/nonexistent');

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('BINDING_NOT_FOUND');
    });
  });

  describe('PATCH /tenants/:tenantId/bindings/:bindingId — update', () => {
    it('updates binding fields', async () => {
      const updated = makeBinding({ displayName: 'New Name' });
      const app = buildAdminCompatApp(
        fakeRepo({
          update: async () => updated,
        }),
      );

      const res = await supertest(app)
        .patch('/tenants/T1/bindings/binding-1')
        .send({ displayName: 'New Name' });

      expect(res.status).toBe(200);
      expect(res.body.data.displayName).toBe('New Name');
    });

    it('returns 404 when binding not found', async () => {
      const app = buildAdminCompatApp(
        fakeRepo({
          update: async () => {
            throw new AgentAssistBindingNotFoundError('nonexistent');
          },
        }),
      );

      const res = await supertest(app)
        .patch('/tenants/T1/bindings/nonexistent')
        .send({ displayName: 'X' });

      expect(res.status).toBe(404);
      expect(res.body.error.code).toBe('BINDING_NOT_FOUND');
    });

    it('rejects immutable field changes', async () => {
      const app = buildAdminCompatApp(fakeRepo({}));

      const res = await supertest(app)
        .patch('/tenants/T1/bindings/binding-1')
        .send({ environment: 'prod' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IMMUTABLE_FIELD_CHANGE');
    });
  });

  describe('POST /tenants/:tenantId/bindings/:bindingId/disable', () => {
    it('sets status to disabled', async () => {
      const disabled = makeBinding({ status: 'disabled', disabledAt: new Date() });
      const app = buildAdminCompatApp(
        fakeRepo({
          setStatus: async (_ctx, _id, status) => {
            expect(status).toBe('disabled');
            return disabled;
          },
        }),
      );

      const res = await supertest(app).post('/tenants/T1/bindings/binding-1/disable');

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('disabled');
    });

    it('returns 404 when binding not found', async () => {
      const app = buildAdminCompatApp(
        fakeRepo({
          setStatus: async () => {
            throw new AgentAssistBindingNotFoundError('nonexistent');
          },
        }),
      );

      const res = await supertest(app).post('/tenants/T1/bindings/nonexistent/disable');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /tenants/:tenantId/bindings/:bindingId/enable', () => {
    it('sets status to active', async () => {
      const enabled = makeBinding({ status: 'active', disabledAt: null });
      const app = buildAdminCompatApp(
        fakeRepo({
          setStatus: async (_ctx, _id, status) => {
            expect(status).toBe('active');
            return enabled;
          },
        }),
      );

      const res = await supertest(app).post('/tenants/T1/bindings/binding-1/enable');

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('active');
    });
  });

  describe('DELETE /tenants/:tenantId/bindings/:bindingId', () => {
    it('deletes binding', async () => {
      let removeCalled = false;
      const app = buildAdminCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => makeBinding(),
          remove: async () => {
            removeCalled = true;
          },
        }),
      );

      const res = await supertest(app).delete('/tenants/T1/bindings/binding-1');

      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
      expect(removeCalled).toBe(true);
    });

    it('revokes the binding API key before deleting', async () => {
      let revokedId: string | null = null;
      const apiKeyStore = createInMemoryApiKeyStore();
      const app = buildAdminCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => makeBinding({ apiKeyId: 'key-1' }),
          remove: async () => {},
        }),
        {
          apiKeyStore: {
            create: apiKeyStore.create,
            async revoke(id, tenantId) {
              revokedId = id;
              await apiKeyStore.revoke(id, tenantId);
            },
          },
        },
      );

      const res = await supertest(app).delete('/tenants/T1/bindings/binding-1');

      expect(res.status).toBe(200);
      expect(revokedId).toBe('key-1');
    });

    it('returns 404 when binding not found', async () => {
      const app = buildAdminCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => null,
        }),
      );

      const res = await supertest(app).delete('/tenants/T1/bindings/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('tenant isolation', () => {
    it('passes tenantId from path to repo methods', async () => {
      let receivedTenantId = '';
      const app = buildAdminCompatApp(
        fakeRepo({
          list: async (ctx) => {
            receivedTenantId = ctx.tenantId;
            return { items: [], total: 0 };
          },
        }),
      );

      await supertest(app).get('/tenants/TENANT_XYZ/bindings');
      expect(receivedTenantId).toBe('TENANT_XYZ');
    });
  });
});
