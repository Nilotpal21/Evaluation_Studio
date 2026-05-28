import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type {
  RealtimeVoiceProviderCapabilityProfile,
  RealtimeProviderType,
} from '@abl/compiler/platform/llm/realtime/types.js';
import type { ToolDefinition } from '@abl/compiler/platform/llm/types.js';
import {
  buildCanonicalVoicePromptSurface,
  type CanonicalVoicePromptSurface,
} from '../execution/prompt-builder.js';
import type { RuntimeSession } from '../execution/types.js';
import {
  applyVoicePromptProviderOverlay,
  describeVoicePromptProviderOverlay,
  resolveVoicePromptProviderOverlay,
  type VoicePromptProviderOverlay,
} from './voice-provider-prompt-overlay.js';
import type {
  VoiceSemanticConvergenceMode,
  VoiceSemanticConvergencePlan,
  VoiceSemanticConvergenceStrategy,
} from './voice-semantic-convergence.js';

const REALTIME_VOICE_PROMPT_APPENDIX = [
  '## Realtime Voice Operating Mode',
  'You are speaking live over audio.',
  'Keep spoken replies concise, natural, and easy to say aloud.',
  'Prefer one or two short sentences before asking a follow-up question.',
  'If the caller interrupts or changes direction, respond to the latest request without narrating internal state.',
  'Use tools only when they materially improve the next spoken reply.',
].join('\n');

const REALTIME_VOICE_COORDINATOR_APPENDIX = [
  '## Canonical Voice Turn Tool',
  'For every finalized user utterance, call `__voice_runtime_turn__` before you answer.',
  'Pass the exact finalized utterance in the `utterance` argument whenever you have it.',
  'After the tool returns, read only the `response_text` field from the returned JSON to the caller.',
  'Do not paraphrase, add extra content, describe diagnostics, or mention tool execution.',
  'Do not call any other tools directly while this coordinator tool is active.',
].join('\n');

export const REALTIME_VOICE_TURN_TOOL_NAME = '__voice_runtime_turn__';

export type VoicePromptProfileMode = 'pipeline' | 'realtime';

export type VoicePromptRefreshMode = 'supported' | 'immutable' | 'not_applicable';

export interface VoicePromptProfileDiagnostics {
  profile: VoicePromptProfileMode;
  providerType?: RealtimeProviderType;
  providerPromptOverlay?: VoicePromptProviderOverlay;
  promptRefresh: VoicePromptRefreshMode;
  toolRefresh: VoicePromptRefreshMode;
  capabilityNotes: string[];
  usingRuntimeSession: boolean;
  semanticConvergenceMode: VoiceSemanticConvergenceMode;
  semanticStrategy: VoiceSemanticConvergenceStrategy;
  semanticFamily?: VoiceSemanticConvergencePlan['family'];
}

export interface VoicePromptProfileResult extends CanonicalVoicePromptSurface {
  profile: VoicePromptProfileMode;
  diagnostics: VoicePromptProfileDiagnostics;
}

export interface BuildVoicePromptProfileOptions {
  sessionId: string;
  agentIR: AgentIR;
  runtimeSession?: RuntimeSession;
  preferredProfile?: VoicePromptProfileMode;
  providerCapabilityProfile?: RealtimeVoiceProviderCapabilityProfile;
  providerPromptOverlay?: VoicePromptProviderOverlay;
  semanticConvergencePlan?: VoiceSemanticConvergencePlan;
}

export function resolveVoicePromptProfile(
  options: Pick<BuildVoicePromptProfileOptions, 'preferredProfile' | 'providerCapabilityProfile'>,
): VoicePromptProfileMode {
  if (options.preferredProfile) {
    return options.preferredProfile;
  }

  if (options.providerCapabilityProfile) {
    return 'realtime';
  }

  return 'pipeline';
}

export function buildVoicePromptProfile(
  options: BuildVoicePromptProfileOptions,
): VoicePromptProfileResult {
  const profile = resolveVoicePromptProfile(options);
  const promptSession = buildPromptRuntimeSession(options);
  const canonicalSurface = buildCanonicalVoicePromptSurface(promptSession);
  const semanticPlan = options.semanticConvergencePlan;
  const useCoordinatorTool =
    profile === 'realtime' && semanticPlan?.strategy === 'coordinator_tool';
  const realtimeAppendices = useCoordinatorTool
    ? [REALTIME_VOICE_PROMPT_APPENDIX, REALTIME_VOICE_COORDINATOR_APPENDIX]
    : [REALTIME_VOICE_PROMPT_APPENDIX];
  const providerPromptOverlay = resolveVoicePromptProviderOverlay(options);
  const baseSystemPrompt =
    profile === 'realtime'
      ? [canonicalSurface.systemPrompt, ...realtimeAppendices].join('\n\n')
      : canonicalSurface.systemPrompt;

  return {
    profile,
    systemPrompt:
      profile === 'realtime'
        ? applyVoicePromptProviderOverlay(baseSystemPrompt, providerPromptOverlay)
        : baseSystemPrompt,
    tools: useCoordinatorTool ? [buildRealtimeVoiceTurnTool()] : canonicalSurface.tools,
    diagnostics: buildDiagnostics(
      profile,
      options.providerCapabilityProfile,
      providerPromptOverlay,
      !!options.runtimeSession,
      semanticPlan,
    ),
  };
}

