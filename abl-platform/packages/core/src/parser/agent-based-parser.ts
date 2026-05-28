/**
 * Parser for Agent-Based ABL
 *
 * Parses the new agent-based ABL syntax into an AgentBasedDocument AST.
 */

import * as yaml from 'js-yaml';

import type {
  AgentBasedDocument,
  ExecutionConfigAST,
  AgentMessages,
  HooksConfig,
  HookAction,
  ToolHintsAST,
  FlowDefinition,
  FlowStep,
  ToolInvocationAST,
  FlowGatherConfig,
  FlowGatherField,
  Digression,
  DigressionActionAST,
  SubIntent,
  SetAssignment,
  TransformConfig,
  AgentGoal,
  AgentPersona,
  AgentLimitation,
  AgentTool,
  ToolImport,
  GatherField,
  EntityDefinition,
  MemoryConfig,
  SessionMemoryVar,
  PersistentMemoryPath,
  RememberTrigger,
  RecallInstruction,
  ConstraintPhase,
  ConstraintRequirement,
  GuardrailDefinition,
  DelegateConfig,
  HandoffConfig,
  HandoffContext,
  HandoffOnReturnConfig,
  EscalateConfig,
  EscalateTrigger,
  EscalateContextItem,
  OnHumanCompleteAction,
  CompleteCondition,
  ErrorHandler,
  StartHandler,
  NLUDefinition,
  NLUIntentDefinition,
  NLUCategoryDefinition,
  NLUEntityDefinition,
  NLUModelConfig,
  NLUEvalConfig,
  NLUEmbeddingsConfig,
  VoiceConfigAST,
  RichContentAST,
  QuickReplyAST,
  ListItemAST,
  TableColumnAST,
  ChartDataPointAST,
  ActionElementAST,
  ActionSetAST,
  ActionHandlerActionAST,
  ActionHandlerAST,
  CarouselAST,
  CarouselCardAST,
  TemplateDefinition,
  AttachmentFieldAST,
  AttachmentCategory,
  DestinationAST,
  MultiIntentConfig,
  LookupTableDefinition,
  BehaviorProfileAST,
  BehaviorProfileResponseAST,
  BehaviorProfileGatherAST,
  BehaviorProfileFlowAST,
  IntentDefinition,
  IntentSectionConfig,
  IntentLexicalFallbackMode,
  ReturnHandlerDefinition,
} from '../types/agent-based.js';
import {
  parseDefaultValue,
  parseToolParams,
  parseToolReturn,
  splitParams,
} from './tool-parser-utils.js';
import { parseToolProperties, applyParameterEnrichments } from './tool-file-parser.js';
import { isYamlFormat, parseYamlABL, parseConversationBehaviorData } from './yaml-parser.js';
import { splitConstraintInlineClauses } from './constraint-before.js';

// =============================================================================
// IMPLEMENTATION PROPERTIES NOT ALLOWED IN AGENT DSL TOOLS SECTION
// =============================================================================
// These properties belong in project tool definitions, not in agent DSL.
// Only signature-level properties (description, type) are allowed.
const TOOL_IMPLEMENTATION_PROPERTIES = new Set([
  // HTTP binding
  'endpoint',
  'method',
  'auth',
  'auth_config',
  'headers',
  'timeout',
  'retry',
  'retry_delay',
  'rate_limit',
  'circuit_breaker',
  'protocol',
  'soap_version',
  'soap_action',
  'on_soap_fault',
  // Sandbox binding
  'code',
  'runtime',
  'memory_mb',
  // MCP binding
  'server',
  'server_tool',
]);

// =============================================================================
// PARSER STATE
// =============================================================================

interface ParserState {
  lines: string[];
  currentLine: number;
  errors: ParseError[];
  warnings: ParseWarning[];
}

interface ParseError {
  line: number;
  column: number;
  message: string;
}

interface ParseWarning {
  line: number;
  message: string;
}

// =============================================================================
// MAIN PARSER
// =============================================================================

export interface ParseResult {
  document: AgentBasedDocument | null;
  errors: ParseError[];
  warnings: ParseWarning[];
}

/**
 * Parse agent-based ABL content into an AST
 */
export function parseAgentBasedABL(content: string): ParseResult {
  // Defensive guard: callers may hand us a value that was nulled or replaced
  // upstream (e.g., legacy-encrypted documents). Surface it as a structured
  // parse error rather than a TypeError on `.trim()` deeper in the parser.
  if (typeof content !== 'string') {
    return {
      document: null,
      errors: [
        {
          line: 1,
          column: 1,
          message: `Cannot parse non-string ABL source (received ${content === null ? 'null' : typeof content}).`,
        },
      ],
      warnings: [],
    };
  }
  // Auto-detect YAML format and delegate to YAML parser
  if (isYamlFormat(content)) {
    const yamlResult = parseYamlABL(content);
    return {
      document: yamlResult.document,
      errors: yamlResult.errors.map((e) => ({
        line: e.line,
        column: e.column,
        message: e.message,
      })),
      warnings: yamlResult.warnings.map((w) => ({
        line: w.line,
        message: w.message,
      })),
    };
  }

  const state: ParserState = {
    lines: content.split('\n'),
    currentLine: 0,
    errors: [],
    warnings: [],
  };

  try {
    const document = parseDocument(state);
    return {
      document,
      errors: state.errors,
      warnings: state.warnings,
    };
  } catch (error) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: error instanceof Error ? error.message : 'Unknown parse error',
    });
    return {
      document: null,
      errors: state.errors,
      warnings: state.warnings,
    };
  }
}

// =============================================================================
// DOCUMENT PARSER
// =============================================================================

function addDuplicateSectionError(
  state: ParserState,
  sectionName: string,
  firstSeenLine: number,
): void {
  state.errors.push({
    line: state.currentLine + 1,
    column: 0,
    message: `Duplicate section ${sectionName}: first declared on line ${firstSeenLine}. Only one ${sectionName} block is allowed per agent.`,
  });
}

function mergeMemoryConfig(
  state: ParserState,
  existing: MemoryConfig,
  parsed: MemoryConfig,
): MemoryConfig {
  return {
    session: appendUniqueByKey(
      state,
      'MEMORY SESSION',
      existing.session,
      parsed.session,
      (entry) => entry.name,
    ),
    persistent: appendUniqueByKey(
      state,
      'MEMORY PERSISTENT',
      existing.persistent,
      parsed.persistent,
      (entry) => entry.path,
    ),
    remember: [...existing.remember, ...parsed.remember],
    recall: [...existing.recall, ...parsed.recall],
  };
}

function appendUniqueByKey<T>(
  state: ParserState,
  sectionName: string,
  existing: T[],
  parsed: T[],
  getKey: (item: T) => string,
): T[] {
  const result = [...existing];
  const seenKeys = existing.map(getKey);

  for (const item of parsed) {
    const key = getKey(item);
    if (seenKeys.includes(key)) {
      state.errors.push({
        line: state.currentLine,
        column: 0,
        message: `Duplicate ${sectionName} entry "${key}". Entries in repeated ${sectionName}: blocks must have unique names.`,
      });
      continue;
    }
    seenKeys.push(key);
    result.push(item);
  }

  return result;
}

function mergeUniqueRecord<T>(
  state: ParserState,
  sectionName: string,
  existing: Record<string, T>,
  parsed: Record<string, T>,
): Record<string, T> {
  const result = { ...existing };
  for (const [key, value] of Object.entries(parsed)) {
    if (Object.prototype.hasOwnProperty.call(result, key)) {
      state.errors.push({
        line: state.currentLine,
        column: 0,
        message: `Duplicate ${sectionName} entry "${key}". Entries in repeated ${sectionName}: blocks must have unique names.`,
      });
      continue;
    }
    result[key] = value;
  }
  return result;
}

function parseDocument(state: ParserState): AgentBasedDocument {
  const doc: Partial<AgentBasedDocument> = {
    meta: {
      id: crypto.randomUUID(),
      kind: 'agent-based',
      version: '1.0.0',
      name: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    },
    // mode is no longer set — deprecated
    limitations: [],
    tools: [],
    gather: [],
    memory: {
      session: [],
      persistent: [],
      remember: [],
      recall: [],
    },
    constraints: [],
    guardrails: [], // Initialize guardrails array
    flow: undefined,
    delegate: [],
    handoff: [],
    returnHandlers: {},
    complete: [],
    onError: [],
  };

  let hasFlowSection = false;
  const singletonSectionFirstLines: Record<string, number> = {};
  const claimSingletonSection = (sectionName: string): boolean => {
    const firstSeenLine = singletonSectionFirstLines[sectionName];
    if (firstSeenLine !== undefined) {
      addDuplicateSectionError(state, sectionName, firstSeenLine);
      return false;
    }
    singletonSectionFirstLines[sectionName] = state.currentLine + 1;
    return true;
  };

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine].trim();

    // Skip empty lines and comments (# or // or /* ... */)
    if (!line || line.startsWith('#') || line.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Skip block comments: /* ... */
    if (line.startsWith('/*')) {
      // Single-line block comment: /* ... */
      if (line.endsWith('*/')) {
        state.currentLine++;
        continue;
      }
      // Multi-line block comment: consume until closing */
      state.currentLine++;
      while (state.currentLine < state.lines.length) {
        const blockLine = state.lines[state.currentLine].trim();
        state.currentLine++;
        if (blockLine.endsWith('*/')) break;
      }
      continue;
    }

    // Parse section headers
    if (line.startsWith('AGENT:')) {
      if (claimSingletonSection('AGENT/SUPERVISOR:')) {
        doc.name = line.substring(6).trim();
        doc.meta!.name = doc.name;
      }
      state.currentLine++;
    } else if (line.startsWith('SUPERVISOR:')) {
      if (claimSingletonSection('AGENT/SUPERVISOR:')) {
        doc.name = line.substring(11).trim();
        doc.meta!.name = doc.name;
        doc.meta!.kind = 'supervisor';
      }
      state.currentLine++;
    } else if (line.startsWith('BEHAVIOR_PROFILE:')) {
      const profileName = line.substring(17).trim();

      if (doc.name && doc.meta!.kind !== 'behavior_profile') {
        // Inline BEHAVIOR_PROFILE inside an agent — do NOT overwrite identity
        if (!profileName) {
          state.errors.push({
            line: state.currentLine + 1,
            column: 1,
            message: 'Inline BEHAVIOR_PROFILE requires a name (e.g., BEHAVIOR_PROFILE: my_profile)',
          });
          state.currentLine++;
        } else {
          const INLINE_PROFILE_KEYWORDS = new Set([
            'PRIORITY',
            'WHEN',
            'INSTRUCTIONS',
            'CONVERSATION',
          ]);
          state.currentLine++;
          const inlineProfile = parseBehaviorProfile(state.lines, state.currentLine, state.errors, {
            allowedTopLevelSections: INLINE_PROFILE_KEYWORDS,
          });
          // Advance state.currentLine past the profile's consumed lines
          // parseBehaviorProfile reads from startLine to the next top-level section or EOF.
          // We need to figure out how many lines it consumed.
          // Advance state.currentLine past the inline profile body.
          // For inline profiles, only profile-body sections are consumed here.
          // Any other top-level section (TOOLS, CONSTRAINTS, GUARDRAILS, etc.) marks the
          // end of the inline profile and should be re-parsed by the main loop.
          let consumed = state.currentLine;
          const seenInlineProfileSections = new Set<string>();
          while (consumed < state.lines.length) {
            const profileLine = state.lines[consumed];
            const trimmedLine = profileLine.trim();
            // Skip empty lines and comments
            if (!trimmedLine || trimmedLine.startsWith('#') || trimmedLine.startsWith('//')) {
              consumed++;
              continue;
            }
            // Stop at any top-level section that isn't an inline profile keyword
            if (profileLine === profileLine.trimStart() && /^[A-Z_]+:/i.test(trimmedLine)) {
              const sectionName = trimmedLine.replace(/:.*$/, '').toUpperCase();
              if (!INLINE_PROFILE_KEYWORDS.has(sectionName)) {
                break;
              }
              if (seenInlineProfileSections.has(sectionName)) {
                break;
              }
              seenInlineProfileSections.add(sectionName);
            }
            consumed++;
          }
          state.currentLine = consumed;

          if (!doc.inlineBehaviorProfiles) {
            doc.inlineBehaviorProfiles = [];
          }
          doc.inlineBehaviorProfiles.push({ ...inlineProfile, name: profileName });
        }
      } else {
        // Standalone BEHAVIOR_PROFILE file — original behavior
        doc.name = profileName;
        doc.meta!.name = doc.name;
        doc.meta!.kind = 'behavior_profile';
        state.currentLine++;
        doc.behaviorProfile = parseBehaviorProfile(state.lines, state.currentLine, state.errors);
        state.currentLine = state.lines.length;
      }
    } else if (line.startsWith('VERSION:')) {
      // Store in document meta (strip surrounding quotes)
      if (claimSingletonSection('VERSION:')) {
        doc.meta!.version = line
          .substring(8)
          .trim()
          .replace(/^"|"$/g, '') as import('../types/base.js').Version;
      }
      state.currentLine++;
    } else if (line.startsWith('DESCRIPTION:')) {
      // Store in document meta (strip surrounding quotes, support multi-line |)
      const shouldAssign = claimSingletonSection('DESCRIPTION:');
      const rawDesc = line.substring(12).trim();
      if (rawDesc === '|') {
        state.currentLine++;
        const parsedDescription = parseMultiLineString(state);
        if (shouldAssign) {
          doc.meta!.description = parsedDescription;
        }
      } else {
        if (shouldAssign) {
          doc.meta!.description = rawDesc.replace(/^"|"$/g, '');
        }
        state.currentLine++;
      }
    } else if (line.startsWith('MODE:')) {
      // MODE is deleted — emit error and skip
      state.errors.push({
        line: state.currentLine,
        column: 0,
        message:
          'MODE is no longer supported. Execution style is declared per-step with REASONING: true/false. Remove the MODE: line.',
      });
      state.currentLine++;
    } else if (line.startsWith('LANGUAGE:')) {
      if (claimSingletonSection('LANGUAGE:')) {
        doc.language = line.substring(9).trim().replace(/^"|"$/g, '');
      }
      state.currentLine++;
    } else if (line === 'GOAL:' || line.startsWith('GOAL:')) {
      const shouldAssign = claimSingletonSection('GOAL:');
      const parsedGoal = parseGoal(state);
      if (shouldAssign) {
        doc.goal = parsedGoal;
      }
    } else if (line === 'PERSONA:' || line.startsWith('PERSONA:')) {
      const shouldAssign = claimSingletonSection('PERSONA:');
      const parsedPersona = parsePersona(state);
      if (shouldAssign) {
        doc.persona = parsedPersona;
      }
    } else if (line === 'IDENTITY:') {
      const shouldAssign = claimSingletonSection('IDENTITY:');
      const identity = parseIdentity(state);
      if (shouldAssign) {
        // Map IDENTITY fields to goal/persona/limitations
        if (identity.role) {
          doc.goal = { description: identity.role };
        }
        if (identity.persona) {
          doc.persona = { description: identity.persona };
        }
        if (identity.expertise && identity.expertise.length > 0) {
          // Store expertise in persona description
          if (doc.persona) {
            doc.persona.description += ` Expertise: ${identity.expertise.join(', ')}`;
          }
        }
        doc.limitations = identity.limitations.map((l) => ({ description: l }));
      }
    } else if (line === 'LIMITATIONS:') {
      doc.limitations = parseLimitations(state);
    } else if (line === 'CONVERSATION:') {
      const shouldAssign = claimSingletonSection('CONVERSATION:');
      const parsedConversation = parseConversationBehaviorSection(state);
      if (shouldAssign) {
        doc.conversation = parsedConversation;
      }
    } else if (line === 'TOOLS:') {
      const toolsResult = parseTools(state);
      doc.tools = appendUniqueByKey(
        state,
        'TOOLS',
        doc.tools || [],
        toolsResult.tools,
        (tool) => tool.name,
      );
      if (toolsResult.imports.length > 0) {
        doc.toolImports = [...(doc.toolImports || []), ...toolsResult.imports];
      }
    } else if (line === 'GATHER:') {
      doc.gather = [...(doc.gather || []), ...parseGather(state)];
    } else if (line === 'ATTACHMENTS:') {
      doc.attachments = [...(doc.attachments || []), ...parseAttachments(state)];
    } else if (line === 'DESTINATIONS:') {
      doc.destinations = [...(doc.destinations || []), ...parseDestinations(state)];
    } else if (line === 'MEMORY:') {
      doc.memory = mergeMemoryConfig(state, doc.memory!, parseMemory(state));
    } else if (line === 'CONSTRAINTS:') {
      doc.constraints = [...(doc.constraints || []), ...parseConstraints(state)];
    } else if (line === 'FLOW:') {
      const shouldAssign = claimSingletonSection('FLOW/STEPS:');
      const parsedFlow = parseFlow(state);
      if (shouldAssign) {
        doc.flow = parsedFlow;
        hasFlowSection = true;
      }
    } else if (line === 'STEPS:') {
      const shouldAssign = claimSingletonSection('FLOW/STEPS:');
      const parsedSteps = parseSteps(state);
      if (shouldAssign) {
        doc.flow = parsedSteps;
      }
    } else if (line === 'DELEGATE:') {
      doc.delegate = [...(doc.delegate || []), ...parseDelegate(state)];
    } else if (line === 'HANDOFF:') {
      doc.handoff = [...(doc.handoff || []), ...parseHandoff(state)];
    } else if (line === 'RETURN_HANDLERS:') {
      doc.returnHandlers = mergeUniqueRecord(
        state,
        'RETURN_HANDLERS',
        doc.returnHandlers || {},
        parseReturnHandlers(state),
      );
    } else if (line === 'ESCALATE:') {
      const shouldAssign = claimSingletonSection('ESCALATE:');
      const parsedEscalate = parseEscalate(state);
      if (shouldAssign) {
        doc.escalate = parsedEscalate;
      }
    } else if (line === 'COMPLETE:') {
      doc.complete = [...(doc.complete || []), ...parseComplete(state)];
    } else if (line === 'ON_ERROR:') {
      doc.onError = [...(doc.onError || []), ...parseOnError(state)];
    } else if (line === 'ON_START:') {
      const shouldAssign = claimSingletonSection('ON_START:');
      const parsedOnStart = parseOnStart(state);
      if (shouldAssign) {
        doc.onStart = parsedOnStart;
      }
    } else if (line === 'GUARDRAILS:') {
      doc.guardrails = [...(doc.guardrails || []), ...parseGuardrailDefinitions(state)];
    } else if (line === 'EXECUTION:') {
      const shouldAssign = claimSingletonSection('EXECUTION:');
      const parsedExecution = parseExecutionConfig(state);
      if (shouldAssign) {
        doc.execution = parsedExecution;
      }
    } else if (line === 'MESSAGES:') {
      const shouldAssign = claimSingletonSection('MESSAGES:');
      const parsedMessages = parseMessages(state);
      if (shouldAssign) {
        doc.messages = parsedMessages;
      }
    } else if (line === 'HOOKS:') {
      const shouldAssign = claimSingletonSection('HOOKS:');
      const parsedHooks = parseHooks(state);
      if (shouldAssign) {
        doc.hooks = parsedHooks;
      }
    } else if (line === 'ACTION_HANDLERS:') {
      const ahIndent = getIndent(state.lines[state.currentLine]);
      doc.actionHandlers = [...(doc.actionHandlers || []), ...parseOnActionBlock(state, ahIndent)];
    } else if (line === 'TEMPLATES:') {
      const parsed = parseTemplatesBlock(state);
      doc.templates = [...(doc.templates || []), ...parsed];
    } else if (line.startsWith('TEMPLATE ') && line.includes(':')) {
      const parsed = parseStandaloneTemplate(state);
      if (parsed) {
        if (!doc.templates) doc.templates = [];
        doc.templates.push(parsed);
      }
    } else if (line === 'MULTI_INTENT:') {
      const shouldAssign = claimSingletonSection('MULTI_INTENT:');
      const parsedMultiIntent = parseMultiIntentSection(state);
      if (shouldAssign) {
        doc.multiIntent = parsedMultiIntent;
      }
    } else if (line === 'LOOKUP_TABLES:') {
      doc.lookupTables = mergeUniqueRecord(
        state,
        'LOOKUP_TABLES',
        doc.lookupTables || {},
        parseLookupTables(state),
      );
    } else if (
      line.startsWith('USE BEHAVIOR_PROFILE:') ||
      line.startsWith('USE_BEHAVIOR_PROFILE:')
    ) {
      const colonIdx = line.indexOf(':');
      const profileName = line
        .substring(colonIdx + 1)
        .trim()
        .replace(/^"|"$/g, '');
      if (profileName) {
        if (!doc.useBehaviorProfiles) doc.useBehaviorProfiles = [];
        doc.useBehaviorProfiles.push(profileName);
      }
      state.currentLine++;
    } else if (line === 'PRIORITY:' || line.startsWith('PRIORITY:')) {
      // Part of behavior_profile document — parse the whole profile body
      if (doc.meta!.kind === 'behavior_profile') {
        doc.behaviorProfile = parseBehaviorProfile(state.lines, state.currentLine);
        // Advance past all remaining lines (parseBehaviorProfile consumes the rest)
        state.currentLine = state.lines.length;
      } else {
        state.errors.push({
          line: state.currentLine,
          column: 0,
          message: 'PRIORITY: is only valid inside BEHAVIOR_PROFILE documents.',
        });
        state.currentLine++;
      }
    } else if (line === 'WHEN:' || line.startsWith('WHEN:')) {
      // Part of behavior_profile document — parse the whole profile body
      if (doc.meta!.kind === 'behavior_profile') {
        doc.behaviorProfile = parseBehaviorProfile(state.lines, state.currentLine);
        state.currentLine = state.lines.length;
      } else {
        state.errors.push({
          line: state.currentLine,
          column: 0,
          message: 'WHEN: at top level is only valid inside BEHAVIOR_PROFILE documents.',
        });
        state.currentLine++;
      }
    } else if (line === 'ENTITIES:') {
      doc.entities = [...(doc.entities || []), ...parseEntitiesSection(state)];
    } else if (line === 'NLU:') {
      const shouldAssign = claimSingletonSection('NLU:');
      const parsedNlu = parseNLUSection(state);
      if (shouldAssign) {
        doc.nlu = parsedNlu;
      }
    } else if (line === 'SYSTEM_PROMPT:') {
      const shouldAssign = claimSingletonSection('SYSTEM_PROMPT:');
      state.currentLine++;
      const parsedSystemPrompt = parseMultiLineString(state);
      if (shouldAssign) {
        doc.systemPrompt = parsedSystemPrompt;
      }
    } else if (line === 'INSTRUCTIONS:' || line.startsWith('INSTRUCTIONS:')) {
      // INSTRUCTIONS: maps to additional goal description
      const instructions = parseInstructions(state);
      if (instructions) {
        if (doc.goal && doc.goal.description) {
          doc.goal.description += '\n\nInstructions:\n' + instructions;
        } else {
          doc.goal = { description: instructions };
        }
      }
    } else if (line === 'TESTS:') {
      parseTests(state); // Skip tests section for now
    } else if (line === 'AGENTS:') {
      parseAgentsSection(state); // For supervisor files
    } else if (line === 'INTENTS:') {
      const parsedIntents = parseIntentsSection(state);
      doc.intents = [...(doc.intents || []), ...parsedIntents.intents];
      if (Object.keys(parsedIntents.config).length > 0) {
        doc.intentConfig = {
          ...(doc.intentConfig || {}),
          ...parsedIntents.config,
        };
      }
    } else {
      // Unknown section — produce helpful error
      const sectionName = line.replace(/:.*$/, ':');
      if (sectionName === 'MODEL:') {
        state.errors.push({
          line: state.currentLine,
          column: 0,
          message: `Unknown section MODEL: — use EXECUTION: with "model:" property instead. Example:\n  EXECUTION:\n    model: ${line.substring(6).trim() || 'claude-sonnet-4-5-20250929'}`,
        });
      } else if (sectionName === 'ROUTING:') {
        state.errors.push({
          line: state.currentLine,
          column: 0,
          message: `Unknown section ROUTING: — use HANDOFF: with "- TO:" entries instead. Example:\n  HANDOFF:\n    - TO: Agent_Name\n      WHEN: condition`,
        });
      } else {
        // Check if this is a known section with wrong casing (e.g., "tools:" instead of "TOOLS:")
        const knownSections = [
          'AGENT',
          'SUPERVISOR',
          'BEHAVIOR_PROFILE',
          'VERSION',
          'DESCRIPTION',
          'GOAL',
          'PERSONA',
          'MODE',
          'TOOLS',
          'GATHER',
          'ATTACHMENTS',
          'DESTINATIONS',
          'MEMORY',
          'CONSTRAINTS',
          'GUARDRAILS',
          'FLOW',
          'STEPS',
          'HANDOFF',
          'DELEGATE',
          'ESCALATE',
          'COMPLETE',
          'ON_ERROR',
          'ON_START',
          'EXECUTION',
          'MESSAGES',
          'HOOKS',
          'ACTION_HANDLERS',
          'TEMPLATES',
          'NLU',
          'ENTITIES',
          'MULTI_INTENT',
          'LOOKUP_TABLES',
          'SYSTEM_PROMPT',
          'INSTRUCTIONS',
          'IDENTITY',
          'INTENTS',
          'LIMITATIONS',
          'LANGUAGE',
          'CONVERSATION',
        ];
        const rawName = sectionName.replace(/:$/, '');
        const upperName = rawName.toUpperCase();
        if (rawName !== upperName && knownSections.includes(upperName)) {
          state.warnings.push({
            line: state.currentLine,
            message: `"${rawName}:" should be "${upperName}:". ABL keywords must be uppercase.`,
          });
        } else {
          state.errors.push({
            line: state.currentLine,
            column: 0,
            message: `Unknown section: ${sectionName} Valid sections: AGENT:, SUPERVISOR:, BEHAVIOR_PROFILE:, VERSION:, DESCRIPTION:, GOAL:, PERSONA:, MODE:, TOOLS:, GATHER:, ATTACHMENTS:, DESTINATIONS:, MEMORY:, CONSTRAINTS:, GUARDRAILS:, FLOW:, STEPS:, HANDOFF:, DELEGATE:, ESCALATE:, COMPLETE:, ON_ERROR:, ON_START:, EXECUTION:, MESSAGES:, HOOKS:, ACTION_HANDLERS:, TEMPLATES:, NLU:, MULTI_INTENT:, LOOKUP_TABLES:, SYSTEM_PROMPT:, INSTRUCTIONS:, IDENTITY:, INTENTS:, LIMITATIONS:, LANGUAGE:, CONVERSATION:, USE BEHAVIOR_PROFILE:`,
          });
        }
      }
      state.currentLine++;
    }
  }

  // Validate required fields
  if (!doc.name) {
    state.errors.push({
      line: 0,
      column: 0,
      message: 'Missing required AGENT: declaration',
    });
  }

  if (!doc.goal && doc.meta?.kind !== 'behavior_profile') {
    doc.goal = { description: '' };
    state.errors.push({
      line: 0,
      column: 0,
      message: 'GOAL is required on every agent. Add a GOAL: section.',
    });
  }

  if (!doc.persona) {
    doc.persona = { description: '' };
  }

  // Validate flow step REASONING declarations (only for FLOW: section, not legacy STEPS:)
  if (doc.flow && hasFlowSection) {
    for (const stepName of Object.keys(doc.flow.definitions)) {
      const step = doc.flow.definitions[stepName];
      if (step.reasoning === undefined) {
        state.errors.push({
          line: 0,
          column: 0,
          message: `Step '${stepName}' must declare REASONING: true or REASONING: false.`,
        });
      }
      if (
        step.reasoning === true &&
        step.goal === undefined &&
        (!doc.goal || !doc.goal.description)
      ) {
        state.errors.push({
          line: 0,
          column: 0,
          message: `Step '${stepName}' has REASONING: true but no GOAL (step-level or agent-level).`,
        });
      }
      if (step.reasoning === false && step.goal !== undefined) {
        state.warnings.push({
          line: 0,
          message: `Step '${stepName}' has REASONING: false with a step GOAL — GOAL has no effect on deterministic steps. Remove GOAL or set REASONING: true.`,
        });
      }
      if (step.reasoning === false && step.availableTools !== undefined) {
        state.warnings.push({
          line: 0,
          message: `Step '${stepName}' has REASONING: false with AVAILABLE_TOOLS — tools have no effect on deterministic steps. Use CALL to invoke tools deterministically.`,
        });
      }
    }
  }

  return doc as AgentBasedDocument;
}

// =============================================================================
// SECTION PARSERS
// =============================================================================

// parseMode removed — MODE is deleted from ABL

function parseGoal(state: ParserState): AgentGoal {
  const line = state.lines[state.currentLine];

  // Check for inline goal: GOAL: "description"
  const inlineMatch = line.match(/^GOAL:\s*"([^"]+)"$/);
  if (inlineMatch) {
    state.currentLine++;
    return { description: inlineMatch[1] };
  }

  // Check for inline unquoted goal: GOAL: some text here
  // (text after "GOAL:" that isn't just whitespace or pipe indicator)
  const afterColon = line.substring(5).trim();
  if (afterColon && afterColon !== '|') {
    state.currentLine++;
    return { description: afterColon.replace(/^"|"$/g, '') };
  }

  // Multi-line goal (GOAL: alone on line, or GOAL: |)
  state.currentLine++;
  const description = parseMultiLineString(state);
  return { description };
}

function parseInstructions(state: ParserState): string {
  const line = state.lines[state.currentLine];

  // Check for inline: INSTRUCTIONS: "text"
  const inlineMatch = line.match(/^INSTRUCTIONS:\s*"([^"]+)"$/);
  if (inlineMatch) {
    state.currentLine++;
    return inlineMatch[1];
  }

  // Check for inline unquoted text
  const afterColon = line.substring(13).trim();
  if (afterColon && afterColon !== '|') {
    state.currentLine++;
    return afterColon.replace(/^"|"$/g, '');
  }

  // Multi-line instructions (alone on line, or with | indicator)
  state.currentLine++;
  return parseMultiLineString(state);
}

