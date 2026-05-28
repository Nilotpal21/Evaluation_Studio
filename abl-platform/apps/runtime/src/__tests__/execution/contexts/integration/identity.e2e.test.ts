/**
 * End-to-End Identity Flow Integration Test
 *
 * Validates the full identity lifecycle by composing real use case implementations
 * with in-memory store implementations:
 *
 *   SDK init with HMAC -> first message -> session created with CallerContext (tier 2) ->
 *   contact auto-created -> resolution key registered -> second connection with same artifact ->
 *   session resumed.
 *
 * No mocking of use cases — only infrastructure ports are replaced with in-memory stores.
 */

import { createHmac, randomUUID } from 'node:crypto';
import crypto from 'node:crypto';
import { describe, it, expect, beforeEach } from 'vitest';

// Identity context
import { HmacVerifier } from '../../../../contexts/identity/infrastructure/verifiers/hmac-verifier.js';
import { VerifyIdentity } from '../../../../contexts/identity/use-cases/verify-identity.js';
import {
  ResolveSession,
  type SessionResolutionStore,
} from '../../../../contexts/identity/use-cases/resolve-session.js';
import { RegisterResolutionKey } from '../../../../contexts/identity/use-cases/register-resolution-key.js';
import { PromoteTier } from '../../../../contexts/identity/use-cases/promote-tier.js';
import type { SessionResolutionKey } from '../../../../contexts/identity/domain/session-resolution-key.js';
import {
  normalizeSessionResolutionRecord,
  type SessionResolutionRecord,
} from '../../../../contexts/identity/domain/session-resolution-record.js';
import type { VerificationInput } from '../../../../contexts/identity/domain/identity-verifier.js';

// Contact context
import { ResolveOrCreateContact } from '../../../../contexts/contact/use-cases/resolve-or-create-contact.js';
import { LinkSessionToContact } from '../../../../contexts/contact/use-cases/link-session-to-contact.js';
import { EncryptionService } from '@agent-platform/shared/encryption';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { ContactRepository } from '../../../../contexts/contact/domain/contact-repository.js';
import type { ContactIdentity } from '../../../../contexts/contact/domain/contact-identity.js';
import type { ChannelType } from '../../../../channels/types.js';

// Caller context builder
import { buildCallerContext } from '../../../../services/identity/artifact-hasher.js';

// =============================================================================
// CONSTANTS
// =============================================================================

const SECRET_KEY = 'integration-test-secret-key-hmac';
const MASTER_KEY_HEX = crypto.randomBytes(32).toString('hex');
const ONE_DAY_MS = 86_400_000;

// =============================================================================
// IN-MEMORY SESSION RESOLUTION STORE
// =============================================================================

/**
 * Map-based in-memory implementation of SessionResolutionStore.
 * Keys are tenant-scoped: `${tenantId}:${channelId}:${artifactHash}`.
 */
class InMemoryResolutionStore implements SessionResolutionStore {
  private readonly store = new Map<string, SessionResolutionRecord>();

  async findByKey(
    tenantId: string,
    channelId: string,
    artifactHash: string,
  ): Promise<SessionResolutionRecord | null> {
    const key = `${tenantId}:${channelId}:${artifactHash}`;
    return this.store.get(key) ?? null;
  }

  async save(resolutionKey: SessionResolutionKey): Promise<void> {
    const key = `${resolutionKey.tenantId}:${resolutionKey.channelId}:${resolutionKey.artifactHash}`;
    this.store.set(key, normalizeSessionResolutionRecord(resolutionKey));
  }
}

// =============================================================================
// IN-MEMORY CONTACT REPOSITORY
// =============================================================================

/**
 * Map-based in-memory implementation of ContactRepository.
 * Stores contacts by ID and maintains a blind-index lookup for resolution.
 */
class InMemoryContactRepository implements ContactRepository {
  private readonly contacts = new Map<string, Contact>();
  private readonly blindIndexMap = new Map<string, string>(); // blindIdx -> contactId

  async findById(tenantId: string, contactId: string): Promise<Contact | null> {
    const contact = this.contacts.get(contactId);
    if (contact && contact.tenantId === tenantId) {
      return contact;
    }
    return null;
  }

