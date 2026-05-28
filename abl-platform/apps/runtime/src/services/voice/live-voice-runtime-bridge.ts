import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type { RealtimeVoiceProviderCapabilityProfile } from '@abl/compiler/platform/llm/realtime/types.js';
import type { ChannelOutcome } from '../channel/outcome.js';
import type { ExecutionResult, RuntimeSession } from '../execution/types.js';
import { getActiveThread } from '../execution/types.js';
import { buildProductionSessionLocator, type SessionLocator } from '../session/execution-scope.js';
import type { RuntimeExecutor } from '../runtime-executor.js';
import {
  buildVoicePromptProfile,
  type VoicePromptProfileMode,
  type VoicePromptProfileResult,
} from './voice-prompt-profile.js';
import type { VoicePromptProviderOverlay } from './voice-provider-prompt-overlay.js';
import type { VoiceSemanticConvergencePlan } from './voice-semantic-convergence.js';
import {
  executeVoiceTurn,
  serializeRealtimeVoiceTurnToolPayload,
} from './voice-turn-coordinator.js';

type LiveVoiceToolExecutor = Pick<RuntimeExecutor, 'executeRealtimeToolCall' | 'getSession'>;
type LiveVoiceTurnExecutor = Pick<
  RuntimeExecutor,
  'executeMessage' | 'getSession' | 'rehydrateSession'
>;

export type LiveVoiceTraceEvent = {
  type: string;
  data: Record<string, unknown>;
};

export interface BuildLiveVoicePromptSurfaceOptions {
  sessionId: string;
  agentIR: AgentIR;
  runtimeSession?: RuntimeSession;
  preferredProfile?: VoicePromptProfileMode;
  providerCapabilityProfile?: RealtimeVoiceProviderCapabilityProfile;
  providerPromptOverlay?: VoicePromptProviderOverlay;
  semanticConvergencePlan?: VoiceSemanticConvergencePlan;
  includeConversationHistory?: boolean;
}

export interface LiveVoicePromptSurface extends VoicePromptProfileResult {}

export interface ExecuteLiveVoiceToolCallOptions {
  runtimeExecutor: LiveVoiceToolExecutor;
  runtimeSession: RuntimeSession;
  toolName: string;
  input: Record<string, unknown>;
  tenantId?: string;
  projectId?: string;
  sessionLocator?: SessionLocator;
  onTraceEvent?: (event: LiveVoiceTraceEvent) => void;
  syncRuntimeSession?: boolean;
}

export interface LiveVoiceToolExecutionResult {
  rawResult: unknown;
  serializedResult: string;
  activeAgentName: string;
  activeAgentIR: AgentIR | null;
  runtimeSession: RuntimeSession;
}

export interface ExecuteLiveVoiceSemanticTurnOptions {
  channelType: string;
  runtimeExecutor: LiveVoiceTurnExecutor;
  runtimeSession: RuntimeSession;
  utterance: string;
  timeoutMs: number;
  promptProfile: VoicePromptProfileMode;
  tenantId?: string;
  projectId?: string;
  sessionLocator?: SessionLocator;
  onChunk?: (chunk: string) => void;
  onTraceEvent?: (event: LiveVoiceTraceEvent) => void;
  channelMetadata?: {
    channel: string;
    contentLength: number;
  };
  syncRuntimeSession?: boolean;
}

export interface LiveVoiceSemanticTurnResult {
  outcome: ChannelOutcome;
  executionResult?: ExecutionResult;
  serializedResult: string;
  activeAgentName: string;
  activeAgentIR: AgentIR | null;
  runtimeSession: RuntimeSession;
}

export function buildLiveVoicePromptSurface(
  options: BuildLiveVoicePromptSurfaceOptions,
): LiveVoicePromptSurface {
  const promptProfile = buildVoicePromptProfile({
    sessionId: options.sessionId,
    agentIR: options.agentIR,
    runtimeSession: options.runtimeSession,
    preferredProfile: options.preferredProfile,
    providerCapabilityProfile: options.providerCapabilityProfile,
    providerPromptOverlay: options.providerPromptOverlay,
    semanticConvergencePlan: options.semanticConvergencePlan,
  });

  if (!options.includeConversationHistory || !options.runtimeSession) {
    return promptProfile;
  }

  const historyText = buildConversationHistoryText(options.runtimeSession.conversationHistory);
  if (!historyText) {
    return promptProfile;
  }

  return {
    ...promptProfile,
    systemPrompt: `${promptProfile.systemPrompt}\n\n## CONVERSATION HISTORY\n${historyText}`,
  };
}

