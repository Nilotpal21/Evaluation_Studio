/**
 * getCompletions — Context-aware completion suggestions for ABL YAML files.
 *
 * Analyzes cursor position to determine the enclosing section and returns
 * appropriate suggestions:
 *   - Top-level: remaining ABL top-level keys
 *   - Tools section: tool names from CompletionContext
 *   - Flow step: step keywords (respond, call, then, gather, etc.)
 *   - Handoff/delegate target: agent names from CompletionContext
 *   - CEL expression contexts: function completions (when, validate, set, etc.)
 *   - Value completions: enum-like fields (mode, type, action, strategy, priority)
 *   - Gather field: property completions and type values
 */

import type { Position, CompletionItem, CompletionKind, CompletionContext } from './types.js';
import { CEL_FUNCTIONS } from './cel-functions.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** All recognized ABL YAML-format top-level keys. */
const TOP_LEVEL_KEYS: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'agent', detail: 'Agent name' },
  { key: 'supervisor', detail: 'Supervisor name' },
  { key: 'goal', detail: 'Agent goal description' },
  { key: 'persona', detail: 'Agent personality and tone' },
  { key: 'limitations', detail: 'Agent limitations and boundaries' },
  { key: 'execution', detail: 'Model and runtime configuration' },
  { key: 'tools', detail: 'Tool definitions' },
  { key: 'gather', detail: 'Information gathering fields' },
  { key: 'memory', detail: 'Session and persistent memory' },
  { key: 'constraints', detail: 'Behavioral constraints and rules' },
  { key: 'guardrails', detail: 'Security guardrails' },
  { key: 'flow', detail: 'Scripted flow definition' },
  { key: 'handoff', detail: 'Handoff targets' },
  { key: 'return_handlers', detail: 'Named post-return handoff handlers' },
  { key: 'delegate', detail: 'Delegate targets' },
  { key: 'escalate', detail: 'Human escalation rules' },
  { key: 'on_start', detail: 'Startup handler' },
  { key: 'complete', detail: 'Completion conditions' },
  { key: 'on_error', detail: 'Error handlers' },
  { key: 'identity', detail: 'Agent identity (legacy)' },
  { key: 'context', detail: 'Context variables' },
  { key: 'mode', detail: 'Execution mode (deprecated)' },
];

/** Top-level keys for the legacy colon-separated format (AGENT:, MODE:, etc.). */
const LEGACY_TOP_LEVEL_KEYS: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'AGENT', detail: 'Agent name' },
  { key: 'MODE', detail: 'Execution mode (reasoning | scripted)' },
  { key: 'GOAL', detail: 'Agent goal description' },
  { key: 'TOOLS', detail: 'Tool definitions' },
  { key: 'FLOW', detail: 'Scripted flow definition' },
  { key: 'CONSTRAINTS', detail: 'Behavioral constraints' },
  { key: 'HANDOFF', detail: 'Handoff targets' },
  { key: 'DELEGATE', detail: 'Delegate targets' },
  { key: 'GATHER', detail: 'Information gathering fields' },
  { key: 'IDENTITY', detail: 'Agent identity / persona' },
  { key: 'CONTEXT', detail: 'Context variables' },
  { key: 'MODEL', detail: 'Model configuration (legacy)' },
];

/** Keywords valid inside a flow step body. */
const FLOW_STEP_KEYWORDS: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'respond', detail: 'Send a message to the user' },
  { key: 'call', detail: 'Call a tool' },
  { key: 'then', detail: 'Next step to transition to' },
  { key: 'gather', detail: 'Collect information from the user' },
  { key: 'set', detail: 'Set a context variable' },
  { key: 'when', detail: 'Conditional branch' },
  { key: 'on_success', detail: 'Handler for successful tool call' },
  { key: 'on_failure', detail: 'Handler for failed tool call' },
  { key: 'prompt', detail: 'Prompt template for LLM' },
  { key: 'validate', detail: 'Validation rule' },
];

/** CEL expression context keywords — lines ending with these trigger function completions. */
const CEL_EXPRESSION_KEYS = ['when', 'validate', 'success_when', 'condition'];
const CEL_EXPRESSION_REGEXES: ReadonlyArray<RegExp> = CEL_EXPRESSION_KEYS.map(
  (key) => new RegExp(`^${key}\\s*:\\s`),
);

