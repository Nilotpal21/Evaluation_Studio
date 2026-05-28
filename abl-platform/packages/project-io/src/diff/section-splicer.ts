/**
 * Section Splicer — byte-perfect ABL section editing
 *
 * Operates on raw ABL text lines without parsing. Identifies section boundaries
 * and splices content so that untouched sections remain byte-identical.
 *
 * This is the core primitive for clean diffs: when AI tools edit an agent's GOAL,
 * only the GOAL section changes. Git diffs show exactly what changed.
 */

import type { SectionBoundary, SectionEdit } from '../types.js';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('section-splicer');

// ─── Constants ──────────────────────────────────────────────────────────────

/**
 * Canonical ordering of ABL top-level section headers.
 * Used to determine insertion points for new sections.
 */
const SECTION_HEADERS = [
  'AGENT',
  'SUPERVISOR',
  'VERSION',
  'DESCRIPTION',
  'MODE',
  'LANGUAGE',
  'GOAL',
  'PERSONA',
  'IDENTITY',
  'LIMITATIONS',
  'TOOLS',
  'TOOLIMPORTS',
  'GATHER',
  'MEMORY',
  'CONSTRAINTS',
  'GUARDRAILS',
  'FLOW',
  'ACTION_HANDLERS',
  'DELEGATE',
  'HANDOFF',
  'ESCALATE',
  'COMPLETE',
  'ON_ERROR',
  'ON_START',
  'MESSAGES',
  'TEMPLATES',
  'HOOKS',
  'EXECUTION',
  'NLU',
  'VOICE',
  'CONVERSATION',
  'BEHAVIOR',
  'BEHAVIOR_PROFILE',
] as const;

/**
 * Pattern that matches a top-level section header at zero indentation.
 * These are lines like "AGENT:", "GOAL:", "TOOLS:", etc.
 */
const SECTION_HEADER_PATTERN = new RegExp(`^(${SECTION_HEADERS.join('|')}):`, 'i');
const BEHAVIOR_PROFILE_USE_PATTERN = /^USE\s+BEHAVIOR_PROFILE:\s*\S+/i;
const FULL_EDIT_SECTION = 'FULL';

// ─── Core Functions ─────────────────────────────────────────────────────────

/**
 * Identify all top-level section boundaries in ABL content.
 *
 * Scans lines to find section headers (keywords at column 0 followed by `:`)
 * and determines where each section starts and ends.
 *
 * @param content - Raw ABL text content
 * @returns Array of section boundaries sorted by line position
 */
export function identifySections(content: string): SectionBoundary[] {
  // Normalize CRLF to LF for consistent processing
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const sections: SectionBoundary[] = [];
  const seenSections = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(SECTION_HEADER_PATTERN);
    if (match) {
      const sectionName = match[1];
      // Warn on duplicate sections, use first occurrence for editing
      if (seenSections.has(sectionName)) {
        log.warn('Duplicate section found, using first occurrence', {
          section: sectionName,
          line: i + 1,
        });
        continue;
      }
      seenSections.add(sectionName);
      sections.push({
        name: sectionName,
        startLine: i,
        endLine: -1, // will be set below
        headerLine: lines[i],
      });
      continue;
    }

    if (BEHAVIOR_PROFILE_USE_PATTERN.test(lines[i]) && !seenSections.has('BEHAVIOR')) {
      seenSections.add('BEHAVIOR');
      sections.push({
        name: 'BEHAVIOR',
        startLine: i,
        endLine: -1, // will be set below
        headerLine: lines[i],
      });
    }
  }

  // Set endLine for each section: the line before the next section header (or EOF)
  for (let i = 0; i < sections.length; i++) {
    if (i + 1 < sections.length) {
      // Find the last non-empty content line before the next section
      sections[i].endLine = sections[i + 1].startLine - 1;
    } else {
      sections[i].endLine = lines.length - 1;
    }
  }

  return sections;
}

