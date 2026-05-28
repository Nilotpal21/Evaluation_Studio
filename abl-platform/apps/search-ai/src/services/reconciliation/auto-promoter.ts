/**
 * Auto-Promoter
 *
 * Evaluates whether a novel attribute should be promoted to approved,
 * discarded as noise, or kept as novel for further observation.
 */

import type { IAttributeRegistry } from '@agent-platform/database/models';
import type { InteractionStats, ReconciliationConfig } from './types.js';

export interface PromotionDecision {
  attributeId: string;
  productScope: string;
  action: 'promote' | 'discard' | 'keep' | 'demote';
  reason: string;
}

/**
 * Evaluate whether an attribute should be promoted, discarded, demoted, or kept.
 *
 * Decision order:
 * 1. Discard: novel with too few docs AND old enough (age gate)
 * 2. Interaction demote: approved → beta when click rate is critically low
 *    (permanent tier is never demoted; checked before doc-count promotion
 *    so approved attrs with high doc-count but terrible engagement can still demote)
 * 3. Doc-count promote: high frequency + high confidence (novel/beta → approved)
 * 4. Interaction promote: beta → approved when click rate + unique users meet thresholds
 * 5. Keep: no action needed
 */
export function evaluatePromotion(
  attr: IAttributeRegistry,
  config: ReconciliationConfig,
  interactionStats?: InteractionStats,
): PromotionDecision {
  const docCount = attr.documentCount ?? 0;
  const confidence = attr.confidence ?? 0;
  const base = {
    attributeId: attr.attributeId,
    productScope: attr.productScope,
  };

  // Admin-set tiers are never auto-promoted/demoted
  if (attr.discoverySource === 'admin_manual') {
    return {
      ...base,
      action: 'keep',
      reason: 'Admin-managed attribute (discoverySource=admin_manual)',
    };
  }

  // Discarded attributes cannot be re-promoted — they require explicit admin action.
  if (attr.tier === 'discarded') {
    return {
      ...base,
      action: 'keep',
      reason: 'Discarded tier cannot be promoted automatically',
    };
  }

  // Discard noise: ONLY novel tier, too few documents AND old enough.
  // Without the age gate, newly discovered attributes (docCount=1) would be
  // immediately discarded before they had time to appear in more documents.
  // Tier gate prevents beta/approved from being discarded — they can only be demoted.
  const ageMs = attr.firstSeenAt ? Date.now() - new Date(attr.firstSeenAt).getTime() : 0;
  if (
    attr.tier === 'novel' &&
    docCount < config.discardDocCountMax &&
    ageMs > config.discardMinAgeMs
  ) {
    return {
      ...base,
      action: 'discard',
      reason: `documentCount=${docCount} < ${config.discardDocCountMax} and age=${Math.round(ageMs / 86400000)}d > ${Math.round(config.discardMinAgeMs / 86400000)}d`,
    };
  }

  // Interaction-based demotion: approved → beta (checked BEFORE doc-count promotion
  // so that an approved attribute with high doc-count but terrible engagement can be demoted).
  // Permanent tier is NEVER demoted.
  if (
    interactionStats &&
    attr.tier === 'approved' &&
    interactionStats.impressions >= config.demotionImpressionsMin &&
    interactionStats.clickRate < config.demotionClickRateMax
  ) {
    return {
      ...base,
      action: 'demote',
      reason: `Low engagement: clickRate=${interactionStats.clickRate.toFixed(3)} < ${config.demotionClickRateMax}, impressions=${interactionStats.impressions}`,
    };
  }

  // Doc-count promote: high frequency + high confidence (novel/beta → approved)
  // Skipped for already-approved attributes (they can only be demoted via interactions above).
  if (
    attr.tier !== 'approved' &&
    attr.tier !== 'permanent' &&
    docCount >= config.promotionDocCountMin &&
    confidence >= config.promotionConfidenceMin
  ) {
    return {
      ...base,
      action: 'promote',
      reason: `documentCount=${docCount} >= ${config.promotionDocCountMin} AND confidence=${confidence} >= ${config.promotionConfidenceMin}`,
    };
  }

  // Interaction-based promotion: beta → approved
  if (
    interactionStats &&
    interactionStats.impressions >= config.promotionImpressionsMin &&
    attr.tier === 'beta' &&
    interactionStats.clickRate >= config.promotionClickRateMin &&
    interactionStats.uniqueUsers >= config.promotionUniqueUsersMin
  ) {
    return {
      ...base,
      action: 'promote',
      reason: `Interaction-based: clickRate=${interactionStats.clickRate.toFixed(3)} >= ${config.promotionClickRateMin}, uniqueUsers=${interactionStats.uniqueUsers} >= ${config.promotionUniqueUsersMin}`,
    };
  }

  // Keep as-is
  return {
    ...base,
    action: 'keep',
    reason: `Below promotion thresholds (docCount=${docCount}, confidence=${confidence})`,
  };
}
