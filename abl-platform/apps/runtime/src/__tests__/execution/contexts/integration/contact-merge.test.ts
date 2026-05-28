/**
 * Contact Merge Integration Test
 *
 * Validates the full merge lifecycle:
 *   1. Create two separate contacts via different channels (web + WhatsApp)
 *   2. Add an overlapping email identity to contact B
 *   3. DetectMergeCandidates finds the overlap
 *   4. ExecuteMerge consolidates contacts
 *   5. Verify: unified contact has both identities, secondary is soft-deleted
 *
 * Also tests tenant isolation: merge detection must not leak across tenants.
 *
 * Uses an InMemoryContactRepository so no external infrastructure is needed.
 */

import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { ContactIdentity } from '../../../../contexts/contact/domain/contact-identity.js';
import { createContactIdentity } from '../../../../contexts/contact/domain/contact-identity.js';
import type { ContactRepository } from '../../../../contexts/contact/domain/contact-repository.js';
import type { ChannelType } from '../../../../channels/types.js';
import type { ChannelHistoryEntry } from '../../../../contexts/contact/domain/contact.js';
import { EncryptionService } from '@agent-platform/shared/encryption';
import { normalizeIdentity } from '../../../../contexts/contact/infrastructure/normalize-identity.js';
import { ResolveOrCreateContact } from '../../../../contexts/contact/use-cases/resolve-or-create-contact.js';
import { DetectMergeCandidates } from '../../../../contexts/contact/use-cases/detect-merge-candidates.js';
import { ExecuteMerge } from '../../../../contexts/contact/use-cases/execute-merge.js';
import { LinkSessionToContact } from '../../../../contexts/contact/use-cases/link-session-to-contact.js';

// =============================================================================
// InMemoryContactRepository
// =============================================================================

/**
 * In-memory implementation of ContactRepository for testing.
 * Stores contacts in a tenant-keyed Map for proper tenant isolation.
 */
class InMemoryContactRepository implements ContactRepository {
  /** Map<tenantId, Map<contactId, Contact>> */
  private readonly store = new Map<string, Map<string, Contact>>();

  async findById(tenantId: string, contactId: string): Promise<Contact | null> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return null;
    return tenantStore.get(contactId) ?? null;
  }

  async findByBlindIndex(tenantId: string, blindIndex: string): Promise<Contact | null> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return null;

    for (const contact of tenantStore.values()) {
      if (contact.deletedAt) continue;
      for (const identity of contact.identities) {
        if (identity.blindIndex === blindIndex) {
          return contact;
        }
      }
    }
    return null;
  }

  async findByBlindIndexes(tenantId: string, blindIndexes: string[]): Promise<Contact[]> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return [];

    const indexSet = new Set(blindIndexes);
    const matches: Contact[] = [];

    for (const contact of tenantStore.values()) {
      if (contact.deletedAt) continue;
      for (const identity of contact.identities) {
        if (indexSet.has(identity.blindIndex)) {
          matches.push(contact);
          break; // Don't add the same contact twice
        }
      }
    }
    return matches;
  }

  async create(contact: Contact): Promise<Contact> {
    let tenantStore = this.store.get(contact.tenantId);
    if (!tenantStore) {
      tenantStore = new Map();
      this.store.set(contact.tenantId, tenantStore);
    }
    const clone = structuredClone(contact);
    tenantStore.set(clone.id, clone);
    return structuredClone(clone);
  }

  async update(contact: Contact): Promise<Contact> {
    const tenantStore = this.store.get(contact.tenantId);
    if (!tenantStore) {
      throw new Error(`Tenant ${contact.tenantId} not found`);
    }
    if (!tenantStore.has(contact.id)) {
      throw new Error(`Contact ${contact.id} not found in tenant ${contact.tenantId}`);
    }
    const clone = structuredClone(contact);
    tenantStore.set(clone.id, clone);
    return structuredClone(clone);
  }

  async addIdentity(tenantId: string, contactId: string, identity: ContactIdentity): Promise<void> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    const contact = tenantStore.get(contactId);
    if (!contact) {
      throw new Error(`Contact ${contactId} not found in tenant ${tenantId}`);
    }
    contact.identities.push(structuredClone(identity));
  }

  async linkSession(
    tenantId: string,
    contactId: string,
    _sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) {
      throw new Error(`Tenant ${tenantId} not found`);
    }
    const contact = tenantStore.get(contactId);
    if (!contact) {
      throw new Error(`Contact ${contactId} not found in tenant ${tenantId}`);
    }

    // Increment session count
    contact.sessionCount += 1;
    contact.lastSeenAt = new Date();

    // Upsert channel history entry
    const existingEntry = contact.channelHistory.find(
      (e) => e.channelType === channelType && e.channelId === channelId,
    );

    if (existingEntry) {
      existingEntry.lastSessionAt = new Date();
      existingEntry.sessionCount += 1;
    } else {
      const now = new Date();
      const entry: ChannelHistoryEntry = {
        channelType,
        channelId,
        firstSessionAt: now,
        lastSessionAt: now,
        sessionCount: 1,
      };
      contact.channelHistory.push(entry);
    }
  }

  async softDelete(tenantId: string, contactId: string): Promise<void> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return;
    const contact = tenantStore.get(contactId);
    if (contact) {
      contact.deletedAt = new Date();
    }
  }

  async hardDelete(tenantId: string, contactId: string): Promise<void> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return;
    tenantStore.delete(contactId);
  }

  async nullifyEncryptionSalt(tenantId: string, contactId: string): Promise<void> {
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return;
    const contact = tenantStore.get(contactId);
    if (contact) {
      contact.encryptionSalt = null;
    }
  }

  async findMergeCandidates(tenantId: string, blindIndexes: string[]): Promise<Contact[]> {
    // Same as findByBlindIndexes — returns all contacts (including deleted)
    // that share any of the given blind indexes. The caller filters out
    // the source contact and applies further business rules.
    const tenantStore = this.store.get(tenantId);
    if (!tenantStore) return [];

    const indexSet = new Set(blindIndexes);
    const matches: Contact[] = [];

    for (const contact of tenantStore.values()) {
      // Include soft-deleted contacts too — the use case decides whether to skip them.
      // But skip contacts with mergedInto set (already merged away).
      if (contact.mergedInto) continue;
      for (const identity of contact.identities) {
        if (indexSet.has(identity.blindIndex)) {
          matches.push(structuredClone(contact));
          break;
        }
      }
    }
    return matches;
  }
}

