/**
 * DSL Field Utilities
 *
 * Extract and update scalar field values in ABL DSL content.
 * Handles quoted strings, pipe (|) multiline, and plain values.
 */

export interface FieldRange {
  /** Field name (e.g. "PERSONA", "GOAL") */
  name: string;
  /** 1-based line number of the field header */
  headerLine: number;
  /** 1-based line number of the last line of the field value */
  endLine: number;
  /** Extracted plain-text value */
  value: string;
}

// ============================================================================
// Helper Functions
// ============================================================================

/** Get the indentation level of a line (number of leading spaces/tabs) */
function getLineIndent(line: string): number {
  return line.length - line.trimStart().length;
}

/** Remove surrounding quotes from a string value */
function removeQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** Escape double quotes in a string for YAML output */
function escapeQuotes(value: string): string {
  return value.replace(/"/g, '\\"');
}

/** Extract value from a quoted string (handles both single and double quotes) */
function extractQuotedValue(rest: string): string {
  const quote = rest[0];
  const endIdx = rest.lastIndexOf(quote);
  return endIdx > 0 ? rest.slice(1, endIdx) : rest.slice(1);
}

/**
 * Known fields that are ALWAYS markdown-editable (explicit allow-list).
 * These fields are commonly multi-line string fields that benefit from rich editing.
 *
 * Note: LIMITATIONS is NOT included because it's typically a list structure (array),
 * not a multiline text field. If a field uses block scalar (|) syntax for long text,
 * it will be auto-detected by the content-based logic.
 */
const KNOWN_MARKDOWN_FIELDS = ['PERSONA', 'GOAL'] as const;
export type MarkdownField = (typeof KNOWN_MARKDOWN_FIELDS)[number];

/**
 * Check if a field should use the markdown editor.
 *
 * Uses hybrid detection:
 * 1. Explicit allow-list (PERSONA, GOAL)
 * 2. Auto-detect: multi-line content (contains newlines)
 * 3. Auto-detect: long single-line content (>80 chars)
 *
 * This allows any field with significant text content to use rich editing,
 * while maintaining explicit support for commonly-used fields.
 *
 * @param name - Field name (e.g., "PERSONA", "GOAL", "DESCRIPTION")
 * @param value - Optional field value for content-based detection
 */
export function isMarkdownField(name: string, value?: string): boolean {
  const upperName = name.toUpperCase();

  // Explicit allow-list
  if (KNOWN_MARKDOWN_FIELDS.includes(upperName as MarkdownField)) {
    return true;
  }

  // Content-based auto-detection
  if (value) {
    // Multi-line content
    if (value.includes('\n')) return true;

    // Long single-line content
    if (value.length > 80) return true;
  }

  return false;
}

/**
 * Find all markdown-editable fields in DSL content.
 * Returns their positions and extracted values.
 *
 * Uses hybrid detection:
 * - Known text fields (PERSONA, GOAL) are always included
 * - Any field with block scalar syntax (|) is auto-detected
 * - Any field with multi-line or long content (>80 chars) is auto-detected
 *
 * This enables rich editing for any field with significant text content,
 * automatically adapting to new fields without code changes.
 */
export function findMarkdownFields(dsl: string): FieldRange[] {
  const lines = dsl.split('\n');
  const fields: FieldRange[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    // Match top-level field (no indent) like PERSONA:, GOAL:, etc.
    const match = line.match(/^([A-Z][A-Z_]*)\s*:\s*(.*)/);
    if (!match) continue;

    const name = match[1];
    const rest = match[2].trim();
    const headerLine = i + 1; // 1-based

    let value = '';
    let endLine = headerLine;

    if (rest === '|' || rest === '>') {
      // Block scalar — collect indented lines
      const result = extractBlockScalar(lines, i + 1);
      value = result.value;
      endLine = result.endLineIdx + 1;
    } else if (rest.startsWith('"') || rest.startsWith("'")) {
      value = extractQuotedValue(rest);
    } else if (rest) {
      value = rest;
    }

    // Apply hybrid detection: include if it's a known field OR has markdown-worthy content
    if (isMarkdownField(name, value)) {
      fields.push({ name, headerLine, endLine, value });
    }
  }

  return fields;
}

/**
 * Extract a block scalar value (lines after `|` or `>` with consistent indent).
 */
function extractBlockScalar(
  lines: string[],
  startIdx: number,
): { value: string; endLineIdx: number } {
  const collected: string[] = [];
  let endLineIdx = startIdx - 1;
  let baseIndent = -1;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      collected.push('');
      endLineIdx = i;
      continue;
    }

    const indent = getLineIndent(line);
    if (indent === 0) break; // Hit next top-level key
    if (baseIndent === -1) baseIndent = indent;
    if (indent < baseIndent) break; // Dedented past block

    collected.push(line.slice(baseIndent));
    endLineIdx = i;
  }

  // Trim trailing empty lines
  while (collected.length > 0 && collected[collected.length - 1] === '') {
    collected.pop();
  }

  return { value: collected.join('\n'), endLineIdx };
}

