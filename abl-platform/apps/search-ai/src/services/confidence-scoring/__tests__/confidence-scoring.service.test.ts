/**
 * ConfidenceScoringService Unit Tests
 *
 * Tests confidence-based auto-apply logic:
 *   - >= 0.8 -> status 'active', reviewedBy 'system'
 *   - 0.5 to 0.79 -> status 'suggested', reviewedBy null
 *   - < 0.5 -> filtered out, not stored
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';

// ─── Mocks (must be before imports) ───────────────────────────────────────────

const { mockInsertMany } = vi.hoisted(() => ({
  mockInsertMany: vi.fn(),
}));

vi.mock('../../../db/index.js', () => ({
  getLazyModel: vi.fn(() => ({
    insertMany: mockInsertMany,
  })),
}));

vi.mock('@abl/compiler/platform', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  })),
}));

// ─── Imports (after mocks) ────────────────────────────────────────────────────

import {
  ConfidenceScoringService,
  AUTO_APPLY_THRESHOLD,
  MINIMUM_THRESHOLD,
} from '../confidence-scoring.service.js';
import type { MappingSuggestion } from '../../mapping-suggestion/mapping-suggestion.service.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeSuggestion(overrides: Partial<MappingSuggestion> = {}): MappingSuggestion {
  return {
    canonicalField: 'title',
    sourcePath: 'summary',
    transform: { type: 'direct' },
    confidence: 0.9,
    reasoning: 'Test mapping',
    ...overrides,
  };
}

const baseInput = {
  tenantId: 'tenant-1',
  canonicalSchemaId: 'schema-1',
  connectorId: 'connector-1',
  suggestedBy: 'llm' as const,
};

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('ConfidenceScoringService', () => {
  let service: ConfidenceScoringService;

  beforeEach(() => {
    vi.clearAllMocks();
    service = new ConfidenceScoringService();
    // Default mock: return the input documents with an _id added
    mockInsertMany.mockImplementation((docs: any[]) =>
      Promise.resolve(docs.map((d: any, i: number) => ({ _id: `mapping-${i}`, ...d }))),
    );
  });

  // ─── Threshold Constants ──────────────────────────────────────────────────

  describe('threshold constants', () => {
    it('AUTO_APPLY_THRESHOLD should be 0.8', () => {
      expect(AUTO_APPLY_THRESHOLD).toBe(0.8);
    });

    it('MINIMUM_THRESHOLD should be 0.5', () => {
      expect(MINIMUM_THRESHOLD).toBe(0.5);
    });
  });

  // ─── classifySuggestions ──────────────────────────────────────────────────

  describe('classifySuggestions', () => {
    it('classifies >= 0.8 as autoApply', () => {
      const suggestions = [makeSuggestion({ confidence: 0.9 })];
      const result = service.classifySuggestions(suggestions);
      expect(result.autoApply).toHaveLength(1);
      expect(result.pendingReview).toHaveLength(0);
      expect(result.filtered).toHaveLength(0);
    });

    it('classifies 0.5-0.79 as pendingReview', () => {
      const suggestions = [makeSuggestion({ confidence: 0.65 })];
      const result = service.classifySuggestions(suggestions);
      expect(result.autoApply).toHaveLength(0);
      expect(result.pendingReview).toHaveLength(1);
      expect(result.filtered).toHaveLength(0);
    });

    it('classifies < 0.5 as filtered', () => {
      const suggestions = [makeSuggestion({ confidence: 0.3 })];
      const result = service.classifySuggestions(suggestions);
      expect(result.autoApply).toHaveLength(0);
      expect(result.pendingReview).toHaveLength(0);
      expect(result.filtered).toHaveLength(1);
    });

    it('handles boundary: exactly 0.8 -> autoApply', () => {
      const suggestions = [makeSuggestion({ confidence: 0.8 })];
      const result = service.classifySuggestions(suggestions);
      expect(result.autoApply).toHaveLength(1);
    });

    it('handles boundary: exactly 0.5 -> pendingReview', () => {
      const suggestions = [makeSuggestion({ confidence: 0.5 })];
      const result = service.classifySuggestions(suggestions);
      expect(result.pendingReview).toHaveLength(1);
    });

    it('handles boundary: exactly 0.499 -> filtered', () => {
      const suggestions = [makeSuggestion({ confidence: 0.499 })];
      const result = service.classifySuggestions(suggestions);
      expect(result.filtered).toHaveLength(1);
    });

    it('classifies mixed confidence array correctly', () => {
      const suggestions = [
        makeSuggestion({ confidence: 0.95, canonicalField: 'title' }),
        makeSuggestion({ confidence: 0.85, canonicalField: 'description' }),
        makeSuggestion({ confidence: 0.7, canonicalField: 'status' }),
        makeSuggestion({ confidence: 0.55, canonicalField: 'priority' }),
        makeSuggestion({ confidence: 0.4, canonicalField: 'custom_1' }),
        makeSuggestion({ confidence: 0.1, canonicalField: 'custom_2' }),
      ];
      const result = service.classifySuggestions(suggestions);
      expect(result.autoApply).toHaveLength(2);
      expect(result.pendingReview).toHaveLength(2);
      expect(result.filtered).toHaveLength(2);
    });
  });

  // ─── processSuggestions ───────────────────────────────────────────────────

  describe('processSuggestions', () => {
    it('returns empty result for empty suggestions', async () => {
      const result = await service.processSuggestions({
        ...baseInput,
        suggestions: [],
      });
      expect(result.autoApplied).toHaveLength(0);
      expect(result.pending).toHaveLength(0);
      expect(result.filteredCount).toBe(0);
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('auto-applies high confidence (>= 0.8) with status active and reviewedBy system', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.9 })];
      const result = await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      expect(result.autoApplied).toHaveLength(1);
      expect(result.pending).toHaveLength(0);
      expect(result.filteredCount).toBe(0);

      // Verify the document shape passed to insertMany
      const insertCall = mockInsertMany.mock.calls[0][0];
      expect(insertCall[0]).toMatchObject({
        tenantId: 'tenant-1',
        canonicalSchemaId: 'schema-1',
        connectorId: 'connector-1',
        canonicalField: 'title',
        sourcePath: 'summary',
        transform: { type: 'direct' },
        confidence: 0.9,
        status: 'active',
        suggestedBy: 'llm',
        reviewedBy: 'system',
      });
      expect(insertCall[0].reviewedAt).toBeInstanceOf(Date);
    });

    it('marks medium confidence (0.5-0.79) as suggested with null reviewedBy', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.65 })];
      const result = await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      expect(result.autoApplied).toHaveLength(0);
      expect(result.pending).toHaveLength(1);
      expect(result.filteredCount).toBe(0);

      const insertCall = mockInsertMany.mock.calls[0][0];
      expect(insertCall[0]).toMatchObject({
        status: 'suggested',
        reviewedBy: null,
        reviewedAt: null,
      });
    });

    it('filters out low confidence (< 0.5) without storing', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.3 })];
      const result = await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      expect(result.autoApplied).toHaveLength(0);
      expect(result.pending).toHaveLength(0);
      expect(result.filteredCount).toBe(1);
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('handles mixed confidence array with correct bucketing', async () => {
      const suggestions = [
        makeSuggestion({ confidence: 0.95, canonicalField: 'title', sourcePath: 'summary' }),
        makeSuggestion({ confidence: 0.65, canonicalField: 'status', sourcePath: 'state' }),
        makeSuggestion({ confidence: 0.3, canonicalField: 'custom_1', sourcePath: 'extra' }),
      ];

      const result = await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      expect(result.autoApplied).toHaveLength(1);
      expect(result.pending).toHaveLength(1);
      expect(result.filteredCount).toBe(1);

      // Two insertMany calls: one for auto-applied, one for pending
      expect(mockInsertMany).toHaveBeenCalledTimes(2);
    });

    it('preserves suggestedBy=rules for rule-based mappings', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.9 })];
      await service.processSuggestions({
        ...baseInput,
        suggestedBy: 'rules',
        suggestions,
      });

      const insertCall = mockInsertMany.mock.calls[0][0];
      expect(insertCall[0].suggestedBy).toBe('rules');
    });

    it('preserves suggestedBy=llm for LLM-generated mappings', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.9 })];
      await service.processSuggestions({
        ...baseInput,
        suggestedBy: 'llm',
        suggestions,
      });

      const insertCall = mockInsertMany.mock.calls[0][0];
      expect(insertCall[0].suggestedBy).toBe('llm');
    });

    it('uses correct field names: sourcePath not sourceField', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.9, sourcePath: 'my.nested.path' })];
      await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      const insertCall = mockInsertMany.mock.calls[0][0];
      expect(insertCall[0].sourcePath).toBe('my.nested.path');
      expect(insertCall[0]).not.toHaveProperty('sourceField');
    });

    it('maps transform from suggestion to FieldMapping document', async () => {
      const suggestions = [
        makeSuggestion({
          confidence: 0.9,
          transform: {
            type: 'value_map',
            valueMap: { open: 'active', closed: 'resolved' },
          },
        }),
      ];
      await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      const insertCall = mockInsertMany.mock.calls[0][0];
      expect(insertCall[0].transform).toEqual({
        type: 'value_map',
        valueMap: { open: 'active', closed: 'resolved' },
      });
    });

    it('re-throws error if insertMany fails', async () => {
      mockInsertMany.mockRejectedValueOnce(new Error('MongoDB connection lost'));

      const suggestions = [makeSuggestion({ confidence: 0.9 })];
      await expect(service.processSuggestions({ ...baseInput, suggestions })).rejects.toThrow(
        'MongoDB connection lost',
      );
    });

    it('handles boundary: exactly 0.8 -> auto-applied', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.8 })];
      const result = await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      expect(result.autoApplied).toHaveLength(1);
      expect(result.pending).toHaveLength(0);

      const insertCall = mockInsertMany.mock.calls[0][0];
      expect(insertCall[0].status).toBe('active');
    });

    it('handles boundary: exactly 0.5 -> pending', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.5 })];
      const result = await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      expect(result.autoApplied).toHaveLength(0);
      expect(result.pending).toHaveLength(1);

      const insertCall = mockInsertMany.mock.calls[0][0];
      expect(insertCall[0].status).toBe('suggested');
    });

    it('handles boundary: exactly 0.499 -> filtered', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.499 })];
      const result = await service.processSuggestions({
        ...baseInput,
        suggestions,
      });

      expect(result.autoApplied).toHaveLength(0);
      expect(result.pending).toHaveLength(0);
      expect(result.filteredCount).toBe(1);
      expect(mockInsertMany).not.toHaveBeenCalled();
    });

    it('includes all required FieldMapping fields in created documents', async () => {
      const suggestions = [makeSuggestion({ confidence: 0.85 })];
      await service.processSuggestions({ ...baseInput, suggestions });

      const insertCall = mockInsertMany.mock.calls[0][0];
      const doc = insertCall[0];

      // Verify all required fields are present
      expect(doc).toHaveProperty('tenantId');
      expect(doc).toHaveProperty('canonicalSchemaId');
      expect(doc).toHaveProperty('canonicalField');
      expect(doc).toHaveProperty('connectorId');
      expect(doc).toHaveProperty('sourcePath');
      expect(doc).toHaveProperty('transform');
      expect(doc).toHaveProperty('confidence');
      expect(doc).toHaveProperty('status');
      expect(doc).toHaveProperty('suggestedBy');
      expect(doc).toHaveProperty('reviewedBy');
      expect(doc).toHaveProperty('reviewedAt');
    });
  });
});
