/**
 * ABL Section Serializers
 *
 * Convert typed section data models → ABL DSL section edit arrays.
 * Each serializer returns `Array<{ section: string; content: string | null }>`
 * compatible with the `spliceSections` API in `@agent-platform/project-io`.
 *
 * A `content` of `null` removes the section entirely.
 */

import type { ActionSetIR, RichContentIR, VoiceConfigIR } from '@abl/compiler';
import type {
  IdentitySectionData,
  ToolSectionData,
  GatherFieldData,
  FlowSectionData,
  RulesSectionData,
  CoordinationSectionData,
  LifecycleSectionData,
  ConversationBehaviorData,
  ToolInvocationData,
} from '@/store/agent-detail-store';
import type { OnStartSectionData } from '@/components/agent-editor/types';
import type { SectionEdit } from '@agent-platform/project-io';

// Re-export so existing consumers can still import from here
export type { SectionEdit };

// =============================================================================
// HELPERS
// =============================================================================

/** Quote a string value for ABL DSL, handling special characters */
function quote(value: string): string {
  if (value.includes('\n')) {
    // Multiline: use pipe syntax
    const indented = value
      .split('\n')
      .map((line) => `  ${line}`)
      .join('\n');
    return `|\n${indented}`;
  }
  // Single line: always double-quote
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/** Quote a single-line string — always returns "..." form */
function inlineQuote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

const GATHER_SEMANTICS_KEY_ORDER = [
  'lookup',
  'format',
  'components',
  'unit',
  'convert_to',
  'locale',
  'kore_entity_type',
  'enum_set',
] as const;

function inlineScalarToken(value: string): string {
  return /^[A-Za-z0-9_./:-]+$/.test(value) ? value : inlineQuote(value);
}

function serializeGatherSemanticsValue(value: string | string[]): string {
  if (Array.isArray(value)) {
    return `[${value.map(inlineScalarToken).join(', ')}]`;
  }
  return inlineScalarToken(value);
}

function buildGatherSemantics(field: GatherFieldData): Record<string, string | string[]> {
  const semantics: Record<string, string | string[]> = {};

  for (const key of GATHER_SEMANTICS_KEY_ORDER) {
    const value = field.semantics?.[key];
    if (value === undefined) {
      continue;
    }
    if (Array.isArray(value) && value.length === 0) {
      continue;
    }
    semantics[key] = Array.isArray(value) ? [...value] : value;
  }

  if (field.lookupTable) {
    semantics.lookup = field.lookupTable;
  }

  if (Array.isArray(field.semantics?.enum_set)) {
    if (field.type === 'enum' && field.options && field.options.length > 0) {
      semantics.enum_set = [...field.options];
    } else {
      delete semantics.enum_set;
    }
  }

  return semantics;
}

function isPlainScalarToken(value: string): boolean {
  return /^[A-Za-z0-9_./:-]+$/.test(value);
}

function serializeConversationScalar(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return isPlainScalarToken(value) ? value : inlineQuote(value);
  }
  return inlineQuote(String(value));
}

function isEmptyConversationNode(value: unknown): boolean {
  if (value === undefined || value === null || value === '') {
    return true;
  }
  if (Array.isArray(value)) {
    return value.length === 0;
  }
  if (typeof value !== 'object') {
    return false;
  }

  return Object.values(value).every((nestedValue) => isEmptyConversationNode(nestedValue));
}

function appendConversationBlock(
  lines: string[],
  key: string,
  value: Record<string, unknown>,
  indent: number,
): void {
  const entries = Object.entries(value).filter(
    ([, nestedValue]) => !isEmptyConversationNode(nestedValue),
  );
  if (entries.length === 0) {
    return;
  }

  const prefix = ' '.repeat(indent);
  lines.push(`${prefix}${key}:`);

  for (const [nestedKey, nestedValue] of entries) {
    if (nestedValue && typeof nestedValue === 'object' && !Array.isArray(nestedValue)) {
      appendConversationBlock(lines, nestedKey, nestedValue as Record<string, unknown>, indent + 2);
      continue;
    }

    lines.push(
      `${' '.repeat(indent + 2)}${nestedKey}: ${serializeConversationScalar(nestedValue)}`,
    );
  }
}

export function serializeConversationBehaviorBlock(data: ConversationBehaviorData): string | null {
  if (isEmptyConversationNode(data)) {
    return null;
  }

  const lines = ['CONVERSATION:'];
  if (data.speaking) {
    appendConversationBlock(lines, 'speaking', data.speaking as Record<string, unknown>, 2);
  }
  if (data.listening) {
    appendConversationBlock(lines, 'listening', data.listening as Record<string, unknown>, 2);
  }
  if (data.interaction) {
    appendConversationBlock(lines, 'interaction', data.interaction as Record<string, unknown>, 2);
  }

  return lines.length > 1 ? lines.join('\n') : null;
}

function serializeInvocationScalar(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return inlineScalarToken(value);
  }
  return inlineQuote(JSON.stringify(value));
}

function normalizeToolInvocation(
  toolName: string | undefined,
  callSpec: ToolInvocationData | undefined,
): ToolInvocationData | null {
  if (toolName !== undefined) {
    const normalizedTool = toolName.trim();
    if (!normalizedTool) {
      return null;
    }
    return callSpec ? { ...callSpec, tool: normalizedTool } : { tool: normalizedTool };
  }

  if (!callSpec?.tool) {
    return null;
  }

  return callSpec;
}

function appendToolInvocation(
  lines: string[],
  indent: number,
  toolName: string | undefined,
  callSpec: ToolInvocationData | undefined,
): void {
  const invocation = normalizeToolInvocation(toolName, callSpec);
  if (!invocation) {
    return;
  }

  const prefix = ' '.repeat(indent);
  lines.push(`${prefix}CALL: ${invocation.tool}`);

  if (invocation.with && Object.keys(invocation.with).length > 0) {
    lines.push(`${' '.repeat(indent + 2)}WITH:`);
    for (const [key, value] of Object.entries(invocation.with)) {
      if (value === undefined) {
        continue;
      }
      lines.push(`${' '.repeat(indent + 4)}${key}: ${serializeInvocationScalar(value)}`);
    }
  }

  if (invocation.as) {
    lines.push(`${' '.repeat(indent + 2)}AS: ${invocation.as}`);
  }
}

function serializeLifecycleScalar(value: unknown): string {
  if (typeof value === 'boolean') {
    return value ? 'true' : 'false';
  }
  if (typeof value === 'number') {
    return String(value);
  }
  if (typeof value === 'string') {
    return inlineScalarToken(value);
  }
  return inlineQuote(JSON.stringify(value));
}