  async findByBlindIndex(tenantId: string, blindIndex: string): Promise<Contact | null> {
    const contactId = this.blindIndexMap.get(`${tenantId}:${blindIndex}`);
    if (!contactId) return null;
    return this.findById(tenantId, contactId);
  }

  async findByBlindIndexes(tenantId: string, blindIndexes: string[]): Promise<Contact[]> {
    const results: Contact[] = [];
    for (const idx of blindIndexes) {
      const contact = await this.findByBlindIndex(tenantId, idx);
      if (contact) results.push(contact);
    }
    return results;
  }

  async create(contact: Contact): Promise<Contact> {
    this.contacts.set(contact.id, contact);
    for (const identity of contact.identities) {
      this.blindIndexMap.set(`${contact.tenantId}:${identity.blindIndex}`, contact.id);
    }
    return contact;
  }

  async update(contact: Contact): Promise<Contact> {
    this.contacts.set(contact.id, contact);
    return contact;
  }

  async addIdentity(tenantId: string, contactId: string, identity: ContactIdentity): Promise<void> {
    const contact = await this.findById(tenantId, contactId);
    if (!contact) return;
    contact.identities.push(identity);
    this.blindIndexMap.set(`${tenantId}:${identity.blindIndex}`, contactId);
  }

  async linkSession(
    tenantId: string,
    contactId: string,
    sessionId: string,
    channelType: ChannelType,
    channelId: string,
  ): Promise<void> {
    const contact = await this.findById(tenantId, contactId);
    if (!contact) return;

    contact.sessionCount += 1;
    contact.lastSeenAt = new Date();

    const existingChannel = contact.channelHistory.find(
      (h) => h.channelType === channelType && h.channelId === channelId,
    );

    if (existingChannel) {
      existingChannel.lastSessionAt = new Date();
      existingChannel.sessionCount += 1;
    } else {
      contact.channelHistory.push({
        channelType,
        channelId,
        firstSessionAt: new Date(),
        lastSessionAt: new Date(),
        sessionCount: 1,
      });
    }
  }

  async softDelete(tenantId: string, contactId: string): Promise<void> {
    const contact = await this.findById(tenantId, contactId);
    if (contact) {
      contact.deletedAt = new Date();
    }
  }

  async hardDelete(tenantId: string, contactId: string): Promise<void> {
    const contact = this.contacts.get(contactId);
    if (contact && contact.tenantId === tenantId) {
      for (const identity of contact.identities) {
        this.blindIndexMap.delete(`${tenantId}:${identity.blindIndex}`);
      }
      this.contacts.delete(contactId);
    }
  }

  async nullifyEncryptionSalt(tenantId: string, contactId: string): Promise<void> {
    const contact = await this.findById(tenantId, contactId);
    if (contact) {
      contact.encryptionSalt = null;
    }
  }

  async findMergeCandidates(tenantId: string, blindIndexes: string[]): Promise<Contact[]> {
    return this.findByBlindIndexes(tenantId, blindIndexes);
  }
}

// =============================================================================
// HELPERS
// =============================================================================

/** Generate a valid HMAC-SHA256 signature matching the format expected by verifyHMAC. */
function makeValidHmac(userId: string, timestamp: number, secretKey: string): string {
  return createHmac('sha256', secretKey).update(`${userId}:${timestamp}`).digest('hex');
}

/** Get the current Unix timestamp in seconds. */
function currentTimestamp(): number {
  return Math.floor(Date.now() / 1000);
}

/** Build a VerificationInput for HMAC-based verification. */
function makeVerificationInput(
  tenantId: string,
  userId: string,
  hmac: string,
  timestamp: number,
): VerificationInput {
  return {
    tenantId,
    sessionId: `sess-${randomUUID()}`,
    channelType: 'web_chat',
    identityValue: userId,
    identityType: 'cookie',
    metadata: { hmac, timestamp },
  };
}

// =============================================================================
// TESTS
// =============================================================================

