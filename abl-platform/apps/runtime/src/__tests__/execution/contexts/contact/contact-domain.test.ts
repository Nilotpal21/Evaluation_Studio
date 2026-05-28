/**
 * Contact Domain Types Tests
 *
 * Validates that all contact domain type shapes are correct and
 * can be instantiated with proper values. Uses type-satisfaction
 * pattern: create objects matching each interface, verify fields.
 */

import { describe, it, expect } from 'vitest';
import type {
  Contact,
  ContactType,
  ChannelHistoryEntry,
} from '../../../../contexts/contact/domain/contact.js';
import type {
  ContactIdentity,
  ContactIdentityType,
} from '../../../../contexts/contact/domain/contact-identity.js';
import type { ContactRepository } from '../../../../contexts/contact/domain/contact-repository.js';
import type {
  MergeSuggestion,
  MergeSuggestionConfidence,
  MergeSuggestionStatus,
} from '../../../../contexts/contact/domain/merge-suggestion.js';
import type { MergeExecution } from '../../../../contexts/contact/domain/merge-execution.js';
import { createContactIdentity } from '../../../../contexts/contact/domain/contact-identity.js';

// =============================================================================
// ContactIdentityType
// =============================================================================

describe('ContactIdentityType', () => {
  it('supports all 3 identity types', () => {
    const types: ContactIdentityType[] = ['email', 'phone', 'external'];
    expect(types).toHaveLength(3);
    const unique = new Set(types);
    expect(unique.size).toBe(3);
  });
});

// =============================================================================
// ContactIdentity
// =============================================================================

describe('ContactIdentity', () => {
  it('creates a verified email identity', () => {
    const identity: ContactIdentity = {
      type: 'email',
      encryptedValue: 'base64-encrypted-email',
      blindIndex: 'abcdef1234567890abcdef1234567890abcdef1234567890abcdef1234567890',
      verified: true,
      verifiedAt: new Date('2026-01-15T10:00:00Z'),
      verifiedVia: 'otp',
      channel: 'web',
    };
    expect(identity.type).toBe('email');
    expect(identity.encryptedValue).toBe('base64-encrypted-email');
    expect(identity.blindIndex).toHaveLength(64);
    expect(identity.verified).toBe(true);
    expect(identity.verifiedAt).toBeInstanceOf(Date);
    expect(identity.verifiedVia).toBe('otp');
    expect(identity.channel).toBe('web');
  });

  it('creates an unverified phone identity', () => {
    const identity: ContactIdentity = {
      type: 'phone',
      encryptedValue: 'base64-encrypted-phone',
      blindIndex: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      verified: false,
      verifiedAt: null,
      verifiedVia: null,
      channel: 'whatsapp',
    };
    expect(identity.type).toBe('phone');
    expect(identity.verified).toBe(false);
    expect(identity.verifiedAt).toBeNull();
    expect(identity.verifiedVia).toBeNull();
    expect(identity.channel).toBe('whatsapp');
  });

  it('creates an external identity without channel', () => {
    const identity: ContactIdentity = {
      type: 'external',
      encryptedValue: 'base64-encrypted-crm-id',
      blindIndex: 'fedcba0987654321fedcba0987654321fedcba0987654321fedcba0987654321',
      verified: true,
      verifiedAt: new Date('2026-02-01T08:30:00Z'),
      verifiedVia: 'oauth',
      channel: null,
    };
    expect(identity.type).toBe('external');
    expect(identity.channel).toBeNull();
  });
});

// =============================================================================
// createContactIdentity factory
// =============================================================================

describe('createContactIdentity()', () => {
  it('creates an unverified identity with defaults', () => {
    const identity = createContactIdentity({
      type: 'email',
      encryptedValue: 'enc-val',
      blindIndex: 'blind-idx',
    });
    expect(identity.type).toBe('email');
    expect(identity.encryptedValue).toBe('enc-val');
    expect(identity.blindIndex).toBe('blind-idx');
    expect(identity.verified).toBe(false);
    expect(identity.verifiedAt).toBeNull();
    expect(identity.verifiedVia).toBeNull();
    expect(identity.channel).toBeNull();
  });

  it('creates a verified identity with all options', () => {
    const now = new Date();
    const identity = createContactIdentity({
      type: 'phone',
      encryptedValue: 'enc-phone',
      blindIndex: 'blind-phone',
      verified: true,
      verifiedAt: now,
      verifiedVia: 'provider',
      channel: 'sms',
    });
    expect(identity.verified).toBe(true);
    expect(identity.verifiedAt).toBe(now);
    expect(identity.verifiedVia).toBe('provider');
    expect(identity.channel).toBe('sms');
  });
});

