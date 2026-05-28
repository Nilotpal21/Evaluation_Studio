import { beforeEach, describe, expect, test, vi } from 'vitest';

const {
  mockExecutor,
  mockConversationStore,
  mockFlushMessageQueue,
  mockFindProjectSettings,
  mockFindProjectAgentForProject,
  mockIsDatabaseAvailable,
  mockIsConfigLoaded,
  mockGetConfig,
  mockCleanupClosedSessionArtifacts,
  mockIsSessionTerminalizationEnabled,
  mockTerminateConversationSession,
  mockPersistMessageRecord,
} = vi.hoisted(() => ({
  mockExecutor: {
    getSession: vi.fn(),
    saveSessionSnapshot: vi.fn(async () => {}),
    endSession: vi.fn(),
    detachSession: vi.fn(),
  },
  mockConversationStore: {
    endSession: vi.fn(async () => {}),
  },
  mockFlushMessageQueue: vi.fn(async () => {}),
  mockFindProjectSettings: vi.fn(),
  mockFindProjectAgentForProject: vi.fn(),
  mockIsDatabaseAvailable: vi.fn(() => true),
  mockIsConfigLoaded: vi.fn(() => true),
  mockGetConfig: vi.fn(() => ({
    channelLifecycle: {
      voice: {
        defaultDisposition: 'abandoned',
        disconnectBehavior: 'detach',
      },
    },
  })),
  mockCleanupClosedSessionArtifacts: vi.fn(async () => {}),
  mockIsSessionTerminalizationEnabled: vi.fn(() => true),
  mockPersistMessageRecord: vi.fn(async () => undefined),
  mockTerminateConversationSession: vi.fn(async () => ({
    sessionId: 'db-voice',
    disposition: 'completed',
    status: 'completed',
    endedAt: '2026-03-30T10:00:00.000Z',
    eventEmitted: true,
    eventId: 'evt-disconnect-1',
    hook: {
      attempted: true,
      mode: 'ignore',
      outcome: 'ignored',
    },
    runtimeEnded: true,
    dbUpdated: true,
    artifactSessionIds: ['rt-voice'],
  })),
}));

vi.mock('../../../services/runtime-executor.js', () => ({
  getRuntimeExecutor: () => mockExecutor,
}));

vi.mock('../../../services/stores/store-factory.js', () => ({
  getStores: () => ({
    conversation: mockConversationStore,
  }),
}));

vi.mock('../../../db/index.js', () => ({
  isDatabaseAvailable: mockIsDatabaseAvailable,
}));

vi.mock('../../../services/message-persistence-queue.js', () => ({
  flushMessageQueue: mockFlushMessageQueue,
  persistMessageRecord: mockPersistMessageRecord,
}));

vi.mock('../../../services/session-lifecycle/artifact-cleanup.js', () => ({
  cleanupClosedSessionArtifacts: mockCleanupClosedSessionArtifacts,
}));

vi.mock('../../../services/session-lifecycle/terminalization-service.js', () => ({
  isSessionTerminalizationEnabled: mockIsSessionTerminalizationEnabled,
  SessionTerminalizationService: class MockSessionTerminalizationService {
    terminateConversationSession = mockTerminateConversationSession;
  },
}));

vi.mock('../../../repos/project-settings-repo.js', () => ({
  findProjectSettings: mockFindProjectSettings,
}));

vi.mock('../../../repos/project-repo.js', () => ({
  findProjectAgentForProject: mockFindProjectAgentForProject,
}));

vi.mock('../../../config/loader.js', () => ({
  isConfigLoaded: mockIsConfigLoaded,
  getConfig: mockGetConfig,
}));

import { handleDisconnect } from '../lifecycle-manager.js';

describe('handleDisconnect', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecutor.getSession.mockReturnValue({
      id: 'rt-voice',
      agentName: 'VoiceAgent',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      agentIR: null,
      createdAt: new Date('2026-03-30T00:00:00.000Z'),
    });
    mockIsDatabaseAvailable.mockReturnValue(true);
    mockIsConfigLoaded.mockReturnValue(true);
    mockFindProjectSettings.mockResolvedValue(null);
    mockFindProjectAgentForProject.mockResolvedValue(null);
    mockIsSessionTerminalizationEnabled.mockReturnValue(true);
    mockTerminateConversationSession.mockResolvedValue({
      sessionId: 'db-voice',
      disposition: 'completed',
      status: 'completed',
      endedAt: '2026-03-30T10:00:00.000Z',
      eventEmitted: true,
      eventId: 'evt-disconnect-1',
      hook: {
        attempted: true,
        mode: 'ignore',
        outcome: 'ignored',
      },
      runtimeEnded: true,
      dbUpdated: true,
      artifactSessionIds: ['rt-voice'],
    });
  });

  test('uses the shared voice project override to end the runtime session', async () => {
    mockFindProjectSettings.mockResolvedValue({
      sessionLifecycle: {
        channels: {
          voice: {
            defaultDisposition: 'completed',
            disconnectBehavior: 'end',
          },
        },
      },
    });

    await handleDisconnect({
      channel: 'voice',
      sessionId: 'rt-voice',
      dbSessionId: 'db-voice',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });

    expect(mockExecutor.saveSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(mockTerminateConversationSession).toHaveBeenCalledWith({
      tenantId: 'tenant-1',
      projectId: 'proj-1',
      sessionId: 'db-voice',
      agentName: 'VoiceAgent',
      channel: 'voice',
      disposition: 'completed',
      source: 'disconnect',
    });
    expect(mockCleanupClosedSessionArtifacts).toHaveBeenCalledWith(['rt-voice']);
    expect(mockExecutor.endSession).not.toHaveBeenCalled();
    expect(mockExecutor.detachSession).not.toHaveBeenCalled();
    expect(mockFlushMessageQueue).toHaveBeenCalledWith('db-voice');
    expect(mockConversationStore.endSession).not.toHaveBeenCalled();
  });

  test('falls back to the legacy abandon-and-detach defaults when no policy resolves', async () => {
    mockIsConfigLoaded.mockReturnValue(false);

    await handleDisconnect({
      channel: 'voice',
      sessionId: 'rt-voice',
      dbSessionId: 'db-voice',
      tenantId: 'tenant-1',
      projectId: 'proj-1',
    });

    expect(mockExecutor.detachSession).toHaveBeenCalledWith('rt-voice');
    expect(mockExecutor.endSession).not.toHaveBeenCalled();
    expect(mockConversationStore.endSession).toHaveBeenCalledWith('db-voice', 'abandoned');
  });
});
