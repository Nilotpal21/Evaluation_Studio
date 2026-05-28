/**
 * Available Canonical Fields
 *
 * Reference list of all canonical field slots available in the OpenSearch index.
 * Used by the LLM mapping service to know what fields can be mapped TO,
 * independent of the CanonicalSchema document (which tracks only configured fields).
 *
 * Must stay in sync with opensearch-mappings.ts canonical.properties.
 */

import type { ICanonicalField } from '@agent-platform/database/models';

/** Minimal canonical field info for LLM prompt building */
export interface AvailableCanonicalField {
  storageField: string;
  type: string;
  label: string;
  category: 'core' | 'common' | 'custom';
}

// ── 15 Core fields (always populated) ────────────────────────────────────

const CORE_FIELDS: AvailableCanonicalField[] = [
  { storageField: 'title', type: 'text', label: 'Title', category: 'core' },
  { storageField: 'content_summary', type: 'text', label: 'Content Summary', category: 'core' },
  {
    storageField: 'source_type',
    type: 'keyword',
    label: 'Source / Connector Type',
    category: 'core',
  },
  { storageField: 'source_url', type: 'keyword', label: 'Source URL', category: 'core' },
  { storageField: 'created_date', type: 'date', label: 'Created Date', category: 'core' },
  { storageField: 'modified_date', type: 'date', label: 'Modified Date', category: 'core' },
  { storageField: 'author', type: 'keyword', label: 'Author', category: 'core' },
  { storageField: 'access_level', type: 'keyword', label: 'Access Level', category: 'core' },
  { storageField: 'language', type: 'keyword', label: 'Language', category: 'core' },
  { storageField: 'mime_type', type: 'keyword', label: 'MIME Type', category: 'core' },
  { storageField: 'status', type: 'keyword', label: 'Status', category: 'core' },
  { storageField: 'category', type: 'keyword', label: 'Category', category: 'core' },
];

// ── 25 Common fields (populated when available) ──────────────────────────

const COMMON_FIELDS: AvailableCanonicalField[] = [
  { storageField: 'description', type: 'text', label: 'Description', category: 'common' },
  { storageField: 'tags', type: 'keyword', label: 'Tags', category: 'common' },
  { storageField: 'priority', type: 'float', label: 'Priority', category: 'common' },
  { storageField: 'assignee', type: 'keyword', label: 'Assignee', category: 'common' },
  { storageField: 'reporter', type: 'keyword', label: 'Reporter', category: 'common' },
  { storageField: 'modified_by', type: 'keyword', label: 'Modified By', category: 'common' },
  { storageField: 'department', type: 'keyword', label: 'Department', category: 'common' },
  { storageField: 'project', type: 'keyword', label: 'Project', category: 'common' },
  { storageField: 'version', type: 'keyword', label: 'Version', category: 'common' },
  { storageField: 'parent_id', type: 'keyword', label: 'Parent ID', category: 'common' },
  { storageField: 'due_date', type: 'date', label: 'Due Date', category: 'common' },
  { storageField: 'resolved_date', type: 'date', label: 'Resolved Date', category: 'common' },
  {
    storageField: 'attachment_count',
    type: 'integer',
    label: 'Attachment Count',
    category: 'common',
  },
  { storageField: 'comment_count', type: 'integer', label: 'Comment Count', category: 'common' },
  { storageField: 'is_archived', type: 'boolean', label: 'Is Archived', category: 'common' },
  { storageField: 'severity', type: 'keyword', label: 'Severity', category: 'common' },
  { storageField: 'resolution', type: 'keyword', label: 'Resolution', category: 'common' },
  { storageField: 'component', type: 'keyword', label: 'Component', category: 'common' },
  { storageField: 'label', type: 'keyword', label: 'Label', category: 'common' },
  { storageField: 'story_points', type: 'float', label: 'Story Points', category: 'common' },
  { storageField: 'sprint', type: 'keyword', label: 'Sprint', category: 'common' },
  { storageField: 'epic', type: 'keyword', label: 'Epic', category: 'common' },
  { storageField: 'environment', type: 'keyword', label: 'Environment', category: 'common' },
  { storageField: 'customer', type: 'keyword', label: 'Customer', category: 'common' },
  { storageField: 'deal_amount', type: 'float', label: 'Deal Amount', category: 'common' },
  { storageField: 'stage', type: 'keyword', label: 'Stage', category: 'common' },
];

// ── 40 Custom slots ──────────────────────────────────────────────────────

function generateCustomFields(): AvailableCanonicalField[] {
  const fields: AvailableCanonicalField[] = [];
  for (let i = 1; i <= 20; i++) {
    fields.push({
      storageField: `custom_string_${i}`,
      type: 'keyword',
      label: `Custom String ${i}`,
      category: 'custom',
    });
  }
  for (let i = 1; i <= 10; i++) {
    fields.push({
      storageField: `custom_number_${i}`,
      type: 'float',
      label: `Custom Number ${i}`,
      category: 'custom',
    });
  }
  for (let i = 1; i <= 5; i++) {
    fields.push({
      storageField: `custom_date_${i}`,
      type: 'date',
      label: `Custom Date ${i}`,
      category: 'custom',
    });
  }
  for (let i = 1; i <= 5; i++) {
    fields.push({
      storageField: `custom_bool_${i}`,
      type: 'boolean',
      label: `Custom Bool ${i}`,
      category: 'custom',
    });
  }
  return fields;
}

/** All available canonical fields (core + common + custom slots) */
export const AVAILABLE_CANONICAL_FIELDS: readonly AvailableCanonicalField[] = [
  ...CORE_FIELDS,
  ...COMMON_FIELDS,
  ...generateCustomFields(),
];

/**
 * Convert an AvailableCanonicalField to ICanonicalField format
 * for use in LLM prompts and field creation.
 */
export function toCanonicalField(field: AvailableCanonicalField): ICanonicalField {
  // source_url should not be filterable - it's an internal path, not useful for end users
  const isFilterable =
    field.storageField !== 'source_url' &&
    (field.type === 'keyword' || field.type === 'date' || field.type === 'boolean');

  return {
    name: field.label,
    label: field.label,
    type: field.type,
    storageField: field.storageField,
    indexed: true,
    filterable: isFilterable,
    aggregatable: field.type === 'keyword',
    sortable:
      field.type === 'keyword' ||
      field.type === 'date' ||
      field.type === 'float' ||
      field.type === 'integer',
  };
}

/**
 * Get all available canonical fields as ICanonicalField[] for LLM prompt.
 * Only includes core + common fields (not custom slots) to keep prompt focused.
 */
export function getAvailableFieldsForLLM(): ICanonicalField[] {
  return [...CORE_FIELDS, ...COMMON_FIELDS].map(toCanonicalField);
}

/**
 * Look up an available canonical field by storage field name.
 */
export function getAvailableField(storageField: string): AvailableCanonicalField | undefined {
  return AVAILABLE_CANONICAL_FIELDS.find((f) => f.storageField === storageField);
}
