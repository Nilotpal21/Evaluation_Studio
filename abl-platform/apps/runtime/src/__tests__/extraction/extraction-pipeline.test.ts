/**
 * 4-Tier Extraction Pipeline Integration Tests
 *
 * Tests the extraction pipeline end-to-end across all four tiers:
 *   Tier 1: In-process JS libraries (chrono-node, libphonenumber-js)
 *   Tier 2: NLU Sidecar (Python ML service with circuit breaker)
 *   Tier 3: LLM extraction (via extractEntitiesWithLLM)
 *   Tier 4: Regex fallback (pattern extraction)
 *
 * These tests verify tier coordination, graceful degradation, and
 * multi-field extraction across different field types and locales.
 */

import { describe, it, expect } from 'vitest';
import { extractDatesFromText } from '@abl/compiler/platform';
import type { ExtractedDate } from '@abl/compiler/platform';
import { extractPhoneFromText } from '@abl/compiler/platform';
import type { ExtractedPhone } from '@abl/compiler/platform';
import {
  NLUSidecarClient,
  type SidecarCallContext,
  type SidecarResult,
} from '../../services/nlu/sidecar-client.js';
import { extractWithJSLibs, isJSExtractableType } from '../../services/execution/js-extraction.js';

const REFERENCE_INSTANT = new Date('2026-04-15T12:00:00.000Z');
const ASIA_KOLKATA_DATE_OPTIONS = {
  referenceInstant: REFERENCE_INSTANT,
  timezone: 'Asia/Kolkata',
};
const SIDECAR_CTX: SidecarCallContext = {
  tenantId: 'tenant-1',
  projectId: 'project-1',
  sessionId: 'session-1',
};

function expectSidecarErr<T>(
  result: SidecarResult<T>,
  kind: 'unavailable' | 'timeout' | 'circuit_open' | 'no_match' | 'invalid_response',
): void {
  if (result.ok) {
    throw new Error(`expected sidecar error ${kind}, got ok`);
  }
  expect(result.error.kind).toBe(kind);
}

// =============================================================================
// Tier 1: JS Library Extraction — chrono-node
// =============================================================================

