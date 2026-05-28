/**
 * Phase 3 Integration Tests
 *
 * Exercises the full Phase 3 NLU robustness pipeline end-to-end:
 *   - Unit conversion (convert_to)
 *   - Lookup table resolution (inline, fuzzy)
 *   - Field inference (shouldAttempt, prompt, parse, apply)
 *   - Semantic hints (buildSemanticHint with new features)
 */

import { describe, it, expect, vi } from 'vitest';

vi.mock('@abl/compiler/platform', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@abl/compiler/platform')>();
  return {
    ...actual,
    createLogger: () => ({
      info: vi.fn(),
      debug: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    }),
  };
});

import { convertValue, isConversionSupported, buildSemanticHint } from '@abl/compiler/platform';
import type { LookupTableIR } from '@abl/compiler/platform/ir/schema.js';
import { resolveInlineLookup, fuzzyMatch } from '../services/execution/lookup-resolver.js';
import {
  shouldAttemptInference,
  buildInferencePrompt,
  parseInferenceResponse,
  applyInferences,
} from '../services/execution/field-inference.js';

describe('Phase 3: Stubbed Feature Integration', () => {
  describe('End-to-end: Extract -> Validate -> Lookup -> Convert -> Infer -> Store', () => {
    it('full pipeline: temperature conversion with original preservation', () => {
      const extracted = { temperature: 72, destination: 'Paris' };
      const converted = convertValue(extracted.temperature, 'fahrenheit', 'celsius');
      const original = extracted.temperature;
      const values: Record<string, unknown> = {
        ...extracted,
        temperature: converted,
        _original: { temperature: original },
      };
      expect(values.temperature).toBeCloseTo(22.22, 1);
      expect((values._original as Record<string, unknown>).temperature).toBe(72);
      expect(values.destination).toBe('Paris');
    });

    it('full pipeline: airport code lookup + normalization', () => {
      const table: LookupTableIR = {
        name: 'iata_codes',
        source: 'inline',
        values: ['LAX', 'JFK', 'CDG', 'LHR'],
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      };
      const result = resolveInlineLookup('lax', table);
      expect(result.found).toBe(true);
      expect(result.matched_value).toBe('LAX');
    });

    it('full pipeline: inference fills missing field from context', () => {
      const fields = [
        {
          name: 'hotel_class',
          type: 'string',
          infer: true,
          validation: {
            type: 'enum' as const,
            rule: 'budget|standard|premium|luxury',
            error_message: '',
          },
        },
      ];
      const context = { destination: 'Paris', guests: 2, check_in: '2026-03-15' };
      expect(shouldAttemptInference(fields[0], context)).toBe(true);
      const prompt = buildInferencePrompt(fields, context);
      expect(prompt).toContain('hotel_class');
      expect(prompt).toContain('Paris');
      const parsed = parseInferenceResponse(
        {
          inferences: [
            {
              field: 'hotel_class',
              value: 'standard',
              confidence: 0.85,
              reasoning: 'Leisure trip default',
            },
          ],
        },
        0.8,
      );
      expect(parsed[0].accepted).toBe(true);
      const values: Record<string, unknown> = { ...context };
      const { applied, confirmationMessage } = applyInferences(parsed, values, true);
      expect(applied.hotel_class).toBe('standard');
      expect(values._inferred).toBeDefined();
      expect(confirmationMessage).toContain('standard');
    });
  });

  describe('Semantic hints include new features', () => {
    it('conversion hint in extraction prompt', () => {
      const hint = buildSemanticHint({
        semantics: { unit: 'fahrenheit', convert_to: 'celsius' },
      });
      expect(hint).toContain('fahrenheit');
      expect(hint).toContain('convert to: celsius');
    });

    it('lookup hint in extraction prompt', () => {
      const hint = buildSemanticHint({
        semantics: { format: 'airport_code', lookup: 'iata_codes' },
      });
      expect(hint).toContain('IATA airport code');
      expect(hint).toContain('valid values from: iata_codes');
    });
  });

  describe('Conversion edge cases', () => {
    it('currency static conversion', () => {
      const result = convertValue(100, 'USD', 'EUR');
      expect(result).toBeGreaterThan(0);
      expect(result).toBeLessThan(200);
    });

    it('unsupported cross-category conversion throws', () => {
      expect(() => convertValue(1, 'celsius', 'km')).toThrow('Unsupported conversion');
    });

    it('all temperature conversions are reversible', () => {
      const original = 100;
      const toF = convertValue(original, 'celsius', 'fahrenheit');
      const backToC = convertValue(toF, 'fahrenheit', 'celsius');
      expect(backToC).toBeCloseTo(original, 5);
    });
  });

  describe('Lookup edge cases', () => {
    it('fuzzy matching with close misspelling', () => {
      const match = fuzzyMatch('Chicgo', ['Chicago', 'New York', 'Houston'], 0.7);
      expect(match).not.toBeNull();
      expect(match!.value).toBe('Chicago');
    });

    it('fuzzy matching rejects distant strings', () => {
      const match = fuzzyMatch('xyz', ['Chicago', 'New York', 'Houston'], 0.7);
      expect(match).toBeNull();
    });
  });

  describe('Inference edge cases', () => {
    it('does not infer already-collected fields', () => {
      const field = { name: 'hotel_class', type: 'string', infer: true };
      const collected = { hotel_class: 'luxury' };
      expect(shouldAttemptInference(field, collected)).toBe(false);
    });

    it('does not infer fields without infer flag', () => {
      const field = { name: 'hotel_class', type: 'string' };
      expect(shouldAttemptInference(field, {})).toBe(false);
    });

    it('rejects low-confidence inferences', () => {
      const parsed = parseInferenceResponse(
        {
          inferences: [{ field: 'x', value: 'y', confidence: 0.3, reasoning: 'wild guess' }],
        },
        0.8,
      );
      expect(parsed[0].accepted).toBe(false);
      const values: Record<string, unknown> = {};
      const { applied } = applyInferences(parsed, values, false);
      expect(Object.keys(applied)).toHaveLength(0);
    });
  });
});
