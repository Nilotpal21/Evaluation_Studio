/**
 * Prompt Builder
 *
 * Builds system prompts and tool definitions from agent IR.
 * Read-only inspection of IR — no state mutation.
 */

import {
  SYSTEM_TOOL_HANDOFF,
  SYSTEM_TOOL_DELEGATE,
  SYSTEM_TOOL_COMPLETE,
  SYSTEM_TOOL_ESCALATE,
  SYSTEM_TOOL_FAN_OUT,
  SYSTEM_TOOL_SET_CONTEXT,
  SYSTEM_TOOL_RETURN_TO_PARENT,
  SYSTEM_PROMPT_TEMPLATES,
  FAN_OUT_MIN_TASKS,
  FAN_OUT_MAX_TASKS,
  evaluateConditionDual,
  extractVariableReferences,
} from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { AgentIR, HandoffConfig } from '@abl/compiler';
import type { ToolDefinition, ToolPropertySchema } from '../llm/session-llm-client.js';
import type { RuntimeSession, DelegateConfigIR } from './types.js';
import { getActiveThread } from './types.js';
import { interpolateTemplate } from './value-resolution.js';
import { renderTemplate } from './template-engine.js';
import { getPreTurnExecutionView } from './pre-turn-execution-view.js';
import {
  EXECUTION_TREE_NAMESPACE,
  GRANTED_MEMORY_NAMESPACE,
  getWritableExecutionTreePaths,
  getWritableGrantedMemoryKeys,
} from './memory-scope-runtime.js';
import {
  buildConversationBehaviorPromptLines,
  resolveConversationBehavior,
} from './conversation-behavior-resolver.js';
import { AppError, ErrorCodes } from '@agent-platform/shared-kernel';

const log = createLogger('prompt-builder');
import { PromptCatalog, type SystemPromptKey } from './prompt-catalog.js';
import { promptTemplateLoader } from './prompt-template-loader.js';
import { getChannelManifest } from '../../channels/manifest.js';
import {
  getCurrentInteractionContext,
  getCurrentInteractionLanguage,
  getCurrentInteractionLocale,
  getCurrentInteractionTimezone,
} from './interaction-context.js';

/**
 * Check if the session is on a voice channel.
 *
 * Reads from session.channelType (top-level, survives handoffs) first,
 * then falls back to session.data.values.session.channel (may be wiped by handoff).
 *
 * Uses ChannelManifest's isVoice flag for explicit capability detection.
 * Falls back to string prefix check for unknown channel types (forward compatibility).
 */
export function isVoiceChannel(session: RuntimeSession): boolean {
  const channel =
    session.channelType ??
    (session.data?.values?.session as Record<string, unknown> | undefined)?.channel;
  if (typeof channel !== 'string') return false;
  // Manifest lookup — explicit capability check
  const manifest = getChannelManifest(channel);
  if (manifest) return manifest.isVoice;
  // Fallback for unknown channel types: prefix check for forward compatibility
  return channel.startsWith('voice');
}

function isGoogleRealtimeVoiceSession(session: RuntimeSession): boolean {
  if (!isVoiceChannel(session)) {
    return false;
  }

  const sessionNamespace = session.data?.values?.session;
  if (!sessionNamespace || typeof sessionNamespace !== 'object') {
    return false;
  }

  return (sessionNamespace as Record<string, unknown>).s2sProvider === 's2s:google';
}

/** IR ToolParameter shape (avoids importing from @abl/compiler to keep this file light) */
interface IRToolParam {
  name: string;
  type: string;
  description?: string;
  required: boolean;
  default?: unknown;
  enum?: unknown[];
  properties?: IRToolParam[];
  items?: { type: string; enum?: unknown[]; properties?: IRToolParam[] };
}

/**
 * Map an ABL/IR type string to a JSON Schema property descriptor.
 *
 * ABL types: string, integer, number, boolean, date, email, phone, url, object,
 * and array notation (e.g. "string[]", "integer[]").
 * Unrecognised types fall back to `{ type: 'string' }` so the LLM always gets
 * a valid schema.
 *
 * When a full IR ToolParameter is provided (via `param`), enum values,
 * nested object properties, and array item schemas are preserved in the output
 * so the LLM receives constrained schemas instead of bare type stubs.
 */
export function ablTypeToJsonSchema(
  ablType: string,
  description?: string,
  param?: IRToolParam,
): ToolPropertySchema {
  const trimmed = ablType.trim().toLowerCase();
  // Spread default value into the schema when available from the IR.
  // This helps the LLM understand optional params and their fallback values.
  const defaultSpread = param?.default !== undefined ? { default: param.default } : {};

  // Enum — constrained string params get enum values in schema
  if (param?.enum && param.enum.length > 0) {
    return {
      type: 'string',
      enum: param.enum.map(String),
      ...(description ? { description } : {}),
      ...defaultSpread,
    };
  }

  // Array notation: "type[]"
  if (trimmed.endsWith('[]')) {
    const itemType = trimmed.slice(0, -2);
    // If the IR param has nested properties for array items, build a full object schema
    if (param?.items?.properties && param.items.properties.length > 0) {
      const nestedProps: Record<string, ToolPropertySchema> = {};
      const nestedRequired: string[] = [];
      for (const sub of param.items.properties) {
        nestedProps[sub.name] = ablTypeToJsonSchema(sub.type || 'string', sub.description, sub);
        if (sub.required) nestedRequired.push(sub.name);
      }
      return {
        type: 'array',
        ...(description ? { description } : {}),
        ...defaultSpread,
        items: {
          type: 'object',
          properties: nestedProps,
          ...(nestedRequired.length > 0 ? { required: nestedRequired } : {}),
        },
      };
    }
    // If the IR param has nested properties at the param level (object[] with properties)
    if (
      param?.properties &&
      param.properties.length > 0 &&
      (itemType === 'object' || itemType === 'json')
    ) {
      const nestedProps: Record<string, ToolPropertySchema> = {};
      const nestedRequired: string[] = [];
      for (const sub of param.properties) {
        nestedProps[sub.name] = ablTypeToJsonSchema(sub.type || 'string', sub.description, sub);
        if (sub.required) nestedRequired.push(sub.name);
      }
      return {
        type: 'array',
        ...(description ? { description } : {}),
        ...defaultSpread,
        items: {
          type: 'object',
          properties: nestedProps,
          ...(nestedRequired.length > 0 ? { required: nestedRequired } : {}),
        },
      };
    }
    return {
      type: 'array',
      ...(description ? { description } : {}),
      ...defaultSpread,
      items: ablTypeToJsonSchema(itemType),
    };
  }

  // Array from IR items schema
  if (trimmed === 'array' && param?.items) {
    // Handle items with nested properties
    if (param.items.properties && param.items.properties.length > 0) {
      const nestedProps: Record<string, ToolPropertySchema> = {};
      const nestedRequired: string[] = [];
      for (const sub of param.items.properties) {
        nestedProps[sub.name] = ablTypeToJsonSchema(sub.type || 'string', sub.description, sub);
        if (sub.required) nestedRequired.push(sub.name);
      }
      return {
        type: 'array',
        ...(description ? { description } : {}),
        ...defaultSpread,
        items: {
          type: 'object',
          properties: nestedProps,
          ...(nestedRequired.length > 0 ? { required: nestedRequired } : {}),
        },
      };
    }
    const itemSchema: ToolPropertySchema = { type: param.items.type || 'string' };
    if (param.items.enum && param.items.enum.length > 0) {
      itemSchema.enum = param.items.enum.map(String);
    }
    return {
      type: 'array',
      ...(description ? { description } : {}),
      ...defaultSpread,
      items: itemSchema,
    };
  }

  // Object with nested properties from IR
  if (
    (trimmed === 'object' || trimmed === 'json' || trimmed === 'map') &&
    param?.properties &&
    param.properties.length > 0
  ) {
    const nestedProps: Record<string, ToolPropertySchema> = {};
    const nestedRequired: string[] = [];
    for (const sub of param.properties) {
      nestedProps[sub.name] = ablTypeToJsonSchema(sub.type || 'string', sub.description, sub);
      if (sub.required) nestedRequired.push(sub.name);
    }
    return {
      type: 'object',
      ...(description ? { description } : {}),
      ...defaultSpread,
      properties: nestedProps,
      ...(nestedRequired.length > 0 ? { required: nestedRequired } : {}),
    };
  }

  switch (trimmed) {
    case 'integer':
    case 'int':
      return { type: 'integer', ...(description ? { description } : {}), ...defaultSpread };
    case 'number':
    case 'float':
    case 'double':
      return { type: 'number', ...(description ? { description } : {}), ...defaultSpread };
    case 'boolean':
    case 'bool':
      return { type: 'boolean', ...(description ? { description } : {}), ...defaultSpread };
    case 'object':
    case 'json':
    case 'map':
      return { type: 'object', ...(description ? { description } : {}), ...defaultSpread };
    case 'string':
    case 'text':
      return { type: 'string', ...(description ? { description } : {}), ...defaultSpread };
    case 'enum':
      // Enum type from IR without specific values — fall back to string
      return { type: 'string', ...(description ? { description } : {}), ...defaultSpread };
    // Semantic string subtypes — type stays 'string', description carries format hint
    case 'date':
      return {
        type: 'string',
        description: description ? `${description} (ISO 8601 date)` : 'ISO 8601 date',
        ...defaultSpread,
      };
    case 'datetime':
      return {
        type: 'string',
        description: description ? `${description} (ISO 8601 datetime)` : 'ISO 8601 datetime',
        ...defaultSpread,
      };
    case 'email':
      return {
        type: 'string',
        description: description ? `${description} (email address)` : 'Email address',
        ...defaultSpread,
      };
    case 'phone':
      return {
        type: 'string',
        description: description ? `${description} (phone number)` : 'Phone number',
        ...defaultSpread,
      };
    case 'url':
      return {
        type: 'string',
        description: description ? `${description} (URL)` : 'URL',
        ...defaultSpread,
      };
    case 'attachment':
      return {
        type: 'string',
        description: description
          ? `${description} (must be a valid attachment ID from this session)`
          : 'Attachment ID (must be a valid attachment ID from this session)',
        ...defaultSpread,
      };
    default:
      // Unknown type — fall back to string
      return { type: 'string', ...(description ? { description } : {}), ...defaultSpread };
  }
}

