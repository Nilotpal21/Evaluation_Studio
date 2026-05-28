/**
 * Browser-Side ABL Validation (Tier 1)
 *
 * Instant parse feedback (~5ms) using @abl/language-service parsers directly in the browser.
 * No API roundtrip needed — @abl/language-service has zero Node.js dependencies.
 */

import { useCallback, useRef } from 'react';
import { getDiagnostics } from '@abl/language-service';
import type { Diagnostic } from '@abl/language-service';

const MAX_CACHE_SIZE = 20;

interface CacheEntry {
  diagnostics: Diagnostic[];
}

interface BrowserValidationResult {
  errors: Diagnostic[];
  warnings: Diagnostic[];
}

export function useABLBrowserValidation() {
  const cacheRef = useRef<Map<string, CacheEntry>>(new Map());

  const validate = useCallback((dsl: string): BrowserValidationResult => {
    if (!dsl.trim()) {
      return { errors: [], warnings: [] };
    }

    // Check cache
    const cached = cacheRef.current.get(dsl);
    if (cached) {
      return {
        errors: cached.diagnostics.filter((d) => d.severity === 'error'),
        warnings: cached.diagnostics.filter((d) => d.severity === 'warning'),
      };
    }

    // Run Tier 1+2 parse (no compileFn = no Tier 3)
    const diagnostics = getDiagnostics(dsl);

    // Cache result
    const cache = cacheRef.current;
    if (cache.size >= MAX_CACHE_SIZE) {
      // Evict oldest entry
      const firstKey = cache.keys().next().value;
      if (firstKey !== undefined) cache.delete(firstKey);
    }
    cache.set(dsl, { diagnostics });

    return {
      errors: diagnostics.filter((d) => d.severity === 'error'),
      warnings: diagnostics.filter((d) => d.severity === 'warning'),
    };
  }, []);

  return { validate };
}
