/**
 * YAML Parser for Agent-Based ABL
 *
 * Parses YAML-format ABL files into the same AgentBasedDocument AST
 * as the legacy Chevrotain-based parser. Both parser paths produce
 * identical types that feed into compileABLtoIR().
 */

import * as yaml from 'js-yaml';

import type {
  AgentBasedDocument,
  ExecutionConfigAST,
  AgentGoal,
  AgentPersona,
  AgentLimitation,
  AgentTool,
  CompactionPolicyOverrideAST,
  ToolParam,
  ToolReturn,
  ToolCompactionConfigAST,
  GatherField,
  MemoryConfig,
  ConstraintPhase,
  ConstraintRequirement,
  ConstraintAction,
  DelegateConfig,
  HandoffConfig,
  HandoffContext,
  HandoffHistoryConfig,
  HandoffHistoryConfigObject,
  HandoffHistoryMode,
  HandoffOnReturnConfig,
  ReturnHandlerDefinition,
  EscalateConfig,
  EscalateTrigger,
  EscalateContextItem,
  OnHumanCompleteAction,
  CompleteCondition,
  ErrorHandler,
  StartHandler,
  HooksConfig,
  HookAction,
  AgentMessages,
  TemplateDefinition,
  GuardrailDefinition,
  FlowDefinition,
  FlowStep,
  FlowGatherConfig,
  FlowGatherField,
  SetAssignment,
  CallResultBranchAST,
  RichContentAST,
  ToolInvocationAST,
  ActionElementAST,
  ActionHandlerAST,
  ActionHandlerActionAST,
  ActionSetAST,
  VoiceConfigAST,
  DigressionOnReturnAST,
  Digression,
  SubIntent,
  ConversationBehaviorAST,
  ConversationSpeakingAST,
  ConversationListeningAST,
  ConversationInteractionAST,
} from '../types/agent-based.js';
import type { DocumentMeta, Version } from '../types/base.js';
import { parseConstraintBeforeTarget } from './constraint-before.js';

// =============================================================================
// PARSE RESULT
// =============================================================================

export interface YamlParseError {
  line: number;
  column: number;
  message: string;
}

export interface YamlParseWarning {
  line: number;
  message: string;
}

export interface YamlParseResult {
  document: AgentBasedDocument | null;
  errors: YamlParseError[];
  warnings: YamlParseWarning[];
}

// =============================================================================
// FORMAT DETECTION
// =============================================================================

/**
 * Detect whether content is YAML-format ABL (lowercase keys like `agent:`, `mode:`)
 * vs legacy ABL format (uppercase keys like `AGENT:`, `MODE:`).
 *
 * Heuristic: scan the first non-empty, non-comment lines for lowercase
 * top-level keys that are valid YAML ABL keys.
 */
export function isYamlFormat(content: string): boolean {
  if (typeof content !== 'string') return false;
  const lines = content.split('\n');
  const yamlTopLevelKeys = new Set([
    'agent',
    'supervisor',
    'mode',
    'goal',
    'persona',
    'identity',
    'tools',
    'gather',
    'constraints',
    'guardrails',
    'flow',
    'handoff',
    'return_handlers',
    'delegate',
    'escalate',
    'complete',
    'on_error',
    'on_start',
    'memory',
    'execution',
    'language',
    'version',
    'description',
    'limitations',
    'messages',
    'templates',
    'hooks',
    'system_prompt',
    'nlu',
    'conversation',
    'action_handlers',
  ]);

  for (const line of lines) {
    const trimmed = line.trim();
    // Skip empty lines, comments
    if (
      !trimmed ||
      trimmed.startsWith('#') ||
      trimmed.startsWith('//') ||
      trimmed.startsWith('/*')
    ) {
      continue;
    }
    // Check if the first non-empty, non-comment line has a lowercase key
    const keyMatch = trimmed.match(/^([a-z_]+)\s*:/);
    if (keyMatch && yamlTopLevelKeys.has(keyMatch[1])) {
      return true;
    }
    // If we hit an uppercase key, it is legacy format
    const upperKeyMatch = trimmed.match(/^([A-Z_]+)\s*:/);
    if (upperKeyMatch) {
      return false;
    }
    // If it doesn't look like either, skip (could be a YAML comment with ---)
    if (trimmed === '---') {
      continue;
    }
    break;
  }
  return false;
}

// =============================================================================
// MAIN PARSER
// =============================================================================

/**
 * Parse YAML-format ABL content into an AgentBasedDocument AST.
 *
 * The YAML format uses lowercase keys and standard YAML syntax.
 * This function produces the exact same AST type as `parseAgentBasedABL`.
 */
export function parseYamlABL(content: string): YamlParseResult {
  const errors: YamlParseError[] = [];
  const warnings: YamlParseWarning[] = [];

  if (typeof content !== 'string') {
    errors.push({
      line: 1,
      column: 1,
      message: `Cannot parse non-string YAML ABL source (received ${content === null ? 'null' : typeof content}).`,
    });
    return { document: null, errors, warnings };
  }

  // Parse raw YAML
  let raw: unknown;
  try {
    raw = yaml.load(content);
  } catch (e) {
    const yamlError = e as yaml.YAMLException;
    errors.push({
      line: yamlError.mark?.line ?? 0,
      column: yamlError.mark?.column ?? 0,
      message: yamlError.message || 'Invalid YAML syntax',
    });
    return { document: null, errors, warnings };
  }

  if (!raw || typeof raw !== 'object') {
    errors.push({
      line: 0,
      column: 0,
      message: 'YAML content must be an object with agent definition keys',
    });
    return { document: null, errors, warnings };
  }

  const data = raw as Record<string, unknown>;

  // Determine agent name
  const agentName = asDocumentName(data['agent'] ?? data['supervisor']);
  if (!agentName) {
    errors.push({
      line: 0,
      column: 0,
      message: 'Missing required field: "agent" (agent name)',
    });
    return { document: null, errors, warnings };
  }

  // Determine document kind
  const isSupervisor = data['supervisor'] !== undefined && data['agent'] === undefined;

  // MODE is deprecated — emit error if present
  const modeStr = asString(data['mode']);
  if (modeStr) {
    errors.push({
      line: 0,
      column: 0,
      message:
        'MODE is no longer supported. Execution style is declared per-step with REASONING: true/false. Remove the mode: field.',
    });
  }

  const now = new Date();
  const meta: DocumentMeta = {
    id: crypto.randomUUID(),
    kind: isSupervisor ? 'supervisor' : 'agent-based',
    version: (asString(data['version']) || '1.0.0') as Version,
    name: agentName,
    description: asString(data['description']),
    createdAt: now,
    updatedAt: now,
  };

  // Build document
  const doc: AgentBasedDocument = {
    meta,
    name: agentName,
    goal: parseGoal(data['goal']),
    persona: parsePersona(data['persona']),
    limitations: parseLimitations(data['limitations']),
    tools: parseTools(data['tools'], warnings),
    gather: parseGather(data['gather']),
    memory: parseMemory(data['memory'], errors),
    constraints: parseConstraints(data['constraints']),
    delegate: parseDelegate(data['delegate']),
    handoff: parseHandoff(data['handoff'], errors),
    returnHandlers: parseReturnHandlers(data['return_handlers']),
    actionHandlers: parseActionHandlers(data['action_handlers']),
    complete: parseComplete(data['complete']),
    onError: parseOnError(data['on_error']),
    flow: parseFlow(data['flow']),
  };

  // Optional fields
  if (data['language']) {
    doc.language = asString(data['language']);
  }
  if (data['execution']) {
    doc.execution = parseExecution(data['execution']);
  }
  if (data['escalate']) {
    doc.escalate = parseEscalate(data['escalate'], warnings);
  }
  if (data['on_start']) {
    doc.onStart = parseOnStart(data['on_start']);
  }
  if (data['hooks']) {
    doc.hooks = parseHooks(data['hooks']);
  }
  if (data['messages']) {
    doc.messages = parseMessages(data['messages']);
  }
  if (data['conversation']) {
    const conversationResult = parseConversationBehaviorData(data['conversation']);
    if (conversationResult.conversation) {
      doc.conversation = conversationResult.conversation;
    }
    for (const message of conversationResult.errors) {
      errors.push({
        line: 0,
        column: 0,
        message,
      });
    }
  }
  if (data['templates']) {
    doc.templates = parseTemplates(data['templates']);
  }
  if (data['guardrails']) {
    doc.guardrails = parseGuardrails(data['guardrails']);
  }
  if (data['system_prompt']) {
    doc.systemPrompt = asString(data['system_prompt']);
  }

  // Handle identity section (maps to goal, persona, limitations)
  if (data['identity']) {
    const identity = data['identity'] as Record<string, unknown>;
    if (identity['role']) {
      doc.goal = { description: asString(identity['role']) || '' };
    }
    if (identity['persona']) {
      doc.persona = { description: asString(identity['persona']) || '' };
    }
    if (identity['expertise'] && Array.isArray(identity['expertise'])) {
      if (doc.persona.description) {
        doc.persona.description += ` Expertise: ${(identity['expertise'] as string[]).join(', ')}`;
      }
    }
    if (identity['limitations'] && Array.isArray(identity['limitations'])) {
      doc.limitations = (identity['limitations'] as string[]).map((l) => ({
        description: l,
      }));
    }
  }

  return { document: doc, errors, warnings };
}

// =============================================================================
// SECTION PARSERS
// =============================================================================

function parseGoal(raw: unknown): AgentGoal {
  if (!raw) return { description: '' };
  if (typeof raw === 'string') return { description: raw };
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return {
      description: asString(obj['description']) || '',
      measurable: obj['measurable'] === true ? true : undefined,
    };
  }
  return { description: String(raw) };
}

function parsePersona(raw: unknown): AgentPersona {
  if (!raw) return { description: '' };
  if (typeof raw === 'string') return { description: raw };
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    return { description: asString(obj['description']) || '' };
  }
  return { description: String(raw) };
}

function parseLimitations(raw: unknown): AgentLimitation[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => ({
    description:
      typeof item === 'string'
        ? item
        : asString((item as Record<string, unknown>)['description']) || '',
  }));
}

function parseTools(raw: unknown, warnings: YamlParseWarning[]): AgentTool[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => parseSingleTool(item as Record<string, unknown>, warnings));
}

