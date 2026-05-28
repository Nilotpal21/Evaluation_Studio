/**
 * getDocumentSymbols — Extract hierarchical document outline for tree-view navigator.
 *
 * Returns: Agent (root) -> Sections (Tools, Flow, Constraints, Gather, Handoffs, Delegates) -> Items
 */

import { detectFormat } from './detect-format.js';
import { parseYamlABL, parseAgentBasedABL } from '@abl/core';
import type { AgentBasedDocument } from '@abl/core';
import type { DocumentSymbol, SymbolKind } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Find the 1-based line number where a top-level YAML key appears.
 */
function findLineForKey(source: string, key: string): number {
  const lines = source.split('\n');
  const pattern = new RegExp(`^${key}\\s*:`);
  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i].trim())) {
      return i + 1;
    }
  }
  return 1;
}

/**
 * Find the 1-based line number where a value appears within a section.
 * Searches for the value string after the sectionKey line.
 */
function findLineForValue(source: string, sectionKey: string, value: string): number {
  const lines = source.split('\n');
  const sectionPattern = new RegExp(`^${sectionKey}\\s*:`);
  let inSection = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (sectionPattern.test(trimmed)) {
      inSection = true;
      continue;
    }
    if (inSection) {
      // Left the section if we hit another top-level key
      if (
        /^[a-z][a-z_]*\s*:/.test(trimmed) &&
        !lines[i].startsWith(' ') &&
        !lines[i].startsWith('\t')
      ) {
        break;
      }
      if (trimmed.includes(value)) {
        return i + 1;
      }
    }
  }
  return findLineForKey(source, sectionKey);
}

/**
 * Create a DocumentSymbol node.
 */
function makeSymbol(
  name: string,
  kind: SymbolKind,
  line: number,
  children: DocumentSymbol[] = [],
): DocumentSymbol {
  return { name, kind, line, children };
}

/**
 * Extract simple tool names from raw YAML source.
 * Handles the shorthand `- tool_name` syntax that the parser
 * doesn't preserve as tool names.
 */
