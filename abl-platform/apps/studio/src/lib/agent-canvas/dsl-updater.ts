/**
 * DSL Updater — Parse and modify ABL DSL content.
 *
 * Uses @abl/core parser for reading structured data from DSL.
 * Uses regex-based mutations for writes (serializer not yet in @abl/core).
 */

import { parseAgentBasedABL } from '@abl/core';
import type { AgentTool, HandoffConfig, DelegateConfig } from '@abl/core';

// =============================================================================
// SUMMARY PARSING
// =============================================================================

export interface DslSummary {
  goal: string | null;
  persona: string | null;
  isSupervisor: boolean;
  toolsCount: number;
  hasFlow: boolean;
  hasEscalation: boolean;
}

export function parseSummary(dsl: string): DslSummary | null {
  if (!dsl.trim()) return null;
  const result = parseAgentBasedABL(dsl);
  if (!result.document || !result.document.name) return null;

  const doc = result.document;
  return {
    goal: doc.goal.description || null,
    persona: doc.persona.description || null,
    isSupervisor: /^\s*SUPERVISOR\s*:/m.test(dsl),
    toolsCount: doc.tools.length,
    hasFlow: !!doc.flow,
    hasEscalation: !!doc.escalate,
  };
}

// =============================================================================
// TOOLS PARSING
// =============================================================================

export function parseTools(dsl: string): AgentTool[] | null {
  if (!dsl.trim()) return null;
  const result = parseAgentBasedABL(dsl);
  if (!result.document || !result.document.name) return null;
  return result.document.tools;
}

// =============================================================================
// RELATIONSHIP PARSING
// =============================================================================

export interface DslRelationships {
  handoffs: HandoffConfig[];
  delegates: DelegateConfig[];
}

export function parseRelationships(dsl: string): DslRelationships | null {
  if (!dsl.trim()) return null;
  const result = parseAgentBasedABL(dsl);
  if (!result.document || !result.document.name) return null;

  return {
    handoffs: result.document.handoff,
    delegates: result.document.delegate,
  };
}

// =============================================================================
// REGEX-BASED DSL MUTATIONS
// =============================================================================

function replaceDslSection(dsl: string, section: string, newContent: string): string {
  const pattern = new RegExp(
    `^(${section}\\s*:\\s*)(?:"[^"]*"|\\|[\\s\\S]*?(?=^[A-Z][A-Z_]*\\s*:|$)|.*)`,
    'gm',
  );
  const match = pattern.exec(dsl);
  if (match) {
    return (
      dsl.slice(0, match.index) +
      `${section}: "${newContent.replace(/"/g, '\\"')}"` +
      dsl.slice(match.index + match[0].length)
    );
  }
  return dsl;
}

export function updateGoal(dsl: string, goal: string): string | null {
  if (!dsl.trim()) return null;
  return replaceDslSection(dsl, 'GOAL', goal);
}

export function updatePersona(dsl: string, persona: string): string | null {
  if (!dsl.trim()) return null;
  const pattern = /^(PERSONA\s*:\s*)\|?\s*\n([\s\S]*?)(?=^[A-Z][A-Z_]*\s*:|$)/gm;
  const match = pattern.exec(dsl);
  if (match) {
    const indented = persona
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n');
    return (
      dsl.slice(0, match.index) +
      `PERSONA: |\n${indented}\n` +
      dsl.slice(match.index + match[0].length)
    );
  }
  return replaceDslSection(dsl, 'PERSONA', persona);
}

// =============================================================================
// SHARED BLOCK FIELD UPDATER
// =============================================================================

/**
 * Update a field within the nth entry of a HANDOFF or DELEGATE block.
 *
 * Locates the nth occurrence of the entry keyword (TO or AGENT) inside the
 * parent section, then finds/replaces the target field line.  If the field
 * doesn't exist yet it's inserted after the entry keyword line.
 *
 * String values are wrapped in quotes except for WHEN, which is emitted as a
 * raw expression. Booleans are written unquoted.
 */
