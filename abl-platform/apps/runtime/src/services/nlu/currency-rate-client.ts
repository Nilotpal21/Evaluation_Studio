/**
 * Live currency rate client with in-memory cache and static fallback.
 * Used when ProjectRuntimeConfig.conversion.currency_mode = 'live'.
 */
import { createLogger } from '@abl/compiler/platform';

const log = createLogger('currency-rate-client');

/** Static fallback rates (from USD — 1 USD = X target currency) */
const STATIC_RATES: Record<string, number> = {
  USD: 1.0,
  EUR: 0.92,
  GBP: 0.79,
  JPY: 149.5,
  CAD: 1.36,
  AUD: 1.53,
  CHF: 0.88,
  CNY: 7.24,
  INR: 83.1,
  MXN: 17.2,
  BRL: 4.97,
  KRW: 1330,
  SGD: 1.34,
  HKD: 7.82,
  SEK: 10.4,
  NOK: 10.6,
};

interface CacheEntry {
  rates: Record<string, number>;
  fetchedAt: number;
}

export interface CurrencyRateConfig {
  apiUrl: string;
  cacheTtlMs: number;
  fetchFn?: typeof fetch;
}

/** Max cached base currencies (only ~180 ISO currencies exist, but cap defensively) */
const MAX_CACHE_ENTRIES = 50;

export class CurrencyRateClient {
  private config: CurrencyRateConfig;
  private cache: Map<string, CacheEntry> = new Map();

  constructor(config: CurrencyRateConfig) {
    this.config = config;
  }

  async getRate(from: string, to: string): Promise<number> {
    if (from === to) return 1;

    try {
      const rates = await this.fetchRates(from);
      if (rates[to] != null) return rates[to];
    } catch (err) {
      log.debug('Live rate fetch failed, using static fallback', {
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Static fallback: from → USD → to
    const fromRate = STATIC_RATES[from] ?? 1;
    const toRate = STATIC_RATES[to] ?? 1;
    return toRate / fromRate;
  }

  private async fetchRates(base: string): Promise<Record<string, number>> {
    const cached = this.cache.get(base);
    if (cached && Date.now() - cached.fetchedAt < this.config.cacheTtlMs) {
      return cached.rates;
    }

    const fetchFn = this.config.fetchFn ?? fetch;
    const res = await fetchFn(`${this.config.apiUrl}?base=${base}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const data = (await res.json()) as { rates: Record<string, number> };

    // Evict oldest entry if at capacity
    if (this.cache.size >= MAX_CACHE_ENTRIES && !this.cache.has(base)) {
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey !== undefined) this.cache.delete(oldestKey);
    }
    this.cache.set(base, { rates: data.rates, fetchedAt: Date.now() });

    return data.rates;
  }
}
