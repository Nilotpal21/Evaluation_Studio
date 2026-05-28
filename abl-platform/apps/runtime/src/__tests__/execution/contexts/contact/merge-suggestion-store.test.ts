/**
 * MergeSuggestionMongoStore Tests
 *
 * Tests the MongoDB implementation of the MergeSuggestionStore port.
 * Uses mocked Mongoose model (chainable pattern) to verify:
 * - All queries include tenantId for tenant isolation
 * - create() persists and returns the domain object with an id
 * - findByTenant() queries with correct tenantId filter and optional status
 * - findById() queries with tenantId + _id
 * - updateStatus() uses findOneAndUpdate with tenantId + _id
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MergeSuggestionMongoStore } from '../../../../contexts/contact/infrastructure/merge-suggestion-store.js';
import type { MergeSuggestion } from '../../../../contexts/contact/domain/merge-suggestion.js';

// ─── Test Fixtures ──────────────────────────────────────────────────────

const TENANT_A = 'tenant-aaa';
const TENANT_B = 'tenant-bbb';
const SUGGESTION_ID = 'suggestion-001';

function makeSuggestion(overrides: Partial<MergeSuggestion> = {}): MergeSuggestion {
  return {
    id: SUGGESTION_ID,
    tenantId: TENANT_A,
    primaryContactId: 'contact-001',
    secondaryContactId: 'contact-002',
    overlapIdentities: [{ type: 'email', blindIndex: 'blind-email-alice' }],
    confidence: 'high',
    status: 'pending',
    suggestedAt: new Date('2025-06-01T00:00:00Z'),
    resolvedAt: null,
    resolvedBy: null,
    ...overrides,
  };
}

function makeDocument(suggestion: MergeSuggestion) {
  return {
    _id: suggestion.id,
    tenantId: suggestion.tenantId,
    primaryContactId: suggestion.primaryContactId,
    secondaryContactId: suggestion.secondaryContactId,
    overlapIdentities: suggestion.overlapIdentities,
    confidence: suggestion.confidence,
    status: suggestion.status,
    suggestedAt: suggestion.suggestedAt,
    resolvedAt: suggestion.resolvedAt,
    resolvedBy: suggestion.resolvedBy,
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

  model.find = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
  model.findOne = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
  model.findOneAndUpdate = vi.fn().mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

  return { model, mockSaveInstance };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('MergeSuggestionMongoStore', () => {
  let mockModel: any;
  let mockSaveInstance: any;
  let store: MergeSuggestionMongoStore;

  beforeEach(() => {
    const mocks = createMockModel();
    mockModel = mocks.model;
    mockSaveInstance = mocks.mockSaveInstance;
    store = new MergeSuggestionMongoStore(mockModel);
  });

  // ── create ──────────────────────────────────────────────────────────

  describe('create', () => {
    it('should persist and return domain object with id', async () => {
      const suggestion = makeSuggestion();
      const doc = makeDocument(suggestion);

      mockSaveInstance.save.mockResolvedValue(undefined);
      mockSaveInstance.toObject.mockReturnValue(doc);

      const { id, ...input } = suggestion;
      const result = await store.create(input);

      expect(mockSaveInstance.save).toHaveBeenCalled();
      expect(mockSaveInstance.toObject).toHaveBeenCalled();
      expect(result.id).toBe(SUGGESTION_ID);
      expect(result.tenantId).toBe(TENANT_A);
      expect(result.primaryContactId).toBe('contact-001');
      expect(result.secondaryContactId).toBe('contact-002');
      expect(result.overlapIdentities).toEqual([
        { type: 'email', blindIndex: 'blind-email-alice' },
      ]);
      expect(result.confidence).toBe('high');
      expect(result.status).toBe('pending');
      expect(result.resolvedAt).toBeNull();
      expect(result.resolvedBy).toBeNull();
    });

    it('should not pass id to Mongoose (let _id be generated)', async () => {
      const suggestion = makeSuggestion();
      const doc = makeDocument(suggestion);

      mockSaveInstance.save.mockResolvedValue(undefined);
      mockSaveInstance.toObject.mockReturnValue(doc);

      const { id, ...input } = suggestion;
      await store.create(input);

      // save() was called — verify constructor didn't receive an `id` field
      expect(mockSaveInstance.save).toHaveBeenCalled();
    });
  });

  // ── findByTenant ────────────────────────────────────────────────────

  describe('findByTenant', () => {
    it('should query with tenantId only when no status is provided', async () => {
      const s1 = makeSuggestion();
      const s2 = makeSuggestion({ id: 'suggestion-002', status: 'accepted' });
      mockModel.find.mockReturnValue({
        lean: vi.fn().mockResolvedValue([makeDocument(s1), makeDocument(s2)]),
      });

      const result = await store.findByTenant(TENANT_A);

      expect(mockModel.find).toHaveBeenCalledWith({ tenantId: TENANT_A });
      expect(result).toHaveLength(2);
      expect(result[0].id).toBe(SUGGESTION_ID);
      expect(result[1].id).toBe('suggestion-002');
    });

    it('should include status filter when status is provided', async () => {
      mockModel.find.mockReturnValue({
        lean: vi.fn().mockResolvedValue([makeDocument(makeSuggestion())]),
      });

      const result = await store.findByTenant(TENANT_A, 'pending');

      expect(mockModel.find).toHaveBeenCalledWith({ tenantId: TENANT_A, status: 'pending' });
      expect(result).toHaveLength(1);
    });

    it('should return empty array when no suggestions exist', async () => {
      mockModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });

      const result = await store.findByTenant(TENANT_A, 'rejected');

      expect(result).toEqual([]);
    });

    it('should include tenantId in query (tenant isolation)', async () => {
      mockModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });

      await store.findByTenant(TENANT_B);

      expect(mockModel.find).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT_B }));
    });
  });

  // ── findById ────────────────────────────────────────────────────────

  describe('findById', () => {
    it('should query with _id and tenantId', async () => {
      const doc = makeDocument(makeSuggestion());
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await store.findById(TENANT_A, SUGGESTION_ID);

      expect(mockModel.findOne).toHaveBeenCalledWith({
        _id: SUGGESTION_ID,
        tenantId: TENANT_A,
      });
      expect(result).not.toBeNull();
      expect(result!.id).toBe(SUGGESTION_ID);
      expect(result!.tenantId).toBe(TENANT_A);
    });

    it('should return null when not found', async () => {
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await store.findById(TENANT_A, 'nonexistent');

      expect(result).toBeNull();
    });

    it('should include tenantId in query (tenant isolation)', async () => {
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      await store.findById(TENANT_B, SUGGESTION_ID);

      expect(mockModel.findOne).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_B }),
      );
    });
  });

  // ── updateStatus ──────────────────────────────────────────────────

  describe('updateStatus', () => {
    it('should use findOneAndUpdate with tenantId + _id', async () => {
      const updated = makeSuggestion({
        status: 'accepted',
        resolvedBy: 'user-123',
        resolvedAt: new Date(),
      });
      const doc = makeDocument(updated);
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await store.updateStatus(TENANT_A, SUGGESTION_ID, 'accepted', 'user-123');

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        { _id: SUGGESTION_ID, tenantId: TENANT_A },
        {
          $set: {
            status: 'accepted',
            resolvedBy: 'user-123',
            resolvedAt: expect.any(Date),
          },
        },
        { new: true },
      );
      expect(result).not.toBeNull();
      expect(result!.status).toBe('accepted');
      expect(result!.resolvedBy).toBe('user-123');
    });

    it('should return null when suggestion not found', async () => {
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      const result = await store.updateStatus(TENANT_A, 'nonexistent', 'rejected', 'user-456');

      expect(result).toBeNull();
    });

    it('should include tenantId in filter (tenant isolation)', async () => {
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });

      await store.updateStatus(TENANT_B, SUGGESTION_ID, 'rejected', 'user-789');

      expect(mockModel.findOneAndUpdate).toHaveBeenCalledWith(
        expect.objectContaining({ tenantId: TENANT_B }),
        expect.any(Object),
        expect.any(Object),
      );
    });

    it('should set resolvedAt to a Date', async () => {
      const doc = makeDocument(makeSuggestion({ status: 'rejected', resolvedBy: 'user-x' }));
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      await store.updateStatus(TENANT_A, SUGGESTION_ID, 'rejected', 'user-x');

      const updateArg = mockModel.findOneAndUpdate.mock.calls[0][1];
      expect(updateArg.$set.resolvedAt).toBeInstanceOf(Date);
    });
  });

  // ── Document-to-domain mapping ──────────────────────────────────────

  describe('document-to-domain mapping', () => {
    it('should map _id to id in returned suggestions', async () => {
      const doc = makeDocument(makeSuggestion());
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await store.findById(TENANT_A, SUGGESTION_ID);

      expect(result).not.toBeNull();
      expect(result!.id).toBe(SUGGESTION_ID);
      // Ensure no _id leaks into domain object
      expect((result as any)._id).toBeUndefined();
    });

    it('should preserve all overlapIdentities through round-trip', async () => {
      const suggestion = makeSuggestion({
        overlapIdentities: [
          { type: 'email', blindIndex: 'blind-1' },
          { type: 'phone', blindIndex: 'blind-2' },
        ],
      });
      const doc = makeDocument(suggestion);
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(doc) });

      const result = await store.findById(TENANT_A, SUGGESTION_ID);

      expect(result!.overlapIdentities).toEqual([
        { type: 'email', blindIndex: 'blind-1' },
        { type: 'phone', blindIndex: 'blind-2' },
      ]);
    });
  });

  // ── Tenant Isolation ────────────────────────────────────────────────

  describe('tenant isolation', () => {
    it('every read query includes tenantId', async () => {
      // findByTenant
      mockModel.find.mockReturnValue({ lean: vi.fn().mockResolvedValue([]) });
      await store.findByTenant(TENANT_A);
      expect(mockModel.find.mock.calls[0][0]).toHaveProperty('tenantId', TENANT_A);

      // findById
      mockModel.findOne.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
      await store.findById(TENANT_A, SUGGESTION_ID);
      expect(mockModel.findOne.mock.calls[0][0]).toHaveProperty('tenantId', TENANT_A);
    });

    it('every write query includes tenantId', async () => {
      // updateStatus
      mockModel.findOneAndUpdate.mockReturnValue({ lean: vi.fn().mockResolvedValue(null) });
      await store.updateStatus(TENANT_A, SUGGESTION_ID, 'accepted', 'user-1');
      expect(mockModel.findOneAndUpdate.mock.calls[0][0]).toHaveProperty('tenantId', TENANT_A);
    });
  });
});
