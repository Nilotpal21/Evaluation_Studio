import { describe, it, expect } from 'vitest';
import { evaluatePromotion } from '../auto-promoter.js';
import { DEFAULT_RECONCILIATION_CONFIG } from '../types.js';
import type { InteractionStats } from '../types.js';
import type { IAttributeRegistry, AttributeTier } from '@agent-platform/database/models';

/**
 * Build a minimal IAttributeRegistry stub for testing evaluatePromotion.
 */
function makeAttr(
  overrides: Partial<
    Pick<IAttributeRegistry, 'documentCount' | 'confidence' | 'firstSeenAt' | 'tier'>
  >,
): IAttributeRegistry {
  return {
    _id: 'attr-1',
    tenantId: 'tenant-1',
    indexId: 'index-1',
    attributeId: 'test_attribute',
    productScope: 'credit_card',
    tier: overrides.tier ?? 'novel',
    displayName: 'Test Attribute',
    dataType: 'string',
    aliases: [],
    extractionPatterns: [],
    documentCount: overrides.documentCount ?? 0,
    confidence: overrides.confidence ?? 0,
    firstSeenAt: overrides.firstSeenAt,
  } as unknown as IAttributeRegistry;
}

/** Date 30 days in the past — well past the 7-day discard age gate */
const THIRTY_DAYS_AGO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

describe('evaluatePromotion', () => {
  const config = DEFAULT_RECONCILIATION_CONFIG;

  it('promotes when docCount >= 50 AND confidence >= 0.80', () => {
    const result = evaluatePromotion(makeAttr({ documentCount: 60, confidence: 0.9 }), config);
    expect(result.action).toBe('promote');
  });

  it('discards when docCount < 5 AND old enough (past age gate)', () => {
    const result = evaluatePromotion(
      makeAttr({ documentCount: 3, confidence: 0.95, firstSeenAt: THIRTY_DAYS_AGO }),
      config,
    );
    expect(result.action).toBe('discard');
  });

  it('keeps when docCount < 5 but too young (within age gate)', () => {
    const result = evaluatePromotion(
      makeAttr({ documentCount: 3, confidence: 0.95, firstSeenAt: new Date() }),
      config,
    );
    expect(result.action).toBe('keep');
  });

  it('keeps when docCount = 30 (below promotion threshold) despite high confidence', () => {
    const result = evaluatePromotion(makeAttr({ documentCount: 30, confidence: 0.9 }), config);
    expect(result.action).toBe('keep');
  });

  it('keeps when confidence = 0.60 (below promotion threshold) despite high docCount', () => {
    const result = evaluatePromotion(makeAttr({ documentCount: 100, confidence: 0.6 }), config);
    expect(result.action).toBe('keep');
  });

  it('discards when docCount = 0 and old enough', () => {
    const result = evaluatePromotion(
      makeAttr({ documentCount: 0, confidence: 0.95, firstSeenAt: THIRTY_DAYS_AGO }),
      config,
    );
    expect(result.action).toBe('discard');
  });

  it('promotes at exact boundary (docCount = 50, confidence = 0.80)', () => {
    const result = evaluatePromotion(makeAttr({ documentCount: 50, confidence: 0.8 }), config);
    expect(result.action).toBe('promote');
  });

  it('no interaction stats falls back to existing doc-count/confidence rules', () => {
    const result = evaluatePromotion(
      makeAttr({ tier: 'beta', documentCount: 10, confidence: 0.5 }),
      config,
      undefined,
    );
    expect(result.action).toBe('keep');
  });
});