/**
 * Resolve which system prompt template to use based on agent type and capabilities.
 */
function resolveTemplateKey(ir: AgentIR | null, hasHandoffs: boolean): SystemPromptKey {
  if (!ir) return 'fallback';
  const isSupervisor = ir.metadata?.type === 'supervisor';
  if (isSupervisor) {
    return ir.routing?.direct_response_allowed ? 'supervisor_direct' : 'supervisor';
  }
  return hasHandoffs ? 'specialist' : 'standalone';
}

/**
 * Keys excluded from the `## Current Context` JSON block in the system prompt.
 * These are either duplicated (input is already in the user message) or
 * infrastructure metadata consumed server-side (auto-injected into tools,
 * resolved in CALL expressions, overridden in HANDOFF CONTEXT.pass).
 * Exposing them to the LLM wastes tokens and leaks internal platform IDs.
 */
const CONTEXT_EXCLUDED_KEYS = new Set([
  'input',
  'session_id',
  'tenant_id',
  'project_id',
  'user_id',
  'session',
  EXECUTION_TREE_NAMESPACE,
  GRANTED_MEMORY_NAMESPACE,
  'env',
  'intent',
]);

const CONTEXT_EXCLUDED_PREFIXES = ['last_search_kb_', 'last_browse_kb_'];

interface PromptInteractionContext {
  language?: string;
  locale?: string;
  timezone?: string;
  source?: string;
  confidence?: string;
}

function buildPromptInteractionContext(
  session: RuntimeSession,
): PromptInteractionContext | undefined {
  const interaction = getCurrentInteractionContext(session.data);
  const interactionLanguage = getCurrentInteractionLanguage(session.data);
  const interactionLocale = getCurrentInteractionLocale(session.data);
  const interactionTimezone = getCurrentInteractionTimezone(session.data);

  if (
    !interactionLanguage &&
    !interactionLocale &&
    !interactionTimezone &&
    !interaction?.source &&
    !interaction?.confidence
  ) {
    return undefined;
  }

  return {
    ...(interactionLanguage ? { language: interactionLanguage } : {}),
    ...(interactionLocale ? { locale: interactionLocale } : {}),
    ...(interactionTimezone ? { timezone: interactionTimezone } : {}),
    ...(interaction?.source ? { source: interaction.source } : {}),
    ...(interaction?.confidence ? { confidence: interaction.confidence } : {}),
  };
}

export type SystemPromptSectionId =
  | 'base'
  | 'custom_base'
  | 'channel_instructions'
  | 'additional_constraints'
  | 'conversation_behavior'
  | 'status_protocol';

export interface SystemPromptSection {
  id: SystemPromptSectionId;
  text: string;
  runtimeProtocol?: boolean;
}

function appendSystemPromptSections(parts: string[], sections: SystemPromptSection[]): void {
  for (const section of sections) {
    parts.push(section.text);
  }
}

function buildEffectiveConfigPromptSections(session: RuntimeSession): SystemPromptSection[] {
  const sections: SystemPromptSection[] = [];

  if (session._effectiveConfig?.additionalInstructions?.length) {
    const lines = [`\n## Channel-Specific Instructions`];
    for (const instr of session._effectiveConfig.additionalInstructions) {
      lines.push(instr);
    }
    sections.push({ id: 'channel_instructions', text: lines.join('\n') });
  }

  if (session._effectiveConfig?.additionalConstraints?.length) {
    const lines = [`\n## Additional Constraints`];
    for (const constraint of session._effectiveConfig.additionalConstraints) {
      lines.push(`- ${constraint.condition}`);
    }
    sections.push({ id: 'additional_constraints', text: lines.join('\n') });
  }

  const resolvedConversationBehavior =
    session._effectiveConfig?.conversationBehavior ??
    (session.agentIR?.conversation_behavior
      ? resolveConversationBehavior({
          baseBehavior: session.agentIR.conversation_behavior,
          activeProfiles: [],
          channelType: session.channelType ?? 'digital',
        })
      : undefined);

  if (!resolvedConversationBehavior) {
    return sections;
  }

  const interaction = buildPromptInteractionContext(session);
  const lines = buildConversationBehaviorPromptLines(resolvedConversationBehavior, {
    interactionLanguage: interaction?.language,
    interactionLocale: interaction?.locale,
    interactionTimezone: interaction?.timezone,
  });

  if (lines.length === 0) {
    return sections;
  }

  sections.push({
    id: 'conversation_behavior',
    text: [`\n## Conversation Behavior`, ...lines.map((line) => `- ${line}`)].join('\n'),
  });

  return sections;
}

function appendEffectiveConfigSections(parts: string[], session: RuntimeSession): void {
  appendSystemPromptSections(parts, buildEffectiveConfigPromptSections(session));
}

