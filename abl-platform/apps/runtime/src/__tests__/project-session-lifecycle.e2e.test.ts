import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../routes/auth.js';
import agentTransferSettingsRouter from '../routes/agent-transfer-settings.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import projectIoRouter from '../routes/project-io.js';
import projectSessionLifecycleRouter from '../routes/project-session-lifecycle.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  addMember,
  authHeaders,
  bootstrapProject,
  devLogin,
  importProjectFiles,
  requestJson,
  setSuperAdmins,
  uniqueEmail,
  uniqueSlug,
} from './helpers/channel-e2e-bootstrap.js';

const AGENT_TIMEOUT_DSL = `
AGENT: TimeoutAgent
GOAL: "Handle support conversations"
EXECUTION:
  session_idle_timeout: 125000
`;

describe('Project Session Lifecycle E2E', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/v1/agent-transfer/settings', agentTransferSettingsRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
      app.use('/api/projects/:projectId/project-io', projectIoRouter);
      app.use('/api/projects/:projectId/session-lifecycle', projectSessionLifecycleRouter);
    });
  }, 60_000);

  beforeEach(async () => {
    clearPermissionCache();
    await harness.resetRuntimeState();
    await setSuperAdmins([]);
  });

  afterAll(async () => {
    await harness.close();
  }, 30_000);

  test('GET / returns the default lifecycle projection for a new project', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-e2e-defaults'),
      uniqueSlug('sl-e2e-tenant-defaults'),
      uniqueSlug('sl-e2e-project-defaults'),
    );

    const response = await requestJson<{
      success: boolean;
      data: {
        runtime: Record<string, unknown>;
        endHook: { mode: string };
        channels: Record<string, unknown>;
        agentTransfer: { ttl: Record<string, number> };
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.runtime).toEqual({});
    expect(response.body.data.endHook).toEqual({ mode: 'ignore' });
    expect(response.body.data.channels).toEqual({});
    expect(response.body.data.agentTransfer.ttl).toEqual({});
  });

  test('GET /effective reflects tenant defaults plus the imported agent override', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-e2e-effective'),
      uniqueSlug('sl-e2e-tenant-effective'),
      uniqueSlug('sl-e2e-project-effective'),
    );

    await importProjectFiles(harness, admin.token, admin.projectId, {
      'agents/timeout-agent.agent.abl': AGENT_TIMEOUT_DSL,
    });

    const response = await requestJson<{
      success: boolean;
      data: {
        runtime: {
          idleSeconds: { value?: number; source?: string };
          maxAgeSeconds: { value?: number; source?: string };
        };
        disconnect: {
          defaultDisposition: { value?: string; source?: string };
          disconnectBehavior: { value?: string; source?: string };
        };
        endHook: {
          mode: { value: string; source?: string };
          message: { value?: string; source?: string };
        };
        agentTransfer: {
          ttl: Record<string, { value?: number; source?: string }>;
        };
      };
    }>(
      harness,
      `/api/projects/${admin.projectId}/session-lifecycle/effective?channel=web_chat&agentName=TimeoutAgent`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.runtime.idleSeconds).toEqual({
      value: 125,
      source: 'agent',
    });
    expect(response.body.data.runtime.maxAgeSeconds).toEqual({
      value: 28800,
      source: 'tenant',
    });
    expect(response.body.data.disconnect.defaultDisposition).toEqual({
      value: 'abandoned',
      source: 'tenant',
    });
    expect(response.body.data.disconnect.disconnectBehavior).toEqual({
      value: 'detach',
      source: 'tenant',
    });
    expect(response.body.data.endHook.mode).toEqual({
      value: 'ignore',
    });
    expect(response.body.data.endHook.message).toEqual({});
    expect(response.body.data.agentTransfer.ttl.chat).toEqual({
      value: 1800,
      source: 'legacy.default',
    });
    expect(response.body.data.agentTransfer.ttl.email).toEqual({
      value: 86400,
      source: 'legacy.default',
    });
  });

  test('PATCH / updates lifecycle settings and effective inspection reflects channel hook override', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-e2e-patch'),
      uniqueSlug('sl-e2e-tenant-patch'),
      uniqueSlug('sl-e2e-project-patch'),
    );

    const patchResponse = await requestJson<{
      success: boolean;
      data: {
        runtime: { idleSeconds?: number; maxAgeSeconds?: number };
        endHook: { mode: string; message?: string };
        channels: Record<
          string,
          {
            endHook?: { mode: string; message?: string };
          }
        >;
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        runtime: {
          idleSeconds: 1200,
        },
        endHook: {
          mode: 'ignore',
        },
        channels: {
          web_chat: {
            defaultDisposition: 'completed',
            disconnectBehavior: 'end',
            endHook: {
              mode: 'respond',
              message: 'This chat has ended.',
            },
          },
        },
      },
    });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.success).toBe(true);
    expect(patchResponse.body.data.runtime).toEqual({
      idleSeconds: 1200,
    });
    expect(patchResponse.body.data.endHook).toEqual({
      mode: 'ignore',
    });
    expect(patchResponse.body.data.channels.web_chat).toEqual({
      defaultDisposition: 'completed',
      disconnectBehavior: 'end',
      endHook: {
        mode: 'respond',
        message: 'This chat has ended.',
      },
    });

    const effectiveResponse = await requestJson<{
      success: boolean;
      data: {
        runtime: {
          idleSeconds: { value?: number; source?: string };
        };
        endHook: {
          mode: { value: string; source?: string };
          message: { value?: string; source?: string };
        };
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle/effective?channel=web_chat`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });

    expect(effectiveResponse.status).toBe(200);
    expect(effectiveResponse.body.success).toBe(true);
    expect(effectiveResponse.body.data.runtime.idleSeconds).toEqual({
      value: 1200,
      source: 'project',
    });
    expect(effectiveResponse.body.data.endHook.mode).toEqual({
      value: 'respond',
      source: 'project.channel.web_chat',
    });
    expect(effectiveResponse.body.data.endHook.message).toEqual({
      value: 'This chat has ended.',
      source: 'project.channel.web_chat',
    });
  });

  test('PATCH / updates transfer TTL overrides without regressing legacy transfer settings reads', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-e2e-ttl-patch'),
      uniqueSlug('sl-e2e-tenant-ttl-patch'),
      uniqueSlug('sl-e2e-project-ttl-patch'),
    );

    const seedTransferSettings = await requestJson<{
      success: boolean;
      data: {
        session: {
          ttl?: Record<string, number>;
          maxConcurrentPerContact: number;
        };
        defaultRouting: {
          queue: string;
          postAgentAction: string;
        };
      };
    }>(harness, '/api/v1/agent-transfer/settings', {
      method: 'PUT',
      headers: authHeaders(admin.token, { 'X-Project-Id': admin.projectId }),
      body: {
        session: {
          ttl: {
            email: 7200,
          },
          maxConcurrentPerContact: 4,
        },
        defaultRouting: {
          queue: 'vip-support',
          postAgentAction: 'return',
        },
      },
    });

    expect(seedTransferSettings.status).toBe(200);
    expect(seedTransferSettings.body.success).toBe(true);

    const patchResponse = await requestJson<{
      success: boolean;
      data: {
        agentTransfer: {
          ttl: Record<string, number>;
        };
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        agentTransfer: {
          ttl: {
            chat: 1800,
            voice: 0,
          },
        },
      },
    });

    expect(patchResponse.status).toBe(200);
    expect(patchResponse.body.success).toBe(true);
    expect(patchResponse.body.data.agentTransfer.ttl).toEqual({
      email: 7200,
      chat: 1800,
      voice: 0,
    });

    const readLifecycle = await requestJson<{
      success: boolean;
      data: {
        agentTransfer: {
          ttl: Record<string, number>;
        };
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });

    expect(readLifecycle.status).toBe(200);
    expect(readLifecycle.body.data.agentTransfer.ttl).toEqual({
      email: 7200,
      chat: 1800,
      voice: 0,
    });

    const readLegacy = await requestJson<{
      success: boolean;
      data: {
        session: {
          ttl: Record<string, number>;
          maxConcurrentPerContact: number;
        };
        defaultRouting: {
          queue: string;
          postAgentAction: string;
        };
      } | null;
    }>(harness, '/api/v1/agent-transfer/settings', {
      method: 'GET',
      headers: authHeaders(admin.token, { 'X-Project-Id': admin.projectId }),
    });

    expect(readLegacy.status).toBe(200);
    expect(readLegacy.body.success).toBe(true);
    expect(readLegacy.body.data).toMatchObject({
      session: {
        ttl: {
          email: 7200,
          chat: 1800,
          voice: 0,
        },
        maxConcurrentPerContact: 4,
      },
      defaultRouting: {
        queue: 'vip-support',
        postAgentAction: 'return',
      },
    });
  });

  test('non-members cannot read the lifecycle route', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-e2e-authz'),
      uniqueSlug('sl-e2e-tenant-authz'),
      uniqueSlug('sl-e2e-project-authz'),
    );

    const outsiderEmail = uniqueEmail('sl-e2e-outsider');
    const outsiderLogin = await devLogin(harness, outsiderEmail);
    await addMember(harness, admin.token, admin.tenantId, outsiderEmail, 'VIEWER');

    const response = await requestJson<{
      success: boolean;
      error?: { code: string; message: string };
      message?: string;
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'GET',
      headers: authHeaders(outsiderLogin.accessToken),
    });

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error?.code).toBe('PROJECT_MEMBERSHIP_REQUIRED');
  });

  test('non-members cannot write the lifecycle route', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-e2e-write-authz'),
      uniqueSlug('sl-e2e-tenant-write-authz'),
      uniqueSlug('sl-e2e-project-write-authz'),
    );

    const outsiderEmail = uniqueEmail('sl-e2e-write-outsider');
    const outsiderLogin = await devLogin(harness, outsiderEmail);
    await addMember(harness, admin.token, admin.tenantId, outsiderEmail, 'VIEWER');

    const response = await requestJson<{
      success: boolean;
      error?: { code: string; message: string };
      message?: string;
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'PATCH',
      headers: authHeaders(outsiderLogin.accessToken),
      body: {
        endHook: {
          mode: 'ignore',
        },
      },
    });

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error?.code).toBe('PROJECT_MEMBERSHIP_REQUIRED');
  });
});
