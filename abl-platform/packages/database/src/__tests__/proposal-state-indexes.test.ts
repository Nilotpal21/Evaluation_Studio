import { describe, expect, it } from 'vitest';
import { ProposalState } from '../models/proposal-state.model.js';

describe('ProposalState indexes', () => {
  const indexes = (ProposalState.schema as any).indexes() as Array<
    [Record<string, number>, Record<string, unknown>]
  >;

  function findIndex(fields: Record<string, number>): Record<string, unknown> | undefined {
    return indexes.find(
      ([indexFields]) => JSON.stringify(indexFields) === JSON.stringify(fields),
    )?.[1];
  }

  it('keeps the active-proposal uniqueness constraint on supported statuses only', () => {
    const options = findIndex({ tenantId: 1, connectorId: 1 });

    expect(options).toBeDefined();
    expect(options?.unique).toBe(true);
    expect(options?.partialFilterExpression).toEqual({
      status: { $in: ['generating', 'ready', 'approved'] },
    });
  });
});
