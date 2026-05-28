import { describe, it, expect, vi, beforeEach } from 'vitest';

const mockFindProjectSettings = vi.fn();
const mockGetVoiceSession = vi.fn();

// Mock agent-transfer singletons BEFORE importing routing-executor
vi.mock('../services/agent-transfer/index.js', () => ({
  getAdapterRegistry: vi.fn(),
  getTransferSessionStore: vi.fn(),
  isAgentTransferInitialized: vi.fn(),
  getTransferTraceEmitter: vi.fn(() => null),
}));

vi.mock('../db/index.js', () => ({
  isDatabaseReady: vi.fn().mockReturnValue(false),
}));

vi.mock('../repos/project-settings-repo.js', () => ({
  findProjectSettings: (...args: unknown[]) => mockFindProjectSettings(...args),
}));

vi.mock('../services/voice/korevg/korevg-session.js', () => ({
  getVoiceSession: (...args: unknown[]) => mockGetVoiceSession(...args),
}));

import { RoutingExecutor } from '../services/execution/routing-executor.js';
import { isDatabaseReady } from '../db/index.js';
import {
  getAdapterRegistry,
  getTransferSessionStore,
  isAgentTransferInitialized,
} from '../services/agent-transfer/index.js';

function createMockSession(overrides = {}) {
  return {
    id: 'sess-1',
    agentName: 'test-agent',
    tenantId: 'tenant-1',
    projectId: 'project-1',
    data: { values: {}, gatheredKeys: new Set() },
    conversationHistory: [],
    initialized: true,
    traceVerbosity: 'standard',
    agentIR: {
      coordination: {
        escalation: {
          triggers: [],
          context_for_human: [],
          on_human_complete: [],
          routing: {
            connection: 'kore',
            queue: 'support',
            skills: ['billing'],
            priority: 3,
            post_agent: 'return',
          },
        },
      },
    },
    ...overrides,
  } as any;
}

function createMockCtx() {
  return {
    config: { maxConcurrentFanOutCalls: 5 },
    executeMessage: vi.fn(),
    getSession: vi.fn(),
  } as any;
}

function createMockLLMWiring() {
  return {} as any;
}