function parseFlow(state: ParserState): FlowDefinition {
  state.currentLine++;
  const flow: FlowDefinition = {
    steps: [],
    definitions: {},
  };

  let currentStep: FlowStep | null = null;
  let inStepsList = false;
  let inGather = false;
  let inDigressions = false;
  let inSubIntents = false;
  let currentGatherField: Partial<FlowGatherField> | null = null;
  let currentDigression: Partial<Digression> | null = null;
  let currentSubIntent: Partial<SubIntent> | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    // Parse flow-level properties (entry_point: value)
    const flowPropMatch = trimmed.match(/^entry_point:\s*(.+)$/);
    if (flowPropMatch && !currentStep) {
      flow.entryPoint = flowPropMatch[1].trim();
      state.currentLine++;
      continue;
    }

    // Parse global_digressions:
    if (trimmed === 'global_digressions:') {
      state.currentLine++;
      flow.globalDigressions = parseDigressionsList(state);
      continue;
    }

    // Parse YAML-style steps list header: "steps:" or "STEPS:"
    if (trimmed === 'steps:' || trimmed === 'STEPS:') {
      inStepsList = true;
      inGather = false;
      inDigressions = false;
      inSubIntents = false;
      state.currentLine++;
      continue;
    }

    // Parse YAML-style steps list items: "- stepname"
    if (inStepsList && trimmed.startsWith('- ')) {
      const stepName = trimmed.substring(2).trim();
      if (stepName && !stepName.includes(':')) {
        flow.steps.push(stepName);
        state.currentLine++;
        continue;
      }
      // If it has a colon, we're done with the simple list
      inStepsList = false;
    }

    // If we hit a non-list-item line while in steps list, we're done with the list
    if (inStepsList && trimmed && !trimmed.startsWith('-')) {
      inStepsList = false;
    }

    // Parse flow definition line: step1 -> step2 -> step3
    if (trimmed.includes('->') && !trimmed.includes(':')) {
      flow.steps = trimmed.split('->').map((s) => s.trim());
      state.currentLine++;
      continue;
    }

    // Step definition: stepname:
    // Accept step definitions at indent 0 (top-level) or indent 2 (nested in FLOW block).
    // Exclude known step property keywords that also end with just ":"
    const stepPropertyKeywords = [
      'ON_INPUT',
      'ON_SUCCESS',
      'ON_FAILURE',
      'ON_FAIL',
      'ON_RESULT',
      'ON_ACTION',
      'GATHER',
      'DIGRESSIONS',
      'SUB_INTENTS',
      'REASONING',
      'GOAL',
      'EXIT_WHEN',
      'MAX_TURNS',
      'AVAILABLE_TOOLS',
      'BEHAVIOR',
      'STEP_CONSTRAINTS',
      'AWAIT_ATTACHMENT',
    ];
    const stepMatch = trimmed.match(/^(\w+):$/);
    if (
      stepMatch &&
      (indent === 0 || line.match(/^\s{2}\w+:$/)) &&
      !stepPropertyKeywords.includes(stepMatch[1].toUpperCase())
    ) {
      // Save any pending gather field or digression
      if (currentStep && currentGatherField?.name) {
        if (!currentStep.gather) currentStep.gather = { fields: [] };
        currentStep.gather.fields.push(currentGatherField as FlowGatherField);
      }
      if (currentStep && currentDigression?.intent) {
        if (!currentStep.digressions) currentStep.digressions = [];
        currentStep.digressions.push(currentDigression as Digression);
      }
      if (currentStep && currentSubIntent?.intent) {
        if (!currentStep.subIntents) currentStep.subIntents = [];
        currentStep.subIntents.push(currentSubIntent as SubIntent);
      }

      if (currentStep) {
        flow.definitions[currentStep.name] = currentStep;
        if (!flow.steps.includes(currentStep.name)) {
          flow.steps.push(currentStep.name);
        }
      }
      currentStep = {
        name: stepMatch[1],
      };
      currentGatherField = null;
      currentDigression = null;
      currentSubIntent = null;
      inGather = false;
      inDigressions = false;
      inSubIntents = false;
      state.currentLine++;
      continue;
    }

    // Detect known step keywords used outside of a step definition (wrong casing or misplaced)
    if (!currentStep && trimmed) {
      const orphanPropMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (orphanPropMatch) {
        const orphanKey = orphanPropMatch[1];
        const knownStepKeywords = [
          'WHEN',
          'RESPOND',
          'SET',
          'CLEAR',
          'GOTO',
          'CALL',
          'DELEGATE',
          'REASONING',
          'GOAL',
          'EXIT_WHEN',
          'MAX_TURNS',
          'MAX_ATTEMPTS',
          'ON_EXHAUSTED',
          'ON_INPUT',
          'ON_SUCCESS',
          'ON_FAILURE',
          'ON_FAIL',
          'ON_RESULT',
          'ON_ACTION',
          'GATHER',
          'AVAILABLE_TOOLS',
          'STEP_CONSTRAINTS',
        ];
        if (knownStepKeywords.includes(orphanKey.toUpperCase())) {
          if (orphanKey !== orphanKey.toUpperCase()) {
            state.warnings.push({
              line: state.currentLine,
              message: `"${orphanKey}:" should be "${orphanKey.toUpperCase()}:". ABL keywords must be uppercase.`,
            });
          } else {
            state.warnings.push({
              line: state.currentLine,
              message: `"${orphanKey}:" appears outside of a step definition in FLOW. Define a step first (e.g., "my_step:").`,
            });
          }
          state.currentLine++;
          continue;
        }
      }
    }

    // Step properties
    if (currentStep && trimmed) {
      // First, handle special blocks (GATHER, DIGRESSIONS, SUB_INTENTS) where lines start with '-'
      // These need to be checked BEFORE propMatch since '- field' doesn't match /^\w+:/

      // Inside GATHER block - parse field definitions (lines starting with '- ')
      if (inGather && trimmed.startsWith('- ')) {
        // Save previous field
        if (currentGatherField?.name) {
          currentStep.gather!.fields.push(currentGatherField as FlowGatherField);
        }
        const fieldName = trimmed.substring(2).split(':')[0].trim();
        const rest = trimmed.substring(2 + fieldName.length).trim();
        currentGatherField = { name: fieldName };
        // Parse inline properties: - fieldname: required
        if (rest.startsWith(':')) {
          const inlineValue = rest.substring(1).trim();
          if (inlineValue === 'required') currentGatherField.required = true;
          else if (inlineValue === 'optional') currentGatherField.required = false;
          else if (inlineValue.startsWith('default=')) {
            currentGatherField.required = false;
            currentGatherField.default = inlineValue.substring(8);
          }
        }
        state.currentLine++;
        continue;
      }

      // Inside DIGRESSIONS block - new digression (lines starting with '- INTENT:')
      if (inDigressions && trimmed.startsWith('- INTENT:')) {
        if (currentDigression?.intent) {
          currentStep.digressions!.push(currentDigression as Digression);
        }
        currentDigression = { intent: trimmed.substring(9).trim().replace(/^"|"$/g, '') };
        state.currentLine++;
        continue;
      }

      // Inside SUB_INTENTS block - new sub-intent (lines starting with '- ')
      if (inSubIntents && (trimmed.startsWith('- INTENT:') || trimmed.startsWith('- "'))) {
        if (currentSubIntent?.intent) {
          currentStep.subIntents!.push(currentSubIntent as SubIntent);
        }
        const intentValue = trimmed.startsWith('- INTENT:')
          ? trimmed.substring(9).trim()
          : trimmed.substring(2).trim();
        currentSubIntent = { intent: parseSubIntentPattern(intentValue) };
        state.currentLine++;
        continue;
      }

      // Now check for property matches (key: value)
      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        const keyUpper = key.toUpperCase();

        // Check if entering GATHER block
        if (keyUpper === 'GATHER' && (value === '' || value === ':')) {
          inGather = true;
          inDigressions = false;
          inSubIntents = false;
          currentStep.gather = { fields: [] };
          state.currentLine++;
          continue;
        }

        // Check if entering DIGRESSIONS block
        if (keyUpper === 'DIGRESSIONS' && (value === '' || value === ':')) {
          inDigressions = false;
          inGather = false;
          inSubIntents = false;
          state.currentLine++;
          currentStep.digressions = parseDigressionsList(state);
          continue;
        }

        // Check if entering SUB_INTENTS block
        if (keyUpper === 'SUB_INTENTS' && (value === '' || value === ':')) {
          inSubIntents = true;
          inGather = false;
          inDigressions = false;
          currentStep.subIntents = [];
          state.currentLine++;
          continue;
        }

        // Handle GATHER inline format: GATHER: field1, field2, field3
        if (keyUpper === 'GATHER' && value) {
          const fieldNames = value
            .split(',')
            .map((s) => s.trim())
            .filter((s) => s);
          currentStep.gather = {
            fields: fieldNames.map((name) => {
              // Parse "field: required" or "field: default=X" or just "field"
              const parts = name.split(':').map((s) => s.trim());
              const field: FlowGatherField = { name: parts[0] };
              if (parts[1]) {
                if (parts[1] === 'required') field.required = true;
                else if (parts[1] === 'optional') field.required = false;
                else if (parts[1].startsWith('default=')) {
                  field.required = false;
                  field.default = parts[1].substring(8);
                }
              }
              return field;
            }),
          };
          inGather = false;
          state.currentLine++;
          continue;
        }

        // Inside GATHER block - parse field properties
        if (inGather) {
          // Handle FIELDS: sub-key (skip it and continue parsing fields underneath)
          if (keyUpper === 'FIELDS' && (value === '' || value === ':')) {
            state.currentLine++;
            continue;
          }

          // GATHER-specific properties
          const gatherProps = [
            'TYPE',
            'REQUIRED',
            'DEFAULT',
            'PROMPT',
            'MESSAGE_KEY',
            'VALIDATION',
            'STRATEGY',
            'INFER',
            'INFER_CONFIDENCE',
            'INFER_CONFIRM',
            'SEMANTICS',
            'RANGE',
            'LIST',
            'PREFERENCES',
            'ACTIVATION',
            'DEPENDS_ON',
            'PROMPT_MODE',
            'VALIDATION_PROCESS',
            'RETRY_PROMPT',
            'MAX_RETRIES',
            'OPTIONS',
            'ENTITY_REF',
            'SENSITIVE',
            'SENSITIVE_DISPLAY',
            'MASK_CONFIG',
            'PII_TYPE',
            'TRANSIENT',
          ];

          if (gatherProps.includes(keyUpper)) {
            // Field properties
            if (currentGatherField) {
              switch (keyUpper) {
                case 'ENTITY_REF':
                  currentGatherField.entityRef = value;
                  break;
                case 'TYPE':
                  currentGatherField.type = value;
                  break;
                case 'REQUIRED':
                  currentGatherField.required = value === 'true';
                  break;
                case 'DEFAULT':
                  currentGatherField.default = parseDefaultValue(value);
                  break;
                case 'PROMPT':
                  currentGatherField.prompt = value.replace(/^"|"$/g, '');
                  break;
                case 'MESSAGE_KEY':
                  currentGatherField.messageKey = value.replace(/^"|"$/g, '');
                  break;
                case 'VALIDATION':
                  currentGatherField.validation = value;
                  break;
                case 'INFER':
                  currentGatherField.infer = value === 'true';
                  break;
                case 'INFER_CONFIDENCE':
                  currentGatherField.inferConfidence = parseFloat(value);
                  break;
                case 'INFER_CONFIRM':
                  currentGatherField.inferConfirm = value === 'true';
                  break;
                case 'SEMANTICS': {
                  // Parse SEMANTICS sub-block
                  if (!value || value.trim() === '') {
                    const semantics: Record<string, unknown> = {};
                    const semBaseIndent = getIndent(state.lines[state.currentLine]);
                    state.currentLine++;
                    while (state.currentLine < state.lines.length) {
                      const semLine = state.lines[state.currentLine];
                      const semTrimmed = semLine.trim();
                      const semIndent = getIndent(semLine);
                      if (!semTrimmed || semIndent <= semBaseIndent) break;
                      const semPropMatch = semTrimmed.match(/^(\w+):\s*(.+)$/);
                      if (semPropMatch) {
                        const [, semKey, semVal] = semPropMatch;
                        const lowerSemKey = semKey.toLowerCase();
                        const mappedKey = mapSemanticKey(lowerSemKey);
                        if (isSemanticListKey(mappedKey)) {
                          semantics[mappedKey] = semVal
                            .replace(/^\[|\]$/g, '')
                            .split(',')
                            .map((s: string) => s.trim())
                            .filter(Boolean);
                        } else {
                          semantics[mappedKey] = semVal.replace(/^"|"$/g, '');
                        }
                      } else {
                        break;
                      }
                      state.currentLine++;
                    }
                    currentGatherField.semantics = semantics as any;
                    continue; // Skip state.currentLine++ at end
                  }
                  break;
                }
                case 'RANGE':
                  currentGatherField.range = value === 'true';
                  break;
                case 'LIST':
                  currentGatherField.list = value === 'true';
                  break;
                case 'PREFERENCES':
                  currentGatherField.preferences = value === 'true';
                  break;
                case 'ACTIVATION': {
                  if (!value || value.trim() === '') {
                    // Block format - look for WHEN: on subsequent lines
                    const actBaseIndent = getIndent(state.lines[state.currentLine]);
                    state.currentLine++;
                    while (state.currentLine < state.lines.length) {
                      const actLine = state.lines[state.currentLine];
                      const actTrimmed = actLine.trim();
                      const actIndent = getIndent(actLine);
                      if (!actTrimmed || actIndent <= actBaseIndent) break;
                      const whenMatch = actTrimmed.match(/^WHEN:\s*"?(.+?)"?$/i);
                      if (whenMatch) {
                        currentGatherField.activation = { when: whenMatch[1] };
                        state.currentLine++;
                        break;
                      } else {
                        break;
                      }
                    }
                    continue;
                  } else {
                    currentGatherField.activation = value.toLowerCase() as
                      | 'required'
                      | 'optional'
                      | 'progressive';
                  }
                  break;
                }
                case 'DEPENDS_ON':
                  currentGatherField.dependsOn = value
                    .replace(/^\[|\]$/g, '')
                    .split(',')
                    .map((s: string) => s.trim())
                    .filter(Boolean);
                  break;
                case 'PROMPT_MODE':
                  currentGatherField.promptMode = value as 'ask' | 'extract_only';
                  break;
                case 'VALIDATION_PROCESS':
                  currentGatherField.validationProcess = value as 'REGEX' | 'CODE' | 'LLM';
                  break;
                case 'RETRY_PROMPT':
                  currentGatherField.retryPrompt = value.replace(/^"|"$/g, '');
                  break;
                case 'MAX_RETRIES':
                  currentGatherField.maxRetries = parseInt(value, 10);
                  break;
                case 'OPTIONS':
                  if (value && value.trim()) {
                    currentGatherField.options = value
                      .replace(/^\[|\]$/g, '')
                      .split(',')
                      .map((s: string) => s.trim())
                      .filter(Boolean);
                  }
                  break;
                case 'SENSITIVE':
                  currentGatherField.sensitive = value === 'true' || value === 'yes';
                  break;
                case 'SENSITIVE_DISPLAY':
                  currentGatherField.sensitiveDisplay = value as 'redact' | 'mask' | 'replace';
                  break;
                case 'MASK_CONFIG': {
                  if (!value || value === '') {
                    currentGatherField.maskConfig = parseMaskConfigBlock(
                      state,
                      line.length - line.trimStart().length,
                    );
                    continue;
                  }
                  break;
                }
                case 'TRANSIENT':
                  currentGatherField.transient = value === 'true' || value === 'yes';
                  break;
                case 'PII_TYPE': {
                  const normalized = value.trim().toLowerCase();
                  const allowed: Array<FlowGatherField['piiType']> = [
                    'email',
                    'phone',
                    'ssn',
                    'credit_card',
                    'address',
                    'name',
                    'custom',
                  ];
                  if (allowed.includes(normalized as FlowGatherField['piiType'])) {
                    currentGatherField.piiType = normalized as FlowGatherField['piiType'];
                  }
                  break;
                }
              }
            }
            // GATHER block properties
            if (keyUpper === 'STRATEGY') {
              currentStep.gather!.strategy = value as 'llm' | 'pattern' | 'hybrid';
            } else if (keyUpper === 'PROMPT' && !currentGatherField) {
              if (value.startsWith('|')) {
                state.currentLine++;
                currentStep.gather!.prompt = parseMultiLineString(state);
                continue;
              } else {
                currentStep.gather!.prompt = value.replace(/^"|"$/g, '');
              }
            } else if (keyUpper === 'MESSAGE_KEY' && !currentGatherField) {
              currentStep.gather!.messageKey = value.replace(/^"|"$/g, '');
            }
            state.currentLine++;
            continue;
          } else {
            // Not a GATHER property - save current field and exit GATHER mode
            if (currentGatherField?.name) {
              currentStep.gather!.fields.push(currentGatherField as FlowGatherField);
              currentGatherField = null;
            }
            inGather = false;
            // Fall through to process as regular step property
          }
        }

        // Inside DIGRESSIONS block - parse digression properties
        if (inDigressions) {
          const digressionProps = [
            'CONDITION',
            'RESPOND',
            'MESSAGE_KEY',
            'GOTO',
            'DELEGATE',
            'CALL',
            'RESUME',
            'CLEAR',
            'KEYWORDS',
          ];

          if (digressionProps.includes(keyUpper) && currentDigression) {
            switch (keyUpper) {
              case 'CONDITION':
                currentDigression.condition = value;
                break;
              case 'RESPOND': {
                const respondIndent = getIndent(state.lines[state.currentLine]);
                if (value.startsWith('|')) {
                  state.currentLine++;
                  currentDigression.respond = parseMultiLineString(state);
                } else {
                  currentDigression.respond = value.replace(/^"|"$/g, '');
                  state.currentLine++;
                }
                currentDigression.voiceConfig = tryParseVoiceConfig(state, respondIndent);
                currentDigression.richContent = tryParseFormatsBlock(state, respondIndent);
                continue;
              }
              case 'MESSAGE_KEY':
                currentDigression.messageKey = value.replace(/^"|"$/g, '');
                break;
              case 'GOTO':
                currentDigression.goto = value;
                break;
              case 'DELEGATE':
                currentDigression.delegate = value;
                break;
              case 'CALL':
                currentDigression.call = value;
                break;
              case 'RESUME':
                currentDigression.resume = value === 'true';
                break;
              case 'CLEAR':
                currentDigression.clear = parseArray(value);
                break;
              case 'KEYWORDS':
                currentDigression.keywords = parseArray(value);
                break;
            }
            state.currentLine++;
            continue;
          } else {
            // Not a DIGRESSIONS property - save current digression and exit mode
            if (currentDigression?.intent) {
              currentStep.digressions!.push(currentDigression as Digression);
              currentDigression = null;
            }
            inDigressions = false;
            // Fall through to process as regular step property
          }
        }

        // Inside SUB_INTENTS block - parse sub-intent properties
        if (inSubIntents) {
          const subIntentProps = [
            'RESPOND',
            'MESSAGE_KEY',
            'CLEAR',
            'SET',
            'CALL',
            'WITH',
            'AS',
            'RESUME',
          ];

          if (subIntentProps.includes(keyUpper) && currentSubIntent) {
            switch (keyUpper) {
              case 'RESPOND': {
                const respondIndent = getIndent(state.lines[state.currentLine]);
                if (value.startsWith('|')) {
                  state.currentLine++;
                  currentSubIntent.respond = parseMultiLineString(state);
                } else {
                  currentSubIntent.respond = value.replace(/^"|"$/g, '');
                  state.currentLine++;
                }
                currentSubIntent.voiceConfig = tryParseVoiceConfig(state, respondIndent);
                currentSubIntent.richContent = tryParseFormatsBlock(state, respondIndent);
                currentSubIntent.actions = tryParseActionsBlock(state, respondIndent);
                continue;
              }
              case 'MESSAGE_KEY':
                currentSubIntent.messageKey = value.replace(/^"|"$/g, '');
                break;
              case 'CLEAR':
                currentSubIntent.clear = parseArray(value);
                break;
              case 'SET':
                if (!currentSubIntent.set) currentSubIntent.set = {};
                const setMatch = value.match(/^(\w+)\s*=\s*(.+)$/);
                if (setMatch) {
                  currentSubIntent.set[setMatch[1]] = setMatch[2];
                }
                break;
              case 'CALL':
                {
                  const invocation = parseToolInvocation(state, value);
                  currentSubIntent.call = invocation.call;
                  currentSubIntent.callSpec = invocation.callSpec;
                }
                break;
              case 'WITH':
              case 'AS':
                state.errors.push({
                  line: state.currentLine + 1,
                  column: 1,
                  message: `${keyUpper}: must be nested under CALL: inside SUB_INTENTS.`,
                });
                break;
              case 'RESUME':
                currentSubIntent.resume = value === 'true';
                break;
            }
            state.currentLine++;
            continue;
          } else {
            // Not a SUB_INTENTS property - save current sub-intent and exit mode
            if (currentSubIntent?.intent) {
              currentStep.subIntents!.push(currentSubIntent as SubIntent);
              currentSubIntent = null;
            }
            inSubIntents = false;
            // Fall through to process as regular step property
          }
        }

        // Regular step properties (not inside GATHER/DIGRESSIONS/SUB_INTENTS)
        switch (keyUpper) {
          case 'WHEN':
            currentStep.when = value;
            break;
          case 'MAX_ATTEMPTS':
            currentStep.maxAttempts = parseInt(value, 10);
            break;
          case 'ON_EXHAUSTED':
            currentStep.onExhausted = value;
            break;
          case 'SET': {
            if (!currentStep.set) currentStep.set = [];
            if (value) {
              // Inline: SET: variable = expression
              const setM = value.match(/^([\w.]+)\s*=\s*(.+)$/);
              if (setM) {
                currentStep.set.push({ variable: setM[1], expression: setM[2].trim() });
              }
            } else {
              // Block form: read indented lines as "variable = expression"
              const setBaseIndent = getIndent(state.lines[state.currentLine]);
              state.currentLine++;
              while (state.currentLine < state.lines.length) {
                const setLine = state.lines[state.currentLine];
                const setIndent = getIndent(setLine);
                const setTrimmed = setLine.trim();
                if (!setTrimmed || setIndent <= setBaseIndent) break;
                const setLineM = setTrimmed.match(/^([\w.]+)\s*=\s*(.+)$/);
                if (setLineM) {
                  currentStep.set.push({ variable: setLineM[1], expression: setLineM[2].trim() });
                }
                state.currentLine++;
              }
              continue; // Skip state.currentLine++ at end
            }
            break;
          }
          case 'CLEAR': {
            currentStep.clear = value
              .split(',')
              .map((v) => v.trim())
              .filter(Boolean);
            break;
          }
          case 'TRANSFORM': {
            // Parse: source AS itemVar INTO target
            const trM = value.match(/^([\w.]+)\s+AS\s+(\w+)\s+INTO\s+(\w+)$/i);
            if (trM) {
              currentStep.transform = {
                source: trM[1],
                itemVar: trM[2],
                target: trM[3],
              };
              // Parse indented FILTER, MAP, SORT_BY, LIMIT
              const trBaseIndent = getIndent(state.lines[state.currentLine]);
              state.currentLine++;
              while (state.currentLine < state.lines.length) {
                const trLine = state.lines[state.currentLine];
                const trIndent = getIndent(trLine);
                const trTrimmed = trLine.trim();
                if (!trTrimmed || trIndent <= trBaseIndent) break;
                const colonIdx = trTrimmed.indexOf(':');
                if (colonIdx === -1) {
                  state.currentLine++;
                  continue;
                }
                const trKey = trTrimmed.slice(0, colonIdx).trim().toUpperCase();
                const trVal = trTrimmed.slice(colonIdx + 1).trim();
                switch (trKey) {
                  case 'FILTER':
                    currentStep.transform.filter = trVal;
                    state.currentLine++;
                    break;
                  case 'MAP': {
                    // Parse indented key: value pairs
                    const mapObj: Record<string, string> = {};
                    const mapBaseIndent = getIndent(state.lines[state.currentLine]);
                    state.currentLine++;
                    while (state.currentLine < state.lines.length) {
                      const mapLine = state.lines[state.currentLine];
                      const mapIndent = getIndent(mapLine);
                      const mapTrimmed = mapLine.trim();
                      if (!mapTrimmed || mapIndent <= mapBaseIndent) break;
                      const mapColonIdx = mapTrimmed.indexOf(':');
                      if (mapColonIdx !== -1) {
                        const mapKey = mapTrimmed.slice(0, mapColonIdx).trim();
                        const mapVal = mapTrimmed.slice(mapColonIdx + 1).trim();
                        mapObj[mapKey] = mapVal;
                      }
                      state.currentLine++;
                    }
                    currentStep.transform.map = mapObj;
                    break;
                  }
                  case 'SORT_BY': {
                    const sortParts = trVal.split(/\s+/);
                    currentStep.transform.sortBy = {
                      field: sortParts[0],
                      order: (sortParts[1] || 'asc').toLowerCase() as 'asc' | 'desc',
                    };
                    state.currentLine++;
                    break;
                  }
                  case 'LIMIT':
                    currentStep.transform.limit = parseInt(trVal, 10);
                    state.currentLine++;
                    break;
                  default:
                    state.currentLine++;
                }
              }
              continue; // Skip state.currentLine++ at end
            }
            break;
          }
          case 'CALL': {
            const invocation = parseToolInvocation(state, value);
            currentStep.call = invocation.call;
            currentStep.callWith = invocation.callWith;
            currentStep.callAs = invocation.callAs;
            currentStep.callSpec = invocation.callSpec;
            break;
          }
          case 'WITH':
          case 'AS':
            state.errors.push({
              line: state.currentLine + 1,
              column: 1,
              message: `${key.toUpperCase()}: must be nested under CALL: inside FLOW steps.`,
            });
            break;
          case 'CHECK':
            currentStep.check = value;
            break;
          case 'RESPOND': {
            const respondIndent = getIndent(state.lines[state.currentLine]);
            if (value.startsWith('|')) {
              state.currentLine++;
              currentStep.respond = parseMultiLineString(state);
            } else {
              currentStep.respond = value.replace(/^"|"$/g, '');
              state.currentLine++;
            }
            currentStep.voiceConfig = tryParseVoiceConfig(state, respondIndent);
            currentStep.richContent = tryParseFormatsBlock(state, respondIndent);
            currentStep.actions = tryParseActionsBlock(state, respondIndent);
            const carousel = tryParseCarouselBlock(state, respondIndent);
            if (carousel) {
              if (!currentStep.richContent) currentStep.richContent = {};
              currentStep.richContent.carousel = carousel;
            }
            continue;
          }
          case 'MESSAGE_KEY':
            currentStep.messageKey = value.replace(/^"|"$/g, '');
            break;
          case 'PRESENT':
            if (value.startsWith('|')) {
              state.currentLine++;
              currentStep.present = parseMultiLineString(state);
              continue;
            } else {
              currentStep.present = value.replace(/^"|"$/g, '');
            }
            break;
          case 'CORRECTIONS':
            currentStep.corrections = value === 'true';
            break;
          case 'AWAIT_ATTACHMENT': {
            // Parse AWAIT_ATTACHMENT block with indented sub-properties
            const aaConfig: Record<string, unknown> = {};
            const aaBaseIndent = getIndent(state.lines[state.currentLine]);
            state.currentLine++;
            while (state.currentLine < state.lines.length) {
              const aaLine = state.lines[state.currentLine];
              const aaIndent = getIndent(aaLine);
              const aaTrimmed = aaLine.trim();
              if (!aaTrimmed || aaIndent <= aaBaseIndent) break;
              const aaColonIdx = aaTrimmed.indexOf(':');
              if (aaColonIdx !== -1) {
                const aaKey = aaTrimmed.slice(0, aaColonIdx).trim().toLowerCase();
                const aaVal = aaTrimmed.slice(aaColonIdx + 1).trim();
                switch (aaKey) {
                  case 'name':
                    aaConfig.name = aaVal;
                    break;
                  case 'prompt':
                    aaConfig.prompt = aaVal.replace(/^"|"$/g, '');
                    break;
                  case 'category':
                    aaConfig.category = aaVal;
                    break;
                  case 'required':
                    aaConfig.required = aaVal.toLowerCase() !== 'false';
                    break;
                  case 'timeout':
                    aaConfig.timeout = parseInt(aaVal, 10);
                    break;
                  case 'on_timeout':
                    aaConfig.onTimeout = aaVal;
                    break;
                }
              }
              state.currentLine++;
            }
            currentStep.awaitAttachment = {
              name: (aaConfig.name as string) || '',
              prompt: (aaConfig.prompt as string) || '',
              category: aaConfig.category as 'image' | 'document' | 'audio' | 'video' | undefined,
              required: aaConfig.required !== undefined ? (aaConfig.required as boolean) : true,
              timeout: aaConfig.timeout as number | undefined,
              onTimeout: aaConfig.onTimeout as string | undefined,
            };
            continue; // Skip state.currentLine++ at end
          }
          case 'COMPLETE_WHEN':
            currentStep.completeWhen = value;
            break;
          case 'ON_FAIL': {
            // If it's a block (no value on same line), parse the block
            if (!value || value.trim() === '') {
              // Check if next lines have COLLECT/GOTO/RETRY (structured constraint-style block)
              const nextIdx = state.currentLine + 1;
              if (nextIdx < state.lines.length) {
                const peekLine = state.lines[nextIdx].trim().toUpperCase();
                if (
                  peekLine.startsWith('COLLECT:') ||
                  peekLine.startsWith('GOTO:') ||
                  peekLine.startsWith('RETRY:')
                ) {
                  // Parse as ConstraintOnFailBlock
                  const onFailBlock: Record<string, unknown> = {};
                  const onFailBaseIndent = getIndent(state.lines[state.currentLine]);
                  state.currentLine++;
                  while (state.currentLine < state.lines.length) {
                    const ofLine = state.lines[state.currentLine];
                    const ofTrimmed = ofLine.trim();
                    const ofIndent = getIndent(ofLine);
                    if (!ofTrimmed || ofIndent <= onFailBaseIndent) break;
                    const ofPropMatch = ofTrimmed.match(/^(\w+):\s*(.+)$/);
                    if (ofPropMatch) {
                      const [, ofKey, ofVal] = ofPropMatch;
                      switch (ofKey.toUpperCase()) {
                        case 'COLLECT':
                          onFailBlock.collect = ofVal
                            .replace(/^\[|\]$/g, '')
                            .split(',')
                            .map((s: string) => s.trim())
                            .filter(Boolean);
                          break;
                        case 'GOTO':
                          onFailBlock.goto = ofVal.trim();
                          break;
                        case 'RETRY':
                          onFailBlock.retry = ofVal.trim() === 'true';
                          break;
                        case 'RESPOND':
                          onFailBlock.respond = ofVal.replace(/^"|"$/g, '');
                          break;
                        case 'THEN':
                          onFailBlock.then = ofVal.trim();
                          break;
                      }
                    }
                    state.currentLine++;
                  }
                  currentStep.onFail = onFailBlock as any;
                  continue;
                }
              }
              // Fall back to existing parseOnFailBlock for ON_SUCCESS/ON_FAIL result blocks
              state.currentLine++;
              parseOnFailBlock(state, currentStep);
              continue;
            } else {
              // Simple inline value (legacy: just a step name)
              currentStep.onFail = value;
            }
            break;
          }
          case 'ON_ERROR': {
            // Parse ON_ERROR block: list of error handlers
            if (!value || value.trim() === '') {
              const errorHandlers: any[] = [];
              const onErrorBaseIndent = getIndent(state.lines[state.currentLine]);
              state.currentLine++;
              let currentHandler: Record<string, unknown> | null = null;

              while (state.currentLine < state.lines.length) {
                const errLine = state.lines[state.currentLine];
                const errTrimmed = errLine.trim();
                const errIndent = getIndent(errLine);

                if (!errTrimmed) {
                  state.currentLine++;
                  continue;
                }
                if (errIndent <= onErrorBaseIndent && !errTrimmed.startsWith('-')) break;

                // New handler: - TYPE: value
                if (errTrimmed.startsWith('- TYPE:')) {
                  if (currentHandler) errorHandlers.push(currentHandler);
                  currentHandler = { type: errTrimmed.substring(7).trim() };
                  state.currentLine++;
                  continue;
                }

                // Handler properties
                if (currentHandler) {
                  const errPropMatch = errTrimmed.match(/^(\w+):\s*(.+)$/);
                  if (errPropMatch) {
                    const [, errKey, errVal] = errPropMatch;
                    switch (errKey.toUpperCase()) {
                      case 'SUBTYPE':
                        currentHandler.subtypes = [errVal.trim()];
                        break;
                      case 'RESPOND':
                        currentHandler.respond = errVal.replace(/^"|"$/g, '');
                        break;
                      case 'THEN':
                        currentHandler.then = errVal.trim();
                        break;
                      case 'RETRY':
                        currentHandler.retry = parseInt(errVal, 10);
                        break;
                      case 'RETRY_DELAY':
                        currentHandler.retryDelay = parseInt(errVal, 10);
                        break;
                      case 'RETRY_BACKOFF':
                        currentHandler.retryBackoff = errVal.trim();
                        break;
                      case 'BACKTRACK_TO':
                        currentHandler.backtrackTo = errVal.trim();
                        break;
                    }
                  }
                }
                state.currentLine++;
              }
              if (currentHandler) errorHandlers.push(currentHandler);
              currentStep.onError = errorHandlers;
              continue;
            }
            break;
          }
          case 'REASONING':
            currentStep.reasoning = value.toLowerCase() === 'true';
            break;
          case 'GOAL': {
            // Step-level GOAL (overrides agent GOAL for reasoning steps)
            if (value && value !== '|') {
              currentStep.goal = value.replace(/^"|"$/g, '');
            } else {
              const goalBaseIndent = getIndent(state.lines[state.currentLine]);
              const { lines, nextLine } = collectIndentedBlockLines(state, goalBaseIndent);
              currentStep.goal = dedentBlockLines(lines);
              state.currentLine = nextLine;
              continue; // Skip state.currentLine++ at end
            }
            break;
          }
          case 'BEHAVIOR': {
            const behaviorText =
              value && value !== '|'
                ? value.replace(/^"|"$/g, '')
                : collectFlowStepBehaviorText(state);
            if (behaviorText) {
              currentStep.goal = currentStep.goal
                ? `${currentStep.goal}\n\n${behaviorText}`
                : behaviorText;
            }
            if (!value || value === '|') {
              continue;
            }
            break;
          }
          case 'EXIT_WHEN':
            currentStep.exitWhen = value;
            break;
          case 'MAX_TURNS':
            currentStep.maxTurns = parseInt(value, 10);
            break;
          case 'AVAILABLE_TOOLS': {
            // Parse array: [tool1, tool2] or comma-separated
            let toolList = value;
            if (toolList.startsWith('[') && toolList.endsWith(']')) {
              toolList = toolList.slice(1, -1);
            }
            currentStep.availableTools = toolList
              .split(',')
              .map((t) => t.trim())
              .filter(Boolean);
            break;
          }
          case 'STEP_CONSTRAINTS': {
            // Parse step-level constraints as list
            if (!currentStep.stepConstraints) currentStep.stepConstraints = [];
            if (value) {
              currentStep.stepConstraints.push(value);
            } else {
              const scBaseIndent = getIndent(state.lines[state.currentLine]);
              state.currentLine++;
              while (state.currentLine < state.lines.length) {
                const scLine = state.lines[state.currentLine];
                const scIndent = getIndent(scLine);
                const scTrimmed = scLine.trim();
                if (!scTrimmed || scIndent <= scBaseIndent) break;
                if (scTrimmed.startsWith('- ')) {
                  currentStep.stepConstraints.push(scTrimmed.substring(2).trim());
                }
                state.currentLine++;
              }
              continue;
            }
            break;
          }
          case 'THEN':
            currentStep.then = value;
            break;
          case 'ON_ACTION': {
            const onActionIndent = getIndent(state.lines[state.currentLine]);
            currentStep.onAction = parseOnActionBlock(state, onActionIndent);
            continue;
          }
          case 'ON_INPUT':
            state.currentLine++;
            currentStep.onInput = parseOnInput(state);
            continue;
          case 'ON_SUCCESS':
            // Parse ON_SUCCESS block for CALL steps
            state.currentLine++;
            parseOnSuccessBlock(state, currentStep);
            continue;
          case 'ON_FAILURE':
            // Parse ON_FAILURE block for CALL steps
            state.currentLine++;
            parseOnFailBlock(state, currentStep);
            continue;
          case 'ON_RESULT':
            // Parse ON_RESULT block — reuses ON_INPUT branch parsing
            state.currentLine++;
            currentStep.onResult = parseOnInput(state);
            continue;
        }
      }
    }

    state.currentLine++;
  }

  // Save any pending gather field or digression
  if (currentStep && currentGatherField?.name) {
    if (!currentStep.gather) currentStep.gather = { fields: [] };
    currentStep.gather.fields.push(currentGatherField as FlowGatherField);
  }
  if (currentStep && currentDigression?.intent) {
    if (!currentStep.digressions) currentStep.digressions = [];
    currentStep.digressions.push(currentDigression as Digression);
  }
  if (currentStep && currentSubIntent?.intent) {
    if (!currentStep.subIntents) currentStep.subIntents = [];
    currentStep.subIntents.push(currentSubIntent as SubIntent);
  }

  if (currentStep) {
    flow.definitions[currentStep.name] = currentStep;
    if (!flow.steps.includes(currentStep.name)) {
      flow.steps.push(currentStep.name);
    }
  }

  return flow;
}

const FLOW_STEP_DIRECTIVE_KEYS = new Set([
  'WHEN',
  'MAX_ATTEMPTS',
  'ON_EXHAUSTED',
  'SET',
  'CLEAR',
  'TRANSFORM',
  'CALL',
  'WITH',
  'AS',
  'CHECK',
  'RESPOND',
  'MESSAGE_KEY',
  'PRESENT',
  'CORRECTIONS',
  'AWAIT_ATTACHMENT',
  'COMPLETE_WHEN',
  'ON_FAIL',
  'ON_ERROR',
  'REASONING',
  'GOAL',
  'BEHAVIOR',
  'EXIT_WHEN',
  'MAX_TURNS',
  'AVAILABLE_TOOLS',
  'STEP_CONSTRAINTS',
  'THEN',
  'ON_ACTION',
  'ON_INPUT',
  'ON_SUCCESS',
  'ON_FAILURE',
  'ON_RESULT',
  'GATHER',
  'DIGRESSIONS',
  'SUB_INTENTS',
]);

function isFlowStepDirective(trimmed: string): boolean {
  const match = trimmed.match(/^([A-Z_]+):(?:\s*.*)?$/);
  return !!match && FLOW_STEP_DIRECTIVE_KEYS.has(match[1]);
}

function looksLikeFlowStepDefinition(state: ParserState, lineIndex: number): boolean {
  const line = state.lines[lineIndex];
  const trimmed = line.trim();
  const indent = getIndent(line);
  const stepMatch = trimmed.match(/^(\w+):$/);
  if (
    !stepMatch ||
    FLOW_STEP_DIRECTIVE_KEYS.has(stepMatch[1].toUpperCase()) ||
    !(indent === 0 || line.match(/^\s{2}\w+:$/))
  ) {
    return false;
  }

  for (let cursor = lineIndex + 1; cursor < state.lines.length; cursor++) {
    const candidate = state.lines[cursor];
    const candidateTrimmed = candidate.trim();
    if (!candidateTrimmed) {
      continue;
    }

    return getIndent(candidate) > indent && isFlowStepDirective(candidateTrimmed);
  }

  return false;
}

function collectFlowStepBehaviorText(state: ParserState): string {
  const behaviorIndent = getIndent(state.lines[state.currentLine]);
  const lines: string[] = [];
  let cursor = state.currentLine + 1;

  while (cursor < state.lines.length) {
    const candidate = state.lines[cursor];
    const trimmed = candidate.trim();
    const indent = getIndent(candidate);

    if (trimmed) {
      if (indent < behaviorIndent) {
        break;
      }
      if (indent === 0 && /^[A-Z_]+:/.test(trimmed)) {
        break;
      }
      if (indent <= behaviorIndent && isFlowStepDirective(trimmed)) {
        break;
      }
      if (indent <= behaviorIndent && looksLikeFlowStepDefinition(state, cursor)) {
        break;
      }
    }

    lines.push(candidate);
    cursor++;
  }

  state.currentLine = cursor;
  return dedentBlockLines(lines);
}

/**
 * Parse a list of digressions (for global_digressions or step digressions)
 */
function parseDigressionIntent(intentValue: string): string {
  const trimmed = intentValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && /\s/.test(trimmed.slice(1, -1))) {
    return trimmed;
  }
  return trimmed.replace(/^"|"$/g, '');
}

function parseSubIntentPattern(intentValue: string): string {
  const trimmed = intentValue.trim();
  if (trimmed.startsWith('"') && trimmed.endsWith('"') && /\s/.test(trimmed.slice(1, -1))) {
    return trimmed;
  }
  return trimmed.replace(/^"|"$/g, '');
}

function looksLikeLegacyDigressionIntent(intentValue: string): boolean {
  const trimmed = intentValue.trim();
  const unquoted = trimmed.replace(/^"|"$/g, '');
  return /[,\|\s]/.test(unquoted) || trimmed.includes('"');
}

function maybeWarnLegacyDigressionIntent(state: ParserState, intentValue: string): void {
  if (!looksLikeLegacyDigressionIntent(intentValue)) {
    return;
  }

  state.warnings.push({
    line: state.currentLine + 1,
    message:
      `Digression INTENT ${intentValue} looks like legacy keyword text. ` +
      `Use a semantic id such as cancel_request and move phrases into KEYWORDS.`,
  });
}

function hasLegacyDigressionExecutionFields(digression: Partial<Digression>): boolean {
  return !!(
    digression.respond ||
    digression.goto ||
    digression.delegate ||
    digression.call ||
    digression.resume !== undefined ||
    (digression.clear && digression.clear.length > 0)
  );
}

function parseDigressionDoBlock(state: ParserState, parentIndent: number): DigressionActionAST[] {
  const actions: DigressionActionAST[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    if (!trimmed.startsWith('- ')) {
      state.errors.push({
        line: state.currentLine + 1,
        column: 1,
        message: `Invalid digression DO action "${trimmed}"`,
      });
      state.currentLine++;
      continue;
    }

    const actionIndent = indent;
    const actionBody = trimmed.substring(2).trim();

    const actionMatch = actionBody.match(/^(\w+):\s*(.*)$/);
    if (!actionMatch) {
      if (actionBody === 'RESUME') {
        actions.push({ resume: true });
        state.currentLine++;
        continue;
      }
      state.errors.push({
        line: state.currentLine + 1,
        column: 1,
        message: `Unknown digression DO action "${actionBody}"`,
      });
      state.currentLine++;
      continue;
    }

    const [, actionKey, rawValue] = actionMatch;
    const actionKeyUpper = actionKey.toUpperCase();

    switch (actionKeyUpper) {
      case 'RESPOND': {
        const action: DigressionActionAST = {};
        const respondIndent = getIndent(state.lines[state.currentLine]);
        if (rawValue.startsWith('|')) {
          state.currentLine++;
          action.respond = parseMultiLineString(state);
        } else {
          action.respond = rawValue.replace(/^"|"$/g, '');
          state.currentLine++;
        }
        action.voiceConfig = tryParseVoiceConfig(state, respondIndent);
        action.richContent = tryParseFormatsBlock(state, respondIndent);
        action.actions = tryParseActionsBlock(state, respondIndent);
        actions.push(action);
        continue;
      }
      case 'SET': {
        const set = parseIndentedSetAssignments(state, actionIndent, rawValue);
        actions.push({ set });
        continue;
      }
      case 'CLEAR':
        actions.push({ clear: parseArray(rawValue) });
        state.currentLine++;
        continue;
      case 'CALL': {
        const invocation = parseToolInvocation(state, rawValue);
        actions.push({ call: invocation.call, callSpec: invocation.callSpec });
        state.currentLine++;
        continue;
      }
      case 'DELEGATE': {
        const action: DigressionActionAST = { delegate: rawValue };
        state.currentLine++;
        parseDigressionDelegateActionDetails(state, actionIndent, action, state);
        actions.push(action);
        continue;
      }
      case 'GOTO':
        actions.push({ goto: rawValue });
        state.currentLine++;
        continue;
      case 'RESUME':
        actions.push({ resume: rawValue === '' || rawValue === 'true' });
        state.currentLine++;
        continue;
      default:
        state.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message: `Unknown digression DO action "${actionKey}"`,
        });
        state.currentLine++;
        continue;
    }
  }

  return actions;
}

function parseIndentedSetAssignments(
  state: ParserState,
  parentIndent: number,
  inlineValue: string,
): Record<string, string> {
  const set: Record<string, string> = {};

  const parseAssignment = (text: string): void => {
    const setMatch = text.match(/^(\S+)\s*=\s*(.+)$/);
    if (setMatch) {
      set[setMatch[1]] = setMatch[2].replace(/^"|"$/g, '');
    }
  };

  if (inlineValue.trim()) {
    parseAssignment(inlineValue.trim());
    state.currentLine++;
    return set;
  }

  state.currentLine++;
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    parseAssignment(trimmed);
    state.currentLine++;
  }

  return set;
}

