/**
 * MCP Analysis Tools
 *
 * Local tools for analyzing ABL DSL content using @abl/language-service.
 * All tools are LOCAL — no platform auth required.
 *
 * Tools:
 *   kore_explain_dsl    — Parse and explain agent structure
 *   kore_suggest_improvements — Diagnostics + rule-based improvement suggestions
 *   kore_test_agent     — Compilation/diagnostic summary with counts
 */

import { detectFormat, getDiagnostics, getDocumentSymbols } from '@abl/language-service';
import type { DocumentSymbol, Diagnostic, SymbolKind } from '@abl/language-service';

// =============================================================================
// TYPES
// =============================================================================

export interface AnalysisTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
  };
}

interface Suggestion {
  severity: 'info' | 'warning' | 'error';
  message: string;
  category: string;
}

// =============================================================================
// TOOL DEFINITIONS
// =============================================================================

export const analysisTools: AnalysisTool[] = [
  {
    name: 'kore_explain_dsl',
    description: `Analyze ABL DSL content and return a structured explanation of the agent.
Returns:
- Agent name and format (yaml/legacy)
- Execution mode (scripted/reasoning/supervisor)
- Flow steps (for scripted agents)
- Tools declared
- Gather fields
- Constraints
- Handoff and delegate targets
- Section summary with counts

Use this to understand what an agent does before making changes.`,
    inputSchema: {
      type: 'object',
      properties: {
        dsl: {
          type: 'string',
          description: 'ABL DSL content to analyze',
        },
      },
      required: ['dsl'],
    },
  },
  {
    name: 'kore_suggest_improvements',
    description: `Analyze ABL DSL content and return diagnostics plus rule-based improvement suggestions.
Returns:
- Parse diagnostics (errors and warnings from the parser)
- Improvement suggestions based on best practices:
  - Missing goal/persona
  - No constraints defined
  - No error transitions in flow steps
  - Unused tools (declared but not referenced in steps)
  - Missing handoffs for multi-agent scenarios
  - Large flow step count without constraints
  - Gather fields without validation hints

Use this for code review and quality improvement of agent definitions.`,
    inputSchema: {
      type: 'object',
      properties: {
        dsl: {
          type: 'string',
          description: 'ABL DSL content to analyze',
        },
      },
      required: ['dsl'],
    },
  },
  {
    name: 'kore_test_agent',
    description: `Run diagnostics on ABL DSL content and return a compilation/validation summary.
Returns:
- Overall status (pass/fail/warning)
- Error count and warning count
- Diagnostics list with line numbers
- Agent structure summary (tool count, step count, field count, etc.)
- Format detected (yaml/legacy)

Use this as a quick health check for agent definitions.`,
    inputSchema: {
      type: 'object',
      properties: {
        dsl: {
          type: 'string',
          description: 'ABL DSL content to validate',
        },
      },
      required: ['dsl'],
    },
  },
];

/** Tool names that are local (no auth required) */
export const LOCAL_ANALYSIS_TOOLS = new Set([
  'kore_explain_dsl',
  'kore_suggest_improvements',
  'kore_test_agent',
]);

// =============================================================================
// HELPERS
// =============================================================================

/**
 * Collect all symbols of a given kind from the symbol tree.
 */
function collectSymbolsByKind(symbols: DocumentSymbol[], kind: SymbolKind): DocumentSymbol[] {
  const result: DocumentSymbol[] = [];
  for (const sym of symbols) {
    if (sym.kind === kind) {
      result.push(sym);
    }
    if (sym.children.length > 0) {
      result.push(...collectSymbolsByKind(sym.children, kind));
    }
  }
  return result;
}

/**
 * Extract the execution mode from raw DSL source.
 * Checks both yaml (mode:) and legacy (MODE:) formats.
 */
