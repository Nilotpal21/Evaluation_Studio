import { describe, it, expect } from 'vitest';
import { extractSessionMetadata } from '../../services/execution/routing-executor';

describe('Session metadata propagation on handoff', () => {
  it('propagates non-internal, non-gathered metadata from parent to child thread', () => {
    const parentValues: Record<string, unknown> = {
      conversationSummary: 'Customer was looking at Nike running shoes',
      user: 'e2e_test_user',
      gender: 'male',
      location: 'Dubai',
      _handoff_summary: 'routing info',
      _recallPrompts: ['prompt1'],
      _constraint_warnings: [],
      product_category: 'Red sneakers',
      budget_range: 'Under 500 AED',
      handoff_from: 'GuardRail_Supervisor',
    };

    const gatheredKeys = new Set(['product_category', 'brand_preference', 'budget_range']);
    const metadata = extractSessionMetadata(parentValues, gatheredKeys);

    expect(metadata).toEqual({
      conversationSummary: 'Customer was looking at Nike running shoes',
      user: 'e2e_test_user',
      gender: 'male',
      location: 'Dubai',
    });

    expect(metadata._handoff_summary).toBeUndefined();
    expect(metadata._recallPrompts).toBeUndefined();
    expect(metadata.product_category).toBeUndefined();
    expect(metadata.handoff_from).toBeUndefined();
  });

  it('returns empty object when parent has no propagatable metadata', () => {
    const parentValues: Record<string, unknown> = {
      _internal: 'value',
      handoff_from: 'Agent_A',
      product_category: 'shoes',
    };
    const metadata = extractSessionMetadata(parentValues, new Set(['product_category']));
    expect(metadata).toEqual({});
  });

  it('skips null, undefined, and empty string values', () => {
    const parentValues: Record<string, unknown> = {
      user: 'test',
      empty: '',
      nullVal: null,
      undefVal: undefined,
    };
    const metadata = extractSessionMetadata(parentValues, []);
    expect(metadata).toEqual({ user: 'test' });
  });

  it('excludes gathered keys even when they were not declared in top-level gather config', () => {
    const parentValues: Record<string, unknown> = {
      conversationSummary: 'Customer is planning a trip',
      destination: 'Tokyo',
      seat_preference: 'aisle',
      travel_window: 'next month',
    };

    const metadata = extractSessionMetadata(
      parentValues,
      new Set(['destination', 'seat_preference']),
    );

    expect(metadata).toEqual({
      conversationSummary: 'Customer is planning a trip',
      travel_window: 'next month',
    });
  });
});