function appendLifecycleValue(lines: string[], indent: number, key: string, value: unknown): void {
  if (value === undefined || value === null || value === '') {
    return;
  }

  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    if (value.length === 0) {
      return;
    }
    lines.push(`${prefix}${key}:`);
    for (const item of value) {
      if (item === undefined || item === null) {
        continue;
      }
      if (typeof item === 'object' && !Array.isArray(item)) {
        lines.push(`${' '.repeat(indent + 2)}-`);
        for (const [nestedKey, nestedValue] of Object.entries(item)) {
          appendLifecycleValue(lines, indent + 4, nestedKey, nestedValue);
        }
        continue;
      }
      lines.push(`${' '.repeat(indent + 2)}- ${serializeLifecycleScalar(item)}`);
    }
    return;
  }

  if (typeof value === 'object') {
    const entries = Object.entries(value).filter(
      ([, nestedValue]) => nestedValue !== undefined && nestedValue !== null && nestedValue !== '',
    );
    if (entries.length === 0) {
      return;
    }
    lines.push(`${prefix}${key}:`);
    for (const [nestedKey, nestedValue] of entries) {
      appendLifecycleValue(lines, indent + 2, nestedKey, nestedValue);
    }
    return;
  }

  lines.push(`${prefix}${key}: ${serializeLifecycleScalar(value)}`);
}

function appendLifecycleMapping(
  lines: string[],
  indent: number,
  header: string,
  value: object | undefined,
): void {
  if (!value) {
    return;
  }

  const entries = Object.entries(value).filter(
    ([, nestedValue]) => nestedValue !== undefined && nestedValue !== null && nestedValue !== '',
  );
  if (entries.length === 0) {
    return;
  }

  lines.push(`${' '.repeat(indent)}${header}:`);
  for (const [key, nestedValue] of entries) {
    appendLifecycleValue(lines, indent + 2, key, nestedValue);
  }
}

function appendLifecycleActions(
  lines: string[],
  indent: number,
  actions: ActionSetIR | undefined,
): void {
  if (!actions?.elements?.length) {
    return;
  }

  const prefix = ' '.repeat(indent);
  lines.push(`${prefix}ACTIONS:`);
  if (actions.submit_label) {
    lines.push(`${' '.repeat(indent + 2)}SUBMIT_LABEL: ${inlineQuote(actions.submit_label)}`);
  }
  if (actions.submit_id) {
    lines.push(`${' '.repeat(indent + 2)}SUBMIT_ID: ${actions.submit_id}`);
  }
  if (actions.renderId) {
    lines.push(`${' '.repeat(indent + 2)}RENDER_ID: ${actions.renderId}`);
  }
  for (const element of actions.elements) {
    if (element.type === 'select') {
      lines.push(`${' '.repeat(indent + 2)}- SELECT: ${inlineQuote(element.label)}`);
      if (element.id) {
        lines.push(`${' '.repeat(indent + 4)}ID: ${element.id}`);
      }
      if (element.description) {
        lines.push(`${' '.repeat(indent + 4)}DESCRIPTION: ${inlineQuote(element.description)}`);
      }
      if (element.options?.length) {
        lines.push(`${' '.repeat(indent + 4)}OPTIONS:`);
        for (const option of element.options) {
          lines.push(`${' '.repeat(indent + 6)}- ${inlineQuote(option.label)} -> ${option.id}`);
          if (option.description) {
            lines.push(`${' '.repeat(indent + 8)}DESCRIPTION: ${inlineQuote(option.description)}`);
          }
        }
      }
      continue;
    }

    if (element.type === 'input') {
      lines.push(`${' '.repeat(indent + 2)}- INPUT: ${inlineQuote(element.label)}`);
      if (element.id) {
        lines.push(`${' '.repeat(indent + 4)}ID: ${element.id}`);
      }
      if (element.input_type) {
        lines.push(`${' '.repeat(indent + 4)}INPUT_TYPE: ${element.input_type}`);
      }
      if (element.placeholder) {
        lines.push(`${' '.repeat(indent + 4)}PLACEHOLDER: ${inlineQuote(element.placeholder)}`);
      }
      if (element.required !== undefined) {
        lines.push(`${' '.repeat(indent + 4)}REQUIRED: ${element.required ? 'true' : 'false'}`);
      }
      if (element.value) {
        lines.push(`${' '.repeat(indent + 4)}VALUE: ${inlineQuote(element.value)}`);
      }
      if (element.description) {
        lines.push(`${' '.repeat(indent + 4)}DESCRIPTION: ${inlineQuote(element.description)}`);
      }
      continue;
    }

    lines.push(`${' '.repeat(indent + 2)}- BUTTON: ${inlineQuote(element.label)} -> ${element.id}`);
    if (element.value) {
      lines.push(`${' '.repeat(indent + 4)}VALUE: ${inlineQuote(element.value)}`);
    }
    if (element.description) {
      lines.push(`${' '.repeat(indent + 4)}DESCRIPTION: ${inlineQuote(element.description)}`);
    }
  }
}

function appendStructuredRespondPayload(
  lines: string[],
  indent: number,
  payload: {
    voiceConfig?: VoiceConfigIR;
    richContent?: RichContentIR;
    actions?: ActionSetIR;
  },
): void {
  appendLifecycleMapping(lines, indent, 'VOICE', payload.voiceConfig);
  appendLifecycleMapping(lines, indent, 'FORMATS', payload.richContent);
  appendLifecycleActions(lines, indent, payload.actions);
}

function hasStructuredRespondPayload(payload: {
  voiceConfig?: VoiceConfigIR;
  richContent?: RichContentIR;
  actions?: ActionSetIR;
}): boolean {
  return (
    payload.voiceConfig !== undefined ||
    payload.richContent !== undefined ||
    (payload.actions?.elements?.length ?? 0) > 0
  );
}

function serializeLifecycleThen(handler: LifecycleSectionData['errorHandlers'][number]): string {
  const normalized = handler.then.trim();
  const lower = normalized.toLowerCase();
  if (lower === 'handoff' && handler.handoffTarget) {
    return `HANDOFF ${handler.handoffTarget}`;
  }
  if (lower.startsWith('handoff ')) {
    return `HANDOFF ${normalized.slice('handoff '.length).trim()}`;
  }
  return normalized.toUpperCase();
}

// =============================================================================
// IDENTITY → GOAL, PERSONA, LIMITATIONS
// =============================================================================

export function serializeIdentityToABL(data: IdentitySectionData): SectionEdit[] {
  const edits: SectionEdit[] = [];

  // GOAL
  if (data.goal) {
    edits.push({
      section: 'GOAL',
      content: `GOAL: ${quote(data.goal)}`,
    });
  } else {
    edits.push({ section: 'GOAL', content: null });
  }

  // PERSONA
  if (data.persona) {
    edits.push({
      section: 'PERSONA',
      content: `PERSONA: ${quote(data.persona)}`,
    });
  } else {
    edits.push({ section: 'PERSONA', content: null });
  }

  // LIMITATIONS
  if (data.limitations.length > 0) {
    const items = data.limitations.map((l) => `  - ${inlineQuote(l)}`).join('\n');
    edits.push({
      section: 'LIMITATIONS',
      content: `LIMITATIONS:\n${items}`,
    });
  } else {
    edits.push({ section: 'LIMITATIONS', content: null });
  }

  return edits;
}