function parseSingleTool(raw: Record<string, unknown>, warnings: YamlParseWarning[]): AgentTool {
  const tool: AgentTool = {
    name: asString(raw['name']) || '',
    description: asString(raw['description']),
    parameters: parseToolParams(raw['parameters']),
    returns: parseToolReturn(raw['returns']),
  };

  if (raw['type']) {
    const toolType = asString(raw['type']);
    if (
      toolType === 'http' ||
      toolType === 'mcp' ||
      toolType === 'lambda' ||
      toolType === 'sandbox'
    ) {
      tool.type = toolType;
    } else {
      warnings.push({
        line: 0,
        message: `Unknown tool type "${toolType}" for tool "${tool.name}"`,
      });
    }
  }

  if (raw['hints'] && typeof raw['hints'] === 'object') {
    const h = raw['hints'] as Record<string, unknown>;
    tool.hints = {
      cacheable: h['cacheable'] === true ? true : undefined,
      latency: asString(h['latency']) as 'fast' | 'medium' | 'slow' | undefined,
      side_effects: h['side_effects'] === true ? true : undefined,
      requires_auth: h['requires_auth'] === true ? true : undefined,
      timeout: typeof h['timeout'] === 'number' ? h['timeout'] : undefined,
    };
  }

  const compaction = parseToolCompaction(raw['compaction']);
  if (compaction) {
    tool.compaction = compaction;
  }

  // HTTP binding
  if (raw['http_binding'] && typeof raw['http_binding'] === 'object') {
    const hb = raw['http_binding'] as Record<string, unknown>;
    tool.httpBinding = {
      endpoint: asString(hb['endpoint']) || '',
      method: (asString(hb['method'])?.toUpperCase() || 'GET') as
        | 'GET'
        | 'POST'
        | 'PUT'
        | 'PATCH'
        | 'DELETE',
      timeout: typeof hb['timeout'] === 'number' ? hb['timeout'] : undefined,
      retry: typeof hb['retry'] === 'number' ? hb['retry'] : undefined,
    };
  }

  // MCP binding
  if (raw['mcp_binding'] && typeof raw['mcp_binding'] === 'object') {
    const mb = raw['mcp_binding'] as Record<string, unknown>;
    const mcpHeaders =
      mb['headers'] && typeof mb['headers'] === 'object'
        ? (mb['headers'] as Record<string, string>)
        : undefined;
    tool.mcpBinding = {
      server: asString(mb['server']) || '',
      tool: asString(mb['tool']),
      ...(mcpHeaders && Object.keys(mcpHeaders).length > 0 ? { headers: mcpHeaders } : {}),
    };
  }

  return tool;
}

function parseToolCompaction(raw: unknown): ToolCompactionConfigAST | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const compaction: ToolCompactionConfigAST = {
    essential_fields: asStringArray(readYamlField(obj, 'essentialFields', 'essential_fields')),
    max_description_length: asNumber(
      readYamlField(obj, 'maxDescriptionLength', 'max_description_length'),
    ),
  };

  return Object.values(compaction).some((value) => value !== undefined) ? compaction : undefined;
}

function parseToolParams(raw: unknown): ToolParam[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const p = item as Record<string, unknown>;
    return {
      name: asString(p['name']) || '',
      type: asString(p['type']) || 'string',
      required: p['required'] !== false,
      default: p['default'],
      description: asString(p['description']),
      validate: asString(p['validate']),
    };
  });
}

function parseToolReturn(raw: unknown): ToolReturn {
  if (!raw) return { type: 'void' };
  if (typeof raw === 'string') return { type: raw };
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const ret: ToolReturn = {
      type: asString(obj['type']) || 'object',
    };
    if (obj['fields'] && typeof obj['fields'] === 'object') {
      ret.fields = {};
      for (const [key, val] of Object.entries(obj['fields'] as Record<string, unknown>)) {
        ret.fields[key] = parseToolReturn(val);
      }
    }
    if (obj['items']) {
      ret.items = parseToolReturn(obj['items']);
    }
    if (obj['optional'] === true) {
      ret.optional = true;
    }
    return ret;
  }
  return { type: 'void' };
}

function parseGather(raw: unknown): GatherField[] {
  if (!raw) return [];
  // Support both { fields: [...] } and direct array
  let fieldsArray: unknown[];
  if (Array.isArray(raw)) {
    fieldsArray = raw;
  } else if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    if (Array.isArray(obj['fields'])) {
      fieldsArray = obj['fields'];
    } else {
      return [];
    }
  } else {
    return [];
  }

  return fieldsArray.map((item) => {
    const f = item as Record<string, unknown>;
    const field: GatherField = {
      name: asString(f['name']) || '',
      prompt: asString(f['prompt']) || '',
      type: asString(f['type']) || 'string',
      required: f['required'] !== false,
    };
    if (f['message_key'] !== undefined) field.messageKey = asString(f['message_key']);
    if (f['default'] !== undefined) field.default = f['default'];
    if (f['validate']) field.validate = asString(f['validate']);
    if (f['infer'] !== undefined) field.infer = f['infer'] === true;
    if (f['range'] === true) field.range = true;
    if (f['list'] === true) field.list = true;
    if (f['preferences'] === true) field.preferences = true;
    if (f['depends_on'] && Array.isArray(f['depends_on'])) {
      field.dependsOn = f['depends_on'] as string[];
    }
    if (f['prompt_mode']) {
      field.promptMode = asString(f['prompt_mode']) as 'ask' | 'extract_only';
    }
    if (f['validation_process']) {
      field.validationProcess = asString(f['validation_process'])?.toUpperCase() as
        | 'REGEX'
        | 'CODE'
        | 'LLM';
    }
    if (f['retry_prompt']) field.retryPrompt = asString(f['retry_prompt']);
    if (typeof f['max_retries'] === 'number') field.maxRetries = f['max_retries'];
    return field;
  });
}

function parseMemory(raw: unknown, errors: YamlParseError[]): MemoryConfig {
  const defaultMemory: MemoryConfig = {
    session: [],
    persistent: [],
    remember: [],
    recall: [],
  };
  if (!raw || typeof raw !== 'object') return defaultMemory;
  const obj = raw as Record<string, unknown>;

  if (Array.isArray(obj['session'])) {
    defaultMemory.session = obj['session'].map((s) => {
      if (typeof s === 'string') return { name: s };
      const sv = s as Record<string, unknown>;
      return {
        name: asString(sv['name']) || '',
        description: asString(sv['description']),
        initial_value: sv['initial_value'],
      };
    });
  }
  if (Array.isArray(obj['persistent'])) {
    defaultMemory.persistent = obj['persistent'].map((p) => {
      if (typeof p === 'string') return { path: p };
      const pv = p as Record<string, unknown>;
      return {
        path: asString(pv['path']) || '',
        description: asString(pv['description']),
        scope: asString(pv['scope']) as 'user' | 'project' | 'execution_tree' | undefined,
        access: asString(pv['access']) as 'read' | 'write' | 'readwrite' | undefined,
        type: asString(pv['type']) as
          | 'string'
          | 'number'
          | 'boolean'
          | 'date'
          | 'array'
          | 'object'
          | undefined,
        unit: asString(pv['unit']),
        defaultValue: pv['default_value'],
      };
    });
  }
  if (Array.isArray(obj['remember'])) {
    defaultMemory.remember = obj['remember'].map((r) => {
      const rv = r as Record<string, unknown>;
      const store = rv['store'] as Record<string, unknown> | undefined;
      return {
        when: asString(rv['when']) || '',
        store: {
          value: asString(store?.['value']) || '',
          target: asString(store?.['target']) || '',
        },
        ttl: asString(rv['ttl']),
      };
    });
  }
  if (Array.isArray(obj['recall'])) {
    defaultMemory.recall = obj['recall'].map((r) => {
      const rv = r as Record<string, unknown>;
      const event = asString(rv['event']) || '';
      if (isLegacyRecallEvent(event)) {
        errors.push({
          line: 0,
          column: 0,
          message: buildLegacyRecallEventError(event),
        });
      }
      return {
        event,
        instruction: asString(rv['instruction']) || '',
      };
    });
  }

  return defaultMemory;
}

function parseConstraints(raw: unknown): ConstraintPhase[] {
  if (!raw || !Array.isArray(raw)) return [];

  // YAML constraints can be flat (list of { condition, on_fail }) or phased
  // If the items have a "name" + "requirements" shape, they are phases.
  // Otherwise, wrap them in a default "always" phase.
  const firstItem = raw[0] as Record<string, unknown> | undefined;
  if (firstItem && firstItem['requirements']) {
    // Phased constraints
    return raw.map((phase) => {
      const p = phase as Record<string, unknown>;
      return {
        name: asString(p['name']) || 'always',
        requirements: parseConstraintRequirements(p['requirements']),
      };
    });
  }

  // Flat constraints — wrap in an "always" phase
  return [
    {
      name: 'always',
      requirements: parseConstraintRequirements(raw),
    },
  ];
}

function parseConstraintRequirements(raw: unknown): ConstraintRequirement[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const r = item as Record<string, unknown>;
    const req: ConstraintRequirement = {
      condition: asString(r['condition']) || '',
      onFail: parseOnFailValue(r['on_fail']),
    };
    const kind = asString(r['kind'])?.toLowerCase();
    if (kind === 'require' || kind === 'limit' || kind === 'restrict') {
      req.kind = kind;
    }
    const when = asString(r['when']);
    if (when) {
      req.when = when;
    }
    const before = parseConstraintBeforeValue(r['before']);
    if (before) {
      req.before = before;
    }
    const severity = asString(r['severity'])?.toLowerCase();
    if (severity === 'error' || severity === 'warning') {
      req.severity = severity;
    }
    return req;
  });
}

function parseConstraintBeforeValue(raw: unknown): ConstraintRequirement['before'] {
  if (!raw) return undefined;
  if (typeof raw === 'string') {
    return parseConstraintBeforeTarget(raw);
  }
  if (typeof raw !== 'object') {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const rawText = asString(obj['raw']);
  const kind = asString(obj['kind'])?.toLowerCase();
  const target = asString(obj['target']);

  switch (kind) {
    case 'tool_call':
      if (!target) return undefined;
      return {
        kind: 'tool_call',
        target,
        raw: rawText || `calling ${target}`,
      };
    case 'respond':
      return {
        kind: 'respond',
        raw: rawText || 'returning results',
      };
    default:
      if (rawText) {
        return {
          kind: 'unsupported',
          raw: rawText,
          ...(target ? { target } : {}),
        };
      }
      return undefined;
  }
}

function parseOnFailValue(raw: unknown): string | ConstraintAction {
  if (!raw) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const action = asString(obj['action']);
    switch (action) {
      case 'respond':
        return { type: 'respond', message: asString(obj['message']) || '' };
      case 'escalate':
        return { type: 'escalate', reason: asString(obj['reason']) };
      case 'handoff':
        return { type: 'handoff', target: asString(obj['target']) || '' };
      case 'block':
        return { type: 'block' };
      case 'collect_field':
        return {
          type: 'collect_field',
          collectFields: Array.isArray(obj['collect_fields'])
            ? (obj['collect_fields'] as string[])
            : [],
          thenAction: asString(obj['then']) as 'continue' | 'retry' | undefined,
        };
      case 'goto_step':
        return {
          type: 'goto_step',
          thenStep: asString(obj['step']) || '',
          respond: asString(obj['respond']),
        };
      case 'retry_step':
        return { type: 'retry_step' };
      default:
        // Treat as a respond with message
        if (obj['message']) {
          return { type: 'respond', message: asString(obj['message']) || '' };
        }
        return asString(raw) || '';
    }
  }
  return String(raw);
}