// =============================================================================
// ChannelHistoryEntry
// =============================================================================

describe('ChannelHistoryEntry', () => {
  it('creates a channel history entry with all fields', () => {
    const entry: ChannelHistoryEntry = {
      channelType: 'whatsapp',
      channelId: 'ch-wa-001',
      firstSessionAt: new Date('2026-01-01T00:00:00Z'),
      lastSessionAt: new Date('2026-02-18T12:00:00Z'),
      sessionCount: 15,
    };
    expect(entry.channelType).toBe('whatsapp');
    expect(entry.channelId).toBe('ch-wa-001');
    expect(entry.firstSessionAt).toBeInstanceOf(Date);
    expect(entry.lastSessionAt).toBeInstanceOf(Date);
    expect(entry.sessionCount).toBe(15);
  });

  it('works with all channel types', () => {
    const channelTypes = [
      'web',
      'mobile_ios',
      'mobile_android',
      'voice',
      'sms',
      'whatsapp',
      'email',
      'facebook',
      'ms_teams',
      'api',
    ] as const;

    for (const ct of channelTypes) {
      const entry: ChannelHistoryEntry = {
        channelType: ct,
        channelId: `ch-${ct}-001`,
        firstSessionAt: new Date(),
        lastSessionAt: new Date(),
        sessionCount: 1,
      };
      expect(entry.channelType).toBe(ct);
    }
  });
});

// =============================================================================
// ContactType
// =============================================================================

describe('ContactType', () => {
  it('supports customer and employee types', () => {
    const types: ContactType[] = ['customer', 'employee'];
    expect(types).toHaveLength(2);
    const unique = new Set(types);
    expect(unique.size).toBe(2);
  });
});

// =============================================================================
// Contact
// =============================================================================

