/**
 * ResolveOrCreateContact Use Case Tests
 *
 * Validates blind-index-based resolution: returns existing contact when found,
 * creates a new encrypted contact when not found, and enforces tenant isolation.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import crypto from 'node:crypto';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { ContactRepository } from '../../../../contexts/contact/domain/contact-repository.js';
import { EncryptionService } from '@agent-platform/shared/encryption';
import { normalizeIdentity } from '../../../../contexts/contact/infrastructure/normalize-identity.js';
import { ResolveOrCreateContact } from '../../../../contexts/contact/use-cases/resolve-or-create-contact.js';

// 32 bytes = 64 hex chars for AES-256
const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');

function makeContact(overrides: Partial<Contact> = {}): Contact {
  const now = new Date();
  return {
    id: overrides.id ?? 'contact-001',
    tenantId: overrides.tenantId ?? 'tenant-001',
    identities: overrides.identities ?? [],
    displayName: overrides.displayName ?? null,
    type: overrides.type ?? 'customer',
    metadata: overrides.metadata ?? {},
    tags: overrides.tags ?? [],
    channelHistory: overrides.channelHistory ?? [],
    sessionCount: overrides.sessionCount ?? 0,
    firstSeenAt: overrides.firstSeenAt ?? now,
    lastSeenAt: overrides.lastSeenAt ?? now,
    mergedInto: overrides.mergedInto ?? null,
    deletedAt: overrides.deletedAt ?? null,
    encryptionSalt: overrides.encryptionSalt ?? null,
  };
}

function createMockRepo(): ContactRepository {
  return {
    findById: vi.fn().mockResolvedValue(null),
    findByBlindIndex: vi.fn().mockResolvedValue(null),
    findByBlindIndexes: vi.fn().mockResolvedValue([]),
    create: vi.fn().mockImplementation(async (c: Contact) => c),
    update: vi.fn().mockImplementation(async (c: Contact) => c),
    addIdentity: vi.fn().mockResolvedValue(undefined),
    linkSession: vi.fn().mockResolvedValue(undefined),
    softDelete: vi.fn().mockResolvedValue(undefined),
    hardDelete: vi.fn().mockResolvedValue(undefined),
    nullifyEncryptionSalt: vi.fn().mockResolvedValue(undefined),
    findMergeCandidates: vi.fn().mockResolvedValue([]),
  };
}

describe('ResolveOrCreateContact', () => {
  let repo: ContactRepository;
  let encryptor: EncryptionService;
  let useCase: ResolveOrCreateContact;

  beforeEach(() => {
    repo = createMockRepo();
    encryptor = new EncryptionService({ masterKeyHex: TEST_MASTER_KEY_HEX });
    useCase = new ResolveOrCreateContact(repo, encryptor);
  });

  // ===========================================================================
  // Resolve existing contact
  // ===========================================================================

  it('returns existing contact when blind index matches', async () => {
    const tenantId = 'tenant-001';
    const emailValue = 'alice@example.com';
    const normalized = normalizeIdentity('email', emailValue);
    const blindIdx = encryptor.blindIndex(tenantId, normalized);

    const existing = makeContact({
      id: 'existing-contact-1',
      tenantId,
      identities: [
        {
          type: 'email',
          encryptedValue: 'enc-val',
          blindIndex: blindIdx,
          verified: false,
          verifiedAt: null,
          verifiedVia: null,
          channel: null,
        },
      ],
    });

    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

    const result = await useCase.execute(tenantId, 'email', emailValue);

    expect(result.id).toBe('existing-contact-1');
    expect(repo.findByBlindIndex).toHaveBeenCalledWith(tenantId, blindIdx);
    expect(repo.create).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Create new contact
  // ===========================================================================

  it('creates a new contact when no blind index match', async () => {
    const tenantId = 'tenant-001';
    const emailValue = 'bob@example.com';

    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    const result = await useCase.execute(tenantId, 'email', emailValue);

    expect(repo.create).toHaveBeenCalledTimes(1);

    const createdContact = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    expect(createdContact.tenantId).toBe(tenantId);
    expect(createdContact.identities).toHaveLength(1);
    expect(createdContact.identities[0].type).toBe('email');
    // Encrypted value should not be plaintext
    expect(createdContact.identities[0].encryptedValue).not.toBe(emailValue);
    // Blind index should be deterministic hex
    expect(createdContact.identities[0].blindIndex).toMatch(/^[0-9a-f]{64}$/);
    // Should be able to decrypt back
    const decrypted = encryptor.decryptContactPII(
      tenantId,
      createdContact.identities[0].encryptedValue,
    );
    expect(decrypted).toBe(normalizeIdentity('email', emailValue));

    expect(result.tenantId).toBe(tenantId);
    expect(result.identities).toHaveLength(1);
  });

  // ===========================================================================
  // Identity normalization
  // ===========================================================================

  it('normalizes email before lookup (case-insensitive)', async () => {
    const tenantId = 'tenant-001';

    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    const result1 = await useCase.execute(tenantId, 'email', 'Alice@Example.COM');

    const created = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    const normalizedBlindIdx = encryptor.blindIndex(
      tenantId,
      normalizeIdentity('email', 'alice@example.com'),
    );
    expect(created.identities[0].blindIndex).toBe(normalizedBlindIdx);
  });

  // ===========================================================================
  // Tenant isolation
  // ===========================================================================

  it('different tenants with same identity produce different contacts', async () => {
    const emailValue = 'shared@example.com';

    // Tenant A has the contact
    const tenantAContact = makeContact({
      id: 'contact-tenant-a',
      tenantId: 'tenant-A',
    });

    // When searching for tenant-A, find the contact
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockImplementation(
      async (tenantId: string, blindIndex: string) => {
        const blindIdxA = encryptor.blindIndex('tenant-A', normalizeIdentity('email', emailValue));
        if (tenantId === 'tenant-A' && blindIndex === blindIdxA) {
          return tenantAContact;
        }
        return null;
      },
    );
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    // Tenant A -> returns existing
    const resultA = await useCase.execute('tenant-A', 'email', emailValue);
    expect(resultA.id).toBe('contact-tenant-a');

    // Tenant B -> creates new (different blind index due to tenant-scoped HMAC)
    const resultB = await useCase.execute('tenant-B', 'email', emailValue);
    expect(repo.create).toHaveBeenCalledTimes(1);
    const createdForB = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    expect(createdForB.tenantId).toBe('tenant-B');
  });

  // ===========================================================================
  // Channel type passthrough
  // ===========================================================================

  it('sets channel on the identity when channelType provided', async () => {
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    await useCase.execute('tenant-001', 'phone', '+15551234567', 'whatsapp');

    const created = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    expect(created.identities[0].channel).toBe('whatsapp');
  });

  it('sets channel to null when channelType not provided', async () => {
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    await useCase.execute('tenant-001', 'email', 'test@example.com');

    const created = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    expect(created.identities[0].channel).toBeNull();
  });

  // ===========================================================================
  // Encryption salt
  // ===========================================================================

  it('new contact has encryptionSalt of 64 hex chars', async () => {
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    const result = await useCase.execute('tenant-001', 'email', 'salt-test@example.com');

    const created = (repo.create as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    expect(created.encryptionSalt).toMatch(/^[0-9a-f]{64}$/);
    expect(result.encryptionSalt).toMatch(/^[0-9a-f]{64}$/);
  });

  it('existing contact resolution does NOT overwrite salt', async () => {
    const existingSalt = 'a'.repeat(64);
    const existing = makeContact({
      id: 'existing-salt-contact',
      tenantId: 'tenant-001',
      encryptionSalt: existingSalt,
      identities: [
        {
          type: 'email',
          encryptedValue: 'enc-val',
          blindIndex: encryptor.blindIndex(
            'tenant-001',
            normalizeIdentity('email', 'existing@example.com'),
          ),
          verified: false,
          verifiedAt: null,
          verifiedVia: null,
          channel: null,
        },
      ],
    });

    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

    const result = await useCase.execute('tenant-001', 'email', 'existing@example.com');

    expect(result.encryptionSalt).toBe(existingSalt);
    expect(repo.create).not.toHaveBeenCalled();
  });
});