function parseDelegate(raw: unknown): DelegateConfig[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const d = item as Record<string, unknown>;
    return {
      agent: asString(d['agent']) || '',
      when: asString(d['when']) || '',
      purpose: asString(d['purpose']) || '',
      input: asStringRecord(d['input']),
      returns: asStringRecord(d['returns']),
      useResult: asString(d['use_result']) || '',
      timeout: asString(d['timeout']),
    };
  });
}

function parseHandoff(raw: unknown, errors: YamlParseError[]): HandoffConfig[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const h = item as Record<string, unknown>;
    const onReturn = h['on_return'];
    const onReturnObject =
      typeof onReturn === 'object' && onReturn !== null
        ? (onReturn as Record<string, unknown>)
        : undefined;
    return {
      to: asString(h['to']) || '',
      when: asString(h['when']) || '',
      priority: typeof h['priority'] === 'number' ? h['priority'] : undefined,
      context: parseHandoffContext(h['context'], errors),
      return: h['return'] === true,
      onReturn: parseYamlHandoffOnReturn(onReturn, h['on_return_map'], errors),
    };
  });
}

function parseReturnHandlers(raw: unknown): Record<string, ReturnHandlerDefinition> | undefined {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const handlers: Record<string, ReturnHandlerDefinition> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      continue;
    }
    const handler = value as Record<string, unknown>;
    handlers[name] = {
      respond: asString(handler['respond']),
      clear: Array.isArray(handler['clear']) ? (handler['clear'] as string[]) : undefined,
      continue: typeof handler['continue'] === 'boolean' ? handler['continue'] : undefined,
      resumeIntent:
        typeof handler['resume_intent'] === 'boolean' ? handler['resume_intent'] : undefined,
    };
  }

  return Object.keys(handlers).length > 0 ? handlers : undefined;
}

function parseHandoffContext(raw: unknown, errors: YamlParseError[]): HandoffContext {
  if (!raw || typeof raw !== 'object') {
    return { pass: [], summary: '' };
  }
  const obj = raw as Record<string, unknown>;
  if (Array.isArray(obj['grant_memory'])) {
    errors.push({
      line: 0,
      column: 0,
      message:
        'Legacy handoff context grant_memory is no longer supported. Use memory_grants with explicit path/access entries.',
    });
  }
  return {
    pass: Array.isArray(obj['pass']) ? (obj['pass'] as string[]) : [],
    summary: asString(obj['summary']) || '',
    memoryGrants: Array.isArray(obj['memory_grants'])
      ? (obj['memory_grants'] as Array<Record<string, unknown>>).map((grant) => ({
          path: asString(grant['path']) || '',
          access: asString(grant['access']) as 'read' | 'readwrite' | undefined,
        }))
      : undefined,
    history: parseHandoffHistory(obj['history'], errors),
  };
}

function parseHandoffHistory(
  raw: unknown,
  errors: YamlParseError[],
): HandoffHistoryConfig | undefined {
  const validModes = new Set<HandoffHistoryMode>([
    'auto',
    'none',
    'summary_only',
    'full',
    'last_n',
  ]);

  if (typeof raw === 'string') {
    return raw as HandoffHistoryConfig;
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const mode = asString(obj['mode'])?.trim().toLowerCase() as HandoffHistoryMode | undefined;
  const count = typeof obj['count'] === 'number' ? obj['count'] : undefined;

  if (!mode) {
    errors.push({
      line: 0,
      column: 0,
      message:
        'Handoff history object requires a mode. Use a scalar history value or an object with mode/count.',
    });
    return undefined;
  }

  if (!validModes.has(mode)) {
    errors.push({
      line: 0,
      column: 0,
      message: `Unsupported handoff history mode "${mode}". Use auto, none, summary_only, full, or last_n.`,
    });
    return undefined;
  }

  const result: HandoffHistoryConfigObject = { mode };
  if (count !== undefined) {
    result.count = count;
  }

  if (mode === 'last_n' && count === undefined) {
    errors.push({
      line: 0,
      column: 0,
      message: 'Handoff history mode "last_n" requires count.',
    });
  }

  return result;
}

const RECALL_EVENT_ALIASES: Record<string, string> = {
  ON_START: 'session:start',
  ON_END: 'session:end',
  session_start: 'session:start',
  session_end: 'session:end',
  agent_enter: 'agent:*:after',
  agent_exit: 'agent:*:after',
  delegate_complete: 'agent:*:after',
};

function isLegacyRecallEvent(event: string): boolean {
  return Object.prototype.hasOwnProperty.call(RECALL_EVENT_ALIASES, event);
}

function buildLegacyRecallEventError(event: string): string {
  const canonical = RECALL_EVENT_ALIASES[event];
  if (canonical?.includes(':')) {
    return `Legacy RECALL event "${event}" is no longer supported. Use "event: ${canonical}" instead.`;
  }

  return `Legacy RECALL event "${event}" is no longer supported. Use canonical lifecycle events such as "session:start", "agent:<name>:after", or "tool:<name>:after".`;
}

function parseYamlHandoffOnReturn(
  raw: unknown,
  legacyMapRaw: unknown,
  errors: YamlParseError[],
): HandoffConfig['onReturn'] {
  if (typeof raw === 'string') {
    return raw;
  }

  if (legacyMapRaw != null) {
    errors.push({
      line: 0,
      column: 0,
      message:
        'Legacy handoff on_return_map is no longer supported. Move the map entries under on_return.map.',
    });
  }

  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return undefined;
  }

  const obj = raw as Record<string, unknown>;
  const result: HandoffOnReturnConfig = {};
  const action = asString(obj['action']);
  const handler = asString(obj['handler']);
  const map = obj['map'] != null ? (obj['map'] as Record<string, string>) : undefined;

  if (action) {
    result.action = action;
  }
  if (handler) {
    result.handler = handler;
  }
  if (map) {
    result.map = map;
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseEscalate(raw: unknown, warnings: YamlParseWarning[]): EscalateConfig | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    triggers: parseEscalateTriggers(obj['triggers'], warnings),
    contextForHuman: parseEscalateContext(obj['context_for_human']),
    onHumanComplete: parseOnHumanComplete(obj['on_human_complete']),
  };
}

function parseEscalateTriggers(raw: unknown, warnings: YamlParseWarning[]): EscalateTrigger[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const t = item as Record<string, unknown>;
    let priority: EscalateTrigger['priority'] = 'medium';
    if (typeof t['priority'] === 'number') {
      const num = t['priority'];
      if (!Number.isInteger(num) || num < 0) {
        warnings.push({
          line: 0,
          message: `ESCALATE PRIORITY should be a non-negative integer, got "${num}"`,
        });
        priority = 'medium';
      } else {
        priority = num;
      }
    } else if (t['priority'] !== undefined && t['priority'] !== null) {
      const strVal = asString(t['priority']) || 'medium';
      priority = strVal as EscalateTrigger['priority'];
      const validNames = ['low', 'medium', 'high', 'critical'];
      if (!validNames.includes(strVal)) {
        warnings.push({
          line: 0,
          message: `ESCALATE PRIORITY should be a non-negative integer, got "${strVal}"`,
        });
      }
    }
    return {
      when: asString(t['when']) || '',
      reason: asString(t['reason']) || '',
      priority,
      tags: Array.isArray(t['tags']) ? (t['tags'] as string[]) : undefined,
    };
  });
}

function parseEscalateContext(raw: unknown): EscalateContextItem[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const c = item as Record<string, unknown>;
    return {
      name: asString(c['name']) || '',
      template: asString(c['template']),
      include: Array.isArray(c['include']) ? (c['include'] as string[]) : undefined,
    };
  });
}

function parseOnHumanComplete(raw: unknown): OnHumanCompleteAction[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const a = item as Record<string, unknown>;
    return {
      condition: asString(a['condition']) || '',
      action: asString(a['action']) || '',
    };
  });
}

function parseComplete(raw: unknown): CompleteCondition[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const c = item as Record<string, unknown>;
    const voiceConfigRaw = readYamlField(c, 'voice_config') ?? readYamlField(c, 'voice');
    const richContentRaw = readYamlField(c, 'rich_content') ?? readYamlField(c, 'formats');
    return {
      when: asString(c['when']) || '',
      respond: asString(c['respond']),
      voiceConfig: asObject(voiceConfigRaw) ? (voiceConfigRaw as VoiceConfigAST) : undefined,
      richContent: asObject(richContentRaw) ? (richContentRaw as RichContentAST) : undefined,
      actions: parseActionSet(readYamlField(c, 'actions')),
      store: asString(c['store']),
    };
  });
}

function parseOnError(raw: unknown): ErrorHandler[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const e = item as Record<string, unknown>;
    const voiceConfigRaw = readYamlField(e, 'voice_config') ?? readYamlField(e, 'voice');
    const richContentRaw = readYamlField(e, 'rich_content') ?? readYamlField(e, 'formats');
    return {
      type: asString(e['type']) || 'unknown',
      subtypes: asStringArray(e['subtypes']) || undefined,
      respond: asString(e['respond']),
      voiceConfig: asObject(voiceConfigRaw) ? (voiceConfigRaw as VoiceConfigAST) : undefined,
      richContent: asObject(richContentRaw) ? (richContentRaw as RichContentAST) : undefined,
      actions: parseActionSet(readYamlField(e, 'actions')),
      retry: typeof e['retry'] === 'number' ? e['retry'] : undefined,
      retryDelay: typeof e['retry_delay'] === 'number' ? e['retry_delay'] : undefined,
      retryBackoff: asString(e['retry_backoff']) as 'fixed' | 'exponential' | 'linear' | undefined,
      retryMaxDelay: typeof e['retry_max_delay'] === 'number' ? e['retry_max_delay'] : undefined,
      then: asString(e['then']),
      backtrackTo: asString(e['backtrack_to']),
    };
  });
}

type ParsedToolInvocation = {
  tool?: string;
  with?: Record<string, unknown>;
  as?: string;
};

function parseToolInvocation(raw: unknown): ParsedToolInvocation | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const tool = asString(obj['tool']);
  const withValues = asObject(obj['with']);
  const asValue = asString(obj['as']);
  if (!tool && !withValues && !asValue) {
    return undefined;
  }

  return {
    ...(tool ? { tool } : {}),
    ...(withValues ? { with: { ...withValues } } : {}),
    ...(asValue ? { as: asValue } : {}),
  };
}