describe('Contact', () => {
  it('creates a minimal contact with required fields', () => {
    const now = new Date();
    const contact: Contact = {
      id: '01926b89-7a3e-7def-9abc-123456789abc',
      tenantId: 'tenant-001',
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
    };
    expect(contact.id).toBe('01926b89-7a3e-7def-9abc-123456789abc');
    expect(contact.tenantId).toBe('tenant-001');
    expect(contact.identities).toEqual([]);
    expect(contact.displayName).toBeNull();
    expect(contact.type).toBe('customer');
    expect(contact.metadata).toEqual({});
    expect(contact.tags).toEqual([]);
    expect(contact.channelHistory).toEqual([]);
    expect(contact.sessionCount).toBe(0);
    expect(contact.mergedInto).toBeNull();
    expect(contact.deletedAt).toBeNull();
  });

  it('creates a full contact with identities and channel history', () => {
    const contact: Contact = {
      id: '01926b89-7a3e-7def-9abc-222222222222',
      tenantId: 'tenant-002',
      identities: [
        {
          type: 'email',
          encryptedValue: 'enc-email',
          blindIndex: 'blind-email',
          verified: true,
          verifiedAt: new Date('2026-01-10T00:00:00Z'),
          verifiedVia: 'otp',
          channel: 'web',
        },
        {
          type: 'phone',
          encryptedValue: 'enc-phone',
          blindIndex: 'blind-phone',
          verified: false,
          verifiedAt: null,
          verifiedVia: null,
          channel: 'whatsapp',
        },
      ],
      displayName: 'Alice Johnson',
      type: 'employee',
      metadata: { department: 'engineering', tier: 'premium' },
      tags: ['vip', 'early-adopter'],
      channelHistory: [
        {
          channelType: 'web',
          channelId: 'ch-web-main',
          firstSessionAt: new Date('2026-01-01T00:00:00Z'),
          lastSessionAt: new Date('2026-02-18T12:00:00Z'),
          sessionCount: 20,
        },
        {
          channelType: 'whatsapp',
          channelId: 'ch-wa-001',
          firstSessionAt: new Date('2026-02-01T00:00:00Z'),
          lastSessionAt: new Date('2026-02-18T14:00:00Z'),
          sessionCount: 5,
        },
      ],
      sessionCount: 25,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-02-18T14:00:00Z'),
      mergedInto: null,
      deletedAt: null,
      encryptionSalt: null,
      contactContext: null,
    };
    expect(contact.identities).toHaveLength(2);
    expect(contact.identities[0].type).toBe('email');
    expect(contact.identities[1].type).toBe('phone');
    expect(contact.displayName).toBe('Alice Johnson');
    expect(contact.type).toBe('employee');
    expect(contact.tags).toContain('vip');
    expect(contact.channelHistory).toHaveLength(2);
    expect(contact.sessionCount).toBe(25);
  });

  it('represents a merged contact', () => {
    const contact: Contact = {
      id: '01926b89-7a3e-7def-9abc-333333333333',
      tenantId: 'tenant-001',
      identities: [],
      displayName: 'Merged Away',
      type: 'customer',
      metadata: {},
      tags: [],
      channelHistory: [],
      sessionCount: 3,
      firstSeenAt: new Date('2026-01-01T00:00:00Z'),
      lastSeenAt: new Date('2026-01-15T00:00:00Z'),
      mergedInto: '01926b89-7a3e-7def-9abc-444444444444',
      deletedAt: null,
      encryptionSalt: null,
      contactContext: null,
    };
    expect(contact.mergedInto).toBe('01926b89-7a3e-7def-9abc-444444444444');
  });

  it('represents a soft-deleted contact', () => {
    const deletedAt = new Date('2026-02-18T16:00:00Z');
    const contact: Contact = {
      id: '01926b89-7a3e-7def-9abc-555555555555',
      tenantId: 'tenant-001',
      identities: [],
      displayName: null,
      type: 'customer',
      metadata: {},
      tags: [],
      channelHistory: [],
      sessionCount: 1,
      firstSeenAt: new Date('2026-02-01T00:00:00Z'),
      lastSeenAt: new Date('2026-02-01T00:00:00Z'),
      mergedInto: null,
      deletedAt,
      encryptionSalt: null,
      contactContext: null,
    };
    expect(contact.deletedAt).toBe(deletedAt);
  });
});

// =============================================================================
// ContactRepository (port interface type check)
// =============================================================================

describe('ContactRepository', () => {
  it('has the correct method signatures (compile-time type check)', () => {
    // This test verifies the interface shape by creating a mock implementation.
    // If the interface changes, this test will fail to compile.
    const mockRepo: ContactRepository = {
      findById: async (_tenantId: string, _contactId: string) => null,
      findByBlindIndex: async (_tenantId: string, _blindIndex: string) => null,
      findByBlindIndexes: async (_tenantId: string, _blindIndexes: string[]) => [],
      create: async (contact: Contact) => contact,
      update: async (contact: Contact) => contact,
      addIdentity: async (_tenantId: string, _contactId: string, _identity: ContactIdentity) => {},
      linkSession: async (
        _tenantId: string,
        _contactId: string,
        _sessionId: string,
        _channelType: string,
        _channelId: string,
      ) => {},
      softDelete: async (_tenantId: string, _contactId: string) => {},
      hardDelete: async (_tenantId: string, _contactId: string) => {},
      findMergeCandidates: async (_tenantId: string, _blindIndexes: string[]) => [],
    };

    // Verify all 10 methods exist
    expect(typeof mockRepo.findById).toBe('function');
    expect(typeof mockRepo.findByBlindIndex).toBe('function');
    expect(typeof mockRepo.findByBlindIndexes).toBe('function');
    expect(typeof mockRepo.create).toBe('function');
    expect(typeof mockRepo.update).toBe('function');
    expect(typeof mockRepo.addIdentity).toBe('function');
    expect(typeof mockRepo.linkSession).toBe('function');
    expect(typeof mockRepo.softDelete).toBe('function');
    expect(typeof mockRepo.hardDelete).toBe('function');
    expect(typeof mockRepo.findMergeCandidates).toBe('function');
  });

  it('findById returns Contact or null', async () => {
    const mockRepo: ContactRepository = {
      findById: async () => null,
      findByBlindIndex: async () => null,
      findByBlindIndexes: async () => [],
      create: async (c) => c,
      update: async (c) => c,
      addIdentity: async () => {},
      linkSession: async () => {},
      softDelete: async () => {},
      hardDelete: async () => {},
      findMergeCandidates: async () => [],
    };

    const result = await mockRepo.findById('tenant-001', 'contact-id');
    expect(result).toBeNull();
  });

  it('findByBlindIndexes returns Contact array', async () => {
    const now = new Date();
    const contact: Contact = {
      id: 'contact-1',
      tenantId: 'tenant-001',
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
    };

    const mockRepo: ContactRepository = {
      findById: async () => null,
      findByBlindIndex: async () => null,
      findByBlindIndexes: async () => [contact],
      create: async (c) => c,
      update: async (c) => c,
      addIdentity: async () => {},
      linkSession: async () => {},
      softDelete: async () => {},
      hardDelete: async () => {},
      findMergeCandidates: async () => [],
    };

    const results = await mockRepo.findByBlindIndexes('tenant-001', ['idx-1', 'idx-2']);
    expect(results).toHaveLength(1);
    expect(results[0].id).toBe('contact-1');
  });
});

