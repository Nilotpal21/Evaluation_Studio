/**
 * Contact Audit Trail Tests
 *
 * Verifies that each contact use case emits the correct audit events
 * when a ContactAuditEmitter is provided, and that the primary operation
 * succeeds even if the audit emitter fails.
 */

import crypto from 'node:crypto';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { ContactIdentity } from '../../../../contexts/contact/domain/contact-identity.js';
import type { ContactRepository } from '../../../../contexts/contact/domain/contact-repository.js';
import type { EncryptionService } from '@agent-platform/shared/encryption';
import type {
  ContactAuditEmitter,
  ContactAuditEvent,
} from '../../../../contexts/contact/infrastructure/contact-audit.js';
import { ResolveOrCreateContact } from '../../../../contexts/contact/use-cases/resolve-or-create-contact.js';
import { LinkSessionToContact } from '../../../../contexts/contact/use-cases/link-session-to-contact.js';
import { ExecuteMerge } from '../../../../contexts/contact/use-cases/execute-merge.js';
import { SelfMerge } from '../../../../contexts/contact/use-cases/self-merge.js';
import { CascadeDeleteContact } from '../../../../contexts/contact/use-cases/cascade-delete-contact.js';

// =============================================================================
// TEST HELPERS
// =============================================================================

const TENANT_ID = 'tenant-001';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  const now = new Date();
  return {
    id: crypto.randomUUID(),
    tenantId: TENANT_ID,
    identities: [],
    displayName: null,
    type: 'customer',
    metadata: {},
    tags: [],
    channelHistory: [],
    sessionCount: 0,
    firstSeenAt: now,
    lastSeenAt: now,
    mergedInto: null,
    deletedAt: null,
    encryptionSalt: null,
    contactContext: null,
    ...overrides,
  };
}

function makeIdentity(overrides: Partial<ContactIdentity> = {}): ContactIdentity {
  return {
    type: 'email',
    encryptedValue: 'enc-value',
    blindIndex: `blind-${crypto.randomUUID()}`,
    verified: false,
    verifiedAt: null,
    verifiedVia: null,
    channel: null,
    ...overrides,
  };
}

function createMockRepo(): ContactRepository {
  return {
    findById: vi.fn(),
    findByBlindIndex: vi.fn(),
    findByBlindIndexes: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    addIdentity: vi.fn(),
    linkSession: vi.fn(),
    softDelete: vi.fn(),
    hardDelete: vi.fn(),
    nullifyEncryptionSalt: vi.fn(),
    findMergeCandidates: vi.fn(),
  };
}

function createMockEncryptor(): EncryptionService {
  return {
    blindIndex: vi.fn((_tenantId: string, value: string) => `blind:${value}`),
    encryptContactPII: vi.fn((_tenantId: string, value: string) => `enc:${value}`),
    decryptContactPII: vi.fn((_tenantId: string, encrypted: string) =>
      encrypted.replace('enc:', ''),
    ),
  } as unknown as EncryptionService;
}

// =============================================================================
// ResolveOrCreateContact AUDIT TESTS
// =============================================================================

describe('ResolveOrCreateContact audit', () => {
  let repo: ContactRepository;
  let encryptor: EncryptionService;
  let auditEmitter: ReturnType<typeof vi.fn<[ContactAuditEvent], Promise<void>>>;

  beforeEach(() => {
    repo = createMockRepo();
    encryptor = createMockEncryptor();
    auditEmitter = vi.fn<[ContactAuditEvent], Promise<void>>().mockResolvedValue(undefined);
  });

  it('emits contact.created when creating a new contact', async () => {
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    const uc = new ResolveOrCreateContact(repo, encryptor, auditEmitter);
    const result = await uc.execute(TENANT_ID, 'email', 'test@example.com');

    expect(auditEmitter).toHaveBeenCalledTimes(1);
    const event = auditEmitter.mock.calls[0][0];
    expect(event.action).toBe('contact.created');
    expect(event.tenantId).toBe(TENANT_ID);
    expect(event.contactId).toBe(result.id);
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('adds contact.created source metadata when provided', async () => {
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    const uc = new ResolveOrCreateContact(repo, encryptor, auditEmitter);
    await uc.execute(TENANT_ID, 'external', 'customer-123', 'sdk_http', {
      contactAuditSource: 'customer_id',
    });

    expect(auditEmitter).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'contact.created',
        metadata: { source: 'customer_id' },
      }),
    );
  });

  it('does NOT emit contact.created when audit options suppress creation audit', async () => {
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    const uc = new ResolveOrCreateContact(repo, encryptor, auditEmitter);
    await uc.execute(TENANT_ID, 'external', 'anonymous-session-1', 'sdk_http', {
      contactAuditSource: 'anonymous_id',
      suppressContactCreatedAudit: true,
    });

    expect(auditEmitter).not.toHaveBeenCalled();
  });

  it('does NOT emit audit when resolving an existing contact', async () => {
    const existing = makeContact();
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(existing);

    const uc = new ResolveOrCreateContact(repo, encryptor, auditEmitter);
    await uc.execute(TENANT_ID, 'email', 'test@example.com');

    expect(auditEmitter).not.toHaveBeenCalled();
  });

  it('works without audit emitter (backward compatible)', async () => {
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);

    const uc = new ResolveOrCreateContact(repo, encryptor);
    const result = await uc.execute(TENANT_ID, 'email', 'test@example.com');

    expect(result).toBeDefined();
    expect(result.tenantId).toBe(TENANT_ID);
  });

  it('succeeds even if audit emitter rejects', async () => {
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.create as ReturnType<typeof vi.fn>).mockImplementation(async (c: Contact) => c);
    auditEmitter.mockRejectedValue(new Error('audit store down'));

    const uc = new ResolveOrCreateContact(repo, encryptor, auditEmitter);
    const result = await uc.execute(TENANT_ID, 'email', 'test@example.com');

    expect(result).toBeDefined();
    expect(result.tenantId).toBe(TENANT_ID);
  });
});

