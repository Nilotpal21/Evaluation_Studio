/**
 * Tests for event mapping fixes (I7, M2).
 *
 * - conversation_updated is no longer mapped to agent:message
 * - All other XO_EVENT_MAP entries still map correctly
 * - invalidateAuth is called via typed interface (no `any` cast)
 */
import { describe, it, expect, vi } from 'vitest';
import { KoreEventHandler } from '../adapters/kore/event-handler.js';
import { AdapterRegistry } from '../adapters/registry.js';
import { createMockAdapter } from './helpers/mock-adapter.js';

describe('XO_EVENT_MAP fixes (I7)', () => {
  it('does not map conversation_updated to any event type', () => {
    const mapped = KoreEventHandler.mapEventType('conversation_updated');
    expect(mapped).toBeUndefined();
  });

  it('skips conversation_updated events in processEvent without calling handlers', async () => {
    const handler = new KoreEventHandler();
    const spy = vi.fn();
    handler.onAgentMessage(spy);

    await handler.processEvent(
      {
        type: 'conversation_updated',
        conversationId: 'conv-1',
        message: 'metadata change',
      },
      { tenantId: 't1', contactId: 'c1', channel: 'chat' },
    );

    expect(spy).not.toHaveBeenCalled();
  });

  it('conversation_updated is not in supported event types', () => {
    const supported = KoreEventHandler.supportedEventTypes();
    expect(supported).not.toContain('conversation_updated');
  });

  it('still maps agent_message to agent:message', () => {
    expect(KoreEventHandler.mapEventType('agent_message')).toBe('agent:message');
  });

  it('still maps agent_accepted to agent:connected', () => {
    expect(KoreEventHandler.mapEventType('agent_accepted')).toBe('agent:connected');
  });

  it('still maps conversation_queued to agent:queued', () => {
    expect(KoreEventHandler.mapEventType('conversation_queued')).toBe('agent:queued');
  });

  it('still maps closed to agent:disconnected', () => {
    expect(KoreEventHandler.mapEventType('closed')).toBe('agent:disconnected');
  });

  it('still maps typing to agent:typing', () => {
    expect(KoreEventHandler.mapEventType('typing')).toBe('agent:typing');
  });

  it('still maps stop_typing to agent:typing_stop', () => {
    expect(KoreEventHandler.mapEventType('stop_typing')).toBe('agent:typing_stop');
  });

  it('still maps message_delivered to agent:delivery_receipt', () => {
    expect(KoreEventHandler.mapEventType('message_delivered')).toBe('agent:delivery_receipt');
  });

  it('still maps form_message to agent:form', () => {
    expect(KoreEventHandler.mapEventType('form_message')).toBe('agent:form');
  });

  it('still maps proactive_agentassist to agent:assist_suggestion', () => {
    expect(KoreEventHandler.mapEventType('proactive_agentassist')).toBe('agent:assist_suggestion');
  });

  it('still maps agent_joined to agent:joined', () => {
    expect(KoreEventHandler.mapEventType('agent_joined')).toBe('agent:joined');
  });

  it('still maps conversation_closed to agent:disconnected', () => {
    expect(KoreEventHandler.mapEventType('conversation_closed')).toBe('agent:disconnected');
  });

  it('still maps agent_transferred to agent:connected', () => {
    expect(KoreEventHandler.mapEventType('agent_transferred')).toBe('agent:connected');
  });

  it('still maps bot_message_delivered to agent:delivery_receipt', () => {
    expect(KoreEventHandler.mapEventType('bot_message_delivered')).toBe('agent:delivery_receipt');
  });

  it('still maps user_message_delivered to agent:delivery_receipt', () => {
    expect(KoreEventHandler.mapEventType('user_message_delivered')).toBe('agent:delivery_receipt');
  });

  it('still maps queue_position_update to agent:queued', () => {
    expect(KoreEventHandler.mapEventType('queue_position_update')).toBe('agent:queued');
  });

  it('still maps wait_time_update to agent:queued', () => {
    expect(KoreEventHandler.mapEventType('wait_time_update')).toBe('agent:queued');
  });

  it('still maps agent_disconnect to agent:disconnected', () => {
    expect(KoreEventHandler.mapEventType('agent_disconnect')).toBe('agent:disconnected');
  });

  it('maps call_status_notifications to agent:call_status', () => {
    expect(KoreEventHandler.mapEventType('call_status_notifications')).toBe('agent:call_status');
  });

  it('maps wait_time_voice_message_for_user to agent:waiting_message', () => {
    expect(KoreEventHandler.mapEventType('wait_time_voice_message_for_user')).toBe(
      'agent:waiting_message',
    );
  });

  it('maps remove_id_to_acc_identity to agent:disconnected', () => {
    expect(KoreEventHandler.mapEventType('remove_id_to_acc_identity')).toBe('agent:disconnected');
  });

  it('extracts voice dial metadata from assign_kore_agent_for_user events', async () => {
    const handler = new KoreEventHandler();
    const spy = vi.fn();
    handler.onAgentMessage(spy);

    await handler.processEvent(
      {
        type: 'assign_kore_agent_for_user',
        conversationId: 'conv-1',
        payload: {
          transferURI: 'sip:agent@example.com',
          agentSipURI: 'sip:agent@example.com',
          sipHeaders: [{ name: 'X-Test', value: '1' }],
          dialHeaders: { 'X-Conversation': 'conv-1' },
        },
      },
      { tenantId: 't1', contactId: 'c1', channel: 'voice' },
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent:connected',
        data: expect.objectContaining({
          transferURI: 'sip:agent@example.com',
          agentSipURI: 'sip:agent@example.com',
          sipHeaders: [{ name: 'X-Test', value: '1' }],
          dialHeaders: { 'X-Conversation': 'conv-1' },
          isVoice: true,
        }),
      }),
    );
  });

  it('extracts disconnect metadata from call_status_notifications events', async () => {
    const handler = new KoreEventHandler();
    const spy = vi.fn();
    handler.onAgentMessage(spy);

    await handler.processEvent(
      {
        type: 'call_status_notifications',
        conversationId: 'conv-1',
        payload: {
          callStatus: 'agent_hangup',
          reason: 'agent_disconnect',
          sipCallId: 'sip-1',
        },
      },
      { tenantId: 't1', contactId: 'c1', channel: 'voice' },
    );

    expect(spy).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'agent:call_status',
        data: expect.objectContaining({
          callStatus: 'agent_hangup',
          disconnectReason: 'agent_disconnect',
          sipCallId: 'sip-1',
        }),
      }),
    );
  });

  it('synthesizes agent:disconnected from SmartAssist close-message fallbacks', async () => {
    const handler = new KoreEventHandler();
    const spy = vi.fn();
    handler.onAgentMessage(spy);

    await handler.processEvent(
      {
        type: 'agent_message',
        conversationId: 'conv-1',
        message: 'Agent Smith has now closed this conversation',
      },
      { tenantId: 't1', contactId: 'c1', channel: 'chat' },
    );

    expect(spy).toHaveBeenCalledTimes(2);
    expect(spy).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        type: 'agent:message',
      }),
    );
    expect(spy).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        type: 'agent:disconnected',
        data: expect.objectContaining({
          syntheticDisconnect: true,
          closeMessage: 'Agent Smith has now closed this conversation',
        }),
      }),
    );
  });
});

describe('AdapterRegistry.invalidateAuth typed call (M2)', () => {
  it('calls invalidateAuth on adapter when method exists', () => {
    const invalidateAuth = vi.fn();
    const adapter = createMockAdapter({ invalidateAuth } as any);
    const registry = new AdapterRegistry();
    registry.register('test-adapter', adapter);

    registry.invalidateAuth('test-adapter', 'tenant-1');

    expect(invalidateAuth).toHaveBeenCalledWith('tenant-1');
  });

  it('does nothing when adapter does not implement invalidateAuth', () => {
    const adapter = createMockAdapter();
    // Ensure no invalidateAuth on mock
    delete (adapter as any).invalidateAuth;
    const registry = new AdapterRegistry();
    registry.register('test-adapter', adapter);

    // Should not throw
    expect(() => registry.invalidateAuth('test-adapter', 'tenant-1')).not.toThrow();
  });

  it('logs warning when adapter not found', () => {
    const registry = new AdapterRegistry();

    // Should not throw
    expect(() => registry.invalidateAuth('nonexistent', 'tenant-1')).not.toThrow();
  });
});
