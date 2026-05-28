/**
 * ABL to IR Compiler
 *
 * Transforms parsed ABL (AgentBasedDocument) into the IR format
 * that all runtimes consume.
 */

import type {
  AgentBasedDocument,
  TemplateDefinition,
  RichContentAST,
  AttachmentFieldAST,
  DestinationAST,
  ActionSetAST,
  ActionHandlerAST,
  ActionHandlerActionAST,
  DigressionActionAST,
  HandoffHistoryConfig,
  ToolInvocationAST,
} from '@abl/core';
import type {
  AgentIR,
  BehaviorProfileIR,
  CompilationOutput,
  ToolDefinition,
  ToolHints,
  HttpBindingIR,
  McpBindingIR,
  SandboxBindingIR,
  ToolAuthTypeIR,
  GatherConfig,
  MemoryConfig,
  ConstraintConfig,
  CoordinationConfig,
  CompletionConfig,
  ErrorHandlingConfig,
  FlowConfig,
  RuntimeHints,
  DeploymentHints,
  Guardrail,
  GuardrailKind,
  GuardrailTier,
  StartConfig,
  AgentMessages,
  HookAction,
  HooksConfig,
  NLUIRConfig,
  VoiceConfigIR,
  RichContentIR,
  ActionElementIR,
  AttachmentFieldIR,
  ResolvedPassField,
  IntentHandlingConfig,
  MultiIntentStrategy,
  LookupTableIR,
  ActionSetIR,
  ActionHandlerIR,
  ActionHandlerActionIR,
  DigressionAction,
  ToolInvocationIR,
  ToolParameter,
  ConstraintCheckpoint,
  DestinationIR,
  IntentCategory,
  EntityDefinitionIR,
  EntityType,
} from './schema.js';
import type { GuardrailAction, GuardrailActionType, FixStrategy } from './guardrail-action.js';
import {
  getMutableActionHandlerActionRefs,
  syncActionHandlerCompatibilityMirrors,
} from './action-handler-utils.js';
import { compileBehaviorProfile, attachProfilesToAgent } from './compile-behavior-profile.js';
import { compileConversationBehavior } from './compile-conversation-behavior.js';
import type {
  HttpBindingAST,
  McpBindingAST,
  SandboxBindingAST,
  AgentTool,
  VoiceConfigAST,
  ToolParam,
} from '@abl/core';
import type { AgentSessionLifecycleConfig } from '../core/types.js';
import { createHash } from 'crypto';
import { getSystemEntityDefinition } from './system-entities.js';
import { MAX_USER_REGEX_PATTERN_LENGTH, validateRegexSafety } from './regex-safety.js';
import { createLogger } from '../logger.js';
import { extractStaticGraph } from './graph-extractor.js';
import { validateIR } from './validate-ir.js';
import { validateToolDefinitions } from './tool-schema-validator.js';
import { buildAuthConfigFromAST } from './auth-config-builder.js';
import { validateRecallEvents } from './recall-validation.js';
import {
  DEFAULT_INTENT_CATEGORIES,
  DEFAULT_MIN_CONFIDENCE,
  DEFAULT_MESSAGES,
  SYSTEM_TOOL_HANDOFF,
  SYSTEM_TOOL_DELEGATE,
  SYSTEM_TOOL_COMPLETE,
  SYSTEM_TOOL_ESCALATE,
  SYSTEM_TOOL_FAN_OUT,
  SYSTEM_TOOL_SET_CONTEXT,
  DEFAULT_TOOL_TIMEOUT_MS,
  DEFAULT_LLM_TIMEOUT_MS,
  DEFAULT_SESSION_TIMEOUT_MS,
  VOICE_LATENCY_SCRIPTED_MS,
  VOICE_LATENCY_INTERACTIVE_MS,
  CONFIG_VAR_PATTERN,
  ENV_VAR_PATTERN,
  DEFAULT_CONVERSATION_HISTORY_WINDOW,
  MAX_CONVERSATION_HISTORY_WINDOW,
  CONSTRAINT_CHECKPOINT_KIND_KEY,
  CONSTRAINT_CHECKPOINT_TARGET_KEY,
} from '../constants.js';
import type { ConfigVariableResolution, GatherField } from './schema.js';

const log = createLogger('compiler');

/** System types that get auto-generated intrinsic validation (phone, email, date, etc.) */
const INTRINSIC_VALIDATED_TYPES = new Set([
  'phone',
  'email',
  'date',
  'datetime',
  'number',
  'integer',
  'float',
  'currency',
  'boolean',
]);

/** System tool names that cannot be shadowed by project tool declarations */
const SYSTEM_TOOL_NAMES = new Set([
  SYSTEM_TOOL_HANDOFF,
  SYSTEM_TOOL_DELEGATE,
  SYSTEM_TOOL_COMPLETE,
  SYSTEM_TOOL_ESCALATE,
  SYSTEM_TOOL_FAN_OUT,
  SYSTEM_TOOL_SET_CONTEXT,
]);

function mergeAgentToolBehavior(
  resolvedTool: ToolDefinition,
  dslTool: ToolDefinition,
): ToolDefinition {
  const merged = { ...resolvedTool };

  if (dslTool.on_result) merged.on_result = dslTool.on_result;
  if (dslTool.on_error) merged.on_error = dslTool.on_error;
  if (dslTool.store_result !== undefined) merged.store_result = dslTool.store_result;
  if (dslTool.context_access) merged.context_access = dslTool.context_access;
  if (dslTool.confirmation) merged.confirmation = dslTool.confirmation;
  if (dslTool.pii_access) merged.pii_access = dslTool.pii_access;
  if (dslTool.auth_profile_ref) merged.auth_profile_ref = dslTool.auth_profile_ref;
  if (dslTool.jit_auth !== undefined) merged.jit_auth = dslTool.jit_auth;
  if (dslTool.connection_mode) merged.connection_mode = dslTool.connection_mode;
  if (dslTool.compaction) merged.compaction = dslTool.compaction;
  if (dslTool.consent_mode) merged.consent_mode = dslTool.consent_mode;
  if (dslTool.identity_tier_required !== undefined)
    merged.identity_tier_required = dslTool.identity_tier_required;

  return merged;
}

function compileAgentSessionLifecycle(
  execution?: AgentBasedDocument['execution'],
): AgentSessionLifecycleConfig | undefined {
  const idleTimeoutMs = execution?.session_idle_timeout;
  if (typeof idleTimeoutMs !== 'number') {
    return undefined;
  }

  return {
    // Convert the legacy ms-based DSL field into the seconds-based lifecycle override shape
    // without shortening the requested idle window.
    idleSeconds: Math.ceil(idleTimeoutMs / 1000),
  };
}

// =============================================================================
// TOOL SIGNATURE COMPARISON
// =============================================================================

/**
 * D42: Field-by-field comparison of agent DSL signature vs project_tools data.
 * Returns list of changed field names, or empty array if signatures match.
 */
function compareToolSignatures(
  dslTool: {
    name: string;
    parameters?: { name: string; type?: string }[];
    returns?: { type?: string } | string;
    description?: string;
  },
  resolvedTool: {
    name: string;
    parameters?: { name: string; type?: string }[];
    returns?: { type?: string } | string;
    description?: string;
  },
): string[] {
  const changedFields: string[] = [];

  // Compare parameters: count, names, types
  const dslParams = dslTool.parameters ?? [];
  const resolvedParams = resolvedTool.parameters ?? [];
  if (dslParams.length !== resolvedParams.length) {
    changedFields.push('parameters');
  } else {
    for (let i = 0; i < dslParams.length; i++) {
      if (
        dslParams[i].name !== resolvedParams[i].name ||
        dslParams[i].type !== resolvedParams[i].type
      ) {
        changedFields.push('parameters');
        break;
      }
    }
  }

  // Compare returns type
  const dslReturnType =
    typeof dslTool.returns === 'string' ? dslTool.returns : dslTool.returns?.type;
  const resolvedReturnType =
    typeof resolvedTool.returns === 'string' ? resolvedTool.returns : resolvedTool.returns?.type;
  if (dslReturnType !== resolvedReturnType) {
    changedFields.push('returns');
  }

  // Compare description
  if ((dslTool.description || '') !== (resolvedTool.description || '')) {
    changedFields.push('description');
  }

  return changedFields;
}

// =============================================================================
// MAIN COMPILER
// =============================================================================

/**
 * Compile multiple ABL documents into IR format
 */
export function compileABLtoIR(
  documents: AgentBasedDocument[],
  options: CompilerOptions = {},
): CompilationOutput {
  const agents: Record<string, AgentIR> = {};
  const compilationErrors: import('./schema.js').CompilationError[] = [];
  const compilationWarnings: import('./schema.js').CompilationError[] = [];
  let entryAgent: string | undefined;

  // D43: Compilation timeout tracking
  const compilationStart = Date.now();
  const timeoutMs = options.compilationTimeoutMs ?? 30_000;

  // 1. Separate behavior profiles from agents/supervisors
  const profileDocs = documents.filter((d) => d.meta.kind === 'behavior_profile');
  const agentDocs = documents.filter((d) => d.meta.kind !== 'behavior_profile');
  const supervisorNames = agentDocs
    .filter((d) => d.meta.kind === 'supervisor')
    .map((d) => d.name || d.meta?.name || 'unknown');

  if (supervisorNames.length > 1) {
    const [firstSupervisor] = supervisorNames;
    compilationErrors.push({
      agent: firstSupervisor,
      message: `E728: Multiple supervisors found; entry_agent is ambiguous. Using first supervisor "${firstSupervisor}" deterministically. Supervisors: ${supervisorNames.join(', ')}.`,
      type: 'compilation',
      severity: 'error',
    });
  }

  // 2. Compile behavior profiles first
  const compiledProfiles = new Map<string, BehaviorProfileIR>();
  for (const doc of profileDocs) {
    try {
      const { profile, errors } = compileBehaviorProfile(doc);
      compiledProfiles.set(profile.name, profile);
      for (const err of errors) compilationErrors.push(err);
    } catch (error) {
      const profileName = doc.name || doc.meta?.name || 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      compilationErrors.push({
        agent: profileName,
        message,
        type: 'compilation',
      });
    }
  }

  // 3. Compile agents/supervisors
  for (const doc of agentDocs) {
    try {
      // D43: Compilation timeout check
      const elapsed = Date.now() - compilationStart;
      if (elapsed > timeoutMs) {
        compilationErrors.push({
          agent: doc.name || 'unknown',
          message: `E727: Compilation timeout exceeded (${timeoutMs}ms). Elapsed: ${elapsed}ms.`,
          type: 'compilation',
        });
        break;
      }
      const { ir, warnings: agentWarnings, errors: agentErrors } = compileAgentToIR(doc, options);
      agents[ir.metadata.name] = ir;
      compilationWarnings.push(...agentWarnings);
      compilationErrors.push(...agentErrors);

      // 4. Attach behavior profiles if referenced via USE
      if (doc.useBehaviorProfiles?.length) {
        const errs = attachProfilesToAgent(ir, doc.useBehaviorProfiles, compiledProfiles);
        compilationErrors.push(...errs);
      }

      // 4b. Compile and attach inline behavior profiles
      if (doc.inlineBehaviorProfiles?.length) {
        for (const inlineProfile of doc.inlineBehaviorProfiles) {
          // Create a synthetic document for compileBehaviorProfile
          const syntheticDoc = {
            ...doc,
            name: inlineProfile.name,
            behaviorProfile: inlineProfile,
            meta: { ...doc.meta!, kind: 'behavior_profile' as const, name: inlineProfile.name },
          } as import('@abl/core').AgentBasedDocument;
          const { profile, errors: profileErrors } = compileBehaviorProfile(syntheticDoc);
          for (const err of profileErrors) compilationErrors.push(err);
          if (!ir.behavior_profiles) {
            ir.behavior_profiles = [];
          }
          ir.behavior_profiles.push(profile);
        }
      }

      if (doc.meta.kind === 'supervisor' && !entryAgent) {
        entryAgent = ir.metadata.name;
      }

      // Merge resolved tool implementations into agent tools
      // project_tools is authoritative — agent DSL signature is informational
      const resolvedTools = options.resolvedToolImplementations?.get(doc.name) ?? [];
      if (resolvedTools.length > 0) {
        const collidingNames = new Set<string>();
        for (const rt of resolvedTools) {
          if (SYSTEM_TOOL_NAMES.has(rt.name)) {
            compilationErrors.push({
              agent: doc.name,
              message: `E707: Tool "${rt.name}" conflicts with system tool`,
              type: 'compilation',
            });
            collidingNames.add(rt.name);
          }
        }
        // Insert resolved tools before system tools, excluding colliding ones.
        // Resolved tools replace DSL-parsed tools with the same name (they carry bindings).
        // DSL-level behavioral properties (on_result, on_error, store_result) are preserved
        // from the original IR tools since they are agent-specific, not tool-implementation.
        const safeResolvedTools = resolvedTools.filter((t) => !collidingNames.has(t.name));
        const resolvedNames = new Set(safeResolvedTools.map((t) => t.name));
        const systemTools = ir.tools.filter((t) => t.system);
        const dslToolMap = new Map(ir.tools.map((t) => [t.name, t]));
        const nonSystemTools = ir.tools.filter((t) => !t.system && !resolvedNames.has(t.name));
        // Merge DSL behavioral properties into resolved tools
        for (const rt of safeResolvedTools) {
          const dslIRTool = dslToolMap.get(rt.name);
          if (dslIRTool) {
            if (dslIRTool.on_result) rt.on_result = dslIRTool.on_result;
            if (dslIRTool.on_error) rt.on_error = dslIRTool.on_error;
            if (dslIRTool.store_result !== undefined) rt.store_result = dslIRTool.store_result;
            if (dslIRTool.context_access) rt.context_access = dslIRTool.context_access;
            if (dslIRTool.auth_profile_ref) rt.auth_profile_ref = dslIRTool.auth_profile_ref;
            if (dslIRTool.jit_auth !== undefined) rt.jit_auth = dslIRTool.jit_auth;
            if (dslIRTool.consent_mode) rt.consent_mode = dslIRTool.consent_mode;
            if (dslIRTool.connection_mode) rt.connection_mode = dslIRTool.connection_mode;
            if (dslIRTool.compaction) rt.compaction = dslIRTool.compaction;
            if (dslIRTool.pii_access) rt.pii_access = dslIRTool.pii_access;
            if (dslIRTool.confirmation) rt.confirmation = dslIRTool.confirmation;
            if (dslIRTool.identity_tier_required !== undefined)
              rt.identity_tier_required = dslIRTool.identity_tier_required;
          }
        }
        ir.tools = [...nonSystemTools, ...safeResolvedTools, ...systemTools];

        // D42: Staleness detection — compare agent DSL signatures vs resolved project_tools
        for (const resolvedTool of safeResolvedTools) {
          const dslTool = doc.tools?.find((t) => t.name === resolvedTool.name);
          if (dslTool) {
            const changedFields = compareToolSignatures(dslTool, resolvedTool);
            if (changedFields.length > 0) {
              compilationWarnings.push({
                agent: doc.name,
                message: `W721: Tool "${resolvedTool.name}" signature in agent DSL differs from project tool (changed: ${changedFields.join(', ')}). Consider updating.`,
                type: 'validation',
                severity: 'warning',
              });
            }
          }
        }
      }

      // In strict mode, halt compilation if any tool-related errors were collected
      if (options.mode === 'strict' && compilationErrors.length > 0) {
        const toolErrors = compilationErrors.filter(
          (e) => e.agent === doc.name && e.type === 'compilation',
        );
        if (toolErrors.length > 0) {
          throw new Error(
            `Strict mode: ${toolErrors.length} tool error(s) for agent "${doc.name}": ${toolErrors.map((e) => e.message).join('; ')}`,
          );
        }
      }

      // Validate constraint operators (raw conditions before auto-guard)
      for (const phase of doc.constraints) {
        for (const req of phase.requirements) {
          const opErrors = validateConstraintOperators(req.condition, ir.metadata.name);
          compilationErrors.push(...opErrors);
        }
      }
    } catch (error) {
      const agentName = doc.name || doc.meta?.name || 'unknown';
      const message = error instanceof Error ? error.message : String(error);
      console.error(`[Compiler] Failed to compile agent "${agentName}":`, message);
      compilationErrors.push({
        agent: agentName,
        message,
        type: 'compilation',
      });
      // Continue with other agents — don't crash entire compilation
    }
  }

  // D36: Stale signature threshold — fail compilation if too many tools are stale
  if (options.staleSignatureThreshold !== undefined && options.staleSignatureThreshold > 0) {
    const staleWarnings = compilationWarnings.filter((w) => w.message.startsWith('W721:'));
    // Count total resolved tools across all agents
    let totalResolvedTools = 0;
    if (options.resolvedToolImplementations) {
      for (const [, tools] of options.resolvedToolImplementations) {
        totalResolvedTools += tools.length;
      }
    }
    if (totalResolvedTools > 0) {
      const stalePercent = (staleWarnings.length / totalResolvedTools) * 100;
      if (stalePercent > options.staleSignatureThreshold) {
        compilationErrors.push({
          agent: '_global',
          message: `E726: Too many stale tool signatures (${staleWarnings.length}/${totalResolvedTools} exceed threshold of ${options.staleSignatureThreshold}%). Update signatures or raise threshold.`,
          type: 'compilation',
        });
      }
    }
  }

  // Post-IR validation pass
  const allAgentIRs = Object.values(agents);
  const singleAgentScope = options.singleAgentScope || options.skipCrossAgentValidation;
  for (const [agentName, agentIR] of Object.entries(agents)) {
    const diagnostics = validateIR(agentIR, allAgentIRs, {
      skipCrossAgentValidation: options.skipCrossAgentValidation,
      singleAgentScope,
    });
    for (const d of diagnostics) {
      const target = d.severity === 'error' ? compilationErrors : compilationWarnings;
      target.push({
        agent: d.agent,
        message: d.message,
        code: d.code,
        path: d.path,
        referenced_agent: d.referenced_agent,
        type: 'validation',
        severity: d.severity,
      });
    }

    // Validate tool definitions for completeness and correctness
    const toolValidation = validateToolDefinitions(agentIR.tools || []);
    for (const err of toolValidation.errors) {
      compilationErrors.push({
        agent: agentName,
        message: `Tool "${err.tool}" [${err.field}]: ${err.message}`,
        type: 'validation',
        severity: 'error',
      });
    }
    for (const warn of toolValidation.warnings) {
      compilationWarnings.push({
        agent: agentName,
        message: `Tool "${warn.tool}" [${warn.field}]: ${warn.message}`,
        type: 'validation',
        severity: 'warning',
      });
    }

    // Validate RECALL event names against lifecycle patterns
    if (agentIR.memory?.recall?.length) {
      const knownAgents = collectKnownAgentNames(agentIR, allAgentIRs);
      const recallDiagnostics = validateRecallEvents(
        agentIR.memory.recall,
        agentIR.tools || [],
        knownAgents,
        agentName,
        { singleAgentScope },
      );
      for (const d of recallDiagnostics) {
        const target = d.severity === 'error' ? compilationErrors : compilationWarnings;
        target.push({
          agent: d.agent,
          message: d.message,
          code: d.code,
          path: d.path,
          referenced_agent: d.referenced_agent,
          type: 'validation',
          severity: d.severity,
        });
      }
    }

    // Validate session memory declarations have population sources
    const memoryWarnings = validateSessionMemoryDeclarations(agentIR);
    compilationWarnings.push(...memoryWarnings);

    // Validate CONTEXT_ACCESS references declared memory vars
    const ctxWarnings = validateContextAccessDeclarations(agentIR);
    compilationWarnings.push(...ctxWarnings);
  }

  // Analyze for deployment hints
  const deployment = analyzeDeployment(agents, entryAgent);

  // Collect remote agents referenced across all handoffs/delegates
  const remoteAgents = collectRemoteAgents(agents);

  // Resolve config variables if provided
  let configVarResolution: ConfigVariableResolution | undefined;
  const configVars = options.config_variables;
  if (configVars && Object.keys(configVars).length > 0) {
    const allUsed = new Set<string>();
    for (const [agentName, agentIR] of Object.entries(agents)) {
      const result = resolveConfigVariables(agentIR, configVars);
      for (const key of result.used) {
        allUsed.add(key);
      }
      for (const err of result.errors) {
        compilationErrors.push({
          agent: agentName,
          message: err,
          type: 'compilation',
        });
      }
      // Compute config_hash for cache invalidation
      if (result.used.size > 0) {
        const usedEntries = [...result.used].sort().map((k) => `${k}=${configVars[k]}`);
        agentIR.metadata.config_hash = hashSource(usedEntries.join('|'));
      }
    }

    const resolved: Record<string, string> = {};
    for (const key of allUsed) {
      resolved[key] = configVars[key];
    }
    const unused = Object.keys(configVars).filter((k) => !allUsed.has(k));
    // Collect unresolved keys from errors
    const unresolved = [
      ...new Set(
        compilationErrors
          .filter((e) => e.message.startsWith('Undefined config variable'))
          .map((e) => {
            const match = e.message.match(/"(\w+)"/);
            return match ? match[1] : '';
          })
          .filter(Boolean),
      ),
    ];

    configVarResolution = { resolved, unresolved, unused };
  }

  const output: CompilationOutput = {
    version: '1.0',
    compiled_at: new Date().toISOString(),
    agents,
    entry_agent: entryAgent,
    deployment,
  };

  if (Object.keys(remoteAgents).length > 0) {
    output.remote_agents = remoteAgents;
  }
  if (options.coordination_defaults) {
    output.coordination_defaults = options.coordination_defaults;
  }
  if (compilationErrors.length > 0) {
    output.compilation_errors = compilationErrors;
    output.errors = compilationErrors;
  }
  if (compilationWarnings.length > 0) {
    output.compilation_warnings = compilationWarnings;
    output.warnings = compilationWarnings;
  }
  if (configVarResolution) {
    output.resolved_config_variables = configVarResolution;
  }

  return output;
}