function extractToolNamesFromSource(source: string): string[] {
  const lines = source.split('\n');
  const toolNames: string[] = [];
  let inTools = false;

  for (const line of lines) {
    const trimmed = line.trim();

    if (/^tools\s*:/.test(trimmed)) {
      inTools = true;
      continue;
    }

    if (inTools) {
      // Left the section if we hit a non-indented top-level key
      if (/^[a-z][a-z_]*\s*:/.test(trimmed) && !line.startsWith(' ') && !line.startsWith('\t')) {
        break;
      }

      // String shorthand: `- tool_name`
      const stringMatch = trimmed.match(/^-\s+(\S+)$/);
      if (stringMatch) {
        toolNames.push(stringMatch[1]);
        continue;
      }

      // Object form: `- name: tool_name`
      const nameMatch = trimmed.match(/^-?\s*name\s*:\s*(.+)$/);
      if (nameMatch) {
        toolNames.push(nameMatch[1].trim().replace(/^["']|["']$/g, ''));
      }
    }
  }

  return toolNames;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Extract document symbols from ABL source for the tree-view outline.
 *
 * Returns a hierarchical tree:
 *   Agent (root) -> Sections -> Items
 */
export function getDocumentSymbols(source: string): DocumentSymbol[] {
  if (!source || !source.trim()) {
    return [];
  }

  const format = detectFormat(source);

  let doc: AgentBasedDocument | null = null;

  try {
    if (format === 'yaml') {
      const result = parseYamlABL(source);
      doc = result.document;
    } else {
      const result = parseAgentBasedABL(source);
      doc = result.document;
    }
  } catch {
    console.debug('[language-service:symbols] Parse failed');
    return [];
  }

  if (!doc) {
    return [];
  }

  const agentName = doc.name || 'unknown';
  // Support both AGENT: and SUPERVISOR: keywords
  let agentLine = findLineForKey(source, 'agent');
  if (agentLine === 1) {
    // agent not found, try supervisor
    const supervisorLine = findLineForKey(source, 'supervisor');
    if (supervisorLine !== 1) {
      agentLine = supervisorLine;
    }
  }
  const children: DocumentSymbol[] = [];

  // --- Persona section ---
  if (doc.persona && doc.persona.description) {
    const personaLine = findLineForKey(source, 'persona');
    children.push(makeSymbol('Persona', 'section', personaLine));
  }

  // --- Limitations section ---
  if (doc.limitations && doc.limitations.length > 0) {
    const limitationsLine = findLineForKey(source, 'limitations');
    const limitationChildren: DocumentSymbol[] = doc.limitations.map((limitation, idx) => {
      const preview = limitation.description.substring(0, 50).replace(/\n/g, ' ');
      const line = findLineForValue(source, 'limitations', preview.substring(0, 20));
      return makeSymbol(preview, 'field', line);
    });

    children.push(makeSymbol('Limitations', 'section', limitationsLine, limitationChildren));
  }

  // --- Templates section ---
  if (doc.templates && doc.templates.length > 0) {
    const templatesLine = findLineForKey(source, 'templates');
    const templateChildren: DocumentSymbol[] = doc.templates.map((template) => {
      const line = findLineForValue(source, 'templates', template.name);
      return makeSymbol(template.name, 'field', line);
    });

    children.push(makeSymbol('Templates', 'section', templatesLine, templateChildren));
  }

  // --- Tools section ---
  if (doc.tools && doc.tools.length > 0) {
    const toolsLine = findLineForKey(source, 'tools');
    const toolNames = extractToolNamesFromSource(source);

    const toolChildren: DocumentSymbol[] = doc.tools.map((tool, idx) => {
      const name = tool.name || (toolNames[idx] ?? `tool_${idx}`);
      const line = findLineForValue(source, 'tools', name);
      return makeSymbol(name, 'tool', line);
    });

    children.push(makeSymbol('Tools', 'section', toolsLine, toolChildren));
  }

  // --- Flow section ---
  if (doc.flow) {
    const flowLine = findLineForKey(source, 'flow');
    const stepChildren: DocumentSymbol[] = doc.flow.steps.map((stepName) => {
      const line = findLineForValue(source, 'flow', stepName);
      return makeSymbol(stepName, 'step', line);
    });

    children.push(makeSymbol('Flow', 'section', flowLine, stepChildren));
  }

  // --- Gather section ---
  if (doc.gather && doc.gather.length > 0) {
    const gatherLine = findLineForKey(source, 'gather');
    const fieldChildren: DocumentSymbol[] = doc.gather.map((field) => {
      const line = findLineForValue(source, 'gather', field.name);
      return makeSymbol(field.name, 'field', line);
    });

    children.push(makeSymbol('Gather', 'section', gatherLine, fieldChildren));
  }

  // --- Memory section ---
  if (doc.memory) {
    const memoryLine = findLineForKey(source, 'memory');
    const memoryChildren: DocumentSymbol[] = [];

    if (doc.memory.session && doc.memory.session.length > 0) {
      const sessionLine = findLineForValue(source, 'memory', 'session');
      const sessionChildren = doc.memory.session.map((item) => {
        // Handle both SessionMemoryVar objects (with .name) and legacy string format
        const varName = typeof item === 'string' ? item : item.name;
        const line = findLineForValue(source, 'session', String(varName));
        return makeSymbol(String(varName), 'field', line);
      });
      memoryChildren.push(makeSymbol('session', 'section', sessionLine, sessionChildren));
    }

    if (doc.memory.persistent && doc.memory.persistent.length > 0) {
      const persistentLine = findLineForValue(source, 'memory', 'persistent');
      memoryChildren.push(makeSymbol('persistent', 'section', persistentLine));
    }

    if (memoryChildren.length > 0) {
      children.push(makeSymbol('Memory', 'section', memoryLine, memoryChildren));
    }
  }

  // --- Constraints section ---
  if (doc.constraints && doc.constraints.length > 0) {
    const constraintsLine = findLineForKey(source, 'constraints');
    const constraintChildren: DocumentSymbol[] = [];

    for (const phase of doc.constraints) {
      if (phase.name) {
        // Named phase — add as a constraint symbol
        const line = findLineForValue(source, 'constraints', phase.name);
        constraintChildren.push(makeSymbol(phase.name, 'constraint', line));
      }
      for (const req of phase.requirements) {
        const ruleName = typeof req.condition === 'string' ? req.condition : 'rule';
        const line = findLineForValue(source, 'constraints', ruleName.substring(0, 20));
        constraintChildren.push(makeSymbol(ruleName, 'constraint', line));
      }
    }

    if (constraintChildren.length > 0) {
      children.push(makeSymbol('Constraints', 'section', constraintsLine, constraintChildren));
    }
  }

  // --- Handoffs section ---
  if (doc.handoff && doc.handoff.length > 0) {
    const handoffLine = findLineForKey(source, 'handoff');
    const handoffChildren: DocumentSymbol[] = doc.handoff.map((h) => {
      const line = findLineForValue(source, 'handoff', h.to);
      return makeSymbol(h.to, 'handoff', line);
    });

    children.push(makeSymbol('Handoffs', 'section', handoffLine, handoffChildren));
  }

  // --- Delegates section ---
  if (doc.delegate && doc.delegate.length > 0) {
    const delegateLine = findLineForKey(source, 'delegate');
    const delegateChildren: DocumentSymbol[] = doc.delegate.map((d) => {
      const line = findLineForValue(source, 'delegate', d.agent);
      return makeSymbol(d.agent, 'delegate', line);
    });

    children.push(makeSymbol('Delegates', 'section', delegateLine, delegateChildren));
  }

  // --- Escalate section ---
  if (doc.escalate && doc.escalate.triggers && doc.escalate.triggers.length > 0) {
    const escalateLine = findLineForKey(source, 'escalate');
    const escalateChildren: DocumentSymbol[] = doc.escalate.triggers.map((trigger) => {
      const reasonPreview = trigger.reason.substring(0, 50).replace(/\n/g, ' ');
      const line = findLineForValue(source, 'escalate', reasonPreview.substring(0, 20));
      return makeSymbol(reasonPreview, 'handler', line);
    });

    children.push(makeSymbol('Escalate', 'section', escalateLine, escalateChildren));
  }

  // --- Complete section ---
  if (doc.complete && doc.complete.length > 0) {
    const completeLine = findLineForKey(source, 'complete');
    const completeChildren: DocumentSymbol[] = doc.complete.map((condition) => {
      const whenPreview = condition.when.substring(0, 50).replace(/\n/g, ' ');
      const line = findLineForValue(source, 'complete', whenPreview.substring(0, 20));
      return makeSymbol(whenPreview, 'constraint', line);
    });

    children.push(makeSymbol('Complete', 'section', completeLine, completeChildren));
  }

  const agentSymbol = makeSymbol(agentName, 'agent', agentLine, children);
  return [agentSymbol];
}