function updateBlockField(
  dsl: string,
  section: 'HANDOFF' | 'DELEGATE',
  entryKey: 'TO' | 'AGENT',
  index: number,
  field: string,
  value: string | boolean,
): string | null {
  // Find all entry positions (`- TO:` or `- AGENT:`) inside the section
  const sectionPattern = new RegExp(`^\\s*${section}\\s*:`, 'gm');
  const sectionMatch = sectionPattern.exec(dsl);
  if (!sectionMatch) return null;

  const entryPattern = new RegExp(`^\\s*-\\s*${entryKey}\\s*:`, 'gm');
  entryPattern.lastIndex = sectionMatch.index;

  let lastMatch: RegExpExecArray | null = null;
  for (let i = 0; i <= index; i++) {
    lastMatch = entryPattern.exec(dsl);
    if (!lastMatch) return null;
  }
  const entryMatch = lastMatch!;

  // Determine the end of this block entry (next `- TO/AGENT:` or next top-level section or EOF)
  const nextEntryPattern = new RegExp(`^\\s*-\\s*${entryKey}\\s*:|^[A-Z][A-Z_]*\\s*:`, 'gm');
  nextEntryPattern.lastIndex = entryMatch.index + entryMatch[0].length;
  const nextMatch = nextEntryPattern.exec(dsl);
  const blockEnd = nextMatch ? nextMatch.index : dsl.length;

  const blockSlice = dsl.slice(entryMatch.index, blockEnd);

  const fieldKey = field.toUpperCase();
  const formattedValue = formatBlockFieldValue(fieldKey, value);

  // Try to find the field line within this block
  const fieldPattern = new RegExp(`^(\\s*${fieldKey}\\s*:)\\s*.*$`, 'gm');
  const fieldMatch = fieldPattern.exec(blockSlice);

  let updatedBlock: string;
  if (fieldMatch) {
    // Replace existing field value
    updatedBlock =
      blockSlice.slice(0, fieldMatch.index) +
      `${fieldMatch[1]} ${formattedValue}` +
      blockSlice.slice(fieldMatch.index + fieldMatch[0].length);
  } else {
    // Insert field after the entry keyword line
    const entryLineEnd = blockSlice.indexOf('\n');
    if (entryLineEnd === -1) {
      updatedBlock = blockSlice + `\n    ${fieldKey}: ${formattedValue}`;
    } else {
      updatedBlock =
        blockSlice.slice(0, entryLineEnd + 1) +
        `    ${fieldKey}: ${formattedValue}\n` +
        blockSlice.slice(entryLineEnd + 1);
    }
  }

  return dsl.slice(0, entryMatch.index) + updatedBlock + dsl.slice(blockEnd);
}

function formatBlockFieldValue(fieldKey: string, value: string | boolean): string {
  if (typeof value === 'boolean') {
    return String(value);
  }

  // Condition slots must stay as expressions so users can author
  // `input contains "lookup"` instead of a truthy string literal.
  if (fieldKey === 'WHEN') {
    return value;
  }

  return `"${value.replace(/"/g, '\\"')}"`;
}

function serializeHandoffHistory(history: HandoffConfig['context']['history']): string {
  if (!history) return '';

  if (typeof history === 'string') {
    return `\n      history: ${history}`;
  }

  if (history.mode === 'last_n') {
    return `\n      history:\n        mode: last_n\n        count: ${history.count ?? 10}`;
  }

  return `\n      history: ${history.mode}`;
}

// Handoff mutations
export interface AddHandoffConfig {
  when: string;
  return?: boolean;
  summary?: string;
  pass?: string[];
  history?: HandoffConfig['context']['history'];
  priority?: number;
}

export function addHandoff(dsl: string, to: string, config?: AddHandoffConfig): string | null {
  if (!dsl.trim()) return null;
  const when = config?.when ?? '';
  const ret = config?.return !== undefined ? config.return : true;
  let section = `\n  - TO: ${to}\n    WHEN: ${when}\n    RETURN: ${ret}`;
  if (config?.priority !== undefined) {
    section += `\n    PRIORITY: ${config.priority}`;
  }
  const shouldEmitContext =
    !!config?.summary || (config?.pass?.length ?? 0) > 0 || config?.history !== undefined;
  if (shouldEmitContext) {
    section += `\n    CONTEXT:`;
    if (config?.summary) {
      section += `\n      summary: "${config.summary.replace(/"/g, '\\"')}"`;
    }
    if (config?.pass && config.pass.length > 0) {
      section += `\n      pass: [${config.pass.join(', ')}]`;
    }
    if (config?.history) {
      section += serializeHandoffHistory(config.history);
    }
  }
  if (/^\s*HANDOFF\s*:/m.test(dsl)) {
    return dsl.replace(/^(\s*HANDOFF\s*:.*)/m, `$1${section}`);
  }
  return dsl + `\n\nHANDOFF:${section}\n`;
}