export interface CompilerOptions {
  version?: string;
  optimize_for?: 'voice' | 'digital' | 'workflow';
  include_source_maps?: boolean;
  coordination_defaults?: import('./schema.js').ProjectCoordinationDefaults;
  config_variables?: Record<string, string>;
  project_runtime_config?: import('./schema.js').ProjectRuntimeConfigIR;
  /** Pre-resolved tool implementations from project_tools.
   *  Keyed by agent name → ToolDefinition[]. Compiler merges these into each agent's tools. */
  resolvedToolImplementations?: Map<string, ToolDefinition[]>;
  /** Configurable threshold for stale signature warnings. 0-100 percentage.
   *  If > X% of tools have stale signatures, compilation fails. Default: disabled. */
  staleSignatureThreshold?: number;
  /** Compilation timeout in ms. Default: 30000 (30s). */
  compilationTimeoutMs?: number;
  /** Compilation mode. 'strict' fails on unresolved tools, 'preview' returns partial IR. Default: 'preview' */
  mode?: 'strict' | 'preview';
  /** Skip cross-agent reference validation. Use when compiling a single agent in isolation
   *  (e.g. during per-agent generation) where other project agents are not in the compilation context. */
  skipCrossAgentValidation?: boolean;
  /** Single-agent validation scope. Alias for skipCrossAgentValidation in newer callers. */
  singleAgentScope?: boolean;
}

// =============================================================================
// AGENT COMPILER
// =============================================================================

function isExplicitDefaultHandoffCondition(condition: string | undefined): boolean {
  return (
    condition
      ?.trim()
      .replace(/^['"]|['"]$/g, '')
      .toLowerCase() === 'true'
  );
}

function compileAgentToIR(
  doc: AgentBasedDocument,
  options: CompilerOptions,
): {
  ir: AgentIR;
  warnings: import('./schema.js').CompilationError[];
  errors: import('./schema.js').CompilationError[];
} {
  const sourceHash = hashSource(JSON.stringify(doc));

  // Compile constraints first so they can be passed to flow compilation
  const { config: constraintConfig, warnings: constraintWarnings } = compileConstraints(doc);

  const isSupervisor = doc.meta.kind === 'supervisor';

  // Derive execution style from structure — MODE is deleted from DSL
  const hasFlow = doc.flow !== undefined && Object.keys(doc.flow.definitions).length > 0;
  const conversationCompilation = doc.conversation
    ? compileConversationBehavior(doc.conversation, doc.name)
    : { conversationBehavior: undefined, errors: [] };

  const ir: AgentIR = {
    ir_version: '1.0',

    metadata: {
      name: doc.name,
      version: options.version || '1.0.0',
      type: isSupervisor ? 'supervisor' : 'agent',
      compiled_at: new Date().toISOString(),
      source_hash: sourceHash,
      compiler_version: '1.0.0',
    },

    execution: {
      // mode is no longer set from DSL — derived from flow presence at runtime
      hints: analyzeRuntimeHints(doc),
      timeouts: {
        tool_timeout_ms: doc.execution?.tool_timeout ?? DEFAULT_TOOL_TIMEOUT_MS,
        llm_timeout_ms: doc.execution?.llm_timeout ?? DEFAULT_LLM_TIMEOUT_MS,
        session_timeout_ms: doc.execution?.session_idle_timeout ?? DEFAULT_SESSION_TIMEOUT_MS,
        voice_latency_target_ms:
          doc.execution?.voice_latency_target ??
          (hasFlow ? VOICE_LATENCY_SCRIPTED_MS : VOICE_LATENCY_INTERACTIVE_MS),
      },
      sessionLifecycle: compileAgentSessionLifecycle(doc.execution),
      model: doc.execution?.model,
      temperature: doc.execution?.temperature,
      max_tokens: doc.execution?.max_tokens,
      max_iterations: doc.execution?.max_reasoning_iterations,
      max_flow_iterations: doc.execution?.max_flow_iterations,
      fallback_model: doc.execution?.fallback_model,
      operation_models: doc.execution?.operation_models,
      enable_thinking: doc.execution?.enable_thinking,
      thinking_budget: doc.execution?.thinking_budget,
      compaction_threshold: doc.execution?.compaction_threshold,
      compaction: (doc.execution as any)?.compaction,
      inline_gather: doc.execution?.inline_gather,
      pipeline: doc.execution?.pipeline,
      voice: compileVoiceConfig(doc.execution?.voice),
    },

    identity: {
      goal: doc.goal.description,
      persona: doc.persona?.description || '',
      limitations: doc.limitations.map((l) => l.description),
      system_prompt: {
        template: doc.systemPrompt || buildSystemPromptTemplate(doc),
        custom: !!doc.systemPrompt,
        sections: {
          context: true,
          tools: doc.tools.length > 0,
          constraints: doc.constraints.length > 0,
          history: true,
        },
      },
      language: doc.language,
    },

    tools: [...compileTools(doc), ...compileSystemTools(doc)],
    gather: { fields: [], strategy: 'hybrid' as const }, // placeholder — populated after entity compilation
    attachments:
      doc.attachments && doc.attachments.length > 0
        ? compileAttachments(doc.attachments)
        : undefined,
    destinations:
      doc.destinations && doc.destinations.length > 0
        ? compileDestinations(doc.destinations)
        : undefined,
    memory: compileMemory(doc),
    constraints: constraintConfig,
    coordination: compileCoordination(doc),
    completion: compileCompletion(doc),
    error_handling: compileErrorHandling(doc),
    flow: doc.flow ? compileFlow(doc.flow, constraintConfig, doc.name, doc.gather) : undefined,
    on_start: doc.onStart ? compileStartConfig(doc.onStart) : undefined,
    messages: compileMessages(doc),
    hooks: doc.hooks ? compileHooks(doc.hooks) : undefined,
    nlu: doc.nlu ? compileNLU(doc.nlu) : undefined,
    action_handlers: compileActionHandlers(doc.actionHandlers),
    conversation_behavior: conversationCompilation.conversationBehavior,
    project_runtime_config: options.project_runtime_config,
  };

  // Compile top-level ENTITIES into canonical entity registry
  if (doc.entities && doc.entities.length > 0) {
    ir.entities = compileEntities(doc.entities);
  }

  // Lower NLU.entities into canonical entity registry
  const entityLoweringErrors: import('./schema.js').CompilationError[] = [];
  if (ir.nlu?.entities && ir.nlu.entities.length > 0) {
    if (!ir.entities) ir.entities = [];
    const loweringErrors = lowerNLUEntitiesToRegistry(ir.entities, ir.nlu.entities, doc.name);
    entityLoweringErrors.push(...loweringErrors);
  }

  // Ensure entity registry exists before compileGather (anonymous entities will be pushed into it)
  if (!ir.entities) ir.entities = [];

  // Compile GATHER with entity_ref resolution (runs after entity registry is populated)
  const gatherResult = compileGather(doc, ir.entities);
  ir.gather = gatherResult.config;
  entityLoweringErrors.push(...gatherResult.errors);

  // Clean up: if no entities were created, set to undefined for clean IR
  if (ir.entities.length === 0) {
    ir.entities = undefined;
  }

  // Multi-intent config → AgentIR.intent_handling
  if (doc.multiIntent) {
    ir.intent_handling = {
      multi_intent: {
        enabled: doc.multiIntent.enabled ?? true,
        strategy: (doc.multiIntent.strategy ?? 'primary_queue') as MultiIntentStrategy,
        max_intents: doc.multiIntent.max_intents ?? 3,
        confidence_threshold: doc.multiIntent.confidence_threshold ?? 0.6,
        queue_max_age_ms: doc.multiIntent.queue_max_age_ms ?? 600_000,
      },
    };
  }

  // Lookup tables → AgentIR.lookup_tables
  if (doc.lookupTables && Object.keys(doc.lookupTables).length > 0) {
    ir.lookup_tables = {};
    for (const [name, table] of Object.entries(doc.lookupTables)) {
      ir.lookup_tables[name] = {
        name,
        source: table.source,
        values: table.values,
        normalized_values:
          table.values && !table.caseSensitive
            ? table.values.map((v) => v.toLowerCase())
            : undefined,
        table_name: table.tableName,
        endpoint: table.endpoint,
        field: table.field,
        timeout_ms: table.timeoutMs,
        headers: table.headers,
        case_sensitive: table.caseSensitive,
        fuzzy_match: table.fuzzyMatch,
        fuzzy_threshold: table.fuzzyThreshold ?? 0.85,
      };
    }
  }

  // Compile and resolve templates (inline TEMPLATE(name) references)
  if (doc.templates && doc.templates.length > 0) {
    const templateDict = compileTemplates(doc);
    const templateFormatsDict = compileTemplateFormats(doc);
    const templateVoiceConfigDict = compileTemplateVoiceConfigs(doc);
    ir.templates = templateDict;
    const resolution = resolveAllTemplateRefs(
      ir,
      templateDict,
      templateFormatsDict,
      templateVoiceConfigDict,
    );
    // Template resolution errors are compile-time errors
    if (resolution.errors.length > 0) {
      throw new Error(`Template resolution failed:\n${resolution.errors.join('\n')}`);
    }
    // Warnings are non-fatal (e.g., unused templates)
    if (resolution.warnings.length > 0) {
      // Log warnings but continue
      for (const w of resolution.warnings) {
        log.warn(w);
      }
    }
  }

  // Add routing configuration for any agent with handoff rules
  if (doc.handoff.length > 0) {
    ir.routing = {
      rules: doc.handoff.map((h, idx) => ({
        to: h.to,
        when: h.when,
        description: h.context?.summary || `Route to ${h.to}`,
        priority: idx + 1,
        return: h.return,
      })),
      default_agent:
        doc.handoff.find((handoff) => isExplicitDefaultHandoffCondition(handoff.when))?.to ?? '',
      intent_classification: (() => {
        const { categories, source } = extractIntentCategories(doc);

        // Validate: if explicit, warn on undeclared categories in WHEN conditions
        if (source === 'explicit') {
          const declaredNames = new Set(categories.map((c) => c.name));
          const whenCategories = extractAllWhenCategories(doc);
          for (const cat of whenCategories) {
            if (!declaredNames.has(cat)) {
              constraintWarnings.push({
                agent: doc.name,
                message: `Intent category "${cat}" used in WHEN condition but not declared in INTENTS: block`,
                type: 'validation',
                severity: 'warning',
              });
            }
          }
        }

        return {
          categories,
          min_confidence: DEFAULT_MIN_CONFIDENCE,
          source,
          ...(doc.intentConfig?.lexicalFallback
            ? { lexical_fallback: doc.intentConfig.lexicalFallback }
            : {}),
        };
      })(),
    };
    ir.available_agents = [...new Set(doc.handoff.map((h) => h.to))];
  }

  // Merge NLU entity definitions (synonyms, values) into GATHER fields
  if (ir.nlu?.entities && ir.nlu.entities.length > 0 && ir.gather?.fields) {
    mergeNLUIntoGather(ir.gather.fields, ir.nlu.entities, ir.metadata.name);
  }

  // Also merge NLU into flow step GATHER fields
  if (ir.nlu?.entities && ir.nlu.entities.length > 0 && ir.flow?.definitions) {
    for (const step of Object.values(ir.flow.definitions)) {
      if (step.gather?.fields && step.gather.fields.length > 0) {
        mergeNLUIntoGather(
          step.gather.fields as unknown as GatherField[],
          ir.nlu.entities,
          ir.metadata.name,
        );
      }
    }
  }

  // Resolve entity_ref on flow step GATHER fields (post-processing pass)
  if (ir.entities && ir.entities.length > 0 && ir.flow?.definitions) {
    for (const step of Object.values(ir.flow.definitions)) {
      if (step.gather?.fields && step.gather.fields.length > 0) {
        for (const field of step.gather.fields) {
          if (!field.entity_ref) continue;

          // Exclusivity: entity_ref cannot coexist with entity-level properties
          const entityProps: string[] = [];
          if (field.type && field.type !== 'string') entityProps.push('TYPE');
          if (field.enum_values && field.enum_values.length > 0) entityProps.push('OPTIONS');

          if (entityProps.length > 0) {
            entityLoweringErrors.push({
              agent: doc.name,
              message:
                `Flow step GATHER field "${field.name}" uses ENTITY_REF but also defines entity-level ` +
                `properties (${entityProps.join(', ')}). When using ENTITY_REF, cannot redefine ` +
                `type, values, or synonyms — remove ${entityProps.join('/')} or remove ENTITY_REF.`,
              type: 'compilation',
            });
            continue; // skip this field
          }

          const entity = ir.entities.find((e) => e.name === field.entity_ref);
          if (!entity) {
            entityLoweringErrors.push({
              agent: doc.name,
              message:
                `Flow step GATHER field "${field.name}" references entity "${field.entity_ref}" ` +
                `not found in entity registry. Define it in ENTITIES or NLU.entities.`,
              type: 'compilation',
            });
            continue;
          }
          // Inherit type from entity
          if (!field.type) {
            field.type = entity.type;
          }
          // Inherit enum values if not already set
          if (entity.values && (!field.enum_values || field.enum_values.length === 0)) {
            field.enum_values = entity.values;
          }
          // Inherit synonyms if not already set
          if (entity.synonyms && !field.synonyms) {
            field.synonyms = entity.synonyms;
          }
          // Inherit sensitive flag if not overridden
          if (entity.sensitive && field.sensitive === undefined) {
            field.sensitive = entity.sensitive;
          }
        }
      }
    }
  }

  // Lower FLOW step typed gather fields into canonical ir.entities
  // (mirrors the anonymous entity creation in compileGather for top-level fields)
  if (ir.flow?.definitions) {
    for (const step of Object.values(ir.flow.definitions)) {
      if (!step.gather?.fields || step.gather.fields.length === 0) continue;
      for (const field of step.gather.fields) {
        if (field.entity_ref) continue; // entity_ref fields are handled above
        const fieldType = field.type;
        if (!fieldType || fieldType === 'string') continue; // skip untyped / string fields
        if (!ir.entities) ir.entities = [];
        const existingEntity = ir.entities.find((e) => e.name === field.name);
        if (existingEntity) continue; // already in registry
        const systemDef = getSystemEntityDefinition(fieldType);
        ir.entities.push({
          name: field.name,
          type: (fieldType || 'string') as EntityType,
          values: systemDef?.values ?? (field.enum_values?.length ? field.enum_values : undefined),
          intrinsic_validation: systemDef?.intrinsic_validation,
          sensitive: field.sensitive,
          source: 'gather_inline',
        });
      }
    }
  }

  return {
    ir,
    warnings: constraintWarnings,
    errors: [...entityLoweringErrors, ...conversationCompilation.errors],
  };
}

// =============================================================================
// COMPONENT COMPILERS
// =============================================================================

/**
 * Reject deprecated Lambda tool type at compile time with actionable error.
 * Returns the tool_type unchanged for all valid types.
 */
function rejectLambdaToolType(
  type: string | undefined,
  toolName: string,
): ToolDefinition['tool_type'] {
  if (type === 'lambda') {
    throw new Error(
      `Tool "${toolName}" uses deprecated Lambda type. ` +
        `Migrate to HTTP (with API Gateway) or Sandbox (for code execution).`,
    );
  }
  return type as ToolDefinition['tool_type'];
}

function compileToolParam(p: ToolParam): ToolParameter {
  return {
    name: p.name,
    type: p.type,
    description: p.description,
    required: p.required,
    default: p.default,
    validation: p.validate,
    properties: p.properties?.map(compileToolParam),
    items: p.items
      ? {
          type: p.items.type || 'object',
          properties: p.items.properties?.map(compileToolParam),
        }
      : undefined,
  };
}

function compileTools(doc: AgentBasedDocument): ToolDefinition[] {
  return doc.tools.map((tool) => ({
    name: tool.name,
    description: tool.description || `Execute ${tool.name}`,
    parameters: tool.parameters.map(compileToolParam),
    returns: {
      type: tool.returns.type,
      fields: tool.returns.fields,
      items: tool.returns.items,
      optional: tool.returns.optional,
    },
    hints: inferToolHints(tool),
    tool_type: rejectLambdaToolType(tool.type, tool.name),
    http_binding: tool.httpBinding ? compileHttpBinding(tool.httpBinding) : undefined,
    mcp_binding: tool.mcpBinding ? compileMcpBinding(tool.mcpBinding, tool.name) : undefined,
    sandbox_binding: tool.sandboxBinding ? compileSandboxBinding(tool.sandboxBinding) : undefined,
    store_result: tool.storeResult,
    on_result: tool.onResult,
    on_error: tool.onError,
    context_access: tool.contextAccess
      ? { read: tool.contextAccess.read, write: tool.contextAccess.write }
      : undefined,
    compaction: (tool as any).compaction,
    confirmation: tool.confirmation
      ? {
          require: tool.confirmation.require,
          immutable_params: tool.confirmation.immutableParams,
          consent_required_in: tool.confirmation.consentRequiredIn,
          consent_scope: tool.confirmation.consentScope,
          consent_action: tool.confirmation.consentAction,
          consent_fallback: tool.confirmation.consentFallback,
        }
      : undefined,
    pii_access: tool.piiAccess,
    identity_tier_required: tool.identityTierRequired,
    auth_profile_ref: tool.authProfile,
    jit_auth: tool.authJit,
    consent_mode: tool.consent as 'inline' | 'preflight' | undefined,
    connection_mode: tool.connection as 'per_user' | 'shared' | undefined,
  }));
}

function compileHttpBinding(ast: HttpBindingAST): HttpBindingIR {
  const authType = (ast.auth || 'none') as ToolAuthTypeIR;
  return {
    endpoint: ast.endpoint,
    method: ast.method,
    auth: {
      type: authType,
      config: buildAuthConfigFromAST(ast.auth, ast.authConfig),
    },
    timeout_ms: ast.timeout,
    retry: ast.retry ? { count: ast.retry, delay_ms: ast.retryDelay ?? 1000 } : undefined,
    rate_limit_per_minute: ast.rateLimit,
    circuit_breaker: ast.circuitBreaker
      ? {
          threshold: ast.circuitBreaker.threshold,
          reset_ms: ast.circuitBreaker.resetMs,
        }
      : undefined,
    headers: ast.headers,
    query_params: ast.queryParams,
    body_type: ast.bodyType,
    body_template: ast.bodyTemplate,
    protocol: ast.protocol,
    soap_version: ast.soapVersion,
    soap_action: ast.soapAction,
    on_soap_fault: ast.onSoapFault,
  };
}

function compileMcpBinding(ast: McpBindingAST, toolName: string): McpBindingIR {
  return {
    server: ast.server,
    tool: ast.tool ?? toolName, // Default to the tool's name
    headers: ast.headers,
  };
}

function compileSandboxBinding(ast: SandboxBindingAST): SandboxBindingIR {
  return {
    runtime: ast.runtime,
    code_content: ast.code ?? '',
    timeout_ms: ast.timeout,
    memory_mb: ast.memoryMb,
  };
}

function inferToolHints(tool: AgentTool): ToolHints {
  // Default to conservative/safe values, merge with any declared hints
  const parsed = tool.hints || {};

  // Infer hints based on tool type
  let defaultLatency: 'fast' | 'medium' | 'slow' = 'medium';
  let defaultSideEffects = true;
  let defaultRequiresAuth = false;

  const toolType = tool.type;

  switch (toolType) {
    case 'http':
      defaultLatency = 'slow';
      defaultSideEffects = tool.httpBinding
        ? ['POST', 'PUT', 'PATCH', 'DELETE'].includes(tool.httpBinding.method)
        : true;
      defaultRequiresAuth =
        tool.httpBinding?.auth !== undefined && tool.httpBinding.auth !== 'none';
      break;
    case 'mcp':
      defaultLatency = 'slow';
      defaultSideEffects = true;
      defaultRequiresAuth = false;
      break;
    case 'sandbox':
      defaultLatency = 'medium';
      defaultSideEffects = true;
      defaultRequiresAuth = false;
      break;
    case 'workflow':
      defaultLatency = 'slow';
      defaultSideEffects = true;
      defaultRequiresAuth = false;
      break;
  }

  return {
    cacheable: parsed.cacheable ?? false,
    latency: (parsed.latency as 'fast' | 'medium' | 'slow') ?? defaultLatency,
    parallelizable: false,
    side_effects: parsed.side_effects ?? defaultSideEffects,
    requires_auth: parsed.requires_auth ?? defaultRequiresAuth,
    timeout: parsed.timeout,
  };
}

/**
 * Generate system tool definitions based on agent coordination/completion config.
 * These are auto-injected tools that the runtime uses for handoff, delegate, etc.
 */
function compileSystemTools(doc: AgentBasedDocument): ToolDefinition[] {
  const systemTools: ToolDefinition[] = [];

  // __handoff__ tool if handoffs are defined
  if (doc.handoff.length > 0) {
    const targets = doc.handoff.map((h) => h.to);
    systemTools.push({
      name: SYSTEM_TOOL_HANDOFF,
      description: `Transfer the conversation to another agent. Available targets: ${targets.join(', ')}`,
      parameters: [
        { name: 'target', type: 'string', description: 'The agent to hand off to', required: true },
        { name: 'context', type: 'string', description: 'JSON context to pass', required: false },
      ],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'fast',
        parallelizable: false,
        side_effects: true,
        requires_auth: false,
      },
      system: true,
    });
  }

  // __delegate__ tool if delegates are defined
  if (doc.delegate.length > 0) {
    const targets = doc.delegate.map((d) => d.agent);
    systemTools.push({
      name: SYSTEM_TOOL_DELEGATE,
      description: `Call a sub-agent and use their result. Available targets: ${targets.join(', ')}`,
      parameters: [
        {
          name: 'target',
          type: 'string',
          description: 'The sub-agent to delegate to',
          required: true,
        },
        { name: 'input', type: 'object', description: 'Input data to pass', required: false },
      ],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'slow',
        parallelizable: false,
        side_effects: true,
        requires_auth: false,
      },
      system: true,
    });
  }

  // __complete__ tool if completion conditions or gather fields exist
  if (doc.complete.length > 0 || doc.gather.length > 0) {
    systemTools.push({
      name: SYSTEM_TOOL_COMPLETE,
      description: 'Mark the conversation as complete',
      parameters: [
        {
          name: 'message',
          type: 'string',
          description: 'Final message to the user',
          required: true,
        },
        {
          name: 'store',
          type: 'string',
          description: 'Optional key to store data',
          required: false,
        },
      ],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'fast',
        parallelizable: false,
        side_effects: true,
        requires_auth: false,
      },
      system: true,
    });
  }

  // __escalate__ tool — only when ESCALATION config is defined
  if ((doc.escalate?.triggers?.length ?? 0) > 0)
    systemTools.push({
      name: SYSTEM_TOOL_ESCALATE,
      description: 'Transfer the conversation to a human agent',
      parameters: [
        { name: 'reason', type: 'string', description: 'Reason for escalation', required: true },
        { name: 'priority', type: 'string', description: 'Priority level', required: false },
      ],
      returns: { type: 'object' },
      hints: {
        cacheable: false,
        latency: 'fast',
        parallelizable: false,
        side_effects: true,
        requires_auth: false,
      },
      system: true,
    });

  return systemTools;
}

