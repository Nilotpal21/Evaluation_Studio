/**
 * Contact Store Tests
 *
 * Tests for InMemoryContactStore CRUD operations.
 */

import { describe, test, expect, beforeEach } from 'vitest';
import {
  InMemoryContactStore,
  type ContactStoreConfig,
} from '../../platform/stores/contact-store.js';

describe('InMemoryContactStore', () => {
  let store: InMemoryContactStore;

  beforeEach(() => {
    const config: ContactStoreConfig = { type: 'memory' };
    store = new InMemoryContactStore(config);
  });

  describe('create', () => {
    test('creates a contact with required fields', async () => {
      const contact = await store.create({
        tenantId: 'org-1',
        type: 'customer',
        identity: 'john@example.com',
        identityType: 'email',
        displayName: 'John Doe',
      });

      expect(contact.id).toBeDefined();
      expect(contact.tenantId).toBe('org-1');
      expect(contact.type).toBe('customer');
      expect(contact.identity).toBe('john@example.com');
      expect(contact.identityType).toBe('email');
      expect(contact.displayName).toBe('John Doe');
      expect(contact.metadata).toEqual({});
      expect(contact.tags).toEqual([]);
      expect(contact.firstSeenAt).toBeInstanceOf(Date);
      expect(contact.lastSeenAt).toBeInstanceOf(Date);
    });

    test('defaults type to anonymous', async () => {
      const contact = await store.create({ tenantId: 'org-1' });
      expect(contact.type).toBe('anonymous');
    });

    test('accepts metadata and tags', async () => {
      const contact = await store.create({
        tenantId: 'org-1',
        metadata: { source: 'web' },
        tags: ['vip', 'premium'],
      });

      expect(contact.metadata).toEqual({ source: 'web' });
      expect(contact.tags).toEqual(['vip', 'premium']);
    });
  });

  describe('getById', () => {
    test('returns contact by ID', async () => {
      const created = await store.create({
        tenantId: 'org-1',
        displayName: 'Jane',
      });

      const found = await store.getById(created.id);
      expect(found).not.toBeNull();
      expect(found!.displayName).toBe('Jane');
    });

    test('returns null for non-existent ID', async () => {
      const found = await store.getById('non-existent');
      expect(found).toBeNull();
    });
  });

  describe('findByIdentity', () => {
    test('finds contact by org, identity type, and identity', async () => {
      await store.create({
        tenantId: 'org-1',
        identity: '+15551234567',
        identityType: 'phone',
        displayName: 'Phone User',
      });

      const found = await store.findByIdentity('org-1', 'phone', '+15551234567');
      expect(found).not.toBeNull();
      expect(found!.displayName).toBe('Phone User');
    });

    test('returns null when org does not match', async () => {
      await store.create({
        tenantId: 'org-1',
        identity: 'user@example.com',
        identityType: 'email',
      });

      const found = await store.findByIdentity('org-2', 'email', 'user@example.com');
      expect(found).toBeNull();
    });

    test('returns null when identity type does not match', async () => {
      await store.create({
        tenantId: 'org-1',
        identity: 'user@example.com',
        identityType: 'email',
      });

      const found = await store.findByIdentity('org-1', 'phone', 'user@example.com');
      expect(found).toBeNull();
    });
  });

  describe('update', () => {
    test('updates contact fields', async () => {
      const created = await store.create({
        tenantId: 'org-1',
        type: 'anonymous',
      });

      const updated = await store.update(created.id, {
        type: 'customer',
        displayName: 'Now Known',
        company: 'ACME Corp',
      });

      expect(updated.type).toBe('customer');
      expect(updated.displayName).toBe('Now Known');
      expect(updated.company).toBe('ACME Corp');
    });

    test('merges metadata', async () => {
      const created = await store.create({
        tenantId: 'org-1',
        metadata: { a: 1 },
      });

      const updated = await store.update(created.id, {
        metadata: { b: 2 },
      });

      expect(updated.metadata).toEqual({ a: 1, b: 2 });
    });

    test('throws for non-existent contact', async () => {
      await expect(store.update('non-existent', { displayName: 'test' })).rejects.toThrow(
        'Contact non-existent not found',
      );
    });
  });

  describe('query', () => {
    test('filters by organization', async () => {
      await store.create({ tenantId: 'org-1', displayName: 'A' });
      await store.create({ tenantId: 'org-2', displayName: 'B' });

      const result = await store.query({ tenantId: 'org-1' });
      expect(result.total).toBe(1);
      expect(result.contacts[0].displayName).toBe('A');
    });

    test('filters by type', async () => {
      await store.create({ tenantId: 'org-1', type: 'customer' });
      await store.create({ tenantId: 'org-1', type: 'employee' });

      const result = await store.query({ tenantId: 'org-1', type: 'customer' });
      expect(result.total).toBe(1);
      expect(result.contacts[0].type).toBe('customer');
    });

    test('filters by tags', async () => {
      await store.create({ tenantId: 'org-1', tags: ['vip'] });
      await store.create({ tenantId: 'org-1', tags: ['standard'] });

      const result = await store.query({ tenantId: 'org-1', tags: ['vip'] });
      expect(result.total).toBe(1);
    });

    test('paginates results', async () => {
      for (let i = 0; i < 5; i++) {
        await store.create({ tenantId: 'org-1', displayName: `Contact ${i}` });
      }

      const result = await store.query({ tenantId: 'org-1', limit: 2, offset: 1 });
      expect(result.contacts.length).toBe(2);
      expect(result.total).toBe(5);
    });
  });

  describe('delete', () => {
    test('removes contact', async () => {
      const created = await store.create({ tenantId: 'org-1' });
      await store.delete(created.id);
      const found = await store.getById(created.id);
      expect(found).toBeNull();
    });
  });

  describe('touchLastSeen', () => {
    test('updates lastSeenAt timestamp', async () => {
      const created = await store.create({ tenantId: 'org-1' });
      const originalLastSeen = created.lastSeenAt;

      // Small delay to ensure timestamp differs
      await new Promise((r) => setTimeout(r, 10));

      await store.touchLastSeen(created.id);
      const found = await store.getById(created.id);
      expect(found!.lastSeenAt.getTime()).toBeGreaterThan(originalLastSeen.getTime());
    });
  });
});
