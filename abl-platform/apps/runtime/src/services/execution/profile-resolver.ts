/**
 * Profile Resolver
 *
 * Evaluates behavior profiles at session creation time. Takes session context
 * (channel, caller, session metadata, environment) and evaluates CEL WHEN
 * expressions on behavior profiles to determine which profiles are active.
 * Then builds an "effective config" overlay that merges base agent IR with
 * active profile overrides.
 *
 * Three main exports:
 * - assembleProfileContext: Builds ProfileContext from runtime inputs
 * - resolveActiveProfiles: Evaluates WHEN expressions to find matching profiles
 * - buildEffectiveConfig: Merges base IR with active profile overrides
 */

import { evaluateCelCondition } from '@abl/compiler';
import { createLogger } from '@abl/compiler/platform';
import type { InteractionContext, InteractionContextInput } from '@agent-platform/shared-kernel';
import type {
  AgentIR,
  BehaviorProfileIR,
  Constraint,
  FlowConfig,
  FlowStepOverrideIR,
  GatherProfileOverrides,
  ResponseRulesIR,
  ToolDefinition,
  VoiceConfigIR,
} from '@abl/compiler';
import {
  resolveConversationBehavior,
  type ResolvedConversationBehavior,
} from './conversation-behavior-resolver.js';

const log = createLogger('profile-resolver');
export const PROFILE_INTERACTION_CONTEXT_SESSION_KEY = '_profileInteractionContext';

// =============================================================================
// PROFILE CONTEXT
// =============================================================================

/**
 * Channel capabilities derived from channel type.
 */
export interface ChannelCapabilities {
  streaming: boolean;
  media: boolean;
  threading: boolean;
  interactive: boolean;
}

/**
 * Profile context assembled from session creation inputs.
 * This is the evaluation context passed to CEL WHEN expressions.
 */
export interface ProfileContext {
  channel: {
    name: string;
    region: string;
    number_type: string;
    provider: string;
    tags: Record<string, string>;
    capabilities: ChannelCapabilities;
  };
  caller: {
    identity_tier: number;
    customer_id: string | null;
    is_authenticated: boolean;
    verification_method: string;
    tags: Record<string, string>;
  };
  session: {
    is_new: boolean;
    language: string;
    turn_count: number;
  };
  interaction: {
    sentiment_score: number;
    sentiment_label: string;
    emotion_label: string;
    turn_topic: string;
  };
  env: {
    deployment_region: string;
    timestamp: number;
  };
}

/**
 * Caller context input — subset of CallerContext from @agent-platform/shared.
 * Defined locally to avoid coupling to the shared package version.
 */
export interface CallerContextInput {
  identityTier?: number;
  customerId?: string | null;
  verificationMethod?: string;
}

/**
 * Channel connection config metadata.
 */
export interface ConnectionConfig {
  region?: string;
  number_type?: string;
  provider?: string;
  tags?: Record<string, string>;
}

/**
 * Session metadata input.
 */
export interface SessionMeta {
  isNew?: boolean;
  language?: string;
  turnCount?: number;
}

/**
 * Profile-specific interaction hints used only for behavior-profile WHEN
 * evaluation. Canonical runtime InteractionContext remains limited to locale
 * dimensions; these optional classifier fields are intentionally sanitized
 * into a narrow shape before reaching CEL evaluation.
 */
export interface ProfileInteractionContextInput extends InteractionContextInput {
  language?: string;
  locale?: string;
  timezone?: string;
  sentiment_score?: number;
  sentiment_label?: string;
  emotion_label?: string;
  turn_topic?: string;
}

interface ProfileSessionDataStore {
  values: Record<string, unknown>;
}

/**
 * Input to assembleProfileContext.
 */
export interface ProfileContextInput {
  channelType: string;
  callerContext?: CallerContextInput;
  connectionConfig?: ConnectionConfig;
  sessionMeta?: SessionMeta;
  interactionContext?: InteractionContext | ProfileInteractionContextInput;
}

// =============================================================================
// CHANNEL CAPABILITIES
// =============================================================================

const CHANNEL_CAPABILITIES: Record<string, ChannelCapabilities> = {
  web: { streaming: true, media: true, threading: true, interactive: true },
  whatsapp: { streaming: false, media: true, threading: false, interactive: true },
  messenger: { streaming: false, media: true, threading: false, interactive: true },
  slack: { streaming: false, media: true, threading: true, interactive: true },
  msteams: { streaming: false, media: true, threading: true, interactive: true },
  sms: { streaming: false, media: false, threading: false, interactive: false },
  voice: { streaming: true, media: false, threading: false, interactive: false },
  email: { streaming: false, media: true, threading: true, interactive: false },
};