describe('evaluatePromotion — interaction-based', () => {
  const config = DEFAULT_RECONCILIATION_CONFIG;

  it('promotes beta when clickRate >= 5%, uniqueUsers >= 3, impressions >= 100', () => {
    const stats: InteractionStats = {
      impressions: 200,
      clicks: 20,
      uniqueUsers: 5,
      clickRate: 0.1,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'beta', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    expect(result.action).toBe('promote');
    expect(result.reason).toContain('Interaction-based');
  });

  it('does NOT promote beta when below click rate threshold', () => {
    const stats: InteractionStats = {
      impressions: 200,
      clicks: 4,
      uniqueUsers: 5,
      clickRate: 0.02,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'beta', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    expect(result.action).toBe('keep');
  });

  it('does NOT promote beta when below unique users threshold', () => {
    const stats: InteractionStats = {
      impressions: 200,
      clicks: 20,
      uniqueUsers: 2,
      clickRate: 0.1,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'beta', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    expect(result.action).toBe('keep');
  });

  it('does NOT promote beta when impressions below minimum', () => {
    const stats: InteractionStats = {
      impressions: 50,
      clicks: 10,
      uniqueUsers: 5,
      clickRate: 0.2,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'beta', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    expect(result.action).toBe('keep');
  });

  it('demotes approved when clickRate < 1% and impressions >= 20', () => {
    const stats: InteractionStats = {
      impressions: 500,
      clicks: 2,
      uniqueUsers: 2,
      clickRate: 0.004,
    };
    // Demotion is checked BEFORE doc-count promotion, so docCount/confidence don't matter
    const result = evaluatePromotion(
      makeAttr({ tier: 'approved', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    expect(result.action).toBe('demote');
    expect(result.reason).toContain('Low engagement');
  });

  it('does NOT demote approved when clickRate is above demotion threshold', () => {
    const stats: InteractionStats = {
      impressions: 500,
      clicks: 50,
      uniqueUsers: 10,
      clickRate: 0.1,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'approved', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    expect(result.action).toBe('keep');
  });

  it('NEVER demotes permanent tier even with low engagement', () => {
    const stats: InteractionStats = {
      impressions: 500,
      clicks: 1,
      uniqueUsers: 1,
      clickRate: 0.002,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'permanent' as AttributeTier, documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    // permanent is not 'approved', so demotion block is skipped
    expect(result.action).not.toBe('demote');
    expect(result.action).toBe('keep');
  });
});

describe('evaluatePromotion — boundary & tier-gating', () => {
  const config = DEFAULT_RECONCILIATION_CONFIG;

  it('promotes beta at exact interaction boundary (impressions=100, clickRate=0.05, uniqueUsers=3)', () => {
    const stats: InteractionStats = {
      impressions: 100,
      clicks: 5,
      uniqueUsers: 3,
      clickRate: 0.05,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'beta', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    expect(result.action).toBe('promote');
    expect(result.reason).toContain('Interaction-based');
  });

  it('does NOT demote at exact demotion boundary (clickRate=0.01 is NOT < 0.01)', () => {
    // demotionClickRateMax is 0.01, code uses `<` not `<=`, so exactly 0.01 should NOT demote
    const stats: InteractionStats = {
      impressions: 100,
      clicks: 1,
      uniqueUsers: 1,
      clickRate: 0.01,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'approved', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    expect(result.action).not.toBe('demote');
    expect(result.action).toBe('keep');
  });

  it('novel tier with good interaction stats is NOT interaction-promoted (only beta can be)', () => {
    const stats: InteractionStats = {
      impressions: 200,
      clicks: 20,
      uniqueUsers: 5,
      clickRate: 0.1,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'novel', documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    // novel is not beta, so interaction promotion is skipped; falls through to keep
    expect(result.action).toBe('keep');
  });

  it('approved tier with high docCount + low clickRate is DEMOTED (demotion checked before doc-count)', () => {
    const stats: InteractionStats = {
      impressions: 500,
      clicks: 2,
      uniqueUsers: 2,
      clickRate: 0.004,
    };
    // High docCount + confidence that would normally trigger doc-count promotion,
    // but demotion fires first for approved tier, and doc-count promotion skips approved anyway.
    const result = evaluatePromotion(
      makeAttr({ tier: 'approved', documentCount: 100, confidence: 0.95 }),
      config,
      stats,
    );
    expect(result.action).toBe('demote');
    expect(result.reason).toContain('Low engagement');
  });

  it('beta tier with low docCount is NOT discarded (discard is novel-only)', () => {
    const result = evaluatePromotion(
      makeAttr({
        tier: 'beta',
        documentCount: 2,
        confidence: 0.3,
        firstSeenAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
      }),
      config,
    );
    // beta meets discard criteria (low doc count + old) but discard is novel-only
    expect(result.action).not.toBe('discard');
    expect(result.action).toBe('keep');
  });

  it('permanent tier is never demoted or promoted via interactions', () => {
    const stats: InteractionStats = {
      impressions: 200,
      clicks: 20,
      uniqueUsers: 5,
      clickRate: 0.1,
    };
    const result = evaluatePromotion(
      makeAttr({ tier: 'permanent' as AttributeTier, documentCount: 10, confidence: 0.5 }),
      config,
      stats,
    );
    // permanent is neither 'approved' (no demotion) nor 'beta' (no interaction promotion)
    // and doc-count promotion skips permanent
    expect(result.action).toBe('keep');
  });

  it('discarded tier cannot be promoted even with high docCount and confidence', () => {
    const result = evaluatePromotion(
      makeAttr({ tier: 'discarded' as AttributeTier, documentCount: 100, confidence: 0.99 }),
      config,
    );
    expect(result.action).toBe('keep');
    expect(result.reason).toContain('Discarded tier');
  });

  it('does NOT discard at exact discardDocCountMax boundary (docCount=5 is NOT < 5)', () => {
    const result = evaluatePromotion(
      makeAttr({ documentCount: 5, confidence: 0.3, firstSeenAt: THIRTY_DAYS_AGO }),
      config,
    );
    // discardDocCountMax is 5, code uses `<` not `<=`, so exactly 5 should NOT discard
    expect(result.action).not.toBe('discard');
  });
});

describe('evaluatePromotion — admin_manual guard (Sprint 7)', () => {
  const config = DEFAULT_RECONCILIATION_CONFIG;

  function makeAdminAttr(
    tier: AttributeTier,
    overrides?: Partial<Pick<IAttributeRegistry, 'documentCount' | 'confidence'>>,
  ): IAttributeRegistry {
    return {
      ...makeAttr({
        tier,
        documentCount: overrides?.documentCount ?? 100,
        confidence: overrides?.confidence ?? 0.99,
      }),
      discoverySource: 'admin_manual',
    } as unknown as IAttributeRegistry;
  }

  it('keeps admin_manual novel attribute even with high docCount + confidence (would normally promote)', () => {
    const result = evaluatePromotion(makeAdminAttr('novel'), config);
    expect(result.action).toBe('keep');
    expect(result.reason).toContain('Admin-managed');
  });

  it('keeps admin_manual approved attribute even with terrible engagement (would normally demote)', () => {
    const stats: InteractionStats = {
      impressions: 500,
      clicks: 1,
      uniqueUsers: 1,
      clickRate: 0.002,
    };
    const result = evaluatePromotion(makeAdminAttr('approved'), config, stats);
    expect(result.action).toBe('keep');
    expect(result.reason).toContain('Admin-managed');
  });

  it('keeps admin_manual beta attribute (no interaction-based promotion)', () => {
    const stats: InteractionStats = {
      impressions: 200,
      clicks: 20,
      uniqueUsers: 5,
      clickRate: 0.1,
    };
    const result = evaluatePromotion(makeAdminAttr('beta'), config, stats);
    expect(result.action).toBe('keep');
    expect(result.reason).toContain('Admin-managed');
  });

  it('keeps admin_manual discarded attribute (admin decision preserved)', () => {
    const result = evaluatePromotion(makeAdminAttr('discarded' as AttributeTier), config);
    expect(result.action).toBe('keep');
    // admin_manual guard fires BEFORE the discarded guard
    expect(result.reason).toContain('Admin-managed');
  });

  it('does NOT guard non-admin attributes (normal auto-promotion still works)', () => {
    const attr = makeAttr({ documentCount: 100, confidence: 0.95 });
    const result = evaluatePromotion(attr, config);
    expect(result.action).toBe('promote');
  });
});
