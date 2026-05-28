/**
 * Unit tests for Project-Scoped Agentic Compat Binding Routes
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
import {
  buildProjectCompatApp,
  createInMemorySettingsStore,
  createInMemoryApiKeyStore,
} from '../helpers/agent-assist/project-compat-app-builder.js';

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
    createdBy: 'user-1',
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

describe('project-agent-assist-bindings routes (unit)', () => {
  describe('GET /projects/:projectId/bindings — list', () => {
    it('returns only bindings for the requested project', async () => {
      const p1Binding = makeBinding({ _id: 'b1', projectId: 'P1' });
      let receivedProjectId: string | undefined;
      const app = buildProjectCompatApp(
        fakeRepo({
          list: async (_ctx, page) => {
            receivedProjectId = page.projectId;
            return { items: [p1Binding], total: 1 };
          },
        }),
      );

      const res = await supertest(app).get('/projects/P1/bindings');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.items).toHaveLength(1);
      expect(res.body.data.items[0]._id).toBe('b1');
      expect(receivedProjectId).toBe('P1');
    });

    it('returns empty list when no project bindings', async () => {
      const app = buildProjectCompatApp(
        fakeRepo({
          list: async () => ({ items: [], total: 0 }),
        }),
      );

      const res = await supertest(app).get('/projects/P1/bindings');

      expect(res.status).toBe(200);
      expect(res.body.data.items).toHaveLength(0);
    });
  });

  describe('POST /projects/:projectId/bindings — create', () => {
    it('creates binding with projectId injected from URL', async () => {
      const app = buildProjectCompatApp(
        fakeRepo({
          create: async (_ctx, input) =>
            makeBinding({ appId: input.appId, projectId: input.projectId }),
        }),
      );

      const res = await supertest(app)
        .post('/projects/P1/bindings')
        .send({ appId: 'aa-new', environment: 'dev' });

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.appId).toBe('aa-new');
      expect(res.body.data.projectId).toBe('P1');
    });

    it('returns 409 on duplicate binding', async () => {
      const app = buildProjectCompatApp(
        fakeRepo({
          create: async () => {
            throw new AgentAssistBindingDuplicateError('T1', 'aa-dup', 'dev');
          },
        }),
      );

      const res = await supertest(app)
        .post('/projects/P1/bindings')
        .send({ appId: 'aa-dup', environment: 'dev' });

      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('BINDING_DUPLICATE');
    });
  });

  describe('GET /projects/:projectId/bindings/:bindingId — get', () => {
    it('returns binding when it belongs to the project', async () => {
      const binding = makeBinding({ projectId: 'P1' });
      const app = buildProjectCompatApp(fakeRepo({ ['findByIdForTenant']: async () => binding }));

      const res = await supertest(app).get('/projects/P1/bindings/binding-1');

      expect(res.status).toBe(200);
      expect(res.body.data._id).toBe('binding-1');
    });

    it('returns 404 when binding belongs to another project', async () => {
      const binding = makeBinding({ projectId: 'P2' });
      const app = buildProjectCompatApp(fakeRepo({ ['findByIdForTenant']: async () => binding }));

      const res = await supertest(app).get('/projects/P1/bindings/binding-1');

      expect(res.status).toBe(404);
    });

    it('returns 404 when binding not found', async () => {
      const app = buildProjectCompatApp(fakeRepo({ ['findByIdForTenant']: async () => null }));

      const res = await supertest(app).get('/projects/P1/bindings/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  describe('PATCH /projects/:projectId/bindings/:bindingId — update', () => {
    it('updates binding fields', async () => {
      const binding = makeBinding({ projectId: 'P1' });
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => binding,
          update: async (_ctx, _id, patch) => makeBinding({ ...patch, projectId: 'P1' }),
        }),
      );

      const res = await supertest(app)
        .patch('/projects/P1/bindings/binding-1')
        .send({ displayName: 'Updated' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });

    it('handles status change via setStatus', async () => {
      const binding = makeBinding({ projectId: 'P1', status: 'active' });
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => binding,
          setStatus: async (_ctx, _id, status) => makeBinding({ projectId: 'P1', status }),
        }),
      );

      const res = await supertest(app)
        .patch('/projects/P1/bindings/binding-1')
        .send({ status: 'disabled' });

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('disabled');
    });

    it('rejects immutable field changes', async () => {
      const binding = makeBinding({ projectId: 'P1' });
      const app = buildProjectCompatApp(fakeRepo({ ['findByIdForTenant']: async () => binding }));

      const res = await supertest(app)
        .patch('/projects/P1/bindings/binding-1')
        .send({ environment: 'prod' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('IMMUTABLE_FIELD_CHANGE');
    });
  });

  describe('POST /projects/:projectId/bindings/:bindingId/disable', () => {
    it('disables binding', async () => {
      const binding = makeBinding({ projectId: 'P1' });
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => binding,
          setStatus: async () => makeBinding({ status: 'disabled', projectId: 'P1' }),
        }),
      );

      const res = await supertest(app).post('/projects/P1/bindings/binding-1/disable');

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('disabled');
    });

    it('returns 404 for binding in another project', async () => {
      const binding = makeBinding({ projectId: 'P2' });
      const app = buildProjectCompatApp(fakeRepo({ ['findByIdForTenant']: async () => binding }));

      const res = await supertest(app).post('/projects/P1/bindings/binding-1/disable');

      expect(res.status).toBe(404);
    });
  });

  describe('POST /projects/:projectId/bindings/:bindingId/enable', () => {
    it('enables binding', async () => {
      const binding = makeBinding({ projectId: 'P1', status: 'disabled' });
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => binding,
          setStatus: async () => makeBinding({ status: 'active', projectId: 'P1' }),
        }),
      );

      const res = await supertest(app).post('/projects/P1/bindings/binding-1/enable');

      expect(res.status).toBe(200);
      expect(res.body.data.status).toBe('active');
    });
  });

  describe('DELETE /projects/:projectId/bindings/:bindingId', () => {
    it('deletes binding', async () => {
      let removeCalled = false;
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => makeBinding({ projectId: 'P1' }),
          remove: async () => {
            removeCalled = true;
          },
        }),
      );

      const res = await supertest(app).delete('/projects/P1/bindings/binding-1');

      expect(res.status).toBe(200);
      expect(res.body.data.deleted).toBe(true);
      expect(removeCalled).toBe(true);
    });

    it('revokes the binding API key before deleting', async () => {
      let revokedId: string | null = null;
      const apiKeyStore = createInMemoryApiKeyStore();
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => makeBinding({ projectId: 'P1', apiKeyId: 'key-1' }),
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

      const res = await supertest(app).delete('/projects/P1/bindings/binding-1');

      expect(res.status).toBe(200);
      expect(revokedId).toBe('key-1');
    });

    it('returns 404 for binding in another project', async () => {
      const binding = makeBinding({ projectId: 'P2' });
      const app = buildProjectCompatApp(fakeRepo({ ['findByIdForTenant']: async () => binding }));

      const res = await supertest(app).delete('/projects/P1/bindings/binding-1');

      expect(res.status).toBe(404);
    });

    it('returns 404 for nonexistent binding', async () => {
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => null,
        }),
      );

      const res = await supertest(app).delete('/projects/P1/bindings/nonexistent');

      expect(res.status).toBe(404);
    });
  });

  // ─── Settings (Pass 2) ─────────────────────────────────────────────────

  describe('GET /projects/:projectId/bindings/settings', () => {
    it('returns enabled=true when no settings exist', async () => {
      const settingsStore = createInMemorySettingsStore();
      const app = buildProjectCompatApp(fakeRepo({}), { settingsStore });

      const res = await supertest(app).get('/projects/P1/bindings/settings');

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.enabled).toBe(true);
    });

    it('returns enabled=true after settings are set', async () => {
      const settingsStore = createInMemorySettingsStore();
      const app = buildProjectCompatApp(fakeRepo({}), { settingsStore });

      // First set it to enabled
      await supertest(app).put('/projects/P1/bindings/settings').send({ enabled: true });

      const res = await supertest(app).get('/projects/P1/bindings/settings');

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(true);
    });
  });

  describe('PUT /projects/:projectId/bindings/settings', () => {
    it('enables project agent assist', async () => {
      const settingsStore = createInMemorySettingsStore();
      const app = buildProjectCompatApp(fakeRepo({}), { settingsStore });

      const res = await supertest(app)
        .put('/projects/P1/bindings/settings')
        .send({ enabled: true });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
      expect(res.body.data.enabled).toBe(true);
    });

    it('disables project agent assist', async () => {
      const settingsStore = createInMemorySettingsStore();
      const app = buildProjectCompatApp(fakeRepo({}), { settingsStore });

      // Enable first
      await supertest(app).put('/projects/P1/bindings/settings').send({ enabled: true });

      // Then disable
      const res = await supertest(app)
        .put('/projects/P1/bindings/settings')
        .send({ enabled: false });

      expect(res.status).toBe(200);
      expect(res.body.data.enabled).toBe(false);
    });

    it('returns 400 for invalid settings body', async () => {
      const settingsStore = createInMemorySettingsStore();
      const app = buildProjectCompatApp(fakeRepo({}), { settingsStore });

      const res = await supertest(app)
        .put('/projects/P1/bindings/settings')
        .send({ enabled: 'not-a-boolean' });

      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    });
  });

  // ─── Create with appId auto-injection (Pass 2) ────────────────────────

  describe('POST /projects/:projectId/bindings — appId auto-injection', () => {
    it('auto-injects appId = projectId when no appId provided', async () => {
      const app = buildProjectCompatApp(
        fakeRepo({
          create: async (_ctx, input) =>
            makeBinding({ appId: input.appId, projectId: input.projectId }),
        }),
      );

      const res = await supertest(app).post('/projects/P1/bindings').send({ environment: 'dev' });

      expect(res.status).toBe(201);
      expect(res.body.data.appId).toBe('P1');
      expect(res.body.data.projectId).toBe('P1');
    });

    it('preserves legacy appId when explicitly provided', async () => {
      const app = buildProjectCompatApp(
        fakeRepo({
          create: async (_ctx, input) =>
            makeBinding({ appId: input.appId, projectId: input.projectId }),
        }),
      );

      const res = await supertest(app)
        .post('/projects/P1/bindings')
        .send({ appId: 'legacy-app-id', environment: 'dev' });

      expect(res.status).toBe(201);
      expect(res.body.data.appId).toBe('legacy-app-id');
    });

    it('persists runtimeBaseUrl on create', async () => {
      const app = buildProjectCompatApp(
        fakeRepo({
          create: async (_ctx, input) =>
            makeBinding({
              appId: input.appId,
              projectId: input.projectId,
              runtimeBaseUrl: input.runtimeBaseUrl ?? null,
            }),
        }),
      );

      const res = await supertest(app)
        .post('/projects/P1/bindings')
        .send({ environment: 'dev', runtimeBaseUrl: 'https://agents-dev.kore.ai' });

      expect(res.status).toBe(201);
      expect(res.body.data.runtimeBaseUrl).toBe('https://agents-dev.kore.ai');
    });
  });

  // ─── runtimeBaseUrl via PATCH (Pass 2) ──────────────────────────────────

  describe('PATCH /projects/:projectId/bindings/:bindingId — runtimeBaseUrl', () => {
    it('updates runtimeBaseUrl', async () => {
      const binding = makeBinding({ projectId: 'P1' });
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => binding,
          update: async (_ctx, _id, patch) => makeBinding({ ...patch, projectId: 'P1' }),
        }),
      );

      const res = await supertest(app)
        .patch('/projects/P1/bindings/binding-1')
        .send({ runtimeBaseUrl: 'https://agents-dev.kore.ai' });

      expect(res.status).toBe(200);
      expect(res.body.success).toBe(true);
    });
  });

  // ─── Generate API Key (Pass 2) ──────────────────────────────────────────

  describe('POST /projects/:projectId/bindings/:bindingId/generate-api-key', () => {
    it('generates a new API key for binding without existing key', async () => {
      const binding = makeBinding({ projectId: 'P1', apiKeyId: null });
      let capturedPatch: Record<string, unknown> = {};
      let createdScopes: string[] | undefined;
      const apiKeyStore = createInMemoryApiKeyStore();
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => binding,
          update: async (_ctx, _id, patch) => {
            capturedPatch = patch as Record<string, unknown>;
            return makeBinding({ ...patch, projectId: 'P1' });
          },
        }),
        {
          apiKeyStore: {
            revoke: apiKeyStore.revoke,
            async create(data) {
              createdScopes = data.scopes as string[];
              return apiKeyStore.create(data);
            },
          },
        },
      );

      const res = await supertest(app).post('/projects/P1/bindings/binding-1/generate-api-key');

      expect(res.status).toBe(201);
      expect(res.body.success).toBe(true);
      expect(res.body.data.rawKey).toMatch(/^abl_[0-9a-f]{64}$/);
      expect(res.body.data.prefix).toHaveLength(8);
      expect(res.body.data.apiKeyId).toBeTruthy();
      // Binding should be updated with the new apiKeyId
      expect(capturedPatch.apiKeyId).toBe(res.body.data.apiKeyId);
      expect(createdScopes).toEqual(['session:send_message']);
    });

    it('rotates API key when binding has existing key', async () => {
      const apiKeyStore = createInMemoryApiKeyStore();
      let revokedId: string | null = null;
      const customApiKeyStore: typeof apiKeyStore = {
        create: apiKeyStore.create,
        async revoke(id, tenantId) {
          revokedId = id;
          return apiKeyStore.revoke(id, tenantId);
        },
      };

      const binding = makeBinding({ projectId: 'P1', apiKeyId: 'old-key-123' });
      const app = buildProjectCompatApp(
        fakeRepo({
          ['findByIdForTenant']: async () => binding,
          update: async (_ctx, _id, patch) => makeBinding({ ...patch, projectId: 'P1' }),
        }),
        { apiKeyStore: customApiKeyStore },
      );

      const res = await supertest(app).post('/projects/P1/bindings/binding-1/generate-api-key');

      expect(res.status).toBe(201);
      expect(res.body.data.rawKey).toMatch(/^abl_/);
      // Old key should have been revoked
      expect(revokedId).toBe('old-key-123');
    });

    it('returns 404 for binding in another project', async () => {
      const binding = makeBinding({ projectId: 'P2' });
      const app = buildProjectCompatApp(fakeRepo({ ['findByIdForTenant']: async () => binding }));

      const res = await supertest(app).post('/projects/P1/bindings/binding-1/generate-api-key');

      expect(res.status).toBe(404);
    });

    it('returns 404 for nonexistent binding', async () => {
      const app = buildProjectCompatApp(fakeRepo({ ['findByIdForTenant']: async () => null }));

      const res = await supertest(app).post('/projects/P1/bindings/nonexistent/generate-api-key');

      expect(res.status).toBe(404);
    });
  });
});
