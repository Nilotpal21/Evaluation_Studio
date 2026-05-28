import { describe, it, expect, vi } from 'vitest';

// ─── Mock Dependencies ──────────────────────────────────────────────────
vi.mock('@abl/compiler/platform', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { FacetDisplayRulesService } from '../facet-display-rules.service.js';
import type { FacetCandidate } from '../facet-display-rules.service.js';

// ─── Helpers ────────────────────────────────────────────────────────────

/** Create a promoted (permanent/approved) facet candidate */
function makePromoted(
  overrides: Partial<FacetCandidate> & { attributeType: string },
): FacetCandidate {
  return {
    productScope: 'all',
    displayName: overrides.attributeType,
    tier: 'permanent',
    dataType: 'keyword',
    distinctValueCount: 10,
    impressionCount: 0,
    ...overrides,
  };
}

/** Create a beta facet candidate */
function makeBeta(overrides: Partial<FacetCandidate> & { attributeType: string }): FacetCandidate {
  return {
    productScope: 'all',
    displayName: overrides.attributeType,
    tier: 'beta',
    dataType: 'keyword',
    distinctValueCount: 10,
    impressionCount: 0,
    ...overrides,
  };
}

// ─── Tests ──────────────────────────────────────────────────────────────

describe('FacetDisplayRulesService', () => {
  describe('selectFacets', () => {
    it('returns max 8 facets when more than 8 promoted are available and includeBeta=false', () => {
      const service = new FacetDisplayRulesService();

      // 15 promoted attributes
      const attributes: FacetCandidate[] = Array.from({ length: 15 }, (_, i) =>
        makePromoted({
          attributeType: `attr_${i}`,
          distinctValueCount: 20 - i,
        }),
      );

      const result = service.selectFacets(attributes, false);

      // When includeBeta=false, promoted gets the full budget (maxVisibleFacets = 8)
      expect(result.length).toBe(8);
      expect(result.every((f) => !f.isBeta)).toBe(true);
    });

    it('returns max 3 beta facets when includeBeta is true', () => {
      const service = new FacetDisplayRulesService();

      const promoted = Array.from({ length: 3 }, (_, i) =>
        makePromoted({ attributeType: `promoted_${i}` }),
      );
      const betas = Array.from({ length: 10 }, (_, i) =>
        makeBeta({ attributeType: `beta_${i}`, impressionCount: i * 5 }),
      );

      const result = service.selectFacets([...promoted, ...betas], true);

      const betaResults = result.filter((f) => f.isBeta);
      expect(betaResults.length).toBe(3);
    });

    it('excludes attributes with distinctValueCount below minimum', () => {
      const service = new FacetDisplayRulesService();

      const attributes: FacetCandidate[] = [
        makePromoted({ attributeType: 'good', distinctValueCount: 5 }),
        makePromoted({ attributeType: 'low', distinctValueCount: 1 }),
        makePromoted({ attributeType: 'zero', distinctValueCount: 0 }),
        makePromoted({ attributeType: 'exact', distinctValueCount: 2 }),
      ];

      const result = service.selectFacets(attributes, false);

      const types = result.map((f) => f.attributeType);
      expect(types).toContain('good');
      expect(types).toContain('exact');
      expect(types).not.toContain('low');
      expect(types).not.toContain('zero');
    });

    it('selects beta facets by lowest impressionCount first (round-robin)', () => {
      const service = new FacetDisplayRulesService();

      const betas: FacetCandidate[] = [
        makeBeta({ attributeType: 'high', impressionCount: 100 }),
        makeBeta({ attributeType: 'low', impressionCount: 1 }),
        makeBeta({ attributeType: 'mid', impressionCount: 50 }),
        makeBeta({ attributeType: 'lowest', impressionCount: 0 }),
        makeBeta({ attributeType: 'medium', impressionCount: 25 }),
      ];

      const result = service.selectFacets(betas, true);
      const betaResults = result.filter((f) => f.isBeta);

      // Should pick the 3 with lowest impression counts: 0, 1, 25
      expect(betaResults.length).toBe(3);
      expect(betaResults[0].attributeType).toBe('lowest');
      expect(betaResults[1].attributeType).toBe('low');
      expect(betaResults[2].attributeType).toBe('medium');
    });

    it('returns zero beta facets when includeBeta is false', () => {
      const service = new FacetDisplayRulesService();

      const attributes: FacetCandidate[] = [
        makePromoted({ attributeType: 'promoted_1' }),
        makeBeta({ attributeType: 'beta_1' }),
        makeBeta({ attributeType: 'beta_2' }),
      ];

      const result = service.selectFacets(attributes, false);

      expect(result.every((f) => !f.isBeta)).toBe(true);
      expect(result.length).toBe(1);
    });

    it('returns empty array for empty input', () => {
      const service = new FacetDisplayRulesService();

      const result = service.selectFacets([], true);

      expect(result).toEqual([]);
    });

    it('gives remaining slots to beta when promoted pool is small', () => {
      const service = new FacetDisplayRulesService();

      // Only 2 promoted (budget is 5), so 6 remaining slots
      // But beta max is still 3
      const attributes: FacetCandidate[] = [
        makePromoted({ attributeType: 'p1' }),
        makePromoted({ attributeType: 'p2' }),
        ...Array.from({ length: 6 }, (_, i) =>
          makeBeta({ attributeType: `b${i}`, impressionCount: i }),
        ),
      ];

      const result = service.selectFacets(attributes, true);

      const promotedResults = result.filter((f) => !f.isBeta);
      const betaResults = result.filter((f) => f.isBeta);

      expect(promotedResults.length).toBe(2);
      // remainingSlots = 8 - 2 = 6, but capped at maxBetaFacets = 3
      expect(betaResults.length).toBe(3);
      expect(result.length).toBe(5);
    });

    it('respects custom config overrides', () => {
      const service = new FacetDisplayRulesService({
        maxVisibleFacets: 4,
        maxBetaFacets: 1,
        minDistinctValues: 5,
      });

      const attributes: FacetCandidate[] = [
        makePromoted({ attributeType: 'p1', distinctValueCount: 10 }),
        makePromoted({ attributeType: 'p2', distinctValueCount: 8 }),
        makePromoted({ attributeType: 'p3', distinctValueCount: 6 }),
        makePromoted({ attributeType: 'p4', distinctValueCount: 4 }), // below min
        makeBeta({ attributeType: 'b1', distinctValueCount: 7, impressionCount: 0 }),
        makeBeta({ attributeType: 'b2', distinctValueCount: 3, impressionCount: 0 }), // below min
      ];

      const result = service.selectFacets(attributes, true);

      // maxVisible=4, maxBeta=1, promotedBudget=3
      // Qualified promoted: p1, p2, p3 (p4 has 4 < 5)
      // Qualified beta: b1 (b2 has 3 < 5)
      const promotedResults = result.filter((f) => !f.isBeta);
      const betaResults = result.filter((f) => f.isBeta);

      expect(promotedResults.length).toBe(3);
      expect(betaResults.length).toBe(1);
      expect(betaResults[0].attributeType).toBe('b1');
      expect(result.length).toBe(4);
    });

    it('places promoted facets before beta facets in output', () => {
      const service = new FacetDisplayRulesService();

      const attributes: FacetCandidate[] = [
        makeBeta({ attributeType: 'beta_first', impressionCount: 0 }),
        makePromoted({ attributeType: 'promoted_first' }),
      ];

      const result = service.selectFacets(attributes, true);

      expect(result[0].attributeType).toBe('promoted_first');
      expect(result[0].isBeta).toBe(false);
      expect(result[1].attributeType).toBe('beta_first');
      expect(result[1].isBeta).toBe(true);
    });

    it('sorts promoted facets by distinctValueCount descending', () => {
      const service = new FacetDisplayRulesService();

      const attributes: FacetCandidate[] = [
        makePromoted({ attributeType: 'low', distinctValueCount: 3 }),
        makePromoted({ attributeType: 'high', distinctValueCount: 100 }),
        makePromoted({ attributeType: 'mid', distinctValueCount: 20 }),
      ];

      const result = service.selectFacets(attributes, false);

      expect(result[0].attributeType).toBe('high');
      expect(result[1].attributeType).toBe('mid');
      expect(result[2].attributeType).toBe('low');
    });

    it('routes novel and discarded tiers to beta pool (not promoted pool)', () => {
      const service = new FacetDisplayRulesService();

      const attributes: FacetCandidate[] = [
        makePromoted({ attributeType: 'permanent_one', tier: 'permanent' }),
        // novel and discarded are NOT in PROMOTED_TIERS, so they go to beta pool
        {
          attributeType: 'novel_one',
          productScope: 'all',
          displayName: 'novel_one',
          tier: 'novel',
          dataType: 'keyword',
          distinctValueCount: 10,
          impressionCount: 5,
        },
        {
          attributeType: 'discarded_one',
          productScope: 'all',
          displayName: 'discarded_one',
          tier: 'discarded',
          dataType: 'keyword',
          distinctValueCount: 10,
          impressionCount: 3,
        },
      ];

      // With includeBeta=true, novel/discarded go to beta pool and are marked isBeta
      const result = service.selectFacets(attributes, true);
      const promotedResults = result.filter((f) => !f.isBeta);
      const betaResults = result.filter((f) => f.isBeta);

      expect(promotedResults.length).toBe(1);
      expect(promotedResults[0].attributeType).toBe('permanent_one');
      expect(betaResults.length).toBe(2);
      expect(betaResults.map((f) => f.attributeType)).toContain('novel_one');
      expect(betaResults.map((f) => f.attributeType)).toContain('discarded_one');

      // With includeBeta=false, novel/discarded are excluded entirely
      const resultNoBeta = service.selectFacets(attributes, false);
      expect(resultNoBeta.length).toBe(1);
      expect(resultNoBeta[0].attributeType).toBe('permanent_one');
    });

    it('treats approved tier as promoted', () => {
      const service = new FacetDisplayRulesService();

      const attributes: FacetCandidate[] = [
        makePromoted({ attributeType: 'permanent_one', tier: 'permanent' }),
        makePromoted({ attributeType: 'approved_one', tier: 'approved' }),
        makeBeta({ attributeType: 'beta_one', tier: 'experimental' }),
      ];

      const result = service.selectFacets(attributes, true);

      const promotedResults = result.filter((f) => !f.isBeta);
      expect(promotedResults.length).toBe(2);
      expect(promotedResults.map((f) => f.attributeType)).toContain('permanent_one');
      expect(promotedResults.map((f) => f.attributeType)).toContain('approved_one');
    });

    it('clamps maxBetaFacets when it exceeds maxVisibleFacets (prevents negative budget)', () => {
      // maxBetaFacets=10 > maxVisibleFacets=8 → should be clamped to 8
      const service = new FacetDisplayRulesService({ maxBetaFacets: 10 });

      const promoted = Array.from({ length: 5 }, (_, i) =>
        makePromoted({ attributeType: `p_${i}` }),
      );
      const betas = Array.from({ length: 10 }, (_, i) =>
        makeBeta({ attributeType: `b_${i}`, impressionCount: i }),
      );

      const result = service.selectFacets([...promoted, ...betas], true);

      // Total should never exceed maxVisibleFacets (8)
      expect(result.length).toBeLessThanOrEqual(8);
      // Should not produce negative promoted budget or broken slice
      const promotedResults = result.filter((f) => !f.isBeta);
      expect(promotedResults.length).toBeGreaterThanOrEqual(0);
    });

    it('promoted pool exceeds budget while beta is enabled — beta still gets slots', () => {
      const service = new FacetDisplayRulesService();

      // 10 promoted (budget=5), 5 beta — beta should still get 3
      const promoted = Array.from({ length: 10 }, (_, i) =>
        makePromoted({ attributeType: `p_${i}`, distinctValueCount: 100 - i }),
      );
      const betas = Array.from({ length: 5 }, (_, i) =>
        makeBeta({ attributeType: `b_${i}`, impressionCount: i }),
      );

      const result = service.selectFacets([...promoted, ...betas], true);

      const promotedResults = result.filter((f) => !f.isBeta);
      const betaResults = result.filter((f) => f.isBeta);

      // promotedBudget = 8 - 3 = 5, so 5 promoted
      expect(promotedResults.length).toBe(5);
      // remainingSlots = 8 - 5 = 3, beta capped at min(3, 3) = 3
      expect(betaResults.length).toBe(3);
      expect(result.length).toBe(8);
    });
  });
});