/** Known values for enum-like fields. Key is the YAML field name. */
const VALUE_COMPLETIONS: Record<string, ReadonlyArray<{ value: string; detail?: string }>> = {
  mode: [
    { value: 'reasoning', detail: 'LLM-driven autonomous mode' },
    { value: 'scripted', detail: 'Deterministic flow-based mode' },
  ],
  type: [
    { value: 'http', detail: 'HTTP API tool' },
    { value: 'mcp', detail: 'Model Context Protocol tool' },
    { value: 'lambda', detail: 'AWS Lambda tool' },
    { value: 'sandbox', detail: 'Sandboxed execution tool' },
    { value: 'async_webhook', detail: 'Async webhook with callback' },
  ],
  action: [
    { value: 'handoff', detail: 'Transfer to another agent' },
    { value: 'escalate', detail: 'Escalate to a human or higher-tier agent' },
    { value: 'delegate', detail: 'Delegate a subtask to another agent' },
    { value: 'complete', detail: 'Complete the conversation' },
    { value: 'respond', detail: 'Send a response to user' },
  ],
  strategy: [
    { value: 'parallel', detail: 'Execute in parallel' },
    { value: 'sequential', detail: 'Execute sequentially' },
    { value: 'fallback', detail: 'Try alternatives on failure' },
  ],
  priority: [
    { value: 'low', detail: 'Low priority' },
    { value: 'medium', detail: 'Medium priority' },
    { value: 'high', detail: 'High priority' },
    { value: 'urgent', detail: 'Urgent priority' },
  ],
  history: [
    { value: 'auto', detail: 'Use summary when safe; otherwise fall back to bounded raw history' },
    { value: 'none', detail: 'Start child fresh with no copied transcript' },
    { value: 'summary_only', detail: 'Pass only the authored handoff summary' },
    { value: 'full', detail: 'Pass the full parent conversation history' },
    {
      value: 'last_<n>',
      detail:
        'Legacy shorthand for passing the last N raw messages. Prefer a history block with mode: last_n and count.',
    },
  ],
  gather_type: [
    { value: 'string', detail: 'Text value' },
    { value: 'number', detail: 'Numeric value' },
    { value: 'boolean', detail: 'True/false value' },
    { value: 'date', detail: 'Date value' },
    { value: 'email', detail: 'Email address' },
    { value: 'phone', detail: 'Phone number' },
    { value: 'enum', detail: 'One of a set of options' },
    { value: 'array', detail: 'List of values' },
  ],
};

/** Built-in agent transfer tools available for all agents. */
const BUILT_IN_TOOLS: ReadonlyArray<{ name: string; description: string; type: string }> = [
  {
    name: 'transfer_to_agent',
    description: 'Transfer conversation to a human agent',
    type: 'builtin',
  },
  { name: 'check_hours', description: 'Check agent desktop business hours', type: 'builtin' },
  { name: 'check_availability', description: 'Check human agent availability', type: 'builtin' },
  { name: 'set_queue', description: 'Set the routing queue for agent transfer', type: 'builtin' },
  { name: 'ivr_menu', description: 'Present IVR menu options (voice only)', type: 'builtin' },
  {
    name: 'ivr_digit_input',
    description: 'Collect DTMF digit input (voice only)',
    type: 'builtin',
  },
  {
    name: 'call_transfer',
    description: 'Transfer call via SIP REFER (voice only)',
    type: 'builtin',
  },
  {
    name: 'deflect_to_chat',
    description: 'Deflect voice call to chat channel (voice only)',
    type: 'builtin',
  },
];

/** Properties valid inside a gather field definition. */
const GATHER_FIELD_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'type', detail: 'Field data type' },
  { key: 'required', detail: 'Whether the field is required' },
  { key: 'description', detail: 'Field description shown to user' },
  { key: 'extraction_hints', detail: 'Hints for extracting value from user input' },
  { key: 'validate', detail: 'Validation expression' },
  { key: 'default', detail: 'Default value if not provided' },
  { key: 'options', detail: 'Valid options for enum type' },
  { key: 'prompt', detail: 'Prompt to ask the user for this field' },
];

/** Properties valid inside the EXECUTION: section. */
const EXECUTION_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'model', detail: 'LLM model name (e.g. claude-sonnet-4-20250514)' },
  { key: 'temperature', detail: 'LLM temperature (0.0 - 1.0)' },
  { key: 'max_tokens', detail: 'Maximum tokens in LLM response' },
  { key: 'max_iterations', detail: 'Max reasoning iterations' },
  { key: 'max_flow_iterations', detail: 'Max flow loop iterations' },
  { key: 'fallback_model', detail: 'Fallback model if primary fails' },
  { key: 'reasoning_effort', detail: 'Reasoning effort (low | medium | high)' },
  { key: 'enable_thinking', detail: 'Enable extended thinking (Anthropic)' },
  { key: 'thinking_budget', detail: 'Token budget for extended thinking' },
  { key: 'compaction_threshold', detail: 'Context-usage ratio triggering compaction (0-1)' },
  { key: 'inline_gather', detail: 'Merge extraction into reasoning tool set' },
  { key: 'concurrency', detail: 'Message processing (serial | preemptive | parallel)' },
  { key: 'max_queue_depth', detail: 'Maximum pending messages in queue' },
];