function parseDigressionDelegateActionDetails(
  state: ParserState,
  parentIndent: number,
  action: DigressionActionAST,
  parserState: ParserState,
): void {
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (!propMatch) {
      state.currentLine++;
      continue;
    }

    const [, key, value] = propMatch;
    switch (key.toUpperCase()) {
      case 'RETURN':
        action.return = value.trim().toLowerCase() === 'true';
        state.currentLine++;
        continue;
      case 'ON_RETURN':
        state.currentLine++;
        action.onReturn = parseDigressionOnReturnBlock(state, indent, parserState);
        continue;
      default:
        parserState.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message: `Unknown digression DELEGATE property "${key}"`,
        });
        state.currentLine++;
        continue;
    }
  }
}

function parseDigressionOnReturnBlock(
  state: ParserState,
  parentIndent: number,
  parserState: ParserState,
): { map?: Record<string, string> } {
  const onReturn: { map?: Record<string, string> } = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (!propMatch) {
      state.currentLine++;
      continue;
    }

    const [, key, value] = propMatch;
    switch (key.toUpperCase()) {
      case 'MAP':
        if (value.trim()) {
          onReturn.map = parseInlineObject(value) ?? {};
          state.currentLine++;
        } else {
          state.currentLine++;
          onReturn.map = parseIndentedStringMap(state, indent);
        }
        continue;
      default:
        parserState.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message: `Unknown digression ON_RETURN property "${key}"`,
        });
        state.currentLine++;
        continue;
    }
  }

  return onReturn;
}

function parseIndentedStringMap(state: ParserState, parentIndent: number): Record<string, string> {
  const map: Record<string, string> = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    const match = trimmed.match(/^(\S+):\s*(.+)$/);
    if (match) {
      map[match[1]] = match[2].replace(/^"|"$/g, '');
    }
    state.currentLine++;
  }

  return map;
}

function validateDigressionDefinition(digression: Partial<Digression>, state: ParserState): void {
  if (!digression.do || digression.do.length === 0) {
    return;
  }

  let sawTerminal = false;
  let terminalName: 'RESUME' | 'GOTO' | null = null;

  for (let index = 0; index < digression.do.length; index++) {
    const action = digression.do[index];
    if (sawTerminal) {
      state.errors.push({
        line: state.currentLine + 1,
        column: 1,
        message: `Digression DO action after terminal ${terminalName} is unreachable`,
      });
      break;
    }

    if (action.resume) {
      sawTerminal = true;
      terminalName = 'RESUME';
    } else if (action.goto) {
      sawTerminal = true;
      terminalName = 'GOTO';
    }

    if (action.delegate && action.return !== true) {
      state.errors.push({
        line: state.currentLine + 1,
        column: 1,
        message:
          'Digression DELEGATE actions must declare RETURN: true until non-returning transfer semantics are implemented.',
      });
    }

    if (index > 0 && action.respond && sawTerminal) {
      break;
    }
  }
}

function parseDigressionsList(state: ParserState): Digression[] {
  const digressions: Digression[] = [];
  let currentDigression: Partial<Digression> | null = null;
  const baseIndent = getIndent(state.lines[state.currentLine] || '');

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // Check if we've left the digressions block
    if (trimmed && indent < baseIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    if (trimmed.startsWith('- INTENT:')) {
      if (currentDigression?.intent) {
        validateDigressionDefinition(currentDigression, state);
        digressions.push(currentDigression as Digression);
      }
      const rawIntent = trimmed.substring(9).trim();
      maybeWarnLegacyDigressionIntent(state, rawIntent);
      currentDigression = { intent: parseDigressionIntent(rawIntent) };
      state.currentLine++;
      continue;
    }

    if (currentDigression) {
      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        switch (key.toUpperCase()) {
          case 'CONDITION':
            currentDigression.condition = value;
            break;
          case 'DO':
            if (hasLegacyDigressionExecutionFields(currentDigression)) {
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message:
                  'Digression has mixed canonical DO actions and legacy execution fields (RESPOND/GOTO/DELEGATE/CALL/RESUME/CLEAR). Use DO only.',
              });
            }
            state.currentLine++;
            currentDigression.do = parseDigressionDoBlock(state, indent);
            continue;
          case 'GOTO':
            if (currentDigression.do) {
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message:
                  'Digression has mixed legacy execution field "GOTO" with canonical DO actions. Move GOTO inside DO.',
              });
            }
            currentDigression.goto = value;
            break;
          case 'DELEGATE':
            if (currentDigression.do) {
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message:
                  'Digression has mixed legacy execution field "DELEGATE" with canonical DO actions. Move DELEGATE inside DO.',
              });
            }
            currentDigression.delegate = value;
            break;
          case 'CALL':
            if (currentDigression.do) {
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message:
                  'Digression has mixed legacy execution field "CALL" with canonical DO actions. Move CALL inside DO.',
              });
            }
            {
              const invocation = parseToolInvocation(state, value);
              currentDigression.call = invocation.call;
              currentDigression.callSpec = invocation.callSpec;
            }
            break;
          case 'WITH':
          case 'AS':
            state.errors.push({
              line: state.currentLine + 1,
              column: 1,
              message: `${key.toUpperCase()}: must be nested under CALL: inside DIGRESSIONS.`,
            });
            break;
          case 'RESUME':
            if (currentDigression.do) {
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message:
                  'Digression has mixed legacy execution field "RESUME" with canonical DO actions. Move RESUME inside DO.',
              });
            }
            currentDigression.resume = value === 'true';
            break;
          case 'RESPOND': {
            if (currentDigression.do) {
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message:
                  'Digression has mixed legacy execution field "RESPOND" with canonical DO actions. Move RESPOND inside DO.',
              });
            }
            const respondIndent = getIndent(state.lines[state.currentLine]);
            if (value.startsWith('|')) {
              state.currentLine++;
              currentDigression.respond = parseMultiLineString(state);
            } else {
              currentDigression.respond = value.replace(/^"|"$/g, '');
              state.currentLine++;
            }
            currentDigression.voiceConfig = tryParseVoiceConfig(state, respondIndent);
            currentDigression.richContent = tryParseFormatsBlock(state, respondIndent);
            continue;
          }
          case 'MESSAGE_KEY':
            currentDigression.messageKey = value.replace(/^"|"$/g, '');
            break;
          case 'CLEAR':
            if (currentDigression.do) {
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message:
                  'Digression has mixed legacy execution field "CLEAR" with canonical DO actions. Move CLEAR inside DO.',
              });
            }
            currentDigression.clear = parseArray(value);
            break;
          case 'KEYWORDS':
            currentDigression.keywords = parseArray(value);
            break;
          default:
            state.errors.push({
              line: state.currentLine + 1,
              column: 1,
              message: `Unknown digression property "${key}"`,
            });
            break;
        }
      }
    }

    state.currentLine++;
  }

  if (currentDigression?.intent) {
    validateDigressionDefinition(currentDigression, state);
    digressions.push(currentDigression as Digression);
  }

  return digressions;
}

/**
 * Parse ON_SUCCESS block for CALL steps
 */
function parseOnSuccessBlock(state: ParserState, step: FlowStep): void {
  if (!step.onSuccess) {
    step.onSuccess = {};
  }
  parseCallResultBlock(state, step.onSuccess!);
}

function parseInlineCallBinding(rawValue: string): { callExpression: string; callAs?: string } {
  const trimmed = rawValue.trim();
  const match = trimmed.match(/^(.*?)(?:\s+AS\s+(\w[\w.]*))?$/i);
  if (!match) {
    return { callExpression: trimmed };
  }

  const [, callExpression, callAs] = match;
  return {
    callExpression: callExpression.trim(),
    callAs: callAs?.trim() || undefined,
  };
}

function extractToolNameFromCallExpression(callExpression: string): string | undefined {
  const trimmed = callExpression.trim();
  if (!trimmed) {
    return undefined;
  }

  const toolNameMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(|$)/);
  return toolNameMatch?.[1];
}

function parseCallWithAssignments(state: ParserState): Record<string, string> {
  const withObj: Record<string, string> = {};
  const withBaseIndent = getIndent(state.lines[state.currentLine]);
  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const withLine = state.lines[state.currentLine];
    const withIndent = getIndent(withLine);
    const withTrimmed = withLine.trim();
    if (!withTrimmed || withIndent <= withBaseIndent) {
      break;
    }

    const withColonIdx = withTrimmed.indexOf(':');
    if (withColonIdx !== -1) {
      const withKey = withTrimmed.slice(0, withColonIdx).trim();
      const withVal = withTrimmed.slice(withColonIdx + 1).trim();
      withObj[withKey] = withVal;
    }
    state.currentLine++;
  }

  return withObj;
}

function parseToolInvocation(
  state: ParserState,
  rawValue: string,
): {
  call?: string;
  callWith?: Record<string, string>;
  callAs?: string;
  callSpec?: ToolInvocationAST;
} {
  const { callExpression, callAs: inlineCallAs } = parseInlineCallBinding(rawValue);
  const call = callExpression || undefined;
  let callWith: Record<string, string> | undefined;
  let callAs = inlineCallAs;

  const callBaseIndent = getIndent(state.lines[state.currentLine]);
  while (state.currentLine + 1 < state.lines.length) {
    const nextCallLine = state.lines[state.currentLine + 1];
    const nextCallIndent = getIndent(nextCallLine);
    const nextCallTrimmed = nextCallLine.trim();
    if (!nextCallTrimmed || nextCallIndent <= callBaseIndent) {
      break;
    }

    if (/^WITH:/i.test(nextCallTrimmed)) {
      state.currentLine++;
      callWith = parseCallWithAssignments(state);
      state.currentLine--;
      continue;
    }

    if (/^AS:/i.test(nextCallTrimmed)) {
      state.currentLine++;
      callAs = nextCallTrimmed.replace(/^AS:\s*/i, '').trim() || callAs;
      continue;
    }

    break;
  }

  const tool = call ? extractToolNameFromCallExpression(call) : undefined;
  const callSpec =
    tool !== undefined
      ? {
          tool,
          ...(callWith ? { with: callWith } : {}),
          ...(callAs ? { as: callAs } : {}),
        }
      : undefined;

  return { call, callWith, callAs, callSpec };
}

/**
 * Generic parser for ON_SUCCESS / ON_FAILURE blocks.
 * Supports both simple (RESPOND/THEN) and conditional (- IF: / - ELSE:) forms.
 */
function parseCallResultBlock(
  state: ParserState,
  block: {
    respond?: string;
    messageKey?: string;
    voiceConfig?: VoiceConfigAST;
    richContent?: import('../types/agent-based.js').RichContentAST;
    actions?: ActionSetAST;
    set?: Record<string, string>;
    then?: string;
    branches?: import('../types/agent-based.js').CallResultBranchAST[];
  },
): void {
  const baseIndent = getIndent(state.lines[state.currentLine - 1] || '');

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // Check if we've left the block
    if (trimmed && indent <= baseIndent) {
      break;
    }

    // Conditional branch: "- IF: condition" or "- ELSE:"
    if (trimmed.startsWith('- IF:') || trimmed.startsWith('- ELSE:')) {
      if (!block.branches) {
        block.branches = [];
      }
      const branch: import('../types/agent-based.js').CallResultBranchAST = {};

      if (trimmed.startsWith('- IF:')) {
        branch.condition = trimmed.substring(5).trim();
      }
      // ELSE has no condition (undefined = default branch)

      state.currentLine++;

      // Parse branch body (SET, RESPOND, CALL, THEN at deeper indent)
      const branchIndent = indent;
      while (state.currentLine < state.lines.length) {
        const bLine = state.lines[state.currentLine];
        const bTrimmed = bLine.trim();
        const bIndent = getIndent(bLine);

        if (bTrimmed && bIndent <= branchIndent) {
          // Also break on next branch at same level
          if (
            bTrimmed.startsWith('- IF:') ||
            bTrimmed.startsWith('- ELSE:') ||
            bIndent <= baseIndent
          ) {
            break;
          }
        }

        const bPropMatch = bTrimmed.match(/^(\w+):\s*(.*)$/);
        if (bPropMatch) {
          const [, bKey, bValue] = bPropMatch;
          switch (bKey.toUpperCase()) {
            case 'SET':
              if (!branch.set) branch.set = {};
              // SET: var = value
              const setMatch = bValue.match(/^(\S+)\s*=\s*(.+)$/);
              if (setMatch) {
                branch.set[setMatch[1]] = setMatch[2].replace(/^"|"$/g, '');
              }
              break;
            case 'RESPOND': {
              const respondIndent = getIndent(state.lines[state.currentLine]);
              if (bValue.startsWith('|')) {
                state.currentLine++;
                branch.respond = parseMultiLineString(state);
              } else {
                branch.respond = bValue.replace(/^"|"$/g, '');
                state.currentLine++;
              }
              branch.voiceConfig = tryParseVoiceConfig(state, respondIndent);
              branch.richContent = tryParseFormatsBlock(state, respondIndent);
              branch.actions = tryParseActionsBlock(state, respondIndent);
              continue;
            }
            case 'MESSAGE_KEY':
              branch.messageKey = bValue.replace(/^"|"$/g, '');
              break;
            case 'CALL': {
              const invocation = parseToolInvocation(state, bValue);
              branch.call = invocation.call;
              branch.callSpec = invocation.callSpec;
              break;
            }
            case 'WITH':
            case 'AS':
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message: `${bKey.toUpperCase()}: must be nested under CALL: in ON_SUCCESS/ON_FAILURE branches.`,
              });
              break;
            case 'THEN':
              branch.then = bValue;
              break;
          }
        }

        // Handle nested "- IF:" within a branch (for inner conditionals like "- IF: verification_attempts >= 3")
        if (bTrimmed.startsWith('- IF:') || bTrimmed.startsWith('- ELSE:')) {
          break;
        }

        state.currentLine++;
      }

      block.branches.push(branch);
      continue; // Don't increment again
    }

    // Simple properties (RESPOND, THEN)
    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key.toUpperCase()) {
        case 'RESPOND': {
          const respondIndent = getIndent(state.lines[state.currentLine]);
          if (value.startsWith('|')) {
            state.currentLine++;
            block.respond = parseMultiLineString(state);
          } else {
            block.respond = value.replace(/^"|"$/g, '');
            state.currentLine++;
          }
          block.voiceConfig = tryParseVoiceConfig(state, respondIndent);
          block.richContent = tryParseFormatsBlock(state, respondIndent);
          block.actions = tryParseActionsBlock(state, respondIndent);
          continue;
        }
        case 'MESSAGE_KEY':
          block.messageKey = value.replace(/^"|"$/g, '');
          break;
        case 'SET': {
          const set = parseIndentedSetAssignments(state, indent, value);
          block.set = {
            ...(block.set ?? {}),
            ...set,
          };
          continue;
        }
        case 'WITH':
        case 'AS':
          state.errors.push({
            line: state.currentLine + 1,
            column: 1,
            message: `${key.toUpperCase()}: must be nested under CALL: in ON_SUCCESS/ON_FAILURE blocks.`,
          });
          break;
        case 'THEN':
          block.then = value;
          break;
      }
    }

    state.currentLine++;
  }
}

/**
 * Parse ON_FAIL block for CALL steps
 */
function parseOnFailBlock(state: ParserState, step: FlowStep): void {
  if (!step.onFailure) {
    step.onFailure = {};
  }
  parseCallResultBlock(state, step.onFailure!);
}

/**
 * Parse ON_INPUT block with conditional branches
 */
function parseOnInput(state: ParserState): Array<{
  condition?: string;
  respond?: string;
  messageKey?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: import('../types/agent-based.js').RichContentAST;
  actions?: ActionSetAST;
  set?: Record<string, string>;
  call?: string;
  callSpec?: ToolInvocationAST;
  then: string;
}> {
  const branches: Array<{
    condition?: string;
    respond?: string;
    messageKey?: string;
    voiceConfig?: VoiceConfigAST;
    richContent?: import('../types/agent-based.js').RichContentAST;
    actions?: ActionSetAST;
    set?: Record<string, string>;
    call?: string;
    callSpec?: ToolInvocationAST;
    then: string;
  }> = [];

  let currentBranch: {
    condition?: string;
    respond?: string;
    messageKey?: string;
    voiceConfig?: VoiceConfigAST;
    richContent?: import('../types/agent-based.js').RichContentAST;
    actions?: ActionSetAST;
    set?: Record<string, string>;
    call?: string;
    callSpec?: ToolInvocationAST;
    then?: string;
  } | null = null;

  const baseIndent = getIndent(state.lines[state.currentLine - 1]);

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // Check if we've left the ON_INPUT block
    if (trimmed && indent <= baseIndent && !trimmed.startsWith('-')) {
      break;
    }

    // Empty line
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    // New branch: - IF: or - ELSE:
    if (trimmed.startsWith('- IF:') || trimmed.startsWith('- ELSE:')) {
      // Save previous branch
      if (currentBranch && currentBranch.then) {
        branches.push(
          currentBranch as {
            condition?: string;
            respond?: string;
            messageKey?: string;
            voiceConfig?: VoiceConfigAST;
            richContent?: import('../types/agent-based.js').RichContentAST;
            actions?: ActionSetAST;
            set?: Record<string, string>;
            call?: string;
            callSpec?: ToolInvocationAST;
            then: string;
          },
        );
      }

      if (trimmed.startsWith('- IF:')) {
        const condition = trimmed.substring(5).trim();
        currentBranch = { condition };
      } else {
        // ELSE branch has no condition
        currentBranch = {};
      }
      state.currentLine++;
      continue;
    }

    // Branch properties
    if (currentBranch) {
      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        switch (key.toUpperCase()) {
          case 'RESPOND': {
            const respondIndent = getIndent(state.lines[state.currentLine]);
            if (value.startsWith('|')) {
              state.currentLine++;
              currentBranch.respond = parseMultiLineString(state);
            } else {
              currentBranch.respond = value.replace(/^"|"$/g, '');
              state.currentLine++;
            }
            currentBranch.voiceConfig = tryParseVoiceConfig(state, respondIndent);
            currentBranch.richContent = tryParseFormatsBlock(state, respondIndent);
            currentBranch.actions = tryParseActionsBlock(state, respondIndent);
            continue;
          }
          case 'MESSAGE_KEY':
            currentBranch.messageKey = value.replace(/^"|"$/g, '');
            break;
          case 'SET': {
            // Parse SET: field = value
            const setMatch = value.match(/^(\w+)\s*=\s*(.+)$/);
            if (setMatch) {
              if (!currentBranch.set) currentBranch.set = {};
              currentBranch.set[setMatch[1]] = setMatch[2];
            }
            break;
          }
          case 'CALL': {
            const invocation = parseToolInvocation(state, value);
            currentBranch.call = invocation.call;
            currentBranch.callSpec = invocation.callSpec;
            break;
          }
          case 'WITH':
          case 'AS':
            state.errors.push({
              line: state.currentLine + 1,
              column: 1,
              message: `${key.toUpperCase()}: must be nested under CALL: inside ON_INPUT/ON_RESULT branches.`,
            });
            break;
          case 'THEN':
            currentBranch.then = value;
            break;
        }
      }
    }

    state.currentLine++;
  }

  // Save last branch
  if (currentBranch && currentBranch.then) {
    branches.push(
      currentBranch as {
        condition?: string;
        respond?: string;
        messageKey?: string;
        voiceConfig?: VoiceConfigAST;
        richContent?: import('../types/agent-based.js').RichContentAST;
        actions?: ActionSetAST;
        set?: Record<string, string>;
        call?: string;
        callSpec?: ToolInvocationAST;
        then: string;
      },
    );
  }

  return branches;
}

function parsePersona(state: ParserState): AgentPersona {
  const line = state.lines[state.currentLine];

  // Inline quoted persona: PERSONA: "description"
  const inlineMatch = line.match(/^PERSONA:\s*"([^"]+)"$/);
  if (inlineMatch) {
    state.currentLine++;
    return { description: inlineMatch[1] };
  }

  // Check for pipe (|) multiline indicator
  const afterColon = line.substring(8).trim();
  if (afterColon === '|') {
    state.currentLine++;
    const description = parseMultiLineString(state);
    return { description };
  }

  // Inline unquoted persona: PERSONA: some text here
  if (afterColon) {
    state.currentLine++;
    return { description: afterColon.replace(/^"|"$/g, '') };
  }

  // PERSONA: alone on line — multi-line indented block
  state.currentLine++;
  const description = parseMultiLineString(state);
  if (description) {
    return { description };
  }
  return { description: '' };
}

function parseLimitations(state: ParserState): AgentLimitation[] {
  state.currentLine++;
  const limitations: AgentLimitation[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another section
    if (
      trimmed &&
      !trimmed.startsWith('-') &&
      !trimmed.startsWith('#') &&
      !line.startsWith(' ') &&
      !line.startsWith('\t')
    ) {
      break;
    }

    if (trimmed.startsWith('-')) {
      const desc = trimmed.substring(1).trim().replace(/^"|"$/g, '');
      limitations.push({ description: desc });
    }

    state.currentLine++;
  }

  return limitations;
}

function parseTools(state: ParserState): {
  tools: AgentTool[];
  imports: ToolImport[];
} {
  state.currentLine++;
  const tools: AgentTool[] = [];
  const imports: ToolImport[] = [];
  const seenNames = new Set<string>();

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && !trimmed.startsWith('#')) {
      if (!trimmed.includes('(') || trimmed.endsWith(':')) {
        break;
      }
    }

    // Skip empty lines
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    // Skip comments
    if (trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    // Reject removed syntax: FROM "path" USE: tool1, tool2
    if (/^FROM\s+"[^"]+"\s+USE:/i.test(trimmed)) {
      state.errors.push({
        line: state.currentLine + 1,
        column: 0,
        message: `E720: 'FROM...USE' syntax has been removed. Define tools as signatures in agent DSL and manage implementations in Project Tools.`,
      });
      state.currentLine++;
      continue;
    }

    // Reject removed syntax: USE TOOL: slug[@version]
    if (/^USE\s+TOOL:/i.test(trimmed)) {
      state.errors.push({
        line: state.currentLine + 1,
        column: 0,
        message: `E720: 'USE TOOL:' syntax has been removed. Define tools as signatures in agent DSL and manage implementations in Project Tools.`,
      });
      state.currentLine++;
      continue;
    }

    // Parse tool definition: name(params) [-> return_type]
    const toolMatch = trimmed.match(/^(\w+)\(([^)]*)\)(?:\s*->\s*(.+))?$/);
    if (toolMatch) {
      const [, name, paramsStr, returnStr] = toolMatch;

      // Validate: tool names starting with __ are reserved for internal system tools
      if (name.startsWith('__')) {
        state.errors.push({
          line: state.currentLine + 1,
          column: 0,
          message: `Tool name "${name}" is reserved. Names starting with __ are internal system tools.`,
        });
        state.currentLine++;
        continue;
      }

      const parameters = parseToolParams(paramsStr);
      const returns = parseToolReturn(returnStr?.trim() || 'object');
      const tool: AgentTool = { name, parameters, returns };

      // D32: Reject duplicate tool names within same agent
      if (seenNames.has(name)) {
        state.errors.push({
          line: state.currentLine + 1,
          column: 0,
          message: `Duplicate tool name '${name}' in TOOLS section. Each tool name must be unique within an agent.`,
        });
        state.currentLine++;
        continue;
      }
      seenNames.add(name);

      // Parse optional indented properties after tool signature
      const toolIndent = getIndent(line);
      state.currentLine++;

      // Pre-scan indented property lines to reject implementation properties
      // in agent DSL TOOLS section. These belong in Project Tool definitions.
      // Properties nested inside allowed blocks (e.g. hints:) are exempt —
      // only top-level tool properties are checked.
      let scanLine = state.currentLine;
      let nestedBlockIndent = -1;
      while (scanLine < state.lines.length) {
        const scanContent = state.lines[scanLine];
        const scanTrimmed = scanContent.trim();
        const scanIndent = getIndent(scanContent);
        if (scanTrimmed && scanIndent <= toolIndent) break;
        if (!scanTrimmed) {
          scanLine++;
          continue;
        }

        // If we were inside a nested block and this line's indent is back
        // at or before the block's own indent, we've left the nested block.
        if (nestedBlockIndent >= 0 && scanIndent <= nestedBlockIndent) {
          nestedBlockIndent = -1;
        }

        const propKeyMatch = scanTrimmed.match(/^(\w+):/);
        if (propKeyMatch) {
          const propName = propKeyMatch[1].toLowerCase();

          // Only check top-level tool properties (not inside a nested block)
          if (nestedBlockIndent < 0 && TOOL_IMPLEMENTATION_PROPERTIES.has(propName)) {
            state.warnings.push({
              line: scanLine + 1,
              message: `E720: Implementation property '${propName}' not allowed in agent DSL TOOLS section. Tool implementation must be configured in Project Tools.`,
            });
          }

          // Detect the start of a nested block: key with no inline value
          const afterColon = scanContent.substring(scanContent.indexOf(':') + 1).trim();
          if (!afterColon && nestedBlockIndent < 0) {
            nestedBlockIndent = scanIndent;
          }
        }
        scanLine++;
      }

      const props = parseToolProperties(state, toolIndent);
      // Only apply signature-level properties — reject implementation bindings
      if (props.hints) tool.hints = props.hints;
      if (props.type) tool.type = props.type;
      if (props.description) tool.description = props.description;
      if (props.storeResult !== undefined) tool.storeResult = props.storeResult;
      if (props.onResult) tool.onResult = props.onResult;
      if (props.onError) tool.onError = props.onError;
      if (props.contextAccess) tool.contextAccess = props.contextAccess;
      if (props.compaction) tool.compaction = props.compaction;
      if (props.confirmation) tool.confirmation = props.confirmation;
      if (props.piiAccess) tool.piiAccess = props.piiAccess;
      if (props.authProfile) tool.authProfile = props.authProfile;
      if (props.authJit !== undefined) tool.authJit = props.authJit;
      if (props.consent) tool.consent = props.consent;
      if (props.connection) tool.connection = props.connection;
      if (props.parameterEnrichments) {
        applyParameterEnrichments(tool.parameters, props.parameterEnrichments);
      }

      tools.push(tool);
      continue;
    }

    if (/^[^\s#].*\([^)]*\)/.test(trimmed)) {
      state.errors.push({
        line: state.currentLine + 1,
        column: getIndent(line),
        message: `Invalid tool signature '${trimmed}'. Use a tool name made of letters, numbers, and underscores, for example payments__check_refund_eligibility(...).`,
      });
      state.currentLine++;
      continue;
    }

    state.currentLine++;
  }

  // D31: Enforce max 100 tools per agent
  if (tools.length > 100) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: `Too many tools: ${tools.length} defined, maximum is 100. Reduce the number of tools in this agent's TOOLS section.`,
    });
  }

  return { tools, imports };
}

/**
 * Map snake_case semantics keys to camelCase AST property names.
 * Keys without an explicit mapping are returned as-is.
 */
const SEMANTIC_KEY_MAP: Record<string, string> = {
  convert_to: 'convertTo',
  kore_entity_type: 'koreEntityType',
  enum_set: 'enumSet',
};

const SEMANTIC_LIST_KEYS = new Set<string>(['components', 'enumSet']);

function mapSemanticKey(key: string): string {
  return SEMANTIC_KEY_MAP[key] ?? key;
}

function isSemanticListKey(mappedKey: string): boolean {
  return SEMANTIC_LIST_KEYS.has(mappedKey);
}

function parseMaskConfigBlock(
  state: ParserState,
  parentIndent: number,
): { showFirst: number; showLast: number; char: string } {
  const maskConfig = {
    showFirst: 0,
    showLast: 4,
    char: '*',
  };

  state.currentLine++;
  while (state.currentLine < state.lines.length) {
    const nextLine = state.lines[state.currentLine];
    const trimmed = nextLine.trim();
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    const indent = nextLine.length - nextLine.trimStart().length;
    if (indent <= parentIndent) {
      break;
    }

    const match = trimmed.match(/^(\w+):\s*(.+)$/);
    if (!match) {
      break;
    }

    const key = match[1].toLowerCase();
    const value = match[2].trim();
    if (key === 'show_first') maskConfig.showFirst = parseInt(value, 10);
    else if (key === 'show_last') maskConfig.showLast = parseInt(value, 10);
    else if (key === 'char') maskConfig.char = value.replace(/^"|"$/g, '');
    else break;

    state.currentLine++;
  }

  return maskConfig;
}

function parseGather(state: ParserState): GatherField[] {
  state.currentLine++;
  const fields: GatherField[] = [];
  let currentField: Partial<GatherField> | null = null;

  // Known top-level sections that end GATHER
  const topLevelSections = [
    'CONSTRAINTS:',
    'MEMORY:',
    'DELEGATE:',
    'HANDOFF:',
    'ESCALATE:',
    'COMPLETE:',
    'FLOW:',
    'TOOLS:',
    'LIMITATIONS:',
    'PERSONA:',
    'MULTI_INTENT:',
  ];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    // Check if we've reached another top-level section (no indentation)
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && topLevelSections.includes(trimmed)) {
      break;
    }

    // Also break on any unindented line that ends with : and is a known section pattern
    if (indent === 0 && trimmed.match(/^[A-Z_]+:$/)) {
      break;
    }

    // Known property keywords that can appear as "KEY:" (no value) - must NOT be treated as field names
    const blockPropertyKeywords = [
      'SEMANTICS',
      'ACTIVATION',
      'MASK_CONFIG',
      'OPTIONS',
      'semantics',
      'activation',
      'mask_config',
      'options',
    ];

    // New field: fieldname: (must be indented)
    const fieldMatch = trimmed.match(/^(\w+):$/);
    if (
      fieldMatch &&
      line.match(/^\s{2,}\w+:$/) &&
      !blockPropertyKeywords.includes(fieldMatch[1])
    ) {
      if (currentField && currentField.name) {
        fields.push(currentField as GatherField);
      }
      currentField = {
        name: fieldMatch[1],
        prompt: '',
        type: 'string',
        required: true,
      };
      state.currentLine++;
      continue;
    }

    // Field properties (allow empty value for block properties like SEMANTICS: and ACTIVATION:)
    if (currentField && trimmed) {
      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        switch (key.toLowerCase()) {
          case 'prompt':
            currentField.prompt = value.replace(/^"|"$/g, '');
            break;
          case 'message_key':
            currentField.messageKey = value.replace(/^"|"$/g, '');
            break;
          case 'type':
            currentField.type = value;
            break;
          case 'required':
            currentField.required = value === 'true';
            break;
          case 'default':
            currentField.default = parseDefaultValue(value);
            break;
          case 'validate':
            currentField.validate = value.replace(/^"|"$/g, '');
            break;
          case 'options':
            if (value && value.trim()) {
              // Inline format: options: ["iPhone", "iPad", "Mac"]
              currentField.options = value
                .replace(/^\[|\]$/g, '')
                .split(',')
                .map((s: string) => s.trim())
                .filter(Boolean);
            } else {
              // Block format: options:\n  - "iPhone"\n  - "iPad"
              const optionsList: string[] = [];
              const parentIndent = line.length - line.trimStart().length;
              state.currentLine++;
              while (state.currentLine < state.lines.length) {
                const optLine = state.lines[state.currentLine];
                const optTrimmed = optLine.trim();
                if (!optTrimmed) {
                  state.currentLine++;
                  continue;
                }
                const optIndent = optLine.length - optLine.trimStart().length;
                if (optIndent <= parentIndent) break;
                const listItemMatch = optTrimmed.match(/^-\s*"?([^"]*)"?$/);
                if (listItemMatch) {
                  optionsList.push(listItemMatch[1].trim());
                  state.currentLine++;
                } else {
                  break;
                }
              }
              currentField.options = optionsList;
              continue; // currentLine already advanced past the block
            }
            break;
          case 'infer':
            currentField.infer = value === 'true';
            break;
          case 'infer_confidence':
            currentField.inferConfidence = parseFloat(value);
            break;
          case 'infer_confirm':
            currentField.inferConfirm = value === 'true';
            break;
          case 'semantics': {
            // Parse SEMANTICS sub-block on subsequent indented lines
            if (!value || value.trim() === '') {
              const semantics: Record<string, unknown> = {};
              state.currentLine++;
              while (state.currentLine < state.lines.length) {
                const semLine = state.lines[state.currentLine];
                const semTrimmed = semLine.trim();
                if (!semTrimmed) {
                  state.currentLine++;
                  continue;
                }
                const semIndent = semLine.length - semLine.trimStart().length;
                const parentIndent = line.length - line.trimStart().length;
                if (semIndent <= parentIndent && semTrimmed) break;
                const semPropMatch = semTrimmed.match(/^(\w+):\s*(.+)$/);
                if (semPropMatch) {
                  const [, semKey, semVal] = semPropMatch;
                  const lowerSemKey = semKey.toLowerCase();
                  const mappedKey = mapSemanticKey(lowerSemKey);
                  if (isSemanticListKey(mappedKey)) {
                    semantics[mappedKey] = semVal
                      .replace(/^\[|\]$/g, '')
                      .split(',')
                      .map((s: string) => s.trim())
                      .filter(Boolean);
                  } else {
                    semantics[mappedKey] = semVal.replace(/^"|"$/g, '');
                  }
                } else {
                  break;
                }
                state.currentLine++;
              }
              currentField.semantics = semantics as any;
              continue; // Skip the state.currentLine++ at the end of the while loop
            }
            break;
          }
          case 'range':
            currentField.range = value === 'true';
            break;
          case 'list':
            currentField.list = value === 'true';
            break;
          case 'preferences':
            currentField.preferences = value === 'true';
            break;
          case 'activation': {
            if (!value || value.trim() === '') {
              // Block format - look for WHEN: on next line
              state.currentLine++;
              while (state.currentLine < state.lines.length) {
                const actLine = state.lines[state.currentLine].trim();
                if (!actLine) {
                  state.currentLine++;
                  continue;
                }
                const whenMatch = actLine.match(/^WHEN:\s*"?(.+?)"?$/i);
                if (whenMatch) {
                  currentField.activation = { when: whenMatch[1] };
                  state.currentLine++;
                  break;
                } else {
                  break;
                }
              }
              continue;
            } else {
              currentField.activation = value as 'required' | 'optional' | 'progressive';
            }
            break;
          }
          case 'depends_on':
            currentField.dependsOn = value
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean);
            break;
          case 'prompt_mode':
            currentField.promptMode = value as 'ask' | 'extract_only';
            break;
          case 'validation_process':
            currentField.validationProcess = value as 'REGEX' | 'CODE' | 'LLM';
            break;
          case 'retry_prompt':
            currentField.retryPrompt = value.replace(/^"|"$/g, '');
            break;
          case 'max_retries':
            currentField.maxRetries = parseInt(value, 10);
            break;
          case 'sensitive':
            currentField.sensitive = value === 'true' || value === 'yes';
            break;
          case 'sensitive_display':
            currentField.sensitiveDisplay = value as 'redact' | 'mask' | 'replace';
            break;
          case 'mask_config': {
            // Nested block pattern (like SEMANTICS)
            if (!value || value === '') {
              currentField.maskConfig = parseMaskConfigBlock(
                state,
                line.length - line.trimStart().length,
              );
              continue;
            }
            break;
          }
          case 'transient':
            currentField.transient = value === 'true' || value === 'yes';
            break;
          case 'pii_type': {
            const normalized = value.trim().toLowerCase();
            const allowed: Array<GatherField['piiType']> = [
              'email',
              'phone',
              'ssn',
              'credit_card',
              'address',
              'name',
              'custom',
            ];
            if (allowed.includes(normalized as GatherField['piiType'])) {
              currentField.piiType = normalized as GatherField['piiType'];
            }
            break;
          }
          case 'entity_ref':
            currentField.entityRef = value;
            break;
          case 'extraction_pattern':
            currentField.extractionPattern = value.replace(/^"|"$/g, '');
            break;
          case 'extraction_group':
            currentField.extractionGroup = parseInt(value, 10);
            break;
        }
      }
    }

    state.currentLine++;
  }

  if (currentField && currentField.name) {
    fields.push(currentField as GatherField);
  }

  return fields;
}

// =============================================================================
// ATTACHMENTS PARSER
// =============================================================================

function parseAttachments(state: ParserState): AttachmentFieldAST[] {
  state.currentLine++;
  const fields: AttachmentFieldAST[] = [];
  let currentField: Partial<AttachmentFieldAST> | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    // Check if we've reached another top-level section (no indentation, UPPER_CASE:)
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.match(/^[A-Z_]+:$/)) {
      break;
    }

    // New attachment field: fieldname: (must be indented)
    const fieldMatch = trimmed.match(/^(\w+):$/);
    if (fieldMatch && line.match(/^\s{2,}\w+:$/)) {
      if (currentField && currentField.name) {
        // Default required to true if not specified
        if (currentField.required === undefined) {
          currentField.required = true;
        }
        fields.push(currentField as AttachmentFieldAST);
      }
      currentField = {
        name: fieldMatch[1],
        prompt: '',
        category: 'document',
        required: true,
      };
      state.currentLine++;
      continue;
    }

    // Field properties
    if (currentField && trimmed) {
      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        switch (key.toLowerCase()) {
          case 'prompt':
            currentField.prompt = value.replace(/^"|"$/g, '');
            break;
          case 'category':
            currentField.category = value as AttachmentCategory;
            break;
          case 'required':
            currentField.required = value === 'true';
            break;
          case 'max_size_mb':
          case 'max_file_size_mb':
            currentField.maxFileSizeMb = parseInt(value, 10);
            break;
          case 'allowed_types':
            currentField.allowedMimeTypes = value
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean);
            break;
          case 'ocr_enabled':
            currentField.ocrEnabled = value === 'true';
            break;
          case 'transcription_enabled':
          case 'transcription':
            currentField.transcriptionEnabled = value === 'true';
            break;
          case 'key_frame_extraction':
            currentField.keyFrameExtraction = value === 'true';
            break;
        }
      }
    }

    state.currentLine++;
  }

  if (currentField && currentField.name) {
    if (currentField.required === undefined) {
      currentField.required = true;
    }
    fields.push(currentField as AttachmentFieldAST);
  }

  return fields;
}

