import { describe, expect, it } from 'vitest';
import { Message } from '../models/message.model.js';

describe('Message indexes', () => {
  const indexes = (Message.schema as any).indexes() as Array<
    [Record<string, number>, Record<string, unknown>]
  >;

  function findIndex(fields: Record<string, number>): Record<string, unknown> | undefined {
    return indexes.find(
      ([indexFields]) => JSON.stringify(indexFields) === JSON.stringify(fields),
    )?.[1];
  }

  it('uses a supported non-empty projectId partial filter for recall queries', () => {
    const options = findIndex({ tenantId: 1, projectId: 1, contactId: 1, createdAt: -1 });

    expect(options).toBeDefined();
    expect(options?.partialFilterExpression).toEqual({
      contactId: { $type: 'string' },
      projectId: { $gt: '' },
    });
  });
});
