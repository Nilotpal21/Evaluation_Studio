/**
 * Classify Plan Tests
 *
 * Tests for KB fast-path classify utilities:
 * - parseClassifyPlan: JSON parsing, fence handling, plain-text fallback
 * - buildSimpleClassifyPrompt: agent identity injection
 * - classifyKBComplexity: tier classification
 */

import { describe, test, expect } from 'vitest';
import {
  parseClassifyPlan,
  buildSimpleClassifyPrompt,
  classifyKBComplexity,
} from '../description-builder.js';

// =============================================================================
// parseClassifyPlan
// =============================================================================

describe('parseClassifyPlan', () => {
  test('parses valid SEARCH JSON', () => {
    const plan = parseClassifyPlan('{"action":"SEARCH","query":"test query","queryType":"hybrid"}');
    expect(plan?.action).toBe('SEARCH');
    expect(plan?.query).toBe('test query');
    expect(plan?.queryType).toBe('hybrid');
  });

  test('parses valid DIRECT JSON', () => {
    const plan = parseClassifyPlan('{"action":"DIRECT","response":"Hello! How can I help?"}');
    expect(plan?.action).toBe('DIRECT');
    expect(plan?.response).toBe('Hello! How can I help?');
  });

  test('handles JSON wrapped in code fences', () => {
    const plan = parseClassifyPlan('```json\n{"action":"SEARCH","query":"fenced"}\n```');
    expect(plan?.action).toBe('SEARCH');
    expect(plan?.query).toBe('fenced');
  });

  test('handles plain text DIRECT: response', () => {
    const plan = parseClassifyPlan('DIRECT: Hi there!');
    expect(plan?.action).toBe('DIRECT');
    expect(plan?.response).toBe('Hi there!');
  });

  test('handles bare DIRECT without response', () => {
    const plan = parseClassifyPlan('DIRECT');
    expect(plan?.action).toBe('DIRECT');
    expect(plan?.response).toBeUndefined();
  });

  test('handles plain text SEARCH', () => {
    const plan = parseClassifyPlan('SEARCH');
    expect(plan?.action).toBe('SEARCH');
  });

  test('treats unknown text as rephrased search query', () => {
    const plan = parseClassifyPlan('what are the latest updates on project X');
    expect(plan?.action).toBe('SEARCH');
    expect(plan?.query).toBe('what are the latest updates on project X');
  });

  test('returns null for empty input', () => {
    expect(parseClassifyPlan('')).toBeNull();
    expect(parseClassifyPlan(null)).toBeNull();
    expect(parseClassifyPlan(undefined)).toBeNull();
  });

  test('parses filters array', () => {
    const plan = parseClassifyPlan(
      '{"action":"SEARCH","query":"red items","filters":[{"field":"color","operator":"equals","value":"red"}]}',
    );
    expect(plan?.filters).toHaveLength(1);
    expect(plan?.filters?.[0].field).toBe('color');
    expect(plan?.filters?.[0].operator).toBe('equals');
    expect(plan?.filters?.[0].value).toBe('red');
  });

  test('parses aggregation', () => {
    const plan = parseClassifyPlan(
      '{"action":"SEARCH","queryType":"aggregation","aggregation":{"field":"source_type","function":"count"}}',
    );
    expect(plan?.queryType).toBe('aggregation');
    expect(plan?.aggregation?.field).toBe('source_type');
    expect(plan?.aggregation?.function).toBe('count');
  });

  test('ignores invalid filters (not array)', () => {
    const plan = parseClassifyPlan('{"action":"SEARCH","query":"test","filters":"invalid"}');
    expect(plan?.action).toBe('SEARCH');
    expect(plan?.filters).toBeUndefined();
  });

  test('handles JSON with surrounding whitespace', () => {
    const plan = parseClassifyPlan('  \n{"action":"SEARCH","query":"trimmed"}\n  ');
    expect(plan?.action).toBe('SEARCH');
    expect(plan?.query).toBe('trimmed');
  });

  test('handles malformed JSON gracefully — falls back to text', () => {
    const plan = parseClassifyPlan('{"action":"SEARCH", broken json');
    expect(plan?.action).toBe('SEARCH');
    expect(plan?.query).toBe('{"action":"SEARCH", broken json');
  });
});

