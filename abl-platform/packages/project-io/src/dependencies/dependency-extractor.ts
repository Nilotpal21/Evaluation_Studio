/**
 * Dependency Extractor — lightweight line scanner for inter-agent references
 *
 * Extracts HANDOFF, DELEGATE, TOOLIMPORT, and inline references from ABL
 * content without full parsing. Uses regex patterns on raw text lines.
 */

import type { AgentDependency } from '../types.js';

// ─── Patterns ───────────────────────────────────────────────────────────────

/** HANDOFF: - TO: AgentName */
const HANDOFF_TO_PATTERN = /^\s*-\s*TO:\s*(\w+)/;

/** DELEGATE: - AGENT: AgentName */
const DELEGATE_AGENT_PATTERN = /^\s*-\s*AGENT:\s*(\w+)/;

/** TOOLS: FROM "path" USE: tool1, tool2 */
const TOOL_IMPORT_PATTERN = /^\s*FROM\s+["']([^"']+)["']\s+USE:\s*(.+)/;

/** ON_FAIL: HANDOFF AgentName */
const INLINE_HANDOFF_PATTERN = /\bHANDOFF\s+(\w+)/;

/** THEN: HANDOFF AgentName */
const THEN_HANDOFF_PATTERN = /^\s*THEN:\s*HANDOFF\s+(\w+)/;

/** Action-handler DO or direct handler property: - HANDOFF: AgentName / HANDOFF: AgentName */
const ACTION_HANDLER_HANDOFF_PATTERN = /^\s*(?:-\s*)?HANDOFF:\s*(\w+)/i;

/** Action-handler DO or direct handler property: - DELEGATE: AgentName / DELEGATE: AgentName */
const ACTION_HANDLER_DELEGATE_PATTERN = /^\s*(?:-\s*)?DELEGATE:\s*(\w+)/i;

/** USE BEHAVIOR_PROFILE: profile_name */
const USE_BEHAVIOR_PROFILE_PATTERN = /^\s*USE\s+BEHAVIOR_PROFILE:\s*(\S+)/;

// ─── Section Detection ──────────────────────────────────────────────────────

type CurrentSection =
  | 'HANDOFF'
  | 'DELEGATE'
  | 'TOOLS'
  | 'ESCALATE'
  | 'ON_ERROR'
  | 'CONSTRAINTS'
  | 'FLOW'
  | 'ACTION_HANDLERS'
  | 'OTHER';

const SECTION_PATTERN =
  /^(HANDOFF|DELEGATE|TOOLS|TOOLIMPORTS|ESCALATE|ON_ERROR|CONSTRAINTS|AGENT|SUPERVISOR|VERSION|DESCRIPTION|MODE|LANGUAGE|GOAL|PERSONA|IDENTITY|LIMITATIONS|GATHER|MEMORY|GUARDRAILS|FLOW|ACTION_HANDLERS|COMPLETE|ON_START|MESSAGES|TEMPLATES|HOOKS|EXECUTION|NLU|VOICE|BEHAVIOR_PROFILE|BEHAVIOR):/;

/**
 * Extract all inter-agent dependencies from ABL content.
 *
 * Scans line-by-line to find:
 * - HANDOFF TO references
 * - DELEGATE AGENT references
 * - TOOLS FROM (tool imports)
 * - Inline HANDOFF references in ON_FAIL, THEN, etc.
 *
 * @param dslContent - Raw ABL text
 * @returns Array of discovered dependencies
 */