// =============================================================================
// EXECUTION → EXECUTION
// =============================================================================

/**
 * Fields from `ExecutionSectionData` that round-trip to the EXECUTION DSL block.
 */
export interface ExecutionDSLData {
  model?: string;
  temperature?: number;
  maxTokens?: number;
  /** null = inherit (omit), true = enabled, false = disabled */
  enableThinking?: boolean | null;
  thinkingBudget?: number;
  toolTimeout?: number;
  llmTimeout?: number;
  sessionIdleTimeout?: number;
  maxReasoningIterations?: number;
  maxFlowIterations?: number;
  voiceLatencyTarget?: number;
  fallbackModel?: string;
  operationModels?: Record<string, string>;
}

export function serializeExecutionToABL(data: ExecutionDSLData): SectionEdit[] {
  const lines: string[] = [];

  if (data.model !== undefined && data.model !== '') {
    lines.push(`  model: ${inlineScalarToken(data.model)}`);
  }
  if (data.temperature !== undefined && Number.isFinite(data.temperature)) {
    lines.push(`  temperature: ${data.temperature}`);
  }
  if (
    data.maxTokens !== undefined &&
    Number.isFinite(data.maxTokens) &&
    Number.isInteger(data.maxTokens)
  ) {
    lines.push(`  max_tokens: ${data.maxTokens}`);
  }
  if (data.enableThinking === true || data.enableThinking === false) {
    lines.push(`  enable_thinking: ${data.enableThinking ? 'true' : 'false'}`);
  }
  if (data.thinkingBudget !== undefined && Number.isFinite(data.thinkingBudget)) {
    lines.push(`  thinking_budget: ${data.thinkingBudget}`);
  }
  if (data.toolTimeout !== undefined && Number.isFinite(data.toolTimeout)) {
    lines.push(`  tool_timeout: ${data.toolTimeout}`);
  }
  if (data.llmTimeout !== undefined && Number.isFinite(data.llmTimeout)) {
    lines.push(`  llm_timeout: ${data.llmTimeout}`);
  }
  if (data.sessionIdleTimeout !== undefined && Number.isFinite(data.sessionIdleTimeout)) {
    lines.push(`  session_idle_timeout: ${data.sessionIdleTimeout}`);
  }
  if (data.maxReasoningIterations !== undefined && Number.isFinite(data.maxReasoningIterations)) {
    lines.push(`  max_reasoning_iterations: ${data.maxReasoningIterations}`);
  }
  if (data.maxFlowIterations !== undefined && Number.isFinite(data.maxFlowIterations)) {
    lines.push(`  max_flow_iterations: ${data.maxFlowIterations}`);
  }
  if (data.voiceLatencyTarget !== undefined && Number.isFinite(data.voiceLatencyTarget)) {
    lines.push(`  voice_latency_target: ${data.voiceLatencyTarget}`);
  }
  if (data.fallbackModel !== undefined && data.fallbackModel !== '') {
    lines.push(`  fallback_model: ${inlineScalarToken(data.fallbackModel)}`);
  }
  if (data.operationModels && Object.keys(data.operationModels).length > 0) {
    lines.push(`  operation_models:`);
    for (const [op, model] of Object.entries(data.operationModels)) {
      lines.push(`    ${op}: ${inlineScalarToken(model)}`);
    }
  }

  if (lines.length === 0) {
    return [{ section: 'EXECUTION', content: null }];
  }

  return [{ section: 'EXECUTION', content: `EXECUTION:\n${lines.join('\n')}` }];
}

// =============================================================================
// TOOLS → TOOLS
// =============================================================================

function serializeTool(tool: ToolSectionData): string {
  const params = tool.parameters
    .map((p) => `${p.name}${p.required ? '' : '?'}: ${p.type}`)
    .join(', ');
  const returns = tool.returns?.type ? ` -> ${tool.returns.type}` : '';
  let block = `  ${tool.name}(${params})${returns}`;
  if (tool.description) {
    block += `\n    description: ${inlineQuote(tool.description)}`;
  }
  if (tool.toolType) {
    block += `\n    type: ${tool.toolType}`;
  }
  if (tool.toolType === 'searchai' && tool.searchaiBinding) {
    block += `\n    index_id: ${inlineQuote(tool.searchaiBinding.indexId)}`;
    block += `\n    tenant_id: ${inlineQuote(tool.searchaiBinding.tenantId)}`;
    if (tool.searchaiBinding.kbName) {
      block += `\n    kb_name: ${inlineQuote(tool.searchaiBinding.kbName)}`;
    }
  }
  if (tool.toolType === 'workflow' && tool.workflowBinding) {
    block += `\n    workflow_id: ${inlineQuote(tool.workflowBinding.workflowId)}`;
    block += `\n    trigger_id: ${inlineQuote(tool.workflowBinding.triggerId)}`;
    block += `\n    mode: ${tool.workflowBinding.mode}`;
    if (tool.workflowBinding.timeoutMs !== undefined) {
      block += `\n    timeout_ms: ${tool.workflowBinding.timeoutMs}`;
    }
  }
  const hintEntries: string[] = [];
  const hints = tool.hints;
  if (hints.cacheable) hintEntries.push('cacheable: true');
  if (hints.latency && hints.latency !== 'medium') hintEntries.push(`latency: ${hints.latency}`);
  if (hints.side_effects) hintEntries.push('side_effects: true');
  if (hints.requires_auth) hintEntries.push('requires_auth: true');
  if (hints.timeout) hintEntries.push(`timeout: ${hints.timeout}`);
  if (hintEntries.length > 0) {
    block += `\n    hints:\n${hintEntries.map((h) => `      ${h}`).join('\n')}`;
  }
  if (tool.confirmation) {
    block += `\n    confirm: ${tool.confirmation.require}`;
    if (tool.confirmation.immutableParams && tool.confirmation.immutableParams.length > 0) {
      block += `\n    immutable: [${tool.confirmation.immutableParams.join(', ')}]`;
    }
  }
  if (tool.piiAccess && tool.piiAccess !== 'tools') {
    block += `\n    pii_access: ${tool.piiAccess}`;
  }
  return block;
}

export function serializeToolsToABL(data: ToolSectionData[]): SectionEdit[] {
  if (data.length === 0) {
    return [{ section: 'TOOLS', content: null }];
  }

  const lines = data.map(serializeTool);

  return [{ section: 'TOOLS', content: `TOOLS:\n${lines.join('\n\n')}` }];
}

// =============================================================================
// GATHER → GATHER
// =============================================================================

