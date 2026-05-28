import { describe, it, expect, vi } from 'vitest';
import { convertValue } from '@abl/compiler/platform';
import { resolveLookup, resolveInlineLookup } from '../services/execution/lookup-resolver.js';
import { parseInferenceResponse, applyInferences } from '../services/execution/field-inference.js';
import { CurrencyRateClient } from '../services/nlu/currency-rate-client.js';
import type { LookupTableIR } from '@abl/compiler/platform';

describe('Phase 3 error paths', () => {
  describe('Conversion errors', () => {
    it('throws for cross-category conversion', () => {
      expect(() => convertValue(1, 'celsius', 'kg')).toThrow('Unsupported conversion');
    });

    it('throws for unknown unit', () => {
      expect(() => convertValue(1, 'banana', 'apple')).toThrow('Unsupported conversion');
    });

    it('handles NaN input', () => {
      const result = convertValue(NaN, 'celsius', 'fahrenheit');
      expect(isNaN(result)).toBe(true);
    });

    it('handles Infinity input', () => {
      const result = convertValue(Infinity, 'km', 'miles');
      expect(result).toBe(Infinity);
    });
  });

  describe('Lookup errors', () => {
    it('returns not-found for collection without connection', async () => {
      const table: LookupTableIR = {
        name: 'hotels',
        source: 'collection',
        table_name: 'lookup_hotels',
        field: 'name',
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      };
      const result = await resolveLookup('Hilton', table, {});
      expect(result.found).toBe(false);
      expect(result.error).toContain('Collection lookup requires tenant and project context');
    });

    it('returns not-found for api without endpoint', async () => {
      const table: LookupTableIR = {
        name: 'products',
        source: 'api',
        endpoint: undefined,
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      };
      const result = await resolveLookup('Widget', table, {});
      expect(result.found).toBe(false);
      expect(result.error).toContain('API lookup requires endpoint');
    });

    it('returns not-found for api fetch failure', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('Network timeout'));
      const table: LookupTableIR = {
        name: 'products',
        source: 'api',
        endpoint: 'https://api.example.com/lookup',
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      };
      const result = await resolveLookup('Widget', table, { fetchFn: mockFetch });
      expect(result.found).toBe(false);
      expect(result.error).toBe('API lookup failed');
    });

    it('handles unknown source type', async () => {
      const table = {
        name: 'test',
        source: 'redis' as 'inline',
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      };
      const result = await resolveLookup('test', table, {});
      expect(result.found).toBe(false);
      expect(result.error).toContain('Unknown lookup source');
    });

    it('returns not-found for inline lookup with empty values', () => {
      const table: LookupTableIR = {
        name: 'colors',
        source: 'inline',
        values: [],
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      };
      const result = resolveInlineLookup('red', table);
      expect(result.found).toBe(false);
    });

    it('returns not-found for inline lookup with no values property', () => {
      const table: LookupTableIR = {
        name: 'colors',
        source: 'inline',
        case_sensitive: false,
        fuzzy_match: false,
        fuzzy_threshold: 0.85,
      };
      const result = resolveInlineLookup('red', table);
      expect(result.found).toBe(false);
    });
  });

  describe('Inference errors', () => {
    it('handles malformed LLM response (not an object)', () => {
      const result = parseInferenceResponse('not json', 0.8);
      expect(result).toHaveLength(0);
    });

    it('handles LLM response with missing inferences field', () => {
      const result = parseInferenceResponse({ wrong_key: [] }, 0.8);
      expect(result).toHaveLength(0);
    });

    it('handles null LLM response', () => {
      const result = parseInferenceResponse(null, 0.8);
      expect(result).toHaveLength(0);
    });

    it('handles undefined LLM response', () => {
      const result = parseInferenceResponse(undefined, 0.8);
      expect(result).toHaveLength(0);
    });

    it('applyInferences with all rejected inferences produces no changes', () => {
      const results = parseInferenceResponse(
        {
          inferences: [
            { field: 'a', value: 'x', confidence: 0.3, reasoning: 'guess' },
            { field: 'b', value: 'y', confidence: 0.1, reasoning: 'wild guess' },
          ],
        },
        0.8,
      );
      const values: Record<string, unknown> = {};
      const { applied, confirmationMessage } = applyInferences(results, values, true);
      expect(Object.keys(applied)).toHaveLength(0);
      expect(confirmationMessage).toBeNull();
      expect(values._inferred).toBeUndefined();
    });

    it('handles inferences array with non-numeric confidence', () => {
      const result = parseInferenceResponse(
        {
          inferences: [
            { field: 'a', value: 'x', confidence: 'high' as unknown as number, reasoning: 'test' },
          ],
        },
        0.8,
      );
      // 'high' >= 0.8 is false (NaN comparison), so accepted should be false
      expect(result).toHaveLength(1);
      expect(result[0].accepted).toBe(false);
    });
  });

  describe('CurrencyRateClient error paths', () => {
    it('falls back to static rate on API error', async () => {
      const mockFetch = vi.fn().mockRejectedValue(new Error('503 Service Unavailable'));
      const client = new CurrencyRateClient({
        apiUrl: 'https://api.example.com/rates',
        cacheTtlMs: 60_000,
        fetchFn: mockFetch,
      });
      const rate = await client.getRate('USD', 'EUR');
      expect(rate).toBeGreaterThan(0);
      expect(typeof rate).toBe('number');
    });

    it('falls back to static rate on non-OK HTTP response', async () => {
      const mockFetch = vi.fn().mockResolvedValue({ ok: false, status: 429 });
      const client = new CurrencyRateClient({
        apiUrl: 'https://api.example.com/rates',
        cacheTtlMs: 60_000,
        fetchFn: mockFetch,
      });
      const rate = await client.getRate('USD', 'GBP');
      expect(rate).toBeGreaterThan(0);
    });

    it('handles unknown currency codes with fallback', async () => {
      const client = new CurrencyRateClient({
        apiUrl: 'https://api.example.com/rates',
        cacheTtlMs: 60_000,
        fetchFn: vi.fn().mockRejectedValue(new Error('fail')),
      });
      const rate = await client.getRate('XYZ', 'ABC');
      expect(typeof rate).toBe('number');
    });

    it('returns 1 when from and to currency are the same', async () => {
      const client = new CurrencyRateClient({
        apiUrl: 'https://api.example.com/rates',
        cacheTtlMs: 60_000,
        fetchFn: vi.fn().mockRejectedValue(new Error('fail')),
      });
      const rate = await client.getRate('USD', 'USD');
      expect(rate).toBe(1);
    });
  });
});
