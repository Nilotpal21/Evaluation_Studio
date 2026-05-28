/**
 * Static Vocabulary Aliases for Document Upload Fields
 *
 * Pre-defined aliases for core document metadata fields.
 * NO LLM - these are hardcoded mappings for natural language query support.
 *
 * Only includes ~15 core fields commonly used for document management.
 * Custom fields get auto-generated basic entries (field name only, no rich aliases).
 */

export interface DocumentFieldVocabulary {
  fieldRef: string;
  term: string;
  aliases: string[];
  description: string;
}

/**
 * Core document fields with rich aliases.
 * These fields get vocabulary entries with pre-defined synonyms.
 */
export const DOCUMENT_FIELD_VOCABULARY: DocumentFieldVocabulary[] = [
  // ── Tier 1: Essential (always shown in form) ────────────────────────────
  {
    fieldRef: 'mime_type',
    term: 'MIME Type',
    aliases: ['file type', 'document type', 'format', 'extension', 'file format'],
    description:
      'Document format / MIME type (e.g., application/pdf, text/csv, application/json). Use this field to filter by file format like PDF, CSV, JSON, DOCX.',
  },
  {
    fieldRef: 'source_type',
    term: 'Source Type',
    aliases: ['source', 'connector', 'data source', 'origin', 'source name'],
    description:
      'The source or connector that provided this document (e.g., SharePoint, Confluence, manual upload, web crawl)',
  },
  {
    fieldRef: 'author',
    term: 'Author',
    aliases: ['creator', 'written by', 'created by', 'uploaded by', 'owner', 'writer'],
    description: 'Person who created or uploaded the document',
  },
  {
    fieldRef: 'category',
    term: 'Category',
    aliases: ['type', 'classification', 'document category', 'kind', 'class'],
    description: 'Document category or classification',
  },
  {
    fieldRef: 'tags',
    term: 'Tags',
    aliases: ['labels', 'keywords', 'topics', 'tag', 'label'],
    description: 'Tags or labels for organization and search',
  },
  {
    fieldRef: 'department',
    term: 'Department',
    aliases: ['team', 'division', 'org', 'organization', 'business unit', 'group'],
    description: 'Department or team that owns the document',
  },

  // ── Tier 2: Common (shown if previously used) ──────────────────────────
  {
    fieldRef: 'project',
    term: 'Project',
    aliases: ['project name', 'initiative', 'program', 'project id'],
    description: 'Project or initiative the document belongs to',
  },
  {
    fieldRef: 'status',
    term: 'Status',
    aliases: ['state', 'document status', 'workflow status', 'stage'],
    description: 'Current status of the document',
  },
  {
    fieldRef: 'priority',
    term: 'Priority',
    aliases: ['importance', 'urgency', 'priority level', 'criticality'],
    description: 'Priority or importance level',
  },
  {
    fieldRef: 'description',
    term: 'Description',
    aliases: ['summary', 'overview', 'about', 'abstract'],
    description: 'Brief description or summary',
  },
  {
    fieldRef: 'modified_by',
    term: 'Modified By',
    aliases: ['last edited by', 'updated by', 'editor', 'last editor'],
    description: 'Person who last modified the document',
  },

  // ── Tier 3: Optional (available via "Add More Fields") ─────────────────
  {
    fieldRef: 'assignee',
    term: 'Assignee',
    aliases: ['assigned to', 'owner', 'responsible person', 'assigned'],
    description: 'Person assigned to this document',
  },
  {
    fieldRef: 'due_date',
    term: 'Due Date',
    aliases: ['deadline', 'expiry date', 'expires', 'due by', 'expiration'],
    description: 'Due date or expiration date',
  },
  {
    fieldRef: 'version',
    term: 'Version',
    aliases: ['revision', 'document version', 'v', 'ver'],
    description: 'Document version number',
  },
  {
    fieldRef: 'access_level',
    term: 'Access Level',
    aliases: ['confidentiality', 'security level', 'classification', 'access'],
    description: 'Access or confidentiality level',
  },
  {
    fieldRef: 'language',
    term: 'Language',
    aliases: ['document language', 'lang', 'locale', 'language code'],
    description: 'Primary language of the document',
  },
];

/**
 * Get vocabulary definition by field reference.
 * Returns null if field is not in the core vocabulary (will be auto-generated).
 */
export function getDocumentFieldVocabulary(fieldRef: string): DocumentFieldVocabulary | null {
  return DOCUMENT_FIELD_VOCABULARY.find((v) => v.fieldRef === fieldRef) || null;
}

/**
 * Get all field refs that have pre-defined vocabulary.
 */
export function getDocumentVocabularyFieldRefs(): string[] {
  return DOCUMENT_FIELD_VOCABULARY.map((v) => v.fieldRef);
}

/**
 * Check if a field has pre-defined vocabulary (core field).
 */
export function hasDocumentVocabulary(fieldRef: string): boolean {
  return DOCUMENT_FIELD_VOCABULARY.some((v) => v.fieldRef === fieldRef);
}
