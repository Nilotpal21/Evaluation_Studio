/**
 * Docling native response → `ExtractionEnvelope` (LLD Phase 2 Task 2.2).
 *
 * The Docling Python service returns a layout-aware response with `pages[]`,
 * `metadata`, and `structure` (see `apps/search-ai/src/workers/docling-extraction-worker.ts:82-102`
 * for the historical wire shape). This module owns the canonical mapping
 * to the shared `ExtractionEnvelope` so both the search-ai workflow worker
 * branch and the (future) connector body downstream consume an identical
 * cross-provider shape.
 *
 * Pure function; no side effects.
 */

import {
  ExtractionEnvelopeSchema,
  type ExtractionEnvelope,
  type ExtractionPage,
} from '../extraction-envelope.js';

/** Wire shape of the Docling Python service's `/extract` response. */
export interface DoclingNativeResponse {
  pages: Array<{
    pageNumber: number;
    text: string;
    layout?: {
      headings?: Array<{ level: number; text: string; bbox?: unknown }>;
      structure?: unknown;
    };
    tables: Array<{
      rows: string[][];
      headers?: string[];
      html?: string;
      markdown: string;
      bbox?: unknown;
      isComplete?: boolean;
    }>;
    images: Array<{ data: string; format: string; bbox?: unknown }>;
    screenshot?: string | null;
  }>;
  metadata: {
    pageCount: number;
    hasOCR?: boolean;
    totalTables?: number;
    totalImages?: number;
    processingTime?: number;
    documentType?: string;
    language?: string;
    languageConfidence?: number;
    languageScript?: string;
    languageDetectionMethod?: string;
    secondaryLanguages?: Array<{ lang: string; confidence: number }>;
  };
  structure?: {
    outline?: unknown[];
    documentType?: string;
  };
}

export interface NormalizeOptions {
  sourceUrl: string;
  /** Optional explicit content-type override; falls back to documentType-derived. */
  contentType?: string;
  /** Include the provider-native response under `envelope.raw` for debugging. */
  includeRaw?: boolean;
}

/** Map a Docling-native response into the canonical `ExtractionEnvelope`. */
export function normalizeDoclingToEnvelope(
  response: DoclingNativeResponse,
  options: NormalizeOptions,
): ExtractionEnvelope {
  const pages: ExtractionPage[] = response.pages.map<ExtractionPage>((p) => ({
    pageNumber: p.pageNumber,
    text: p.text,
    tables: p.tables.map((t) => ({
      rows: t.rows,
      markdown: t.markdown,
      ...(isBbox(t.bbox) ? { bbox: t.bbox } : {}),
    })),
    images: p.images.map((img) => ({
      format: img.format,
      base64: img.data,
      ...(isBbox(img.bbox) ? { bbox: img.bbox } : {}),
    })),
    headings: p.layout?.headings?.map((h) => ({ level: h.level, text: h.text })) ?? [],
  }));

  const markdown = pages.map((p) => `# Page ${p.pageNumber}\n\n${p.text}`).join('\n\n---\n\n');

  const envelope: ExtractionEnvelope = {
    schemaVersion: 1,
    provider: 'docling',
    sourceUrl: options.sourceUrl,
    contentType: options.contentType ?? deriveContentType(response),
    markdown,
    pages,
    metadata: {
      pageCount: response.metadata.pageCount,
      ...(response.metadata.language ? { language: response.metadata.language } : {}),
      ...(response.metadata.languageConfidence !== undefined
        ? { languageConfidence: response.metadata.languageConfidence }
        : {}),
      ...(response.metadata.hasOCR !== undefined ? { hasOCR: response.metadata.hasOCR } : {}),
      ...(response.metadata.processingTime !== undefined
        ? {
            // Docling reports `metadata.processingTime` as a float in seconds
            // (e.g. 87.304); the envelope schema expects a non-negative integer
            // count of milliseconds. Convert seconds -> ms then round so the
            // field's name and value agree.
            processingTimeMs: Math.round(response.metadata.processingTime * 1000),
          }
        : {}),
    },
    ...(options.includeRaw ? { raw: response } : {}),
  };

  // Validate the produced envelope so downstream consumers never see a
  // malformed shape. The Zod parse is cheap (envelope is bounded by the
  // inline-cap before reaching here) and surfaces normalizer bugs at the
  // boundary rather than at consume-time.
  return ExtractionEnvelopeSchema.parse(envelope);
}

function deriveContentType(response: DoclingNativeResponse): string {
  const docType = response.metadata.documentType ?? response.structure?.documentType;
  switch ((docType ?? '').toLowerCase()) {
    case 'pdf':
      return 'application/pdf';
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';
    case 'pptx':
      return 'application/vnd.openxmlformats-officedocument.presentationml.presentation';
    case 'xlsx':
      return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
    case 'html':
      return 'text/html';
    case 'md':
    case 'markdown':
      return 'text/markdown';
    case 'txt':
    case 'text':
      return 'text/plain';
    default:
      return 'application/octet-stream';
  }
}

function isBbox(value: unknown): value is [number, number, number, number] {
  return (
    Array.isArray(value) &&
    value.length === 4 &&
    value.every((n): n is number => typeof n === 'number' && Number.isFinite(n))
  );
}