const DEFAULT_CAPABILITIES: ChannelCapabilities = {
  streaming: false,
  media: false,
  threading: false,
  interactive: false,
};

/**
 * Derive channel capabilities from channel type.
 */
function getChannelCapabilities(channelType: string): ChannelCapabilities {
  return CHANNEL_CAPABILITIES[channelType.toLowerCase()] ?? DEFAULT_CAPABILITIES;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readNestedValue(record: Record<string, unknown> | undefined, path: string[]): unknown {
  let current: unknown = record;
  for (const segment of path) {
    const currentRecord = asRecord(current);
    if (!currentRecord) {
      return undefined;
    }
    current = currentRecord[segment];
  }
  return current;
}

function assembleInteractionProfileContext(
  interactionContext: InteractionContext | ProfileInteractionContextInput | undefined,
): ProfileContext['interaction'] {
  const interaction = normalizeProfileInteractionContextInput(interactionContext);

  return {
    sentiment_score: interaction?.sentiment_score ?? 0,
    sentiment_label: interaction?.sentiment_label ?? '',
    emotion_label: interaction?.emotion_label ?? '',
    turn_topic: interaction?.turn_topic ?? '',
  };
}

function hasProfileInteractionValues(input: ProfileInteractionContextInput): boolean {
  return (
    input.language !== undefined ||
    input.locale !== undefined ||
    input.timezone !== undefined ||
    input.sentiment_score !== undefined ||
    input.sentiment_label !== undefined ||
    input.emotion_label !== undefined ||
    input.turn_topic !== undefined
  );
}

function hasProfileInteractionSignals(input: ProfileInteractionContextInput | undefined): boolean {
  return (
    input?.sentiment_score !== undefined ||
    input?.sentiment_label !== undefined ||
    input?.emotion_label !== undefined ||
    input?.turn_topic !== undefined
  );
}

function pickProfileInteractionSignals(
  input: ProfileInteractionContextInput | undefined,
): ProfileInteractionContextInput | undefined {
  if (!input || !hasProfileInteractionSignals(input)) {
    return undefined;
  }

  return {
    ...(input.sentiment_score !== undefined ? { sentiment_score: input.sentiment_score } : {}),
    ...(input.sentiment_label !== undefined ? { sentiment_label: input.sentiment_label } : {}),
    ...(input.emotion_label !== undefined ? { emotion_label: input.emotion_label } : {}),
    ...(input.turn_topic !== undefined ? { turn_topic: input.turn_topic } : {}),
  };
}

/**
 * Normalize arbitrary metadata/classifier payloads into the narrow set of
 * fields behavior profiles are allowed to inspect.
 */
export function normalizeProfileInteractionContextInput(
  input: unknown,
): ProfileInteractionContextInput | undefined {
  const interaction = asRecord(input);
  if (!interaction) {
    return undefined;
  }

  const sentimentRecord = asRecord(interaction.sentiment);
  const emotionRecord = asRecord(interaction.emotion);
  const normalized: ProfileInteractionContextInput = {};

  const language = readString(interaction.language);
  if (language) {
    normalized.language = language;
  }

  const locale = readString(interaction.locale);
  if (locale) {
    normalized.locale = locale;
  }

  const timezone = readString(interaction.timezone);
  if (timezone) {
    normalized.timezone = timezone;
  }

  const sentimentScore =
    readNumber(interaction.sentiment_score) ??
    readNumber(interaction.sentimentScore) ??
    readNumber(sentimentRecord?.score);
  if (sentimentScore !== undefined) {
    normalized.sentiment_score = sentimentScore;
  }

  const sentimentLabel =
    readString(interaction.sentiment_label) ??
    readString(interaction.sentimentLabel) ??
    readString(sentimentRecord?.label);
  if (sentimentLabel) {
    normalized.sentiment_label = sentimentLabel;
  }

  const emotionLabel =
    readString(interaction.emotion_label) ??
    readString(interaction.emotionLabel) ??
    readString(emotionRecord?.label) ??
    readString(readNestedValue(interaction, ['emotion', 'name']));
  if (emotionLabel) {
    normalized.emotion_label = emotionLabel;
  }

  const turnTopic =
    readString(interaction.turn_topic) ??
    readString(interaction.turnTopic) ??
    readString(readNestedValue(interaction, ['turn', 'topic']));
  if (turnTopic) {
    normalized.turn_topic = turnTopic;
  }

  return hasProfileInteractionValues(normalized) ? normalized : undefined;
}

export function mergeProfileInteractionContextInputs(
  ...inputs: Array<unknown>
): ProfileInteractionContextInput | undefined {
  const merged: ProfileInteractionContextInput = {};

  for (const input of inputs) {
    const normalized = normalizeProfileInteractionContextInput(input);
    if (!normalized) {
      continue;
    }

    Object.assign(merged, normalized);
  }

  return hasProfileInteractionValues(merged) ? merged : undefined;
}

export function extractProfileInteractionContextFromMetadata(
  metadata: unknown,
): ProfileInteractionContextInput | undefined {
  const record = asRecord(metadata);
  if (!record) {
    return undefined;
  }

  return mergeProfileInteractionContextInputs(
    record,
    record.interactionContext,
    record.interaction,
    record.classification,
    record.classifier,
    record.analysis,
    record.messageAnalysis,
  );
}

function getProfileSessionNamespace(sessionData: ProfileSessionDataStore): Record<string, unknown> {
  const namespace = sessionData.values.session;
  if (namespace && typeof namespace === 'object' && !Array.isArray(namespace)) {
    return namespace as Record<string, unknown>;
  }

  const nextNamespace: Record<string, unknown> = {};
  sessionData.values.session = nextNamespace;
  return nextNamespace;
}

export function applyProfileInteractionContextToSessionData(
  sessionData: ProfileSessionDataStore,
  input: unknown,
): ProfileInteractionContextInput | undefined {
  const sessionNamespace = getProfileSessionNamespace(sessionData);
  const signals = pickProfileInteractionSignals(normalizeProfileInteractionContextInput(input));

  if (!signals) {
    delete sessionNamespace[PROFILE_INTERACTION_CONTEXT_SESSION_KEY];
    return undefined;
  }

  sessionNamespace[PROFILE_INTERACTION_CONTEXT_SESSION_KEY] = signals;
  return signals;
}

export function readProfileInteractionContextFromSessionData(
  sessionData: ProfileSessionDataStore,
): ProfileInteractionContextInput | undefined {
  const sessionNamespace = asRecord(sessionData.values.session);
  const rawInteraction = asRecord(sessionNamespace?.interaction);
  const rawInteractionContext = asRecord(sessionNamespace?.interactionContext);

  return mergeProfileInteractionContextInputs(
    rawInteraction?.current,
    rawInteractionContext?.current,
    sessionNamespace?.[PROFILE_INTERACTION_CONTEXT_SESSION_KEY],
  );
}

// =============================================================================
// CONTEXT ASSEMBLY
// =============================================================================

/**
 * Assemble a ProfileContext from session creation inputs.
 *
 * Maps runtime-specific types (CallerContext, connection config, session meta)
 * into the flat context structure used by CEL WHEN expression evaluation.
 */
export function assembleProfileContext(input: ProfileContextInput): ProfileContext {
  const { channelType, callerContext, connectionConfig, sessionMeta, interactionContext } = input;
  const normalizedInteractionContext = normalizeProfileInteractionContextInput(interactionContext);

  const identityTier = callerContext?.identityTier ?? 0;
  const sessionLanguage =
    normalizedInteractionContext?.language ??
    (typeof sessionMeta?.language === 'string' && sessionMeta.language.trim().length > 0
      ? sessionMeta.language
      : 'en');

  return {
    channel: {
      name: channelType,
      region: connectionConfig?.region ?? '',
      number_type: connectionConfig?.number_type ?? '',
      provider: connectionConfig?.provider ?? '',
      tags: connectionConfig?.tags ?? {},
      capabilities: getChannelCapabilities(channelType),
    },
    caller: {
      identity_tier: identityTier,
      customer_id: callerContext?.customerId ?? null,
      is_authenticated: identityTier > 0,
      verification_method: callerContext?.verificationMethod ?? 'none',
      tags: {},
    },
    session: {
      is_new: sessionMeta?.isNew ?? true,
      language: sessionLanguage,
      turn_count: sessionMeta?.turnCount ?? 0,
    },
    interaction: assembleInteractionProfileContext(normalizedInteractionContext),
    env: {
      deployment_region: process.env.DEPLOYMENT_REGION ?? '',
      timestamp: Date.now(),
    },
  };
}

// =============================================================================
// PROFILE RESOLUTION
// =============================================================================

/**
 * Normalize ABL-style logical operators (AND, OR, NOT) to CEL syntax (&&, ||, !).
 * Replaces whole-word occurrences only (not inside strings or identifiers).
 */
function normalizeToCel(expression: string): string {
  return expression
    .replace(/\bAND\b/g, '&&')
    .replace(/\bOR\b/g, '||')
    .replace(/\bNOT\b/g, '!');
}

/**
 * Evaluate each profile's WHEN expression against the assembled context.
 * Returns matching profiles sorted by priority ascending (lowest first).
 *
 * Expressions may use ABL-style operators (AND, OR, NOT) or CEL-style
 * (&&, ||, !) — both are supported via normalization before evaluation.
 *
 * A failing CEL expression logs a warning and skips the profile rather than
 * crashing the session.
 */
export function resolveActiveProfiles(
  profiles: BehaviorProfileIR[],
  context: ProfileContext,
): BehaviorProfileIR[] {
  if (!profiles || profiles.length === 0) {
    return [];
  }

  const matched: BehaviorProfileIR[] = [];

  for (const profile of profiles) {
    try {
      const celExpr = normalizeToCel(profile.when);
      const isActive = evaluateCelCondition(celExpr, context as unknown as Record<string, unknown>);
      if (isActive) {
        matched.push(profile);
      }
    } catch (err) {
      log.warn('Profile WHEN evaluation failed, skipping profile', {
        profile: profile.name,
        when: profile.when,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Sort by priority ascending (lowest first) so higher-priority profiles
  // are applied last and win in last-wins merges
  matched.sort((a, b) => a.priority - b.priority);

  return matched;
}

// =============================================================================
// EFFECTIVE CONFIG
// =============================================================================

/**
 * The merged configuration produced by applying active behavior profiles
 * on top of the base agent IR.
 */
export interface EffectiveAgentConfig {
  /** Instructions appended from all active profiles */
  additionalInstructions: string[];
  /** Base tools minus hidden, plus added */
  tools: ToolDefinition[];
  /** Constraints appended from all active profiles */
  additionalConstraints: Constraint[];
  /** Response rules — last (highest priority) wins per field */
  responseRules?: ResponseRulesIR;
  /** Voice config — last wins per field */
  voiceConfig?: VoiceConfigIR;
  /** Resolved conversation behavior after profile merge and capability gating */
  conversationBehavior?: ResolvedConversationBehavior;
  /** Gather overrides — deep merged across profiles */
  gatherOverrides?: GatherProfileOverrides;
  /** Flow config with skips applied */
  flow?: FlowConfig;
  /** Per-step overrides from profiles (last wins per step) */
  flowStepOverrides?: Record<string, FlowStepOverrideIR>;
  /** If any profile replaces the flow, the replacement flow name */
  flowReplace?: string;
  /** Names of all active profiles (for tracing/debugging) */
  activeProfileNames: string[];
}

/**
 * Build the effective agent configuration by merging base IR with active
 * behavior profiles.
 *
 * Profiles are expected to be sorted by priority ascending (lowest first).
 * Merge semantics:
 * - instructions: Append all into additionalInstructions[]
 * - constraints: Append all into additionalConstraints[]
 * - tools_hide: Cumulative — remove from base tools
 * - tools_add: Cumulative — add to tools
 * - response_rules: Last (highest priority) wins per field (shallow merge)
 * - voice: Last wins per field (shallow merge)
 * - gather_overrides: Deep merge — field-level overrides stack
 * - flow_modifications.skip: Cumulative across profiles
 * - flow_modifications.overrides: Last wins per step
 * - flow_replace: Last profile with flow_replace wins
 */
export function buildEffectiveConfig(
  baseIR: AgentIR,
  activeProfiles: BehaviorProfileIR[],
  options: { channelType?: string } = {},
): EffectiveAgentConfig {
  // Start with base values
  const additionalInstructions: string[] = [];
  const additionalConstraints: Constraint[] = [];
  const hiddenTools = new Set<string>();
  const addedTools: ToolDefinition[] = [];
  let responseRules: ResponseRulesIR | undefined;
  let voiceConfig: VoiceConfigIR | undefined;
  const channelType = options.channelType ?? 'digital';
  let gatherOverrides: GatherProfileOverrides | undefined;
  let flowReplace: string | undefined;
  const flowSkips = new Set<string>();
  const flowStepOverrides: Record<string, FlowStepOverrideIR> = {};

  // Apply profiles in priority order (low to high)
  for (const profile of activeProfiles) {
    // Instructions: append
    if (profile.instructions) {
      additionalInstructions.push(profile.instructions);
    }

    // Constraints: append
    if (profile.constraints && profile.constraints.length > 0) {
      additionalConstraints.push(...profile.constraints);
    }

    // Tools hide: cumulative
    if (profile.tools_hide) {
      for (const toolName of profile.tools_hide) {
        hiddenTools.add(toolName);
      }
    }

    // Tools add: cumulative
    if (profile.tools_add && profile.tools_add.length > 0) {
      addedTools.push(...profile.tools_add);
    }

    // Response rules: last wins per field (shallow merge)
    if (profile.response_rules) {
      responseRules = responseRules
        ? { ...responseRules, ...profile.response_rules }
        : { ...profile.response_rules };
    }

    // Voice: last wins per field (shallow merge)
    if (profile.voice) {
      voiceConfig = voiceConfig ? { ...voiceConfig, ...profile.voice } : { ...profile.voice };
    }

    // Gather overrides: deep merge
    if (profile.gather_overrides) {
      gatherOverrides = deepMergeGatherOverrides(gatherOverrides, profile.gather_overrides);
    }

    // Flow modifications
    if (profile.flow_modifications) {
      // Skip: cumulative
      if (profile.flow_modifications.skip) {
        for (const stepName of profile.flow_modifications.skip) {
          flowSkips.add(stepName);
        }
      }
      // Overrides: last wins per step
      if (profile.flow_modifications.overrides) {
        for (const [stepName, override] of Object.entries(profile.flow_modifications.overrides)) {
          flowStepOverrides[stepName] = override;
        }
      }
    }

    // Flow replace: last profile wins
    if (profile.flow_replace) {
      flowReplace = profile.flow_replace;
    }
  }

  // Build final tools list: base minus hidden, plus added
  const baseTools = baseIR.tools ?? [];
  const tools = [...baseTools.filter((t) => !hiddenTools.has(t.name)), ...addedTools];

  // Build flow with skips applied
  let flow = baseIR.flow;
  if (flow && flowSkips.size > 0) {
    flow = applyFlowSkips(flow, flowSkips);
  }

  const conversationBehavior = resolveConversationBehavior({
    baseBehavior: baseIR.conversation_behavior,
    activeProfiles,
    channelType,
  });

  return {
    additionalInstructions,
    tools,
    additionalConstraints,
    responseRules,
    voiceConfig,
    conversationBehavior,
    gatherOverrides,
    flow,
    flowStepOverrides: Object.keys(flowStepOverrides).length > 0 ? flowStepOverrides : undefined,
    flowReplace,
    activeProfileNames: activeProfiles.map((p) => p.name),
  };
}

// =============================================================================
// MERGE HELPERS
// =============================================================================

/**
 * Deep merge gather overrides. Field-level overrides stack across profiles.
 */
function deepMergeGatherOverrides(
  base: GatherProfileOverrides | undefined,
  overlay: GatherProfileOverrides,
): GatherProfileOverrides {
  if (!base) {
    return { ...overlay };
  }

  const merged: GatherProfileOverrides = { ...base };

  // Top-level fields: last wins
  if (overlay.validation_style !== undefined) {
    merged.validation_style = overlay.validation_style;
  }
  if (overlay.confirmation !== undefined) {
    merged.confirmation = overlay.confirmation;
  }

  // Field overrides: deep merge per field
  if (overlay.field_overrides) {
    merged.field_overrides = { ...(base.field_overrides ?? {}) };
    for (const [fieldName, fieldOverride] of Object.entries(overlay.field_overrides)) {
      const existing = merged.field_overrides[fieldName];
      merged.field_overrides[fieldName] = existing
        ? Object.assign({}, existing, fieldOverride)
        : Object.assign({}, fieldOverride);
    }
  }

  return merged;
}

/**
 * Apply flow skip modifications: remove skipped steps from steps list and definitions.
 * Logs warnings for dangling `then` references that point to skipped steps.
 */
function applyFlowSkips(flow: FlowConfig, skips: Set<string>): FlowConfig {
  const filteredSteps = flow.steps.filter((step) => !skips.has(step));

  // Also remove skipped steps from definitions
  let filteredDefinitions = flow.definitions;
  if (flow.definitions) {
    filteredDefinitions = { ...flow.definitions };
    for (const stepName of skips) {
      delete filteredDefinitions[stepName];
    }

    // Warn about dangling `then` references to skipped steps
    for (const [name, def] of Object.entries(filteredDefinitions)) {
      if (def.then && skips.has(def.then)) {
        log.warn('Flow step references skipped step in then', {
          step: name,
          then: def.then,
          skippedBy: 'behavior_profile',
        });
      }
    }
  }

  return {
    ...flow,
    steps: filteredSteps,
    definitions: filteredDefinitions,
  };
}
