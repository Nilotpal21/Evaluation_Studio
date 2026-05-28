import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CallerContext } from '@agent-platform/shared-auth';

const mockCreateSessionFromResolved = vi.fn();
const mockEnsureLLMReady = vi.fn();
const mockResolveProjectTools = vi.fn();
const mockCompileToResolvedAgent = vi.fn();
const mockFindProjectWithAgents = vi.fn();
const mockFindProjectRuntimeConfig = vi.fn();
const mockLoadConfigVariablesMap = vi.fn();
const mockResolveProjectEntryAgentName = vi.fn();
const mockFindProjectSettings = vi.fn();
const mockDeploymentResolve = vi.fn();
const mockGetProjectConfig = vi.fn();
const mockGetConfigAsync = vi.fn();
const mockCompileProjectWorkingCopy = vi.fn();

const mockResolvedAgent = {
  agents: {
    entry_agent: { execution: { type: 'mock' } },
  },
  entryAgent: 'entry_agent',
  compilationOutput: {},
  versionInfo: { versions: {} },
};

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => ({
    isConfigured: vi.fn(() => true),
    createSessionFromResolved: mockCreateSessionFromResolved,
    ensureLLMReady: mockEnsureLLMReady,
  })),
  compileToResolvedAgent: (...args: unknown[]) => mockCompileToResolvedAgent(...args),
  resolveProjectTools: (...args: unknown[]) => mockResolveProjectTools(...args),
}));

vi.mock('../../services/project-working-copy-compiler.js', () => ({
  buildProjectWorkingCopyAgentSources: (agents: Array<Record<string, unknown>>) =>
    agents
      .filter(
        (agent): agent is { name: string; dslContent: string; systemPromptLibraryRef?: unknown } =>
          typeof agent.name === 'string' && typeof agent.dslContent === 'string',
      )
      .map((agent) => ({
        name: agent.name,
        dslContent: agent.dslContent,
        systemPromptLibraryRef:
          agent.systemPromptLibraryRef &&
          typeof agent.systemPromptLibraryRef === 'object' &&
          typeof (agent.systemPromptLibraryRef as { promptId?: unknown }).promptId === 'string' &&
          typeof (agent.systemPromptLibraryRef as { versionId?: unknown }).versionId === 'string'
            ? {
                promptId: (agent.systemPromptLibraryRef as { promptId: string }).promptId,
                versionId: (agent.systemPromptLibraryRef as { versionId: string }).versionId,
              }
            : null,
      })),
  compileProjectWorkingCopy: (...args: unknown[]) => mockCompileProjectWorkingCopy(...args),
  extractSearchInstructionsFromDsl: () => new Map(),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve(...args: unknown[]) {
      return mockDeploymentResolve(...args);
    }
  },
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(() => ({})),
}));

vi.mock('../../services/stores/store-factory.js', () => ({
  getStores: vi.fn(() => ({
    conversation: {
      createSession: vi.fn(),
    },
  })),
}));

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
}));

vi.mock('../../repos/project-repo.js', () => ({
  findProjectAgentForProject: vi.fn(async () => null),
  findProjectWithAgents: (...args: unknown[]) => mockFindProjectWithAgents(...args),
  findProjectRuntimeConfig: (...args: unknown[]) => mockFindProjectRuntimeConfig(...args),
  loadConfigVariablesMap: (...args: unknown[]) => mockLoadConfigVariablesMap(...args),
  resolveProjectEntryAgentName: (...args: unknown[]) => mockResolveProjectEntryAgentName(...args),
}));

vi.mock('../../repos/session-repo.js', () => ({
  updateSession: vi.fn(),
}));

vi.mock('../../repos/project-settings-repo.js', () => ({
  findProjectSettings: (...args: unknown[]) => mockFindProjectSettings(...args),
}));

vi.mock('../../services/tenant-config.js', () => ({
  getTenantConfigService: vi.fn(() => ({
    getProjectConfig: (...args: unknown[]) => mockGetProjectConfig(...args),
    getConfigAsync: (...args: unknown[]) => mockGetConfigAsync(...args),
  })),
}));

