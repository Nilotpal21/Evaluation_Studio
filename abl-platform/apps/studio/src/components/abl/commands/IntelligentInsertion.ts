/**
 * Intelligent DSL Insertion
 *
 * Understands ABL DSL structure and inserts constructs in the correct section,
 * even if the user's cursor is in the wrong place.
 */

import type { editor } from 'monaco-editor';
import type { DSLSection } from './DSLContextDetector';

/**
 * Standard ABL DSL section order (as per agent-based.ts)
 */
const SECTION_ORDER: DSLSection[] = [
  'identity', // AGENT, VERSION, DESCRIPTION, GOAL, PERSONA, LIMITATIONS
  'tools', // TOOLS:
  'guardrails', // GUARDRAILS:
  'templates', // TEMPLATES: or MESSAGES:
  'gather', // GATHER:
  'memory', // MEMORY:
  'constraints', // CONSTRAINTS:
  'delegates', // DELEGATE:
  'handoff', // HANDOFF:
  'escalation', // ESCALATE:
  'error_handling', // ON_ERROR:
  'hooks', // HOOKS:
  'messages', // (alternative to templates)
  'completion', // COMPLETE:
  'execution', // EXECUTION:
];

/**
 * Maps construct types to their target section
 */
const CONSTRUCT_TO_SECTION: Record<string, DSLSection> = {
  // Tools
  tool: 'tools',
  'http-tool': 'tools',
  'mcp-tool': 'tools',
  'sandbox-tool': 'tools',
  'lambda-tool': 'tools',
  'async-tool': 'tools',

  // Guardrails
  guardrail: 'guardrails',
  'builtin-guard': 'guardrails',
  'input-guard': 'guardrails',
  'output-guard': 'guardrails',

  // Templates
  template: 'templates',
  multiformat: 'templates',
  'voice-template': 'templates',

  // Gather
  field: 'gather',
  'string-field': 'gather',
  'number-field': 'gather',
  'date-field': 'gather',
  'email-field': 'gather',
  'enum-field': 'gather',

  // Flow
  step: 'flow',
  'reasoning-step': 'flow',
  'scripted-step': 'flow',
  'gather-step': 'flow',
  digression: 'flow',

  // Memory
  'memory-var': 'memory',
  persistent: 'memory',
  remember: 'memory',
  recall: 'memory',

  // Constraints
  constraint: 'constraints',
  require: 'constraints',
  warn: 'constraints',

  // Coordination
  handoff: 'handoff',
  delegate: 'delegates',
  escalate: 'escalation',

  // Lifecycle
  onstart: 'hooks',
  complete: 'completion',
  onerror: 'error_handling',
  hook: 'hooks',
};

/**
 * Maps DSL sections to their YAML keyword
 */
const SECTION_TO_KEYWORD: Record<DSLSection, string> = {
  root: '',
  identity: '',
  tools: 'TOOLS:',
  guardrails: 'GUARDRAILS:',
  templates: 'TEMPLATES:',
  messages: 'MESSAGES:',
  flow: 'FLOW:',
  'flow.step': '',
  gather: 'GATHER:',
  memory: 'MEMORY:',
  constraints: 'CONSTRAINTS:',
  delegates: 'DELEGATE:',
  handoff: 'HANDOFF:',
  escalation: 'ESCALATE:',
  error_handling: 'ON_ERROR:',
  completion: 'COMPLETE:',
  execution: 'EXECUTION:',
  hooks: 'HOOKS:',
  unknown: '',
};

export interface InsertionResult {
  success: boolean;
  insertedAtLine: number;
  message?: string;
  warning?: string;
}

/**
 * Heuristic: detect the target section from snippet shape when commandId is
 * missing/unrecognized. Returns null when the shape is ambiguous.
 *
 * Why: pickers (esp. the legacy Tool Picker opened from the toolbar) may fire
 * `onInsert` without setting `lastCommandId`. Without this fallback, the caller
 * would land in the "insert at cursor" branch and a tool reference like
 * `  alias__name()` ends up at line 1, before `AGENT:`, producing "Unknown
 * section" compile errors.
 */
function detectSectionFromSnippet(snippet: string): DSLSection | null {
  const trimmed = snippet.trim();
  if (!trimmed) return null;

  // Tool reference / signature: identifier(...) optionally followed by metadata lines.
  // Examples:
  //   alias__charge_card()
  //   charge_card(amount: number) -> Result
  //   create_ticket(title: string)
  //     description: "..."
  //     type: http
  const firstLine = trimmed.split('\n')[0] ?? '';
  if (/^[A-Za-z_][A-Za-z0-9_]*\s*\(/.test(firstLine)) {
    return 'tools';
  }

  return null;
}

/**
 * Find the position where a section exists in the document
 */
function findSection(lines: string[], section: DSLSection): number | null {
  const keyword = SECTION_TO_KEYWORD[section];
  if (!keyword) return null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === keyword || line.startsWith(keyword)) {
      return i + 1; // Convert to 1-based line number
    }
  }
  return null;
}

/**
 * Find the last line of a section (before the next section starts)
 */
function findSectionEnd(lines: string[], sectionStartLine: number): number {
  // Start from the line after the section header
  for (let i = sectionStartLine; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    // Empty line or comment - continue
    if (!trimmed || trimmed.startsWith('#')) continue;

    // If line starts at column 0 and ends with ':', it's a new section
    if (line.search(/\S/) === 0 && trimmed.endsWith(':')) {
      // This is the start of the next section
      return i; // Return line number (1-based)
    }
  }

  // Section goes to end of file
  return lines.length + 1;
}

