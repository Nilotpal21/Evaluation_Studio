/**
 * Korevg WebSocket Router
 *
 * Handles WebSocket connections from Korevg/Jambonz and routes them to
 * KorevgSession instances for processing.
 */

import { WebSocket, WebSocketServer } from 'ws';
import type { IncomingMessage } from 'http';
import type { Duplex } from 'stream';
import { createLogger } from '@abl/compiler/platform';
import { getRuntimeExecutor } from '../../runtime-executor.js';
import { KorevgSession, type KorevgSessionConfig } from './korevg-session.js';
import {
  RealtimeVoiceGatewaySession,
  registerRealtimeVoiceSession,
  unregisterRealtimeVoiceSession,
  getRealtimeVoiceSession,
  CSAT_GATHER_HOOK,
} from './realtime-voice-session.js';
import { randomBytes, randomUUID } from 'crypto';
import { getRuntimeEventBus } from '../../../services/event-bus/runtime-bus-accessor.js';
import { emitVoiceSessionEnded, emitVoiceMessage } from './voice-session-event.js';
import { DeploymentResolver } from '../../deployment-resolver.js';
import { resolveRequiredContactProductionScope } from '../../session/production-contact-scope.js';
import { getSessionService } from '../../session/session-service.js';
import { extractIngressToken, tokensMatch } from '@agent-platform/shared-kernel/security';
import {
  MAX_KOREVG_SESSIONS,
  DEFAULT_KOREVG_TTS_VENDOR,
  DEFAULT_KOREVG_TTS_VOICE,
  DEFAULT_KOREVG_STT_VENDOR,
  WS_MESSAGE_TIMEOUT_MS,
} from '../../channel/constants.js';
import { VoiceServiceFactory } from '../voice-service-factory.js';
import { S2SSessionBridge, type S2SSessionBridgeConfig } from '../s2s/S2SSessionBridge.js';
import type { S2SSessionConfig, S2SProviderType } from '../s2s/types.js';
import { getTraceStore, type TraceEvent } from '../../trace-store.js';
import { addScrubbedVoiceTraceEvent } from './voice-trace-scrubbing.js';
import {
  GoogleTranscriptAccumulator,
  extractGoogleInputTranscript,
  extractGoogleToolCalls,
  buildGoogleToolResponse,
  isGoogleSetupComplete,
  isGoogleInterrupted,
  type GoogleServerEvent,
} from './s2s-google-event-handler.js';
import { buildCallerContext } from '../../identity/artifact-hasher.js';
import {
  linkResolvedContactToSession,
  resolveContactIdFromChannelIdentity,
} from '../../identity/channel-contact-linking.js';
import { resolveProviderVerification } from '../../identity/provider-verification-policy.js';
import type { CallerContext, ChannelArtifactType } from '@agent-platform/shared-auth';
import { createAndLinkDBSession } from '../../../channels/pipeline/session-factory.js';
import { applyCallerContextToRuntimeSession } from '../../session/runtime-session-identity.js';
import {
  buildSessionLocalizationCatalog,
  resolveLocalizedAgentMessage,
  storeRuntimeSessionLocalizationCatalog,
} from '../../execution/localized-messages.js';
import type { RuntimeSession } from '../../execution/types.js';
import { loadConfigVariablesMap } from '../../../repos/project-repo.js';
import {
  coerceSessionMetadata,
  isSessionMetadataValidationError,
  mergeSessionMetadata,
} from '../../session-metadata.js';
import {
  registerRealtimeInterruptionTarget,
  unregisterRealtimeInterruptionTarget,
} from '../realtime-interruption-coordinator.js';
import {
  executeLiveVoiceSemanticTurn,
  executeLiveVoiceToolCall,
} from '../live-voice-runtime-bridge.js';
import {
  UltravoxTranscriptAccumulator,
  buildProviderAwareLlmVerbPayload,
  buildProviderToolErrorMessage,
  buildProviderToolResponseMessage,
  getS2SProviderFamily,
  getS2STraceProviderName,
  translateProviderEventToRealtimeEvents,
} from './s2s-provider-adapter.js';
import {
  buildKorevgGrokHandoffCommands,
  buildKorevgGoogleInlineHandoffPayload,
  buildKorevgLlmUpdateCommand,
  buildKorevgOpenAIHandoffCommands,
  buildKorevgRealtimeBootstrap,
  buildKorevgRealtimePromptState,
  buildKorevgRealtimeToolDispatchPlan,
  buildKorevgRealtimeToolErrorCommand,
  buildKorevgToolOutputCommand,
  isSupportedKorevgRealtimeS2SProvider,
} from './realtime-provider-adapter.js';
import type { RealtimeLlmToolDefinition } from './realtime-llm-payload.js';
import { resolveConversationBehaviorVoiceRuntimeConfig } from '../../execution/conversation-behavior-resolver.js';
import type { ResponseMessageMetadata } from '../../channel/response-provenance.js';
import type { ClickHouseMetricsStore } from '../../stores/clickhouse-metrics-store.js';
import { hasKnownPricing, getModelCapabilities, calculateCost } from '../../llm/model-router.js';

const log = createLogger('korevg-router');
type ResolvedVoiceAgentIR = Exclude<RuntimeSession['agentIR'], null>;
const MAX_BOOTSTRAP_BUFFERED_MESSAGES = 128;
const KOREVG_CALLER_ANI_CONTEXT_KEY = 'caller_ani';
const KOREVG_DNIS_CONTEXT_KEY = 'dnis';
const REALTIME_ASSISTANT_TRANSCRIPT_METADATA: ResponseMessageMetadata = {
  isLlmGenerated: true,
  responseProvenance: {
    schemaVersion: 1,
    kind: 'llm',
    disclaimerRequired: true,
    usedLlmInternally: true,
  },
};

// Type mapping for voice events: trace format (underscores) → EventStore format (dots)
const VOICE_EVENT_TYPE_MAP: Record<string, string> = {
  llm_call: 'llm.call.completed',
  voice_session_start: 'voice.session.started',
  voice_session_end: 'voice.session.ended',
  voice_turn: 'voice.turn.completed',
  voice_stt: 'voice.stt.completed',
  voice_tts: 'voice.tts.completed',
  voice_realtime_tool_call: 'voice.realtime.tool_call',
  voice_barge_in: 'voice.barge_in.detected',
  voice_asr_quality: 'voice.asr_quality.analyzed',
  voice_tts_quality: 'voice.tts_quality.measured',
  voice_asr_cascade: 'voice.asr_cascade.detected',
  voice_config_resolved: 'agent.voice.config_resolved',
};

const _chMetricsStores = new Map<string, ClickHouseMetricsStore>();

async function getClickHouseMetricsStore(tenantId: string): Promise<ClickHouseMetricsStore> {
  if (!_chMetricsStores.has(tenantId)) {
    if (_chMetricsStores.size >= 50) {
      const oldest = _chMetricsStores.keys().next().value;
      if (oldest !== undefined) _chMetricsStores.delete(oldest);
    }
    const { getClickHouseClient } = await import('@agent-platform/database/clickhouse');
    const client = getClickHouseClient();
    if (!client) throw new Error('ClickHouse client not available');
    const { ClickHouseMetricsStore: Store } =
      await import('../../stores/clickhouse-metrics-store.js');
    _chMetricsStores.set(tenantId, new Store({ type: 'clickhouse' }, { client, tenantId }));
  }
  return _chMetricsStores.get(tenantId)!;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

function asNumber(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    if (value === 'true') return true;
    if (value === 'false') return false;
  }
  return undefined;
}

function buildElevenLabsTtsOptions(
  config: Record<string, unknown>,
): Record<string, unknown> | undefined {
  if (config.ttsVendor !== 'elevenlabs') return undefined;

  const options: Record<string, unknown> = {};
  const speed = asNumber(config.ttsSpeed);
  const stability = asNumber(config.ttsStability);
  const similarityBoost = asNumber(config.ttsSimilarityBoost);
  const style = asNumber(config.ttsStyle);
  const useSpeakerBoost = asBoolean(config.ttsUseSpeakerBoost);

  if (speed !== undefined) options.speed = speed;
  if (stability !== undefined) options.stability = stability;
  if (similarityBoost !== undefined) options.similarity_boost = similarityBoost;
  if (style !== undefined) options.style = style;
  if (useSpeakerBoost !== undefined) options.use_speaker_boost = useSpeakerBoost;

  return Object.keys(options).length > 0 ? options : undefined;
}

function getHeaderValue(
  headers: Record<string, unknown>,
  names: readonly string[],
): string | undefined {
  const normalizedNames = new Set(names.map((name) => name.toLowerCase()));
  for (const [key, value] of Object.entries(headers)) {
    if (normalizedNames.has(key.toLowerCase())) {
      return asString(value);
    }
  }
  return undefined;
}

function normalizePhoneLikeValue(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  const sipMatch = trimmed.match(/\bsips?:([^@;>\s]+)/i);
  const telMatch = trimmed.match(/\btel:([^;>\s]+)/i);
  const candidate = sipMatch?.[1] ?? telMatch?.[1] ?? trimmed;
  const digitsOnly = candidate.replace(/[\s\-().]/g, '');

  if (/^\+?\d{7,15}$/.test(digitsOnly)) {
    return digitsOnly.startsWith('+') ? digitsOnly : `+${digitsOnly}`;
  }

  return undefined;
}

const KOREVG_CALLER_PHONE_HEADER_NAMES = [
  'p-asserted-identity',
  'remote-party-id',
  'from',
  'x-caller-id',
  'x-twilio-callerid',
] as const;

const KOREVG_CALLED_PHONE_HEADER_NAMES = ['to', 'x-called-number'] as const;

function readStringList(value: unknown): string[] | undefined {
  const rawItems = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
  const seen = new Set<string>();
  const items = rawItems
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => {
      if (!item || seen.has(item)) {
        return false;
      }
      seen.add(item);
      return true;
    });

  return items.length > 0 ? items : undefined;
}

function extractKorevgSipHeaders(data: Record<string, unknown>): Record<string, unknown> {
  const sipInfo = isRecord(data.sip) ? data.sip : undefined;
  const sipHeaders = isRecord(sipInfo?.headers) ? sipInfo.headers : undefined;
  const legacySipHeaders = isRecord(data.sip_headers) ? data.sip_headers : undefined;

  return {
    ...(legacySipHeaders ?? {}),
    ...(sipHeaders ?? {}),
  };
}

function resolvePhoneLikeKorevgValue(params: {
  primary?: string;
  fallback?: string;
  headers: Record<string, unknown>;
  headerNames: readonly string[];
}): string | undefined {
  const primaryPhone = normalizePhoneLikeValue(params.primary);
  if (primaryPhone) {
    return primaryPhone;
  }

  for (const headerName of params.headerNames) {
    const headerPhone = normalizePhoneLikeValue(getHeaderValue(params.headers, [headerName]));
    if (headerPhone) {
      return headerPhone;
    }
  }

  return asString(params.primary) ?? asString(params.fallback);
}

function normalizeVoiceArtifact(
  raw: string | undefined,
): { channelArtifact: string; channelArtifactType: ChannelArtifactType } | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!trimmed) return null;

  if (/^sips?:/i.test(trimmed)) {
    return { channelArtifact: trimmed.toLowerCase(), channelArtifactType: 'sip_uri' };
  }

  const digitsOnly = trimmed.replace(/[\s\-().]/g, '');
  if (/^\+?\d{7,15}$/.test(digitsOnly)) {
    return {
      channelArtifact: digitsOnly.startsWith('+') ? digitsOnly : `+${digitsOnly}`,
      channelArtifactType: 'caller_id',
    };
  }

  return { channelArtifact: trimmed, channelArtifactType: 'caller_id' };
}

function getGrokResponseId(eventData: Record<string, unknown>): string | null {
  const responseId = asString(eventData.response_id) ?? asString(eventData.responseId);
  if (responseId) {
    return responseId;
  }

  const response = eventData.response;
  if (!isRecord(response)) {
    return null;
  }

  return asString(response.id) ?? asString(response.response_id) ?? null;
}

function readTokenCount(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.trunc(value));
  }

  if (typeof value === 'string' && value.trim()) {
    const parsed = Number.parseInt(value.trim(), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : undefined;
  }

  return undefined;
}

function extractRealtimeLlmUsage(eventData: Record<string, unknown>): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
} {
  const response = isRecord(eventData.response) ? eventData.response : undefined;
  const usage = isRecord(response?.usage)
    ? response.usage
    : isRecord(eventData.usage)
      ? eventData.usage
      : undefined;

  const inputTokens =
    readTokenCount(usage?.inputTokens) ??
    readTokenCount(usage?.input_tokens) ??
    readTokenCount(usage?.promptTokens) ??
    readTokenCount(usage?.prompt_tokens) ??
    0;
  const outputTokens =
    readTokenCount(usage?.outputTokens) ??
    readTokenCount(usage?.output_tokens) ??
    readTokenCount(usage?.completionTokens) ??
    readTokenCount(usage?.completion_tokens) ??
    0;
  const totalTokens =
    readTokenCount(usage?.totalTokens) ??
    readTokenCount(usage?.total_tokens) ??
    inputTokens + outputTokens;

  return {
    inputTokens,
    outputTokens,
    totalTokens,
  };
}

function summarizeHookPayload(data: unknown): Record<string, unknown> | undefined {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return undefined;
  }

  const record = data as Record<string, unknown>;
  const summary: Record<string, unknown> = {
    keys: Object.keys(record),
  };

  if (typeof record.completion_reason === 'string') {
    summary.completionReason = record.completion_reason;
  }
  if (typeof record.reason === 'string') {
    summary.reason = record.reason;
  }
  if (typeof record.status === 'string') {
    summary.status = record.status;
  }
  if (typeof record.error === 'string') {
    summary.error = record.error;
  }
  if (typeof record.error_code === 'string' || typeof record.error_code === 'number') {
    summary.errorCode = record.error_code;
  }
  if (typeof record.call_status === 'string') {
    summary.callStatus = record.call_status;
  }

  return summary;
}

function messageContentToText(
  content: RuntimeSession['conversationHistory'][number]['content'],
): string {
  if (typeof content === 'string') {
    return content;
  }

  return content
    .map((block) => (block.type === 'text' ? (block.text ?? '') : ''))
    .filter(Boolean)
    .join(' ');
}

function appendTranscriptToRuntimeHistory(
  executor: {
    addMessage?: (
      sessionId: string,
      role: string,
      content: string,
      metadata?: Record<string, unknown>,
    ) => void;
  },
  runtimeSession: RuntimeSession,
  role: 'user' | 'assistant',
  transcript: string,
  metadata?: ResponseMessageMetadata,
): void {
  const normalizedTranscript = transcript.trim();
  if (!normalizedTranscript) {
    return;
  }

  const lastMessage = runtimeSession.conversationHistory.at(-1);
  const lastText = lastMessage ? messageContentToText(lastMessage.content).trim() : '';
  if (lastMessage?.role === role && lastText === normalizedTranscript) {
    return;
  }

  if (typeof executor.addMessage === 'function') {
    executor.addMessage(runtimeSession.id, role, normalizedTranscript, metadata);
    return;
  }

  runtimeSession.conversationHistory.push({
    role,
    content: normalizedTranscript,
    ...(metadata ? { metadata } : {}),
  });
}

function buildGrokHandoffContextSummary(userText: string): string {
  return `The customer previously said:\n${userText}\n\nContinue from where the conversation left off. Do not ask them to repeat information they already provided.`;
}

function buildUserConversationHistoryText(
  conversationHistory: RuntimeSession['conversationHistory'],
): string {
  if (!conversationHistory || conversationHistory.length === 0) {
    return '';
  }

  return conversationHistory
    .filter((msg) => msg.role === 'user')
    .map((msg) => messageContentToText(msg.content).trim())
    .filter(Boolean)
    .join('\n');
}

function buildKorevgTtsClearCommand(): Record<string, unknown> {
  return {
    type: 'command',
    command: 'tts:clear',
  };
}

function buildKorevgRealtimeInterruptCommands(
  provider: S2SProviderType,
): Record<string, unknown>[] {
  const commands: Record<string, unknown>[] = [buildKorevgTtsClearCommand()];

  if (provider === 's2s:openai' || provider === 's2s:grok') {
    commands.push(buildKorevgLlmUpdateCommand({ type: 'response.cancel' }));
  }

  return commands;
}

function isBufferedSessionNewMessage(data: Buffer): boolean {
  try {
    const message = JSON.parse(data.toString()) as { type?: unknown };
    return message?.type === 'session:new';
  } catch {
    return false;
  }
}

function extractActionToolSpeechPayload(toolName: string, result: unknown): unknown {
  if (!isActionTool(toolName) || !result || typeof result !== 'object') {
    return result;
  }

  if ('response' in result && typeof result.response === 'string' && result.response.trim()) {
    return result.response;
  }

  if ('message' in result && typeof result.message === 'string' && result.message.trim()) {
    return result.message;
  }

  if ('error' in result && typeof result.error === 'string' && result.error.trim()) {
    return result.error;
  }

  return result;
}

function shouldSpeakInternalHandoffAnnouncement(policy: string | undefined): boolean {
  return policy === 'brief' || policy === 'explicit';
}

function buildSilentInternalHandoffToolPayload(): Record<string, true> {
  return { success: true };
}

function isAgentIRLike(
  value: unknown,
): value is ResolvedVoiceAgentIR & { metadata: { name?: string } } {
  return typeof value === 'object' && value !== null && 'metadata' in value && 'identity' in value;
}

function getAgentIRName(value: unknown): string | null {
  if (!isAgentIRLike(value) || typeof value.metadata?.name !== 'string') {
    return null;
  }

  const normalizedName = value.metadata.name.trim();
  return normalizedName.length > 0 ? normalizedName : null;
}

function findFuzzyAgentMatch(
  availableAgents: string[],
  candidateNames: Array<string | undefined | null>,
): string | null {
  const findUniqueMatch = (matches: string[]): string | null => {
    if (matches.length === 1) {
      return matches[0];
    }
    return null;
  };

  for (const candidateName of candidateNames) {
    if (!candidateName) {
      continue;
    }

    const normalizedCandidate = candidateName.toLowerCase();
    const exactMatch = findUniqueMatch(
      availableAgents.filter((key) => key.toLowerCase() === normalizedCandidate),
    );
    if (exactMatch) {
      return exactMatch;
    }

    const underscoredSuffixMatch = findUniqueMatch(
      availableAgents.filter((key) => key.toLowerCase().endsWith(`_${normalizedCandidate}`)),
    );
    if (underscoredSuffixMatch) {
      return underscoredSuffixMatch;
    }

    const suffixMatch = findUniqueMatch(
      availableAgents.filter(
        (key) =>
          !key.toLowerCase().endsWith(`_${normalizedCandidate}`) &&
          key.toLowerCase().endsWith(normalizedCandidate),
      ),
    );
    if (suffixMatch) {
      return suffixMatch;
    }
  }

  return null;
}

function resolveVoiceEntryAgent(params: {
  requestedEntryAgent: string;
  compilationEntryAgent?: string;
  resolvedAgents: Record<string, ResolvedVoiceAgentIR>;
  runtimeAgentIR: unknown;
}): {
  agentIR: ResolvedVoiceAgentIR;
  agentName: string;
  resolvedBy: 'runtime_session' | 'requested' | 'compilation_entry' | 'single_agent' | 'fuzzy';
} | null {
  const availableAgents = Object.keys(params.resolvedAgents);
  const runtimeAgentName = getAgentIRName(params.runtimeAgentIR);

  if (runtimeAgentName && params.resolvedAgents[runtimeAgentName]) {
    return {
      agentIR: params.resolvedAgents[runtimeAgentName],
      agentName: runtimeAgentName,
      resolvedBy: runtimeAgentName === params.requestedEntryAgent ? 'requested' : 'runtime_session',
    };
  }

  if (params.resolvedAgents[params.requestedEntryAgent]) {
    return {
      agentIR: params.resolvedAgents[params.requestedEntryAgent],
      agentName: params.requestedEntryAgent,
      resolvedBy: 'requested',
    };
  }

  if (params.compilationEntryAgent && params.resolvedAgents[params.compilationEntryAgent]) {
    return {
      agentIR: params.resolvedAgents[params.compilationEntryAgent],
      agentName: params.compilationEntryAgent,
      resolvedBy: 'compilation_entry',
    };
  }

  if (availableAgents.length === 1) {
    // Single-agent deployments are intentionally tolerant of stored-name drift.
    const soleAgentName = availableAgents[0];
    return {
      agentIR: params.resolvedAgents[soleAgentName],
      agentName: soleAgentName,
      resolvedBy: 'single_agent',
    };
  }

  const fuzzyMatch = findFuzzyAgentMatch(availableAgents, [
    runtimeAgentName,
    params.requestedEntryAgent,
    params.compilationEntryAgent,
  ]);

  if (fuzzyMatch) {
    return {
      agentIR: params.resolvedAgents[fuzzyMatch],
      agentName: fuzzyMatch,
      resolvedBy: 'fuzzy',
    };
  }

  return null;
}

/** @internal Test-only: deterministic voice entry-agent resolution */
export const _resolveVoiceEntryAgentForTesting = resolveVoiceEntryAgent;
/** @internal Test-only: localized greeting extraction */
export const _extractInitialGreetingForTesting = extractInitialGreeting;

/**
 * Extract the initial greeting message from the agent configuration.
 * Tries multiple sources in order:
 * 1. Flow definitions (greet_new_visitor, greet_returning_visitor)
 * 2. Templates (welcome, greeting)
 * 3. Messages (greet_new_visitor, greet_returning_visitor)
 * Returns null if no greeting found.
 */
function extractInitialGreeting(runtimeSession: RuntimeSession): string | null {
  const agentIR = runtimeSession.agentIR;

  log.debug('[S2S] extractInitialGreeting check', {
    hasAgentIR: !!agentIR,
    hasFlow: !!agentIR?.flow,
    hasTemplates: !!agentIR?.templates,
    hasMessages: !!agentIR?.messages,
    templateKeys: agentIR?.templates ? Object.keys(agentIR.templates) : [],
    messageKeys: agentIR?.messages ? Object.keys(agentIR.messages) : [],
    agentName: runtimeSession.agentName,
  });

  // 1. Try flow definitions first
  const flowDefinitions = agentIR?.flow?.definitions;
  if (flowDefinitions) {
    const greetingStepNames = [
      'greet_new_visitor',
      'greet_returning_visitor',
      'greet_new',
      'greet_returning',
    ];
    for (const stepName of greetingStepNames) {
      const step = flowDefinitions[stepName];
      if (step?.respond) {
        log.debug('[S2S] Found greeting in flow step', {
          stepName,
          respondPreview: step.respond.substring(0, 100),
        });
        return step.respond;
      }
    }
  }

  // 2. Try templates (common for supervisor agents)
  if (agentIR?.templates) {
    const templates = agentIR.templates as Record<string, string>;
    const greetingTemplateNames = [
      'welcome',
      'greeting',
      'greet_new_visitor',
      'greet_returning_visitor',
    ];
    for (const templateName of greetingTemplateNames) {
      if (templates[templateName]) {
        log.debug('[S2S] Found greeting in templates', {
          templateName,
          greetingPreview: templates[templateName].substring(0, 100),
        });
        return templates[templateName];
      }
    }
  }

  // 3. Try messages field
  if (agentIR?.messages) {
    const greetingMessageNames = [
      'greet_new_visitor',
      'greet_returning_visitor',
      'welcome',
      'greeting',
    ];
    for (const messageName of greetingMessageNames) {
      const localizedGreeting = resolveLocalizedAgentMessage({
        session: runtimeSession,
        messageKey: messageName,
        fallbackMessage: '',
      });
      if (localizedGreeting) {
        log.debug('[S2S] Found greeting in messages', {
          messageName,
          greetingPreview: localizedGreeting.substring(0, 100),
        });
        return localizedGreeting;
      }
    }
  }

  log.debug('[S2S] No greeting found in any source');
  return null;
}

