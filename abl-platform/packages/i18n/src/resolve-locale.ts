import type { Locale } from './types.js';

/**
 * BCP 47 locale matching with fallback chain.
 * Supports exact match and language-prefix match (e.g., pt-BR → pt).
 */
export function resolveLocale(requested: Locale[], supported: Locale[], fallback: Locale): Locale {
  const supportedLower = new Map(supported.map((s) => [s.toLowerCase(), s]));

  for (const req of requested) {
    const reqLower = req.toLowerCase();

    // Exact match
    if (supportedLower.has(reqLower)) {
      return supportedLower.get(reqLower)!;
    }

    // Prefix match: ar-EG → ar
    const langPart = reqLower.split('-')[0];
    if (langPart && supportedLower.has(langPart)) {
      return supportedLower.get(langPart)!;
    }
  }

  return fallback;
}

/**
 * Parse Accept-Language header into locale array sorted by quality descending.
 */
export function parseAcceptLanguage(header: string): Locale[] {
  if (!header) return [];

  return header
    .split(',')
    .map((part) => {
      const [locale, q] = part.trim().split(';');
      const quality = q ? parseFloat(q.trim().replace('q=', '')) : 1;
      return [locale.trim(), quality] as const;
    })
    .filter(([, q]) => q > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([locale]) => locale);
}
