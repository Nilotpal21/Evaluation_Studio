import { describe, expect, test, vi } from 'vitest';
import { SessionRuntimePolicyService } from '../runtime-policy-service.js';

describe('SessionRuntimePolicyService', () => {
  test('applies tenant, project, and agent runtime timeout precedence', async () => {
    const service = new SessionRuntimePolicyService({
      getTenantConfigAsync: vi.fn().mockResolvedValue({
        security: {
          sessionIdleSeconds: 1800,
          sessionMaxAgeSeconds: 28800,
        },
      }),
      findProjectSettings: vi.fn().mockResolvedValue({
        sessionLifecycle: {
          runtime: {
            idleSeconds: 900,
          },
        },
      }),
    });

    const resolved = await service.resolveRuntimeSessionTimeouts({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentLifecycle: {
        maxAgeSeconds: 120,
      },
    });

    expect(resolved).toEqual({
      sessionIdleSeconds: 900,
      sessionMaxAgeSeconds: 120,
      sources: {
        idleSeconds: 'project',
        maxAgeSeconds: 'agent',
      },
    });
  });

  test('loads agent lifecycle overrides by name when not passed directly', async () => {
    const service = new SessionRuntimePolicyService({
      getTenantConfigAsync: vi.fn().mockResolvedValue({
        security: {
          sessionIdleSeconds: 1800,
          sessionMaxAgeSeconds: 28800,
        },
      }),
      findProjectSettings: vi.fn().mockResolvedValue(null),
      findProjectAgentForProject: vi.fn().mockResolvedValue({
        dslContent: 'AGENT: TimeoutAgent',
      }),
      parseAgentDsl: vi.fn().mockResolvedValue({
        idleSeconds: 45,
      }),
    });

    const resolved = await service.resolveRuntimeSessionTimeouts({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      agentName: 'TimeoutAgent',
    });

    expect(resolved).toEqual({
      sessionIdleSeconds: 45,
      sessionMaxAgeSeconds: 28800,
      sources: {
        idleSeconds: 'agent',
        maxAgeSeconds: 'tenant',
      },
      agentFound: true,
    });
  });

  test('returns empty timeouts when tenant context is unavailable', async () => {
    const service = new SessionRuntimePolicyService();

    await expect(
      service.resolveRuntimeSessionTimeouts({
        projectId: 'project-1',
      }),
    ).resolves.toEqual({
      sources: {},
    });
  });

  test('falls back to empty sources when resolution fails', async () => {
    const service = new SessionRuntimePolicyService({
      getTenantConfigAsync: vi.fn().mockRejectedValue(new Error('boom')),
    });

    await expect(
      service.resolveRuntimeSessionTimeouts({
        tenantId: 'tenant-1',
        projectId: 'project-1',
      }),
    ).resolves.toEqual({
      sources: {},
    });
  });

  test('resolves disconnect policy from tenant, project channel override, and agent override precedence', async () => {
    const service = new SessionRuntimePolicyService({
      findProjectSettings: vi.fn().mockResolvedValue({
        sessionLifecycle: {
          channels: {
            api: {
              defaultDisposition: 'completed',
              disconnectBehavior: 'end',
            },
          },
        },
      }),
      getChannelLifecycle: vi.fn(() => ({
        defaultDisposition: 'abandoned' as const,
        disconnectBehavior: 'detach' as const,
      })),
    });

    const resolved = await service.resolveDisconnectPolicy({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: 'api',
      agentLifecycle: {
        disconnect: {
          defaultDisposition: 'timeout',
        },
      },
    });

    expect(resolved).toEqual({
      disposition: 'timeout',
      disconnectBehavior: 'end',
      sources: {
        disposition: 'agent',
        disconnectBehavior: 'project.channel.api',
      },
    });
  });

  test('loads disconnect lifecycle agent overrides by name when needed', async () => {
    const service = new SessionRuntimePolicyService({
      findProjectSettings: vi.fn().mockResolvedValue(null),
      findProjectAgentForProject: vi.fn().mockResolvedValue({
        dslContent: 'AGENT: TimeoutAgent',
      }),
      parseAgentDsl: vi.fn().mockResolvedValue({
        disconnect: {
          defaultDisposition: 'completed',
          disconnectBehavior: 'end',
        },
      }),
      getChannelLifecycle: vi.fn(() => ({
        defaultDisposition: 'abandoned' as const,
        disconnectBehavior: 'detach' as const,
      })),
    });

    const resolved = await service.resolveDisconnectPolicy({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: 'web_chat',
      agentName: 'TimeoutAgent',
    });

    expect(resolved).toEqual({
      disposition: 'completed',
      disconnectBehavior: 'end',
      sources: {
        disposition: 'agent',
        disconnectBehavior: 'agent',
      },
      agentFound: true,
    });
  });

  test('falls back to empty disconnect sources when resolution fails', async () => {
    const service = new SessionRuntimePolicyService({
      findProjectSettings: vi.fn().mockRejectedValue(new Error('boom')),
      getChannelLifecycle: vi.fn(() => ({
        defaultDisposition: 'abandoned' as const,
        disconnectBehavior: 'detach' as const,
      })),
    });

    await expect(
      service.resolveDisconnectPolicy({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channel: 'web_chat',
      }),
    ).resolves.toEqual({
      sources: {},
    });
  });

  test('resolves end-hook policy from project defaults with channel override and ignores agent lookup', async () => {
    const findProjectSettings = vi.fn().mockResolvedValue({
      sessionLifecycle: {
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
    const findProjectAgentForProject = vi.fn();
    const service = new SessionRuntimePolicyService({
      findProjectSettings,
      findProjectAgentForProject,
    });

    const resolved = await service.resolveEndHookPolicy({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: 'web_chat',
    });

    expect(resolved).toEqual({
      config: {
        mode: 'respond',
        message: 'This chat has ended.',
      },
      source: 'project.channel.web_chat',
    });
    expect(findProjectAgentForProject).not.toHaveBeenCalled();
  });

  test('resolves transfer-session TTL from project agent transfer settings', async () => {
    const service = new SessionRuntimePolicyService({
      findProjectSettings: vi.fn().mockResolvedValue({
        agentTransfer: {
          session: {
            ttl: {
              chat: 900,
            },
          },
        },
      }),
    });

    const resolved = await service.resolveTransferSessionTtl({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      channel: 'chat',
    });

    expect(resolved).toEqual({
      ttlSeconds: 900,
      source: 'project.agentTransfer.ttl.chat',
    });
  });

  test('falls back to legacy transfer-session TTL when project scope is unavailable', async () => {
    const service = new SessionRuntimePolicyService({
      getLegacyTransferTtl: vi.fn().mockReturnValue(86400),
    });

    const resolved = await service.resolveTransferSessionTtl({
      channel: 'email',
    });

    expect(resolved).toEqual({
      ttlSeconds: 86400,
      source: 'legacy.default',
    });
  });
});