export function extractDependencies(dslContent: string): AgentDependency[] {
  const lines = dslContent.split('\n');
  const deps: AgentDependency[] = [];
  let currentSection: CurrentSection = 'OTHER';
  // Track ESCALATE sub-sections: on_human_complete actions are opaque strings
  // that should not be scanned for agent references (see decision-log.md).
  let escalateSubSection: 'triggers' | 'context_for_human' | 'on_human_complete' | null = null;
  const seenDeps = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const lineNum = i + 1;

    // Detect section transitions
    const sectionMatch = line.match(SECTION_PATTERN);
    if (sectionMatch) {
      const name = sectionMatch[1];
      if (name === 'HANDOFF') currentSection = 'HANDOFF';
      else if (name === 'DELEGATE') currentSection = 'DELEGATE';
      else if (name === 'TOOLS' || name === 'TOOLIMPORTS') currentSection = 'TOOLS';
      else if (name === 'ESCALATE') currentSection = 'ESCALATE';
      else if (name === 'ON_ERROR') currentSection = 'ON_ERROR';
      else if (name === 'CONSTRAINTS') currentSection = 'CONSTRAINTS';
      else if (name === 'FLOW') currentSection = 'FLOW';
      else if (name === 'ACTION_HANDLERS') currentSection = 'ACTION_HANDLERS';
      else currentSection = 'OTHER';
      // Reset escalate sub-section when leaving ESCALATE
      if (name !== 'ESCALATE') escalateSubSection = null;
      continue;
    }

    // Detect ESCALATE sub-section transitions
    if (currentSection === 'ESCALATE') {
      const trimmed = line.trim();
      if (trimmed === 'triggers:') {
        escalateSubSection = 'triggers';
        continue;
      }
      if (trimmed === 'context_for_human:') {
        escalateSubSection = 'context_for_human';
        continue;
      }
      if (trimmed === 'on_human_complete:') {
        escalateSubSection = 'on_human_complete';
        continue;
      }
    }

    // Skip comments
    if (line.trim().startsWith('#')) continue;

    // USE BEHAVIOR_PROFILE: profile_name (can appear in any section)
    const profileMatch = line.match(USE_BEHAVIOR_PROFILE_PATTERN);
    if (profileMatch) {
      const key = `profile_use:${profileMatch[1]}`;
      if (!seenDeps.has(key)) {
        seenDeps.add(key);
        deps.push({
          type: 'profile_use',
          targetAgent: profileMatch[1],
          sourceLine: lineNum,
          sourceSection: currentSection,
        });
      }
    }

    // HANDOFF section: TO: AgentName
    if (currentSection === 'HANDOFF') {
      const handoffMatch = line.match(HANDOFF_TO_PATTERN);
      if (handoffMatch) {
        const key = `handoff:${handoffMatch[1]}`;
        if (!seenDeps.has(key)) {
          seenDeps.add(key);
          deps.push({
            type: 'handoff',
            targetAgent: handoffMatch[1],
            sourceLine: lineNum,
            sourceSection: 'HANDOFF',
          });
        }
      }
    }

    // DELEGATE section: AGENT: AgentName
    if (currentSection === 'DELEGATE') {
      const delegateMatch = line.match(DELEGATE_AGENT_PATTERN);
      if (delegateMatch) {
        const key = `delegate:${delegateMatch[1]}`;
        if (!seenDeps.has(key)) {
          seenDeps.add(key);
          deps.push({
            type: 'delegate',
            targetAgent: delegateMatch[1],
            sourceLine: lineNum,
            sourceSection: 'DELEGATE',
          });
        }
      }
    }

    if (currentSection === 'FLOW' || currentSection === 'ACTION_HANDLERS') {
      const handoffMatch = line.match(ACTION_HANDLER_HANDOFF_PATTERN);
      if (handoffMatch) {
        const key = `handoff:${handoffMatch[1]}`;
        if (!seenDeps.has(key)) {
          seenDeps.add(key);
          deps.push({
            type: 'handoff',
            targetAgent: handoffMatch[1],
            sourceLine: lineNum,
            sourceSection: currentSection,
          });
        }
      }

      const delegateMatch = line.match(ACTION_HANDLER_DELEGATE_PATTERN);
      if (delegateMatch) {
        const key = `delegate:${delegateMatch[1]}`;
        if (!seenDeps.has(key)) {
          seenDeps.add(key);
          deps.push({
            type: 'delegate',
            targetAgent: delegateMatch[1],
            sourceLine: lineNum,
            sourceSection: currentSection,
          });
        }
      }
    }

    // TOOLS section: FROM "path" USE: tool1, tool2
    if (currentSection === 'TOOLS') {
      const toolMatch = line.match(TOOL_IMPORT_PATTERN);
      if (toolMatch) {
        const sourcePath = toolMatch[1];
        const toolNames = toolMatch[2]
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        deps.push({
          type: 'tool_import',
          targetAgent: sourcePath,
          sourceLine: lineNum,
          sourceSection: 'TOOLS',
          toolNames,
          sourcePath,
        });
      }
    }

    // Inline HANDOFF references in ON_ERROR, CONSTRAINTS, and ESCALATE sections.
    // Skip on_human_complete sub-section — its actions are opaque strings (e.g.
    // "HANDOFF to specified_agent") that are not resolvable agent references.
    if (
      (currentSection === 'ON_ERROR' ||
        currentSection === 'CONSTRAINTS' ||
        currentSection === 'ESCALATE') &&
      escalateSubSection !== 'on_human_complete'
    ) {
      const thenMatch = line.match(THEN_HANDOFF_PATTERN);
      if (thenMatch) {
        const key = `inline_handoff:${thenMatch[1]}`;
        if (!seenDeps.has(key)) {
          seenDeps.add(key);
          deps.push({
            type: 'inline_handoff',
            targetAgent: thenMatch[1],
            sourceLine: lineNum,
            sourceSection: currentSection,
          });
        }
        continue;
      }

      const inlineMatch = line.match(INLINE_HANDOFF_PATTERN);
      if (inlineMatch && !line.match(HANDOFF_TO_PATTERN)) {
        const key = `inline_handoff:${inlineMatch[1]}`;
        if (!seenDeps.has(key)) {
          seenDeps.add(key);
          deps.push({
            type: 'inline_handoff',
            targetAgent: inlineMatch[1],
            sourceLine: lineNum,
            sourceSection: currentSection,
          });
        }
      }
    }
  }

  return deps;
}
