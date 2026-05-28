/**
 * `ExtractionEnvelopeSchema` Zod parse tests (LLD Phase 2 Task 2.1).
 *
 * Covers happy path, missing required fields, schemaVersion mismatch,
 * malformed bbox, invalid URLs, defaults application, provider enum,
 * out-of-range metadata values, and a Docling/Azure round-trip pair to
 * verify both providers can produce conforming envelopes.
 */

import { describe, it, expect } from 'vitest';
import {
  ExtractionEnvelopeSchema,
  ExtractionPageSchema,
  ExtractionTableSchema,
  ExtractionImageSchema,
  type ExtractionEnvelope,
} from '../native/extraction-envelope.js';

const validEnvelope: ExtractionEnvelope = {
  schemaVersion: 1,
  provider: 'docling',
  sourceUrl: 'https://example.com/doc.pdf',
  contentType: 'application/pdf',
  markdown: '# Page 1\n\nHello',
  pages: [
    {
      pageNumber: 1,
      text: 'Hello',
      tables: [],
      images: [],
      headings: [{ level: 1, text: 'Page 1' }],
    },
  ],
  metadata: { pageCount: 1, language: 'en', hasOCR: false, processingTimeMs: 100 },
};

describe('ExtractionEnvelopeSchema', () => {
  it('parses a valid Docling envelope', () => {
    const result = ExtractionEnvelopeSchema.safeParse(validEnvelope);
    expect(result.success).toBe(true);
  });

  it('parses a valid Azure envelope', () => {
    const azure: ExtractionEnvelope = {
      ...validEnvelope,
      provider: 'azure-document-intelligence',
      sourceUrl: 'https://example.com/invoice.pdf',
    };
    expect(ExtractionEnvelopeSchema.safeParse(azure).success).toBe(true);
  });

  it('rejects schemaVersion other than 1', () => {
    const bad = { ...validEnvelope, schemaVersion: 2 };
    const result = ExtractionEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects unknown provider', () => {
    const bad = { ...validEnvelope, provider: 'aws-textract' as never };
    const result = ExtractionEnvelopeSchema.safeParse(bad);
    expect(result.success).toBe(false);
  });

  it('rejects non-URL sourceUrl', () => {
    const bad = { ...validEnvelope, sourceUrl: 'not-a-url' };
    expect(ExtractionEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects empty contentType', () => {
    const bad = { ...validEnvelope, contentType: '' };
    expect(ExtractionEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects pageCount below 0', () => {
    const bad = { ...validEnvelope, metadata: { ...validEnvelope.metadata, pageCount: -1 } };
    expect(ExtractionEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('rejects languageConfidence outside [0, 1]', () => {
    const bad = {
      ...validEnvelope,
      metadata: { ...validEnvelope.metadata, languageConfidence: 1.5 },
    };
    expect(ExtractionEnvelopeSchema.safeParse(bad).success).toBe(false);
  });

  it('applies defaults for missing page subfields', () => {
    const minimalPage = { pageNumber: 1, text: 'Hello' };
    const result = ExtractionPageSchema.safeParse(minimalPage);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.tables).toEqual([]);
      expect(result.data.images).toEqual([]);
      expect(result.data.headings).toEqual([]);
    }
  });

  it('rejects pageNumber 0 (must be ≥1)', () => {
    const bad = ExtractionPageSchema.safeParse({ pageNumber: 0, text: 'x' });
    expect(bad.success).toBe(false);
  });

  it('rejects malformed bbox on tables', () => {
    const bad = ExtractionTableSchema.safeParse({
      rows: [['a', 'b']],
      markdown: '|a|b|',
      bbox: [1, 2, 3] as never, // missing 4th element
    });
    expect(bad.success).toBe(false);
  });

  it('rejects malformed bbox on images', () => {
    const bad = ExtractionImageSchema.safeParse({
      format: 'png',
      base64: 'iVBORw0KGgo=',
      bbox: ['a', 'b', 'c', 'd'] as never,
    });
    expect(bad.success).toBe(false);
  });

  it('passes raw field through unchanged', () => {
    const withRaw = { ...validEnvelope, raw: { vendor: 'docling', extra: { nested: true } } };
    const result = ExtractionEnvelopeSchema.safeParse(withRaw);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.raw).toEqual({ vendor: 'docling', extra: { nested: true } });
    }
  });

  it('omits optional metadata fields cleanly', () => {
    const minimal: ExtractionEnvelope = {
      ...validEnvelope,
      metadata: { pageCount: 0 },
    };
    expect(ExtractionEnvelopeSchema.safeParse(minimal).success).toBe(true);
  });

  it('accepts an empty pages array (e.g. extract-failed-but-still-conforms)', () => {
    const noPages = { ...validEnvelope, pages: [] };
    expect(ExtractionEnvelopeSchema.safeParse(noPages).success).toBe(true);
  });

  it('rejects missing required envelope keys', () => {
    const missingMarkdown = { ...validEnvelope } as Partial<ExtractionEnvelope>;
    delete missingMarkdown.markdown;
    expect(ExtractionEnvelopeSchema.safeParse(missingMarkdown).success).toBe(false);
  });
});
