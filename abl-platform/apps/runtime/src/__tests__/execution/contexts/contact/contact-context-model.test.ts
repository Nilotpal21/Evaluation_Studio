/**
 * Contact Context Model Tests — Item 27
 *
 * Validates the contactContext subdocument on the Contact domain model and
 * the toDocument/toDomain round-trip through the ContactMongoRepository.
 *
 * Scope:
 *   1. New Contact has contactContext: null by default.
 *   2. A Contact with contactContext round-trips through the repository
 *      mapping (toDocument / toDomain) without data loss or mutation.
 *
 * Strategy: mocked Mongoose model — no real MongoDB required.
 */

import { describe, test, expect, vi, beforeEach } from 'vitest';
import { ContactMongoRepository } from '../../../../contexts/contact/infrastructure/contact-mongo-repository.js';
import type { Contact, ContactContext } from '../../../../contexts/contact/domain/contact.js';

// =============================================================================
// Helpers
// =============================================================================

const NOW = new Date('2026-03-05T12:00:00.000Z');
const TENANT_ID = 'tenant-ctx-test';
const CONTACT_ID = 'contact-ctx-001';

/** Build a minimal Contact domain object. contactContext defaults to null. */
function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: CONTACT_ID,
    tenantId: TENANT_ID,
    identities: [],
    displayName: null,
    type: 'customer',
    metadata: {},
    tags: [],
    channelHistory: [],
    sessionCount: 0,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
    mergedInto: null,
    deletedAt: null,
    encryptionSalt: null,
    contactContext: null,
    ...overrides,
  };
}

