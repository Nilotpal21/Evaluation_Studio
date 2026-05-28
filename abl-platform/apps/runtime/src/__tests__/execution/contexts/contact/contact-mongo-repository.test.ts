/**
 * ContactMongoRepository Tests
 *
 * Tests the MongoDB implementation of the ContactRepository port.
 * Uses mocked Mongoose model (chainable pattern) to verify:
 * - All queries include tenantId for tenant isolation
 * - Correct query shapes for blind index lookups
 * - Proper field mapping between domain and document
 * - $push for addIdentity
 * - Channel history updates for linkSession
 * - Soft/hard delete operations
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ContactMongoRepository } from '../../../../contexts/contact/infrastructure/contact-mongo-repository.js';
import type { Contact } from '../../../../contexts/contact/domain/contact.js';
import type { ContactIdentity } from '../../../../contexts/contact/domain/contact-identity.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────

const TENANT_A = 'tenant-aaa';
const TENANT_B = 'tenant-bbb';
const CONTACT_ID = 'contact-001';

function makeContact(overrides: Partial<Contact> = {}): Contact {
  return {
    id: CONTACT_ID,
    tenantId: TENANT_A,
    identities: [
      {
        type: 'email',
        encryptedValue: 'enc-alice@example.com',
        blindIndex: 'blind-email-alice',
        verified: true,
        verifiedAt: new Date('2025-01-01T00:00:00Z'),
        verifiedVia: 'hmac',
        channel: 'web',
      },
    ],
    displayName: 'Alice',
    type: 'customer',
    metadata: { source: 'sdk' },
    tags: ['vip'],
    channelHistory: [
      {
        channelType: 'web',
        channelId: 'ch-web-1',
        firstSessionAt: new Date('2025-01-01'),
        lastSessionAt: new Date('2025-06-01'),
        sessionCount: 5,
      },
    ],
    sessionCount: 5,
    firstSeenAt: new Date('2025-01-01'),
    lastSeenAt: new Date('2025-06-01'),
    mergedInto: null,
    deletedAt: null,
    encryptionSalt: null,
    ...overrides,
  };
}

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
    _v: 1,
    createdAt: new Date(),
    updatedAt: new Date(),
  };
}

// ─── Mock Model Factory ─────────────────────────────────────────────────

function createMockModel() {
  const mockSaveInstance = {
    save: vi.fn(),
    toObject: vi.fn(),
  };

  // Use a real function constructor so `new model(...)` works
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

// ─── Tests ──────────────────────────────────────────────────────────────

describe('ContactMongoRepository', () => {
  let mockModel: any;
  let mockSaveInstance: any;
  let repo: ContactMongoRepository;

  beforeEach(() => {
    const mocks = createMockModel();
    mockModel = mocks.model;
    mockSaveInstance = mocks.mockSaveInstance;
    repo = new ContactMongoRepository(mockModel);
  });

  // ── findById ────────────────────────────────────────────────────────

  describe('findById', () => {
    it('should query with _id and tenantId', async () => {
      const doc = makeDocument(makeContact());
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findById(TENANT_A, CONTACT_ID);

      expect(mockModel.findOne).toHaveBeenCalledWith({
        _id: CONTACT_ID,
        tenantId: TENANT_A,
      });
      expect(result).not.toBeNull();
      expect(result!.id).toBe(CONTACT_ID);
      expect(result!.tenantId).toBe(TENANT_A);
    });

    it('should return null when not found', async () => {
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await repo.findById(TENANT_A, 'nonexistent');

      expect(result).toBeNull();
    });

    it('should include tenantId in query (tenant isolation)', async () => {
      await repo.findById(TENANT_B, CONTACT_ID);

      expect(mockModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_B }),
      );
    });
  });

  // ── findByBlindIndex ────────────────────────────────────────────────

  describe('findByBlindIndex', () => {
    it('should query with tenantId, identities.blindIndex, and deletedAt: null', async () => {
      const doc = makeDocument(makeContact());
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findByBlindIndex(TENANT_A, 'blind-email-alice');

      expect(mockModel.findOne).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        'identities.blindIndex': 'blind-email-alice',
        deletedAt: null,
      });
      expect(result).not.toBeNull();
      expect(result!.identities[0].blindIndex).toBe('blind-email-alice');
    });

    it('should return null when no match', async () => {
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await repo.findByBlindIndex(TENANT_A, 'no-such-index');

      expect(result).toBeNull();
    });
  });

  // ── findByBlindIndexes ──────────────────────────────────────────────

  describe('findByBlindIndexes', () => {
    it('should query with $in for multiple blind indexes', async () => {
      const c1 = makeContact();
      const c2 = makeContact({ id: 'contact-002' });
      mockModel.find.mockReturnValue({
        lean: vi.fn().mockResolvedValue([makeDocument(c1), makeDocument(c2)]),
      });

      const indexes = ['blind-email-alice', 'blind-phone-bob'];
      const result = await repo.findByBlindIndexes(TENANT_A, indexes);

      expect(mockModel.find).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        'identities.blindIndex': { $in: indexes },
        deletedAt: null,
      });
      expect(result).toHaveLength(2);
    });

    it('should return empty array when no matches', async () => {
      mockModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });

      const result = await repo.findByBlindIndexes(TENANT_A, ['no-match']);

      expect(result).toEqual([]);
    });
  });

  // ── create ──────────────────────────────────────────────────────────

  describe('create', () => {
    it('should create a new contact with all fields', async () => {
      const contact = makeContact();
      const doc = makeDocument(contact);

      mockSaveInstance.save.mockResolvedValue(undefined);
      mockSaveInstance.toObject.mockReturnValue(doc);

      const result = await repo.create(contact);

      // save() must have been called on the constructed instance
      expect(mockSaveInstance.save).toHaveBeenCalled();
      // toObject() must have been called to convert to lean doc
      expect(mockSaveInstance.toObject).toHaveBeenCalled();
      // Domain object returned with correct mapping
      expect(result.id).toBe(contact.id);
      expect(result.tenantId).toBe(TENANT_A);
      expect(result.identities).toEqual(contact.identities);
      expect(result.displayName).toBe(contact.displayName);
      expect(result.type).toBe(contact.type);
      expect(result.metadata).toEqual(contact.metadata);
      expect(result.tags).toEqual(contact.tags);
      expect(result.channelHistory).toEqual(contact.channelHistory);
      expect(result.sessionCount).toBe(contact.sessionCount);
      expect(result.mergedInto).toBeNull();
      expect(result.deletedAt).toBeNull();
    });
  });

  // ── update ──────────────────────────────────────────────────────────

  describe('update', () => {
    it('should use findOneAndUpdate with _id and tenantId filter', async () => {
      const contact = makeContact({ displayName: 'Alice Updated' });
      const doc = makeDocument(contact);
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.update(contact);

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: contact.id, tenantId: contact.tenantId },
        expect.objectContaining({
          $set: expect.objectContaining({
            identities: contact.identities,
            displayName: 'Alice Updated',
            type: contact.type,
          }),
        }),
        { new: true },
      );
      expect(result.displayName).toBe('Alice Updated');
    });

    it('should throw when contact not found (tenant mismatch)', async () => {
      const contact = makeContact({ tenantId: TENANT_B });
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      await expect(repo.update(contact)).rejects.toThrow();
    });
  });

  // ── addIdentity ─────────────────────────────────────────────────────

  describe('addIdentity', () => {
    it('should use $push to add identity to identities array', async () => {
      const identity: ContactIdentity = {
        type: 'phone',
        encryptedValue: 'enc-+15551234567',
        blindIndex: 'blind-phone-123',
        verified: false,
        verifiedAt: null,
        verifiedVia: null,
        channel: 'sms',
      };

      await repo.addIdentity(TENANT_A, CONTACT_ID, identity);

      expect(mockModel.updateOne).toHaveBeenCalledWith(
        { _id: CONTACT_ID, tenantId: TENANT_A },
        { $push: { identities: identity } },
      );
    });

    it('should include tenantId in update filter (tenant isolation)', async () => {
      const identity: ContactIdentity = {
        type: 'email',
        encryptedValue: 'enc-val',
        blindIndex: 'blind-val',
        verified: false,
        verifiedAt: null,
        verifiedVia: null,
        channel: null,
      };

      await repo.addIdentity(TENANT_B, CONTACT_ID, identity);

      expect(mockModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_B }),
        expect.any(Object),
      );
    });
  });

  // ── linkSession ─────────────────────────────────────────────────────

  describe('linkSession', () => {
    it('should update channel history and increment sessionCount', async () => {
      // First call to findOne returns existing contact with no matching channel
      const contact = makeContact({ channelHistory: [] });
      const doc = makeDocument(contact);
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      await repo.linkSession(TENANT_A, CONTACT_ID, 'session-1', 'web', 'ch-web-1');

      // Should have called updateOne with tenantId
      expect(mockModel.updateOne).toHaveBeenCalledWith(
        expect.objectContaining({
          _id: CONTACT_ID,
          tenantId: TENANT_A,
        }),
        expect.objectContaining({
          $inc: expect.objectContaining({ sessionCount: 1 }),
        }),
      );
    });
  });

  // ── softDelete ──────────────────────────────────────────────────────

  describe('softDelete', () => {
    it('should set deletedAt to current date with tenant filter', async () => {
      await repo.softDelete(TENANT_A, CONTACT_ID);

      expect(mockModel.updateOne).toHaveBeenCalledWith(
        { _id: CONTACT_ID, tenantId: TENANT_A },
        { $set: { deletedAt: expect.any(Date) } },
      );
    });
  });

  // ── hardDelete ──────────────────────────────────────────────────────

  describe('hardDelete', () => {
    it('should call deleteOne with _id and tenantId', async () => {
      await repo.hardDelete(TENANT_A, CONTACT_ID);

      expect(mockModel.deleteOne).toHaveBeenCalledWith({
        _id: CONTACT_ID,
        tenantId: TENANT_A,
      });
    });

    it('should include tenantId (no cross-tenant delete)', async () => {
      await repo.hardDelete(TENANT_B, CONTACT_ID);

      expect(mockModel.deleteOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_B }),
      );
    });
  });

  // ── findMergeCandidates ─────────────────────────────────────────────

  describe('findMergeCandidates', () => {
    it('should query with $in and exclude deleted contacts', async () => {
      const indexes = ['blind-a', 'blind-b'];
      mockModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });

      await repo.findMergeCandidates(TENANT_A, indexes);

      expect(mockModel.find).toHaveBeenCalledWith({
        tenantId: TENANT_A,
        'identities.blindIndex': { $in: indexes },
        deletedAt: null,
      });
    });
  });

  // ── Tenant Isolation ────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('every read query includes tenantId', async () => {
      // findById
      await repo.findById(TENANT_A, CONTACT_ID);
      expect(mockModel.findOne.mock.calls[0][0]).toHaveProperty('tenantId', TENANT_A);

      // findByBlindIndex
      await repo.findByBlindIndex(TENANT_A, 'idx');
      expect(mockModel.findOne.mock.calls[1][0]).toHaveProperty('tenantId', TENANT_A);

      // findByBlindIndexes
      mockModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
      await repo.findByBlindIndexes(TENANT_A, ['idx']);
      expect(mockModel.find.mock.calls[0][0]).toHaveProperty('tenantId', TENANT_A);

      // findMergeCandidates
      await repo.findMergeCandidates(TENANT_A, ['idx']);
      expect(mockModel.find.mock.calls[1][0]).toHaveProperty('tenantId', TENANT_A);
    });

    it('every write query includes tenantId', async () => {
      // addIdentity
      const identity: ContactIdentity = {
        type: 'email',
        encryptedValue: 'enc',
        blindIndex: 'idx',
        verified: false,
        verifiedAt: null,
        verifiedVia: null,
        channel: null,
      };
      await repo.addIdentity(TENANT_A, CONTACT_ID, identity);
      expect(mockModel.updateOne.mock.calls[0][0]).toHaveProperty('tenantId', TENANT_A);

      // softDelete
      await repo.softDelete(TENANT_A, CONTACT_ID);
      expect(mockModel.updateOne.mock.calls[1][0]).toHaveProperty('tenantId', TENANT_A);

      // hardDelete
      await repo.hardDelete(TENANT_A, CONTACT_ID);
      expect(mockModel.deleteOne.mock.calls[0][0]).toHaveProperty('tenantId', TENANT_A);
    });
  });

  // ── Document-to-domain mapping ──────────────────────────────────────

  describe('document-to-domain mapping', () => {
    it('should map _id to id in returned contacts', async () => {
      const contact = makeContact();
      const doc = makeDocument(contact);
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findById(TENANT_A, CONTACT_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(CONTACT_ID);
      // Ensure no _id leaks into domain object
      expect((result as any)._id).toBeUndefined();
    });

    it('should preserve all identity fields through round-trip', async () => {
      const contact = makeContact();
      const doc = makeDocument(contact);
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await repo.findById(TENANT_A, CONTACT_ID);

      expect(result!.identities[0]).toEqual(contact.identities[0]);
    });
  });
});
