import { beforeEach, describe, expect, it, vi } from 'vitest';

const {
  mockExecutor,
  mockResolve,
  mockLoadConfigVariablesMap,
  mockResolveProjectTools,
  mockCompileToResolvedAgent,
} = vi.hoisted(() => ({
  mockExecutor: {
    createSessionFromResolved: vi.fn(),
  },
  mockResolve: vi.fn(),
  mockLoadConfigVariablesMap: vi.fn(async () => ({})),
  mockResolveProjectTools: vi.fn(async () => new Map()),
  mockCompileToResolvedAgent: vi.fn(),
}));

const resolvedAgent = {
  agents: {
    entry_agent: { metadata: { name: 'entry_agent' } },
  },
  entryAgent: 'entry_agent',
  compilationOutput: {},
  sourceHash: 'working-copy',
  versionInfo: { versions: {} },
};

vi.mock('../../db/index.js', () => ({
  isDatabaseAvailable: vi.fn(() => true),
}));

vi.mock('../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: vi.fn(() => mockExecutor),
  compileToResolvedAgent: (...args: unknown[]) => mockCompileToResolvedAgent(...args),
  resolveProjectTools: (...args: unknown[]) => mockResolveProjectTools(...args),
}));

vi.mock('../../services/deployment-resolver.js', () => ({
  DeploymentResolver: class MockDeploymentResolver {
    resolve(...args: unknown[]) {
      return mockResolve(...args);
    }
  },
}));

vi.mock('../../services/session/session-service.js', () => ({
  getSessionService: vi.fn(() => ({})),
}));

vi.mock('../../repos/project-repo.js', () => ({
  loadConfigVariablesMap: (...args: unknown[]) => mockLoadConfigVariablesMap(...args),
}));

import {
  createSessionFromDSLs,
  resolveAndCreateSession,
} from '../../services/session/session-bootstrap.js';

describe('session bootstrap localization hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolve.mockResolvedValue(resolvedAgent);
    mockCompileToResolvedAgent.mockReturnValue(resolvedAgent);
    mockResolveProjectTools.mockResolvedValue(new Map());
    mockLoadConfigVariablesMap.mockResolvedValue({});
    mockExecutor.createSessionFromResolved.mockReturnValue({
      id: 'runtime-session-1',
      agentName: 'entry_agent',
      data: undefined,
    });
  });

  it('materializes the session data store for deployment-resolved localization catalogs', async () => {
    mockLoadConfigVariablesMap.mockResolvedValueOnce({
      'locale:fr/_shared.json': JSON.stringify({
        conversation_complete: 'Conversation terminee.',
      }),
    });

    const result = await resolveAndCreateSession(
      {
        projectId: 'project-1',
        tenantId: 'tenant-1',
        deploymentId: 'deploy-1',
        agentName: 'entry_agent',
      },
      {
        projectId: 'project-1',
        tenantId: 'tenant-1',
        channelType: 'debug_websocket',
        deploymentId: 'deploy-1',
      },
    );

    expect(result).not.toBeNull();
    expect(result?.runtimeSession.data.gatheredKeys).toBeInstanceOf(Set);
    expect(
      (
        result?.runtimeSession.data.values.session as {
          _localizedMessageCatalog?: {
            locales?: Record<string, { shared?: { conversation_complete?: string } }>;
          };
        }
      )?._localizedMessageCatalog?.locales?.fr?.shared?.conversation_complete,
    ).toBe('Conversation terminee.');
  });

  it('materializes the session data store for DSL-compiled localization catalogs', async () => {
    mockLoadConfigVariablesMap.mockResolvedValueOnce({
      'locale:de/_shared.json': JSON.stringify({
        conversation_complete: 'Unterhaltung abgeschlossen.',
      }),
    });

    const result = await createSessionFromDSLs(['AGENT entry_agent'], 'entry_agent', {
      projectId: 'project-1',
      tenantId: 'tenant-1',
      channelType: 'api',
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
});