function isActionTool(toolName: string): boolean {
  return (
    isHandoffTool(toolName) ||
    toolName.startsWith('delegate_to_') ||
    toolName === '__delegate__' ||
    toolName === '__escalate__'
  );
}

function isHandoffTool(toolName: string): boolean {
  return toolName.startsWith('handoff_to_') || toolName === '__handoff__';
}

export function buildKorevgCallerContext(params: {
  tenantId: string;
  channelId: string;
  caller?: string;
  connectionConfig?: Record<string, unknown>;
}): CallerContext {
  const normalizedVoiceArtifact = normalizeVoiceArtifact(params.caller);
  const providerVerification = resolveProviderVerification({
    providerVerified: normalizedVoiceArtifact != null,
    connectionConfig: params.connectionConfig,
  });

  return buildCallerContext({
    tenantId: params.tenantId,
    channel: 'korevg',
    channelId: params.channelId,
    anonymousId: params.caller?.trim(),
    identityTier: providerVerification.identityTier,
    verificationMethod: providerVerification.providerVerified ? 'provider' : 'none',
    rawArtifact: normalizedVoiceArtifact?.channelArtifact,
    channelArtifactType: normalizedVoiceArtifact?.channelArtifactType,
  });
}

function firstStringValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const trimmed = value.trim();
    if (trimmed.length > 0) {
      return trimmed;
    }
  }

  return undefined;
}

function firstPhoneLikeValue(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value !== 'string') {
      continue;
    }

    const normalized = normalizePhoneLikeValue(value);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

function setContextValueIfAbsent(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (!value || target[key] !== undefined) {
    return;
  }

  target[key] = value;
}

function setPhoneContextValueIfAbsentOrPlaceholder(
  target: Record<string, unknown>,
  key: string,
  value: string | undefined,
): void {
  if (!value) {
    return;
  }

  const existing = target[key];
  if (typeof existing === 'string' && normalizePhoneLikeValue(existing)) {
    return;
  }

  target[key] = value;
}

function applyKorevgVoiceSessionAliasesToValues(params: {
  values: Record<string, unknown>;
  runtimeSession: RuntimeSession;
  latestCalled?: string;
}): void {
  const sessionNamespace =
    params.values.session &&
    typeof params.values.session === 'object' &&
    !Array.isArray(params.values.session)
      ? (params.values.session as Record<string, unknown>)
      : undefined;
  const callerAni = firstPhoneLikeValue(
    params.runtimeSession.callerContext?.anonymousId,
    params.runtimeSession.callerContext?.sessionPrincipalId,
    sessionNamespace?.anonymousId,
    sessionNamespace?.sessionPrincipalId,
  );
  const dnis = firstStringValue(params.latestCalled, sessionNamespace?.calledNumber);

  setPhoneContextValueIfAbsentOrPlaceholder(
    params.values,
    KOREVG_CALLER_ANI_CONTEXT_KEY,
    callerAni,
  );
  setContextValueIfAbsent(params.values, KOREVG_DNIS_CONTEXT_KEY, dnis);
  setContextValueIfAbsent(params.values, 'session_id', params.runtimeSession.id);
}

export function applyKorevgVoiceSessionAliases(
  runtimeSession: RuntimeSession,
  latestCalled?: string,
): void {
  const values = runtimeSession.data?.values;
  if (!values || typeof values !== 'object') {
    return;
  }

  applyKorevgVoiceSessionAliasesToValues({ values, runtimeSession, latestCalled });

  for (const thread of runtimeSession.threads ?? []) {
    const threadValues = thread.data?.values;
    if (!threadValues || threadValues === values) {
      continue;
    }

    applyKorevgVoiceSessionAliasesToValues({
      values: threadValues,
      runtimeSession,
      latestCalled,
    });
  }
}

export interface KorevgRouterConfig {
  baseUrl: string; // Base URL for action hooks (e.g., http://localhost:3112)
  sessionNewTimeoutMs?: number;
}

// Session can be either a KorevgSession (pipeline mode) or a simple object with close() for S2S
type SessionEntry = KorevgSession | { close: () => void };

export class KorevgRouter {
  private wss: WebSocketServer;
  private sessions: Map<string, SessionEntry> = new Map();
  private config: KorevgRouterConfig;
  private voiceFactory: VoiceServiceFactory;
  private sessionNewTimeoutMs: number;

  constructor(config: KorevgRouterConfig) {
    this.config = config;
    this.sessionNewTimeoutMs = config.sessionNewTimeoutMs ?? WS_MESSAGE_TIMEOUT_MS;
    this.voiceFactory = new VoiceServiceFactory();
    this.wss = new WebSocketServer({
      noServer: true,
      handleProtocols: (protocols: Set<string>) => {
        // Accept any protocol or no protocol
        if (protocols.size > 0) {
          return Array.from(protocols)[0];
        }
        return false; // No protocol selected
      },
    });

    this.wss.on('connection', (ws: WebSocket, req: IncomingMessage) => {
      this.handleConnection(ws, req);
    });
  }

  /**
   * Handle WebSocket upgrade request
   */
  handleUpgrade(request: IncomingMessage, socket: Duplex, head: Buffer) {
    const url = request.url || '/';
    const safeUpgradeUrl = url.replace(/([?&]token=)[^&]*/g, '$1***');
    log.info(`[UPGRADE] Handling WebSocket upgrade for URL: ${safeUpgradeUrl}`);

    // Upgrade the connection
    this.wss.handleUpgrade(request, socket, head, (ws: WebSocket) => {
      log.info(`[UPGRADE] WebSocket upgraded, emitting connection event`);
      this.wss.emit('connection', ws, request);
      log.info(`[UPGRADE] Connection event emitted`);
    });
  }

