/**
 * Schema & Field Mapping Types
 *
 * Three-layer schema architecture:
 * Layer 1: Source Schema Discovery (per Connector, sync-time)
 * Layer 2: Canonical Schema Mapping (per KnowledgeBase, ingestion-time)
 * Layer 3: Domain Vocabulary (per ProjectKnowledgeBase, query-time) — see vocabulary.ts
 */

import type { SchemaStatus, MappingStatus, SchemaChangeType, ReviewStatus } from '../constants.js';

// ─── Layer 1: Source Schema (Connector-level) ────────────────────────────────

export const FieldType = {
  STRING: 'string',
  NUMBER: 'number',
  BOOLEAN: 'boolean',
  DATE: 'date',
  DATETIME: 'datetime',
  ENUM: 'enum',
  ARRAY: 'array',
  OBJECT: 'object',
  TEXT: 'text',
  URL: 'url',
  EMAIL: 'email',
  CURRENCY: 'currency',
} as const;
export type FieldType = (typeof FieldType)[keyof typeof FieldType];

export interface ConnectorSchemaField {
  /** Field path in source system (e.g., "customfield_10042") */
  path: string;
  /** Human-readable label (e.g., "Sprint") */
  label: string;
  /** Field data type */
  type: FieldType;
  /** Whether this is a custom field in the source system */
  isCustom: boolean;
  /** Whether this field is required in the source */
  isRequired: boolean;
  /** Allowed values (for enum type) */
  enumValues?: string[];
  /** Sample values for mapping assistance */
  sampleValues?: unknown[];
  /** Nested fields (for object type) */
  children?: ConnectorSchemaField[];
  /** Additional metadata from the source system */
  metadata?: Record<string, unknown>;
}

export interface ConnectorSchemaSummary {
  id: string;
  connectorId: string;
  version: number;
  fieldCount: number;
  customFieldCount: number;
  status: SchemaStatus;
  discoveredAt: string;
}

// ─── Layer 2: Canonical Schema (KnowledgeBase-level) ─────────────────────────

export interface CanonicalField {
  /** Alias name — business-friendly identifier used by agents, vocabulary, and UI */
  name: string;
  /** Human-readable display label */
  label: string;
  /** Data type */
  type: FieldType;
  /** Description for LLM context — helps agents understand field purpose */
  description?: string;
  /** Actual vector store field path under metadata.canonical.* */
  storageField: string;
  /** Whether this field is indexed for structured queries */
  indexed: boolean;
  /** Whether this field is filterable */
  filterable: boolean;
  /** Whether this field can be used in aggregations */
  aggregatable: boolean;
  /** Whether this field can be used for sorting */
  sortable: boolean;
  /** Display value → stored value mapping for enum coercion */
  enumValues?: Record<string, unknown>;
  /** Original connector field path for traceability */
  sourceConnectorField?: string;
}

export interface CanonicalSchemaSummary {
  id: string;
  knowledgeBaseId: string;
  version: number;
  fieldCount: number;
  status: SchemaStatus;
  createdAt: string;
}

// ─── Field Mapping (Source → Canonical) ──────────────────────────────────────

export interface SourceFieldMapping {
  id: string;
  canonicalSchemaId: string;
  canonicalField: string;
  connectorId: string;
  /** Path in the source schema */
  sourcePath: string;
  /** Transform to apply during ingestion */
  transform: FieldTransform;
  /** Confidence score from LLM suggestion (0-1) */
  confidence: number;
  /** Mapping status */
  status: MappingStatus;
  /** Who suggested this mapping */
  suggestedBy: 'llm' | 'user' | 'rule';
  /** Who reviewed/confirmed this mapping */
  reviewedBy?: string;
  reviewedAt?: string;
}

export interface FieldTransform {
  type: TransformType;
  /** For rename_value: mapping of source values to canonical values */
  valueMap?: Record<string, string>;
  /** For extract: regex or JSONPath expression */
  expression?: string;
  /** For coalesce: ordered list of source paths to try */
  sources?: string[];
  /** For compute: expression to evaluate */
  computeExpression?: string;
  /** For date_format: source format string */
  sourceFormat?: string;
  /** For split: delimiter */
  delimiter?: string;
}

export const TransformType = {
  /** Direct mapping (no transformation) */
  DIRECT: 'direct',
  /** Map source enum values to canonical enum values */
  RENAME_VALUE: 'rename_value',
  /** Extract a portion of the source value */
  EXTRACT: 'extract',
  /** Try multiple source paths, use first non-null */
  COALESCE: 'coalesce',
  /** Compute from expression involving multiple fields */
  COMPUTE: 'compute',
  /** Reformat date/datetime */
  DATE_FORMAT: 'date_format',
  /** Convert to lowercase */
  LOWERCASE: 'lowercase',
  /** Split a single field into array */
  SPLIT: 'split',
} as const;
export type TransformType = (typeof TransformType)[keyof typeof TransformType];

// ─── Schema Change Detection ─────────────────────────────────────────────────

export interface SchemaChange {
  id: string;
  connectorId: string;
  schemaVersion: number;
  changeType: SchemaChangeType;
  /** Dot-path to the changed field */
  fieldPath: string;
  previousValue?: unknown;
  newValue?: unknown;
  reviewStatus: ReviewStatus;
  /** Whether this change affects existing canonical mappings */
  affectsMapping: boolean;
}
