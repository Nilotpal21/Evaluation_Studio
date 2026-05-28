// DSLContextDetector.ts
import { parseAgentBasedABL } from '@abl/core';
import { COMMAND_REGISTRY, type Command } from './CommandRegistry';

export type DSLSection =
  | 'root'
  | 'identity'
  | 'tools'
  | 'guardrails'
  | 'templates'
  | 'flow'
  | 'flow.step'
  | 'gather'
  | 'memory'
  | 'constraints'
  | 'delegates'
  | 'handoff'
  | 'escalation'
  | 'error_handling'
  | 'completion'
  | 'execution'
  | 'hooks'
  | 'messages'
  | 'unknown';

export interface DSLContext {
  section: DSLSection;
  line: number;
  column: number;
  indentLevel: number;
  availableCommands: Command[];
}

interface Position {
  line: number;
  column: number;
}

// Section keyword → DSLSection mapping for line-based fallback
const SECTION_KEYWORDS: Record<string, DSLSection> = {
  'TOOLS:': 'tools',
  'GUARDRAILS:': 'guardrails',
  'TEMPLATES:': 'templates',
  'MESSAGES:': 'messages',
  'FLOW:': 'flow',
  'STEPS:': 'flow',
  'GATHER:': 'gather',
  'MEMORY:': 'memory',
  'CONSTRAINTS:': 'constraints',
  'DELEGATE:': 'delegates',
  'HANDOFF:': 'handoff',
  'ESCALATE:': 'escalation',
  'ESCALATION:': 'escalation',
  'ON_ERROR:': 'error_handling',
  'COMPLETE:': 'completion',
  'ON_START:': 'root',
  'EXECUTION:': 'execution',
  'HOOKS:': 'hooks',
  'IDENTITY:': 'identity',
  'PERSONA:': 'identity',
  'GOAL:': 'identity',
  'LIMITATIONS:': 'identity',
  'AGENT:': 'identity',
  'VERSION:': 'identity',
  'DESCRIPTION:': 'identity',
  'NLU:': 'root',
  'SYSTEM_PROMPT:': 'root',
  // YAML lowercase variants
  'tools:': 'tools',
  'guardrails:': 'guardrails',
  'templates:': 'templates',
  'flow:': 'flow',
  'gather:': 'gather',
  'memory:': 'memory',
  'constraints:': 'constraints',
  'handoff:': 'handoff',
  'delegate:': 'delegates',
  'escalate:': 'escalation',
  'execution:': 'execution',
  'persona:': 'identity',
  'goal:': 'identity',
  'limitations:': 'identity',
  'agent:': 'identity',
};

/**
 * Detect DSL section at cursor position.
 * Primary: AST parsing. Fallback: line-based keyword search.
 */
export function detectDSLContext(dslContent: string, position: Position): DSLContext {
  const lines = dslContent.split('\n');
  const currentLine = lines[position.line - 1] || '';
  const indentLevel = currentLine.search(/\S|$/);

  // Try AST-based detection first
  let section = detectByAST(dslContent, position);

  // Fallback to line-based if AST fails
  if (section === 'unknown') {
    section = detectByLine(lines, position.line);
  }

  const availableCommands = getCommandsForSection(section);

  return {
    section,
    line: position.line,
    column: position.column,
    indentLevel,
    availableCommands,
  };
}

function detectByAST(dslContent: string, position: Position): DSLSection {
  try {
    const result = parseAgentBasedABL(dslContent);
    if (!result.document) return 'unknown';

    // For now, fall back to line-based detection
    // In the future, we could walk the AST to find the exact node
    const lines = dslContent.split('\n');
    return detectByLine(lines, position.line);
  } catch (parseError) {
    // AST parsing failed, falling back to line-based detection
    return 'unknown';
  }
}

function detectByLine(lines: string[], cursorLine: number): DSLSection {
  const cursorIndex = Math.max(0, cursorLine - 1);
  const isBlankLine = (lines[cursorIndex] ?? '').trim().length === 0;

  // Search backwards from cursor for a section keyword at indent 0
  for (let i = cursorLine - 1; i >= 0; i--) {
    const line = lines[i];
    if (!line) continue;
    // Check if this is a top-level section (no leading whitespace)
    const indent = line.search(/\S|$/);
    if (indent > 0) continue;

    const matchedSection = matchTopLevelSection(line);
    if (!matchedSection) {
      continue;
    }

    if (isBlankLine && (matchedSection === 'identity' || matchedSection === 'root')) {
      const nextTopLevelSection = findNextTopLevelSection(lines, cursorIndex + 1);
      return nextTopLevelSection === matchedSection ? matchedSection : 'root';
    }

    return matchedSection;
  }

  return 'root';
}

function findNextTopLevelSection(lines: string[], startIndex: number): DSLSection | null {
  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];
    if (!line) continue;
    const indent = line.search(/\S|$/);
    if (indent > 0) continue;

    const matchedSection = matchTopLevelSection(line);
    if (matchedSection) {
      return matchedSection;
    }
  }

  return null;
}

function matchTopLevelSection(line: string): DSLSection | null {
  const trimmed = line.trim();
  for (const [keyword, section] of Object.entries(SECTION_KEYWORDS)) {
    if (trimmed.startsWith(keyword)) {
      return section;
    }
  }

  return null;
}

function getCommandsForSection(section: DSLSection): Command[] {
  return COMMAND_REGISTRY.filter(
    (cmd) => cmd.availableIn.includes(section) || cmd.availableIn.includes('root'),
  );
}