describe('End-to-End Identity Flow', () => {
  let resolutionStore: InMemoryResolutionStore;
  let contactRepo: InMemoryContactRepository;
  let encryptor: EncryptionService;
  let hmacVerifier: HmacVerifier;
  let verifyIdentity: VerifyIdentity;
  let resolveSession: ResolveSession;
  let registerKey: RegisterResolutionKey;
  let promoteTier: PromoteTier;
  let resolveOrCreate: ResolveOrCreateContact;
  let linkSession: LinkSessionToContact;

  beforeEach(() => {
    // Set up in-memory stores
    resolutionStore = new InMemoryResolutionStore();
    contactRepo = new InMemoryContactRepository();
    encryptor = new EncryptionService({ masterKeyHex: MASTER_KEY_HEX });

    // Set up use cases with real implementations + in-memory stores
    hmacVerifier = new HmacVerifier(SECRET_KEY);
    const verifierMap = new Map([['hmac' as const, hmacVerifier]]);
    verifyIdentity = new VerifyIdentity(verifierMap);
    resolveSession = new ResolveSession(resolutionStore);
    registerKey = new RegisterResolutionKey(resolutionStore);
    promoteTier = new PromoteTier();
    resolveOrCreate = new ResolveOrCreateContact(contactRepo, encryptor);
    linkSession = new LinkSessionToContact(contactRepo);
  });

  // ---------------------------------------------------------------------------
  // Full HMAC identity -> contact -> session resolution cycle
  // ---------------------------------------------------------------------------

  it('full HMAC identity -> contact -> session resolution cycle', async () => {
    const tenantId = 'tenant-1';
    const channelId = 'channel-web-1';
    const userId = 'user@example.com';
    const artifactHash = 'artifact-hash-abc123';

    // ---
    // Step 1: HMAC verification — simulates SDK init with HMAC
    // ---
    const ts = currentTimestamp();
    const hmac = makeValidHmac(userId, ts, SECRET_KEY);
    const verificationInput = makeVerificationInput(tenantId, userId, hmac, ts);

    const verifyResult = await verifyIdentity.execute(verificationInput);

    expect(verifyResult.success).toBe(true);
    expect(verifyResult.error).toBeUndefined();

    // ---
    // Step 2: Tier promotion — HMAC grants tier 2
    // ---
    const promoteResult = promoteTier.execute({
      currentTier: 0,
      verificationMethod: 'hmac',
    });

    expect(promoteResult.success).toBe(true);
    if (promoteResult.success) {
      expect(promoteResult.newTier).toBe(2);
    }

    // ---
    // Step 3: First connection — no existing session
    // ---
    const firstResolution = await resolveSession.execute(tenantId, channelId, artifactHash);

    expect(firstResolution.found).toBe(false);
    expect(firstResolution.sessionId).toBeUndefined();

    // ---
    // Step 4: Create session + register resolution key
    // ---
    const sessionId = `sess-${randomUUID()}`;
    await registerKey.execute({
      tenantId,
      channelId,
      artifactHash,
      sessionId,
      expiresAt: new Date(Date.now() + ONE_DAY_MS),
    });

    // ---
    // Step 5: Build CallerContext with tier 2 identity
    // ---
    const callerCtx = buildCallerContext({
      tenantId,
      channel: 'web_chat',
      channelId,
      customerId: userId,
      identityTier: 2,
      verificationMethod: 'hmac',
      rawArtifact: artifactHash,
      channelArtifactType: 'cookie',
    });

    expect(callerCtx.tenantId).toBe(tenantId);
    expect(callerCtx.identityTier).toBe(2);
    expect(callerCtx.verificationMethod).toBe('hmac');
    expect(callerCtx.customerId).toBe(userId);
    expect(callerCtx.channelArtifact).toBeDefined();

    // ---
    // Step 6: Contact auto-created for verified (tier 2) user
    // ---
    const contact = await resolveOrCreate.execute(tenantId, 'email', userId);

    expect(contact.id).toBeDefined();
    expect(contact.tenantId).toBe(tenantId);
    expect(contact.identities).toHaveLength(1);
    expect(contact.identities[0].type).toBe('email');
    // Encrypted value should not be plaintext
    expect(contact.identities[0].encryptedValue).not.toBe(userId);
    // Blind index should be a 64-char hex string
    expect(contact.identities[0].blindIndex).toMatch(/^[0-9a-f]{64}$/);

    // ---
    // Step 7: Link session to contact
    // ---
    await linkSession.execute(tenantId, contact.id, sessionId, 'web_chat', channelId);

    // Verify the link was established
    const linkedContact = await contactRepo.findById(tenantId, contact.id);
    expect(linkedContact).not.toBeNull();
    expect(linkedContact!.sessionCount).toBe(1);
    expect(linkedContact!.channelHistory).toHaveLength(1);
    expect(linkedContact!.channelHistory[0].channelType).toBe('web_chat');
    expect(linkedContact!.channelHistory[0].channelId).toBe(channelId);

    // ---
    // Step 8: Second connection — same artifact -> session found (resumed)
    // ---
    const secondResolution = await resolveSession.execute(tenantId, channelId, artifactHash);

    expect(secondResolution.found).toBe(true);
    expect(secondResolution.sessionId).toBe(sessionId);

    // ---
    // Step 9: Same user -> same contact (idempotent resolution)
    // ---
    const sameContact = await resolveOrCreate.execute(tenantId, 'email', userId);

    expect(sameContact.id).toBe(contact.id);
    expect(sameContact.tenantId).toBe(tenantId);
  });

  // ---------------------------------------------------------------------------
  // Tenant isolation: different tenants get different contacts
  // ---------------------------------------------------------------------------

  it('tenant isolation: different tenants get different contacts for same email', async () => {
    const emailValue = 'shared-user@example.com';
    const tenantA = 'tenant-A';
    const tenantB = 'tenant-B';

    // Same email resolves to different contacts in different tenants
    const contactA = await resolveOrCreate.execute(tenantA, 'email', emailValue);
    const contactB = await resolveOrCreate.execute(tenantB, 'email', emailValue);

    expect(contactA.id).toBeDefined();
    expect(contactB.id).toBeDefined();
    expect(contactA.id).not.toBe(contactB.id);
    expect(contactA.tenantId).toBe(tenantA);
    expect(contactB.tenantId).toBe(tenantB);

    // Blind indexes are different due to tenant-scoped HMAC keys
    expect(contactA.identities[0].blindIndex).not.toBe(contactB.identities[0].blindIndex);
  });

  it('tenant isolation: same artifact in different tenants does not cross-resolve', async () => {
    const channelId = 'ch-web';
    const artifactHash = 'shared-artifact-hash';
    const tenantA = 'tenant-A';
    const tenantB = 'tenant-B';
    const sessionA = 'session-A';

    // Register resolution key for tenant A
    await registerKey.execute({
      tenantId: tenantA,
      channelId,
      artifactHash,
      sessionId: sessionA,
      expiresAt: new Date(Date.now() + ONE_DAY_MS),
    });

    // Tenant A resolves successfully
    const resultA = await resolveSession.execute(tenantA, channelId, artifactHash);
    expect(resultA.found).toBe(true);
    expect(resultA.sessionId).toBe(sessionA);

    // Tenant B with same artifact -> no resolution (tenant-scoped keys)
    const resultB = await resolveSession.execute(tenantB, channelId, artifactHash);
    expect(resultB.found).toBe(false);
  });

  // ---------------------------------------------------------------------------
  // HMAC failure path: invalid HMAC does not grant tier 2
  // ---------------------------------------------------------------------------

  it('invalid HMAC does not grant identity tier promotion', async () => {
    const tenantId = 'tenant-fail';
    const userId = 'attacker@example.com';
    const ts = currentTimestamp();

    // Generate HMAC with wrong key
    const wrongHmac = makeValidHmac(userId, ts, 'wrong-secret-key');
    const verificationInput = makeVerificationInput(tenantId, userId, wrongHmac, ts);

    const verifyResult = await verifyIdentity.execute(verificationInput);

    expect(verifyResult.success).toBe(false);
    expect(verifyResult.error).toBeDefined();
    expect(verifyResult.error?.code).toBe('HMAC_INVALID');

    // Tier promotion from 0 via 'none' (no verified identity) stays at 0
    const promoteResult = promoteTier.execute({
      currentTier: 0,
      verificationMethod: 'none',
    });

    expect(promoteResult.success).toBe(false);
    if (!promoteResult.success) {
      expect(promoteResult.error.code).toBe('TIER_NOT_PROMOTED');
    }
  });

  // ---------------------------------------------------------------------------
  // Contact encrypted identity roundtrip
  // ---------------------------------------------------------------------------

  it('contact identity is encrypted and decryptable with correct tenant key', async () => {
    const tenantId = 'tenant-enc';
    const email = 'encrypted@example.com';

    const contact = await resolveOrCreate.execute(tenantId, 'email', email);

    // Encrypted value is not plaintext
    expect(contact.identities[0].encryptedValue).not.toBe(email);
    expect(contact.identities[0].encryptedValue).not.toBe(email.toLowerCase());

    // Can decrypt with the correct tenant key
    const decrypted = encryptor.decryptContactPII(tenantId, contact.identities[0].encryptedValue);
    expect(decrypted).toBe(email.toLowerCase()); // normalized

    // Different tenant cannot decrypt (throws due to auth tag mismatch)
    expect(() => {
      encryptor.decryptContactPII('wrong-tenant', contact.identities[0].encryptedValue);
    }).toThrow();
  });

  // ---------------------------------------------------------------------------
  // Multiple sessions for the same contact
  // ---------------------------------------------------------------------------

  it('links multiple sessions to the same contact', async () => {
    const tenantId = 'tenant-multi';
    const userId = 'multi-session@example.com';

    const contact = await resolveOrCreate.execute(tenantId, 'email', userId);

    // Link first session via web
    await linkSession.execute(tenantId, contact.id, 'sess-1', 'web_chat', 'ch-web-1');

    // Link second session via mobile
    await linkSession.execute(tenantId, contact.id, 'sess-2', 'web_chat', 'ch-ios-1');

    // Link third session via web (same channel)
    await linkSession.execute(tenantId, contact.id, 'sess-3', 'web_chat', 'ch-web-1');

    const updated = await contactRepo.findById(tenantId, contact.id);
    expect(updated).not.toBeNull();
    expect(updated!.sessionCount).toBe(3);
    expect(updated!.channelHistory).toHaveLength(2); // web_chat (ch-web-1) + web_chat (ch-ios-1)

    const webHistory = updated!.channelHistory.find(
      (h) => h.channelType === 'web_chat' && h.channelId === 'ch-web-1',
    );
    expect(webHistory).toBeDefined();
    expect(webHistory!.sessionCount).toBe(2); // two web sessions

    const iosHistory = updated!.channelHistory.find(
      (h) => h.channelType === 'web_chat' && h.channelId === 'ch-ios-1',
    );
    expect(iosHistory).toBeDefined();
    expect(iosHistory!.sessionCount).toBe(1);
  });

  // ---------------------------------------------------------------------------
  // VerifyIdentity dispatches to correct verifier
  // ---------------------------------------------------------------------------

  it('VerifyIdentity returns NO_VERIFIER when no matching verifier exists', async () => {
    const input: VerificationInput = {
      tenantId: 'tenant-1',
      sessionId: 'sess-1',
      channelType: 'web_chat',
      identityValue: 'user@example.com',
      identityType: 'cookie',
      // No hmac/timestamp metadata -> HmacVerifier won't support this
      metadata: {},
    };

    const result = await verifyIdentity.execute(input);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('NO_VERIFIER');
  });

  // ---------------------------------------------------------------------------
  // Resolution key overwrite: re-register updates the session
  // ---------------------------------------------------------------------------

  it('re-registering a resolution key updates the linked session', async () => {
    const tenantId = 'tenant-rewrite';
    const channelId = 'ch-web';
    const artifactHash = 'artifact-123';

    // Register first session
    await registerKey.execute({
      tenantId,
      channelId,
      artifactHash,
      sessionId: 'old-session',
      expiresAt: new Date(Date.now() + ONE_DAY_MS),
    });

    const first = await resolveSession.execute(tenantId, channelId, artifactHash);
    expect(first.found).toBe(true);
    expect(first.sessionId).toBe('old-session');

    // Re-register with new session
    await registerKey.execute({
      tenantId,
      channelId,
      artifactHash,
      sessionId: 'new-session',
      expiresAt: new Date(Date.now() + ONE_DAY_MS),
    });

    const second = await resolveSession.execute(tenantId, channelId, artifactHash);
    expect(second.found).toBe(true);
    expect(second.sessionId).toBe('new-session');
  });
});