function buildDiagnostics(
  profile: VoicePromptProfileMode,
  providerCapabilityProfile: RealtimeVoiceProviderCapabilityProfile | undefined,
  providerPromptOverlay: VoicePromptProviderOverlay | undefined,
  usingRuntimeSession: boolean,
  semanticConvergencePlan: VoiceSemanticConvergencePlan | undefined,
): VoicePromptProfileDiagnostics {
  if (profile !== 'realtime' || !providerCapabilityProfile) {
    return {
      profile,
      providerPromptOverlay,
      promptRefresh: 'not_applicable',
      toolRefresh: 'not_applicable',
      capabilityNotes: describeVoicePromptProviderOverlay(providerPromptOverlay),
      usingRuntimeSession,
      semanticConvergenceMode: semanticConvergencePlan?.mode ?? 'off',
      semanticStrategy: semanticConvergencePlan?.strategy ?? 'legacy',
      semanticFamily: semanticConvergencePlan?.family,
    };
  }

  return {
    profile,
    providerType: providerCapabilityProfile.providerType,
    providerPromptOverlay,
    promptRefresh: providerCapabilityProfile.capabilities.supportsPromptRefresh
      ? 'supported'
      : 'immutable',
    toolRefresh: providerCapabilityProfile.capabilities.supportsToolRefresh
      ? 'supported'
      : 'immutable',
    capabilityNotes: [
      ...describeVoicePromptProviderOverlay(providerPromptOverlay),
      ...providerCapabilityProfile.notes,
      ...(semanticConvergencePlan?.notes ?? []),
    ],
    usingRuntimeSession,
    semanticConvergenceMode: semanticConvergencePlan?.mode ?? 'off',
    semanticStrategy: semanticConvergencePlan?.strategy ?? 'legacy',
    semanticFamily: semanticConvergencePlan?.family,
  };
}

function buildRealtimeVoiceTurnTool(): ToolDefinition {
  return {
    name: REALTIME_VOICE_TURN_TOOL_NAME,
    description:
      'Execute the canonical runtime voice turn for the latest finalized user utterance and return the spoken response payload.',
    input_schema: {
      type: 'object',
      properties: {
        utterance: {
          type: 'string',
          description: 'The exact finalized user utterance for this turn.',
        },
      },
      required: ['utterance'],
    },
  };
}

function buildPromptRuntimeSession(options: BuildVoicePromptProfileOptions): RuntimeSession {
  if (options.runtimeSession) {
    return toVoicePromptSession(options.runtimeSession, options.agentIR);
  }

  return buildSyntheticRuntimeSession(options);
}

function toVoicePromptSession(baseSession: RuntimeSession, agentIR: AgentIR): RuntimeSession {
  const sessionValues = baseSession.data?.values ?? {};
  const rawSessionMeta = sessionValues.session;
  const sessionMeta =
    rawSessionMeta && typeof rawSessionMeta === 'object' && !Array.isArray(rawSessionMeta)
      ? (rawSessionMeta as Record<string, unknown>)
      : {};

  return {
    ...baseSession,
    agentName: agentIR.metadata.name,
    agentIR,
    channelType: baseSession.channelType ?? 'voice',
    data: {
      ...baseSession.data,
      values: {
        ...sessionValues,
        session: {
          ...sessionMeta,
          channel: baseSession.channelType ?? 'voice',
        },
      },
    },
  };
}

function buildSyntheticRuntimeSession(options: BuildVoicePromptProfileOptions): RuntimeSession {
  return {
    id: options.sessionId,
    agentName: options.agentIR.metadata.name,
    agentIR: options.agentIR,
    compilationOutput: null,
    conversationHistory: [],
    state: {
      gatherProgress: {},
      conversationPhase: 'start',
      context: {},
    },
    data: {
      values: {
        session: {
          channel: 'voice',
        },
      },
      gatheredKeys: new Set<string>(),
    },
    isComplete: false,
    isEscalated: false,
    handoffStack: [options.agentIR.metadata.name],
    delegateStack: [],
    initialized: false,
    threads: [],
    activeThreadIndex: 0,
    threadStack: [],
    channelType: 'voice',
    createdAt: new Date(),
    lastActivityAt: new Date(),
    storeVersion: 0,
  } as RuntimeSession;
}
