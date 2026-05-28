/**
 * Encryption Salt Lifecycle Tests
 *
 * Verifies:
 * - New contacts get non-null encryptionSalt
 * - GDPR cascade nullifies encryptionSalt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import { EncryptionService } from '@agent-platform/shared/encryption';
import { ResolveOrCreateContact } from '../../contexts/contact/use-cases/resolve-or-create-contact.js';
import { CascadeDeleteContact } from '../../contexts/contact/use-cases/cascade-delete-contact.js';
import type { Contact } from '../../contexts/contact/domain/contact.js';
import type { ContactRepository } from '../../contexts/contact/domain/contact-repository.js';

// ── Test fixtures ───────────────────────────────────────────────────────

const TENANT_ID = 'tenant-salt-test';

function makeEncryptor(): Pick<
  EncryptionService,
  'blindIndex' | 'encryptContactPII' | 'decryptContactPII'
> {
  return {
    blindIndex: (_tenantId: string, normalized: string) =>
      crypto.createHash('sha256').update(normalized).digest('hex'),
    encryptContactPII: (_tenantId: string, value: string) => `enc:${value}`,
    decryptContactPII: (_tenantId: string, encrypted: string) => encrypted.replace('enc:', ''),
  };
}

function makeRepo(store: Map<string, Contact>): ContactRepository {
  return {
    findById: vi.fn(async (tenantId: string, contactId: string) => {
      const c = store.get(contactId);
      return c && c.tenantId === tenantId ? c : null;
    }),
    findByBlindIndex: vi.fn(async () => null),
    findByBlindIndexes: vi.fn(async () => []),
    create: vi.fn(async (contact: Contact) => {
      store.set(contact.id, contact);
      return contact;
    }),
    update: vi.fn(async (contact: Contact) => {
      store.set(contact.id, contact);
      return contact;
    }),
    addIdentity: vi.fn(async () => {}),
    linkSession: vi.fn(async () => {}),
    softDelete: vi.fn(async () => {}),
    hardDelete: vi.fn(async (_tenantId: string, contactId: string) => {
      store.delete(contactId);
    }),
    nullifyEncryptionSalt: vi.fn(async (_tenantId: string, contactId: string) => {
      const c = store.get(contactId);
      if (c) {
        c.encryptionSalt = null;
        store.set(contactId, c);
      }
    }),
    findMergeCandidates: vi.fn(async () => []),
  };
}

// ── Tests ────────────────────────────────────────────────────────────────

describe('Encryption Salt Lifecycle', () => {
  let store: Map<string, Contact>;

  beforeEach(() => {
    store = new Map();
  });

  it('new contact gets non-null encryptionSalt', async () => {
    const repo = makeRepo(store);
    const encryptor = makeEncryptor();
    const useCase = new ResolveOrCreateContact(repo, encryptor as unknown as EncryptionService);

    const contact = await useCase.execute(TENANT_ID, 'email', 'user@example.com');

    expect(contact.encryptionSalt).toBeTruthy();
    expect(typeof contact.encryptionSalt).toBe('string');
    expect(contact.encryptionSalt!.length).toBe(64); // 32 bytes hex
  });

  it('GDPR cascade nullifies encryptionSalt', async () => {
    const repo = makeRepo(store);
    const encryptor = makeEncryptor();
    const resolveOrCreate = new ResolveOrCreateContact(
      repo,
      encryptor as unknown as EncryptionService,
    );

    const contact = await resolveOrCreate.execute(TENANT_ID, 'email', 'gdpr@example.com');
    expect(contact.encryptionSalt).toBeTruthy();

    const cascade = new CascadeDeleteContact(
      repo,
      vi.fn(async () => {}),
    );

    await cascade.execute(TENANT_ID, contact.id);

    // nullifyEncryptionSalt should have been called
    expect(repo.nullifyEncryptionSalt).toHaveBeenCalledWith(TENANT_ID, contact.id);
  });
});