// =============================================================================
// DESTINATIONS PARSER
// =============================================================================

function parseDestinations(state: ParserState): DestinationAST[] {
  state.currentLine++;
  const destinations: DestinationAST[] = [];
  let currentDest: Partial<DestinationAST> | null = null;
  let destIndent = -1; // Indent level of destination name entries
  let parsingHeaders = false;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    // Check if we've reached another top-level section (no indentation, UPPER_CASE:)
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.match(/^[A-Z][A-Z_]*:/)) {
      break;
    }

    // New destination entry: "name:" with no value, at the destination-name indent level
    const destNameMatch = trimmed.match(/^(\w+):$/);
    if (destNameMatch && indent >= 2) {
      // First destination sets the indent level; subsequent must match
      if (destIndent === -1) {
        destIndent = indent;
      }

      if (indent === destIndent) {
        // Save previous destination
        if (currentDest && currentDest.name) {
          if (!currentDest.url) {
            state.errors.push({
              line: state.currentLine,
              column: 0,
              message: `Destination "${currentDest.name}" is missing a required "url" property`,
            });
          }
          destinations.push(currentDest as DestinationAST);
        }
        currentDest = { name: destNameMatch[1] };
        parsingHeaders = false;
        state.currentLine++;
        continue;
      }
    }

    // Destination properties (deeper than destIndent)
    if (currentDest && trimmed) {
      if (parsingHeaders && indent > destIndent + 2) {
        // This is a header entry under "headers:"
        const headerMatch = trimmed.match(/^([^:]+):\s*(.*)$/);
        if (headerMatch) {
          if (!currentDest.headers) currentDest.headers = {};
          currentDest.headers[headerMatch[1].trim()] = headerMatch[2].trim().replace(/^"|"$/g, '');
        }
        state.currentLine++;
        continue;
      }

      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        parsingHeaders = false;

        switch (key.toLowerCase()) {
          case 'url':
            currentDest.url = value.replace(/^"|"$/g, '');
            break;
          case 'method':
            currentDest.method = value.toUpperCase();
            break;
          case 'auth':
            currentDest.auth = value.replace(/^"|"$/g, '');
            break;
          case 'headers':
            parsingHeaders = true;
            break;
          default:
            break;
        }
      }
    }

    state.currentLine++;
  }

  // Push last destination
  if (currentDest && currentDest.name) {
    if (!currentDest.url) {
      state.errors.push({
        line: state.currentLine,
        column: 0,
        message: `Destination "${currentDest.name}" is missing a required "url" property`,
      });
    }
    destinations.push(currentDest as DestinationAST);
  }

  return destinations;
}

function parseMemory(state: ParserState): MemoryConfig {
  state.currentLine++;
  const memory: MemoryConfig = {
    session: [],
    persistent: [],
    remember: [],
    recall: [],
  };

  let currentSection: 'session' | 'persistent' | 'remember' | 'recall' | 'reads' | 'writes' | null =
    null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (
        trimmed.match(/^[A-Z_]+:/) &&
        !['session:', 'persistent:', 'remember:', 'recall:', 'READS:', 'WRITES:'].includes(trimmed)
      ) {
        break;
      }
    }

    // Skip comments
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Sub-sections (support both old and new format)
    if (trimmed === 'session:' || trimmed === 'SESSION:') {
      currentSection = 'session';
      state.currentLine++;
      continue;
    }
    if (trimmed === 'persistent:' || trimmed === 'PERSISTENT:') {
      currentSection = 'persistent';
      state.currentLine++;
      continue;
    }
    if (trimmed === 'remember:' || trimmed === 'REMEMBER:') {
      currentSection = 'remember';
      state.currentLine++;
      continue;
    }
    if (trimmed === 'recall:' || trimmed === 'RECALL:') {
      currentSection = 'recall';
      state.currentLine++;
      continue;
    }
    // New format: READS and WRITES
    if (trimmed === 'READS:') {
      currentSection = 'reads';
      state.currentLine++;
      continue;
    }
    if (trimmed === 'WRITES:') {
      currentSection = 'writes';
      state.currentLine++;
      continue;
    }

    // Parse items based on current section
    if (currentSection === 'session' && trimmed.startsWith('-')) {
      // Handle both `- varname` and `- NAME: varname` formats
      const nameKV = trimmed.substring(1).trim().split('#')[0].trim();
      const nameMatch = nameKV.match(/^NAME:\s*(.+)$/i);
      const name = nameMatch ? nameMatch[1].trim() : nameKV;
      const sessionVar: SessionMemoryVar = { name };
      // Look ahead for INITIAL:, RESET:, TYPE:, DESCRIPTION: on subsequent lines
      while (state.currentLine + 1 < state.lines.length) {
        const nextLine = state.lines[state.currentLine + 1].trim();
        const initialMatch = nextLine.match(/^INITIAL:\s*(.+)$/i);
        const resetMatch = nextLine.match(/^RESET:\s*(.+)$/i);
        const typeMatch = nextLine.match(/^TYPE:\s*(.+)$/i);
        const descMatch = nextLine.match(/^DESCRIPTION:\s*(.+)$/i);
        if (initialMatch) {
          const rawValue = initialMatch[1].trim().replace(/^"|"$/g, '');
          // Parse as number if possible, otherwise keep as string
          const numValue = Number(rawValue);
          sessionVar.initial_value = !isNaN(numValue) && rawValue !== '' ? numValue : rawValue;
          state.currentLine++;
        } else if (resetMatch) {
          sessionVar.reset = resetMatch[1].trim() as 'per_session' | 'per_step' | 'never';
          state.currentLine++;
        } else if (typeMatch) {
          sessionVar.type = typeMatch[1].trim() as SessionMemoryVar['type'];
          state.currentLine++;
        } else if (descMatch) {
          sessionVar.description = descMatch[1].trim().replace(/^"|"$/g, '');
          state.currentLine++;
        } else {
          break;
        }
      }
      memory.session.push(sessionVar);
    } else if (currentSection === 'persistent' && trimmed.startsWith('-')) {
      // Handle both `- path` and `- PATH: "path"` formats
      const pathKV = trimmed.substring(1).trim().split('#')[0].trim();
      const pathMatch = pathKV.match(/^PATH:\s*"?([^"]+)"?$/i);
      const path = pathMatch ? pathMatch[1].trim() : pathKV;
      const persistentEntry: PersistentMemoryPath = { path };
      // Look ahead for SCOPE:, TYPE:, UNIT:, DEFAULT_VALUE:, ACCESS:, DESCRIPTION: on subsequent indented lines
      while (state.currentLine + 1 < state.lines.length) {
        const nextRawLine = state.lines[state.currentLine + 1];
        const nextPLine = nextRawLine.trim();
        const scopeMatch = nextPLine.match(/^SCOPE:\s*(.+)$/i);
        const typeMatch = nextPLine.match(/^TYPE:\s*(.+)$/i);
        const unitMatch = nextPLine.match(/^UNIT:\s*(.+)$/i);
        const defaultMatch = nextPLine.match(/^DEFAULT_VALUE:\s*(.+)$/i);
        const accessMatch = nextPLine.match(/^ACCESS:\s*(.+)$/i);
        const descMatch = nextPLine.match(/^DESCRIPTION:\s*(.+)$/i);
        const sensitiveMatch = nextPLine.match(/^SENSITIVE:\s*(.+)$/i);
        const sensitiveDisplayMatch = nextPLine.match(/^SENSITIVE_DISPLAY:\s*(.+)$/i);
        const maskConfigMatch = nextPLine.match(/^MASK_CONFIG:\s*(.*)$/i);
        if (scopeMatch) {
          const scopeVal = scopeMatch[1].trim().toLowerCase();
          if (scopeVal === 'user' || scopeVal === 'project' || scopeVal === 'execution_tree') {
            persistentEntry.scope = scopeVal;
          }
          state.currentLine++;
        } else if (typeMatch) {
          persistentEntry.type = typeMatch[1].trim() as PersistentMemoryPath['type'];
          state.currentLine++;
        } else if (unitMatch) {
          persistentEntry.unit = unitMatch[1].trim();
          state.currentLine++;
        } else if (defaultMatch) {
          persistentEntry.defaultValue = defaultMatch[1].trim().replace(/^"|"$/g, '');
          state.currentLine++;
        } else if (accessMatch) {
          const accessVal = accessMatch[1].trim().toLowerCase();
          if (accessVal === 'read' || accessVal === 'write' || accessVal === 'readwrite') {
            persistentEntry.access = accessVal as 'read' | 'write' | 'readwrite';
          }
          state.currentLine++;
        } else if (descMatch) {
          persistentEntry.description = descMatch[1].trim().replace(/^"|"$/g, '');
          state.currentLine++;
        } else if (sensitiveMatch) {
          const sensitiveVal = sensitiveMatch[1].trim().toLowerCase();
          persistentEntry.sensitive = sensitiveVal === 'true' || sensitiveVal === 'yes';
          state.currentLine++;
        } else if (sensitiveDisplayMatch) {
          persistentEntry.sensitiveDisplay = sensitiveDisplayMatch[1]
            .trim()
            .toLowerCase() as PersistentMemoryPath['sensitiveDisplay'];
          state.currentLine++;
        } else if (maskConfigMatch) {
          if (!maskConfigMatch[1] || maskConfigMatch[1].trim() === '') {
            state.currentLine++;
            persistentEntry.maskConfig = parseMaskConfigBlock(
              state,
              nextRawLine.length - nextRawLine.trimStart().length,
            );
            // parseMaskConfigBlock stops on the next sibling line, so rewind one
            // step and let the lookahead loop decide whether that sibling is
            // another property, another persistent entry, or a new subsection.
            state.currentLine--;
            continue;
          }
          state.currentLine++;
        } else {
          break;
        }
      }
      memory.persistent.push(persistentEntry);
    } else if (currentSection === 'remember' && trimmed.startsWith('- WHEN')) {
      const trigger = parseRememberTrigger(state);
      if (trigger) memory.remember.push(trigger);
      // parseRememberTrigger advances currentLine; if it returned null,
      // we must still advance to avoid an infinite loop
      if (!trigger) state.currentLine++;
      continue;
    } else if (currentSection === 'recall' && trimmed.startsWith('- ON:')) {
      // New format: - ON: event_name with ACTION/PATHS/DOMAIN on subsequent lines
      const onMatch = trimmed.match(/^-\s*ON:\s*(.+)$/);
      if (onMatch) {
        const rawEvent = onMatch[1].trim();
        if (isLegacyRecallEvent(rawEvent)) {
          state.errors.push({
            line: state.currentLine,
            column: 0,
            message: buildLegacyRecallEventError(rawEvent),
          });
          state.currentLine++;
          continue;
        }

        const recallEntry: RecallInstruction = {
          event: rawEvent,
          instruction: '',
        };
        // Collect action properties from subsequent lines
        let actionType: string | null = null;
        let actionDomain: string | undefined;
        let actionPaths: string[] | undefined;
        while (state.currentLine + 1 < state.lines.length) {
          const nextRLine = state.lines[state.currentLine + 1].trim();
          const actionMatch = nextRLine.match(/^ACTION:\s*(.+)$/i);
          const pathsMatch = nextRLine.match(/^PATHS:\s*(.+)$/i);
          const domainMatch = nextRLine.match(/^DOMAIN:\s*(.+)$/i);
          const instructionMatch = nextRLine.match(/^INSTRUCTION:\s*(.+)$/i);
          if (actionMatch) {
            actionType = actionMatch[1].trim();
            state.currentLine++;
          } else if (pathsMatch) {
            actionPaths = pathsMatch[1]
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean);
            if (!actionType) actionType = 'inject_context';
            state.currentLine++;
          } else if (domainMatch) {
            actionDomain = domainMatch[1].trim();
            if (!actionType) actionType = 'load_memory';
            state.currentLine++;
          } else if (instructionMatch) {
            recallEntry.instruction = instructionMatch[1].trim().replace(/^"|"$/g, '');
            if (!actionType) actionType = 'prompt_llm';
            state.currentLine++;
          } else {
            break;
          }
        }
        // Build the properly-typed RecallAction
        if (actionType === 'inject_context' && actionPaths) {
          recallEntry.action = { type: 'inject_context', paths: actionPaths };
        } else if (actionType === 'load_memory') {
          recallEntry.action = { type: 'load_memory', domain: actionDomain };
        } else if (actionType === 'prompt_llm') {
          recallEntry.action = { type: 'prompt_llm', instruction: recallEntry.instruction };
        }
        memory.recall.push(recallEntry);
      }
    } else if (
      currentSection === 'recall' &&
      (trimmed.startsWith('- ON_') || trimmed.startsWith('- EVENT'))
    ) {
      const legacyInstruction = parseLegacyRecallInstruction(trimmed);
      if (legacyInstruction) {
        state.errors.push({
          line: state.currentLine,
          column: 0,
          message: buildLegacyRecallEventError(legacyInstruction.event),
        });
      }
    } else if (currentSection === 'reads' && trimmed.startsWith('-')) {
      // READS: stores as persistent memory paths with read access
      const path = trimmed.substring(1).trim().split('#')[0].trim();
      memory.persistent.push({ path, access: 'read' });
    } else if (currentSection === 'writes' && trimmed.startsWith('-')) {
      // WRITES: stores as persistent memory paths with write access
      const path = trimmed.substring(1).trim().split('#')[0].trim();
      memory.persistent.push({ path, access: 'write' });
    }

    state.currentLine++;
  }

  return memory;
}

function parseRememberTrigger(state: ParserState): RememberTrigger | null {
  const line = state.lines[state.currentLine].trim();
  // Handle both `- WHEN condition` and `- WHEN: condition` formats
  const whenMatch = line.match(/^-\s*WHEN:?\s+(.+)$/);
  if (!whenMatch) return null;

  const trigger: RememberTrigger = {
    when: whenMatch[1],
    store: { value: '', target: '' },
  };

  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const nextLine = state.lines[state.currentLine].trim();
    if (nextLine.startsWith('STORE:')) {
      // Handle inline format: STORE: value -> target
      const storeMatch = nextLine.match(/^STORE:\s*(.+)\s*->\s*(.+)$/);
      if (storeMatch) {
        trigger.store.value = storeMatch[1].trim();
        trigger.store.target = storeMatch[2].trim();
      }
      // Handle multi-line STORE block (target: ..., value: ... on separate lines)
      // If STORE: has no inline content, parse sub-properties
      if (!storeMatch && nextLine === 'STORE:') {
        state.currentLine++;
        while (state.currentLine < state.lines.length) {
          const storeLine = state.lines[state.currentLine].trim();
          const targetMatch = storeLine.match(/^target:\s*"?([^"]+)"?$/i);
          const valueMatch = storeLine.match(/^value:\s*"?([^"]+)"?$/i);
          if (targetMatch) {
            trigger.store.target = targetMatch[1].trim();
          } else if (valueMatch) {
            trigger.store.value = valueMatch[1].trim();
          } else if (!storeLine || storeLine.startsWith('-') || storeLine.match(/^[A-Z_]+:/)) {
            break;
          }
          state.currentLine++;
        }
        continue; // Skip the outer state.currentLine++ since we already advanced
      }
    } else if (nextLine.startsWith('TTL:')) {
      trigger.ttl = nextLine.substring(4).trim().replace(/^"|"$/g, '');
    } else if (nextLine.startsWith('-') || (!nextLine.startsWith(' ') && nextLine)) {
      break;
    }
    state.currentLine++;
  }

  return trigger;
}

/** Retired recall-event aliases kept only to produce precise parser errors. */
const RECALL_EVENT_ALIASES: Record<string, string> = {
  ON_START: 'session:start',
  ON_END: 'session:end',
  ON_SEARCH: 'search_initiated',
  ON_BOOKING: 'booking_started',
  ON_CANCEL: 'cancellation_initiated',
  ON_PAYMENT: 'payment_initiated',
  ON_UPDATE: 'modification_initiated',
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
    return `Legacy RECALL event "${event}" is no longer supported. Use "ON: ${canonical}" instead.`;
  }

  return `Legacy RECALL event "${event}" is no longer supported. Use canonical lifecycle events such as "session:start", "agent:<name>:after", or "tool:<name>:after".`;
}

function parseLegacyRecallInstruction(
  line: string,
): { event: string; instruction: string } | { event: string } | null {
  const onMatch = line.match(/^-\s*(ON_\w+):\s*"?(.+)"?$/);
  if (onMatch) {
    return {
      event: onMatch[1],
      instruction: onMatch[2].replace(/^"|"$/g, ''),
    };
  }

  const eventMatch = line.match(/^-\s*EVENT:\s*(\S+)$/i);
  if (eventMatch) {
    return {
      event: eventMatch[1],
    };
  }

  return null;
}

function parseMemoryGrantsBlock(
  state: ParserState,
  parentIndent: number,
): Array<{ path: string; access?: 'read' | 'readwrite' }> {
  const grants: Array<{ path: string; access?: 'read' | 'readwrite' }> = [];

  while (state.currentLine < state.lines.length) {
    const rawLine = state.lines[state.currentLine];
    const trimmed = rawLine.trim();
    const currentIndent = rawLine.length - rawLine.trimStart().length;

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    if (currentIndent <= parentIndent) {
      break;
    }

    const pathMatch = trimmed.match(/^-\s*path:\s*(.+)$/i);
    if (!pathMatch) {
      break;
    }

    const grant: { path: string; access?: 'read' | 'readwrite' } = {
      path: pathMatch[1].trim().replace(/^"|"$/g, ''),
    };

    const itemIndent = currentIndent;
    state.currentLine++;

    while (state.currentLine < state.lines.length) {
      const detailRaw = state.lines[state.currentLine];
      const detailTrimmed = detailRaw.trim();
      const detailIndent = detailRaw.length - detailRaw.trimStart().length;

      if (!detailTrimmed || detailTrimmed.startsWith('#') || detailTrimmed.startsWith('//')) {
        state.currentLine++;
        continue;
      }

      if (detailIndent <= itemIndent) {
        break;
      }

      const accessMatch = detailTrimmed.match(/^access:\s*(.+)$/i);
      if (accessMatch) {
        const access = accessMatch[1].trim().toLowerCase();
        if (access === 'read' || access === 'readwrite') {
          grant.access = access;
        }
      }

      state.currentLine++;
    }

    grants.push(grant);
  }

  return grants;
}

const CONSTRAINT_REQUIREMENT_START_PATTERN = /^-\s*(REQUIRE|WARN|LIMIT|RESTRICT)\b/i;
const CONSTRAINT_REQUIREMENT_PATTERN = /^-\s*(REQUIRE|WARN|LIMIT|RESTRICT)\s*:?\s+(.+)$/i;
const CONSTRAINT_PLAIN_LIST_ITEM_PATTERN = /^-\s+/;

function isConstraintRequirementLine(line: string): boolean {
  return CONSTRAINT_REQUIREMENT_START_PATTERN.test(line);
}

function skipMalformedConstraintRequirement(state: ParserState, requirementIndent: number): void {
  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    if (getIndent(line) <= requirementIndent) {
      break;
    }

    state.currentLine++;
  }
}

function parseConstraints(state: ParserState): ConstraintPhase[] {
  state.currentLine++;
  const phases: ConstraintPhase[] = [];
  let currentPhase: ConstraintPhase | null = null;
  let plainListItemCount = 0;
  let firstPlainListItemLine: number | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    // Phase name: pre_search:
    const phaseMatch = trimmed.match(/^(\w+):$/);
    if (phaseMatch && line.match(/^\s{2}\w+:$/)) {
      if (currentPhase) phases.push(currentPhase);
      currentPhase = { name: phaseMatch[1], requirements: [] };
      state.currentLine++;
      continue;
    }

    // Requirement: - REQUIRE condition  OR  - WARN condition  OR  - LIMIT  OR  - RESTRICT
    if (isConstraintRequirementLine(trimmed)) {
      // Create a default phase if no named phase header was seen (flat constraints)
      if (!currentPhase) {
        currentPhase = { name: 'always', requirements: [] };
      }
      const req = parseConstraintRequirement(state);
      if (req) {
        currentPhase.requirements.push(req);
      } else {
        state.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message:
            'Malformed constraint requirement. Expected "- REQUIRE <expr>" or "- REQUIRE: <expr>" style syntax.',
        });
        skipMalformedConstraintRequirement(state, getIndent(line));
      }
      continue;
    }

    if (CONSTRAINT_PLAIN_LIST_ITEM_PATTERN.test(trimmed)) {
      plainListItemCount++;
      firstPlainListItemLine ??= state.currentLine + 1;
    }

    state.currentLine++;
  }

  if (currentPhase) phases.push(currentPhase);
  if (plainListItemCount > 0) {
    state.warnings.push({
      line: firstPlainListItemLine ?? state.currentLine,
      message: `CONSTRAINTS contains ${plainListItemCount} plain list item${plainListItemCount === 1 ? '' : 's'} that did not parse as runtime constraints. Use phase labels such as "always:" with "- REQUIRE", "- WARN", "- LIMIT", or "- RESTRICT"; plain quoted bullets are ignored by the constraints compiler.`,
    });
  }
  return phases;
}

function parseConstraintRequirement(state: ParserState): ConstraintRequirement | null {
  const line = state.lines[state.currentLine].trim();
  const match = line.match(CONSTRAINT_REQUIREMENT_PATTERN);
  if (!match) return null;

  const keyword = match[1].toUpperCase(); // 'REQUIRE', 'WARN', 'LIMIT', or 'RESTRICT'
  const rawExpression = match[2];

  // Split BEFORE / WHEN clauses from the condition
  const { condition, when, before } = splitConstraintInlineClauses(rawExpression);

  const req: ConstraintRequirement = {
    condition,
    onFail: '',
    severity: keyword === 'WARN' ? 'warning' : 'error',
  };

  // Map keyword to kind
  const kindMap: Record<string, 'require' | 'limit' | 'restrict'> = {
    REQUIRE: 'require',
    LIMIT: 'limit',
    RESTRICT: 'restrict',
  };
  if (kindMap[keyword]) {
    req.kind = kindMap[keyword];
  }
  if (when) {
    req.when = when;
  }
  if (before) {
    req.before = before;
  }

  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const nextLine = state.lines[state.currentLine].trim();
    if (nextLine.startsWith('WHEN:')) {
      let whenContent = nextLine.substring(5).trim();
      // Only strip wrapping quotes if the entire value is quoted
      if (
        whenContent.length >= 2 &&
        ((whenContent[0] === '"' && whenContent[whenContent.length - 1] === '"') ||
          (whenContent[0] === "'" && whenContent[whenContent.length - 1] === "'"))
      ) {
        whenContent = whenContent.slice(1, -1);
      }
      if (whenContent) {
        req.when = whenContent;
      }
      state.currentLine++;
      continue;
    } else if (nextLine.startsWith('ON_FAIL:')) {
      const onFailContent = nextLine.substring(8).trim();
      if (onFailContent.startsWith('|')) {
        state.currentLine++;
        req.onFail = parseMultiLineString(state);
        continue;
      } else if (onFailContent) {
        // Inline string value: ON_FAIL: "message"
        req.onFail = onFailContent.replace(/^"|"$/g, '');
      } else {
        // Empty ON_FAIL: — parse structured block on subsequent lines
        const onFailBlock: Record<string, unknown> = {};
        const cfBaseIndent = getIndent(state.lines[state.currentLine]);
        state.currentLine++;
        while (state.currentLine < state.lines.length) {
          const cfLine = state.lines[state.currentLine];
          const cfTrimmed = cfLine.trim();
          const cfIndent = getIndent(cfLine);
          if (!cfTrimmed || cfIndent <= cfBaseIndent) break;
          const cfPropMatch = cfTrimmed.match(/^(\w+):\s*(.+)$/);
          if (cfPropMatch) {
            const [, cfKey, cfVal] = cfPropMatch;
            switch (cfKey.toUpperCase()) {
              case 'COLLECT':
                onFailBlock.collect = cfVal
                  .replace(/^\[|\]$/g, '')
                  .split(',')
                  .map((s: string) => s.trim())
                  .filter(Boolean);
                break;
              case 'GOTO':
                onFailBlock.goto = cfVal.trim();
                break;
              case 'RETRY':
                onFailBlock.retry = cfVal.trim() === 'true';
                break;
              case 'RESPOND':
                onFailBlock.respond = cfVal.replace(/^"|"$/g, '');
                break;
              case 'THEN':
                onFailBlock.then = cfVal.trim();
                break;
            }
          }
          state.currentLine++;
        }
        req.onFail = onFailBlock as any;
        continue;
      }
    } else if (nextLine.startsWith('-') || (!nextLine.startsWith(' ') && nextLine)) {
      break;
    }
    state.currentLine++;
  }

  return req;
}

function parseDelegate(state: ParserState): DelegateConfig[] {
  state.currentLine++;
  const delegates: DelegateConfig[] = [];
  const MAX_ITERATIONS = 10000;
  let iterations = 0;

  while (state.currentLine < state.lines.length && iterations < MAX_ITERATIONS) {
    iterations++;
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      trimmed.match(/^[A-Z_]+:/) &&
      trimmed !== 'AGENT:'
    ) {
      break;
    }

    // New delegate: - TO: name (preferred) or legacy - AGENT: name
    if (trimmed.startsWith('- TO:') || trimmed.startsWith('- AGENT:')) {
      const delegate = parseDelegateConfig(state);
      if (delegate) {
        delegates.push(delegate);
      } else {
        // parseDelegateConfig returned null without advancing — avoid infinite loop
        state.warnings.push({
          line: state.currentLine,
          message: `Invalid DELEGATE entry: "${trimmed}". Expected format "- TO: AgentName" (single word agent name)`,
        });
        state.currentLine++;
      }
      continue;
    }

    // Warn on list entries that look like delegate attempts but use wrong syntax
    if (
      trimmed.startsWith('- ') &&
      !trimmed.startsWith('- TO:') &&
      !trimmed.startsWith('- AGENT:')
    ) {
      state.warnings.push({
        line: state.currentLine,
        message: `Invalid DELEGATE entry: "${trimmed}". Expected "- TO: AgentName"`,
      });
    }

    state.currentLine++;
  }

  if (iterations >= MAX_ITERATIONS) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: 'DELEGATE section parsing exceeded maximum iterations - check syntax',
    });
  }

  return delegates;
}

function parseDelegateConfig(state: ParserState): DelegateConfig | null {
  const line = state.lines[state.currentLine].trim();
  const match = line.match(/^-\s*(?:TO|AGENT):\s*(\w+)$/);
  if (!match) return null;

  const config: Partial<DelegateConfig> = {
    agent: match[1],
    input: {},
    returns: {},
  };

  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const nextLine = state.lines[state.currentLine];
    const trimmed = nextLine.trim();

    if (
      trimmed.startsWith('- TO:') ||
      trimmed.startsWith('- AGENT:') ||
      (!nextLine.startsWith(' ') && trimmed && trimmed.match(/^[A-Z_]+:/))
    ) {
      break;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key.toUpperCase()) {
        case 'WHEN':
          config.when = value;
          break;
        case 'PURPOSE':
        case 'SUMMARY':
          config.purpose = value.replace(/^"|"$/g, '');
          break;
        case 'INPUT':
        case 'PASS':
          config.input = parseInlineObject(value) || {};
          // If inline parse failed and value is empty, try multi-line block
          if (Object.keys(config.input!).length === 0 && !value.trim()) {
            config.input = parseIndentedKeyValues(state);
          }
          break;
        case 'RETURNS':
          config.returns = parseInlineObject(value) || {};
          // If inline parse failed and value is empty, try multi-line block
          if (Object.keys(config.returns!).length === 0 && !value.trim()) {
            config.returns = parseIndentedKeyValues(state);
          }
          break;
        case 'USE_RESULT':
          config.useResult = value.replace(/^"|"$/g, '');
          break;
        case 'TIMEOUT':
          config.timeout = value;
          break;
        case 'ON_FAILURE':
          config.onFailure = value;
          break;
        case 'EXPERIENCE_MODE':
          config.experienceMode = normalizeCustomerExperienceMode(value);
          break;
        case 'LOCATION':
          if (!config.remote) config.remote = { location: 'local' };
          config.remote.location = value.trim().toLowerCase() as 'local' | 'remote';
          break;
        case 'ENDPOINT':
          if (!config.remote) config.remote = { location: 'remote' };
          config.remote.endpoint = value.replace(/^"|"$/g, '');
          config.remote.location = 'remote';
          break;
        case 'PROTOCOL':
          if (!config.remote) config.remote = { location: 'remote' };
          config.remote.protocol = value.trim() as 'a2a' | 'rest';
          break;
      }
    }

    state.currentLine++;
  }

  return config as DelegateConfig;
}

function parseHandoff(state: ParserState): HandoffConfig[] {
  state.currentLine++;
  const handoffs: HandoffConfig[] = [];
  const MAX_ITERATIONS = 10000; // Safety limit to prevent infinite loops
  let iterations = 0;

  while (state.currentLine < state.lines.length && iterations < MAX_ITERATIONS) {
    iterations++;
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      trimmed.match(/^[A-Z_]+:/) &&
      trimmed !== 'TO:'
    ) {
      break;
    }

    // New handoff: - TO: agent
    if (trimmed.startsWith('- TO:')) {
      const handoff = parseHandoffConfig(state);
      if (handoff) {
        handoffs.push(handoff);
      } else {
        // parseHandoffConfig returned null without advancing — avoid infinite loop
        state.warnings.push({
          line: state.currentLine,
          message: `Invalid HANDOFF entry: "${trimmed}". Expected format "- TO: AgentName" (single word agent name)`,
        });
        state.currentLine++;
      }
      continue;
    }

    // Warn on list entries that look like handoff attempts but use wrong syntax
    if (trimmed.startsWith('- ') && !trimmed.startsWith('- TO:')) {
      state.warnings.push({
        line: state.currentLine,
        message: `Invalid HANDOFF entry: "${trimmed}". Expected "- TO: AgentName"`,
      });
    }

    state.currentLine++;
  }

  if (iterations >= MAX_ITERATIONS) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: 'HANDOFF section parsing exceeded maximum iterations - check syntax',
    });
  }

  return handoffs;
}

function parseHandoffConfig(state: ParserState): HandoffConfig | null {
  const line = state.lines[state.currentLine].trim();
  const match = line.match(/^-\s*TO:\s*(\w+)$/);
  if (!match) return null;

  const config: Partial<HandoffConfig> = {
    to: match[1],
    return: false,
    context: {
      pass: [],
      summary: '',
    },
  };

  state.currentLine++;
  let inContext = false;
  let contextIndent = 0;
  let inOnReturn = false;
  let onReturnIndent = 0;
  let inOnReturnMap = false;
  let onReturnMapIndent = 0;
  const ensureOnReturn = (): HandoffOnReturnConfig => {
    if (!config.onReturn || typeof config.onReturn === 'string') {
      config.onReturn = {};
    }
    return config.onReturn;
  };

  while (state.currentLine < state.lines.length) {
    const nextLine = state.lines[state.currentLine];
    const trimmed = nextLine.trim();

    if (
      trimmed.startsWith('- TO:') ||
      (!nextLine.startsWith(' ') && trimmed && trimmed.match(/^[A-Z_]+:/))
    ) {
      break;
    }

    // Calculate current line indentation
    const currentIndent = nextLine.length - nextLine.trimStart().length;

    // Check if we've left the CONTEXT block (indentation back to handoff level)
    if (inContext && currentIndent <= contextIndent && trimmed && !trimmed.startsWith('#')) {
      inContext = false;
    }

    if (inOnReturn && currentIndent <= onReturnIndent && trimmed && !trimmed.startsWith('#')) {
      inOnReturn = false;
    }

    // Check if we've left the ON_RETURN map block
    if (
      inOnReturnMap &&
      currentIndent <= onReturnMapIndent &&
      trimmed &&
      !trimmed.startsWith('#')
    ) {
      inOnReturnMap = false;
    }

    // Parse ON_RETURN multi-line map entries (key: value pairs at deeper indent)
    if (inOnReturnMap && trimmed) {
      const mapEntryMatch = trimmed.match(/^(\w+):\s*(.+)$/);
      if (mapEntryMatch) {
        const onReturnConfig = ensureOnReturn();
        onReturnConfig.map ??= {};
        onReturnConfig.map[mapEntryMatch[1]] = mapEntryMatch[2].trim();
        state.currentLine++;
        continue;
      }
    }

    if (trimmed === 'CONTEXT:') {
      inContext = true;
      contextIndent = currentIndent;
      state.currentLine++;
      continue;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      if (inContext) {
        switch (key) {
          case 'pass':
            if (!value) {
              state.currentLine++;
              config.context!.pass = parseIndentedStringList(state, currentIndent);
              continue;
            }
            config.context!.pass = parseArray(value);
            break;
          case 'summary':
            if (value.startsWith('|')) {
              state.currentLine++;
              config.context!.summary = parseMultiLineString(state);
              continue;
            } else {
              config.context!.summary = value.replace(/^"|"$/g, '');
            }
            break;
          case 'grant_memory':
            state.errors.push({
              line: state.currentLine,
              column: 0,
              message:
                'Legacy handoff CONTEXT grant_memory is no longer supported. Use memory_grants with explicit path/access entries.',
            });
            break;
          case 'memory_grants':
            if (!value) {
              state.currentLine++;
              config.context!.memoryGrants = parseMemoryGrantsBlock(state, currentIndent);
              continue;
            }
            break;
          case 'history':
            if (!value) {
              state.currentLine++;
              config.context!.history = parseHandoffHistoryBlock(state, currentIndent);
              continue;
            }
            config.context!.history = normalizeHandoffHistoryValue(value);
            break;
        }
      } else {
        switch (key.toUpperCase()) {
          case 'WHEN':
            config.when = value;
            break;
          case 'PRIORITY':
            config.priority = parseInt(value, 10);
            break;
          case 'RETURN':
            config.return = value === 'true';
            break;
          case 'EXPECT_RETURN':
            config.return = value === 'true';
            break;
          case 'ON_FAILURE':
            config.onFailure = value;
            break;
          case 'ON_RETURN':
            if (value) {
              config.onReturn = value.replace(/^['"]|['"]$/g, '').trim();
            } else {
              ensureOnReturn();
              inOnReturn = true;
              onReturnIndent = currentIndent;
            }
            break;
          case 'EXPERIENCE_MODE':
            config.experienceMode = normalizeCustomerExperienceMode(value);
            break;
          case 'ACTION':
            if (!inOnReturn) {
              state.errors.push({
                line: state.currentLine,
                column: 0,
                message: 'ACTION is only valid inside an ON_RETURN block for HANDOFF.',
              });
            } else if (value) {
              ensureOnReturn().action = value;
            }
            break;
          case 'HANDLER':
            if (!inOnReturn) {
              state.errors.push({
                line: state.currentLine,
                column: 0,
                message: 'HANDLER is only valid inside an ON_RETURN block for HANDOFF.',
              });
            } else if (value) {
              ensureOnReturn().handler = value;
            }
            break;
          case 'PASS':
            // Support shorthand PASS: [...] outside of CONTEXT block
            if (!value) {
              state.currentLine++;
              config.context!.pass = parseIndentedStringList(state, currentIndent);
              continue;
            }
            config.context!.pass = parseArray(value);
            break;
          case 'SUMMARY':
            // Support shorthand SUMMARY: "..." outside of CONTEXT block
            config.context!.summary = value.replace(/^"|"$/g, '');
            break;
          case 'HISTORY':
            // Support shorthand HISTORY: ... outside of CONTEXT block
            if (!value) {
              state.currentLine++;
              config.context!.history = parseHandoffHistoryBlock(state, currentIndent);
              continue;
            }
            config.context!.history = normalizeHandoffHistoryValue(value);
            break;
          case 'LOCATION':
            if (!config.remote) config.remote = { location: 'local' };
            config.remote.location = value.trim().toLowerCase() as 'local' | 'remote';
            break;
          case 'ENDPOINT':
            if (!config.remote) config.remote = { location: 'remote' };
            config.remote.endpoint = value.replace(/^"|"$/g, '');
            config.remote.location = 'remote';
            break;
          case 'PROTOCOL':
            if (!config.remote) config.remote = { location: 'remote' };
            config.remote.protocol = value.trim() as 'a2a' | 'rest';
            break;
          case 'ASYNC':
            config.async = value.trim().toLowerCase() === 'true';
            break;
          case 'TIMEOUT':
            // Store as asyncTimeout unconditionally — the routing executor
            // uses it when async=true, or as a general remote timeout otherwise
            config.asyncTimeout = parseInt(value, 10);
            break;
          case 'MAP':
            if (!inOnReturn) {
              state.errors.push({
                line: state.currentLine,
                column: 0,
                message: 'MAP is only valid inside an ON_RETURN block for HANDOFF.',
              });
              break;
            }
            const onReturnConfig = ensureOnReturn();
            onReturnConfig.map ??= {};
            if (!value) {
              // Multi-line map: entries on subsequent indented lines
              inOnReturnMap = true;
              onReturnMapIndent = currentIndent;
            } else {
              try {
                const mapEntries = value
                  .replace(/^\{|\}$/g, '')
                  .split(',')
                  .map((s) => s.trim())
                  .filter(Boolean);
                for (const entry of mapEntries) {
                  const [childKey, parentKey] = entry.split(':').map((s) => s.trim());
                  if (childKey && parentKey) {
                    onReturnConfig.map[childKey] = parentKey;
                  }
                }
              } catch {
                /* ignore malformed MAP */
              }
            }
            break;
        }
      }
    }

    state.currentLine++;
  }

  return config as HandoffConfig;
}

function normalizeCustomerExperienceMode(raw: string): HandoffConfig['experienceMode'] {
  const value = raw.replace(/^['"]|['"]$/g, '').trim();
  if (
    value === 'shared_voice_handoff' ||
    value === 'visible_handoff' ||
    value === 'silent_delegate' ||
    value === 'human_escalation'
  ) {
    return value;
  }
  return undefined;
}

function normalizeHandoffHistoryValue(raw: string): HandoffContext['history'] {
  return raw.replace(/^"|"$/g, '').trim().toLowerCase() as HandoffContext['history'];
}

function parseHandoffHistoryBlock(
  state: ParserState,
  parentIndent: number,
): HandoffContext['history'] {
  const validModes = new Set(['auto', 'none', 'summary_only', 'full', 'last_n']);
  const history: { mode?: string; count?: number } = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    const match = trimmed.match(/^(\w+):\s*(.+)?$/);
    if (!match) {
      state.currentLine++;
      continue;
    }

    const [, key, rawValue] = match;
    const value = rawValue?.replace(/^"|"$/g, '').trim();
    switch (key.toUpperCase()) {
      case 'MODE':
        history.mode = value?.toLowerCase();
        break;
      case 'COUNT':
        if (value) {
          history.count = Number.parseInt(value, 10);
        }
        break;
      default:
        state.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message: `Unknown handoff history property "${key}"`,
        });
        break;
    }

    state.currentLine++;
  }

  if (!history.mode) {
    state.errors.push({
      line: state.currentLine + 1,
      column: 1,
      message: 'Handoff history block requires MODE.',
    });
    return undefined;
  }

  if (!validModes.has(history.mode)) {
    state.errors.push({
      line: state.currentLine + 1,
      column: 1,
      message: `Unsupported handoff history MODE "${history.mode}". Use auto, none, summary_only, full, or last_n.`,
    });
    return undefined;
  }

  if (history.mode === 'last_n' && history.count === undefined) {
    state.errors.push({
      line: state.currentLine + 1,
      column: 1,
      message: 'Handoff history MODE last_n requires COUNT.',
    });
  }

  return history as HandoffContext['history'];
}

function parseReturnHandlers(state: ParserState): Record<string, ReturnHandlerDefinition> {
  state.currentLine++;
  const handlers: Record<string, ReturnHandlerDefinition> = {};

  let currentHandlerName: string | null = null;
  let currentHandler: ReturnHandlerDefinition | null = null;
  let currentIndent = 0;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    const indent = getIndent(line);
    const handlerMatch = trimmed.match(/^([A-Za-z_][\w-]*):$/);
    if (handlerMatch && indent <= 2) {
      currentHandlerName = handlerMatch[1];
      currentHandler = {};
      handlers[currentHandlerName] = currentHandler;
      currentIndent = indent;
      state.currentLine++;
      continue;
    }

    if (!currentHandlerName || !currentHandler) {
      state.currentLine++;
      continue;
    }

    if (indent <= currentIndent) {
      currentHandlerName = null;
      currentHandler = null;
      continue;
    }

    const propMatch = trimmed.match(/^([A-Z_]+):\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key) {
        case 'RESPOND':
          if (value.startsWith('|')) {
            state.currentLine++;
            currentHandler.respond = parseMultiLineString(state);
            continue;
          }
          currentHandler.respond = value.replace(/^"|"$/g, '');
          break;
        case 'CLEAR':
          currentHandler.clear = parseArray(value);
          break;
        case 'CONTINUE':
          currentHandler.continue = value.trim().toLowerCase() === 'true';
          break;
        case 'RESUME_INTENT':
          currentHandler.resumeIntent = value.trim().toLowerCase() === 'true';
          break;
      }
    }

    state.currentLine++;
  }

  return handlers;
}

