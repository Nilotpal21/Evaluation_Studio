/**
 * BackLinkSessions Job Processor Tests
 *
 * Validates the BullMQ job processor that back-links sessions to a contact:
 * - Finds all sessions sharing the same channel artifact hash + tenant
 * - Updates each session's contactId to the given contact
 * - No-ops when no sessions match
 * - Handles errors from the session store gracefully
 *
 * Also validates MergeDetection job processor:
 * - Loads contact, extracts blind indexes from identities
 * - Finds other contacts sharing those indexes
 * - Creates MergeSuggestion for each overlap
 * - No-ops when contact not found or no overlapping contacts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  createBackLinkProcessor,
  BACK_LINK_QUEUE_NAME,
  type BackLinkJobData,
  type BackLinkDeps,
} from '../../../../contexts/orchestration/jobs/back-link-sessions.js';
import {
  createMergeDetectionProcessor,
  MERGE_DETECTION_QUEUE_NAME,
  type MergeDetectionJobData,
  type MergeDetectionDeps,
} from '../../../../contexts/orchestration/jobs/detect-merge-candidates.js';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { MergeSuggestion } from '../../../../contexts/contact/domain/merge-suggestion.js';

// =============================================================================
// FIXTURES
// =============================================================================

const TENANT_ID = 'tenant-backlink-001';
const CONTACT_ID = 'contact-001';
const ARTIFACT_HASH = 'hashed-phone-abc123';

function createMockContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: CONTACT_ID,
    tenantId: TENANT_ID,
    identities: [
      {
        type: 'phone',
        encryptedValue: 'enc-phone-1',
        blindIndex: 'blind-phone-1',
        verified: true,
        verifiedAt: new Date('2026-02-18T10:00:00Z'),
        verifiedVia: 'provider',
        channel: 'whatsapp',
      },
      {
        type: 'email',
        encryptedValue: 'enc-email-1',
        blindIndex: 'blind-email-1',
        verified: true,
        verifiedAt: new Date('2026-02-18T11:00:00Z'),
        verifiedVia: 'otp',
        channel: 'web',
      },
    ],
    displayName: null,
    type: 'customer',
    metadata: {},
    tags: [],
    channelHistory: [],
    sessionCount: 0,
    firstSeenAt: new Date('2026-02-18T10:00:00Z'),
    lastSeenAt: new Date('2026-02-18T12:00:00Z'),
    mergedInto: null,
    deletedAt: null,
    ...overrides,
  };
}

// =============================================================================
// BACK-LINK SESSIONS TESTS
// =============================================================================

describe('BackLinkSessions job processor', () => {
  let deps: BackLinkDeps;
  let processor: (job: { data: BackLinkJobData }) => Promise<void>;

  beforeEach(() => {
    deps = {
      findSessionsByArtifact: vi
        .fn()
        .mockResolvedValue([
          { sessionId: 'sess-001' },
          { sessionId: 'sess-002' },
          { sessionId: 'sess-003' },
        ]),
      updateSessionContactId: vi.fn().mockResolvedValue(undefined),
    };
    processor = createBackLinkProcessor(deps);
  });

  it('exports the correct queue name', () => {
    expect(BACK_LINK_QUEUE_NAME).toBe('identity-back-link');
  });

  it('finds sessions by artifact hash and tenant', async () => {
    const jobData: BackLinkJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      channelArtifact: ARTIFACT_HASH,
    };

    await processor({ data: jobData });

    expect(deps.findSessionsByArtifact).toHaveBeenCalledWith(TENANT_ID, ARTIFACT_HASH);
  });

  it('updates contactId on each matching session', async () => {
    const jobData: BackLinkJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      channelArtifact: ARTIFACT_HASH,
    };

    await processor({ data: jobData });

    expect(deps.updateSessionContactId).toHaveBeenCalledTimes(3);
    expect(deps.updateSessionContactId).toHaveBeenCalledWith(TENANT_ID, 'sess-001', CONTACT_ID);
    expect(deps.updateSessionContactId).toHaveBeenCalledWith(TENANT_ID, 'sess-002', CONTACT_ID);
    expect(deps.updateSessionContactId).toHaveBeenCalledWith(TENANT_ID, 'sess-003', CONTACT_ID);
  });

  it('no-ops when no sessions match the artifact', async () => {
    deps.findSessionsByArtifact = vi.fn().mockResolvedValue([]);
    processor = createBackLinkProcessor(deps);

    const jobData: BackLinkJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      channelArtifact: ARTIFACT_HASH,
    };

    await processor({ data: jobData });

    expect(deps.updateSessionContactId).not.toHaveBeenCalled();
  });

  it('propagates errors from findSessionsByArtifact', async () => {
    deps.findSessionsByArtifact = vi.fn().mockRejectedValue(new Error('DB connection lost'));
    processor = createBackLinkProcessor(deps);

    const jobData: BackLinkJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      channelArtifact: ARTIFACT_HASH,
    };

    await expect(processor({ data: jobData })).rejects.toThrow('DB connection lost');
  });

  it('propagates errors from updateSessionContactId', async () => {
    deps.updateSessionContactId = vi.fn().mockRejectedValue(new Error('Write failed'));
    processor = createBackLinkProcessor(deps);

    const jobData: BackLinkJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
      channelArtifact: ARTIFACT_HASH,
    };

    await expect(processor({ data: jobData })).rejects.toThrow('Write failed');
  });
});

// =============================================================================
// MERGE DETECTION TESTS
// =============================================================================

describe('MergeDetection job processor', () => {
  let deps: MergeDetectionDeps;
  let processor: (job: { data: MergeDetectionJobData }) => Promise<void>;

  const sourceContact = createMockContact();
  const overlappingContact = createMockContact({
    id: 'contact-overlap-001',
    identities: [
      {
        type: 'phone',
        encryptedValue: 'enc-phone-overlap',
        blindIndex: 'blind-phone-1', // Same blind index as source
        verified: true,
        verifiedAt: new Date(),
        verifiedVia: 'provider',
        channel: 'whatsapp',
      },
    ],
  });

  beforeEach(() => {
    deps = {
      contactRepository: {
        findById: vi.fn().mockResolvedValue(sourceContact),
        findByBlindIndex: vi.fn().mockResolvedValue(null),
        findByBlindIndexes: vi.fn().mockResolvedValue([]),
        create: vi.fn().mockResolvedValue(sourceContact),
        update: vi.fn().mockResolvedValue(sourceContact),
        addIdentity: vi.fn().mockResolvedValue(undefined),
        linkSession: vi.fn().mockResolvedValue(undefined),
        softDelete: vi.fn().mockResolvedValue(undefined),
        hardDelete: vi.fn().mockResolvedValue(undefined),
        nullifyEncryptionSalt: vi.fn().mockResolvedValue(undefined),
        findMergeCandidates: vi.fn().mockResolvedValue([overlappingContact]),
      },
      saveMergeSuggestion: vi.fn().mockResolvedValue(undefined),
    };
    processor = createMergeDetectionProcessor(deps);
  });

  it('exports the correct queue name', () => {
    expect(MERGE_DETECTION_QUEUE_NAME).toBe('merge-detection');
  });

  it('loads the contact by id within the tenant', async () => {
    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await processor({ data: jobData });

    expect(deps.contactRepository.findById).toHaveBeenCalledWith(TENANT_ID, CONTACT_ID);
  });

  it('extracts blind indexes and finds merge candidates', async () => {
    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await processor({ data: jobData });

    expect(deps.contactRepository.findMergeCandidates).toHaveBeenCalledWith(TENANT_ID, [
      'blind-phone-1',
      'blind-email-1',
    ]);
  });

  it('creates a MergeSuggestion for each overlapping contact', async () => {
    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await processor({ data: jobData });

    expect(deps.saveMergeSuggestion).toHaveBeenCalledTimes(1);
    expect(deps.saveMergeSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT_ID,
        primaryContactId: CONTACT_ID,
        secondaryContactId: 'contact-overlap-001',
        status: 'pending',
        overlapIdentities: expect.arrayContaining([
          expect.objectContaining({
            blindIndex: 'blind-phone-1',
          }),
        ]),
      }),
    );
  });

  it('no-ops when contact is not found', async () => {
    deps.contactRepository.findById = vi.fn().mockResolvedValue(null);
    processor = createMergeDetectionProcessor(deps);

    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await processor({ data: jobData });

    expect(deps.contactRepository.findMergeCandidates).not.toHaveBeenCalled();
    expect(deps.saveMergeSuggestion).not.toHaveBeenCalled();
  });

  it('no-ops when contact has no identities', async () => {
    deps.contactRepository.findById = vi
      .fn()
      .mockResolvedValue(createMockContact({ identities: [] }));
    processor = createMergeDetectionProcessor(deps);

    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await processor({ data: jobData });

    expect(deps.contactRepository.findMergeCandidates).not.toHaveBeenCalled();
    expect(deps.saveMergeSuggestion).not.toHaveBeenCalled();
  });

  it('no-ops when no overlapping contacts found', async () => {
    deps.contactRepository.findMergeCandidates = vi.fn().mockResolvedValue([]);
    processor = createMergeDetectionProcessor(deps);

    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await processor({ data: jobData });

    expect(deps.saveMergeSuggestion).not.toHaveBeenCalled();
  });

  it('filters out the source contact from merge candidates', async () => {
    // findMergeCandidates returns the source contact itself + another
    deps.contactRepository.findMergeCandidates = vi.fn().mockResolvedValue([
      sourceContact, // same as source -- should be filtered
      overlappingContact,
    ]);
    processor = createMergeDetectionProcessor(deps);

    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await processor({ data: jobData });

    expect(deps.saveMergeSuggestion).toHaveBeenCalledTimes(1);
    expect(deps.saveMergeSuggestion).toHaveBeenCalledWith(
      expect.objectContaining({
        secondaryContactId: 'contact-overlap-001',
      }),
    );
  });

  it('creates suggestions for multiple overlapping contacts', async () => {
    const secondOverlap = createMockContact({
      id: 'contact-overlap-002',
      identities: [
        {
          type: 'email',
          encryptedValue: 'enc-email-overlap',
          blindIndex: 'blind-email-1',
          verified: true,
          verifiedAt: new Date(),
          verifiedVia: 'otp',
          channel: 'web',
        },
      ],
    });

    deps.contactRepository.findMergeCandidates = vi
      .fn()
      .mockResolvedValue([overlappingContact, secondOverlap]);
    processor = createMergeDetectionProcessor(deps);

    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await processor({ data: jobData });

    expect(deps.saveMergeSuggestion).toHaveBeenCalledTimes(2);
  });

  it('propagates errors from contactRepository.findById', async () => {
    deps.contactRepository.findById = vi.fn().mockRejectedValue(new Error('DB read error'));
    processor = createMergeDetectionProcessor(deps);

    const jobData: MergeDetectionJobData = {
      tenantId: TENANT_ID,
      contactId: CONTACT_ID,
    };

    await expect(processor({ data: jobData })).rejects.toThrow('DB read error');
  });
});