/**
 * Resolve validation type from VALIDATION_PROCESS.
 * Default (no process specified or REGEX) → 'pattern' so regex runs at runtime.
 * LLM → 'llm' so LLM validation triggers.
 * CODE → 'custom' (future JS evaluator).
 */
function resolveValidationType(process?: 'REGEX' | 'CODE' | 'LLM'): 'pattern' | 'llm' | 'custom' {
  if (process === 'LLM') return 'llm';
  if (process === 'CODE') return 'custom';
  return 'pattern';
}

/**
 * Validate that a VALIDATE string is a valid regex at compile time.
 * Throws a compile error if the regex is invalid.
 */
function validateRegexAtCompile(rule: string, fieldName: string, agentName: string): void {
  try {
    new RegExp(rule);
  } catch {
    throw new Error(
      `[${agentName}] GATHER field "${fieldName}" has invalid regex in VALIDATE: "${rule}". ` +
        `Use VALIDATION_PROCESS: LLM for natural language validation rules.`,
    );
  }

  const safety = validateRegexSafety(rule, `${fieldName} VALIDATE`);
  if (!safety.safe) {
    throw new Error(
      `[${agentName}] GATHER field "${fieldName}" has an unsafe regex in VALIDATE: "${rule}". ` +
        (safety.error ?? 'Potential catastrophic backtracking detected.'),
    );
  }
}

function validateExtractionPatternAtCompile(
  pattern: string,
  fieldName: string,
  agentName: string,
): void {
  if (pattern.length > MAX_USER_REGEX_PATTERN_LENGTH) {
    throw new Error(
      `[${agentName}] GATHER field "${fieldName}" has extraction_pattern exceeding maximum length of ${MAX_USER_REGEX_PATTERN_LENGTH}.`,
    );
  }

  const safety = validateRegexSafety(pattern, `${fieldName} extraction_pattern`);
  if (!safety.safe) {
    throw new Error(
      `[${agentName}] GATHER field "${fieldName}" has an unsafe extraction_pattern: "${pattern}". ` +
        (safety.error ?? 'Potential catastrophic backtracking detected.'),
    );
  }
}

/**
 * Compile top-level ENTITIES section into canonical EntityDefinitionIR[].
 */
function compileEntities(
  entities: NonNullable<AgentBasedDocument['entities']>,
): EntityDefinitionIR[] {
  return entities.map((e) => {
    // Validate regex patterns at compile time to prevent ReDoS at runtime
    if (e.pattern) {
      const safety = validateRegexSafety(e.pattern, e.name);
      if (!safety.safe) {
        throw new Error(safety.error);
      }
    }
    return {
      name: e.name,
      type: e.type as EntityType,
      values: e.values,
      synonyms: e.synonyms,
      pattern: e.pattern,
      intrinsic_validation: e.validation,
      sensitive: e.sensitive,
      source: 'explicit' as const,
    };
  });
}

/**
 * Lower NLU.entities into the canonical entity registry.
 * Detects conflicts with explicitly defined ENTITIES.
 */
function lowerNLUEntitiesToRegistry(
  registry: EntityDefinitionIR[],
  nluEntities: NLUIRConfig['entities'],
  agentName: string,
): import('./schema.js').CompilationError[] {
  const errors: import('./schema.js').CompilationError[] = [];

  for (const nluEntity of nluEntities) {
    const existing = registry.find((e) => e.name === nluEntity.name);
    if (existing && existing.source === 'explicit') {
      errors.push({
        agent: agentName,
        message:
          `Entity "${nluEntity.name}" is defined in both ENTITIES and NLU.entities. ` +
          `Remove the duplicate from NLU.entities or use the same definition in ENTITIES only.`,
        type: 'compilation',
      });
      continue;
    }
    if (!existing) {
      // Validate regex patterns at compile time to prevent ReDoS at runtime
      if (nluEntity.pattern) {
        const safety = validateRegexSafety(nluEntity.pattern, nluEntity.name);
        if (!safety.safe) {
          errors.push({
            agent: agentName,
            message: safety.error ?? `Entity "${nluEntity.name}" has an unsafe regex pattern.`,
            type: 'compilation',
          });
          continue;
        }
      }
      registry.push({
        name: nluEntity.name,
        type: nluEntity.type as EntityType,
        values: nluEntity.values,
        synonyms: nluEntity.synonyms,
        pattern: nluEntity.pattern,
        intrinsic_validation: nluEntity.validation,
        sensitive: nluEntity.sensitive,
        source: 'nlu_lowered',
      });
    }
  }

  return errors;
}

function compileGather(
  doc: AgentBasedDocument,
  entityRegistry?: EntityDefinitionIR[],
): { config: GatherConfig; errors: import('./schema.js').CompilationError[] } {
  const errors: import('./schema.js').CompilationError[] = [];
  const config: GatherConfig = {
    fields: doc.gather.flatMap((f) => {
      // Resolve entity_ref — inherit type, values, synonyms from entity
      let fieldType = f.type;
      // Enum values can be declared either top-level (options: [...]) or
      // inside the semantics block (enum_set: [...]). Normalize to a single
      // enum_values array on the IR so runtime consumers read one source.
      let enumValues = f.options?.length
        ? f.options
        : f.semantics?.enumSet?.length
          ? f.semantics.enumSet
          : undefined;
      let fieldSynonyms: Record<string, string[]> | undefined;
      let fieldSensitive = f.sensitive;

      if (f.entityRef) {
        // Exclusivity: entity_ref cannot coexist with entity-level properties
        const entityProps: string[] = [];
        if (f.type && f.type !== 'string') entityProps.push('TYPE');
        if (f.options && f.options.length > 0) entityProps.push('OPTIONS');

        if (entityProps.length > 0) {
          errors.push({
            agent: doc.name,
            message:
              `GATHER field "${f.name}" uses ENTITY_REF but also defines entity-level ` +
              `properties (${entityProps.join(', ')}). When using ENTITY_REF, cannot redefine ` +
              `type, values, or synonyms — remove ${entityProps.join('/')} or remove ENTITY_REF.`,
            type: 'compilation',
          });
          return []; // skip this field
        }

        const entity = entityRegistry?.find((e) => e.name === f.entityRef);
        if (!entity) {
          errors.push({
            agent: doc.name,
            message:
              `GATHER field "${f.name}" references entity "${f.entityRef}" ` +
              `not found in entity registry. Define it in ENTITIES or NLU.entities.`,
            type: 'compilation',
          });
          return []; // skip this field
        }
        // Override the field type with entity type
        fieldType = entity.type;
        // Inherit enum values and synonyms
        if (entity.values) {
          enumValues = entity.values;
        }
        if (entity.synonyms) {
          fieldSynonyms = entity.synonyms;
        }
        // Inherit sensitive flag if not overridden on GATHER
        if (entity.sensitive && f.sensitive === undefined) {
          fieldSensitive = entity.sensitive;
        }
      }

      // For fields without entity_ref, create an anonymous entity in the registry
      if (!f.entityRef && fieldType && entityRegistry) {
        const existingEntity = entityRegistry.find((e) => e.name === f.name);
        if (!existingEntity) {
          const systemDef = getSystemEntityDefinition(fieldType);
          entityRegistry.push({
            name: f.name,
            type: (fieldType || 'string') as EntityType,
            values: systemDef?.values ?? enumValues,
            intrinsic_validation: systemDef?.intrinsic_validation,
            sensitive: fieldSensitive,
            source: 'gather_inline',
          });
        }
      }

      if (f.extractionPattern) {
        validateExtractionPatternAtCompile(f.extractionPattern, f.name, doc.name);
      }

      return [
        {
          name: f.name,
          entity_ref: f.entityRef,
          prompt: f.prompt,
          message_key: f.messageKey,
          type: fieldType,
          required: f.required,
          default: f.default,
          validation:
            fieldType === 'enum' && enumValues?.length
              ? {
                  type: 'enum' as const,
                  rule: enumValues.join('|'),
                  error_message: `Invalid ${f.name}. Allowed values: ${enumValues.join(', ')}`,
                  retry_prompt: f.retryPrompt,
                  max_retries: f.maxRetries,
                  validation_process: f.validationProcess,
                }
              : f.validate
                ? (() => {
                    const vType = resolveValidationType(f.validationProcess);
                    if (vType === 'pattern') {
                      validateRegexAtCompile(f.validate, f.name, doc.name);
                    }
                    return {
                      type: vType,
                      rule: f.validate,
                      error_message: `Invalid ${f.name}`,
                      retry_prompt: f.retryPrompt,
                      max_retries: f.maxRetries,
                      validation_process: f.validationProcess,
                    };
                  })()
                : f.retryPrompt || f.maxRetries || f.validationProcess
                  ? {
                      type: resolveValidationType(f.validationProcess),
                      rule: '',
                      error_message: `Invalid ${f.name}`,
                      retry_prompt: f.retryPrompt,
                      max_retries: f.maxRetries,
                      validation_process: f.validationProcess,
                    }
                  : INTRINSIC_VALIDATED_TYPES.has(fieldType)
                    ? {
                        type: 'intrinsic' as const,
                        rule: fieldType,
                        error_message: `Invalid ${f.name}`,
                        retry_prompt: f.retryPrompt,
                        max_retries: f.maxRetries,
                      }
                    : undefined,
          enum_values: enumValues,
          synonyms: fieldSynonyms,
          extraction_hints: [f.prompt],
          infer: f.infer,
          infer_confidence: f.inferConfidence,
          infer_confirm: f.inferConfirm,
          semantics: f.semantics
            ? {
                format: f.semantics.format,
                components: f.semantics.components,
                unit: f.semantics.unit,
                lookup: f.semantics.lookup,
                convert_to: f.semantics.convertTo,
                locale: f.semantics.locale,
                kore_entity_type: f.semantics.koreEntityType,
                enum_set: f.semantics.enumSet,
              }
            : undefined,
          range: f.range,
          list: f.list,
          preferences: f.preferences,
          activation: f.activation,
          depends_on: f.dependsOn,
          prompt_mode: f.promptMode,
          sensitive: fieldSensitive,
          sensitive_display: f.sensitiveDisplay,
          mask_config: f.maskConfig
            ? {
                show_first: f.maskConfig.showFirst,
                show_last: f.maskConfig.showLast,
                char: f.maskConfig.char,
              }
            : undefined,
          pii_type: f.piiType,
          transient: f.transient,
          extraction_pattern: f.extractionPattern,
          extraction_group: f.extractionGroup,
        },
      ];
    }),
    strategy: doc.flow !== undefined ? 'pattern' : 'hybrid',
  };
  return { config, errors };
}

/**
 * Merge NLU entity definitions (synonyms, values) into GATHER fields at compile time.
 * When a GATHER field name matches an NLU entity name, the compiler merges NLU synonyms
 * and values into the GATHER field IR. Types must match (compile error otherwise).
 * GATHER options filter NLU synonyms; if no options, all NLU values/synonyms are inherited.
 */
function mergeNLUIntoGather(
  gatherFields: GatherField[],
  nluEntities: Array<{
    name: string;
    type: string;
    values?: string[];
    synonyms?: Record<string, string[]>;
  }>,
  agentName: string,
): void {
  for (const field of gatherFields) {
    const entity = nluEntities.find((e) => e.name === field.name);
    if (!entity) continue;

    // Type check: both must agree if both specified
    if (field.type && entity.type) {
      const nluType = entity.type === 'free_text' ? 'string' : entity.type;
      if (field.type !== nluType) {
        throw new Error(
          `[${agentName}] GATHER field "${field.name}" has type "${field.type}" but NLU entity has type "${entity.type}". Types must match.`,
        );
      }
    }

    if (field.enum_values && field.enum_values.length > 0) {
      // GATHER has options — filter NLU synonyms to only matching values
      const synonyms: Record<string, string[]> = {};
      for (const value of field.enum_values) {
        if (entity.synonyms?.[value]) {
          synonyms[value] = entity.synonyms[value];
        }
      }
      if (Object.keys(synonyms).length > 0) {
        field.synonyms = synonyms;
      }
    } else if (entity.values && entity.values.length > 0) {
      // GATHER has no options — bring everything from NLU
      field.enum_values = entity.values;
      if (entity.synonyms) {
        field.synonyms = entity.synonyms;
      }
    }
  }
}