function buildToolInvocation(
  call: string | undefined,
  callWith?: Record<string, unknown>,
  callAs?: string,
  callSpec?: ParsedToolInvocation,
): ToolInvocationAST | undefined {
  const toolMatch = call?.trim().match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(|$)/);
  const toolFromCall = toolMatch?.[1] ?? call?.trim();
  const tool = callSpec?.tool ?? toolFromCall;
  if (!tool) {
    return undefined;
  }

  return {
    tool,
    ...(callSpec?.with || callWith ? { with: { ...(callSpec?.with ?? callWith) } } : {}),
    ...(callSpec?.as || callAs ? { as: callSpec?.as ?? callAs } : {}),
  };
}

function parseOnStart(raw: unknown): StartHandler | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  const call = asString(obj['call']);
  const callSpec = parseToolInvocation(obj['call_spec']);
  const voiceConfigRaw = readYamlField(obj, 'voiceConfig', 'voice_config') ?? obj['voice'];
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];
  return {
    respond: asString(obj['respond']),
    voiceConfig: asObject(voiceConfigRaw)
      ? (voiceConfigRaw as StartHandler['voiceConfig'])
      : undefined,
    richContent: asObject(richContentRaw)
      ? (richContentRaw as StartHandler['richContent'])
      : undefined,
    actions: parseActionSet(readYamlField(obj, 'actions')),
    call,
    callSpec: buildToolInvocation(call, undefined, undefined, callSpec),
    set: obj['set'] && typeof obj['set'] === 'object' ? asStringRecord(obj['set']) : undefined,
    delegate: asString(obj['delegate']),
  };
}

function parseHookAction(raw: unknown): HookAction | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const call = asString(obj['call']);
  const callSpec = parseToolInvocation(obj['call_spec']);
  const voiceConfigRaw = readYamlField(obj, 'voiceConfig', 'voice_config');
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];

  const action: HookAction = {
    call,
    callSpec: buildToolInvocation(call, undefined, undefined, callSpec),
    set: asObject(obj['set']) ? asStringRecord(obj['set']) : undefined,
    respond: asString(obj['respond']),
    voiceConfig: asObject(voiceConfigRaw)
      ? (voiceConfigRaw as HookAction['voiceConfig'])
      : undefined,
    richContent: asObject(richContentRaw)
      ? (richContentRaw as HookAction['richContent'])
      : undefined,
    actions: parseActionSet(readYamlField(obj, 'actions')),
    critical: asBoolean(obj['critical']),
  };

  return Object.keys(action).some((key) => action[key as keyof HookAction] !== undefined)
    ? action
    : undefined;
}

function parseHooks(raw: unknown): HooksConfig | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const hooks: HooksConfig = {
    before_agent: parseHookAction(obj['before_agent']),
    after_agent: parseHookAction(obj['after_agent']),
    before_turn: parseHookAction(obj['before_turn']),
    after_turn: parseHookAction(obj['after_turn']),
  };

  return Object.values(hooks).some(Boolean) ? hooks : undefined;
}

function readYamlField(
  obj: Record<string, unknown>,
  camelCase: string,
  snakeCase = camelCase,
): unknown {
  return obj[camelCase] ?? obj[snakeCase];
}

function parseExecutionPipeline(
  raw: unknown,
): NonNullable<ExecutionConfigAST['pipeline']> | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const shortCircuit = asObject(readYamlField(obj, 'shortCircuit', 'short_circuit'));
  const toolFilter = asObject(readYamlField(obj, 'toolFilter', 'tool_filter'));
  const keywordVeto = asObject(readYamlField(obj, 'keywordVeto', 'keyword_veto'));
  const intentBridge = asObject(readYamlField(obj, 'intentBridge', 'intent_bridge'));

  return {
    enabled: asBoolean(obj['enabled']),
    mode: asString(obj['mode']) as 'parallel' | 'sequential' | undefined,
    model: asString(obj['model']),
    shortCircuit: shortCircuit
      ? {
          enabled: asBoolean(shortCircuit['enabled']),
          confidenceThreshold: asNumber(
            readYamlField(shortCircuit, 'confidenceThreshold', 'confidence_threshold'),
          ),
        }
      : undefined,
    toolFilter: toolFilter
      ? {
          enabled: asBoolean(toolFilter['enabled']),
          maxTools: asNumber(readYamlField(toolFilter, 'maxTools', 'max_tools')),
        }
      : undefined,
    keywordVeto: keywordVeto
      ? {
          enabled: asBoolean(keywordVeto['enabled']),
          keywords: asStringArray(keywordVeto['keywords']),
        }
      : undefined,
    intentBridge: intentBridge
      ? {
          enabled: asBoolean(intentBridge['enabled']),
          programmaticThreshold: asNumber(
            readYamlField(intentBridge, 'programmaticThreshold', 'programmatic_threshold'),
          ),
          guidedThreshold: asNumber(
            readYamlField(intentBridge, 'guidedThreshold', 'guided_threshold'),
          ),
          outOfScopeDecline: asBoolean(
            readYamlField(intentBridge, 'outOfScopeDecline', 'out_of_scope_decline'),
          ),
          multiIntentSignal: asBoolean(
            readYamlField(intentBridge, 'multiIntentSignal', 'multi_intent_signal'),
          ),
        }
      : undefined,
  };
}

function asStringArrayRecord(val: unknown): Record<string, string[]> | undefined {
  const obj = asObject(val);
  if (!obj) return undefined;

  const result: Record<string, string[]> = {};
  for (const [key, value] of Object.entries(obj)) {
    const strings = asStringArray(value);
    if (strings) {
      result[key] = strings;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseCompactionPolicy(raw: unknown): CompactionPolicyOverrideAST | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const toolResults = asObject(readYamlField(obj, 'toolResults', 'tool_results'));
  const priorTurns = asObject(readYamlField(obj, 'priorTurns', 'prior_turns'));
  const compaction: CompactionPolicyOverrideAST = {
    model: asString(obj['model']),
    tool_results: toolResults
      ? {
          strategy: asString(toolResults['strategy']) as
            | NonNullable<NonNullable<CompactionPolicyOverrideAST['tool_results']>['strategy']>
            | undefined,
          max_chars: asNumber(readYamlField(toolResults, 'maxChars', 'max_chars')),
          structured_threshold: asNumber(
            readYamlField(toolResults, 'structuredThreshold', 'structured_threshold'),
          ),
          keep_recent: asNumber(readYamlField(toolResults, 'keepRecent', 'keep_recent')),
          essential_fields: asStringArrayRecord(
            readYamlField(toolResults, 'essentialFields', 'essential_fields'),
          ),
          max_description_length: asNumber(
            readYamlField(toolResults, 'maxDescriptionLength', 'max_description_length'),
          ),
          summarize_prompt: asString(
            readYamlField(toolResults, 'summarizePrompt', 'summarize_prompt'),
          ),
        }
      : undefined,
    prior_turns: priorTurns
      ? {
          strategy: asString(priorTurns['strategy']) as
            | NonNullable<NonNullable<CompactionPolicyOverrideAST['prior_turns']>['strategy']>
            | undefined,
          assistant_preview_chars: asNumber(
            readYamlField(priorTurns, 'assistantPreviewChars', 'assistant_preview_chars'),
          ),
        }
      : undefined,
  };

  return Object.values(compaction).some((value) => value !== undefined) ? compaction : undefined;
}

function parseExecution(raw: unknown): ExecutionConfigAST | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;
  return {
    model: asString(obj['model']),
    temperature: typeof obj['temperature'] === 'number' ? obj['temperature'] : undefined,
    max_tokens: typeof obj['max_tokens'] === 'number' ? obj['max_tokens'] : undefined,
    tool_timeout: typeof obj['tool_timeout'] === 'number' ? obj['tool_timeout'] : undefined,
    llm_timeout: typeof obj['llm_timeout'] === 'number' ? obj['llm_timeout'] : undefined,
    session_idle_timeout:
      typeof obj['session_idle_timeout'] === 'number' ? obj['session_idle_timeout'] : undefined,
    max_reasoning_iterations:
      typeof obj['max_reasoning_iterations'] === 'number'
        ? obj['max_reasoning_iterations']
        : undefined,
    max_flow_iterations:
      typeof obj['max_flow_iterations'] === 'number' ? obj['max_flow_iterations'] : undefined,
    fallback_model: asString(obj['fallback_model']),
    compaction: parseCompactionPolicy(obj['compaction']),
    pipeline: parseExecutionPipeline(obj['pipeline']),
    conversation_history_window:
      typeof obj['conversation_history_window'] === 'number'
        ? obj['conversation_history_window']
        : undefined,
  };
}

function parseMessages(raw: unknown): AgentMessages | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const result: AgentMessages = {};
  for (const [key, val] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof val === 'string') {
      result[key] = val;
    }
  }
  return result;
}

function parseTemplates(raw: unknown): TemplateDefinition[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const t = item as Record<string, unknown>;
    return {
      name: asString(t['name']) || '',
      content: asString(t['content']) || '',
    };
  });
}

function parseGuardrails(raw: unknown): GuardrailDefinition[] | undefined {
  if (!raw || !Array.isArray(raw)) return undefined;
  return raw.map((item) => {
    const g = item as Record<string, unknown>;
    return {
      name: asString(g['name']) || '',
      kind: (asString(g['kind']) || 'input') as 'input' | 'output' | 'both',
      check: asString(g['check']) || '',
      action: (asString(g['action']) || 'block') as 'block' | 'warn' | 'redact' | 'escalate',
      message: asString(g['message']),
      priority: typeof g['priority'] === 'number' ? g['priority'] : undefined,
    };
  });
}

// =============================================================================
// FLOW PARSING (Scripted Mode)
// =============================================================================

function parseFlow(raw: unknown): FlowDefinition | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const obj = raw as Record<string, unknown>;

  const flow: FlowDefinition = {
    steps: [],
    definitions: {},
  };

  // Parse entry_point
  if (obj['entry_point']) {
    flow.entryPoint = asString(obj['entry_point']);
  }

  // Parse steps (the main content)
  if (obj['steps'] && typeof obj['steps'] === 'object') {
    const stepsObj = obj['steps'] as Record<string, unknown>;
    for (const [stepName, stepData] of Object.entries(stepsObj)) {
      flow.steps.push(stepName);
      flow.definitions[stepName] = parseFlowStep(stepName, stepData);
    }
  }

  return flow;
}

