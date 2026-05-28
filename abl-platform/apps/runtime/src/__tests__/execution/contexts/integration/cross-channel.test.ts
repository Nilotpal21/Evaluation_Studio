/**
 * Cross-Channel Continuity Integration Test
 *
 * Validates that a user who starts on one channel (web) can be recognized
 * on another channel (WhatsApp) through contact identity resolution and merging.
 *
 * Uses real use cases with an in-memory ContactRepository -- no mocking of
 * use case logic. Only infrastructure is replaced with in-memory implementations.
 *
 * Flow:
 *   1. User arrives on web with email (tier 2 via HMAC) -> Contact created
 *   2. User arrives on WhatsApp with phone (provider-verified) -> Separate contact created
 *   3. User self-merges by providing email on WhatsApp -> Contacts merged
 *   4. Both sessions share the same surviving contactId
 */

import { describe, it, expect, beforeEach } from 'vitest';
import crypto from 'node:crypto';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { ContactIdentity } from '../../../../contexts/contact/domain/contact-identity.js';
import type { ContactRepository } from '../../../../contexts/contact/domain/contact-repository.js';
import type { ChannelType } from '../../../../channels/types.js';
import { EncryptionService } from '@agent-platform/shared/encryption';
import { ResolveOrCreateContact } from '../../../../contexts/contact/use-cases/resolve-or-create-contact.js';
import { LinkSessionToContact } from '../../../../contexts/contact/use-cases/link-session-to-contact.js';
import { SelfMerge } from '../../../../contexts/contact/use-cases/self-merge.js';

// =============================================================================
// IN-MEMORY CONTACT REPOSITORY
// =============================================================================

/**
 * In-memory implementation of ContactRepository for integration tests.
 * Implements tenant isolation by filtering on tenantId in every operation.
 */
class InMemoryContactRepository implements ContactRepository {
  private readonly store = new Map<string, Contact>();

  async findById(tenantId: string, contactId: string): Promise<Contact | null> {
    const contact = this.store.get(contactId);
    if (!contact || contact.tenantId !== tenantId) return null;
    return structuredClone(contact);
  }

  async findByBlindIndex(tenantId: string, blindIndex: string): Promise<Contact | null> {
    for (const contact of this.store.values()) {
      if (contact.tenantId !== tenantId) continue;
      if (contact.deletedAt !== null) continue;
      const match = contact.identities.some((i) => i.blindIndex === blindIndex);
      if (match) return structuredClone(contact);
    }
    return null;
  }

  async findByBlindIndexes(tenantId: string, blindIndexes: string[]): Promise<Contact[]> {
    const indexSet = new Set(blindIndexes);
    const results: Contact[] = [];
    for (const contact of this.store.values()) {
      if (contact.tenantId !== tenantId) continue;
      if (contact.deletedAt !== null) continue;
      const hasMatch = contact.identities.some((i) => indexSet.has(i.blindIndex));
      if (hasMatch) results.push(structuredClone(contact));
    }
    return results;
  }

  async create(contact: Contact): Promise<Contact> {
    const clone = structuredClone(contact);
    this.store.set(clone.id, clone);
    return structuredClone(clone);
  }

  async update(contact: Contact): Promise<Contact> {
    const existing = this.store.get(contact.id);
    if (!existing || existing.tenantId !== contact.tenantId) {
      throw new Error(`Contact not found for update: ${contact.id}`);
    }
    const clone = structuredClone(contact);
    this.store.set(clone.id, clone);
    return structuredClone(clone);
  }

  async addIdentity(tenantId: string, contactId: string, identity: ContactIdentity): Promise<void> {
    const contact = this.store.get(contactId);
    if (!contact || contact.tenantId !== tenantId) {
      throw new Error(`Contact not found for addIdentity: ${contactId}`);
    }
    contact.identities.push(structuredClone(identity));
  }

