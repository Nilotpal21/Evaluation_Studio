/**
 * Tenant Isolation Tests
 *
 * Verifies that the tenantId is included in the provider index key,
 * preventing cross-tenant session collisions.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import Redis from 'ioredis-mock';
import { TransferSessionStore } from '../../session/transfer-session-store.js';
import { providerIndexKey, sessionKey } from '../../session/types.js';

// Mock createLogger
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

describe('tenant isolation', () => {
  let redis: InstanceType<typeof Redis>;
  let store: TransferSessionStore;

  beforeEach(() => {
    redis = new Redis();
    store = new TransferSessionStore(redis as any);
  });

  describe('providerIndexKey', () => {
    it('includes tenantId in the key', () => {
      const key = providerIndexKey('kore', 'tenant-1', 'conv-123');
      expect(key).toBe('at_by_provider:kore:tenant-1:conv-123');
    });

    it('produces different keys for different tenants with same providerSessionId', () => {
      const key1 = providerIndexKey('kore', 'tenant-1', 'conv-123');
      const key2 = providerIndexKey('kore', 'tenant-2', 'conv-123');
      expect(key1).not.toBe(key2);
    });
  });

  describe('sessionKey', () => {
    it('includes tenantId', () => {
      const key = sessionKey('tenant-1', 'contact-1', 'chat');
      expect(key).toBe('agent_transfer:tenant-1:contact-1:chat');
    });
  });

  describe('two tenants with same providerSessionId', () => {
    it('do NOT collide when creating sessions', async () => {
      const session1 = await store.create({
        tenantId: 'tenant-A',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-shared',
        ownerPod: 'pod-1',
      });

      const session2 = await store.create({
        tenantId: 'tenant-B',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-shared',
        ownerPod: 'pod-1',
      });

      expect(session1.success).toBe(true);
      expect(session2.success).toBe(true);

      // Different session keys
      expect(session1.sessionKey).not.toBe(session2.sessionKey);
    });

    it('getByProvider returns the correct tenant session', async () => {
      await store.create({
        tenantId: 'tenant-A',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-shared',
        ownerPod: 'pod-1',
      });

      await store.create({
        tenantId: 'tenant-B',
        contactId: 'contact-2',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-shared',
        ownerPod: 'pod-1',
      });

      const sessionA = await store.getByProvider('kore', 'tenant-A', 'conv-shared');
      const sessionB = await store.getByProvider('kore', 'tenant-B', 'conv-shared');

      expect(sessionA).not.toBeNull();
      expect(sessionB).not.toBeNull();
      expect(sessionA!.tenantId).toBe('tenant-A');
      expect(sessionA!.contactId).toBe('contact-1');
      expect(sessionB!.tenantId).toBe('tenant-B');
      expect(sessionB!.contactId).toBe('contact-2');
    });

    it('getByProvider with wrong tenantId returns null', async () => {
      await store.create({
        tenantId: 'tenant-A',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-123',
        ownerPod: 'pod-1',
      });

      const result = await store.getByProvider('kore', 'tenant-B', 'conv-123');
      expect(result).toBeNull();
    });
  });

  describe('session end with tenant isolation', () => {
    it('ending one tenant session does not affect another', async () => {
      await store.create({
        tenantId: 'tenant-A',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-shared',
        ownerPod: 'pod-1',
      });

      await store.create({
        tenantId: 'tenant-B',
        contactId: 'contact-1',
        channel: 'chat',
        provider: 'kore',
        providerSessionId: 'conv-shared',
        ownerPod: 'pod-1',
      });

      // End tenant-A's session
      const keyA = sessionKey('tenant-A', 'contact-1', 'chat');
      await store.end(keyA);

      // Tenant-A session should be gone
      const sessionA = await store.getByProvider('kore', 'tenant-A', 'conv-shared');
      expect(sessionA).toBeNull();

      // Tenant-B session should still exist
      const sessionB = await store.getByProvider('kore', 'tenant-B', 'conv-shared');
      expect(sessionB).not.toBeNull();
      expect(sessionB!.tenantId).toBe('tenant-B');
    });
  });
});