function parseEscalate(state: ParserState): EscalateConfig {
  state.currentLine++;
  const config: EscalateConfig = {
    triggers: [],
    contextForHuman: [],
    onHumanComplete: [],
  };

  let currentSection: 'triggers' | 'context_for_human' | 'on_human_complete' | null = null;
  const MAX_ITERATIONS = 10000;
  let iterations = 0;

  while (state.currentLine < state.lines.length && iterations < MAX_ITERATIONS) {
    iterations++;
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      if (
        !['triggers:', 'context_for_human:', 'on_human_complete:'].includes(trimmed) &&
        !trimmed.match(/^(?:CONNECTOR_ACTION|connector_action):/i)
      ) {
        break;
      }
    }

    // Handle CONNECTOR_ACTION: property
    const connectorMatch = trimmed.match(/^(?:CONNECTOR_ACTION|connector_action):\s*(.+)$/);
    if (connectorMatch) {
      config.connectorAction = connectorMatch[1].replace(/^"|"$/g, '');
      state.currentLine++;
      continue;
    }

    if (trimmed === 'triggers:') {
      currentSection = 'triggers';
    } else if (trimmed === 'context_for_human:') {
      currentSection = 'context_for_human';
    } else if (trimmed === 'on_human_complete:') {
      currentSection = 'on_human_complete';
    } else if (currentSection === 'triggers' && trimmed.startsWith('- WHEN')) {
      const trigger = parseEscalateTrigger(state);
      if (trigger) {
        config.triggers.push(trigger);
      } else {
        // parseEscalateTrigger returned null without advancing — avoid infinite loop
        state.warnings.push({
          line: state.currentLine,
          message: `Invalid ESCALATE trigger: "${trimmed}". Expected format "- WHEN: condition"`,
        });
        state.currentLine++;
      }
      continue;
    } else if (currentSection === 'context_for_human' && trimmed.startsWith('-')) {
      config.contextForHuman.push({ name: trimmed.substring(1).trim() });
    } else if (currentSection === 'on_human_complete' && trimmed.startsWith('- IF')) {
      const action = parseOnHumanComplete(trimmed);
      if (action) config.onHumanComplete.push(action);
    }

    state.currentLine++;
  }

  if (iterations >= MAX_ITERATIONS) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: 'ESCALATE section parsing exceeded maximum iterations - check syntax',
    });
  }

  return config;
}

function parseEscalateTrigger(state: ParserState): EscalateTrigger | null {
  const line = state.lines[state.currentLine].trim();
  const match = line.match(/^-\s*WHEN:\s*(.+)$/);
  if (!match) return null;

  const trigger: EscalateTrigger = {
    when: match[1],
    reason: '',
    priority: 'medium',
  };

  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const nextLine = state.lines[state.currentLine].trim();
    if (nextLine.startsWith('REASON:')) {
      trigger.reason = nextLine.substring(7).trim().replace(/^"|"$/g, '');
    } else if (nextLine.startsWith('PRIORITY:')) {
      const rawPriority = nextLine.substring(9).trim();
      const parsed = Number(rawPriority);
      if (!isNaN(parsed) && Number.isInteger(parsed) && parsed >= 0) {
        // Valid non-negative integer — preferred format
        trigger.priority = parsed;
      } else {
        // Non-integer value — store as-is but emit warning
        trigger.priority = rawPriority as 'low' | 'medium' | 'high' | 'critical';
        state.warnings.push({
          line: state.currentLine,
          message: `ESCALATE PRIORITY should be a non-negative integer, got "${rawPriority}"`,
        });
      }
    } else if (nextLine.startsWith('TAGS:')) {
      trigger.tags = parseArray(nextLine.substring(5));
    } else if (nextLine.startsWith('-') || (!nextLine.startsWith(' ') && nextLine)) {
      break;
    }
    state.currentLine++;
  }

  return trigger;
}

function parseOnHumanComplete(line: string): OnHumanCompleteAction | null {
  const match = line.match(/^-\s*IF\s+(.+?):\s*(.+)$/);
  if (!match) return null;
  return {
    condition: match[1],
    action: match[2],
  };
}

function parseComplete(state: ParserState): CompleteCondition[] {
  state.currentLine++;
  const conditions: CompleteCondition[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    if (trimmed.startsWith('- WHEN:')) {
      const condition = parseCompleteCondition(state);
      if (condition) {
        conditions.push(condition);
      } else {
        state.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message: `Invalid COMPLETE condition: "${trimmed}". Expected format "- WHEN: condition"`,
        });
        state.currentLine++;
      }
      continue;
    }

    state.currentLine++;
  }

  return conditions;
}

function parseCompleteCondition(state: ParserState): CompleteCondition | null {
  const line = state.lines[state.currentLine].trim();
  const match = line.match(/^-\s*WHEN:\s*(.+)$/);
  if (!match) return null;

  const condition: CompleteCondition = {
    when: match[1],
  };

  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const nextLine = state.lines[state.currentLine].trim();
    if (nextLine.startsWith('RESPOND:')) {
      const respondIndent = getIndent(state.lines[state.currentLine]);
      const content = nextLine.substring(8).trim();
      if (content.startsWith('|')) {
        state.currentLine++;
        condition.respond = parseMultiLineString(state);
      } else {
        condition.respond = content.replace(/^"|"$/g, '');
        state.currentLine++;
      }
      condition.voiceConfig = tryParseVoiceConfig(state, respondIndent);
      condition.richContent = tryParseFormatsBlock(state, respondIndent);
      condition.actions = tryParseActionsBlock(state, respondIndent);
      continue;
    } else if (nextLine.startsWith('STORE:')) {
      condition.store = nextLine.substring(6).trim();
    } else if (nextLine.startsWith('-') || (!nextLine.startsWith(' ') && nextLine)) {
      break;
    }
    state.currentLine++;
  }

  return condition;
}

function parseOnError(state: ParserState): ErrorHandler[] {
  state.currentLine++;
  const handlers: ErrorHandler[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    // Error type: error_name:
    const typeMatch = trimmed.match(/^(\w+):$/);
    if (typeMatch && line.match(/^\s{2}\w+:$/)) {
      const handler = parseErrorHandler(state, typeMatch[1]);
      if (handler) handlers.push(handler);
      continue;
    }

    state.currentLine++;
  }

  return handlers;
}

function parseErrorHandler(state: ParserState, type: string): ErrorHandler | null {
  const handler: ErrorHandler = { type };

  state.currentLine++;

  while (state.currentLine < state.lines.length) {
    const nextLine = state.lines[state.currentLine];
    const trimmed = nextLine.trim();

    // Check if we've hit a non-indented line (another main section)
    if (!nextLine.startsWith(' ') && trimmed && !trimmed.startsWith('#')) {
      break;
    }

    // Check if we've hit the next error type (2-space indented line ending in colon)
    if (nextLine.match(/^\s{2}\w+:$/) && trimmed.match(/^\w+:$/)) {
      break;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key.toUpperCase()) {
        case 'RESPOND': {
          const respondIndent = getIndent(state.lines[state.currentLine]);
          handler.respond = value.replace(/^"|"$/g, '');
          state.currentLine++;
          handler.voiceConfig = tryParseVoiceConfig(state, respondIndent);
          handler.richContent = tryParseFormatsBlock(state, respondIndent);
          handler.actions = tryParseActionsBlock(state, respondIndent);
          continue;
        }
        case 'SUBTYPES':
          handler.subtypes = parseArray(value);
          break;
        case 'SUBTYPE':
          handler.subtypes = [value.trim()];
          break;
        case 'RETRY':
          handler.retry = parseInt(value, 10);
          break;
        case 'RETRY_DELAY':
          handler.retryDelay = parseInt(value, 10);
          break;
        case 'RETRY_BACKOFF':
          handler.retryBackoff = value.trim() as 'fixed' | 'exponential' | 'linear';
          break;
        case 'RETRY_MAX_DELAY':
          handler.retryMaxDelay = parseInt(value, 10);
          break;
        case 'THEN':
          handler.then = value;
          break;
        case 'BACKTRACK_TO':
          handler.backtrackTo = value.trim();
          break;
      }
    }

    state.currentLine++;
  }

  return handler;
}

/**
 * Parse ON_START lifecycle handler
 * Syntax:
 *   ON_START:
 *     RESPOND: "Welcome message"
 *     CALL: check_returning_user
 *     SET: session_initialized = true
 *     DELEGATE: Welcome_Task
 *
 * Legacy bullet-list forms are also accepted:
 *   ON_START:
 *     - RESPOND: "Welcome message"
 */
function parseOnStart(state: ParserState): StartHandler {
  state.currentLine++;
  const handler: StartHandler = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    const normalized = trimmed.replace(/^-+\s*/, '');
    const propMatch = normalized.match(/^(\w+):\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key.toLowerCase()) {
        case 'respond': {
          const respondIndent = getIndent(state.lines[state.currentLine]);
          if (value.startsWith('|')) {
            state.currentLine++;
            handler.respond = parseMultiLineString(state);
          } else {
            handler.respond = value.replace(/^"|"$/g, '');
            state.currentLine++;
          }
          handler.voiceConfig = tryParseVoiceConfig(state, respondIndent);
          handler.richContent = tryParseFormatsBlock(state, respondIndent);
          handler.actions = tryParseActionsBlock(state, respondIndent);
          continue;
        }
        case 'call': {
          const invocation = parseToolInvocation(state, value);
          handler.call = invocation.call;
          handler.callSpec = invocation.callSpec;
          break;
        }
        case 'with':
        case 'as':
          state.errors.push({
            line: state.currentLine + 1,
            column: 1,
            message: `${key.toUpperCase()}: must be nested under CALL: inside ON_START.`,
          });
          break;
        case 'set': {
          // Parse "field = value" assignments
          if (!handler.set) handler.set = {};
          const setMatch = value.match(/^(\w+)\s*=\s*(.+)$/);
          if (setMatch) {
            handler.set[setMatch[1]] = setMatch[2];
          }
          break;
        }
        case 'delegate':
          handler.delegate = value;
          break;
      }
    }

    state.currentLine++;
  }

  return handler;
}

// =============================================================================
// EXECUTION CONFIG PARSER
// =============================================================================

function isExecutionNestedObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asExecutionBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asExecutionNumber(value: unknown): number | undefined {
  return typeof value === 'number' ? value : undefined;
}

function asExecutionString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asExecutionStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  return value.filter((item): item is string => typeof item === 'string');
}

function asExecutionStringArrayRecord(value: unknown): Record<string, string[]> | undefined {
  if (!isExecutionNestedObject(value)) {
    return undefined;
  }

  const result: Record<string, string[]> = {};
  for (const [key, raw] of Object.entries(value)) {
    const strings = asExecutionStringArray(raw);
    if (strings) {
      result[key] = strings;
    }
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function getExecutionField(
  block: Record<string, unknown>,
  snakeCase: string,
  camelCase = snakeCase,
): unknown {
  return block[snakeCase] ?? block[camelCase];
}

function parseExecutionNestedValue(value: string): unknown {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return splitParams(trimmed.slice(1, -1))
      .map((item) => parseDefaultValue(item))
      .filter((item): item is string => typeof item === 'string');
  }

  return parseDefaultValue(trimmed);
}

function parseExecutionNestedBlock(
  state: ParserState,
  parentIndent: number,
): Record<string, unknown> {
  const block: Record<string, unknown> = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    const indent = line.search(/\S/);
    if (indent <= parentIndent) {
      break;
    }

    const nestedBlockMatch = trimmed.match(/^(\w+):\s*$/);
    if (nestedBlockMatch) {
      const [, key] = nestedBlockMatch;
      state.currentLine++;
      block[key] = parseExecutionNestedBlock(state, indent);
      continue;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      block[key] = parseExecutionNestedValue(value);
    }

    state.currentLine++;
  }

  return block;
}

function parseExecutionCompactionBlock(
  block: Record<string, unknown>,
): NonNullable<ExecutionConfigAST['compaction']> {
  const toolResults = getExecutionField(block, 'tool_results', 'toolResults');
  const priorTurns = getExecutionField(block, 'prior_turns', 'priorTurns');

  return {
    model: asExecutionString(block.model),
    tool_results: isExecutionNestedObject(toolResults)
      ? {
          strategy: asExecutionString(toolResults.strategy) as
            | NonNullable<NonNullable<ExecutionConfigAST['compaction']>['tool_results']>['strategy']
            | undefined,
          max_chars: asExecutionNumber(getExecutionField(toolResults, 'max_chars', 'maxChars')),
          structured_threshold: asExecutionNumber(
            getExecutionField(toolResults, 'structured_threshold', 'structuredThreshold'),
          ),
          keep_recent: asExecutionNumber(
            getExecutionField(toolResults, 'keep_recent', 'keepRecent'),
          ),
          essential_fields: asExecutionStringArrayRecord(
            getExecutionField(toolResults, 'essential_fields', 'essentialFields'),
          ),
          max_description_length: asExecutionNumber(
            getExecutionField(toolResults, 'max_description_length', 'maxDescriptionLength'),
          ),
          summarize_prompt: asExecutionString(
            getExecutionField(toolResults, 'summarize_prompt', 'summarizePrompt'),
          ),
        }
      : undefined,
    prior_turns: isExecutionNestedObject(priorTurns)
      ? {
          strategy: asExecutionString(priorTurns.strategy) as
            | NonNullable<NonNullable<ExecutionConfigAST['compaction']>['prior_turns']>['strategy']
            | undefined,
          assistant_preview_chars: asExecutionNumber(
            getExecutionField(priorTurns, 'assistant_preview_chars', 'assistantPreviewChars'),
          ),
        }
      : undefined,
  };
}

function parseExecutionConfig(state: ParserState): ExecutionConfigAST {
  state.currentLine++;
  const config: ExecutionConfigAST = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Check for sub-blocks (key with no value): MODELS: or VOICE:
    const subBlockMatch = trimmed.match(/^(\w+):\s*$/);
    if (subBlockMatch) {
      const subBlockName = subBlockMatch[1].toLowerCase();
      if (subBlockName === 'models') {
        config.operation_models = {};
        state.currentLine++;
        // Parse nested key: value pairs at deeper indentation
        const parentIndent = line.search(/\S/);
        while (state.currentLine < state.lines.length) {
          const subLine = state.lines[state.currentLine];
          const subTrimmed = subLine.trim();
          if (!subTrimmed || subTrimmed.startsWith('#') || subTrimmed.startsWith('//')) {
            state.currentLine++;
            continue;
          }
          const subIndent = subLine.search(/\S/);
          if (subIndent <= parentIndent) break; // Back to parent level
          const subProp = subTrimmed.match(/^(\w+):\s*(.+)$/);
          if (subProp) {
            config.operation_models[subProp[1].toLowerCase()] = subProp[2].replace(/^"|"$/g, '');
          }
          state.currentLine++;
        }
        continue;
      }
      if (subBlockName === 'voice') {
        config.voice = config.voice || {};
        state.currentLine++;
        const parentIndent = line.search(/\S/);
        while (state.currentLine < state.lines.length) {
          const subLine = state.lines[state.currentLine];
          const subTrimmed = subLine.trim();
          if (!subTrimmed || subTrimmed.startsWith('#') || subTrimmed.startsWith('//')) {
            state.currentLine++;
            continue;
          }
          const subIndent = subLine.search(/\S/);
          if (subIndent <= parentIndent) break;
          const subProp = subTrimmed.match(/^(\w+):\s*(.+)$/);
          if (subProp) {
            const [, vKey, vValue] = subProp;
            const cleanVal = vValue.replace(/^"|"$/g, '');
            switch (vKey.toLowerCase()) {
              case 'provider':
                config.voice.provider = cleanVal;
                break;
              case 'voice_id':
                config.voice.voiceId = cleanVal;
                break;
              case 'speed':
                config.voice.speed = parseFloat(cleanVal);
                break;
              case 'ssml':
                config.voice.ssml = cleanVal;
                break;
              case 'instructions':
                config.voice.instructions = cleanVal;
                break;
              case 'plain_text':
                config.voice.plainText = cleanVal;
                break;
            }
          }
          state.currentLine++;
        }
        continue;
      }
      if (subBlockName === 'pipeline') {
        state.currentLine++;
        const parentIndent = line.search(/\S/);
        const pipelineBlock = parseExecutionNestedBlock(state, parentIndent);
        const shortCircuit = pipelineBlock.shortCircuit;
        const toolFilter = pipelineBlock.toolFilter;
        const keywordVeto = pipelineBlock.keywordVeto;
        const intentBridge = pipelineBlock.intentBridge;

        config.pipeline = {
          enabled: asExecutionBoolean(pipelineBlock.enabled),
          mode: asExecutionString(pipelineBlock.mode) as 'parallel' | 'sequential' | undefined,
          model: asExecutionString(pipelineBlock.model),
          shortCircuit: isExecutionNestedObject(shortCircuit)
            ? {
                enabled: asExecutionBoolean(shortCircuit.enabled),
                confidenceThreshold: asExecutionNumber(shortCircuit.confidenceThreshold),
              }
            : undefined,
          toolFilter: isExecutionNestedObject(toolFilter)
            ? {
                enabled: asExecutionBoolean(toolFilter.enabled),
                maxTools: asExecutionNumber(toolFilter.maxTools),
              }
            : undefined,
          keywordVeto: isExecutionNestedObject(keywordVeto)
            ? {
                enabled: asExecutionBoolean(keywordVeto.enabled),
                keywords: asExecutionStringArray(keywordVeto.keywords),
              }
            : undefined,
          intentBridge: isExecutionNestedObject(intentBridge)
            ? {
                enabled: asExecutionBoolean(intentBridge.enabled),
                programmaticThreshold: asExecutionNumber(intentBridge.programmaticThreshold),
                guidedThreshold: asExecutionNumber(intentBridge.guidedThreshold),
                outOfScopeDecline: asExecutionBoolean(intentBridge.outOfScopeDecline),
                multiIntentSignal: asExecutionBoolean(intentBridge.multiIntentSignal),
              }
            : undefined,
        };
        continue;
      }
      if (subBlockName === 'compaction') {
        state.currentLine++;
        const parentIndent = line.search(/\S/);
        config.compaction = parseExecutionCompactionBlock(
          parseExecutionNestedBlock(state, parentIndent),
        );
        continue;
      }
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      const cleanValue = value.replace(/^"|"$/g, '');
      switch (key.toLowerCase()) {
        case 'model':
          config.model = cleanValue;
          break;
        case 'temperature':
          config.temperature = parseFloat(cleanValue);
          break;
        case 'max_tokens':
          config.max_tokens = parseInt(cleanValue, 10);
          break;
        case 'tool_timeout':
          config.tool_timeout = parseInt(cleanValue, 10);
          break;
        case 'llm_timeout':
          config.llm_timeout = parseInt(cleanValue, 10);
          break;
        case 'session_idle_timeout':
          config.session_idle_timeout = parseInt(cleanValue, 10);
          break;
        case 'max_reasoning_iterations':
          config.max_reasoning_iterations = parseInt(cleanValue, 10);
          break;
        case 'max_flow_iterations':
          config.max_flow_iterations = parseInt(cleanValue, 10);
          break;
        case 'voice_latency_target':
          config.voice_latency_target = parseInt(cleanValue, 10);
          break;
        case 'fallback_model':
          config.fallback_model = cleanValue;
          break;
        case 'enable_thinking':
          config.enable_thinking = cleanValue === 'true';
          break;
        case 'thinking_budget':
          config.thinking_budget = parseInt(cleanValue, 10);
          break;
        case 'compaction_threshold':
          config.compaction_threshold = parseFloat(cleanValue);
          break;
        case 'inline_gather':
          config.inline_gather = cleanValue === 'true';
          break;
      }
    }

    state.currentLine++;
  }

  return config;
}

// =============================================================================
// TEMPLATES PARSER
// =============================================================================

/**
 * Try to parse a multi-format template entry.
 * Expects the cursor to be past the "name:" line.
 * Looks for DEFAULT: and any supported rich-content format keys.
 */
function tryParseMultiFormatTemplate(
  state: ParserState,
  name: string,
  parentIndent: number,
): TemplateDefinition | null {
  // Peek at next non-empty line to see if it's a format key
  let peek = state.currentLine;
  while (peek < state.lines.length && !state.lines[peek].trim()) peek++;
  if (peek >= state.lines.length) return null;

  const peekIndent = getIndent(state.lines[peek]);
  const peekTrimmed = state.lines[peek].trim();
  const peekMatch = peekTrimmed.match(/^([A-Za-z][A-Za-z0-9_ ]*):/);
  const formatKeys = new Set([
    'DEFAULT',
    'MARKDOWN',
    'ADAPTIVECARD',
    'HTML',
    'SLACK',
    'AGUI',
    'WHATSAPP',
    'CAROUSEL',
    'QUICKREPLIES',
    'LIST',
    'IMAGE',
    'VIDEO',
    'AUDIO',
    'FILE',
    'KPI',
    'TABLE',
    'CHART',
    'FORM',
    'PROGRESS',
    'FEEDBACK',
  ]);
  const voiceKeys = new Set(['VOICE', 'VOICEINSTRUCTIONS']);
  const isMultiFormat =
    peekIndent > parentIndent &&
    peekMatch !== null &&
    (formatKeys.has(normalizeRichContentKey(peekMatch[1])) ||
      voiceKeys.has(normalizeRichContentKey(peekMatch[1])));
  if (!isMultiFormat) return null;

  state.currentLine = peek;
  let content = '';
  const formats: RichContentAST = {};
  let voiceConfig: VoiceConfigAST | undefined;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    if (!line.trim()) {
      state.currentLine++;
      continue;
    }
    if (getIndent(line) <= parentIndent) break;

    const match = line.trim().match(/^([A-Za-z][A-Za-z0-9_ ]*):\s*(.*)$/);
    if (!match) {
      state.currentLine++;
      continue;
    }
    const [, key, val] = match;
    const normalizedKey = normalizeRichContentKey(key);

    switch (normalizedKey) {
      case 'VOICE':
        if (val.trim()) {
          voiceConfig = { ...(voiceConfig ?? {}), instructions: val.trim().replace(/^"|"$/g, '') };
          state.currentLine++;
        } else {
          voiceConfig = { ...(voiceConfig ?? {}), ...parseVoiceBlock(state) };
        }
        continue;
      case 'VOICEINSTRUCTIONS':
        if (val.trim().startsWith('|')) {
          state.currentLine++;
          voiceConfig = { ...(voiceConfig ?? {}), instructions: parseMultiLineString(state) };
        } else {
          voiceConfig = { ...(voiceConfig ?? {}), instructions: val.trim().replace(/^"|"$/g, '') };
          state.currentLine++;
        }
        continue;
    }

    const parsed = parseRichContentValue(state, getIndent(line), val);

    switch (normalizedKey) {
      case 'DEFAULT':
        content = coerceRichContentString(parsed) ?? '';
        continue;
      case 'MARKDOWN':
        formats.markdown = coerceRichContentString(parsed);
        continue;
      case 'ADAPTIVECARD':
        formats.adaptiveCard = coerceRichContentString(parsed, { stringifyObjects: true });
        continue;
      case 'HTML':
        formats.html = coerceRichContentString(parsed);
        continue;
      case 'SLACK':
        formats.slack = coerceRichContentString(parsed, { stringifyObjects: true });
        continue;
      case 'AGUI':
        formats.agUi = coerceRichContentString(parsed, { stringifyObjects: true });
        continue;
      case 'WHATSAPP':
        formats.whatsapp = coerceRichContentString(parsed, { stringifyObjects: true });
        continue;
      case 'CAROUSEL':
        formats.carousel = coerceCarouselTemplate(parsed);
        continue;
      case 'QUICKREPLIES':
        formats.quickReplies = coerceQuickRepliesTemplate(parsed);
        continue;
      case 'LIST':
        formats.list = coerceListTemplate(parsed);
        continue;
      case 'IMAGE':
        formats.image = coerceMediaTemplate(parsed);
        continue;
      case 'VIDEO':
        formats.video = coerceMediaTemplate(parsed);
        continue;
      case 'AUDIO':
        formats.audio = coerceMediaTemplate(parsed);
        continue;
      case 'FILE':
        formats.file = coerceFileTemplate(parsed);
        continue;
      case 'KPI':
        formats.kpi = coerceKpiTemplate(parsed);
        continue;
      case 'TABLE':
        formats.table = coerceTableTemplate(parsed);
        continue;
      case 'CHART':
        formats.chart = coerceChartTemplate(parsed);
        continue;
      case 'FORM':
        formats.form = coerceFormTemplate(parsed);
        continue;
      case 'PROGRESS':
        formats.progress = coerceProgressTemplate(parsed);
        continue;
      case 'FEEDBACK':
        formats.feedback = coerceFeedbackTemplate(parsed);
        continue;
      default:
        // Unknown key — stop parsing this template
        break;
    }
    // If we hit default case (unknown key), break out
    break;
  }

  const hasFormats = Object.keys(formats).length > 0;
  return {
    name,
    content,
    formats: hasFormats ? pruneUndefinedRichContent(formats) : undefined,
    voiceConfig,
  };
}

/**
 * Parse a TEMPLATES: block with named template entries.
 * Supports multi-line (|) and inline ("...") content.
 */
function parseTemplatesBlock(state: ParserState): TemplateDefinition[] {
  state.currentLine++; // consume TEMPLATES: line
  const templates: TemplateDefinition[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section (unindented uppercase header or standalone TEMPLATE)
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t')) {
      if (
        (trimmed.match(/^[A-Z_]+:/) && trimmed !== 'TEMPLATES:') ||
        trimmed.match(/^TEMPLATE\s+\w+:/)
      ) {
        break;
      }
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Match "name: |" (multi-line) or "name: "content"" or "name: content" (inline)
    const entryMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (entryMatch) {
      const [, name, rest] = entryMatch;
      const restTrimmed = rest.trim();

      if (restTrimmed === '|') {
        // Multi-line template body
        state.currentLine++;
        const content = parseMultiLineString(state);
        if (!content) {
          state.warnings.push({
            line: state.currentLine,
            message: `Empty template body for "${name}"`,
          });
        }
        templates.push({ name, content: content || '' });
      } else if (restTrimmed) {
        // Inline content (strip surrounding quotes if present)
        const content = restTrimmed.replace(/^"|"$/g, '');
        templates.push({ name, content });
        state.currentLine++;
      } else {
        // No inline content — check for multi-format template (DEFAULT: on next line)
        const entryIndent = getIndent(line);
        state.currentLine++;
        const multiFormat = tryParseMultiFormatTemplate(state, name, entryIndent);
        if (multiFormat) {
          templates.push(multiFormat);
        } else {
          state.warnings.push({
            line: state.currentLine - 1,
            message: `Empty template "${name}"`,
          });
          templates.push({ name, content: '' });
        }
      }
    } else {
      state.currentLine++;
    }
  }

  return templates;
}

/**
 * Parse a standalone TEMPLATE directive: TEMPLATE name: | or TEMPLATE name: "content"
 */
function parseStandaloneTemplate(state: ParserState): TemplateDefinition | null {
  const line = state.lines[state.currentLine];
  const trimmed = line.trim();
  const match = trimmed.match(/^TEMPLATE\s+(\w+):\s*(.*)$/);

  if (!match) {
    state.currentLine++;
    return null;
  }

  const [, name, rest] = match;
  const restTrimmed = rest.trim();
  const entryIndent = getIndent(line);

  if (restTrimmed === '|') {
    // Multi-line template body
    state.currentLine++;
    const content = parseMultiLineString(state);
    if (!content) {
      state.warnings.push({
        line: state.currentLine,
        message: `Empty template body for "${name}"`,
      });
    }
    return { name, content: content || '' };
  } else if (restTrimmed) {
    // Inline content
    const content = restTrimmed.replace(/^"|"$/g, '');
    state.currentLine++;
    return { name, content };
  } else {
    // No inline content — check for multi-format template
    state.currentLine++;
    const multiFormat = tryParseMultiFormatTemplate(state, name, entryIndent);
    if (multiFormat) {
      return multiFormat;
    }
    state.warnings.push({
      line: state.currentLine - 1,
      message: `Empty standalone template "${name}"`,
    });
    return { name, content: '' };
  }
}

// =============================================================================
// MESSAGES PARSER
// =============================================================================

function parseMessages(state: ParserState): AgentMessages {
  state.currentLine++;
  const messages: AgentMessages = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      messages[key.toLowerCase()] = value.replace(/^"|"$/g, '');
    }

    state.currentLine++;
  }

  return messages;
}

// =============================================================================
// HOOKS PARSER
// =============================================================================

function parseHooks(state: ParserState): HooksConfig {
  state.currentLine++;
  const hooks: HooksConfig = {};
  let currentHook: 'before_agent' | 'after_agent' | 'before_turn' | 'after_turn' | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (trimmed && !line.startsWith(' ') && !line.startsWith('\t') && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Hook sub-section headers
    const hookNames: Record<string, 'before_agent' | 'after_agent' | 'before_turn' | 'after_turn'> =
      {
        'before_agent:': 'before_agent',
        'after_agent:': 'after_agent',
        'before_turn:': 'before_turn',
        'after_turn:': 'after_turn',
      };

    if (hookNames[trimmed]) {
      currentHook = hookNames[trimmed];
      hooks[currentHook] = {};
      state.currentLine++;
      continue;
    }

    if (currentHook) {
      const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        const hookAction = hooks[currentHook]!;
        switch (key.toUpperCase()) {
          case 'CALL': {
            const invocation = parseToolInvocation(state, value);
            hookAction.call = invocation.call;
            hookAction.callSpec = invocation.callSpec;
            break;
          }
          case 'WITH':
          case 'AS':
            state.errors.push({
              line: state.currentLine + 1,
              column: 1,
              message: `${key.toUpperCase()}: must be nested under CALL: inside HOOKS.`,
            });
            break;
          case 'RESPOND': {
            const respondIndent = getIndent(state.lines[state.currentLine]);
            hookAction.respond = value.replace(/^"|"$/g, '');
            state.currentLine++;
            hookAction.voiceConfig = tryParseVoiceConfig(state, respondIndent);
            hookAction.richContent = tryParseFormatsBlock(state, respondIndent);
            hookAction.actions = tryParseActionsBlock(state, respondIndent);
            continue;
          }
          case 'SET': {
            if (!hookAction.set) hookAction.set = {};
            const setMatch = value.match(/^(\w[\w.]*)\s*=\s*(.+)$/);
            if (setMatch) {
              hookAction.set[setMatch[1]] = setMatch[2];
            }
            break;
          }
          case 'CRITICAL':
            hookAction.critical = value.toLowerCase() === 'true';
            break;
        }
      }
    }

    state.currentLine++;
  }

  return hooks;
}

// =============================================================================
// TOOL HINTS PARSER
// =============================================================================

function parseToolHints(state: ParserState, toolIndent: number): ToolHintsAST | null {
  const hints: ToolHintsAST = {};
  let hasHints = false;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    // Stop if we hit a line with less or equal indentation to the tool definition
    if (trimmed && indent <= toolIndent) {
      break;
    }

    // Skip empty lines
    if (!trimmed) {
      state.currentLine++;
      continue;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      hasHints = true;
      switch (key.toLowerCase()) {
        case 'cacheable':
          hints.cacheable = value === 'true';
          break;
        case 'latency':
          hints.latency = value as 'fast' | 'medium' | 'slow';
          break;
        case 'side_effects':
          hints.side_effects = value === 'true' || value === 'yes';
          break;
        case 'requires_auth':
          hints.requires_auth = value === 'true' || value === 'yes';
          break;
        case 'timeout':
          hints.timeout = parseInt(value, 10);
          break;
      }
    }

    state.currentLine++;
  }

  return hasHints ? hints : null;
}

// =============================================================================
// UTILITY FUNCTIONS
// =============================================================================

/**
 * Parse a VOICE: sub-block with SSML, INSTRUCTIONS, PLAIN_TEXT properties
 */
function parseVoiceBlock(state: ParserState): VoiceConfigAST {
  const voice: VoiceConfigAST = {};
  const blockIndent = getIndent(state.lines[state.currentLine]);
  state.currentLine++; // consume "VOICE:" line

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    if (!line.trim()) {
      state.currentLine++;
      continue;
    }
    if (getIndent(line) <= blockIndent) break;

    const match = line.trim().match(/^(\w+):\s*(.*)$/);
    if (!match) {
      state.currentLine++;
      continue;
    }
    const [, key, val] = match;

    switch (key.toUpperCase()) {
      case 'SSML':
        if (val.startsWith('|')) {
          state.currentLine++;
          voice.ssml = parseMultiLineString(state);
          continue;
        }
        voice.ssml = val.replace(/^"|"$/g, '');
        break;
      case 'INSTRUCTIONS':
        if (val.startsWith('|')) {
          state.currentLine++;
          voice.instructions = parseMultiLineString(state);
          continue;
        }
        voice.instructions = val.replace(/^"|"$/g, '');
        break;
      case 'PLAIN_TEXT':
        if (val.startsWith('|')) {
          state.currentLine++;
          voice.plainText = parseMultiLineString(state);
          voice.plain_text = voice.plainText;
          continue;
        }
        voice.plainText = val.replace(/^"|"$/g, '');
        voice.plain_text = voice.plainText;
        break;
    }
    state.currentLine++;
  }
  return voice;
}

/**
 * After parsing a RESPOND value, peek ahead for a VOICE: sub-block.
 * Returns VoiceConfigAST if found, undefined otherwise.
 */
function tryParseVoiceConfig(
  state: ParserState,
  respondIndent: number,
): VoiceConfigAST | undefined {
  let peek = state.currentLine;
  while (peek < state.lines.length && !state.lines[peek].trim()) peek++;

  if (peek < state.lines.length) {
    const nextIndent = getIndent(state.lines[peek]);
    const nextTrimmed = state.lines[peek].trim().toUpperCase();
    if (nextIndent > respondIndent && nextTrimmed.startsWith('VOICE:')) {
      state.currentLine = peek;
      return parseVoiceBlock(state);
    }
  }
  return undefined;
}

function normalizeRichContentKey(key: string): string {
  return key.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
}