// =============================================================================
// Test Constants
// =============================================================================

/** 256-bit master key (64 hex chars) for EncryptionService. */
const MASTER_KEY_HEX = 'a'.repeat(64);

// =============================================================================
// Tests
// =============================================================================

describe('Contact Merge Integration', () => {
  let contactRepo: InMemoryContactRepository;
  let encryptor: EncryptionService;
  let resolveOrCreate: ResolveOrCreateContact;
  let detectMerge: DetectMergeCandidates;
  let executeMerge: ExecuteMerge;
  let linkSession: LinkSessionToContact;

  beforeEach(() => {
    contactRepo = new InMemoryContactRepository();
    encryptor = new EncryptionService({ masterKeyHex: MASTER_KEY_HEX });
    resolveOrCreate = new ResolveOrCreateContact(contactRepo, encryptor);
    detectMerge = new DetectMergeCandidates(contactRepo);
    executeMerge = new ExecuteMerge(contactRepo);
    linkSession = new LinkSessionToContact(contactRepo);
  });

  it('full merge lifecycle: create -> detect overlap -> merge -> verify', async () => {
    const tenantId = 'tenant-1';

    // -------------------------------------------------------------------------
    // 1. Create contact A via web (email identity)
    // -------------------------------------------------------------------------
    const contactA = await resolveOrCreate.execute(
      tenantId,
      'email',
      'user@example.com',
      'web_chat',
    );
    await linkSession.execute(tenantId, contactA.id, 'session-web', 'web_chat', 'channel-web');

    // -------------------------------------------------------------------------
    // 2. Create contact B via WhatsApp (phone identity)
    // -------------------------------------------------------------------------
    const contactB = await resolveOrCreate.execute(tenantId, 'phone', '+1234567890', 'whatsapp');
    await linkSession.execute(tenantId, contactB.id, 'session-wa', 'whatsapp', 'channel-wa');

    // Contacts are separate at this point
    expect(contactA.id).not.toBe(contactB.id);

    // Verify each contact has exactly one identity
    const fetchedA = await contactRepo.findById(tenantId, contactA.id);
    const fetchedB = await contactRepo.findById(tenantId, contactB.id);
    expect(fetchedA!.identities).toHaveLength(1);
    expect(fetchedB!.identities).toHaveLength(1);

    // -------------------------------------------------------------------------
    // 3. Add overlapping email to contact B (user provides same email on WhatsApp)
    // -------------------------------------------------------------------------
    const normalizedEmail = normalizeIdentity('email', 'user@example.com');
    const emailBlindIdx = encryptor.blindIndex(tenantId, normalizedEmail);
    const encryptedEmail = encryptor.encryptContactPII(tenantId, normalizedEmail);

    const overlappingIdentity = createContactIdentity({
      type: 'email',
      encryptedValue: encryptedEmail,
      blindIndex: emailBlindIdx,
      channel: 'whatsapp',
    });

    await contactRepo.addIdentity(tenantId, contactB.id, overlappingIdentity);

    // Verify contact B now has 2 identities (phone + email)
    const updatedB = await contactRepo.findById(tenantId, contactB.id);
    expect(updatedB!.identities).toHaveLength(2);

    // -------------------------------------------------------------------------
    // 4. Detect merge candidates for contact B
    // -------------------------------------------------------------------------
    const candidates = await detectMerge.execute(tenantId, contactB.id);

    // Contact A should be a candidate (shares the email blind index)
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    const candidateIds = candidates.map((c) => c.id);
    expect(candidateIds).toContain(contactA.id);

    // Should NOT contain contact B itself
    expect(candidateIds).not.toContain(contactB.id);

    // -------------------------------------------------------------------------
    // 5. Admin accepts merge: A is primary, B is secondary
    // -------------------------------------------------------------------------
    const mergeResult = await executeMerge.execute(tenantId, contactA.id, contactB.id, 'admin-1');
    expect(mergeResult.success).toBe(true);
    expect(mergeResult.data).toBeDefined();
    expect(mergeResult.data!.primaryContactId).toBe(contactA.id);
    expect(mergeResult.data!.secondaryContactId).toBe(contactB.id);
    expect(mergeResult.data!.mergedBy).toBe('admin-1');

    // -------------------------------------------------------------------------
    // 6. Verify merged state
    // -------------------------------------------------------------------------
    const mergedContact = await contactRepo.findById(tenantId, contactA.id);
    expect(mergedContact).not.toBeNull();

    // Merged contact has both identity types (email + phone)
    const identityTypes = mergedContact!.identities.map((i) => i.type);
    expect(identityTypes).toContain('email');
    expect(identityTypes).toContain('phone');

    // The email blind index that was shared should be deduplicated
    // (primary already had it, so it should not be duplicated)
    const emailIdentities = mergedContact!.identities.filter((i) => i.type === 'email');
    expect(emailIdentities).toHaveLength(1);

    // Secondary contact is soft-deleted with mergedInto pointer
    const secondary = await contactRepo.findById(tenantId, contactB.id);
    expect(secondary).not.toBeNull();
    expect(secondary!.mergedInto).toBe(contactA.id);
    expect(secondary!.deletedAt).toBeTruthy();

    // Secondary identities were cleared (moved to primary)
    expect(secondary!.identities).toHaveLength(0);

    // Channel history merged — should have web + whatsapp entries
    expect(mergedContact!.channelHistory).toHaveLength(2);
    const channelTypes = mergedContact!.channelHistory.map((h) => h.channelType);
    expect(channelTypes).toContain('web_chat');
    expect(channelTypes).toContain('whatsapp');

    // Session count is combined
    expect(mergedContact!.sessionCount).toBe(2);
  });

  it('detect merge candidates from primary perspective also works', async () => {
    const tenantId = 'tenant-1';

    // Create contact A with email
    const contactA = await resolveOrCreate.execute(
      tenantId,
      'email',
      'shared@example.com',
      'web_chat',
    );

    // Create contact B with phone, then add the same email
    const contactB = await resolveOrCreate.execute(tenantId, 'phone', '+9876543210', 'whatsapp');

    const normalizedEmail = normalizeIdentity('email', 'shared@example.com');
    const emailBlindIdx = encryptor.blindIndex(tenantId, normalizedEmail);
    const encryptedEmail = encryptor.encryptContactPII(tenantId, normalizedEmail);

    await contactRepo.addIdentity(
      tenantId,
      contactB.id,
      createContactIdentity({
        type: 'email',
        encryptedValue: encryptedEmail,
        blindIndex: emailBlindIdx,
        channel: 'whatsapp',
      }),
    );

    // Detect from contact A's perspective — should find B as candidate
    const candidatesFromA = await detectMerge.execute(tenantId, contactA.id);
    const candidateIds = candidatesFromA.map((c) => c.id);
    expect(candidateIds).toContain(contactB.id);
    expect(candidateIds).not.toContain(contactA.id);
  });

  it('resolves to existing contact when same identity is provided again', async () => {
    const tenantId = 'tenant-1';

    // Create contact with email
    const contactA = await resolveOrCreate.execute(
      tenantId,
      'email',
      'same@example.com',
      'web_chat',
    );

    // Resolve again with same email — should return the same contact
    const resolved = await resolveOrCreate.execute(
      tenantId,
      'email',
      'same@example.com',
      'web_chat',
    );

    expect(resolved.id).toBe(contactA.id);
  });

  it('tenant isolation: merge candidates only within same tenant', async () => {
    const tenant1 = 'tenant-1';
    const tenant2 = 'tenant-2';
    const sharedEmail = 'shared@example.com';

    // Create contact in tenant-1 with email X
    const contact1 = await resolveOrCreate.execute(tenant1, 'email', sharedEmail, 'web_chat');
    await linkSession.execute(tenant1, contact1.id, 'session-t1', 'web_chat', 'channel-t1');

    // Create contact in tenant-2 with the same email X
    const contact2 = await resolveOrCreate.execute(tenant2, 'email', sharedEmail, 'web_chat');
    await linkSession.execute(tenant2, contact2.id, 'session-t2', 'web_chat', 'channel-t2');

    // Contacts are different (different tenants)
    expect(contact1.id).not.toBe(contact2.id);

    // Add a second identity to contact1 to trigger merge detection
    const normalizedPhone = normalizeIdentity('phone', '+5551112222');
    const phoneBlindIdx = encryptor.blindIndex(tenant1, normalizedPhone);
    const encryptedPhone = encryptor.encryptContactPII(tenant1, normalizedPhone);

    await contactRepo.addIdentity(
      tenant1,
      contact1.id,
      createContactIdentity({
        type: 'phone',
        encryptedValue: encryptedPhone,
        blindIndex: phoneBlindIdx,
        channel: 'web_chat',
      }),
    );

    // Detection for tenant-1 contact should NOT find tenant-2 contact
    const candidates = await detectMerge.execute(tenant1, contact1.id);
    const candidateIds = candidates.map((c) => c.id);
    expect(candidateIds).not.toContain(contact2.id);

    // Detection for tenant-2 contact should NOT find tenant-1 contact
    const candidates2 = await detectMerge.execute(tenant2, contact2.id);
    const candidateIds2 = candidates2.map((c) => c.id);
    expect(candidateIds2).not.toContain(contact1.id);
  });

  it('merge with non-existent primary returns structured error', async () => {
    const tenantId = 'tenant-1';

    const contactB = await resolveOrCreate.execute(
      tenantId,
      'email',
      'test@example.com',
      'web_chat',
    );

    const result = await executeMerge.execute(tenantId, 'non-existent-id', contactB.id, 'admin-1');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('CONTACT_NOT_FOUND');
  });

  it('merge with non-existent secondary returns structured error', async () => {
    const tenantId = 'tenant-1';

    const contactA = await resolveOrCreate.execute(
      tenantId,
      'email',
      'test@example.com',
      'web_chat',
    );

    const result = await executeMerge.execute(tenantId, contactA.id, 'non-existent-id', 'admin-1');

    expect(result.success).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.code).toBe('CONTACT_NOT_FOUND');
  });

  it('no merge candidates when contacts have disjoint identities', async () => {
    const tenantId = 'tenant-1';

    // Create two contacts with completely different identities
    const contactA = await resolveOrCreate.execute(
      tenantId,
      'email',
      'alice@example.com',
      'web_chat',
    );
    const contactB = await resolveOrCreate.execute(tenantId, 'phone', '+1111111111', 'whatsapp');

    // Neither should find the other as a merge candidate
    const candidatesA = await detectMerge.execute(tenantId, contactA.id);
    expect(candidatesA).toHaveLength(0);

    const candidatesB = await detectMerge.execute(tenantId, contactB.id);
    expect(candidatesB).toHaveLength(0);
  });

  it('merge deduplicates shared blind indexes', async () => {
    const tenantId = 'tenant-1';

    // Both contacts have the exact same email identity (same blind index)
    const contactA = await resolveOrCreate.execute(
      tenantId,
      'email',
      'dup@example.com',
      'web_chat',
    );
    // Create B separately with a different identity first
    const contactB = await resolveOrCreate.execute(tenantId, 'phone', '+3333333333', 'http_async');

    // Add the same email to contact B
    const normalized = normalizeIdentity('email', 'dup@example.com');
    const blindIdx = encryptor.blindIndex(tenantId, normalized);
    const encrypted = encryptor.encryptContactPII(tenantId, normalized);

    await contactRepo.addIdentity(
      tenantId,
      contactB.id,
      createContactIdentity({
        type: 'email',
        encryptedValue: encrypted,
        blindIndex: blindIdx,
        channel: 'http_async',
      }),
    );

    // Merge B into A
    const result = await executeMerge.execute(tenantId, contactA.id, contactB.id, 'admin-1');
    expect(result.success).toBe(true);

    // Primary should have email (original) + phone (from B), NOT two emails
    const merged = await contactRepo.findById(tenantId, contactA.id);
    expect(merged).not.toBeNull();

    const emailIdentities = merged!.identities.filter((i) => i.type === 'email');
    const phoneIdentities = merged!.identities.filter((i) => i.type === 'phone');

    // Email should appear exactly once (deduplicated by blind index)
    expect(emailIdentities).toHaveLength(1);
    // Phone should be moved from B
    expect(phoneIdentities).toHaveLength(1);

    // Verify the moved identities in the merge execution record
    expect(result.data!.identitiesMoved).toHaveLength(1);
    expect(result.data!.identitiesMoved[0].type).toBe('phone');
  });
});