/** Properties valid inside a TOOLS: tool definition (indent 4+). */
const TOOL_DEFINITION_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'description', detail: 'Human-readable tool description' },
  { key: 'type', detail: 'Tool type (http | mcp | sandbox | lambda | async_webhook)' },
  { key: 'endpoint', detail: 'HTTP endpoint URL' },
  { key: 'method', detail: 'HTTP method (GET | POST | PUT | DELETE)' },
  { key: 'headers', detail: 'HTTP headers map' },
  { key: 'body', detail: 'Request body template' },
  { key: 'auth', detail: 'Authentication config' },
  { key: 'timeout', detail: 'Tool execution timeout' },
  { key: 'retry', detail: 'Retry count on failure' },
  { key: 'params', detail: 'Parameter definitions' },
  { key: 'on_result', detail: 'Variable mappings on success' },
  { key: 'on_error', detail: 'Variable mappings on error' },
  { key: 'confirmation', detail: 'Require user confirmation before execution' },
  { key: 'store_result', detail: 'Store raw result in session data' },
  { key: 'context_access', detail: 'Declarative session var injection' },
  { key: 'pii_access', detail: 'PII access level (tools | user | logs | llm)' },
];

/** Properties valid inside a GUARDRAILS: guardrail definition (indent 4+). */
const GUARDRAIL_DEFINITION_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'kind', detail: 'When guardrail fires (input | output | both)' },
  { key: 'check', detail: 'CEL expression to evaluate (Tier 1)' },
  { key: 'action', detail: 'Action on violation (block | redact | warn | flag | rewrite)' },
  { key: 'priority', detail: 'Execution priority (lower = first)' },
  { key: 'description', detail: 'Human-readable description' },
  { key: 'provider', detail: 'Model-based provider name (Tier 2)' },
  { key: 'category', detail: 'Safety taxonomy category' },
  { key: 'threshold', detail: 'Score threshold 0.0 - 1.0' },
  { key: 'llmCheck', detail: 'Natural language check prompt (Tier 3)' },
  { key: 'streaming', detail: 'Enable mid-stream evaluation' },
];

/** Properties valid inside the MEMORY: section (indent 2). */
const MEMORY_SECTION_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'SESSION', detail: 'Session-scoped variables (reset per conversation)' },
  { key: 'PERSISTENT', detail: 'Persistent user/system memory paths' },
  { key: 'REMEMBER', detail: 'Automatic memory triggers' },
  { key: 'RECALL', detail: 'Memory recall instructions' },
];

/** Properties valid inside a CONSTRAINTS: phase block (indent 4). */
const CONSTRAINT_RULE_KEYWORDS: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'REQUIRE', detail: 'Blocking rule — fails execution if false' },
  { key: 'WARN', detail: 'Warning rule — emits warning but continues' },
  { key: 'ON_FAIL', detail: 'Action when constraint fails' },
];

/** Properties valid inside a HANDOFF: entry (indent 4). */
const HANDOFF_ENTRY_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'TO', detail: 'Target agent name' },
  { key: 'WHEN', detail: 'Condition triggering handoff' },
  { key: 'CONTEXT', detail: 'Context to pass to target agent' },
  { key: 'RETURN', detail: 'Whether to return after handoff' },
  { key: 'ON_RETURN', detail: 'Action after returning from handoff' },
  { key: 'PRIORITY', detail: 'Handoff priority (low | medium | high)' },
  { key: 'TIMEOUT', detail: 'Handoff timeout duration' },
  { key: 'ON_TIMEOUT', detail: 'Action on handoff timeout' },
];

/** Properties valid inside HANDOFF > CONTEXT: block. */
const HANDOFF_CONTEXT_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'pass', detail: 'Variables to pass to target agent' },
  { key: 'summary', detail: 'Conversation summary to include' },
  { key: 'memory_grants', detail: 'Explicit memory grants to expose to the target agent' },
  {
    key: 'history',
    detail:
      'History strategy (auto | none | summary_only | full | history: { mode: last_n, count })',
  },
];

const HANDOFF_HISTORY_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'mode', detail: 'History mode (auto | none | summary_only | full | last_n)' },
  { key: 'count', detail: 'Required when mode is last_n' },
];

const HANDOFF_HISTORY_MODE_VALUES: ReadonlyArray<{ value: string; detail?: string }> = [
  { value: 'auto', detail: 'Prefer summary-only when a real summary exists, otherwise fallback' },
  { value: 'none', detail: 'Do not pass summary or raw history' },
  { value: 'summary_only', detail: 'Pass only the authored summary' },
  { value: 'full', detail: 'Pass the full parent transcript' },
  { value: 'last_n', detail: 'Pass a bounded raw history window; requires count' },
];