// =============================================================================
// ATTACHMENT COMPILATION
// =============================================================================

/** Default MIME types by attachment category */
const DEFAULT_MIME_TYPES: Record<string, string[]> = {
  image: ['image/jpeg', 'image/png', 'image/gif', 'image/webp'],
  document: ['application/pdf', 'application/msword', 'text/plain'],
  audio: ['audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm'],
  video: ['video/mp4', 'video/webm', 'video/quicktime'],
};

/** Default max file size in MB by attachment category */
const DEFAULT_MAX_SIZE_MB: Record<string, number> = {
  image: 10,
  document: 25,
  audio: 50,
  video: 100,
};

function compileAttachments(attachments: AttachmentFieldAST[]): AttachmentFieldIR[] {
  return attachments.map((a) => {
    const maxSizeMb = a.maxFileSizeMb ?? DEFAULT_MAX_SIZE_MB[a.category] ?? 10;
    return {
      name: a.name,
      prompt: a.prompt,
      category: a.category,
      required: a.required,
      allowed_mime_types: a.allowedMimeTypes ?? DEFAULT_MIME_TYPES[a.category] ?? [],
      max_file_size_bytes: maxSizeMb * 1024 * 1024,
      processing: {
        ...(a.ocrEnabled !== undefined ? { ocr_enabled: a.ocrEnabled } : {}),
        ...(a.transcriptionEnabled !== undefined
          ? { transcription_enabled: a.transcriptionEnabled }
          : {}),
        ...(a.keyFrameExtraction !== undefined
          ? { key_frame_extraction: a.keyFrameExtraction }
          : {}),
      },
    };
  });
}

// =============================================================================
// DESTINATIONS COMPILER
// =============================================================================

/**
 * Check if a hostname is a private, reserved, or loopback address.
 * Used for SSRF protection on destination URLs.
 */
function isPrivateOrReservedIP(hostname: string): boolean {
  // Normalize
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, '');

  // Loopback / special
  if (h === 'localhost' || h === '::1' || h === '0.0.0.0') return true;

  // IPv4 private ranges
  const ipv4Match = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (a === 127) return true; // 127.0.0.0/8
    if (a === 10) return true; // 10.0.0.0/8
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12
    if (a === 192 && b === 168) return true; // 192.168.0.0/16
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 (link-local)
    if (a === 0) return true; // 0.0.0.0/8
  }

  return false;
}

function compileDestinations(destinations: DestinationAST[]): DestinationIR[] {
  return destinations.map((d) => {
    // SSRF protection: validate URL hostname
    try {
      const parsed = new URL(d.url);
      if (isPrivateOrReservedIP(parsed.hostname)) {
        throw new Error(
          `Destination "${d.name}" URL targets a private/internal address (SSRF not allowed): ${d.url}`,
        );
      }
    } catch (err) {
      if (err instanceof Error && err.message.includes('SSRF')) {
        throw err;
      }
      // URL parse failure — let it through (might be a template)
    }

    return {
      name: d.name,
      url: d.url,
      method: d.method,
      auth: d.auth,
      headers: d.headers,
    };
  });
}

function compileMemory(doc: AgentBasedDocument): MemoryConfig {
  return {
    session: doc.memory.session.map((s) => ({
      name: s.name,
      type: s.type,
      description: s.description,
      initial_value: s.initial_value,
      reset: s.reset,
    })),
    persistent: doc.memory.persistent.map((p) => ({
      path: p.path,
      description: p.description,
      scope: (p.scope ?? 'user') as 'user' | 'project' | 'execution_tree',
      access: (p.access ?? 'readwrite') as 'read' | 'write' | 'readwrite',
      type: p.type,
      unit: p.unit,
      default_value: p.defaultValue,
      sensitive: p.sensitive,
      sensitive_display: p.sensitiveDisplay,
      mask_config: p.maskConfig
        ? {
            show_first: p.maskConfig.showFirst,
            show_last: p.maskConfig.showLast,
            char: p.maskConfig.char,
          }
        : undefined,
    })),
    remember: doc.memory.remember.map((r) => ({
      when: r.when,
      store: r.store,
      ttl: r.ttl,
    })),
    recall: doc.memory.recall.map((r) => ({
      event: r.event,
      instruction: r.instruction,
      action: r.action,
    })),
  };
}

function compileConstraints(doc: AgentBasedDocument): {
  config: ConstraintConfig;
  warnings: import('./schema.js').CompilationError[];
} {
  const warnings: import('./schema.js').CompilationError[] = [];

  // NOTE: LIMITATIONS are included in the system prompt for the LLM to follow.
  // They are NOT runtime guardrails because they're text descriptions, not evaluatable conditions.
  // Runtime guardrails should only come from explicit GUARDRAILS with evaluatable conditions.

  // Compile guardrails from doc.guardrails (parsed from GUARDRAILS section)
  const rawGuardrails: Guardrail[] = (doc.guardrails || []).map((g) => {
    // Infer tier from fields present
    const tier: GuardrailTier = g.provider ? 'model' : g.llm_check ? 'llm' : 'local';

    // Map action with full GuardrailAction details
    const action: GuardrailAction = {
      type: mapGuardrailActionType(g.action),
      message: g.message,
      ...(g.fix_strategy && { fixStrategy: g.fix_strategy as FixStrategy }),
      ...(g.fix_expression && { fixExpression: g.fix_expression }),
      ...(g.max_reasks != null && { maxReasks: g.max_reasks }),
      ...(g.filter_min_length != null && { filterMinLength: g.filter_min_length }),
    };

    return {
      name: g.name,
      description: g.message || `Guardrail: ${g.name}`,
      kind: g.kind as GuardrailKind, // 'both' still present at this point
      priority: g.priority ?? 100,
      tier,
      ...(g.check && { check: g.check }),
      ...(g.provider && { provider: g.provider }),
      ...(g.category && { category: g.category }),
      ...(g.threshold != null && { threshold: g.threshold }),
      ...(g.llm_check && { llmCheck: g.llm_check }),
      action,
      ...(g.streaming != null && { streaming: g.streaming }),
      ...(g.streaming_interval && { streamingInterval: g.streaming_interval }),
    } as Guardrail;
  });

  // Expand 'both' into input + output (compile-time expansion)
  const guardrails: Guardrail[] = rawGuardrails.flatMap((g) => {
    if ((g as any).kind === 'both') {
      return [
        { ...g, kind: 'input' as GuardrailKind },
        { ...g, kind: 'output' as GuardrailKind },
      ];
    }
    return [g];
  });

  // W823: Warn when named constraint phases (non-"always") are used — they are labels only
  for (const phase of doc.constraints) {
    if (phase.name !== 'always') {
      warnings.push({
        agent: doc.name,
        message: `W823: Constraint phase "${phase.name}" has no runtime effect. All constraints evaluate every turn; phase names are treated as labels for readability only.`,
        type: 'validation',
        severity: 'warning',
      });
    }
  }

  // W822: Warn when top-level GATHER fields set both required:false and default
  for (const field of doc.gather) {
    if (field.required === false && field.default !== undefined) {
      warnings.push({
        agent: doc.name,
        message: `W822: GATHER field "${field.name}" sets both required:false and default. Fields with defaults already satisfy missing-field checks; remove required:false for clarity.`,
        type: 'validation',
        severity: 'warning',
      });
    }
  }

  // W822: Warn when FLOW step GATHER fields set both required:false and default
  if (doc.flow) {
    for (const [stepName, step] of Object.entries(doc.flow.definitions)) {
      if (step.gather?.fields) {
        for (const field of step.gather.fields) {
          if (field.required === false && field.default !== undefined) {
            warnings.push({
              agent: doc.name,
              message: `W822: FLOW step "${stepName}" GATHER field "${field.name}" sets both required:false and default. Fields with defaults already satisfy missing-field checks; remove required:false for clarity.`,
              type: 'validation',
              severity: 'warning',
            });
          }
        }
      }
    }
  }

  // Flatten all constraint phase requirements into a single list.
  // All constraints are checked every turn. The compiler auto-adds IS NOT SET
  // guards so authors don't need to write them manually.
  const constraints = doc.constraints.flatMap((phase) =>
    phase.requirements.map((req) => {
      let condition = req.condition;
      let checkpoint: ConstraintCheckpoint | undefined;

      // Handle RESTRICT kind — negate the prohibited state before any WHEN/BEFORE gating.
      if (req.kind === 'restrict') {
        condition = `NOT (${condition})`;
      }

      // Handle WHEN clause — lower to implication regardless of checkpoint usage.
      if (req.when) {
        condition = `NOT (${req.when}) OR (${condition})`;
      }

      // Handle BEFORE clause — lower to checkpoint guard around the already-lowered condition.
      if (req.before) {
        if (req.before.kind === 'tool_call') {
          checkpoint = { kind: 'tool_call', target: req.before.target };
          condition = `NOT (${CONSTRAINT_CHECKPOINT_KIND_KEY} == "tool_call" AND ${CONSTRAINT_CHECKPOINT_TARGET_KEY} == "${req.before.target}") OR (${condition})`;
        } else if (req.before.kind === 'respond') {
          checkpoint = { kind: 'response' };
          condition = `NOT (${CONSTRAINT_CHECKPOINT_KIND_KEY} == "response") OR (${condition})`;
        } else {
          warnings.push({
            agent: doc.name,
            message: `W824: Constraint BEFORE target "${req.before.raw}" is not a supported structural checkpoint. The construct is retained for compatibility, but has no runtime effect; use IMPLIES or WHEN for non-structural conditions. Supported structural targets: "calling <tool>" and "returning results".`,
            type: 'validation',
            severity: 'warning',
          });
          condition = 'true';
        }
      }

      // Auto-guard: skip for checkpoint-gated constraints (they use synthetic variables)
      const finalCondition = checkpoint ? condition : autoGuardConstraint(condition);

      return {
        condition: finalCondition,
        on_fail: parseOnFail(req.onFail),
        ...(req.severity === 'warning' ? { severity: 'warning' as const } : {}),
        ...(req.kind ? { kind: req.kind } : {}),
        ...(req.when ? { applies_when: req.when } : {}),
        ...(checkpoint ? { checkpoint } : {}),
      };
    }),
  );

  return {
    config: {
      constraints,
      guardrails,
    },
    warnings,
  };
}

// =============================================================================
// CONSTRAINT AUTO-GUARD
// =============================================================================

/** Keywords and literals that are NOT variable references */
const CONSTRAINT_KEYWORDS = new Set([
  'AND',
  'OR',
  'NOT',
  'IS',
  'SET',
  'IN',
  'true',
  'false',
  'null',
  'undefined',
  'now',
  'NOW',
  'REQUIRE',
  'WARN',
  'ON_FAIL',
  'RESPOND',
  'ESCALATE',
  'HANDOFF',
  'BLOCK',
  'contains',
  'startsWith',
  'endsWith',
  'matches',
]);

/** Method names that should not be treated as variable path segments */
const CONSTRAINT_METHODS = new Set(['contains', 'startsWith', 'endsWith', 'matches']);

/**
 * Extract variable/path references from a constraint condition.
 * Filters out string literals, numbers, operators, and keywords.
 *
 * @example
 * extractVariableReferences('destination != origin') // ['destination', 'origin']
 * extractVariableReferences('check_trip.hours > 24') // ['check_trip.hours']
 * extractVariableReferences('total <= 1000 OR budget == null') // ['total', 'budget']
 */