/**
 * Extract list items (lines starting with '-' after a field header).
 * Converts YAML list format to plain text for markdown editing.
 * Example:
 *   - "Item 1"
 *   - "Item 2"
 * Returns: ["Item 1", "Item 2"]
 */
function extractListItems(
  lines: string[],
  startIdx: number,
): { items: string[]; endLineIdx: number } {
  const items: string[] = [];
  let endLineIdx = startIdx - 1;

  for (let i = startIdx; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (trimmed === '') {
      endLineIdx = i;
      continue;
    }

    const indent = getLineIndent(line);
    if (indent === 0) break; // Hit next top-level key

    if (trimmed.startsWith('- ')) {
      const value = removeQuotes(trimmed.substring(2));
      items.push(value);
      endLineIdx = i;
    } else {
      break; // Not a list item
    }
  }

  return { items, endLineIdx };
}

/**
 * Sections that contain structured data (not editable as markdown text).
 * These are skipped by findFieldAtLine since they use sub-structures (tools, flows, etc).
 */
const STRUCTURED_SECTIONS = new Set([
  'TOOLS',
  'GATHER',
  'FLOW',
  'STEPS',
  'HANDOFF',
  'DELEGATE',
  'TEMPLATES',
  'MEMORY',
  'CONSTRAINTS',
  'GUARDRAILS',
  'ESCALATE',
  'ESCALATION',
  'ON_ERROR',
  'COMPLETE',
  'ON_START',
  'EXECUTION',
  'HOOKS',
  'NLU',
]);

/**
 * Find the top-level field that encloses the given cursor line.
 * Returns the field range if it's a text field (not a structured section).
 * Used by the markdown editor to edit GOAL, PERSONA, DESCRIPTION, LIMITATIONS, etc.
 */
export function findFieldAtLine(dsl: string, cursorLine: number): FieldRange | null {
  const lines = dsl.split('\n');

  // Scan backwards to find the enclosing top-level field
  let fieldIdx = -1;
  for (let i = cursorLine - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line || line.length === 0) continue;
    if (line[0] !== ' ' && line[0] !== '\t') {
      const match = line.match(/^([A-Z][A-Z_]*)\s*:/i);
      if (match) {
        fieldIdx = i;
        break;
      }
    }
  }

  if (fieldIdx === -1) return null;

  const line = lines[fieldIdx];
  const match = line.match(/^([A-Z][A-Z_]*)\s*:\s*(.*)/i);
  if (!match) return null;

  const name = match[1].toUpperCase();
  const rest = match[2].trim();
  const headerLine = fieldIdx + 1;

  // Skip structured sections — they aren't text fields
  if (STRUCTURED_SECTIONS.has(name)) return null;

  let value = '';
  let endLine = headerLine;

  if (rest === '|' || rest === '>') {
    const result = extractBlockScalar(lines, fieldIdx + 1);
    value = result.value;
    endLine = result.endLineIdx + 1;
  } else if (rest.startsWith('"') || rest.startsWith("'")) {
    value = extractQuotedValue(rest);
  } else if (rest) {
    value = rest;
  } else {
    // Empty value after colon — might be a list structure
    const listResult = extractListItems(lines, fieldIdx + 1);
    if (listResult.items.length > 0) {
      value = listResult.items.join('\n');
      endLine = listResult.endLineIdx + 1;
    }
  }

  return { name, headerLine, endLine, value };
}

/**
 * Build the replacement text for a field value in DSL.
 * - List fields (LIMITATIONS) → YAML list format with quoted items
 * - Short values → quoted string on same line
 * - Multi-line or long values → pipe (|) block scalar
 */
export function formatFieldValue(fieldName: string, value: string): string {
  const trimmed = value.trim();
  const upperName = fieldName.toUpperCase();

  // List fields (LIMITATIONS, etc.) — format as YAML list
  if (upperName === 'LIMITATIONS' && trimmed.includes('\n')) {
    const items = trimmed
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

    const listItems = items.map((item) => `  - "${escapeQuotes(item)}"`).join('\n');
    return `${fieldName}:\n${listItems}`;
  }

  // Multi-line or long text values → block scalar
  if (trimmed.includes('\n') || trimmed.length > 80) {
    const indented = trimmed
      .split('\n')
      .map((line) => (line.trim() === '' ? '' : `  ${line}`))
      .join('\n');
    return `${fieldName}: |\n${indented}`;
  }

  // Short single-line value → quoted string
  return `${fieldName}: "${escapeQuotes(trimmed)}"`;
}

/**
 * Update a field's value in the DSL content string.
 * Returns the new DSL content.
 */
export function updateFieldInDSL(dsl: string, field: FieldRange, newValue: string): string {
  const lines = dsl.split('\n');
  const replacement = formatFieldValue(field.name, newValue);
  const replacementLines = replacement.split('\n');

  // Replace from headerLine to endLine (0-based indices)
  const startIdx = field.headerLine - 1;
  const endIdx = field.endLine - 1;
  const deleteCount = endIdx - startIdx + 1;

  lines.splice(startIdx, deleteCount, ...replacementLines);
  return lines.join('\n');
}
