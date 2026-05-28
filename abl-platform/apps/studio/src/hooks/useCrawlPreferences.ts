/**
 * useCrawlPreferences Hook
 *
 * Fetches the user's saved crawl preferences and matches a given URL
 * against saved domain patterns, returning the best match for auto-apply.
 */

import { useMemo } from 'react';
import useSWR from 'swr';
import { getCrawlPreferences } from '@/api/crawl';
import type { UserCrawlPreference } from '@/api/crawl';

interface UseCrawlPreferencesReturn {
  /** All user preferences, sorted by lastUsed descending */
  preferences: UserCrawlPreference[];
  /** Best matching preference for the given URL, or null */
  matchingPreference: UserCrawlPreference | null;
  /** Whether preferences are still loading */
  isLoading: boolean;
}

/**
 * Convert a simple glob domain pattern to a RegExp.
 *
 * Supported patterns:
 *   "*.example.com"  → matches sub.example.com, deep.sub.example.com
 *   "docs.example.com" → exact match
 *   "example.*"      → matches example.com, example.org
 */
function patternToRegExp(pattern: string): RegExp {
  // First escape all regex-special chars (including *), then convert \* → .*
  const escaped = pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/\\\*/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function useCrawlPreferences(url: string | null): UseCrawlPreferencesReturn {
  const { data, isLoading } = useSWR(
    'crawl-preferences',
    () => getCrawlPreferences(),
    { dedupingInterval: 60_000 }, // Cache for 1 minute (equivalent to staleTime)
  );

  const preferences = data?.preferences ?? [];

  const matchingPreference = useMemo(() => {
    if (!url || preferences.length === 0) return null;

    let hostname: string;
    try {
      hostname = new URL(url).hostname;
    } catch {
      return null;
    }

    // Find best match: prefer exact matches over wildcards, then highest useCount
    let best: UserCrawlPreference | null = null;
    let bestSpecificity = -1;

    for (const pref of preferences) {
      const regex = patternToRegExp(pref.domainPattern);
      if (!regex.test(hostname)) continue;

      // Specificity: exact match > partial wildcard > broad wildcard
      const specificity = pref.domainPattern.includes('*')
        ? pref.domainPattern.length // Longer patterns are more specific
        : 1000; // Exact match wins

      if (specificity > bestSpecificity) {
        best = pref;
        bestSpecificity = specificity;
      }
    }

    return best;
  }, [url, preferences]);

  return { preferences, matchingPreference, isLoading };
}