function parseInputBranch(raw: unknown): NonNullable<FlowStep['onInput']>[number] | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const call = asString(obj['call']);
  const callSpec = parseToolInvocation(obj['call_spec']);
  const voiceConfigRaw = readYamlField(obj, 'voiceConfig', 'voice_config');
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];

  const branch: NonNullable<FlowStep['onInput']>[number] = {
    condition:
      obj['condition'] === null || obj['condition'] === undefined
        ? undefined
        : asString(obj['condition']),
    respond: asString(obj['respond']),
    messageKey: asString(obj['message_key']),
    voiceConfig: asObject(voiceConfigRaw)
      ? (voiceConfigRaw as NonNullable<FlowStep['onInput']>[number]['voiceConfig'])
      : undefined,
    richContent: asObject(richContentRaw)
      ? (richContentRaw as NonNullable<FlowStep['onInput']>[number]['richContent'])
      : undefined,
    actions: parseActionSet(readYamlField(obj, 'actions')),
    set: asObject(obj['set']) ? asStringRecord(obj['set']) : undefined,
    call,
    callSpec: buildToolInvocation(call, undefined, undefined, callSpec),
    then: asString(obj['then']) || '',
  };

  return branch;
}

function parseInputBranches(raw: unknown): FlowStep['onInput'] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const branches = raw
    .map((item) => parseInputBranch(item))
    .filter((branch): branch is NonNullable<FlowStep['onInput']>[number] => !!branch);
  return branches.length > 0 ? branches : undefined;
}

function parseActionElement(raw: unknown): ActionElementAST | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const id =
    asString(readYamlField(obj, 'id')) ||
    asString(readYamlField(obj, 'actionId', 'action_id')) ||
    asString(readYamlField(obj, 'name'));
  if (!id) return undefined;

  const type = (asString(readYamlField(obj, 'type')) || 'button').toLowerCase();
  if (type !== 'button' && type !== 'select' && type !== 'input') return undefined;

  const label =
    asString(readYamlField(obj, 'label')) ||
    asString(readYamlField(obj, 'title')) ||
    asString(readYamlField(obj, 'text')) ||
    id;

  type ActionElementOption = {
    id: string;
    label: string;
    description?: string;
  };
  const optionsRaw = readYamlField(obj, 'options');
  const options = Array.isArray(optionsRaw)
    ? optionsRaw
        .map((optionRaw) => {
          const optionObj = asObject(optionRaw);
          if (!optionObj) return undefined;
          const optionId =
            asString(readYamlField(optionObj, 'id')) || asString(readYamlField(optionObj, 'value'));
          if (!optionId) return undefined;
          const description = asString(readYamlField(optionObj, 'description'));
          return {
            id: optionId,
            label:
              asString(readYamlField(optionObj, 'label')) ||
              asString(readYamlField(optionObj, 'title')) ||
              asString(readYamlField(optionObj, 'text')) ||
              optionId,
            ...(description ? { description } : {}),
          };
        })
        .filter((option): option is ActionElementOption => !!option)
    : undefined;

  return {
    id,
    type,
    label,
    ...(asString(readYamlField(obj, 'value')) || asString(readYamlField(obj, 'payload'))
      ? {
          value: asString(readYamlField(obj, 'value')) || asString(readYamlField(obj, 'payload')),
        }
      : {}),
    ...(asString(readYamlField(obj, 'description')) || asString(readYamlField(obj, 'subtitle'))
      ? {
          description:
            asString(readYamlField(obj, 'description')) || asString(readYamlField(obj, 'subtitle')),
        }
      : {}),
    ...(options && options.length > 0 ? { options } : {}),
    ...(asString(readYamlField(obj, 'inputType', 'input_type'))
      ? {
          inputType: asString(
            readYamlField(obj, 'inputType', 'input_type'),
          ) as ActionElementAST['inputType'],
        }
      : {}),
    ...(asString(readYamlField(obj, 'placeholder'))
      ? { placeholder: asString(readYamlField(obj, 'placeholder')) }
      : {}),
    ...(asBoolean(readYamlField(obj, 'required')) !== undefined
      ? { required: asBoolean(readYamlField(obj, 'required')) }
      : {}),
  };
}

function parseActionSet(raw: unknown): ActionSetAST | undefined {
  const obj = asObject(raw);
  const elementsRaw = Array.isArray(raw)
    ? raw
    : Array.isArray(obj?.['elements'])
      ? obj?.['elements']
      : undefined;
  if (!elementsRaw) return undefined;

  const elements = elementsRaw
    .map((item) => parseActionElement(item))
    .filter((element): element is ActionElementAST => !!element);
  if (elements.length === 0) return undefined;

  return {
    elements,
    ...(obj && asString(readYamlField(obj, 'submitLabel', 'submit_label'))
      ? { submitLabel: asString(readYamlField(obj, 'submitLabel', 'submit_label')) }
      : {}),
    ...(obj && asString(readYamlField(obj, 'submitId', 'submit_id'))
      ? { submitId: asString(readYamlField(obj, 'submitId', 'submit_id')) }
      : {}),
  };
}

function parseActionOnReturn(raw: unknown): DigressionOnReturnAST | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const onReturn: DigressionOnReturnAST = {
    map: asObject(readYamlField(obj, 'map'))
      ? asStringRecord(readYamlField(obj, 'map'))
      : undefined,
  };

  return Object.values(onReturn).some((value) => value !== undefined) ? onReturn : undefined;
}

function parseActionHandlerAction(raw: unknown): ActionHandlerActionAST | undefined {
  if (typeof raw === 'string') {
    const actionName = raw.trim().toLowerCase();
    return actionName === 'complete' ? { complete: true } : undefined;
  }

  const obj = asObject(raw);
  if (!obj) return undefined;

  const call = asString(readYamlField(obj, 'call'));
  const callWith = asObject(readYamlField(obj, 'callWith', 'call_with'));
  const callAs = asString(readYamlField(obj, 'callAs', 'call_as'));
  const callSpec = parseToolInvocation(readYamlField(obj, 'callSpec', 'call_spec'));
  const voiceConfigRaw = readYamlField(obj, 'voiceConfig', 'voice_config');
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];

  const completeRaw = readYamlField(obj, 'complete');
  const returnRaw = readYamlField(obj, 'return');
  const action: ActionHandlerActionAST = {
    respond: asString(readYamlField(obj, 'respond')),
    voiceConfig: asObject(voiceConfigRaw)
      ? (voiceConfigRaw as ActionHandlerActionAST['voiceConfig'])
      : undefined,
    richContent: asObject(richContentRaw)
      ? (richContentRaw as ActionHandlerActionAST['richContent'])
      : undefined,
    actions: parseActionSet(readYamlField(obj, 'actions')),
    set: asObject(readYamlField(obj, 'set'))
      ? asStringRecord(readYamlField(obj, 'set'))
      : undefined,
    clear: normalizeClearFields(readYamlField(obj, 'clear')),
    call,
    resultKey: asString(readYamlField(obj, 'resultKey', 'result_key')) || callAs || callSpec?.as,
    callSpec: buildToolInvocation(call, callWith, callAs, callSpec),
    handoff: asString(readYamlField(obj, 'handoff')),
    delegate: asString(readYamlField(obj, 'delegate')),
    return:
      typeof returnRaw === 'boolean'
        ? returnRaw
        : typeof returnRaw === 'string'
          ? returnRaw.trim().toLowerCase() === 'true'
          : undefined,
    onReturn: parseActionOnReturn(readYamlField(obj, 'onReturn', 'on_return')),
    goto:
      asString(readYamlField(obj, 'goto')) ||
      asString(readYamlField(obj, 'transition')) ||
      asString(readYamlField(obj, 'then')),
    complete:
      completeRaw === undefined
        ? undefined
        : typeof completeRaw === 'boolean'
          ? completeRaw
          : String(completeRaw).trim().toLowerCase() === 'true',
  };

  return Object.values(action).some((value) => value !== undefined) ? action : undefined;
}

function parseActionHandlerActions(raw: unknown): ActionHandlerActionAST[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const actions = raw
    .map((item) => parseActionHandlerAction(item))
    .filter((action): action is ActionHandlerActionAST => !!action);
  return actions.length > 0 ? actions : undefined;
}

function parseDirectActionHandlerActions(
  handlerObj: Record<string, unknown>,
): ActionHandlerActionAST[] | undefined {
  const actions: ActionHandlerActionAST[] = [];
  const set = readYamlField(handlerObj, 'set');
  const clear = normalizeClearFields(readYamlField(handlerObj, 'clear'));
  const respond = asString(readYamlField(handlerObj, 'respond'));
  const voiceConfigRaw = readYamlField(handlerObj, 'voiceConfig', 'voice_config');
  const richContentRaw =
    readYamlField(handlerObj, 'richContent', 'rich_content') ?? handlerObj['formats'];
  const call = asString(readYamlField(handlerObj, 'call'));
  const callWith = asObject(readYamlField(handlerObj, 'callWith', 'call_with'));
  const callAs = asString(readYamlField(handlerObj, 'callAs', 'call_as'));
  const callSpec = parseToolInvocation(readYamlField(handlerObj, 'callSpec', 'call_spec'));
  const handoff = asString(readYamlField(handlerObj, 'handoff'));
  const delegate = asString(readYamlField(handlerObj, 'delegate'));
  const returnRaw = readYamlField(handlerObj, 'return');
  const goto =
    asString(readYamlField(handlerObj, 'goto')) ||
    asString(readYamlField(handlerObj, 'transition')) ||
    asString(readYamlField(handlerObj, 'then'));
  const completeRaw = readYamlField(handlerObj, 'complete');
  const complete =
    completeRaw === undefined
      ? undefined
      : typeof completeRaw === 'boolean'
        ? completeRaw
        : String(completeRaw).trim().toLowerCase() === 'true';

  if (asObject(set)) {
    actions.push({ set: asStringRecord(set) });
  }
  if (clear) {
    actions.push({ clear });
  }
  if (respond !== undefined) {
    actions.push({
      respond,
      voiceConfig: asObject(voiceConfigRaw)
        ? (voiceConfigRaw as ActionHandlerActionAST['voiceConfig'])
        : undefined,
      richContent: asObject(richContentRaw)
        ? (richContentRaw as ActionHandlerActionAST['richContent'])
        : undefined,
      actions: parseActionSet(readYamlField(handlerObj, 'actions')),
    });
  }
  if (call || callSpec) {
    actions.push({
      call,
      resultKey:
        asString(readYamlField(handlerObj, 'resultKey', 'result_key')) || callAs || callSpec?.as,
      callSpec: buildToolInvocation(call, callWith, callAs, callSpec),
    });
  }
  if (handoff) {
    actions.push({ handoff });
  }
  if (delegate) {
    actions.push({
      delegate,
      return:
        typeof returnRaw === 'boolean'
          ? returnRaw
          : typeof returnRaw === 'string'
            ? returnRaw.trim().toLowerCase() === 'true'
            : undefined,
      onReturn: parseActionOnReturn(readYamlField(handlerObj, 'onReturn', 'on_return')),
    });
  }
  if (goto) {
    actions.push({ goto });
  }
  if (complete !== undefined) {
    actions.push({ complete });
  }

  return actions.length > 0 ? actions : undefined;
}

