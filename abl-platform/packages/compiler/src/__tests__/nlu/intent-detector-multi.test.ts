import { describe, it, expect } from 'vitest';
import { parseIntentResponse } from '../../platform/nlu/tasks/intent-detector.js';

describe('parseIntentResponse', () => {
  it('parses multi-intent format', () => {
    const json = {
      intents: [
        { intent: 'book_hotel', confidence: 0.92 },
        { intent: 'rent_car', confidence: 0.85 },
      ],
      relationships: { type: 'independent', reasoning: 'Both are travel tasks' },
    };
    const result = parseIntentResponse(json, 3, 0.6);
    expect(result.primary.intent).toBe('book_hotel');
    expect(result.primary.confidence).toBe(0.92);
    expect(result.primary.source).toBe('fast');
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].intent).toBe('rent_car');
    expect(result.alternatives[0].confidence).toBe(0.85);
    expect(result.alternatives[0].source).toBe('fast');
    expect(result.relationships.type).toBe('independent');
    expect(result.relationships.reasoning).toBe('Both are travel tasks');
  });

  it('handles single-intent legacy format', () => {
    const json = { intent: 'book_hotel', confidence: 0.92 };
    const result = parseIntentResponse(json, 3, 0.6);
    expect(result.primary.intent).toBe('book_hotel');
    expect(result.primary.confidence).toBe(0.92);
    expect(result.primary.source).toBe('fast');
    expect(result.alternatives).toEqual([]);
    expect(result.relationships.type).toBe('ambiguous');
    expect(result.relationships.reasoning).toBe('');
  });

  it('respects max_intents cap', () => {
    const json = {
      intents: [
        { intent: 'a', confidence: 0.9 },
        { intent: 'b', confidence: 0.8 },
        { intent: 'c', confidence: 0.7 },
        { intent: 'd', confidence: 0.6 },
      ],
    };
    const result = parseIntentResponse(json, 2, 0.5);
    // maxIntents = 2 means primary + 1 alternative
    expect(result.primary.intent).toBe('a');
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].intent).toBe('b');
  });

  it('filters by confidence threshold', () => {
    const json = {
      intents: [
        { intent: 'a', confidence: 0.9 },
        { intent: 'b', confidence: 0.7 },
        { intent: 'c', confidence: 0.4 },
      ],
    };
    const result = parseIntentResponse(json, 5, 0.6);
    // 'c' (0.4) is below threshold 0.6, only 'a' and 'b' pass
    expect(result.primary.intent).toBe('a');
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].intent).toBe('b');
  });

  it('defaults to ambiguous relationship when missing', () => {
    const json = {
      intents: [{ intent: 'a', confidence: 0.9 }],
    };
    const result = parseIntentResponse(json, 3, 0.5);
    expect(result.relationships.type).toBe('ambiguous');
    expect(result.relationships.reasoning).toBe('');
  });

  it('sorts intents by confidence descending', () => {
    const json = {
      intents: [
        { intent: 'low', confidence: 0.6 },
        { intent: 'high', confidence: 0.95 },
        { intent: 'mid', confidence: 0.8 },
      ],
    };
    const result = parseIntentResponse(json, 5, 0.5);
    expect(result.primary.intent).toBe('high');
    expect(result.primary.confidence).toBe(0.95);
    expect(result.alternatives[0].intent).toBe('mid');
    expect(result.alternatives[0].confidence).toBe(0.8);
    expect(result.alternatives[1].intent).toBe('low');
    expect(result.alternatives[1].confidence).toBe(0.6);
  });

  it('handles empty intents array', () => {
    const json = { intents: [] };
    const result = parseIntentResponse(json, 3, 0.5);
    expect(result.primary.intent).toBeNull();
    expect(result.primary.confidence).toBe(0);
    expect(result.primary.source).toBe('fast');
    expect(result.alternatives).toEqual([]);
  });

  it('handles legacy format with missing confidence', () => {
    const json = { intent: 'greet' };
    const result = parseIntentResponse(json, 3, 0.5);
    expect(result.primary.intent).toBe('greet');
    expect(result.primary.confidence).toBe(0.8);
  });

  it('handles legacy format with null intent', () => {
    const json = { confidence: 0.3 };
    const result = parseIntentResponse(json, 3, 0.5);
    expect(result.primary.intent).toBeNull();
    expect(result.primary.confidence).toBe(0.3);
  });

  it('preserves dependent relationship type', () => {
    const json = {
      intents: [
        { intent: 'check_balance', confidence: 0.9 },
        { intent: 'transfer_funds', confidence: 0.75 },
      ],
      relationships: {
        type: 'dependent',
        reasoning: 'User wants to check balance before transferring',
      },
    };
    const result = parseIntentResponse(json, 5, 0.5);
    expect(result.relationships.type).toBe('dependent');
    expect(result.relationships.reasoning).toContain('check balance');
  });

  it('filters all intents below threshold leaving null primary', () => {
    const json = {
      intents: [
        { intent: 'a', confidence: 0.3 },
        { intent: 'b', confidence: 0.2 },
      ],
    };
    const result = parseIntentResponse(json, 5, 0.5);
    expect(result.primary.intent).toBeNull();
    expect(result.primary.confidence).toBe(0);
    expect(result.alternatives).toEqual([]);
  });

  it('applies threshold before maxIntents cap', () => {
    const json = {
      intents: [
        { intent: 'a', confidence: 0.95 },
        { intent: 'b', confidence: 0.9 },
        { intent: 'c', confidence: 0.3 }, // below threshold
        { intent: 'd', confidence: 0.85 },
      ],
    };
    // threshold=0.5 removes 'c', then maxIntents=2 caps to 'a' and 'b'
    const result = parseIntentResponse(json, 2, 0.5);
    expect(result.primary.intent).toBe('a');
    expect(result.alternatives).toHaveLength(1);
    expect(result.alternatives[0].intent).toBe('b');
  });
});
