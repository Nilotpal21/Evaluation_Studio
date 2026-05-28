/**
 * serializeToYAML — Convert a compiled AgentIR back to canonical YAML ABL format.
 *
 * This module accepts an AgentIR object (typed as Record<string, unknown> to
 * avoid importing from the compiler, which has server-only dependencies) and
 * produces a human-readable YAML ABL string that round-trips through the
 * YAML parser.
 *
 * Only sections with actual content are emitted; empty arrays and undefined
 * fields are omitted for a clean, minimal output.
 */

// ---------------------------------------------------------------------------
// Internal type aliases — mirrors the AgentIR shape without importing it.
// We cast the incoming `unknown` through these as needed.
// ---------------------------------------------------------------------------

interface IRToolParam {
  name: string;
  type: string;
  required: boolean;
  description?: string;
  enum?: unknown[];
}

interface IRTool {
  name: string;
  description: string;
  parameters: IRToolParam[];
  tool_type?: string;
  system?: boolean;
}

interface IRGatherField {
  name: string;
  type: string;
  prompt: string;
  rich_content?: Record<string, unknown>;
  required: boolean;
  validation?: {
    type: string;
    rule: string;
    error_message: string;
    retry_prompt?: string;
    max_retries?: number;
  };
  extraction_hints?: string[];
  infer?: boolean;
  range?: boolean;
  list?: boolean;
  preferences?: boolean;
  depends_on?: string[];
  prompt_mode?: string;
}

interface IRConstraint {
  condition: string;
  on_fail: {
    type: string;
    message?: string;
    target?: string;
    reason?: string;
  };
}

interface IRHandoff {
  to: string;
  when: string;
  context: {
    pass: string[];
    summary: string;
    memory_grants?: Array<{ path: string; access?: 'read' | 'readwrite' }>;
    history?: unknown;
  };
  return: boolean;
  on_return?: { action?: string; handler?: string; map?: Record<string, string> };
}

interface IRReturnHandler {
  respond?: string;
  clear?: string[];
  continue?: boolean;
  resume_intent?: boolean;
}

interface IRDelegate {
  agent: string;
  when: string;
  purpose: string;
  input: Record<string, string>;
  returns: Record<string, string>;
  use_result: string;
  timeout?: string;
  on_failure: string;
  failure_message?: string;
}

interface IRCompletionCondition {
  when: string;
  respond?: string;
  voice_config?: Record<string, unknown>;
  rich_content?: Record<string, unknown>;
  actions?: IRActionSet;
  store?: string;
}

interface IRErrorHandler {
  type: string;
  subtypes?: string[];
  respond?: string;
  voice_config?: Record<string, unknown>;
  rich_content?: Record<string, unknown>;
  actions?: IRActionSet;
  retry?: number;
  retry_delay_ms?: number;
  retry_backoff?: string;
  retry_max_delay_ms?: number;
  then: string;
  handoff_target?: string;
  backtrack_to?: string;
}

interface IRToolInvocation {
  tool: string;
  with?: Record<string, unknown>;
  as?: string;
}

interface IRActionOption {
  id: string;
  label: string;
  description?: string;
}

interface IRActionElement {
  id: string;
  type: 'button' | 'select' | 'input';
  label: string;
  value?: string;
  description?: string;
  options?: IRActionOption[];
  input_type?: 'text' | 'number' | 'date' | 'time' | 'email';
  placeholder?: string;
  required?: boolean;
}

interface IRActionSet {
  elements: IRActionElement[];
  submit_label?: string;
  submit_id?: string;
}

interface IRActionOnReturn {
  action?: string;
  handler?: string;
  map?: Record<string, string>;
}

interface IRActionHandlerAction {
  respond?: string;
  voice_config?: Record<string, unknown>;
  rich_content?: Record<string, unknown>;
  set?: Record<string, string>;
  clear?: string[];
  call?: string;
  result_key?: string;
  call_spec?: IRToolInvocation;
  handoff?: string;
  delegate?: string;
  return?: boolean;
  on_return?: IRActionOnReturn;
  goto?: string;
  complete?: boolean;
}

interface IRActionHandler {
  action_id: string;
  condition?: string;
  do?: IRActionHandlerAction[];
  respond?: string;
  voice_config?: Record<string, unknown>;
  rich_content?: Record<string, unknown>;
  set?: Record<string, string>;
  transition?: string;
}

interface IRReasoningZone {
  goal: string;
  available_tools?: string[];
  exit_when?: string;
  max_turns?: number;
  constraints?: string[];
}

interface IRHookAction {
  call?: string;
  call_spec?: IRToolInvocation;
  set?: Record<string, string>;
  respond?: string;
  voice_config?: Record<string, unknown>;
  rich_content?: Record<string, unknown>;
  actions?: IRActionSet;
  critical?: boolean;
}

interface IRSetAssignment {
  variable: string;
  expression: string;
}

interface IRFlowGatherField {
  name: string;
  type?: string;
  required?: boolean;
  prompt?: string;
  rich_content?: Record<string, unknown>;
  validation?: { type: string; rule: string; error_message: string };
  extraction_hints?: string[];
  infer?: boolean;
}

interface IRFlowGatherConfig {
  fields: IRFlowGatherField[];
  strategy?: string;
  prompt?: string;
}

interface IRCallResultBlock {
  respond?: string;
  message_key?: string;
  voice_config?: Record<string, unknown>;
  rich_content?: Record<string, unknown>;
  actions?: IRActionSet;
  set?: Record<string, string>;
  call?: string;
  call_spec?: IRToolInvocation;
  then?: string;
  branches?: Array<{
    condition?: string;
    respond?: string;
    message_key?: string;
    voice_config?: Record<string, unknown>;
    rich_content?: Record<string, unknown>;
    actions?: IRActionSet;
    set?: Record<string, string>;
    call?: string;
    call_spec?: IRToolInvocation;
    then: string;
  }>;
}

interface IRFlowStep {
  name: string;
  reasoning_zone?: IRReasoningZone;
  respond?: string;
  voice_config?: Record<string, unknown>;
  rich_content?: Record<string, unknown>;
  call?: string;
  call_with?: Record<string, string>;
  call_as?: string;
  call_spec?: IRToolInvocation;
  success_when?: string;
  then?: string;
  check?: string;
  gather?: IRFlowGatherConfig;
  present?: string;
  corrections?: boolean;
  complete_when?: string;
  set?: IRSetAssignment[];
  clear?: string[];
  actions?: IRActionSet;
  on_action?: IRActionHandler[];
  on_success?: IRCallResultBlock;
  on_failure?: IRCallResultBlock;
  on_result?: Array<{
    condition?: string;
    respond?: string;
    message_key?: string;
    voice_config?: Record<string, unknown>;
    rich_content?: Record<string, unknown>;
    actions?: IRActionSet;
    set?: Record<string, string>;
    call?: string;
    call_spec?: IRToolInvocation;
    then: string;
  }>;
  on_input?: Array<{
    condition?: string;
    respond?: string;
    message_key?: string;
    voice_config?: Record<string, unknown>;
    rich_content?: Record<string, unknown>;
    actions?: IRActionSet;
    set?: Record<string, string>;
    call?: string;
    call_spec?: IRToolInvocation;
    then: string;
  }>;
  on_fail?: string;
  digressions?: Array<{
    intent: string;
    respond?: string;
    message_key?: string;
    voice_config?: Record<string, unknown>;
    rich_content?: Record<string, unknown>;
    actions?: IRActionSet;
    goto?: string;
    delegate?: string;
    call?: string;
    call_spec?: IRToolInvocation;
    resume?: boolean;
  }>;
  sub_intents?: Array<{
    intent: string;
    respond?: string;
    message_key?: string;
    voice_config?: Record<string, unknown>;
    rich_content?: Record<string, unknown>;
    actions?: IRActionSet;
    clear?: string[];
    set?: Record<string, string>;
    call?: string;
    call_spec?: IRToolInvocation;
  }>;
}