function parseActionHandlers(raw: unknown): ActionHandlerAST[] | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const handlers = Object.entries(obj)
    .map(([actionId, handlerRaw]) => {
      const handlerObj = asObject(handlerRaw);
      if (!handlerObj) return undefined;
      const handler: ActionHandlerAST = {
        actionId,
        condition: asString(readYamlField(handlerObj, 'condition')),
        do:
          parseActionHandlerActions(readYamlField(handlerObj, 'do')) ??
          parseDirectActionHandlerActions(handlerObj),
        respond: asString(readYamlField(handlerObj, 'respond')),
        voiceConfig: asObject(readYamlField(handlerObj, 'voiceConfig', 'voice_config'))
          ? (readYamlField(
              handlerObj,
              'voiceConfig',
              'voice_config',
            ) as ActionHandlerAST['voiceConfig'])
          : undefined,
        richContent: asObject(
          readYamlField(handlerObj, 'richContent', 'rich_content') ?? handlerObj['formats'],
        )
          ? ((readYamlField(handlerObj, 'richContent', 'rich_content') ??
              handlerObj['formats']) as ActionHandlerAST['richContent'])
          : undefined,
        actions: parseActionSet(readYamlField(handlerObj, 'actions')),
        set: asObject(readYamlField(handlerObj, 'set'))
          ? asStringRecord(readYamlField(handlerObj, 'set'))
          : undefined,
        transition:
          asString(readYamlField(handlerObj, 'transition')) ||
          asString(readYamlField(handlerObj, 'goto')) ||
          asString(readYamlField(handlerObj, 'then')),
      };
      return handler;
    })
    .filter((handler): handler is ActionHandlerAST => !!handler);

  return handlers.length > 0 ? handlers : undefined;
}

function parseDigression(raw: unknown): Digression | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const intent = asString(readYamlField(obj, 'intent'));
  if (!intent) return undefined;

  const call = asString(readYamlField(obj, 'call'));
  const voiceConfigRaw = readYamlField(obj, 'voiceConfig', 'voice_config');
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];
  const digression: Digression = {
    intent,
    keywords: asStringArray(readYamlField(obj, 'keywords')),
    condition: asString(readYamlField(obj, 'condition')),
    respond: asString(readYamlField(obj, 'respond')),
    messageKey: asString(readYamlField(obj, 'messageKey', 'message_key')),
    voiceConfig: asObject(voiceConfigRaw)
      ? (voiceConfigRaw as Digression['voiceConfig'])
      : undefined,
    richContent: asObject(richContentRaw)
      ? (richContentRaw as Digression['richContent'])
      : undefined,
    actions: parseActionSet(readYamlField(obj, 'actions')),
    clear: normalizeClearFields(readYamlField(obj, 'clear')),
    goto: asString(readYamlField(obj, 'goto')),
    delegate: asString(readYamlField(obj, 'delegate')),
    call,
    callSpec: buildToolInvocation(
      call,
      undefined,
      undefined,
      parseToolInvocation(readYamlField(obj, 'callSpec', 'call_spec')),
    ),
    resume: asBoolean(readYamlField(obj, 'resume')),
  };

  return digression;
}

function parseDigressions(raw: unknown): Digression[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const digressions = raw
    .map((item) => parseDigression(item))
    .filter((digression): digression is Digression => !!digression);
  return digressions.length > 0 ? digressions : undefined;
}

function parseSubIntent(raw: unknown): SubIntent | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const intent = asString(readYamlField(obj, 'intent'));
  if (!intent) return undefined;

  const call = asString(readYamlField(obj, 'call'));
  const voiceConfigRaw = readYamlField(obj, 'voiceConfig', 'voice_config');
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];
  const subIntent: SubIntent = {
    intent,
    respond: asString(readYamlField(obj, 'respond')),
    messageKey: asString(readYamlField(obj, 'messageKey', 'message_key')),
    voiceConfig: asObject(voiceConfigRaw)
      ? (voiceConfigRaw as SubIntent['voiceConfig'])
      : undefined,
    richContent: asObject(richContentRaw)
      ? (richContentRaw as SubIntent['richContent'])
      : undefined,
    actions: parseActionSet(readYamlField(obj, 'actions')),
    clear: normalizeClearFields(readYamlField(obj, 'clear')),
    set: asObject(readYamlField(obj, 'set'))
      ? asStringRecord(readYamlField(obj, 'set'))
      : undefined,
    call,
    callSpec: buildToolInvocation(
      call,
      undefined,
      undefined,
      parseToolInvocation(readYamlField(obj, 'callSpec', 'call_spec')),
    ),
    resume: asBoolean(readYamlField(obj, 'resume')),
  };

  return subIntent;
}

function parseSubIntents(raw: unknown): SubIntent[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const subIntents = raw
    .map((item) => parseSubIntent(item))
    .filter((subIntent): subIntent is SubIntent => !!subIntent);
  return subIntents.length > 0 ? subIntents : undefined;
}

function parseCallResultBlock(raw: unknown): FlowStep['onSuccess'] | undefined {
  const obj = asObject(raw);
  if (!obj) return undefined;

  const voiceConfigRaw = readYamlField(obj, 'voiceConfig', 'voice_config');
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];
  const branches = Array.isArray(obj['branches'])
    ? (obj['branches'] as unknown[])
        .map((item) => {
          const branchObj = asObject(item);
          if (!branchObj) return undefined;
          const call = asString(branchObj['call']);
          const callSpec = parseToolInvocation(branchObj['call_spec']);
          const branchVoiceConfigRaw = readYamlField(branchObj, 'voiceConfig', 'voice_config');
          const branchRichContentRaw =
            readYamlField(branchObj, 'richContent', 'rich_content') ?? branchObj['formats'];
          const branch: CallResultBranchAST = {
            condition:
              branchObj['condition'] === null || branchObj['condition'] === undefined
                ? undefined
                : asString(branchObj['condition']),
            respond: asString(branchObj['respond']),
            messageKey: asString(branchObj['message_key']),
            voiceConfig: asObject(branchVoiceConfigRaw)
              ? (branchVoiceConfigRaw as CallResultBranchAST['voiceConfig'])
              : undefined,
            richContent: asObject(branchRichContentRaw)
              ? (branchRichContentRaw as CallResultBranchAST['richContent'])
              : undefined,
            actions: parseActionSet(readYamlField(branchObj, 'actions')),
            set: asObject(branchObj['set']) ? asStringRecord(branchObj['set']) : undefined,
            call,
            callSpec: buildToolInvocation(call, undefined, undefined, callSpec),
            then: asString(branchObj['then']),
          };
          return branch;
        })
        .filter((branch): branch is CallResultBranchAST => !!branch)
    : undefined;

  return {
    respond: asString(obj['respond']),
    messageKey: asString(obj['message_key']),
    voiceConfig: asObject(voiceConfigRaw) ? (voiceConfigRaw as VoiceConfigAST) : undefined,
    richContent: asObject(richContentRaw) ? (richContentRaw as RichContentAST) : undefined,
    actions: parseActionSet(readYamlField(obj, 'actions')),
    set: asObject(obj['set']) ? asStringRecord(obj['set']) : undefined,
    then: asString(obj['then']),
    branches: branches && branches.length > 0 ? branches : undefined,
  };
}

function parseFlowStep(name: string, raw: unknown): FlowStep {
  const step: FlowStep = { name };

  if (!raw || typeof raw !== 'object') return step;
  const obj = raw as Record<string, unknown>;

  const reasoning = asBoolean(readYamlField(obj, 'reasoning'));
  if (reasoning !== undefined) {
    step.reasoning = reasoning;
  }
  if (readYamlField(obj, 'goal') !== undefined) {
    step.goal = asString(readYamlField(obj, 'goal'));
  }
  const availableTools = asStringArray(readYamlField(obj, 'availableTools', 'available_tools'));
  if (availableTools) {
    step.availableTools = availableTools;
  }
  if (readYamlField(obj, 'exitWhen', 'exit_when') !== undefined) {
    step.exitWhen = asString(readYamlField(obj, 'exitWhen', 'exit_when'));
  }
  const maxTurns = asNumber(readYamlField(obj, 'maxTurns', 'max_turns'));
  if (maxTurns !== undefined) {
    step.maxTurns = maxTurns;
  }
  const stepConstraints = asStringArray(readYamlField(obj, 'stepConstraints', 'step_constraints'));
  if (stepConstraints) {
    step.stepConstraints = stepConstraints;
  }

  // Entry guard
  if (obj['when'] !== undefined) {
    step.when = asString(obj['when']);
  }

  // Attempt limiting
  if (typeof obj['max_attempts'] === 'number') {
    step.maxAttempts = obj['max_attempts'];
  }
  if (obj['on_exhausted']) {
    step.onExhausted = asString(obj['on_exhausted']);
  }

  // Respond
  if (obj['respond'] !== undefined) {
    step.respond = asString(obj['respond']);
  }
  if (obj['message_key'] !== undefined) {
    step.messageKey = asString(obj['message_key']);
  }
  const voiceConfigRaw = readYamlField(obj, 'voiceConfig', 'voice_config') ?? obj['voice'];
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];
  if (asObject(voiceConfigRaw)) {
    step.voiceConfig = voiceConfigRaw as VoiceConfigAST;
  }
  if (asObject(richContentRaw)) {
    step.richContent = richContentRaw as RichContentAST;
  }

  // Transition
  if (obj['then'] !== undefined) {
    step.then = asString(obj['then']);
  }

  // Tool call
  const call = asString(obj['call']);
  if (call !== undefined) {
    step.call = call;
  }
  if (obj['call_with'] && typeof obj['call_with'] === 'object') {
    step.callWith = asStringRecord(obj['call_with']);
  }
  if (obj['call_as'] !== undefined) {
    step.callAs = asString(obj['call_as']);
  }
  step.callSpec = buildToolInvocation(
    call,
    step.callWith,
    step.callAs,
    parseToolInvocation(obj['call_spec']),
  );

  // Check
  if (obj['check'] !== undefined) {
    step.check = asString(obj['check']);
  }

  // On fail (simple)
  if (obj['on_fail'] !== undefined) {
    step.onFail = asString(obj['on_fail']);
  }

  // Gather
  if (obj['gather']) {
    step.gather = parseFlowGatherConfig(obj['gather']);
  }

  // Present
  if (obj['present'] !== undefined) {
    step.present = asString(obj['present']);
  }

  step.actions = parseActionSet(readYamlField(obj, 'actions'));
  step.onAction = parseActionHandlers(readYamlField(obj, 'onAction', 'on_action'));

  // Corrections
  if (obj['corrections'] !== undefined) {
    step.corrections = obj['corrections'] === true;
  }

  // Complete when
  if (obj['complete_when'] !== undefined) {
    step.completeWhen = asString(obj['complete_when']);
  }

  // SET assignments
  if (obj['set']) {
    step.set = parseSetAssignments(obj['set']);
  }

  // CLEAR
  if (obj['clear'] && Array.isArray(obj['clear'])) {
    step.clear = (obj['clear'] as unknown[]).map((c) => String(c));
  }

  // ON_SUCCESS / ON_FAILURE
  if (obj['on_success']) {
    step.onSuccess = parseCallResultBlock(obj['on_success']);
  }
  if (obj['on_failure']) {
    step.onFailure = parseCallResultBlock(obj['on_failure']);
  }

  if (obj['on_input']) {
    step.onInput = parseInputBranches(obj['on_input']);
  }
  if (obj['on_result']) {
    step.onResult = parseInputBranches(obj['on_result']);
  }
  if (obj['digressions']) {
    step.digressions = parseDigressions(obj['digressions']);
  }
  if (obj['sub_intents']) {
    step.subIntents = parseSubIntents(obj['sub_intents']);
  }

  return step;
}

