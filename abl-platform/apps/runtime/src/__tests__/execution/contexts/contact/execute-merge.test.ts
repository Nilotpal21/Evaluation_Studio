/**
 * ExecuteMerge Use Case Tests
 *
 * Validates contact merging: identities moved from secondary to primary,
 * duplicate blind indexes deduplicated, secondary marked with mergedInto,
 * and channel history merged.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { ContactIdentity } from '../../../../contexts/contact/domain/contact-identity.js';
import type { ContactRepository } from '../../../../contexts/contact/domain/contact-repository.js';
import { ExecuteMerge } from '../../../../contexts/contact/use-cases/execute-merge.js';

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

function makeIdentity(overrides: Partial<ContactIdentity> = {}): ContactIdentity {
  return {
    type: overrides.type ?? 'email',
    encryptedValue: overrides.encryptedValue ?? 'enc-val',
    blindIndex: overrides.blindIndex ?? 'blind-idx-default',
    verified: overrides.verified ?? false,
    verifiedAt: overrides.verifiedAt ?? null,
    verifiedVia: overrides.verifiedVia ?? null,
    channel: overrides.channel ?? null,
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

describe('ExecuteMerge', () => {
  let repo: ContactRepository;
  let useCase: ExecuteMerge;

  beforeEach(() => {
    repo = createMockRepo();
    useCase = new ExecuteMerge(repo);
  });

  // ===========================================================================
  // Identities moved from secondary -> primary
  // ===========================================================================

  it('moves identities from secondary to primary', async () => {
    const tenantId = 'tenant-001';

    const primaryIdentity = makeIdentity({
      type: 'email',
      blindIndex: 'blind-email-primary',
      encryptedValue: 'enc-email-primary',
    });
    const secondaryIdentity = makeIdentity({
      type: 'phone',
      blindIndex: 'blind-phone-secondary',
      encryptedValue: 'enc-phone-secondary',
      channel: 'whatsapp',
    });

    const primary = makeContact({
      id: 'primary-001',
      tenantId,
      identities: [primaryIdentity],
    });
    const secondary = makeContact({
      id: 'secondary-001',
      tenantId,
      identities: [secondaryIdentity],
    });

    (repo.findById as ReturnType<typeof vi.fn>).mockImplementation(
      async (tid: string, cid: string) => {
        if (tid === tenantId && cid === 'primary-001') return primary;
        if (tid === tenantId && cid === 'secondary-001') return secondary;
        return null;
      },
    );

    const result = await useCase.execute(tenantId, 'primary-001', 'secondary-001', 'admin-user');

    expect(result.success).toBe(true);
    expect(result.data!.identitiesMoved).toHaveLength(1);
    expect(result.data!.identitiesMoved[0].blindIndex).toBe('blind-phone-secondary');

    // Primary should have been updated with both identities
    const updateCall = (repo.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    expect(updateCall.identities).toHaveLength(2);
    expect(updateCall.identities.map((i: ContactIdentity) => i.blindIndex)).toContain(
      'blind-email-primary',
    );
    expect(updateCall.identities.map((i: ContactIdentity) => i.blindIndex)).toContain(
      'blind-phone-secondary',
    );
  });

  // ===========================================================================
  // Duplicate blind indexes deduplicated
  // ===========================================================================

  it('deduplicates identities with same blind index during merge', async () => {
    const tenantId = 'tenant-001';
    const sharedBlindIdx = 'blind-shared-email';

    const primaryIdentity = makeIdentity({
      type: 'email',
      blindIndex: sharedBlindIdx,
      encryptedValue: 'enc-primary-email',
    });
    const secondaryIdentity = makeIdentity({
      type: 'email',
      blindIndex: sharedBlindIdx,
      encryptedValue: 'enc-secondary-email',
    });
    const uniqueSecondaryIdentity = makeIdentity({
      type: 'phone',
      blindIndex: 'blind-unique-phone',
      encryptedValue: 'enc-unique-phone',
    });

    const primary = makeContact({
      id: 'primary-002',
      tenantId,
      identities: [primaryIdentity],
    });
    const secondary = makeContact({
      id: 'secondary-002',
      tenantId,
      identities: [secondaryIdentity, uniqueSecondaryIdentity],
    });

    (repo.findById as ReturnType<typeof vi.fn>).mockImplementation(
      async (tid: string, cid: string) => {
        if (tid === tenantId && cid === 'primary-002') return primary;
        if (tid === tenantId && cid === 'secondary-002') return secondary;
        return null;
      },
    );

    const result = await useCase.execute(tenantId, 'primary-002', 'secondary-002', 'admin');

    expect(result.success).toBe(true);

    // Only the unique phone should be moved; duplicate email deduplicated
    expect(result.data!.identitiesMoved).toHaveLength(1);
    expect(result.data!.identitiesMoved[0].blindIndex).toBe('blind-unique-phone');

    const updatedPrimary = (repo.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    expect(updatedPrimary.identities).toHaveLength(2); // primary email + unique phone
    const blindIndexes = updatedPrimary.identities.map((i: ContactIdentity) => i.blindIndex);
    expect(new Set(blindIndexes).size).toBe(2); // all unique
  });

  // ===========================================================================
  // Secondary marked mergedInto
  // ===========================================================================

  it('marks secondary contact as mergedInto primary', async () => {
    const tenantId = 'tenant-001';

    const primary = makeContact({ id: 'primary-003', tenantId });
    const secondary = makeContact({ id: 'secondary-003', tenantId });

    (repo.findById as ReturnType<typeof vi.fn>).mockImplementation(
      async (tid: string, cid: string) => {
        if (tid === tenantId && cid === 'primary-003') return primary;
        if (tid === tenantId && cid === 'secondary-003') return secondary;
        return null;
      },
    );

    await useCase.execute(tenantId, 'primary-003', 'secondary-003', 'system');

    // First update call = primary, second = secondary
    const updateCalls = (repo.update as ReturnType<typeof vi.fn>).mock.calls;
    expect(updateCalls.length).toBeGreaterThanOrEqual(2);

    const updatedSecondary = updateCalls[1][0] as Contact;
    expect(updatedSecondary.mergedInto).toBe('primary-003');

    // soft-delete should have been called
    expect(repo.softDelete).toHaveBeenCalledWith(tenantId, 'secondary-003');
  });

  // ===========================================================================
  // Channel history merged
  // ===========================================================================

  it('merges channel history from secondary into primary', async () => {
    const tenantId = 'tenant-001';

    const primary = makeContact({
      id: 'primary-004',
      tenantId,
      channelHistory: [
        {
          channelType: 'web',
          channelId: 'ch-web-1',
          firstSessionAt: new Date('2026-01-01'),
          lastSessionAt: new Date('2026-02-01'),
          sessionCount: 5,
        },
      ],
      sessionCount: 5,
    });
    const secondary = makeContact({
      id: 'secondary-004',
      tenantId,
      channelHistory: [
        {
          channelType: 'whatsapp',
          channelId: 'ch-wa-1',
          firstSessionAt: new Date('2026-01-15'),
          lastSessionAt: new Date('2026-02-15'),
          sessionCount: 3,
        },
      ],
      sessionCount: 3,
    });

    (repo.findById as ReturnType<typeof vi.fn>).mockImplementation(
      async (tid: string, cid: string) => {
        if (tid === tenantId && cid === 'primary-004') return primary;
        if (tid === tenantId && cid === 'secondary-004') return secondary;
        return null;
      },
    );

    const result = await useCase.execute(tenantId, 'primary-004', 'secondary-004', 'admin');

    expect(result.success).toBe(true);

    const updatedPrimary = (repo.update as ReturnType<typeof vi.fn>).mock.calls[0][0] as Contact;
    expect(updatedPrimary.channelHistory).toHaveLength(2);
    expect(updatedPrimary.channelHistory.map((h) => h.channelType)).toContain('web');
    expect(updatedPrimary.channelHistory.map((h) => h.channelType)).toContain('whatsapp');
  });

  // ===========================================================================
  // Tenant isolation
  // ===========================================================================

  it('fails when primary contact not found (wrong tenant)', async () => {
    (repo.findById as ReturnType<typeof vi.fn>).mockResolvedValue(null);

    const result = await useCase.execute('tenant-001', 'missing-primary', 'secondary', 'admin');

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('CONTACT_NOT_FOUND');
  });

  it('fails when secondary contact not found (wrong tenant)', async () => {
    const primary = makeContact({ id: 'primary-existing', tenantId: 'tenant-001' });

    (repo.findById as ReturnType<typeof vi.fn>).mockImplementation(
      async (tid: string, cid: string) => {
        if (cid === 'primary-existing') return primary;
        return null;
      },
    );

    const result = await useCase.execute(
      'tenant-001',
      'primary-existing',
      'missing-secondary',
      'admin',
    );

    expect(result.success).toBe(false);
    expect(result.error!.code).toBe('CONTACT_NOT_FOUND');
  });

  // ===========================================================================
  // Merge execution result
  // ===========================================================================

  it('returns a complete MergeExecution result', async () => {
    const tenantId = 'tenant-001';

    const primary = makeContact({
      id: 'primary-005',
      tenantId,
      identities: [makeIdentity({ blindIndex: 'blind-a' })],
    });
    const secondary = makeContact({
      id: 'secondary-005',
      tenantId,
      identities: [makeIdentity({ type: 'phone', blindIndex: 'blind-b' })],
    });

    (repo.findById as ReturnType<typeof vi.fn>).mockImplementation(
      async (tid: string, cid: string) => {
        if (tid === tenantId && cid === 'primary-005') return primary;
        if (tid === tenantId && cid === 'secondary-005') return secondary;
        return null;
      },
    );

    const result = await useCase.execute(tenantId, 'primary-005', 'secondary-005', 'admin-user');

    expect(result.success).toBe(true);
    const execution = result.data!;
    expect(execution.tenantId).toBe(tenantId);
    expect(execution.primaryContactId).toBe('primary-005');
    expect(execution.secondaryContactId).toBe('secondary-005');
    expect(execution.mergedBy).toBe('admin-user');
    expect(execution.mergedAt).toBeInstanceOf(Date);
    expect(execution.id).toBeTruthy();
  });
});