function normalizeRichContentFieldName(name: string): string {
  return name.replace(/[^A-Za-z0-9]/g, '').toLowerCase();
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function getRichContentField(record: Record<string, unknown>, ...names: string[]): unknown {
  for (const [candidateKey, candidateValue] of Object.entries(record)) {
    const normalizedCandidate = normalizeRichContentFieldName(candidateKey);
    if (names.some((name) => normalizeRichContentFieldName(name) === normalizedCandidate)) {
      return candidateValue;
    }
  }
  return undefined;
}

function coerceRichContentString(
  value: unknown,
  options?: { stringifyObjects?: boolean },
): string | undefined {
  if (typeof value === 'string') {
    return value;
  }
  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }
  if (options?.stringifyObjects && value !== null && value !== undefined) {
    try {
      return JSON.stringify(value);
    } catch {
      return undefined;
    }
  }
  return undefined;
}

function coerceNumberValue(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

function coerceBooleanValue(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') {
    return value;
  }
  if (typeof value === 'string') {
    if (value.toLowerCase() === 'true') return true;
    if (value.toLowerCase() === 'false') return false;
  }
  return undefined;
}

function coerceCollectionBinding<TItem>(
  value: unknown,
  coerceTemplate: (template: unknown) => TItem | undefined,
): { from: string; template?: TItem } | string | undefined {
  if (typeof value === 'string') {
    return value;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const from = coerceRichContentString(getRichContentField(record, 'from', 'source'));
  if (!from) {
    return undefined;
  }

  const templateValue = getRichContentField(record, 'template', 'item', 'row', 'card', 'field');
  const template = templateValue === undefined ? undefined : coerceTemplate(templateValue);

  return template ? { from, template } : { from };
}

function collectIndentedBlockLines(
  state: ParserState,
  parentIndent: number,
): { lines: string[]; nextLine: number } {
  const lines: string[] = [];
  let cursor = state.currentLine + 1;

  while (cursor < state.lines.length) {
    const candidate = state.lines[cursor];
    if (candidate.trim() && getIndent(candidate) <= parentIndent) {
      break;
    }
    lines.push(candidate);
    cursor++;
  }

  return { lines, nextLine: cursor };
}

function dedentBlockLines(lines: string[]): string {
  const minIndent = lines.reduce<number>((currentMin, line) => {
    if (!line.trim()) return currentMin;
    const indent = getIndent(line);
    return currentMin === Infinity ? indent : Math.min(currentMin, indent);
  }, Infinity);

  if (minIndent === Infinity) {
    return '';
  }

  return lines
    .map((line) => (line.trim() ? line.slice(minIndent) : ''))
    .join('\n')
    .trim();
}

function parseYamlSnippet(value: string): unknown {
  try {
    return yaml.load(value);
  } catch {
    return value.replace(/^"|"$/g, '');
  }
}

function parseRichContentValue(state: ParserState, lineIndent: number, rawValue: string): unknown {
  const trimmedValue = rawValue.trim();

  if (trimmedValue.startsWith('|')) {
    state.currentLine++;
    return parseMultiLineString(state);
  }

  if (trimmedValue) {
    state.currentLine++;
    return parseYamlSnippet(trimmedValue);
  }

  const { lines, nextLine } = collectIndentedBlockLines(state, lineIndent);
  state.currentLine = nextLine;

  const dedented = dedentBlockLines(lines);
  if (!dedented) {
    return undefined;
  }

  return parseYamlSnippet(dedented);
}

function parseConversationBehaviorSection(state: ParserState): AgentBasedDocument['conversation'] {
  const sectionLine = state.currentLine;
  const parentIndent = getIndent(state.lines[state.currentLine]);
  const { lines, nextLine } = collectIndentedBlockLines(state, parentIndent);
  state.currentLine = nextLine;

  const dedented = dedentBlockLines(lines);
  if (!dedented) {
    state.errors.push({
      line: sectionLine + 1,
      column: 1,
      message:
        'CONVERSATION: requires an indented block with speaking, listening, or interaction fields.',
    });
    return undefined;
  }

  let rawConversation: unknown;
  try {
    rawConversation = yaml.load(dedented);
  } catch (error) {
    const yamlError = error as yaml.YAMLException;
    state.errors.push({
      line: sectionLine + 1 + (yamlError.mark?.line ?? 0),
      column: (yamlError.mark?.column ?? 0) + 1,
      message: yamlError.message || 'Invalid CONVERSATION block.',
    });
    return undefined;
  }

  const result = parseConversationBehaviorData(rawConversation);
  for (const message of result.errors) {
    state.errors.push({
      line: sectionLine + 1,
      column: 1,
      message,
    });
  }

  return result.conversation;
}

function coerceQuickRepliesTemplate(value: unknown): RichContentAST['quickReplies'] | undefined {
  const binding = coerceCollectionBinding(value, coerceQuickReplyTemplate);
  if (binding !== undefined) {
    return binding;
  }

  if (!Array.isArray(value)) {
    return undefined;
  }

  const quickReplies = value
    .map((entry) => coerceQuickReplyTemplate(entry))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  return quickReplies.length > 0 ? quickReplies : undefined;
}

function coerceQuickReplyTemplate(value: unknown): QuickReplyAST | undefined {
  if (typeof value === 'string') {
    return {
      id: sanitizeActionId(value),
      label: value,
    };
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const label = coerceRichContentString(getRichContentField(record, 'label', 'title', 'text'));
  const idValue = getRichContentField(record, 'id', 'value', 'payload');
  const id = coerceRichContentString(idValue) ?? (label ? sanitizeActionId(label) : undefined);

  if (!label || !id) {
    return undefined;
  }

  return {
    id,
    label,
    iconUrl: coerceRichContentString(getRichContentField(record, 'icon_url', 'iconUrl')),
  };
}

function coerceListTemplate(value: unknown): RichContentAST['list'] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const rawItems = getRichContentField(record, 'items');
  const binding = coerceCollectionBinding(rawItems, coerceListItemTemplate);
  if (binding !== undefined) {
    return {
      title: coerceRichContentString(getRichContentField(record, 'title')),
      items: binding,
    };
  }

  if (!Array.isArray(rawItems)) {
    return undefined;
  }

  const items = rawItems
    .map((item) => coerceListItemTemplate(item))
    .filter((item): item is NonNullable<typeof item> => Boolean(item));

  if (items.length === 0) {
    return undefined;
  }

  return {
    title: coerceRichContentString(getRichContentField(record, 'title')),
    items,
  };
}

function coerceListItemTemplate(value: unknown): ListItemAST | undefined {
  if (typeof value === 'string') {
    return { title: value };
  }

  const itemRecord = asRecord(value);
  if (!itemRecord) {
    return undefined;
  }

  const title = coerceRichContentString(getRichContentField(itemRecord, 'title', 'label'));
  if (!title) {
    return undefined;
  }

  return {
    title,
    subtitle: coerceRichContentString(getRichContentField(itemRecord, 'subtitle', 'description')),
    imageUrl: coerceRichContentString(
      getRichContentField(itemRecord, 'image_url', 'imageUrl', 'image'),
    ),
    defaultActionUrl: coerceRichContentString(
      getRichContentField(itemRecord, 'default_action_url', 'defaultActionUrl', 'url'),
    ),
  };
}

function coerceMediaTemplate(
  value: unknown,
): RichContentAST['image'] | RichContentAST['video'] | RichContentAST['audio'] | undefined {
  if (typeof value === 'string') {
    return { url: value };
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const url = coerceRichContentString(getRichContentField(record, 'url', 'src'));
  if (!url) {
    return undefined;
  }

  return {
    url,
    alt: coerceRichContentString(getRichContentField(record, 'alt', 'label', 'title')),
    thumbnailUrl: coerceRichContentString(
      getRichContentField(record, 'thumbnail_url', 'thumbnailUrl'),
    ),
    caption: coerceRichContentString(getRichContentField(record, 'caption', 'description')),
  };
}

function filenameFromUrl(url: string): string | undefined {
  const parts = url.split(/[/?#]/).filter(Boolean);
  return parts.length > 0 ? parts[parts.length - 1] : undefined;
}

function coerceFileTemplate(value: unknown): RichContentAST['file'] | undefined {
  if (typeof value === 'string') {
    const filename = filenameFromUrl(value);
    return filename ? { url: value, filename } : undefined;
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const url = coerceRichContentString(getRichContentField(record, 'url', 'src'));
  const filename =
    coerceRichContentString(getRichContentField(record, 'filename', 'name')) ??
    (url ? filenameFromUrl(url) : undefined);

  if (!url || !filename) {
    return undefined;
  }

  return {
    url,
    filename,
    sizeBytes: coerceNumberValue(getRichContentField(record, 'size_bytes', 'sizeBytes')),
    mimeType: coerceRichContentString(getRichContentField(record, 'mime_type', 'mimeType')),
  };
}

function coerceKpiTemplate(value: unknown): RichContentAST['kpi'] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const label = coerceRichContentString(getRichContentField(record, 'label', 'title'));
  const rawMetricValue = getRichContentField(record, 'value');

  if (!label || (typeof rawMetricValue !== 'string' && typeof rawMetricValue !== 'number')) {
    return undefined;
  }

  const trendValue = coerceRichContentString(getRichContentField(record, 'trend'))?.toLowerCase();
  const trend =
    trendValue === 'up' || trendValue === 'down' || trendValue === 'flat'
      ? (trendValue as 'up' | 'down' | 'flat')
      : undefined;

  return {
    label,
    value: rawMetricValue,
    unit: coerceRichContentString(getRichContentField(record, 'unit')),
    trend,
    iconUrl: coerceRichContentString(getRichContentField(record, 'icon_url', 'iconUrl')),
  };
}

function coerceTableCell(value: unknown): string | number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'string') {
    const numericValue = Number(value);
    return Number.isFinite(numericValue) && value.trim() !== '' ? numericValue : value;
  }
  return undefined;
}

function coerceTableRowTemplate(
  row: unknown,
  columns?: Array<{ key: string }>,
): Record<string, string | number> | undefined {
  if (typeof row === 'string') {
    if (!columns) {
      return undefined;
    }
    const cells = row.split('/').map((cell) => cell.trim());
    if (cells.length === 0) {
      return undefined;
    }

    const parsedRow: Record<string, string | number> = {};
    columns.forEach((column, index) => {
      const parsedCell = coerceTableCell(cells[index]);
      if (parsedCell !== undefined) {
        parsedRow[column.key] = parsedCell;
      }
    });
    return Object.keys(parsedRow).length > 0 ? parsedRow : undefined;
  }

  if (Array.isArray(row)) {
    if (!columns) {
      return undefined;
    }
    const parsedRow: Record<string, string | number> = {};
    columns.forEach((column, index) => {
      const parsedCell = coerceTableCell(row[index]);
      if (parsedCell !== undefined) {
        parsedRow[column.key] = parsedCell;
      }
    });
    return Object.keys(parsedRow).length > 0 ? parsedRow : undefined;
  }

  const rowRecord = asRecord(row);
  if (!rowRecord) {
    return undefined;
  }

  const parsedRow: Record<string, string | number> = {};
  for (const [key, cellValue] of Object.entries(rowRecord)) {
    const parsedCell = coerceTableCell(cellValue);
    if (parsedCell !== undefined) {
      parsedRow[key] = parsedCell;
    }
  }

  return Object.keys(parsedRow).length > 0 ? parsedRow : undefined;
}

function coerceTableColumnTemplate(column: unknown): TableColumnAST | undefined {
  if (typeof column === 'string') {
    return { key: sanitizeActionId(column), header: column };
  }

  const columnRecord = asRecord(column);
  if (!columnRecord) {
    return undefined;
  }

  const key =
    coerceRichContentString(getRichContentField(columnRecord, 'key', 'field', 'id')) ??
    coerceRichContentString(getRichContentField(columnRecord, 'header', 'title', 'label'));
  const header =
    coerceRichContentString(getRichContentField(columnRecord, 'header', 'title', 'label')) ?? key;

  if (!key || !header) {
    return undefined;
  }

  const alignValue = coerceRichContentString(getRichContentField(columnRecord, 'align'));
  const align =
    alignValue === 'left' || alignValue === 'center' || alignValue === 'right'
      ? (alignValue as 'left' | 'center' | 'right')
      : undefined;

  return { key, header, align };
}

function coerceTableTemplate(value: unknown): RichContentAST['table'] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const rawColumns = getRichContentField(record, 'columns');
  const columnBinding = coerceCollectionBinding(rawColumns, coerceTableColumnTemplate);
  const columns =
    columnBinding !== undefined
      ? columnBinding
      : Array.isArray(rawColumns)
        ? rawColumns
            .map((column) => coerceTableColumnTemplate(column))
            .filter((column): column is NonNullable<typeof column> => Boolean(column))
        : undefined;

  if (columns === undefined || (Array.isArray(columns) && columns.length === 0)) {
    return undefined;
  }

  const rawRows = getRichContentField(record, 'rows');
  const rowBinding = coerceCollectionBinding(rawRows, (template) =>
    coerceTableRowTemplate(template, Array.isArray(columns) ? columns : undefined),
  );
  const rows =
    rowBinding !== undefined
      ? rowBinding
      : Array.isArray(rawRows)
        ? rawRows
            .map((row) => coerceTableRowTemplate(row, Array.isArray(columns) ? columns : undefined))
            .filter((row): row is NonNullable<typeof row> => Boolean(row))
        : [];

  return {
    columns,
    rows,
    maxVisibleRows: coerceNumberValue(
      getRichContentField(record, 'max_visible_rows', 'maxVisibleRows'),
    ),
  };
}

function coerceChartTemplate(value: unknown): RichContentAST['chart'] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const chartType = coerceRichContentString(getRichContentField(record, 'type'))?.toLowerCase();
  if (chartType !== 'bar' && chartType !== 'line' && chartType !== 'pie') {
    return undefined;
  }

  const rawData = getRichContentField(record, 'data');
  const dataBinding = coerceCollectionBinding(rawData, coerceChartDataPointTemplate);
  if (dataBinding !== undefined) {
    return {
      type: chartType as 'bar' | 'line' | 'pie',
      title: coerceRichContentString(getRichContentField(record, 'title')),
      data: dataBinding,
    };
  }

  if (!Array.isArray(rawData)) {
    return undefined;
  }

  const data = rawData
    .map((entry) => coerceChartDataPointTemplate(entry))
    .filter((entry): entry is NonNullable<typeof entry> => Boolean(entry));

  if (data.length === 0) {
    return undefined;
  }

  return {
    type: chartType as 'bar' | 'line' | 'pie',
    title: coerceRichContentString(getRichContentField(record, 'title')),
    data,
  };
}

function coerceChartDataPointTemplate(value: unknown): ChartDataPointAST | undefined {
  if (typeof value === 'string') {
    const [label, rawNumber, color] = value.split('/').map((part) => part.trim());
    const parsedValue = coerceNumberValue(rawNumber);
    if (!label || parsedValue === undefined) {
      return undefined;
    }

    return {
      label,
      value: parsedValue,
      color: color || undefined,
    };
  }

  const dataRecord = asRecord(value);
  if (!dataRecord) {
    return undefined;
  }

  const label = coerceRichContentString(getRichContentField(dataRecord, 'label'));
  const rawValue = getRichContentField(dataRecord, 'value');
  const parsedValue =
    coerceNumberValue(rawValue) ??
    (typeof rawValue === 'string' && rawValue.includes('{{') ? rawValue : undefined);
  if (!label || parsedValue === undefined) {
    return undefined;
  }

  return {
    label,
    value: parsedValue,
    color: coerceRichContentString(getRichContentField(dataRecord, 'color')),
  };
}

function coerceActionElement(
  value: unknown,
  defaultType: ActionElementAST['type'] = 'button',
): ActionElementAST | undefined {
  if (typeof value === 'string') {
    return {
      id: sanitizeActionId(value),
      type: defaultType,
      label: value,
    };
  }

  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const rawType = coerceRichContentString(getRichContentField(record, 'type'))?.toLowerCase();
  const type =
    rawType === 'button' || rawType === 'select' || rawType === 'input'
      ? (rawType as ActionElementAST['type'])
      : defaultType;
  const label =
    coerceRichContentString(getRichContentField(record, 'label', 'title', 'text')) ??
    coerceRichContentString(getRichContentField(record, 'id', 'name'));
  const id =
    coerceRichContentString(getRichContentField(record, 'id', 'name', 'value')) ??
    (label ? sanitizeActionId(label) : undefined);

  if (!label || !id) {
    return undefined;
  }

  const optionsValue = getRichContentField(record, 'options');
  const options = Array.isArray(optionsValue)
    ? optionsValue
        .map((option) => {
          if (typeof option === 'string') {
            return {
              id: sanitizeActionId(option),
              label: option,
            };
          }

          const optionRecord = asRecord(option);
          if (!optionRecord) {
            return undefined;
          }

          const optionLabel =
            coerceRichContentString(getRichContentField(optionRecord, 'label', 'title')) ??
            coerceRichContentString(getRichContentField(optionRecord, 'id', 'value'));
          const optionId =
            coerceRichContentString(getRichContentField(optionRecord, 'id', 'value')) ??
            (optionLabel ? sanitizeActionId(optionLabel) : undefined);

          if (!optionLabel || !optionId) {
            return undefined;
          }

          return {
            id: optionId,
            label: optionLabel,
            description: coerceRichContentString(
              getRichContentField(optionRecord, 'description', 'subtitle'),
            ),
          };
        })
        .filter((option): option is NonNullable<typeof option> => Boolean(option))
    : undefined;

  const inputTypeValue = coerceRichContentString(
    getRichContentField(record, 'input_type', 'inputType'),
  )?.toLowerCase();
  const inputType =
    inputTypeValue === 'text' ||
    inputTypeValue === 'number' ||
    inputTypeValue === 'date' ||
    inputTypeValue === 'time' ||
    inputTypeValue === 'email'
      ? (inputTypeValue as NonNullable<ActionElementAST['inputType']>)
      : undefined;

  return {
    id,
    type,
    label,
    value: coerceRichContentString(getRichContentField(record, 'value')),
    description: coerceRichContentString(getRichContentField(record, 'description', 'subtitle')),
    options,
    inputType,
    placeholder: coerceRichContentString(getRichContentField(record, 'placeholder')),
    required: coerceBooleanValue(getRichContentField(record, 'required')),
  };
}

function coerceFormTemplate(value: unknown): RichContentAST['form'] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const rawFields = getRichContentField(record, 'fields');
  const fieldBinding = coerceCollectionBinding(rawFields, (field) =>
    coerceActionElement(field, 'input'),
  );
  if (fieldBinding !== undefined) {
    return {
      title: coerceRichContentString(getRichContentField(record, 'title')),
      fields: fieldBinding,
      submitLabel: coerceRichContentString(
        getRichContentField(record, 'submit_label', 'submitLabel'),
      ),
    };
  }

  if (!Array.isArray(rawFields)) {
    return undefined;
  }

  const fields = rawFields
    .map((field) => coerceActionElement(field, 'input'))
    .filter((field): field is NonNullable<typeof field> => Boolean(field));

  if (fields.length === 0) {
    return undefined;
  }

  return {
    title: coerceRichContentString(getRichContentField(record, 'title')),
    fields,
    submitLabel: coerceRichContentString(
      getRichContentField(record, 'submit_label', 'submitLabel'),
    ),
  };
}

function coerceProgressTemplate(value: unknown): RichContentAST['progress'] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const progressValue = coerceNumberValue(getRichContentField(record, 'value'));
  if (progressValue === undefined) {
    return undefined;
  }

  const variantValue = coerceRichContentString(
    getRichContentField(record, 'variant'),
  )?.toLowerCase();
  const variant =
    variantValue === 'bar' || variantValue === 'circle'
      ? (variantValue as 'bar' | 'circle')
      : undefined;

  return {
    label: coerceRichContentString(getRichContentField(record, 'label')),
    value: progressValue,
    max: coerceNumberValue(getRichContentField(record, 'max')),
    variant,
  };
}

function coerceFeedbackTemplate(value: unknown): RichContentAST['feedback'] | undefined {
  const record = asRecord(value);
  if (!record) {
    return undefined;
  }

  const prompt = coerceRichContentString(
    getRichContentField(record, 'prompt', 'question', 'label'),
  );
  const feedbackType = coerceRichContentString(getRichContentField(record, 'type'))?.toLowerCase();

  if (
    !prompt ||
    (feedbackType !== 'thumbs' && feedbackType !== 'stars' && feedbackType !== 'scale')
  ) {
    return undefined;
  }

  return {
    prompt,
    type: feedbackType as 'thumbs' | 'stars' | 'scale',
    max: coerceNumberValue(getRichContentField(record, 'max')),
  };
}

function coerceCarouselTemplate(value: unknown): RichContentAST['carousel'] | undefined {
  const cardsValue = Array.isArray(value)
    ? value
    : asRecord(value)
      ? getRichContentField(value as Record<string, unknown>, 'cards')
      : undefined;

  const cardsBinding = coerceCollectionBinding(cardsValue ?? value, coerceCarouselCardTemplate);
  if (cardsBinding !== undefined) {
    return { cards: cardsBinding };
  }

  if (!Array.isArray(cardsValue)) {
    return undefined;
  }

  const cards = cardsValue
    .map((card) => coerceCarouselCardTemplate(card))
    .filter((card): card is NonNullable<typeof card> => Boolean(card));

  return cards.length > 0 ? { cards } : undefined;
}

function coerceCarouselCardTemplate(value: unknown): CarouselCardAST | undefined {
  const cardRecord = asRecord(value);
  if (!cardRecord) {
    return undefined;
  }

  const title = coerceRichContentString(getRichContentField(cardRecord, 'title'));
  if (!title) {
    return undefined;
  }

  const buttonsValue = getRichContentField(cardRecord, 'buttons');
  const buttons = Array.isArray(buttonsValue)
    ? buttonsValue
        .map((button) => coerceActionElement(button, 'button'))
        .filter((button): button is NonNullable<typeof button> => Boolean(button))
    : undefined;

  return {
    title,
    subtitle: coerceRichContentString(getRichContentField(cardRecord, 'subtitle', 'description')),
    imageUrl: coerceRichContentString(
      getRichContentField(cardRecord, 'image_url', 'imageUrl', 'image'),
    ),
    defaultActionUrl: coerceRichContentString(
      getRichContentField(cardRecord, 'default_action_url', 'defaultActionUrl', 'url'),
    ),
    buttons: buttons && buttons.length > 0 ? buttons : undefined,
  };
}

function pruneUndefinedRichContent(formats: RichContentAST): RichContentAST {
  return Object.fromEntries(
    Object.entries(formats).filter(([, value]) => value !== undefined),
  ) as RichContentAST;
}

/**
 * Parse a FORMATS: sub-block with MARKDOWN, ADAPTIVE_CARD, HTML, SLACK, AG_UI, WHATSAPP properties.
 * Mirrors parseVoiceBlock() structure.
 */
function parseFormatsBlock(state: ParserState): RichContentAST {
  const formats: RichContentAST = {};
  const blockIndent = getIndent(state.lines[state.currentLine]);
  state.currentLine++; // consume "FORMATS:" line

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    if (!line.trim()) {
      state.currentLine++;
      continue;
    }
    if (getIndent(line) <= blockIndent) break;

    const match = line.trim().match(/^(\w+):\s*(.*)$/);
    if (!match) {
      state.currentLine++;
      continue;
    }
    const [, key, val] = match;
    const parsed = parseRichContentValue(state, getIndent(line), val);

    switch (normalizeRichContentKey(key)) {
      case 'MARKDOWN':
        formats.markdown = coerceRichContentString(parsed);
        continue;
      case 'ADAPTIVECARD':
        formats.adaptiveCard = coerceRichContentString(parsed, { stringifyObjects: true });
        continue;
      case 'HTML':
        formats.html = coerceRichContentString(parsed);
        continue;
      case 'SLACK':
        formats.slack = coerceRichContentString(parsed, { stringifyObjects: true });
        continue;
      case 'AGUI':
        formats.agUi = coerceRichContentString(parsed, { stringifyObjects: true });
        continue;
      case 'WHATSAPP':
        formats.whatsapp = coerceRichContentString(parsed, { stringifyObjects: true });
        continue;
      case 'CAROUSEL':
        formats.carousel = coerceCarouselTemplate(parsed);
        continue;
      case 'QUICKREPLIES':
        formats.quickReplies = coerceQuickRepliesTemplate(parsed);
        continue;
      case 'LIST':
        formats.list = coerceListTemplate(parsed);
        continue;
      case 'IMAGE':
        formats.image = coerceMediaTemplate(parsed);
        continue;
      case 'VIDEO':
        formats.video = coerceMediaTemplate(parsed);
        continue;
      case 'AUDIO':
        formats.audio = coerceMediaTemplate(parsed);
        continue;
      case 'FILE':
        formats.file = coerceFileTemplate(parsed);
        continue;
      case 'KPI':
        formats.kpi = coerceKpiTemplate(parsed);
        continue;
      case 'TABLE':
        formats.table = coerceTableTemplate(parsed);
        continue;
      case 'CHART':
        formats.chart = coerceChartTemplate(parsed);
        continue;
      case 'FORM':
        formats.form = coerceFormTemplate(parsed);
        continue;
      case 'PROGRESS':
        formats.progress = coerceProgressTemplate(parsed);
        continue;
      case 'FEEDBACK':
        formats.feedback = coerceFeedbackTemplate(parsed);
        continue;
    }
  }
  return pruneUndefinedRichContent(formats);
}

/**
 * After parsing VOICE config (if any), peek ahead for a FORMATS: sub-block.
 * Returns RichContentAST if found, undefined otherwise.
 */
function tryParseFormatsBlock(
  state: ParserState,
  respondIndent: number,
): RichContentAST | undefined {
  let peek = state.currentLine;
  while (peek < state.lines.length && !state.lines[peek].trim()) peek++;

  if (peek < state.lines.length) {
    const nextIndent = getIndent(state.lines[peek]);
    const nextTrimmed = state.lines[peek].trim().toUpperCase();
    if (nextIndent > respondIndent && nextTrimmed.startsWith('FORMATS:')) {
      state.currentLine = peek;
      return parseFormatsBlock(state);
    }
  }
  return undefined;
}

// =============================================================================
// ACTIONS BLOCK PARSER
// =============================================================================

/**
 * Sanitize a label into a valid action ID: lowercase, spaces to underscores,
 * strip characters not valid in ON_ACTION handler declarations ([\w-]).
 */
function sanitizeActionId(label: string): string {
  return label
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[^\w-]/g, '');
}

function parseActionElementAttributes(
  state: ParserState,
  itemIndent: number,
): Partial<
  Pick<ActionElementAST, 'id' | 'value' | 'description' | 'inputType' | 'placeholder' | 'required'>
> {
  const attributes: Partial<
    Pick<
      ActionElementAST,
      'id' | 'value' | 'description' | 'inputType' | 'placeholder' | 'required'
    >
  > = {};
  let idx = state.currentLine + 1;
  let lastConsumed = state.currentLine;

  while (idx < state.lines.length) {
    const line = state.lines[idx];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (!trimmed) {
      idx++;
      continue;
    }
    if (indent <= itemIndent) {
      break;
    }

    const match = trimmed.match(/^([A-Z_]+):\s*(.*)$/i);
    if (!match) {
      break;
    }

    const key = match[1].toUpperCase();
    if (key === 'OPTIONS') {
      break;
    }
    const value = stripWrappingQuotes(match[2]);
    switch (key) {
      case 'ID':
      case 'ACTION_ID':
      case 'NAME':
        if (value) {
          attributes.id = value;
        }
        break;
      case 'VALUE':
      case 'PAYLOAD':
        attributes.value = value;
        break;
      case 'URL':
        attributes.value = value;
        break;
      case 'DESCRIPTION':
      case 'SUBTITLE':
        attributes.description = value;
        break;
      case 'INPUT_TYPE': {
        const normalized = value.toLowerCase();
        if (
          normalized === 'text' ||
          normalized === 'number' ||
          normalized === 'date' ||
          normalized === 'time' ||
          normalized === 'email'
        ) {
          attributes.inputType = normalized;
        }
        break;
      }
      case 'PLACEHOLDER':
        attributes.placeholder = value;
        break;
      case 'REQUIRED':
        attributes.required = coerceBooleanValue(value);
        break;
      default:
        break;
    }

    lastConsumed = idx;
    idx++;
  }

  state.currentLine = lastConsumed;
  return attributes;
}

/**
 * Parse a BUTTON element from a list item.
 * Supports:
 *   - Arrow syntax: "Label" -> action_id
 *   - Block metadata: ID, VALUE, URL, DESCRIPTION on subsequent indented lines
 */
function parseButtonElement(
  rest: string,
  state: ParserState,
  itemIndent: number,
): ActionElementAST {
  // Arrow syntax: "Label" -> action_id
  const arrowMatch = rest.match(/^"([^"]+)"\s*->\s*(\S+)$/);
  if (arrowMatch) {
    const attributes = parseActionElementAttributes(state, itemIndent);
    const actionId = attributes.id ?? arrowMatch[2];
    return {
      id: actionId,
      type: 'button',
      label: arrowMatch[1],
      value: attributes.value ?? actionId,
      description: attributes.description,
    };
  }

  // Label only on this line — check for block metadata on subsequent lines.
  const label = rest.replace(/^"|"$/g, '');
  const attributes = parseActionElementAttributes(state, itemIndent);
  const autoId = sanitizeActionId(label);
  return {
    id: attributes.id ?? autoId,
    type: 'button',
    label,
    value: attributes.value ?? attributes.id ?? autoId,
    description: attributes.description,
  };
}

function parseInputElement(rest: string, state: ParserState, itemIndent: number): ActionElementAST {
  const label = rest.replace(/^"|"$/g, '');
  const attributes = parseActionElementAttributes(state, itemIndent);
  const autoId = sanitizeActionId(label);
  return {
    id: attributes.id ?? autoId,
    type: 'input',
    label,
    value: attributes.value,
    description: attributes.description,
    inputType: attributes.inputType,
    placeholder: attributes.placeholder,
    required: attributes.required,
  };
}

/**
 * Parse a SELECT element from a list item.
 * Supports OPTIONS: sub-block with "Label" -> option_id items.
 */
function parseSelectElement(
  rest: string,
  state: ParserState,
  itemIndent: number,
): ActionElementAST {
  const label = rest.replace(/^"|"$/g, '');
  const autoId = sanitizeActionId(label);
  const options: Array<{ id: string; label: string; description?: string }> = [];
  const attributes = parseActionElementAttributes(state, itemIndent);
  const element: ActionElementAST = {
    id: attributes.id ?? autoId,
    type: 'select',
    label,
    value: attributes.value,
    description: attributes.description,
    options,
  };

  // Look for OPTIONS: on next line
  const nextIdx = state.currentLine + 1;
  if (nextIdx < state.lines.length) {
    const nextLine = state.lines[nextIdx];
    const nextTrimmed = nextLine.trim();
    const nextIndent = getIndent(nextLine);
    if (nextIndent > itemIndent && nextTrimmed.toUpperCase().startsWith('OPTIONS:')) {
      state.currentLine++; // consume OPTIONS: line
      const optionsIndent = getIndent(state.lines[state.currentLine]);
      state.currentLine++; // move past OPTIONS:

      // Parse option items: - "Label" -> option_id
      while (state.currentLine < state.lines.length) {
        const optLine = state.lines[state.currentLine];
        const optTrimmed = optLine.trim();
        const optIndent = getIndent(optLine);

        if (!optTrimmed) {
          state.currentLine++;
          continue;
        }
        if (optIndent <= optionsIndent) break;

        if (optTrimmed.startsWith('- ')) {
          const optRest = optTrimmed.substring(2).trim();
          const optArrow = optRest.match(/^"([^"]+)"\s*->\s*(\S+)$/);
          if (optArrow) {
            const option: { id: string; label: string; description?: string } = {
              id: optArrow[2],
              label: optArrow[1],
            };
            const optionIndent = optIndent;
            while (state.currentLine + 1 < state.lines.length) {
              const metadataLine = state.lines[state.currentLine + 1];
              const metadataTrimmed = metadataLine.trim();
              const metadataIndent = getIndent(metadataLine);
              if (!metadataTrimmed) {
                state.currentLine++;
                continue;
              }
              if (metadataIndent <= optionIndent) {
                break;
              }
              const metadataMatch = metadataTrimmed.match(/^([A-Z_]+):\s*(.*)$/i);
              if (!metadataMatch) {
                break;
              }
              if (metadataMatch[1].toUpperCase() === 'DESCRIPTION') {
                option.description = stripWrappingQuotes(metadataMatch[2]);
              }
              state.currentLine++;
            }
            options.push(option);
          }
        }
        state.currentLine++;
      }
      // Back up since the outer loop will also advance
      return element;
    }
  }

  return element;
}

/**
 * Parse an ACTIONS: sub-block under RESPOND.
 * Returns ActionSetAST if found, undefined otherwise.
 */
function tryParseActionsBlock(state: ParserState, respondIndent: number): ActionSetAST | undefined {
  let peek = state.currentLine;
  while (peek < state.lines.length && !state.lines[peek].trim()) peek++;

  if (peek >= state.lines.length) return undefined;

  const nextIndent = getIndent(state.lines[peek]);
  const nextTrimmed = state.lines[peek].trim().toUpperCase();
  if (!(nextIndent > respondIndent && nextTrimmed.startsWith('ACTIONS:'))) {
    return undefined;
  }

  state.currentLine = peek;
  const actionsIndent = getIndent(state.lines[state.currentLine]);
  state.currentLine++; // consume ACTIONS: line

  const elements: ActionElementAST[] = [];
  let submitLabel: string | undefined;
  let submitId: string | undefined;
  let renderId: string | undefined;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (!trimmed) {
      state.currentLine++;
      continue;
    }
    if (indent <= actionsIndent) break;

    const metadataMatch = trimmed.match(/^([A-Z_]+):\s*(.*)$/i);
    if (metadataMatch) {
      const key = metadataMatch[1].toUpperCase();
      const value = stripWrappingQuotes(metadataMatch[2]);
      if (key === 'SUBMIT_LABEL') {
        submitLabel = value;
        state.currentLine++;
        continue;
      }
      if (key === 'SUBMIT_ID') {
        submitId = value;
        state.currentLine++;
        continue;
      }
      if (key === 'RENDER_ID') {
        renderId = value;
        state.currentLine++;
        continue;
      }
    }

    if (trimmed.startsWith('- BUTTON:')) {
      const rest = trimmed.substring(9).trim();
      const itemIndent = indent;
      elements.push(parseButtonElement(rest, state, itemIndent));
      state.currentLine++;
      continue;
    }

    if (trimmed.startsWith('- SELECT:')) {
      const rest = trimmed.substring(9).trim();
      const itemIndent = indent;
      const selectLine = state.currentLine;
      elements.push(parseSelectElement(rest, state, itemIndent));
      // If parseSelectElement didn't advance (no OPTIONS block), advance past the SELECT line
      if (state.currentLine === selectLine) {
        state.currentLine++;
      }
      continue;
    }

    if (trimmed.startsWith('- INPUT:')) {
      const rest = trimmed.substring(8).trim();
      const itemIndent = indent;
      elements.push(parseInputElement(rest, state, itemIndent));
      state.currentLine++;
      continue;
    }

    state.currentLine++;
  }

  return elements.length > 0 ? { elements, submitLabel, submitId, renderId } : undefined;
}

// =============================================================================
// ON_ACTION BLOCK PARSER
// =============================================================================

function stripWrappingQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function parseActionHandlerSetAssignments(
  state: ParserState,
  parentIndent: number,
  inlineValue: string,
): Record<string, string> {
  const set: Record<string, string> = {};

  const parseAssignment = (text: string): void => {
    const setMatch = text.match(/^(\w[\w.]*)\s*=\s*(.+)$/);
    if (setMatch) {
      set[setMatch[1]] = setMatch[2].trim();
    } else {
      state.errors.push({
        line: state.currentLine + 1,
        column: 1,
        message: `Invalid ON_ACTION SET assignment "${text}"`,
      });
    }
  };

  if (inlineValue.trim()) {
    parseAssignment(inlineValue.trim());
    state.currentLine++;
    return set;
  }

  state.currentLine++;
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    parseAssignment(trimmed);
    state.currentLine++;
  }

  return set;
}

function parseActionHandlerCall(
  state: ParserState,
  rawValue: string,
): Pick<ActionHandlerActionAST, 'call' | 'resultKey' | 'callSpec'> {
  const invocation = parseToolInvocation(state, rawValue);
  const resultKey = invocation.callAs ?? invocation.callSpec?.as;

  if (!invocation.call) {
    state.errors.push({
      line: state.currentLine + 1,
      column: 1,
      message: `Invalid ON_ACTION CALL "${rawValue}". Expected "CALL: tool_name AS result_key".`,
    });
    return { call: rawValue.trim(), callSpec: invocation.callSpec };
  }

  if (!resultKey) {
    state.errors.push({
      line: state.currentLine + 1,
      column: 1,
      message: `ON_ACTION CALL "${invocation.call}" must declare an AS result key.`,
    });
  }

  return {
    call: invocation.call,
    resultKey,
    callSpec: invocation.callSpec,
  };
}

function parseActionHandlerDelegateActionDetails(
  state: ParserState,
  parentIndent: number,
  action: ActionHandlerActionAST,
): void {
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (!propMatch) {
      state.errors.push({
        line: state.currentLine + 1,
        column: 1,
        message: `Invalid ON_ACTION DELEGATE property "${trimmed}"`,
      });
      state.currentLine++;
      continue;
    }

    const [, key, value] = propMatch;
    switch (key.toUpperCase()) {
      case 'RETURN':
        action.return = value.trim().toLowerCase() === 'true';
        state.currentLine++;
        continue;
      case 'ON_RETURN':
        state.currentLine++;
        action.onReturn = parseDigressionOnReturnBlock(state, indent, state);
        continue;
      default:
        state.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message: `Unknown ON_ACTION DELEGATE property "${key}"`,
        });
        state.currentLine++;
        continue;
    }
  }
}

