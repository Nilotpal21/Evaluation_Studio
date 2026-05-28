import { describe, expect, it } from 'vitest';

import {
  DEFAULT_OPERATION_TIERS,
  MODEL_ROUTING_OPERATIONS,
  MODEL_ROUTING_TIERS,
  TEXT_MODEL_ROUTING_TIERS,
  getDefaultOperationTier,
  isModelRoutingOperation,
  isModelRoutingTier,
  isTextModelRoutingTier,
  normalizeOperationTierOverrides,
} from '../model-routing.js';

describe('model routing contract', () => {
  it('keeps voice in the canonical model routing tier vocabulary', () => {
    expect(MODEL_ROUTING_TIERS).toEqual(['fast', 'balanced', 'powerful', 'voice', 'embedding']);
    expect(TEXT_MODEL_ROUTING_TIERS).toEqual(['fast', 'balanced', 'powerful']);
    expect(isModelRoutingTier('voice')).toBe(true);
    expect(isTextModelRoutingTier('voice')).toBe(false);
  });

  it('keeps realtime voice in the canonical operation vocabulary', () => {
    expect(MODEL_ROUTING_OPERATIONS).toContain('realtime_voice');
    expect(isModelRoutingOperation('realtime_voice')).toBe(true);
    expect(isModelRoutingOperation('voice')).toBe(false);
  });

  it('maps realtime voice to the voice tier by default', () => {
    expect(DEFAULT_OPERATION_TIERS.realtime_voice).toBe('voice');
    expect(DEFAULT_OPERATION_TIERS.extraction).toBe('fast');
    expect(DEFAULT_OPERATION_TIERS.reasoning).toBe('powerful');
    expect(getDefaultOperationTier('tool_selection')).toBe('fast');
  });

  it('normalizes operation-tier override records and maps', () => {
    expect(
      normalizeOperationTierOverrides({
        response_gen: 'powerful',
        realtime_voice: 'voice',
      }),
    ).toEqual({
      ok: true,
      overrides: {
        response_gen: 'powerful',
        realtime_voice: 'voice',
      },
    });

    expect(normalizeOperationTierOverrides(new Map([['tool_selection', 'fast']]))).toEqual({
      ok: true,
      overrides: { tool_selection: 'fast' },
    });
  });

  it('rejects unknown operation names and tier values', () => {
    expect(
      normalizeOperationTierOverrides({
        extract: 'premium',
        response_gen: 'voice',
        realtime_voice: 42,
      }),
    ).toEqual({
      ok: false,
      invalidOperations: ['extract'],
      invalidTiers: ['premium', '42'],
      incompatiblePairs: [{ operation: 'response_gen', tier: 'voice' }],
    });
  });

  it('accepts voice only for realtime voice operation overrides', () => {
    expect(normalizeOperationTierOverrides({ realtime_voice: 'voice' })).toEqual({
      ok: true,
      overrides: { realtime_voice: 'voice' },
    });

    expect(normalizeOperationTierOverrides({ realtime_voice: 'fast' })).toEqual({
      ok: false,
      invalidOperations: [],
      invalidTiers: [],
      incompatiblePairs: [{ operation: 'realtime_voice', tier: 'fast' }],
    });

    expect(normalizeOperationTierOverrides({ response_gen: 'voice' })).toEqual({
      ok: false,
      invalidOperations: [],
      invalidTiers: [],
      incompatiblePairs: [{ operation: 'response_gen', tier: 'voice' }],
    });
  });
});