/**
 * Replace, add, or remove a single section in ABL content.
 *
 * - **Replace:** If the section exists and `newContent` is a string, the section
 *   (from header to end) is replaced with `newContent`.
 * - **Remove:** If the section exists and `newContent` is `null`, the section is removed.
 * - **Add:** If the section doesn't exist and `newContent` is a string, it's inserted
 *   at the canonical position based on `SECTION_HEADERS` order.
 *
 * Lines outside the affected section are emitted byte-for-byte as-is.
 *
 * @param originalContent - Full ABL text
 * @param sectionName - Name of the section (e.g., "GOAL", "TOOLS")
 * @param newContent - New section text (including header line) or null to remove
 * @returns Modified ABL text
 */
export function spliceSection(
  originalContent: string,
  sectionName: string,
  newContent: string | null,
): string {
  if (sectionName.toUpperCase() === FULL_EDIT_SECTION) {
    if (newContent === null) {
      return '';
    }
    const hasCRLF = originalContent.includes('\r\n');
    return hasCRLF ? newContent.replace(/\r\n/g, '\n').replace(/\n/g, '\r\n') : newContent;
  }

  // Handle empty content gracefully
  if (originalContent.trim() === '' && newContent === null) return originalContent;
  if (originalContent.trim() === '' && newContent !== null) return newContent;

  // Detect and preserve original line endings
  const hasCRLF = originalContent.includes('\r\n');
  const normalized = hasCRLF ? originalContent.replace(/\r\n/g, '\n') : originalContent;
  const normalizedNew =
    newContent !== null && hasCRLF ? newContent.replace(/\r\n/g, '\n') : newContent;

  const lines = normalized.split('\n');
  const sections = identifySections(normalized);
  const existing = sections.find((s) => s.name.toLowerCase() === sectionName.toLowerCase());

  let result: string;

  if (existing) {
    if (normalizedNew === null) {
      // Remove: skip this section's lines, emit everything else
      result = removeSection(lines, existing);
    } else {
      // Replace: emit before, new content, after
      result = replaceSection(lines, existing, normalizedNew);
    }
  } else if (normalizedNew === null) {
    // Nothing to remove
    return originalContent;
  } else {
    // Add at canonical position
    result = addSection(lines, sections, sectionName, normalizedNew);
  }

  // Restore original line endings if CRLF was detected
  return hasCRLF ? result.replace(/\n/g, '\r\n') : result;
}

/**
 * Apply multiple section edits in a single pass.
 *
 * Edits are applied in reverse line order to avoid offset shifts.
 * All non-edited sections remain byte-identical.
 *
 * @param originalContent - Full ABL text
 * @param edits - Array of section edits to apply
 * @returns Modified ABL text
 */
export function spliceSections(originalContent: string, edits: SectionEdit[]): string {
  if (edits.length === 0) return originalContent;
  if (edits.some((edit) => edit.section.toUpperCase() === FULL_EDIT_SECTION)) {
    return edits.reduce(
      (content, edit) => spliceSection(content, edit.section, edit.content),
      originalContent,
    );
  }
  // For a single edit, no optimization needed
  if (edits.length === 1) {
    return spliceSection(originalContent, edits[0].section, edits[0].content);
  }

  // Detect CRLF and normalize
  const hasCRLF = originalContent.includes('\r\n');
  const normalized = hasCRLF ? originalContent.replace(/\r\n/g, '\n') : originalContent;

  // Compute section boundaries once
  const sections = identifySections(normalized);
  const lines = normalized.split('\n');

  // Build a map of existing section edits (replacements/removals)
  const editMap = new Map<string, string | null>();
  const addEdits: SectionEdit[] = [];
  for (const edit of edits) {
    const existing = sections.find((s) => s.name.toLowerCase() === edit.section.toLowerCase());
    if (existing) {
      editMap.set(
        edit.section,
        edit.content !== null && hasCRLF ? edit.content.replace(/\r\n/g, '\n') : edit.content,
      );
    } else {
      addEdits.push(edit);
    }
  }

  // Apply replacements/removals in reverse order to preserve line offsets
  const sortedSections = sections
    .filter((s) => editMap.has(s.name))
    .sort((a, b) => b.startLine - a.startLine);

  for (const section of sortedSections) {
    const newContent = editMap.get(section.name)!;
    if (newContent === null) {
      // Remove section lines
      lines.splice(section.startLine, section.endLine - section.startLine + 1);
    } else {
      const cleaned = newContent.endsWith('\n') ? newContent.slice(0, -1) : newContent;
      const newLines = cleaned.split('\n');
      lines.splice(section.startLine, section.endLine - section.startLine + 1, ...newLines);
    }
  }

  // Apply additions (sections that don't exist yet) — use sequential spliceSection
  let result = lines.join('\n');
  for (const edit of addEdits) {
    if (edit.content !== null) {
      const content = hasCRLF ? edit.content.replace(/\r\n/g, '\n') : edit.content;
      result = spliceSection(result, edit.section, content);
    }
  }

  return hasCRLF ? result.replace(/\n/g, '\r\n') : result;
}

