import { describe, expect, it } from 'vitest';

import {
  DEFAULT_EVAL_RETENTION,
  assertDefaultSyntheticRetentionIsShorter,
  normalizeEvalKnownSource,
  resolveEvalConversationTtlDays,
  resolveEvalRetentionContract,
  resolveEvalScoreTtlDays,
} from '../eval-retention.js';

describe('eval retention contract', () => {
  it('resolves the platform defaults when tenant overrides are missing', () => {
    const contract = resolveEvalRetentionContract(null);

    expect(contract.evalConversationsTtlDays).toBe(730);
    expect(contract.evalScoresTtlDays).toBe(730);
    expect(contract.productionScoresTtlDays).toBe(365);
    expect(contract.syntheticTtlDays).toBe(30);
    expect(contract.hardDeleteExpiredRuns).toBe(false);
    expect(contract.scrubPiiOnStore).toBe(false);
  });

  it('applies tenant TTL and cleanup overrides', () => {
    const contract = resolveEvalRetentionContract({
      evalRetention: {
        evalConversationsTtlDays: 120,
        evalScoresTtlDays: 90,
        productionScoresTtlDays: 180,
        syntheticTtlDays: 14,
        hardDeleteExpiredRuns: true,
        scrubPiiOnStore: true,
      },
    });

    expect(contract).toMatchObject({
      evalConversationsTtlDays: 120,
      evalScoresTtlDays: 90,
      productionScoresTtlDays: 180,
      syntheticTtlDays: 14,
      hardDeleteExpiredRuns: true,
      scrubPiiOnStore: true,
    });
  });

  it('rejects values outside the retention bounds', () => {
    expect(() =>
      resolveEvalRetentionContract({
        evalRetention: {
          evalConversationsTtlDays: 6,
        },
      }),
    ).toThrow(/between 7 and 730/);

    expect(() =>
      resolveEvalRetentionContract({
        evalRetention: {
          productionScoresTtlDays: 731,
        },
      }),
    ).toThrow(/between 7 and 730/);
  });

  it('requires synthetic retention to be shorter than eval retention', () => {
    expect(() =>
      resolveEvalRetentionContract({
        evalRetention: {
          evalConversationsTtlDays: 30,
          evalScoresTtlDays: 90,
          syntheticTtlDays: 30,
        },
      }),
    ).toThrow(/syntheticTtlDays must be strictly shorter/);

    assertDefaultSyntheticRetentionIsShorter();
  });

  it('resolves per-row TTLs from knownSource', () => {
    const contract = {
      ...DEFAULT_EVAL_RETENTION,
      evalConversationsTtlDays: 100,
      evalScoresTtlDays: 80,
      syntheticTtlDays: 20,
      overrides: {},
    };

    expect(resolveEvalConversationTtlDays(contract, 'eval')).toBe(100);
    expect(resolveEvalConversationTtlDays(contract, 'production')).toBe(100);
    expect(resolveEvalConversationTtlDays(contract, 'synthetic')).toBe(20);
    expect(resolveEvalScoreTtlDays(contract, 'eval')).toBe(80);
    expect(resolveEvalScoreTtlDays(contract, 'synthetic')).toBe(20);
  });

  it('normalizes unknown caller tags to eval', () => {
    expect(normalizeEvalKnownSource('synthetic')).toBe('synthetic');
    expect(normalizeEvalKnownSource('unexpected')).toBe('eval');
    expect(normalizeEvalKnownSource(undefined)).toBe('eval');
  });
});