/** Properties for ON_ERROR: entries. */
const ON_ERROR_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'type', detail: 'Error type to handle (tool_timeout | tool_error | parse_error)' },
  { key: 'retry', detail: 'Number of retries' },
  { key: 'respond', detail: 'Message to send on error' },
  { key: 'escalate', detail: 'Escalate to human on error' },
  { key: 'fallback', detail: 'Fallback action' },
];

/** Properties for COMPLETE: entries. */
const COMPLETE_ENTRY_PROPERTIES: ReadonlyArray<{ key: string; detail: string }> = [
  { key: 'WHEN', detail: 'Completion condition expression' },
  { key: 'RESPOND', detail: 'Message to send on completion' },
];

/** Values for guardrail kind. */
const GUARDRAIL_KIND_VALUES: ReadonlyArray<{ value: string; detail?: string }> = [
  { value: 'input', detail: 'Check user input before processing' },
  { value: 'output', detail: 'Check agent output before sending' },
  { value: 'both', detail: 'Check both input and output' },
  { value: 'tool_input', detail: 'Check input before tool call' },
  { value: 'tool_output', detail: 'Check tool call result' },
  { value: 'handoff', detail: 'Check before handoff' },
];

/** Values for guardrail action. */
const GUARDRAIL_ACTION_VALUES: ReadonlyArray<{ value: string; detail?: string }> = [
  { value: 'block', detail: 'Block the message entirely' },
  { value: 'redact', detail: 'Redact the matching content' },
  { value: 'warn', detail: 'Allow but emit a warning' },
  { value: 'flag', detail: 'Flag for review but allow' },
  { value: 'rewrite', detail: 'Rewrite the content' },
];

/** Values for HTTP method. */
const HTTP_METHOD_VALUES: ReadonlyArray<{ value: string; detail?: string }> = [
  { value: 'GET', detail: 'Retrieve resource' },
  { value: 'POST', detail: 'Create resource' },
  { value: 'PUT', detail: 'Update resource' },
  { value: 'PATCH', detail: 'Partial update' },
  { value: 'DELETE', detail: 'Delete resource' },
];

/** Values for error type in ON_ERROR. */
const ERROR_TYPE_VALUES: ReadonlyArray<{ value: string; detail?: string }> = [
  { value: 'tool_timeout', detail: 'Tool execution timed out' },
  { value: 'tool_error', detail: 'Tool returned an error' },
  { value: 'parse_error', detail: 'Failed to parse tool result' },
  { value: 'llm_error', detail: 'LLM call failed' },
  { value: 'constraint_violation', detail: 'Constraint check failed' },
  { value: 'guardrail_violation', detail: 'Guardrail check failed' },
];

/** Values for concurrency strategy. */
const CONCURRENCY_VALUES: ReadonlyArray<{ value: string; detail?: string }> = [
  { value: 'serial', detail: 'Process messages one at a time' },
  { value: 'preemptive', detail: 'Cancel current on new message' },
  { value: 'parallel', detail: 'Process multiple messages concurrently' },
];

/** Values for reasoning_effort. */
const REASONING_EFFORT_VALUES: ReadonlyArray<{ value: string; detail?: string }> = [
  { value: 'low', detail: 'Minimal reasoning (faster)' },
  { value: 'medium', detail: 'Balanced reasoning' },
  { value: 'high', detail: 'Maximum reasoning (slower)' },
];

/** Values for tool type. */
const TOOL_TYPE_VALUES: ReadonlyArray<{ value: string; detail?: string }> = [
  { value: 'http', detail: 'HTTP API tool' },
  { value: 'mcp', detail: 'Model Context Protocol tool' },
  { value: 'sandbox', detail: 'Sandboxed code execution' },
  { value: 'lambda', detail: 'AWS Lambda function' },
  { value: 'async_webhook', detail: 'Async webhook with callback' },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Determine which top-level section encloses the given cursor line by
 * scanning upward from the cursor position. Returns the key name (e.g.
 * "tools", "flow", "handoff") or null if none found.
 */
function findEnclosingSection(lines: string[], cursorLineIdx: number): string | null {
  for (let i = cursorLineIdx; i >= 0; i--) {
    const trimmed = lines[i].trimStart();
    // A top-level key starts at column 0 with no leading whitespace
    if (lines[i].length > 0 && lines[i][0] !== ' ' && lines[i][0] !== '\t') {
      // Match both lowercase (yaml) and UPPERCASE (legacy) section headers
      const match = trimmed.match(/^([a-zA-Z][a-zA-Z_]*)\s*:/);
      if (match) {
        return match[1].toLowerCase();
      }
    }
  }
  return null;
}

/**
 * Determine if the cursor is inside a named child definition of a section.
 * E.g., inside a tool definition under TOOLS:, or a guardrail under GUARDRAILS:.
 *
 * Pattern:
 *   section_keyword:       (indent 0)
 *     child_name:          (indent 2) ← named child
 *       <cursor>           (indent 4+) ← inside child definition
 */
function isInsideSectionChild(
  lines: string[],
  cursorLineIdx: number,
  sectionName: string,
): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorIndent = cursorLine.length - cursorLine.trimStart().length;
  if (cursorIndent < 4) return false;

  let foundChildName = false;
  for (let i = cursorLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (indent === 0 && /^[a-zA-Z][a-zA-Z_]*\s*:/.test(trimmed)) {
      return trimmed.toLowerCase().startsWith(sectionName) && foundChildName;
    }

    if (!foundChildName && indent < cursorIndent && indent >= 2 && /^\S+\s*:/.test(trimmed)) {
      foundChildName = true;
    }
  }
  return false;
}

