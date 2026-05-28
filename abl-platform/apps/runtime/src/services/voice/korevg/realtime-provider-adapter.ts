import type { AgentIR } from '@abl/compiler/platform/ir/schema.js';
import type { RuntimeSession } from '../../execution/types.js';
import {
  buildLiveVoicePromptSurface,
  type LiveVoicePromptSurface,
} from '../live-voice-runtime-bridge.js';
import type { S2SSessionConfig, S2SProviderType } from '../s2s/types.js';
import type { VoicePromptProviderOverlay } from '../voice-provider-prompt-overlay.js';
import { buildGrokLlmVerbPayload, type GrokLlmVerbPayload } from './grok-llm-payload.js';
import {
  buildRealtimeLlmVerbPayload,
  type RealtimeLlmToolDefinition,
  type RealtimeLlmVerbPayload,
} from './realtime-llm-payload.js';
import {
  buildGoogleRealtimeToolDefinitions,
  toRealtimeToolDefinitions,
} from './realtime-tool-definitions.js';
import { buildGoogleToolResponse, buildOpenAIToolResponse } from './s2s-google-event-handler.js';
import { buildGoogleLlmVerb, type LlmVerbBase } from './s2s-llm-verb-builder.js';

export type KorevgRealtimeProviderKind = 'openai' | 'google' | 'grok';

export type KorevgRealtimeLlmVerb = RealtimeLlmVerbPayload | GrokLlmVerbPayload | LlmVerbBase;

export function isSupportedKorevgRealtimeS2SProvider(
  s2sProvider: S2SProviderType,
): s2sProvider is 's2s:openai' | 's2s:microsoft' | 's2s:google' | 's2s:grok' {
  return (
    s2sProvider === 's2s:openai' ||
    s2sProvider === 's2s:microsoft' ||
    s2sProvider === 's2s:google' ||
    s2sProvider === 's2s:grok'
  );
}

export interface KorevgRealtimePromptState {
  providerKind: KorevgRealtimeProviderKind;
  providerPromptOverlay: VoicePromptProviderOverlay;
  promptSurface: LiveVoicePromptSurface;
  instructions: string;
  tools: RealtimeLlmToolDefinition[];
}

export interface BuildKorevgRealtimePromptStateOptions {
  sessionId: string;
  runtimeSession: RuntimeSession;
  entryAgentIR: AgentIR;
  s2sProvider: S2SProviderType;
  includeConversationHistory?: boolean;
}

export interface BuildKorevgRealtimeBootstrapOptions extends BuildKorevgRealtimePromptStateOptions {
  apiKey: string;
  s2sConfig: S2SSessionConfig;
  greetingMessage?: string | null;
}

export interface KorevgRealtimeBootstrap extends KorevgRealtimePromptState {
  llmVerb: KorevgRealtimeLlmVerb;
}

export interface BuildKorevgOpenAIHandoffCommandsOptions extends BuildKorevgRealtimePromptStateOptions {
  voice?: string;
}

export interface KorevgRealtimeCommandPlan extends KorevgRealtimePromptState {
  commands: Record<string, unknown>[];
}

export interface BuildKorevgGrokHandoffCommandsOptions extends BuildKorevgRealtimePromptStateOptions {
  apiKey: string;
  s2sConfig: S2SSessionConfig;
  handoffContext?: string;
  internalHandoffSpeech?: string;
}

export interface BuildKorevgGoogleInlineHandoffPayloadOptions extends BuildKorevgRealtimePromptStateOptions {
  activeAgentName: string;
}

export interface KorevgRealtimeInlineHandoffPayload extends KorevgRealtimePromptState {
  payload: Record<string, unknown>;
}

export interface BuildKorevgRealtimeToolDispatchPlanOptions {
  providerKind: KorevgRealtimeProviderKind;
  toolCallId: string;
  payload: unknown;
  actionToolSpeech?: string | null;
  deferImplicitFollowup?: boolean;
  voice?: string;
}

export interface KorevgRealtimeToolDispatchPlan {
  toolOutputCommand: Record<string, unknown>;
  followupCommands: Record<string, unknown>[];
  deferImplicitFollowup: boolean;
}

function numberOrDefault(value: unknown, defaultValue: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : defaultValue;
}