export function serializeGatherToABL(data: GatherFieldData[]): SectionEdit[] {
  if (data.length === 0) {
    return [{ section: 'GATHER', content: null }];
  }

  const fields = data
    .map((f) => {
      const lines: string[] = [];

      // Field header: "  fieldname:" — parser detects fields via /^(\w+):$/ on indented lines
      lines.push(`  ${f.name}:`);

      // Type (parser defaults to 'string', so only emit when different)
      if (f.type && f.type !== 'string') {
        lines.push(`    type: ${f.type}`);
      }

      // Required (parser defaults to true, so only emit when false)
      if (!f.required) {
        lines.push('    required: false');
      }

      if (f.prompt) {
        lines.push(`    prompt: ${inlineQuote(f.prompt)}`);
      }

      const semantics = buildGatherSemantics(f);
      if (Object.keys(semantics).length > 0) {
        lines.push('    semantics:');
        for (const key of GATHER_SEMANTICS_KEY_ORDER) {
          const value = semantics[key];
          if (value === undefined) {
            continue;
          }
          lines.push(`      ${key}: ${serializeGatherSemanticsValue(value)}`);
        }
      }

      if (f.validation) {
        lines.push(`    validate: ${f.validation.rule}`);
        if (f.validation.errorMessage) {
          lines.push(`    on_fail: ${inlineQuote(f.validation.errorMessage)}`);
        }
      }

      if (f.extractionHints && f.extractionHints.length > 0) {
        lines.push(`    hints: [${f.extractionHints.map(inlineQuote).join(', ')}]`);
      }

      if (f.infer) {
        lines.push('    infer: true');
      }

      if (f.piiType) {
        lines.push(`    pii_type: ${f.piiType}`);
      }

      if (
        f.options &&
        f.options.length > 0 &&
        f.type === 'enum' &&
        !Array.isArray(f.semantics?.enum_set)
      ) {
        lines.push(`    options: [${f.options.join(', ')}]`);
      }

      if (f.sensitive) {
        lines.push('    sensitive: true');
        if (f.sensitiveDisplay) {
          lines.push(`    sensitive_display: ${f.sensitiveDisplay}`);
        }
        if (f.sensitiveDisplay === 'mask' && f.maskConfig) {
          lines.push('    mask_config:');
          lines.push(`      show_first: ${f.maskConfig.showFirst}`);
          lines.push(`      show_last: ${f.maskConfig.showLast}`);
          lines.push(`      char: ${inlineQuote(f.maskConfig.char)}`);
        }
        if (f.transient) {
        }
      }

      if (f.transient) {
        lines.push('    transient: true');
      }

      if (f.extractionPattern) {
        lines.push(`    extraction_pattern: ${inlineQuote(f.extractionPattern)}`);
        if (f.extractionGroup && f.extractionGroup > 0) {
          lines.push(`    extraction_group: ${f.extractionGroup}`);
        }
      }

      return lines.join('\n');
    })
    .join('\n');

  return [{ section: 'GATHER', content: `GATHER:\n${fields}` }];
}

// =============================================================================
// FLOW → FLOW
// =============================================================================

export function serializeFlowToABL(data: FlowSectionData | null): SectionEdit[] {
  if (!data || data.steps.length === 0) {
    return [{ section: 'FLOW', content: null }];
  }

  const lines: string[] = [];
  lines.push(`  entry_point: ${data.entryPoint}`);
  lines.push('  steps:');
  for (const step of data.steps) {
    lines.push(`    - ${step.name}`);
  }
  lines.push('');

  for (const step of data.steps) {
    lines.push(`  ${step.name}:`);
    if (step.when) {
      lines.push(`    WHEN: ${step.when}`);
    }
    lines.push(`    REASONING: ${step.reasoning ? 'true' : 'false'}`);
    if (step.reasoning && step.goal) {
      lines.push(`    GOAL: ${inlineQuote(step.goal)}`);
    }
    if (step.reasoning && step.exitWhen) {
      lines.push(`    EXIT_WHEN: ${step.exitWhen}`);
    }
    if (step.reasoning && step.maxTurns !== undefined && step.maxTurns !== 10) {
      lines.push(`    MAX_TURNS: ${step.maxTurns}`);
    }
    if (step.reasoning && step.availableTools?.length) {
      lines.push(`    AVAILABLE_TOOLS: [${step.availableTools.join(', ')}]`);
    }
    if (step.maxAttempts !== undefined) {
      lines.push(`    MAX_ATTEMPTS: ${step.maxAttempts}`);
    }
    if (step.onExhausted) {
      lines.push(`    ON_EXHAUSTED: ${step.onExhausted}`);
    }
    if (step.set && step.set.length > 0) {
      for (const s of step.set) {
        lines.push(`    SET: ${s.variable} = ${s.expression}`);
      }
    }
    if (step.clear && step.clear.length > 0) {
      lines.push(`    CLEAR: [${step.clear.join(', ')}]`);
    }
    if (step.respond) {
      lines.push(`    RESPOND: ${inlineQuote(step.respond)}`);
    }
    appendToolInvocation(lines, 4, step.call, step.callSpec);
    if (step.onFail) {
      lines.push(`    ON_FAIL: ${step.onFail}`);
    }
    if (step.then) {
      lines.push(`    THEN: ${step.then}`);
    }
    // Write back fields the visual editor preserves but cannot render
    const extras = step._rawExtras;
    if (extras) {
      if (extras.gather) {
        lines.push(`    GATHER:`);
        serializeRawYamlBlock(lines, extras.gather, 6);
      }
      if (Array.isArray(extras.on_input) && extras.on_input.length > 0) {
        lines.push(`    ON_INPUT:`);
        serializeRawYamlBlock(lines, extras.on_input, 6);
      }
      if (Array.isArray(extras.on_result) && extras.on_result.length > 0) {
        lines.push(`    ON_RESULT:`);
        serializeRawYamlBlock(lines, extras.on_result, 6);
      }
      if (extras.on_success) {
        lines.push(`    ON_SUCCESS:`);
        serializeRawYamlBlock(lines, extras.on_success, 6);
      }
      if (extras.on_failure) {
        lines.push(`    ON_FAILURE:`);
        serializeRawYamlBlock(lines, extras.on_failure, 6);
      }
      if (Array.isArray(extras.digressions) && extras.digressions.length > 0) {
        lines.push(`    DIGRESSIONS:`);
        serializeRawYamlBlock(lines, extras.digressions, 6);
      }
      if (Array.isArray(extras.sub_intents) && extras.sub_intents.length > 0) {
        lines.push(`    SUB_INTENTS:`);
        serializeRawYamlBlock(lines, extras.sub_intents, 6);
      }
      if (extras.transform) {
        lines.push(`    TRANSFORM:`);
        serializeRawYamlBlock(lines, extras.transform, 6);
      }
      if (extras.await_attachment) {
        lines.push(`    AWAIT_ATTACHMENT:`);
        serializeRawYamlBlock(lines, extras.await_attachment, 6);
      }
      if (Array.isArray(extras.on_action) && extras.on_action.length > 0) {
        lines.push(`    ON_ACTION:`);
        serializeRawYamlBlock(lines, extras.on_action, 6);
      }
    }
  }

  return [{ section: 'FLOW', content: `FLOW:\n${lines.join('\n')}` }];
}

