/**
 * Edge Case Tests
 *
 * Validates boundary conditions, malformed data, and unusual inputs.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { TransferSessionStore } from '../../session/transfer-session-store.js';
import { KoreEventHandler } from '../../adapters/kore/event-handler.js';
import { CHANNEL_TTL_DEFAULTS } from '../../session/types.js';

vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('edge cases', () => {
  describe('session store', () => {
    let redis: InstanceType<typeof Redis>;
    let store: TransferSessionStore;

    beforeEach(() => {
      redis = new Redis();
      store = new TransferSessionStore(redis as any);
    });

    it('get returns null for non-existent key', async () => {
      const result = await store.get('agent_transfer:fake:fake:fake');
      expect(result).toBeNull();
    });

    it('update returns false for non-existent key', async () => {
      const result = await store.update('agent_transfer:fake:fake:fake', {
        state: 'active',
      });
      expect(result).toBe(false);
    });

    it('end returns false for non-existent key', async () => {
      const result = await store.end('agent_transfer:fake:fake:fake');
      expect(result).toBe(false);
    });

    it('extendTTL returns false for non-existent session', async () => {
      const result = await store.extendTTL('agent_transfer:fake:fake:fake');
      expect(result).toBe(false);
    });

    it('voice channel gets TTL=0 (no expiry)', () => {
      expect(CHANNEL_TTL_DEFAULTS.voice).toBe(0);
    });

    it('unknown channel gets default TTL', () => {
      expect(CHANNEL_TTL_DEFAULTS['unknown_channel']).toBeUndefined();
      expect(CHANNEL_TTL_DEFAULTS.default).toBe(1800);
    });

    it('create sets initializing state', async () => {
      const result = await store.create({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        ownerPod: 'pod-1',
      });

      expect(result.success).toBe(true);
      const session = await store.get(result.sessionKey!);
      expect(session!.state).toBe('pending');
    });

    it('update changes state correctly', async () => {
      // Use mock Redis since ioredis-mock does not support Lua eval
      const sessionData: Record<string, string> = {
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        state: 'initializing',
        metadata: '{}',
        providerData: '{}',
        ownerPod: 'pod-1',
        lastHeartbeat: String(Date.now()),
        createdAt: String(Date.now()),
        updatedAt: String(Date.now()),
        ttl: '1800',
      };

      const mockRedis = {
        eval: vi
          .fn()
          .mockImplementation(
            (_script: string, _numKeys: number, _key: string, ...args: string[]) => {
              // Simulate Lua: apply field-value pairs to sessionData
              for (let i = 0; i < args.length; i += 2) {
                sessionData[args[i]] = args[i + 1];
              }
              return Promise.resolve(1);
            },
          ),
        hgetall: vi.fn().mockImplementation(() => Promise.resolve({ ...sessionData })),
      };
      const mockStore = new TransferSessionStore(mockRedis as any);

      const key = 'agent_transfer:tenant-1:contact-1:chat';
      await mockStore.update(key, { state: 'active' });
      const session = await mockStore.get(key);
      expect(session!.state).toBe('active');
    });

    it('getActiveSessions returns all active keys', async () => {
      await store.create({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        ownerPod: 'pod-1',
      });

      await store.create({
        tenantId: 'tenant-1',
        contactId: 'contact-2',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-2',
        ownerPod: 'pod-1',
      });

      const keys = await store.getActiveSessions();
      expect(keys).toHaveLength(2);
    });

    it('getSessionsByPod returns sessions for specific pod', async () => {
      // Use mock Redis since ioredis-mock doesn't handle Lua SADD to pod sets.
      // Post-Phase 2.2: Lua only writes the session hash; cross-slot index
      // writes (pod SET, active-sessions SET, provider index) happen as
      // individual calls via Promise.allSettled (ioredis Cluster pipelines
      // require same-slot keys, which the indexes intentionally don't).
      const podSets: Record<string, Set<string>> = {};
      const mockRedis = {
        eval: vi.fn().mockResolvedValue(1),
        set: vi.fn().mockResolvedValue('OK'),
        sadd: vi.fn().mockImplementation((setKey: string, member: string) => {
          if (setKey.startsWith('at_pod:')) {
            if (!podSets[setKey]) podSets[setKey] = new Set();
            podSets[setKey].add(member);
          }
          return Promise.resolve(1);
        }),
        smembers: vi.fn().mockImplementation((key: string) => {
          return Promise.resolve(Array.from(podSets[key] ?? []));
        }),
      };
      const mockStore = new TransferSessionStore(mockRedis as any);

      await mockStore.create({
        tenantId: 'tenant-1',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-1',
        ownerPod: 'pod-1',
      });

      await mockStore.create({
        tenantId: 'tenant-1',
        contactId: 'contact-2',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-2',
        ownerPod: 'pod-2',
      });

      const pod1Sessions = await mockStore.getSessionsByPod('pod-1');
      const pod2Sessions = await mockStore.getSessionsByPod('pod-2');

      expect(pod1Sessions).toHaveLength(1);
      expect(pod2Sessions).toHaveLength(1);
    });
  });

  describe('event handler', () => {
    it('unknown XO event type is skipped', async () => {
      const handler = new KoreEventHandler();
      const mockFn = vi.fn();
      handler.onAgentMessage(mockFn);

      await handler.processEvent(
        { type: 'completely_unknown_event', conversationId: 'conv-1' },
        { tenantId: 't', contactId: 'c', channel: 'chat' },
      );

      expect(mockFn).not.toHaveBeenCalled();
    });

    it('handler errors do not propagate', async () => {
      const handler = new KoreEventHandler();
      handler.onAgentMessage(() => {
        throw new Error('handler crash');
      });

      // Should not throw
      await handler.processEvent(
        { type: 'agent_message', conversationId: 'conv-1' },
        { tenantId: 't', contactId: 'c', channel: 'chat' },
      );
    });

    it('maps all known XO event types', () => {
      const types = KoreEventHandler.supportedEventTypes();
      expect(types.length).toBeGreaterThan(10);
      expect(types).toContain('agent_message');
      expect(types).toContain('closed');
      expect(types).toContain('conversation_closed');
    });

    it('mapEventType returns correct ABL type', () => {
      expect(KoreEventHandler.mapEventType('agent_message')).toBe('agent:message');
      expect(KoreEventHandler.mapEventType('closed')).toBe('agent:disconnected');
      expect(KoreEventHandler.mapEventType('unknown')).toBeUndefined();
    });
  });
});