describe('handleEscalate → agent-transfer wiring', () => {
  let executor: RoutingExecutor;
  const mockExecute = vi.fn();
  const mockCreate = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    mockGetVoiceSession.mockReset();
    mockGetVoiceSession.mockReturnValue(undefined);
    executor = new RoutingExecutor(createMockCtx(), createMockLLMWiring());
    mockFindProjectSettings.mockResolvedValue(null);

    // Default: agent-transfer initialized with working adapter + store
    (isAgentTransferInitialized as any).mockReturnValue(true);
    (isDatabaseReady as any).mockReturnValue(false);
    (getAdapterRegistry as any).mockReturnValue({
      get: vi.fn().mockReturnValue({
        name: 'kore',
        execute: mockExecute,
      }),
    });
    (getTransferSessionStore as any).mockReturnValue({
      create: mockCreate,
    });
    mockCreate.mockResolvedValue({ success: true, sessionKey: 'at:tenant-1:c1:chat' });
    mockExecute.mockResolvedValue({ success: true, status: 'queued', providerSessionId: 'prov-1' });
  });

  it('calls adapter.execute when routing is configured', async () => {
    const session = createMockSession();
    const result = await executor.handleEscalate(session, {
      reason: 'Customer needs billing help',
    });

    expect(result.success).toBe(true);
    expect(session.isEscalated).toBe(true);
    expect(session.transferInitiated).toBe(true);
    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        projectId: 'project-1',
        agentId: 'test-agent',
        contactId: 'sess-1',
        sessionId: 'sess-1',
        postAgentAction: 'return',
      }),
    );
  });

  it('builds the canonical routing envelope for escalation payloads', async () => {
    const session = createMockSession({
      channelType: 'sdk_websocket',
      callerContext: {
        tenantId: 'tenant-1',
        channel: 'sdk_websocket',
        channelId: 'conn-1',
        contactId: 'contact-1',
        customerId: 'customer-1',
        anonymousId: 'anon-1',
        identityTier: 2,
        verificationMethod: 'sdk_session',
        channelArtifactType: 'device_id',
        contactDisplayName: 'Taylor Customer',
        contactContext: {
          firstName: 'Taylor',
          email: 'taylor@example.com',
          phone: '+15551234567',
        },
      },
      data: {
        values: {
          session: {
            conversationSessionId: 'conversation-1',
            externalSessionKey: 'sdk:customer-1',
            interaction: {
              current: {
                language: 'en',
                locale: 'en-US',
                timezone: 'America/New_York',
              },
            },
          },
          customer_id: 'customer-1',
        },
        gatheredKeys: new Set(),
      },
    });

    await executor.handleEscalate(session, {
      reason: 'Customer needs billing help',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        contactId: 'contact-1',
        channel: 'chat',
        language: 'en',
        routing: {
          runtimeSessionId: 'sess-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
          channelConnectionId: 'conn-1',
          externalSessionKey: 'sdk:customer-1',
        },
        contextSnapshot: {
          identityHints: {
            customerId: 'customer-1',
            anonymousId: 'anon-1',
            identityTier: 2,
            verificationMethod: 'sdk_session',
            channelArtifactType: 'device_id',
          },
          contact: {
            firstName: 'Taylor',
            displayName: 'Taylor Customer',
            email: 'taylor@example.com',
            phone: '+15551234567',
            customerId: 'customer-1',
          },
          interactionContext: {
            language: 'en',
            locale: 'en-US',
            timezone: 'America/New_York',
          },
        },
      }),
    );
  });

  it('normalizes voice gateway channels and forwards voiceData', async () => {
    const session = createMockSession({
      channelType: 'korevg',
      callerContext: {
        channel: 'korevg',
        contactContext: { phone: '+15551234567' },
      },
    });
    mockGetVoiceSession.mockReturnValue({
      getVoiceTransferData: () => ({
        callSid: 'call-1',
        caller: '+15551234567',
        called: '+18005550199',
        sipCallId: 'sip-1',
      }),
    });

    await executor.handleEscalate(session, {
      reason: 'Customer needs a live agent',
    });

    expect(mockExecute).toHaveBeenCalledWith(
      expect.objectContaining({
        channel: 'voice',
        routing: expect.objectContaining({
          normalizedTransferChannel: 'voice',
          sourceChannelType: 'korevg',
          voice: expect.objectContaining({
            callSid: 'call-1',
            sipCallId: 'sip-1',
            gateway: 'korevg',
          }),
        }),
        voiceData: expect.objectContaining({
          callSid: 'call-1',
          caller: '+15551234567',
          called: '+18005550199',
          sipCallId: 'sip-1',
        }),
      }),
    );
  });

  it('still succeeds when agent-transfer is not initialized (HITL fallback)', async () => {
    (isAgentTransferInitialized as any).mockReturnValue(false);
    const session = createMockSession();
    const result = await executor.handleEscalate(session, { reason: 'Needs human help' });

    expect(result.success).toBe(true);
    expect(session.isEscalated).toBe(true);
    expect(session.transferInitiated).toBeUndefined();
  });

  it('still succeeds when routing config is absent (HITL fallback)', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          escalation: {
            triggers: [],
            context_for_human: [],
            on_human_complete: [],
            // no routing
          },
        },
      },
    });
    const result = await executor.handleEscalate(session, { reason: 'Basic escalation' });

    expect(result.success).toBe(true);
    expect(session.isEscalated).toBe(true);
    expect(session.transferInitiated).toBeUndefined();
  });

  it('does not query project settings fallback when the database is not ready', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          escalation: {
            triggers: [],
            context_for_human: [],
            on_human_complete: [],
          },
        },
      },
    });

    const result = await executor.handleEscalate(session, { reason: 'Need fallback routing' });

    expect(result).toMatchObject({ success: true });
    expect(mockFindProjectSettings).not.toHaveBeenCalled();
    expect(session.transferInitiated).toBeUndefined();
  });

  it('still succeeds when adapter is not found (HITL fallback)', async () => {
    (getAdapterRegistry as any).mockReturnValue({
      get: vi.fn().mockReturnValue(undefined),
    });
    const session = createMockSession();
    const result = await executor.handleEscalate(session, { reason: 'Adapter missing' });

    expect(result.success).toBe(true);
    expect(session.isEscalated).toBe(true);
  });

  it('fails safely when human-resolution persistence is required but unavailable', async () => {
    const session = createMockSession({
      agentIR: {
        coordination: {
          escalation: {
            triggers: [],
            context_for_human: [],
            on_human_complete: [{ condition: 'always', action: 'continue' }],
            routing: {
              connection: 'kore',
            },
          },
        },
      },
    });

    const result = await executor.handleEscalate(session, { reason: 'Need a human review' });

    expect(result).toMatchObject({
      success: false,
      error: 'ESCALATION_PERSISTENCE_UNAVAILABLE',
    });
    expect(session.isEscalated).toBe(false);
    expect(session.escalationReason).toBeUndefined();
    expect(session.transferInitiated).toBe(false);
  });
});
