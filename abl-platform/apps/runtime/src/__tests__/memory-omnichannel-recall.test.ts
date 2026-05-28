import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeSession } from '../services/execution/types.js';
import {
  initializeActivatedAgentMemory,
  initializeAllMemory,
} from '../services/execution/memory-integration.js';

const { mockGetRecallMessages, mockGetOmnichannelSettings, MockRecallService } = vi.hoisted(() => {
  const mockGetRecallMessages = vi.fn();
  const mockGetOmnichannelSettings = vi.fn();
  const MockRecallService = vi.fn().mockImplementation(function MockRecallService() {
    return {
      getRecallMessages: (...args: unknown[]) => mockGetRecallMessages(...args),
    };
  });

  return {
    mockGetRecallMessages,
    mockGetOmnichannelSettings,
    MockRecallService,
  };
});

vi.mock('../services/omnichannel/recall-service.js', () => ({
  RecallService: MockRecallService,
}));

vi.mock('../services/omnichannel/omnichannel-settings-service.js', () => ({
  getOmnichannelSettings: (...args: unknown[]) => mockGetOmnichannelSettings(...args),
}));

function createSession(overrides?: Partial<RuntimeSession>): RuntimeSession {
  return {
    id: 'test-session-1',
    agentName: 'TestAgent',
    agentIR: null,
    compilationOutput: null,
    conversationHistory: [],
    state: { gatherProgress: {}, conversationPhase: 'start', context: {} },
    data: { values: {}, gatheredKeys: new Set() },
    isComplete: false,
    isEscalated: false,
    handoffStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
    tenantId: 'tenant-1',
    projectId: 'project-1',
    userId: 'contact-1',
    callerContext: {
      tenantId: 'tenant-1',
      channel: 'sdk_websocket',
      contactId: 'contact-1',
      sessionPrincipalId: 'sessp-1',
      identityTier: 2,
      verificationMethod: 'oauth',
    },
    ...overrides,
  } as RuntimeSession;
}

function makeAgentIR(name = 'TestAgent'): any {
  return {
    metadata: { name },
    omnichannel: {
      recall: {
        enabled: true,
        maxMessages: 5,
      },
    },
    memory: {
      session: [],
      persistent: [],
      remember: [],
      recall: [],
    },
  };
}

describe('memory integration omnichannel recall wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetOmnichannelSettings.mockResolvedValue({
      identity: { minTier: 1 },
      recall: {
        enabled: true,
        maxMessages: 20,
        maxAgeDays: 30,
        defaultAllowedChannels: [],
      },
    });
    mockGetRecallMessages.mockResolvedValue({
      messages: [{ id: 'msg-1', text: 'hello again' }],
      metadata: {
        matchedSessions: 1,
        truncated: false,
        payloadBytes: 128,
      },
    });
  });

  it('hydrates omnichannel recall during initializeAllMemory', async () => {
    const session = createSession();
    const agentIR = makeAgentIR();

    await initializeAllMemory(session, agentIR);

    expect(mockGetOmnichannelSettings).toHaveBeenCalledWith('tenant-1', 'project-1');
    expect(mockGetRecallMessages).toHaveBeenCalledWith({
      sessionId: 'test-session-1',
      tenantId: 'tenant-1',
      projectId: 'project-1',
      contactId: 'contact-1',
      maxMessages: 5,
      maxAgeDays: 30,
      allowedChannels: undefined,
    });
    expect(session.data.values._omnichannel_recall).toEqual({
      messages: [{ id: 'msg-1', text: 'hello again' }],
      metadata: {
        matchedSessions: 1,
        truncated: false,
        payloadBytes: 128,
      },
    });
  });

  it('uses the channel contact identity for recall instead of the workspace user id', async () => {
    const session = createSession({
      userId: 'workspace-user-1',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'whatsapp',
        contactId: 'contact-42',
        customerId: 'customer-ignored',
        sessionPrincipalId: 'sessp-42',
        identityTier: 2,
        verificationMethod: 'otp',
      },
    });

    await initializeAllMemory(session, makeAgentIR());

    expect(mockGetRecallMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: 'test-session-1',
        tenantId: 'tenant-1',
        projectId: 'project-1',
        contactId: 'contact-42',
      }),
    );
    expect(mockGetRecallMessages).not.toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'workspace-user-1',
      }),
    );
  });

  it('hydrates omnichannel recall even when the agent has no FactStore memory config', async () => {
    const session = createSession();
    const agentIR = {
      metadata: { name: 'RecallOnlyAgent' },
      omnichannel: {
        recall: {
          enabled: true,
          maxMessages: 5,
        },
      },
    } as any;

    await initializeAllMemory(session, agentIR);

    expect(mockGetRecallMessages).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'contact-1',
        maxMessages: 5,
      }),
    );
    expect(session.data.values._omnichannel_recall).toEqual(
      expect.objectContaining({
        messages: [{ id: 'msg-1', text: 'hello again' }],
      }),
    );
    expect(session.data.values._memory_initialized_agent).toBe('RecallOnlyAgent');
  });

  it('hydrates omnichannel recall when a newly activated agent initializes memory', async () => {
    const session = createSession({
      data: { values: {}, gatheredKeys: new Set() },
    });
    const childAgentIR = makeAgentIR('ChildAgent');

    await initializeActivatedAgentMemory(session, childAgentIR);

    expect(mockGetRecallMessages).toHaveBeenCalledTimes(1);
    expect(session.data.values._omnichannel_recall).toEqual(
      expect.objectContaining({
        messages: [{ id: 'msg-1', text: 'hello again' }],
      }),
    );
    expect(session.data.values._memory_initialized_agent).toBe('ChildAgent');
  });
});