function parseActionHandlerDoBlock(
  state: ParserState,
  parentIndent: number,
): ActionHandlerActionAST[] {
  const actions: ActionHandlerActionAST[] = [];

  state.currentLine++; // consume DO:
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    if (!trimmed.startsWith('- ')) {
      state.errors.push({
        line: state.currentLine + 1,
        column: 1,
        message: `Invalid ON_ACTION DO action "${trimmed}"`,
      });
      state.currentLine++;
      continue;
    }

    const actionIndent = indent;
    const actionBody = trimmed.substring(2).trim();
    if (actionBody.toUpperCase() === 'COMPLETE') {
      actions.push({ complete: true });
      state.currentLine++;
      continue;
    }

    const actionMatch = actionBody.match(/^(\w+):\s*(.*)$/);
    if (!actionMatch) {
      state.errors.push({
        line: state.currentLine + 1,
        column: 1,
        message: `Unknown ON_ACTION DO action "${actionBody}"`,
      });
      state.currentLine++;
      continue;
    }

    const [, actionKey, rawValue] = actionMatch;
    switch (actionKey.toUpperCase()) {
      case 'SET':
        actions.push({
          set: parseActionHandlerSetAssignments(state, actionIndent, rawValue),
        });
        continue;
      case 'CLEAR':
        actions.push({ clear: parseArray(rawValue) });
        state.currentLine++;
        continue;
      case 'RESPOND': {
        const action: ActionHandlerActionAST = {};
        const respondIndent = getIndent(state.lines[state.currentLine]);
        if (rawValue.startsWith('|')) {
          state.currentLine++;
          action.respond = parseMultiLineString(state);
        } else {
          action.respond = stripWrappingQuotes(rawValue);
          state.currentLine++;
        }
        action.voiceConfig = tryParseVoiceConfig(state, respondIndent);
        action.richContent = tryParseFormatsBlock(state, respondIndent);
        action.actions = tryParseActionsBlock(state, respondIndent);
        actions.push(action);
        continue;
      }
      case 'CALL':
        actions.push(parseActionHandlerCall(state, rawValue));
        state.currentLine++;
        continue;
      case 'GOTO':
      case 'TRANSITION':
      case 'THEN':
        actions.push({ goto: rawValue.trim() });
        state.currentLine++;
        continue;
      case 'HANDOFF':
        actions.push({ handoff: rawValue.trim() });
        state.currentLine++;
        continue;
      case 'DELEGATE': {
        const action: ActionHandlerActionAST = { delegate: rawValue.trim() };
        state.currentLine++;
        parseActionHandlerDelegateActionDetails(state, actionIndent, action);
        actions.push(action);
        continue;
      }
      case 'COMPLETE':
        actions.push({ complete: rawValue === '' || rawValue.trim().toLowerCase() === 'true' });
        state.currentLine++;
        continue;
      default:
        state.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message: `Unknown ON_ACTION DO action "${actionKey}"`,
        });
        state.currentLine++;
        continue;
    }
  }

  return actions;
}

/**
 * Parse an ON_ACTION: block at step level.
 * Each handler is: action_id: followed by RESPOND:, TRANSITION:, SET:, CONDITION:
 */
function parseOnActionBlock(state: ParserState, onActionIndent: number): ActionHandlerAST[] {
  state.currentLine++; // consume ON_ACTION: line
  const handlers: ActionHandlerAST[] = [];
  let currentHandler: Partial<ActionHandlerAST> | null = null;
  let handlerIndent: number | undefined;
  const appendAction = (action: ActionHandlerActionAST): void => {
    if (!currentHandler) return;
    currentHandler.do = [...(currentHandler.do ?? []), action];
  };

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (!trimmed) {
      state.currentLine++;
      continue;
    }
    if (indent <= onActionIndent) break;

    // Action handler definition: action_id:
    // Supports word chars and hyphens to match IDs from button arrow syntax
    const handlerMatch = trimmed.match(/^([\w-]+):$/);
    if (handlerMatch) {
      if (handlerIndent === undefined) handlerIndent = indent;
      if (indent === handlerIndent) {
        // Save previous handler
        if (currentHandler?.actionId) {
          handlers.push(currentHandler as ActionHandlerAST);
        }
        currentHandler = { actionId: handlerMatch[1] };
        state.currentLine++;
        continue;
      }
    }

    // Handler properties
    if (currentHandler) {
      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (propMatch) {
        const [, key, val] = propMatch;
        switch (key.toUpperCase()) {
          case 'RESPOND': {
            const respondIndent = getIndent(state.lines[state.currentLine]);
            const respond = stripWrappingQuotes(val);
            currentHandler.respond = respond;
            state.currentLine++;
            const voiceConfig = tryParseVoiceConfig(state, respondIndent);
            const richContent = tryParseFormatsBlock(state, respondIndent);
            const actions = tryParseActionsBlock(state, respondIndent);
            currentHandler.voiceConfig = voiceConfig;
            currentHandler.richContent = richContent;
            currentHandler.actions = actions;
            appendAction({ respond, voiceConfig, richContent, actions });
            continue;
          }
          case 'TRANSITION':
          case 'THEN':
          case 'GOTO':
            currentHandler.transition = val.trim();
            appendAction({ goto: val.trim() });
            break;
          case 'CONDITION':
            currentHandler.condition = stripWrappingQuotes(val);
            break;
          case 'DO':
            currentHandler.do = [
              ...(currentHandler.do ?? []),
              ...parseActionHandlerDoBlock(state, indent),
            ];
            continue;
          case 'HANDOFF':
            appendAction({ handoff: val.trim() });
            break;
          case 'DELEGATE': {
            const action: ActionHandlerActionAST = { delegate: val.trim() };
            state.currentLine++;
            parseActionHandlerDelegateActionDetails(state, indent, action);
            appendAction(action);
            continue;
          }
          case 'COMPLETE':
            appendAction({ complete: val.trim() === '' || val.trim().toLowerCase() === 'true' });
            break;
          case 'CLEAR':
            appendAction({ clear: parseArray(val) });
            break;
          case 'CALL':
            appendAction(parseActionHandlerCall(state, val));
            break;
          case 'SET': {
            if (!currentHandler.set) currentHandler.set = {};
            // Parse inline set: key = value
            const setMatch = val.match(/^(\w[\w.]*)\s*=\s*(.+)$/);
            if (setMatch) {
              currentHandler.set[setMatch[1]] = setMatch[2].trim();
              appendAction({ set: { [setMatch[1]]: setMatch[2].trim() } });
            } else {
              state.errors.push({
                line: state.currentLine + 1,
                column: 1,
                message: `Invalid ON_ACTION SET assignment "${val}"`,
              });
            }
            break;
          }
          default:
            state.errors.push({
              line: state.currentLine + 1,
              column: 1,
              message: `Unknown ON_ACTION handler property "${key}"`,
            });
            break;
        }
      } else {
        state.errors.push({
          line: state.currentLine + 1,
          column: 1,
          message: `Invalid ON_ACTION handler property "${trimmed}"`,
        });
      }
    }

    state.currentLine++;
  }

  // Save last handler
  if (currentHandler?.actionId) {
    handlers.push(currentHandler as ActionHandlerAST);
  }

  return handlers;
}

// =============================================================================
// CAROUSEL BLOCK PARSER
// =============================================================================

/**
 * Parse a CAROUSEL: sub-block under RESPOND.
 * Returns CarouselAST if found, undefined otherwise.
 */
function tryParseCarouselBlock(state: ParserState, respondIndent: number): CarouselAST | undefined {
  let peek = state.currentLine;
  while (peek < state.lines.length && !state.lines[peek].trim()) peek++;

  if (peek >= state.lines.length) return undefined;

  const nextIndent = getIndent(state.lines[peek]);
  const nextTrimmed = state.lines[peek].trim().toUpperCase();
  if (!(nextIndent > respondIndent && nextTrimmed.startsWith('CAROUSEL:'))) {
    return undefined;
  }

  state.currentLine = peek;
  const carouselIndent = getIndent(state.lines[state.currentLine]);
  state.currentLine++; // consume CAROUSEL: line

  const cards: CarouselCardAST[] = [];
  let currentCard: Partial<CarouselCardAST> | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (!trimmed) {
      state.currentLine++;
      continue;
    }
    if (indent <= carouselIndent) break;

    // New card: - TITLE: "..."
    if (trimmed.startsWith('- TITLE:')) {
      // Save previous card
      if (currentCard?.title) {
        cards.push(currentCard as CarouselCardAST);
      }
      const titleVal = trimmed.substring(8).trim().replace(/^"|"$/g, '');
      currentCard = { title: titleVal };
      state.currentLine++;
      continue;
    }

    // Card properties (at indent > card list item indent)
    if (currentCard) {
      const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
      if (propMatch) {
        const [, key, val] = propMatch;
        switch (key.toUpperCase()) {
          case 'SUBTITLE':
            currentCard.subtitle = val.replace(/^"|"$/g, '');
            state.currentLine++;
            continue;
          case 'IMAGE':
            currentCard.imageUrl = val.replace(/^"|"$/g, '');
            state.currentLine++;
            continue;
          case 'DEFAULT_ACTION':
            currentCard.defaultActionUrl = val.replace(/^"|"$/g, '');
            state.currentLine++;
            continue;
          case 'BUTTONS': {
            // Parse BUTTONS sub-block — reuses parseButtonElement
            const buttonsIndent = indent;
            state.currentLine++; // consume BUTTONS: line
            const buttons: ActionElementAST[] = [];

            while (state.currentLine < state.lines.length) {
              const btnLine = state.lines[state.currentLine];
              const btnTrimmed = btnLine.trim();
              const btnIndent = getIndent(btnLine);

              if (!btnTrimmed) {
                state.currentLine++;
                continue;
              }
              if (btnIndent <= buttonsIndent) break;

              if (btnTrimmed.startsWith('- BUTTON:')) {
                const btnRest = btnTrimmed.substring(9).trim();
                buttons.push(parseButtonElement(btnRest, state, btnIndent));
                state.currentLine++;
                continue;
              }

              state.currentLine++;
            }

            currentCard.buttons = buttons;
            continue;
          }
        }
      }
    }

    state.currentLine++;
  }

  // Save last card
  if (currentCard?.title) {
    cards.push(currentCard as CarouselCardAST);
  }

  return cards.length > 0 ? { cards } : undefined;
}

function parseMultiLineString(state: ParserState): string {
  const lines: string[] = [];
  const baseIndent = getIndent(state.lines[state.currentLine] || '');

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const indent = getIndent(line);

    // Stop if we hit a line with less indentation (unless empty)
    if (line.trim() && indent < baseIndent) {
      break;
    }

    // Add line content (removing base indentation)
    if (line.trim()) {
      lines.push(line.substring(baseIndent));
    } else {
      lines.push('');
    }

    state.currentLine++;
  }

  return lines.join('\n').trim();
}

function getIndent(line: string): number {
  const match = line.match(/^(\s*)/);
  return match ? match[1].length : 0;
}

function parseArray(value: string): string[] {
  const trimmed = value.trim();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    return trimmed
      .slice(1, -1)
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter((s) => s);
  }
  return [];
}

function parseIndentedStringList(state: ParserState, parentIndent: number): string[] {
  const result: string[] = [];

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();
    const indent = getIndent(line);

    if (trimmed && indent <= parentIndent) {
      break;
    }

    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    if (!trimmed.startsWith('-')) {
      break;
    }

    const value = trimmed.substring(1).trim().replace(/^"|"$/g, '');
    if (value) {
      result.push(value);
    }
    state.currentLine++;
  }

  return result;
}

function parseInlineObject(value: string): Record<string, string> | null {
  const trimmed = value.trim();

  // Handle braced format: { key: value, key2: value2 }
  // Also handle bare format: key: $value, key2: $value2
  const content = trimmed.startsWith('{') && trimmed.endsWith('}') ? trimmed.slice(1, -1) : trimmed;

  // Must have content and contain at least one key: value pattern
  if (!content.trim() || !content.match(/\w+:\s*.+/)) return null;

  const result: Record<string, string> = {};
  const parts = splitParams(content);

  for (const part of parts) {
    const match = part.trim().match(/^(\w+):\s*(.+)$/);
    if (match) {
      result[match[1]] = match[2].trim();
    } else if (part.trim()) {
      result[part.trim()] = part.trim();
    }
  }

  return Object.keys(result).length > 0 ? result : null;
}

/**
 * Parse indented key-value pairs from subsequent lines.
 * Used for multi-line INPUT/RETURNS blocks in DELEGATE:
 *   INPUT:
 *     hotel: selected_hotel
 *     nights: num_nights
 */
function parseIndentedKeyValues(state: ParserState): Record<string, string> {
  const result: Record<string, string> = {};
  // Peek at subsequent lines for indented key: value pairs
  const startLine = state.currentLine + 1;
  let i = startLine;

  while (i < state.lines.length) {
    const nextLine = state.lines[i];
    const nextTrimmed = nextLine.trim();

    // Stop at empty lines, new sections, or non-indented content
    if (!nextTrimmed || (!nextLine.startsWith(' ') && !nextLine.startsWith('\t'))) {
      break;
    }

    // Stop at known DELEGATE property keywords so multi-line INPUT/PASS maps do not
    // consume sibling properties.
    if (
      nextTrimmed.match(
        /^(WHEN|PURPOSE|SUMMARY|INPUT|PASS|RETURNS|USE_RESULT|TIMEOUT|ON_FAILURE|EXPERIENCE_MODE|LOCATION|ENDPOINT|PROTOCOL|AGENT|TO):/i,
      ) &&
      nextTrimmed.match(/^[A-Z_]+:/)
    ) {
      break;
    }

    // Parse key: value
    const kvMatch = nextTrimmed.match(/^(\w+):\s*(.+)$/);
    if (kvMatch) {
      result[kvMatch[1]] = kvMatch[2].trim();
      i++;
    } else {
      break;
    }
  }

  // Only advance state.currentLine if we consumed lines
  // (the outer loop will also do state.currentLine++, so adjust)
  if (i > startLine) {
    // We consumed lines from startLine to i-1
    // The outer loop will advance past the current line (INPUT:/RETURNS:)
    // We need the next iteration to start at line i
    // Since the outer loop does state.currentLine++ at the end, set to i-1
    state.currentLine = i - 1;
  }

  return result;
}

// =============================================================================
// IDENTITY SECTION PARSER (for IDENTITY: role, persona, expertise, limitations)
// =============================================================================

interface IdentityResult {
  role: string;
  persona: string;
  expertise: string[];
  limitations: string[];
}

function parseIdentity(state: ParserState): IdentityResult {
  state.currentLine++;
  const result: IdentityResult = {
    role: '',
    persona: '',
    expertise: [],
    limitations: [],
  };

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (
        trimmed.match(/^[A-Z_]+:/) &&
        !['role:', 'persona:', 'expertise:', 'limitations:'].includes(trimmed.toLowerCase())
      ) {
        break;
      }
    }

    // Skip comments
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Parse identity properties
    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      const keyLower = key.toLowerCase();

      if (keyLower === 'role') {
        result.role = value.replace(/^"|"$/g, '');
      } else if (keyLower === 'persona') {
        result.persona = value.replace(/^"|"$/g, '');
      } else if (keyLower === 'expertise') {
        result.expertise = parseArray(value);
      } else if (keyLower === 'limitations') {
        result.limitations = parseArray(value);
      }
    }

    state.currentLine++;
  }

  return result;
}

// =============================================================================
// STEPS SECTION PARSER (for numbered steps like 1. StepName)
// =============================================================================

function parseSteps(state: ParserState): FlowDefinition {
  state.currentLine++;
  const flow: FlowDefinition = {
    steps: [],
    definitions: {},
  };

  let currentStepName: string | null = null;
  let currentStep: FlowStep | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (trimmed.match(/^[A-Z_]+:/) && !trimmed.match(/^\d+\./)) {
        break;
      }
    }

    // Skip comments
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Step definition: 1. StepName or just StepName
    const stepMatch = trimmed.match(/^(\d+)\.\s*(\w+)$/);
    if (stepMatch) {
      // Save previous step
      if (currentStep && currentStepName) {
        flow.definitions[currentStepName] = currentStep;
        if (!flow.steps.includes(currentStepName)) {
          flow.steps.push(currentStepName);
        }
      }

      currentStepName = stepMatch[2];
      currentStep = { name: currentStepName };
      state.currentLine++;
      continue;
    }

    // Step actions within a step
    if (currentStep && trimmed) {
      // RESPOND "message"
      const respondMatch = trimmed.match(/^RESPOND\s+"([^"]+)"$/);
      if (respondMatch) {
        currentStep.respond = respondMatch[1];
        state.currentLine++;
        continue;
      }

      // WAIT_INPUT with routes
      if (trimmed === 'WAIT_INPUT') {
        currentStep.then = 'WAIT_INPUT';
        state.currentLine++;
        // Parse routes following WAIT_INPUT
        while (state.currentLine < state.lines.length) {
          const routeLine = state.lines[state.currentLine].trim();
          if (
            !routeLine.match(/^(INTENT|DEFAULT|POSITIVE|NEGATIVE)\s*\(/i) &&
            !routeLine.startsWith('->')
          ) {
            break;
          }
          // Parse intent routes: INTENT(a, b, c) -> 2
          const intentMatch = routeLine.match(/^INTENT\(([^)]+)\)\s*->\s*(\d+|\w+)$/i);
          if (intentMatch) {
            // Store as check for now
            if (!currentStep.check) currentStep.check = '';
            currentStep.check += `INTENT(${intentMatch[1]}) -> ${intentMatch[2]}; `;
          }
          // Parse default route: DEFAULT -> 2
          const defaultMatch = routeLine.match(/^DEFAULT\s*->\s*(\d+|\w+)$/i);
          if (defaultMatch) {
            currentStep.then = defaultMatch[1];
          }
          state.currentLine++;
        }
        continue;
      }

      // CALL tool(args)
      const callMatch = trimmed.match(/^CALL\s+(\w+)\s*\(([^)]*)\)$/);
      if (callMatch) {
        currentStep.call = `${callMatch[1]}(${callMatch[2]})`;
        state.currentLine++;
        continue;
      }

      // ON_SUCCESS -> step
      const successMatch = trimmed.match(/^ON_SUCCESS\s*->\s*(\d+|\w+)$/);
      if (successMatch) {
        currentStep.then = successMatch[1];
        state.currentLine++;
        continue;
      }

      // ON_FAILURE -> step
      const failMatch = trimmed.match(/^ON_FAILURE\s*->\s*(\d+|\w+)$/);
      if (failMatch) {
        currentStep.onFail = failMatch[1];
        state.currentLine++;
        continue;
      }

      // GOTO step
      const gotoMatch = trimmed.match(/^GOTO\s+(\d+|\w+)$/);
      if (gotoMatch) {
        currentStep.then = gotoMatch[1];
        state.currentLine++;
        continue;
      }

      // SIGNAL: type
      const signalMatch = trimmed.match(/^SIGNAL:\s*(\w+)$/);
      if (signalMatch) {
        currentStep.then = `SIGNAL:${signalMatch[1]}`;
        state.currentLine++;
        continue;
      }

      // SET variable = value
      const setMatch = trimmed.match(/^SET\s+(\S+)\s*=\s*(.+)$/);
      if (setMatch) {
        if (!currentStep.set) currentStep.set = [];
        currentStep.set.push({ variable: setMatch[1], expression: setMatch[2].trim() });
        state.currentLine++;
        continue;
      }

      // IF condition THEN
      const ifMatch = trimmed.match(/^IF\s+(.+)\s+THEN$/);
      if (ifMatch) {
        currentStep.check = ifMatch[1];
        state.currentLine++;
        continue;
      }

      // ELSE IF
      if (trimmed.startsWith('ELSE IF') || trimmed.startsWith('ELSE')) {
        state.currentLine++;
        continue;
      }

      // CLASSIFY user_input
      if (trimmed.startsWith('CLASSIFY')) {
        state.currentLine++;
        continue;
      }
    }

    state.currentLine++;
  }

  // Save last step
  if (currentStep && currentStepName) {
    flow.definitions[currentStepName] = currentStep;
    if (!flow.steps.includes(currentStepName)) {
      flow.steps.push(currentStepName);
    }
  }

  return flow;
}

// =============================================================================
// GUARDRAILS SECTION PARSER
// =============================================================================

function parseGuardrails(state: ParserState): ConstraintPhase[] {
  state.currentLine++;
  const phases: ConstraintPhase[] = [];
  let currentGuardrail: {
    name: string;
    kind: string;
    check: string;
    action: string;
    msg: string;
  } | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section.
    // An unindented line starting with an UPPERCASE keyword followed by colon
    // is a section boundary — stop parsing guardrails.
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (trimmed.match(/^[A-Z][A-Z0-9_]*:/)) {
        break;
      }
    }

    // Skip comments
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Guardrail name definition: guardrail_name:
    const nameMatch = trimmed.match(/^(\w+):$/);
    if (nameMatch && line.match(/^\s{2}\w+:$/)) {
      // Save previous guardrail
      if (currentGuardrail) {
        phases.push({
          name: currentGuardrail.kind || 'output',
          requirements: [
            {
              condition: currentGuardrail.check || currentGuardrail.name,
              onFail:
                currentGuardrail.msg || `${currentGuardrail.action}: ${currentGuardrail.name}`,
            },
          ],
        });
      }
      currentGuardrail = {
        name: nameMatch[1],
        kind: 'output',
        check: '',
        action: 'warn',
        msg: '',
      };
      state.currentLine++;
      continue;
    }

    // Guardrail properties
    if (currentGuardrail && trimmed) {
      const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        switch (key.toLowerCase()) {
          case 'kind':
          case 'type':
            currentGuardrail.kind = value.replace(/^"|"$/g, '');
            break;
          case 'check':
            currentGuardrail.check = value.replace(/^"|"$/g, '');
            break;
          case 'action':
            currentGuardrail.action = value.replace(/^"|"$/g, '');
            break;
          case 'msg':
          case 'message':
            currentGuardrail.msg = value.replace(/^"|"$/g, '');
            break;
        }
      }
    }

    state.currentLine++;
  }

  // Save last guardrail
  if (currentGuardrail) {
    phases.push({
      name: currentGuardrail.kind || 'output',
      requirements: [
        {
          condition: currentGuardrail.check || currentGuardrail.name,
          onFail: currentGuardrail.msg || `${currentGuardrail.action}: ${currentGuardrail.name}`,
        },
      ],
    });
  }

  return phases;
}

/**
 * Parse GUARDRAILS section into GuardrailDefinition array
 * New format that maps directly to IR guardrails
 */
function parseGuardrailDefinitions(state: ParserState): GuardrailDefinition[] {
  state.currentLine++;
  const guardrails: GuardrailDefinition[] = [];
  let current: Partial<GuardrailDefinition> | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Check if we've reached another main section.
    // An unindented line starting with an UPPERCASE keyword followed by colon
    // is a section boundary — stop parsing guardrails.
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (trimmed.match(/^[A-Z][A-Z0-9_]*:/)) {
        break;
      }
    }

    // Skip comments
    if (trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Guardrail name definition: guardrail_name:
    const nameMatch = trimmed.match(/^(\w+):$/);
    if (nameMatch && line.match(/^\s{2}\w+:$/)) {
      // Save previous guardrail
      if (current?.name) {
        guardrails.push({
          name: current.name,
          kind: (current.kind as GuardrailDefinition['kind']) || 'output',
          check: current.check,
          action: (current.action as GuardrailDefinition['action']) || 'warn',
          message: current.message,
          priority: current.priority,
          provider: current.provider,
          category: current.category,
          threshold: current.threshold,
          llm_check: current.llm_check,
          severity_actions: current.severity_actions,
          fix_strategy: current.fix_strategy,
          fix_expression: current.fix_expression,
          max_reasks: current.max_reasks,
          filter_min_length: current.filter_min_length,
          streaming: current.streaming,
          streaming_interval: current.streaming_interval,
        });
      }
      current = {
        name: nameMatch[1],
        kind: 'output',
        action: 'warn',
      };
      state.currentLine++;
      continue;
    }

    // Guardrail properties
    if (current && trimmed) {
      const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        const cleanValue = value.replace(/^"|"$/g, '');
        switch (key.toLowerCase()) {
          case 'kind':
          case 'type':
            current.kind = cleanValue as GuardrailDefinition['kind'];
            break;
          case 'check':
            current.check = cleanValue;
            break;
          case 'action':
            current.action = cleanValue as GuardrailDefinition['action'];
            break;
          case 'msg':
          case 'message':
            current.message = cleanValue;
            break;
          case 'priority':
            current.priority = parseInt(cleanValue, 10);
            break;
          case 'provider':
            current.provider = cleanValue;
            break;
          case 'category':
            current.category = cleanValue;
            break;
          case 'threshold':
            current.threshold = parseFloat(cleanValue);
            break;
          case 'llm_check':
            current.llm_check = cleanValue;
            break;
          case 'fix_strategy':
            current.fix_strategy = cleanValue;
            break;
          case 'fix_expression':
            current.fix_expression = cleanValue;
            break;
          case 'max_reasks':
            current.max_reasks = parseInt(cleanValue, 10);
            break;
          case 'filter_min_length':
            current.filter_min_length = parseInt(cleanValue, 10);
            break;
          case 'streaming':
            current.streaming = cleanValue === 'true';
            break;
          case 'streaming_interval':
            current.streaming_interval = cleanValue;
            break;
        }
      }
    }

    state.currentLine++;
  }

  // Save last guardrail
  if (current?.name) {
    guardrails.push({
      name: current.name,
      kind: (current.kind as GuardrailDefinition['kind']) || 'output',
      check: current.check,
      action: (current.action as GuardrailDefinition['action']) || 'warn',
      message: current.message,
      priority: current.priority,
      provider: current.provider,
      category: current.category,
      threshold: current.threshold,
      llm_check: current.llm_check,
      severity_actions: current.severity_actions,
      fix_strategy: current.fix_strategy,
      fix_expression: current.fix_expression,
      max_reasks: current.max_reasks,
      filter_min_length: current.filter_min_length,
      streaming: current.streaming,
      streaming_interval: current.streaming_interval,
    });
  }

  return guardrails;
}

// =============================================================================
// TESTS SECTION PARSER (skip for now)
// =============================================================================

function parseTests(state: ParserState): void {
  state.currentLine++;
  // Skip tests section - just advance past it
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (trimmed.match(/^[A-Z][A-Z0-9_]*:/)) {
        break;
      }
    }

    state.currentLine++;
  }
}

// =============================================================================
// AGENTS SECTION PARSER (for supervisor files)
// =============================================================================

function parseAgentsSection(state: ParserState): void {
  state.currentLine++;
  // Skip for now - just advance past it
  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (trimmed.match(/^[A-Z_]+:/) && !['FILE:', 'INTENTS:'].some((s) => trimmed.startsWith(s))) {
        break;
      }
    }

    state.currentLine++;
  }
}

// =============================================================================
// ENTITIES SECTION PARSER
// =============================================================================

/**
 * Parse top-level ENTITIES: section.
 *
 * Syntax:
 *   ENTITIES:
 *     entity_name:
 *       TYPE: enum | pattern | date | ...
 *       VALUES: [a, b, c]
 *       SYNONYMS:
 *         a: [alias1, alias2]
 *       PATTERN: "regex"
 *       VALIDATION: "rule"
 *       SENSITIVE: true
 */
// Fixed-size constant set — bounded at definition time, no eviction needed.
const KNOWN_ENTITY_TYPES: ReadonlySet<string> = new Set([
  'string',
  'text',
  'free_text',
  'number',
  'integer',
  'float',
  'currency',
  'boolean',
  'date',
  'datetime',
  'email',
  'phone',
  'enum',
  'pattern',
  'location',
]);

function parseEntitiesSection(state: ParserState): EntityDefinition[] {
  state.currentLine++;

  const entities: EntityDefinition[] = [];
  let currentEntity: Partial<EntityDefinition> | null = null;
  let currentSynonyms: Record<string, string[]> | null = null;
  let inSynonyms = false;

  function flushEntity() {
    if (currentEntity && currentEntity.name) {
      if (currentSynonyms && Object.keys(currentSynonyms).length > 0) {
        currentEntity.synonyms = currentSynonyms;
      }
      entities.push({
        name: currentEntity.name,
        type: (currentEntity.type as EntityDefinition['type']) || 'string',
        values: currentEntity.values,
        synonyms: currentEntity.synonyms,
        pattern: currentEntity.pattern,
        validation: currentEntity.validation,
        sensitive: currentEntity.sensitive,
      });
    }
    currentEntity = null;
    currentSynonyms = null;
    inSynonyms = false;
  }

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // End of section: non-indented line that looks like a new section keyword
    if (indent === 0 && trimmed.match(/^[A-Z_]+:/)) {
      break;
    }

    // Entity name line: "  entity_name:" at indent level 2
    const entityNameMatch = trimmed.match(/^([a-zA-Z_][a-zA-Z0-9_]*):\s*$/);
    if (entityNameMatch && indent === 2) {
      flushEntity();
      currentEntity = { name: entityNameMatch[1] };
      currentSynonyms = null;
      inSynonyms = false;
      state.currentLine++;
      continue;
    }

    // Property lines inside an entity (indent level 4+)
    if (currentEntity && indent >= 4) {
      // Check for synonym entries first (indent level 6+, inside SYNONYMS block)
      if (inSynonyms && indent >= 6) {
        const synMatch = trimmed.match(/^([a-zA-Z0-9_]+):\s*\[(.*)\]/);
        if (synMatch && currentSynonyms) {
          currentSynonyms[synMatch[1]] = synMatch[2]
            .split(',')
            .map((s: string) => s.trim())
            .filter(Boolean);
          state.currentLine++;
          continue;
        }
      }

      const kvMatch = trimmed.match(/^([A-Z_]+):\s*(.*)/);
      if (kvMatch) {
        const key = kvMatch[1];
        const value = kvMatch[2].trim();

        switch (key) {
          case 'TYPE': {
            if (!KNOWN_ENTITY_TYPES.has(value)) {
              state.warnings.push({
                line: state.currentLine + 1,
                message: `Unknown entity type "${value}" — will be treated as "string". Known types: ${[...KNOWN_ENTITY_TYPES].join(', ')}`,
              });
            }
            currentEntity.type = value as EntityDefinition['type'];
            inSynonyms = false;
            break;
          }
          case 'VALUES':
            currentEntity.values = parseInlineArray(value);
            inSynonyms = false;
            break;
          case 'PATTERN':
            currentEntity.pattern = value.replace(/^["']|["']$/g, '');
            inSynonyms = false;
            break;
          case 'VALIDATION':
            currentEntity.validation = value.replace(/^["']|["']$/g, '');
            inSynonyms = false;
            break;
          case 'SENSITIVE':
            currentEntity.sensitive = value === 'true' || value === 'yes';
            inSynonyms = false;
            break;
          case 'SYNONYMS':
            currentSynonyms = {};
            inSynonyms = true;
            break;
          default:
            inSynonyms = false;
            break;
        }
        state.currentLine++;
        continue;
      }
    }

    state.currentLine++;
  }

  flushEntity();
  return entities;
}

// =============================================================================
// INTENTS SECTION PARSER (for supervisor files)
// =============================================================================

function parseIntentsSection(state: ParserState): {
  intents: IntentDefinition[];
  config: IntentSectionConfig;
} {
  state.currentLine++;
  const intents: IntentDefinition[] = [];
  const config: IntentSectionConfig = {};
  const seenNames = new Set<string>();
  const allowedLexicalFallbackModes = new Set<IntentLexicalFallbackMode>([
    'never',
    'when_unavailable',
    'always',
  ]);

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // End of section: non-indented line that looks like a new section keyword
    if (
      trimmed &&
      !line.startsWith(' ') &&
      !line.startsWith('\t') &&
      !trimmed.startsWith('#') &&
      !trimmed.startsWith('//')
    ) {
      if (trimmed.match(/^[A-Z_]+:/)) {
        break;
      }
    }

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Parse intent entry: "  category_name: "description"" or "  category_name"
    // Strip leading dash if present (- category_name)
    const entry = trimmed.startsWith('-') ? trimmed.substring(1).trim() : trimmed;

    const lexicalFallbackMatch = entry.match(/^LEXICAL_FALLBACK\s*:\s*(.+)$/);
    if (lexicalFallbackMatch) {
      const rawValue = lexicalFallbackMatch[1].trim().replace(/^['"]|['"]$/g, '');
      if (!allowedLexicalFallbackModes.has(rawValue as IntentLexicalFallbackMode)) {
        state.warnings.push({
          line: state.currentLine,
          message:
            `Invalid INTENTS lexical fallback "${rawValue}". ` +
            'Expected one of: never, when_unavailable, always.',
        });
        state.currentLine++;
        continue;
      }

      if (config.lexicalFallback) {
        state.warnings.push({
          line: state.currentLine,
          message: 'Duplicate INTENTS LEXICAL_FALLBACK entry — keeping the last configured value',
        });
      }

      config.lexicalFallback = rawValue as IntentLexicalFallbackMode;
      state.currentLine++;
      continue;
    }

    // Match: name: "description" or name: 'description' or just name
    // Uses backreference (\2) to ensure matching open/close quotes
    const match = entry.match(/^([a-zA-Z_][a-zA-Z0-9_]*)\s*(?::\s*(["'])(.+?)\2)?\s*$/);
    if (match) {
      const name = match[1];
      const description = match[3] || undefined;
      if (seenNames.has(name)) {
        state.warnings.push({
          line: state.currentLine,
          message: `Duplicate INTENTS category "${name}" — keeping first occurrence`,
        });
        state.currentLine++;
        continue;
      }
      seenNames.add(name);
      intents.push({ name, description });
    } else if (entry) {
      state.warnings.push({
        line: state.currentLine,
        message: `Invalid INTENTS entry: "${entry}". Expected: category_name or category_name: "description"`,
      });
    }

    state.currentLine++;
  }

  return { intents, config };
}

// =============================================================================
// MULTI_INTENT SECTION PARSER
// =============================================================================

function parseMultiIntentSection(state: ParserState): MultiIntentConfig {
  state.currentLine++; // skip "MULTI_INTENT:" header
  const config: MultiIntentConfig = {};

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#')) {
      state.currentLine++;
      continue;
    }

    // Check if we've reached another top-level section
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.match(/^[A-Z_]+:$/)) {
      break;
    }

    const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
    if (propMatch) {
      const [, key, value] = propMatch;
      switch (key) {
        case 'strategy':
          config.strategy = value.trim();
          break;
        case 'max_intents':
          config.max_intents = parseInt(value.trim(), 10);
          break;
        case 'confidence_threshold':
          config.confidence_threshold = parseFloat(value.trim());
          break;
        case 'queue_max_age_ms':
          config.queue_max_age_ms = parseInt(value.trim(), 10);
          break;
        case 'enabled':
          config.enabled = value.trim() === 'true';
          break;
      }
    }
    state.currentLine++;
  }

  return config;
}

// =============================================================================
// LOOKUP_TABLES SECTION PARSER
// =============================================================================

const LOOKUP_TABLE_NAME_PATTERN = /^[a-z_][a-z0-9_]*$/;
const LOOKUP_FIELD_NAME_PATTERN = /^[a-zA-Z_][a-zA-Z0-9_.]*$/;
const FUZZY_MATCH_VALUES_WARNING_THRESHOLD = 1000;
const LEGACY_SOURCE_ALIASES: Record<string, string> = { mongodb: 'collection', http: 'api' };
const VALID_SOURCES = ['inline', 'collection', 'api'];

function validateLookupTable(name: string, table: LookupTableDefinition, state: ParserState): void {
  // Table name validation: must be lowercase alphanumeric with underscores
  if (!LOOKUP_TABLE_NAME_PATTERN.test(name)) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: `Invalid lookup table name '${name}': must be lowercase alphanumeric with underscores, starting with a letter or underscore`,
    });
  }

  // Field name validation: allowlist pattern
  if (table.field && !LOOKUP_FIELD_NAME_PATTERN.test(table.field)) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: `Invalid field name '${table.field}' in lookup table '${name}': must be alphanumeric with underscores/dots, starting with a letter or underscore`,
    });
  }

  // Unknown source validation
  if (!VALID_SOURCES.includes(table.source)) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: `Unknown source '${table.source}' in lookup table '${name}': must be one of ${VALID_SOURCES.join(', ')}`,
    });
  }

  // Source-required field validation
  if (table.source === 'collection' && !table.tableName) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: `Lookup table '${name}' has source 'collection' but no table_name specified`,
    });
  }
  if (table.source === 'api' && !table.endpoint) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: `Lookup table '${name}' has source 'api' but no endpoint specified`,
    });
  }

  // API endpoint URL validation
  if (table.source === 'api' && table.endpoint) {
    try {
      new URL(table.endpoint);
    } catch {
      state.errors.push({
        line: state.currentLine,
        column: 0,
        message: `Invalid endpoint URL '${table.endpoint}' in lookup table '${name}': must be a valid URL`,
      });
    }
  }

  // timeout_ms validation
  if (table.timeoutMs !== undefined && (isNaN(table.timeoutMs) || table.timeoutMs <= 0)) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: `Invalid timeout_ms in lookup table '${name}': must be a positive number`,
    });
  }

  // tableName pattern validation
  if (table.tableName && !LOOKUP_TABLE_NAME_PATTERN.test(table.tableName)) {
    state.errors.push({
      line: state.currentLine,
      column: 0,
      message: `Invalid table_name '${table.tableName}' in lookup table '${name}': must be lowercase alphanumeric with underscores`,
    });
  }

  // Fuzzy + large values warning
  if (
    table.fuzzyMatch &&
    table.values &&
    table.values.length > FUZZY_MATCH_VALUES_WARNING_THRESHOLD
  ) {
    state.warnings.push({
      line: state.currentLine,
      message: `Lookup table '${name}' has ${table.values.length} values with fuzzy matching enabled. Consider using a collection source for better performance.`,
    });
  }
}