  /**
   * Handle new WebSocket connection
   */
  private async handleConnection(ws: WebSocket, req: IncomingMessage) {
    const url = req.url || '/';
    const safeUrl = url.replace(/([?&]token=)[^&]*/g, '$1***');
    log.info(`[CONNECTION] handleConnection called for URL: ${safeUrl}`);
    let bootstrapMetadataRejected = false;

    const rejectInvalidSessionMetadata = (error: unknown, phase: string): boolean => {
      if (!isSessionMetadataValidationError(error)) {
        return false;
      }

      bootstrapMetadataRejected = true;
      log.warn('[SESSION] Rejecting Korevg bootstrap with invalid session metadata', {
        phase,
        error: error.message,
        url: safeUrl,
      });
      ws.close(1008, 'Invalid session metadata');
      return true;
    };

    // Enforce concurrent session cap
    if (this.sessions.size >= MAX_KOREVG_SESSIONS) {
      log.error('[CONNECTION] Max concurrent voice sessions reached, rejecting connection', {
        current: this.sessions.size,
        max: MAX_KOREVG_SESSIONS,
      });
      ws.close(1008, 'Server at capacity');
      return;
    }

    // Store session:new data for async processing
    let sessionNewMsgId: string | undefined;
    let sessionNewCallInfo: Record<string, unknown> | undefined;
    let sessionNewReceived = false;
    let sessionNewTimeout: ReturnType<typeof setTimeout> | undefined;
    const bufferedBootstrapMessages: Buffer[] = [];
    let droppedBootstrapMessageCount = 0;
    let syncRuntimeCallerAndCallMetadata: (() => void) | undefined;

    const clearSessionNewTimeout = (): void => {
      if (!sessionNewTimeout) {
        return;
      }

      clearTimeout(sessionNewTimeout);
      sessionNewTimeout = undefined;
    };

    const armSessionNewTimeout = (): void => {
      if (sessionNewReceived || sessionNewTimeout) {
        return;
      }

      sessionNewTimeout = setTimeout(() => {
        if (sessionNewReceived || ws.readyState !== WebSocket.OPEN) {
          return;
        }

        log.warn('[BOOTSTRAP] Korevg session:new was never received before timeout', {
          timeoutMs: this.sessionNewTimeoutMs,
          url: safeUrl,
        });
      }, this.sessionNewTimeoutMs);
      sessionNewTimeout.unref?.();
    };

    const bufferBootstrapMessage = (data: Buffer): void => {
      if (bufferedBootstrapMessages.length >= MAX_BOOTSTRAP_BUFFERED_MESSAGES) {
        bufferedBootstrapMessages.shift();
        droppedBootstrapMessageCount += 1;
        log.warn('[BOOTSTRAP] Dropping oldest buffered Korevg message during bootstrap', {
          maxBufferedMessages: MAX_BOOTSTRAP_BUFFERED_MESSAGES,
          droppedBootstrapMessageCount,
          url: safeUrl,
        });
      }

      bufferedBootstrapMessages.push(Buffer.from(data));
    };

    const replayBufferedBootstrapMessages = async ({
      target,
      handler,
      skipSessionNew,
    }: {
      target: 'pipeline' | 'realtime';
      handler: (data: Buffer) => void | Promise<void>;
      skipSessionNew: boolean;
    }): Promise<void> => {
      const messages = bufferedBootstrapMessages.splice(0);
      let replayed = 0;
      let skippedSessionNew = 0;

      for (const data of messages) {
        if (skipSessionNew && isBufferedSessionNewMessage(data)) {
          skippedSessionNew += 1;
          continue;
        }

        try {
          await handler(Buffer.from(data));
          replayed += 1;
        } catch (err) {
          log.error('[BOOTSTRAP] Failed to replay buffered Korevg message', {
            target,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (replayed > 0 || skippedSessionNew > 0 || droppedBootstrapMessageCount > 0) {
        log.info('[BOOTSTRAP] Replayed buffered Korevg bootstrap messages', {
          target,
          replayed,
          skippedSessionNew,
          droppedBootstrapMessageCount,
        });
      }
    };

    const captureSessionNewData = (msg: unknown): boolean => {
      if (!msg || typeof msg !== 'object') {
        return false;
      }

      const sessionMessage = msg as {
        type?: string;
        msgid?: string;
        data?: Record<string, unknown>;
        call_sid?: string;
      };

      if (sessionMessage.type !== 'session:new') {
        return false;
      }

      sessionNewReceived = true;
      clearSessionNewTimeout();

      if (!sessionNewMsgId && sessionMessage.msgid) {
        sessionNewMsgId = sessionMessage.msgid;
      } else if (!sessionMessage.msgid) {
        log.warn('[BOOTSTRAP] Korevg session:new received without msgid', {
          url: safeUrl,
          callSid: sessionMessage.call_sid,
        });
      }

      if (!sessionNewCallInfo) {
        const d = sessionMessage.data || {};
        const sipInfo = isRecord(d.sip) ? d.sip : undefined;
        const sipHeaders = extractKorevgSipHeaders(d);
        const defaults = isRecord(d.defaults) ? d.defaults : undefined;
        const dataFrom = asString(d.from);
        const dataTo = asString(d.to);
        const callerFromSip = getHeaderValue(sipHeaders, ['from']);
        const calledFromSip = getHeaderValue(sipHeaders, ['to']);
        const resolvedCaller = resolvePhoneLikeKorevgValue({
          primary: dataFrom,
          fallback: callerFromSip,
          headers: sipHeaders,
          headerNames: KOREVG_CALLER_PHONE_HEADER_NAMES,
        });
        const resolvedCalled = resolvePhoneLikeKorevgValue({
          primary: dataTo,
          fallback: calledFromSip,
          headers: sipHeaders,
          headerNames: KOREVG_CALLED_PHONE_HEADER_NAMES,
        });

        sessionNewCallInfo = {
          callSid: sessionMessage.call_sid || d.call_sid,
          from: resolvedCaller,
          to: resolvedCalled,
          rawFrom: dataFrom,
          rawTo: dataTo,
          sipFrom: callerFromSip,
          sipTo: calledFromSip,
          callId: sipHeaders['call-id'] || d.call_id,
          sbcCallId: d.sbc_callid,
          accountSid: sipHeaders['X-Account-Sid'] || d.account_sid,
          voipCarrierSid: sipHeaders['X-Voip-Carrier-Sid'],
          applicationSid: sipHeaders['X-Application-Sid'] || d.application_sid,
          uri: sipInfo?.uri,
          direction: d.direction,
          traceId: d.trace_id,
          originatingSipIp: d.originating_sip_ip,
          callerName: d.caller_name,
          originatingSipTrunkName: d.originating_sip_trunk_name,
          userAgent: sipHeaders['user-agent'],
          synthesizer: defaults?.synthesizer,
          recognizer: defaults?.recognizer,
          sessionMetadata:
            coerceSessionMetadata(d.sessionMetadata) ?? coerceSessionMetadata(d.session_metadata),
        };
      }

      syncRuntimeCallerAndCallMetadata?.();

      return true;
    };

    // Extract call info from session:new early (before async setup)
    const earlyInfoExtractor = (data: Buffer) => {
      bufferBootstrapMessage(data);
      try {
        captureSessionNewData(JSON.parse(data.toString()));
      } catch (err) {
        if (rejectInvalidSessionMetadata(err, 'early_session_new')) {
          return;
        }
        log.warn(`[EARLY INFO] Failed to parse early message: ${err}`);
      }
    };
    ws.on('message', earlyInfoExtractor);
    ws.on('close', clearSessionNewTimeout);

    try {
      // Parse URL and query parameters
      // Expected format: /ws/korevg/:streamId?token=xxx&projectId=xxx&deploymentId=xxx&agentId=xxx
      const urlMatch = url.match(/\/ws\/korevg\/([^?]+)/);
      if (!urlMatch) {
        log.error(`Invalid WebSocket URL format: ${url}`);
        ws.close(1008, 'Invalid URL format');
        return;
      }

      const [, streamId] = urlMatch;
      const urlObj = new URL(url, 'http://localhost');

      // Resolve connection by ID (auto-provisioned connections use _id in the WebSocket URL).
      // Fall back to resolveChannelConnection by externalIdentifier for manually configured
      // connections that predate auto-provisioning.
      const { resolveConnectionByIdUnsafe, resolveChannelConnection } =
        await import('../../../channels/connection-resolver.js');
      // NOTE: Intentionally using the unsafe (no-tenantId) variant — this is a
      // WebSocket bootstrap lookup where tenant context is unknown until the
      // connection record is resolved (analogous to resolveConnectionByVerifyToken).
      const connection =
        (await resolveConnectionByIdUnsafe(streamId)) ??
        (await resolveChannelConnection('korevg', streamId));

      if (!connection) {
        log.warn('[KOREVG] No connection found', { streamId });
        ws.close(1008, 'Channel not configured');
        return;
      }

      // Extract authentication token (from header or query param)
      const queryToken = urlObj.searchParams.get('token');
      // TODO(auth-consolidation): Remove query-token fallback after Korevg/Jambonz
      // supports a non-URL WebSocket bootstrap/auth transport in all deployments.
      const token = extractIngressToken(req.headers, queryToken, {
        allowQueryTokenFor: 'korevg_ws',
      });

      // Get expected token from connection config
      const connectionConfig = (connection.config || {}) as Record<string, unknown>;
      const expectedToken =
        (connectionConfig.inboundAuthToken as string | undefined)?.trim() || null;

      if (!expectedToken) {
        if (process.env.NODE_ENV === 'production') {
          log.error('[AUTH] Korevg ingress secret not configured in production', { streamId });
          ws.close(1011, 'Service unavailable');
          return;
        }
        log.warn(
          '[AUTH] Korevg ingress secret not configured; allowing request in non-production',
          { streamId },
        );
      } else if (!token) {
        log.warn(`[AUTH] No token provided for Korevg WebSocket connection: ${streamId}`);
        ws.close(1008, 'Authentication required');
        return;
      } else if (!tokensMatch(token, expectedToken)) {
        log.warn('[AUTH] Korevg ingress authentication failed', {
          streamId,
          hasToken: !!token,
        });
        ws.close(1008, 'Unauthorized request');
        return;
      }

      if (expectedToken) {
        log.info(`[AUTH] Token validated successfully for streamId ${streamId}`);
      }

      armSessionNewTimeout();

      if (bootstrapMetadataRejected) {
        ws.off('message', earlyInfoExtractor);
        clearSessionNewTimeout();
        return;
      }

      // Get projectId and deploymentId from connection
      const projectId = connection.projectId;
      const deploymentId = connection.deploymentId || connection.agentId || '';
      const agentId = urlObj.searchParams.get('agentId') || connection.agentId || deploymentId;
      const caller = urlObj.searchParams.get('caller') || undefined;
      const called =
        urlObj.searchParams.get('called') || urlObj.searchParams.get('calledNumber') || undefined;
      const callSid = urlObj.searchParams.get('callSid') || randomBytes(16).toString('hex');
      const sessionMetadata = mergeSessionMetadata(
        coerceSessionMetadata(urlObj.searchParams.get('sessionMetadata')),
        coerceSessionMetadata(sessionNewCallInfo?.sessionMetadata),
      );

      // Generate session ID
      const sessionId = randomBytes(16).toString('hex');

      // Get RuntimeExecutor singleton
      const executor = getRuntimeExecutor();

      // Resolve deployment and create RuntimeExecutor session
      const resolver = new DeploymentResolver(getSessionService());

      // Use tenantId from connection
      const tenantId = connection.tenantId;
      const resolvedChannelId = connection.id || streamId;
      let callerContext = buildKorevgCallerContext({
        tenantId,
        channelId: resolvedChannelId,
        caller: (sessionNewCallInfo?.from as string | undefined) || caller,
        connectionConfig,
      });

      const resolved = await resolver.resolve({
        projectId,
        tenantId,
        deploymentId,
        environment: connection.environment || undefined,
        agentName: agentId.split('-').pop() || 'supervisor', // Extract agent name from agentId
        allowWorkingCopy: true, // Allow using DSL content if no deployment/version found
      });
      let configVariables: Record<string, string> | undefined;
      try {
        const loaded = await loadConfigVariablesMap(projectId, tenantId);
        if (Object.keys(loaded).length > 0) {
          configVariables = loaded;
        }
      } catch (err) {
        log.warn('Failed to load config variables for Korevg voice session', {
          projectId,
          tenantId,
          deploymentId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      const scopedSession = await resolveRequiredContactProductionScope({
        tenantId,
        projectId,
        sessionId,
        channelId: resolvedChannelId,
        environment: connection.environment ?? resolved.versionInfo?.environment ?? 'unknown',
        source: 'korevg_voice',
        authType: 'korevg_ws',
        callerContext,
        channelType: 'korevg',
        fallbackAnonymousId: callSid,
      });
      callerContext = scopedSession.callerContext;

      // Create RuntimeExecutor session with resolved deployment
      const runtimeSession = executor.createSessionFromResolved(resolved, {
        channelType: 'voice',
        deploymentId,
        metadata: sessionMetadata,
        scope: scopedSession.scope,
      });
      storeRuntimeSessionLocalizationCatalog(
        runtimeSession,
        buildSessionLocalizationCatalog(configVariables),
      );

      const getRuntimeSessionNamespace = (): Record<string, unknown> => {
        const sessionNamespace =
          runtimeSession.data?.values?.session &&
          typeof runtimeSession.data.values.session === 'object' &&
          !Array.isArray(runtimeSession.data.values.session)
            ? (runtimeSession.data.values.session as Record<string, unknown>)
            : {};
        runtimeSession.data.values.session = sessionNamespace;
        return sessionNamespace;
      };

      const syncCallerContext = (nextCallerContext: CallerContext) => {
        callerContext = nextCallerContext;
        applyCallerContextToRuntimeSession(runtimeSession, nextCallerContext);
        getRuntimeSessionNamespace().channel = runtimeSession.channelType || 'voice';
      };

      const getLatestCaller = (): string | undefined =>
        (sessionNewCallInfo?.from as string | undefined) || caller || undefined;
      const getLatestCalled = (): string | undefined =>
        (sessionNewCallInfo?.to as string | undefined) || called || undefined;
      const getLatestRawCaller = (): string | undefined =>
        (sessionNewCallInfo?.rawFrom as string | undefined) ||
        (sessionNewCallInfo?.sipFrom as string | undefined) ||
        getLatestCaller();
      const getLatestRawCalled = (): string | undefined =>
        (sessionNewCallInfo?.rawTo as string | undefined) ||
        (sessionNewCallInfo?.sipTo as string | undefined) ||
        getLatestCalled();
      syncRuntimeCallerAndCallMetadata = () => {
        const latestCaller = getLatestCaller();
        const nextCallerContext = buildKorevgCallerContext({
          tenantId,
          channelId: resolvedChannelId,
          caller: latestCaller,
          connectionConfig,
        });
        syncCallerContext(nextCallerContext);

        const sessionNamespace = getRuntimeSessionNamespace();
        sessionNamespace.channel = runtimeSession.channelType || 'voice';
        const latestRawCaller = getLatestRawCaller();
        if (latestRawCaller) {
          sessionNamespace.rawCallerId = latestRawCaller;
          sessionNamespace.rawFrom = latestRawCaller;
        }
        const latestCalled = getLatestCalled();
        if (latestCalled) {
          sessionNamespace.calledNumber = latestCalled;
        }
        const latestRawCalled = getLatestRawCalled();
        if (latestRawCalled) {
          sessionNamespace.rawCalledNumber = latestRawCalled;
          sessionNamespace.rawTo = latestRawCalled;
        }
        applyKorevgVoiceSessionAliases(runtimeSession, latestCalled);
      };

      log.info(`Created RuntimeExecutor session: ${runtimeSession.id} for Korevg call ${callSid}`);

      const voiceEntryAgent = resolveVoiceEntryAgent({
        requestedEntryAgent: resolved.entryAgent,
        compilationEntryAgent: resolved.compilationOutput?.entry_agent,
        resolvedAgents: resolved.agents,
        runtimeAgentIR: runtimeSession.agentIR,
      });

      if (!voiceEntryAgent) {
        log.error('[VOICE_MODE] Entry agent identity mismatch prevented voice bootstrap', {
          requestedEntryAgent: resolved.entryAgent,
          compilationEntryAgent: resolved.compilationOutput?.entry_agent,
          runtimeAgentName: isAgentIRLike(runtimeSession.agentIR)
            ? runtimeSession.agentIR.metadata?.name
            : undefined,
          availableAgents: Object.keys(resolved.agents || {}),
        });
        ws.close(1011, 'Agent configuration error');
        return;
      }

      if (
        voiceEntryAgent.resolvedBy !== 'requested' &&
        voiceEntryAgent.agentName !== resolved.entryAgent
      ) {
        log.warn('[VOICE_MODE] Entry agent mismatch resolved for voice bootstrap', {
          requestedEntryAgent: resolved.entryAgent,
          resolvedEntryAgent: voiceEntryAgent.agentName,
          compilationEntryAgent: resolved.compilationOutput?.entry_agent,
          resolvedBy: voiceEntryAgent.resolvedBy,
          availableAgents: Object.keys(resolved.agents || {}),
        });
      }

      // Extract agent name from resolved deployment for tracing
      let agentName = voiceEntryAgent.agentName;

      // Resolve STT model from tenant's voice service instance
      let sttModel: string | undefined;
      if (tenantId) {
        try {
          const factory = this.voiceFactory;
          const voiceCreds = await factory.resolveVoiceCredentials(tenantId, {
            sttServiceType:
              (connectionConfig.asrVendor as string | undefined) || DEFAULT_KOREVG_STT_VENDOR,
            sttInstanceId: connectionConfig.asrServiceInstanceId as string | undefined,
            ttsServiceType:
              (connectionConfig.ttsVendor as string | undefined) || DEFAULT_KOREVG_TTS_VENDOR,
            ttsInstanceId: connectionConfig.ttsServiceInstanceId as string | undefined,
          });
          sttModel = voiceCreds.stt?.model;
        } catch (err) {
          log.warn('Failed to resolve STT model via VoiceServiceFactory', {
            tenantId,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Create session config — prefer vendor settings from connection config, then URL query param,
      // then module-level defaults. connectionConfig is already resolved above for auth.
      const orpheusWsStreamingEnabled =
        connectionConfig.orpheusWsStreamingEnabled === true ||
        connectionConfig.orpheusWsStreamingEnabled === 'true' ||
        urlObj.searchParams.get('orpheusWsStreamingEnabled') === 'true';
      const config: KorevgSessionConfig = {
        projectId,
        agentId,
        deploymentId,
        sessionId: runtimeSession.id,
        callSid,
        streamId, // For constructing WebSocket actionHook path
        caller: getLatestCaller(),
        called: getLatestCalled(),
        ttsVendor:
          (connectionConfig.ttsVendor as string) ||
          urlObj.searchParams.get('ttsVendor') ||
          DEFAULT_KOREVG_TTS_VENDOR,
        ttsVoice:
          (connectionConfig.ttsVoice as string) ||
          urlObj.searchParams.get('ttsVoice') ||
          DEFAULT_KOREVG_TTS_VOICE,
        ttsLanguage:
          (connectionConfig.ttsLanguage as string) ||
          urlObj.searchParams.get('ttsLanguage') ||
          'en',
        ttsOptions: buildElevenLabsTtsOptions(connectionConfig),
        sttVendor:
          (connectionConfig.asrVendor as string) ||
          urlObj.searchParams.get('sttVendor') ||
          DEFAULT_KOREVG_STT_VENDOR,
        sttLanguage:
          (connectionConfig.asrLanguage as string) ||
          urlObj.searchParams.get('sttLanguage') ||
          'en-US',
        sttAlternativeLanguages:
          readStringList(connectionConfig.asrAlternativeLanguages) ||
          readStringList(urlObj.searchParams.get('sttAlternativeLanguages')),
        sttModel,
        welcomeMessage:
          typeof connectionConfig.welcomeMessage === 'string'
            ? (connectionConfig.welcomeMessage as string)
            : null,
        tenantId,
        agentName,
        callInfo: sessionNewCallInfo,
        callerContext,
        sessionMetadata,
        orpheusWsStreamingEnabled,
        onSessionNewReceived: captureSessionNewData,
      };

      // --- IR Voice Config Override: resolve TTS from agentIR / profile overrides ---
      // Priority: IR voice config > connection config > URL params > module defaults
      const { resolveVoiceConfig } = await import('../voice-config-resolver.js');
      const irVoiceParams = resolveVoiceConfig(
        runtimeSession.agentIR,
        runtimeSession._effectiveConfig,
      );
      if (irVoiceParams) {
        if (irVoiceParams.ttsVendor) config.ttsVendor = irVoiceParams.ttsVendor;
        if (irVoiceParams.ttsVoice) config.ttsVoice = irVoiceParams.ttsVoice;
        if (irVoiceParams.ttsLanguage) config.ttsLanguage = irVoiceParams.ttsLanguage;
        if (irVoiceParams.ttsVendor && irVoiceParams.ttsVendor !== 'elevenlabs') {
          config.ttsOptions = undefined;
        }
        log.debug('[VOICE_IR] Applied IR voice config override', {
          ttsVendor: config.ttsVendor,
          ttsVoice: config.ttsVoice,
          agent: agentName,
        });
      }
      const behaviorVoiceConfig = resolveConversationBehaviorVoiceRuntimeConfig(
        runtimeSession._effectiveConfig?.conversationBehavior,
      );
      const internalHandoffSpeechPolicy = behaviorVoiceConfig.internalHandoffSpeech ?? 'silent';
      if (behaviorVoiceConfig.bargeIn !== undefined) {
        config.bargeIn = behaviorVoiceConfig.bargeIn;
      }
      if (behaviorVoiceConfig.pauseTimeoutMs !== undefined) {
        config.pauseTimeoutMs = behaviorVoiceConfig.pauseTimeoutMs;
      }

      log.info(`[SETUP] Async setup complete, session:new msgid=${sessionNewMsgId}`);

      // Resolve voice mode (pipeline vs realtime) against the actual runtime-selected agent IR.
      const entryAgentIR = voiceEntryAgent.agentIR;

      // Map channelType to voice mode configuration
      // If channelType is 'voice_realtime', explicitly set mode to 'realtime'
      const voiceConfig = {
        ...connectionConfig,
        mode: (connectionConfig.channelType === 'voice_realtime'
          ? 'realtime'
          : connectionConfig.mode || 'auto') as 'realtime' | 'pipeline' | 'auto',
        // Map s2sProvider to provider for voice mode resolution
        provider: connectionConfig.s2sProvider as string | undefined,
      };

      log.debug(`[VOICE_MODE] Voice config before resolution`, {
        channelType: connectionConfig.channelType,
        mode: voiceConfig.mode,
        provider: voiceConfig.provider,
        s2sProvider: connectionConfig.s2sProvider,
        hasS2sConfig: !!connectionConfig.s2sProvider,
      });

      const resolvedVoiceMode = await this.voiceFactory.resolveVoiceMode({
        tenantId,
        deploymentVoiceConfig: voiceConfig,
        agentIR: entryAgentIR,
      });

      log.info(`[VOICE_MODE] Resolved voice mode: ${resolvedVoiceMode}`, {
        sessionId: runtimeSession.id,
        tenantId,
        deploymentId,
      });

      const s2sProvider =
        typeof connectionConfig.s2sProvider === 'string' &&
        connectionConfig.s2sProvider.startsWith('s2s:')
          ? (connectionConfig.s2sProvider as S2SProviderType)
          : undefined;
      const voiceMode =
        resolvedVoiceMode === 'realtime' && !s2sProvider ? 'pipeline' : resolvedVoiceMode;
      if (resolvedVoiceMode === 'realtime' && !s2sProvider) {
        log.warn('[VOICE_MODE] Downgrading Korevg call from realtime to pipeline', {
          sessionId: runtimeSession.id,
          tenantId,
          projectId,
          deploymentId,
          channelType: connectionConfig.channelType,
          configuredMode: voiceConfig.mode,
          resolvedVoiceMode,
          s2sProvider: connectionConfig.s2sProvider,
          reason: 'missing_explicit_s2s_provider',
        });
      }

      const sessionNamespace = getRuntimeSessionNamespace();
      sessionNamespace.channel = runtimeSession.channelType || 'voice';
      sessionNamespace.voiceMode = voiceMode;
      syncRuntimeCallerAndCallMetadata?.();
      log.info('[VOICE_MODE] Runtime session namespace updated', {
        sessionId: runtimeSession.id,
        channel: sessionNamespace.channel,
        voiceMode: sessionNamespace.voiceMode,
      });

      // Create session based on voice mode
      if (voiceMode === 'realtime') {
        if (!s2sProvider) {
          log.error('[VOICE_MODE] Realtime voice selected without an explicit S2S provider', {
            sessionId: runtimeSession.id,
            tenantId,
            projectId,
            deploymentId,
          });
          ws.close(1011, 'S2S provider not configured');
          return;
        }
        if (!isSupportedKorevgRealtimeS2SProvider(s2sProvider)) {
          log.error('[VOICE_MODE] Realtime voice selected with unsupported S2S provider', {
            sessionId: runtimeSession.id,
            tenantId,
            projectId,
            deploymentId,
            s2sProvider,
          });
          ws.close(1011, 'S2S provider not supported');
          return;
        }

        // S2S Realtime Mode
        log.info(`[CONNECTION] Creating S2SSessionBridge with sessionId=${runtimeSession.id}`);

        const s2sConfig: S2SSessionConfig = {
          provider: s2sProvider,
          model: connectionConfig.s2sModel as string,
          voice: connectionConfig.s2sVoice as string,
          temperature: connectionConfig.s2sTemperature as number,
          threshold: connectionConfig.s2sThreshold as number,
          startSensitivity: connectionConfig.s2sStartSensitivity as string,
          endSensitivity: connectionConfig.s2sEndSensitivity as string,
          turnDetection: connectionConfig.s2sTurnDetection as string,
          silenceDuration: connectionConfig.s2sSilenceDuration as number,
          prefixPadding: connectionConfig.s2sPrefixPadding as number,
          agentId: connectionConfig.s2sAgentId as string,
          conversationId: connectionConfig.s2sConversationId as string,
          thinkProviderType: connectionConfig.s2sThinkProviderType as string,
          thinkModel: connectionConfig.s2sThinkModel as string,
          listenModel: connectionConfig.s2sListenModel as string,
        };

        sessionNamespace.s2sProvider = s2sProvider;
        sessionNamespace.s2sModel = s2sConfig.model as string | undefined;
        sessionNamespace.s2sVoice = s2sConfig.voice as string | undefined;
        log.info('[S2S] Runtime session S2S metadata updated', {
          sessionId: runtimeSession.id,
          s2sProvider,
          s2sModel: sessionNamespace.s2sModel,
          s2sVoice: sessionNamespace.s2sVoice,
        });

        const bridgeConfig: S2SSessionBridgeConfig = {
          projectId,
          tenantId,
          deploymentId,
          sessionId: runtimeSession.id,
          callSid,
          agentName,
          agentIR: entryAgentIR,
          s2sProvider,
          s2sConfig,
        };

        // Resolve S2S credentials
        const s2sCredentials = await this.voiceFactory.resolveS2SCredentials(tenantId, s2sProvider);
        if (!s2sCredentials) {
          log.error('[S2S] Failed to resolve credentials');
          ws.close(1011, 'S2S credentials not configured');
          return;
        }

        log.info('[S2S] Credentials resolved', {
          hasApiKey: !!s2sCredentials.credentials?.apiKey,
          apiKeyLength: s2sCredentials.credentials?.apiKey?.length,
          apiKeyPrefix: s2sCredentials.credentials?.apiKey?.substring(0, 20),
        });
        const s2sApiKey = s2sCredentials.credentials.apiKey;

        const resolvedS2SConfig: S2SSessionConfig = {
          ...s2sConfig,
          model:
            (s2sConfig.model as string | undefined) ||
            (s2sCredentials.credentials.config?.model as string | undefined) ||
            (s2sCredentials.credentials.config?.deploymentName as string | undefined),
          deploymentName:
            (s2sConfig.deploymentName as string | undefined) ||
            (s2sCredentials.credentials.config?.deploymentName as string | undefined),
          voice:
            (s2sConfig.voice as string | undefined) ||
            (s2sCredentials.credentials.config?.voice as string | undefined) ||
            (s2sCredentials.credentials.config?.voiceId as string | undefined),
          resourceHost:
            (s2sConfig.resourceHost as string | undefined) ||
            (s2sCredentials.credentials.config?.resourceHost as string | undefined),
          azureResourceHost:
            (s2sConfig.azureResourceHost as string | undefined) ||
            (s2sCredentials.credentials.config?.azureResourceHost as string | undefined),
          endpoint:
            (s2sConfig.endpoint as string | undefined) ||
            (s2sCredentials.credentials.config?.endpoint as string | undefined),
          apiVersion:
            (s2sConfig.apiVersion as string | undefined) ||
            (s2sCredentials.credentials.config?.apiVersion as string | undefined),
          path:
            (s2sConfig.path as string | undefined) ||
            (s2sCredentials.credentials.config?.path as string | undefined),
          realtimePath:
            (s2sConfig.realtimePath as string | undefined) ||
            (s2sCredentials.credentials.config?.realtimePath as string | undefined),
          temperature:
            (s2sConfig.temperature as number | undefined) ??
            (s2sCredentials.credentials.config?.temperature as number | undefined),
          agentId:
            (s2sConfig.agentId as string | undefined) ||
            (s2sCredentials.credentials.config?.agentId as string | undefined),
          conversationId:
            (s2sConfig.conversationId as string | undefined) ||
            (s2sCredentials.credentials.config?.conversationId as string | undefined),
          thinkProviderType:
            (s2sConfig.thinkProviderType as string | undefined) ||
            (s2sCredentials.credentials.config?.thinkProviderType as string | undefined),
          thinkModel:
            (s2sConfig.thinkModel as string | undefined) ||
            (s2sCredentials.credentials.config?.thinkModel as string | undefined),
          listenModel:
            (s2sConfig.listenModel as string | undefined) ||
            (s2sCredentials.credentials.config?.listenModel as string | undefined),
        };
        sessionNamespace.s2sModel = resolvedS2SConfig.model as string | undefined;
        sessionNamespace.s2sVoice = resolvedS2SConfig.voice as string | undefined;

        // Extract initial greeting from agent configuration
        const extractedGreeting = extractInitialGreeting(runtimeSession);
        log.info('[S2S] Initial greeting extraction', {
          hasGreeting: !!extractedGreeting,
          greetingLength: extractedGreeting?.length || 0,
          greetingPreview: extractedGreeting?.substring(0, 100),
        });

        const providerFamily = getS2SProviderFamily(s2sProvider);
        const traceProviderName = getS2STraceProviderName(s2sProvider);
        const promptState = buildKorevgRealtimePromptState({
          sessionId: runtimeSession.id,
          runtimeSession,
          entryAgentIR: voiceEntryAgent.agentIR,
          s2sProvider,
        });
        const bootstrap =
          providerFamily === 'elevenlabs' ||
          providerFamily === 'ultravox' ||
          providerFamily === 'voiceagent'
            ? null
            : buildKorevgRealtimeBootstrap({
                sessionId: runtimeSession.id,
                runtimeSession,
                entryAgentIR: voiceEntryAgent.agentIR,
                s2sProvider,
                s2sConfig: resolvedS2SConfig,
                apiKey: s2sCredentials.credentials.apiKey,
                greetingMessage: extractedGreeting,
              });
        const instructions = bootstrap?.instructions ?? promptState.instructions;
        const tools = bootstrap?.tools ?? promptState.tools;
        const promptTools = promptState.promptSurface.tools;
        const llmVerb =
          bootstrap?.llmVerb ??
          buildProviderAwareLlmVerbPayload({
            provider: s2sProvider,
            apiKey: s2sApiKey,
            instructions,
            s2sConfig: resolvedS2SConfig,
            openAITools: tools,
            promptTools,
            greetingMessage: extractedGreeting || undefined,
          });
        const llmOptionsForDiagnostics = isRecord(llmVerb.llmOptions) ? llmVerb.llmOptions : {};
        const responseCreateForDiagnostics = isRecord(llmOptionsForDiagnostics.response_create)
          ? llmOptionsForDiagnostics.response_create
          : undefined;
        const sessionUpdateForDiagnostics = isRecord(llmOptionsForDiagnostics.session_update)
          ? llmOptionsForDiagnostics.session_update
          : undefined;
        const responseCreateModalities = Array.isArray(responseCreateForDiagnostics?.modalities)
          ? responseCreateForDiagnostics.modalities
          : undefined;
        const sessionUpdateVoice =
          typeof sessionUpdateForDiagnostics?.voice === 'string'
            ? sessionUpdateForDiagnostics.voice
            : undefined;
        const providerKind =
          providerFamily === 'google' ? 'google' : providerFamily === 'grok' ? 'grok' : 'openai';
        const isGoogleProvider = providerKind === 'google';
        const isGrokProvider = providerKind === 'grok';
        let openAISessionUpdatedReceived = false;
        let openAIEarlyResponseCreatedCount = 0;
        let latestOpenAIResponseId: string | undefined;
        let latestOpenAIResponseVoice: string | undefined;
        const openAIResponseVoices = new Map<string, string | undefined>();
        const remainingTemplates = instructions.match(/\{\{[^}]+\}\}/g);
        log.debug('[S2S] Built initial realtime instructions from shared prompt builder', {
          providerKind,
          instructionsLength: instructions.length,
          instructionsPreview: instructions.substring(0, 200),
          instructionsEnd: instructions.substring(instructions.length - 200),
          hasRemainingTemplates: !!remainingTemplates,
          remainingTemplates: remainingTemplates || [],
        });

        if (remainingTemplates && remainingTemplates.length > 0) {
          log.error('[S2S] Shared prompt builder left unresolved placeholders', {
            providerKind,
            count: remainingTemplates.length,
            placeholders: remainingTemplates,
            fullInstructions: instructions,
          });
        }
        if (isGrokProvider) {
          const grokOpts = llmVerb.llmOptions as Record<string, any>;
          log.info('[S2S] Grok Realtime configuration', {
            model: llmVerb.model,
            voice: resolvedS2SConfig.voice,
            threshold: grokOpts.session_update.turn_detection.threshold,
            silence_duration_ms: grokOpts.session_update.turn_detection.silence_duration_ms,
          });
          if (!llmVerb.toolHook) delete llmVerb.toolHook;
        } else if (isGoogleProvider) {
          const googleSetup = (llmVerb.llmOptions as { setup?: Record<string, unknown> }).setup;
          log.info('[S2S] Google Gemini Live configuration', {
            model: llmVerb.model,
            voice: resolvedS2SConfig.voice,
          });
          log.info('[S2S:Google] Setup payload', {
            setup: googleSetup,
          });
          if (!llmVerb.toolHook) delete llmVerb.toolHook;
        } else if (providerFamily === 'openai') {
          const openaiOpts = llmVerb.llmOptions as Record<string, any>;
          const turnDetection =
            openaiOpts.session_update.turn_detection ??
            openaiOpts.session_update.audio?.input?.turn_detection;
          log.info('[S2S] VAD Configuration', {
            threshold: turnDetection?.threshold,
            prefix_padding_ms: turnDetection?.prefix_padding_ms,
            silence_duration_ms: turnDetection?.silence_duration_ms,
          });
          log.info('[S2S:OpenAI] Bootstrap voice gate configuration', {
            sessionId: runtimeSession.id,
            provider: traceProviderName,
            model: llmVerb.model,
            configuredVoice: resolvedS2SConfig.voice,
            sessionUpdateVoice,
            hasBootstrapResponseCreate: !!responseCreateForDiagnostics,
            responseCreateModalities,
            subscribedToSessionUpdated: llmVerb.events.includes('session.updated'),
            toolCount: tools.length,
          });
        } else {
          log.info('[S2S] Provider bootstrap configuration', {
            provider: traceProviderName,
            model: llmVerb.model,
            voice: resolvedS2SConfig.voice,
            toolCount: promptTools.length,
            hasToolHook: !!llmVerb.toolHook,
            configuredEvents: llmVerb.events.length,
          });
        }

        // Create DB session for message persistence and session tracking BEFORE sending llm verb
        // Match KorevgSession.createDBSession() approach - call createAndLinkDBSession directly
        let dbSessionId: string | undefined;
        let sessionStartTime = Date.now();
        let turnCount = 0;

        // Metrics tracking (similar to pipeline mode)
        let e2eTotalMs = 0; // Metric 203: E2E latency accumulator
        let e2eCount = 0; // Metric 203: Number of measured turns
        let bargeInCount = 0; // Metric 204: Barge-in counter
        let userSpeakingTotalMs = 0; // Metric 205: User speaking time
        let agentSpeakingTotalMs = 0; // Metric 205: Agent speaking time
        let callPhase: 'greeting' | 'conversation' | 'transfer' = 'greeting'; // Metric 207

        // Metric 202: TTS quality tracking (audio streaming)
        let ttsTotalTtfbMs = 0; // Accumulator for TTFB (time to first audio chunk)
        let ttsTtfbCount = 0; // Number of turns with TTFB measurements
        let ttsProxyMosTotal = 0; // Accumulator for proxy MOS scores
        let ttsProxyMosCount = 0; // Number of turns with MOS scores

        const ensureRealtimeDbSession = async () => {
          if (dbSessionId) {
            return dbSessionId;
          }

          const latestCaller = getLatestCaller();
          const nextCallerContext = buildKorevgCallerContext({
            tenantId,
            channelId: resolvedChannelId,
            caller: latestCaller,
            connectionConfig,
          });
          const contactId = await resolveContactIdFromChannelIdentity({
            tenantId,
            channelType: 'korevg',
            rawArtifact: latestCaller,
            artifactType: nextCallerContext.channelArtifactType,
            verificationMethod: nextCallerContext.verificationMethod,
            identityTier: nextCallerContext.identityTier,
          });
          const linkedCallerContext = contactId
            ? { ...nextCallerContext, contactId }
            : nextCallerContext;
          syncCallerContext(linkedCallerContext);

          const result = await createAndLinkDBSession({
            channel: 'voice',
            agentName: agentName || 'unknown',
            agentVersion: '1.0',
            environment: 'production' as any,
            projectId,
            tenantId,
            sessionId: runtimeSession.id,
            anonymousId: linkedCallerContext.anonymousId,
            contactId,
            channelArtifact: linkedCallerContext.channelArtifact,
            channelArtifactType: linkedCallerContext.channelArtifactType,
            identityTier: linkedCallerContext.identityTier,
            verificationMethod: linkedCallerContext.verificationMethod,
            channelId: linkedCallerContext.channelId,
            callerNumber: latestCaller,
            experimentId: runtimeSession.experimentId,
            experimentGroup: runtimeSession.experimentGroup,
            metadata: {
              callSid,
              called,
              s2sProvider,
              s2sModel: resolvedS2SConfig.model,
              s2sVoice: resolvedS2SConfig.voice,
            },
          });

          dbSessionId = result.dbSessionId;
          if (contactId) {
            await linkResolvedContactToSession({
              tenantId,
              channelType: 'korevg',
              channelId: linkedCallerContext.channelId || resolvedChannelId,
              sessionId: runtimeSession.id,
              contactId,
            });
          }
          log.info(`[S2S] DB session created: ${dbSessionId}`);

          // Emit voice_session_start trace event (same as pipeline mode)
          // Use actual call IDs from session:new (captured by earlyInfoExtractor)
          const actualCallSid = (sessionNewCallInfo?.callSid as string) || callSid;
          const actualCaller = (sessionNewCallInfo?.from as string) || caller;
          const actualCalled = (sessionNewCallInfo?.to as string) || called;

          const sessionStartEvent = {
            id: randomUUID(),
            sessionId: runtimeSession.id,
            type: 'voice_session_start' as const,
            timestamp: new Date(),
            data: {
              callSid: actualCallSid,
              caller: actualCaller,
              called: actualCalled,
              s2sProvider,
              s2sModel: resolvedS2SConfig.model,
              s2sVoice: resolvedS2SConfig.voice,
              // Studio expects these field names for provider/voice display
              sttVendor: traceProviderName,
              ttsVendor: s2sProvider,
              ttsVoice: resolvedS2SConfig.voice,
              channel: 'voice',
              tenantId,
            },
            agentName: agentName || 'unknown',
          };

          // 1. In-memory TraceStore
          getTraceStore().addEvent(runtimeSession.id, sessionStartEvent);

          // 2. Emit to EventStore → platform_events table (for voice analytics dashboard)
          if (tenantId) {
            Promise.all([
              import('../../eventstore-singleton.js'),
              import('@abl/eventstore/migration'),
            ])
              .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                const eventStore = getEventStore();
                if (!eventStore) return;
                emitTraceEventAsAnalytics(
                  eventStore.emitter,
                  {
                    type: 'voice_session_start',
                    sessionId: runtimeSession.id,
                    tenantId: tenantId,
                    projectId: projectId,
                    agentName: agentName || 'unknown',
                    timestamp: sessionStartEvent.timestamp,
                    durationMs: 0,
                    data: sessionStartEvent.data,
                  },
                  {
                    typeMap: VOICE_EVENT_TYPE_MAP,
                  },
                );
              })
              .catch((err) => {
                log.warn('[S2S] EventStore voice_session_start emission failed', {
                  err: err instanceof Error ? err.message : String(err),
                });
              });
          }

          // Increment traceEventCount for voice_session_start
          const { persistTurnMetrics } = await import('../../message-persistence-queue.js');
          persistTurnMetrics({
            dbSessionId,
            tenantId,
            tokensIn: 0,
            tokensOut: 0,
            cost: 0,
            traceEventCount: 1,
            errorCount: 0,
            handoffCount: 0,
          });
          return dbSessionId;
        };

        try {
          if (sessionNewCallInfo?.from || caller) {
            await ensureRealtimeDbSession();
          }
        } catch (err) {
          log.warn(
            `[S2S] DB session creation failed (persistence disabled): ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }

        // Track turn state for voice_turn events
        let lastUserTranscript: string | undefined;
        let lastAssistantTranscript: string | undefined;
        let turnStartTime = Date.now();
        let userSpeechEndTime = 0; // For E2E latency measurement
        let assistantSpeechStartTime = 0; // For E2E latency measurement
        let turnUserDurationMs = 0; // User speaking time for this turn
        let turnAssistantDurationMs = 0; // Assistant speaking time for this turn
        let pendingGoogleAssistantSpeech: {
          text: string;
          source: 'greeting' | 'tool';
        } | null = null;
        let activeRealtimeAgentRun: {
          agentName: string;
          spanId: string;
          startedAt: number;
          turn: number;
        } | null = null;

        const emitRealtimeVoiceLifecycleEvent = (event: TraceEvent) => {
          addScrubbedVoiceTraceEvent(runtimeSession.id, event, runtimeSession, {
            persistToEventStore: true,
            incrementTraceEventCount: true,
            dbSessionId: dbSessionId || undefined,
            tenantId,
            projectId,
            knownSource: 'production',
          });
        };

        const startRealtimeVoiceAgentRun = (
          turn: number,
          trigger: 'voice_turn' | 'realtime_response' | 'realtime_tool_call' | 'handoff',
        ) => {
          const currentAgent = agentName || runtimeSession.agentName || 'unknown';
          if (activeRealtimeAgentRun?.agentName === currentAgent) {
            return;
          }

          if (activeRealtimeAgentRun) {
            finishRealtimeVoiceAgentRun('continue', currentAgent);
          }

          const spanId = `voice-agent-${turn}-${randomUUID()}`;
          activeRealtimeAgentRun = {
            agentName: currentAgent,
            spanId,
            startedAt: Date.now(),
            turn,
          };

          emitRealtimeVoiceLifecycleEvent({
            id: randomUUID(),
            sessionId: runtimeSession.id,
            type: 'agent_enter',
            timestamp: new Date(),
            spanId,
            data: {
              agentName: currentAgent,
              targetAgent: currentAgent,
              mode: runtimeSession.agentIR?.flow ? 'scripted' : 'reasoning',
              trigger,
              messageSource: 'voice',
              entryReason: trigger,
              reasonCode: `agent_enter_${trigger}`,
              turn,
              channel: 'voice',
              s2sProvider,
              modality: 'realtime_voice',
              threadStackDepth: runtimeSession.threadStack?.length ?? 0,
              handoffStackDepth: runtimeSession.handoffStack?.length ?? 0,
              delegateStackDepth: runtimeSession.delegateStack?.length ?? 0,
            },
            agentName: currentAgent,
          });
        };

        const finishRealtimeVoiceAgentRun = (
          result: 'continue' | 'handoff' | 'completed' | 'abandoned' | 'error',
          nextAgent?: string,
        ) => {
          const activeRun = activeRealtimeAgentRun;
          if (!activeRun) {
            return;
          }

          activeRealtimeAgentRun = null;
          const durationMs = Math.max(0, Date.now() - activeRun.startedAt);
          const reasonCode = `agent_exit_${result}`;
          const responseDisposition =
            result === 'continue'
              ? 'continued'
              : result === 'handoff'
                ? 'handoff'
                : result === 'completed'
                  ? 'completed'
                  : result;

          emitRealtimeVoiceLifecycleEvent({
            id: randomUUID(),
            sessionId: runtimeSession.id,
            type: 'agent_exit',
            timestamp: new Date(),
            durationMs,
            spanId: activeRun.spanId,
            data: {
              agentName: activeRun.agentName,
              targetAgent: activeRun.agentName,
              ...(nextAgent ? { nextAgent } : {}),
              result,
              exitReason: result,
              exitReasonCode: reasonCode,
              terminalAction: result,
              responseDisposition,
              reasonCode,
              turn: activeRun.turn,
              channel: 'voice',
              s2sProvider,
              modality: 'realtime_voice',
              durationMs,
              threadStackDepth: runtimeSession.threadStack?.length ?? 0,
              handoffStackDepth: runtimeSession.handoffStack?.length ?? 0,
              delegateStackDepth: runtimeSession.delegateStack?.length ?? 0,
            },
            agentName: activeRun.agentName,
          });
        };

        const withRealtimeAgentParent = <T extends TraceEvent>(event: T): T & TraceEvent => {
          if (!activeRealtimeAgentRun) {
            return event as T & TraceEvent;
          }

          return {
            ...event,
            parentSpanId: event.parentSpanId ?? activeRealtimeAgentRun.spanId,
            agentRunId: event.agentRunId ?? activeRealtimeAgentRun.spanId,
            data: {
              ...event.data,
              parentSpanId: event.data.parentSpanId ?? activeRealtimeAgentRun.spanId,
              agentRunId: event.data.agentRunId ?? activeRealtimeAgentRun.spanId,
            },
          } as T & TraceEvent;
        };

        // Google S2S transcript accumulator (only used for Google provider)
        const googleAccumulator = isGoogleProvider ? new GoogleTranscriptAccumulator() : null;
        const ultravoxTranscriptAccumulator =
          providerFamily === 'ultravox' ? new UltravoxTranscriptAccumulator() : null;
        const openAIToolArguments = new Map<string, Record<string, unknown>>();
        const emittedRealtimeLlmResponseIds = new Set<string>();

        const emitRealtimeLlmCallTrace = async (eventData: Record<string, unknown>) => {
          const responseId = getGrokResponseId(eventData);
          if (responseId && emittedRealtimeLlmResponseIds.has(responseId)) {
            return;
          }
          if (responseId) {
            emittedRealtimeLlmResponseIds.add(responseId);
          }

          let activeDbSessionId = dbSessionId;
          if (!activeDbSessionId) {
            try {
              activeDbSessionId = await ensureRealtimeDbSession();
            } catch (err) {
              log.warn('[S2S] Could not create DB session for realtime llm_call trace', {
                err: err instanceof Error ? err.message : String(err),
              });
            }
          }

          const usage = extractRealtimeLlmUsage(eventData);
          const model =
            asString(llmVerb.model) ?? asString(resolvedS2SConfig.model) ?? 'realtime-voice';
          const currentTurn = turnCount + 1;
          const durationMs = userSpeechEndTime > 0 ? Date.now() - userSpeechEndTime : 0;
          const assistantTranscript =
            asString(eventData.transcript) ?? lastAssistantTranscript ?? undefined;

          startRealtimeVoiceAgentRun(currentTurn, 'realtime_response');

          const traceEvent = {
            id: randomUUID(),
            sessionId: runtimeSession.id,
            type: 'llm_call' as const,
            timestamp: new Date(),
            durationMs,
            data: {
              model,
              provider: traceProviderName,
              s2sProvider,
              modality: 'realtime_voice',
              realtime: true,
              responseId,
              turn: currentTurn,
              channel: 'voice',
              tenantId,
              tokensIn: usage.inputTokens,
              tokensOut: usage.outputTokens,
              totalTokens: usage.totalTokens,
              usage,
              request: {
                model,
                provider: traceProviderName,
                modality: 'realtime_voice',
                toolCount: promptTools.length,
                voice: resolvedS2SConfig.voice,
              },
              response: {
                status: 'completed',
                responseId,
                transcript: assistantTranscript,
              },
              userTranscript: lastUserTranscript,
            },
            agentName: agentName || 'unknown',
          };

          const scrubbedTraceEvent = addScrubbedVoiceTraceEvent(
            runtimeSession.id,
            withRealtimeAgentParent(traceEvent),
            runtimeSession,
          );

          if (tenantId) {
            Promise.all([
              import('../../eventstore-singleton.js'),
              import('@abl/eventstore/migration'),
            ])
              .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                const eventStore = getEventStore();
                if (!eventStore) return;
                emitTraceEventAsAnalytics(
                  eventStore.emitter,
                  {
                    type: 'llm_call',
                    sessionId: runtimeSession.id,
                    tenantId,
                    projectId,
                    agentName: agentName || 'unknown',
                    timestamp: scrubbedTraceEvent.timestamp,
                    durationMs,
                    spanId: scrubbedTraceEvent.spanId,
                    parentSpanId: scrubbedTraceEvent.parentSpanId,
                    data: scrubbedTraceEvent.data,
                  },
                  {
                    typeMap: VOICE_EVENT_TYPE_MAP,
                  },
                );
              })
              .catch((err) => {
                log.warn('[S2S] EventStore realtime llm_call emission failed', {
                  err: err instanceof Error ? err.message : String(err),
                });
              });
          }

          if (activeDbSessionId) {
            const { persistTurnMetrics } = await import('../../message-persistence-queue.js');
            persistTurnMetrics({
              dbSessionId: activeDbSessionId,
              tenantId,
              tokensIn: usage.inputTokens,
              tokensOut: usage.outputTokens,
              cost: 0,
              traceEventCount: 1,
              errorCount: 0,
              handoffCount: 0,
            });
          }

          if (tenantId && (usage.inputTokens > 0 || usage.outputTokens > 0)) {
            let callCost: number | null = null;
            const callModelId = model !== 'realtime-voice' ? model : '';
            if (callModelId && hasKnownPricing(callModelId)) {
              try {
                const caps = getModelCapabilities(callModelId);
                callCost = calculateCost(
                  caps.inputCostPer1k,
                  caps.outputCostPer1k,
                  usage.inputTokens,
                  usage.outputTokens,
                );
              } catch (err) {
                log.warn('[S2S] Cost calculation failed, proceeding without cost estimate', {
                  error: err instanceof Error ? err.message : String(err),
                  modelId: callModelId,
                });
              }
            }
            getClickHouseMetricsStore(tenantId)
              .then(async (store) => {
                await store.record({
                  sessionId: runtimeSession.id,
                  projectId: projectId ?? '',
                  modelId: callModelId,
                  provider: traceProviderName || '',
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                  totalTokens: usage.totalTokens,
                  estimatedCost: callCost,
                  latencyMs: durationMs,
                  streamingUsed: true,
                  toolCallCount: 0,
                  operationType: 'realtime_response',
                  agentName: agentName || '',
                  knownSource: runtimeSession.knownSource ?? 'production',
                });
              })
              .catch((err) => {
                log.error('[S2S] Failed to persist realtime llm_metrics', {
                  error: err instanceof Error ? err.message : String(err),
                  sessionId: runtimeSession.id,
                });
              });
          }
        };

        let effectiveExtractedGreeting = extractedGreeting;
        let realtimeSessionPrimePromise: Promise<{
          instructions: string;
          tools: RealtimeLlmToolDefinition[];
          greeting: string | null;
        }> | null = null;
        let googleSessionConnected = false;
        let googleGreetingServed = false;
        const geminiRawEventLoggingEnabled = process.env.KOREVG_GEMINI_RAW_EVENT_LOG === 'true';

        const queueGoogleAssistantSpeech = (
          text: string | null | undefined,
          source: 'greeting' | 'tool',
        ) => {
          const normalized = typeof text === 'string' ? text.trim() : '';
          if (!normalized || !isGoogleProvider) {
            return;
          }

          pendingGoogleAssistantSpeech = {
            text: normalized,
            source,
          };

          log.info('[S2S:Google] Queued assistant speech fallback', {
            source,
            length: normalized.length,
            preview: normalized.substring(0, 120),
          });
        };

        const ensureRealtimeSessionPrimed = async () => {
          if (!realtimeSessionPrimePromise) {
            realtimeSessionPrimePromise = (async () => {
              const initChunks: string[] = [];
              const initResult = await executor.initializeSession(
                runtimeSession.id,
                (chunk: string) => {
                  const trimmedChunk = chunk.trim();
                  if (trimmedChunk.length > 0) {
                    initChunks.push(trimmedChunk);
                  }
                },
                () => undefined,
              );

              const initGreeting =
                initResult?.response?.trim() || initChunks.join(' ').trim() || null;
              effectiveExtractedGreeting =
                initGreeting ||
                extractInitialGreeting(runtimeSession) ||
                effectiveExtractedGreeting;

              const promptState = buildKorevgRealtimePromptState({
                sessionId: runtimeSession.id,
                runtimeSession,
                entryAgentIR: voiceEntryAgent.agentIR,
                s2sProvider,
              });

              return {
                instructions: promptState.instructions,
                tools: promptState.tools,
                greeting: effectiveExtractedGreeting,
              };
            })();
          }

          return realtimeSessionPrimePromise;
        };

        const maybeStartGoogleSession = async (reason: string) => {
          if (!isGoogleProvider || googleActivateTriggerSent || !googleSessionConnected) {
            return;
          }

          try {
            await ensureRealtimeSessionPrimed();
          } catch (err) {
            log.warn('[S2S:Google] Runtime session prime failed before START_SESSION', {
              reason,
              error: err instanceof Error ? err.message : String(err),
            });
          }

          if (googleActivateTriggerSent) {
            return;
          }

          googleActivateTriggerSent = true;
          log.info('[S2S:Google] Sending realtimeInput nudge', {
            reason,
            hasGreeting: !!effectiveExtractedGreeting,
          });
          ws.send(
            JSON.stringify(
              buildKorevgLlmUpdateCommand({
                realtimeInput: {
                  text: 'START_SESSION',
                },
              }),
            ),
          );
        };

        // Track TTS audio streaming per turn (Metric 202)
        let firstAudioChunkTime = 0; // Time when first audio chunk arrives
        let audioChunkCount = 0; // Number of audio chunks received
        let lastAudioChunkTime = 0; // Time of last audio chunk
        let audioStreamStartTime = 0; // When audio streaming started for this turn
        let agentSpeakingStartTime = 0; // Track when agent starts speaking (for barge-in duration)

        // Saved TTS metrics for trace event emission (before reset)
        let savedTtfbMs: number | undefined;
        let savedAudioChunkCount = 0;
        let initialS2SAckSent = false;
        let googleActivateTriggerSent = false; // Track if we've sent the realtimeInput nudge for Google

        // Handoff orchestration state (Grok event-driven pattern)
        // Used to transition between agents without interrupting current audio
        let nextAgent: string | null = null; // Agent to transition to after current response completes
        let nextAgentHandoffContext: string | null = null; // User context for the next Grok agent
        let readyToTransition = false; // Set when response.output_audio_transcript.done received
        let pendingGrokHandoffResponseId: string | null = null;
        let latestGrokTranscriptDoneResponseId: string | null = null;
        let latestGrokResponseDoneResponseId: string | null = null;
        let grokHandoffTransitionRequested = false;
        let nextAgentHandoffSpeechPolicy = internalHandoffSpeechPolicy;

        const sendGrokInlineHandoffUpdate = (options: {
          ackMsgId?: string;
          responseId?: string | null;
          reason: string;
        }) => {
          if (!nextAgent || grokHandoffTransitionRequested) {
            return;
          }

          const targetAgent = nextAgent;
          nextAgent = null;
          grokHandoffTransitionRequested = true;
          readyToTransition = false;
          pendingGrokHandoffResponseId = options.responseId ?? pendingGrokHandoffResponseId;

          let handoffContextSummary = '';
          const userHistoryText = buildUserConversationHistoryText(
            runtimeSession.conversationHistory,
          );

          if (userHistoryText) {
            handoffContextSummary = buildGrokHandoffContextSummary(userHistoryText);
          } else if (nextAgentHandoffContext) {
            handoffContextSummary = nextAgentHandoffContext;
          }

          const grokHandoffPlan = buildKorevgGrokHandoffCommands({
            sessionId: runtimeSession.id,
            runtimeSession,
            entryAgentIR,
            s2sProvider,
            s2sConfig: resolvedS2SConfig,
            apiKey: s2sApiKey,
            handoffContext: handoffContextSummary || undefined,
            internalHandoffSpeech: nextAgentHandoffSpeechPolicy,
          });

          log.info(options.reason, {
            targetAgent,
            responseId: pendingGrokHandoffResponseId,
            toolCount: grokHandoffPlan.tools.length,
            hasUserHistory: !!userHistoryText,
            hasHandoffContext: !!handoffContextSummary,
          });

          if (options.ackMsgId) {
            ws.send(JSON.stringify({ type: 'ack', msgid: options.ackMsgId }));
          }

          log.info('[S2S:Grok] Sending inline session.update for handoff', {
            targetAgent,
            promptLength: grokHandoffPlan.instructions.length,
          });
          ws.send(JSON.stringify(grokHandoffPlan.commands[0]));

          log.info('[S2S:Grok] Sending inline response.create for handoff', {
            targetAgent,
            instructionLength:
              typeof grokHandoffPlan.commands[1]?.data === 'object' &&
              grokHandoffPlan.commands[1]?.data !== null &&
              'response' in grokHandoffPlan.commands[1].data &&
              typeof (
                grokHandoffPlan.commands[1].data as {
                  response?: { instructions?: unknown };
                }
              ).response?.instructions === 'string'
                ? (
                    grokHandoffPlan.commands[1].data as {
                      response: { instructions: string };
                    }
                  ).response.instructions.length
                : 0,
            hasHandoffContext: !!handoffContextSummary,
          });
          ws.send(JSON.stringify(grokHandoffPlan.commands[1]));

          nextAgentHandoffContext = null;
          nextAgentHandoffSpeechPolicy = internalHandoffSpeechPolicy;
        };

        const sendInitialS2SAck = () => {
          if (initialS2SAckSent || !sessionNewMsgId) {
            return;
          }

          initialS2SAckSent = true;
          log.info('[S2S] Sending initial ack with answer + pause + llm verb', {
            model: llmVerb.model,
            vendor: llmVerb.vendor,
            voice: resolvedS2SConfig.voice,
            toolCount: tools.length,
            toolNames: tools.map((t) => t.name),
            hasAuthApiKey: s2sApiKey.length > 0,
            authApiKeyLength: s2sApiKey.length,
          });

          if (providerFamily === 'openai') {
            log.info('[S2S:OpenAI] Sending bootstrap llm verb to KoreVG', {
              sessionId: runtimeSession.id,
              callSid: (sessionNewCallInfo?.callSid as string | undefined) || callSid,
              model: llmVerb.model,
              configuredVoice: resolvedS2SConfig.voice,
              sessionUpdateVoice,
              hasBootstrapResponseCreate: !!responseCreateForDiagnostics,
              responseCreateModalities,
              subscribedToSessionUpdated: llmVerb.events.includes('session.updated'),
              sessionNewMsgId,
            });
          }

          ws.send(
            JSON.stringify({
              type: 'ack',
              msgid: sessionNewMsgId,
              data: [{ verb: 'answer' }, { verb: 'pause', length: 1 }, llmVerb],
            }),
          );

          if (isGoogleProvider) {
            void ensureRealtimeSessionPrimed()
              .then(() => maybeStartGoogleSession('background-prime'))
              .catch((err) => {
                log.warn('[S2S] Background runtime session prime failed', {
                  provider: s2sProvider,
                  error: err instanceof Error ? err.message : String(err),
                });
              });
          }
        };

        // Set up WebSocket message handler for S2S verb hooks (tool calls, events)
        const handleS2SMessage = async (data: Buffer) => {
          try {
            const msg = JSON.parse(data.toString());

            if (captureSessionNewData(msg)) {
              void ensureRealtimeDbSession().catch((err) => {
                log.warn(
                  `[S2S] Deferred DB session creation failed (persistence disabled): ${
                    err instanceof Error ? err.message : String(err)
                  }`,
                );
              });
              sendInitialS2SAck();
              return;
            }

            // Handle llm:event — Google events have different structure from OpenAI
            if (msg.type === 'llm:event' && msg.data && isGoogleProvider && googleAccumulator) {
              const evt = msg.data as GoogleServerEvent;
              if (geminiRawEventLoggingEnabled) {
                log.info('[S2S:Google] Raw llm:event payload', {
                  sessionId: runtimeSession.id,
                  turn: turnCount + 1,
                  payload: msg.data,
                });
              }
              log.debug('[S2S:Google] Event received', {
                hasSetupComplete: isGoogleSetupComplete(evt),
                hasServerContent: !!(evt.serverContent ?? evt.server_content),
                hasTurnComplete:
                  !!evt.serverContent?.turnComplete ||
                  !!evt.serverContent?.turn_complete ||
                  !!evt.server_content?.turnComplete ||
                  !!evt.server_content?.turn_complete,
                hasInterrupted:
                  !!evt.serverContent?.interrupted || !!evt.server_content?.interrupted,
                fullData: JSON.stringify(msg.data).substring(0, 500),
              });

              // On session.connected, send realtimeInput nudge to trigger get_greeting tool call
              const isSessionConnected =
                !!(msg.data as any).type && (msg.data as any).type === 'session.connected';
              if (isSessionConnected) {
                googleSessionConnected = true;
                void maybeStartGoogleSession('session.connected');
              }

              // Detect barge-ins
              if (isGoogleInterrupted(evt)) {
                bargeInCount++;
                const agentSpeakingDurationMs =
                  agentSpeakingStartTime > 0 ? Date.now() - agentSpeakingStartTime : undefined;

                const bargeInEvent = {
                  id: randomUUID(),
                  sessionId: runtimeSession.id,
                  type: 'voice_barge_in' as const,
                  timestamp: new Date(),
                  data: {
                    turn: turnCount + 1,
                    type: 'speech' as const,
                    agentSpeakingDurationMs,
                    bargeInCount,
                    channel: 'voice',
                    tenantId,
                  },
                  agentName: agentName || 'unknown',
                };
                getTraceStore().addEvent(runtimeSession.id, bargeInEvent);
                googleAccumulator.resetInterrupted();

                log.info('[S2S:Google] Barge-in detected', {
                  bargeInCount,
                  agentSpeakingDurationMs,
                });
              }

              const inputTranscript = extractGoogleInputTranscript(evt);
              let userMessageIndex = -1;
              if (inputTranscript) {
                userMessageIndex = runtimeSession.conversationHistory.length;
                appendTranscriptToRuntimeHistory(executor, runtimeSession, 'user', inputTranscript);
              }

              if (inputTranscript && dbSessionId) {
                const { persistMessage, persistTurnMetrics } =
                  await import('../../message-persistence-queue.js');
                persistMessage(
                  dbSessionId,
                  'user',
                  inputTranscript,
                  'voice',
                  tenantId,
                  undefined,
                  undefined,
                  projectId,
                  Date.now(),
                );
                log.info('[S2S:Google] Persisted user transcript', {
                  length: inputTranscript.length,
                });

                startRealtimeVoiceAgentRun(turnCount + 1, 'voice_turn');

                const traceEvent = {
                  id: randomUUID(),
                  sessionId: runtimeSession.id,
                  type: 'voice_stt' as const,
                  timestamp: new Date(),
                  data: {
                    turn: turnCount + 1,
                    transcript: inputTranscript,
                    provider: 'google',
                    confidence: 1.0,
                    language: 'en-US',
                    channel: 'voice',
                    tenantId,
                  },
                  agentName: agentName || 'unknown',
                };

                log.info('[S2S] Emitting voice_stt trace event', {
                  sessionId: runtimeSession.id,
                  dbSessionId,
                  provider: 'google',
                  turn: turnCount + 1,
                });
                const scrubbedTraceEvent = addScrubbedVoiceTraceEvent(
                  runtimeSession.id,
                  withRealtimeAgentParent(traceEvent),
                  runtimeSession,
                );

                if (tenantId) {
                  Promise.all([
                    import('../../eventstore-singleton.js'),
                    import('@abl/eventstore/migration'),
                  ])
                    .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                      const eventStore = getEventStore();
                      if (!eventStore) return;
                      emitTraceEventAsAnalytics(
                        eventStore.emitter,
                        {
                          type: 'voice_stt',
                          sessionId: runtimeSession.id,
                          tenantId,
                          projectId,
                          agentName: agentName || 'unknown',
                          timestamp: scrubbedTraceEvent.timestamp,
                          durationMs: 0,
                          spanId: scrubbedTraceEvent.spanId,
                          parentSpanId: scrubbedTraceEvent.parentSpanId,
                          data: scrubbedTraceEvent.data,
                        },
                        {
                          typeMap: VOICE_EVENT_TYPE_MAP,
                        },
                      );
                    })
                    .catch((err) => {
                      log.warn('[S2S] EventStore voice_stt emission failed', {
                        err: err instanceof Error ? err.message : String(err),
                      });
                    });
                }

                persistTurnMetrics({
                  dbSessionId,
                  tenantId,
                  tokensIn: 0,
                  tokensOut: 0,
                  cost: 0,
                  traceEventCount: 1,
                  errorCount: 0,
                  handoffCount: 0,
                });

                lastUserTranscript = inputTranscript;
                userSpeechEndTime = Date.now();
                turnStartTime = userSpeechEndTime;
                turnUserDurationMs = 0;

                const bus = getRuntimeEventBus();
                if (bus && tenantId) {
                  log.debug('[S2S:Google] Emitting message.user pipeline event', {
                    sessionId: runtimeSession.id,
                    messageIndex: userMessageIndex,
                  });
                  emitVoiceMessage(bus, 'user', {
                    tenantId,
                    projectId,
                    sessionId: runtimeSession.id,
                    agentName: agentName || 'unknown',
                    content: inputTranscript,
                    messageIndex: userMessageIndex,
                    piiContext: runtimeSession,
                  });
                }
              }

              // Process transcript fragments
              const textFragment = googleAccumulator.processEvent(evt);
              if (textFragment && audioChunkCount === 0) {
                // First text fragment = proxy for first audio chunk (TTFB)
                const now = Date.now();
                audioChunkCount = 1;
                firstAudioChunkTime = now;
                audioStreamStartTime = now;
                agentSpeakingStartTime = now;
                lastAudioChunkTime = now;
                savedAudioChunkCount = 1;
                if (userSpeechEndTime > 0) {
                  savedTtfbMs = now - userSpeechEndTime;
                  log.debug('[S2S:Google] First transcript chunk (TTFB)', {
                    ttfbMs: savedTtfbMs,
                  });
                }
              } else if (textFragment) {
                audioChunkCount++;
                savedAudioChunkCount = audioChunkCount;
                lastAudioChunkTime = Date.now();
              }

              // On turn complete, flush accumulated transcript and persist
              if (googleAccumulator.isTurnComplete) {
                const streamedTranscript = googleAccumulator.flush();
                const fullTranscript =
                  streamedTranscript ||
                  (pendingGoogleAssistantSpeech ? pendingGoogleAssistantSpeech.text : '');

                if (!streamedTranscript && pendingGoogleAssistantSpeech) {
                  log.info('[S2S:Google] Using queued assistant speech fallback', {
                    source: pendingGoogleAssistantSpeech.source,
                    length: pendingGoogleAssistantSpeech.text.length,
                    preview: pendingGoogleAssistantSpeech.text.substring(0, 120),
                  });
                }

                if (savedTtfbMs !== undefined && savedAudioChunkCount > 0) {
                  let proxyMos = 4.5;
                  if (savedTtfbMs > 1000) proxyMos = 3.0;
                  else if (savedTtfbMs > 600) proxyMos = 3.7;
                  else if (savedTtfbMs > 300) proxyMos = 4.2;

                  ttsTotalTtfbMs += savedTtfbMs;
                  ttsTtfbCount++;
                  ttsProxyMosTotal += proxyMos;
                  ttsProxyMosCount++;

                  log.info('[S2S:Google] Audio streaming complete', {
                    ttfbMs: savedTtfbMs,
                    chunkCount: savedAudioChunkCount,
                    proxyMos: +proxyMos.toFixed(2),
                  });
                }

                const assistantMessageIndex = runtimeSession.conversationHistory.length;
                if (fullTranscript) {
                  appendTranscriptToRuntimeHistory(
                    executor,
                    runtimeSession,
                    'assistant',
                    fullTranscript,
                    REALTIME_ASSISTANT_TRANSCRIPT_METADATA,
                  );
                }

                if (fullTranscript && dbSessionId) {
                  // Persist as assistant message
                  const { persistMessage } = await import('../../message-persistence-queue.js');
                  persistMessage(
                    dbSessionId,
                    'assistant',
                    fullTranscript,
                    'voice',
                    tenantId,
                    undefined,
                    undefined,
                    projectId,
                    Date.now(),
                    undefined,
                    REALTIME_ASSISTANT_TRANSCRIPT_METADATA,
                  );
                  log.info('[S2S:Google] Persisted assistant transcript', {
                    length: fullTranscript.length,
                    turn: turnCount + 1,
                  });

                  // Emit voice_tts trace event
                  const traceEvent = {
                    id: randomUUID(),
                    sessionId: runtimeSession.id,
                    type: 'voice_tts' as const,
                    timestamp: new Date(),
                    data: {
                      turn: turnCount + 1,
                      text: fullTranscript,
                      provider: s2sProvider,
                      voice: resolvedS2SConfig.voice,
                      streaming: true,
                      connectionMs: savedTtfbMs,
                      chunks: savedAudioChunkCount,
                      durationMs: 0,
                      channel: 'voice',
                      tenantId,
                    },
                    agentName: agentName || 'unknown',
                  };
                  const scrubbedTraceEvent = addScrubbedVoiceTraceEvent(
                    runtimeSession.id,
                    withRealtimeAgentParent(traceEvent),
                    runtimeSession,
                  );

                  if (tenantId) {
                    Promise.all([
                      import('../../eventstore-singleton.js'),
                      import('@abl/eventstore/migration'),
                    ])
                      .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                        const eventStore = getEventStore();
                        if (!eventStore) return;
                        emitTraceEventAsAnalytics(
                          eventStore.emitter,
                          {
                            type: 'voice_tts',
                            sessionId: runtimeSession.id,
                            tenantId,
                            projectId,
                            agentName: agentName || 'unknown',
                            timestamp: scrubbedTraceEvent.timestamp,
                            durationMs: 0,
                            data: scrubbedTraceEvent.data,
                          },
                          {
                            typeMap: VOICE_EVENT_TYPE_MAP,
                          },
                        );
                      })
                      .catch((err) => {
                        log.warn('[S2S] EventStore voice_tts emission failed', {
                          err: err instanceof Error ? err.message : String(err),
                        });
                      });
                  }

                  // Increment traceEventCount
                  const { persistTurnMetrics } = await import('../../message-persistence-queue.js');
                  persistTurnMetrics({
                    dbSessionId,
                    tenantId,
                    tokensIn: 0,
                    tokensOut: 0,
                    cost: 0,
                    traceEventCount: 1,
                    errorCount: 0,
                    handoffCount: 0,
                  });

                  assistantSpeechStartTime =
                    savedTtfbMs !== undefined && userSpeechEndTime > 0
                      ? userSpeechEndTime + savedTtfbMs
                      : Date.now();
                  const wordCount = fullTranscript.split(/\s+/).filter(Boolean).length;
                  turnAssistantDurationMs = wordCount * 400;
                  agentSpeakingTotalMs += turnAssistantDurationMs;

                  // Update turn metrics
                  turnCount++;
                  if (lastUserTranscript) {
                    const turnDuration = Date.now() - turnStartTime;
                    const e2eLatency =
                      userSpeechEndTime > 0 ? assistantSpeechStartTime - userSpeechEndTime : null;
                    const voiceTurnEvent = {
                      id: randomUUID(),
                      sessionId: runtimeSession.id,
                      type: 'voice_turn' as const,
                      timestamp: new Date(),
                      data: {
                        turn: turnCount,
                        userInput: lastUserTranscript,
                        assistantResponse: fullTranscript,
                        durationMs: turnDuration,
                        channel: 'voice',
                        s2sProvider,
                        tenantId,
                        e2eLatencyMs: e2eLatency,
                        userSpeakingMs: turnUserDurationMs,
                        agentSpeakingMs: turnAssistantDurationMs,
                      },
                      agentName: agentName || 'unknown',
                    };

                    const scrubbedVoiceTurnEvent = addScrubbedVoiceTraceEvent(
                      runtimeSession.id,
                      withRealtimeAgentParent(voiceTurnEvent),
                      runtimeSession,
                    );

                    if (tenantId) {
                      Promise.all([
                        import('../../eventstore-singleton.js'),
                        import('@abl/eventstore/migration'),
                      ])
                        .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                          const eventStore = getEventStore();
                          if (!eventStore) return;
                          emitTraceEventAsAnalytics(
                            eventStore.emitter,
                            {
                              type: 'voice_turn',
                              sessionId: runtimeSession.id,
                              tenantId,
                              projectId,
                              agentName: agentName || 'unknown',
                              timestamp: scrubbedVoiceTurnEvent.timestamp,
                              durationMs: turnDuration,
                              spanId: scrubbedVoiceTurnEvent.spanId,
                              parentSpanId: scrubbedVoiceTurnEvent.parentSpanId,
                              data: scrubbedVoiceTurnEvent.data,
                            },
                            {
                              typeMap: VOICE_EVENT_TYPE_MAP,
                            },
                          );
                        })
                        .catch((err) => {
                          log.warn('[S2S] EventStore voice_turn emission failed', {
                            err: err instanceof Error ? err.message : String(err),
                          });
                        });
                    }

                    persistTurnMetrics({
                      dbSessionId,
                      tenantId,
                      tokensIn: 0,
                      tokensOut: 0,
                      cost: 0,
                      traceEventCount: 1,
                      errorCount: 0,
                      handoffCount: 0,
                    });

                    finishRealtimeVoiceAgentRun('continue');
                  }

                  turnStartTime = Date.now();
                  userSpeechEndTime = 0;
                  assistantSpeechStartTime = 0;
                  audioChunkCount = 0;
                  firstAudioChunkTime = 0;
                  audioStreamStartTime = 0;
                  savedTtfbMs = undefined;
                  savedAudioChunkCount = 0;
                  lastUserTranscript = undefined;
                  lastAssistantTranscript = fullTranscript;
                  turnUserDurationMs = 0;
                  turnAssistantDurationMs = 0;

                  const bus = getRuntimeEventBus();
                  if (bus && tenantId) {
                    log.debug('[S2S:Google] Emitting message.agent pipeline event', {
                      sessionId: runtimeSession.id,
                      messageIndex: assistantMessageIndex,
                    });
                    emitVoiceMessage(bus, 'assistant', {
                      tenantId,
                      projectId,
                      sessionId: runtimeSession.id,
                      agentName: agentName || 'unknown',
                      content: fullTranscript,
                      messageIndex: assistantMessageIndex,
                      piiContext: runtimeSession,
                    });
                  }
                }

                pendingGoogleAssistantSpeech = null;
              }

              ws.send(JSON.stringify({ type: 'ack', msgid: msg.msgid }));
              return;
            }

            if (
              msg.type === 'llm:event' &&
              msg.data &&
              !isGoogleProvider &&
              !isGrokProvider &&
              providerFamily !== 'openai'
            ) {
              const translatedEvents = translateProviderEventToRealtimeEvents(
                s2sProvider,
                msg.data as Record<string, unknown>,
                ultravoxTranscriptAccumulator ?? new UltravoxTranscriptAccumulator(),
              );

              for (const translatedEvent of translatedEvents) {
                const eventType = translatedEvent.type;
                log.debug('[S2S] Provider event translated', {
                  provider: traceProviderName,
                  sourceType:
                    typeof (msg.data as { type?: unknown }).type === 'string'
                      ? (msg.data as { type: string }).type
                      : 'unknown',
                  translatedType: eventType,
                });

                if (eventType === 'conversation.item.truncated') {
                  bargeInCount++;
                  const agentSpeakingDurationMs =
                    agentSpeakingStartTime > 0 ? Date.now() - agentSpeakingStartTime : undefined;

                  const bargeInEvent = {
                    id: randomUUID(),
                    sessionId: runtimeSession.id,
                    type: 'voice_barge_in' as const,
                    timestamp: new Date(),
                    data: {
                      turn: turnCount + 1,
                      type: 'speech' as const,
                      agentSpeakingDurationMs,
                      bargeInCount,
                      channel: 'voice',
                      tenantId,
                    },
                    agentName: agentName || 'unknown',
                  };

                  getTraceStore().addEvent(runtimeSession.id, bargeInEvent);

                  if (tenantId) {
                    Promise.all([
                      import('../../eventstore-singleton.js'),
                      import('@abl/eventstore/migration'),
                    ])
                      .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                        const eventStore = getEventStore();
                        if (!eventStore) return;
                        emitTraceEventAsAnalytics(
                          eventStore.emitter,
                          {
                            type: 'voice_barge_in',
                            sessionId: runtimeSession.id,
                            tenantId,
                            projectId,
                            agentName: agentName || 'unknown',
                            timestamp: bargeInEvent.timestamp,
                            durationMs: 0,
                            data: bargeInEvent.data,
                          },
                          {
                            typeMap: VOICE_EVENT_TYPE_MAP,
                          },
                        );
                      })
                      .catch((err) => {
                        log.warn('[S2S] EventStore voice_barge_in emission failed', {
                          err: err instanceof Error ? err.message : String(err),
                        });
                      });
                  }
                }

                if (eventType === 'response.audio_transcript.delta') {
                  const now = Date.now();
                  audioChunkCount++;
                  lastAudioChunkTime = now;

                  if (audioChunkCount === 1 && userSpeechEndTime > 0) {
                    firstAudioChunkTime = now;
                    audioStreamStartTime = now;
                    agentSpeakingStartTime = now;
                    savedTtfbMs = firstAudioChunkTime - userSpeechEndTime;
                    savedAudioChunkCount = 1;
                  }

                  if (audioChunkCount > 0) {
                    savedAudioChunkCount = audioChunkCount;
                  }
                }

                if (!translatedEvent.transcript) {
                  continue;
                }

                const translatedMessageIndex = runtimeSession.conversationHistory.length;
                appendTranscriptToRuntimeHistory(
                  executor,
                  runtimeSession,
                  eventType.includes('input') ? 'user' : 'assistant',
                  translatedEvent.transcript,
                );

                if (!dbSessionId) {
                  continue;
                }

                try {
                  const { persistMessage, persistTurnMetrics } =
                    await import('../../message-persistence-queue.js');
                  const role = eventType.includes('input') ? 'user' : 'assistant';
                  persistMessage(
                    dbSessionId,
                    role,
                    translatedEvent.transcript,
                    'voice',
                    tenantId,
                    undefined,
                    undefined,
                    projectId,
                    Date.now(),
                  );

                  const currentTurn = turnCount + 1;
                  const translatedBus = getRuntimeEventBus();
                  if (role === 'user') {
                    const traceEvent = {
                      id: randomUUID(),
                      sessionId: runtimeSession.id,
                      type: 'voice_stt' as const,
                      timestamp: new Date(),
                      data: {
                        turn: currentTurn,
                        transcript: translatedEvent.transcript,
                        provider: traceProviderName,
                        confidence: 1.0,
                        language: 'en-US',
                        channel: 'voice',
                        tenantId,
                      },
                      agentName: agentName || 'unknown',
                    };

                    getTraceStore().addEvent(runtimeSession.id, traceEvent);

                    if (tenantId) {
                      Promise.all([
                        import('../../eventstore-singleton.js'),
                        import('@abl/eventstore/migration'),
                      ])
                        .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                          const eventStore = getEventStore();
                          if (!eventStore) return;
                          emitTraceEventAsAnalytics(
                            eventStore.emitter,
                            {
                              type: 'voice_stt',
                              sessionId: runtimeSession.id,
                              tenantId,
                              projectId,
                              agentName: agentName || 'unknown',
                              timestamp: traceEvent.timestamp,
                              durationMs: 0,
                              data: traceEvent.data,
                            },
                            {
                              typeMap: VOICE_EVENT_TYPE_MAP,
                            },
                          );
                        })
                        .catch((err) => {
                          log.warn('[S2S] EventStore voice_stt emission failed', {
                            err: err instanceof Error ? err.message : String(err),
                          });
                        });
                    }

                    persistTurnMetrics({
                      dbSessionId,
                      tenantId,
                      tokensIn: 0,
                      tokensOut: 0,
                      cost: 0,
                      traceEventCount: 1,
                      errorCount: 0,
                      handoffCount: 0,
                    });

                    lastUserTranscript = translatedEvent.transcript;
                    userSpeechEndTime = Date.now();
                    turnStartTime = userSpeechEndTime;

                    if (translatedBus && tenantId) {
                      log.debug('[S2S:translated] Emitting message.user pipeline event', {
                        sessionId: runtimeSession.id,
                        messageIndex: translatedMessageIndex,
                      });
                      emitVoiceMessage(translatedBus, 'user', {
                        tenantId,
                        projectId,
                        sessionId: runtimeSession.id,
                        agentName: agentName || 'unknown',
                        content: translatedEvent.transcript,
                        messageIndex: translatedMessageIndex,
                        piiContext: runtimeSession,
                      });
                    }
                  } else {
                    const traceEvent = {
                      id: randomUUID(),
                      sessionId: runtimeSession.id,
                      type: 'voice_tts' as const,
                      timestamp: new Date(),
                      data: {
                        turn: currentTurn,
                        text: translatedEvent.transcript,
                        provider: s2sProvider,
                        voice: resolvedS2SConfig.voice,
                        streaming: true,
                        connectionMs: savedTtfbMs,
                        chunks: savedAudioChunkCount,
                        durationMs: 0,
                        channel: 'voice',
                        tenantId,
                      },
                      agentName: agentName || 'unknown',
                    };

                    getTraceStore().addEvent(runtimeSession.id, traceEvent);

                    if (tenantId) {
                      Promise.all([
                        import('../../eventstore-singleton.js'),
                        import('@abl/eventstore/migration'),
                      ])
                        .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                          const eventStore = getEventStore();
                          if (!eventStore) return;
                          emitTraceEventAsAnalytics(
                            eventStore.emitter,
                            {
                              type: 'voice_tts',
                              sessionId: runtimeSession.id,
                              tenantId,
                              projectId,
                              agentName: agentName || 'unknown',
                              timestamp: traceEvent.timestamp,
                              durationMs: 0,
                              data: traceEvent.data,
                            },
                            {
                              typeMap: VOICE_EVENT_TYPE_MAP,
                            },
                          );
                        })
                        .catch((err) => {
                          log.warn('[S2S] EventStore voice_tts emission failed', {
                            err: err instanceof Error ? err.message : String(err),
                          });
                        });
                    }

                    persistTurnMetrics({
                      dbSessionId,
                      tenantId,
                      tokensIn: 0,
                      tokensOut: 0,
                      cost: 0,
                      traceEventCount: 1,
                      errorCount: 0,
                      handoffCount: 0,
                    });

                    savedTtfbMs = undefined;
                    savedAudioChunkCount = 0;
                    agentSpeakingStartTime = 0;
                    lastAssistantTranscript = translatedEvent.transcript;
                    assistantSpeechStartTime = Date.now();

                    if (translatedBus && tenantId) {
                      log.debug('[S2S:translated] Emitting message.agent pipeline event', {
                        sessionId: runtimeSession.id,
                        messageIndex: translatedMessageIndex,
                      });
                      emitVoiceMessage(translatedBus, 'assistant', {
                        tenantId,
                        projectId,
                        sessionId: runtimeSession.id,
                        agentName: agentName || 'unknown',
                        content: translatedEvent.transcript,
                        messageIndex: translatedMessageIndex,
                        piiContext: runtimeSession,
                      });
                    }

                    if (userSpeechEndTime > 0) {
                      const e2eLatency = assistantSpeechStartTime - userSpeechEndTime;
                      e2eTotalMs += e2eLatency;
                      e2eCount++;
                    }

                    const wordCount = translatedEvent.transcript
                      .split(/\s+/)
                      .filter(Boolean).length;
                    turnAssistantDurationMs = wordCount * 400;
                    agentSpeakingTotalMs += turnAssistantDurationMs;

                    if (lastUserTranscript) {
                      turnCount++;
                      const turnDuration = Date.now() - turnStartTime;
                      const e2eLatency = assistantSpeechStartTime - userSpeechEndTime;

                      if (turnCount === 1 && callPhase === 'greeting') {
                        callPhase = 'conversation';
                      }

                      const voiceTurnEvent = {
                        id: randomUUID(),
                        sessionId: runtimeSession.id,
                        type: 'voice_turn' as const,
                        timestamp: new Date(),
                        data: {
                          turn: turnCount,
                          userInput: lastUserTranscript,
                          assistantResponse: lastAssistantTranscript,
                          durationMs: turnDuration,
                          channel: 'voice',
                          s2sProvider,
                          tenantId,
                          e2eLatencyMs: e2eLatency > 0 ? e2eLatency : null,
                          userSpeakingMs: turnUserDurationMs,
                          agentSpeakingMs: turnAssistantDurationMs,
                        },
                        agentName: agentName || 'unknown',
                      };

                      getTraceStore().addEvent(runtimeSession.id, voiceTurnEvent);

                      if (tenantId) {
                        Promise.all([
                          import('../../eventstore-singleton.js'),
                          import('@abl/eventstore/migration'),
                        ])
                          .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                            const eventStore = getEventStore();
                            if (!eventStore) return;
                            emitTraceEventAsAnalytics(
                              eventStore.emitter,
                              {
                                type: 'voice_turn',
                                sessionId: runtimeSession.id,
                                tenantId,
                                projectId,
                                agentName: agentName || 'unknown',
                                timestamp: voiceTurnEvent.timestamp,
                                durationMs: turnDuration,
                                data: voiceTurnEvent.data,
                              },
                              {
                                typeMap: VOICE_EVENT_TYPE_MAP,
                              },
                            );
                          })
                          .catch((err) => {
                            log.warn('[S2S] EventStore voice_turn emission failed', {
                              err: err instanceof Error ? err.message : String(err),
                            });
                          });
                      }

                      persistTurnMetrics({
                        dbSessionId,
                        tenantId,
                        tokensIn: 0,
                        tokensOut: 0,
                        cost: 0,
                        traceEventCount: 1,
                        errorCount: 0,
                        handoffCount: 0,
                      });

                      finishRealtimeVoiceAgentRun('continue');
                      lastUserTranscript = undefined;
                      lastAssistantTranscript = undefined;
                    }
                  }
                } catch (err) {
                  log.warn('[S2S] Failed to persist translated provider transcript', {
                    err: err instanceof Error ? err.message : String(err),
                    provider: traceProviderName,
                  });
                }
              }

              ws.send(JSON.stringify({ type: 'ack', msgid: msg.msgid }));
              return;
            }

            // Handle llm:event (OpenAI Realtime API events with transcripts)
            if (msg.type === 'llm:event' && msg.data) {
              // Drop all AI-generated events once we are in transfer phase — the human
              // agent is now bridged (or about to be) and any OpenAI audio/response
              // would play over the live agent ↔ user conversation.
              if (callPhase === 'transfer') {
                ws.send(JSON.stringify({ type: 'ack', msgid: msg.msgid }));
                return;
              }

              const eventType = msg.data.type;
              const grokResponseId = getGrokResponseId(msg.data as Record<string, unknown>);
              log.debug('[S2S] Event received', {
                eventType,
                provider: traceProviderName,
              });

              if (providerFamily === 'openai') {
                const eventSession = isRecord(msg.data.session) ? msg.data.session : undefined;
                const eventResponse = isRecord(msg.data.response) ? msg.data.response : undefined;
                const eventSessionVoice =
                  typeof eventSession?.voice === 'string' ? eventSession.voice : undefined;
                const eventResponseVoice =
                  typeof eventResponse?.voice === 'string' ? eventResponse.voice : undefined;
                const eventResponseModalities = Array.isArray(eventResponse?.modalities)
                  ? eventResponse.modalities
                  : undefined;
                const eventResponseId =
                  typeof eventResponse?.id === 'string'
                    ? eventResponse.id
                    : typeof msg.data.response_id === 'string'
                      ? msg.data.response_id
                      : undefined;

                if (eventType === 'response.created') {
                  latestOpenAIResponseId = eventResponseId ?? latestOpenAIResponseId;
                  latestOpenAIResponseVoice = eventResponseVoice ?? latestOpenAIResponseVoice;
                  if (eventResponseId) {
                    openAIResponseVoices.set(eventResponseId, eventResponseVoice);
                  }

                  log.info('[S2S:OpenAI] response.created', {
                    sessionId: runtimeSession.id,
                    callSid: (sessionNewCallInfo?.callSid as string | undefined) || callSid,
                    responseId: eventResponseId,
                    configuredVoice: resolvedS2SConfig.voice,
                    sessionUpdateVoice,
                    responseVoice: eventResponseVoice,
                    responseModalities: eventResponseModalities,
                    hasBootstrapResponseCreate: !!responseCreateForDiagnostics,
                    sessionUpdatedReceived: openAISessionUpdatedReceived,
                  });

                  if (!openAISessionUpdatedReceived) {
                    openAIEarlyResponseCreatedCount += 1;
                    log.warn('[S2S:OpenAI] response.created arrived before session.updated', {
                      sessionId: runtimeSession.id,
                      callSid: (sessionNewCallInfo?.callSid as string | undefined) || callSid,
                      earlyResponseCreatedCount: openAIEarlyResponseCreatedCount,
                      responseId: eventResponseId,
                      configuredVoice: resolvedS2SConfig.voice,
                      sessionUpdateVoice,
                      responseVoice: eventResponseVoice,
                      responseModalities: eventResponseModalities,
                      hasBootstrapResponseCreate: !!responseCreateForDiagnostics,
                    });
                  }
                }

                if (eventType === 'session.updated') {
                  openAISessionUpdatedReceived = true;
                  log.info('[S2S:OpenAI] session.updated received', {
                    sessionId: runtimeSession.id,
                    callSid: (sessionNewCallInfo?.callSid as string | undefined) || callSid,
                    configuredVoice: resolvedS2SConfig.voice,
                    sessionUpdateVoice,
                    eventSessionVoice,
                    hasBootstrapResponseCreate: !!responseCreateForDiagnostics,
                    earlyResponseCreatedCount: openAIEarlyResponseCreatedCount,
                  });
                }
              }

              // TEMPORARY DEBUG: Log full event data for Grok
              if (isGrokProvider) {
                log.info('[S2S:DEBUG] Grok event', {
                  type: eventType,
                  data: JSON.stringify(msg.data).substring(0, 500),
                });
              }

              if (eventType === 'response.function_call_arguments.done') {
                const callId =
                  typeof msg.data.call_id === 'string'
                    ? msg.data.call_id
                    : typeof msg.data.item_id === 'string'
                      ? msg.data.item_id
                      : null;
                const rawArguments = msg.data.arguments;

                if (callId && typeof rawArguments === 'string' && rawArguments.trim().length > 0) {
                  try {
                    const parsed = JSON.parse(rawArguments) as Record<string, unknown>;
                    openAIToolArguments.set(callId, parsed);
                    log.info('[S2S] Cached OpenAI function arguments', {
                      callId,
                      keys: Object.keys(parsed),
                    });
                  } catch (err) {
                    log.warn('[S2S] Failed to parse OpenAI function arguments', {
                      callId,
                      error: err instanceof Error ? err.message : String(err),
                    });
                  }
                }
              }

              if (eventType === 'response.done') {
                await emitRealtimeLlmCallTrace(msg.data as Record<string, unknown>);
              }

              // Detect barge-ins (conversation.item.truncated means user interrupted)
              if (eventType === 'conversation.item.truncated') {
                bargeInCount++;
                const agentSpeakingDurationMs =
                  agentSpeakingStartTime > 0 ? Date.now() - agentSpeakingStartTime : undefined;

                // Emit voice_barge_in event
                const bargeInEvent = {
                  id: randomUUID(),
                  sessionId: runtimeSession.id,
                  type: 'voice_barge_in' as const,
                  timestamp: new Date(),
                  data: {
                    turn: turnCount + 1, // Next turn will be interrupted
                    type: 'speech' as const, // S2S only has speech barge-ins (no DTMF)
                    agentSpeakingDurationMs,
                    bargeInCount,
                    channel: 'voice',
                    tenantId,
                  },
                  agentName: agentName || 'unknown',
                };

                // 1. In-memory TraceStore
                getTraceStore().addEvent(runtimeSession.id, bargeInEvent);

                // 2. Emit to EventStore → platform_events table
                if (tenantId) {
                  Promise.all([
                    import('../../eventstore-singleton.js'),
                    import('@abl/eventstore/migration'),
                  ])
                    .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                      const eventStore = getEventStore();
                      if (!eventStore) return;
                      emitTraceEventAsAnalytics(
                        eventStore.emitter,
                        {
                          type: 'voice_barge_in',
                          sessionId: runtimeSession.id,
                          tenantId: tenantId,
                          projectId: projectId,
                          agentName: agentName || 'unknown',
                          timestamp: bargeInEvent.timestamp,
                          durationMs: 0,
                          data: bargeInEvent.data,
                        },
                        {
                          typeMap: VOICE_EVENT_TYPE_MAP,
                        },
                      );
                    })
                    .catch((err) => {
                      log.warn('[S2S] EventStore voice_barge_in emission failed', {
                        err: err instanceof Error ? err.message : String(err),
                      });
                    });
                }

                log.info('[S2S] Barge-in detected', {
                  bargeInCount,
                  agentSpeakingDurationMs,
                  turn: turnCount + 1,
                });
              }

              // Mark when user speech ends (for TTFB calculation)
              // Reset audio metrics for the upcoming assistant response
              if (eventType === 'input_audio_buffer.committed') {
                userSpeechEndTime = Date.now();
                audioChunkCount = 0; // Reset for next assistant response
                firstAudioChunkTime = 0;
                audioStreamStartTime = 0;
                // DON'T reset savedTtfbMs here - transcript.done may not have arrived yet
                log.debug('[S2S] User speech ended, reset metrics', { userSpeechEndTime });
              }

              // Track TTS audio streaming via transcript deltas (Metric 202: TTFB and streaming quality)
              // In S2S mode, audio is streamed directly to FreeSWITCH via WebSocket
              // We use transcript deltas as a proxy for audio chunk timing
              if (eventType === 'response.audio_transcript.delta') {
                const now = Date.now();
                audioChunkCount++;
                lastAudioChunkTime = now;

                // Measure TTFB (time to first transcript chunk after user speech)
                if (audioChunkCount === 1 && userSpeechEndTime > 0) {
                  firstAudioChunkTime = now;
                  audioStreamStartTime = now;
                  agentSpeakingStartTime = now; // Track when agent starts speaking for barge-in
                  const ttfb = firstAudioChunkTime - userSpeechEndTime;

                  // Save metrics immediately for use in transcript.done handler
                  savedTtfbMs = ttfb;
                  savedAudioChunkCount = 1; // Will increment as more chunks arrive

                  log.debug('[S2S] First transcript chunk received (TTFB)', {
                    ttfbMs: ttfb,
                    chunkCount: audioChunkCount,
                  });
                }

                // Update chunk count in saved metrics
                if (audioChunkCount > 0) {
                  savedAudioChunkCount = audioChunkCount;
                }
              }

              // Audio streaming complete - use SAVED metrics (already calculated on first delta)
              // Don't recalculate here because values may be reset by next turn
              if (eventType === 'response.audio_transcript.done') {
                if (savedTtfbMs !== undefined && savedAudioChunkCount > 0) {
                  const ttfb = savedTtfbMs;
                  const chunkCount = savedAudioChunkCount;

                  // Compute proxy MOS based on TTFB
                  let proxyMos = 4.5;
                  if (ttfb > 1000) proxyMos = 3.0;
                  else if (ttfb > 600) proxyMos = 3.7;
                  else if (ttfb > 300) proxyMos = 4.2;

                  ttsTotalTtfbMs += ttfb;
                  ttsTtfbCount++;
                  ttsProxyMosTotal += proxyMos;
                  ttsProxyMosCount++;

                  log.info('[S2S] Audio streaming complete', {
                    ttfbMs: ttfb,
                    chunkCount: chunkCount,
                    proxyMos: +proxyMos.toFixed(2),
                  });

                  // DON'T clear saved metrics here - trace event emission happens later in the same event
                }
              }

              // Keep runtime history in sync with voice transcripts even if DB persistence is unavailable.
              const openaiMessageIndex = runtimeSession.conversationHistory.length;
              if (msg.data.transcript) {
                const role = eventType.includes('input') ? 'user' : 'assistant';
                const metadata =
                  role === 'assistant' ? REALTIME_ASSISTANT_TRANSCRIPT_METADATA : undefined;
                appendTranscriptToRuntimeHistory(
                  executor,
                  runtimeSession,
                  role,
                  msg.data.transcript,
                  metadata,
                );
              }

              // Persist transcripts as messages
              if (dbSessionId && msg.data.transcript) {
                try {
                  const { persistMessage } = await import('../../message-persistence-queue.js');
                  const role = eventType.includes('input') ? 'user' : 'assistant';
                  const metadata =
                    role === 'assistant' ? REALTIME_ASSISTANT_TRANSCRIPT_METADATA : undefined;
                  persistMessage(
                    dbSessionId,
                    role,
                    msg.data.transcript,
                    'voice',
                    tenantId,
                    undefined,
                    undefined,
                    projectId,
                    Date.now(),
                    undefined,
                    metadata,
                  );
                  log.info('[S2S] Persisted transcript', {
                    role,
                    length: msg.data.transcript.length,
                  });

                  // Emit voice_stt or voice_tts trace events (persist to in-memory + EventStore)
                  const currentTurn = turnCount + 1; // Next turn is starting

                  if (role === 'user') {
                    startRealtimeVoiceAgentRun(currentTurn, 'voice_turn');

                    // Emit voice_stt for user speech recognition
                    const traceEvent = {
                      id: randomUUID(),
                      sessionId: runtimeSession.id,
                      type: 'voice_stt' as const,
                      timestamp: new Date(),
                      data: {
                        turn: currentTurn,
                        transcript: msg.data.transcript,
                        provider: traceProviderName,
                        confidence: 1.0,
                        language: 'en-US',
                        durationMs: msg.data.usage?.seconds
                          ? msg.data.usage.seconds * 1000
                          : undefined,
                        channel: 'voice',
                        tenantId,
                      },
                      agentName: agentName || 'unknown',
                    };

                    // 1. In-memory TraceStore
                    log.info('[S2S] Emitting voice_stt trace event', {
                      sessionId: runtimeSession.id,
                      dbSessionId: dbSessionId,
                      provider: traceProviderName,
                      turn: currentTurn,
                    });
                    const scrubbedTraceEvent = addScrubbedVoiceTraceEvent(
                      runtimeSession.id,
                      withRealtimeAgentParent(traceEvent),
                      runtimeSession,
                    );

                    // 2. Emit to EventStore → platform_events table
                    if (tenantId) {
                      Promise.all([
                        import('../../eventstore-singleton.js'),
                        import('@abl/eventstore/migration'),
                      ])
                        .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                          const eventStore = getEventStore();
                          if (!eventStore) return;
                          emitTraceEventAsAnalytics(
                            eventStore.emitter,
                            {
                              type: 'voice_stt',
                              sessionId: runtimeSession.id,
                              tenantId: tenantId,
                              projectId: projectId,
                              agentName: agentName || 'unknown',
                              timestamp: scrubbedTraceEvent.timestamp,
                              durationMs: (scrubbedTraceEvent.data.durationMs as number) || 0,
                              spanId: scrubbedTraceEvent.spanId,
                              parentSpanId: scrubbedTraceEvent.parentSpanId,
                              data: scrubbedTraceEvent.data,
                            },
                            {
                              typeMap: VOICE_EVENT_TYPE_MAP,
                            },
                          );
                        })
                        .catch((err) => {
                          log.warn('[S2S] EventStore voice_stt emission failed', {
                            err: err instanceof Error ? err.message : String(err),
                          });
                        });
                    }

                    // Increment traceEventCount for voice_stt
                    const { persistTurnMetrics } =
                      await import('../../message-persistence-queue.js');
                    persistTurnMetrics({
                      dbSessionId,
                      tenantId,
                      tokensIn: 0,
                      tokensOut: 0,
                      cost: 0,
                      traceEventCount: 1,
                      errorCount: 0,
                      handoffCount: 0,
                    });
                  } else {
                    // Emit voice_tts using saved metrics (captured before reset)
                    // NOTE: Studio expects 'connectionMs' for streaming TTS (not 'firstChunkMs')
                    const openAIResponseId =
                      providerFamily === 'openai'
                        ? getGrokResponseId(msg.data as Record<string, unknown>) ||
                          latestOpenAIResponseId
                        : undefined;
                    const openAIResponseVoice =
                      providerFamily === 'openai' && openAIResponseId
                        ? (openAIResponseVoices.get(openAIResponseId) ?? latestOpenAIResponseVoice)
                        : providerFamily === 'openai'
                          ? latestOpenAIResponseVoice
                          : undefined;
                    const configuredVoice =
                      typeof resolvedS2SConfig.voice === 'string'
                        ? resolvedS2SConfig.voice
                        : undefined;
                    const traceVoice = openAIResponseVoice ?? configuredVoice;
                    const voiceMismatch =
                      !!configuredVoice &&
                      !!openAIResponseVoice &&
                      configuredVoice !== openAIResponseVoice;
                    const traceEvent = {
                      id: randomUUID(),
                      sessionId: runtimeSession.id,
                      type: 'voice_tts' as const,
                      timestamp: new Date(),
                      data: {
                        turn: currentTurn,
                        text: msg.data.transcript,
                        provider: s2sProvider,
                        voice: traceVoice ?? resolvedS2SConfig.voice,
                        configuredVoice,
                        openaiResponseVoice: openAIResponseVoice,
                        openaiResponseId: openAIResponseId,
                        voiceMismatch,
                        streaming: true,
                        connectionMs: savedTtfbMs,
                        chunks: savedAudioChunkCount,
                        durationMs: 0, // S2S streaming doesn't track total TTS duration
                        channel: 'voice',
                        tenantId,
                      },
                      agentName: agentName || 'unknown',
                    };

                    // 1. In-memory TraceStore
                    log.info('[S2S] Emitting voice_tts trace event', {
                      sessionId: runtimeSession.id,
                      dbSessionId: dbSessionId,
                      provider: s2sProvider,
                      voice: traceVoice ?? resolvedS2SConfig.voice,
                      configuredVoice,
                      openaiResponseVoice: openAIResponseVoice,
                      openaiResponseId: openAIResponseId,
                      voiceMismatch,
                      connectionMs: savedTtfbMs,
                      chunks: savedAudioChunkCount,
                      turn: currentTurn,
                    });
                    const scrubbedTraceEvent = addScrubbedVoiceTraceEvent(
                      runtimeSession.id,
                      withRealtimeAgentParent(traceEvent),
                      runtimeSession,
                    );

                    // 2. Emit to EventStore → platform_events table
                    if (tenantId) {
                      Promise.all([
                        import('../../eventstore-singleton.js'),
                        import('@abl/eventstore/migration'),
                      ])
                        .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                          const eventStore = getEventStore();
                          if (!eventStore) return;
                          emitTraceEventAsAnalytics(
                            eventStore.emitter,
                            {
                              type: 'voice_tts',
                              sessionId: runtimeSession.id,
                              tenantId: tenantId,
                              projectId: projectId,
                              agentName: agentName || 'unknown',
                              timestamp: scrubbedTraceEvent.timestamp,
                              durationMs: 0,
                              data: scrubbedTraceEvent.data,
                            },
                            {
                              typeMap: VOICE_EVENT_TYPE_MAP,
                            },
                          );
                        })
                        .catch((err) => {
                          log.warn('[S2S] EventStore voice_tts emission failed', {
                            err: err instanceof Error ? err.message : String(err),
                          });
                        });
                    }

                    // Increment traceEventCount for voice_tts
                    const { persistTurnMetrics } =
                      await import('../../message-persistence-queue.js');
                    persistTurnMetrics({
                      dbSessionId,
                      tenantId,
                      tokensIn: 0,
                      tokensOut: 0,
                      cost: 0,
                      traceEventCount: 1,
                      errorCount: 0,
                      handoffCount: 0,
                    });

                    // Clear saved metrics after trace event emission
                    savedTtfbMs = undefined;
                    savedAudioChunkCount = 0;
                    agentSpeakingStartTime = 0; // Reset after agent finishes speaking
                  }

                  // Track turn completion and emit voice_turn event
                  if (role === 'user') {
                    lastUserTranscript = msg.data.transcript;
                    userSpeechEndTime = Date.now();
                    turnStartTime = userSpeechEndTime;

                    // Extract user speaking duration from OpenAI usage data
                    if (msg.data.usage?.seconds) {
                      turnUserDurationMs = msg.data.usage.seconds * 1000;
                      userSpeakingTotalMs += turnUserDurationMs;
                    }

                    const bus = getRuntimeEventBus();
                    if (bus && tenantId) {
                      log.debug('[S2S:OpenAI] Emitting message.user pipeline event', {
                        sessionId: runtimeSession.id,
                        messageIndex: openaiMessageIndex,
                      });
                      emitVoiceMessage(bus, 'user', {
                        tenantId,
                        projectId,
                        sessionId: runtimeSession.id,
                        agentName: agentName || 'unknown',
                        content: msg.data.transcript,
                        messageIndex: openaiMessageIndex,
                        piiContext: runtimeSession,
                      });
                    }
                  } else if (role === 'assistant') {
                    lastAssistantTranscript = msg.data.transcript;
                    // TEMPORARY DEBUG: Log what Grok is saying
                    log.info('[S2S:DEBUG] Grok speaking', {
                      text: msg.data.transcript,
                      length: msg.data.transcript?.length || 0,
                    });
                    assistantSpeechStartTime = Date.now();

                    const bus = getRuntimeEventBus();
                    if (bus && tenantId) {
                      log.debug('[S2S:OpenAI] Emitting message.agent pipeline event', {
                        sessionId: runtimeSession.id,
                        messageIndex: openaiMessageIndex,
                      });
                      emitVoiceMessage(bus, 'assistant', {
                        tenantId,
                        projectId,
                        sessionId: runtimeSession.id,
                        agentName: agentName || 'unknown',
                        content: msg.data.transcript,
                        messageIndex: openaiMessageIndex,
                        piiContext: runtimeSession,
                      });
                    }

                    // Calculate E2E latency (user speech end → assistant speech start)
                    if (userSpeechEndTime > 0) {
                      const e2eLatency = assistantSpeechStartTime - userSpeechEndTime;
                      e2eTotalMs += e2eLatency;
                      e2eCount++;
                    }

                    // Estimate assistant speaking time from transcript length
                    // (rough estimate: ~150 words per minute = 2.5 words/sec = 400ms/word)
                    const wordCount = msg.data.transcript.split(/\s+/).length;
                    turnAssistantDurationMs = wordCount * 400;
                    agentSpeakingTotalMs += turnAssistantDurationMs;

                    // Emit voice_turn when we have both user and assistant transcripts
                    if (lastUserTranscript) {
                      turnCount++;
                      const turnDuration = Date.now() - turnStartTime;
                      const e2eLatency = assistantSpeechStartTime - userSpeechEndTime;

                      // Update call phase after first turn
                      if (turnCount === 1 && callPhase === 'greeting') {
                        callPhase = 'conversation';
                      }

                      const voiceTurnEvent = {
                        id: randomUUID(),
                        sessionId: runtimeSession.id,
                        type: 'voice_turn' as const,
                        timestamp: new Date(),
                        data: {
                          turn: turnCount,
                          userInput: lastUserTranscript,
                          assistantResponse: lastAssistantTranscript,
                          durationMs: turnDuration,
                          channel: 'voice',
                          s2sProvider,
                          tenantId,
                          // Metric 203: E2E latency for this turn
                          e2eLatencyMs: e2eLatency > 0 ? e2eLatency : null,
                          // Metric 205: Speaking times for this turn
                          userSpeakingMs: turnUserDurationMs,
                          agentSpeakingMs: turnAssistantDurationMs,
                        },
                        agentName: agentName || 'unknown',
                      };

                      // 1. In-memory TraceStore
                      const scrubbedVoiceTurnEvent = addScrubbedVoiceTraceEvent(
                        runtimeSession.id,
                        withRealtimeAgentParent(voiceTurnEvent),
                        runtimeSession,
                      );

                      // 2. Emit to EventStore → platform_events table
                      if (tenantId) {
                        Promise.all([
                          import('../../eventstore-singleton.js'),
                          import('@abl/eventstore/migration'),
                        ])
                          .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                            const eventStore = getEventStore();
                            if (!eventStore) return;
                            emitTraceEventAsAnalytics(
                              eventStore.emitter,
                              {
                                type: 'voice_turn',
                                sessionId: runtimeSession.id,
                                tenantId: tenantId,
                                projectId: projectId,
                                agentName: agentName || 'unknown',
                                timestamp: scrubbedVoiceTurnEvent.timestamp,
                                durationMs: turnDuration,
                                data: scrubbedVoiceTurnEvent.data,
                              },
                              {
                                typeMap: VOICE_EVENT_TYPE_MAP,
                              },
                            );
                          })
                          .catch((err) => {
                            log.warn('[S2S] EventStore voice_turn emission failed', {
                              err: err instanceof Error ? err.message : String(err),
                            });
                          });
                      }

                      // Increment traceEventCount for voice_turn
                      const { persistTurnMetrics } =
                        await import('../../message-persistence-queue.js');
                      persistTurnMetrics({
                        dbSessionId,
                        tenantId,
                        tokensIn: 0,
                        tokensOut: 0,
                        cost: 0,
                        traceEventCount: 1,
                        errorCount: 0,
                        handoffCount: 0,
                      });

                      lastUserTranscript = undefined;
                      lastAssistantTranscript = undefined;
                    }
                  }
                } catch (err) {
                  log.warn('[S2S] Failed to persist transcript', {
                    err: err instanceof Error ? err.message : String(err),
                  });
                }
              }

              if (s2sProvider === 's2s:grok' && grokResponseId) {
                if (eventType === 'response.output_audio_transcript.done') {
                  latestGrokTranscriptDoneResponseId = grokResponseId;
                } else if (eventType === 'response.done') {
                  latestGrokResponseDoneResponseId = grokResponseId;
                }
              }

              // Grok handoff orchestration: let the current response finish, then update the
              // live session in place once the matching response ends.
              if (
                s2sProvider === 's2s:grok' &&
                nextAgent &&
                eventType === 'response.output_audio_transcript.done'
              ) {
                if (grokResponseId) {
                  pendingGrokHandoffResponseId = pendingGrokHandoffResponseId ?? grokResponseId;
                }
                readyToTransition = true;
                if (grokResponseId && latestGrokResponseDoneResponseId === grokResponseId) {
                  sendGrokInlineHandoffUpdate({
                    ackMsgId: msg.msgid,
                    responseId: grokResponseId,
                    reason:
                      '[S2S:Grok] Transcript arrived after response.done, sending inline handoff update',
                  });
                  return;
                }

                log.info(
                  '[S2S:Grok] Transcript done, will update session on matching response.done',
                  {
                    nextAgent,
                    responseId: grokResponseId,
                  },
                );
                ws.send(JSON.stringify({ type: 'ack', msgid: msg.msgid }));
                return;
              }

              // Once the matching transfer response fully completes, switch the live Grok
              // session to the target agent instead of restarting the llm task.
              if (s2sProvider === 's2s:grok' && nextAgent && eventType === 'response.done') {
                const handoffResponseId =
                  pendingGrokHandoffResponseId ?? latestGrokTranscriptDoneResponseId;
                const shouldTransition =
                  !!grokResponseId &&
                  !!handoffResponseId &&
                  handoffResponseId === grokResponseId &&
                  (readyToTransition || latestGrokTranscriptDoneResponseId === grokResponseId);

                if (shouldTransition) {
                  sendGrokInlineHandoffUpdate({
                    ackMsgId: msg.msgid,
                    responseId: grokResponseId,
                    reason: '[S2S:Grok] Matching response completed, sending inline handoff update',
                  });
                  return;
                }
              }

              ws.send(JSON.stringify({ type: 'ack', msgid: msg.msgid }));
              return;
            }

            // Handle tool calls (Google uses functionCalls, OpenAI uses call_id/arguments)
            if (msg.type === 'llm:tool-call' && msg.data) {
              const toolCallData = msg.data;

              // Google format: {type: 'toolCall', functionCalls: [{id, name, args}]}
              // OpenAI format: {name, call_id, arguments}
              const googleToolCalls = isGoogleProvider
                ? extractGoogleToolCalls(toolCallData)
                : null;

              const toolCalls = googleToolCalls
                ? googleToolCalls.functionCalls.map((fc) => {
                    let parsedArgs = fc.args;
                    if (typeof parsedArgs === 'string') {
                      try {
                        parsedArgs = JSON.parse(parsedArgs);
                      } catch {
                        parsedArgs = {};
                      }
                    }
                    return {
                      name: fc.name,
                      callId: fc.id,
                      args: parsedArgs,
                    };
                  })
                : [
                    {
                      name: toolCallData.name || toolCallData.function_name,
                      // Grok uses tool_call_id, OpenAI uses call_id
                      callId: toolCallData.tool_call_id || toolCallData.call_id,
                      args: (() => {
                        // Grok sends args as object, OpenAI sends arguments as string
                        let a =
                          toolCallData.args ||
                          toolCallData.arguments ||
                          toolCallData.parameters ||
                          {};
                        if (typeof a === 'string') {
                          try {
                            a = JSON.parse(a);
                          } catch {
                            a = {};
                          }
                        }
                        return a;
                      })(),
                    },
                  ];

              for (const tc of toolCalls) {
                const effectiveArgs =
                  !isGoogleProvider &&
                  tc.callId &&
                  Object.keys(tc.args || {}).length === 0 &&
                  openAIToolArguments.has(tc.callId)
                    ? (openAIToolArguments.get(tc.callId) ?? {})
                    : tc.args;

                log.info('[S2S] Tool call received', {
                  toolName: tc.name,
                  callId: tc.callId,
                  provider: traceProviderName,
                  argKeys: Object.keys(effectiveArgs || {}),
                });
                if (s2sProvider === 's2s:grok') {
                  latestGrokTranscriptDoneResponseId = null;
                  latestGrokResponseDoneResponseId = null;
                }

                // Handle get_greeting tool for Google — return the startup greeting plus the
                // initialized runtime instructions so Gemini can speak from primed session state
                // without requiring a mid-session config update.
                if (isGoogleProvider && tc.name === 'get_greeting' && effectiveExtractedGreeting) {
                  const primed = await ensureRealtimeSessionPrimed();
                  const greetingPayload: Record<string, unknown> = {};
                  const greetingText = primed.greeting || effectiveExtractedGreeting;

                  if (!googleGreetingServed) {
                    greetingPayload.text = greetingText;
                    queueGoogleAssistantSpeech(greetingText, 'greeting');
                    googleGreetingServed = true;
                  }

                  const trimmedInstructions = primed.instructions.trim();
                  if (trimmedInstructions.length > 0) {
                    greetingPayload.runtime_instructions = trimmedInstructions;
                  }

                  log.info(
                    '[S2S:Google] get_greeting tool called, returning primed startup context',
                    {
                      greetingServed: googleGreetingServed,
                      includesGreetingText: typeof greetingPayload.text === 'string',
                      hasRuntimeInstructions: !!greetingPayload.runtime_instructions,
                      promptLength: trimmedInstructions.length,
                    },
                  );
                  const greetingResponse = buildGoogleToolResponse(tc.callId, {
                    ...greetingPayload,
                  });
                  ws.send(
                    JSON.stringify(buildKorevgToolOutputCommand(tc.callId, greetingResponse)),
                  );
                  continue;
                }

                // ACK immediately before tool execution (matches working example pattern)
                ws.send(JSON.stringify({ type: 'ack', msgid: msg.msgid }));

                const toolCallStartedAt = Date.now();

                try {
                  const activeAgentBeforeTool = runtimeSession.agentName;
                  startRealtimeVoiceAgentRun(turnCount + 1, 'realtime_tool_call');

                  // Google self-handoff workaround: Google can't update tools mid-session,
                  // so it keeps calling handoff_to_X when already on X. Instead of returning
                  // "Cannot hand off to yourself", process the message through the current agent's flow.
                  const isSelfHandoff =
                    isGoogleProvider &&
                    tc.name.startsWith('handoff_to_') &&
                    tc.name.replace('handoff_to_', '') === runtimeSession.agentName;

                  let toolExecution;
                  if (isSelfHandoff) {
                    const userMessage =
                      (effectiveArgs?.message as string) || (effectiveArgs?.reason as string) || '';
                    log.info('[S2S:Google] Self-handoff detected, processing as user message', {
                      toolName: tc.name,
                      currentAgent: runtimeSession.agentName,
                      userMessage: userMessage.substring(0, 100),
                    });

                    const semanticTurn = await executeLiveVoiceSemanticTurn({
                      channelType: 'korevg',
                      runtimeExecutor: executor,
                      runtimeSession,
                      utterance: userMessage,
                      timeoutMs: WS_MESSAGE_TIMEOUT_MS,
                      promptProfile: 'realtime',
                      tenantId,
                      projectId,
                      channelMetadata: {
                        channel: 'voice',
                        contentLength: userMessage.length,
                      },
                      onTraceEvent: (event) => {
                        addScrubbedVoiceTraceEvent(
                          runtimeSession.id,
                          withRealtimeAgentParent({
                            id: randomUUID(),
                            sessionId: runtimeSession.id,
                            type: event.type,
                            timestamp: new Date(),
                            data: event.data,
                            agentName: runtimeSession.agentName || agentName || 'unknown',
                          }),
                          runtimeSession,
                          {
                            persistToEventStore: true,
                            incrementTraceEventCount: true,
                            dbSessionId,
                            tenantId,
                            projectId,
                          },
                        );
                      },
                    });

                    toolExecution = {
                      rawResult: semanticTurn.serializedResult,
                      serializedResult: semanticTurn.serializedResult,
                      activeAgentName: semanticTurn.activeAgentName,
                      activeAgentIR: semanticTurn.activeAgentIR,
                    };

                    log.info('[S2S:Google] Self-handoff flow result', {
                      agent: semanticTurn.activeAgentName,
                      responsePreview: semanticTurn.outcome.responseText.substring(0, 100),
                    });
                  } else {
                    toolExecution = await executeLiveVoiceToolCall({
                      runtimeExecutor: executor,
                      runtimeSession,
                      toolName: tc.name,
                      input: effectiveArgs,
                      tenantId,
                      projectId,
                      onTraceEvent: (event) => {
                        addScrubbedVoiceTraceEvent(
                          runtimeSession.id,
                          withRealtimeAgentParent({
                            id: randomUUID(),
                            sessionId: runtimeSession.id,
                            type: event.type,
                            timestamp: new Date(),
                            data: event.data,
                            agentName: runtimeSession.agentName || agentName || 'unknown',
                          }),
                          runtimeSession,
                          {
                            persistToEventStore: true,
                            incrementTraceEventCount: true,
                            dbSessionId,
                            tenantId,
                            projectId,
                          },
                        );
                      },
                    });
                  }
                  const toolResult = toolExecution.rawResult;
                  agentName = toolExecution.activeAgentName || agentName;
                  const toolCallDurationMs = Date.now() - toolCallStartedAt;
                  const sourceAgentForToolTrace = activeAgentBeforeTool || agentName || 'unknown';
                  const targetAgentForToolTrace =
                    toolExecution.activeAgentName &&
                    toolExecution.activeAgentName !== sourceAgentForToolTrace
                      ? toolExecution.activeAgentName
                      : undefined;

                  log.info('[S2S] Tool executed successfully', {
                    toolName: tc.name,
                    callId: tc.callId,
                  });

                  const toolTraceEvent = {
                    id: randomUUID(),
                    sessionId: runtimeSession.id,
                    type: 'voice_realtime_tool_call' as const,
                    timestamp: new Date(),
                    durationMs: toolCallDurationMs,
                    data: {
                      turn: turnCount + 1,
                      toolName: tc.name,
                      toolCallId: tc.callId,
                      arguments: effectiveArgs,
                      provider: s2sProvider,
                      durationMs: toolCallDurationMs,
                      channel: 'voice',
                      tenantId,
                      sourceAgent: sourceAgentForToolTrace,
                      ...(targetAgentForToolTrace ? { targetAgent: targetAgentForToolTrace } : {}),
                    },
                    agentName: sourceAgentForToolTrace,
                  };

                  const scrubbedToolTraceEvent = addScrubbedVoiceTraceEvent(
                    runtimeSession.id,
                    withRealtimeAgentParent(toolTraceEvent),
                    runtimeSession,
                  );
                  const canonicalToolCallEvent = withRealtimeAgentParent({
                    id: randomUUID(),
                    sessionId: runtimeSession.id,
                    type: 'tool_call' as const,
                    timestamp: new Date(),
                    durationMs: toolCallDurationMs,
                    spanId: `voice-tool-${tc.callId || randomUUID()}`,
                    data: {
                      toolName: tc.name,
                      toolCallId: tc.callId,
                      input: effectiveArgs,
                      output: toolResult,
                      result: toolResult,
                      status: 'success',
                      durationMs: toolCallDurationMs,
                      channel: 'voice',
                      provider: s2sProvider,
                      modality: 'realtime_voice',
                      realtime: true,
                      sourceAgent: sourceAgentForToolTrace,
                      ...(targetAgentForToolTrace ? { targetAgent: targetAgentForToolTrace } : {}),
                      voiceTraceEventId: scrubbedToolTraceEvent.id,
                      turn: turnCount + 1,
                    },
                    agentName: sourceAgentForToolTrace,
                  });
                  addScrubbedVoiceTraceEvent(
                    runtimeSession.id,
                    canonicalToolCallEvent,
                    runtimeSession,
                    {
                      persistToEventStore: true,
                      incrementTraceEventCount: true,
                      dbSessionId,
                      tenantId,
                      projectId,
                      knownSource: 'production',
                    },
                  );

                  if (tenantId) {
                    Promise.all([
                      import('../../eventstore-singleton.js'),
                      import('@abl/eventstore/migration'),
                    ])
                      .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                        const eventStore = getEventStore();
                        if (!eventStore) return;
                        emitTraceEventAsAnalytics(
                          eventStore.emitter,
                          {
                            type: 'voice_realtime_tool_call',
                            sessionId: runtimeSession.id,
                            tenantId,
                            projectId,
                            agentName: scrubbedToolTraceEvent.agentName,
                            timestamp: scrubbedToolTraceEvent.timestamp,
                            durationMs: toolCallDurationMs,
                            spanId: scrubbedToolTraceEvent.spanId,
                            parentSpanId: scrubbedToolTraceEvent.parentSpanId,
                            data: scrubbedToolTraceEvent.data,
                          },
                          {
                            typeMap: VOICE_EVENT_TYPE_MAP,
                          },
                        );
                      })
                      .catch((err) => {
                        log.warn('[S2S] EventStore voice_realtime_tool_call emission failed', {
                          err: err instanceof Error ? err.message : String(err),
                        });
                      });
                  }

                  const activeAgentChanged =
                    !!toolExecution.activeAgentName &&
                    toolExecution.activeAgentName !== activeAgentBeforeTool;
                  if (activeAgentChanged) {
                    finishRealtimeVoiceAgentRun('handoff', toolExecution.activeAgentName);
                    startRealtimeVoiceAgentRun(turnCount + 1, 'handoff');
                  }
                  const supportsInlineOpenAISessionUpdates = providerFamily === 'openai';
                  const isHandoff =
                    activeAgentChanged && (supportsInlineOpenAISessionUpdates || isGrokProvider);
                  const isGoogleInlineHandoff = isGoogleProvider && activeAgentChanged;
                  if (activeAgentChanged) {
                    applyKorevgVoiceSessionAliases(runtimeSession, getLatestCalled());
                  }
                  const shouldMuteInternalHandoffSpeech =
                    activeAgentChanged &&
                    !shouldSpeakInternalHandoffAnnouncement(internalHandoffSpeechPolicy);
                  const outboundToolPayload = shouldMuteInternalHandoffSpeech
                    ? buildSilentInternalHandoffToolPayload()
                    : extractActionToolSpeechPayload(tc.name, toolResult);
                  const actionToolSpeech =
                    !shouldMuteInternalHandoffSpeech &&
                    typeof outboundToolPayload === 'string' &&
                    outboundToolPayload.trim()
                      ? outboundToolPayload.trim()
                      : null;
                  let completedGrokHandoffResponseId: string | null = null;

                  if (isHandoff) {
                    // Let the current response finish, then update the active Grok session in place.
                    // This keeps the same LLM task and conversation context.
                    if (s2sProvider === 's2s:grok') {
                      nextAgent = toolExecution.activeAgentName;
                      nextAgentHandoffSpeechPolicy = actionToolSpeech
                        ? 'silent'
                        : internalHandoffSpeechPolicy;
                      grokHandoffTransitionRequested = false;
                      readyToTransition = false;
                      pendingGrokHandoffResponseId = null;
                      const handoffUserText =
                        typeof effectiveArgs?.message === 'string' && effectiveArgs.message.trim()
                          ? effectiveArgs.message.trim()
                          : typeof effectiveArgs?.reason === 'string' && effectiveArgs.reason.trim()
                            ? effectiveArgs.reason.trim()
                            : typeof lastUserTranscript === 'string' && lastUserTranscript.trim()
                              ? lastUserTranscript.trim()
                              : null;
                      nextAgentHandoffContext = handoffUserText
                        ? buildGrokHandoffContextSummary(handoffUserText)
                        : null;
                      log.info(
                        '[S2S:Grok] Handoff scheduled, will update the live session after response completes',
                        {
                          fromAgent: activeAgentBeforeTool,
                          toAgent: nextAgent,
                          hasHandoffContext: !!nextAgentHandoffContext,
                          latestTranscriptResponseId: latestGrokTranscriptDoneResponseId,
                          latestResponseDoneId: latestGrokResponseDoneResponseId,
                        },
                      );
                      if (
                        latestGrokResponseDoneResponseId &&
                        latestGrokTranscriptDoneResponseId === latestGrokResponseDoneResponseId
                      ) {
                        completedGrokHandoffResponseId = latestGrokResponseDoneResponseId;
                        if (actionToolSpeech) {
                          nextAgentHandoffSpeechPolicy = internalHandoffSpeechPolicy;
                        }
                      }
                    } else {
                      // OpenAI-compatible providers: inline session.update works
                      const openAIHandoffPlan = buildKorevgOpenAIHandoffCommands({
                        sessionId: runtimeSession.id,
                        runtimeSession,
                        entryAgentIR: voiceEntryAgent.agentIR,
                        s2sProvider,
                        voice: resolvedS2SConfig.voice as string | undefined,
                      });
                      log.info('[S2S] Agent changed, sending session.update', {
                        fromAgent: activeAgentBeforeTool,
                        toAgent: toolExecution.activeAgentName,
                        provider: s2sProvider,
                        promptLength: openAIHandoffPlan.instructions.length,
                        toolCount: openAIHandoffPlan.tools.length,
                      });
                      for (const command of openAIHandoffPlan.commands) {
                        ws.send(JSON.stringify(command));
                      }
                    }
                  } else if (activeAgentChanged && !isGoogleInlineHandoff) {
                    log.warn(
                      '[S2S] Agent changed but provider does not support inline prompt swap',
                      {
                        fromAgent: activeAgentBeforeTool,
                        toAgent: toolExecution.activeAgentName,
                        provider: s2sProvider,
                      },
                    );
                  }

                  // Send result in provider-specific format

                  // TEMPORARY DEBUG: Log action tool speech extraction
                  if (isActionTool(tc.name)) {
                    log.info('[S2S:DEBUG] Action tool speech extraction', {
                      toolName: tc.name,
                      hasActionToolSpeech: !!actionToolSpeech,
                      actionToolSpeechPreview: actionToolSpeech?.substring(0, 100),
                      outboundPayloadType: typeof outboundToolPayload,
                      toolResultType: typeof toolResult,
                      toolResultKeys:
                        toolResult && typeof toolResult === 'object' ? Object.keys(toolResult) : [],
                    });
                  }

                  const googleToolPayload =
                    isGoogleInlineHandoff && tc.callId
                      ? (() => {
                          const googleInlineHandoff = buildKorevgGoogleInlineHandoffPayload({
                            sessionId: runtimeSession.id,
                            runtimeSession,
                            entryAgentIR: voiceEntryAgent.agentIR,
                            s2sProvider,
                            activeAgentName: toolExecution.activeAgentName,
                          });
                          log.info(
                            '[S2S:Google] Agent changed, returning inline runtime instructions in tool output',
                            {
                              fromAgent: activeAgentBeforeTool,
                              toAgent: toolExecution.activeAgentName,
                              promptLength: googleInlineHandoff.instructions.trim().length,
                            },
                          );

                          return googleInlineHandoff.payload;
                        })()
                      : outboundToolPayload;

                  if (isGoogleProvider) {
                    const googleSpeechCandidate =
                      typeof googleToolPayload === 'object' &&
                      googleToolPayload !== null &&
                      'text' in googleToolPayload &&
                      typeof (googleToolPayload as { text?: unknown }).text === 'string'
                        ? ((googleToolPayload as { text?: string }).text ?? null)
                        : isActionTool(tc.name)
                          ? actionToolSpeech
                          : null;

                    queueGoogleAssistantSpeech(googleSpeechCandidate, 'tool');
                  }

                  // Send tool results for all providers
                  // - Grok: event-driven handoff, LLM speaks tool result, then we orchestrate transition
                  // - OpenAI/Google: tool result completes the function call cycle, triggers response
                  const shouldSendToolResult = !!tc.callId;

                  if (shouldSendToolResult) {
                    const shouldSuppressOpenAIHandoffFollowup =
                      providerKind === 'openai' && isHandoffTool(tc.name);
                    const toolDispatchPlan =
                      providerFamily === 'elevenlabs' ||
                      providerFamily === 'ultravox' ||
                      providerFamily === 'voiceagent'
                        ? {
                            toolOutputCommand: buildKorevgToolOutputCommand(
                              tc.callId,
                              buildProviderToolResponseMessage({
                                provider: s2sProvider,
                                callId: tc.callId,
                                toolName: tc.name,
                                result: outboundToolPayload,
                              }),
                            ),
                            followupCommands: [] as Record<string, unknown>[],
                            deferImplicitFollowup: false,
                          }
                        : buildKorevgRealtimeToolDispatchPlan({
                            providerKind,
                            toolCallId: tc.callId,
                            payload: googleToolPayload,
                            deferImplicitFollowup:
                              isGrokProvider && shouldMuteInternalHandoffSpeech,
                            actionToolSpeech:
                              isActionTool(tc.name) &&
                              !shouldSuppressOpenAIHandoffFollowup &&
                              !completedGrokHandoffResponseId
                                ? actionToolSpeech
                                : null,
                            voice: resolvedS2SConfig.voice as string | undefined,
                          });
                    log.info('[S2S] Sending tool result via llm:tool-output', {
                      toolName: tc.name,
                      callId: tc.callId,
                      provider: s2sProvider,
                    });
                    // TEMPORARY DEBUG: Log tool result payload
                    log.info('[S2S:DEBUG] Tool result payload', {
                      toolName: tc.name,
                      payload: JSON.stringify(toolDispatchPlan.toolOutputCommand).substring(0, 500),
                    });
                    ws.send(JSON.stringify(toolDispatchPlan.toolOutputCommand));
                    if (completedGrokHandoffResponseId) {
                      sendGrokInlineHandoffUpdate({
                        responseId: completedGrokHandoffResponseId,
                        reason:
                          '[S2S:Grok] Handoff response already completed during tool execution, sending inline handoff update',
                      });
                    }

                    // Once tool output is deferred, send an explicit response.create so the
                    // provider speaks with the configured voice instead of relying on an
                    // implicit provider-generated follow-up.
                    if (isActionTool(tc.name)) {
                      log.info('[S2S:DEBUG] Response.create decision', {
                        toolName: tc.name,
                        isGoogleProvider,
                        s2sProvider,
                        isGrok: s2sProvider === 's2s:grok',
                        isActionTool: isActionTool(tc.name),
                        hasActionToolSpeech: !!actionToolSpeech,
                        willSendResponseCreate: toolDispatchPlan.deferImplicitFollowup,
                      });
                    }

                    // Skip response.create when escalation just succeeded — we are about to
                    // send response.cancel + tts:clear to silence the AI for the transfer gap.
                    // Sending response.create first would cause a race where OpenAI audio
                    // frames arrive at Jambonz before our tts:clear, leaking into the bridged call.
                    if (
                      toolDispatchPlan.deferImplicitFollowup &&
                      actionToolSpeech &&
                      toolDispatchPlan.followupCommands.length > 0 &&
                      !runtimeSession.isEscalated
                    ) {
                      log.info('[S2S] Sending response.create for action tool speech', {
                        toolName: tc.name,
                        provider: s2sProvider,
                        speechPreview: actionToolSpeech.substring(0, 100),
                      });
                      for (const command of toolDispatchPlan.followupCommands) {
                        ws.send(JSON.stringify(command));
                      }
                    }
                  }
                } catch (err) {
                  const errorMessage = err instanceof Error ? err.message : String(err);
                  log.error('[S2S] Tool execution failed', {
                    toolName: tc.name,
                    callId: tc.callId,
                    error: errorMessage,
                  });

                  if (tc.callId) {
                    // For ALL providers, use llm:tool-output command for error results
                    ws.send(
                      JSON.stringify(
                        providerFamily === 'elevenlabs' ||
                          providerFamily === 'ultravox' ||
                          providerFamily === 'voiceagent'
                          ? buildKorevgToolOutputCommand(
                              tc.callId,
                              buildProviderToolErrorMessage({
                                provider: s2sProvider,
                                callId: tc.callId,
                                toolName: tc.name,
                                errorMessage,
                              }),
                            )
                          : buildKorevgRealtimeToolErrorCommand({
                              providerKind,
                              toolCallId: tc.callId,
                              errorMessage,
                            }),
                      ),
                    );
                  }
                } finally {
                  if (!isGoogleProvider && tc.callId) {
                    openAIToolArguments.delete(tc.callId);
                  }
                }

                // After each tool call, check if escalation was triggered and update call phase.
                // The actual transfer is driven by message-bridge.ts → dialAgent() when
                // SmartAssist sends agent:connected. Here we only track the call phase and
                // immediately interrupt the AI to prevent it speaking during the transfer gap.
                if (runtimeSession.isEscalated && callPhase !== 'transfer') {
                  callPhase = 'transfer';
                  log.info(
                    '[S2S] Escalation detected — interrupting AI and updating call phase to transfer',
                    {
                      sessionId: runtimeSession.id,
                      toolName: tc.name,
                    },
                  );
                  const interruptCommands = buildKorevgRealtimeInterruptCommands(s2sProvider);
                  for (const command of interruptCommands) {
                    ws.send(JSON.stringify(command));
                  }
                  // Disable VAD turn detection so OpenAI stops auto-responding to caller
                  // speech during the transfer gap. Without this, Jambonz keeps forwarding
                  // caller audio to OpenAI whose VAD triggers new responses that go directly
                  // to the media plane — bypassing our llm:event guard entirely.
                  if (s2sProvider === 's2s:openai' || s2sProvider === 's2s:grok') {
                    ws.send(
                      JSON.stringify(
                        buildKorevgLlmUpdateCommand({
                          type: 'session.update',
                          session: { turn_detection: null },
                        }),
                      ),
                    );
                    log.info('[S2S] Disabled VAD turn detection for transfer gap', {
                      sessionId: runtimeSession.id,
                      provider: s2sProvider,
                    });
                  }
                }
              }
            } else if (msg.type === 'verb:hook') {
              log.info('[S2S] verb:hook received', {
                hook: msg.hook,
                nextAgent,
                dataSummary: summarizeHookPayload(msg.data),
              });

              // Forward DTMF gather result to the CSAT resolver if one is pending.
              if (msg.hook === CSAT_GATHER_HOOK) {
                const realtimeSession = getRealtimeVoiceSession(runtimeSession.id);
                if (realtimeSession?.csatGatherResolve) {
                  const digits = (msg.data?.digits as string | undefined) ?? null;
                  const resolve = realtimeSession.csatGatherResolve;
                  realtimeSession.csatGatherResolve = undefined;
                  log.info('[S2S] CSAT gather digits received', {
                    sessionId: runtimeSession.id,
                    hasDigits: !!digits,
                  });
                  resolve(digits);
                }
              }

              ws.send(JSON.stringify({ type: 'ack', msgid: msg.msgid }));
            } else if (msg.type === 'jambonz:error') {
              log.error('[S2S] Jambonz error', { error: msg.data });
            }
          } catch (err) {
            log.error('[S2S] Error handling message', {
              error: err instanceof Error ? err.message : String(err),
            });
          }
        };

        ws.on('message', handleS2SMessage);
        ws.off('message', earlyInfoExtractor);
        await replayBufferedBootstrapMessages({
          target: 'realtime',
          handler: handleS2SMessage,
          skipSessionNew: false,
        });

        // Send initial ack with answer + pause + llm all together
        sendInitialS2SAck();

        const realtimeInterruptionRegistrationId = registerRealtimeInterruptionTarget({
          sessionIds: [runtimeSession.id, callSid],
          tenantId,
          provider: s2sProvider,
          interrupt: () => {
            const commands = buildKorevgRealtimeInterruptCommands(s2sProvider);
            for (const command of commands) {
              ws.send(JSON.stringify(command));
            }
          },
        });

        // Register realtime voice session for agent transfer (Failure 1 + 2 fix).
        // The pipeline path uses KorevgSession which self-registers; the realtime
        // path has no KorevgSession, so we register a lightweight session stub that
        // (a) provides VoiceCallData for the SmartAssist escalation payload, and
        // (b) implements dialAgent() so agent:connected events can bridge the call.
        const actualCallSid = (sessionNewCallInfo?.callSid as string | undefined) || callSid;
        const realtimeVoiceSession = new RealtimeVoiceGatewaySession({
          sessionId: runtimeSession.id,
          tenantId,
          sttVendor: config.sttVendor,
          sttLanguage: config.sttLanguage,
          ws,
          callData: {
            callSid: actualCallSid,
            caller: (sessionNewCallInfo?.from as string | undefined) || caller || '',
            called: (sessionNewCallInfo?.to as string | undefined) || called || '',
            sipCallId: sessionNewCallInfo?.callId as string | undefined,
            sipFrom: sessionNewCallInfo?.from as string | undefined,
            sipTo: sessionNewCallInfo?.to as string | undefined,
            originatingSipIp: sessionNewCallInfo?.originatingSipIp as string | undefined,
            direction: sessionNewCallInfo?.direction as string | undefined,
            callerName: sessionNewCallInfo?.callerName as string | undefined,
          },
        });
        registerRealtimeVoiceSession(runtimeSession.id, actualCallSid, realtimeVoiceSession);

        // Store minimal session for cleanup
        this.sessions.set(sessionId, {
          close: () => {
            log.info('[S2S] Session ended');
            unregisterRealtimeVoiceSession(runtimeSession.id);
            unregisterRealtimeInterruptionTarget(realtimeInterruptionRegistrationId);
            // End the DB session if it exists
            // Use session repo directly to avoid tenant context issues in WebSocket close handler
            if (dbSessionId) {
              (async () => {
                try {
                  // Flush buffered messages before ending session
                  const { flushMessageQueue } = await import('../../message-persistence-queue.js');
                  await flushMessageQueue(dbSessionId);
                  log.info('[S2S] Message queue flushed');

                  // Fetch Homer quality data for network MOS (Metric 202)
                  // Use actual call IDs from session:new (same as pipeline mode)
                  const sipCallId = (sessionNewCallInfo?.callId as string) || callSid;
                  const rtpCallId = sessionNewCallInfo?.sbcCallId as string;

                  let homerData: any = null;
                  try {
                    // Wait briefly for Homer to ingest final SIP messages (same as pipeline mode)
                    await new Promise((resolve) => setTimeout(resolve, 5000));

                    const { getCallQuality } = await import('./homer-client.js');
                    homerData = await getCallQuality(sipCallId, rtpCallId);
                    log.info('[S2S] Homer quality fetch', {
                      sipCallId,
                      rtpCallId,
                      hasQos: homerData?.homerAvailable,
                    });
                  } catch (err) {
                    log.warn('[S2S] Failed to fetch Homer quality data', {
                      err: err instanceof Error ? err.message : String(err),
                    });
                  }

                  // Calculate silence metrics (Metric 205)
                  const sessionDuration = Date.now() - sessionStartTime;
                  const totalSpeakingMs = userSpeakingTotalMs + agentSpeakingTotalMs;
                  const silenceMs = Math.max(0, sessionDuration - totalSpeakingMs);
                  const silencePercent =
                    sessionDuration > 0 ? +((silenceMs / sessionDuration) * 100).toFixed(1) : 0;

                  // Determine containment (Metric 206)
                  // Use Homer disconnect attribution to determine outcome (similar to pipeline mode)
                  let sessionOutcome: 'completed' | 'abandoned' | 'escalated' = 'completed';
                  const disconnectInitiator = homerData?.disconnect?.initiator ?? 'unknown';

                  if (disconnectInitiator === 'caller') {
                    sessionOutcome = 'abandoned'; // User hung up before completion
                  } else if (disconnectInitiator === 'platform') {
                    sessionOutcome = 'completed'; // Platform-initiated disconnect = successful completion
                  } else {
                    // Unknown disconnect = treat as completed (benefit of doubt)
                    sessionOutcome = 'completed';
                  }

                  const isContained = sessionOutcome === 'completed';
                  finishRealtimeVoiceAgentRun(
                    sessionOutcome === 'completed' ? 'completed' : 'abandoned',
                  );

                  // Emit voice_session_end trace event (same metrics as pipeline mode)
                  const { getTraceStore } = await import('../../trace-store.js');
                  const sessionEndEvent = {
                    id: randomUUID(),
                    sessionId: runtimeSession.id,
                    type: 'voice_session_end' as const,
                    timestamp: new Date(),
                    data: {
                      callSid,
                      totalTurns: turnCount,
                      channel: 'voice',
                      s2sProvider,
                      disposition: sessionOutcome === 'completed' ? 'completed' : 'abandoned',
                      tenantId,

                      // Metric 203: E2E latency summary
                      avgE2eLatencyMs: e2eCount > 0 ? Math.round(e2eTotalMs / e2eCount) : null,
                      e2eMeasuredTurns: e2eCount,

                      // Metric 204: Barge-in summary
                      bargeInCount,
                      bargeInRate:
                        turnCount > 0 ? +((bargeInCount / turnCount) * 100).toFixed(1) : 0,

                      // Metric 205: Call activity breakdown
                      callDurationMs: sessionDuration,
                      agentSpeakingMs: agentSpeakingTotalMs,
                      userSpeakingMs: userSpeakingTotalMs,
                      silenceMs,
                      silencePercent,

                      // Metric 206: Containment tracking
                      sessionOutcome,
                      isContained,

                      // Metric 207: Call phase tracking and abandonment attribution
                      callPhase,
                      currentAgent: agentName || null,
                      abandonedDuringGreeting:
                        sessionOutcome === 'abandoned' && callPhase === 'greeting',
                      abandonedDuringConversation:
                        sessionOutcome === 'abandoned' && callPhase === 'conversation',
                      abandonedDuringTransfer:
                        sessionOutcome === 'abandoned' && callPhase === 'transfer',

                      // Homer quality data (Metric 202 network component)
                      homerAvailable: homerData?.homerAvailable ?? false,
                      homerError: homerData?.homerError,
                      inboundNetworkMos: homerData?.mos?.inbound ?? null,
                      outboundNetworkMos: homerData?.mos?.outbound ?? null,
                      inboundRFactor: homerData?.mos?.inboundRFactor ?? null,
                      outboundRFactor: homerData?.mos?.outboundRFactor ?? null,
                      inboundJitterMs: homerData?.qos?.inbound?.jitterMs ?? null,
                      inboundPacketLossRate: homerData?.qos?.inbound?.packetLossRate ?? null,
                      outboundJitterMs: homerData?.qos?.outbound?.jitterMs ?? null,
                      outboundPacketLossRate: homerData?.qos?.outbound?.packetLossRate ?? null,
                      rtcpReportCount:
                        (homerData?.qos?.inbound?.reportCount ?? 0) +
                        (homerData?.qos?.outbound?.reportCount ?? 0),

                      // SIP disconnect attribution (Metric 207)
                      sipDisconnectInitiator: homerData?.disconnect?.initiator ?? 'unknown',
                      sipStatusCode: homerData?.disconnect?.statusCode ?? null,
                      sipDisconnectMethod: homerData?.disconnect?.method ?? null,
                      sipDisconnectReason: homerData?.disconnect?.reason ?? null,

                      // Metric 202: TTS Quality (audio streaming metrics)
                      avgProxyMos:
                        ttsProxyMosCount > 0
                          ? +(ttsProxyMosTotal / ttsProxyMosCount).toFixed(2)
                          : null,
                      avgTtfbMs:
                        ttsTtfbCount > 0 ? Math.round(ttsTotalTtfbMs / ttsTtfbCount) : null,
                      avgCombinedTtsMos:
                        ttsProxyMosCount > 0
                          ? +(() => {
                              const proxyMos = ttsProxyMosTotal / ttsProxyMosCount;
                              const networkMos = homerData?.mos?.outbound ?? null;
                              // Combined MOS: 60% proxy (app quality) + 40% network (delivery)
                              return networkMos !== null
                                ? 0.6 * proxyMos + 0.4 * networkMos
                                : proxyMos;
                            })().toFixed(2)
                          : null,
                      ttsQualityTurns: ttsProxyMosCount,

                      // S2S limitations (metrics not available from OpenAI Realtime API)
                      dtmfTurnCount: 0, // Metric 209: S2S is voice-only, no DTMF
                      dtmfFallbackRate: 0,
                      overallAsrScore: null, // Metric 201: No ASR confidence data from OpenAI
                      cascadeRiskTurns: 0, // Metric 210: No cascade detection without ASR confidence
                    },
                    agentName: agentName || 'unknown',
                  };

                  // 1. In-memory TraceStore
                  getTraceStore().addEvent(runtimeSession.id, sessionEndEvent);

                  // 2. Emit to EventStore → platform_events table (critical for voice analytics)
                  if (tenantId) {
                    Promise.all([
                      import('../../eventstore-singleton.js'),
                      import('@abl/eventstore/migration'),
                    ])
                      .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
                        const eventStore = getEventStore();
                        if (!eventStore) return;
                        emitTraceEventAsAnalytics(
                          eventStore.emitter,
                          {
                            type: 'voice_session_end',
                            sessionId: runtimeSession.id,
                            tenantId: tenantId,
                            projectId: projectId,
                            agentName: agentName || 'unknown',
                            timestamp: sessionEndEvent.timestamp,
                            durationMs: sessionDuration,
                            data: sessionEndEvent.data,
                          },
                          {
                            typeMap: VOICE_EVENT_TYPE_MAP,
                          },
                        );
                      })
                      .catch((err) => {
                        log.warn('[S2S] EventStore voice_session_end emission failed', {
                          err: err instanceof Error ? err.message : String(err),
                        });
                      });
                  }

                  // Log session metrics summary
                  log.info('[S2S] Session ended with metrics', {
                    callSid,
                    sessionOutcome,
                    isContained,
                    totalTurns: turnCount,
                    avgE2eLatencyMs: e2eCount > 0 ? Math.round(e2eTotalMs / e2eCount) : null,
                    bargeInCount,
                    silencePercent,
                    callPhase,
                    disconnectInitiator,
                    homerAvailable: homerData?.homerAvailable ?? false,
                    inboundMos: homerData?.mos?.inbound ?? null,
                    outboundMos: homerData?.mos?.outbound ?? null,
                    avgProxyMos:
                      ttsProxyMosCount > 0
                        ? +(ttsProxyMosTotal / ttsProxyMosCount).toFixed(2)
                        : null,
                    avgTtfbMs: ttsTtfbCount > 0 ? Math.round(ttsTotalTtfbMs / ttsTtfbCount) : null,
                    ttsQualityTurns: ttsProxyMosCount,
                  });

                  // Increment traceEventCount for voice_session_end
                  const { persistTurnMetrics } = await import('../../message-persistence-queue.js');
                  await persistTurnMetrics({
                    dbSessionId: dbSessionId!,
                    tenantId,
                    tokensIn: 0,
                    tokensOut: 0,
                    cost: 0,
                    traceEventCount: 1,
                    errorCount: 0,
                    handoffCount: 0,
                  });

                  // Flush metrics before ending session
                  await flushMessageQueue(dbSessionId);

                  // Update session status in DB
                  const { updateSession } = await import('../../../repos/session-repo.js');
                  const now = new Date();

                  await updateSession(
                    dbSessionId!,
                    {
                      status: 'ended',
                      disposition: sessionOutcome === 'completed' ? 'completed' : 'abandoned',
                      endedAt: now,
                      lastActivityAt: now,
                    },
                    tenantId,
                  );

                  log.info('[S2S] DB session ended successfully');

                  // Emit session.ended to trigger analytics pipelines (mirrors text/chat path)
                  const bus = getRuntimeEventBus();
                  if (bus) {
                    emitVoiceSessionEnded(bus, {
                      tenantId,
                      projectId,
                      sessionId: runtimeSession.id,
                      agentName: agentName || 'unknown',
                      sessionOutcome,
                      durationMs: sessionDuration,
                      turnCount,
                    });
                  }
                } catch (err) {
                  log.warn('[S2S] Failed to end DB session', {
                    err: err instanceof Error ? err.message : String(err),
                  });
                }
              })();
            }
          },
        } as any);

        log.info(`[CONNECTION] S2S session ready with llm verb`);
      } else {
        // Pipeline Voice Mode (STT + LLM + TTS)
        log.info(`[CONNECTION] Creating KorevgSession with sessionId=${runtimeSession.id}`);
        const session = new KorevgSession(ws, config, executor);
        this.sessions.set(sessionId, session);
        log.info(`[CONNECTION] KorevgSession created and ready for messages`);
        ws.off('message', earlyInfoExtractor);

        // Send initial ack for session:new if we have the msgid
        if (sessionNewMsgId) {
          ws.send(
            JSON.stringify({
              type: 'ack',
              msgid: sessionNewMsgId,
              data: [{ verb: 'answer' }],
            }),
          );
          // Send greeting after answer
          session.sendGreeting().catch((err: unknown) => {
            log.error(`[GREETING] Failed to send greeting: ${err}`);
          });
        }

        await replayBufferedBootstrapMessages({
          target: 'pipeline',
          handler: (data) => session.replayBufferedMessage(data),
          skipSessionNew: !!sessionNewMsgId,
        });
      }

      // Clean up on close
      ws.on('close', (code: number, reason: Buffer) => {
        clearSessionNewTimeout();
        log.info(`Session closed: ${sessionId}, code=${code}, reason=${reason.toString()}`);
        const session = this.sessions.get(sessionId);
        if (session) {
          if ('close' in session && typeof session.close === 'function') {
            session.close();
          }
          this.sessions.delete(sessionId);
        }
      });
    } catch (err) {
      if (rejectInvalidSessionMetadata(err, 'bootstrap')) {
        clearSessionNewTimeout();
        ws.off('message', earlyInfoExtractor);
        return;
      }
      clearSessionNewTimeout();
      ws.off('message', earlyInfoExtractor);
      log.error(`Error setting up WebSocket connection for ${safeUrl}: ${err}`);
      ws.close(1011, 'Internal server error');
    }
  }

  /**
   * Get active session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Close all sessions and shut down
   */
  async shutdown() {
    log.info(`Shutting down Korevg router (${this.sessions.size} active sessions)`);

    for (const [sessionId] of this.sessions) {
      try {
        // WebSocket will be closed by the session handler
        log.debug(`Closing session: ${sessionId}`);
      } catch (err) {
        log.error(`Error closing session ${sessionId}: ${err}`);
      }
    }

    this.sessions.clear();

    return new Promise<void>((resolve) => {
      this.wss.close(() => {
        log.info('Korevg WebSocket server closed');
        resolve();
      });
    });
  }
}
