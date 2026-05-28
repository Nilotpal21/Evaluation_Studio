/**
 * ABL Differ — section-aware diff for ABL files
 *
 * Groups changes by ABL section so that diffs show exactly which sections
 * changed, rather than raw line-level diffs that lose context.
 */

import type { ABLDiffResult, SectionDiff, SectionStatus } from '../types.js';
import { identifySections } from './section-splicer.js';

/**
 * Compute a section-aware diff between two ABL contents.
 *
 * @param before - Original ABL text (or empty string for new files)
 * @param after - Modified ABL text (or empty string for deleted files)
 * @returns Diff result grouped by section with per-section status
 */
export function diffABL(before: string, after: string): ABLDiffResult {
  const beforeSections = identifySections(before);
  const afterSections = identifySections(after);

  const beforeLines = before.split('\n');
  const afterLines = after.split('\n');

  const beforeMap = new Map<string, string>();
  const afterMap = new Map<string, string>();

  for (const s of beforeSections) {
    const sectionContent = beforeLines.slice(s.startLine, s.endLine + 1).join('\n');
    beforeMap.set(s.name, sectionContent);
  }

  for (const s of afterSections) {
    const sectionContent = afterLines.slice(s.startLine, s.endLine + 1).join('\n');
    afterMap.set(s.name, sectionContent);
  }

  // Collect all section names in appearance order
  const allSections = new Set<string>();
  for (const s of beforeSections) allSections.add(s.name);
  for (const s of afterSections) allSections.add(s.name);

  const sections: SectionDiff[] = [];
  const summary = {
    added: [] as string[],
    removed: [] as string[],
    modified: [] as string[],
    unchanged: [] as string[],
  };

  for (const name of allSections) {
    const beforeContent = beforeMap.get(name) ?? null;
    const afterContent = afterMap.get(name) ?? null;

    let status: SectionStatus;

    if (beforeContent === null && afterContent !== null) {
      status = 'added';
      summary.added.push(name);
    } else if (beforeContent !== null && afterContent === null) {
      status = 'removed';
      summary.removed.push(name);
    } else if (beforeContent !== afterContent) {
      status = 'modified';
      summary.modified.push(name);
    } else {
      status = 'unchanged';
      summary.unchanged.push(name);
    }

    sections.push({ section: name, status, beforeContent, afterContent });
  }

  // Also capture content between/outside sections (comments, blank lines)
  const hasNonSectionChanges = checkNonSectionChanges(before, after, beforeSections, afterSections);

  const hasChanges =
    summary.added.length > 0 ||
    summary.removed.length > 0 ||
    summary.modified.length > 0 ||
    hasNonSectionChanges;

  return { hasChanges, sections, summary };
}

/**
 * Check if there are changes in content outside of any section
 * (e.g., comments between sections, leading blank lines).
 */
function checkNonSectionChanges(
  before: string,
  after: string,
  beforeSections: { startLine: number; endLine: number }[],
  afterSections: { startLine: number; endLine: number }[],
): boolean {
  const beforeNonSection = extractNonSectionContent(before, beforeSections);
  const afterNonSection = extractNonSectionContent(after, afterSections);
  return beforeNonSection !== afterNonSection;
}

function extractNonSectionContent(
  content: string,
  sections: { startLine: number; endLine: number }[],
): string {
  const lines = content.split('\n');
  const inSection = new Set<number>();
  for (const s of sections) {
    for (let i = s.startLine; i <= s.endLine; i++) {
      inSection.add(i);
    }
  }

  const nonSectionLines: string[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (!inSection.has(i)) {
      nonSectionLines.push(lines[i]);
    }
  }
  return nonSectionLines.join('\n');
}