function parseLookupTables(state: ParserState): Record<string, LookupTableDefinition> {
  state.currentLine++; // skip "LOOKUP_TABLES:" header
  const tables: Record<string, LookupTableDefinition> = {};
  let currentName: string | null = null;
  let current: Partial<LookupTableDefinition> | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    // Check if we've reached another top-level section
    const indent = line.length - line.trimStart().length;
    if (indent === 0 && trimmed.match(/^[A-Z_]+:$/)) {
      break;
    }

    // Table name definition: table_name: (at 2-space indent level)
    // Exclude known block property keywords from being treated as table names
    const LOOKUP_BLOCK_PROPERTIES = ['headers'];
    const nameMatch = trimmed.match(/^(\w+):$/);
    if (
      nameMatch &&
      indent >= 2 &&
      indent <= 4 &&
      !LOOKUP_BLOCK_PROPERTIES.includes(nameMatch[1].toLowerCase())
    ) {
      // Save previous table
      if (currentName && current) {
        tables[currentName] = {
          source: (current.source as 'inline' | 'collection' | 'api') || 'inline',
          values: current.values,
          tableName: current.tableName,
          endpoint: current.endpoint,
          field: current.field,
          timeoutMs: current.timeoutMs,
          headers: current.headers,
          caseSensitive: current.caseSensitive ?? false,
          fuzzyMatch: current.fuzzyMatch ?? false,
          fuzzyThreshold: current.fuzzyThreshold,
        };
        validateLookupTable(currentName, tables[currentName], state);
      }
      currentName = nameMatch[1];
      current = {};
      state.currentLine++;
      continue;
    }

    // Table properties (at deeper indent)
    if (current && trimmed) {
      // Check for block-style properties first (key: with no value)
      const blockMatch = trimmed.match(/^(\w+):$/);
      if (blockMatch && blockMatch[1].toLowerCase() === 'headers') {
        const headers: Record<string, string> = {};
        const headerBaseIndent = line.length - line.trimStart().length;
        state.currentLine++;
        while (state.currentLine < state.lines.length) {
          const hLine = state.lines[state.currentLine];
          const hTrimmed = hLine.trim();
          if (!hTrimmed || hTrimmed.startsWith('#')) {
            state.currentLine++;
            continue;
          }
          const hIndent = hLine.length - hLine.trimStart().length;
          if (hIndent <= headerBaseIndent) break;
          const hMatch = hTrimmed.match(/^([\w-]+):\s*(.+)$/);
          if (hMatch) {
            headers[hMatch[1]] = hMatch[2].replace(/^"|"$/g, '');
          } else {
            break;
          }
          state.currentLine++;
        }
        if (Object.keys(headers).length > 0) {
          current.headers = headers;
        }
        continue;
      }
      const propMatch = trimmed.match(/^(\w+):\s*(.+)$/);
      if (propMatch) {
        const [, key, value] = propMatch;
        switch (key.toLowerCase()) {
          case 'source': {
            const raw = value.trim();
            current.source = (LEGACY_SOURCE_ALIASES[raw] ?? raw) as 'inline' | 'collection' | 'api';
            break;
          }
          case 'values':
            current.values = value
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map((s: string) => s.trim())
              .filter(Boolean);
            break;
          case 'collection':
          case 'table_name':
            current.tableName = value.trim();
            break;
          case 'endpoint':
            current.endpoint = value.trim();
            break;
          case 'field':
            current.field = value.trim();
            break;
          case 'timeout_ms':
            current.timeoutMs = parseInt(value.trim(), 10);
            break;
          case 'case_sensitive':
            current.caseSensitive = value.trim() === 'true';
            break;
          case 'fuzzy_match':
            current.fuzzyMatch = value.trim() === 'true';
            break;
          case 'fuzzy_threshold':
            current.fuzzyThreshold = parseFloat(value.trim());
            break;
        }
      }
    }
    state.currentLine++;
  }

  // Save last table
  if (currentName && current) {
    tables[currentName] = {
      source: (current.source as 'inline' | 'collection' | 'api') || 'inline',
      values: current.values,
      tableName: current.tableName,
      endpoint: current.endpoint,
      field: current.field,
      timeoutMs: current.timeoutMs,
      headers: current.headers,
      caseSensitive: current.caseSensitive ?? false,
      fuzzyMatch: current.fuzzyMatch ?? false,
      fuzzyThreshold: current.fuzzyThreshold,
    };
    validateLookupTable(currentName, tables[currentName], state);
  }

  return tables;
}

// =============================================================================
// NLU SECTION PARSER
// =============================================================================

function parseNLUSection(state: ParserState): NLUDefinition {
  state.currentLine++;

  const nlu: NLUDefinition = {
    intents: [],
    categories: [],
    entities: [],
    glossary: [],
  };

  // Track which sub-section we're in
  let currentSubSection: string | null = null;
  let currentIntent: Partial<NLUIntentDefinition> | null = null;
  let currentCategory: Partial<NLUCategoryDefinition> | null = null;
  let currentEntity: Partial<NLUEntityDefinition> | null = null;
  let currentSynonyms: Record<string, string[]> | null = null;

  while (state.currentLine < state.lines.length) {
    const line = state.lines[state.currentLine];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      state.currentLine++;
      continue;
    }

    const indent = line.length - line.trimStart().length;

    // Check for top-level section break (unindented, uppercase section header)
    if (indent === 0 && trimmed.match(/^[A-Z_]+:/) && !trimmed.startsWith('NLU:')) {
      break;
    }

    // Sub-section headers (indent level 2): models:, languages:, intents:, etc.
    if (indent === 2 || indent === 4) {
      // Flush current items before switching
      flushNLUItem(
        nlu,
        currentSubSection,
        currentIntent,
        currentCategory,
        currentEntity,
        currentSynonyms,
      );
      currentIntent = null;
      currentCategory = null;
      currentEntity = null;
      currentSynonyms = null;

      // Check for sub-section headers
      if (trimmed === 'models:') {
        currentSubSection = 'models';
        nlu.models = nlu.models || {};
        state.currentLine++;
        continue;
      }
      if (trimmed === 'intents:') {
        currentSubSection = 'intents';
        state.currentLine++;
        continue;
      }
      if (trimmed === 'categories:') {
        currentSubSection = 'categories';
        state.currentLine++;
        continue;
      }
      if (trimmed === 'entities:') {
        currentSubSection = 'entities';
        state.currentLine++;
        continue;
      }
      if (trimmed === 'glossary:') {
        currentSubSection = 'glossary';
        state.currentLine++;
        continue;
      }
      if (trimmed === 'evaluation:') {
        currentSubSection = 'evaluation';
        nlu.evaluation = nlu.evaluation || {};
        state.currentLine++;
        continue;
      }
      if (trimmed === 'embeddings:') {
        currentSubSection = 'embeddings';
        nlu.embeddings = nlu.embeddings || { enabled: false };
        state.currentLine++;
        continue;
      }
      if (trimmed === 'language_models:') {
        currentSubSection = 'language_models';
        nlu.languageModels = nlu.languageModels || {};
        state.currentLine++;
        continue;
      }

      // Inline key:value sub-section properties
      const kvMatch = trimmed.match(/^(\w+):\s+(.+)$/);
      if (kvMatch) {
        const [, key, value] = kvMatch;
        const cleanValue = value.replace(/^"|"$/g, '');

        if (currentSubSection === null || indent === 2) {
          // Top-level NLU properties
          switch (key) {
            case 'languages':
              nlu.languages = parseInlineArray(cleanValue);
              break;
            case 'default_language':
              nlu.defaultLanguage = cleanValue;
              break;
            case 'allow_code_switching':
              nlu.allowCodeSwitching = cleanValue === 'true';
              break;
            case 'config_file':
              nlu.configFile = cleanValue;
              break;
          }
        } else {
          parseNLUSubSectionKV(
            nlu,
            currentSubSection,
            key,
            cleanValue,
            currentIntent,
            currentCategory,
            currentEntity,
            currentSynonyms,
          );
        }

        state.currentLine++;
        continue;
      }
    }

    // List items (- NAME:, - "pattern")
    if (trimmed.startsWith('- ')) {
      const itemContent = trimmed.substring(2).trim();

      // Flush previous item within the same sub-section
      if (currentSubSection === 'intents' && currentIntent) {
        nlu.intents.push(currentIntent as NLUIntentDefinition);
        currentIntent = null;
      }
      if (currentSubSection === 'categories' && currentCategory) {
        nlu.categories.push(currentCategory as NLUCategoryDefinition);
        currentCategory = null;
      }
      if (currentSubSection === 'entities' && currentEntity) {
        if (currentSynonyms) currentEntity.synonyms = currentSynonyms;
        nlu.entities.push(currentEntity as NLUEntityDefinition);
        currentEntity = null;
        currentSynonyms = null;
      }

      // Parse item based on sub-section
      if (currentSubSection === 'intents') {
        const nameMatch = itemContent.match(/^NAME:\s*(\w+)$/);
        if (nameMatch) {
          currentIntent = { name: nameMatch[1], patterns: [] };
        } else {
          // Inline example string
          if (currentIntent?.examples) {
            currentIntent.examples.push(itemContent.replace(/^"|"$/g, ''));
          }
        }
      } else if (currentSubSection === 'categories') {
        const nameMatch = itemContent.match(/^NAME:\s*(\w+)$/);
        if (nameMatch) {
          currentCategory = { name: nameMatch[1], patterns: [] };
        }
      } else if (currentSubSection === 'entities') {
        const nameMatch = itemContent.match(/^NAME:\s*(\w+)$/);
        if (nameMatch) {
          currentEntity = { name: nameMatch[1], type: 'enum' };
          currentSynonyms = null;
        }
      } else if (currentSubSection === 'glossary') {
        nlu.glossary.push(itemContent.replace(/^"|"$/g, ''));
      } else if (currentSubSection === 'intents_examples') {
        // Examples inside an intent definition
        if (currentIntent) {
          if (!currentIntent.examples) currentIntent.examples = [];
          currentIntent.examples.push(itemContent.replace(/^"|"$/g, ''));
        }
      }

      state.currentLine++;
      continue;
    }

    // Key:value properties within items (deeper indentation)
    const propMatch = trimmed.match(/^(\w+):\s*(.*)$/);
    if (propMatch) {
      const [, key, rawValue] = propMatch;
      const value = rawValue.replace(/^"|"$/g, '').trim();

      if (currentSubSection === 'models') {
        if (!nlu.models) nlu.models = {};
        if (key === 'fast') nlu.models.fast = value;
        else if (key === 'balanced') nlu.models.balanced = value;
      } else if (currentSubSection === 'evaluation') {
        if (!nlu.evaluation) nlu.evaluation = {};
        if (key === 'log_predictions') nlu.evaluation.logPredictions = value === 'true';
        else if (key === 'ab_test') nlu.evaluation.abTest = value === 'true';
        else if (key === 'confidence_threshold')
          nlu.evaluation.confidenceThreshold = parseFloat(value);
      } else if (currentSubSection === 'embeddings') {
        if (!nlu.embeddings) nlu.embeddings = { enabled: false };
        if (key === 'enabled') nlu.embeddings.enabled = value === 'true';
        else if (key === 'provider') nlu.embeddings.provider = value;
        else if (key === 'model') nlu.embeddings.model = value;
        else if (key === 'base_url') nlu.embeddings.baseUrl = value;
        else if (key === 'threshold') nlu.embeddings.threshold = parseFloat(value);
        else if (key === 'cache_ttl') nlu.embeddings.cacheTtl = parseInt(value, 10);
      } else if (currentSubSection === 'language_models') {
        if (!nlu.languageModels) nlu.languageModels = {};
        nlu.languageModels[key] = value;
      } else if (currentSubSection === 'intents' && currentIntent) {
        switch (key) {
          case 'NAME':
            currentIntent.name = value;
            break;
          case 'PATTERNS':
            currentIntent.patterns = parseInlineArray(value);
            break;
          case 'EXAMPLES':
            if (value) {
              currentIntent.examples = parseInlineArray(value);
            } else {
              // Multi-line examples follow
              currentIntent.examples = [];
              currentSubSection = 'intents_examples';
            }
            break;
          case 'EXAMPLES_FILE':
            currentIntent.examplesFile = value;
            break;
          case 'ENTITIES':
            currentIntent.entities = parseInlineArray(value);
            break;
        }
      } else if (currentSubSection === 'categories' && currentCategory) {
        switch (key) {
          case 'NAME':
            currentCategory.name = value;
            break;
          case 'PATTERNS':
            currentCategory.patterns = parseInlineArray(value);
            break;
        }
      } else if (currentSubSection === 'entities' && currentEntity) {
        switch (key) {
          case 'NAME':
            currentEntity.name = value;
            break;
          case 'TYPE':
            currentEntity.type = value as NLUEntityDefinition['type'];
            break;
          case 'VALUES':
            currentEntity.values = parseInlineArray(value);
            break;
          case 'PATTERN':
            currentEntity.pattern = value;
            break;
          case 'VALIDATION':
            currentEntity.validation = value;
            break;
          case 'SENSITIVE':
            currentEntity.sensitive = value === 'true' || value === 'yes';
            break;
          case 'SYNONYMS':
            if (!value) {
              // Multi-line synonyms follow — handled by deeper indentation
              currentSynonyms = {};
            }
            break;
          default:
            // Synonym entries: budget: ["cheap", "affordable"]
            if (currentSynonyms !== null) {
              currentSynonyms[key] = parseInlineArray(value);
            }
            break;
        }
      } else if (currentSubSection === 'intents_examples') {
        // We left examples mode, back to intent properties
        currentSubSection = 'intents';
        if (currentIntent) {
          switch (key) {
            case 'PATTERNS':
              currentIntent.patterns = parseInlineArray(value);
              break;
            case 'ENTITIES':
              currentIntent.entities = parseInlineArray(value);
              break;
          }
        }
      }

      state.currentLine++;
      continue;
    }

    state.currentLine++;
  }

  // Flush remaining items
  flushNLUItem(
    nlu,
    currentSubSection,
    currentIntent,
    currentCategory,
    currentEntity,
    currentSynonyms,
  );

  return nlu;
}

/**
 * Parse an inline array like ["a", "b", "c"] or [a, b, c]
 */
function parseInlineArray(value: string): string[] {
  const cleaned = value.trim();

  // Handle ["a", "b", "c"] format
  if (cleaned.startsWith('[') && cleaned.endsWith(']')) {
    const inner = cleaned.slice(1, -1);
    return inner
      .split(',')
      .map((s) => s.trim().replace(/^"|"$/g, ''))
      .filter((s) => s.length > 0);
  }

  // Handle comma-separated without brackets
  return cleaned
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter((s) => s.length > 0);
}

/**
 * Parse NLU sub-section key-value pairs
 */
function parseNLUSubSectionKV(
  nlu: NLUDefinition,
  subSection: string,
  key: string,
  value: string,
  currentIntent: Partial<NLUIntentDefinition> | null,
  currentCategory: Partial<NLUCategoryDefinition> | null,
  currentEntity: Partial<NLUEntityDefinition> | null,
  currentSynonyms: Record<string, string[]> | null,
): void {
  // Delegate to sub-section parsers is handled in main loop
}

/**
 * Flush the current NLU item being parsed
 */
function flushNLUItem(
  nlu: NLUDefinition,
  subSection: string | null,
  intent: Partial<NLUIntentDefinition> | null,
  category: Partial<NLUCategoryDefinition> | null,
  entity: Partial<NLUEntityDefinition> | null,
  synonyms: Record<string, string[]> | null,
): void {
  if (subSection === 'intents' || subSection === 'intents_examples') {
    if (intent?.name) {
      nlu.intents.push({
        name: intent.name,
        patterns: intent.patterns || [],
        ...intent,
      } as NLUIntentDefinition);
    }
  }
  if (subSection === 'categories') {
    if (category?.name) {
      nlu.categories.push({
        name: category.name,
        patterns: category.patterns || [],
      } as NLUCategoryDefinition);
    }
  }
  if (subSection === 'entities') {
    if (entity?.name) {
      if (synonyms) entity.synonyms = synonyms;
      nlu.entities.push({
        name: entity.name,
        type: entity.type || 'enum',
        ...entity,
      } as NLUEntityDefinition);
    }
  }
}

// =============================================================================
// BEHAVIOR PROFILE PARSER
// =============================================================================

/**
 * Parse a BEHAVIOR_PROFILE document body starting from the first section line
 * (e.g., PRIORITY:, WHEN:, INSTRUCTIONS:, etc.).
 *
 * This is a standalone function that operates on raw lines rather than
 * ParserState because the caller advances state.currentLine to EOF after
 * calling this.
 */
export function parseBehaviorProfile(
  lines: string[],
  startLine: number,
  errors?: Array<{ line: number; column: number; message: string }>,
  options?: {
    allowedTopLevelSections?: Set<string>;
  },
): BehaviorProfileAST {
  const profile: BehaviorProfileAST = {
    priority: 0,
    when: 'true',
  };
  let hasPriority = false;
  let hasWhen = false;
  const consumedAllowedTopLevelSections = new Set<string>();

  let i = startLine;

  /** Helper: check if a line is a top-level section header (non-indented, UPPER_CASE:) */
  function isTopLevelSection(line: string): boolean {
    const trimmed = line.trim();
    if (!trimmed) return false;
    // Must not be indented
    if (line !== line.trimStart()) return false;
    return /^[A-Z_]+:/.test(trimmed);
  }

  function getTopLevelSectionName(line: string): string | undefined {
    if (!isTopLevelSection(line)) {
      return undefined;
    }
    return line.trim().replace(/:.*$/, '').toUpperCase();
  }

  /** Helper: collect indented multi-line text until the next top-level section or EOF */
  function collectMultiLineText(): string {
    const collected: string[] = [];
    while (i < lines.length) {
      const ln = lines[i];
      const trimmed = ln.trim();
      if (!trimmed) {
        collected.push('');
        i++;
        continue;
      }
      if (isTopLevelSection(ln)) break;
      collected.push(trimmed);
      i++;
    }
    return collected.join('\n').trim();
  }

  /** Helper: collect indented list items (lines starting with "- ") */
  function collectListItems(): string[] {
    const items: string[] = [];
    while (i < lines.length) {
      const ln = lines[i];
      const trimmed = ln.trim();
      if (!trimmed) {
        i++;
        continue;
      }
      if (isTopLevelSection(ln)) break;
      if (trimmed.startsWith('- ')) {
        items.push(trimmed.substring(2).trim().replace(/^"|"$/g, ''));
      } else {
        // Continuation of previous item or bare text — treat as item
        items.push(trimmed.replace(/^"|"$/g, ''));
      }
      i++;
    }
    return items;
  }

  /** Helper: parse indented key: value pairs into a record */
  function collectKeyValueBlock(): Record<string, string> {
    const result: Record<string, string> = {};
    while (i < lines.length) {
      const ln = lines[i];
      const trimmed = ln.trim();
      if (!trimmed) {
        i++;
        continue;
      }
      if (isTopLevelSection(ln)) break;
      const kvMatch = trimmed.match(/^(\w[\w_]*):\s*(.+)$/);
      if (kvMatch) {
        result[kvMatch[1].toLowerCase()] = kvMatch[2].replace(/^"|"$/g, '');
      }
      i++;
    }
    return result;
  }

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Skip empty lines and comments
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('//')) {
      i++;
      continue;
    }

    const topLevelSectionName = getTopLevelSectionName(line);
    if (
      topLevelSectionName &&
      options?.allowedTopLevelSections &&
      !options.allowedTopLevelSections.has(topLevelSectionName)
    ) {
      break;
    }
    if (
      topLevelSectionName &&
      options?.allowedTopLevelSections &&
      consumedAllowedTopLevelSections.has(topLevelSectionName)
    ) {
      break;
    }

    // ── PRIORITY ──
    if (trimmed.startsWith('PRIORITY:')) {
      consumedAllowedTopLevelSections.add('PRIORITY');
      const val = trimmed.substring(9).trim();
      const parsed = Number(val);
      if (isNaN(parsed) || !Number.isInteger(parsed) || parsed < 0) {
        if (errors) {
          errors.push({
            line: i,
            column: 0,
            message: `PRIORITY must be a non-negative integer, got "${val}"`,
          });
        }
        profile.priority = 0;
      } else {
        profile.priority = parsed;
      }
      hasPriority = true;
      i++;
      continue;
    }

    // ── WHEN ──
    if (trimmed.startsWith('WHEN:')) {
      consumedAllowedTopLevelSections.add('WHEN');
      let val = trimmed.substring(5).trim();
      // Only strip wrapping quotes if the entire value is quoted
      if (val.startsWith('"') && val.endsWith('"') && val.length > 1) val = val.slice(1, -1);
      if (val) {
        profile.when = val;
        hasWhen = true;
        i++;
      } else {
        // Multi-line WHEN (pipe-style)
        i++;
        profile.when = collectMultiLineText();
        if (profile.when && profile.when !== 'true') hasWhen = true;
      }
      continue;
    }

    // ── INSTRUCTIONS ──
    if (trimmed === 'INSTRUCTIONS:' || trimmed.startsWith('INSTRUCTIONS:')) {
      consumedAllowedTopLevelSections.add('INSTRUCTIONS');
      const inline = trimmed.substring(13).trim();
      if (inline && inline !== '|') {
        profile.instructions = inline.replace(/^"|"$/g, '');
        i++;
      } else {
        i++;
        profile.instructions = collectMultiLineText();
      }
      continue;
    }

    // ── CONVERSATION ──
    if (trimmed === 'CONVERSATION:') {
      consumedAllowedTopLevelSections.add('CONVERSATION');
      const conversationLine = i;
      const sectionIndent = getIndent(line);
      const blockLines: string[] = [];
      i++;
      while (i < lines.length) {
        const candidate = lines[i];
        if (candidate.trim() && getIndent(candidate) <= sectionIndent) {
          break;
        }
        blockLines.push(candidate);
        i++;
      }

      const dedented = dedentBlockLines(blockLines);
      if (!dedented) {
        if (errors) {
          errors.push({
            line: conversationLine + 1,
            column: 0,
            message:
              'CONVERSATION: requires an indented block with speaking, listening, or interaction fields.',
          });
        }
        continue;
      }

      try {
        const rawConversation = yaml.load(dedented);
        const result = parseConversationBehaviorData(rawConversation);
        if (result.conversation) {
          profile.conversation = result.conversation;
        }
        if (errors) {
          for (const message of result.errors) {
            errors.push({
              line: conversationLine + 1,
              column: 0,
              message,
            });
          }
        }
      } catch (error) {
        if (errors) {
          const yamlError = error as yaml.YAMLException;
          errors.push({
            line: conversationLine + 1,
            column: 0,
            message: yamlError.message || 'Invalid CONVERSATION block.',
          });
        }
      }
      continue;
    }

    // ── CONSTRAINTS ──
    if (trimmed === 'CONSTRAINTS:') {
      i++;
      profile.constraints = collectListItems();
      continue;
    }

    // ── RESPONSE ──
    if (trimmed === 'RESPONSE:') {
      i++;
      const response: BehaviorProfileResponseAST = {};
      while (i < lines.length) {
        const rLn = lines[i];
        const rTrimmed = rLn.trim();
        if (!rTrimmed) {
          i++;
          continue;
        }
        if (isTopLevelSection(rLn)) break;
        const kvMatch = rTrimmed.match(/^(\w[\w_]*):\s*(.+)$/);
        if (kvMatch) {
          const key = kvMatch[1].toLowerCase();
          const val = kvMatch[2].replace(/^"|"$/g, '');
          switch (key) {
            case 'max_buttons':
              response.max_buttons = parseInt(val, 10);
              break;
            case 'fallback_format':
              response.fallback_format = val;
              break;
            case 'media_types':
              // Comma-separated or bracket list
              response.media_types = val
                .replace(/^\[|\]$/g, '')
                .split(',')
                .map((s) => s.trim().replace(/^"|"$/g, ''));
              break;
            case 'max_response_length':
              response.max_response_length = parseInt(val, 10);
              break;
          }
        }
        i++;
      }
      profile.response = response;
      continue;
    }

    // ── VOICE ──
    if (trimmed === 'VOICE:') {
      i++;
      const voice: { ssml?: string; instructions?: string; plain_text?: string } = {};
      while (i < lines.length) {
        const vLn = lines[i];
        const vTrimmed = vLn.trim();
        if (!vTrimmed) {
          i++;
          continue;
        }
        if (isTopLevelSection(vLn)) break;
        const kvMatch = vTrimmed.match(/^(\w[\w_]*):\s*(.+)$/);
        if (kvMatch) {
          const key = kvMatch[1].toLowerCase();
          const val = kvMatch[2].replace(/^"|"$/g, '');
          switch (key) {
            case 'ssml':
              voice.ssml = val;
              break;
            case 'instructions':
              voice.instructions = val;
              break;
            case 'plain_text':
              voice.plain_text = val;
              break;
          }
        } else if (vTrimmed.match(/^(\w[\w_]*):\s*$/)) {
          // Multi-line value (e.g., ssml: followed by indented content)
          const subKey = vTrimmed.replace(':', '').trim().toLowerCase();
          i++;
          const subVal = collectMultiLineText();
          switch (subKey) {
            case 'ssml':
              voice.ssml = subVal;
              break;
            case 'instructions':
              voice.instructions = subVal;
              break;
            case 'plain_text':
              voice.plain_text = subVal;
              break;
          }
          continue;
        }
        i++;
      }
      profile.voice = voice;
      continue;
    }

    // ── TOOLS ──
    if (trimmed === 'TOOLS:') {
      i++;
      const tools: { hide?: string[]; add?: AgentTool[] } = {};
      while (i < lines.length) {
        const tLn = lines[i];
        const tTrimmed = tLn.trim();
        if (!tTrimmed) {
          i++;
          continue;
        }
        if (isTopLevelSection(tLn)) break;
        // HIDE: [inline_list] or HIDE: (standalone, followed by list items)
        if (tTrimmed.startsWith('HIDE:')) {
          const hideInline = tTrimmed.substring(5).trim();
          if (hideInline && hideInline.startsWith('[')) {
            // Inline bracket list: HIDE: [a, b, c]
            tools.hide = hideInline
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map((s) => s.trim().replace(/^"|"$/g, ''));
            i++;
          } else if (!hideInline) {
            i++;
            tools.hide = collectListItems();
          } else {
            // Single value
            tools.hide = [hideInline.replace(/^"|"$/g, '')];
            i++;
          }
          continue;
        }
        if (tTrimmed === 'ADD:') {
          i++;
          // Collect tool definitions — simplified parsing for behavior profiles
          tools.add = [];
          while (i < lines.length) {
            const aLn = lines[i];
            const aTrimmed = aLn.trim();
            if (!aTrimmed) {
              i++;
              continue;
            }
            if (isTopLevelSection(aLn)) break;
            if (aTrimmed.startsWith('HIDE:')) break; // Another TOOLS sub-section
            // Match tool name: either "- tool_name:" or "tool_name:"
            const toolNameMatch = aTrimmed.match(/^-?\s*(\w+):\s*$/);
            if (toolNameMatch) {
              const tool: AgentTool = {
                name: toolNameMatch[1],
                parameters: [],
                returns: { type: 'object' },
              };
              i++;
              const toolIndent = aLn.search(/\S/);
              // Parse tool properties
              while (i < lines.length) {
                const pLn = lines[i];
                const pTrimmed = pLn.trim();
                if (!pTrimmed) {
                  i++;
                  continue;
                }
                const pIndent = pLn.search(/\S/);
                // Stop at next tool def (same or lower indent), section, or HIDE
                if (pIndent <= toolIndent && !pTrimmed.startsWith('-')) break;
                if (isTopLevelSection(pLn)) break;
                // Check for next tool definition at same indent level
                if (pIndent === toolIndent && pTrimmed.match(/^-?\s*\w+:\s*$/)) break;
                const propMatch = pTrimmed.match(/^(\w[\w_]*):\s*(.+)$/);
                if (propMatch) {
                  const pKey = propMatch[1].toLowerCase();
                  const pVal = propMatch[2].replace(/^"|"$/g, '');
                  if (pKey === 'description') tool.description = pVal;
                  else if (pKey === 'returns') tool.returns = { type: pVal };
                } else if (pTrimmed === 'PARAMETERS:') {
                  i++;
                  tool.parameters = [];
                  while (i < lines.length) {
                    const paramLn = lines[i];
                    const paramTrimmed = paramLn.trim();
                    if (!paramTrimmed) {
                      i++;
                      continue;
                    }
                    const paramIndent = paramLn.search(/\S/);
                    if (paramIndent <= pIndent) break;
                    // Parse "- name: type"
                    const paramMatch = paramTrimmed.match(/^-\s*(\w[\w_]*):\s*(\w+)$/);
                    if (paramMatch) {
                      tool.parameters!.push({
                        name: paramMatch[1],
                        type: paramMatch[2],
                        required: true,
                      });
                    }
                    i++;
                  }
                  continue;
                }
                i++;
              }
              tools.add.push(tool);
              continue;
            }
            i++;
          }
          continue;
        }
        i++;
      }
      profile.tools = tools;
      continue;
    }

    // ── GATHER ──
    if (trimmed === 'GATHER:') {
      i++;
      const gather: BehaviorProfileGatherAST = {};
      while (i < lines.length) {
        const gLn = lines[i];
        const gTrimmed = gLn.trim();
        if (!gTrimmed) {
          i++;
          continue;
        }
        if (isTopLevelSection(gLn)) break;
        const kvMatch = gTrimmed.match(/^(\w[\w_]*):\s*(.+)$/);
        if (kvMatch) {
          const key = kvMatch[1].toLowerCase();
          const val = kvMatch[2].replace(/^"|"$/g, '');
          switch (key) {
            case 'validation_style':
              gather.validation_style = val;
              break;
            case 'confirmation':
              gather.confirmation = val;
              break;
          }
        } else if (gTrimmed === 'FIELD_OVERRIDES:') {
          i++;
          gather.field_overrides = {};
          // Parse field override entries
          while (i < lines.length) {
            const foLn = lines[i];
            const foTrimmed = foLn.trim();
            if (!foTrimmed) {
              i++;
              continue;
            }
            if (isTopLevelSection(foLn)) break;
            // Check for back-to-parent (non-indented gather props)
            if (!foLn.startsWith(' ') && !foLn.startsWith('\t')) break;
            const fieldMatch = foTrimmed.match(/^-?\s*(\w[\w_]*):\s*$/);
            if (fieldMatch) {
              const fieldName = fieldMatch[1];
              const override: Record<string, unknown> = {};
              i++;
              const fieldIndent = foLn.search(/\S/);
              while (i < lines.length) {
                const fLn = lines[i];
                const fTrimmed = fLn.trim();
                if (!fTrimmed) {
                  i++;
                  continue;
                }
                const fIndent = fLn.search(/\S/);
                if (fIndent <= fieldIndent) break;
                const fkvMatch = fTrimmed.match(/^(\w[\w_]*):\s*(.+)$/);
                if (fkvMatch) {
                  const fKey = fkvMatch[1].toLowerCase();
                  const fVal = fkvMatch[2].replace(/^"|"$/g, '');
                  switch (fKey) {
                    case 'prompt':
                      override.prompt = fVal;
                      break;
                    case 'skip':
                      override.skip = fVal === 'true';
                      break;
                    case 'required':
                      override.required = fVal === 'true';
                      break;
                    case 'validation':
                      override.validation = fVal;
                      break;
                    case 'extraction_hints':
                      override.extraction_hints = fVal
                        .replace(/^\[|\]$/g, '')
                        .split(',')
                        .map((s) => s.trim().replace(/^"|"$/g, ''));
                      break;
                  }
                }
                i++;
              }
              gather.field_overrides[fieldName] = override as {
                prompt?: string;
                extraction_hints?: string[];
                skip?: boolean;
                required?: boolean;
                validation?: string;
              };
              continue;
            }
            i++;
          }
          continue;
        }
        i++;
      }
      profile.gather = gather;
      continue;
    }

    // ── FLOW ──
    if (trimmed === 'FLOW:') {
      i++;
      const flow: BehaviorProfileFlowAST = {};
      while (i < lines.length) {
        const fLn = lines[i];
        const fTrimmed = fLn.trim();
        if (!fTrimmed) {
          i++;
          continue;
        }
        if (isTopLevelSection(fLn)) break;

        // SKIP: [inline_list] or SKIP: (standalone, followed by list items)
        if (fTrimmed.startsWith('SKIP:')) {
          const skipInline = fTrimmed.substring(5).trim();
          if (skipInline && skipInline.startsWith('[')) {
            // Inline bracket list: SKIP: [a, b, c]
            flow.skip = skipInline
              .replace(/^\[|\]$/g, '')
              .split(',')
              .map((s) => s.trim().replace(/^"|"$/g, ''));
            i++;
          } else if (!skipInline) {
            i++;
            flow.skip = collectListItems();
          } else {
            flow.skip = [skipInline.replace(/^"|"$/g, '')];
            i++;
          }
          continue;
        }

        if (fTrimmed.startsWith('REPLACE:')) {
          flow.replace = fTrimmed.substring(8).trim().replace(/^"|"$/g, '');
          i++;
          continue;
        }

        if (fTrimmed === 'OVERRIDES:' || fTrimmed === 'OVERRIDE:') {
          i++;
          flow.overrides = {};
          while (i < lines.length) {
            const oLn = lines[i];
            const oTrimmed = oLn.trim();
            if (!oTrimmed) {
              i++;
              continue;
            }
            if (isTopLevelSection(oLn)) break;
            if (!oLn.startsWith(' ') && !oLn.startsWith('\t')) break;
            const stepMatch = oTrimmed.match(/^-?\s*(\w[\w_]*):\s*$/);
            if (stepMatch) {
              const stepName = stepMatch[1];
              const override: Record<string, unknown> = {};
              i++;
              const stepIndent = oLn.search(/\S/);
              while (i < lines.length) {
                const sLn = lines[i];
                const sTrimmed = sLn.trim();
                if (!sTrimmed) {
                  i++;
                  continue;
                }
                const sIndent = sLn.search(/\S/);
                if (sIndent <= stepIndent) break;
                const skvMatch = sTrimmed.match(/^(\w[\w_]*):\s*(.+)$/);
                if (skvMatch) {
                  const sKey = skvMatch[1].toLowerCase();
                  const sVal = skvMatch[2].replace(/^"|"$/g, '');
                  switch (sKey) {
                    case 'respond':
                      override.respond = sVal;
                      break;
                    case 'transition':
                      override.transition = sVal;
                      break;
                  }
                } else if (sTrimmed === 'VOICE:') {
                  i++;
                  const voice: Record<string, string> = {};
                  const voiceIndent = sLn.search(/\S/);
                  while (i < lines.length) {
                    const vLn = lines[i];
                    const vTrimmed = vLn.trim();
                    if (!vTrimmed) {
                      i++;
                      continue;
                    }
                    if (vLn.search(/\S/) <= voiceIndent) break;
                    const vkvMatch = vTrimmed.match(/^(\w[\w_]*):\s*(.+)$/);
                    if (vkvMatch)
                      voice[vkvMatch[1].toLowerCase()] = vkvMatch[2].replace(/^"|"$/g, '');
                    i++;
                  }
                  override.voice = voice;
                  continue;
                } else if (sTrimmed === 'RICH_CONTENT:') {
                  i++;
                  const richKv = collectKeyValueBlock();
                  override.rich_content = { type: richKv.type || 'unknown', payload: richKv };
                  continue;
                }
                i++;
              }
              flow.overrides[stepName] = override as {
                respond?: string;
                voice?: { ssml?: string; instructions?: string; plain_text?: string };
                rich_content?: { type: string; payload: Record<string, unknown> };
                transition?: string;
              };
              continue;
            }
            i++;
          }
          continue;
        }

        if (fTrimmed === 'INSERTIONS:') {
          i++;
          flow.insertions = [];
          while (i < lines.length) {
            const iLn = lines[i];
            const iTrimmed = iLn.trim();
            if (!iTrimmed) {
              i++;
              continue;
            }
            if (isTopLevelSection(iLn)) break;
            if (!iLn.startsWith(' ') && !iLn.startsWith('\t')) break;
            const posMatch = iTrimmed.match(/^-\s*(BEFORE|AFTER):\s*(\w[\w_]*)$/i);
            if (posMatch) {
              const position = posMatch[1].toLowerCase() as 'before' | 'after';
              const targetStep = posMatch[2];
              i++;
              // Collect nested step definition as Record<string, unknown>
              const step: Record<string, unknown> = {};
              const insIndent = iLn.search(/\S/);
              while (i < lines.length) {
                const isLn = lines[i];
                const isTrimmed = isLn.trim();
                if (!isTrimmed) {
                  i++;
                  continue;
                }
                const isIndent = isLn.search(/\S/);
                if (isIndent <= insIndent) break;
                const iskvMatch = isTrimmed.match(/^(\w[\w_]*):\s*(.+)$/);
                if (iskvMatch) {
                  step[iskvMatch[1].toLowerCase()] = iskvMatch[2].replace(/^"|"$/g, '');
                }
                i++;
              }
              flow.insertions.push({ position, target_step: targetStep, step });
              continue;
            }
            i++;
          }
          continue;
        }

        i++;
      }
      profile.flow = flow;
      continue;
    }

    // Unknown line in behavior profile — skip
    i++;
  }

  // Validate required fields
  if (errors) {
    if (!hasPriority) {
      errors.push({
        line: startLine,
        column: 0,
        message: 'BEHAVIOR_PROFILE requires a PRIORITY: declaration.',
      });
    }
    if (!hasWhen) {
      errors.push({
        line: startLine,
        column: 0,
        message: 'BEHAVIOR_PROFILE requires a WHEN: declaration.',
      });
    }
  }

  return profile;
}
