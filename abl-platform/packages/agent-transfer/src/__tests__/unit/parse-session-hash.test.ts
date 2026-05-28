/**
 * parseSessionHash and create() extended fields tests
 *
 * Verifies that parseSessionHash correctly deserializes all 12 new fields
 * and that create() stores them in Redis.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { TransferSessionStore } from '../../session/transfer-session-store.js';
import { sessionKey } from '../../session/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('parseSessionHash extended fields', () => {
  let redis: InstanceType<typeof Redis>;
  let store: TransferSessionStore;

  beforeEach(() => {
    redis = new Redis();
    store = new TransferSessionStore(redis as any);
  });

  const baseInput = {
    tenantId: 'tenant-1',
    contactId: 'contact-1',
    channel: 'chat',
    provider: 'kore',
    providerSessionId: 'conv-123',
    ownerPod: 'pod-1',
  };

  describe('create() stores new optional fields', () => {
    it('stores ownerId, routing, and contextSnapshot for canonical transfer sessions', async () => {
      const result = await store.create({
        ...baseInput,
        ownerId: 'runtime-1',
        routing: {
          runtimeSessionId: 'runtime-1',
          resolvedContactId: 'contact-1',
          normalizedTransferChannel: 'chat',
          sourceChannelType: 'sdk_websocket',
          channelConnectionId: 'conn-1',
        },
        contextSnapshot: {
          contact: {
            displayName: 'Taylor Customer',
            email: 'taylor@example.com',
          },
        },
      });

      expect(result.success).toBe(true);

      const key = sessionKey(baseInput.tenantId, 'runtime-1', baseInput.channel);
      const session = await store.get(key);

      expect(session).not.toBeNull();
      expect(session!.ownerId).toBe('runtime-1');
      expect(session!.routing).toEqual({
        runtimeSessionId: 'runtime-1',
        resolvedContactId: 'contact-1',
        normalizedTransferChannel: 'chat',
        sourceChannelType: 'sdk_websocket',
        channelConnectionId: 'conn-1',
      });
      expect(session!.contextSnapshot).toEqual({
        contact: {
          displayName: 'Taylor Customer',
          email: 'taylor@example.com',
        },
      });
    });

    it('stores agentId, projectId, queue, skills, priority, and postAgentConfig', async () => {
      const result = await store.create({
        ...baseInput,
        agentId: 'agent-42',
        projectId: 'proj-7',
        queue: 'support',
        skills: ['billing', 'refunds'],
        priority: 3,
        postAgentConfig: { action: 'return', dialogId: 'dlg-1' },
      });

      expect(result.success).toBe(true);

      const key = sessionKey(baseInput.tenantId, baseInput.contactId, baseInput.channel);
      const session = await store.get(key);

      expect(session).not.toBeNull();
      expect(session!.agentId).toBe('agent-42');
      expect(session!.projectId).toBe('proj-7');
      expect(session!.queue).toBe('support');
      expect(session!.skills).toEqual(['billing', 'refunds']);
      expect(session!.priority).toBe(3);
      expect(session!.postAgentConfig).toEqual({ action: 'return', dialogId: 'dlg-1' });
    });

    it('stores voiceData for voice transfers', async () => {
      const result = await store.create({
        ...baseInput,
        contactId: 'voice-contact',
        channel: 'voice',
        voiceData: {
          callSid: 'call-1',
          sipCallId: 'sip-1',
        },
      });

      expect(result.success).toBe(true);

      const key = sessionKey(baseInput.tenantId, 'voice-contact', 'voice');
      const session = await store.get(key);

      expect(session).not.toBeNull();
      expect(session!.voiceData).toEqual({
        callSid: 'call-1',
        sipCallId: 'sip-1',
      });
    });

    it('omits optional fields when not provided', async () => {
      const input = { ...baseInput, contactId: 'contact-no-extras' };
      await store.create(input);
      const key = sessionKey(input.tenantId, input.contactId, input.channel);
      const session = await store.get(key);

      expect(session).not.toBeNull();
      expect(session!.agentId).toBeUndefined();
      expect(session!.projectId).toBeUndefined();
      expect(session!.queue).toBeUndefined();
      expect(session!.skills).toBeUndefined();
      expect(session!.priority).toBeUndefined();
      expect(session!.postAgentConfig).toBeUndefined();
    });
  });

  describe('parseSessionHash via get()', () => {
    it('round-trips all extended fields through Redis', async () => {
      const key = sessionKey(baseInput.tenantId, baseInput.contactId, baseInput.channel);

      // Write raw hash fields to simulate a session with all fields
      await redis.hmset(key, {
        tenantId: 'tenant-1',
        ownerId: 'runtime-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-123',
        state: 'active',
        metadata: '{}',
        providerData: '{}',
        routing:
          '{"runtimeSessionId":"runtime-1","resolvedContactId":"contact-1","normalizedTransferChannel":"chat","sourceChannelType":"sdk_websocket"}',
        contextSnapshot:
          '{"contact":{"displayName":"Taylor Customer"},"interactionContext":{"language":"en"}}',
        ownerPod: 'pod-1',
        lastHeartbeat: '1000',
        createdAt: '900',
        updatedAt: '1000',
        ttl: '1800',
        agentId: 'agent-42',
        projectId: 'proj-7',
        queue: 'support',
        skills: '["billing","refunds"]',
        priority: '3',
        postAgentConfig: '{"action":"return","dialogId":"dlg-1"}',
        csatSurveyType: 'nps',
        csatDialogId: 'dlg-csat',
        csatStartedAt: '2000',
        csatCompletedAt: '3000',
        dispositionCode: 'resolved',
        wrapUpNotes: 'Customer issue fixed',
        voiceData: '{"callSid":"call-1","sipCallId":"sip-1","agentSipURI":"sip:agent@example.com"}',
      });

      const session = await store.get(key);

      expect(session).not.toBeNull();
      // Original fields
      expect(session!.tenantId).toBe('tenant-1');
      expect(session!.ownerId).toBe('runtime-1');
      expect(session!.state).toBe('active');
      expect(session!.routing).toEqual({
        runtimeSessionId: 'runtime-1',
        resolvedContactId: 'contact-1',
        normalizedTransferChannel: 'chat',
        sourceChannelType: 'sdk_websocket',
      });
      expect(session!.contextSnapshot).toEqual({
        contact: {
          displayName: 'Taylor Customer',
        },
        interactionContext: {
          language: 'en',
        },
      });

      // New routing fields
      expect(session!.agentId).toBe('agent-42');
      expect(session!.projectId).toBe('proj-7');
      expect(session!.queue).toBe('support');
      expect(session!.skills).toEqual(['billing', 'refunds']);
      expect(session!.priority).toBe(3);
      expect(session!.postAgentConfig).toEqual({ action: 'return', dialogId: 'dlg-1' });

      // CSAT fields
      expect(session!.csatSurveyType).toBe('nps');
      expect(session!.csatDialogId).toBe('dlg-csat');
      expect(session!.csatStartedAt).toBe(2000);
      expect(session!.csatCompletedAt).toBe(3000);

      // Disposition fields
      expect(session!.dispositionCode).toBe('resolved');
      expect(session!.wrapUpNotes).toBe('Customer issue fixed');
      expect(session!.voiceData).toEqual({
        callSid: 'call-1',
        sipCallId: 'sip-1',
        agentSipURI: 'sip:agent@example.com',
      });
    });

    it('synthesizes ownerId and routing for legacy hashes without the new fields', async () => {
      const key = sessionKey(baseInput.tenantId, 'legacy-ownerless-key', baseInput.channel);

      await redis.hmset(key, {
        tenantId: 'tenant-1',
        contactId: 'contact-legacy-1',
        channel: 'sdk_websocket',
        provider: 'kore',
        providerSessionId: 'conv-legacy-1',
        state: 'pending',
        metadata: '{}',
        providerData: '{}',
        ownerPod: 'pod-1',
        lastHeartbeat: '1000',
        createdAt: '900',
        updatedAt: '1000',
        ttl: '1800',
      });

      const session = await store.get(key);

      expect(session).not.toBeNull();
      expect(session!.ownerId).toBe('contact-legacy-1');
      expect(session!.routing).toEqual({
        runtimeSessionId: 'contact-legacy-1',
        resolvedContactId: 'contact-legacy-1',
        normalizedTransferChannel: 'chat',
        sourceChannelType: 'sdk_websocket',
      });
    });

    it('handles malformed skills JSON gracefully', async () => {
      const key = sessionKey(baseInput.tenantId, baseInput.contactId, baseInput.channel);

      await redis.hmset(key, {
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-123',
        state: 'pending',
        metadata: '{}',
        providerData: '{}',
        ownerPod: 'pod-1',
        lastHeartbeat: '1000',
        createdAt: '900',
        updatedAt: '1000',
        ttl: '1800',
        skills: 'not-valid-json',
      });

      const session = await store.get(key);
      expect(session).not.toBeNull();
      expect(session!.skills).toEqual([]);
    });
  });

  describe('update() stores new fields', () => {
    it('updates CSAT and disposition fields', async () => {
      await store.create(baseInput);
      const key = sessionKey(baseInput.tenantId, baseInput.contactId, baseInput.channel);

      const updated = await store.update(key, {
        state: 'post_agent',
        csatSurveyType: 'csat',
        csatDialogId: 'dlg-survey',
        csatStartedAt: 5000,
        dispositionCode: 'escalated',
        wrapUpNotes: 'Needs follow-up',
        skills: ['tech', 'vip'],
        priority: 8,
        voiceData: {
          callSid: 'call-9',
          disconnectReason: 'agent_disconnect',
        },
      });

      expect(updated).toBe(true);

      const session = await store.get(key);
      expect(session!.state).toBe('post_agent');
      expect(session!.csatSurveyType).toBe('csat');
      expect(session!.csatDialogId).toBe('dlg-survey');
      expect(session!.csatStartedAt).toBe(5000);
      expect(session!.dispositionCode).toBe('escalated');
      expect(session!.wrapUpNotes).toBe('Needs follow-up');
      expect(session!.skills).toEqual(['tech', 'vip']);
      expect(session!.priority).toBe(8);
      expect(session!.voiceData).toEqual({
        callSid: 'call-9',
        disconnectReason: 'agent_disconnect',
      });
    });
  });
});