function buildStatusProtocolPromptSection(
  session: RuntimeSession,
): SystemPromptSection | undefined {
  if (session._fillerEnabled === false || isVoiceChannel(session)) {
    return undefined;
  }

  return {
    id: 'status_protocol',
    text: STATUS_TAG_INSTRUCTION,
    runtimeProtocol: true,
  };
}

/**
 * Build the full template context from session state.
 * All dynamic sections (context, memory, voice, constraints) are included
 * as context variables — the template handles conditional rendering via {{#if}}.
 */
function buildTemplateContext(session: RuntimeSession): Record<string, unknown> {
  const ir = session.agentIR;
  if (!ir) return { name: session.agentName };
  const preTurnView = getPreTurnExecutionView(session);
  const interpolationValues = buildPromptInterpolationValues(session, preTurnView);

  const name = ir.metadata?.name || session.agentName;
  const goal = ir.identity?.goal ? interpolateTemplate(ir.identity.goal, interpolationValues) : '';
  const persona = ir.identity?.persona
    ? interpolateTemplate(ir.identity.persona, interpolationValues)
    : '';
  const limitations =
    ir.identity?.limitations && ir.identity.limitations.length > 0
      ? ir.identity.limitations
          .map((l) => `- ${interpolateTemplate(l, interpolationValues)}`)
          .join('\n')
      : '';
  const effectiveTools = session._effectiveConfig?.tools ?? ir.tools;
  const has_tools = effectiveTools && effectiveTools.length > 0;
  const gather_fields = ir.gather?.fields?.length
    ? ir.gather.fields
        .map((field) => {
          const fieldName = typeof field === 'string' ? field : field.name;
          const prompt = typeof field === 'string' ? field : field.prompt || field.name;
          const required = typeof field === 'string' ? true : field.required !== false;
          return `- ${fieldName}: ${prompt}${required ? ' (required)' : ' (optional)'}`;
        })
        .join('\n')
    : '';
  const routing_rules = ir.routing?.rules
    ? ir.routing.rules
        .map(
          (rule) =>
            `- Priority ${rule.priority}: **${rule.to}**: ${conditionToDescription(rule.when, rule.to, rule.description)}`,
        )
        .join('\n')
    : '';
  const handoff_rules = ir.coordination?.handoffs
    ? ir.coordination.handoffs
        .map((h) => `- **${h.to}**: ${conditionToDescription(h.when, h.to, h.context?.summary)}`)
        .join('\n')
    : '';
  const escalation = Boolean(ir.coordination?.escalation);
  const escalation_triggers = ir.coordination?.escalation?.triggers
    ? ir.coordination.escalation.triggers
        .map((t) => `- ${t.reason} (priority: ${t.priority})`)
        .join('\n')
    : '';

  // Dynamic sections — part of the template context, not appended after
  const interactionContext = buildPromptInteractionContext(session);
  const interaction_language = interactionContext?.language ?? '';
  const interaction_locale = interactionContext?.locale ?? '';
  const interaction_timezone = interactionContext?.timezone ?? '';
  const contextValues = buildVisibleContextValues(session, preTurnView);

  // Extract conversationSummary as a dedicated template variable so it renders
  // in its own ## Previous Conversation Summary section instead of being buried
  // in the generic context JSON blob.
  const conversation_summary =
    typeof contextValues.conversationSummary === 'string' && contextValues.conversationSummary
      ? contextValues.conversationSummary
      : '';
  if (conversation_summary) {
    delete contextValues.conversationSummary;
  }

  const context_json =
    Object.keys(contextValues).length > 0 ? JSON.stringify(contextValues, null, 2) : '';
  const session_memory_json =
    preTurnView && Object.keys(preTurnView.memory.session).length > 0
      ? JSON.stringify(preTurnView.memory.session, null, 2)
      : '';
  const execution_tree_json =
    preTurnView && Object.keys(preTurnView.memory.executionTree).length > 0
      ? JSON.stringify(preTurnView.memory.executionTree, null, 2)
      : '';
  const granted_memory_json =
    preTurnView && Object.keys(preTurnView.memory.granted).length > 0
      ? JSON.stringify(preTurnView.memory.granted, null, 2)
      : '';
  const gather_progress_json =
    preTurnView && Object.keys(preTurnView.memory.gather).length > 0
      ? JSON.stringify(preTurnView.memory.gather, null, 2)
      : '';
  const policy_json = preTurnView?.policy ? JSON.stringify(preTurnView.policy, null, 2) : '';

  const recallPrompts = session.data.values._recallPrompts;
  const recall_prompts =
    Array.isArray(recallPrompts) && recallPrompts.length > 0
      ? recallPrompts.filter((p) => typeof p === 'string').join('\n')
      : '';

  const constraintWarnings = session.data.values._constraint_warnings;
  const constraint_warnings =
    Array.isArray(constraintWarnings) && constraintWarnings.length > 0
      ? constraintWarnings
          .filter((w) => typeof w === 'string')
          .map((w) => `- ${w}`)
          .join('\n')
      : '';

  // Validation errors — surface to LLM so it asks for correction instead of echoing
  const validationErrors = session.data.values._validation_errors;
  const validation_errors =
    validationErrors && typeof validationErrors === 'object' && !Array.isArray(validationErrors)
      ? Object.entries(validationErrors as Record<string, string>)
          .map(([field, error]) => `- ${field}: ${error}`)
          .join('\n')
      : '';

  const voice_channel = isVoiceChannel(session);
  const voice_format_rules = voice_channel
    ? ir.identity?.voice_response_rules || PromptCatalog.voiceFormatRules
    : '';

  // Inline gather context: surface collected/missing fields to LLM
  const inline_gather = ir?.execution?.inline_gather === true;
  const inline_gather_fields = inline_gather && ir?.gather?.fields?.length ? ir.gather.fields : [];
  let inline_gather_status = '';
  if (inline_gather && inline_gather_fields.length > 0) {
    const collected: string[] = [];
    const needed: string[] = [];
    for (const field of inline_gather_fields) {
      const fName = typeof field === 'string' ? field : field.name;
      const fPrompt = typeof field === 'string' ? field : field.prompt || field.name;
      const fRequired = typeof field === 'string' ? true : field.required !== false;
      const val = session.data?.values?.[fName];
      if (val !== undefined && val !== null && val !== '') {
        collected.push(`${fName}: ${JSON.stringify(val)}`);
      } else {
        // Show both required and optional uncollected fields so the LLM
        // can extract them opportunistically via _extract_entities
        const label = fRequired ? fPrompt : `${fPrompt} (optional)`;
        needed.push(`${fName}: ${label}`);
      }
    }
    const parts: string[] = [];
    if (collected.length > 0)
      parts.push(`Already collected:\n${collected.map((c) => `- ${c}`).join('\n')}`);
    if (needed.length > 0) parts.push(`Still needed:\n${needed.map((n) => `- ${n}`).join('\n')}`);
    if (parts.length > 0) {
      inline_gather_status = parts.join('\n\n');
    }
  }

  return {
    name,
    goal,
    persona,
    limitations,
    has_tools,
    gather_fields,
    routing_rules,
    handoff_rules,
    handoff_tool: '', // Deprecated — per-agent tools used instead
    escalate_tool: SYSTEM_TOOL_ESCALATE,
    fan_out_tool: '', // Deprecated — per-agent tools used instead
    escalation,
    escalation_triggers,
    conversation_summary,
    context_json,
    session_memory_json,
    execution_tree_json,
    granted_memory_json,
    gather_progress_json,
    policy_json,
    recall_prompts,
    constraint_warnings,
    validation_errors,
    voice_channel,
    voice_format_rules,
    inline_gather,
    inline_gather_status,
    interactionContext: interactionContext ?? {},
    runtime_interaction: interactionContext ?? {},
    interaction_language,
    interaction_locale,
    interaction_timezone,
    interaction_source: interactionContext?.source ?? '',
    interaction_confidence: interactionContext?.confidence ?? '',

    // Citation support: enabled when agent has searchai tools with citations not explicitly disabled.
    // Uses conservative logic: if ANY tool has citationConfig.enabled === false, disable for all.
    citations_enabled: (() => {
      const searchAiToolExecutor = session._searchaiToolExecutor;
      if (!searchAiToolExecutor) return false;
      if (
        typeof searchAiToolExecutor.getToolBindings !== 'function' ||
        typeof searchAiToolExecutor.getDiscoveryManifestForTool !== 'function'
      ) {
        return false;
      }

      const toolNames = Array.from(searchAiToolExecutor.getToolBindings().keys());
      if (toolNames.length === 0) return false;
      for (const toolName of toolNames) {
        const manifest = searchAiToolExecutor.getDiscoveryManifestForTool(toolName);
        if (manifest?.citationConfig?.enabled === false) return false;
      }
      return true;
    })(),
  };
}