/**
 * Determine if cursor is at the direct child level (indent 2) of a section.
 * E.g., adding a new tool name under TOOLS:, or a new guardrail under GUARDRAILS:.
 */
function isAtSectionChildLevel(
  lines: string[],
  cursorLineIdx: number,
  sectionName: string,
): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorIndent = cursorLine.length - cursorLine.trimStart().length;
  if (cursorIndent < 2 || cursorIndent > 3) return false;

  const section = findEnclosingSection(lines, cursorLineIdx);
  return section === sectionName;
}

/**
 * Determine if cursor is inside a HANDOFF > CONTEXT: block.
 */
function isInsideHandoffContext(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorIndent = cursorLine.length - cursorLine.trimStart().length;
  if (cursorIndent < 6) return false;

  for (let i = cursorLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (indent < cursorIndent && /^CONTEXT\s*:/i.test(trimmed)) {
      const section = findEnclosingSection(lines, i);
      return section === 'handoff' || section === 'delegate';
    }
    if (indent === 0) break;
  }
  return false;
}

function isInsideHandoffHistoryBlock(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorIndent = cursorLine.length - cursorLine.trimStart().length;
  if (cursorIndent < 8) return false;

  for (let i = cursorLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    if (indent < cursorIndent && /^history\s*:/i.test(trimmed)) {
      return isInsideHandoffContext(lines, i);
    }

    if (indent === 0) break;
  }

  return false;
}

/**
 * Get the field name on the cursor line if it matches a known value set
 * for section-specific fields (e.g., kind: inside guardrails).
 * Returns { section, field } or null.
 */
function getSectionValueField(
  lines: string[],
  cursorLineIdx: number,
): { section: string; field: string } | null {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const trimmed = cursorLine.trimStart();
  const match = trimmed.match(/^-?\s*([a-zA-Z][a-zA-Z_]*)\s*:\s*$/);
  if (!match) return null;

  const field = match[1].toLowerCase();
  const section = findEnclosingSection(lines, cursorLineIdx);
  if (!section) return null;

  return { section, field };
}

/**
 * Determine if the cursor is inside the body of a flow step (indented
 * inside `flow: > steps: > <stepName>:`).
 *
 * Heuristic: the cursor line has indent >= 6 (typically 6 spaces for step
 * body content), and scanning upward we find a step name line (indent ~4)
 * before hitting `steps:` (indent ~2) under `flow:` (indent 0).
 */
function isInsideFlowStep(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorIndent = cursorLine.length - cursorLine.trimStart().length;
  if (cursorIndent < 4) {
    return false;
  }

  // Scan upward looking for the pattern: stepName: at lower indent, steps: even lower, flow: at 0
  let foundStepName = false;
  let foundSteps = false;

  for (let i = cursorLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Stop if we hit a top-level key that is not 'flow'
    if (indent === 0 && /^[a-z][a-z_]*\s*:/.test(trimmed)) {
      return trimmed.startsWith('flow') && foundSteps && foundStepName;
    }

    if (!foundStepName && indent < cursorIndent && /^[a-z][a-z_]*\s*:/.test(trimmed)) {
      foundStepName = true;
      continue;
    }

    if (foundStepName && !foundSteps && /^steps\s*:/.test(trimmed)) {
      foundSteps = true;
      continue;
    }
  }

  return false;
}

/**
 * Determine if the cursor is positioned after `to:` inside a handoff or
 * delegate section.
 */
function isHandoffTarget(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const trimmed = cursorLine.trimStart();

  // Direct check: is the cursor on a `- to: ` or `to: ` line?
  if (/^-?\s*to\s*:\s*/.test(trimmed)) {
    // Verify enclosing section is handoff or delegate
    const section = findEnclosingSection(lines, cursorLineIdx);
    return section === 'handoff' || section === 'delegate';
  }

  return false;
}

/**
 * Determine if the cursor is in a CEL expression context.
 *
 * Returns true when the cursor line contains a CEL expression keyword
 * (when:, validate:, success_when:, condition:) with trailing space,
 * or when the cursor is on a `key: ` line inside a `set:` block.
 */
