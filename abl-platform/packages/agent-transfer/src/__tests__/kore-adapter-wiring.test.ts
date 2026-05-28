/**
 * Tests for KoreAdapter Phase 1 wiring:
 * - sendUserMessage resolves session and calls sendEvent
 * - sendControlEvent sends correct eventName per event type
 * - endSession sends close event then cleans up
 * - endSession skips close event when reason is 'agent_closed'
 * - runPreChecks skips availability when queue is set
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KoreAdapter, type TransferSessionStoreHandle } from '../adapters/kore/index.js';
import type { SmartAssistConfig } from '../config/schema.js';
import type { TransferPayload, UserMessage } from '../types.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

// Mock SmartAssistClient — we intercept the constructor
const mockSendEvent = vi.fn().mockResolvedValue({ success: true });
const mockCheckAgentAvailability = vi.fn().mockResolvedValue({ success: true, data: true });
const mockCheckBusinessHours = vi.fn().mockResolvedValue({ success: true, data: true });
const mockValidateQueue = vi.fn().mockResolvedValue({ success: true, data: true });
const mockInitTransfer = vi.fn().mockResolvedValue({
  success: true,
  status: 'transferred',
  providerSessionId: 'conv-123',
});
const mockClose = vi.fn().mockResolvedValue(undefined);

vi.mock('../adapters/kore/smartassist-client.js', () => ({
  SmartAssistClient: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.sendEvent = mockSendEvent;
    this.checkAgentAvailability = mockCheckAgentAvailability;
    this.checkBusinessHours = mockCheckBusinessHours;
    this.validateQueue = mockValidateQueue;
    this.initTransfer = mockInitTransfer;
    this.close = mockClose;
  }),
}));

vi.mock('../adapters/kore/event-handler.js', () => ({
  KoreEventHandler: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.onAgentMessage = vi.fn();
    this.handlerCount = vi.fn().mockReturnValue(0);
    this.clear = vi.fn();
    this.processEvent = vi.fn();
  }),
}));

vi.mock('../../session/types.js', async () => {
  return {
    sessionKey: (tenantId: string, contactId: string, channel: string) =>
      `agent_transfer:${tenantId}:${contactId}:${channel}`,
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockSessionStore(
  overrides: Partial<TransferSessionStoreHandle> = {},
): TransferSessionStoreHandle {
  return {
    create: vi.fn().mockResolvedValue({ success: true, sessionKey: 'agent_transfer:t1:c1:chat' }),
    get: vi.fn().mockResolvedValue({
      tenantId: 't1',
      contactId: 'c1',
      channel: 'chat',
      provider: 'kore',
      providerSessionId: 'conv-456',
    }),
    end: vi.fn().mockResolvedValue(undefined),
    extendTTL: vi.fn().mockResolvedValue(undefined),
    getByProvider: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

const SMART_ASSIST_CONFIG: SmartAssistConfig = {
  baseUrl: 'https://smartassist.example.com',
  apiKey: 'test-key',
  timeoutMs: 5000,
  retry: { maxAttempts: 1, backoffMs: 100, backoffMultiplier: 2 },
} as SmartAssistConfig;

function createAdapter(sessionStore?: TransferSessionStoreHandle): KoreAdapter {
  return new KoreAdapter(SMART_ASSIST_CONFIG, sessionStore);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('KoreAdapter Phase 1 wiring', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // sendUserMessage
  // -------------------------------------------------------------------------
  describe('sendUserMessage', () => {
    it('resolves session and calls sendEvent with correct payload', async () => {
      const store = createMockSessionStore();
      const adapter = createAdapter(store);

      const message: UserMessage = {
        content: 'Hello agent',
        attachments: [
          {
            url: 'https://files.example.com/doc.pdf',
            name: 'doc.pdf',
            mimeType: 'application/pdf',
            size: 1024,
          },
        ],
      };

      await adapter.sendUserMessage('agent_transfer:t1:c1:chat', message);

      // Should resolve session via store.get
      expect(store.get).toHaveBeenCalledWith('agent_transfer:t1:c1:chat');

      // Should call sendEvent with correct structure
      expect(mockSendEvent).toHaveBeenCalledWith(
        'agent_transfer:t1:c1:chat',
        'conv-456',
        expect.objectContaining({
          eventName: 'start_kore_agent_chat_message_for_agent',
          payload: expect.objectContaining({
            conversationId: 'conv-456',
            author: { id: 'c1', type: 'USER' },
            type: 'text',
            value: 'Hello agent',
            event: 'user_message',
            attachments: [
              expect.objectContaining({
                url: 'https://files.example.com/doc.pdf',
                name: 'doc.pdf',
                mimeType: 'application/pdf',
                size: 1024,
              }),
            ],
          }),
          queryFields: { sid: 'agent_transfer:t1:c1:chat', cId: 'conv-456' },
        }),
      );

      // Should extend TTL after sending
      expect(store.extendTTL).toHaveBeenCalledWith('agent_transfer:t1:c1:chat');
    });

    it('returns early when session not found', async () => {
      const store = createMockSessionStore({
        get: vi.fn().mockResolvedValue(null),
      });
      const adapter = createAdapter(store);

      await adapter.sendUserMessage('agent_transfer:t1:c1:chat', { content: 'Hello' });

      expect(mockSendEvent).not.toHaveBeenCalled();
      expect(store.extendTTL).not.toHaveBeenCalled();
    });

    it('returns early when no providerSessionId', async () => {
      const store = createMockSessionStore({
        get: vi.fn().mockResolvedValue({
          tenantId: 't1',
          contactId: 'c1',
          channel: 'chat',
          providerSessionId: '',
        }),
      });
      const adapter = createAdapter(store);

      await adapter.sendUserMessage('agent_transfer:t1:c1:chat', { content: 'Hello' });

      expect(mockSendEvent).not.toHaveBeenCalled();
    });

    it('throws when client not configured', async () => {
      const adapter = new KoreAdapter(undefined, createMockSessionStore());

      await expect(
        adapter.sendUserMessage('agent_transfer:t1:c1:chat', { content: 'Hello' }),
      ).rejects.toThrow('SmartAssist client not configured');
    });
  });

  // -------------------------------------------------------------------------
  // sendControlEvent
  // -------------------------------------------------------------------------
  describe('sendControlEvent', () => {
    it('maps close_agent_chat to close_conversation eventName', async () => {
      const store = createMockSessionStore();
      const adapter = createAdapter(store);

      await adapter.sendControlEvent('agent_transfer:t1:c1:chat', 'close_agent_chat');

      expect(mockSendEvent).toHaveBeenCalledWith(
        'agent_transfer:t1:c1:chat',
        'conv-456',
        expect.objectContaining({
          eventName: 'close_conversation',
          payload: expect.objectContaining({
            conversationId: 'conv-456',
            author: { id: 'c1', type: 'USER' },
            event: 'close_agent_chat',
          }),
        }),
      );
    });

    it.each(['typing', 'stop_typing', 'message_read', 'message_delivered'] as const)(
      'maps %s to start_control_message_for_agent eventName',
      async (eventType) => {
        const store = createMockSessionStore();
        const adapter = createAdapter(store);

        await adapter.sendControlEvent('agent_transfer:t1:c1:chat', eventType);

        expect(mockSendEvent).toHaveBeenCalledWith(
          'agent_transfer:t1:c1:chat',
          'conv-456',
          expect.objectContaining({
            eventName: 'start_control_message_for_agent',
            payload: expect.objectContaining({
              event: eventType,
            }),
          }),
        );
      },
    );

    it('does nothing when client is not configured', async () => {
      const adapter = new KoreAdapter(undefined, createMockSessionStore());

      await adapter.sendControlEvent('agent_transfer:t1:c1:chat', 'typing');

      expect(mockSendEvent).not.toHaveBeenCalled();
    });

    it('does nothing when session is not found', async () => {
      const store = createMockSessionStore({
        get: vi.fn().mockResolvedValue(null),
      });
      const adapter = createAdapter(store);

      await adapter.sendControlEvent('agent_transfer:t1:c1:chat', 'typing');

      expect(mockSendEvent).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // endSession
  // -------------------------------------------------------------------------
  describe('endSession', () => {
    it('sends close event then cleans up session', async () => {
      const store = createMockSessionStore();
      const adapter = createAdapter(store);

      const callOrder: string[] = [];
      mockSendEvent.mockImplementation(async () => {
        callOrder.push('sendEvent');
        return { success: true };
      });
      (store.end as ReturnType<typeof vi.fn>).mockImplementation(async () => {
        callOrder.push('end');
      });

      await adapter.endSession('agent_transfer:t1:c1:chat', 'user_closed');

      // Close event should be sent before session end
      expect(callOrder).toEqual(['sendEvent', 'end']);
      expect(store.end).toHaveBeenCalledWith('agent_transfer:t1:c1:chat');
    });

    it('skips close event when reason is agent_closed', async () => {
      const store = createMockSessionStore();
      const adapter = createAdapter(store);

      await adapter.endSession('agent_transfer:t1:c1:chat', 'agent_closed');

      // Should NOT send close event
      expect(mockSendEvent).not.toHaveBeenCalled();
      // Should still clean up session
      expect(store.end).toHaveBeenCalledWith('agent_transfer:t1:c1:chat');
    });

    it('still cleans up session when close event fails', async () => {
      const store = createMockSessionStore();
      const adapter = createAdapter(store);

      mockSendEvent.mockRejectedValueOnce(new Error('Network error'));

      await adapter.endSession('agent_transfer:t1:c1:chat', 'timeout');

      // Session cleanup should still happen
      expect(store.end).toHaveBeenCalledWith('agent_transfer:t1:c1:chat');
    });
  });

  // -------------------------------------------------------------------------
  // runPreChecks — queue skips availability
  // -------------------------------------------------------------------------
  describe('runPreChecks (via execute)', () => {
    it('skips availability check when queue is set', async () => {
      const store = createMockSessionStore();
      const adapter = createAdapter(store);

      const payload: TransferPayload = {
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'agent-1',
        contactId: 'c1',
        sessionId: 'sess-1',
        channel: 'chat',
        queue: 'support-queue',
      };

      await adapter.execute(payload);

      // Availability check should NOT have been called
      expect(mockCheckAgentAvailability).not.toHaveBeenCalled();
      // Queue validation should still have been called
      expect(mockValidateQueue).toHaveBeenCalled();
    });

    it('runs availability check when no queue is set', async () => {
      const store = createMockSessionStore();
      const adapter = createAdapter(store);

      const payload: TransferPayload = {
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'agent-1',
        contactId: 'c1',
        sessionId: 'sess-1',
        channel: 'chat',
      };

      await adapter.execute(payload);

      expect(mockCheckAgentAvailability).toHaveBeenCalled();
    });

    it('returns no_agents when availability check fails and no queue', async () => {
      const store = createMockSessionStore();
      const adapter = createAdapter(store);
      mockCheckAgentAvailability.mockResolvedValueOnce({ success: false });

      const payload: TransferPayload = {
        tenantId: 't1',
        projectId: 'p1',
        agentId: 'agent-1',
        contactId: 'c1',
        sessionId: 'sess-1',
        channel: 'chat',
      };

      const result = await adapter.execute(payload);

      expect(result.success).toBe(false);
      expect(result.status).toBe('no_agents');
    });
  });

  // -------------------------------------------------------------------------
  // handleInboundEvent — agent_disconnect triggers cleanup
  // -------------------------------------------------------------------------
  describe('handleInboundEvent agent_disconnect', () => {
    it('triggers session cleanup on agent_disconnect event', async () => {
      const store = createMockSessionStore({
        getByProvider: vi.fn().mockResolvedValue({
          tenantId: 't1',
          contactId: 'c1',
          channel: 'chat',
          provider: 'kore',
          providerSessionId: 'conv-789',
        }),
      });
      const adapter = createAdapter(store);

      await adapter.handleInboundEvent(
        {
          type: 'agent_disconnect',
          conversationId: 'conv-789',
        },
        't1',
      );

      expect(store.end).toHaveBeenCalledWith('agent_transfer:t1:c1:chat');
    });
  });
});