export function extractVariableReferences(condition: string): string[] {
  // Remove string literals
  let cleaned = condition.replace(/"[^"]*"|'[^']*'/g, ' ');

  // Remove numbers (including decimals)
  cleaned = cleaned.replace(/\b\d+(\.\d+)?\b/g, ' ');

  // Find identifier tokens (including dot-paths like check_trip_status.hours)
  // Also capture an optional trailing '(' to detect function calls
  const tokenPattern = /[a-zA-Z_]\w*(?:\.\w+)*\s*(\()?/g;
  let match: RegExpExecArray | null;

  const vars = new Set<string>();
  while ((match = tokenPattern.exec(cleaned)) !== null) {
    let token = match[0].trim();
    const isCall = match[1] === '(';

    // Remove trailing '(' if present
    if (isCall) {
      token = token.slice(0, -1).trim();
    }

    // If the token is a plain function call (no dot), skip it entirely (e.g. NOW())
    if (isCall && !token.includes('.')) {
      if (CONSTRAINT_KEYWORDS.has(token)) continue;
      // Still a function call — skip
      continue;
    }

    // Handle dot-path tokens: if the last segment is a known method, extract only the receiver
    if (token.includes('.')) {
      const lastDot = token.lastIndexOf('.');
      const lastSegment = token.slice(lastDot + 1);
      if (CONSTRAINT_METHODS.has(lastSegment) || isCall) {
        // Extract only the receiver (everything before the last dot)
        const receiver = token.slice(0, lastDot);
        if (receiver && !CONSTRAINT_KEYWORDS.has(receiver)) {
          vars.add(receiver);
        }
        continue;
      }
    }

    if (!CONSTRAINT_KEYWORDS.has(token)) {
      vars.add(token);
    }
  }

  return [...vars];
}

/**
 * Auto-add IS NOT SET guards to a constraint condition.
 *
 * Constraints fire every turn. Without guards, a condition like
 * `destination != origin` fails when neither field exists yet
 * (undefined != undefined → false). This function prepends
 * `VAR IS NOT SET OR` for each variable, so the constraint is
 * skipped when referenced data hasn't been collected.
 *
 * If the condition already contains IS NOT SET or IS SET, the author
 * is handling guards explicitly — return as-is.
 *
 * @example
 * autoGuardConstraint('destination != origin')
 * // → '(destination IS NOT SET AND origin IS NOT SET) OR (destination != origin)'
 *
 * autoGuardConstraint('num_guests <= 10')
 * // → 'num_guests IS NOT SET OR num_guests <= 10'
 *
 * // Already guarded — returned unchanged:
 * autoGuardConstraint('destination IS NOT SET OR destination != origin')
 * // → 'destination IS NOT SET OR destination != origin'
 */
export function autoGuardConstraint(condition: string): string {
  // If the author already wrote IS NOT SET / IS SET guards, respect their intent.
  // Note: \b word boundaries prevent false positives from variable names containing these keywords.
  if (/\bIS\s+NOT\s+SET\b/i.test(condition) || /\bIS\s+SET\b/i.test(condition)) {
    return condition;
  }

  const vars = extractVariableReferences(condition);
  if (vars.length === 0) return condition;

  // For purely OR-based conditions (no AND), skip auto-guarding.
  // Auto-guards create tautologies with OR: "A IS NOT SET OR A != null" is always true.
  // The dual-evaluator injects null for missing vars, so OR clauses
  // safely evaluate to false without guards.
  const hasTopLevelOr = /\bOR\b/i.test(condition);
  const hasAnd = /\bAND\b/i.test(condition);
  if (hasTopLevelOr && !hasAnd) {
    return condition;
  }

  const guards = vars.map((v) => `${v} IS NOT SET`);
  if (guards.length === 1) {
    return `${guards[0]} OR ${condition}`;
  }
  return `(${guards.join(' AND ')}) OR (${condition})`;
}

// =============================================================================
// CONSTRAINT OPERATOR VALIDATION
// =============================================================================

/** Valid symbol-based comparison operators recognized by the runtime evaluator */
const VALID_SYMBOL_OPERATORS = new Set(['>=', '<=', '!=', '==', '>', '<']);

/**
 * Validate that a constraint condition uses only recognized comparison operators.
 *
 * Scans for contiguous runs of operator characters (<, >, =, !) and checks each
 * against the set of valid operators. Returns an error for each invalid operator found.
 *
 * @example
 * validateConstraintOperators('destination <<= origin', 'my_agent')
 * // → [{ agent: 'my_agent', message: 'Invalid operator "<<=" ...', type: 'validation' }]
 *
 * validateConstraintOperators('destination != origin', 'my_agent')
 * // → []
 */
export function validateConstraintOperators(
  condition: string,
  agentName: string,
): import('./schema.js').CompilationError[] {
  // Remove string literals so operators inside strings aren't flagged
  const cleaned = condition.replace(/"[^"]*"|'[^']*'/g, '""');

  // Find all contiguous runs of operator characters: <, >, =, !
  const opPattern = /[<>=!]+/g;
  const errors: import('./schema.js').CompilationError[] = [];

  let match;
  while ((match = opPattern.exec(cleaned)) !== null) {
    const op = match[0];
    if (!VALID_SYMBOL_OPERATORS.has(op)) {
      errors.push({
        agent: agentName,
        message: `Invalid operator "${op}" in constraint "${condition}". Valid operators: ==, !=, >, <, >=, <=, contains, startsWith, endsWith, matches`,
        type: 'validation',
      });
    }
  }

  return errors;
}

/**
 * Validate session memory declarations have at least one population source.
 * Warns for variables declared in MEMORY.session that are never populated by
 * GATHER fields, tool on_result/on_error, SET assignments, REMEMBER triggers,
 * HANDOFF return mappings, DELEGATE returns, RECALL inject_context, or
 * flow step branches.
 *
 * This is a soft warning — the __set_context__ system tool can set any
 * variable at runtime, so unpopulated declarations may still be valid.
 */
export function validateSessionMemoryDeclarations(
  agentIR: AgentIR,
): import('./schema.js').CompilationError[] {
  const warnings: import('./schema.js').CompilationError[] = [];
  const agentName = agentIR.metadata.name;

  const declaredVars = agentIR.memory?.session;
  if (!declaredVars || declaredVars.length === 0) return warnings;

  // Collect all known population sources
  const populated = new Set<string>();

  // 1. Top-level GATHER fields
  if (agentIR.gather?.fields) {
    for (const f of agentIR.gather.fields) {
      populated.add(f.name);
    }
  }

  // 2. Tool on_result / on_error variable mappings
  if (agentIR.tools) {
    for (const tool of agentIR.tools) {
      if (tool.on_result?.set) {
        for (const key of Object.keys(tool.on_result.set)) {
          populated.add(key.split('.')[0]); // handle dot notation
        }
      }
      if (tool.on_error?.set) {
        for (const key of Object.keys(tool.on_error.set)) {
          populated.add(key.split('.')[0]);
        }
      }
      // store_result auto-populates last_<tool>_result
      if (tool.store_result !== false) {
        populated.add(`last_${tool.name}_result`);
      }
    }
  }

  // 3. REMEMBER triggers — store.target
  if (agentIR.memory?.remember) {
    for (const r of agentIR.memory.remember) {
      populated.add(r.store.target.split('.')[0]);
    }
  }

  // 4. RECALL inject_context paths
  if (agentIR.memory?.recall) {
    for (const r of agentIR.memory.recall) {
      if (r.action?.type === 'inject_context') {
        for (const p of r.action.paths) {
          populated.add(p.split('.')[0]);
        }
      }
    }
  }

  // 5. Handoff on_return map values (child key → parent session var)
  if (agentIR.coordination?.handoffs) {
    for (const h of agentIR.coordination.handoffs) {
      if (h.on_return && typeof h.on_return === 'object' && h.on_return.map) {
        for (const parentVar of Object.values(h.on_return.map)) {
          populated.add(parentVar.split('.')[0]);
        }
      }
    }
  }

  // 6. Delegate returns values (child key → parent session var)
  if (agentIR.coordination?.delegates) {
    for (const d of agentIR.coordination.delegates) {
      if (d.returns) {
        for (const parentVar of Object.values(d.returns)) {
          populated.add(parentVar.split('.')[0]);
        }
      }
    }
  }

  // 7. Flow step sources: SET, GATHER, TRANSFORM, ON_INPUT/ON_RESULT/ON_SUCCESS/ON_FAILURE branches
  if (agentIR.flow?.definitions) {
    for (const step of Object.values(agentIR.flow.definitions)) {
      // SET assignments
      if (step.set) {
        for (const s of step.set) {
          populated.add(s.variable.split('.')[0]);
        }
      }
      // GATHER within flow step
      if (step.gather?.fields) {
        for (const f of step.gather.fields) {
          populated.add(f.name);
        }
      }
      // TRANSFORM target
      if (step.transform?.target) {
        populated.add(step.transform.target.split('.')[0]);
      }
      // ON_INPUT / ON_RESULT / ON_SUCCESS / ON_FAILURE branches with set
      const branchSources = [
        ...(step.on_input ?? []),
        ...(step.on_result ?? []),
        ...(step.on_success?.branches ?? []),
        ...(step.on_failure?.branches ?? []),
      ];
      for (const branch of branchSources) {
        if (branch.set) {
          for (const key of Object.keys(branch.set)) {
            populated.add(key.split('.')[0]);
          }
        }
      }
      // Sub-intents with set
      if (step.sub_intents) {
        for (const si of step.sub_intents) {
          if (si.set) {
            for (const key of Object.keys(si.set)) {
              populated.add(key.split('.')[0]);
            }
          }
        }
      }
    }
  }

  // Check each declared session variable
  for (const decl of declaredVars) {
    if (!populated.has(decl.name)) {
      warnings.push({
        agent: agentName,
        message: `W801: Session variable "${decl.name}" has no population source. Not populated by: GATHER fields, tool result mapping, SET assignments, REMEMBER triggers, or HANDOFF/DELEGATE returns.`,
        type: 'validation',
        severity: 'warning',
      });
    }
  }

  return warnings;
}

/**
 * Map guardrail action string to GuardrailActionType.
 * Unlike the old mapGuardrailAction which mapped 'warn' → 'respond',
 * this preserves the action type faithfully (warn stays warn).
 */
function mapGuardrailActionType(action: string): GuardrailActionType {
  switch (action) {
    case 'block':
      return 'block';
    case 'warn':
      return 'warn';
    case 'redact':
      return 'redact';
    case 'fix':
      return 'fix';
    case 'reask':
      return 'reask';
    case 'filter':
      return 'filter';
    case 'escalate':
      return 'escalate';
    default:
      return 'warn';
  }
}

/**
 * Strip surrounding double or single quotes from a string.
 * Also handles the case where only a leading quote remains
 * (the parser's regex may have already stripped the trailing quote).
 */
function stripQuotes(s: string): string {
  // Matched pair of quotes
  if (
    s.length >= 2 &&
    ((s[0] === '"' && s[s.length - 1] === '"') || (s[0] === "'" && s[s.length - 1] === "'"))
  ) {
    return s.slice(1, -1);
  }
  // Lone leading quote (trailing already stripped by parser)
  if (s.length >= 1 && (s[0] === '"' || s[0] === "'")) {
    return s.slice(1);
  }
  return s;
}

function parseOnFail(
  onFail:
    | string
    | {
        type: string;
        message?: string;
        target?: string;
        reason?: string;
        collectFields?: string[];
        thenAction?: string;
        thenStep?: string;
        respond?: string;
      }
    | { respond?: string; collect?: string[]; goto?: string; retry?: boolean; then?: string },
): import('./schema.js').ConstraintAction {
  if (typeof onFail === 'string') {
    const rawString = onFail.trim();

    // BLOCK (no args) or BLOCK "message"
    if (rawString === 'BLOCK') {
      return { type: 'block' };
    }
    if (rawString.startsWith('BLOCK ')) {
      const msg = stripQuotes(rawString.slice(6).trim());
      return { type: 'block', reason: msg, message: msg };
    }

    // RESPOND "message" — strip the keyword prefix
    if (rawString.startsWith('RESPOND ')) {
      const msg = stripQuotes(rawString.slice(8).trim());
      return { type: 'respond', message: msg };
    }

    // REDACT (no args)
    if (rawString === 'REDACT') {
      return { type: 'redact', message: undefined };
    }

    // ESCALATE reason text
    if (rawString.startsWith('ESCALATE')) {
      return { type: 'escalate', reason: rawString.replace('ESCALATE', '').trim() };
    }

    // HANDOFF target (bare HANDOFF or HANDOFF target_name)
    if (rawString === 'HANDOFF') {
      return { type: 'handoff' };
    }
    if (rawString.startsWith('HANDOFF ')) {
      const target = rawString.slice(8).trim();
      return { type: 'handoff', target: target || undefined, message: undefined };
    }

    // Default: treat as respond message
    return { type: 'respond', message: rawString };
  }

  // Handle ConstraintOnFailBlock (structured control flow block without 'type')
  if (!('type' in onFail)) {
    const block = onFail as {
      respond?: string;
      collect?: string[];
      goto?: string;
      retry?: boolean;
      then?: string;
    };
    if (block.collect && block.collect.length > 0) {
      const trimmedThen = block.then?.trim();
      const hasActionThen = trimmedThen === 'continue' || trimmedThen === 'retry';
      const thenAction = block.retry ? 'retry' : hasActionThen ? trimmedThen : undefined;
      const thenStep = block.goto ?? (trimmedThen && !hasActionThen ? trimmedThen : undefined);
      return {
        type: 'collect_field',
        message: block.respond,
        collect_fields: block.collect,
        ...(thenAction ? { then_action: thenAction } : {}),
        ...(thenStep ? { then_step: thenStep } : {}),
        ...(!thenAction && !thenStep ? { then_action: 'continue' as const } : {}),
      };
    }
    if (block.goto) {
      return {
        type: 'goto_step',
        message: block.respond,
        then_step: block.goto,
      };
    }
    if (block.retry) {
      return {
        type: 'retry_step',
        message: block.respond,
      };
    }
    // Fallback: treat as respond
    return { type: 'respond', message: block.respond ?? '' };
  }

  // Handle typed ConstraintAction variants from parser
  const typed = onFail as {
    type: string;
    message?: string;
    target?: string;
    reason?: string;
    collectFields?: string[];
    thenAction?: string;
    thenStep?: string;
    respond?: string;
  };
  switch (typed.type) {
    case 'collect_field':
      return {
        type: 'collect_field',
        message: typed.message ?? typed.respond,
        collect_fields: typed.collectFields,
        ...(typed.thenStep ? { then_step: typed.thenStep } : {}),
        ...(typed.thenStep
          ? {}
          : { then_action: (typed.thenAction as 'continue' | 'retry') ?? 'continue' }),
      };
    case 'goto_step':
      return {
        type: 'goto_step',
        message: typed.message ?? typed.respond,
        then_step: typed.thenStep ?? typed.target,
      };
    case 'retry_step':
      return {
        type: 'retry_step',
        message: typed.message ?? typed.respond,
      };
    default:
      return {
        type: typed.type as 'respond' | 'escalate' | 'handoff' | 'block' | 'redact',
        message: typed.message,
        target: typed.target,
        reason: typed.reason,
      };
  }
}

/**
 * Resolve PASS field names into typed, described ResolvedPassField objects.
 *
 * Resolution chain:
 * 1. If the field is already an object (future hybrid syntax), use it directly.
 * 2. If the field is a string, look up the name in session memory declarations
 *    to resolve type and description. Falls back to type='string' if unresolved.
 */
function resolvePassFields(
  rawPass: string[],
  sessionMemory: Array<{ name: string; type?: string; description?: string }> | undefined,
): ResolvedPassField[] {
  const memoryLookup = new Map((sessionMemory || []).map((m) => [m.name, m]));

  return rawPass.map((fieldName) => {
    const memDecl = memoryLookup.get(fieldName);
    return {
      name: fieldName,
      type: memDecl?.type || 'string',
      description: memDecl?.description,
    };
  });
}

function compileNamedReturnHandlers(
  doc: AgentBasedDocument,
): CoordinationConfig['return_handlers'] | undefined {
  if (!doc.returnHandlers || Object.keys(doc.returnHandlers).length === 0) {
    return undefined;
  }

  return Object.fromEntries(
    Object.entries(doc.returnHandlers).map(([name, handler]) => [
      name,
      {
        respond: handler.respond,
        clear: handler.clear,
        continue: handler.continue,
        resume_intent: handler.resumeIntent,
      },
    ]),
  );
}

function compileOnReturnConfig(
  doc: AgentBasedDocument,
  handoff: AgentBasedDocument['handoff'][number],
): CoordinationConfig['handoffs'][number]['on_return'] {
  if (!handoff.onReturn) {
    return undefined;
  }

  if (typeof handoff.onReturn === 'string') {
    return handoff.onReturn;
  }

  return {
    ...(handoff.onReturn.action ? { action: handoff.onReturn.action } : {}),
    ...(handoff.onReturn.handler ? { handler: handoff.onReturn.handler } : {}),
    ...(handoff.onReturn.map ? { map: handoff.onReturn.map } : {}),
  };
}

function compileCoordination(doc: AgentBasedDocument): CoordinationConfig {
  return {
    delegates: doc.delegate.map((d) => {
      const failureHandling = compileFailureHandling(d.onFailure);
      return {
        agent: d.agent,
        when: d.when,
        purpose: d.purpose,
        input: d.input,
        returns: d.returns,
        use_result: d.useResult,
        timeout: d.timeout,
        on_failure: failureHandling.action as 'continue' | 'escalate' | 'respond',
        failure_message: failureHandling.failureMessage,
        remote: d.remote?.location === 'remote' ? d.remote : undefined,
        experienceMode: d.experienceMode,
      };
    }),

    handoffs: doc.handoff.map((h) => {
      const failureHandling = compileFailureHandling(h.onFailure, {
        preserveUnknownAction: true,
      });
      return {
        to: h.to,
        when: h.when,
        context: {
          pass: resolvePassFields(h.context.pass, doc.memory.session),
          summary: h.context.summary,
          memory_grants: h.context.memoryGrants?.map((grant) => ({
            path: grant.path,
            access: grant.access ?? 'read',
          })),
          history: compileHistoryStrategy(h.context.history),
        },
        return: h.return,
        on_failure: failureHandling.action as 'continue' | 'escalate' | 'respond',
        failure_message: failureHandling.failureMessage,
        on_return: compileOnReturnConfig(doc, h),
        remote: h.remote?.location === 'remote' ? h.remote : undefined,
        async: h.async,
        asyncTimeout: h.asyncTimeout,
        experienceMode: h.experienceMode,
      };
    }),

    return_handlers: compileNamedReturnHandlers(doc),

    escalation: doc.escalate
      ? {
          triggers: doc.escalate.triggers.map((t) => ({
            when: t.when,
            reason: t.reason,
            priority: t.priority,
            tags: t.tags,
          })),
          context_for_human: doc.escalate.contextForHuman.map((c) => c.name),
          on_human_complete: doc.escalate.onHumanComplete.map((a) => ({
            condition: a.condition,
            action: typeof a.action === 'string' ? a.action : JSON.stringify(a.action),
          })),
          connector_action: doc.escalate.connectorAction,
        }
      : undefined,
  };
}

/**
 * Collect all known agent names from routing rules, handoffs, delegates,
 * and sibling agent IRs in the compilation. Used for RECALL event validation.
 */
function collectKnownAgentNames(agentIR: AgentIR, allAgentIRs: AgentIR[]): string[] {
  const agents = new Set<string>();

  // Add all sibling agent names from the compilation
  for (const ir of allAgentIRs) {
    agents.add(ir.metadata.name);
  }

  // Add routing targets
  if (agentIR.routing?.rules) {
    for (const r of agentIR.routing.rules) {
      if (r.to) agents.add(r.to);
    }
  }

  // Add handoff targets
  if (agentIR.coordination?.handoffs) {
    for (const h of agentIR.coordination.handoffs) {
      if (h.to) agents.add(h.to);
    }
  }

  // Add delegate targets
  if (agentIR.coordination?.delegates) {
    for (const d of agentIR.coordination.delegates) {
      if (d.agent) agents.add(d.agent);
    }
  }

  return [...agents];
}

function collectRemoteAgents(
  agents: Record<string, import('./schema.js').AgentIR>,
): Record<string, import('./schema.js').RemoteAgentLocation> {
  const registry: Record<string, import('./schema.js').RemoteAgentLocation> = {};

  for (const ir of Object.values(agents)) {
    if (!ir.coordination) continue;
    for (const h of ir.coordination.handoffs ?? []) {
      if (h.remote?.location === 'remote') {
        registry[h.to] = h.remote;
      }
    }
    for (const d of ir.coordination.delegates ?? []) {
      if (d.remote?.location === 'remote') {
        registry[d.agent] = d.remote;
      }
    }
  }

  return registry;
}

function compileFailureHandling(
  onFailure?: string | { type: string; message?: string },
  options?: { preserveUnknownAction?: boolean },
): {
  action: 'continue' | 'escalate' | 'respond' | string;
  failureMessage?: string;
} {
  if (!onFailure) {
    return { action: 'continue' };
  }

  if (typeof onFailure !== 'string') {
    const action = onFailure.type.toLowerCase();
    return {
      action:
        action === 'continue' || action === 'escalate' || action === 'respond'
          ? action
          : options?.preserveUnknownAction && action
            ? action
            : 'continue',
      failureMessage: 'message' in onFailure ? onFailure.message : undefined,
    };
  }

  const trimmed = onFailure.trim();
  const [actionToken] = trimmed.split(/\s+/, 1);
  const normalizedAction = actionToken?.toLowerCase();

  if (normalizedAction === 'continue') {
    return { action: 'continue' };
  }

  if (/^ESCALATE\b/i.test(trimmed)) {
    return { action: 'escalate' };
  }

  if (/^RESPOND\b/i.test(trimmed)) {
    const failureMessage = trimmed
      .replace(/^RESPOND\b/i, '')
      .trim()
      .replace(/^"|"$/g, '');
    return {
      action: 'respond',
      failureMessage: failureMessage || undefined,
    };
  }

  return {
    action: options?.preserveUnknownAction && normalizedAction ? normalizedAction : 'continue',
  };
}

function compileHistoryStrategy(
  history?: HandoffHistoryConfig,
): import('./schema.js').HistoryStrategy | undefined {
  if (!history) return undefined;

  if (typeof history === 'object') {
    const normalizedMode = history.mode.trim().toLowerCase();
    if (
      normalizedMode === 'auto' ||
      normalizedMode === 'none' ||
      normalizedMode === 'full' ||
      normalizedMode === 'summary_only'
    ) {
      return normalizedMode;
    }
    if (normalizedMode === 'last_n' && typeof history.count === 'number' && history.count > 0) {
      return { last_n: history.count };
    }
    return undefined;
  }

  const normalized = history.trim().toLowerCase();
  if (
    normalized === 'auto' ||
    normalized === 'none' ||
    normalized === 'full' ||
    normalized === 'summary_only'
  ) {
    return normalized;
  }
  // Parse last_N pattern (e.g., "last_5", "last_10")
  const lastNMatch = normalized.match(/^last_(\d+)$/);
  if (lastNMatch) {
    return { last_n: parseInt(lastNMatch[1], 10) };
  }
  return undefined;
}

function compileVoiceConfig(ast: VoiceConfigAST | undefined): VoiceConfigIR | undefined {
  if (!ast) return undefined;
  return {
    ssml: ast.ssml,
    instructions: ast.instructions,
    plain_text: ast.plainText ?? ast.plain_text,
    provider: ast.provider,
    voice_id: ast.voiceId ?? ast.voice_id,
    speed: ast.speed,
  };
}

type RichContentCollectionBinding<TItem> = { from: string; template?: TItem };

function isRichContentCollectionBinding<TItem>(
  value: unknown,
): value is RichContentCollectionBinding<TItem> {
  return Boolean(
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    typeof (value as Record<string, unknown>).from === 'string',
  );
}

function compileRichContentCollection<TAstItem, TIrItem>(
  collection: TAstItem[] | RichContentCollectionBinding<TAstItem> | string,
  compileItem: (item: TAstItem) => TIrItem,
): unknown {
  if (typeof collection === 'string') {
    return collection;
  }

  if (Array.isArray(collection)) {
    return collection.map((item) => compileItem(item));
  }

  if (isRichContentCollectionBinding<TAstItem>(collection)) {
    return collection.template
      ? { from: collection.from, template: compileItem(collection.template) }
      : { from: collection.from };
  }

  return [];
}

function compileActionElement(b: import('@abl/core').ActionElementAST): ActionElementIR {
  return {
    id: b.id,
    type: b.type,
    label: b.label,
    value: b.value,
    description: b.description,
    options: b.options
      ? (compileRichContentCollection(b.options, (option) => ({
          id: option.id,
          label: option.label,
          description: option.description,
        })) as ActionElementIR['options'])
      : undefined,
    input_type: b.inputType,
    placeholder: b.placeholder,
    required: b.required,
  };
}

function compileRichContent(ast: RichContentAST | undefined): RichContentIR | undefined {
  if (!ast) return undefined;
  const result: RichContentIR = {};
  if (ast.markdown) result.markdown = ast.markdown;
  if (ast.adaptiveCard) result.adaptive_card = ast.adaptiveCard;
  if (ast.html) result.html = ast.html;
  if (ast.slack) result.slack = ast.slack;
  if (ast.agUi) result.ag_ui = ast.agUi;
  if (ast.whatsapp) result.whatsapp = ast.whatsapp;
  if (ast.carousel) {
    result.carousel = {
      cards: compileRichContentCollection(ast.carousel.cards, (card) => ({
        title: card.title,
        subtitle: card.subtitle,
        image_url: card.imageUrl,
        default_action_url: card.defaultActionUrl,
        buttons: card.buttons ? card.buttons.map((b) => compileActionElement(b)) : undefined,
      })) as import('./schema.js').CarouselIR['cards'],
    };
  }

  // --- Tier 1: Basic Templates ---
  if (ast.quickReplies) {
    result.quick_replies = compileRichContentCollection(ast.quickReplies, (qr) => ({
      id: qr.id,
      label: qr.label,
      icon_url: qr.iconUrl,
    })) as import('./schema.js').RichContentIR['quick_replies'];
  }
  if (ast.list) {
    result.list = {
      title: ast.list.title,
      items: compileRichContentCollection(ast.list.items, (item) => ({
        title: item.title,
        subtitle: item.subtitle,
        image_url: item.imageUrl,
        default_action_url: item.defaultActionUrl,
      })) as import('./schema.js').ListTemplateIR['items'],
    };
  }
  if (ast.image) {
    result.image = {
      url: ast.image.url,
      alt: ast.image.alt,
      thumbnail_url: ast.image.thumbnailUrl,
      caption: ast.image.caption,
    };
  }
  if (ast.video) {
    result.video = {
      url: ast.video.url,
      alt: ast.video.alt,
      thumbnail_url: ast.video.thumbnailUrl,
      caption: ast.video.caption,
    };
  }
  if (ast.audio) {
    result.audio = {
      url: ast.audio.url,
      alt: ast.audio.alt,
      thumbnail_url: ast.audio.thumbnailUrl,
      caption: ast.audio.caption,
    };
  }
  if (ast.file) {
    result.file = {
      url: ast.file.url,
      filename: ast.file.filename,
      size_bytes: ast.file.sizeBytes,
      mime_type: ast.file.mimeType,
    };
  }

  // --- Tier 2: Data-Rich Templates ---
  if (ast.kpi) {
    result.kpi = {
      label: ast.kpi.label,
      value: ast.kpi.value,
      unit: ast.kpi.unit,
      trend: ast.kpi.trend,
      icon_url: ast.kpi.iconUrl,
    };
  }
  if (ast.table) {
    result.table = {
      columns: compileRichContentCollection(ast.table.columns, (col) => ({
        key: col.key,
        header: col.header,
        align: col.align,
      })) as import('./schema.js').TableTemplateIR['columns'],
      rows: ast.table.rows as import('./schema.js').TableTemplateIR['rows'],
      max_visible_rows: ast.table.maxVisibleRows,
    };
  }
  if (ast.chart) {
    result.chart = {
      type: ast.chart.type,
      title: ast.chart.title,
      data: compileRichContentCollection(ast.chart.data, (dp) => ({
        label: dp.label,
        value: dp.value,
        color: dp.color,
      })) as import('./schema.js').ChartTemplateIR['data'],
    };
  }
  if (ast.form) {
    result.form = {
      title: ast.form.title,
      fields: compileRichContentCollection(ast.form.fields, (f) =>
        compileActionElement(f),
      ) as import('./schema.js').FormTemplateIR['fields'],
      submit_label: ast.form.submitLabel,
    };
  }
  if (ast.progress) {
    result.progress = {
      label: ast.progress.label,
      value: ast.progress.value,
      max: ast.progress.max,
      variant: ast.progress.variant,
    };
  }
  if (ast.feedback) {
    result.feedback = {
      prompt: ast.feedback.prompt,
      type: ast.feedback.type,
      max: ast.feedback.max,
    };
  }

  return Object.keys(result).length > 0 ? result : undefined;
}

function compileActions(ast: ActionSetAST | undefined): ActionSetIR | undefined {
  if (!ast || ast.elements.length === 0) return undefined;
  return {
    elements: ast.elements.map((e) => compileActionElement(e)),
    submit_label: ast.submitLabel,
    submit_id: ast.submitId,
    renderId: ast.renderId,
  };
}

function extractCallToolName(call: string | undefined): string | undefined {
  if (!call) return undefined;
  const trimmed = call.trim();
  if (!trimmed) return undefined;
  const toolNameMatch = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)(?:\s*\(|$)/);
  return toolNameMatch?.[1];
}