function isCelExpressionContext(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const trimmed = cursorLine.trimStart();

  // Check if the line matches a CEL expression keyword with trailing content/space
  for (const re of CEL_EXPRESSION_REGEXES) {
    if (re.test(trimmed)) {
      return true;
    }
  }

  // Check if inside a set: block on a `key: ` value line
  if (/^[a-z][a-z_0-9]*\s*:\s/.test(trimmed)) {
    // Scan upward for a `set:` parent
    const cursorIndent = cursorLine.length - trimmed.length;
    for (let i = cursorLineIdx - 1; i >= 0; i--) {
      const line = lines[i];
      const lineTrimmed = line.trimStart();
      const lineIndent = line.length - lineTrimmed.length;

      // Found a line at lower indent — check if it's `set:`
      if (lineIndent < cursorIndent) {
        return /^set\s*:\s*$/.test(lineTrimmed);
      }
    }
  }

  return false;
}

/**
 * Extract the field key from a `key: ` pattern on the cursor line.
 * Returns the key if it exists in VALUE_COMPLETIONS, otherwise null.
 */
function getValueFieldKey(line: string): string | null {
  const trimmed = line.trimStart();
  const match = trimmed.match(/^-?\s*([a-z][a-z_]*)\s*:\s*$/);
  if (match) {
    const key = match[1];
    if (key in VALUE_COMPLETIONS) {
      return key;
    }
  }
  return null;
}

/**
 * Determine if the cursor is inside a gather field definition.
 *
 * Pattern: cursor is indented inside a field name that is inside `gather:`.
 * Example:
 *   gather:
 *     name:        <-- field name (indent 2)
 *       <cursor>   <-- inside gather field (indent 4+)
 */
function isInsideGatherField(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const cursorIndent = cursorLine.length - cursorLine.trimStart().length;
  if (cursorIndent < 2) {
    return false;
  }

  // Scan upward: look for a field name at lower indent, then `gather:` at indent 0
  let foundFieldName = false;

  for (let i = cursorLineIdx - 1; i >= 0; i--) {
    const line = lines[i];
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // Stop at top-level key
    if (indent === 0 && /^[a-z][a-z_]*\s*:/.test(trimmed)) {
      return trimmed.startsWith('gather') && foundFieldName;
    }

    // Look for a field name at lower indent
    if (!foundFieldName && indent < cursorIndent && /^[a-z][a-z_0-9]*\s*:\s*$/.test(trimmed)) {
      foundFieldName = true;
      continue;
    }
  }

  return false;
}

/**
 * Determine if the cursor is on a `type: ` line inside a gather field.
 * This overrides the generic value completions to provide gather-specific types.
 */
function isGatherFieldTypeValue(lines: string[], cursorLineIdx: number): boolean {
  const cursorLine = lines[cursorLineIdx] ?? '';
  const trimmed = cursorLine.trimStart();

  // Must be on a `type: ` line
  if (!/^type\s*:\s*$/.test(trimmed)) {
    return false;
  }

  return isInsideGatherField(lines, cursorLineIdx);
}

/**
 * Build completion items for all CEL functions.
 */
function getCelFunctionCompletions(): CompletionItem[] {
  return CEL_FUNCTIONS.map((fn, idx) => ({
    label: fn.name,
    kind: 'function' as CompletionKind,
    detail: fn.signature,
    documentation: fn.description,
    insertText: fn.name + '(',
    sortOrder: idx,
  }));
}

/**
 * Build completion items for value fields.
 */
function getValueCompletions(key: string): CompletionItem[] {
  const values = VALUE_COMPLETIONS[key] ?? [];
  return values.map((v, idx) => ({
    label: v.value,
    kind: 'value' as CompletionKind,
    detail: v.detail,
    insertText: v.value,
    sortOrder: idx,
  }));
}

/**
 * Build completion items from a raw values array.
 */
function getValueCompletions_raw(
  values: ReadonlyArray<{ value: string; detail?: string }>,
): CompletionItem[] {
  return values.map((v, idx) => ({
    label: v.value,
    kind: 'value' as CompletionKind,
    detail: v.detail,
    insertText: v.value,
    sortOrder: idx,
  }));
}

function getModelValueCompletions(context?: CompletionContext): CompletionItem[] {
  const models = context?.availableModels ?? [];
  return models.map((model, idx) => {
    const displayName = model.displayName || model.name;
    const detail = [
      displayName && displayName !== model.modelId ? displayName : undefined,
      model.provider,
      model.isDefault ? 'Default' : undefined,
    ]
      .filter(Boolean)
      .join(' · ');

    return {
      label: model.modelId,
      kind: 'value' as CompletionKind,
      detail: detail || 'Project model',
      insertText: model.modelId,
      sortOrder: idx,
    };
  });
}

/**
 * Build a CompletionItem.
 */
