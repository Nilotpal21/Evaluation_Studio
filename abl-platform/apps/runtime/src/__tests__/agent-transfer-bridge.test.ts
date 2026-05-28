import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const { mockRegistryFindSession, mockStoreGet, mockGetTransferSessionStore, mockGetVoiceSession } =
  vi.hoisted(() => ({
    mockRegistryFindSession: vi.fn(),
    mockStoreGet: vi.fn(),
    mockGetTransferSessionStore: vi.fn(),
    mockGetVoiceSession: vi.fn(),
  }));
const { mockPersistDeliveredAgentEvent } = vi.hoisted(() => ({
  mockPersistDeliveredAgentEvent: vi.fn(),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock('@agent-platform/agent-transfer', () => ({
  getVoiceGatewayRegistry: vi.fn(() => ({
    findSession: mockRegistryFindSession,
  })),
}));

vi.mock('../services/agent-transfer/index.js', () => ({
  getTransferSessionStore: mockGetTransferSessionStore,
  getTransferTraceEmitter: vi.fn(() => null),
}));

vi.mock('../services/voice/korevg/korevg-session.js', () => ({
  getVoiceSession: mockGetVoiceSession,
}));

vi.mock('../services/agent-transfer/transcript-persistence.js', () => ({
  getAgentTransferTranscriptPersistenceService: () => ({
    persistDeliveredAgentEvent: (...args: unknown[]) => mockPersistDeliveredAgentEvent(...args),
  }),
}));

import {
  AgentTransferMessageBridge,
  registerSessionWebSocket,
  unregisterSessionWebSocket,
  getSessionWebSocket,
} from '../services/agent-transfer/message-bridge.js';
import { _resetRegistryForTest } from '../services/agent-transfer/session-ws-registry.js';
import type { AgentEvent } from '@agent-platform/agent-transfer';

function createMockWs(readyState: number = 1 /* OPEN */): any {
  const closeHandlers: (() => void)[] = [];
  return {
    readyState,
    OPEN: 1,
    send: vi.fn(),
    close: vi.fn(),
    // Store close handlers so tests can fire them to simulate real WS close events.
    on(event: string, handler: () => void) {
      if (event === 'close') closeHandlers.push(handler);
    },
    // Test helper: fire all registered close handlers (simulates ws.emit('close')).
    _fireClose() {
      closeHandlers.forEach((h) => h());
    },
  };
}

describe('AgentTransferMessageBridge', () => {
  let bridge: AgentTransferMessageBridge;
  let bridgeInternals: AgentTransferMessageBridge & {
    handleCrossPodEvent(message: string): Promise<void>;
    publishCrossPod(sessionKey: string, event: AgentEvent): Promise<void>;
  };

  beforeEach(() => {
    bridge = new AgentTransferMessageBridge();
    bridgeInternals = bridge as AgentTransferMessageBridge & {
      handleCrossPodEvent(message: string): Promise<void>;
      publishCrossPod(sessionKey: string, event: AgentEvent): Promise<void>;
    };
    // Clean up any registered sockets from previous tests
    unregisterSessionWebSocket('session-1');
    unregisterSessionWebSocket('session-2');
    unregisterSessionWebSocket('contact-1');
    mockRegistryFindSession.mockReset();
    mockStoreGet.mockReset();
    mockGetTransferSessionStore.mockReset();
    mockGetVoiceSession.mockReset();
    mockPersistDeliveredAgentEvent.mockReset().mockResolvedValue(undefined);
    mockRegistryFindSession.mockReturnValue(undefined);
    mockStoreGet.mockResolvedValue(null);
    mockGetTransferSessionStore.mockReturnValue({ get: mockStoreGet });
    mockGetVoiceSession.mockReturnValue(undefined);
  });

  // --- Session WebSocket Registry ---

  describe('session WebSocket registry', () => {
    it('registers and retrieves a WebSocket for a session', () => {
      const ws = createMockWs();
      registerSessionWebSocket('session-1', ws);

      expect(getSessionWebSocket('session-1')).toBe(ws);
    });

    it('returns undefined for unregistered session', () => {
      expect(getSessionWebSocket('unknown')).toBeUndefined();
    });

    it('unregisters a WebSocket', () => {
      const ws = createMockWs();
      registerSessionWebSocket('session-1', ws);
      unregisterSessionWebSocket('session-1');

      expect(getSessionWebSocket('session-1')).toBeUndefined();
    });

    it('returns undefined when WebSocket is not open', () => {
      const ws = createMockWs(3); // CLOSED
      registerSessionWebSocket('session-1', ws);

      expect(getSessionWebSocket('session-1')).toBeUndefined();
    });

    it('cleans up closed WebSocket on get', () => {
      const ws = createMockWs(3); // CLOSED
      registerSessionWebSocket('session-1', ws);

      getSessionWebSocket('session-1'); // triggers cleanup
      // Registering a new one should work
      const ws2 = createMockWs();
      registerSessionWebSocket('session-1', ws2);
      expect(getSessionWebSocket('session-1')).toBe(ws2);
    });
  });

  // --- Message Bridge ---

  describe('routeAgentEvent', () => {
    const agentEvent: AgentEvent = {
      type: 'agent:message',
      sessionId: 'session-1',
      tenantId: 'tenant-1',
      contactId: 'contact-1',
      channel: 'chat',
      timestamp: '2026-03-06T12:00:00Z',
      data: { message: 'Hello from agent' },
    };

    it('delivers via WebSocket when client is connected', async () => {
      const ws = createMockWs();
      registerSessionWebSocket('session-1', ws);
      mockStoreGet.mockResolvedValue({
        tenantId: 'tenant-1',
        ownerId: 'contact-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      });

      await bridge.routeAgentEvent('session-1', agentEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ws.send).toHaveBeenCalledTimes(1);
      const sent = JSON.parse(ws.send.mock.calls[0][0]);
      expect(sent.type).toBe('agent_transfer_event');
      expect(sent.sessionId).toBe('session-1');
      expect(sent.event.type).toBe('agent:message');
      expect(sent.event.data).toEqual({ message: 'Hello from agent' });
      expect(mockPersistDeliveredAgentEvent).toHaveBeenCalledWith({
        transferSessionId: 'session-1',
        transferSession: expect.objectContaining({
          provider: 'smartassist',
          projectId: 'project-1',
        }),
        event: agentEvent,
        content: 'Hello from agent',
        deliveryChannel: 'websocket',
      });
    });

    it('persists WebSocket-delivered agent messages that use text/body fallback fields', async () => {
      const ws = createMockWs();
      registerSessionWebSocket('session-1', ws);
      mockStoreGet.mockResolvedValue({
        tenantId: 'tenant-1',
        ownerId: 'contact-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      });
      const textOnlyEvent: AgentEvent = {
        ...agentEvent,
        data: { text: 'Template text content', body: 'Body fallback content' },
      };

      await bridge.routeAgentEvent('session-1', textOnlyEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(mockPersistDeliveredAgentEvent).toHaveBeenCalledWith({
        transferSessionId: 'session-1',
        transferSession: expect.objectContaining({
          provider: 'smartassist',
          projectId: 'project-1',
        }),
        event: textOnlyEvent,
        content: 'Template text content',
        deliveryChannel: 'websocket',
      });
    });

    it('suppresses chat agent messages after the transfer session enters post_agent state', async () => {
      const ws = createMockWs();
      registerSessionWebSocket('session-1', ws);
      mockStoreGet.mockResolvedValue({
        tenantId: 'tenant-1',
        ownerId: 'contact-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'post_agent',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      });

      await bridge.routeAgentEvent('session-1', agentEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ws.send).not.toHaveBeenCalled();
      expect(mockPersistDeliveredAgentEvent).not.toHaveBeenCalled();
    });

    it('delivers chat CSAT messages while the transfer session is in post_agent state', async () => {
      const ws = createMockWs();
      registerSessionWebSocket('session-1', ws);
      mockStoreGet.mockResolvedValue({
        tenantId: 'tenant-1',
        ownerId: 'contact-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'post_agent',
        metadata: { postAgentAction: 'csat' },
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
        postAgentConfig: {
          action: 'csat',
          surveyType: 'inline',
        },
        csatSurveyType: 'inline',
        csatStartedAt: Date.now(),
      });

      await bridge.routeAgentEvent('session-1', agentEvent);
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ws.send).toHaveBeenCalledTimes(1);
      expect(mockPersistDeliveredAgentEvent).toHaveBeenCalledWith({
        transferSessionId: 'session-1',
        transferSession: expect.objectContaining({
          state: 'post_agent',
          postAgentConfig: expect.objectContaining({ action: 'csat' }),
        }),
        event: agentEvent,
        content: 'Hello from agent',
        deliveryChannel: 'websocket',
      });
    });

    it('suppresses duplicate chat disconnect banners after the transfer session enters post_agent state', async () => {
      const ws = createMockWs();
      registerSessionWebSocket('session-1', ws);
      mockStoreGet.mockResolvedValue({
        tenantId: 'tenant-1',
        ownerId: 'contact-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'post_agent',
        metadata: { postAgentAction: 'return' },
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      });

      await bridge.routeAgentEvent('session-1', {
        type: 'agent:disconnected',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-03-06T12:00:00Z',
        data: {
          originalType: 'remove_id_to_acc_identity',
        },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      expect(ws.send).not.toHaveBeenCalled();
      expect(mockPersistDeliveredAgentEvent).not.toHaveBeenCalled();
    });

    it('does not throw when no WebSocket is connected (non-WS channel)', async () => {
      const voiceEvent = { ...agentEvent, channel: 'voice' as const };
      await expect(bridge.routeAgentEvent('session-1', voiceEvent)).resolves.not.toThrow();
    });

    it('publishes chat events for cross-pod delivery when no local transport is available', async () => {
      const sessionKey = 'agent_transfer:tenant-1:contact-1:chat';
      const publishSpy = vi.spyOn(bridgeInternals, 'publishCrossPod').mockResolvedValue(undefined);

      await bridge.routeAgentEvent(sessionKey, {
        ...agentEvent,
        sessionId: sessionKey,
      });

      expect(publishSpy).toHaveBeenCalledWith(sessionKey, {
        ...agentEvent,
        sessionId: sessionKey,
      });
    });

    it('dials the agent into an active voice session on agent:connected', async () => {
      const voiceSession = {
        sendAgentMessage: vi.fn(),
        dialAgent: vi.fn().mockResolvedValue(undefined),
        playMessage: vi.fn(),
        hangup: vi.fn(),
      };
      mockStoreGet.mockResolvedValue({
        voiceData: { callSid: 'call-1' },
        providerData: {},
      });
      mockGetVoiceSession.mockImplementation((sessionId: string) =>
        sessionId === 'contact-1' ? voiceSession : undefined,
      );

      await bridge.routeAgentEvent('agent_transfer:t1:contact-1:voice', {
        type: 'agent:connected',
        sessionId: 'agent_transfer:t1:contact-1:voice',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'voice',
        timestamp: '2026-03-06T12:00:00Z',
        data: {
          transferURI: 'sip:agent@example.com',
          sipHeaders: [{ name: 'X-Test', value: '1' }],
          dialHeaders: { 'X-Conversation': 'conv-1' },
        },
      });

      expect(voiceSession.dialAgent).toHaveBeenCalledWith('sip:agent@example.com', {
        sipHeaders: [{ name: 'X-Test', value: '1' }],
        dialHeaders: { 'X-Conversation': 'conv-1' },
        abortPrompts: true,
      });
    });

    it('plays waiting messages and hangs up on terminal call status', async () => {
      const voiceSession = {
        sendAgentMessage: vi.fn(),
        dialAgent: vi.fn().mockResolvedValue(undefined),
        playMessage: vi.fn(),
        hangup: vi.fn(),
      };
      mockStoreGet.mockResolvedValue({
        voiceData: { callSid: 'call-1' },
        providerData: {},
      });
      mockGetVoiceSession.mockImplementation((sessionId: string) =>
        sessionId === 'contact-1' ? voiceSession : undefined,
      );

      await bridge.routeAgentEvent('agent_transfer:t1:contact-1:voice', {
        type: 'agent:waiting_message',
        sessionId: 'agent_transfer:t1:contact-1:voice',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'voice',
        timestamp: '2026-03-06T12:00:00Z',
        data: {
          message: 'Please continue to hold.',
          bargeIn: false,
          bargeInOnDTMF: true,
        },
      });

      await bridge.routeAgentEvent('agent_transfer:t1:contact-1:voice', {
        type: 'agent:call_status',
        sessionId: 'agent_transfer:t1:contact-1:voice',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'voice',
        timestamp: '2026-03-06T12:00:00Z',
        data: {
          callStatus: 'agent_hangup',
        },
      });

      expect(voiceSession.playMessage).toHaveBeenCalledWith('Please continue to hold.', {
        audioUrl: undefined,
        bargeIn: false,
        bargeInOnDTMF: true,
      });
      expect(voiceSession.hangup).toHaveBeenCalledWith('agent_hangup');
    });

    it('persists delivered voice agent messages after TTS delivery', async () => {
      const voiceSession = {
        sendAgentMessage: vi.fn(),
        dialAgent: vi.fn().mockResolvedValue(undefined),
        playMessage: vi.fn(),
        hangup: vi.fn(),
      };
      mockStoreGet.mockResolvedValue({
        tenantId: 'tenant-1',
        ownerId: 'contact-1',
        contactId: 'contact-1',
        channel: 'voice',
        provider: 'smartassist',
        providerSessionId: 'provider-voice-1',
        state: 'active',
        metadata: { conversationSessionId: 'voice-parent-1' },
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-voice-1',
          normalizedTransferChannel: 'voice',
          sourceChannelType: 'korevg',
        },
        voiceData: { callSid: 'call-1' },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 0,
        projectId: 'project-1',
      });
      mockGetVoiceSession.mockImplementation((sessionId: string) =>
        sessionId === 'contact-1' ? voiceSession : undefined,
      );

      const event: AgentEvent = {
        type: 'agent:message',
        sessionId: 'agent_transfer:t1:contact-1:voice',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'voice',
        timestamp: '2026-03-06T12:00:00Z',
        data: { message: 'Voice handoff message' },
      };

      await bridge.routeAgentEvent(event.sessionId, event);

      expect(voiceSession.sendAgentMessage).toHaveBeenCalledWith('Voice handoff message');
      expect(mockPersistDeliveredAgentEvent).toHaveBeenCalledWith({
        transferSessionId: event.sessionId,
        transferSession: expect.objectContaining({
          providerSessionId: 'provider-voice-1',
          projectId: 'project-1',
        }),
        event,
        content: 'Voice handoff message',
        deliveryChannel: 'voice_gateway',
      });
    });

    it('handles WebSocket send error gracefully', async () => {
      const ws = createMockWs();
      ws.send.mockImplementation(() => {
        throw new Error('Connection reset');
      });
      registerSessionWebSocket('session-1', ws);

      // Should not throw
      await expect(bridge.routeAgentEvent('session-1', agentEvent)).resolves.not.toThrow();
    });

    it('skips delivery when WebSocket is closed', async () => {
      const ws = createMockWs(3); // CLOSED
      registerSessionWebSocket('session-1', ws);

      await bridge.routeAgentEvent('session-1', agentEvent);

      expect(ws.send).not.toHaveBeenCalled();
    });

    it('concurrent routeAgentEvent calls for the same session both deliver', async () => {
      const ws = createMockWs();
      registerSessionWebSocket('session-1', ws);

      const transferSessionFixture = {
        tenantId: 'tenant-1',
        ownerId: 'contact-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'smartassist',
        providerSessionId: 'provider-1',
        state: 'active',
        metadata: {},
        providerData: {},
        routing: {
          runtimeSessionId: 'runtime-1',
          conversationSessionId: 'conversation-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
        },
        ownerPod: 'pod-1',
        lastHeartbeat: Date.now(),
        createdAt: Date.now(),
        updatedAt: Date.now(),
        ttl: 1800,
        projectId: 'project-1',
      };
      mockStoreGet.mockResolvedValue(transferSessionFixture);
      mockGetTransferSessionStore.mockReturnValue({ get: mockStoreGet });

      const eventA: AgentEvent = {
        type: 'agent:message',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-03-06T12:00:00Z',
        data: { message: 'first message' },
      };
      const eventB: AgentEvent = {
        type: 'agent:message',
        sessionId: 'session-1',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-03-06T12:00:01Z',
        data: { message: 'second message' },
      };

      // Fire both concurrently — neither should be dropped
      await Promise.all([
        bridge.routeAgentEvent('session-1', eventA),
        bridge.routeAgentEvent('session-1', eventB),
      ]);

      expect(ws.send).toHaveBeenCalledTimes(2);
      const sentMessages = ws.send.mock.calls.map((c: [string]) => JSON.parse(c[0]));
      const deliveredTexts = sentMessages.map(
        (m: { event: { data: { message: string } } }) => m.event.data.message,
      );
      expect(deliveredTexts).toContain('first message');
      expect(deliveredTexts).toContain('second message');
    });
  });

  describe('contactId alias collision — latest-wins (75711c17 / fb602f50)', () => {
    it('closes the displaced socket with code 4000 when a new WS registers under the same key', () => {
      const wsOld = createMockWs();
      const wsNew = createMockWs();

      registerSessionWebSocket('contact-1', wsOld);
      registerSessionWebSocket('contact-1', wsNew);

      expect(wsOld.close).toHaveBeenCalledWith(4000, 'superseded');
      expect(getSessionWebSocket('contact-1')).toBe(wsNew);
    });

    it('does not close the socket when re-registering the same WS instance', () => {
      const ws = createMockWs();

      registerSessionWebSocket('contact-1', ws);
      registerSessionWebSocket('contact-1', ws);

      expect(ws.close).not.toHaveBeenCalled();
      expect(getSessionWebSocket('contact-1')).toBe(ws);
    });

    it('does not close an already-closed displaced socket', () => {
      const wsOld = createMockWs(3 /* CLOSED */);
      const wsNew = createMockWs();

      registerSessionWebSocket('contact-1', wsOld);
      registerSessionWebSocket('contact-1', wsNew);

      // old socket is not OPEN — no close call expected
      expect(wsOld.close).not.toHaveBeenCalled();
      expect(getSessionWebSocket('contact-1')).toBe(wsNew);
    });
  });

  describe('close-handler ownership guard — displaced socket must not evict replacement', () => {
    beforeEach(() => _resetRegistryForTest());
    afterEach(() => _resetRegistryForTest());

    it('replacement socket survives after the displaced socket fires its close event', () => {
      const wsOld = createMockWs();
      const wsNew = createMockWs();

      registerSessionWebSocket('key-1', wsOld);
      // Replace wsOld with wsNew — wsOld has a close handler registered from above
      registerSessionWebSocket('key-1', wsNew);

      // Simulate the displaced socket's close event firing (e.g. TCP RST arrives later)
      wsOld._fireClose();

      // The replacement must still be in the registry
      expect(getSessionWebSocket('key-1')).toBe(wsNew);
    });

    it('legitimate close from the current owner removes the entry', () => {
      const ws = createMockWs();

      registerSessionWebSocket('key-2', ws);
      ws._fireClose();

      expect(getSessionWebSocket('key-2')).toBeUndefined();
    });
  });

  describe('contactId alias tenant isolation — keys are namespaced so same contactId on different tenants gets different registry slots', () => {
    beforeEach(() => _resetRegistryForTest());
    afterEach(() => _resetRegistryForTest());

    it('tenantA:contactId and tenantB:contactId resolve to different sockets', () => {
      const wsA = createMockWs();
      const wsB = createMockWs();

      registerSessionWebSocket('tenant-a:user-999', wsA);
      registerSessionWebSocket('tenant-b:user-999', wsB);

      expect(getSessionWebSocket('tenant-a:user-999')).toBe(wsA);
      expect(getSessionWebSocket('tenant-b:user-999')).toBe(wsB);
    });

    it('bare contactId (legacy, no namespace) does not collide with a namespaced entry', () => {
      const wsLegacy = createMockWs();
      const wsNamespaced = createMockWs();

      registerSessionWebSocket('user-999', wsLegacy);
      registerSessionWebSocket('tenant-x:user-999', wsNamespaced);

      // Namespaced key has a different slot — no displacement
      expect(getSessionWebSocket('user-999')).toBe(wsLegacy);
      expect(getSessionWebSocket('tenant-x:user-999')).toBe(wsNamespaced);
    });
  });

  describe('cross-pod local-miss — publishCrossPod fallback (8157dd45)', () => {
    it('publishes cross-pod when getSessionWebSocket returns undefined and channel delivery fails', async () => {
      const sessionKey = 'agent_transfer:tenant-1:contact-1:chat';
      const publishSpy = vi.spyOn(bridgeInternals, 'publishCrossPod').mockResolvedValue(undefined);

      // No WS registered for any lookup key — simulates session on a different pod
      const event: AgentEvent = {
        type: 'agent:message',
        sessionId: sessionKey,
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-05-06T00:00:00Z',
        data: { message: 'Hello from agent' },
      };

      await bridge.routeAgentEvent(sessionKey, event);

      expect(publishSpy).toHaveBeenCalledWith(sessionKey, event);
    });
  });

  describe('cross-pod relay validation', () => {
    it('drops relayed events when tenantId only matches a non-tenant session-key segment', async () => {
      const routeSpy = vi.spyOn(bridge, 'routeAgentEvent').mockResolvedValue(undefined);

      await bridgeInternals.handleCrossPodEvent(
        JSON.stringify({
          sourcePod: '__other_pod__',
          sessionKey: 'agent_transfer:tenant-b:tenant-a-contact:chat',
          event: {
            type: 'agent:message',
            sessionId: 'agent_transfer:tenant-b:tenant-a-contact:chat',
            tenantId: 'tenant-a',
            contactId: 'tenant-a-contact',
            channel: 'chat',
            timestamp: '2026-03-06T12:00:00Z',
            data: { message: 'Hello from agent' },
          },
        }),
      );

      expect(routeSpy).not.toHaveBeenCalled();
    });

    it('drops relayed events when event.sessionId does not match the relayed session key', async () => {
      const routeSpy = vi.spyOn(bridge, 'routeAgentEvent').mockResolvedValue(undefined);
      const relayedEvent: AgentEvent = {
        type: 'agent:message',
        sessionId: 'agent_transfer:tenant-1:other-contact:chat',
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        timestamp: '2026-03-06T12:00:00Z',
        data: { message: 'Hello from agent' },
      };

      await bridgeInternals.handleCrossPodEvent(
        JSON.stringify({
          sourcePod: '__other_pod__',
          sessionKey: 'agent_transfer:tenant-1:contact-1:chat',
          event: relayedEvent,
        }),
      );

      expect(routeSpy).not.toHaveBeenCalled();
    });
  });
});