function compileToolInvocation(
  invocation:
    | {
        call?: string;
        callWith?: Record<string, unknown>;
        callAs?: string;
        callSpec?: ToolInvocationAST;
      }
    | undefined,
): ToolInvocationIR | undefined {
  if (!invocation) {
    return undefined;
  }

  const tool =
    invocation.callSpec?.tool ??
    extractCallToolName(invocation.call) ??
    (typeof invocation.call === 'string' && invocation.call.trim().length > 0
      ? invocation.call.trim()
      : undefined);

  if (!tool) {
    return undefined;
  }

  const withValues = invocation.callSpec?.with ?? invocation.callWith;
  const asValue = invocation.callSpec?.as ?? invocation.callAs;

  return {
    tool,
    ...(withValues ? { with: { ...withValues } } : {}),
    ...(asValue ? { as: asValue } : {}),
  };
}

function compileActionHandlerAction(action: ActionHandlerActionAST): ActionHandlerActionIR {
  const compiled: ActionHandlerActionIR = {};

  if (action.respond !== undefined) {
    compiled.respond = action.respond;
    compiled.voice_config = compileVoiceConfig(action.voiceConfig);
    compiled.rich_content = compileRichContent(action.richContent);
    compiled.actions = compileActions(action.actions);
  }
  if (action.set) {
    compiled.set = { ...action.set };
  }
  if (action.clear) {
    compiled.clear = [...action.clear];
  }
  if (action.call || action.callSpec) {
    compiled.call = action.call;
    compiled.result_key = action.resultKey ?? action.callSpec?.as;
    compiled.call_spec = compileToolInvocation({
      call: action.call,
      callAs: action.resultKey,
      callSpec: action.callSpec,
    });
  }
  if (action.handoff) {
    compiled.handoff = action.handoff;
  }
  if (action.delegate) {
    compiled.delegate = action.delegate;
    compiled.return = action.return;
    compiled.on_return = action.onReturn ? { map: action.onReturn.map } : undefined;
  }
  if (action.goto) {
    compiled.goto = action.goto;
  }
  if (action.complete !== undefined) {
    compiled.complete = action.complete;
  }

  return compiled;
}

function lowerLegacyActionHandlerFields(handler: ActionHandlerAST): ActionHandlerActionAST[] {
  const actions: ActionHandlerActionAST[] = [];
  if (handler.set) {
    actions.push({ set: { ...handler.set } });
  }
  if (handler.respond !== undefined) {
    actions.push({
      respond: handler.respond,
      voiceConfig: handler.voiceConfig,
      richContent: handler.richContent,
      actions: handler.actions,
    });
  }
  if (handler.transition) {
    actions.push({ goto: handler.transition });
  }
  return actions;
}

function compileActionHandlers(
  handlers: ActionHandlerAST[] | undefined,
): ActionHandlerIR[] | undefined {
  if (!handlers || handlers.length === 0) return undefined;
  return handlers.map((h) => {
    const orderedActions = h.do && h.do.length > 0 ? h.do : lowerLegacyActionHandlerFields(h);
    const handler: ActionHandlerIR = {
      action_id: h.actionId,
      condition: h.condition,
      do:
        orderedActions.length > 0
          ? orderedActions.map((action) => compileActionHandlerAction(action))
          : undefined,
      respond: h.respond,
      voice_config: compileVoiceConfig(h.voiceConfig),
      rich_content: compileRichContent(h.richContent),
      actions: compileActions(h.actions),
      set: h.set,
      transition: h.transition,
    };
    syncActionHandlerCompatibilityMirrors(handler);
    return handler;
  });
}

function compileCompletion(doc: AgentBasedDocument): CompletionConfig {
  return {
    conditions: doc.complete.map((c) => ({
      when: c.when,
      respond: c.respond,
      voice_config: compileVoiceConfig(c.voiceConfig),
      rich_content: compileRichContent(c.richContent),
      actions: compileActions(c.actions),
      store: c.store,
    })),
  };
}

function compileErrorHandling(doc: AgentBasedDocument): ErrorHandlingConfig {
  const defaultHandlerAst = doc.onError.find((h) => h.type.trim().toLowerCase() === 'default');
  const handlers = doc.onError
    .filter((h) => h !== defaultHandlerAst)
    .map((h) => ({
      type: h.type,
      subtypes: h.subtypes,
      respond: h.respond,
      voice_config: compileVoiceConfig(h.voiceConfig),
      rich_content: compileRichContent(h.richContent),
      actions: compileActions(h.actions),
      retry: h.retry,
      retry_delay_ms: h.retryDelay ?? 1000,
      retry_backoff: h.retryBackoff,
      retry_max_delay_ms: h.retryMaxDelay,
      then: parseErrorThen(h.then),
      handoff_target: extractHandoffTarget(h.then),
      backtrack_to: h.backtrackTo,
    }));

  return {
    handlers,
    default_handler: defaultHandlerAst
      ? {
          type: defaultHandlerAst.type,
          subtypes: defaultHandlerAst.subtypes,
          respond: defaultHandlerAst.respond,
          voice_config: compileVoiceConfig(defaultHandlerAst.voiceConfig),
          rich_content: compileRichContent(defaultHandlerAst.richContent),
          actions: compileActions(defaultHandlerAst.actions),
          retry: defaultHandlerAst.retry,
          retry_delay_ms: defaultHandlerAst.retryDelay ?? 1000,
          retry_backoff: defaultHandlerAst.retryBackoff,
          retry_max_delay_ms: defaultHandlerAst.retryMaxDelay,
          then: parseErrorThen(defaultHandlerAst.then),
          handoff_target: extractHandoffTarget(defaultHandlerAst.then),
          backtrack_to: defaultHandlerAst.backtrackTo,
        }
      : {
          type: 'default',
          respond: doc.messages?.error_default ?? DEFAULT_MESSAGES.error_default,
          retry: 1,
          retry_delay_ms: 1000,
          then: 'continue',
        },
  };
}

function parseErrorThen(
  then?: string | { type: string },
): 'continue' | 'escalate' | 'handoff' | 'complete' | 'backtrack' | 'retry_step' {
  if (!then) return 'continue';
  const thenStr = typeof then === 'string' ? then : (then.type ?? '');
  if (thenStr.includes('RETRY_STEP')) return 'retry_step';
  if (thenStr.includes('BACKTRACK')) return 'backtrack';
  if (thenStr.includes('ESCALATE')) return 'escalate';
  if (thenStr.includes('HANDOFF')) return 'handoff';
  if (thenStr.includes('COMPLETE')) return 'complete';
  return 'continue';
}

function extractHandoffTarget(then?: string | { type: string }): string | undefined {
  if (!then) return undefined;
  if (typeof then !== 'string') return undefined;
  if (then.includes('HANDOFF ')) {
    return then.replace('HANDOFF ', '').trim();
  }
  return undefined;
}

/**
 * Compile ON_START handler to IR StartConfig
 */
function compileStartConfig(handler: {
  respond?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  call?: string;
  callSpec?: ToolInvocationAST;
  set?: Record<string, string>;
  delegate?: string;
}): StartConfig {
  return {
    respond: handler.respond,
    voice_config: compileVoiceConfig(handler.voiceConfig),
    rich_content: compileRichContent(handler.richContent),
    actions: compileActions(handler.actions),
    call: handler.call,
    call_spec: compileToolInvocation({
      call: handler.call,
      callSpec: handler.callSpec,
    }),
    set: handler.set ? { ...handler.set } : undefined,
    delegate: handler.delegate,
  };
}

function compileDigressionAction(action: DigressionActionAST): DigressionAction {
  const compiled: DigressionAction = {};

  if (action.respond !== undefined) {
    compiled.respond = action.respond;
    compiled.message_key = action.messageKey;
    compiled.voice_config = compileVoiceConfig(action.voiceConfig);
    compiled.rich_content = compileRichContent(action.richContent);
    compiled.actions = compileActions(action.actions);
  }
  if (action.set) {
    compiled.set = { ...action.set };
  }
  if (action.clear) {
    compiled.clear = [...action.clear];
  }
  if (action.call || action.callSpec) {
    compiled.call = action.call;
    compiled.call_spec = compileToolInvocation({
      call: action.call,
      callSpec: action.callSpec,
    });
  }
  if (action.delegate) {
    compiled.delegate = action.delegate;
    compiled.return = action.return;
    compiled.on_return = action.onReturn ? { map: action.onReturn.map } : undefined;
  }
  if (action.resume !== undefined) {
    compiled.resume = action.resume;
  }
  if (action.goto) {
    compiled.goto = action.goto;
  }

  return compiled;
}

function buildLegacyDigressionActions(digression: {
  respond?: string;
  messageKey?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  clear?: string[];
  call?: string;
  callSpec?: ToolInvocationAST;
  delegate?: string;
  goto?: string;
  resume?: boolean;
}): DigressionAction[] {
  const actions: DigressionAction[] = [];

  if (digression.respond !== undefined) {
    actions.push({
      respond: digression.respond,
      message_key: digression.messageKey,
      voice_config: compileVoiceConfig(digression.voiceConfig),
      rich_content: compileRichContent(digression.richContent),
      actions: compileActions(digression.actions),
    });
  }
  if (digression.clear?.length) {
    actions.push({ clear: [...digression.clear] });
  }
  if (digression.call || digression.callSpec) {
    actions.push({
      call: digression.call,
      call_spec: compileToolInvocation({
        call: digression.call,
        callSpec: digression.callSpec,
      }),
    });
  }
  if (digression.delegate) {
    actions.push({ delegate: digression.delegate });
  }
  if (digression.goto) {
    actions.push({ goto: digression.goto });
  } else if (digression.resume) {
    actions.push({ resume: true });
  }

  return actions;
}

function extractLegacyDigressionCompatibility(actions: DigressionAction[]): {
  respond?: string;
  message_key?: string;
  voice_config?: VoiceConfigIR;
  rich_content?: RichContentIR;
  actions?: ActionSetIR;
  goto?: string;
  delegate?: string;
  call?: string;
  call_spec?: ToolInvocationIR;
  resume?: boolean;
  clear?: string[];
} {
  const compatibility: {
    respond?: string;
    message_key?: string;
    voice_config?: VoiceConfigIR;
    rich_content?: RichContentIR;
    actions?: ActionSetIR;
    goto?: string;
    delegate?: string;
    call?: string;
    call_spec?: ToolInvocationIR;
    resume?: boolean;
    clear?: string[];
  } = {};

  for (const action of actions) {
    if (compatibility.respond === undefined && action.respond !== undefined) {
      compatibility.respond = action.respond;
      compatibility.message_key = action.message_key;
      compatibility.voice_config = action.voice_config;
      compatibility.rich_content = action.rich_content;
      compatibility.actions = action.actions;
    }
    if (compatibility.clear === undefined && action.clear) {
      compatibility.clear = [...action.clear];
    }
    if (compatibility.call === undefined && action.call) {
      compatibility.call = action.call;
    }
    if (compatibility.call_spec === undefined && action.call_spec) {
      compatibility.call_spec = action.call_spec;
    }
    if (compatibility.delegate === undefined && action.delegate) {
      compatibility.delegate = action.delegate;
    }
    if (compatibility.goto === undefined && action.goto) {
      compatibility.goto = action.goto;
    }
    if (compatibility.resume === undefined && action.resume !== undefined) {
      compatibility.resume = action.resume;
    }
  }

  return compatibility;
}

function compileDigression(digression: {
  intent: string;
  keywords?: string[];
  condition?: string;
  do?: DigressionActionAST[];
  respond?: string;
  messageKey?: string;
  voiceConfig?: VoiceConfigAST;
  richContent?: RichContentAST;
  actions?: ActionSetAST;
  goto?: string;
  delegate?: string;
  call?: string;
  callSpec?: ToolInvocationAST;
  resume?: boolean;
  clear?: string[];
}) {
  const actions =
    digression.do && digression.do.length > 0
      ? digression.do.map(compileDigressionAction)
      : buildLegacyDigressionActions(digression);
  const compatibility = extractLegacyDigressionCompatibility(actions);

  return {
    intent: digression.intent,
    keywords: digression.keywords,
    condition: digression.condition,
    do: actions,
    respond: compatibility.respond,
    message_key: compatibility.message_key,
    voice_config: compatibility.voice_config,
    rich_content: compatibility.rich_content,
    actions: compatibility.actions,
    goto: compatibility.goto,
    delegate: compatibility.delegate,
    call: compatibility.call,
    call_spec: compatibility.call_spec,
    resume: compatibility.resume,
    clear: compatibility.clear,
  };
}

