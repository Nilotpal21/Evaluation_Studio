import { describe, it, expect } from 'vitest';
import { MOCK_RESPONSES } from '../fixtures/mock-tool-responses.js';

describe('MOCK_RESPONSES registry', () => {
  it('is a non-empty object', () => {
    expect(typeof MOCK_RESPONSES).toBe('object');
    expect(Object.keys(MOCK_RESPONSES).length).toBeGreaterThan(50);
  });

  it.each(['get_balance', 'search_hotels', 'calculate_risk', 'verify_identity'])(
    'contains known tool "%s"',
    (toolName) => {
      expect(toolName in MOCK_RESPONSES).toBe(true);
      expect(MOCK_RESPONSES[toolName]).toBeDefined();
    },
  );

  it('all values are JSON-serializable (no functions, no circular refs)', () => {
    for (const [key, value] of Object.entries(MOCK_RESPONSES)) {
      expect(() => JSON.stringify(value)).not.toThrow();
      // Ensure no function values
      expect(typeof value).not.toBe('function');
      // Round-trip: parse(stringify(v)) should deep-equal v
      const roundTripped = JSON.parse(JSON.stringify(value));
      expect(roundTripped).toEqual(value);
    }
  });

  it('get_balance returns expected shape', () => {
    const balance = MOCK_RESPONSES.get_balance as Record<string, unknown>;
    expect(balance).toHaveProperty('available');
    expect(balance).toHaveProperty('currency', 'USD');
  });

  it('search_hotels returns expected shape', () => {
    const hotels = MOCK_RESPONSES.search_hotels as Record<string, unknown>;
    expect(hotels).toHaveProperty('hotels');
    expect(Array.isArray((hotels as any).hotels)).toBe(true);
  });

  it('calculate_risk returns expected shape', () => {
    const risk = MOCK_RESPONSES.calculate_risk as Record<string, unknown>;
    expect(risk).toHaveProperty('score');
    expect(risk).toHaveProperty('factors');
    expect(Array.isArray((risk as any).factors)).toBe(true);
  });
});