function parseFlowGatherConfig(raw: unknown): FlowGatherConfig {
  if (!raw || typeof raw !== 'object') return { fields: [] };
  const obj = raw as Record<string, unknown>;

  const config: FlowGatherConfig = {
    fields: [],
  };

  if (obj['strategy']) {
    config.strategy = asString(obj['strategy']) as 'llm' | 'pattern' | 'hybrid';
  }
  if (obj['prompt']) {
    config.prompt = asString(obj['prompt']);
  }
  if (obj['message_key']) {
    config.messageKey = asString(obj['message_key']);
  }
  if (obj['fields'] && Array.isArray(obj['fields'])) {
    config.fields = (obj['fields'] as unknown[]).map((f) => parseFlowGatherField(f));
  }

  return config;
}

function parseFlowGatherField(raw: unknown): FlowGatherField {
  if (!raw || typeof raw !== 'object') return { name: '' };
  const obj = raw as Record<string, unknown>;

  const field: FlowGatherField = {
    name: asString(obj['name']) || '',
  };

  if (obj['type'] !== undefined) field.type = asString(obj['type']);
  if (obj['required'] !== undefined) field.required = obj['required'] === true;
  if (obj['default'] !== undefined) field.default = obj['default'];
  if (obj['prompt'] !== undefined) field.prompt = asString(obj['prompt']);
  if (obj['message_key'] !== undefined) field.messageKey = asString(obj['message_key']);
  if (obj['validation'] !== undefined) field.validation = asString(obj['validation']);
  if (obj['validation_process'] !== undefined) {
    field.validationProcess = asString(obj['validation_process'])?.toUpperCase() as
      | 'REGEX'
      | 'CODE'
      | 'LLM';
  }
  if (obj['retry_prompt'] !== undefined) field.retryPrompt = asString(obj['retry_prompt']);
  if (typeof obj['max_retries'] === 'number') field.maxRetries = obj['max_retries'];
  if (obj['extraction_hints'] && Array.isArray(obj['extraction_hints'])) {
    field.extractionHints = (obj['extraction_hints'] as unknown[]).map((h) => String(h));
  }
  if (obj['infer'] !== undefined) field.infer = obj['infer'] === true;
  if (obj['range'] !== undefined) field.range = obj['range'] === true;
  if (obj['list'] !== undefined) field.list = obj['list'] === true;
  if (obj['preferences'] !== undefined) field.preferences = obj['preferences'] === true;
  if (obj['depends_on'] && Array.isArray(obj['depends_on'])) {
    field.dependsOn = obj['depends_on'] as string[];
  }
  if (obj['prompt_mode']) {
    field.promptMode = asString(obj['prompt_mode']) as 'ask' | 'extract_only';
  }
  const richContentRaw = readYamlField(obj, 'richContent', 'rich_content') ?? obj['formats'];
  if (asObject(richContentRaw)) {
    field.richContent = richContentRaw as RichContentAST;
  }

  return field;
}

function parseSetAssignments(raw: unknown): SetAssignment[] {
  if (!raw || !Array.isArray(raw)) return [];
  return raw.map((item) => {
    const a = item as Record<string, unknown>;
    return {
      variable: asString(a['variable']) || '',
      expression: asString(a['expression']) || '',
    };
  });
}

// =============================================================================
// CONVERSATION BEHAVIOR
// =============================================================================

interface ConversationBehaviorParseResult {
  conversation?: ConversationBehaviorAST;
  errors: string[];
}

export function parseConversationBehaviorData(raw: unknown): ConversationBehaviorParseResult {
  const errors: string[] = [];
  const normalized = normalizeConversationBehaviorValue(raw);
  const obj = asObject(normalized);

  if (!obj) {
    return {
      errors: ['CONVERSATION must be an object with speaking, listening, or interaction fields.'],
    };
  }

  const conversation: ConversationBehaviorAST = {};
  const rootKeys = new Set(['speaking', 'listening', 'interaction']);
  pushUnknownKeys(obj, rootKeys, 'CONVERSATION', errors);

  if (obj['speaking'] !== undefined) {
    const speakingObj = expectObject(obj['speaking'], 'CONVERSATION.speaking', errors);
    if (speakingObj) {
      const speaking = parseConversationSpeaking(speakingObj, errors);
      if (speaking) {
        conversation.speaking = speaking;
      }
    }
  }

  if (obj['listening'] !== undefined) {
    const listeningObj = expectObject(obj['listening'], 'CONVERSATION.listening', errors);
    if (listeningObj) {
      const listening = parseConversationListening(listeningObj, errors);
      if (listening) {
        conversation.listening = listening;
      }
    }
  }

  if (obj['interaction'] !== undefined) {
    const interactionObj = expectObject(obj['interaction'], 'CONVERSATION.interaction', errors);
    if (interactionObj) {
      const interaction = parseConversationInteraction(interactionObj, errors);
      if (interaction) {
        conversation.interaction = interaction;
      }
    }
  }

  return {
    conversation: Object.keys(conversation).length > 0 ? conversation : undefined,
    errors,
  };
}

function parseConversationSpeaking(
  obj: Record<string, unknown>,
  errors: string[],
): ConversationSpeakingAST | undefined {
  const speaking: ConversationSpeakingAST = {};
  pushUnknownKeys(
    obj,
    new Set([
      'style',
      'tone',
      'emotion',
      'pace',
      'variety',
      'language_policy',
      'fixed_language',
      'max_sentences',
      'one_thing_at_a_time',
      'tool_lead_in',
      'tool_results',
      'readback',
      'handoffs',
      'phrases_ref',
      'pronunciations_ref',
    ]),
    'CONVERSATION.speaking',
    errors,
  );

  assignString(obj, 'style', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'tone', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'emotion', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'pace', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'variety', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'language_policy', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'fixed_language', speaking, errors, 'CONVERSATION.speaking');
  assignNumber(obj, 'max_sentences', speaking, errors, 'CONVERSATION.speaking');
  assignBoolean(obj, 'one_thing_at_a_time', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'tool_lead_in', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'phrases_ref', speaking, errors, 'CONVERSATION.speaking');
  assignString(obj, 'pronunciations_ref', speaking, errors, 'CONVERSATION.speaking');

  if (obj['tool_results'] !== undefined) {
    const toolResults = expectObject(
      obj['tool_results'],
      'CONVERSATION.speaking.tool_results',
      errors,
    );
    if (toolResults) {
      pushUnknownKeys(
        toolResults,
        new Set(['style', 'max_points']),
        'CONVERSATION.speaking.tool_results',
        errors,
      );
      speaking.tool_results = {};
      assignString(
        toolResults,
        'style',
        speaking.tool_results,
        errors,
        'CONVERSATION.speaking.tool_results',
      );
      assignNumber(
        toolResults,
        'max_points',
        speaking.tool_results,
        errors,
        'CONVERSATION.speaking.tool_results',
      );
      if (Object.keys(speaking.tool_results).length === 0) {
        delete speaking.tool_results;
      }
    }
  }

  if (obj['readback'] !== undefined) {
    const readback = expectObject(obj['readback'], 'CONVERSATION.speaking.readback', errors);
    if (readback) {
      pushUnknownKeys(
        readback,
        new Set(['numbers', 'codes', 'critical_details']),
        'CONVERSATION.speaking.readback',
        errors,
      );
      speaking.readback = {};
      assignString(
        readback,
        'numbers',
        speaking.readback,
        errors,
        'CONVERSATION.speaking.readback',
      );
      assignString(readback, 'codes', speaking.readback, errors, 'CONVERSATION.speaking.readback');
      assignString(
        readback,
        'critical_details',
        speaking.readback,
        errors,
        'CONVERSATION.speaking.readback',
      );
      if (Object.keys(speaking.readback).length === 0) {
        delete speaking.readback;
      }
    }
  }

  if (obj['handoffs'] !== undefined) {
    const handoffs = expectObject(obj['handoffs'], 'CONVERSATION.speaking.handoffs', errors);
    if (handoffs) {
      pushUnknownKeys(
        handoffs,
        new Set(['internal', 'human']),
        'CONVERSATION.speaking.handoffs',
        errors,
      );
      speaking.handoffs = {};
      assignString(
        handoffs,
        'internal',
        speaking.handoffs,
        errors,
        'CONVERSATION.speaking.handoffs',
      );
      assignString(handoffs, 'human', speaking.handoffs, errors, 'CONVERSATION.speaking.handoffs');
      if (Object.keys(speaking.handoffs).length === 0) {
        delete speaking.handoffs;
      }
    }
  }

  return Object.keys(speaking).length > 0 ? speaking : undefined;
}

function parseConversationListening(
  obj: Record<string, unknown>,
  errors: string[],
): ConversationListeningAST | undefined {
  const listening: ConversationListeningAST = {};
  pushUnknownKeys(
    obj,
    new Set([
      'barge_in',
      'backchannels',
      'on_pause',
      'on_overlap',
      'on_unclear_audio',
      'on_self_correction',
      'use_audio_cues',
    ]),
    'CONVERSATION.listening',
    errors,
  );

  assignString(obj, 'barge_in', listening, errors, 'CONVERSATION.listening');
  assignString(obj, 'backchannels', listening, errors, 'CONVERSATION.listening');
  assignString(obj, 'on_pause', listening, errors, 'CONVERSATION.listening');
  assignString(obj, 'on_overlap', listening, errors, 'CONVERSATION.listening');
  assignString(obj, 'on_unclear_audio', listening, errors, 'CONVERSATION.listening');
  assignString(obj, 'on_self_correction', listening, errors, 'CONVERSATION.listening');
  assignString(obj, 'use_audio_cues', listening, errors, 'CONVERSATION.listening');

  return Object.keys(listening).length > 0 ? listening : undefined;
}