function compileFlow(
  flow: {
    steps: string[];
    entryPoint?: string;
    globalDigressions?: Array<{
      intent: string;
      keywords?: string[];
      condition?: string;
      do?: DigressionActionAST[];
      respond?: string;
      messageKey?: string;
      voiceConfig?: VoiceConfigAST;
      richContent?: RichContentAST;
      actions?: ActionSetAST;
      goto?: string;
      delegate?: string;
      call?: string;
      resume?: boolean;
      clear?: string[];
    }>;
    definitions: Record<
      string,
      {
        name: string;
        // Reasoning zone fields
        reasoning?: boolean;
        goal?: string;
        availableTools?: string[];
        exitWhen?: string;
        maxTurns?: number;
        stepConstraints?: string[];
        // GATHER fields
        gather?: {
          fields: Array<{
            name: string;
            entityRef?: string;
            type?: string;
            required?: boolean;
            default?: unknown;
            prompt?: string;
            messageKey?: string;
            validation?: string;
            validationProcess?: 'REGEX' | 'CODE' | 'LLM';
            retryPrompt?: string;
            maxRetries?: number;
            extractionHints?: string[];
            infer?: boolean;
            inferConfidence?: number;
            inferConfirm?: boolean;
            semantics?: import('@abl/core').GatherFieldSemantics;
            options?: string[];
            range?: boolean;
            list?: boolean;
            preferences?: boolean;
            activation?: import('@abl/core').GatherActivation;
            dependsOn?: string[];
            promptMode?: 'ask' | 'extract_only';
            richContent?: RichContentAST;
            sensitive?: boolean;
            sensitiveDisplay?: 'redact' | 'mask' | 'replace';
            maskConfig?: { showFirst: number; showLast: number; char: string };
            piiType?: 'email' | 'phone' | 'ssn' | 'credit_card' | 'address' | 'name' | 'custom';
            transient?: boolean;
          }>;
          strategy?: 'llm' | 'pattern' | 'hybrid';
          prompt?: string;
          messageKey?: string;
        };
        present?: string;
        corrections?: boolean;
        completeWhen?: string;
        awaitAttachment?: {
          name: string;
          prompt: string;
          category?: 'image' | 'document' | 'audio' | 'video';
          required?: boolean;
          timeout?: number;
          onTimeout?: string;
        };
        set?: Array<{ variable: string; expression: string }>;
        clear?: string[];
        transform?: {
          source: string;
          itemVar: string;
          target: string;
          filter?: string;
          map?: Record<string, string>;
          sortBy?: { field: string; order: 'asc' | 'desc' };
          limit?: number;
        };
        call?: string;
        callWith?: Record<string, string>;
        callAs?: string;
        callSpec?: ToolInvocationAST;
        check?: string;
        respond?: string;
        messageKey?: string;
        voiceConfig?: VoiceConfigAST;
        richContent?: RichContentAST;
        actions?: ActionSetAST;
        onAction?: ActionHandlerAST[];
        onFail?: string;
        then?: string;
        onInput?: Array<{
          condition?: string;
          respond?: string;
          messageKey?: string;
          voiceConfig?: VoiceConfigAST;
          richContent?: RichContentAST;
          actions?: ActionSetAST;
          set?: Record<string, string>;
          call?: string;
          callSpec?: ToolInvocationAST;
          then: string;
        }>;
        onResult?: Array<{
          condition?: string;
          respond?: string;
          messageKey?: string;
          voiceConfig?: VoiceConfigAST;
          richContent?: RichContentAST;
          actions?: ActionSetAST;
          set?: Record<string, string>;
          call?: string;
          callSpec?: ToolInvocationAST;
          then: string;
        }>;
        onSuccess?: {
          respond?: string;
          messageKey?: string;
          voiceConfig?: VoiceConfigAST;
          richContent?: RichContentAST;
          actions?: ActionSetAST;
          set?: Record<string, string>;
          then?: string;
          branches?: Array<{
            condition?: string;
            respond?: string;
            messageKey?: string;
            voiceConfig?: VoiceConfigAST;
            richContent?: RichContentAST;
            actions?: ActionSetAST;
            set?: Record<string, string>;
            call?: string;
            callSpec?: ToolInvocationAST;
            then?: string;
          }>;
        };
        onFailure?: {
          respond?: string;
          messageKey?: string;
          voiceConfig?: VoiceConfigAST;
          richContent?: RichContentAST;
          actions?: ActionSetAST;
          set?: Record<string, string>;
          then?: string;
          branches?: Array<{
            condition?: string;
            respond?: string;
            messageKey?: string;
            voiceConfig?: VoiceConfigAST;
            richContent?: RichContentAST;
            actions?: ActionSetAST;
            set?: Record<string, string>;
            call?: string;
            callSpec?: ToolInvocationAST;
            then?: string;
          }>;
        };
        digressions?: Array<{
          intent: string;
          keywords?: string[];
          condition?: string;
          do?: DigressionActionAST[];
          respond?: string;
          messageKey?: string;
          voiceConfig?: VoiceConfigAST;
          richContent?: RichContentAST;
          actions?: ActionSetAST;
          goto?: string;
          delegate?: string;
          call?: string;
          callSpec?: ToolInvocationAST;
          resume?: boolean;
          clear?: string[];
        }>;
        subIntents?: Array<{
          intent: string;
          respond?: string;
          messageKey?: string;
          voiceConfig?: VoiceConfigAST;
          richContent?: RichContentAST;
          actions?: ActionSetAST;
          clear?: string[];
          set?: Record<string, string>;
          call?: string;
          callSpec?: ToolInvocationAST;
          resume?: boolean;
        }>;
      }
    >;
  },
  constraintConfig?: ConstraintConfig,
  agentName?: string,
  topLevelGather: AgentBasedDocument['gather'] = [],
): FlowConfig {
  const topLevelGatherFieldsByName = new Map(topLevelGather.map((field) => [field.name, field]));
  type FlowStepDefinition = (typeof flow.definitions)[string];
  type FlowGatherField = NonNullable<FlowStepDefinition['gather']>['fields'][number];

  const resolveFlowGatherFields = (fields: FlowGatherField[]): FlowGatherField[] =>
    fields.map((field) => {
      const inherited = topLevelGatherFieldsByName.get(field.name);
      if (!inherited) {
        return field;
      }

      const hasStepSpecificMetadata = Object.entries(field).some(
        ([key, value]) => key !== 'name' && key !== 'required' && value !== undefined,
      );
      const overrides = Object.fromEntries(
        Object.entries(field).filter(
          ([key, value]) =>
            value !== undefined &&
            (hasStepSpecificMetadata || (key !== 'required' && key !== 'name')),
        ),
      );

      return { ...inherited, ...overrides, name: field.name } as FlowGatherField;
    });

  // Build the flow config first
  const flowConfig: FlowConfig = {
    steps: flow.steps,
    global_digressions: flow.globalDigressions?.map((d) => compileDigression(d)),
    definitions: Object.fromEntries(
      Object.entries(flow.definitions).map(([name, step]) => [
        name,
        {
          name: step.name,
          // Reasoning zone (compiled from REASONING: true)
          reasoning_zone: step.reasoning
            ? {
                goal: step.goal ?? '',
                available_tools: step.availableTools,
                exit_when: step.exitWhen ?? step.completeWhen,
                max_turns: step.maxTurns ?? 10,
                constraints: step.stepConstraints,
              }
            : undefined,
          // Enhanced GATHER within FLOW
          gather: step.gather
            ? {
                fields: resolveFlowGatherFields(step.gather.fields).map((f) => ({
                  name: f.name,
                  entity_ref: f.entityRef,
                  type: f.type,
                  required: f.required,
                  default: f.default,
                  prompt: f.prompt,
                  message_key: f.messageKey,
                  validation: f.validation
                    ? (() => {
                        const vType = resolveValidationType(f.validationProcess);
                        if (vType === 'pattern') {
                          validateRegexAtCompile(f.validation, f.name, agentName ?? 'unknown');
                        }
                        return {
                          type: vType,
                          rule: f.validation,
                          error_message: `Invalid ${f.name}`,
                          retry_prompt: f.retryPrompt,
                          max_retries: f.maxRetries,
                          validation_process: f.validationProcess,
                        };
                      })()
                    : f.retryPrompt || f.maxRetries || f.validationProcess
                      ? {
                          type: resolveValidationType(f.validationProcess),
                          rule: '',
                          error_message: `Invalid ${f.name}`,
                          retry_prompt: f.retryPrompt,
                          max_retries: f.maxRetries,
                          validation_process: f.validationProcess,
                        }
                      : undefined,
                  extraction_hints: f.extractionHints,
                  infer: f.infer,
                  infer_confidence: f.inferConfidence,
                  infer_confirm: f.inferConfirm,
                  semantics: f.semantics
                    ? {
                        format: f.semantics.format,
                        components: f.semantics.components,
                        unit: f.semantics.unit,
                        lookup: f.semantics.lookup,
                        convert_to: f.semantics.convertTo,
                        locale: f.semantics.locale,
                        kore_entity_type: f.semantics.koreEntityType,
                        enum_set: f.semantics.enumSet,
                      }
                    : undefined,
                  range: f.range,
                  list: f.list,
                  preferences: f.preferences,
                  activation: f.activation,
                  depends_on: f.dependsOn,
                  prompt_mode: f.promptMode,
                  rich_content: compileRichContent(f.richContent),
                  pii_type: f.piiType,
                  enum_values: f.options?.length
                    ? f.options
                    : f.semantics?.enumSet?.length
                      ? f.semantics.enumSet
                      : undefined,
                  sensitive: f.sensitive,
                  sensitive_display: f.sensitiveDisplay,
                  mask_config: f.maskConfig
                    ? {
                        show_first: f.maskConfig.showFirst,
                        show_last: f.maskConfig.showLast,
                        char: f.maskConfig.char,
                      }
                    : undefined,
                  transient: f.transient,
                })),
                strategy: step.gather.strategy,
                prompt: step.gather.prompt,
                message_key: step.gather.messageKey,
              }
            : undefined,
          present: step.present,
          corrections: step.corrections,
          complete_when: step.completeWhen,
          // Attachment collection
          await_attachment: step.awaitAttachment
            ? {
                variable: step.awaitAttachment.name,
                prompt: step.awaitAttachment.prompt,
                category: step.awaitAttachment.category,
                required: step.awaitAttachment.required ?? true,
                timeout_seconds: step.awaitAttachment.timeout,
                on_timeout: step.awaitAttachment.onTimeout,
              }
            : undefined,
          // Computed assignments
          set: step.set?.map((s) => ({ variable: s.variable, expression: s.expression })),
          clear: step.clear,
          // Data transformation
          transform: step.transform
            ? {
                source: step.transform.source,
                item_var: step.transform.itemVar,
                target: step.transform.target,
                filter: step.transform.filter,
                map: step.transform.map,
                sort_by: step.transform.sortBy,
                limit: step.transform.limit,
              }
            : undefined,
          // Actions
          call: step.call,
          call_spec: compileToolInvocation({
            call: step.call,
            callWith: step.callWith,
            callAs: step.callAs,
            callSpec: step.callSpec,
          }),
          call_with: step.callWith,
          call_as: step.callAs,
          check: step.check,
          respond: step.respond,
          message_key: step.messageKey,
          voice_config: compileVoiceConfig(step.voiceConfig),
          rich_content: compileRichContent(step.richContent),
          actions: compileActions(step.actions),
          on_action: compileActionHandlers(step.onAction),
          on_fail: step.onFail,
          then: step.then,
          // Call result branches
          on_success: step.onSuccess
            ? {
                respond: step.onSuccess.respond,
                message_key: step.onSuccess.messageKey,
                voice_config: compileVoiceConfig(step.onSuccess.voiceConfig),
                rich_content: compileRichContent(step.onSuccess.richContent),
                actions: compileActions(step.onSuccess.actions),
                set: step.onSuccess.set,
                then: step.onSuccess.then,
                branches: step.onSuccess.branches?.map((b) => ({
                  condition: b.condition,
                  respond: b.respond,
                  message_key: b.messageKey,
                  voice_config: compileVoiceConfig(b.voiceConfig),
                  rich_content: compileRichContent(b.richContent),
                  actions: compileActions(b.actions),
                  set: b.set,
                  call: b.call,
                  call_spec: compileToolInvocation({
                    call: b.call,
                    callSpec: b.callSpec,
                  }),
                  then: b.then || '',
                })),
              }
            : undefined,
          on_failure: step.onFailure
            ? {
                respond: step.onFailure.respond,
                message_key: step.onFailure.messageKey,
                voice_config: compileVoiceConfig(step.onFailure.voiceConfig),
                rich_content: compileRichContent(step.onFailure.richContent),
                actions: compileActions(step.onFailure.actions),
                set: step.onFailure.set,
                then: step.onFailure.then,
                branches: step.onFailure.branches?.map((b) => ({
                  condition: b.condition,
                  respond: b.respond,
                  message_key: b.messageKey,
                  voice_config: compileVoiceConfig(b.voiceConfig),
                  rich_content: compileRichContent(b.richContent),
                  actions: compileActions(b.actions),
                  set: b.set,
                  call: b.call,
                  call_spec: compileToolInvocation({
                    call: b.call,
                    callSpec: b.callSpec,
                  }),
                  then: b.then || '',
                })),
              }
            : undefined,
          // Multi-way branching on tool results or deterministic flow context
          on_result: step.onResult?.map((branch) => ({
            condition: branch.condition,
            respond: branch.respond,
            message_key: branch.messageKey,
            voice_config: compileVoiceConfig(branch.voiceConfig),
            rich_content: compileRichContent(branch.richContent),
            actions: compileActions(branch.actions),
            set: branch.set,
            call: branch.call,
            call_spec: compileToolInvocation({
              call: branch.call,
              callSpec: branch.callSpec,
            }),
            then: branch.then,
          })),
          // Legacy branching
          on_input: step.onInput?.map((branch) => ({
            condition: branch.condition,
            respond: branch.respond,
            message_key: branch.messageKey,
            voice_config: compileVoiceConfig(branch.voiceConfig),
            rich_content: compileRichContent(branch.richContent),
            actions: compileActions(branch.actions),
            set: branch.set,
            call: branch.call,
            call_spec: compileToolInvocation({
              call: branch.call,
              callSpec: branch.callSpec,
            }),
            then: branch.then,
          })),
          // Intent handling
          digressions: step.digressions?.map((d) => compileDigression(d)),
          sub_intents: step.subIntents?.map((s) => ({
            intent: s.intent,
            respond: s.respond,
            message_key: s.messageKey,
            voice_config: compileVoiceConfig(s.voiceConfig),
            rich_content: compileRichContent(s.richContent),
            actions: compileActions(s.actions),
            clear: s.clear,
            set: s.set,
            call: s.call,
            call_spec: compileToolInvocation({
              call: s.call,
              callSpec: s.callSpec,
            }),
            resume: s.resume,
          })),
        },
      ]),
    ),
    entry_point:
      flow.entryPoint || (flow.steps && flow.steps.length > 0 ? flow.steps[0] : undefined),
  };

  // Extract static graph for state machine visualization
  // Pass constraint config to enable guard nodes for CHECK constraints
  flowConfig.staticGraph = extractStaticGraph(flowConfig, constraintConfig);

  return flowConfig;
}

// =============================================================================
// ANALYSIS FUNCTIONS
// =============================================================================

function analyzeRuntimeHints(doc: AgentBasedDocument): RuntimeHints {
  const hasHITL = !!doc.escalate?.triggers.length;
  const hasPersistentMemory = doc.memory.persistent.length > 0;
  const hasComplexCoordination = doc.delegate.length > 0 || doc.handoff.length > 2;

  return {
    // Voice optimization should be declared explicitly in the DSL, not inferred.
    // Default to false until an explicit VOICE_OPTIMIZED property is supported.
    voice_optimized: false,
    requires_persistence: hasPersistentMemory || doc.handoff.some((h) => h.return),
    supports_hitl: hasHITL,
    parallel_tools: doc.tools.length > 1,
    complexity: hasComplexCoordination
      ? 'complex'
      : doc.constraints.length > 2
        ? 'moderate'
        : 'simple',
  };
}

function analyzeDeployment(agents: Record<string, AgentIR>, entryAgent?: string): DeploymentHints {
  const recommendations: Record<string, 'voice' | 'digital' | 'workflow'> = {};
  const parallelSafe: string[] = [];
  const stateful: string[] = [];
  const hitlCapable: string[] = [];

  for (const [name, agent] of Object.entries(agents)) {
    // Supervisors (agents with routing) are always digital + stateful
    if (agent.routing?.rules?.length) {
      recommendations[name] = 'digital';
      stateful.push(name);
      continue;
    }

    // Determine recommended runtime
    if (agent.execution.hints.supports_hitl) {
      recommendations[name] = 'workflow';
      hitlCapable.push(name);
    } else if (agent.execution.hints.voice_optimized) {
      recommendations[name] = 'voice';
    } else {
      recommendations[name] = 'digital';
    }

    // Check parallel safety (no side effects in tools)
    const hasSideEffects = agent.tools.some((t) => t.hints.side_effects);
    if (!hasSideEffects) {
      parallelSafe.push(name);
    }

    // Check statefulness
    if (agent.execution.hints.requires_persistence) {
      stateful.push(name);
    }
  }

  return {
    runtime_recommendations: recommendations,
    parallel_safe: parallelSafe,
    stateful,
    hitl_capable: hitlCapable,
  };
}

function extractIntentCategories(doc: AgentBasedDocument): {
  categories: IntentCategory[];
  source: 'explicit' | 'inferred';
} {
  // Explicit mode: INTENTS: block is declared
  if (doc.intents && doc.intents.length > 0) {
    return {
      categories: doc.intents.map((intent) => ({
        name: intent.name,
        description: intent.description,
      })),
      source: 'explicit',
    };
  }

  // Inferred mode: extract from WHEN conditions across all handoffs
  const seen = new Set<string>();
  const categories: IntentCategory[] = [];

  for (const handoff of doc.handoff) {
    if (!handoff.when) continue;

    const regex = /intent\.category\s*[!=]=\s*["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(handoff.when)) !== null) {
      const name = match[1];
      if (!seen.has(name)) {
        seen.add(name);
        categories.push({ name });
      }
    }
  }

  // Add defaults (deduped)
  for (const defaultCat of DEFAULT_INTENT_CATEGORIES) {
    if (!seen.has(defaultCat.name)) {
      seen.add(defaultCat.name);
      categories.push({ name: defaultCat.name });
    }
  }

  return { categories, source: 'inferred' };
}

/** Extract all intent.category values from all WHEN conditions (for validation only) */
function extractAllWhenCategories(doc: AgentBasedDocument): string[] {
  const categories: string[] = [];
  const regex = /intent\.category\s*[!=]=\s*["']([^"']+)["']/g;

  for (const handoff of doc.handoff) {
    if (!handoff.when) continue;
    let match: RegExpExecArray | null;
    while ((match = regex.exec(handoff.when)) !== null) {
      categories.push(match[1]);
    }
  }

  return categories;
}

function buildSystemPromptTemplate(doc: AgentBasedDocument): string {
  return `You are ${doc.name}, an AI assistant.

GOAL: ${doc.goal.description}

PERSONA: ${doc.persona?.description || 'Professional and helpful.'}

${
  doc.limitations.length > 0
    ? `LIMITATIONS (important boundaries to respect when responding):
${doc.limitations.map((l) => `- ${l.description}`).join('\n')}`
    : ''
}

{%- if context %}
CURRENT CONTEXT:
{{ context | tojson }}
{%- endif %}

{%- if tools %}
AVAILABLE TOOLS:
{{ tools | tojson }}
{%- endif %}

{%- if history %}
CONVERSATION HISTORY:
{{ history }}
{%- endif %}`;
}

function compileMessages(doc: AgentBasedDocument): AgentMessages {
  // Filter out undefined values from doc.messages before merging
  const docMessages: Record<string, string> = {};
  if (doc.messages) {
    for (const [key, value] of Object.entries(doc.messages)) {
      if (value !== undefined) {
        docMessages[key] = value;
      }
    }
  }
  return {
    ...DEFAULT_MESSAGES,
    ...docMessages,
  } as AgentMessages;
}

function compileHookAction(
  action:
    | {
        call?: string;
        callSpec?: ToolInvocationAST;
        set?: Record<string, string>;
        respond?: string;
        voiceConfig?: VoiceConfigAST;
        richContent?: RichContentAST;
        actions?: ActionSetAST;
        critical?: boolean;
      }
    | undefined,
): HookAction | undefined {
  if (!action) return undefined;
  return {
    call: action.call,
    call_spec: compileToolInvocation({
      call: action.call,
      callSpec: action.callSpec,
    }),
    set: action.set,
    respond: action.respond,
    voice_config: compileVoiceConfig(action.voiceConfig),
    rich_content: compileRichContent(action.richContent),
    actions: compileActions(action.actions),
    critical: action.critical,
  };
}

function compileHooks(hooks: {
  before_agent?: {
    call?: string;
    callSpec?: ToolInvocationAST;
    set?: Record<string, string>;
    respond?: string;
    voiceConfig?: VoiceConfigAST;
    richContent?: RichContentAST;
    actions?: ActionSetAST;
  };
  after_agent?: {
    call?: string;
    callSpec?: ToolInvocationAST;
    set?: Record<string, string>;
    respond?: string;
    voiceConfig?: VoiceConfigAST;
    richContent?: RichContentAST;
    actions?: ActionSetAST;
  };
  before_turn?: {
    call?: string;
    callSpec?: ToolInvocationAST;
    set?: Record<string, string>;
    respond?: string;
    voiceConfig?: VoiceConfigAST;
    richContent?: RichContentAST;
    actions?: ActionSetAST;
  };
  after_turn?: {
    call?: string;
    callSpec?: ToolInvocationAST;
    set?: Record<string, string>;
    respond?: string;
    voiceConfig?: VoiceConfigAST;
    richContent?: RichContentAST;
    actions?: ActionSetAST;
  };
}): HooksConfig {
  return {
    before_agent: compileHookAction(hooks.before_agent),
    after_agent: compileHookAction(hooks.after_agent),
    before_turn: compileHookAction(hooks.before_turn),
    after_turn: compileHookAction(hooks.after_turn),
  };
}

