/**
 * CascadeDeleteContact Use Case Tests
 *
 * Validates hard-delete of a contact with tenant ownership verification
 * and audit event emission via callback port.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { ContactRepository } from '../../../../contexts/contact/domain/contact-repository.js';
import { CascadeDeleteContact } from '../../../../contexts/contact/use-cases/cascade-delete-contact.js';
import type { AuditCallback } from '../../../../contexts/contact/use-cases/cascade-delete-contact.js';

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
    contactContext: overrides.contactContext ?? null,
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

describe('CascadeDeleteContact', () => {
  let repo: ContactRepository;
  let auditCallback: AuditCallback;
  let useCase: CascadeDeleteContact;

  beforeEach(() => {
    repo = createMockRepo();
    auditCallback = vi.fn().mockResolvedValue(undefined);
    useCase = new CascadeDeleteContact(repo, auditCallback);
  });

  // ===========================================================================
  // Successful deletion
  // ===========================================================================

  it('loads contact, hard-deletes it, and returns success', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-to-delete';
    const contact = makeContact({ id: contactId, tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    const result = await useCase.execute(tenantId, contactId);

    expect(result.success).toBe(true);
    expect(repo.findById).toHaveBeenCalledWith(tenantId, contactId);
    expect(repo.hardDelete).toHaveBeenCalledWith(tenantId, contactId);
  });

  // ===========================================================================
  // Audit event emitted
  // ===========================================================================

  it('emits audit event via callback after deletion', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-audit-test';
    const contact = makeContact({ id: contactId, tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    await useCase.execute(tenantId, contactId);

    expect(auditCallback).toHaveBeenCalledTimes(1);
    const auditEvent = (auditCallback as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEvent.action).toBe('contact.hard_deleted');
    expect(auditEvent.tenantId).toBe(tenantId);
    expect(auditEvent.contactId).toBe(contactId);
    expect(auditEvent.timestamp).toBeInstanceOf(Date);
  });

  it('emits audit event with identity count and session count', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-with-data';
    const contact = makeContact({
      id: contactId,
      tenantId,
      identities: [
        {
          type: 'email',
          encryptedValue: 'enc-1',
          blindIndex: 'blind-1',
          verified: false,
          verifiedAt: null,
          verifiedVia: null,
          channel: null,
        },
        {
          type: 'phone',
          encryptedValue: 'enc-2',
          blindIndex: 'blind-2',
          verified: true,
          verifiedAt: new Date(),
          verifiedVia: 'otp',
          channel: 'sms',
        },
      ],
      sessionCount: 42,
    });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    await useCase.execute(tenantId, contactId);

    const auditEvent = (auditCallback as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEvent.identityCount).toBe(2);
    expect(auditEvent.sessionCount).toBe(42);
  });

  // ===========================================================================
  // Contact not found (tenant isolation)
  // ===========================================================================

  it('fails when contact not found (enforces tenant ownership)', async () => {
    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await useCase.execute('tenant-001', 'nonexistent-contact');

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('CONTACT_NOT_FOUND');
    expect(repo.hardDelete).not.toHaveBeenCalled();
    expect(auditCallback).not.toHaveBeenCalled();
  });

  // ===========================================================================
  // Message scrub + ClickHouse cleanup ports
  // ===========================================================================

  it('calls scrubMessages with correct tenantId/contactId before hardDelete', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-scrub-test';
    const contact = makeContact({ id: contactId, tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    const scrubMessages = vi.fn().mockResolvedValue(15);
    const useCaseWithScrub = new CascadeDeleteContact(
      repo,
      auditCallback,
      undefined,
      scrubMessages,
    );

    const result = await useCaseWithScrub.execute(tenantId, contactId);

    expect(result.success).toBe(true);
    expect(scrubMessages).toHaveBeenCalledWith(tenantId, contactId);

    // Verify scrubMessages was called before hardDelete
    const scrubOrder = scrubMessages.mock.invocationCallOrder[0];
    const deleteOrder = (repo.hardDelete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(scrubOrder).toBeLessThan(deleteOrder);
  });

  it('calls clickhouseCleanup with correct tenantId/contactId before hardDelete', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-ch-test';
    const contact = makeContact({ id: contactId, tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    const clickhouseCleanup = vi.fn().mockResolvedValue(undefined);
    const useCaseWithCH = new CascadeDeleteContact(
      repo,
      auditCallback,
      undefined,
      undefined,
      clickhouseCleanup,
    );

    const result = await useCaseWithCH.execute(tenantId, contactId);

    expect(result.success).toBe(true);
    expect(clickhouseCleanup).toHaveBeenCalledWith(tenantId, contactId);

    // Verify clickhouseCleanup was called before hardDelete
    const chOrder = clickhouseCleanup.mock.invocationCallOrder[0];
    const deleteOrder = (repo.hardDelete as ReturnType<typeof vi.fn>).mock.invocationCallOrder[0];
    expect(chOrder).toBeLessThan(deleteOrder);
  });

  it('includes scrubbedMessageCount in audit event', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-scrub-audit';
    const contact = makeContact({ id: contactId, tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    const scrubMessages = vi.fn().mockResolvedValue(7);
    const useCaseWithScrub = new CascadeDeleteContact(
      repo,
      auditCallback,
      undefined,
      scrubMessages,
    );

    await useCaseWithScrub.execute(tenantId, contactId);

    const auditEvent = (auditCallback as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEvent.scrubbedMessageCount).toBe(7);
  });

  it('sets scrubbedMessageCount to 0 when scrubMessages is not provided', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-no-scrub';
    const contact = makeContact({ id: contactId, tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    await useCase.execute(tenantId, contactId);

    const auditEvent = (auditCallback as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(auditEvent.scrubbedMessageCount).toBe(0);
  });

  it('works without scrubMessages and clickhouseCleanup (both optional)', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-optional';
    const contact = makeContact({ id: contactId, tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    // useCase is created without scrubMessages/clickhouseCleanup in beforeEach
    const result = await useCase.execute(tenantId, contactId);

    expect(result.success).toBe(true);
    expect(repo.hardDelete).toHaveBeenCalledWith(tenantId, contactId);
  });

  // ===========================================================================
  // Audit callback failure does not swallow error
  // ===========================================================================

  it('still returns success even if audit callback throws', async () => {
    const tenantId = 'tenant-001';
    const contactId = 'contact-delete-ok';
    const contact = makeContact({ id: contactId, tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);

    // Make audit callback throw
    const failingAudit = vi.fn().mockRejectedValue(new Error('Audit service unavailable'));
    const useCaseWithFailingAudit = new CascadeDeleteContact(repo, failingAudit);

    const result = await useCaseWithFailingAudit.execute(tenantId, contactId);

    // The deletion itself succeeds despite audit failure
    expect(result.success).toBe(true);
    expect(repo.hardDelete).toHaveBeenCalledWith(tenantId, contactId);
    expect(failingAudit).toHaveBeenCalledTimes(1);
  });
});