// =============================================================================
// buildSimpleClassifyPrompt
// =============================================================================

describe('buildSimpleClassifyPrompt', () => {
  test('returns valid prompt without identity', () => {
    const prompt = buildSimpleClassifyPrompt();
    expect(prompt).toContain('ROUTER');
    expect(prompt).toContain('DIRECT');
    expect(prompt).toContain('SEARCH');
    expect(prompt).toContain('JSON');
  });

  test('includes agent name when provided', () => {
    const prompt = buildSimpleClassifyPrompt({ name: 'Dr. Smith' });
    expect(prompt).toContain('Dr. Smith');
  });

  test('includes persona for DIRECT response style', () => {
    const prompt = buildSimpleClassifyPrompt({
      name: 'BankBot',
      persona: 'Be professional and formal',
    });
    expect(prompt).toContain('BankBot');
    expect(prompt).toContain('Be professional and formal');
  });

  test('works with name only, no persona', () => {
    const prompt = buildSimpleClassifyPrompt({ name: 'Helper' });
    expect(prompt).toContain('Helper');
    // No persona line
    expect(prompt).not.toContain('style:');
  });

  test('works with empty identity object', () => {
    const prompt = buildSimpleClassifyPrompt({});
    expect(prompt).toContain('ROUTER');
  });
});

// =============================================================================
// classifyKBComplexity
// =============================================================================

describe('classifyKBComplexity', () => {
  test('returns simple for empty manifest', () => {
    const result = classifyKBComplexity({});
    expect(result.tier).toBe('simple');
    expect(result.defaultQueryType).toBe('hybrid');
  });

  test('returns simple for null manifest', () => {
    const result = classifyKBComplexity(null);
    expect(result.tier).toBe('simple');
  });

  test('returns filtered for only auto-seeded fields once filter fields exist', () => {
    // PR #1035 tightened classifyKBComplexity so that having any filter
    // field at all — even the standard auto-seeded ones (mime_type,
    // source_type, language, …) — escalates the tier from 'simple' to
    // 'filtered'. domainVocabCount / domainFilterCount still subtract the
    // auto-seeded set so callers can detect connector-domain richness.
    const result = classifyKBComplexity({
      capabilities: {
        vocabulary: {
          terms: [
            { field: 'mime_type', canFilter: true },
            { field: 'source_type', canFilter: true },
            { field: 'title', canFilter: false },
          ],
        },
        filters: {
          fields: [{ name: 'mime_type' }, { name: 'source_type' }],
        },
      },
    });
    expect(result.tier).toBe('filtered');
    expect(result.domainVocabCount).toBe(0);
    expect(result.domainFilterCount).toBe(0);
  });

  test('returns filtered for domain-specific filters without aggregation', () => {
    const result = classifyKBComplexity({
      capabilities: {
        vocabulary: { terms: [{ field: 'status', canFilter: true }] },
        filters: { fields: [{ name: 'status' }] },
        aggregation: { available: false },
      },
    });
    expect(result.tier).toBe('filtered');
    expect(result.domainFilterCount).toBe(1);
  });

  test('returns advanced for domain vocab + aggregation', () => {
    const result = classifyKBComplexity({
      capabilities: {
        vocabulary: { terms: [{ field: 'priority', canFilter: true, canAggregate: true }] },
        filters: { fields: [{ name: 'priority' }] },
        aggregation: { available: true },
      },
    });
    expect(result.tier).toBe('advanced');
    expect(result.hasAggregation).toBe(true);
  });

  test('counts domain vs auto-seeded correctly', () => {
    const result = classifyKBComplexity({
      capabilities: {
        vocabulary: {
          terms: [
            { field: 'mime_type' }, // auto-seeded
            { field: 'color' }, // domain
            { field: 'brand' }, // domain
          ],
        },
        filters: {
          fields: [
            { name: 'source_type' }, // auto-seeded
            { name: 'color' }, // domain
          ],
        },
      },
    });
    expect(result.vocabularyCount).toBe(3);
    expect(result.domainVocabCount).toBe(2);
    expect(result.filterFieldCount).toBe(2);
    expect(result.domainFilterCount).toBe(1);
  });
});
