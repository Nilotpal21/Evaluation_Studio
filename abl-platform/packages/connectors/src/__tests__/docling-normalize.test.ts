/**
 * `normalizeDoclingToEnvelope` unit tests (LLD Phase 2 Task 2.2).
 *
 * Pure-function tests of the Docling-native → ExtractionEnvelope mapping.
 * Includes content-type derivation, page filtering, bbox normalization,
 * empty-input handling, and the bounded-range safety guard.
 */

import { describe, it, expect } from 'vitest';
import {
  normalizeDoclingToEnvelope,
  type DoclingNativeResponse,
} from '../native/docling/normalize.js';

function syntheticResponse(overrides: Partial<DoclingNativeResponse> = {}): DoclingNativeResponse {
  return {
    pages: [
      {
        pageNumber: 1,
        text: 'Page one body.',
        layout: { headings: [{ level: 1, text: 'Heading one' }] },
        tables: [],
        images: [],
        screenshot: null,
      },
      {
        pageNumber: 2,
        text: 'Page two body.',
        layout: { headings: [] },
        tables: [{ rows: [['a', 'b']], markdown: '|a|b|', bbox: [0, 0, 100, 50] }],
        images: [{ data: 'iVBORw0KGgo=', format: 'png', bbox: [10, 10, 50, 50] }],
        screenshot: null,
      },
    ],
    metadata: {
      pageCount: 2,
      hasOCR: false,
      processingTime: 42,
      language: 'en',
      documentType: 'pdf',
    },
    structure: { outline: [], documentType: 'pdf' },
    ...overrides,
  };
}

describe('normalizeDoclingToEnvelope', () => {
  it('produces a valid envelope from a 2-page response', () => {
    const env = normalizeDoclingToEnvelope(syntheticResponse(), {
      sourceUrl: 'https://example.com/doc.pdf',
    });
    expect(env.schemaVersion).toBe(1);
    expect(env.provider).toBe('docling');
    expect(env.contentType).toBe('application/pdf');
    expect(env.pages).toHaveLength(2);
    expect(env.metadata.pageCount).toBe(2);
    expect(env.metadata.language).toBe('en');
    // Docling reports processingTime in seconds (42); normalizer converts to
    // milliseconds and rounds — `42 * 1000 = 42000`.
    expect(env.metadata.processingTimeMs).toBe(42000);
    expect(env.markdown).toContain('# Page 1');
    expect(env.markdown).toContain('# Page 2');
  });

  it('converts Docling float processingTime (seconds) → integer ms and rounds', () => {
    // Regression: Docling returns floats like 87.304 (seconds). The envelope
    // schema demands z.number().int() — without conversion the worker hits a
    // ZodError and classifies a successful extraction as EXTRACTION_FAILED.
    const env = normalizeDoclingToEnvelope(
      syntheticResponse({
        metadata: { pageCount: 2, hasOCR: false, processingTime: 87.304 },
      }),
      { sourceUrl: 'https://example.com/x' },
    );
    expect(env.metadata.processingTimeMs).toBe(87304);
    expect(Number.isInteger(env.metadata.processingTimeMs)).toBe(true);
  });

  it('rounds half-millisecond float to nearest integer', () => {
    const env = normalizeDoclingToEnvelope(
      syntheticResponse({
        metadata: { pageCount: 1, hasOCR: false, processingTime: 0.0015 },
      }),
      { sourceUrl: 'https://example.com/x' },
    );
    // 0.0015 s = 1.5 ms → Math.round → 2
    expect(env.metadata.processingTimeMs).toBe(2);
  });

  it('omits processingTimeMs when Docling response has no processingTime', () => {
    const env = normalizeDoclingToEnvelope(
      syntheticResponse({ metadata: { pageCount: 1, hasOCR: false } }),
      { sourceUrl: 'https://example.com/x' },
    );
    expect(env.metadata.processingTimeMs).toBeUndefined();
  });

  it('derives application/octet-stream for unknown documentType', () => {
    const env = normalizeDoclingToEnvelope(
      // Override both `metadata.documentType` (absent) AND `structure.documentType`
      // (also absent) — the deriver falls through to the default MIME.
      syntheticResponse({ metadata: { pageCount: 0 }, structure: { outline: [] } }),
      { sourceUrl: 'https://example.com/x' },
    );
    expect(env.contentType).toBe('application/octet-stream');
  });

  it('honors an explicit content-type override', () => {
    const env = normalizeDoclingToEnvelope(syntheticResponse(), {
      sourceUrl: 'https://example.com/doc.pdf',
      contentType: 'image/png',
    });
    expect(env.contentType).toBe('image/png');
  });

  it('maps each known documentType to the canonical MIME', () => {
    const cases = [
      ['docx', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'],
      ['pptx', 'application/vnd.openxmlformats-officedocument.presentationml.presentation'],
      ['xlsx', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'],
      ['html', 'text/html'],
      ['md', 'text/markdown'],
      ['markdown', 'text/markdown'],
      ['txt', 'text/plain'],
    ] as const;
    for (const [docType, mime] of cases) {
      const env = normalizeDoclingToEnvelope(
        syntheticResponse({ metadata: { pageCount: 0, documentType: docType } }),
        { sourceUrl: 'https://example.com/x' },
      );
      expect(env.contentType, `${docType} → ${mime}`).toBe(mime);
    }
  });

  it('drops bogus bbox shapes (silently — does not crash)', () => {
    const env = normalizeDoclingToEnvelope(
      syntheticResponse({
        pages: [
          {
            pageNumber: 1,
            text: 'x',
            layout: { headings: [] },
            tables: [{ rows: [['a']], markdown: '|a|', bbox: ['bad', 'bbox', 'shape'] as never }],
            images: [],
            screenshot: null,
          },
        ],
        metadata: { pageCount: 1 },
      }),
      { sourceUrl: 'https://example.com/x' },
    );
    expect(env.pages[0]?.tables[0]?.bbox).toBeUndefined();
  });

  it('includes raw provider response when includeRaw is true', () => {
    const response = syntheticResponse();
    const env = normalizeDoclingToEnvelope(response, {
      sourceUrl: 'https://example.com/x',
      includeRaw: true,
    });
    expect(env.raw).toEqual(response);
  });

  it('omits raw provider response by default', () => {
    const env = normalizeDoclingToEnvelope(syntheticResponse(), {
      sourceUrl: 'https://example.com/x',
    });
    expect(env.raw).toBeUndefined();
  });

  it('produces an empty pages envelope for a zero-page response', () => {
    const env = normalizeDoclingToEnvelope(
      { pages: [], metadata: { pageCount: 0 } },
      { sourceUrl: 'https://example.com/x' },
    );
    expect(env.pages).toEqual([]);
    expect(env.markdown).toBe('');
  });
});