function extractMode(dsl: string): string | null {
  const lines = dsl.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // YAML: mode: scripted
    const yamlMatch = trimmed.match(/^mode\s*:\s*(.+)$/);
    if (yamlMatch) {
      return yamlMatch[1].trim().replace(/^["']|["']$/g, '');
    }
    // Legacy: MODE: scripted
    const legacyMatch = trimmed.match(/^MODE\s*:\s*(.+)$/);
    if (legacyMatch) {
      return legacyMatch[1].trim().replace(/^["']|["']$/g, '');
    }
  }
  return null;
}

/**
 * Check if the DSL contains a GOAL or goal section.
 */
function hasGoal(dsl: string): boolean {
  const lines = dsl.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^goal\s*:/i.test(trimmed) || /^GOAL\s*:/i.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if the DSL contains a PERSONA or persona section.
 */
function hasPersona(dsl: string): boolean {
  const lines = dsl.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    if (/^persona\s*:/i.test(trimmed) || /^PERSONA\s*:/i.test(trimmed)) {
      return true;
    }
  }
  return false;
}

/**
 * Check if any flow step has error/fallback transitions.
 * Looks for "error:" or "on_error:" or "fallback:" in transitions.
 */
function hasErrorTransitions(dsl: string): boolean {
  const lower = dsl.toLowerCase();
  return lower.includes('on_error:') || lower.includes('error:') || lower.includes('fallback:');
}

/**
 * Extract tool names referenced in flow step actions (call: tool_name).
 */
function extractReferencedTools(dsl: string): Set<string> {
  const refs = new Set<string>();
  const lines = dsl.split('\n');
  for (const line of lines) {
    const trimmed = line.trim();
    // call: tool_name
    const callMatch = trimmed.match(/^call\s*:\s*(.+)$/);
    if (callMatch) {
      refs.add(callMatch[1].trim().replace(/^["']|["']$/g, ''));
    }
  }
  return refs;
}

// =============================================================================
// HANDLER: kore_explain_dsl
// =============================================================================

function explainDsl(dsl: string): Record<string, unknown> {
  const format = detectFormat(dsl);
  const symbols = getDocumentSymbols(dsl);
  const mode = extractMode(dsl);

  // Extract agent root
  const agentSymbols = collectSymbolsByKind(symbols, 'agent');
  const agentName = agentSymbols.length > 0 ? agentSymbols[0].name : 'unknown';

  // Extract sections
  const tools = collectSymbolsByKind(symbols, 'tool');
  const steps = collectSymbolsByKind(symbols, 'step');
  const fields = collectSymbolsByKind(symbols, 'field');
  const constraints = collectSymbolsByKind(symbols, 'constraint');
  const handoffs = collectSymbolsByKind(symbols, 'handoff');
  const delegates = collectSymbolsByKind(symbols, 'delegate');
  const handlers = collectSymbolsByKind(symbols, 'handler');

  const explanation: Record<string, unknown> = {
    agentName,
    format,
    mode: mode ?? 'unknown',
    hasGoal: hasGoal(dsl),
    hasPersona: hasPersona(dsl),
    sections: {
      tools: tools.map((t) => t.name),
      steps: steps.map((s) => s.name),
      gatherFields: fields.map((f) => f.name),
      constraints: constraints.map((c) => c.name),
      handoffs: handoffs.map((h) => h.name),
      delegates: delegates.map((d) => d.name),
      handlers: handlers.map((h) => h.name),
    },
    counts: {
      tools: tools.length,
      steps: steps.length,
      gatherFields: fields.length,
      constraints: constraints.length,
      handoffs: handoffs.length,
      delegates: delegates.length,
      handlers: handlers.length,
    },
  };

  // Add mode-specific context
  if (mode === 'scripted' && steps.length > 0) {
    explanation.flowSummary = `Scripted flow with ${steps.length} step(s): ${steps.map((s) => s.name).join(' -> ')}`;
  } else if (mode === 'reasoning') {
    explanation.flowSummary = `Reasoning agent with ${tools.length} tool(s) available for autonomous decision-making`;
  } else if (mode === 'supervisor') {
    explanation.flowSummary = `Supervisor agent coordinating ${delegates.length} delegate(s) and ${handoffs.length} handoff target(s)`;
  }

  return explanation;
}

// =============================================================================
// HANDLER: kore_suggest_improvements
// =============================================================================

function suggestImprovements(dsl: string): Record<string, unknown> {
  const diagnostics = getDiagnostics(dsl);
  const symbols = getDocumentSymbols(dsl);
  const mode = extractMode(dsl);

  const tools = collectSymbolsByKind(symbols, 'tool');
  const steps = collectSymbolsByKind(symbols, 'step');
  const fields = collectSymbolsByKind(symbols, 'field');
  const constraints = collectSymbolsByKind(symbols, 'constraint');
  const handoffs = collectSymbolsByKind(symbols, 'handoff');
  const delegates = collectSymbolsByKind(symbols, 'delegate');

  const suggestions: Suggestion[] = [];

  // Rule: Missing goal
  if (!hasGoal(dsl)) {
    suggestions.push({
      severity: 'warning',
      message:
        "No goal defined. Adding a goal helps the LLM understand the agent's purpose and improves response quality.",
      category: 'completeness',
    });
  }

  // Rule: Missing persona
  if (!hasPersona(dsl)) {
    suggestions.push({
      severity: 'info',
      message: 'No persona defined. A persona gives the agent a consistent communication style.',
      category: 'completeness',
    });
  }

  // Rule: No constraints
  if (constraints.length === 0) {
    suggestions.push({
      severity: 'warning',
      message:
        'No constraints defined. Constraints enforce guardrails during execution (e.g., data validation, safety rules).',
      category: 'safety',
    });
  }

  // Rule: Scripted agent without error transitions
  if (mode === 'scripted' && steps.length > 0 && !hasErrorTransitions(dsl)) {
    suggestions.push({
      severity: 'warning',
      message:
        'No error transitions found in flow steps. Consider adding on_error or fallback transitions to handle failures gracefully.',
      category: 'resilience',
    });
  }

  // Rule: Unused tools (tools declared but not referenced in call: actions)
  if (tools.length > 0 && mode === 'scripted') {
    const referencedTools = extractReferencedTools(dsl);
    const unusedTools = tools.filter((t) => !referencedTools.has(t.name));
    if (unusedTools.length > 0) {
      suggestions.push({
        severity: 'info',
        message: `Potentially unused tools: ${unusedTools.map((t) => t.name).join(', ')}. These are declared but not referenced in any flow step call: action.`,
        category: 'cleanup',
      });
    }
  }

  // Rule: Large flow without constraints
  const LARGE_FLOW_THRESHOLD = 5;
  if (steps.length > LARGE_FLOW_THRESHOLD && constraints.length === 0) {
    suggestions.push({
      severity: 'warning',
      message: `Flow has ${steps.length} steps but no constraints. Complex flows benefit from constraints to prevent invalid state transitions.`,
      category: 'safety',
    });
  }

  // Rule: Gather fields exist but agent has no tools
  if (fields.length > 0 && tools.length === 0) {
    suggestions.push({
      severity: 'info',
      message:
        'Gather fields are defined but no tools are available. Consider adding tools to process the collected data.',
      category: 'completeness',
    });
  }

  // Rule: Supervisor without delegates or handoffs
  if (mode === 'supervisor' && delegates.length === 0 && handoffs.length === 0) {
    suggestions.push({
      severity: 'error',
      message:
        'Supervisor agent has no delegates or handoff targets. A supervisor needs agents to coordinate.',
      category: 'structural',
    });
  }

  // Rule: Many handoffs suggest supervisor pattern
  const HANDOFF_THRESHOLD = 3;
  if (mode !== 'supervisor' && handoffs.length >= HANDOFF_THRESHOLD) {
    suggestions.push({
      severity: 'info',
      message: `Agent has ${handoffs.length} handoff targets. Consider using a supervisor agent pattern for complex multi-agent coordination.`,
      category: 'architecture',
    });
  }

  return {
    diagnostics: diagnostics.map((d: Diagnostic) => ({
      severity: d.severity,
      message: d.message,
      line: d.line,
      column: d.column,
      source: d.source,
    })),
    diagnosticCounts: {
      errors: diagnostics.filter((d: Diagnostic) => d.severity === 'error').length,
      warnings: diagnostics.filter((d: Diagnostic) => d.severity === 'warning').length,
      info: diagnostics.filter((d: Diagnostic) => d.severity === 'info').length,
      hints: diagnostics.filter((d: Diagnostic) => d.severity === 'hint').length,
    },
    suggestions,
    suggestionCount: suggestions.length,
  };
}

// =============================================================================
// HANDLER: kore_test_agent
// =============================================================================

function testAgent(dsl: string): Record<string, unknown> {
  const format = detectFormat(dsl);
  const diagnostics = getDiagnostics(dsl);
  const symbols = getDocumentSymbols(dsl);
  const mode = extractMode(dsl);

  const errors = diagnostics.filter((d: Diagnostic) => d.severity === 'error');
  const warnings = diagnostics.filter((d: Diagnostic) => d.severity === 'warning');

  // Determine overall status
  let status: 'pass' | 'fail' | 'warning';
  if (errors.length > 0) {
    status = 'fail';
  } else if (warnings.length > 0) {
    status = 'warning';
  } else {
    status = 'pass';
  }

  // Gather structure counts
  const tools = collectSymbolsByKind(symbols, 'tool');
  const steps = collectSymbolsByKind(symbols, 'step');
  const fields = collectSymbolsByKind(symbols, 'field');
  const constraints = collectSymbolsByKind(symbols, 'constraint');
  const handoffs = collectSymbolsByKind(symbols, 'handoff');
  const delegates = collectSymbolsByKind(symbols, 'delegate');

  const agentSymbols = collectSymbolsByKind(symbols, 'agent');
  const agentName = agentSymbols.length > 0 ? agentSymbols[0].name : 'unknown';

  return {
    status,
    agentName,
    format,
    mode: mode ?? 'unknown',
    errorCount: errors.length,
    warningCount: warnings.length,
    diagnostics: diagnostics.map((d: Diagnostic) => ({
      severity: d.severity,
      message: d.message,
      line: d.line,
      column: d.column,
      source: d.source,
    })),
    structure: {
      tools: tools.length,
      steps: steps.length,
      gatherFields: fields.length,
      constraints: constraints.length,
      handoffs: handoffs.length,
      delegates: delegates.length,
    },
    summary:
      status === 'pass'
        ? `Agent "${agentName}" passed validation with no issues.`
        : status === 'warning'
          ? `Agent "${agentName}" has ${warnings.length} warning(s) but no errors.`
          : `Agent "${agentName}" has ${errors.length} error(s) and ${warnings.length} warning(s).`,
  };
}

// =============================================================================
// DISPATCH
// =============================================================================

/**
 * Handle an analysis tool call. Validates the dsl parameter and dispatches
 * to the appropriate handler function.
 */
export async function handleAnalysisTool(
  name: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  const dsl = args.dsl;

  if (typeof dsl !== 'string' || !dsl.trim()) {
    throw new Error(
      'Required parameter "dsl" must be a non-empty string containing ABL DSL content.',
    );
  }

  switch (name) {
    case 'kore_explain_dsl':
      return explainDsl(dsl);

    case 'kore_suggest_improvements':
      return suggestImprovements(dsl);

    case 'kore_test_agent':
      return testAgent(dsl);

    default:
      throw new Error(`Unknown analysis tool: ${name}`);
  }
}