// =============================================================================
// LinkSessionToContact AUDIT TESTS
// =============================================================================

describe('LinkSessionToContact audit', () => {
  let repo: ContactRepository;
  let auditEmitter: ReturnType<typeof vi.fn<[ContactAuditEvent], Promise<void>>>;

  beforeEach(() => {
    repo = createMockRepo();
    auditEmitter = vi.fn<[ContactAuditEvent], Promise<void>>().mockResolvedValue(undefined);
  });

  it('emits contact.session_linked on successful link', async () => {
    (repo.linkSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const contactId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();

    const uc = new LinkSessionToContact(repo, auditEmitter);
    await uc.execute(TENANT_ID, contactId, sessionId, 'web', 'ch-001');

    expect(auditEmitter).toHaveBeenCalledTimes(1);
    const event = auditEmitter.mock.calls[0][0];
    expect(event.action).toBe('contact.session_linked');
    expect(event.tenantId).toBe(TENANT_ID);
    expect(event.contactId).toBe(contactId);
    expect(event.metadata).toEqual({ sessionId, channelType: 'web', channelId: 'ch-001' });
  });

  it('works without audit emitter', async () => {
    (repo.linkSession as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const uc = new LinkSessionToContact(repo);
    await expect(uc.execute(TENANT_ID, 'c1', 's1', 'web', 'ch1')).resolves.not.toThrow();
  });
});

// =============================================================================
// ExecuteMerge AUDIT TESTS
// =============================================================================

describe('ExecuteMerge audit', () => {
  let repo: ContactRepository;
  let auditEmitter: ReturnType<typeof vi.fn<[ContactAuditEvent], Promise<void>>>;

  beforeEach(() => {
    repo = createMockRepo();
    auditEmitter = vi.fn<[ContactAuditEvent], Promise<void>>().mockResolvedValue(undefined);
  });

  it('emits contact.merged on successful merge', async () => {
    const sharedBlind = 'blind-shared';
    const primaryIdentity = makeIdentity({ blindIndex: sharedBlind });
    const secondaryIdentity = makeIdentity({ blindIndex: 'blind-unique' });

    const primary = makeContact({
      id: 'primary-001',
      identities: [primaryIdentity],
      channelHistory: [],
    });
    const secondary = makeContact({
      id: 'secondary-001',
      identities: [secondaryIdentity],
      channelHistory: [],
    });

    (repo.findById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(primary)
      .mockResolvedValueOnce(secondary);
    (repo.update as ReturnType<typeof vi.fn>).mockResolvedValue(primary);
    (repo.softDelete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const uc = new ExecuteMerge(repo, auditEmitter);
    const result = await uc.execute(TENANT_ID, 'primary-001', 'secondary-001', 'admin-user');

    expect(result.success).toBe(true);
    expect(auditEmitter).toHaveBeenCalledTimes(1);

    const event = auditEmitter.mock.calls[0][0];
    expect(event.action).toBe('contact.merged');
    expect(event.tenantId).toBe(TENANT_ID);
    expect(event.contactId).toBe('primary-001');
    expect(event.metadata).toMatchObject({
      primaryContactId: 'primary-001',
      secondaryContactId: 'secondary-001',
      identitiesMoved: 1,
    });
  });

  it('does NOT emit audit when merge fails (contact not found)', async () => {
    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const uc = new ExecuteMerge(repo, auditEmitter);
    const result = await uc.execute(TENANT_ID, 'missing', 'secondary', 'admin');

    expect(result.success).toBe(false);
    expect(auditEmitter).not.toHaveBeenCalled();
  });
});

// =============================================================================
// SelfMerge AUDIT TESTS
// =============================================================================

describe('SelfMerge audit', () => {
  let repo: ContactRepository;
  let encryptor: EncryptionService;
  let auditEmitter: ReturnType<typeof vi.fn<[ContactAuditEvent], Promise<void>>>;

  beforeEach(() => {
    repo = createMockRepo();
    encryptor = createMockEncryptor();
    auditEmitter = vi.fn<[ContactAuditEvent], Promise<void>>().mockResolvedValue(undefined);
  });

  it('emits contact.self_merged when merging with another contact', async () => {
    const existing = makeContact({
      id: 'existing-001',
      lastSeenAt: new Date('2025-01-02'),
      identities: [makeIdentity({ blindIndex: 'blind:newemail@test.com' })],
    });
    const current = makeContact({
      id: 'current-001',
      lastSeenAt: new Date('2025-01-01'),
      identities: [makeIdentity({ blindIndex: 'blind:old@test.com' })],
      channelHistory: [],
    });

    // findByBlindIndex returns existing (another contact owns this identity)
    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    // findById calls: first for SelfMerge (current), then for ExecuteMerge (primary, secondary), then for SelfMerge final lookup
    (repo.findById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(current) // SelfMerge: load current to compare recency
      .mockResolvedValueOnce(existing) // ExecuteMerge: load primary
      .mockResolvedValueOnce(current) // ExecuteMerge: load secondary
      .mockResolvedValueOnce(existing); // SelfMerge: load merged contact
    (repo.update as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    (repo.softDelete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const uc = new SelfMerge(repo, encryptor, auditEmitter);
    const result = await uc.execute(TENANT_ID, 'current-001', 'email', 'newemail@test.com');

    expect(result.success).toBe(true);
    expect(result.merged).toBe(true);

    // Should have emitted contact.self_merged
    const selfMergeEvents = auditEmitter.mock.calls.filter(
      (call) => call[0].action === 'contact.self_merged',
    );
    expect(selfMergeEvents.length).toBe(1);
    expect(selfMergeEvents[0][0].tenantId).toBe(TENANT_ID);
  });

  it('emits contact.identity_added when adding a new identity (no merge)', async () => {
    const current = makeContact({
      id: 'current-001',
      identities: [makeIdentity({ blindIndex: 'blind:old@test.com' })],
    });

    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(null);
    (repo.findById as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce(current) // load current
      .mockResolvedValueOnce({ ...current, identities: [...current.identities, makeIdentity()] }); // after addIdentity
    (repo.addIdentity as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const uc = new SelfMerge(repo, encryptor, auditEmitter);
    const result = await uc.execute(TENANT_ID, 'current-001', 'email', 'new@test.com');

    expect(result.success).toBe(true);
    expect(result.merged).toBe(false);

    expect(auditEmitter).toHaveBeenCalledTimes(1);
    const event = auditEmitter.mock.calls[0][0];
    expect(event.action).toBe('contact.identity_added');
    expect(event.contactId).toBe('current-001');
  });

  it('does NOT emit audit when identity already exists on current contact', async () => {
    const blindIdx = 'blind:existing@test.com';
    const current = makeContact({
      id: 'current-001',
      identities: [makeIdentity({ blindIndex: blindIdx })],
    });

    (repo.findByBlindIndex as ReturnType<typeof vi.fn>).mockResolvedValue(current);
    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(current);

    const uc = new SelfMerge(repo, encryptor, auditEmitter);
    const result = await uc.execute(TENANT_ID, 'current-001', 'email', 'existing@test.com');

    expect(result.success).toBe(true);
    expect(result.merged).toBe(false);
    expect(auditEmitter).not.toHaveBeenCalled();
  });
});

// =============================================================================
// CascadeDeleteContact AUDIT TESTS
// =============================================================================

describe('CascadeDeleteContact audit', () => {
  let repo: ContactRepository;

  beforeEach(() => {
    repo = createMockRepo();
  });

  it('emits contact.hard_deleted via its existing AuditCallback', async () => {
    const contact = makeContact({
      id: 'del-001',
      identities: [makeIdentity(), makeIdentity()],
      sessionCount: 5,
    });

    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(contact);
    (repo.hardDelete as ReturnType<typeof vi.fn>).mockResolvedValue(undefined);

    const auditCallback = vi.fn().mockResolvedValue(undefined);
    const uc = new CascadeDeleteContact(repo, auditCallback);
    const result = await uc.execute(TENANT_ID, 'del-001');

    expect(result.success).toBe(true);
    expect(auditCallback).toHaveBeenCalledTimes(1);

    const event = auditCallback.mock.calls[0][0];
    expect(event.action).toBe('contact.hard_deleted');
    expect(event.tenantId).toBe(TENANT_ID);
    expect(event.contactId).toBe('del-001');
    expect(event.identityCount).toBe(2);
    expect(event.sessionCount).toBe(5);
    expect(event.timestamp).toBeInstanceOf(Date);
  });

  it('does NOT emit audit when contact not found', async () => {
    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const auditCallback = vi.fn().mockResolvedValue(undefined);
    const uc = new CascadeDeleteContact(repo, auditCallback);
    const result = await uc.execute(TENANT_ID, 'missing');

    expect(result.success).toBe(false);
    expect(auditCallback).not.toHaveBeenCalled();
  });
});