// ─── Internal Helpers ───────────────────────────────────────────────────────

function replaceSection(lines: string[], section: SectionBoundary, newContent: string): string {
  const before = lines.slice(0, section.startLine);
  const after = lines.slice(section.endLine + 1);

  // Ensure newContent doesn't have a trailing newline that would double up
  const newLines = newContent.endsWith('\n') ? newContent.slice(0, -1) : newContent;

  const parts: string[] = [];
  if (before.length > 0) {
    parts.push(before.join('\n'));
  }
  parts.push(newLines);
  if (after.length > 0) {
    parts.push(after.join('\n'));
  }

  return parts.join('\n');
}

function removeSection(lines: string[], section: SectionBoundary): string {
  const before = lines.slice(0, section.startLine);
  const after = lines.slice(section.endLine + 1);

  // Remove trailing blank lines from before to avoid double spacing
  while (before.length > 0 && before[before.length - 1].trim() === '') {
    before.pop();
  }

  if (before.length === 0 && after.length === 0) {
    return '';
  }
  if (before.length === 0) {
    // Remove leading blank lines from after
    while (after.length > 0 && after[0].trim() === '') {
      after.shift();
    }
    return after.join('\n');
  }
  if (after.length === 0) {
    return before.join('\n');
  }

  return before.join('\n') + '\n' + after.join('\n');
}

function addSection(
  lines: string[],
  existingSections: SectionBoundary[],
  sectionName: string,
  newContent: string,
): string {
  const targetIndex = SECTION_HEADERS.indexOf(
    sectionName.toUpperCase() as (typeof SECTION_HEADERS)[number],
  );

  if (targetIndex === -1) {
    // Unknown section — append at end
    const original = lines.join('\n');
    const separator = original.endsWith('\n') ? '\n' : '\n\n';
    return original + separator + newContent;
  }

  // Find the section that should come after the new one
  let insertBeforeLine = lines.length;

  for (const existing of existingSections) {
    const existingIndex = SECTION_HEADERS.indexOf(
      existing.name.toUpperCase() as (typeof SECTION_HEADERS)[number],
    );
    if (existingIndex > targetIndex) {
      insertBeforeLine = existing.startLine;
      break;
    }
  }

  const before = lines.slice(0, insertBeforeLine);
  const after = lines.slice(insertBeforeLine);

  // Ensure newContent doesn't have a trailing newline
  const cleanContent = newContent.endsWith('\n') ? newContent.slice(0, -1) : newContent;

  const parts: string[] = [];
  if (before.length > 0) {
    parts.push(before.join('\n'));
  }
  parts.push(cleanContent);
  if (after.length > 0) {
    parts.push(after.join('\n'));
  }

  return parts.join('\n');
}
