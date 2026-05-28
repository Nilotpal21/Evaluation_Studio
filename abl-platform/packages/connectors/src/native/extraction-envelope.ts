/**
 * Shared `ExtractionEnvelope` Zod schema + types (LLD §1).
 *
 * Both the native Docling connector (workflow-path) and the Activepieces-format
 * Azure Document Intelligence piece (Phase 3) normalize their provider-native
 * extraction responses into this canonical envelope so workflow nodes
 * downstream can consume either provider's output without rewiring.
 *
 * `schemaVersion: 1` — additive fields are backward-compatible; renames or
 * removals require a version bump.
 */

import { z } from 'zod';

export const ExtractionTableSchema = z.object({
  rows: z.array(z.array(z.string())),
  markdown: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

export const ExtractionImageSchema = z.object({
  format: z.string(),
  base64: z.string(),
  bbox: z.tuple([z.number(), z.number(), z.number(), z.number()]).optional(),
});

export const ExtractionHeadingSchema = z.object({
  level: z.number().int(),
  text: z.string(),
});

export const ExtractionPageSchema = z.object({
  pageNumber: z.number().int().min(1),
  text: z.string(),
  tables: z.array(ExtractionTableSchema).default([]),
  images: z.array(ExtractionImageSchema).default([]),
  headings: z.array(ExtractionHeadingSchema).default([]),
});

export const ExtractionEnvelopeMetadataSchema = z.object({
  pageCount: z.number().int().min(0),
  language: z.string().optional(),
  languageConfidence: z.number().min(0).max(1).optional(),
  hasOCR: z.boolean().optional(),
  title: z.string().optional(),
  author: z.string().optional(),
  processingTimeMs: z.number().int().min(0).optional(),
});

export const ExtractionEnvelopeSchema = z.object({
  schemaVersion: z.literal(1),
  provider: z.enum(['docling', 'azure-document-intelligence']),
  sourceUrl: z.string().url(),
  contentType: z.string().min(1),
  markdown: z.string(),
  pages: z.array(ExtractionPageSchema),
  metadata: ExtractionEnvelopeMetadataSchema,
  /** Optional pass-through of the provider-native response for debugging. */
  raw: z.unknown().optional(),
});

export type ExtractionTable = z.infer<typeof ExtractionTableSchema>;
export type ExtractionImage = z.infer<typeof ExtractionImageSchema>;
export type ExtractionHeading = z.infer<typeof ExtractionHeadingSchema>;
export type ExtractionPage = z.infer<typeof ExtractionPageSchema>;
export type ExtractionEnvelopeMetadata = z.infer<typeof ExtractionEnvelopeMetadataSchema>;
export type ExtractionEnvelope = z.infer<typeof ExtractionEnvelopeSchema>;