// =============================================================================
// MergeSuggestion
// =============================================================================

describe('MergeSuggestion', () => {
  it('supports all confidence levels', () => {
    const levels: MergeSuggestionConfidence[] = ['high', 'medium', 'low'];
    expect(levels).toHaveLength(3);
    const unique = new Set(levels);
    expect(unique.size).toBe(3);
  });

  it('supports all status values', () => {
    const statuses: MergeSuggestionStatus[] = ['pending', 'accepted', 'rejected', 'auto_merged'];
    expect(statuses).toHaveLength(4);
    const unique = new Set(statuses);
    expect(unique.size).toBe(4);
  });

  it('creates a pending merge suggestion', () => {
    const suggestion: MergeSuggestion = {
      id: 'merge-sug-001',
      tenantId: 'tenant-001',
      primaryContactId: 'contact-aaa',
      secondaryContactId: 'contact-bbb',
      overlapIdentities: [{ type: 'email', blindIndex: 'blind-email-shared' }],
      confidence: 'high',
      status: 'pending',
      suggestedAt: new Date('2026-02-18T10:00:00Z'),
      resolvedAt: null,
      resolvedBy: null,
    };
    expect(suggestion.id).toBe('merge-sug-001');
    expect(suggestion.primaryContactId).toBe('contact-aaa');
    expect(suggestion.secondaryContactId).toBe('contact-bbb');
    expect(suggestion.overlapIdentities).toHaveLength(1);
    expect(suggestion.overlapIdentities[0].type).toBe('email');
    expect(suggestion.confidence).toBe('high');
    expect(suggestion.status).toBe('pending');
    expect(suggestion.resolvedAt).toBeNull();
    expect(suggestion.resolvedBy).toBeNull();
  });

  it('creates a resolved (accepted) merge suggestion', () => {
    const suggestion: MergeSuggestion = {
      id: 'merge-sug-002',
      tenantId: 'tenant-001',
      primaryContactId: 'contact-ccc',
      secondaryContactId: 'contact-ddd',
      overlapIdentities: [
        { type: 'phone', blindIndex: 'blind-phone-shared' },
        { type: 'email', blindIndex: 'blind-email-shared' },
      ],
      confidence: 'medium',
      status: 'accepted',
      suggestedAt: new Date('2026-02-17T08:00:00Z'),
      resolvedAt: new Date('2026-02-18T09:00:00Z'),
      resolvedBy: 'user-admin-001',
    };
    expect(suggestion.status).toBe('accepted');
    expect(suggestion.resolvedAt).toBeInstanceOf(Date);
    expect(suggestion.resolvedBy).toBe('user-admin-001');
    expect(suggestion.overlapIdentities).toHaveLength(2);
  });

  it('creates an auto-merged suggestion resolved by system', () => {
    const suggestion: MergeSuggestion = {
      id: 'merge-sug-003',
      tenantId: 'tenant-001',
      primaryContactId: 'contact-eee',
      secondaryContactId: 'contact-fff',
      overlapIdentities: [{ type: 'email', blindIndex: 'blind-email-exact-match' }],
      confidence: 'high',
      status: 'auto_merged',
      suggestedAt: new Date('2026-02-18T11:00:00Z'),
      resolvedAt: new Date('2026-02-18T11:00:01Z'),
      resolvedBy: 'system',
    };
    expect(suggestion.status).toBe('auto_merged');
    expect(suggestion.resolvedBy).toBe('system');
  });

  it('creates a rejected suggestion', () => {
    const suggestion: MergeSuggestion = {
      id: 'merge-sug-004',
      tenantId: 'tenant-002',
      primaryContactId: 'contact-ggg',
      secondaryContactId: 'contact-hhh',
      overlapIdentities: [{ type: 'external', blindIndex: 'blind-crm-id' }],
      confidence: 'low',
      status: 'rejected',
      suggestedAt: new Date('2026-02-16T00:00:00Z'),
      resolvedAt: new Date('2026-02-18T15:00:00Z'),
      resolvedBy: 'user-operator-005',
    };
    expect(suggestion.status).toBe('rejected');
    expect(suggestion.confidence).toBe('low');
  });
});