export function resolveKorevgRealtimeProviderKind(options: {
  s2sProvider: S2SProviderType;
  model?: string | null;
}): KorevgRealtimeProviderKind {
  if (options.s2sProvider === 's2s:grok') {
    return 'grok';
  }

  if (options.s2sProvider === 's2s:google') {
    return 'google';
  }

  if (options.s2sProvider === 's2s:openai' || options.s2sProvider === 's2s:microsoft') {
    return 'openai';
  }

  throw new Error(`Unsupported KoreVG realtime S2S provider: ${options.s2sProvider}`);
}

export function buildKorevgRealtimeBootstrap(
  options: BuildKorevgRealtimeBootstrapOptions,
): KorevgRealtimeBootstrap {
  const promptState = buildKorevgRealtimePromptState(options);
  const greetingMessage = options.greetingMessage ?? undefined;

  const llmVerb =
    promptState.providerKind === 'grok'
      ? buildGrokLlmVerbPayload({
          apiKey: options.apiKey,
          instructions: promptState.instructions,
          s2sConfig: options.s2sConfig,
          tools: promptState.tools,
          handoffContext: greetingMessage,
        })
      : promptState.providerKind === 'google'
        ? buildGoogleLlmVerb({
            model: (options.s2sConfig.model as string) || 'gemini-3.1-flash-live-preview',
            apiKey: options.apiKey,
            instructions: promptState.instructions,
            voice: (options.s2sConfig.voice as string) || 'Puck',
            tools: promptState.tools as unknown as Array<Record<string, unknown>>,
            temperature: numberOrDefault(options.s2sConfig.temperature, 0.8),
            startSensitivity: options.s2sConfig.startSensitivity as string | undefined,
            endSensitivity: options.s2sConfig.endSensitivity as string | undefined,
            prefixPadding: options.s2sConfig.prefixPadding as number | undefined,
            silenceDuration: options.s2sConfig.silenceDuration as number | undefined,
            greetingMessage,
          })
        : buildRealtimeLlmVerbPayload({
            apiKey: options.apiKey,
            instructions: promptState.instructions,
            s2sConfig: options.s2sConfig,
            tools: promptState.tools,
            greetingMessage,
          });

  return {
    ...promptState,
    llmVerb,
  };
}

export function buildKorevgOpenAIHandoffCommands(
  options: BuildKorevgOpenAIHandoffCommandsOptions,
): KorevgRealtimeCommandPlan {
  const promptState = buildKorevgRealtimePromptState({
    ...options,
    includeConversationHistory: true,
  });

  return {
    ...promptState,
    commands: [
      buildKorevgLlmUpdateCommand(
        buildOpenAISessionUpdateMessage(promptState.instructions, promptState.tools, options.voice),
      ),
    ],
  };
}

export function buildKorevgGrokHandoffCommands(
  options: BuildKorevgGrokHandoffCommandsOptions,
): KorevgRealtimeCommandPlan {
  const promptState = buildKorevgRealtimePromptState({
    ...options,
    includeConversationHistory: true,
  });
  const inlineHandoffPayload = buildGrokLlmVerbPayload({
    apiKey: options.apiKey,
    instructions: promptState.instructions,
    s2sConfig: options.s2sConfig,
    tools: promptState.tools,
    includeResponseCreate: false,
    handoffContext: options.handoffContext,
    internalHandoffSpeech: options.internalHandoffSpeech,
  });

  return {
    ...promptState,
    commands: [
      buildKorevgLlmUpdateCommand({
        type: 'session.update',
        session: inlineHandoffPayload.llmOptions.session_update,
      }),
      buildKorevgLlmUpdateCommand({
        type: 'response.create',
        response: inlineHandoffPayload.llmOptions.response_create,
      }),
    ],
  };
}

export function buildKorevgGoogleInlineHandoffPayload(
  options: BuildKorevgGoogleInlineHandoffPayloadOptions,
): KorevgRealtimeInlineHandoffPayload {
  const promptState = buildKorevgRealtimePromptState({
    ...options,
    includeConversationHistory: true,
  });
  const payload: Record<string, unknown> = {
    active_agent: options.activeAgentName,
    continue_current_turn: true,
  };
  const runtimeInstructions = promptState.instructions.trim();

  if (runtimeInstructions.length > 0) {
    payload.runtime_instructions = runtimeInstructions;
  }

  return {
    ...promptState,
    payload,
  };
}

