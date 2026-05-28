import { describe, test, expect, vi, beforeEach } from 'vitest';

const EXPECTED_NODE_TYPE_COUNT = 37;

const mockBulkWrite = vi
  .fn()
  .mockResolvedValue({ upsertedCount: EXPECTED_NODE_TYPE_COUNT, modifiedCount: 0 });
const mockDeleteMany = vi.fn().mockResolvedValue({ deletedCount: 0 });
vi.mock('../schemas/node-type-definition.schema.js', () => ({
  NodeTypeDefinitionModel: {
    bulkWrite: mockBulkWrite,
    deleteMany: mockDeleteMany,
  },
}));

describe('seedNodeTypes', () => {
  beforeEach(() => {
    mockBulkWrite.mockClear();
    mockDeleteMany.mockClear();
  });

  test('calls bulkWrite with upsert operations for all 37 types', async () => {
    const { seedNodeTypes } = await import('../pipeline/seed-node-types.js');
    const result = await seedNodeTypes();

    expect(mockBulkWrite).toHaveBeenCalledTimes(1);
    const operations = mockBulkWrite.mock.calls[0][0];
    expect(operations).toHaveLength(EXPECTED_NODE_TYPE_COUNT);

    // Each operation is an updateOne with upsert
    for (const op of operations) {
      expect(op.updateOne).toBeDefined();
      expect(op.updateOne.filter._id).toBeTruthy();
      expect(op.updateOne.filter.tenantId).toBe('SYSTEM');
      expect(op.updateOne.upsert).toBe(true);
    }

    expect(result.count).toBe(EXPECTED_NODE_TYPE_COUNT);
  });

  test('sets updatedAt in the $set payload', async () => {
    const { seedNodeTypes } = await import('../pipeline/seed-node-types.js');
    await seedNodeTypes();

    const operations = mockBulkWrite.mock.calls[0][0];
    for (const op of operations) {
      expect(op.updateOne.update.$set.updatedAt).toBeInstanceOf(Date);
    }
  });
});