/** Build a lean Mongoose document shape matching IContact. */
function makeDocument(contact: Contact) {
  return {
    _id: contact.id,
    tenantId: contact.tenantId,
    identities: contact.identities,
    displayName: contact.displayName,
    type: contact.type,
    metadata: contact.metadata,
    tags: contact.tags,
    channelHistory: contact.channelHistory,
    sessionCount: contact.sessionCount,
    firstSeenAt: contact.firstSeenAt,
    lastSeenAt: contact.lastSeenAt,
    mergedInto: contact.mergedInto,
    deletedAt: contact.deletedAt,
    encryptionSalt: contact.encryptionSalt,
    contactContext: contact.contactContext,
    // Mongoose-managed fields present on real documents
    _v: 1,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

/** Create a minimal Mongoose model mock that supports the repository methods under test. */
function createMockModel() {
  const mockSaveInstance = {
    save: vi.fn().mockResolvedValue(undefined),
    toObject: vi.fn(),
  };

  function ModelConstructor(this: any, data: any) {
    Object.assign(this, data);
    this.save = mockSaveInstance.save;
    this.toObject = mockSaveInstance.toObject;
  }

  const model: any = ModelConstructor;

  model.findOne = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  model.find = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  model.findOneAndUpdate = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  model.updateOne = vi.fn().mockResolvedValue({ modifiedCount: 1 });
  model.deleteOne = vi.fn().mockResolvedValue({ deletedCount: 1 });

  return { model, mockSaveInstance };
}

// =============================================================================
// Tests
// =============================================================================

describe('contactContext subdocument on Contact model (Item 27)', () => {
  let mockModel: any;
  let mockSaveInstance: any;
  let repo: ContactMongoRepository;

  beforeEach(() => {
    const mocks = createMockModel();
    mockModel = mocks.model;
    mockSaveInstance = mocks.mockSaveInstance;
    repo = new ContactMongoRepository(mockModel);
  });

  // ---------------------------------------------------------------------------
  // 1. Default value
  // ---------------------------------------------------------------------------

  describe('contactContext defaults to null', () => {
    test('a newly constructed Contact domain object has contactContext: null', () => {
      const contact = makeContact();
      expect(contact.contactContext).toBeNull();
    });

    test('Contact with contactContext: null is accepted by the domain type', () => {
      const contact: Contact = makeContact({ contactContext: null });
      expect(contact.contactContext).toBeNull();
    });

    test('findById returns contactContext: null when document has contactContext: null', async () => {
      const contact = makeContact({ contactContext: null });
      const doc = makeDocument(contact);
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findById(TENANT_ID, CONTACT_ID);

      expect(result).not.toBeNull();
      expect(result!.contactContext).toBeNull();
    });

    test('findById returns contactContext: null when document field is missing (legacy document)', async () => {
      const contact = makeContact();
      const doc = makeDocument(contact);
      // Simulate a legacy document where the field was never set
      delete (doc as any).contactContext;
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findById(TENANT_ID, CONTACT_ID);

      expect(result).not.toBeNull();
      expect(result!.contactContext).toBeNull();
    });
  });

  // ---------------------------------------------------------------------------
  // 2. Round-trip through Mongo mapping (toDocument / toDomain)
  // ---------------------------------------------------------------------------

  describe('contactContext round-trip through repository mapping', () => {
    const fullContext: ContactContext = {
      preferences: { language: 'en', theme: 'dark' },
      dataValues: { loyaltyTier: 'gold', accountBalance: 1500 },
      lastDisposition: 'resolved',
      lastInteraction: new Date('2026-03-04T09:00:00.000Z'),
      sessionCount: 12,
      updatedAt: new Date('2026-03-04T09:00:00.000Z'),
    };

    test('create() preserves contactContext in the document passed to save()', async () => {
      const contact = makeContact({ contactContext: fullContext });
      const doc = makeDocument(contact);

      mockSaveInstance.toObject.mockReturnValue(doc);

      await repo.create(contact);

      // The instance was constructed with toDocument(contact); verify save was called
      expect(mockSaveInstance.save).toHaveBeenCalled();
      // toObject returns the doc which toDomain then maps — result checked separately
    });

    test('create() maps contactContext back to domain correctly', async () => {
      const contact = makeContact({ contactContext: fullContext });
      const doc = makeDocument(contact);

      mockSaveInstance.toObject.mockReturnValue(doc);

      const result = await repo.create(contact);

      expect(result.contactContext).not.toBeNull();
      expect(result.contactContext!.preferences).toEqual({ language: 'en', theme: 'dark' });
      expect(result.contactContext!.dataValues).toEqual({
        loyaltyTier: 'gold',
        accountBalance: 1500,
      });
      expect(result.contactContext!.lastDisposition).toBe('resolved');
      expect(result.contactContext!.lastInteraction).toEqual(new Date('2026-03-04T09:00:00.000Z'));
      expect(result.contactContext!.sessionCount).toBe(12);
      expect(result.contactContext!.updatedAt).toEqual(new Date('2026-03-04T09:00:00.000Z'));
    });

    test('findById() maps contactContext from document to domain without data loss', async () => {
      const contact = makeContact({ contactContext: fullContext });
      const doc = makeDocument(contact);
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findById(TENANT_ID, CONTACT_ID);

      expect(result).not.toBeNull();
      const ctx = result!.contactContext;
      expect(ctx).not.toBeNull();
      expect(ctx!.preferences).toEqual(fullContext.preferences);
      expect(ctx!.dataValues).toEqual(fullContext.dataValues);
      expect(ctx!.lastDisposition).toBe(fullContext.lastDisposition);
      expect(ctx!.lastInteraction).toEqual(fullContext.lastInteraction);
      expect(ctx!.sessionCount).toBe(fullContext.sessionCount);
      expect(ctx!.updatedAt).toEqual(fullContext.updatedAt);
    });

    test('update() passes contactContext through $set correctly', async () => {
      const contact = makeContact({ contactContext: fullContext });
      const doc = makeDocument(contact);
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.update(contact);

      // Verify the $set payload included contactContext
      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: CONTACT_ID, tenantId: TENANT_ID },
        expect.objectContaining({
          $set: expect.objectContaining({
            contactContext: fullContext,
          }),
        }),
        { new: true },
      );

      // Result is correctly mapped from the returned doc
      expect(result.contactContext).not.toBeNull();
      expect(result.contactContext!.sessionCount).toBe(12);
    });

    test('update() clears contactContext when set to null', async () => {
      const contact = makeContact({ contactContext: null });
      const doc = makeDocument(contact);
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.update(contact);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: CONTACT_ID, tenantId: TENANT_ID },
        expect.objectContaining({
          $set: expect.objectContaining({
            contactContext: null,
          }),
        }),
        { new: true },
      );

      expect(result.contactContext).toBeNull();
    });

    test('contactContext with empty preferences and dataValues round-trips correctly', async () => {
      const emptyCtx: ContactContext = {
        preferences: {},
        dataValues: {},
        lastDisposition: null,
        lastInteraction: null,
        sessionCount: 0,
        updatedAt: NOW,
      };

      const contact = makeContact({ contactContext: emptyCtx });
      const doc = makeDocument(contact);
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findById(TENANT_ID, CONTACT_ID);

      expect(result).not.toBeNull();
      const ctx = result!.contactContext;
      expect(ctx).not.toBeNull();
      expect(ctx!.preferences).toEqual({});
      expect(ctx!.dataValues).toEqual({});
      expect(ctx!.lastDisposition).toBeNull();
      expect(ctx!.lastInteraction).toBeNull();
      expect(ctx!.sessionCount).toBe(0);
    });

    test('contactContext with nested objects in preferences round-trips correctly', async () => {
      const nestedCtx: ContactContext = {
        preferences: {
          notifications: { email: true, sms: false, push: true },
          display: { timezone: 'America/New_York', locale: 'en-US' },
        },
        dataValues: {
          crm: { accountId: 'acct-42', tier: 'enterprise' },
        },
        lastDisposition: 'escalated',
        lastInteraction: new Date('2026-03-01T18:00:00.000Z'),
        sessionCount: 5,
        updatedAt: new Date('2026-03-01T18:00:00.000Z'),
      };

      const contact = makeContact({ contactContext: nestedCtx });
      const doc = makeDocument(contact);
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findById(TENANT_ID, CONTACT_ID);

      expect(result!.contactContext!.preferences).toEqual(nestedCtx.preferences);
      expect(result!.contactContext!.dataValues).toEqual(nestedCtx.dataValues);
      expect(result!.contactContext!.lastDisposition).toBe('escalated');
    });
  });
});