/**
 * Find where to create a new section based on standard order
 */
function findInsertionPointForNewSection(lines: string[], targetSection: DSLSection): number {
  const targetIndex = SECTION_ORDER.indexOf(targetSection);

  // Find the last existing section that should come before target
  for (let i = targetIndex - 1; i >= 0; i--) {
    const section = SECTION_ORDER[i];
    const lineNum = findSection(lines, section);
    if (lineNum !== null) {
      const endLine = findSectionEnd(lines, lineNum);
      return endLine;
    }
  }

  // If no previous section found, insert after identity block
  // Identity block typically ends after GOAL, PERSONA, LIMITATIONS
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (
      line.startsWith('GOAL:') ||
      line.startsWith('PERSONA:') ||
      line.startsWith('LIMITATIONS:')
    ) {
      // Find the end of this block
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        if (nextLine.search(/\S/) === 0 && nextLine.trim().endsWith(':')) {
          return j;
        }
      }
    }
  }

  // Fallback: insert after line 5 (after AGENT/GOAL typically)
  return Math.min(5, lines.length);
}

/**
 * Calculate indentation for the snippet based on section
 */
function getIndentForSection(section: DSLSection): number {
  // Most sections use 2-space indent for items
  switch (section) {
    case 'root':
    case 'identity':
      return 0;
    default:
      return 2;
  }
}

/**
 * Apply indentation to every non-empty line
 */
function applyIndent(snippet: string, spaces: number): string {
  if (!snippet || spaces === 0) return snippet;
  const indent = ' '.repeat(spaces);
  return snippet
    .split('\n')
    .map((line) => (line.trim() ? indent + line : line))
    .join('\n');
}

/**
 * Intelligently insert a snippet in the correct section
 */
export function insertSnippetIntelligently(
  editorInstance: editor.IStandaloneCodeEditor,
  snippet: string,
  commandId: string,
  currentSection: DSLSection,
): InsertionResult {
  const model = editorInstance.getModel();
  if (!model) {
    return { success: false, insertedAtLine: 0, message: 'No editor model' };
  }

  // Determine target section for this construct
  let targetSection: DSLSection | undefined = CONSTRUCT_TO_SECTION[commandId];

  // Fallback 1: infer from snippet shape (e.g. tool reference / signature).
  // Keeps the insert routed to the correct section when callers (toolbar buttons,
  // legacy pickers) fire onInsert without a populated commandId.
  if (!targetSection) {
    const inferred = detectSectionFromSnippet(snippet);
    if (inferred) {
      targetSection = inferred;
    }
  }

  if (!targetSection) {
    // Fallback 2: insert at cursor as-is
    const position = editorInstance.getPosition();
    if (!position) {
      return { success: false, insertedAtLine: 0, message: 'No cursor position' };
    }

    const indentedSnippet = applyIndent(snippet, 2);
    editorInstance.executeEdits('insert-snippet', [
      {
        range: {
          startLineNumber: position.lineNumber,
          startColumn: position.column,
          endLineNumber: position.lineNumber,
          endColumn: position.column,
        },
        text: indentedSnippet + '\n',
      },
    ]);

    return {
      success: true,
      insertedAtLine: position.lineNumber,
      warning: 'Inserted at cursor (no target section defined)',
    };
  }

  const content = model.getValue();
  const lines = content.split('\n');

  // Check if target section exists
  const sectionLine = findSection(lines, targetSection);

  if (sectionLine !== null) {
    // Section exists - insert at the end of it
    const endLine = findSectionEnd(lines, sectionLine);
    const indent = getIndentForSection(targetSection);
    const indentedSnippet = applyIndent(snippet, indent);

    // Insert before the next section (or at end)
    const insertLine = endLine;

    editorInstance.executeEdits('insert-snippet', [
      {
        range: {
          startLineNumber: insertLine,
          startColumn: 1,
          endLineNumber: insertLine,
          endColumn: 1,
        },
        text: indentedSnippet + '\n\n',
      },
    ]);

    // Move cursor to inserted snippet
    editorInstance.setPosition({ lineNumber: insertLine + 1, column: indent + 1 });
    editorInstance.revealLineInCenter(insertLine + 1);

    let message = `Inserted in ${SECTION_TO_KEYWORD[targetSection]} section`;
    if (currentSection !== targetSection && currentSection !== 'root') {
      message += ` (moved from ${currentSection.toUpperCase()})`;
    }

    return {
      success: true,
      insertedAtLine: insertLine,
      message,
    };
  } else {
    // Section doesn't exist - create it
    const insertionPoint = findInsertionPointForNewSection(lines, targetSection);
    const sectionKeyword = SECTION_TO_KEYWORD[targetSection];
    const indent = getIndentForSection(targetSection);
    const indentedSnippet = applyIndent(snippet, indent);

    const textToInsert = `\n${sectionKeyword}\n${indentedSnippet}\n`;

    editorInstance.executeEdits('insert-snippet', [
      {
        range: {
          startLineNumber: insertionPoint,
          startColumn: 1,
          endLineNumber: insertionPoint,
          endColumn: 1,
        },
        text: textToInsert,
      },
    ]);

    // Move cursor to inserted snippet
    const newLine = insertionPoint + 2; // +1 for section header, +1 for 0-index
    editorInstance.setPosition({ lineNumber: newLine, column: indent + 1 });
    editorInstance.revealLineInCenter(newLine);

    return {
      success: true,
      insertedAtLine: newLine,
      message: `Created ${sectionKeyword} section and inserted snippet`,
    };
  }
}
