import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import authRouter from '../routes/auth.js';
import platformAdminTenantsRouter from '../routes/platform-admin-tenants.js';
import projectSessionLifecycleRouter from '../routes/project-session-lifecycle.js';
import { clearPermissionCache } from '../services/permission-resolution.js';
import { startRuntimeApiHarness, type RuntimeApiHarness } from './helpers/runtime-api-harness.js';
import {
  addMember,
  authHeaders,
  bootstrapProject,
  devLogin,
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

describe('Project Session Lifecycle Integration', () => {
  let harness: RuntimeApiHarness;

  beforeAll(async () => {
    harness = await startRuntimeApiHarness((app) => {
      app.use('/api/auth', authRouter);
      app.use('/api/platform/admin/tenants', platformAdminTenantsRouter);
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

  test('GET / returns stored lifecycle overrides with flattened transfer TTLs', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-int-read'),
      uniqueSlug('sl-int-tenant-read'),
      uniqueSlug('sl-int-project-read'),
    );

    const { ProjectSettings } = await import('@agent-platform/database/models');
    await ProjectSettings.findOneAndUpdate(
      { projectId: admin.projectId, tenantId: admin.tenantId },
      {
        $set: {
          projectId: admin.projectId,
          tenantId: admin.tenantId,
          sessionLifecycle: {
            runtime: {
              idleSeconds: 900,
              maxAgeSeconds: 3600,
            },
            endHook: {
              mode: 'respond',
              message: 'Conversation closed.',
            },
            channels: {
              web_chat: {
                defaultDisposition: 'completed',
                disconnectBehavior: 'detach',
                endHook: {
                  mode: 'respond',
                  message: 'Chat session ended.',
                },
              },
            },
          },
          agentTransfer: {
            session: {
              ttl: {
                chat: 2700,
                voice: 0,
              },
            },
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    ).exec();

    const response = await requestJson<{
      success: boolean;
      data: {
        runtime: { idleSeconds?: number; maxAgeSeconds?: number };
        endHook: { mode: string; message?: string };
        channels: Record<
          string,
          {
            defaultDisposition?: string;
            disconnectBehavior?: string;
            endHook?: { mode: string; message?: string };
          }
        >;
        agentTransfer: {
          ttl: Record<string, number>;
        };
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.runtime).toEqual({
      idleSeconds: 900,
      maxAgeSeconds: 3600,
    });
    expect(response.body.data.endHook).toEqual({
      mode: 'respond',
      message: 'Conversation closed.',
    });
    expect(response.body.data.channels.web_chat).toEqual({
      defaultDisposition: 'completed',
      disconnectBehavior: 'detach',
      endHook: {
        mode: 'respond',
        message: 'Chat session ended.',
      },
    });
    expect(response.body.data.agentTransfer.ttl).toEqual({
      chat: 2700,
      voice: 0,
    });
  });

  test('GET /effective resolves tenant, project, agent, and transfer TTL provenance', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-int-effective'),
      uniqueSlug('sl-int-tenant-effective'),
      uniqueSlug('sl-int-project-effective'),
    );

    const { ProjectSettings, ProjectAgent } = await import('@agent-platform/database/models');
    await Promise.all([
      ProjectSettings.findOneAndUpdate(
        { projectId: admin.projectId, tenantId: admin.tenantId },
        {
          $set: {
            projectId: admin.projectId,
            tenantId: admin.tenantId,
            sessionLifecycle: {
              runtime: {
                maxAgeSeconds: 3600,
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
            agentTransfer: {
              session: {
                ttl: {
                  chat: 2700,
                },
              },
            },
          },
        },
        { upsert: true, setDefaultsOnInsert: true },
      ).exec(),
      ProjectAgent.create({
        tenantId: admin.tenantId,
        projectId: admin.projectId,
        name: 'TimeoutAgent',
        agentPath: 'agents/timeout-agent',
        dslContent: AGENT_TIMEOUT_DSL,
      }),
    ]);

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
      value: 3600,
      source: 'project',
    });
    expect(response.body.data.disconnect.defaultDisposition).toEqual({
      value: 'completed',
      source: 'project.channel.web_chat',
    });
    expect(response.body.data.disconnect.disconnectBehavior).toEqual({
      value: 'end',
      source: 'project.channel.web_chat',
    });
    expect(response.body.data.endHook.mode).toEqual({
      value: 'respond',
      source: 'project.channel.web_chat',
    });
    expect(response.body.data.endHook.message).toEqual({
      value: 'This chat has ended.',
      source: 'project.channel.web_chat',
    });
    expect(response.body.data.agentTransfer.ttl.chat).toEqual({
      value: 2700,
      source: 'project.agentTransfer.ttl.chat',
    });
    expect(response.body.data.agentTransfer.ttl.email).toEqual({
      value: 86400,
      source: 'legacy.default',
    });
  });

  test('GET /effective returns 404 when the requested agent does not exist', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-int-missing-agent'),
      uniqueSlug('sl-int-tenant-missing-agent'),
      uniqueSlug('sl-int-project-missing-agent'),
    );

    const response = await requestJson<{
      success: boolean;
      error?: { code: string; message: string };
    }>(
      harness,
      `/api/projects/${admin.projectId}/session-lifecycle/effective?channel=web_chat&agentName=MissingAgent`,
      {
        method: 'GET',
        headers: authHeaders(admin.token),
      },
    );

    expect(response.status).toBe(404);
    expect(response.body.success).toBe(false);
    expect(response.body.error).toEqual({
      code: 'AGENT_NOT_FOUND',
      message: 'Agent not found',
    });
  });

  test('PATCH / merges lifecycle settings and preserves existing runtime values', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-int-patch-merge'),
      uniqueSlug('sl-int-tenant-patch-merge'),
      uniqueSlug('sl-int-project-patch-merge'),
    );

    const initialPatch = await requestJson<{
      success: boolean;
      data: {
        runtime: { idleSeconds?: number; maxAgeSeconds?: number };
        endHook: { mode: string; message?: string };
        channels: Record<string, unknown>;
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        runtime: {
          idleSeconds: 900,
        },
        channels: {
          web_chat: {
            defaultDisposition: 'completed',
            disconnectBehavior: 'end',
          },
        },
      },
    });

    expect(initialPatch.status).toBe(200);
    expect(initialPatch.body.data.runtime).toEqual({
      idleSeconds: 900,
    });
    expect(initialPatch.body.data.endHook).toEqual({
      mode: 'ignore',
    });
    expect(initialPatch.body.data.channels.web_chat).toEqual({
      defaultDisposition: 'completed',
      disconnectBehavior: 'end',
    });

    const mergedPatch = await requestJson<{
      success: boolean;
      data: {
        runtime: { idleSeconds?: number; maxAgeSeconds?: number };
        endHook: { mode: string; message?: string };
        channels: Record<
          string,
          {
            defaultDisposition?: string;
            disconnectBehavior?: string;
            endHook?: { mode: string; message?: string };
          }
        >;
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        endHook: {
          mode: 'ignore',
        },
        channels: {
          web_chat: {
            endHook: {
              mode: 'respond',
              message: 'This chat has ended.',
            },
          },
        },
      },
    });

    expect(mergedPatch.status).toBe(200);
    expect(mergedPatch.body.data.runtime).toEqual({
      idleSeconds: 900,
    });
    expect(mergedPatch.body.data.endHook).toEqual({
      mode: 'ignore',
    });
    expect(mergedPatch.body.data.channels.web_chat).toEqual({
      defaultDisposition: 'completed',
      disconnectBehavior: 'end',
      endHook: {
        mode: 'respond',
        message: 'This chat has ended.',
      },
    });

    const effectiveApi = await requestJson<{
      success: boolean;
      data: {
        endHook: {
          mode: { value: string; source?: string };
          message: { value?: string; source?: string };
        };
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle/effective?channel=api`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });

    expect(effectiveApi.status).toBe(200);
    expect(effectiveApi.body.data.endHook.mode).toEqual({
      value: 'ignore',
      source: 'project',
    });
    expect(effectiveApi.body.data.endHook.message).toEqual({});

    const effectiveWebChat = await requestJson<{
      success: boolean;
      data: {
        endHook: {
          mode: { value: string; source?: string };
          message: { value?: string; source?: string };
        };
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle/effective?channel=web_chat`, {
      method: 'GET',
      headers: authHeaders(admin.token),
    });

    expect(effectiveWebChat.status).toBe(200);
    expect(effectiveWebChat.body.data.endHook.mode).toEqual({
      value: 'respond',
      source: 'project.channel.web_chat',
    });
    expect(effectiveWebChat.body.data.endHook.message).toEqual({
      value: 'This chat has ended.',
      source: 'project.channel.web_chat',
    });
  });

  test('PATCH / merges transfer TTL overrides and preserves non-lifecycle transfer settings', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-int-ttl-merge'),
      uniqueSlug('sl-int-tenant-ttl-merge'),
      uniqueSlug('sl-int-project-ttl-merge'),
    );

    const { ProjectSettings } = await import('@agent-platform/database/models');
    await ProjectSettings.findOneAndUpdate(
      { projectId: admin.projectId, tenantId: admin.tenantId },
      {
        $set: {
          projectId: admin.projectId,
          tenantId: admin.tenantId,
          sessionLifecycle: {
            runtime: {
              maxAgeSeconds: 3600,
            },
          },
          agentTransfer: {
            session: {
              ttl: {
                email: 7200,
              },
              maxConcurrentPerContact: 3,
            },
            defaultRouting: {
              queue: 'priority-support',
              postAgentAction: 'return',
            },
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    ).exec();

    const response = await requestJson<{
      success: boolean;
      data: {
        runtime: { idleSeconds?: number; maxAgeSeconds?: number };
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

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.runtime).toEqual({
      maxAgeSeconds: 3600,
    });
    expect(response.body.data.agentTransfer.ttl).toEqual({
      email: 7200,
      chat: 1800,
      voice: 0,
    });

    const updated = await ProjectSettings.findOne({
      projectId: admin.projectId,
      tenantId: admin.tenantId,
    }).lean();

    expect(updated?.agentTransfer).toMatchObject({
      session: {
        ttl: {
          email: 7200,
          chat: 1800,
          voice: 0,
        },
        maxConcurrentPerContact: 3,
      },
      defaultRouting: {
        queue: 'priority-support',
        postAgentAction: 'return',
      },
    });
  });

  test('PUT / replaces transfer TTL overrides while preserving non-lifecycle transfer settings', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-int-ttl-replace'),
      uniqueSlug('sl-int-tenant-ttl-replace'),
      uniqueSlug('sl-int-project-ttl-replace'),
    );

    const { ProjectSettings } = await import('@agent-platform/database/models');
    await ProjectSettings.findOneAndUpdate(
      { projectId: admin.projectId, tenantId: admin.tenantId },
      {
        $set: {
          projectId: admin.projectId,
          tenantId: admin.tenantId,
          sessionLifecycle: {
            runtime: {
              idleSeconds: 600,
            },
            channels: {
              web_chat: {
                disconnectBehavior: 'end',
              },
            },
          },
          agentTransfer: {
            session: {
              ttl: {
                chat: 1800,
                email: 7200,
              },
              maxConcurrentPerContact: 2,
            },
            defaultRouting: {
              connectionId: 'conn-123',
              postAgentAction: 'end',
            },
          },
        },
      },
      { upsert: true, setDefaultsOnInsert: true },
    ).exec();

    const response = await requestJson<{
      success: boolean;
      data: {
        runtime: Record<string, number>;
        channels: Record<string, unknown>;
        agentTransfer: {
          ttl: Record<string, number>;
        };
      };
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'PUT',
      headers: authHeaders(admin.token),
      body: {
        endHook: {
          mode: 'ignore',
        },
        agentTransfer: {
          ttl: {
            messaging: 900,
          },
        },
      },
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.data.runtime).toEqual({});
    expect(response.body.data.channels).toEqual({});
    expect(response.body.data.agentTransfer.ttl).toEqual({
      messaging: 900,
    });

    const updated = await ProjectSettings.findOne({
      projectId: admin.projectId,
      tenantId: admin.tenantId,
    }).lean();

    expect(updated?.sessionLifecycle).toEqual({
      endHook: {
        mode: 'ignore',
      },
    });
    expect(updated?.agentTransfer).toMatchObject({
      session: {
        ttl: {
          messaging: 900,
        },
        maxConcurrentPerContact: 2,
      },
      defaultRouting: {
        connectionId: 'conn-123',
        postAgentAction: 'end',
      },
    });
  });

  test('PATCH / rejects unsupported hook modes and denies viewer project members', async () => {
    const admin = await bootstrapProject(
      harness,
      uniqueEmail('sl-int-patch-authz'),
      uniqueSlug('sl-int-tenant-patch-authz'),
      uniqueSlug('sl-int-project-patch-authz'),
    );

    const viewerEmail = uniqueEmail('sl-int-viewer');
    const viewerLogin = await devLogin(harness, viewerEmail);
    await addMember(harness, admin.token, admin.tenantId, viewerEmail, 'MEMBER');

    const { ProjectMember } = await import('@agent-platform/database/models');
    await ProjectMember.create({
      projectId: admin.projectId,
      userId: viewerLogin.user.id,
      role: 'viewer',
    });
    clearPermissionCache();

    const viewerResponse = await requestJson<{
      success: boolean;
      error?: { message?: string };
      message?: string;
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'PATCH',
      headers: authHeaders(viewerLogin.accessToken),
      body: {
        endHook: {
          mode: 'ignore',
        },
      },
    });

    expect(viewerResponse.status).toBe(403);
    expect(viewerResponse.body.success).toBe(false);
    expect(viewerResponse.body.message).toContain('viewer');
    expect(viewerResponse.body.message).toContain('runtime_config:write');

    const invalidModeResponse = await requestJson<{
      success: boolean;
      error?: { code?: string; message?: string };
      issues?: Array<{ message: string }>;
    }>(harness, `/api/projects/${admin.projectId}/session-lifecycle`, {
      method: 'PATCH',
      headers: authHeaders(admin.token),
      body: {
        endHook: {
          mode: 'call',
        },
      } as Record<string, unknown>,
    });

    expect(invalidModeResponse.status).toBe(400);
    expect(invalidModeResponse.body.success).toBe(false);
    expect(invalidModeResponse.body.error).toEqual({
      code: 'INVALID_BODY',
      message: 'Invalid project session lifecycle update payload',
    });
    expect(invalidModeResponse.body.issues?.[0]?.message).toBeDefined();
  });
});
