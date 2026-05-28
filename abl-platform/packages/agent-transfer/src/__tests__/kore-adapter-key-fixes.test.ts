/**
 * Tests for KoreAdapter session key fixes:
 * - C6: execute() uses sessionKey() instead of hardcoded "kore:" prefix
 * - I2: handleInboundEvent uses sessionKey() instead of inline template
 * - NEW-2: postAgentAction is correctly extracted from metadata JSON
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { KoreAdapter, type TransferSessionStoreHandle } from '../adapters/kore/index.js';
import { sessionKey } from '../session/types.js';
import type { TransferPayload } from '../types.js';
import type { XOEvent } from '../adapters/kore/event-handler.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

function createMockSessionStore(
  overrides: Partial<TransferSessionStoreHandle> = {},
): TransferSessionStoreHandle {
  return {
    create: vi.fn().mockResolvedValue({ success: true, sessionKey: 'mock-key' }),
    get: vi.fn().mockResolvedValue(null),
    end: vi.fn().mockResolvedValue(undefined),
    extendTTL: vi.fn().mockResolvedValue(undefined),
    getByProvider: vi.fn().mockResolvedValue(null),
    ...overrides,
  };
}

function createPayload(overrides: Partial<TransferPayload> = {}): TransferPayload {
  return {
    tenantId: 'tenant-1',
    projectId: 'proj-1',
    agentId: 'agent-1',
    contactId: 'contact-1',
    sessionId: 'sess-1',
    channel: 'chat',
    postAgentAction: 'end',
    ...overrides,
  };
}

describe('KoreAdapter session key fixes', () => {
  let store: TransferSessionStoreHandle;
  let adapter: KoreAdapter;

  beforeEach(() => {
    vi.clearAllMocks();
    store = createMockSessionStore();

    // Construct without SmartAssistConfig to avoid SSRF guard,
    // then inject a mock client directly
    adapter = new KoreAdapter(undefined, store);
    (adapter as any).client = {
      checkBusinessHours: vi.fn().mockResolvedValue({ success: true, data: { isValid: true } }),
      checkAgentAvailability: vi
        .fn()
        .mockResolvedValue({ success: true, data: { agentAvailability: true } }),
      validateQueue: vi.fn().mockResolvedValue({ success: true, data: { isValid: true } }),
      initTransfer: vi.fn().mockResolvedValue({
        success: true,
        status: 'transferred',
        providerSessionId: 'conv-abc',
      }),
      createSyntheticUser: vi
        .fn()
        .mockResolvedValue({ success: true, data: { userId: 'u-mock-123' } }),
      getAccountIdByBotId: vi.fn().mockResolvedValue({
        success: true,
        data: { orgId: 'o-mock-org', accountId: 'a-mock-account' },
      }),
      close: vi.fn().mockResolvedValue(undefined),
    };
  });

  describe('C6: execute() returns sessionId with agent_transfer: prefix', () => {
    it('returns sessionId matching sessionKey() format', async () => {
      const payload = createPayload();
      const result = await adapter.execute(payload);

      expect(result.success).toBe(true);
      expect(result.sessionId).toBe(sessionKey(payload.tenantId, payload.sessionId, 'chat'));
      expect(result.sessionId).toBe('agent_transfer:tenant-1:sess-1:chat');
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          tenantId: 'tenant-1',
          projectId: 'proj-1',
          ownerId: 'sess-1',
          contactId: 'contact-1',
          channel: 'chat',
          routing: {
            runtimeSessionId: 'sess-1',
            resolvedContactId: 'contact-1',
            normalizedTransferChannel: 'chat',
            sourceChannelType: 'chat',
          },
          metadata: expect.objectContaining({
            postAgentAction: 'end',
            conversationSessionId: 'sess-1',
          }),
        }),
      );
    });

    it('does NOT use the old kore: prefix', async () => {
      const payload = createPayload();
      const result = await adapter.execute(payload);

      expect(result.sessionId).not.toMatch(/^kore:/);
    });

    it('forwards voiceData to SmartAssist and the session store', async () => {
      const payload = createPayload({
        channel: 'voice',
        voiceData: {
          callSid: 'call-1',
          caller: '+15551234567',
          called: '+18005550199',
          sipCallId: 'sip-1',
        },
      });
      const client = (adapter as any).client;

      await adapter.execute(payload);

      expect(client.initTransfer).toHaveBeenCalledWith(
        expect.objectContaining({
          voiceData: expect.objectContaining({
            callSid: 'call-1',
            caller: '+15551234567',
            called: '+18005550199',
            sipCallId: 'sip-1',
          }),
        }),
      );
      expect(store.create).toHaveBeenCalledWith(
        expect.objectContaining({
          voiceData: {
            callSid: 'call-1',
            sipCallId: 'sip-1',
          },
          providerData: expect.objectContaining({
            callSid: 'call-1',
            sipCallId: 'sip-1',
            caller: '+15551234567',
            called: '+18005550199',
          }),
        }),
      );
    });
  });

  describe('I2: handleInboundEvent uses sessionKey() format', () => {
    it('calls extendTTL with agent_transfer: prefixed key', async () => {
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        ownerId: 'sess-1',
        contactId: 'contact-1',
        channel: 'chat',
        routing: JSON.stringify({
          runtimeSessionId: 'sess-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'chat',
        }),
        metadata: JSON.stringify({ postAgentAction: 'end' }),
      };
      (store.getByProvider as ReturnType<typeof vi.fn>).mockResolvedValue(sessionData);

      const xoEvent: XOEvent = {
        type: 'agent_message',
        conversationId: 'conv-abc',
        message: 'Hello',
      };

      await adapter.handleInboundEvent(xoEvent, 'tenant-1');

      const expectedKey = sessionKey('tenant-1', 'sess-1', 'chat');
      expect(store.extendTTL).toHaveBeenCalledWith(expectedKey);
      expect(expectedKey).toBe('agent_transfer:tenant-1:sess-1:chat');
    });
  });

  describe('NEW-2: postAgentAction correctly extracted from metadata JSON', () => {
    it('extracts postAgentAction=return from metadata and does NOT end session', async () => {
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        ownerId: 'sess-1',
        contactId: 'contact-1',
        channel: 'chat',
        metadata: JSON.stringify({ postAgentAction: 'return', sourceAgentId: 'src-1' }),
      };
      (store.getByProvider as ReturnType<typeof vi.fn>).mockResolvedValue(sessionData);

      const xoEvent: XOEvent = {
        type: 'closed',
        conversationId: 'conv-abc',
      };

      await adapter.handleInboundEvent(xoEvent, 'tenant-1');

      expect(store.end).not.toHaveBeenCalled();
    });

    it('ends session when postAgentAction=end in metadata', async () => {
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        ownerId: 'sess-1',
        contactId: 'contact-1',
        channel: 'chat',
        metadata: JSON.stringify({ postAgentAction: 'end' }),
      };
      (store.getByProvider as ReturnType<typeof vi.fn>).mockResolvedValue(sessionData);

      const xoEvent: XOEvent = {
        type: 'conversation_closed',
        conversationId: 'conv-abc',
      };

      await adapter.handleInboundEvent(xoEvent, 'tenant-1');

      const expectedKey = sessionKey('tenant-1', 'sess-1', 'chat');
      expect(store.end).toHaveBeenCalledWith(expectedKey);
    });

    it('defers session cleanup when ACW is expected but not completed', async () => {
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        ownerId: 'sess-1',
        contactId: 'contact-1',
        channel: 'chat',
        metadata: JSON.stringify({ postAgentAction: 'end' }),
      };
      (store.getByProvider as ReturnType<typeof vi.fn>).mockResolvedValue(sessionData);
      (store.get as ReturnType<typeof vi.fn>).mockResolvedValue({
        ...sessionData,
        acwExpected: 'true',
        acwCompletedEmitted: 'false',
      });

      const xoEvent: XOEvent = {
        type: 'conversation_closed',
        conversationId: 'conv-abc',
      };

      await adapter.handleInboundEvent(xoEvent, 'tenant-1');

      expect(store.end).not.toHaveBeenCalled();
    });

    it('defers session cleanup when the disconnect event already carries ACW data', async () => {
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        ownerId: 'sess-1',
        contactId: 'contact-1',
        channel: 'chat',
        metadata: JSON.stringify({ postAgentAction: 'end' }),
      };
      (store.getByProvider as ReturnType<typeof vi.fn>).mockResolvedValue(sessionData);

      const xoEvent: XOEvent = {
        type: 'closed',
        conversationId: 'conv-abc',
        data: {
          isACWEnabled: true,
        },
      };

      await adapter.handleInboundEvent(xoEvent, 'tenant-1');

      expect(store.end).not.toHaveBeenCalled();
    });

    it('defaults to end when metadata is missing', async () => {
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
      };
      (store.getByProvider as ReturnType<typeof vi.fn>).mockResolvedValue(sessionData);

      const xoEvent: XOEvent = {
        type: 'closed',
        conversationId: 'conv-abc',
      };

      await adapter.handleInboundEvent(xoEvent, 'tenant-1');

      expect(store.end).toHaveBeenCalled();
    });

    it('defaults to end when metadata is [object Object]', async () => {
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        metadata: '[object Object]',
      };
      (store.getByProvider as ReturnType<typeof vi.fn>).mockResolvedValue(sessionData);

      const xoEvent: XOEvent = {
        type: 'closed',
        conversationId: 'conv-abc',
      };

      await adapter.handleInboundEvent(xoEvent, 'tenant-1');

      expect(store.end).toHaveBeenCalled();
    });

    it('defaults to end when metadata JSON is invalid', async () => {
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        metadata: '{not-valid-json',
      };
      (store.getByProvider as ReturnType<typeof vi.fn>).mockResolvedValue(sessionData);

      const xoEvent: XOEvent = {
        type: 'closed',
        conversationId: 'conv-abc',
      };

      await adapter.handleInboundEvent(xoEvent, 'tenant-1');

      expect(store.end).toHaveBeenCalled();
    });
  });
});