function buildVisibleContextValues(
  session: RuntimeSession,
  preTurnView?: ReturnType<typeof getPreTurnExecutionView>,
): Record<string, unknown> {
  const excludedKeys = new Set(CONTEXT_EXCLUDED_KEYS);

  for (const key of Object.keys(preTurnView?.memory.session ?? {})) {
    excludedKeys.add(key);
  }
  for (const key of session.agentIR?.memory?.persistent
    ?.filter((entry) => (entry.scope as string) === 'execution_tree')
    .map((entry) => entry.path) ?? []) {
    excludedKeys.add(key);
  }
  for (const key of Object.keys(preTurnView?.memory.granted ?? {})) {
    excludedKeys.add(key);
  }
  for (const key of Object.keys(preTurnView?.memory.gather ?? {})) {
    excludedKeys.add(key);
  }

  const contextValues = Object.fromEntries(
    Object.entries(session.data.values).filter(
      ([k]) =>
        !k.startsWith('_') &&
        !excludedKeys.has(k) &&
        !CONTEXT_EXCLUDED_PREFIXES.some((prefix) => k.startsWith(prefix)),
    ),
  );
  const interactionContext = buildPromptInteractionContext(session);

  if (interactionContext) {
    contextValues.interactionContext = interactionContext;
  }

  return contextValues;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function mergeTemplateProjection(
  target: Record<string, unknown>,
  projection: Record<string, unknown>,
): void {
  for (const [key, value] of Object.entries(projection)) {
    if (isPlainObject(value) && isPlainObject(target[key])) {
      mergeTemplateProjection(target[key] as Record<string, unknown>, value);
      continue;
    }

    target[key] = structuredClone(value);
  }
}

function buildPromptInterpolationValues(
  session: RuntimeSession,
  preTurnView?: ReturnType<typeof getPreTurnExecutionView>,
): Record<string, unknown> {
  const values = { ...session.data.values };
  if (!isGoogleRealtimeVoiceSession(session)) {
    return values;
  }

  const executionTreeProjection = session.data.values[EXECUTION_TREE_NAMESPACE];
  const grantedMemoryProjection = session.data.values[GRANTED_MEMORY_NAMESPACE];

  if (isPlainObject(executionTreeProjection)) {
    mergeTemplateProjection(values, executionTreeProjection);
  }

  if (isPlainObject(grantedMemoryProjection)) {
    mergeTemplateProjection(values, grantedMemoryProjection);
  }

  if (preTurnView && Object.keys(preTurnView.memory.executionTree).length > 0) {
    mergeTemplateProjection(values, preTurnView.memory.executionTree);
  }

  return values;
}

function buildConversationHistoryText(
  conversationHistory: RuntimeSession['conversationHistory'],
): string {
  if (!conversationHistory || conversationHistory.length === 0) {
    return '';
  }

  return conversationHistory
    .map((message) => {
      const role =
        message.role === 'user' ? 'User' : message.role === 'system' ? 'System' : 'Assistant';
      const text =
        typeof message.content === 'string'
          ? message.content
          : message.content
              .map((block) => (block.type === 'text' ? (block.text ?? '') : `[${block.type}]`))
              .join(' ');
      return `${role}: ${text}`;
    })
    .join('\n');
}

function templateReferencesVariable(template: string, variableName: string): boolean {
  const escaped = variableName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const direct = new RegExp(`\\{\\{\\s*${escaped}(?:\\.\\w+)*(?:\\s*\\|\\s*\\w+)?\\s*\\}\\}`);
  const jinjaIf = new RegExp(`\\{%-?\\s*if\\s+${escaped}(?:\\.\\w+)*\\s*%}`);
  const handlebarsIf = new RegExp(`\\{\\{#if\\s+${escaped}(?:\\.\\w+)*\\s*\\}\\}`);
  const handlebarsEach = new RegExp(`\\{\\{#each\\s+${escaped}(?:\\.\\w+)*\\s*\\}\\}`);

  return (
    direct.test(template) ||
    jinjaIf.test(template) ||
    handlebarsIf.test(template) ||
    handlebarsEach.test(template)
  );
}

function stringifyTemplateValue(value: unknown): string {
  if (Array.isArray(value)) {
    return JSON.stringify(value, null, 2);
  }
  if (value && typeof value === 'object') {
    return JSON.stringify(value, null, 2);
  }
  return value !== undefined ? String(value) : '';
}

function preprocessCustomPromptTemplate(
  template: string,
  templateVars: Record<string, unknown>,
): string {
  let processed = template;
  const jinjaEnabledVars = new Set(['tools', 'context', 'history']);

  // Support the small Jinja subset already used by the S2S router so custom
  // prompts behave consistently for the S2S-specific variables we expose.
  processed = processed.replace(
    /\{%-?\s*if\s+(\w+)\s*%}([\s\S]*?)\{%-?\s*endif\s*%}/g,
    (_match, varName: string, blockContent: string) => {
      if (!jinjaEnabledVars.has(varName)) {
        return _match;
      }
      const value = templateVars[varName];
      const isEmpty =
        value === null ||
        value === undefined ||
        value === '' ||
        (typeof value === 'object' && Object.keys(value as Record<string, unknown>).length === 0);
      return isEmpty ? '' : blockContent;
    },
  );

  processed = processed.replace(
    /\{\{\s*(\w+)\s*\|\s*(\w+)\s*\}\}/g,
    (_match, varName: string, filterName: string) => {
      if (!jinjaEnabledVars.has(varName)) {
        return _match;
      }
      const value = templateVars[varName];
      if (filterName === 'tojson' || filterName === 'json') {
        return JSON.stringify(value, null, 2);
      }
      if (filterName === 'upper') {
        return value !== undefined ? String(value).toUpperCase() : '';
      }
      if (filterName === 'lower') {
        return value !== undefined ? String(value).toLowerCase() : '';
      }
      return value !== undefined ? String(value) : '';
    },
  );

  processed = processed.replace(/\{\{\s*(context)\s*\}\}/g, (_match, varName: string) => {
    return stringifyTemplateValue(templateVars[varName]);
  });

  return processed;
}

function collectPreTurnPromptSections(
  session: RuntimeSession,
  contextValues?: Record<string, unknown>,
): string[] {
  const parts: string[] = [];
  const preTurnView = getPreTurnExecutionView(session);

  if (!preTurnView) {
    if (contextValues && Object.keys(contextValues).length > 0) {
      parts.push(`\n## Current Context`);
      parts.push(JSON.stringify(contextValues, null, 2));
    }
    return parts;
  }

  if (Object.keys(preTurnView.memory.session).length > 0) {
    parts.push(`\n## Session Memory`);
    parts.push(JSON.stringify(preTurnView.memory.session, null, 2));
  }

  if (Object.keys(preTurnView.memory.executionTree).length > 0) {
    parts.push(`\n## Execution Tree Memory`);
    parts.push(JSON.stringify(preTurnView.memory.executionTree, null, 2));
  }

  if (Object.keys(preTurnView.memory.granted).length > 0) {
    parts.push(`\n## Granted Memory`);
    parts.push(JSON.stringify(preTurnView.memory.granted, null, 2));
  }

  if (Object.keys(preTurnView.memory.gather).length > 0) {
    parts.push(`\n## Gather Progress`);
    parts.push(JSON.stringify(preTurnView.memory.gather, null, 2));
  }

  if (preTurnView.policy) {
    parts.push(`\n## Current Policy`);
    parts.push(JSON.stringify(preTurnView.policy, null, 2));
  }

  if (contextValues && Object.keys(contextValues).length > 0) {
    parts.push(`\n## Current Context`);
    parts.push(JSON.stringify(contextValues, null, 2));
  }

  return parts;
}

export function buildPreTurnPromptSections(session: RuntimeSession): string {
  const preTurnView = getPreTurnExecutionView(session);
  const contextValues = buildVisibleContextValues(session, preTurnView);
  return collectPreTurnPromptSections(session, contextValues).join('\n');
}

/**
 * Build system prompt for agents with custom SYSTEM_PROMPT: in DSL.
 * Uses interpolateTemplate (simple {{var}} substitution) for the user-authored template,
 * then appends dynamic sections (context, memory, constraints) based on sections config.
 */
function buildCustomSystemPrompt(session: RuntimeSession, ir: AgentIR): string {
  const T = SYSTEM_PROMPT_TEMPLATES;
  const name = ir.metadata?.name || session.agentName;
  const customParts: string[] = [];
  const interactionContext = buildPromptInteractionContext(session);
  const preTurnView = getPreTurnExecutionView(session);
  const interpolationValues = buildPromptInterpolationValues(session, preTurnView);
  const template = ir.identity!.system_prompt!.template!;
  const usesToolsVariable = templateReferencesVariable(template, 'tools');
  const usesContextVariable = templateReferencesVariable(template, 'context');
  const usesHistoryVariable = templateReferencesVariable(template, 'history');
  const effectiveTools = usesToolsVariable ? buildTools(session) : [];
  const contextValues = buildVisibleContextValues(session, preTurnView);
  const templateVars = {
    ...interpolationValues,
    name,
    goal: ir.identity?.goal ? interpolateTemplate(ir.identity.goal, interpolationValues) : '',
    persona: ir.identity?.persona
      ? interpolateTemplate(ir.identity.persona, interpolationValues)
      : '',
    context: contextValues,
    tools: effectiveTools.map((tool) => ({
      name: tool.name,
      description: tool.description,
    })),
    history: usesHistoryVariable ? buildConversationHistoryText(session.conversationHistory) : '',
    interactionContext: interactionContext ?? {},
    runtime_interaction: interactionContext ?? {},
    interaction_language: interactionContext?.language ?? '',
    interaction_locale: interactionContext?.locale ?? '',
    interaction_timezone: interactionContext?.timezone ?? '',
    interaction_source: interactionContext?.source ?? '',
    interaction_confidence: interactionContext?.confidence ?? '',
  };
  customParts.push(
    interpolateTemplate(preprocessCustomPromptTemplate(template, templateVars), templateVars),
  );

  // Still append dynamic sections based on sections config
  const sections = ir.identity!.system_prompt!.sections || {};
  if (sections.context !== false) {
    const projectedSections = collectPreTurnPromptSections(
      session,
      usesContextVariable ? undefined : contextValues,
    ).join('\n');
    if (projectedSections) {
      customParts.push(projectedSections);
    }
  }

  const recallPrompts = session.data.values._recallPrompts;
  if (Array.isArray(recallPrompts) && recallPrompts.length > 0) {
    customParts.push(T.memory_header);
    for (const instruction of recallPrompts) {
      if (typeof instruction === 'string') {
        customParts.push(instruction);
      }
    }
  }

  // Inject constraint warnings (non-blocking WARN constraints that failed)
  const constraintWarnings = session.data.values._constraint_warnings;
  if (Array.isArray(constraintWarnings) && constraintWarnings.length > 0) {
    customParts.push(
      '\n⚠️ ACTIVE WARNINGS (inform the user about these, but do not block their request):',
    );
    for (const warning of constraintWarnings) {
      if (typeof warning === 'string') {
        customParts.push(`- ${warning}`);
      }
    }
  }

  // Inject validation errors so the LLM asks for correction
  const validationErrors = session.data.values._validation_errors;
  if (
    validationErrors &&
    typeof validationErrors === 'object' &&
    !Array.isArray(validationErrors)
  ) {
    const entries = Object.entries(validationErrors as Record<string, string>);
    if (entries.length > 0) {
      customParts.push(
        '\n⚠️ VALIDATION ERRORS — The user provided values that failed validation. Ask them to correct these specific fields:',
      );
      for (const [field, error] of entries) {
        customParts.push(`- ${field}: ${error}`);
      }
      customParts.push(
        'Do NOT echo or confirm the invalid values. Instead, explain what is wrong and ask for a corrected value.',
      );
    }
  }

  appendEffectiveConfigSections(customParts, session);

  return customParts.join('\n');
}

/**
 * Build system prompt from agent IR.
 *
 * Resolution chain: DB override (via promptTemplateLoader) → PromptCatalog fallback.
 * Template is rendered in a single pass with renderTemplate() — no piece-by-piece assembly.
 * Custom SYSTEM_PROMPT: in DSL bypasses templates entirely.
 */
function buildSystemPromptSections(session: RuntimeSession): SystemPromptSection[] {
  const ir = session.agentIR;

  // Guard: libraryRef present but template empty means the version was compiled without resolving
  // the ref (e.g., version created before the hook was deployed, or resolution was skipped).
  if (ir?.identity?.system_prompt?.libraryRef && !ir.identity.system_prompt.template) {
    log.warn('Agent has prompt library ref but empty template — misconfigured version', {
      promptId: ir.identity.system_prompt.libraryRef.promptId,
      versionId: ir.identity.system_prompt.libraryRef.versionId,
      agentName: session.agentName,
    });
    throw new AppError(
      'Agent system prompt configuration is incomplete. Please re-compile the agent version.',
      { ...ErrorCodes.INTERNAL_ERROR, code: 'PROMPT_LIBRARY_TEMPLATE_MISSING' },
    );
  }

  // Custom system prompt override — bypasses catalog templates entirely
  if (ir?.identity?.system_prompt?.custom && ir.identity.system_prompt.template) {
    return [{ id: 'custom_base', text: buildCustomSystemPrompt(session, ir) }];
  }

  const hasHandoffs = (ir?.coordination?.handoffs?.length ?? 0) > 0;
  const templateKey = resolveTemplateKey(ir, hasHandoffs);

  // Load template: DB override → catalog fallback
  const template = promptTemplateLoader.getSystemPrompt(templateKey);
  const context = buildTemplateContext(session);

  // Single-pass render — no more piece-by-piece assembly
  const sections: SystemPromptSection[] = [{ id: 'base', text: renderTemplate(template, context) }];

  sections.push(...buildEffectiveConfigPromptSections(session));

  const statusProtocolSection = buildStatusProtocolPromptSection(session);
  if (statusProtocolSection) {
    sections.push(statusProtocolSection);
  }

  return sections;
}

export function buildSystemPrompt(session: RuntimeSession): string {
  return buildSystemPromptSections(session)
    .map((section) => section.text)
    .join('\n');
}

export interface CanonicalVoicePromptSurface {
  systemPrompt: string;
  tools: ToolDefinition[];
}

/**
 * Build the canonical prompt/tool surface used by voice channels before any
 * mode-specific shaping is applied.
 */
export function buildCanonicalVoicePromptSurface(
  session: RuntimeSession,
): CanonicalVoicePromptSurface {
  return {
    systemPrompt: buildSystemPrompt(session),
    tools: buildTools(session),
  };
}

/**
 * System prompt instruction for LLM status tags.
 * Lightweight (~50 words) — does not significantly impact token budget.
 */
const STATUS_TAG_INSTRUCTION = `
Before each tool call, emit a brief status message wrapped in <status>...</status> tags.
This message will be shown to the user while the tool executes. Keep it under 15 words,
natural, and specific to what you are about to do. Do NOT ask questions in status messages.
Example: <status>Searching for red sneakers under 500 AED</status>`.trim();

/**
 * Convert a ABL condition expression to natural language description
 */
export function conditionToDescription(
  condition: string | undefined,
  target: string,
  summary?: string,
): string {
  // If we have a summary from the ABL, prefer that
  if (summary) {
    return summary;
  }

  if (!condition) {
    return `Route here when appropriate for ${target.replace(/_/g, ' ')}`;
  }

  // Try to match and combine multiple conditions using centralized catalog patterns
  const descriptions: string[] = [];

  for (const mapping of PromptCatalog.conditionPatterns.mappings) {
    if (mapping.pattern.test(condition)) {
      descriptions.push(mapping.description);
    }
  }

  if (descriptions.length > 0) {
    return descriptions.join('; ');
  }

  // Fallback: clean up the condition for display
  const cleaned = condition
    .replace(
      /intent\.category\s*==\s*["'](\w+)["']/gi,
      (_m, p1: string) => `user intent is "${p1.replace(/_/g, ' ')}"`,
    )
    .replace(/user\.(\w+)\s*==\s*true/gi, 'user $1')
    .replace(/user\.(\w+)\s*==\s*false/gi, 'user has not $1')
    .replace(/\s*AND\s*/gi, ' and ')
    .replace(/\s*OR\s*/gi, ' or ')
    .replace(/NOT\s+/gi, 'not ');

  return cleaned || `Route to ${target.replace(/_/g, ' ')}`;
}

export function getReasoningZoneSettableContextVars(
  session: RuntimeSession,
): Array<{ name: string; type?: string; description?: string }> {
  const stepName = session.currentFlowStep;
  if (!stepName) {
    return [];
  }

  const step = session.agentIR?.flow?.definitions?.[stepName];
  const exitWhen = step?.reasoning_zone?.exit_when;
  if (!exitWhen) {
    return [];
  }

  return extractVariableReferences(exitWhen).map((name) => ({
    name,
    type: 'string',
    description: `Reasoning-zone exit state for FLOW step "${stepName}".`,
  }));
}

/**
 * Build tools array from agent IR (including action tools).
 *
 * All string descriptions are resolved through promptTemplateLoader (DB override → catalog fallback).
 * Dynamic fields (target enums, context PASS fields, session var types) are injected at runtime.
 */
export function buildTools(session: RuntimeSession): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const ir = session.agentIR;
  const loader = promptTemplateLoader;
  const preTurnView = getPreTurnExecutionView(session);
  const allowedToolNames = preTurnView ? new Set(preTurnView.tools.allowedToolNames) : undefined;

  // Skip system tools from IR — they are added with richer descriptions below
  const SYSTEM_TOOLS = new Set([
    SYSTEM_TOOL_HANDOFF,
    SYSTEM_TOOL_DELEGATE,
    SYSTEM_TOOL_COMPLETE,
    SYSTEM_TOOL_ESCALATE,
    SYSTEM_TOOL_FAN_OUT,
    SYSTEM_TOOL_SET_CONTEXT,
  ]);

  // Shared descriptions used across multiple tools
  const reasonDesc = loader.getSharedDescription('reason');
  // Resolution priority: session-level resolved value (from model resolution:
  // Agent IR → Agent DB → Project DB) takes precedence, falling back to IR value.
  const enableThinking = session.resolvedEnableThinking ?? ir?.execution?.enable_thinking;
  const thinkingBudget = session.resolvedThinkingBudget ?? ir?.execution?.thinking_budget;
  // Thought description resolution: project override → session-level (IR → Agent DB → Project DB) → catalog default
  const baseThoughtDesc =
    session.promptOverrides?.['tool_description.shared.thought'] ??
    session.resolvedThoughtDescription ??
    loader.getSharedDescription('thought');
  // When a thinking budget is set, append the budget constraint to the base description.
  // This preserves the user's project-level override while adding the token limit.
  const thoughtDesc = thinkingBudget
    ? `${baseThoughtDesc}. Keep your reasoning within ${thinkingBudget} tokens.`
    : baseThoughtDesc;

  // Use effective config tools (profile-modified) if available, otherwise base IR tools
  const irTools = session._effectiveConfig?.tools ?? ir?.tools;

  // Add regular tools from IR
  if (irTools) {
    for (const tool of irTools) {
      if (SYSTEM_TOOLS.has(tool.name)) continue;
      if (allowedToolNames && !allowedToolNames.has(tool.name)) continue;

      // ── Tier-aware param selection for SearchAI tools ──────────────
      // For non-advanced KBs, strip heavy params (aggregation, rerank,
      // skipPreprocessing, etc.) to cut ~400 tokens from the LLM schema.
      // Before discovery completes, defaults to 'simple' tier for the
      // fastest possible first LLM call.
      let toolParams = tool.parameters;
      if (tool.tool_type === 'searchai' && toolParams) {
        const tier = session._searchaiToolTiers?.get(tool.name) ?? 'simple';
        if (tier !== 'advanced') {
          const keepParams =
            tier === 'simple'
              ? new Set(['query', 'queryType', 'topK', 'top_k'])
              : new Set(['query', 'queryType', 'topK', 'top_k', 'filters']);
          toolParams = toolParams.filter((p) => {
            const name = typeof p === 'string' ? p : p.name;
            return keepParams.has(name);
          });
        }
      }

      const properties: Record<string, ToolPropertySchema> =
        toolParams?.reduce(
          (acc, param) => {
            const paramName = typeof param === 'string' ? param : param.name;
            const paramType = typeof param === 'string' ? 'string' : param.type || 'string';
            let paramDesc = typeof param === 'string' ? paramName : param.description;
            const irParam: IRToolParam | undefined = typeof param === 'string' ? undefined : param;

            // Simplify verbose SearchAI param descriptions for non-advanced tiers
            if (tool.tool_type === 'searchai') {
              const tier = session._searchaiToolTiers?.get(tool.name) ?? 'simple';
              if (tier !== 'advanced') {
                if (paramName === 'queryType') {
                  paramDesc = 'Use "hybrid" for best results. Default: hybrid.';
                } else if (paramName === 'filters') {
                  paramDesc =
                    'Metadata filters. Array of {field, operator, value}. ' +
                    'Operators: equals, contains, in. ' +
                    'Only add when the user gives a concrete value.';
                }
              }
            }

            acc[paramName] = ablTypeToJsonSchema(paramType, paramDesc || paramName, irParam);
            return acc;
          },
          {} as Record<string, ToolPropertySchema>,
        ) || {};
      // Inject implicit 'thought' parameter when extended thinking is enabled
      if (enableThinking) {
        properties.thought = { type: 'string', description: thoughtDesc };
      }
      const toolRequired =
        toolParams
          ?.filter((p) => {
            if (typeof p === 'string') return true;
            // Params with defaults are not required in the LLM schema —
            // the executor injects defaults at execution time if omitted.
            if (p.default !== undefined) return false;
            return p.required !== false;
          })
          .map((p) => (typeof p === 'string' ? p : p.name)) || [];
      // When thinking is enabled, thought is required alongside reason
      if (enableThinking) {
        toolRequired.push('thought');
      }
      tools.push({
        name: tool.name,
        description: tool.description || `Execute the ${tool.name} tool`,
        input_schema: {
          type: 'object',
          properties,
          required: toolRequired,
        },
      });
    }
  }

  // ── Per-agent routing tools (replaces generic __handoff__/__delegate__/__fan_out__) ──
  // Each routing/handoff/delegate target gets its own tool with a descriptive name,
  // dedicated description, and typed input schema. This gives the LLM a strong signal
  // for routing — tool NAME is matched to intent, not an enum value in a generic tool.
  const perAgentTools = buildPerAgentTools(ir, session, enableThinking, reasonDesc, thoughtDesc);
  tools.push(...perAgentTools);

  // Routing authority is derived from the active IR at execution time.
  // Prompt building must stay read-only and never mutate session state.

  // COMPLETE tool removed (Option C): Completion is now runtime-evaluated after
  // each reasoning turn, not LLM-triggered. See checkAndMarkComplete().

  // Add ESCALATE tool when escalation is configured in IR or when the
  // compiler placed __escalate__ in the tool list (default for reasoning agents).
  // This ensures system tools survive profile-based tool filtering.
  const hasEscalateInIR = ir?.tools?.some((t) => t.name === SYSTEM_TOOL_ESCALATE);
  if (ir?.coordination?.escalation || hasEscalateInIR) {
    const escalateProperties: Record<string, ToolPropertySchema> = {
      reason: {
        type: 'string',
        description: reasonDesc,
      },
      priority: {
        type: 'string',
        description: loader.getToolDescription('escalate', 'priority'),
        enum: ['low', 'medium', 'high', 'critical'],
      },
    };
    if (enableThinking) {
      escalateProperties.thought = {
        type: 'string',
        description: thoughtDesc,
      };
    }

    tools.push({
      name: SYSTEM_TOOL_ESCALATE,
      description: loader.getToolDescription('escalate', 'runtime'),
      input_schema: {
        type: 'object',
        properties: escalateProperties,
        required: enableThinking ? ['reason', 'thought'] : ['reason'],
      },
    });
  }

  // Add RETURN_TO_PARENT tool when agent is a child invoked via RETURN:true handoff
  const activeThread = getActiveThread(session);
  const hasParentThread = (session.threadStack?.length ?? 0) > 0;
  if (activeThread?.returnExpected && activeThread?.handoffFrom && hasParentThread) {
    tools.push({
      name: SYSTEM_TOOL_RETURN_TO_PARENT,
      description: `Return control to your supervisor (${activeThread.handoffFrom}). Use ONLY when the user asks something outside your capabilities. Do NOT use for requests you can handle.`,
      input_schema: {
        type: 'object',
        properties: {
          reason: {
            type: 'string',
            description: 'Why you cannot handle this request',
          },
          message: {
            type: 'string',
            description: 'The user message to forward to your supervisor for re-routing',
          },
        },
        required: ['reason', 'message'],
      },
    });
  }

  // Add SET_CONTEXT tool when agent has session memory variables declared
  const sessionVars =
    ir?.memory?.session
      ?.map((s: string | { name: string; type?: string; description?: string }) =>
        typeof s === 'string' ? { name: s } : s,
      )
      .filter((s) => s.name) ?? [];
  const reasoningZoneVars = getReasoningZoneSettableContextVars(session);
  const executionTreeVarNames = getWritableExecutionTreePaths(session);
  const grantedMemoryVarNames = getWritableGrantedMemoryKeys(session);
  const settableContextKeys = Array.from(
    new Set([
      ...sessionVars.map((s) => s.name),
      ...reasoningZoneVars.map((s) => s.name),
      ...executionTreeVarNames,
      ...grantedMemoryVarNames,
    ]),
  );

  if (settableContextKeys.length > 0) {
    const executionTreeProperties = Object.fromEntries(
      executionTreeVarNames.map((path) => [path, { type: 'string' } as ToolPropertySchema]),
    );
    const grantedMemoryProperties = Object.fromEntries(
      grantedMemoryVarNames.map((path) => [path, { type: 'string' } as ToolPropertySchema]),
    );
    const setContextProperties: Record<string, ToolPropertySchema> = {
      updates: {
        type: 'object',
        description:
          loader.getToolDescription('set_context', 'updates') +
          ' Valid keys: ' +
          settableContextKeys.join(', '),
        properties: Object.fromEntries([
          ...sessionVars.map((s) => [
            s.name,
            ablTypeToJsonSchema(s.type || 'string', s.description),
          ]),
          ...reasoningZoneVars.map((s) => [
            s.name,
            ablTypeToJsonSchema(s.type || 'string', s.description),
          ]),
          ...Object.entries(executionTreeProperties),
          ...Object.entries(grantedMemoryProperties),
        ]),
      },
    };
    if (enableThinking) {
      setContextProperties.thought = {
        type: 'string',
        description: thoughtDesc,
      };
    }

    tools.push({
      name: SYSTEM_TOOL_SET_CONTEXT,
      description: loader.getToolDescription('set_context', 'runtime'),
      input_schema: {
        type: 'object',
        properties: setContextProperties,
        required: enableThinking ? ['thought', 'updates'] : ['updates'],
      },
    });
  }

  // ── Workflow status companion tool (auto-injected for async workflow tools) ──
  if (session._workflowStatusToolActive) {
    const statusProperties: Record<string, ToolPropertySchema> = {
      executionId: {
        type: 'string',
        description:
          'The execution ID returned by a previous async workflow tool call. Use this to check if the workflow has completed and retrieve its output.',
      },
    };
    const required = ['executionId'];
    if (enableThinking) {
      statusProperties.thought = { type: 'string', description: thoughtDesc };
      required.push('thought');
    }
    tools.push({
      name: 'check_workflow_status',
      description:
        'Check the status of an asynchronous workflow execution. Returns the current status (running, completed, failed) and output if available.',
      input_schema: {
        type: 'object',
        properties: statusProperties,
        required,
      },
    });
  }

  return tools;
}

// =============================================================================
// PER-AGENT ROUTING TOOLS
// =============================================================================

/**
 * Build per-agent routing tools from IR routing rules, handoff configs, and delegate configs.
 *
 * Instead of generic __handoff__/__delegate__/__fan_out__ tools with flat enum targets,
 * each target agent gets its own tool (e.g. `handoff_to_Sales_Agent`, `delegate_to_Fee_Calculator`).
 * This gives the LLM a strong signal for routing — tool NAME is matched to intent directly.
 */
function buildPerAgentTools(
  ir: AgentIR | null | undefined,
  session: RuntimeSession,
  enableThinking: boolean | undefined,
  reasonDesc: string,
  thoughtDesc: string,
): ToolDefinition[] {
  const tools: ToolDefinition[] = [];
  const seen = new Set<string>(); // Dedup by tool name

  // From ROUTING rules (supervisors) → handoff_to_X
  // Rules are sorted by priority (lower number = higher priority) so the LLM
  // sees the most important routing targets first in its tool list.
  if (ir?.routing?.rules) {
    const sortedRules = [...ir.routing.rules].sort(
      (a, b) => (a.priority ?? Infinity) - (b.priority ?? Infinity),
    );
    for (const rule of sortedRules) {
      const toolName = `handoff_to_${rule.to}`;
      if (seen.has(toolName)) continue;

      // Pre-evaluate WHEN condition: skip tool if condition is deterministically false
      if (rule.when && session.data?.values) {
        const vars = extractVariableReferences(rule.when);
        // Check the full dotted path exists (not just the root) to avoid CEL errors
        // when session has stale objects missing expected keys (e.g. intent without category).
        const allVarsPresent = vars.every((v) => {
          if (!v.includes('.')) return v in session.data.values;
          const parts = v.split('.');
          let cur: unknown = session.data.values;
          for (const part of parts) {
            if (cur == null || typeof cur !== 'object') return false;
            if (!(part in (cur as Record<string, unknown>))) return false;
            cur = (cur as Record<string, unknown>)[part];
          }
          return true;
        });
        if (allVarsPresent) {
          const conditionMet = evaluateConditionDual(rule.when, session.data.values);
          if (!conditionMet) continue;
        }
      }

      seen.add(toolName);

      tools.push({
        name: toolName,
        description: buildHandoffDescription(rule, ir),
        input_schema: buildHandoffInputSchema(rule, ir, enableThinking, reasonDesc, thoughtDesc),
      });
    }
  }

  // From HANDOFF coordination (regular agents) → handoff_to_X
  if (ir?.coordination?.handoffs) {
    for (const handoff of ir.coordination.handoffs) {
      const toolName = `handoff_to_${handoff.to}`;
      if (seen.has(toolName)) {
        continue;
      }

      // Pre-evaluate WHEN condition: skip tool if condition is deterministically false
      if (handoff.when && session.data?.values) {
        const vars = extractVariableReferences(handoff.when);
        // Check the full dotted path exists (not just the root) to avoid CEL errors
        // when session has stale objects missing expected keys.
        const allVarsPresent = vars.every((v) => {
          if (!v.includes('.')) return v in session.data.values;
          const parts = v.split('.');
          let cur: unknown = session.data.values;
          for (const part of parts) {
            if (cur == null || typeof cur !== 'object') return false;
            if (!(part in (cur as Record<string, unknown>))) return false;
            cur = (cur as Record<string, unknown>)[part];
          }
          return true;
        });
        if (allVarsPresent) {
          const conditionMet = evaluateConditionDual(handoff.when, session.data.values);
          if (!conditionMet) continue;
        }
      }

      seen.add(toolName);

      tools.push({
        name: toolName,
        description: buildHandoffDescription(handoff, ir),
        input_schema: buildHandoffInputSchema(handoff, ir, enableThinking, reasonDesc, thoughtDesc),
      });
    }
  }

  // From DELEGATE coordination → delegate_to_X
  if (ir?.coordination?.delegates) {
    const delegateConfigs = ir.coordination.delegates as DelegateConfigIR[];
    for (const delegate of delegateConfigs) {
      const toolName = `delegate_to_${delegate.agent}`;
      if (seen.has(toolName)) continue;
      seen.add(toolName);

      tools.push({
        name: toolName,
        description: buildDelegateDescription(delegate),
        input_schema: buildDelegateInputSchema(delegate, enableThinking, reasonDesc, thoughtDesc),
      });
    }
  }

  return tools;
}

/** Build a rich description for a handoff/routing target. */
function buildHandoffDescription(
  rule: {
    to: string;
    when?: string;
    description?: string;
    return?: boolean;
    priority?: number;
    context?: { summary?: string };
  },
  ir: AgentIR | null | undefined,
): string {
  const parts: string[] = [];

  // Priority signal for routing tiebreaking (lower number = higher priority)
  if (rule.priority != null) parts.push(`[Priority ${rule.priority}]`);

  // Agent description from routing rule or handoff config
  const desc = rule.description || (rule.context as any)?.summary || '';
  if (desc) parts.push(desc);

  // WHEN condition as guidance for the LLM
  if (rule.when) parts.push(`Use when: ${rule.when}`);

  // RETURN behavior
  const returns = (rule as any).return === true;
  if (returns) parts.push('This agent returns control after completion.');

  return parts.join('. ') || `Route to ${rule.to}`;
}

/** Build typed input schema for a handoff/routing tool with per-agent PASS fields. */
function buildHandoffInputSchema(
  rule: { to: string; context?: { pass?: any[] } },
  ir: AgentIR | null | undefined,
  enableThinking: boolean | undefined,
  reasonDesc: string,
  thoughtDesc: string,
): { type: 'object'; properties: Record<string, ToolPropertySchema>; required: string[] } {
  const properties: Record<string, ToolPropertySchema> = {
    reason: { type: 'string', description: reasonDesc },
    message: {
      type: 'string',
      description:
        'The user request or sub-request this agent should handle. Extract the relevant part of the user message.',
    },
  };

  if (enableThinking) {
    properties.thought = { type: 'string', description: thoughtDesc };
  }

  // Add typed pass fields from CONTEXT.pass, resolved against MEMORY.session declarations
  const passFields = rule.context?.pass ?? [];
  for (const field of passFields) {
    if (typeof field === 'string') {
      // Legacy string format — look up in session memory for type info
      const sessionVar = ir?.memory?.session?.find((v: any) => v.name === field);
      properties[field] = {
        type: (sessionVar?.type as string) || 'string',
        description: (sessionVar?.description as string) || `Context: ${field}`,
      };
    } else if (field && typeof field === 'object' && field.name) {
      // ResolvedPassField format
      properties[field.name] = {
        type: field.type || 'string',
        description: field.description || `Context: ${field.name}`,
      };
    }
  }

  const required = enableThinking ? ['reason', 'thought', 'message'] : ['reason', 'message'];

  return { type: 'object' as const, properties, required };
}

/** Build a description for a delegate target. */
function buildDelegateDescription(delegate: DelegateConfigIR): string {
  const parts: string[] = [];
  if (delegate.purpose) parts.push(delegate.purpose);
  if (delegate.when) parts.push(`Use when: ${delegate.when}`);
  parts.push('Runs to completion and returns a result you can use.');
  return parts.join('. ');
}

/** Build typed input schema for a delegate tool with per-agent INPUT fields. */
function buildDelegateInputSchema(
  delegate: DelegateConfigIR,
  enableThinking: boolean | undefined,
  reasonDesc: string,
  thoughtDesc: string,
): { type: 'object'; properties: Record<string, ToolPropertySchema>; required: string[] } {
  const properties: Record<string, ToolPropertySchema> = {
    reason: { type: 'string', description: reasonDesc },
    message: {
      type: 'string',
      description:
        'Instruction for the sub-agent — describe what it should do with the input data.',
    },
  };

  if (enableThinking) {
    properties.thought = { type: 'string', description: thoughtDesc };
  }

  // Add typed input fields from DELEGATE.INPUT mapping
  if (delegate.input) {
    for (const [key, sourceVar] of Object.entries(delegate.input)) {
      properties[key] = {
        type: 'string',
        description: `Input: ${key} (mapped from ${sourceVar})`,
      };
    }
  }

  const required = enableThinking ? ['reason', 'thought', 'message'] : ['reason', 'message'];

  return { type: 'object' as const, properties, required };
}