function compileNLU(nluDef: NonNullable<AgentBasedDocument['nlu']>): NLUIRConfig {
  return {
    models: nluDef.models,
    languages: nluDef.languages,
    defaultLanguage: nluDef.defaultLanguage,
    allowCodeSwitching: nluDef.allowCodeSwitching,
    languageModels: nluDef.languageModels,
    intents: nluDef.intents.map((i) => ({
      name: i.name,
      patterns: i.patterns,
      examples: i.examples,
      examplesFile: i.examplesFile,
      entities: i.entities,
    })),
    categories: nluDef.categories.map((c) => ({
      name: c.name,
      patterns: c.patterns,
    })),
    entities: nluDef.entities.map((e) => ({
      name: e.name,
      type: e.type,
      values: e.values,
      synonyms: e.synonyms,
      pattern: e.pattern,
      validation: e.validation,
      sensitive: e.sensitive,
    })),
    glossary: nluDef.glossary,
    evaluation: nluDef.evaluation
      ? {
          logPredictions: nluDef.evaluation.logPredictions,
          abTest: nluDef.evaluation.abTest,
          confidenceThreshold: nluDef.evaluation.confidenceThreshold,
        }
      : undefined,
    embeddings: nluDef.embeddings
      ? {
          enabled: nluDef.embeddings.enabled,
          provider: nluDef.embeddings.provider,
          model: nluDef.embeddings.model,
          baseUrl: nluDef.embeddings.baseUrl,
          threshold: nluDef.embeddings.threshold,
          cacheTtl: nluDef.embeddings.cacheTtl,
        }
      : undefined,
  };
}

// =============================================================================
// TEMPLATE COMPILATION
// =============================================================================

const TEMPLATE_REF_PATTERN = /^TEMPLATE\((\w+)\)$/;

/**
 * Build a Record<string, string> dictionary from AST template definitions.
 * Duplicate names: last definition wins.
 * Also returns format variants for multi-format templates.
 */
export function compileTemplates(doc: AgentBasedDocument): Record<string, string> {
  const dict: Record<string, string> = {};
  if (!doc.templates) return dict;
  for (const t of doc.templates) {
    dict[t.name] = t.content;
  }
  return dict;
}

/**
 * Extract rich content format variants from template definitions.
 * Returns a map of template name → compiled RichContentIR.
 */
export function compileTemplateFormats(doc: AgentBasedDocument): Record<string, RichContentIR> {
  const formats: Record<string, RichContentIR> = {};
  if (!doc.templates) return formats;
  for (const t of doc.templates) {
    if (t.formats) {
      const compiled = compileRichContent(t.formats);
      if (compiled) {
        formats[t.name] = compiled;
      }
    }
  }
  return formats;
}

/**
 * Extract voice config variants from template definitions.
 * Returns a map of template name -> compiled VoiceConfigIR.
 */
export function compileTemplateVoiceConfigs(
  doc: AgentBasedDocument,
): Record<string, VoiceConfigIR> {
  const voiceConfigs: Record<string, VoiceConfigIR> = {};
  if (!doc.templates) return voiceConfigs;
  for (const t of doc.templates) {
    if (t.voiceConfig) {
      const compiled = compileVoiceConfig(t.voiceConfig);
      if (compiled && Object.values(compiled).some((value) => value !== undefined)) {
        voiceConfigs[t.name] = compiled;
      }
    }
  }
  return voiceConfigs;
}

/**
 * If value matches TEMPLATE(name), return the resolved content.
 * Otherwise return the original value unchanged.
 */
export function resolveTemplateRef(
  value: string | undefined,
  templates: Record<string, string>,
  errors: string[],
  usedSet: Set<string>,
  location: string,
): string | undefined {
  if (!value) return value;
  const match = value.match(TEMPLATE_REF_PATTERN);
  if (!match) return value;
  const name = match[1];
  if (!(name in templates)) {
    errors.push(`E601: Undefined template "${name}" referenced in ${location}`);
    return value;
  }
  usedSet.add(name);
  return templates[name];
}

/**
 * Walk all respond/message locations in the IR and resolve TEMPLATE() references.
 * Also sets rich_content from template format variants when a TEMPLATE(name) reference
 * is resolved and the template has format variants.
 * Returns errors (undefined refs) and warnings (unused templates).
 */
export function resolveAllTemplateRefs(
  ir: AgentIR,
  templates: Record<string, string>,
  templateFormats?: Record<string, RichContentIR>,
  templateVoiceConfigs?: Record<string, VoiceConfigIR>,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const used = new Set<string>();

  const resolve = (val: string | undefined, loc: string) =>
    resolveTemplateRef(val, templates, errors, used, loc);

  // Helper: if a respond value is a TEMPLATE(name) ref, return the template's rich_content
  const resolveFormats = (val: string | undefined): RichContentIR | undefined => {
    if (!val || !templateFormats) return undefined;
    const match = val.match(TEMPLATE_REF_PATTERN);
    if (!match) return undefined;
    return templateFormats[match[1]];
  };

  const resolveVoiceConfig = (val: string | undefined): VoiceConfigIR | undefined => {
    if (!val || !templateVoiceConfigs) return undefined;
    const match = val.match(TEMPLATE_REF_PATTERN);
    if (!match) return undefined;
    const voiceConfig = templateVoiceConfigs[match[1]];
    return voiceConfig ? { ...voiceConfig } : undefined;
  };

  const applyTemplateOutputMetadata = (
    target: { rich_content?: RichContentIR; voice_config?: VoiceConfigIR },
    val: string | undefined,
  ): void => {
    if (!target.rich_content) {
      const formats = resolveFormats(val);
      if (formats) target.rich_content = formats;
    }
    if (!target.voice_config) {
      const voiceConfig = resolveVoiceConfig(val);
      if (voiceConfig) target.voice_config = voiceConfig;
    }
  };

  const resolveActionHandlerResponds = (
    handlers: ActionHandlerIR[] | undefined,
    loc: (handlerIndex: number, actionIndex: number) => string,
  ): void => {
    if (!handlers) {
      return;
    }

    for (let handlerIndex = 0; handlerIndex < handlers.length; handlerIndex++) {
      const handler = handlers[handlerIndex];
      const refs = getMutableActionHandlerActionRefs(handler);
      for (let actionIndex = 0; actionIndex < refs.length; actionIndex++) {
        const ref = refs[actionIndex];
        if (ref.action.respond !== undefined) {
          applyTemplateOutputMetadata(ref.action, ref.action.respond);
          ref.action.respond = resolve(ref.action.respond, loc(handlerIndex, actionIndex));
        }
        ref.sync?.(ref.action);
      }
      syncActionHandlerCompatibilityMirrors(handler);
    }
  };

  // --- completion.conditions[].respond ---
  if (ir.completion?.conditions) {
    for (const c of ir.completion.conditions) {
      applyTemplateOutputMetadata(c, c.respond);
      c.respond = resolve(c.respond, 'COMPLETE respond');
    }
  }

  // --- error_handling.handlers[].respond + default_handler ---
  if (ir.error_handling) {
    for (const h of ir.error_handling.handlers) {
      applyTemplateOutputMetadata(h, h.respond);
      h.respond = resolve(h.respond, 'ON_ERROR handler respond');
    }
    if (ir.error_handling.default_handler) {
      applyTemplateOutputMetadata(
        ir.error_handling.default_handler,
        ir.error_handling.default_handler.respond,
      );
      ir.error_handling.default_handler.respond = resolve(
        ir.error_handling.default_handler.respond,
        'ON_ERROR default_handler respond',
      );
    }
  }

  // --- on_start.respond ---
  if (ir.on_start) {
    applyTemplateOutputMetadata(ir.on_start, ir.on_start.respond);
    ir.on_start.respond = resolve(ir.on_start.respond, 'ON_START respond');
  }

  // --- hooks ---
  if (ir.hooks) {
    for (const hookKey of ['before_agent', 'after_agent', 'before_turn', 'after_turn'] as const) {
      const hook = ir.hooks[hookKey];
      if (hook) {
        applyTemplateOutputMetadata(hook, hook.respond);
        hook.respond = resolve(hook.respond, `HOOKS ${hookKey} respond`);
      }
    }
  }

  // --- messages ---
  if (ir.messages) {
    for (const key of Object.keys(ir.messages)) {
      const val = (ir.messages as Record<string, string>)[key];
      (ir.messages as Record<string, string>)[key] = resolve(val, `MESSAGES ${key}`) ?? val;
    }
  }

  resolveActionHandlerResponds(ir.action_handlers, (handlerIndex, actionIndex) => {
    return `ACTION_HANDLERS[${handlerIndex}] DO[${actionIndex}] respond`;
  });

  // --- flow ---
  if (ir.flow) {
    // global digressions
    if (ir.flow.global_digressions) {
      for (const d of ir.flow.global_digressions) {
        if (d.do) {
          for (let index = 0; index < d.do.length; index++) {
            const action = d.do[index];
            if (action.respond !== undefined) {
              applyTemplateOutputMetadata(action, action.respond);
              action.respond = resolve(
                action.respond,
                `FLOW global digression DO[${index}] respond`,
              );
            }
          }
        }
        applyTemplateOutputMetadata(d, d.respond);
        d.respond = resolve(d.respond, 'FLOW global digression respond');
      }
    }

    // step definitions
    for (const [stepName, step] of Object.entries(ir.flow.definitions)) {
      const loc = (field: string) => `FLOW step "${stepName}" ${field}`;

      applyTemplateOutputMetadata(step, step.respond);
      step.respond = resolve(step.respond, loc('RESPOND'));

      // on_success
      if (step.on_success) {
        applyTemplateOutputMetadata(step.on_success, step.on_success.respond);
        step.on_success.respond = resolve(step.on_success.respond, loc('ON_SUCCESS respond'));
        if (step.on_success.branches) {
          for (const b of step.on_success.branches) {
            applyTemplateOutputMetadata(b, b.respond);
            b.respond = resolve(b.respond, loc('ON_SUCCESS branch respond'));
          }
        }
      }

      // on_failure
      if (step.on_failure) {
        applyTemplateOutputMetadata(step.on_failure, step.on_failure.respond);
        step.on_failure.respond = resolve(step.on_failure.respond, loc('ON_FAILURE respond'));
        if (step.on_failure.branches) {
          for (const b of step.on_failure.branches) {
            applyTemplateOutputMetadata(b, b.respond);
            b.respond = resolve(b.respond, loc('ON_FAILURE branch respond'));
          }
        }
      }

      // on_result
      if (step.on_result) {
        for (const b of step.on_result) {
          applyTemplateOutputMetadata(b, b.respond);
          b.respond = resolve(b.respond, loc('ON_RESULT branch respond'));
        }
      }

      // on_input
      if (step.on_input) {
        for (const b of step.on_input) {
          applyTemplateOutputMetadata(b, b.respond);
          b.respond = resolve(b.respond, loc('ON_INPUT branch respond'));
        }
      }

      // digressions
      if (step.digressions) {
        for (const d of step.digressions) {
          if (d.do) {
            for (let index = 0; index < d.do.length; index++) {
              const action = d.do[index];
              if (action.respond !== undefined) {
                applyTemplateOutputMetadata(action, action.respond);
                action.respond = resolve(action.respond, loc(`digression DO[${index}] respond`));
              }
            }
          }
          applyTemplateOutputMetadata(d, d.respond);
          d.respond = resolve(d.respond, loc('digression respond'));
        }
      }

      // sub_intents
      if (step.sub_intents) {
        for (const s of step.sub_intents) {
          applyTemplateOutputMetadata(s, s.respond);
          s.respond = resolve(s.respond, loc('sub_intent respond'));
        }
      }

      // on_action
      resolveActionHandlerResponds(step.on_action, (handlerIndex, actionIndex) => {
        return loc(`ON_ACTION[${handlerIndex}] DO[${actionIndex}] respond`);
      });

      // step-level gather field prompts
      if (step.gather?.fields) {
        for (const f of step.gather.fields) {
          if (f.prompt) {
            applyTemplateOutputMetadata(f, f.prompt);
            f.prompt = resolve(f.prompt, loc('GATHER field prompt')) ?? f.prompt;
          }
        }
      }
    }
  }

  // --- top-level gather field prompts ---
  if (ir.gather?.fields) {
    for (const f of ir.gather.fields) {
      if (f.prompt) {
        applyTemplateOutputMetadata(f, f.prompt);
        f.prompt = resolve(f.prompt, 'GATHER field prompt') ?? f.prompt;
      }
    }
  }

  // --- warnings for unused templates ---
  const warnings: string[] = [];
  for (const name of Object.keys(templates)) {
    if (!used.has(name)) {
      warnings.push(`W602: Template "${name}" is defined but never referenced`);
    }
  }

  return { errors, warnings };
}

// =============================================================================
// CONFIG VARIABLE RESOLUTION
// =============================================================================

/**
 * Recursively walk an object tree and replace all {{config.KEY}} placeholders
 * in string values with the corresponding config variable value.
 *
 * Does NOT resolve {{env.X}} or {{secrets.X}} — those are runtime placeholders.
 *
 * Returns the set of used config keys and any errors for undefined references.
 */
export function resolveConfigVariables(
  ir: AgentIR,
  configVars: Record<string, string>,
): { errors: string[]; warnings: string[]; used: Set<string> } {
  const errors: string[] = [];
  const used = new Set<string>();

  function walkAndReplace(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return obj.replace(CONFIG_VAR_PATTERN, (match, key: string) => {
        if (key in configVars) {
          used.add(key);
          return configVars[key];
        }
        errors.push(`Undefined config variable "${key}" referenced in agent "${ir.metadata.name}"`);
        return match; // Leave placeholder as-is for error visibility
      });
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        obj[i] = walkAndReplace(obj[i]);
      }
      return obj;
    }
    if (obj !== null && typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        (obj as Record<string, unknown>)[key] = walkAndReplace(
          (obj as Record<string, unknown>)[key],
        );
      }
      return obj;
    }
    return obj;
  }

  // Keys to preserve as runtime templates on tool objects.
  // Namespace-scoped tool bindings must resolve {{config.*}} through their
  // scoped runtime provider rather than the project-wide compile context.
  const TOOL_RUNTIME_KEYS = new Set(['auth_profile_ref']);
  const NAMESPACE_SCOPED_TOOL_RUNTIME_KEYS = new Set([
    'http_binding',
    'mcp_binding',
    'sandbox_binding',
    'connector_binding',
    'workflow_binding',
    'searchai_binding',
    'async_webhook_binding',
  ]);

  // Walk everything except metadata (which we control)
  walkAndReplace(ir.identity);
  walkAndReplace(ir.execution);
  // Walk tools individually, skipping auth_profile_ref (preserved for runtime resolution)
  for (const tool of ir.tools) {
    const toolRecord = tool as unknown as Record<string, unknown>;
    const isNamespaceScopedTool =
      Array.isArray(tool.variable_namespace_ids) && tool.variable_namespace_ids.length > 0;
    for (const key of Object.keys(toolRecord)) {
      if (TOOL_RUNTIME_KEYS.has(key)) continue;
      if (isNamespaceScopedTool && NAMESPACE_SCOPED_TOOL_RUNTIME_KEYS.has(key)) continue;
      toolRecord[key] = walkAndReplace(toolRecord[key]);
    }
  }
  walkAndReplace(ir.gather);
  walkAndReplace(ir.memory);
  walkAndReplace(ir.constraints);
  walkAndReplace(ir.coordination);
  walkAndReplace(ir.completion);
  walkAndReplace(ir.error_handling);
  if (ir.flow) walkAndReplace(ir.flow);
  if (ir.on_start) walkAndReplace(ir.on_start);
  if (ir.messages) walkAndReplace(ir.messages);
  if (ir.hooks) walkAndReplace(ir.hooks);
  if (ir.nlu) walkAndReplace(ir.nlu);
  if (ir.routing) walkAndReplace(ir.routing);
  if (ir.templates) walkAndReplace(ir.templates);
  if (ir.conversation_behavior) walkAndReplace(ir.conversation_behavior);
  if (ir.behavior_profiles) {
    for (const profile of ir.behavior_profiles) {
      if (profile.conversation_behavior) {
        walkAndReplace(profile.conversation_behavior);
      }
    }
  }

  return { errors, warnings: [], used };
}

/**
 * Resolve {{env.KEY}} placeholders in the IR at compile/deploy time.
 * Mirrors resolveConfigVariables but uses ENV_VAR_PATTERN.
 * Unresolved env vars are treated as warnings (not errors) since they
 * may be resolved at runtime as a fallback.
 */
export function resolveEnvVariables(
  ir: AgentIR,
  envVars: Record<string, string>,
): { errors: string[]; used: Set<string> } {
  const errors: string[] = [];
  const used = new Set<string>();

  function walkAndReplace(obj: unknown): unknown {
    if (typeof obj === 'string') {
      return obj.replace(ENV_VAR_PATTERN, (match, key: string) => {
        if (key in envVars) {
          used.add(key);
          return envVars[key];
        }
        errors.push(`Unresolved env variable "{{env.${key}}}" in agent "${ir.metadata.name}"`);
        return match; // Leave placeholder for runtime fallback
      });
    }
    if (Array.isArray(obj)) {
      for (let i = 0; i < obj.length; i++) {
        obj[i] = walkAndReplace(obj[i]);
      }
      return obj;
    }
    if (obj !== null && typeof obj === 'object') {
      for (const key of Object.keys(obj)) {
        (obj as Record<string, unknown>)[key] = walkAndReplace(
          (obj as Record<string, unknown>)[key],
        );
      }
      return obj;
    }
    return obj;
  }

  walkAndReplace(ir.identity);
  walkAndReplace(ir.tools);
  walkAndReplace(ir.gather);
  walkAndReplace(ir.memory);
  walkAndReplace(ir.constraints);
  walkAndReplace(ir.coordination);
  walkAndReplace(ir.completion);
  walkAndReplace(ir.error_handling);
  if (ir.flow) walkAndReplace(ir.flow);
  if (ir.on_start) walkAndReplace(ir.on_start);
  if (ir.messages) walkAndReplace(ir.messages);
  if (ir.hooks) walkAndReplace(ir.hooks);
  if (ir.nlu) walkAndReplace(ir.nlu);
  if (ir.routing) walkAndReplace(ir.routing);
  if (ir.templates) walkAndReplace(ir.templates);
  if (ir.conversation_behavior) walkAndReplace(ir.conversation_behavior);
  if (ir.behavior_profiles) {
    for (const profile of ir.behavior_profiles) {
      if (profile.conversation_behavior) {
        walkAndReplace(profile.conversation_behavior);
      }
    }
  }

  return { errors, used };
}

/**
 * Validate CONTEXT_ACCESS references on tools point to declared memory vars.
 * READ/WRITE entries must be declared in either session or persistent memory.
 */
export function validateContextAccessDeclarations(
  agentIR: AgentIR,
): import('./schema.js').CompilationError[] {
  const warnings: import('./schema.js').CompilationError[] = [];
  if (!agentIR.tools || !agentIR.memory) return warnings;

  // Build set of all declared memory names
  const declaredNames = new Set<string>();
  for (const s of agentIR.memory.session || []) {
    declaredNames.add(s.name);
  }
  for (const p of agentIR.memory.persistent || []) {
    declaredNames.add(p.path);
  }

  for (const tool of agentIR.tools) {
    if (!tool.context_access) continue;

    for (const varName of [...tool.context_access.read, ...tool.context_access.write]) {
      if (!declaredNames.has(varName)) {
        warnings.push({
          agent: agentIR.metadata.name,
          message: `Tool '${tool.name}' CONTEXT_ACCESS references '${varName}' which is not declared in MEMORY section.`,
          type: 'validation',
          severity: 'warning',
        });
      }
    }
  }

  return warnings;
}

function hashSource(content: string): string {
  return createHash('sha256').update(content).digest('hex').substring(0, 16);
}
