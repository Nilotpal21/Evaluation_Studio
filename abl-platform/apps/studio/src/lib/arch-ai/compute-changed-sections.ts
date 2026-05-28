// apps/studio/src/lib/arch-ai/compute-changed-sections.ts
//
// Browser-safe section-differ for ABL YAML.
//
// We cannot import `identifySections` from `@agent-platform/project-io/diff`
// because that module transitively imports `@abl/compiler/platform`, which
// pulls the MCP client into the browser bundle (Node's `child_process`).
// The section-identification logic itself is tiny — scanning for section
// headers at zero indentation — so we inline a client-safe copy here. The
// canonical section header list must stay in sync with
// `packages/project-io/src/diff/section-splicer.ts`.

/**
 * Canonical list of top-level ABL section headers. MUST match
 * `SECTION_HEADERS` in packages/project-io/src/diff/section-splicer.ts.
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
  'BEHAVIOR_PROFILE',
] as const;

const SECTION_HEADER_PATTERN = new RegExp(`^(${SECTION_HEADERS.join('|')}):`, 'i');

interface SectionBoundary {
  name: string;
  /** 0-indexed line number of the header row. */
  startLine: number;
  /** 0-indexed INCLUSIVE line number of the last line in the section. */
  endLine: number;
}

/**
 * Scan ABL text for top-level section boundaries. Ignores duplicates (first
 * occurrence wins) to stay aligned with the canonical section-splicer.
 */
function identifySections(content: string): SectionBoundary[] {
  const normalized = content.replace(/\r\n/g, '\n');
  const lines = normalized.split('\n');
  const sections: SectionBoundary[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const match = lines[i].match(SECTION_HEADER_PATTERN);
    if (!match) continue;
    // Normalize to the canonical upper-case name (matches section-splicer).
    const name = match[1].toUpperCase();
    if (seen.has(name)) continue;
    seen.add(name);
    sections.push({ name, startLine: i, endLine: -1 });
  }

  for (let i = 0; i < sections.length; i++) {
    sections[i].endLine =
      i + 1 < sections.length ? sections[i + 1].startLine - 1 : lines.length - 1;
  }

  return sections;
}

export interface ChangedSection {
  name: string;
  /** 1-indexed line number of the section header in the ORIGINAL content. 0 if the section is new. */
  beforeStartLine: number;
  /** 1-indexed line number of the section header in the MODIFIED content. 0 if the section was removed. */
  afterStartLine: number;
}

/**
 * Identify top-level ABL sections that differ between two strings. Used by
 * InProjectDiffCard to render jump-chips next to the Monaco diff.
 *
 * Line numbers are returned in 1-indexed form so they can be passed directly
 * to Monaco's revealLineInCenter()/setPosition() APIs. identifySections()
 * itself returns 0-indexed line positions with inclusive endLine — we convert
 * here so the rest of the studio codebase doesn't have to know about the
 * internal convention.
 */
export function computeChangedSections(before: string, after: string): ChangedSection[] {
  if (before === after) return [];

  const beforeSections = identifySections(before);
  const afterSections = identifySections(after);

  const beforeByName = new Map(beforeSections.map((s) => [s.name, s]));
  const afterByName = new Map(afterSections.map((s) => [s.name, s]));

  const allNames = new Set<string>([
    ...beforeSections.map((s) => s.name),
    ...afterSections.map((s) => s.name),
  ]);

  const changed: ChangedSection[] = [];
  for (const name of allNames) {
    const b = beforeByName.get(name);
    const a = afterByName.get(name);
    const beforeText = b ? extractSectionText(before, b) : '';
    const afterText = a ? extractSectionText(after, a) : '';
    if (beforeText !== afterText) {
      changed.push({
        name,
        // +1 because identifySections returns 0-indexed line numbers and Monaco is 1-indexed.
        beforeStartLine: b ? b.startLine + 1 : 0,
        afterStartLine: a ? a.startLine + 1 : 0,
      });
    }
  }

  changed.sort((x, y) => x.afterStartLine - y.afterStartLine);
  return changed;
}

function extractSectionText(content: string, section: SectionBoundary): string {
  // section.startLine is 0-indexed and section.endLine is INCLUSIVE.
  // Array.prototype.slice's second arg is exclusive, so add 1 to endLine.
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return lines.slice(section.startLine, section.endLine + 1).join('\n');
}