// =============================================================================
// MergeExecution
// =============================================================================

describe('MergeExecution', () => {
  it('creates a merge execution with suggestion link', () => {
    const execution: MergeExecution = {
      id: 'merge-exec-001',
      tenantId: 'tenant-001',
      primaryContactId: 'contact-aaa',
      secondaryContactId: 'contact-bbb',
      identitiesMoved: [
        {
          type: 'phone',
          encryptedValue: 'enc-phone-moved',
          blindIndex: 'blind-phone-moved',
          verified: true,
          verifiedAt: new Date('2026-01-20T00:00:00Z'),
          verifiedVia: 'provider',
          channel: 'whatsapp',
        },
      ],
      sessionsMoved: ['session-001', 'session-002', 'session-003'],
      mergedAt: new Date('2026-02-18T12:00:00Z'),
      mergedBy: 'user-admin-001',
      suggestionId: 'merge-sug-001',
    };
    expect(execution.id).toBe('merge-exec-001');
    expect(execution.primaryContactId).toBe('contact-aaa');
    expect(execution.secondaryContactId).toBe('contact-bbb');
    expect(execution.identitiesMoved).toHaveLength(1);
    expect(execution.identitiesMoved[0].type).toBe('phone');
    expect(execution.sessionsMoved).toHaveLength(3);
    expect(execution.mergedAt).toBeInstanceOf(Date);
    expect(execution.mergedBy).toBe('user-admin-001');
    expect(execution.suggestionId).toBe('merge-sug-001');
  });

  it('creates a merge execution without suggestion (manual merge)', () => {
    const execution: MergeExecution = {
      id: 'merge-exec-002',
      tenantId: 'tenant-001',
      primaryContactId: 'contact-ccc',
      secondaryContactId: 'contact-ddd',
      identitiesMoved: [],
      sessionsMoved: [],
      mergedAt: new Date('2026-02-18T13:00:00Z'),
      mergedBy: 'system',
      suggestionId: null,
    };
    expect(execution.suggestionId).toBeNull();
    expect(execution.mergedBy).toBe('system');
    expect(execution.identitiesMoved).toEqual([]);
    expect(execution.sessionsMoved).toEqual([]);
  });

  it('creates a self-service merge', () => {
    const execution: MergeExecution = {
      id: 'merge-exec-003',
      tenantId: 'tenant-002',
      primaryContactId: 'contact-xxx',
      secondaryContactId: 'contact-yyy',
      identitiesMoved: [
        {
          type: 'email',
          encryptedValue: 'enc-email-moved',
          blindIndex: 'blind-email-moved',
          verified: false,
          verifiedAt: null,
          verifiedVia: null,
          channel: null,
        },
      ],
      sessionsMoved: ['session-old-001'],
      mergedAt: new Date('2026-02-18T14:00:00Z'),
      mergedBy: 'self',
      suggestionId: 'merge-sug-010',
    };
    expect(execution.mergedBy).toBe('self');
  });
});
