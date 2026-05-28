/**
 * Facet Display Rules Service
 *
 * Selects which facets to display based on budget constraints:
 * - Max 8 visible facets total
 * - Max 3 beta facets within that budget
 * - Minimum 2 distinct values required for a facet to qualify
 * - Beta facets selected by lowest impression count (round-robin fairness)
 */

import { createLogger } from '@abl/compiler/platform';

import { DEFAULT_FACET_DISPLAY_CONFIG } from './types.js';
import type { DisplayFacet, FacetDisplayConfig } from './types.js';

const log = createLogger('facet-display-rules');

/** Tiers considered promoted (non-beta) */
const PROMOTED_TIERS: readonly string[] = ['permanent', 'approved'];

/** Input attribute shape for selectFacets */
export interface FacetCandidate {
  attributeType: string;
  productScope: string;
  displayName: string;
  tier: string;
  dataType: string;
  distinctValueCount: number;
  impressionCount: number;
}

export class FacetDisplayRulesService {
  private config: FacetDisplayConfig;

  constructor(config?: Partial<FacetDisplayConfig>) {
    this.config = { ...DEFAULT_FACET_DISPLAY_CONFIG, ...config };
    // Clamp: maxBetaFacets cannot exceed maxVisibleFacets to prevent negative promotedBudget
    this.config.maxBetaFacets = Math.min(this.config.maxBetaFacets, this.config.maxVisibleFacets);
  }

  /**
   * Select facets to display given budget constraints.
   *
   * 1. Filter out attributes with too few distinct values
   * 2. Separate into promoted (permanent/approved) and beta pools
   * 3. Sort promoted by distinctValueCount DESC (most useful first)
   * 4. Sort beta by impressionCount ASC (least-shown first = round-robin)
   * 5. Take up to (maxVisibleFacets - maxBetaFacets) from promoted pool
   * 6. If includeBeta, take up to maxBetaFacets from beta pool
   *    (if promoted pool is smaller than its budget, remaining slots go to beta)
   * 7. Return combined: promoted first, then beta
   */
  selectFacets(attributes: readonly FacetCandidate[], includeBeta: boolean): DisplayFacet[] {
    // 1. Filter: exclude attributes with too few distinct values
    const qualified = attributes.filter(
      (a) => a.distinctValueCount >= this.config.minDistinctValues,
    );

    // 2. Separate into promoted and beta pools
    const promoted: FacetCandidate[] = [];
    const beta: FacetCandidate[] = [];

    for (const attr of qualified) {
      if (PROMOTED_TIERS.includes(attr.tier)) {
        promoted.push(attr);
      } else {
        beta.push(attr);
      }
    }

    // 3. Sort promoted by distinctValueCount DESC (most useful first)
    promoted.sort((a, b) => b.distinctValueCount - a.distinctValueCount);

    // 4. Sort beta by impressionCount ASC (least-shown first = round-robin)
    beta.sort((a, b) => a.impressionCount - b.impressionCount);

    // 5. Take promoted facets. When beta is included, reserve maxBetaFacets slots.
    // When beta is disabled, promoted gets the full budget.
    const promotedBudget = includeBeta
      ? this.config.maxVisibleFacets - this.config.maxBetaFacets
      : this.config.maxVisibleFacets;
    const selectedPromoted = promoted.slice(0, promotedBudget);

    // 6. If includeBeta, fill remaining slots with beta facets
    let selectedBeta: FacetCandidate[] = [];
    if (includeBeta) {
      const remainingSlots = this.config.maxVisibleFacets - selectedPromoted.length;
      const betaBudget = Math.min(this.config.maxBetaFacets, remainingSlots);
      selectedBeta = beta.slice(0, betaBudget);
    }

    log.debug('Facet selection complete', {
      totalCandidates: attributes.length,
      qualified: qualified.length,
      promotedPool: promoted.length,
      betaPool: beta.length,
      selectedPromoted: selectedPromoted.length,
      selectedBeta: selectedBeta.length,
    });

    // 7. Map to DisplayFacet and combine
    return [
      ...selectedPromoted.map((a) => this.toDisplayFacet(a, false)),
      ...selectedBeta.map((a) => this.toDisplayFacet(a, true)),
    ];
  }

  private toDisplayFacet(attr: FacetCandidate, isBeta: boolean): DisplayFacet {
    return {
      attributeType: attr.attributeType,
      productScope: attr.productScope,
      displayName: attr.displayName,
      tier: attr.tier,
      isBeta,
      dataType: attr.dataType,
      distinctValueCount: attr.distinctValueCount,
      impressionCount: attr.impressionCount,
    };
  }
}