  async linkSession(
    tenantId: string,
    contactId: string,
    sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void> {
    const contact = this.store.get(contactId);
    if (!contact || contact.tenantId !== tenantId) {
      throw new Error(`Contact not found for linkSession: ${contactId}`);
    }

    const now = new Date();
    contact.sessionCount += 1;
    contact.lastSeenAt = now;

    const existingEntry = contact.channelHistory.find(
      (h) => h.channelType === channelType && h.channelId === channelId,
    );
    if (existingEntry) {
      existingEntry.lastSessionAt = now;
      existingEntry.sessionCount += 1;
    } else {
      contact.channelHistory.push({
        channelType,
        channelId,
        firstSessionAt: now,
        lastSessionAt: now,
        sessionCount: 1,
      });
    }
  }

  async softDelete(tenantId: string, contactId: string): Promise<void> {
    const contact = this.store.get(contactId);
    if (!contact || contact.tenantId !== tenantId) return;
    contact.deletedAt = new Date();
  }

  async hardDelete(tenantId: string, contactId: string): Promise<void> {
    const contact = this.store.get(contactId);
    if (!contact || contact.tenantId !== tenantId) return;
    this.store.delete(contactId);
  }

  async nullifyEncryptionSalt(tenantId: string, contactId: string): Promise<void> {
    const contact = this.store.get(contactId);
    if (contact && contact.tenantId === tenantId) {
      contact.encryptionSalt = null;
    }
  }

  async findMergeCandidates(tenantId: string, blindIndexes: string[]): Promise<Contact[]> {
    return this.findByBlindIndexes(tenantId, blindIndexes);
  }
}

// =============================================================================
// CONSTANTS
// =============================================================================

const TEST_MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');

// =============================================================================
// TESTS
// =============================================================================

describe('Cross-Channel Continuity', () => {
  let contactRepo: InMemoryContactRepository;
  let encryptor: EncryptionService;
  let resolveOrCreate: ResolveOrCreateContact;
  let linkSession: LinkSessionToContact;
  let selfMerge: SelfMerge;

  beforeEach(() => {
    contactRepo = new InMemoryContactRepository();
    encryptor = new EncryptionService({ masterKeyHex: TEST_MASTER_KEY_HEX });
    resolveOrCreate = new ResolveOrCreateContact(contactRepo, encryptor);
    linkSession = new LinkSessionToContact(contactRepo);
    selfMerge = new SelfMerge(contactRepo, encryptor);
  });

  // ---------------------------------------------------------------------------
  // Primary scenario: web -> WhatsApp cross-channel merge
  // ---------------------------------------------------------------------------

  it('user on web channel gets same contact when switching to WhatsApp via self-merge', async () => {
    const tenantId = 'tenant-1';

    // 1. User arrives on web with email identity (tier 2 via HMAC)
    const webSessionId = 'web-session-1';
    const webChannelId = 'web-channel-1';
    const email = 'user@example.com';

    const webContact = await resolveOrCreate.execute(tenantId, 'email', email, 'web_chat');
    await linkSession.execute(tenantId, webContact.id, webSessionId, 'web_chat', webChannelId);

    // Verify web contact was created with one identity
    expect(webContact.identities).toHaveLength(1);
    expect(webContact.identities[0].type).toBe('email');
    expect(webContact.tenantId).toBe(tenantId);

    // 2. Same user arrives on WhatsApp with phone (provider-verified)
    const waSessionId = 'wa-session-1';
    const waChannelId = 'wa-channel-1';
    const phone = '+1234567890';

    // Phone creates a separate contact initially
    const waContact = await resolveOrCreate.execute(tenantId, 'phone', phone, 'whatsapp');
    await linkSession.execute(tenantId, waContact.id, waSessionId, 'whatsapp', waChannelId);

    // At this point, web and WhatsApp contacts are separate
    expect(webContact.id).not.toBe(waContact.id);
    expect(waContact.identities).toHaveLength(1);
    expect(waContact.identities[0].type).toBe('phone');

    // 3. User self-merges by providing their email on WhatsApp
    const mergeResult = await selfMerge.execute(tenantId, waContact.id, 'email', email);

    // The contacts should now be merged
    expect(mergeResult.success).toBe(true);
    expect(mergeResult.merged).toBe(true);

    // The surviving contact has both identities
    const survivingContact = mergeResult.contact!;
    expect(survivingContact.identities).toHaveLength(2);

    // Both identity types are present
    const identityTypes = survivingContact.identities.map((i) => i.type);
    expect(identityTypes).toContain('email');
    expect(identityTypes).toContain('phone');
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation: same identity across tenants stays separate
  // ---------------------------------------------------------------------------

  it('tenant isolation: same identity across tenants creates separate contacts', async () => {
    const email = 'shared@example.com';

    // Tenant A creates a contact with this email
    const contactA = await resolveOrCreate.execute('tenant-A', 'email', email, 'web_chat');
    await linkSession.execute('tenant-A', contactA.id, 'sess-A', 'web_chat', 'ch-A');

    // Tenant B creates a contact with the same email
    const contactB = await resolveOrCreate.execute('tenant-B', 'email', email, 'web_chat');
    await linkSession.execute('tenant-B', contactB.id, 'sess-B', 'web_chat', 'ch-B');

    // Contacts must be different -- blind indexes are tenant-scoped
    expect(contactA.id).not.toBe(contactB.id);
    expect(contactA.tenantId).toBe('tenant-A');
    expect(contactB.tenantId).toBe('tenant-B');

    // Blind indexes should differ because they are derived with tenant-scoped keys
    expect(contactA.identities[0].blindIndex).not.toBe(contactB.identities[0].blindIndex);

    // Encrypted values should also differ due to tenant-scoped encryption keys
    expect(contactA.identities[0].encryptedValue).not.toBe(contactB.identities[0].encryptedValue);

    // Both decrypt to the same normalized value within their respective tenant scope
    const decryptedA = encryptor.decryptContactPII(
      'tenant-A',
      contactA.identities[0].encryptedValue,
    );
    const decryptedB = encryptor.decryptContactPII(
      'tenant-B',
      contactB.identities[0].encryptedValue,
    );
    expect(decryptedA).toBe(decryptedB);
    expect(decryptedA).toBe('shared@example.com');
  });

  // ---------------------------------------------------------------------------
  // Same channel, same identity resolves to existing contact (no duplicate)
  // ---------------------------------------------------------------------------

  it('same channel same identity resolves to existing contact without duplication', async () => {
    const tenantId = 'tenant-2';
    const email = 'returning@example.com';

    // First visit: create contact
    const firstContact = await resolveOrCreate.execute(tenantId, 'email', email, 'web_chat');
    await linkSession.execute(tenantId, firstContact.id, 'sess-1', 'web_chat', 'ch-web');

    // Second visit: same email, same channel -> should resolve to same contact
    const secondContact = await resolveOrCreate.execute(tenantId, 'email', email, 'web_chat');
    await linkSession.execute(tenantId, secondContact.id, 'sess-2', 'web_chat', 'ch-web');

    // Same contact -- no duplication
    expect(secondContact.id).toBe(firstContact.id);
    expect(secondContact.identities).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // Self-merge with already-owned identity is a no-op
  // ---------------------------------------------------------------------------

  it('self-merge with an identity the contact already owns is a no-op', async () => {
    const tenantId = 'tenant-3';
    const email = 'already@example.com';

    const contact = await resolveOrCreate.execute(tenantId, 'email', email, 'web_chat');

    // Self-merge with the same email the contact already has
    const result = await selfMerge.execute(tenantId, contact.id, 'email', email);

    expect(result.success).toBe(true);
    expect(result.merged).toBe(false); // Not merged, just recognized as same identity
    expect(result.contact!.identities).toHaveLength(1);
    expect(result.contact!.id).toBe(contact.id);
  });

  // ---------------------------------------------------------------------------
  // Self-merge adds new identity when no other contact owns it
  // ---------------------------------------------------------------------------

  it('self-merge adds new identity when no other contact owns it', async () => {
    const tenantId = 'tenant-4';
    const email = 'user@example.com';
    const phone = '+19876543210';

    // Create contact with email
    const contact = await resolveOrCreate.execute(tenantId, 'email', email, 'web_chat');

    // Self-merge with phone that no other contact has
    const result = await selfMerge.execute(tenantId, contact.id, 'phone', phone);

    expect(result.success).toBe(true);
    expect(result.merged).toBe(false); // No merge occurred, just added identity
    expect(result.contact!.identities).toHaveLength(2);

    const identityTypes = result.contact!.identities.map((i) => i.type);
    expect(identityTypes).toContain('email');
    expect(identityTypes).toContain('phone');
  });

  // ---------------------------------------------------------------------------
  // Channel history is tracked correctly across channels
  // ---------------------------------------------------------------------------

  it('channel history tracks interactions across multiple channels', async () => {
    const tenantId = 'tenant-5';
    const email = 'multichannel@example.com';

    const contact = await resolveOrCreate.execute(tenantId, 'email', email, 'web_chat');

    // Link sessions from different channels
    await linkSession.execute(tenantId, contact.id, 'sess-web', 'web_chat', 'ch-web');
    await linkSession.execute(tenantId, contact.id, 'sess-wa', 'whatsapp', 'ch-wa');
    await linkSession.execute(tenantId, contact.id, 'sess-web-2', 'web_chat', 'ch-web');

    // Fetch the updated contact
    const updated = await contactRepo.findById(tenantId, contact.id);
    expect(updated).not.toBeNull();
    expect(updated!.sessionCount).toBe(3);
    expect(updated!.channelHistory).toHaveLength(2);

    const webHistory = updated!.channelHistory.find((h) => h.channelType === 'web_chat');
    const waHistory = updated!.channelHistory.find((h) => h.channelType === 'whatsapp');

    expect(webHistory).toBeDefined();
    expect(webHistory!.sessionCount).toBe(2);

    expect(waHistory).toBeDefined();
    expect(waHistory!.sessionCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // Cross-tenant merge isolation: merge in tenant A does not affect tenant B
  // ---------------------------------------------------------------------------

  it('merge in one tenant does not affect contacts in another tenant', async () => {
    const email = 'cross@example.com';
    const phone = '+11112223333';

    // Tenant A: two contacts, then merge
    const contactA1 = await resolveOrCreate.execute('tenant-A', 'email', email, 'web_chat');
    const contactA2 = await resolveOrCreate.execute('tenant-A', 'phone', phone, 'whatsapp');
    const mergeA = await selfMerge.execute('tenant-A', contactA2.id, 'email', email);
    expect(mergeA.success).toBe(true);
    expect(mergeA.merged).toBe(true);

    // Tenant B: same identities, but separate contacts, unaffected by tenant A's merge
    const contactB1 = await resolveOrCreate.execute('tenant-B', 'email', email, 'web_chat');
    const contactB2 = await resolveOrCreate.execute('tenant-B', 'phone', phone, 'whatsapp');

    // Tenant B contacts should be independent
    expect(contactB1.id).not.toBe(contactB2.id);
    expect(contactB1.identities).toHaveLength(1);
    expect(contactB2.identities).toHaveLength(1);

    // Tenant B can do its own merge independently
    const mergeB = await selfMerge.execute('tenant-B', contactB2.id, 'email', email);
    expect(mergeB.success).toBe(true);
    expect(mergeB.merged).toBe(true);
    expect(mergeB.contact!.identities).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // Email normalization: case-insensitive matching across channels
  // ---------------------------------------------------------------------------

  it('email normalization ensures case-insensitive matching across channels', async () => {
    const tenantId = 'tenant-6';

    // Create contact with lowercase email on web
    const contact1 = await resolveOrCreate.execute(
      tenantId,
      'email',
      'User@Example.COM',
      'web_chat',
    );

    // Same email with different casing on another channel resolves to same contact
    const contact2 = await resolveOrCreate.execute(
      tenantId,
      'email',
      'user@example.com',
      'whatsapp',
    );

    expect(contact2.id).toBe(contact1.id);
  });

  // ---------------------------------------------------------------------------
  // Phone normalization: E.164 matching across channels
  // ---------------------------------------------------------------------------

  it('phone normalization ensures E.164 matching across channels', async () => {
    const tenantId = 'tenant-7';

    // Create contact with phone on WhatsApp
    const contact1 = await resolveOrCreate.execute(
      tenantId,
      'phone',
      '+1-555-123-4567',
      'whatsapp',
    );

    // Same phone in different format resolves to same contact
    const contact2 = await resolveOrCreate.execute(tenantId, 'phone', '+15551234567', 'http_async');

    expect(contact2.id).toBe(contact1.id);
  });
});