export function removeHandoff(dsl: string, index: number): string | null {
  if (!dsl.trim()) return null;
  const rels = parseRelationships(dsl);
  if (!rels || index < 0 || index >= rels.handoffs.length) return null;
  const target = rels.handoffs[index].to;
  const pattern = new RegExp(
    `^\\s*-\\s*TO\\s*:\\s*${target}[\\s\\S]*?(?=^\\s*-\\s*TO\\s*:|^[A-Z]|$)`,
    'gm',
  );
  return dsl.replace(pattern, '');
}

export function updateHandoffField(
  dsl: string,
  index: number,
  field: 'to' | 'when' | 'summary' | 'return',
  value: string | boolean,
): string | null {
  if (!dsl.trim()) return null;
  const rels = parseRelationships(dsl);
  if (!rels || index < 0 || index >= rels.handoffs.length) return null;

  return updateBlockField(dsl, 'HANDOFF', 'TO', index, field, value);
}

export interface AddDelegateConfig {
  when: string;
  purpose: string;
  input?: Record<string, string>;
  returns?: Record<string, string>;
  timeout?: string;
}

export interface AddEscalateTriggerConfig {
  when: string;
  reason: string;
  priority: 'low' | 'medium' | 'high' | 'critical';
  tags?: string[];
}

export function addEscalateTrigger(dsl: string, config: AddEscalateTriggerConfig): string | null {
  if (!dsl.trim()) return null;
  const when = config.when;
  const reason = `"${config.reason.replace(/"/g, '\\"')}"`;
  let section = `\n    - WHEN: ${when}\n      REASON: ${reason}\n      PRIORITY: ${config.priority}`;
  if (config.tags && config.tags.length > 0) {
    section += `\n      TAGS: [${config.tags.join(', ')}]`;
  }
  if (/^\s*ESCALATE\s*:/m.test(dsl)) {
    if (/^\s*triggers\s*:/m.test(dsl)) {
      return dsl.replace(/^(\s*triggers\s*:.*)/m, `$1${section}`);
    }
    return dsl.replace(/^(\s*ESCALATE\s*:.*)/m, `$1\n  triggers:${section}`);
  }
  return dsl + `\n\nESCALATE:\n  triggers:${section}\n`;
}

export function addDelegate(dsl: string, agent: string, config?: AddDelegateConfig): string | null {
  if (!dsl.trim()) return null;
  const when = config?.when ?? '';
  const purpose = config?.purpose ? `"${config.purpose.replace(/"/g, '\\"')}"` : '""';
  let section = `\n  - AGENT: ${agent}\n    WHEN: ${when}\n    PURPOSE: ${purpose}`;
  if (config?.input && Object.keys(config.input).length > 0) {
    section += '\n    INPUT:';
    for (const [k, v] of Object.entries(config.input)) {
      section += `\n      ${k}: ${v}`;
    }
  }
  if (config?.returns && Object.keys(config.returns).length > 0) {
    section += '\n    RETURNS:';
    for (const [k, v] of Object.entries(config.returns)) {
      section += `\n      ${k}: ${v}`;
    }
  }
  if (config?.timeout) {
    section += `\n    TIMEOUT: "${config.timeout}"`;
  }
  if (/^\s*DELEGATE\s*:/m.test(dsl)) {
    return dsl.replace(/^(\s*DELEGATE\s*:.*)/m, `$1${section}`);
  }
  return dsl + `\n\nDELEGATE:${section}\n`;
}

export function removeDelegate(dsl: string, index: number): string | null {
  if (!dsl.trim()) return null;
  const rels = parseRelationships(dsl);
  if (!rels || index < 0 || index >= rels.delegates.length) return null;
  const target = rels.delegates[index].agent;
  const pattern = new RegExp(
    `^\\s*-\\s*AGENT\\s*:\\s*${target}[\\s\\S]*?(?=^\\s*-\\s*AGENT\\s*:|^[A-Z]|$)`,
    'gm',
  );
  return dsl.replace(pattern, '');
}

export function updateDelegateField(
  dsl: string,
  index: number,
  field: 'agent' | 'when' | 'purpose',
  value: string,
): string | null {
  if (!dsl.trim()) return null;
  const rels = parseRelationships(dsl);
  if (!rels || index < 0 || index >= rels.delegates.length) return null;

  return updateBlockField(dsl, 'DELEGATE', 'AGENT', index, field, value);
}
