import { describe, it, expect, vi, beforeEach } from 'vitest';
import { CurrencyRateClient } from '../services/nlu/currency-rate-client.js';

describe('CurrencyRateClient', () => {
  let mockFetch: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockFetch = vi.fn();
  });

  it('fetches live rate and converts', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rates: { EUR: 0.92 } }),
    });

    const client = new CurrencyRateClient({
      apiUrl: 'https://api.rates.example.com',
      cacheTtlMs: 60_000,
      fetchFn: mockFetch,
    });

    const rate = await client.getRate('USD', 'EUR');
    expect(rate).toBeCloseTo(0.92, 2);
  });

  it('uses cached rate within TTL', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ rates: { EUR: 0.92 } }),
    });

    const client = new CurrencyRateClient({
      apiUrl: 'https://api.rates.example.com',
      cacheTtlMs: 60_000,
      fetchFn: mockFetch,
    });

    await client.getRate('USD', 'EUR');
    await client.getRate('USD', 'EUR');

    expect(mockFetch).toHaveBeenCalledTimes(1);
  });

  it('falls back to static rate on API failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const client = new CurrencyRateClient({
      apiUrl: 'https://api.rates.example.com',
      cacheTtlMs: 60_000,
      fetchFn: mockFetch,
    });

    const rate = await client.getRate('USD', 'EUR');
    // Static fallback: EUR/USD = 0.92/1.0 = 0.92
    expect(rate).toBeCloseTo(0.92, 2);
  });

  it('returns 1 for same currency', async () => {
    const client = new CurrencyRateClient({
      apiUrl: 'https://api.rates.example.com',
      cacheTtlMs: 60_000,
      fetchFn: mockFetch,
    });

    const rate = await client.getRate('USD', 'USD');
    expect(rate).toBe(1);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('falls back to static rate on non-OK HTTP response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 429,
    });

    const client = new CurrencyRateClient({
      apiUrl: 'https://api.rates.example.com',
      cacheTtlMs: 60_000,
      fetchFn: mockFetch,
    });

    const rate = await client.getRate('USD', 'GBP');
    expect(rate).toBeCloseTo(0.79, 2);
  });

  it('handles unknown currency codes with fallback', async () => {
    const client = new CurrencyRateClient({
      apiUrl: 'https://api.rates.example.com',
      cacheTtlMs: 60_000,
      fetchFn: vi.fn().mockRejectedValue(new Error('fail')),
    });

    const rate = await client.getRate('XYZ', 'ABC');
    // Both unknown: fallback math = 1/1 = 1
    expect(rate).toBe(1);
  });

  it('calculates cross-rate via USD for static fallback', async () => {
    const client = new CurrencyRateClient({
      apiUrl: 'https://api.rates.example.com',
      cacheTtlMs: 60_000,
      fetchFn: vi.fn().mockRejectedValue(new Error('fail')),
    });

    // EUR to GBP: (GBP rate / EUR rate) = 0.79 / 0.92
    const rate = await client.getRate('EUR', 'GBP');
    expect(rate).toBeCloseTo(0.79 / 0.92, 2);
  });

  it('refetches after TTL expires', async () => {
    mockFetch
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: { EUR: 0.92 } }),
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ rates: { EUR: 0.93 } }),
      });

    const client = new CurrencyRateClient({
      apiUrl: 'https://api.rates.example.com',
      cacheTtlMs: 1, // 1ms TTL
      fetchFn: mockFetch,
    });

    await client.getRate('USD', 'EUR');
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 10));
    const rate = await client.getRate('USD', 'EUR');

    expect(mockFetch).toHaveBeenCalledTimes(2);
    expect(rate).toBeCloseTo(0.93, 2);
  });
});