interface IRSessionMemory {
  name: string;
  description?: string;
  initial_value?: unknown;
}

interface IRPersistentMemory {
  path: string;
  description?: string;
  scope?: 'user' | 'project';
  access: string;
  type?: string;
}

interface IRRememberTrigger {
  when: string;
  store: { value: string; target: string };
  ttl?: string;
}

interface IRRecallInstruction {
  event: string;
  instruction: string;
}

interface IREscalationTrigger {
  when: string;
  reason: string;
  priority: string;
  tags?: string[];
}

// ---------------------------------------------------------------------------
// YAML Helpers
// ---------------------------------------------------------------------------

/** Escape a YAML string value. Wraps in double quotes if it contains special chars. */
function yamlStr(value: string): string {
  if (value === '') return '""';
  // Needs quoting if contains: colon-space, hash, leading/trailing whitespace,
  // newlines, quotes, or starts with special YAML chars
  if (
    value.includes(': ') ||
    value.includes('#') ||
    value.includes('\n') ||
    value.includes('"') ||
    value.includes("'") ||
    value.startsWith('- ') ||
    value.startsWith('*') ||
    value.startsWith('&') ||
    value.startsWith('!') ||
    value.startsWith('? ') ||
    value.startsWith('{') ||
    value.startsWith('[') ||
    value.startsWith('@') ||
    value.startsWith('`') ||
    value.startsWith('%') ||
    value.startsWith(',') ||
    value.startsWith('|') ||
    value.startsWith('>') ||
    value.trim() !== value ||
    value === 'true' ||
    value === 'false' ||
    value === 'null' ||
    value === 'yes' ||
    value === 'no' ||
    value === 'on' ||
    value === 'off' ||
    /^\d/.test(value)
  ) {
    // Use double-quote with escaping
    const escaped = value
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\n/g, '\\n')
      .replace(/\t/g, '\\t');
    return `"${escaped}"`;
  }
  return value;
}

/** Check if an array has content. */
function hasItems(arr: unknown): arr is unknown[] {
  return Array.isArray(arr) && arr.length > 0;
}

/** Check if a Record has keys. */
function hasKeys(obj: unknown): obj is Record<string, unknown> {
  return (
    obj !== null && typeof obj === 'object' && !Array.isArray(obj) && Object.keys(obj).length > 0
  );
}