function makeCompletion(
  label: string,
  kind: CompletionKind,
  detail?: string,
  insertText?: string,
  sortOrder?: number,
): CompletionItem {
  return {
    label,
    kind,
    detail,
    insertText: insertText ?? label,
    sortOrder,
  };
}

/**
 * Collect the set of top-level keys already present in the source.
 */
function getExistingTopLevelKeys(lines: string[]): Set<string> {
  const keys = new Set<string>();
  for (const line of lines) {
    if (line.length > 0 && line[0] !== ' ' && line[0] !== '\t') {
      const match = line.match(/^([a-zA-Z][a-zA-Z_]*)\s*:/);
      if (match) {
        keys.add(match[1]);
      }
    }
  }
  return keys;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

/**
 * Get context-aware completion suggestions for the given cursor position.
 *
 * @param source - The full ABL YAML source text
 * @param position - Cursor position (1-based line, 1-based column)
 * @param context - Optional project context (available tools, agents)
 * @returns Array of completion items
 */
export function getCompletions(
  source: string,
  position: Position,
  context?: CompletionContext,
): CompletionItem[] {
  const topKeys = context?.format === 'legacy' ? LEGACY_TOP_LEVEL_KEYS : TOP_LEVEL_KEYS;

  if (!source) {
    return topKeys.map((k, idx) => makeCompletion(k.key, 'section', k.detail, `${k.key}: `, idx));
  }

  const lines = source.split('\n').map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l));
  // Convert 1-based position to 0-based index
  const cursorLineIdx = position.line - 1;

  // Safety: if the cursor line is beyond the source, treat as empty top-level
  if (cursorLineIdx < 0 || cursorLineIdx >= lines.length) {
    // Suggest remaining top-level keys
    const existing = getExistingTopLevelKeys(lines);
    return topKeys
      .filter((k) => !existing.has(k.key))
      .map((k, idx) => makeCompletion(k.key, 'section', k.detail, `${k.key}: `, idx));
  }

  const cursorLine = lines[cursorLineIdx];
  const indent = cursorLine.length - cursorLine.trimStart().length;

  // --- Gather field type values (must check before generic value completions) ---
  if (isGatherFieldTypeValue(lines, cursorLineIdx)) {
    return getValueCompletions('gather_type');
  }

  // --- Section-specific value completions (kind:, action:, method:, type: in context) ---
  // Must check BEFORE generic value completions so section-aware values override generic ones
  const sectionField = getSectionValueField(lines, cursorLineIdx);
  if (sectionField) {
    const { section: sec, field } = sectionField;
    if (isInsideHandoffHistoryBlock(lines, cursorLineIdx) && field === 'mode') {
      return getValueCompletions_raw(HANDOFF_HISTORY_MODE_VALUES);
    }
    if (sec === 'guardrails' && field === 'kind')
      return getValueCompletions_raw(GUARDRAIL_KIND_VALUES);
    if (sec === 'guardrails' && field === 'action')
      return getValueCompletions_raw(GUARDRAIL_ACTION_VALUES);
    if (sec === 'tools' && field === 'method') return getValueCompletions_raw(HTTP_METHOD_VALUES);
    if (sec === 'tools' && field === 'type') return getValueCompletions_raw(TOOL_TYPE_VALUES);
    if (sec === 'on_error' && field === 'type') return getValueCompletions_raw(ERROR_TYPE_VALUES);
    if (sec === 'execution' && (field === 'model' || field === 'fallback_model')) {
      return getModelValueCompletions(context);
    }
    if (sec === 'execution' && field === 'concurrency')
      return getValueCompletions_raw(CONCURRENCY_VALUES);
    if (sec === 'execution' && field === 'reasoning_effort')
      return getValueCompletions_raw(REASONING_EFFORT_VALUES);
  }

  // --- Generic value completions for enum-like fields (mode:, action:, strategy:, priority:) ---
  const valueKey = getValueFieldKey(cursorLine);
  if (valueKey) {
    if (valueKey === 'mode' && isInsideHandoffHistoryBlock(lines, cursorLineIdx)) {
      return getValueCompletions_raw(HANDOFF_HISTORY_MODE_VALUES);
    }
    return getValueCompletions(valueKey);
  }

  // --- CEL expression context: when:, validate:, set: values, etc. ---
  if (isCelExpressionContext(lines, cursorLineIdx)) {
    return getCelFunctionCompletions();
  }

  // --- Gather field properties (type, required, description, etc.) ---
  if (isInsideGatherField(lines, cursorLineIdx)) {
    return GATHER_FIELD_PROPERTIES.map((p, idx) =>
      makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
    );
  }

  // --- Handoff / delegate target: `- to: <cursor>` ---
  if (isHandoffTarget(lines, cursorLineIdx)) {
    const agents = context?.availableAgents ?? [];
    return agents.map((a, idx) => makeCompletion(a.name, 'agent', 'Agent', a.name, idx));
  }

  // --- Flow step body ---
  if (isInsideFlowStep(lines, cursorLineIdx)) {
    return FLOW_STEP_KEYWORDS.map((k, idx) =>
      makeCompletion(k.key, 'keyword', k.detail, `${k.key}: `, idx),
    );
  }

  // --- Inside a known section ---
  const section = findEnclosingSection(lines, cursorLineIdx);

  // --- TOOLS section ---
  if (section === 'tools' && indent > 0) {
    // Inside a tool definition (indent 4+) → tool properties
    if (isInsideSectionChild(lines, cursorLineIdx, 'tools')) {
      return TOOL_DEFINITION_PROPERTIES.map((p, idx) =>
        makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
      );
    }
    // At tool-name level (indent 2) → suggest available tool names
    const contextTools = context?.availableTools ?? [];
    const contextToolNames = new Set(contextTools.map((t) => t.name));
    const builtInFiltered = BUILT_IN_TOOLS.filter((t) => !contextToolNames.has(t.name));
    const allTools = [...contextTools, ...builtInFiltered];
    return allTools.map((t, idx) =>
      makeCompletion(t.name, 'tool', t.description ?? t.type, t.name, idx),
    );
  }

  // --- EXECUTION section ---
  if (section === 'execution' && indent > 0) {
    return EXECUTION_PROPERTIES.map((p, idx) =>
      makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
    );
  }

  // --- GUARDRAILS section ---
  if (section === 'guardrails' && indent > 0) {
    if (isInsideSectionChild(lines, cursorLineIdx, 'guardrails')) {
      return GUARDRAIL_DEFINITION_PROPERTIES.map((p, idx) =>
        makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
      );
    }
    // At guardrail-name level → empty (user types the name)
    return [];
  }

  // --- MEMORY section ---
  if (section === 'memory' && indent > 0) {
    if (indent <= 3) {
      return MEMORY_SECTION_PROPERTIES.map((p, idx) =>
        makeCompletion(p.key, 'keyword', p.detail, `${p.key}:`, idx),
      );
    }
    // Deeper indent: no specific completions (variable names are user-defined)
    return [];
  }

  // --- CONSTRAINTS section ---
  if (section === 'constraints' && indent > 0) {
    if (indent >= 4) {
      return CONSTRAINT_RULE_KEYWORDS.map((p, idx) =>
        makeCompletion(p.key, 'keyword', p.detail, `${p.key}: `, idx),
      );
    }
    // At phase-name level → empty (user types the phase name)
    return [];
  }

  // --- HANDOFF section ---
  if ((section === 'handoff' || section === 'delegate') && indent > 0) {
    if (isInsideHandoffHistoryBlock(lines, cursorLineIdx)) {
      return HANDOFF_HISTORY_PROPERTIES.map((p, idx) =>
        makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
      );
    }
    if (isInsideHandoffContext(lines, cursorLineIdx)) {
      return HANDOFF_CONTEXT_PROPERTIES.map((p, idx) =>
        makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
      );
    }
    if (indent >= 2) {
      return HANDOFF_ENTRY_PROPERTIES.map((p, idx) =>
        makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
      );
    }
    return [];
  }

  // --- ON_ERROR section ---
  if (section === 'on_error' && indent > 0) {
    return ON_ERROR_PROPERTIES.map((p, idx) =>
      makeCompletion(p.key, 'field', p.detail, `${p.key}: `, idx),
    );
  }

  // --- COMPLETE section ---
  if (section === 'complete' && indent > 0) {
    return COMPLETE_ENTRY_PROPERTIES.map((p, idx) =>
      makeCompletion(p.key, 'keyword', p.detail, `${p.key}: `, idx),
    );
  }

  // --- ON_START section ---
  if (section === 'on_start' && indent > 0) {
    return [makeCompletion('RESPOND', 'keyword', 'Welcome message to send', 'RESPOND: ', 0)];
  }

  // --- ESCALATE / ESCALATION section ---
  if (section === 'escalate' && indent > 0) {
    return [
      makeCompletion('WHEN', 'keyword', 'Escalation trigger condition', 'WHEN: ', 0),
      makeCompletion('REASON', 'keyword', 'Reason for escalation', 'REASON: ', 1),
      makeCompletion(
        'PRIORITY',
        'keyword',
        'Priority (low | medium | high | critical)',
        'PRIORITY: ',
        2,
      ),
      makeCompletion('CONTEXT', 'keyword', 'Context to pass to human', 'CONTEXT:', 3),
    ];
  }

  // --- Top-level suggestions ---
  if (indent === 0) {
    const existing = getExistingTopLevelKeys(lines);
    return topKeys
      .filter((k) => !existing.has(k.key))
      .map((k, idx) => makeCompletion(k.key, 'section', k.detail, `${k.key}: `, idx));
  }

  // Unrecognized context — return empty
  return [];
}