export async function executeLiveVoiceToolCall(
  options: ExecuteLiveVoiceToolCallOptions,
): Promise<LiveVoiceToolExecutionResult> {
  const sessionLocator = resolveSessionLocator({
    tenantId: options.tenantId,
    projectId: options.projectId,
    runtimeSession: options.runtimeSession,
    sessionLocator: options.sessionLocator,
  });
  const toolExecution = await options.runtimeExecutor.executeRealtimeToolCall(
    options.runtimeSession.id,
    options.toolName,
    options.input,
    options.onTraceEvent,
    sessionLocator ? { sessionLocator } : undefined,
  );
  const resolvedRuntimeSession =
    options.runtimeExecutor.getSession(options.runtimeSession.id) ?? options.runtimeSession;
  const resolvedActiveAgent = resolveActiveAgent(resolvedRuntimeSession, options.runtimeSession);
  const activeAgent = {
    activeAgentName:
      typeof toolExecution.activeAgentName === 'string' && toolExecution.activeAgentName.length > 0
        ? toolExecution.activeAgentName
        : resolvedActiveAgent.activeAgentName,
    activeAgentIR: toolExecution.activeAgentIR ?? resolvedActiveAgent.activeAgentIR,
  };

  if (options.syncRuntimeSession !== false) {
    options.runtimeSession.agentName = activeAgent.activeAgentName;
    options.runtimeSession.agentIR = activeAgent.activeAgentIR;
    resolvedRuntimeSession.agentName = activeAgent.activeAgentName;
    resolvedRuntimeSession.agentIR = activeAgent.activeAgentIR;
  }

  return {
    rawResult: toolExecution.result,
    serializedResult: serializeToolResult(toolExecution.result),
    ...activeAgent,
    runtimeSession: resolvedRuntimeSession,
  };
}

export async function executeLiveVoiceSemanticTurn(
  options: ExecuteLiveVoiceSemanticTurnOptions,
): Promise<LiveVoiceSemanticTurnResult> {
  const sessionLocator = resolveSessionLocator({
    tenantId: options.tenantId,
    projectId: options.projectId,
    runtimeSession: options.runtimeSession,
    sessionLocator: options.sessionLocator,
  });
  const coordinatorResult = await executeVoiceTurn({
    channelType: options.channelType,
    executor: options.runtimeExecutor,
    sessionId: options.runtimeSession.id,
    utterance: options.utterance,
    timeoutMs: options.timeoutMs,
    promptProfile: options.promptProfile,
    onChunk: options.onChunk,
    onTraceEvent: options.onTraceEvent,
    executeOptions: {
      ...(sessionLocator ? { sessionLocator } : {}),
      ...(options.channelMetadata ? { channelMetadata: options.channelMetadata } : {}),
    },
  });
  const resolvedRuntimeSession =
    coordinatorResult.runtimeSession ??
    options.runtimeExecutor.getSession(options.runtimeSession.id) ??
    options.runtimeSession;
  const activeAgent = resolveActiveAgent(resolvedRuntimeSession, options.runtimeSession);

  if (options.syncRuntimeSession !== false) {
    options.runtimeSession.agentName = activeAgent.activeAgentName;
    options.runtimeSession.agentIR = activeAgent.activeAgentIR;
  }

  return {
    outcome: coordinatorResult.outcome,
    executionResult: coordinatorResult.executionResult,
    serializedResult: serializeRealtimeVoiceTurnToolPayload(coordinatorResult.outcome, {
      channelType: options.channelType,
    }),
    ...activeAgent,
    runtimeSession: resolvedRuntimeSession,
  };
}

function resolveSessionLocator(params: {
  tenantId?: string;
  projectId?: string;
  runtimeSession: RuntimeSession;
  sessionLocator?: SessionLocator;
}): SessionLocator | undefined {
  if (params.sessionLocator) {
    return params.sessionLocator;
  }

  return (
    buildProductionSessionLocator({
      tenantId: params.tenantId,
      projectId: params.projectId,
      sessionId: params.runtimeSession.id,
    }) ?? undefined
  );
}

function resolveActiveAgent(
  runtimeSession: RuntimeSession,
  fallbackSession: RuntimeSession,
): {
  activeAgentName: string;
  activeAgentIR: AgentIR | null;
} {
  const activeThread = getSafeActiveThread(runtimeSession);

  return {
    activeAgentName:
      activeThread?.agentName ??
      runtimeSession.agentName ??
      fallbackSession.agentName ??
      fallbackSession.agentIR?.metadata.name ??
      'voice_agent',
    activeAgentIR:
      activeThread?.agentIR ?? runtimeSession.agentIR ?? fallbackSession.agentIR ?? null,
  };
}

function getSafeActiveThread(runtimeSession: RuntimeSession) {
  try {
    return getActiveThread(runtimeSession);
  } catch {
    return undefined;
  }
}

function serializeToolResult(result: unknown): string {
  return typeof result === 'string' ? result : JSON.stringify(result ?? null);
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