function yamlValue(value: unknown): string {
  if (typeof value === 'string') {
    return yamlStr(value);
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (value === null) {
    return 'null';
  }
  return yamlStr(JSON.stringify(value));
}

function serializeYamlNode(lines: string[], indent: string, key: string, value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${indent}${key}: []`);
      return;
    }

    lines.push(`${indent}${key}:`);
    for (const item of value) {
      serializeYamlArrayItem(lines, `${indent}  `, item);
    }
    return;
  }

  if (hasKeys(value)) {
    lines.push(`${indent}${key}:`);
    for (const [entryKey, entryValue] of Object.entries(value)) {
      serializeYamlNode(lines, `${indent}  `, entryKey, entryValue);
    }
    return;
  }

  if (value && typeof value === 'object') {
    lines.push(`${indent}${key}: ${yamlStr(JSON.stringify(value))}`);
    return;
  }

  lines.push(`${indent}${key}: ${yamlValue(value)}`);
}

function serializeYamlArrayItem(lines: string[], indent: string, value: unknown): void {
  if (Array.isArray(value)) {
    if (value.length === 0) {
      lines.push(`${indent}- []`);
      return;
    }

    lines.push(`${indent}-`);
    for (const item of value) {
      serializeYamlArrayItem(lines, `${indent}  `, item);
    }
    return;
  }

  if (hasKeys(value)) {
    lines.push(`${indent}-`);
    for (const [entryKey, entryValue] of Object.entries(value)) {
      serializeYamlNode(lines, `${indent}  `, entryKey, entryValue);
    }
    return;
  }

  lines.push(`${indent}- ${yamlValue(value)}`);
}

function serializeCallSpec(
  lines: string[],
  indent: string,
  call: string | undefined,
  callSpec: IRToolInvocation | undefined,
): void {
  const callValue = call ?? callSpec?.tool;
  if (!callValue) {
    return;
  }

  lines.push(`${indent}call: ${yamlStr(callValue)}`);

  if (!callSpec || (!hasKeys(callSpec.with) && !callSpec.as)) {
    return;
  }

  lines.push(`${indent}call_spec:`);
  if (hasKeys(callSpec.with)) {
    lines.push(`${indent}  with:`);
    for (const [key, value] of Object.entries(callSpec.with)) {
      lines.push(`${indent}    ${key}: ${yamlValue(value)}`);
    }
  }
  if (callSpec.as) {
    lines.push(`${indent}  as: ${yamlStr(callSpec.as)}`);
  }
}

function getOrderedActionHandlerActions(handler: IRActionHandler): IRActionHandlerAction[] {
  if (hasItems(handler.do)) {
    return handler.do;
  }

  const actions: IRActionHandlerAction[] = [];
  if (hasKeys(handler.set)) {
    actions.push({ set: handler.set as Record<string, string> });
  }
  if (handler.respond !== undefined) {
    actions.push({
      respond: handler.respond,
      voice_config: handler.voice_config,
      rich_content: handler.rich_content,
    });
  }
  if (handler.transition) {
    actions.push({ goto: handler.transition });
  }
  return actions;
}

function serializeActionSet(lines: string[], indent: string, actionSet: IRActionSet): void {
  if (!hasItems(actionSet.elements)) {
    return;
  }

  lines.push(`${indent}actions:`);
  lines.push(`${indent}  elements:`);
  for (const element of actionSet.elements) {
    lines.push(`${indent}    - type: ${element.type}`);
    lines.push(`${indent}      id: ${yamlStr(element.id)}`);
    lines.push(`${indent}      label: ${yamlStr(element.label)}`);
    if (element.value) {
      lines.push(`${indent}      value: ${yamlStr(element.value)}`);
    }
    if (element.description) {
      lines.push(`${indent}      description: ${yamlStr(element.description)}`);
    }
    if (hasItems(element.options)) {
      lines.push(`${indent}      options:`);
      for (const option of element.options) {
        lines.push(`${indent}        - id: ${yamlStr(option.id)}`);
        lines.push(`${indent}          label: ${yamlStr(option.label)}`);
        if (option.description) {
          lines.push(`${indent}          description: ${yamlStr(option.description)}`);
        }
      }
    }
    if (element.input_type) {
      lines.push(`${indent}      input_type: ${element.input_type}`);
    }
    if (element.placeholder) {
      lines.push(`${indent}      placeholder: ${yamlStr(element.placeholder)}`);
    }
    if (element.required !== undefined) {
      lines.push(`${indent}      required: ${element.required}`);
    }
  }
  if (actionSet.submit_label) {
    lines.push(`${indent}  submit_label: ${yamlStr(actionSet.submit_label)}`);
  }
  if (actionSet.submit_id) {
    lines.push(`${indent}  submit_id: ${yamlStr(actionSet.submit_id)}`);
  }
}

function serializeRecordBlock(
  lines: string[],
  indent: string,
  key: string,
  record: Record<string, unknown> | undefined,
): void {
  if (!hasKeys(record)) {
    return;
  }

  lines.push(`${indent}${key}:`);
  for (const [entryKey, value] of Object.entries(record)) {
    serializeYamlNode(lines, `${indent}  `, entryKey, value);
  }
}

function serializeStringRecordBlock(
  lines: string[],
  indent: string,
  key: string,
  record: Record<string, string> | undefined,
): void {
  if (!hasKeys(record)) {
    return;
  }

  lines.push(`${indent}${key}:`);
  for (const [entryKey, value] of Object.entries(record)) {
    lines.push(`${indent}  ${entryKey}: ${yamlStr(value)}`);
  }
}

function serializeStructuredResponsePayload(
  lines: string[],
  indent: string,
  payload: {
    voice_config?: Record<string, unknown>;
    rich_content?: Record<string, unknown>;
    actions?: IRActionSet;
  },
): void {
  serializeRecordBlock(lines, indent, 'voice_config', payload.voice_config);
  serializeRecordBlock(lines, indent, 'rich_content', payload.rich_content);
  if (payload.actions) {
    serializeActionSet(lines, indent, payload.actions);
  }
}

function serializeActionOnReturn(
  lines: string[],
  indent: string,
  onReturn: IRActionOnReturn | undefined,
): void {
  if (!onReturn) {
    return;
  }

  lines.push(`${indent}on_return:`);
  if (onReturn.action) {
    lines.push(`${indent}  action: ${yamlStr(onReturn.action)}`);
  }
  if (onReturn.handler) {
    lines.push(`${indent}  handler: ${yamlStr(onReturn.handler)}`);
  }
  if (hasKeys(onReturn.map)) {
    lines.push(`${indent}  map:`);
    for (const [key, value] of Object.entries(onReturn.map)) {
      lines.push(`${indent}    ${key}: ${yamlStr(value)}`);
    }
  }
}

function serializeActionHandlerAction(
  lines: string[],
  indent: string,
  action: IRActionHandlerAction,
): void {
  if (action.respond !== undefined) {
    lines.push(`${indent}- respond: ${yamlStr(action.respond)}`);
    serializeStructuredResponsePayload(lines, `${indent}  `, action);
    return;
  }

  if (hasKeys(action.set)) {
    lines.push(`${indent}- set:`);
    for (const [key, value] of Object.entries(action.set)) {
      lines.push(`${indent}    ${key}: ${yamlStr(value)}`);
    }
    return;
  }

  if (hasItems(action.clear)) {
    lines.push(`${indent}- clear:`);
    for (const field of action.clear) {
      lines.push(`${indent}    - ${yamlStr(field)}`);
    }
    return;
  }

  if (action.call || action.call_spec) {
    const callValue = action.call ?? action.call_spec?.tool;
    if (callValue) {
      lines.push(`${indent}- call: ${yamlStr(callValue)}`);
      const callWith = action.call_spec?.with;
      const resultKey = action.result_key ?? action.call_spec?.as;
      if (hasKeys(callWith) || resultKey) {
        lines.push(`${indent}  call_spec:`);
        if (hasKeys(callWith)) {
          lines.push(`${indent}    with:`);
          for (const [key, value] of Object.entries(callWith)) {
            lines.push(`${indent}      ${key}: ${yamlValue(value)}`);
          }
        }
        if (resultKey) {
          lines.push(`${indent}    as: ${yamlStr(resultKey)}`);
        }
      }
    }
    return;
  }

  if (action.handoff) {
    lines.push(`${indent}- handoff: ${yamlStr(action.handoff)}`);
    return;
  }

  if (action.delegate) {
    lines.push(`${indent}- delegate: ${yamlStr(action.delegate)}`);
    if (action.return !== undefined) {
      lines.push(`${indent}  return: ${action.return}`);
    }
    serializeActionOnReturn(lines, `${indent}  `, action.on_return);
    return;
  }

  if (action.goto) {
    lines.push(`${indent}- goto: ${yamlStr(action.goto)}`);
    return;
  }

  if (action.complete !== undefined) {
    lines.push(`${indent}- complete: ${action.complete}`);
  }
}

function serializeActionHandlersBlock(
  lines: string[],
  indent: string,
  handlers: IRActionHandler[] | undefined,
): void {
  if (!hasItems(handlers)) {
    return;
  }

  for (const handler of handlers) {
    lines.push(`${indent}${yamlStr(handler.action_id)}:`);
    if (handler.condition) {
      lines.push(`${indent}  condition: ${yamlStr(handler.condition)}`);
    }

    const actions = getOrderedActionHandlerActions(handler);
    if (actions.length > 0) {
      lines.push(`${indent}  do:`);
      for (const action of actions) {
        serializeActionHandlerAction(lines, `${indent}    `, action);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Section Serializers
// ---------------------------------------------------------------------------

function serializeIdentity(ir: Record<string, unknown>): string {
  const identity = ir['identity'] as Record<string, unknown> | undefined;
  if (!identity) return '';

  const persona = identity['persona'] as string | undefined;
  const limitations = identity['limitations'] as string[] | undefined;

  if (!persona && !hasItems(limitations)) return '';

  const lines: string[] = ['identity:'];
  if (persona) {
    lines.push(`  persona: ${yamlStr(persona)}`);
  }
  if (hasItems(limitations)) {
    lines.push('  limitations:');
    for (const lim of limitations) {
      lines.push(`    - ${yamlStr(lim)}`);
    }
  }
  return lines.join('\n');
}

function serializeTools(ir: Record<string, unknown>): string {
  const tools = ir['tools'] as IRTool[] | undefined;
  if (!hasItems(tools)) return '';

  // Filter out system tools (like __handoff__, __complete__)
  const userTools = tools.filter((t) => !t.system);
  if (userTools.length === 0) return '';

  const lines: string[] = ['tools:'];
  for (const tool of userTools) {
    lines.push(`  - name: ${yamlStr(tool.name)}`);
    if (tool.description) {
      lines.push(`    description: ${yamlStr(tool.description)}`);
    }
    if (tool.tool_type) {
      lines.push(`    type: ${tool.tool_type}`);
    }
    if (hasItems(tool.parameters)) {
      lines.push('    parameters:');
      for (const param of tool.parameters) {
        lines.push(`      - name: ${yamlStr(param.name)}`);
        lines.push(`        type: ${param.type}`);
        lines.push(`        required: ${param.required}`);
        if (param.description) {
          lines.push(`        description: ${yamlStr(param.description)}`);
        }
        if (hasItems(param.enum)) {
          lines.push(`        enum: [${param.enum.map((v) => yamlStr(String(v))).join(', ')}]`);
        }
      }
    }
  }
  return lines.join('\n');
}

function serializeFlow(ir: Record<string, unknown>): string {
  const flow = ir['flow'] as Record<string, unknown> | undefined;
  if (!flow) return '';

  const stepNames = flow['steps'] as string[] | undefined;
  const definitions = flow['definitions'] as Record<string, IRFlowStep> | undefined;
  if (!hasItems(stepNames) || !definitions) return '';

  const lines: string[] = ['flow:'];

  const entryPoint = flow['entry_point'] as string | undefined;
  if (entryPoint && entryPoint !== stepNames[0]) {
    lines.push(`  entry_point: ${yamlStr(entryPoint)}`);
  }

  lines.push('  steps:');

  for (const stepName of stepNames) {
    const step = definitions[stepName];
    if (!step) continue;

    lines.push(`    ${stepName}:`);
    serializeFlowStep(step, lines);
  }

  return lines.join('\n');
}

function serializeActionHandlers(ir: Record<string, unknown>): string {
  const handlers = ir['action_handlers'] as IRActionHandler[] | undefined;
  if (!hasItems(handlers)) return '';

  const lines: string[] = ['action_handlers:'];
  serializeActionHandlersBlock(lines, '  ', handlers);
  return lines.join('\n');
}

function serializeFlowStep(step: IRFlowStep, lines: string[]): void {
  if (step.reasoning_zone) {
    lines.push('      reasoning: true');
    lines.push(`      goal: ${yamlStr(step.reasoning_zone.goal)}`);
    if (hasItems(step.reasoning_zone.available_tools)) {
      lines.push('      available_tools:');
      for (const toolName of step.reasoning_zone.available_tools) {
        lines.push(`        - ${yamlStr(toolName)}`);
      }
    }
    if (step.reasoning_zone.exit_when) {
      lines.push(`      exit_when: ${yamlStr(step.reasoning_zone.exit_when)}`);
    }
    if (step.reasoning_zone.max_turns !== undefined) {
      lines.push(`      max_turns: ${step.reasoning_zone.max_turns}`);
    }
    if (hasItems(step.reasoning_zone.constraints)) {
      lines.push('      step_constraints:');
      for (const constraint of step.reasoning_zone.constraints) {
        lines.push(`        - ${yamlStr(constraint)}`);
      }
    }
  } else {
    lines.push('      reasoning: false');
  }

  // Present
  if (step.present) {
    lines.push(`      present: ${yamlStr(step.present)}`);
  }

  // Respond (before gather/call, used as greeting)
  if (step.respond && !step.call) {
    lines.push(`      respond: ${yamlStr(step.respond)}`);
  }
  serializeStructuredResponsePayload(lines, '      ', {
    voice_config: step.voice_config,
    rich_content: step.rich_content,
  });

  // Gather
  if (step.gather && hasItems(step.gather.fields)) {
    lines.push('      gather:');
    if (step.gather.strategy) {
      lines.push(`        strategy: ${step.gather.strategy}`);
    }
    if (step.gather.prompt) {
      lines.push(`        prompt: ${yamlStr(step.gather.prompt)}`);
    }
    lines.push('        fields:');
    for (const field of step.gather.fields) {
      lines.push(`          - name: ${yamlStr(field.name)}`);
      if (field.type) {
        lines.push(`            type: ${field.type}`);
      }
      if (field.required === false) {
        lines.push('            required: false');
      }
      if (field.prompt) {
        lines.push(`            prompt: ${yamlStr(field.prompt)}`);
      }
      serializeRecordBlock(lines, '            ', 'rich_content', field.rich_content);
      if (field.validation) {
        lines.push(`            validation: ${yamlStr(field.validation.rule)}`);
      }
      if (hasItems(field.extraction_hints)) {
        lines.push('            extraction_hints:');
        for (const hint of field.extraction_hints) {
          lines.push(`              - ${yamlStr(hint)}`);
        }
      }
      if (field.infer === true) {
        lines.push('            infer: true');
      }
    }
  }

  // Corrections
  if (step.corrections === true) {
    lines.push('      corrections: true');
  }

  // Complete when
  if (step.complete_when) {
    lines.push(`      complete_when: ${yamlStr(step.complete_when)}`);
  }

  // SET assignments
  if (hasItems(step.set)) {
    lines.push('      set:');
    for (const assignment of step.set) {
      lines.push(`        - variable: ${yamlStr(assignment.variable)}`);
      lines.push(`          expression: ${yamlStr(assignment.expression)}`);
    }
  }

  // CLEAR
  if (hasItems(step.clear)) {
    lines.push('      clear:');
    for (const field of step.clear) {
      lines.push(`        - ${yamlStr(field)}`);
    }
  }

  if (step.actions) {
    serializeActionSet(lines, '      ', step.actions);
  }

  // Call
  const stepCall = step.call ?? step.call_spec?.tool;
  if (stepCall) {
    lines.push(`      call: ${yamlStr(stepCall)}`);
    const stepCallWith = step.call_with ?? step.call_spec?.with;
    if (hasKeys(stepCallWith)) {
      lines.push('      call_with:');
      for (const [key, val] of Object.entries(stepCallWith)) {
        lines.push(`        ${key}: ${yamlValue(val)}`);
      }
    }
    const stepCallAs = step.call_as ?? step.call_spec?.as;
    if (stepCallAs) {
      lines.push(`      call_as: ${yamlStr(stepCallAs)}`);
    }
    if (step.success_when) {
      lines.push(`      success_when: ${yamlStr(step.success_when)}`);
    }
    // Respond after call (shows results)
    if (step.respond) {
      lines.push(`      respond: ${yamlStr(step.respond)}`);
    }
  }

  // Check
  if (step.check) {
    lines.push(`      check: ${yamlStr(step.check)}`);
  }

  // On fail (simple)
  if (step.on_fail) {
    lines.push(`      on_fail: ${yamlStr(step.on_fail)}`);
  }

  // ON_SUCCESS / ON_FAILURE
  if (step.on_success) {
    serializeCallResultBlock('on_success', step.on_success, lines, 6);
  }
  if (step.on_failure) {
    serializeCallResultBlock('on_failure', step.on_failure, lines, 6);
  }

  // ON_RESULT branching
  if (hasItems(step.on_result)) {
    lines.push('      on_result:');
    for (const branch of step.on_result) {
      if (branch.condition) {
        lines.push(`        - condition: ${yamlStr(branch.condition)}`);
      } else {
        lines.push('        - condition: null  # else/default');
      }
      if (branch.respond) {
        lines.push(`          respond: ${yamlStr(branch.respond)}`);
      }
      serializeStructuredResponsePayload(lines, '          ', branch);
      if (branch.message_key) {
        lines.push(`          message_key: ${yamlStr(branch.message_key)}`);
      }
      serializeStringRecordBlock(lines, '          ', 'set', branch.set);
      if (branch.call || branch.call_spec) {
        serializeCallSpec(lines, '          ', branch.call, branch.call_spec);
      }
      lines.push(`          then: ${yamlStr(branch.then)}`);
    }
  }

  // ON_INPUT branching
  if (hasItems(step.on_input)) {
    lines.push('      on_input:');
    for (const branch of step.on_input) {
      if (branch.condition) {
        lines.push(`        - condition: ${yamlStr(branch.condition)}`);
      } else {
        lines.push('        - condition: null  # else/default');
      }
      if (branch.respond) {
        lines.push(`          respond: ${yamlStr(branch.respond)}`);
      }
      serializeStructuredResponsePayload(lines, '          ', branch);
      if (branch.message_key) {
        lines.push(`          message_key: ${yamlStr(branch.message_key)}`);
      }
      serializeStringRecordBlock(lines, '          ', 'set', branch.set);
      if (branch.call || branch.call_spec) {
        serializeCallSpec(lines, '          ', branch.call, branch.call_spec);
      }
      lines.push(`          then: ${yamlStr(branch.then)}`);
    }
  }

  if (hasItems(step.on_action)) {
    lines.push('      on_action:');
    serializeActionHandlersBlock(lines, '        ', step.on_action);
  }

  // Digressions
  if (hasItems(step.digressions)) {
    lines.push('      digressions:');
    for (const dig of step.digressions) {
      lines.push(`        - intent: ${yamlStr(dig.intent)}`);
      if (dig.respond) {
        lines.push(`          respond: ${yamlStr(dig.respond)}`);
      }
      serializeStructuredResponsePayload(lines, '          ', dig);
      if (dig.message_key) {
        lines.push(`          message_key: ${yamlStr(dig.message_key)}`);
      }
      if (dig.goto) {
        lines.push(`          goto: ${yamlStr(dig.goto)}`);
      }
      if (dig.delegate) {
        lines.push(`          delegate: ${yamlStr(dig.delegate)}`);
      }
      serializeCallSpec(lines, '          ', dig.call, dig.call_spec);
      if (dig.resume === true) {
        lines.push('          resume: true');
      }
    }
  }

  // Sub-intents
  if (hasItems(step.sub_intents)) {
    lines.push('      sub_intents:');
    for (const si of step.sub_intents) {
      lines.push(`        - intent: ${yamlStr(si.intent)}`);
      if (si.respond) {
        lines.push(`          respond: ${yamlStr(si.respond)}`);
      }
      serializeStructuredResponsePayload(lines, '          ', si);
      if (si.message_key) {
        lines.push(`          message_key: ${yamlStr(si.message_key)}`);
      }
      if (hasItems(si.clear)) {
        lines.push('          clear:');
        for (const c of si.clear) {
          lines.push(`            - ${yamlStr(c)}`);
        }
      }
      if (hasKeys(si.set)) {
        lines.push('          set:');
        for (const [key, val] of Object.entries(si.set)) {
          lines.push(`            ${key}: ${yamlStr(val)}`);
        }
      }
      serializeCallSpec(lines, '          ', si.call, si.call_spec);
    }
  }

  // Then (transition)
  if (step.then) {
    lines.push(`      then: ${yamlStr(step.then)}`);
  }
}

function serializeCallResultBlock(
  key: string,
  block: IRCallResultBlock,
  lines: string[],
  baseIndent: number,
): void {
  const pad = ' '.repeat(baseIndent);
  lines.push(`${pad}${key}:`);

  if (block.respond) {
    lines.push(`${pad}  respond: ${yamlStr(block.respond)}`);
  }
  serializeStructuredResponsePayload(lines, `${pad}  `, block);
  if (block.message_key) {
    lines.push(`${pad}  message_key: ${yamlStr(block.message_key)}`);
  }
  serializeStringRecordBlock(lines, `${pad}  `, 'set', block.set);
  if (block.call || block.call_spec) {
    serializeCallSpec(lines, `${pad}  `, block.call, block.call_spec);
  }
  if (block.then) {
    lines.push(`${pad}  then: ${yamlStr(block.then)}`);
  }

  if (hasItems(block.branches)) {
    lines.push(`${pad}  branches:`);
    for (const branch of block.branches) {
      if (branch.condition) {
        lines.push(`${pad}    - condition: ${yamlStr(branch.condition)}`);
      } else {
        lines.push(`${pad}    - condition: null`);
      }
      if (branch.respond) {
        lines.push(`${pad}      respond: ${yamlStr(branch.respond)}`);
      }
      serializeStructuredResponsePayload(lines, `${pad}      `, branch);
      if (branch.message_key) {
        lines.push(`${pad}      message_key: ${yamlStr(branch.message_key)}`);
      }
      serializeStringRecordBlock(lines, `${pad}      `, 'set', branch.set);
      serializeCallSpec(lines, `${pad}      `, branch.call, branch.call_spec);
      lines.push(`${pad}      then: ${yamlStr(branch.then)}`);
    }
  }
}

function serializeGather(ir: Record<string, unknown>): string {
  const gather = ir['gather'] as Record<string, unknown> | undefined;
  if (!gather) return '';

  const fields = gather['fields'] as IRGatherField[] | undefined;
  if (!hasItems(fields)) return '';

  const lines: string[] = ['gather:'];
  for (const field of fields) {
    lines.push(`  ${field.name}:`);
    lines.push(`    prompt: ${yamlStr(field.prompt)}`);
    lines.push(`    type: ${field.type}`);
    lines.push(`    required: ${field.required}`);
    if (field.validation) {
      lines.push('    validation:');
      lines.push(`      type: ${field.validation.type}`);
      lines.push(`      rule: ${yamlStr(field.validation.rule)}`);
      lines.push(`      error_message: ${yamlStr(field.validation.error_message)}`);
      if (field.validation.retry_prompt) {
        lines.push(`      retry_prompt: ${yamlStr(field.validation.retry_prompt)}`);
      }
      if (field.validation.max_retries !== undefined) {
        lines.push(`      max_retries: ${field.validation.max_retries}`);
      }
    }
    if (hasItems(field.extraction_hints)) {
      lines.push('    extraction_hints:');
      for (const hint of field.extraction_hints) {
        lines.push(`      - ${yamlStr(hint)}`);
      }
    }
    if (field.infer === true) {
      lines.push('    infer: true');
    }
    if (field.range === true) {
      lines.push('    range: true');
    }
    if (field.list === true) {
      lines.push('    list: true');
    }
    if (field.preferences === true) {
      lines.push('    preferences: true');
    }
    if (hasItems(field.depends_on)) {
      lines.push('    depends_on:');
      for (const dep of field.depends_on) {
        lines.push(`      - ${yamlStr(dep)}`);
      }
    }
    if (field.prompt_mode) {
      lines.push(`    prompt_mode: ${field.prompt_mode}`);
    }
  }
  return lines.join('\n');
}

function serializeMemory(ir: Record<string, unknown>): string {
  const memory = ir['memory'] as Record<string, unknown> | undefined;
  if (!memory) return '';

  const session = memory['session'] as IRSessionMemory[] | undefined;
  const persistent = memory['persistent'] as IRPersistentMemory[] | undefined;
  const remember = memory['remember'] as IRRememberTrigger[] | undefined;
  const recall = memory['recall'] as IRRecallInstruction[] | undefined;

  if (!hasItems(session) && !hasItems(persistent) && !hasItems(remember) && !hasItems(recall)) {
    return '';
  }

  const lines: string[] = ['memory:'];

  if (hasItems(session)) {
    lines.push('  session:');
    for (const s of session) {
      if (s.description || s.initial_value !== undefined) {
        lines.push(`    - name: ${yamlStr(s.name)}`);
        if (s.description) {
          lines.push(`      description: ${yamlStr(s.description)}`);
        }
        if (s.initial_value !== undefined) {
          lines.push(`      initial_value: ${JSON.stringify(s.initial_value)}`);
        }
      } else {
        lines.push(`    - ${yamlStr(s.name)}`);
      }
    }
  }

  if (hasItems(persistent)) {
    lines.push('  persistent:');
    for (const p of persistent) {
      lines.push(`    - path: ${yamlStr(p.path)}`);
      lines.push(`      SCOPE: ${p.scope ?? 'user'}`);
      lines.push(`      access: ${p.access}`);
      if (p.description) {
        lines.push(`      description: ${yamlStr(p.description)}`);
      }
      if (p.type) {
        lines.push(`      type: ${p.type}`);
      }
    }
  }

  if (hasItems(remember)) {
    lines.push('  remember:');
    for (const r of remember) {
      lines.push(`    - when: ${yamlStr(r.when)}`);
      lines.push('      store:');
      lines.push(`        value: ${yamlStr(r.store.value)}`);
      lines.push(`        target: ${yamlStr(r.store.target)}`);
      if (r.ttl) {
        lines.push(`      ttl: ${yamlStr(r.ttl)}`);
      }
    }
  }

  if (hasItems(recall)) {
    lines.push('  recall:');
    for (const r of recall) {
      lines.push(`    - event: ${yamlStr(r.event)}`);
      lines.push(`      instruction: ${yamlStr(r.instruction)}`);
    }
  }

  return lines.join('\n');
}

function serializeConstraints(ir: Record<string, unknown>): string {
  const constraintConfig = ir['constraints'] as Record<string, unknown> | undefined;
  if (!constraintConfig) return '';

  const constraints = constraintConfig['constraints'] as IRConstraint[] | undefined;
  if (!hasItems(constraints)) return '';

  const lines: string[] = ['constraints:'];
  for (const c of constraints) {
    lines.push(`  - condition: ${yamlStr(c.condition)}`);
    if (c.on_fail) {
      lines.push('    on_fail:');
      lines.push(`      action: ${c.on_fail.type}`);
      if (c.on_fail.message) {
        lines.push(`      message: ${yamlStr(c.on_fail.message)}`);
      }
      if (c.on_fail.target) {
        lines.push(`      target: ${yamlStr(c.on_fail.target)}`);
      }
      if (c.on_fail.reason) {
        lines.push(`      reason: ${yamlStr(c.on_fail.reason)}`);
      }
    }
  }
  return lines.join('\n');
}

function serializeGuardrails(ir: Record<string, unknown>): string {
  const constraintConfig = ir['constraints'] as Record<string, unknown> | undefined;
  if (!constraintConfig) return '';

  const guardrails = constraintConfig['guardrails'] as
    | Array<{
        name: string;
        description: string;
        check: string;
        action: { type: string; message?: string };
      }>
    | undefined;
  if (!hasItems(guardrails)) return '';

  const lines: string[] = ['guardrails:'];
  for (const g of guardrails) {
    lines.push(`  - name: ${yamlStr(g.name)}`);
    if (g.description) {
      lines.push(`    description: ${yamlStr(g.description)}`);
    }
    lines.push(`    check: ${yamlStr(g.check)}`);
    if (g.action) {
      lines.push(`    action: ${g.action.type}`);
      if (g.action.message) {
        lines.push(`    message: ${yamlStr(g.action.message)}`);
      }
    }
  }
  return lines.join('\n');
}

function serializeHandoff(ir: Record<string, unknown>): string {
  const coordination = ir['coordination'] as Record<string, unknown> | undefined;
  if (!coordination) return '';

  const handoffs = coordination['handoffs'] as IRHandoff[] | undefined;
  if (!hasItems(handoffs)) return '';

  const lines: string[] = ['handoff:'];
  for (const h of handoffs) {
    lines.push(`  - to: ${yamlStr(h.to)}`);
    if (h.when) {
      lines.push(`    when: ${yamlStr(h.when)}`);
    }
    if (h.context) {
      lines.push('    context:');
      if (hasItems(h.context.pass)) {
        lines.push('      pass:');
        for (const p of h.context.pass) {
          lines.push(`        - ${yamlStr(p)}`);
        }
      }
      if (h.context.summary) {
        lines.push(`      summary: ${yamlStr(h.context.summary)}`);
      }
      const memoryGrants = hasItems(h.context.memory_grants) ? h.context.memory_grants : undefined;
      if (hasItems(memoryGrants)) {
        lines.push('      memory_grants:');
        for (const grant of memoryGrants) {
          lines.push('        - path: ' + yamlStr(grant.path));
          if (grant.access && grant.access !== 'read') {
            lines.push(`          access: ${grant.access}`);
          }
        }
      }
      if (h.context.history && h.context.history !== 'none') {
        const hist = h.context.history;
        if (typeof hist === 'string') {
          lines.push(`      history: ${hist}`);
        } else if (
          typeof hist === 'object' &&
          (hist as Record<string, unknown>)['last_n'] !== undefined
        ) {
          lines.push('      history:');
          lines.push('        mode: last_n');
          lines.push(`        count: ${(hist as Record<string, unknown>)['last_n']}`);
        }
      }
    }
    if (h.return) {
      lines.push('    return: true');
    }
    if (h.on_return) {
      lines.push('    on_return:');
      if (h.on_return.action) {
        lines.push(`      action: ${yamlStr(h.on_return.action)}`);
      }
      if (h.on_return.handler) {
        lines.push(`      handler: ${yamlStr(h.on_return.handler)}`);
      }
      if (hasKeys(h.on_return.map)) {
        lines.push('      map:');
        for (const [key, value] of Object.entries(h.on_return.map)) {
          lines.push(`        ${key}: ${yamlStr(value)}`);
        }
      }
    }
  }
  return lines.join('\n');
}

function serializeReturnHandlers(ir: Record<string, unknown>): string {
  const coordination = ir['coordination'] as Record<string, unknown> | undefined;
  if (!coordination) return '';

  const returnHandlers = coordination['return_handlers'] as
    | Record<string, IRReturnHandler>
    | undefined;
  if (!hasKeys(returnHandlers)) return '';

  const lines: string[] = ['return_handlers:'];
  for (const [name, handler] of Object.entries(returnHandlers)) {
    lines.push(`  ${name}:`);
    if (handler.respond) {
      lines.push(`    respond: ${yamlStr(handler.respond)}`);
    }
    if (hasItems(handler.clear)) {
      lines.push('    clear:');
      for (const field of handler.clear) {
        lines.push(`      - ${yamlStr(field)}`);
      }
    }
    if (handler.continue !== undefined) {
      lines.push(`    continue: ${handler.continue}`);
    }
    if (handler.resume_intent !== undefined) {
      lines.push(`    resume_intent: ${handler.resume_intent}`);
    }
  }

  return lines.join('\n');
}

function serializeDelegate(ir: Record<string, unknown>): string {
  const coordination = ir['coordination'] as Record<string, unknown> | undefined;
  if (!coordination) return '';

  const delegates = coordination['delegates'] as IRDelegate[] | undefined;
  if (!hasItems(delegates)) return '';

  const lines: string[] = ['delegate:'];
  for (const d of delegates) {
    lines.push(`  - agent: ${yamlStr(d.agent)}`);
    if (d.when) {
      lines.push(`    when: ${yamlStr(d.when)}`);
    }
    if (d.purpose) {
      lines.push(`    purpose: ${yamlStr(d.purpose)}`);
    }
    if (hasKeys(d.input)) {
      lines.push('    input:');
      for (const [key, val] of Object.entries(d.input)) {
        lines.push(`      ${key}: ${yamlStr(val)}`);
      }
    }
    if (hasKeys(d.returns)) {
      lines.push('    returns:');
      for (const [key, val] of Object.entries(d.returns)) {
        lines.push(`      ${key}: ${yamlStr(val)}`);
      }
    }
    if (d.use_result) {
      lines.push(`    use_result: ${yamlStr(d.use_result)}`);
    }
    if (d.timeout) {
      lines.push(`    timeout: ${yamlStr(d.timeout)}`);
    }
    if (d.on_failure && d.on_failure !== 'continue') {
      lines.push(`    on_failure: ${d.on_failure}`);
    }
    if (d.failure_message) {
      lines.push(`    failure_message: ${yamlStr(d.failure_message)}`);
    }
  }
  return lines.join('\n');
}

function serializeEscalate(ir: Record<string, unknown>): string {
  const coordination = ir['coordination'] as Record<string, unknown> | undefined;
  if (!coordination) return '';

  const escalation = coordination['escalation'] as Record<string, unknown> | undefined;
  if (!escalation) return '';

  const triggers = escalation['triggers'] as IREscalationTrigger[] | undefined;
  if (!hasItems(triggers)) return '';

  const lines: string[] = ['escalate:'];
  lines.push('  triggers:');
  for (const t of triggers) {
    lines.push(`    - when: ${yamlStr(t.when)}`);
    lines.push(`      reason: ${yamlStr(t.reason)}`);
    lines.push(`      priority: ${t.priority}`);
    if (hasItems(t.tags)) {
      lines.push(`      tags: [${t.tags.map((tag) => yamlStr(tag)).join(', ')}]`);
    }
  }

  const contextForHuman = escalation['context_for_human'] as string[] | undefined;
  if (hasItems(contextForHuman)) {
    lines.push('  context_for_human:');
    for (const ctx of contextForHuman) {
      lines.push(`    - ${yamlStr(ctx)}`);
    }
  }

  const onHumanComplete = escalation['on_human_complete'] as
    | Array<{ condition: string; action: string }>
    | undefined;
  if (hasItems(onHumanComplete)) {
    lines.push('  on_human_complete:');
    for (const action of onHumanComplete) {
      lines.push(`    - condition: ${yamlStr(action.condition)}`);
      lines.push(`      action: ${yamlStr(action.action)}`);
    }
  }

  return lines.join('\n');
}

function serializeComplete(ir: Record<string, unknown>): string {
  const completion = ir['completion'] as Record<string, unknown> | undefined;
  if (!completion) return '';

  const conditions = completion['conditions'] as IRCompletionCondition[] | undefined;
  if (!hasItems(conditions)) return '';

  const lines: string[] = ['complete:'];
  for (const c of conditions) {
    lines.push(`  - when: ${yamlStr(c.when)}`);
    if (c.respond) {
      lines.push(`    respond: ${yamlStr(c.respond)}`);
    }
    serializeStructuredResponsePayload(lines, '    ', c);
    if (c.store) {
      lines.push(`    store: ${yamlStr(c.store)}`);
    }
  }
  return lines.join('\n');
}

function serializeOnError(ir: Record<string, unknown>): string {
  const errorHandling = ir['error_handling'] as Record<string, unknown> | undefined;
  if (!errorHandling) return '';

  const handlers = errorHandling['handlers'] as IRErrorHandler[] | undefined;
  const defaultHandler = errorHandling['default_handler'] as IRErrorHandler | undefined;
  const allHandlers = [...(handlers ?? []), ...(defaultHandler ? [defaultHandler] : [])];
  if (!hasItems(allHandlers)) return '';

  const lines: string[] = ['on_error:'];
  for (const h of allHandlers) {
    lines.push(`  - type: ${yamlStr(h.type)}`);
    if (hasItems(h.subtypes)) {
      lines.push('    subtypes:');
      for (const subtype of h.subtypes) {
        lines.push(`      - ${yamlStr(subtype)}`);
      }
    }
    if (h.respond) {
      lines.push(`    respond: ${yamlStr(h.respond)}`);
    }
    serializeStructuredResponsePayload(lines, '    ', h);
    if (h.retry !== undefined) {
      lines.push(`    retry: ${h.retry}`);
    }
    if (h.retry_delay_ms !== undefined) {
      lines.push(`    retry_delay: ${h.retry_delay_ms}`);
    }
    if (h.retry_backoff) {
      lines.push(`    retry_backoff: ${yamlStr(h.retry_backoff)}`);
    }
    if (h.retry_max_delay_ms !== undefined) {
      lines.push(`    retry_max_delay: ${h.retry_max_delay_ms}`);
    }
    if (h.backtrack_to) {
      lines.push(`    backtrack_to: ${yamlStr(h.backtrack_to)}`);
    }
    const thenValue =
      h.then === 'handoff' && h.handoff_target ? `handoff ${h.handoff_target}` : h.then;
    if (thenValue && thenValue !== 'continue') {
      lines.push(`    then: ${yamlStr(thenValue)}`);
    }
  }
  return lines.join('\n');
}

function serializeOnStart(ir: Record<string, unknown>): string {
  const onStart = ir['on_start'] as Record<string, unknown> | undefined;
  if (!onStart) return '';

  const respond = onStart['respond'] as string | undefined;
  const voiceConfig = onStart['voice_config'] as Record<string, unknown> | undefined;
  const richContent = onStart['rich_content'] as Record<string, unknown> | undefined;
  const actions = onStart['actions'] as IRActionSet | undefined;
  const call = onStart['call'] as string | undefined;
  const callSpec = onStart['call_spec'] as IRToolInvocation | undefined;
  const set = onStart['set'] as Record<string, unknown> | undefined;
  const delegate = onStart['delegate'] as string | undefined;

  if (
    !respond &&
    !voiceConfig &&
    !richContent &&
    !actions &&
    !call &&
    !callSpec &&
    !hasKeys(set) &&
    !delegate
  )
    return '';

  const lines: string[] = ['on_start:'];
  if (respond) {
    lines.push(`  respond: ${yamlStr(respond)}`);
  }
  serializeStructuredResponsePayload(lines, '  ', {
    voice_config: voiceConfig,
    rich_content: richContent,
    actions,
  });
  serializeCallSpec(lines, '  ', call, callSpec);
  if (hasKeys(set)) {
    lines.push('  set:');
    for (const [key, val] of Object.entries(set)) {
      lines.push(`    ${key}: ${yamlStr(String(val))}`);
    }
  }
  if (delegate) {
    lines.push(`  delegate: ${yamlStr(delegate)}`);
  }
  return lines.join('\n');
}

function serializeHooks(ir: Record<string, unknown>): string {
  const hooks = ir['hooks'] as Record<string, IRHookAction | undefined> | undefined;
  if (!hooks) return '';

  const hookKeys = ['before_agent', 'after_agent', 'before_turn', 'after_turn'] as const;
  const lines: string[] = [];

  for (const hookKey of hookKeys) {
    const hook = hooks[hookKey];
    if (!hook) continue;

    if (lines.length === 0) {
      lines.push('hooks:');
    }

    lines.push(`  ${hookKey}:`);
    serializeCallSpec(lines, '    ', hook.call, hook.call_spec);
    if (hasKeys(hook.set)) {
      lines.push('    set:');
      for (const [key, value] of Object.entries(hook.set)) {
        lines.push(`      ${key}: ${yamlStr(String(value))}`);
      }
    }
    if (hook.respond) {
      lines.push(`    respond: ${yamlStr(hook.respond)}`);
    }
    serializeStructuredResponsePayload(lines, '    ', hook);
    if (hook.critical === true) {
      lines.push('    critical: true');
    }
  }

  return lines.join('\n');
}

function serializeExecution(ir: Record<string, unknown>): string {
  const execution = ir['execution'] as Record<string, unknown> | undefined;
  if (!execution) return '';

  const model = execution['model'] as string | undefined;
  const temperature = execution['temperature'] as number | undefined;
  const maxTokens = execution['max_tokens'] as number | undefined;
  const maxIterations = execution['max_iterations'] as number | undefined;
  const maxFlowIterations = execution['max_flow_iterations'] as number | undefined;
  const fallbackModel = execution['fallback_model'] as string | undefined;
  const reasoningEffort = execution['reasoning_effort'] as string | undefined;

  // Only serialize if there are user-facing config values
  if (
    model === undefined &&
    temperature === undefined &&
    maxTokens === undefined &&
    maxIterations === undefined &&
    maxFlowIterations === undefined &&
    fallbackModel === undefined &&
    reasoningEffort === undefined
  ) {
    return '';
  }

  const lines: string[] = ['execution:'];
  if (model) {
    lines.push(`  model: ${yamlStr(model)}`);
  }
  if (temperature !== undefined) {
    lines.push(`  temperature: ${temperature}`);
  }
  if (maxTokens !== undefined) {
    lines.push(`  max_tokens: ${maxTokens}`);
  }
  if (maxIterations !== undefined) {
    lines.push(`  max_reasoning_iterations: ${maxIterations}`);
  }
  if (maxFlowIterations !== undefined) {
    lines.push(`  max_flow_iterations: ${maxFlowIterations}`);
  }
  if (fallbackModel) {
    lines.push(`  fallback_model: ${yamlStr(fallbackModel)}`);
  }
  if (reasoningEffort) {
    lines.push(`  reasoning_effort: ${reasoningEffort}`);
  }
  return lines.join('\n');
}

function serializeTemplates(ir: Record<string, unknown>): string {
  const templates = ir['templates'] as Record<string, string> | undefined;
  if (!hasKeys(templates)) return '';

  const lines: string[] = ['templates:'];
  for (const [name, content] of Object.entries(templates)) {
    lines.push(`  - name: ${yamlStr(name)}`);
    lines.push(`    content: ${yamlStr(content)}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Main Export
// ---------------------------------------------------------------------------

/**
 * Convert an AgentIR to canonical YAML ABL format.
 *
 * The `ir` parameter is typed as `Record<string, unknown>` to avoid importing
 * AgentIR from the compiler package (which has server-only dependencies).
 * Pass a compiled AgentIR object directly — its shape is duck-typed internally.
 */
export function serializeToYAML(ir: Record<string, unknown>): string {
  const sections: string[] = [];

  // --- Header: agent name ---
  const metadata = ir['metadata'] as Record<string, unknown> | undefined;
  const agentType = metadata?.['type'] as string | undefined;
  const agentName = metadata?.['name'] as string | undefined;

  if (agentType === 'supervisor') {
    sections.push(`supervisor: ${yamlStr(agentName || 'unnamed')}`);
  } else {
    sections.push(`agent: ${yamlStr(agentName || 'unnamed')}`);
  }

  // --- Goal ---
  const identity = ir['identity'] as Record<string, unknown> | undefined;
  const goal = identity?.['goal'] as string | undefined;
  if (goal) {
    sections.push(`\ngoal: ${yamlStr(goal)}`);
  }

  // --- Identity (persona + limitations) ---
  const identitySection = serializeIdentity(ir);
  if (identitySection) {
    sections.push(`\n${identitySection}`);
  }

  // --- Execution config ---
  const executionSection = serializeExecution(ir);
  if (executionSection) {
    sections.push(`\n${executionSection}`);
  }

  // --- Tools ---
  const toolsSection = serializeTools(ir);
  if (toolsSection) {
    sections.push(`\n${toolsSection}`);
  }

  // --- Flow (scripted mode) ---
  const flowSection = serializeFlow(ir);
  if (flowSection) {
    sections.push(`\n${flowSection}`);
  }

  // --- Action handlers ---
  const actionHandlersSection = serializeActionHandlers(ir);
  if (actionHandlersSection) {
    sections.push(`\n${actionHandlersSection}`);
  }

  // --- Gather ---
  const gatherSection = serializeGather(ir);
  if (gatherSection) {
    sections.push(`\n${gatherSection}`);
  }

  // --- Memory ---
  const memorySection = serializeMemory(ir);
  if (memorySection) {
    sections.push(`\n${memorySection}`);
  }

  // --- Constraints ---
  const constraintsSection = serializeConstraints(ir);
  if (constraintsSection) {
    sections.push(`\n${constraintsSection}`);
  }

  // --- Guardrails ---
  const guardrailsSection = serializeGuardrails(ir);
  if (guardrailsSection) {
    sections.push(`\n${guardrailsSection}`);
  }

  // --- Handoff ---
  const returnHandlersSection = serializeReturnHandlers(ir);
  if (returnHandlersSection) {
    sections.push(`\n${returnHandlersSection}`);
  }

  // --- Handoff ---
  const handoffSection = serializeHandoff(ir);
  if (handoffSection) {
    sections.push(`\n${handoffSection}`);
  }

  // --- Delegate ---
  const delegateSection = serializeDelegate(ir);
  if (delegateSection) {
    sections.push(`\n${delegateSection}`);
  }

  // --- Escalate ---
  const escalateSection = serializeEscalate(ir);
  if (escalateSection) {
    sections.push(`\n${escalateSection}`);
  }

  // --- Complete ---
  const completeSection = serializeComplete(ir);
  if (completeSection) {
    sections.push(`\n${completeSection}`);
  }

  // --- On Error ---
  const onErrorSection = serializeOnError(ir);
  if (onErrorSection) {
    sections.push(`\n${onErrorSection}`);
  }

  // --- On Start ---
  const onStartSection = serializeOnStart(ir);
  if (onStartSection) {
    sections.push(`\n${onStartSection}`);
  }

  // --- Hooks ---
  const hooksSection = serializeHooks(ir);
  if (hooksSection) {
    sections.push(`\n${hooksSection}`);
  }

  // --- Templates ---
  const templatesSection = serializeTemplates(ir);
  if (templatesSection) {
    sections.push(`\n${templatesSection}`);
  }

  return sections.join('\n') + '\n';
}