function parseConversationInteraction(
  obj: Record<string, unknown>,
  errors: string[],
): ConversationInteractionAST | undefined {
  const interaction: ConversationInteractionAST = {};
  pushUnknownKeys(
    obj,
    new Set([
      'answer_shape',
      'detail',
      'initiative',
      'grounding',
      'clarification',
      'confirmation',
      'uncertainty',
      'empathy',
      'repair',
      'context',
      'closure',
      'assumption_handling',
      'guidance',
      'failure_recovery',
      'adaptation',
      'flow_mode',
    ]),
    'CONVERSATION.interaction',
    errors,
  );

  assignString(obj, 'answer_shape', interaction, errors, 'CONVERSATION.interaction');
  assignString(obj, 'detail', interaction, errors, 'CONVERSATION.interaction');
  assignString(obj, 'initiative', interaction, errors, 'CONVERSATION.interaction');
  assignString(obj, 'empathy', interaction, errors, 'CONVERSATION.interaction');
  assignString(obj, 'closure', interaction, errors, 'CONVERSATION.interaction');
  assignString(obj, 'assumption_handling', interaction, errors, 'CONVERSATION.interaction');
  assignString(obj, 'flow_mode', interaction, errors, 'CONVERSATION.interaction');

  interaction.grounding = parseSimpleStringObject(
    obj['grounding'],
    'CONVERSATION.interaction.grounding',
    new Set(['mode']),
    errors,
  );
  interaction.guidance = parseOpaqueObject(
    obj['guidance'],
    'CONVERSATION.interaction.guidance',
    errors,
  );
  interaction.failure_recovery = parseOpaqueObject(
    obj['failure_recovery'],
    'CONVERSATION.interaction.failure_recovery',
    errors,
  );
  interaction.adaptation = parseOpaqueObject(
    obj['adaptation'],
    'CONVERSATION.interaction.adaptation',
    errors,
  );

  if (obj['clarification'] !== undefined) {
    const clarification = expectObject(
      obj['clarification'],
      'CONVERSATION.interaction.clarification',
      errors,
    );
    if (clarification) {
      pushUnknownKeys(
        clarification,
        new Set(['mode', 'max_questions', 'assume_when_low_risk']),
        'CONVERSATION.interaction.clarification',
        errors,
      );
      interaction.clarification = {};
      assignString(
        clarification,
        'mode',
        interaction.clarification,
        errors,
        'CONVERSATION.interaction.clarification',
      );
      assignNumber(
        clarification,
        'max_questions',
        interaction.clarification,
        errors,
        'CONVERSATION.interaction.clarification',
      );
      assignBoolean(
        clarification,
        'assume_when_low_risk',
        interaction.clarification,
        errors,
        'CONVERSATION.interaction.clarification',
      );
      if (Object.keys(interaction.clarification).length === 0) {
        delete interaction.clarification;
      }
    }
  }

  if (obj['confirmation'] !== undefined) {
    interaction.confirmation = parseSimpleStringObject(
      obj['confirmation'],
      'CONVERSATION.interaction.confirmation',
      new Set(['parameters', 'actions']),
      errors,
    );
  }

  if (obj['uncertainty'] !== undefined) {
    const uncertainty = expectObject(
      obj['uncertainty'],
      'CONVERSATION.interaction.uncertainty',
      errors,
    );
    if (uncertainty) {
      pushUnknownKeys(
        uncertainty,
        new Set(['mode', 'offer_next_step']),
        'CONVERSATION.interaction.uncertainty',
        errors,
      );
      interaction.uncertainty = {};
      assignString(
        uncertainty,
        'mode',
        interaction.uncertainty,
        errors,
        'CONVERSATION.interaction.uncertainty',
      );
      assignBoolean(
        uncertainty,
        'offer_next_step',
        interaction.uncertainty,
        errors,
        'CONVERSATION.interaction.uncertainty',
      );
      if (Object.keys(interaction.uncertainty).length === 0) {
        delete interaction.uncertainty;
      }
    }
  }

  if (obj['repair'] !== undefined) {
    const repair = expectObject(obj['repair'], 'CONVERSATION.interaction.repair', errors);
    if (repair) {
      pushUnknownKeys(
        repair,
        new Set(['on_correction', 'on_confusion', 'on_misheard', 'max_attempts']),
        'CONVERSATION.interaction.repair',
        errors,
      );
      interaction.repair = {};
      assignString(
        repair,
        'on_correction',
        interaction.repair,
        errors,
        'CONVERSATION.interaction.repair',
      );
      assignString(
        repair,
        'on_confusion',
        interaction.repair,
        errors,
        'CONVERSATION.interaction.repair',
      );
      assignString(
        repair,
        'on_misheard',
        interaction.repair,
        errors,
        'CONVERSATION.interaction.repair',
      );
      assignNumber(
        repair,
        'max_attempts',
        interaction.repair,
        errors,
        'CONVERSATION.interaction.repair',
      );
      if (Object.keys(interaction.repair).length === 0) {
        delete interaction.repair;
      }
    }
  }

  if (obj['context'] !== undefined) {
    const context = expectObject(obj['context'], 'CONVERSATION.interaction.context', errors);
    if (context) {
      pushUnknownKeys(
        context,
        new Set(['avoid_reasking', 'remember_recent_constraints']),
        'CONVERSATION.interaction.context',
        errors,
      );
      interaction.context = {};
      assignBoolean(
        context,
        'avoid_reasking',
        interaction.context,
        errors,
        'CONVERSATION.interaction.context',
      );
      assignBoolean(
        context,
        'remember_recent_constraints',
        interaction.context,
        errors,
        'CONVERSATION.interaction.context',
      );
      if (Object.keys(interaction.context).length === 0) {
        delete interaction.context;
      }
    }
  }

  return Object.keys(interaction).length > 0 ? interaction : undefined;
}

function parseSimpleStringObject(
  raw: unknown,
  path: string,
  allowedKeys: Set<string>,
  errors: string[],
): Record<string, string> | undefined {
  const obj = expectObject(raw, path, errors);
  if (!obj) return undefined;

  const result: Record<string, string> = {};
  pushUnknownKeys(obj, allowedKeys, path, errors);

  for (const key of allowedKeys) {
    const value = asString(obj[key]);
    if (obj[key] !== undefined && value === undefined) {
      errors.push(`${path}.${key} must be a string.`);
    } else if (value !== undefined) {
      result[key] = value;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function parseOpaqueObject(
  raw: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  return expectObject(raw, path, errors);
}

function normalizeConversationBehaviorValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => normalizeConversationBehaviorValue(item));
  }

  if (value && typeof value === 'object') {
    const normalized: Record<string, unknown> = {};
    for (const [key, nestedValue] of Object.entries(value as Record<string, unknown>)) {
      normalized[key.toLowerCase()] = normalizeConversationBehaviorValue(nestedValue);
    }
    return normalized;
  }

  return value;
}

function expectObject(
  value: unknown,
  path: string,
  errors: string[],
): Record<string, unknown> | undefined {
  const obj = asObject(value);
  if (!obj && value !== undefined) {
    errors.push(`${path} must be an object.`);
  }
  return obj;
}

function pushUnknownKeys(
  obj: Record<string, unknown>,
  allowedKeys: Set<string>,
  path: string,
  errors: string[],
): void {
  for (const key of Object.keys(obj)) {
    if (!allowedKeys.has(key)) {
      errors.push(`${path}.${key} is not a supported Conversation Behavior field.`);
    }
  }
}

function assignString<T extends object>(
  source: Record<string, unknown>,
  key: string,
  target: T,
  errors: string[],
  path: string,
): void {
  if (source[key] === undefined) return;
  const value = asString(source[key]);
  if (value === undefined) {
    errors.push(`${path}.${key} must be a string.`);
    return;
  }
  (target as Record<string, unknown>)[key] = value;
}

function assignBoolean<T extends object>(
  source: Record<string, unknown>,
  key: string,
  target: T,
  errors: string[],
  path: string,
): void {
  if (source[key] === undefined) return;
  const value = asBoolean(source[key]);
  if (value === undefined) {
    errors.push(`${path}.${key} must be a boolean.`);
    return;
  }
  (target as Record<string, unknown>)[key] = value;
}

function assignNumber<T extends object>(
  source: Record<string, unknown>,
  key: string,
  target: T,
  errors: string[],
  path: string,
): void {
  if (source[key] === undefined) return;
  const value = asNumber(source[key]);
  if (value === undefined) {
    errors.push(`${path}.${key} must be a number.`);
    return;
  }
  (target as Record<string, unknown>)[key] = value;
}

// =============================================================================
// UTILITIES
// =============================================================================

function asString(val: unknown): string | undefined {
  if (val === null || val === undefined) return undefined;
  if (typeof val === 'string') return val;
  if (typeof val === 'number' || typeof val === 'boolean') return String(val);
  return undefined;
}

function asDocumentName(val: unknown): string | undefined {
  const scalar = asString(val);
  if (scalar) return scalar;

  const objectValue = asObject(val);
  return asString(objectValue?.['name']);
}

function asObject(val: unknown): Record<string, unknown> | undefined {
  if (!val || typeof val !== 'object' || Array.isArray(val)) return undefined;
  return val as Record<string, unknown>;
}

function asBoolean(val: unknown): boolean | undefined {
  return typeof val === 'boolean' ? val : undefined;
}

function asNumber(val: unknown): number | undefined {
  return typeof val === 'number' ? val : undefined;
}

function asStringArray(val: unknown): string[] | undefined {
  if (!Array.isArray(val)) return undefined;
  return val.filter((item): item is string => typeof item === 'string');
}

function normalizeClearFields(val: unknown): string[] | undefined {
  if (Array.isArray(val)) {
    const fields = val.map((item) => asString(item)).filter((item): item is string => !!item);
    return fields.length > 0 ? fields : undefined;
  }
  const field = asString(val);
  return field ? [field] : undefined;
}

function asStringRecord(val: unknown): Record<string, string> {
  if (!val || typeof val !== 'object') return {};
  const result: Record<string, string> = {};
  for (const [key, v] of Object.entries(val as Record<string, unknown>)) {
    if (v !== null && v !== undefined) {
      result[key] = String(v);
    }
  }
  return result;
}