import { createRuntimeSession } from '../../channels/pipeline/session-factory.js';

function buildCallerContext(overrides: Partial<CallerContext> = {}): CallerContext {
  return {
    tenantId: 'tenant-1',
    channel: 'voice_twilio',
    channelId: 'channel-1',
    identityTier: 2,
    verificationMethod: 'provider',
    ...overrides,
  };
}

describe('channel pipeline session factory', () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockCreateSessionFromResolved.mockReturnValue({
      id: 'canonical-session-1',
      agentName: 'entry_agent',
    });
    mockDeploymentResolve.mockResolvedValue(mockResolvedAgent);
    mockResolveProjectTools.mockResolvedValue(new Map());
    mockCompileToResolvedAgent.mockReturnValue(mockResolvedAgent);
    mockCompileProjectWorkingCopy.mockResolvedValue({
      resolved: mockResolvedAgent,
      configVariables: {},
      warnings: [],
    });
    mockFindProjectWithAgents.mockResolvedValue({
      entryAgentName: 'entry_agent',
      agents: [
        {
          name: 'entry_agent',
          dslContent: 'AGENT entry_agent',
          dslValidationStatus: 'valid',
          systemPromptLibraryRef: null,
        },
      ],
    });
    mockFindProjectRuntimeConfig.mockResolvedValue(null);
    mockLoadConfigVariablesMap.mockResolvedValue({});
    mockResolveProjectEntryAgentName.mockImplementation(
      (
        project: { entryAgentName?: string | null; agents: Array<{ name: string }> },
        requestedAgentName?: string | null,
      ) => {
        if (requestedAgentName) {
          const requestedAgent = project.agents.find((agent) => agent.name === requestedAgentName);
          if (requestedAgent) {
            return requestedAgent.name;
          }
        }

        if (project.entryAgentName) {
          const configuredEntryAgent = project.agents.find(
            (agent) => agent.name === project.entryAgentName,
          );
          if (configuredEntryAgent) {
            return configuredEntryAgent.name;
          }
        }

        return project.agents[0]?.name;
      },
    );
    mockFindProjectSettings.mockResolvedValue(null);
    mockGetProjectConfig.mockResolvedValue({
      security: {
        sessionMaxAgeSeconds: 1200,
        sessionIdleSeconds: 300,
      },
    });
    mockGetConfigAsync.mockResolvedValue({
      security: {
        sessionMaxAgeSeconds: 1200,
        sessionIdleSeconds: 300,
      },
    });
  });

  it('passes a caller-supplied canonical sessionId through the deployment-resolved path', async () => {
    await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      deploymentId: 'deployment-1',
      channelType: 'voice_twilio',
      sessionId: 'canonical-session-1',
    });

    expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
      mockResolvedAgent,
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        deploymentId: 'deployment-1',
        channelType: 'voice_twilio',
        sessionId: 'canonical-session-1',
        sessionMaxAgeSeconds: 1200,
        sessionIdleSeconds: 300,
      }),
    );
  });

  it('forwards validated execution scope objects to runtime session creation', async () => {
    await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      deploymentId: 'deployment-1',
      channelType: 'voice_twilio',
      sessionId: 'canonical-session-scoped',
      scope: {
        kind: 'production',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        sessionId: 'canonical-session-scoped',
        channelId: 'voice-number-1',
        environment: 'production',
        source: 'twilio_voice',
        authType: 'twilio_media_stream',
        traceId: 'trace-1',
        actor: { kind: 'contact', contactId: 'contact-1' },
        subject: { kind: 'contact', contactId: 'contact-1' },
        identityEvidence: {
          identityTier: 2,
          verificationMethod: 'provider',
          artifacts: [{ type: 'caller_id', valueHash: 'hash-1' }],
        },
        callerContext: {
          tenantId: 'tenant-1',
          channel: 'voice_twilio',
          channelId: 'voice-number-1',
          contactId: 'contact-1',
          identityTier: 2,
          verificationMethod: 'provider',
        },
      },
    });

    expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
      mockResolvedAgent,
      expect.objectContaining({
        scope: expect.objectContaining({
          kind: 'production',
          sessionId: 'canonical-session-scoped',
          subject: { kind: 'contact', contactId: 'contact-1' },
        }),
      }),
    );
  });

  it('passes a caller-supplied canonical sessionId through the multi-DSL compile path', async () => {
    await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      channelType: 'http_async',
      sessionId: 'canonical-session-2',
    });

    expect(mockCompileProjectWorkingCopy).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      entryAgentName: 'entry_agent',
      environment: 'dev',
      agents: [
        {
          name: 'entry_agent',
          dslContent: 'AGENT entry_agent',
          systemPromptLibraryRef: null,
        },
      ],
    });
    expect(mockCompileToResolvedAgent).not.toHaveBeenCalled();
    expect(mockResolveProjectTools).not.toHaveBeenCalled();
    expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
      mockResolvedAgent,
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        channelType: 'http_async',
        sessionId: 'canonical-session-2',
        sessionMaxAgeSeconds: 1200,
        sessionIdleSeconds: 300,
      }),
    );
  });

  it('loads project config variables for multi-DSL compile-time resolution', async () => {
    mockCompileProjectWorkingCopy.mockResolvedValueOnce({
      resolved: mockResolvedAgent,
      configVariables: {
        AUTH_PROFILE: 'project-profile',
        FEATURE_FLAG: 'enabled',
      },
      warnings: [],
    });

    await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      channelType: 'sdk_websocket',
      sessionId: 'canonical-session-config-vars',
    });

    expect(mockCompileProjectWorkingCopy).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      entryAgentName: 'entry_agent',
      environment: 'dev',
      agents: [
        {
          name: 'entry_agent',
          dslContent: 'AGENT entry_agent',
          systemPromptLibraryRef: null,
        },
      ],
    });
    expect(mockCompileToResolvedAgent).not.toHaveBeenCalled();
    expect(mockResolveProjectTools).not.toHaveBeenCalled();
    expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
      mockResolvedAgent,
      expect.objectContaining({
        sessionId: 'canonical-session-config-vars',
      }),
    );
  });

  it('passes persisted prompt-library refs into canonical working-copy compilation', async () => {
    mockFindProjectWithAgents.mockResolvedValueOnce({
      entryAgentName: 'entry_agent',
      agents: [
        {
          name: 'entry_agent',
          dslContent: 'AGENT entry_agent',
          dslValidationStatus: 'valid',
          systemPromptLibraryRef: {
            promptId: 'pl_prompt_1',
            versionId: 'plv_version_1',
          },
        },
      ],
    });

    await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      channelType: 'sdk_websocket',
    });

    expect(mockCompileProjectWorkingCopy).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'project-1',
      entryAgentName: 'entry_agent',
      environment: 'dev',
      agents: [
        {
          name: 'entry_agent',
          dslContent: 'AGENT entry_agent',
          systemPromptLibraryRef: {
            promptId: 'pl_prompt_1',
            versionId: 'plv_version_1',
          },
        },
      ],
    });
    expect(mockCompileToResolvedAgent).not.toHaveBeenCalled();
    expect(mockResolveProjectTools).not.toHaveBeenCalled();
  });

  it('rejects working-copy sessions when any project agent DSL has validation errors', async () => {
    mockFindProjectWithAgents.mockResolvedValueOnce({
      entryAgentName: 'entry_agent',
      agents: [
        {
          name: 'entry_agent',
          dslContent: 'AGENT entry_agent',
          dslValidationStatus: 'error',
          dslDiagnostics: [{ severity: 'error', message: 'Unknown HANDOFF target' }],
        },
      ],
    });

    await expect(
      createRuntimeSession({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        channelType: 'sdk_websocket',
        sessionId: 'canonical-session-invalid-draft',
      }),
    ).rejects.toThrow('Project DSL has validation errors');

    expect(mockResolveProjectTools).not.toHaveBeenCalled();
    expect(mockCompileToResolvedAgent).not.toHaveBeenCalled();
    expect(mockCreateSessionFromResolved).not.toHaveBeenCalled();
  });

  it('rejects working-copy sessions when persisted runtime config is not execution-ready', async () => {
    mockFindProjectWithAgents.mockResolvedValueOnce({
      entryAgentName: 'entry_agent',
      agents: [
        {
          name: 'entry_agent',
          dslContent: 'AGENT entry_agent',
          dslValidationStatus: 'valid',
          dslDiagnostics: [],
        },
      ],
    });
    mockFindProjectRuntimeConfig.mockResolvedValueOnce({
      extraction: {
        nlu_provider: 'advanced',
      },
    });

    await expect(
      createRuntimeSession({
        projectId: 'project-1',
        tenantId: 'tenant-1',
        channelType: 'sdk_websocket',
        sessionId: 'canonical-session-invalid-runtime-config',
      }),
    ).rejects.toThrow('Project DSL has validation errors');

    expect(mockCompileProjectWorkingCopy).not.toHaveBeenCalled();
    expect(mockCompileToResolvedAgent).not.toHaveBeenCalled();
    expect(mockCreateSessionFromResolved).not.toHaveBeenCalled();
  });

  it('materializes missing session data for deployment-resolved localization catalogs', async () => {
    mockLoadConfigVariablesMap.mockResolvedValueOnce({
      'locale:fr/_shared.json': JSON.stringify({
        conversation_complete: 'Conversation terminee.',
      }),
    });

    const result = await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      deploymentId: 'deployment-1',
      channelType: 'voice_twilio',
    });

    expect(result.runtimeSession.data.gatheredKeys).toBeInstanceOf(Set);
    expect(
      (
        result.runtimeSession.data.values.session as {
          _localizedMessageCatalog?: {
            locales?: Record<string, { shared?: { conversation_complete?: string } }>;
          };
        }
      )?._localizedMessageCatalog?.locales?.fr?.shared?.conversation_complete,
    ).toBe('Conversation terminee.');
  });

  it('materializes missing session data for multi-DSL localization catalogs', async () => {
    mockCompileProjectWorkingCopy.mockResolvedValueOnce({
      resolved: mockResolvedAgent,
      configVariables: {
        'locale:de/_shared.json': JSON.stringify({
          conversation_complete: 'Unterhaltung abgeschlossen.',
        }),
      },
      warnings: [],
    });

    const result = await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      channelType: 'sdk_websocket',
    });

    expect(result.runtimeSession.data.gatheredKeys).toBeInstanceOf(Set);
    expect(
      (
        result.runtimeSession.data.values.session as {
          _localizedMessageCatalog?: {
            locales?: Record<string, { shared?: { conversation_complete?: string } }>;
          };
        }
      )?._localizedMessageCatalog?.locales?.de?.shared?.conversation_complete,
    ).toBe('Unterhaltung abgeschlossen.');
  });

  it('derives runtime userId from callerContext.contactId when explicit userId is absent', async () => {
    await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      deploymentId: 'deployment-1',
      channelType: 'voice_twilio',
      callerContext: buildCallerContext({
        contactId: 'contact-1',
        customerId: 'customer-1',
        sessionPrincipalId: 'session-principal-1',
        anonymousId: '+15551230001',
      }),
    });

    expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
      mockResolvedAgent,
      expect.objectContaining({
        userId: 'contact-1',
      }),
    );
  });

  it('falls back to callerContext session principal when contact and customer identity are absent', async () => {
    await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      channelType: 'voice_twilio',
      callerContext: buildCallerContext({
        sessionPrincipalId: 'session-principal-2',
        anonymousId: '+15557654321',
      }),
    });

    expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
      mockResolvedAgent,
      expect.objectContaining({
        userId: 'session-principal-2',
      }),
    );
  });

  it('preserves an explicit caller-supplied userId when one is provided', async () => {
    await createRuntimeSession({
      projectId: 'project-1',
      tenantId: 'tenant-1',
      deploymentId: 'deployment-1',
      channelType: 'debug_websocket',
      userId: 'platform-user-1',
      callerContext: buildCallerContext({
        contactId: 'contact-should-not-win',
      }),
    });

    expect(mockCreateSessionFromResolved).toHaveBeenCalledWith(
      mockResolvedAgent,
      expect.objectContaining({
        userId: 'platform-user-1',
      }),
    );
  });
});
