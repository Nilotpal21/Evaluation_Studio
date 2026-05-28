/**
 * Unit test: `computeExtractionTimeoutMs` (LLD Phase 1 Task 1.6).
 *
 * Asserts the size-scaled timeout calculator behaves correctly at the
 * boundary sizes listed in the Phase 1 exit criteria (1 / 50 / 500 MB) and
 * handles malformed input safely.
 *
 * Floor was raised from 60s → 180s after observing real workloads where a
 * 142 KB HTML input rendered to 29 PDF pages via OCR and took ~94s — the
 * size-based formula underestimated dense documents.
 */

import { describe, it, expect } from 'vitest';
import { computeExtractionTimeoutMs } from '../workers/branches/streaming-url-to-docling.js';

const ONE_MB = 1024 * 1024;

describe('computeExtractionTimeoutMs', () => {
  it('returns the floor (180s) for empty input', () => {
    expect(computeExtractionTimeoutMs(0)).toBe(180_000);
  });

  it('scales linearly at 1 MB → 190s', () => {
    expect(computeExtractionTimeoutMs(ONE_MB)).toBe(190_000);
  });

  it('scales linearly at 50 MB → 680s', () => {
    expect(computeExtractionTimeoutMs(50 * ONE_MB)).toBe(680_000);
  });

  it('caps at 1800s (30 min) for 500 MB', () => {
    expect(computeExtractionTimeoutMs(500 * ONE_MB)).toBe(1_800_000);
  });

  it('caps at 1800s for arbitrarily larger inputs (2 GB)', () => {
    expect(computeExtractionTimeoutMs(2 * 1024 * ONE_MB)).toBe(1_800_000);
  });

  it('treats negative size as 0 (returns floor)', () => {
    expect(computeExtractionTimeoutMs(-1)).toBe(180_000);
  });

  it('treats NaN as 0 (returns floor)', () => {
    expect(computeExtractionTimeoutMs(Number.NaN)).toBe(180_000);
  });

  it('treats Infinity as malformed and falls back to the floor', () => {
    // Infinity is non-finite — the calculator treats it the same as NaN /
    // negative input rather than scaling to the cap, so a buggy caller passing
    // an unbounded size cannot extend the worker timeout to its maximum.
    expect(computeExtractionTimeoutMs(Number.POSITIVE_INFINITY)).toBe(180_000);
  });
});
