/**
 * RECALL Event Validation
 *
 * Validates RECALL instruction event names against known lifecycle patterns.
 * Warns when events reference unknown tools, unknown agents, or don't match
 * any recognized lifecycle pattern.
 */

import { LIFECYCLE_PATTERNS, LEGACY_EVENT_ALIASES } from '../constants.js';
import type { ValidationDiagnostic } from './validation-types.js';
import { VALIDATION_CODES } from './validation-types.js';

/**
 * Validate RECALL event names against lifecycle patterns and declared references.
 *
 * Checks:
 * 1. Legacy aliases (session_start, etc.) are rejected with an explicit error.
 * 2. Events matching lifecycle patterns are accepted, but tool/agent references
 *    are checked against declared tools and known agents.
 * 3. Completely unrecognized events produce a warning.
 *
 * @param recall - Array of recall instructions with event names
 * @param declaredTools - Tools declared in the agent
 * @param knownAgents - Agent names known in the compilation context
 * @param agentName - The agent being validated (for diagnostic location)
 */
export function validateRecallEvents(
  recall: Array<{ event: string }>,
  declaredTools: Array<{ name: string }>,
  knownAgents: string[],
  agentName?: string,
  opts: { singleAgentScope?: boolean } = {},
): ValidationDiagnostic[] {
  const toolNames = new Set(declaredTools.map((t) => t.name));
  const agentNames = new Set(knownAgents);
  const diagnostics: ValidationDiagnostic[] = [];
  const blockedToolBeforePattern = /^tool:(\*|[^:]+):before$/;

  for (const r of recall) {
    const event = r.event;

    if (Object.prototype.hasOwnProperty.call(LEGACY_EVENT_ALIASES, event)) {
      const canonical = LEGACY_EVENT_ALIASES[event];
      diagnostics.push({
        agent: agentName ?? '(unknown)',
        message: `Legacy RECALL event "${event}" is no longer supported. Use "${canonical}" instead.`,
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.LEGACY_RECALL_EVENT_ALIAS,
      });
      continue;
    }

    if (blockedToolBeforePattern.test(event)) {
      diagnostics.push({
        agent: agentName ?? '(unknown)',
        message: `RECALL event "${event}" is blocked. Pre-tool RECALL can mutate context that tool dispatch is about to use, so only post-tool hooks are supported. Use "tool:<name>:after", "tool:*:after", or an agent:*:before hook instead.`,
        type: 'validation',
        severity: 'error',
        code: VALIDATION_CODES.BLOCKED_RECALL_TOOL_BEFORE_EVENT,
      });
      continue;
    }

    // Check against lifecycle patterns
    const matchesPattern = LIFECYCLE_PATTERNS.some((p) => p.test(event));

    if (matchesPattern) {
      // Valid pattern — but check if tool/agent reference exists
      const toolMatch = event.match(/^tool:([^:*]+):after$/);
      if (toolMatch && !toolNames.has(toolMatch[1])) {
        diagnostics.push({
          agent: agentName ?? '(unknown)',
          message: `RECALL event "${event}" references unknown tool "${toolMatch[1]}". Declared tools: ${[...toolNames].filter((n) => !n.startsWith('__')).join(', ') || '(none)'}`,
          type: 'validation',
          severity: 'warning',
          code: VALIDATION_CODES.UNKNOWN_RECALL_TOOL,
        });
        continue;
      }
      const agentMatch = event.match(/^agent:([^:*]+):(before|after)$/);
      if (agentMatch && !opts.singleAgentScope && !agentNames.has(agentMatch[1])) {
        diagnostics.push({
          agent: agentName ?? '(unknown)',
          message: `RECALL event "${event}" references unknown agent "${agentMatch[1]}". Known agents: ${[...agentNames].join(', ') || '(none)'}`,
          type: 'validation',
          severity: 'warning',
          code: VALIDATION_CODES.UNKNOWN_RECALL_AGENT,
        });
        continue;
      }
      // Valid pattern, valid references (or wildcards)
      continue;
    }

    // Completely unrecognized
    diagnostics.push({
      agent: agentName ?? '(unknown)',
      message: `RECALL event "${event}" does not match any known event pattern. Valid patterns: session:start, session:end, agent:<name>:before, agent:<name>:after, agent:*:before, agent:*:after, tool:<name>:after, tool:*:after, entity:<field>:extracted, step:enter:<name>, step:exit:<name>`,
      type: 'validation',
      severity: 'warning',
      code: VALIDATION_CODES.UNKNOWN_RECALL_EVENT,
    });
  }

  return diagnostics;
}