export function buildKorevgRealtimeToolDispatchPlan(
  options: BuildKorevgRealtimeToolDispatchPlanOptions,
): KorevgRealtimeToolDispatchPlan {
  const deferImplicitFollowup =
    options.providerKind !== 'google' &&
    (options.deferImplicitFollowup === true || !!options.actionToolSpeech?.trim());
  const providerToolMessage =
    options.providerKind === 'google'
      ? buildGoogleToolResponse(options.toolCallId, options.payload)
      : buildOpenAIToolResponse(options.toolCallId, options.payload);
  const toolOutputPayload = deferImplicitFollowup
    ? { ...providerToolMessage, defer_response_create: true }
    : providerToolMessage;

  return {
    toolOutputCommand: buildKorevgToolOutputCommand(options.toolCallId, toolOutputPayload),
    followupCommands:
      deferImplicitFollowup && options.actionToolSpeech
        ? [
            buildKorevgLlmUpdateCommand(
              buildOpenAIResponseCreateMessage(options.actionToolSpeech, options.voice),
            ),
          ]
        : [],
    deferImplicitFollowup,
  };
}

export function buildKorevgRealtimeToolErrorCommand(options: {
  providerKind: KorevgRealtimeProviderKind;
  toolCallId: string;
  errorMessage: string;
}): Record<string, unknown> {
  const providerToolMessage =
    options.providerKind === 'google'
      ? buildGoogleToolResponse(options.toolCallId, {
          error: options.errorMessage,
          success: false,
        })
      : buildOpenAIToolResponse(options.toolCallId, options.errorMessage);

  return buildKorevgToolOutputCommand(options.toolCallId, providerToolMessage);
}

export function buildKorevgToolOutputCommand(
  toolCallId: string,
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'command',
    command: 'llm:tool-output',
    tool_call_id: toolCallId,
    data,
  };
}

export function buildKorevgLlmUpdateCommand(
  data: Record<string, unknown>,
): Record<string, unknown> {
  return {
    type: 'command',
    command: 'llm:update',
    data,
  };
}

export function buildOpenAISessionUpdateMessage(
  instructions: string,
  tools: RealtimeLlmToolDefinition[],
  voice?: string,
): Record<string, unknown> {
  const session: Record<string, unknown> = { instructions };
  if (voice) {
    session.voice = voice;
  }
  if (tools.length > 0) {
    session.tools = tools;
    session.tool_choice = 'auto';
  } else {
    session.tools = [];
  }

  return {
    type: 'session.update',
    session,
  };
}

export function buildOpenAIResponseCreateMessage(
  text: string,
  voice?: string,
): Record<string, unknown> {
  const response: Record<string, unknown> = {
    modalities: ['text', 'audio'],
    instructions: `Respond to the caller with exactly this text and nothing else:\n${text}`,
  };
  if (voice) {
    response.voice = voice;
  }
  return {
    type: 'response.create',
    response,
  };
}

export function buildKorevgRealtimePromptState(
  options: BuildKorevgRealtimePromptStateOptions,
): KorevgRealtimePromptState {
  const sessionNamespace =
    options.runtimeSession.data?.values?.session &&
    typeof options.runtimeSession.data.values.session === 'object' &&
    !Array.isArray(options.runtimeSession.data.values.session)
      ? (options.runtimeSession.data.values.session as Record<string, unknown>)
      : null;
  const providerKind = resolveKorevgRealtimeProviderKind({
    s2sProvider: options.s2sProvider,
    model: typeof sessionNamespace?.s2sModel === 'string' ? sessionNamespace.s2sModel : undefined,
  });
  const providerPromptOverlay = resolveKorevgProviderPromptOverlay(providerKind);
  const promptSurface = buildLiveVoicePromptSurface({
    sessionId: options.sessionId,
    agentIR: options.runtimeSession.agentIR ?? options.entryAgentIR,
    runtimeSession: options.runtimeSession,
    preferredProfile: 'realtime',
    providerPromptOverlay,
    includeConversationHistory: options.includeConversationHistory,
  });
  const tools =
    providerKind === 'google'
      ? buildGoogleRealtimeToolDefinitions(options.runtimeSession)
      : toRealtimeToolDefinitions(promptSurface.tools);

  return {
    providerKind,
    providerPromptOverlay,
    promptSurface,
    instructions: promptSurface.systemPrompt,
    tools,
  };
}

function resolveKorevgProviderPromptOverlay(
  providerKind: KorevgRealtimeProviderKind,
): VoicePromptProviderOverlay {
  switch (providerKind) {
    case 'google':
      return 'gemini_live';
    case 'grok':
      return 'grok_realtime';
    default:
      return 'openai_realtime';
  }
}