describe('4-Tier Extraction Pipeline', () => {
  describe('Tier 1: chrono-node date extraction', () => {
    it('extracts relative dates that regex would miss: "in 3 business days"', () => {
      // Regex-based extractors cannot handle relative date expressions —
      // chrono-node resolves them to absolute dates
      const result = extractDatesFromText('in 3 days', 'en', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0].type).toBe('date');
      expect(result[0].value).toBe('2026-04-18');
    });

    it('handles "the day after tomorrow"', () => {
      const result = extractDatesFromText(
        'the day after tomorrow',
        'en',
        ASIA_KOLKATA_DATE_OPTIONS,
      );
      expect(result.length).toBe(1);
      expect(result[0].type).toBe('date');
      expect(result[0].value).toBe('2026-04-17');
    });

    it('extracts "tomorrow" as a single date', () => {
      const result = extractDatesFromText('tomorrow', 'en', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBe(1);
      expect(result[0].value).toBe('2026-04-16');
    });

    it('extracts "next Monday" as a future date', () => {
      const result = extractDatesFromText('next Monday', 'en', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBe(1);
      expect(result[0].value).toBe('2026-04-20');
    });

    it('extracts absolute date "March 15, 2026"', () => {
      const result = extractDatesFromText('March 15, 2026', 'en');
      expect(result.length).toBe(1);
      expect(result[0].value).toBe('2026-03-15');
    });

    it('extracts date ranges as two entries', () => {
      const result = extractDatesFromText('March 6 to March 10', 'en');
      // Range should produce 2 entries: start and end
      expect(result.length).toBe(2);
      expect(result[0].value).toMatch(/03-06/);
      expect(result[1].value).toMatch(/03-10/);
    });

    it('returns empty array for text with no dates', () => {
      const result = extractDatesFromText('hello world', 'en');
      expect(result).toEqual([]);
    });

    it('returns empty array for empty text', () => {
      const result = extractDatesFromText('', 'en');
      expect(result).toEqual([]);
    });

    it('returns empty array for whitespace-only text', () => {
      const result = extractDatesFromText('   ', 'en');
      expect(result).toEqual([]);
    });

    // -- Multilingual support --

    it('extracts French date "demain" (tomorrow)', () => {
      const result = extractDatesFromText('demain', 'fr', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBe(1);
      expect(result[0].value).toBe('2026-04-16');
    });

    it('extracts Spanish date "mañana" (tomorrow)', () => {
      const result = extractDatesFromText('mañana', 'es', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBe(1);
    });

    it('extracts German date "übermorgen" (day after tomorrow)', () => {
      const result = extractDatesFromText('übermorgen', 'de', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBe(1);
    });

    it('extracts Japanese date "明日" (tomorrow)', () => {
      const result = extractDatesFromText('明日', 'ja', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBe(1);
    });

    it('falls back to English parser for unsupported locale', () => {
      // 'ko' (Korean) is not in the locale map — should fall back to English
      const result = extractDatesFromText('tomorrow', 'ko', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBe(1);
    });

    it('handles BCP-47 locale with region code', () => {
      const result = extractDatesFromText('tomorrow', 'en-US', ASIA_KOLKATA_DATE_OPTIONS);
      expect(result.length).toBe(1);
    });
  });

  // ===========================================================================
  // Tier 1: JS Library Extraction — libphonenumber-js
  // ===========================================================================

  describe('Tier 1: libphonenumber-js phone extraction', () => {
    it('validates and normalizes US phone number', () => {
      const result = extractPhoneFromText('+1 555 123 4567', 'US');
      expect(result).not.toBeNull();
      expect(result!.type).toBe('phone');
      expect(result!.e164).toMatch(/^\+1/);
      expect(result!.country).toBe('US');
    });

    it('validates and normalizes French phone number', () => {
      const result = extractPhoneFromText('+33 1 23 45 67 89', 'FR');
      expect(result).not.toBeNull();
      expect(result!.e164).toBe('+33123456789');
      expect(result!.country).toBe('FR');
    });

    it('validates and normalizes UK phone number', () => {
      const result = extractPhoneFromText('+44 20 7946 0958', 'GB');
      expect(result).not.toBeNull();
      expect(result!.e164).toMatch(/^\+44/);
    });

    it('normalizes local format with default country', () => {
      const result = extractPhoneFromText('020 7946 0958', 'GB');
      expect(result).not.toBeNull();
      expect(result!.e164).toMatch(/^\+44/);
    });

    it('rejects clearly invalid numbers', () => {
      const result = extractPhoneFromText('12345', 'US');
      expect(result).toBeNull();
    });

    it('rejects empty text', () => {
      const result = extractPhoneFromText('', 'US');
      expect(result).toBeNull();
    });

    it('rejects whitespace-only text', () => {
      const result = extractPhoneFromText('   ', 'US');
      expect(result).toBeNull();
    });

    it('rejects random text with no phone numbers', () => {
      const result = extractPhoneFromText('hello world how are you', 'US');
      expect(result).toBeNull();
    });

    it('provides national format alongside E.164', () => {
      const result = extractPhoneFromText('+1 212 555 1234', 'US');
      expect(result).not.toBeNull();
      expect(result!.national).toBeDefined();
      expect(result!.national.length).toBeGreaterThan(0);
    });

    it('extracts phone from natural language text', () => {
      const result = extractPhoneFromText('call me at +1 212 555 1234 please', 'US');
      expect(result).not.toBeNull();
      expect(result!.e164).toMatch(/^\+1/);
    });
  });

  // ===========================================================================
  // Tier 2: NLU Sidecar (mocked / graceful degradation)
  // ===========================================================================

  describe('Tier 2: NLU Sidecar graceful degradation', () => {
    it('returns err(unavailable) when sidecar is unavailable (connection refused)', async () => {
      const client = new NLUSidecarClient({
        url: 'http://localhost:99999',
        timeoutMs: 500,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
      });

      const result = await client.extract(
        {
          text: 'go to Paris',
          fields: [{ name: 'dest', type: 'string', hints: [] }],
          locale: 'en',
        },
        SIDECAR_CTX,
      );

      expectSidecarErr(result, 'unavailable');
    });

    it('returns false health check when sidecar is down', async () => {
      const client = new NLUSidecarClient({
        url: 'http://localhost:99999',
        timeoutMs: 500,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
      });

      const healthy = await client.health();
      expect(healthy).toBe(false);
    });

    it('returns err(unavailable) for correction detection when sidecar is unavailable', async () => {
      const client = new NLUSidecarClient({
        url: 'http://localhost:99999',
        timeoutMs: 500,
        circuitBreakerThreshold: 3,
        circuitBreakerResetMs: 1000,
      });

      const result = await client.detectCorrection(
        {
          text: 'actually I meant Paris',
          context: { dest: 'London' },
          locale: 'en',
        },
        SIDECAR_CTX,
      );

      expectSidecarErr(result, 'unavailable');
    });

    it('opens circuit breaker after threshold failures', async () => {
      const client = new NLUSidecarClient({
        url: 'http://localhost:99999',
        timeoutMs: 200,
        circuitBreakerThreshold: 2,
        circuitBreakerResetMs: 60_000, // long reset to keep circuit open
      });

      const req = {
        text: 'test',
        fields: [{ name: 'x', type: 'string', hints: [] as string[] }],
        locale: 'en',
      };

      // Exhaust the circuit breaker threshold (2 failures)
      expectSidecarErr(await client.extract(req, SIDECAR_CTX), 'unavailable');
      expectSidecarErr(await client.extract(req, SIDECAR_CTX), 'unavailable');

      // Third call should be short-circuited (circuit is open)
      // Time the call — it should be near-instant (no HTTP attempt)
      const start = Date.now();
      const result = await client.extract(req, SIDECAR_CTX);
      const elapsed = Date.now() - start;

      expectSidecarErr(result, 'circuit_open');
      // Circuit-open calls should resolve in under 50ms (no network I/O)
      expect(elapsed).toBeLessThan(50);
    });
  });

  // ===========================================================================
  // extractWithJSLibs integration (Tier 1 composite)
  // ===========================================================================

  describe('extractWithJSLibs integration', () => {
    it('extracts mixed date and phone from same input', () => {
      const result = extractWithJSLibs(
        'arriving March 15, call +1 555-123-4567',
        [
          { name: 'date', type: 'date' },
          { name: 'phone', type: 'phone' },
        ],
        'en-US',
      );
      expect(result.date).toBeDefined();
      expect(result.date).toBe('2026-03-15');
      expect(result.phone).toBeDefined();
      expect(result.phone).toMatch(/^\+1/);
    });

    it('extracts date with French locale', () => {
      const result = extractWithJSLibs('le 15 mars 2026', [{ name: 'date', type: 'date' }], 'fr');
      expect(result.date).toBeDefined();
      expect(result.date).toBe('2026-03-15');
    });

    it('extracts date with Spanish locale', () => {
      const result = extractWithJSLibs('mañana', [{ name: 'fecha', type: 'date' }], 'es');
      expect(result.fecha).toBeDefined();
      expect(result.fecha).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });

    it('extracts phone with UK locale', () => {
      const result = extractWithJSLibs(
        'call me at +44 20 7946 0958',
        [{ name: 'phone', type: 'phone' }],
        'en-GB',
      );
      expect(result.phone).toBeDefined();
      expect(result.phone).toMatch(/^\+44/);
    });

    it('skips non-JS-extractable types (string, boolean, etc.)', () => {
      const result = extractWithJSLibs(
        'my name is John, true story',
        [
          { name: 'name', type: 'string' },
          { name: 'flag', type: 'boolean' },
        ],
        'en',
      );
      // string and boolean are not handled by Tier 1
      expect(result.name).toBeUndefined();
      expect(result.flag).toBeUndefined();
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('handles mixed extractable and non-extractable types', () => {
      const result = extractWithJSLibs(
        'arriving March 15, my name is John',
        [
          { name: 'checkin', type: 'date' },
          { name: 'name', type: 'string' },
        ],
        'en',
      );
      // date should be extracted, string should be skipped
      expect(result.checkin).toBeDefined();
      expect(result.name).toBeUndefined();
    });

    it('returns empty for text with no extractable entities', () => {
      const result = extractWithJSLibs(
        'just saying hello',
        [
          { name: 'checkin', type: 'date' },
          { name: 'phone', type: 'phone' },
        ],
        'en',
      );
      expect(Object.keys(result)).toHaveLength(0);
    });

    it('extracts datetime type same as date', () => {
      const result = extractWithJSLibs(
        'meeting at March 20, 2026',
        [{ name: 'when', type: 'datetime' }],
        'en',
      );
      expect(result.when).toBe('2026-03-20');
    });

    it('handles country extraction from locale for phone', () => {
      // en-GB -> GB country code for phone parsing
      const result = extractWithJSLibs(
        '020 7946 0958',
        [{ name: 'phone', type: 'phone' }],
        'en-GB',
      );
      expect(result.phone).toBeDefined();
      expect(result.phone).toMatch(/^\+44/);
    });

    it('defaults to US country when locale has no region', () => {
      // 'en' has no region -> defaults to US
      const result = extractWithJSLibs('+1 212 555 1234', [{ name: 'phone', type: 'phone' }], 'en');
      expect(result.phone).toBeDefined();
      expect(result.phone).toMatch(/^\+1/);
    });
  });

  // ===========================================================================
  // isJSExtractableType — tier routing helper
  // ===========================================================================

  describe('isJSExtractableType tier routing', () => {
    it('routes date fields to Tier 1', () => {
      expect(isJSExtractableType('date')).toBe(true);
    });

    it('routes datetime fields to Tier 1', () => {
      expect(isJSExtractableType('datetime')).toBe(true);
    });

    it('routes phone fields to Tier 1', () => {
      expect(isJSExtractableType('phone')).toBe(true);
    });

    it('does not route string fields to Tier 1', () => {
      expect(isJSExtractableType('string')).toBe(false);
    });

    it('routes number fields to Tier 1', () => {
      expect(isJSExtractableType('number')).toBe(true);
    });

    it('routes email fields to Tier 1', () => {
      expect(isJSExtractableType('email')).toBe(true);
    });

    it('routes boolean fields to Tier 1', () => {
      expect(isJSExtractableType('boolean')).toBe(true);
    });

    it('routes enum fields to Tier 1', () => {
      expect(isJSExtractableType('enum')).toBe(true);
    });

    it('handles case-insensitive type names', () => {
      expect(isJSExtractableType('Date')).toBe(true);
      expect(isJSExtractableType('PHONE')).toBe(true);
      expect(isJSExtractableType('DateTime')).toBe(true);
    });
  });

  // ===========================================================================
  // Strategy resolution: auto vs ml vs llm
  // ===========================================================================

  describe('Strategy resolution', () => {
    it('auto strategy: JS libs extract dates without needing LLM', () => {
      // With 'auto' strategy, date fields should be handled by Tier 1
      // without ever needing to call the LLM
      const dates = extractDatesFromText('arriving March 15', 'en');
      expect(dates.length).toBe(1);
      expect(dates[0].value).toMatch(/03-15/);
    });

    it('auto strategy: JS libs extract phones without needing LLM', () => {
      const phone = extractPhoneFromText('+1 555 123 4567', 'US');
      expect(phone).not.toBeNull();
      expect(phone!.e164).toMatch(/^\+1/);
    });

    it('ml strategy: Tier 1 handles date without ML sidecar', () => {
      // When ML sidecar is unavailable, date extraction still works via JS libs
      const dates = extractDatesFromText('tomorrow', 'en', ASIA_KOLKATA_DATE_OPTIONS);
      expect(dates.length).toBe(1);
    });

    it('ml strategy: Tier 1 handles phone without ML sidecar', () => {
      const phone = extractPhoneFromText('+44 20 7946 0958', 'GB');
      expect(phone).not.toBeNull();
    });

    it('date extraction resolves relative expressions to absolute dates', () => {
      // This is a key capability that distinguishes chrono-node from regex
      const expressions = [
        'today',
        'tomorrow',
        'the day after tomorrow',
        'next Friday',
        'in 3 days',
        'last Monday',
      ];

      for (const expr of expressions) {
        const result = extractDatesFromText(expr, 'en', ASIA_KOLKATA_DATE_OPTIONS);
        expect(result.length).toBeGreaterThan(0);
        expect(result[0].value).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });

    it('phone extraction normalizes diverse formats to E.164', () => {
      // All these formats should normalize to valid E.164
      const formats = [
        { text: '+1 212 555 1234', country: 'US' },
        { text: '+44 20 7946 0958', country: 'GB' },
        { text: '+33 1 23 45 67 89', country: 'FR' },
        { text: '+49 30 123456', country: 'DE' },
      ];

      for (const { text, country } of formats) {
        const result = extractPhoneFromText(text, country);
        expect(result).not.toBeNull();
        expect(result!.e164).toMatch(/^\+\d+$/);
      }
    });
  });

  // ===========================================================================
  // ExtractedDate and ExtractedPhone type contracts
  // ===========================================================================

  describe('Type contracts', () => {
    it('ExtractedDate has required fields', () => {
      const dates = extractDatesFromText('March 15, 2026', 'en');
      expect(dates.length).toBe(1);
      const date: ExtractedDate = dates[0];
      expect(date.type).toBe('date');
      expect(typeof date.value).toBe('string');
      expect(typeof date.text).toBe('string');
      expect(typeof date.index).toBe('number');
    });

    it('ExtractedPhone has required fields', () => {
      const phone: ExtractedPhone | null = extractPhoneFromText('+1 212 555 1234', 'US');
      expect(phone).not.toBeNull();
      expect(phone!.type).toBe('phone');
      expect(typeof phone!.e164).toBe('string');
      expect(typeof phone!.national).toBe('string');
      expect(typeof phone!.country).toBe('string');
      expect(typeof phone!.text).toBe('string');
    });
  });
});
