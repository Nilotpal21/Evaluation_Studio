/**
 * Document Upload Vocabulary Seeder
 *
 * Seeds static vocabulary entries for essential document fields at KB creation time.
 * These entries give the LLM context about what fields exist and how to use them
 * for filtering/aggregation — without requiring connector-based vocabulary generation.
 *
 * For connector-backed KBs, the LLM-based vocabulary-generation-worker will later
 * replace/augment these auto-generated entries with richer, connector-specific terms.
 */

import { createLogger } from '@abl/compiler/platform';
import { getLazyModel } from '../db/index.js';
import type { IDomainVocabulary, IVocabularyEntry } from '@agent-platform/database/models';
import { uuidv7 } from '@agent-platform/database/mongo';

const DomainVocabulary = getLazyModel<IDomainVocabulary>('DomainVocabulary');
const logger = createLogger('document-upload-vocabulary-seeder');

/**
 * Minimal default vocabulary for document upload KBs.
 *
 * Only mime_type is seeded by default — it enables filtering/aggregation by
 * document format (PDF, DOCX, etc.) without requiring user action.
 *
 * Additional fields (author, department, tags, etc.) are added DYNAMICALLY
 * when the user fills them during upload via generateDocumentVocabularyEntries().
 * This keeps the vocabulary clean — no empty/unused entries.
 */
export const DOCUMENT_UPLOAD_VOCABULARY: Omit<
  IVocabularyEntry,
  'id' | 'createdAt' | 'updatedAt'
>[] = [
  {
    term: 'title',
    aliases: ['document title', 'name', 'file name'],
    description: 'The title or name of the document',
    fieldRef: 'title',
    capabilities: { canFilter: false, canDisplay: true, canAggregate: false, canSort: true },
    relatedFields: { displayWith: ['author', 'mime_type', 'created_date'], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'author',
    aliases: ['creator', 'written by', 'uploaded by'],
    description: 'The author or creator of the document',
    fieldRef: 'author',
    capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: true },
    relatedFields: { displayWith: ['title', 'created_date'], aggregateWith: ['mime_type'] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'mime type',
    aliases: ['file type', 'document type', 'format', 'file format', 'extension'],
    description:
      'Document format / MIME type field. Use for filtering by file format (PDF, CSV, JSON, etc.)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: false },
    relatedFields: { displayWith: ['title', 'source_type'], aggregateWith: ['language'] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  // ── MIME type value entries ────────────────────────────────────────────
  // These are "value-type" entries: term ≠ fieldRef, so the static vocabulary
  // resolver uses the term itself as the filter value.
  // e.g. "pdf documents" → matches alias "pdf" → filter: mime_type = "application/pdf"
  {
    term: 'application/pdf',
    aliases: ['pdf', 'pdf file', 'pdf files', 'pdf documents', 'pdf document'],
    description: 'PDF documents (application/pdf)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'text/csv',
    aliases: ['csv', 'csv file', 'csv files', 'csv documents', 'spreadsheet csv'],
    description: 'CSV files (text/csv)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'application/json',
    aliases: ['json', 'json file', 'json files', 'json documents'],
    description: 'JSON files (application/json)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    aliases: ['docx', 'docx file', 'word', 'word document', 'word documents'],
    description: 'Word documents (DOCX)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    aliases: ['xlsx', 'xlsx file', 'excel', 'excel file', 'excel documents', 'spreadsheet'],
    description: 'Excel spreadsheets (XLSX)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'text/html',
    aliases: ['html', 'html file', 'web page', 'webpage', 'html documents'],
    description: 'HTML web pages (text/html)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'text/markdown',
    aliases: ['markdown', 'md', 'markdown file', 'markdown documents'],
    description: 'Markdown files (text/markdown)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'text/plain',
    aliases: ['text', 'txt', 'text file', 'plain text', 'text documents'],
    description: 'Plain text files (text/plain)',
    fieldRef: 'mime_type',
    capabilities: { canFilter: true, canDisplay: false, canAggregate: false, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
  {
    term: 'source type',
    aliases: ['source', 'connector', 'data source', 'origin'],
    description:
      'The source or connector that provided this document (e.g., SharePoint, Confluence, manual upload, web crawl)',
    fieldRef: 'source_type',
    capabilities: { canFilter: true, canDisplay: true, canAggregate: true, canSort: false },
    relatedFields: { displayWith: [], aggregateWith: [] },
    enabled: true,
    confidence: 1.0,
    generatedBy: 'auto',
  },
];

/**
 * Seed document metadata vocabulary on first real document upload.
 *
 * Called lazily when a real document (PDF, DOCX, etc.) is uploaded — NOT at
 * KB creation time. This avoids polluting JSON/product KBs with irrelevant
 * document metadata fields like source_type, author, mime_type.
 *
 * Content-aware merging:
 *   - No vocabulary exists → creates with document metadata entries
 *   - Vocabulary exists (from JSON/connector) → merges document metadata
 *     alongside existing entries (skips if already present)
 *
 * Idempotent: skips if document metadata fields already present.
 */
export async function seedDocumentUploadVocabulary(
  tenantId: string,
  knowledgeBaseId: string,
): Promise<void> {
  try {
    const existing = await DomainVocabulary.findOne({
      projectKnowledgeBaseId: knowledgeBaseId,
      tenantId,
    });

    const docEntries: IVocabularyEntry[] = DOCUMENT_UPLOAD_VOCABULARY.map((entry) => ({
      ...entry,
      id: uuidv7(),
    }));

    // Field refs we want to add
    const docFieldRefs = docEntries.map((e) => e.fieldRef);

    if (existing) {
      // Check if document metadata fields are already present
      const existingFieldRefs = existing.entries.map((e: IVocabularyEntry) => e.fieldRef);
      const hasDocFields = docFieldRefs.some((ref) => existingFieldRefs.includes(ref));

      if (hasDocFields) {
        logger.info('Document metadata vocabulary already present, skipping', {
          knowledgeBaseId,
          existingEntryCount: existing.entries.length,
        });
        return;
      }

      // Merge: add document metadata alongside existing (JSON/connector) entries
      existing.entries = [...existing.entries, ...docEntries];
      existing.version += 1;
      existing.updatedAt = new Date();
      await existing.save();

      logger.info('Merged document metadata vocabulary with existing entries', {
        knowledgeBaseId,
        addedCount: docEntries.length,
        totalCount: existing.entries.length,
      });
    } else {
      // No vocabulary yet — create with document metadata entries
      await DomainVocabulary.create({
        tenantId,
        projectKnowledgeBaseId: knowledgeBaseId,
        version: 1,
        status: 'active',
        entries: docEntries,
      });

      logger.info('Seeded document metadata vocabulary on first document upload', {
        knowledgeBaseId,
        entryCount: docEntries.length,
      });
    }
  } catch (error) {
    // Non-fatal: KB works without vocabulary, just with reduced LLM context
    logger.warn('Failed to seed document upload vocabulary', {
      error: error instanceof Error ? error.message : String(error),
      knowledgeBaseId,
    });
  }
}
