/**
 * Inline copies of `ExtractionEnvelope` + `AzureDocumentIntelligenceServices`.
 *
 * Why duplicate: the piece is a workspace package consumed lazily by
 * `@agent-platform/connectors`. If it `import`ed from there we'd hit a Turbo
 * package-graph cycle (connectors → piece → connectors). The piece's output
 * shape is structurally compatible with `@agent-platform/connectors`'s
 * exported types — downstream consumers do not need to re-validate.
 *
 * Schema version is pinned to `1` (LLD §1). If the canonical schema bumps
 * version, this file must be updated in lock-step.
 */

export interface ExtractionTable {
  rows: string[][];
  markdown: string;
  bbox?: [number, number, number, number];
}

export interface ExtractionImage {
  format: string;
  base64: string;
  bbox?: [number, number, number, number];
}

export interface ExtractionHeading {
  level: number;
  text: string;
}

export interface ExtractionPage {
  pageNumber: number;
  text: string;
  tables: ExtractionTable[];
  images: ExtractionImage[];
  headings: ExtractionHeading[];
}

export interface ExtractionEnvelopeMetadata {
  pageCount: number;
  language?: string;
  languageConfidence?: number;
  hasOCR?: boolean;
  title?: string;
  author?: string;
  processingTimeMs?: number;
}

export interface ExtractionEnvelope {
  schemaVersion: 1;
  provider: 'docling' | 'azure-document-intelligence';
  sourceUrl: string;
  contentType: string;
  markdown: string;
  pages: ExtractionPage[];
  metadata: ExtractionEnvelopeMetadata;
  raw?: unknown;
}

/**
 * Mirrors `@agent-platform/connectors`'s `AzureDocumentIntelligenceServices`.
 * The workflow-engine populates this; the piece reads the structural shape.
 */
export interface AzureDocumentIntelligenceServices {
  checkUsage(connectionId: string): Promise<{
    usageCount: number;
    usageSoftCap: number | null;
    usageHardCap: number | null;
    usagePeriodStart: Date | null;
  } | null>;
  recordUsage(connectionId: string): Promise<{
    usageCount: number;
    usagePeriodStart: Date;
  }>;
  breaker: { execute<T>(fn: () => Promise<T>): Promise<T> };
}