function serializeRawYamlBlock(lines: string[], value: unknown, indent: number): void {
  const prefix = ' '.repeat(indent);
  if (Array.isArray(value)) {
    for (const item of value) {
      if (item && typeof item === 'object') {
        lines.push(`${prefix}-`);
        for (const [k, v] of Object.entries(item)) {
          serializeRawYamlEntry(lines, k, v, indent + 2);
        }
      } else {
        lines.push(`${prefix}- ${serializeRawScalar(item)}`);
      }
    }
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      serializeRawYamlEntry(lines, k, v, indent);
    }
  }
}

function serializeRawYamlEntry(lines: string[], key: string, value: unknown, indent: number): void {
  const prefix = ' '.repeat(indent);
  if (value === undefined || value === null) return;
  if (Array.isArray(value)) {
    if (value.length === 0) return;
    lines.push(`${prefix}${key}:`);
    serializeRawYamlBlock(lines, value, indent + 2);
    return;
  }
  if (typeof value === 'object') {
    lines.push(`${prefix}${key}:`);
    serializeRawYamlBlock(lines, value, indent + 2);
    return;
  }
  lines.push(`${prefix}${key}: ${serializeRawScalar(value)}`);
}

function serializeRawScalar(value: unknown): string {
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (typeof value === 'number') return String(value);
  if (typeof value === 'string') {
    return /^[A-Za-z0-9_./:-]+$/.test(value)
      ? value
      : `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }
  return JSON.stringify(value);
}

// =============================================================================
// RULES → CONSTRAINTS, GUARDRAILS
// =============================================================================

export function serializeRulesToABL(data: RulesSectionData): SectionEdit[] {
  const edits: SectionEdit[] = [];

  // CONSTRAINTS
  if (data.constraints.length > 0) {
    const items = data.constraints
      .map((c) => {
        let block = `    - REQUIRE ${c.condition}`;
        if (c.onFail.message) {
          block += `\n      ON_FAIL: ${inlineQuote(c.onFail.message)}`;
        } else if (c.onFail.type === 'handoff' && c.onFail.target) {
          block += `\n      ON_FAIL: HANDOFF ${c.onFail.target}`;
        } else if (c.onFail.type === 'escalate') {
          block += `\n      ON_FAIL: ESCALATE`;
          if (c.onFail.reason) {
            block += ` "${c.onFail.reason}"`;
          }
        }
        return block;
      })
      .join('\n\n');
    edits.push({
      section: 'CONSTRAINTS',
      content: `CONSTRAINTS:\n  always:\n${items}`,
    });
  } else {
    edits.push({ section: 'CONSTRAINTS', content: null });
  }

  // GUARDRAILS
  if (data.guardrails.length > 0) {
    const items = data.guardrails
      .map((g) => {
        const lines: string[] = [];
        lines.push(`  ${g.name}:`);
        if (g.description) {
          lines.push(`    description: ${inlineQuote(g.description)}`);
        }
        if (g.kind) {
          lines.push(`    kind: ${g.kind}`);
        }
        if (g.priority !== undefined) {
          lines.push(`    priority: ${g.priority}`);
        }
        if (g.provider) {
          lines.push(`    provider: ${g.provider}`);
        }
        if (g.threshold !== undefined) {
          lines.push(`    threshold: ${g.threshold}`);
        }
        if (g.check) {
          lines.push(`    check: ${g.check}`);
        }
        if (g.llmCheck) {
          lines.push(`    llm_check: ${inlineQuote(g.llmCheck)}`);
        }
        lines.push(`    action: ${g.action.type}`);
        if (g.action.message) {
          lines.push(`    message: ${inlineQuote(g.action.message)}`);
        }
        if (g.severityActions) {
          lines.push(`    severity_actions:`);
          for (const [sev, act] of Object.entries(g.severityActions)) {
            lines.push(`      ${sev}: ${act}`);
          }
        }
        if (g.streaming) {
          lines.push(`    streaming: true`);
        }
        return lines.join('\n');
      })
      .join('\n\n');
    edits.push({
      section: 'GUARDRAILS',
      content: `GUARDRAILS:\n${items}`,
    });
  } else {
    edits.push({ section: 'GUARDRAILS', content: null });
  }

  return edits;
}

// =============================================================================
// COORDINATION → DELEGATE, HANDOFF, ESCALATE
// =============================================================================

export function serializeCoordinationToABL(data: CoordinationSectionData): SectionEdit[] {
  const edits: SectionEdit[] = [];

  // DELEGATE
  if (data.delegates.length > 0) {
    const items = data.delegates
      .map((d) => {
        const lines: string[] = [];
        lines.push(`  - TO: ${d.agent}`);
        if (d.when) {
          lines.push(`    WHEN: ${d.when}`);
        }
        if (d.purpose) {
          lines.push(`    PURPOSE: ${inlineQuote(d.purpose)}`);
        }
        if (d.input && Object.keys(d.input).length > 0) {
          lines.push(`    INPUT:`);
          for (const [k, v] of Object.entries(d.input)) {
            lines.push(`      ${k}: ${v}`);
          }
        }
        if (d.returns && Object.keys(d.returns).length > 0) {
          lines.push(`    RETURNS:`);
          for (const [k, v] of Object.entries(d.returns)) {
            lines.push(`      ${k}: ${v}`);
          }
        }
        if (d.useResult) {
          lines.push(`    USE_RESULT: ${d.useResult}`);
        }
        if (d.timeout) {
          lines.push(`    TIMEOUT: ${inlineQuote(d.timeout)}`);
        }
        if (d.onFailure) {
          lines.push(`    ON_FAILURE: ${d.onFailure}`);
        }
        return lines.join('\n');
      })
      .join('\n\n');
    edits.push({
      section: 'DELEGATE',
      content: `DELEGATE:\n${items}`,
    });
  } else {
    edits.push({ section: 'DELEGATE', content: null });
  }

  // HANDOFF
  if (data.handoffs.length > 0) {
    const items = data.handoffs
      .map((h) => {
        const lines: string[] = [];
        lines.push(`  - TO: ${h.to}`);
        if (h.when) {
          lines.push(`    WHEN: ${h.when}`);
        }
        if (h.priority !== undefined) {
          lines.push(`    PRIORITY: ${h.priority}`);
        }
        const hasContext = h.summary || (h.pass && h.pass.length > 0) || h.history !== undefined;
        if (hasContext) {
          lines.push(`    CONTEXT:`);
          if (h.summary) {
            lines.push(`      summary: ${inlineQuote(h.summary)}`);
          }
          if (h.pass && h.pass.length > 0) {
            lines.push(`      pass: [${h.pass.join(', ')}]`);
          }
          if (h.history !== undefined) {
            if (typeof h.history === 'string') {
              lines.push(`      history: ${h.history}`);
            } else if (h.history.mode === 'last_n') {
              lines.push(`      history:`);
              lines.push(`        mode: last_n`);
              lines.push(`        count: ${h.history.count ?? 10}`);
            } else {
              lines.push(`      history: ${h.history.mode}`);
            }
          }
        }
        lines.push(`    RETURN: ${h.returnable}`);
        if (h.onFailure) {
          lines.push(`    ON_FAILURE: ${h.onFailure}`);
        }
        if (h.onReturn) {
          if (typeof h.onReturn === 'string') {
            lines.push(`    ON_RETURN: ${h.onReturn}`);
          } else {
            lines.push(`    ON_RETURN:`);
            if (h.onReturn.action) {
              lines.push(`      action: ${h.onReturn.action}`);
            }
            if (h.onReturn.handler) {
              lines.push(`      handler: ${h.onReturn.handler}`);
            }
            if (h.onReturn.map && Object.keys(h.onReturn.map).length > 0) {
              lines.push(`      map:`);
              for (const [k, v] of Object.entries(h.onReturn.map)) {
                lines.push(`        ${k}: ${v}`);
              }
            }
          }
        }
        return lines.join('\n');
      })
      .join('\n\n');
    edits.push({
      section: 'HANDOFF',
      content: `HANDOFF:\n${items}`,
    });
  } else {
    edits.push({ section: 'HANDOFF', content: null });
  }

  // ESCALATE
  if (data.escalation && data.escalation.triggers.length > 0) {
    const escLines: string[] = ['ESCALATE:'];

    // Triggers
    escLines.push('  triggers:');
    for (const t of data.escalation.triggers) {
      escLines.push(`    - WHEN: ${t.when}`);
      escLines.push(`      REASON: ${inlineQuote(t.reason)}`);
      escLines.push(`      PRIORITY: ${t.priority}`);
      if (t.tags && t.tags.length > 0) {
        escLines.push(`      TAGS: [${t.tags.join(', ')}]`);
      }
    }

    // Context for human
    if (data.escalation.contextForHuman.length > 0) {
      escLines.push('  context_for_human:');
      for (const c of data.escalation.contextForHuman) {
        escLines.push(`    - ${c}`);
      }
    }

    // On human complete
    if (data.escalation.onHumanComplete.length > 0) {
      escLines.push('  on_human_complete:');
      for (const h of data.escalation.onHumanComplete) {
        escLines.push(`    - IF: ${h.condition}`);
        escLines.push(`      THEN: ${h.action}`);
      }
    }

    // Routing
    if (data.escalation.routing?.connectionId) {
      escLines.push('  routing:');
      escLines.push(`    connection: ${data.escalation.routing.connectionId}`);
      if (data.escalation.routing.queue) {
        escLines.push(`    queue: ${data.escalation.routing.queue}`);
      }
      if (data.escalation.routing.skills?.length) {
        escLines.push(`    skills: [${data.escalation.routing.skills.join(', ')}]`);
      }
      if (data.escalation.routing.priority != null) {
        escLines.push(`    priority: ${data.escalation.routing.priority}`);
      }
      if (data.escalation.routing.postAgentAction) {
        escLines.push(`    post_agent: ${data.escalation.routing.postAgentAction}`);
      }
      if (data.escalation.routing.voice?.transferMethod) {
        escLines.push('    voice:');
        escLines.push(`      transfer_method: ${data.escalation.routing.voice.transferMethod}`);
        if (data.escalation.routing.voice.sipHeaders) {
          escLines.push('      sip_headers:');
          for (const [k, v] of Object.entries(data.escalation.routing.voice.sipHeaders)) {
            escLines.push(`        ${k}: ${inlineQuote(v)}`);
          }
        }
      }
    }

    edits.push({ section: 'ESCALATE', content: escLines.join('\n') });
  } else {
    edits.push({ section: 'ESCALATE', content: null });
  }

  return edits;
}

// =============================================================================
// LIFECYCLE → ON_START, HOOKS, ON_ERROR, COMPLETE, MEMORY
// =============================================================================

function toOnStartSectionData(data: LifecycleSectionData): OnStartSectionData {
  return {
    respond: data.onStartRespond,
    calls: data.onStartCall ? [{ tool: data.onStartCall }] : [],
    sets: data.onStartSets ?? [],
    hooks: data.hooks,
    hasOnStart: data.hasOnStart,
    onStartCall: data.onStartCall,
    onStartCallSpec: data.onStartCallSpec,
  };
}

export function serializeOnStartToABL(data: OnStartSectionData): SectionEdit[] {
  if (!data.hasOnStart) {
    return [{ section: 'ON_START', content: null }];
  }

  const lines: string[] = [];
  if (data.respond !== undefined) {
    lines.push(`  RESPOND: ${inlineQuote(data.respond)}`);
  }
  appendToolInvocation(lines, 2, data.onStartCall, data.onStartCallSpec);
  for (const assignment of data.sets) {
    if (!assignment.variable || !assignment.value) {
      continue;
    }
    lines.push(`  SET: ${assignment.variable} = ${assignment.value}`);
  }

  if (lines.length === 0) {
    return [{ section: 'ON_START', content: null }];
  }

  return [
    {
      section: 'ON_START',
      content: `ON_START:\n${lines.join('\n')}`,
    },
  ];
}

export function serializeErrorHandlingToABL(
  data: LifecycleSectionData['errorHandlers'],
): SectionEdit[] {
  if (data.length === 0) {
    return [{ section: 'ON_ERROR', content: null }];
  }

  const renderHandler = (
    h: LifecycleSectionData['errorHandlers'][number],
    typeLabel: string,
  ): string => {
    const lines: string[] = [];
    lines.push(`  ${typeLabel}:`);
    if (h.subtypes && h.subtypes.length > 0) {
      lines.push(`    SUBTYPES: [${h.subtypes.join(', ')}]`);
    }
    const structuredPayload = {
      voiceConfig: h.voiceConfig,
      richContent: h.richContent,
      actions: h.actions,
    };
    if (h.respond || hasStructuredRespondPayload(structuredPayload)) {
      lines.push(`    RESPOND: ${inlineQuote(h.respond ?? '')}`);
      appendStructuredRespondPayload(lines, 6, {
        voiceConfig: h.voiceConfig,
        richContent: h.richContent,
        actions: h.actions,
      });
    }
    if (h.retry !== undefined) {
      lines.push(`    RETRY: ${h.retry}`);
    }
    if (h.retryDelayMs !== undefined) {
      lines.push(`    RETRY_DELAY: ${h.retryDelayMs}`);
    }
    if (h.retryBackoff) {
      lines.push(`    RETRY_BACKOFF: ${h.retryBackoff}`);
    }
    if (h.retryMaxDelayMs !== undefined) {
      lines.push(`    RETRY_MAX_DELAY: ${h.retryMaxDelayMs}`);
    }
    if (h.then.trim().toLowerCase() === 'backtrack' && h.backtrackTo) {
      lines.push(`    BACKTRACK_TO: ${h.backtrackTo}`);
    }
    lines.push(`    THEN: ${serializeLifecycleThen(h)}`);
    return lines.join('\n');
  };

  const defaultHandler = data.find((handler) => handler.type.trim().toLowerCase() === 'default');
  const standardHandlers = data.filter((handler) => handler !== defaultHandler);

  const items = [...standardHandlers, ...(defaultHandler ? [defaultHandler] : [])]
    .map((handler) =>
      renderHandler(
        handler,
        handler === defaultHandler ? 'DEFAULT' : handler.type.trim() || 'DEFAULT',
      ),
    )
    .join('\n\n');

  return [
    {
      section: 'ON_ERROR',
      content: `ON_ERROR:\n${items}`,
    },
  ];
}

export function serializeCompletionToABL(
  data: LifecycleSectionData['completionConditions'],
): SectionEdit[] {
  if (data.length === 0) {
    return [{ section: 'COMPLETE', content: null }];
  }

  const items = data
    .map((c) => {
      const lines = [`  - WHEN: ${c.when}`];
      const structuredPayload = {
        voiceConfig: c.voiceConfig,
        richContent: c.richContent,
        actions: c.actions,
      };
      if (c.respond || hasStructuredRespondPayload(structuredPayload)) {
        lines.push(`    RESPOND: ${inlineQuote(c.respond ?? '')}`);
        appendStructuredRespondPayload(lines, 6, structuredPayload);
      }
      if (c.store) {
        lines.push(`    STORE: ${c.store}`);
      }
      return lines.join('\n');
    })
    .join('\n');

  return [
    {
      section: 'COMPLETE',
      content: `COMPLETE:\n${items}`,
    },
  ];
}

export function serializeLifecycleDiffToABL(
  previous: LifecycleSectionData,
  next: LifecycleSectionData,
): SectionEdit[] {
  const edits: SectionEdit[] = [];

  if (
    JSON.stringify({
      hasOnStart: previous.hasOnStart,
      onStartRespond: previous.onStartRespond,
      onStartCall: previous.onStartCall,
      onStartCallSpec: previous.onStartCallSpec,
      onStartSets: previous.onStartSets,
    }) !==
    JSON.stringify({
      hasOnStart: next.hasOnStart,
      onStartRespond: next.onStartRespond,
      onStartCall: next.onStartCall,
      onStartCallSpec: next.onStartCallSpec,
      onStartSets: next.onStartSets,
    })
  ) {
    edits.push(...serializeOnStartToABL(toOnStartSectionData(next)));
  }

  if (JSON.stringify(previous.errorHandlers) !== JSON.stringify(next.errorHandlers)) {
    edits.push(...serializeErrorHandlingToABL(next.errorHandlers));
  }

  if (JSON.stringify(previous.completionConditions) !== JSON.stringify(next.completionConditions)) {
    edits.push(...serializeCompletionToABL(next.completionConditions));
  }

  return edits;
}

export function serializeLifecycleToABL(data: LifecycleSectionData): SectionEdit[] {
  const edits: SectionEdit[] = [];

  // ON_START
  edits.push(...serializeOnStartToABL(toOnStartSectionData(data)));

  // HOOKS
  if (data.hasHooks && data.hooks.length > 0) {
    const hookLines = data.hooks
      .map((hookName) => {
        const hookConfig = data.hookConfigs?.[hookName as keyof typeof data.hookConfigs];
        if (!hookConfig) {
          return `  ${hookName}: true`;
        }

        const lines = [`  ${hookName}:`];
        appendToolInvocation(lines, 4, hookConfig.call, hookConfig.callSpec);
        for (const [variable, value] of Object.entries(hookConfig.set ?? {})) {
          lines.push(`    SET: ${variable} = ${value}`);
        }
        if (hookConfig.respond) {
          lines.push(`    RESPOND: ${inlineQuote(hookConfig.respond)}`);
        }
        appendStructuredRespondPayload(lines, 6, {
          voiceConfig: hookConfig.voiceConfig,
          richContent: hookConfig.richContent,
          actions: hookConfig.actions,
        });
        if (hookConfig.critical !== undefined) {
          lines.push(`    CRITICAL: ${hookConfig.critical ? 'true' : 'false'}`);
        }
        return lines.join('\n');
      })
      .join('\n');
    edits.push({
      section: 'HOOKS',
      content: `HOOKS:\n${hookLines}`,
    });
  } else {
    edits.push({ section: 'HOOKS', content: null });
  }

  // ON_ERROR
  edits.push(...serializeErrorHandlingToABL(data.errorHandlers));

  // COMPLETE
  edits.push(...serializeCompletionToABL(data.completionConditions));

  // MEMORY
  const hasMemory =
    data.memoryConfig.sessionVars.length > 0 || data.memoryConfig.persistentPaths.length > 0;
  if (hasMemory) {
    const lines: string[] = [];
    if (data.memoryConfig.sessionVars.length > 0) {
      lines.push('  session:');
      for (const v of data.memoryConfig.sessionVars) {
        lines.push(`    - ${v}`);
      }
    }
    if (data.memoryConfig.persistentPaths.length > 0) {
      lines.push('  persistent:');
      for (const p of data.memoryConfig.persistentPaths) {
        lines.push(`    - ${p}`);
      }
    }
    edits.push({
      section: 'MEMORY',
      content: `MEMORY:\n${lines.join('\n')}`,
    });
  } else {
    edits.push({ section: 'MEMORY', content: null });
  }

  return edits;
}

// =============================================================================
// CONVERSATION → CONVERSATION
// =============================================================================

export function serializeConversationBehaviorToABL(
  data: ConversationBehaviorData | undefined,
): SectionEdit[] {
  if (!data) {
    return [{ section: 'CONVERSATION', content: null }];
  }

  return [{ section: 'CONVERSATION', content: serializeConversationBehaviorBlock(data) }];
}

// =============================================================================
// BEHAVIOR REFS → USE BEHAVIOR_PROFILE lines
// =============================================================================

/**
 * Serialize behavior profile references (USE BEHAVIOR_PROFILE: name) into
 * section edits for an agent DSL document.
 */
export function serializeBehaviorRefsToABL(profileNames: string[]): SectionEdit[] {
  if (!profileNames || profileNames.length === 0) {
    return [{ section: 'BEHAVIOR', content: null }];
  }

  const lines = profileNames.map((name) => `USE BEHAVIOR_PROFILE: ${name}`);
  return [
    {
      section: 'BEHAVIOR',
      content: lines.join('\n'),
    },
  ];
}

// =============================================================================
// BEHAVIOR PROFILE → Full DSL document
// =============================================================================

export interface ProfileData {
  name: string;
  priority: number;
  when: string;
  instructions?: string;
  constraints?: Array<{ condition: string; action: string }>;
  toolsHide?: string[];
  toolsAdd?: Array<{
    name: string;
    description: string;
    parameters?: Array<{ name: string; type: string }>;
    returns?: string;
  }>;
  responseRules?: {
    tone?: string;
    max_length?: number;
    format?: string;
    max_buttons?: number;
    fallback_format?: string;
  };
  voice?: {
    provider?: string;
    voice_id?: string;
    speed?: number;
    instructions?: string;
    ssml?: string;
    plain_text?: string;
  };
  gatherOverrides?: {
    validationStyle?: string;
    confirmation?: string;
    fieldOverrides?: Record<
      string,
      { prompt?: string; validation?: string; extraction_hints?: string[] }
    >;
  };
  flowModifications?: {
    skip?: string[];
    replace?: string;
    overrides?: Record<string, { respond?: string }>;
  };
  conversationBehavior?: ConversationBehaviorData;
}

export function serializeProfileToABL(data: ProfileData): string {
  const lines: string[] = [];

  // Header
  lines.push(`BEHAVIOR_PROFILE: ${data.name}`);
  lines.push('');
  lines.push(`PRIORITY: ${data.priority}`);
  lines.push(`WHEN: ${data.when}`);

  // INSTRUCTIONS
  if (data.instructions) {
    lines.push('');
    if (data.instructions.includes('\n')) {
      lines.push('INSTRUCTIONS: |');
      for (const line of data.instructions.split('\n')) {
        lines.push(`  ${line}`);
      }
    } else {
      lines.push(`INSTRUCTIONS: ${inlineQuote(data.instructions)}`);
    }
  }

  // CONSTRAINTS
  if (data.constraints && data.constraints.length > 0) {
    lines.push('');
    lines.push('CONSTRAINTS:');
    for (const c of data.constraints) {
      lines.push(`  - ${inlineQuote(c.condition)}`);
    }
  }

  // RESPONSE
  const resp = data.responseRules;
  if (
    resp &&
    (resp.tone ||
      resp.max_length ||
      resp.format ||
      resp.max_buttons !== undefined ||
      resp.fallback_format)
  ) {
    lines.push('');
    lines.push('RESPONSE:');
    if (resp.max_buttons !== undefined) {
      lines.push(`  MAX_BUTTONS: ${resp.max_buttons}`);
    }
    if (resp.fallback_format) {
      lines.push(`  FALLBACK_FORMAT: ${resp.fallback_format}`);
    }
    if (resp.max_length) {
      lines.push(`  MAX_RESPONSE_LENGTH: ${resp.max_length}`);
    }
    if (resp.tone) {
      lines.push(`  TONE: ${inlineQuote(resp.tone)}`);
    }
    if (resp.format) {
      lines.push(`  FORMAT: ${inlineQuote(resp.format)}`);
    }
  }

  // VOICE
  const voice = data.voice;
  if (
    voice &&
    (voice.instructions ||
      voice.ssml ||
      voice.plain_text ||
      voice.provider ||
      voice.voice_id ||
      voice.speed)
  ) {
    lines.push('');
    lines.push('VOICE:');
    if (voice.instructions) {
      lines.push(`  INSTRUCTIONS: ${inlineQuote(voice.instructions)}`);
    }
    if (voice.ssml) {
      lines.push(`  SSML: ${inlineQuote(voice.ssml)}`);
    }
    if (voice.plain_text) {
      lines.push(`  PLAIN_TEXT: ${inlineQuote(voice.plain_text)}`);
    }
    if (voice.provider) {
      lines.push(`  PROVIDER: ${voice.provider}`);
    }
    if (voice.voice_id) {
      lines.push(`  VOICE_ID: ${voice.voice_id}`);
    }
    if (voice.speed !== undefined) {
      lines.push(`  SPEED: ${voice.speed}`);
    }
  }

  // TOOLS
  const hasToolsHide = data.toolsHide && data.toolsHide.length > 0;
  const hasToolsAdd = data.toolsAdd && data.toolsAdd.length > 0;
  if (hasToolsHide || hasToolsAdd) {
    lines.push('');
    lines.push('TOOLS:');
    if (hasToolsHide) {
      lines.push(`  HIDE: [${data.toolsHide!.join(', ')}]`);
    }
    if (hasToolsAdd) {
      lines.push('  ADD:');
      for (const tool of data.toolsAdd!) {
        lines.push(`    ${tool.name}:`);
        lines.push(`      DESCRIPTION: ${inlineQuote(tool.description)}`);
        if (tool.parameters && tool.parameters.length > 0) {
          lines.push('      PARAMETERS:');
          for (const p of tool.parameters) {
            lines.push(`        - ${p.name}: ${p.type}`);
          }
        }
        if (tool.returns) {
          lines.push(`      RETURNS: ${tool.returns}`);
        }
      }
    }
  }

  // GATHER
  const gather = data.gatherOverrides;
  if (
    gather &&
    (gather.validationStyle ||
      gather.confirmation ||
      (gather.fieldOverrides && Object.keys(gather.fieldOverrides).length > 0))
  ) {
    lines.push('');
    lines.push('GATHER:');
    if (gather.validationStyle) {
      lines.push(`  VALIDATION_STYLE: ${gather.validationStyle}`);
    }
    if (gather.confirmation) {
      lines.push(`  CONFIRMATION: ${gather.confirmation}`);
    }
    if (gather.fieldOverrides && Object.keys(gather.fieldOverrides).length > 0) {
      lines.push('  FIELD_OVERRIDES:');
      for (const [fieldName, override] of Object.entries(gather.fieldOverrides)) {
        lines.push(`    ${fieldName}:`);
        if (override.prompt) {
          lines.push(`      PROMPT: ${inlineQuote(override.prompt)}`);
        }
        if (override.validation) {
          lines.push(`      VALIDATION: ${inlineQuote(override.validation)}`);
        }
        if (override.extraction_hints && override.extraction_hints.length > 0) {
          lines.push(
            `      EXTRACTION_HINTS: [${override.extraction_hints.map(inlineQuote).join(', ')}]`,
          );
        }
      }
    }
  }

  // FLOW
  const flow = data.flowModifications;
  if (
    flow &&
    (flow.skip || flow.replace || (flow.overrides && Object.keys(flow.overrides).length > 0))
  ) {
    lines.push('');
    lines.push('FLOW:');
    if (flow.replace) {
      lines.push(`  REPLACE: ${flow.replace}`);
    }
    if (flow.skip && flow.skip.length > 0) {
      lines.push(`  SKIP: [${flow.skip.join(', ')}]`);
    }
    if (flow.overrides && Object.keys(flow.overrides).length > 0) {
      lines.push('  OVERRIDE:');
      for (const [stepName, override] of Object.entries(flow.overrides)) {
        lines.push(`    ${stepName}:`);
        if (override.respond) {
          lines.push(`      RESPOND: ${inlineQuote(override.respond)}`);
        }
      }
    }
  }

  const conversationContent = data.conversationBehavior
    ? serializeConversationBehaviorBlock(data.conversationBehavior)
    : null;
  if (conversationContent) {
    lines.push('');
    lines.push(conversationContent);
  }

  return lines.join('\n') + '\n';
}
