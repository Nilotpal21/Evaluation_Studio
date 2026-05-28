import { describe, it, expect } from 'vitest';
import { setGatheredValues } from '../../services/execution/types.js';
import type { RuntimeSession } from '../../services/execution/types.js';

function createMockSession(): RuntimeSession {
  return {
    data: {
      values: {},
      gatheredKeys: new Set<string>(),
    },
  } as unknown as RuntimeSession;
}

describe('Session metadata storage (_original, _inferred)', () => {
  it('stores _original alongside converted values', () => {
    const session = createMockSession();
    setGatheredValues(session, {
      temperature: 22.22,
      _original: { temperature: 72 },
    });
    expect(session.data.values.temperature).toBe(22.22);
    expect((session.data.values._original as Record<string, unknown>).temperature).toBe(72);
  });

  it('stores _inferred alongside inferred values', () => {
    const session = createMockSession();
    setGatheredValues(session, {
      hotel_class: 'standard',
      _inferred: { hotel_class: { confidence: 0.85, reasoning: 'Default' } },
    });
    expect(session.data.values.hotel_class).toBe('standard');
    expect((session.data.values._inferred as Record<string, unknown>).hotel_class).toBeDefined();
  });

  it('does NOT add _original to gatheredKeys', () => {
    const session = createMockSession();
    setGatheredValues(session, {
      temperature: 22.22,
      _original: { temperature: 72 },
    });
    expect(session.data.gatheredKeys.has('temperature')).toBe(true);
    expect(session.data.gatheredKeys.has('_original')).toBe(false);
  });

  it('does NOT add _inferred to gatheredKeys', () => {
    const session = createMockSession();
    setGatheredValues(session, {
      hotel_class: 'standard',
      _inferred: { hotel_class: { confidence: 0.85, reasoning: 'Default' } },
    });
    expect(session.data.gatheredKeys.has('hotel_class')).toBe(true);
    expect(session.data.gatheredKeys.has('_inferred')).toBe(false);
  });

  it('preserves existing _original when adding new conversions', () => {
    const session = createMockSession();
    setGatheredValues(session, {
      temp: 22,
      _original: { temp: 72 },
    });

    const existing = session.data.values._original as Record<string, unknown>;
    const newOriginals = { ...existing, distance: 10 };
    setGatheredValues(session, {
      distance: 6.21,
      _original: newOriginals,
    });

    const originals = session.data.values._original as Record<string, unknown>;
    expect(originals.temp).toBe(72);
    expect(originals.distance).toBe(10);
  });

  it('does not add any underscore-prefixed metadata keys to gatheredKeys', () => {
    const session = createMockSession();
    setGatheredValues(session, {
      field1: 'value1',
      _original: { field1: 'orig' },
      _inferred: { field2: { confidence: 0.9 } },
    });
    expect(session.data.gatheredKeys.has('field1')).toBe(true);
    expect(session.data.gatheredKeys.has('_original')).toBe(false);
    expect(session.data.gatheredKeys.has('_inferred')).toBe(false);
  });
});
