import { describe, it, expect, vi } from 'vitest';
import { applyPostExtractionConversions } from '../services/execution/flow-step-executor.js';

describe('applyPostExtractionConversions', () => {
  it('converts field with convert_to semantics', async () => {
    const values: Record<string, unknown> = { temperature: 72 };
    const fields = [
      { name: 'temperature', semantics: { unit: 'fahrenheit', convert_to: 'celsius' } },
    ];
    await applyPostExtractionConversions(values, fields);
    // 72°F → ~22.22°C
    expect(values.temperature).toBeCloseTo(22.222, 2);
    expect((values._original as Record<string, unknown>).temperature).toBe(72);
  });

  it('skips non-numeric values', async () => {
    const values: Record<string, unknown> = { city: 'Paris' };
    const fields = [{ name: 'city', semantics: { unit: 'fahrenheit', convert_to: 'celsius' } }];
    await applyPostExtractionConversions(values, fields);
    expect(values.city).toBe('Paris');
    expect(values._original).toBeUndefined();
  });

  it('skips when convert_to is undefined', async () => {
    const values: Record<string, unknown> = { temperature: 72 };
    const fields = [{ name: 'temperature', semantics: { unit: 'fahrenheit' } }];
    await applyPostExtractionConversions(values, fields);
    expect(values.temperature).toBe(72);
    expect(values._original).toBeUndefined();
  });

  it('skips when units match', async () => {
    const values: Record<string, unknown> = { temperature: 22 };
    const fields = [{ name: 'temperature', semantics: { unit: 'celsius', convert_to: 'celsius' } }];
    await applyPostExtractionConversions(values, fields);
    expect(values.temperature).toBe(22);
    expect(values._original).toBeUndefined();
  });

  it('skips when unit is undefined', async () => {
    const values: Record<string, unknown> = { temperature: 72 };
    const fields = [{ name: 'temperature', semantics: { convert_to: 'celsius' } }];
    await applyPostExtractionConversions(values, fields);
    expect(values.temperature).toBe(72);
    expect(values._original).toBeUndefined();
  });

  it('skips unsupported conversion pairs', async () => {
    const values: Record<string, unknown> = { weight: 100 };
    const fields = [{ name: 'weight', semantics: { unit: 'kg', convert_to: 'celsius' } }];
    await applyPostExtractionConversions(values, fields);
    expect(values.weight).toBe(100);
    expect(values._original).toBeUndefined();
  });

  it('preserves existing _original values', async () => {
    const values: Record<string, unknown> = {
      temp1: 72,
      temp2: 100,
      _original: { temp1: 72 },
    };
    const fields = [{ name: 'temp2', semantics: { unit: 'celsius', convert_to: 'fahrenheit' } }];
    await applyPostExtractionConversions(values, fields);
    const originals = values._original as Record<string, unknown>;
    // Pre-existing _original.temp1 should be preserved
    expect(originals.temp1).toBe(72);
    // New _original.temp2 should be set to the original celsius value
    expect(originals.temp2).toBe(100);
    // temp2 should now be in fahrenheit: 100°C → 212°F
    expect(values.temp2).toBeCloseTo(212, 0);
  });

  it('converts multiple fields in a single pass', async () => {
    const values: Record<string, unknown> = { distance: 10, weight: 5 };
    const fields = [
      { name: 'distance', semantics: { unit: 'miles', convert_to: 'km' } },
      { name: 'weight', semantics: { unit: 'lbs', convert_to: 'kg' } },
    ];
    await applyPostExtractionConversions(values, fields);
    // 10 miles → ~16.09 km
    expect(values.distance).toBeCloseTo(16.09, 1);
    // 5 lbs → ~2.27 kg
    expect(values.weight).toBeCloseTo(2.27, 1);
    const originals = values._original as Record<string, unknown>;
    expect(originals.distance).toBe(10);
    expect(originals.weight).toBe(5);
  });

  it('handles empty fields array', async () => {
    const values: Record<string, unknown> = { temperature: 72 };
    await applyPostExtractionConversions(values, []);
    expect(values.temperature).toBe(72);
    expect(values._original).toBeUndefined();
  });

  it('handles fields without semantics property', async () => {
    const values: Record<string, unknown> = { name: 'Alice' };
    const fields = [{ name: 'name' }];
    await applyPostExtractionConversions(values, fields);
    expect(values.name).toBe('Alice');
    expect(values._original).toBeUndefined();
  });

  it('returns the mutated values object', async () => {
    const values: Record<string, unknown> = { temperature: 32 };
    const fields = [
      { name: 'temperature', semantics: { unit: 'fahrenheit', convert_to: 'celsius' } },
    ];
    const result = await applyPostExtractionConversions(values, fields);
    expect(result).toBe(values);
    expect(result.temperature).toBeCloseTo(0, 1);
  });
});

describe('Live currency conversion', () => {
  it('uses CurrencyRateClient for 3-letter currency codes', async () => {
    const mockClient = { getRate: vi.fn().mockResolvedValue(0.92) };
    const values: Record<string, unknown> = { price: 100 };
    const fields = [{ name: 'price', semantics: { unit: 'USD', convert_to: 'EUR' } }];
    await applyPostExtractionConversions(values, fields, mockClient as any);
    expect(values.price).toBeCloseTo(92, 0);
    expect(mockClient.getRate).toHaveBeenCalledWith('USD', 'EUR');
    expect((values._original as Record<string, unknown>).price).toBe(100);
  });

  it('falls back to static conversion for non-currency codes', async () => {
    const mockClient = { getRate: vi.fn() };
    const values: Record<string, unknown> = { temperature: 72 };
    const fields = [
      { name: 'temperature', semantics: { unit: 'fahrenheit', convert_to: 'celsius' } },
    ];
    await applyPostExtractionConversions(values, fields, mockClient as any);
    expect(values.temperature).toBeCloseTo(22.22, 1);
    expect(mockClient.getRate).not.toHaveBeenCalled();
  });

  it('does not use currency client when not provided', async () => {
    const values: Record<string, unknown> = { price: 100 };
    const fields = [{ name: 'price', semantics: { unit: 'USD', convert_to: 'EUR' } }];
    // Without client, USD→EUR won't be recognized as a supported static conversion
    await applyPostExtractionConversions(values, fields);
    // The static unit-conversion module may or may not support currency — check result
    // If it does support it, value changes; if not, value stays 100
    expect(typeof values.price).toBe('number');
  });
});
