/**
 * Korevg Session Handler
 *
 * Manages individual call sessions for Korevg/Jambonz integration.
 * Uses RuntimeExecutor to process transcribed speech and returns Jambonz verbs.
 *
 * Tracing: Each voice turn is instrumented with OTEL spans (STT → LLM → TTS)
 * and trace events are forwarded to TraceStore + ClickHouse via the centralized
 * onTraceEvent callback in RuntimeExecutor.createCentralizedTraceHandler().
 * Message and turn metrics are persisted to the DB for conversation history.
 */

import { WebSocket } from 'ws';
import { createLogger } from '@abl/compiler/platform';
import { getRuntimeExecutor } from '../../runtime-executor.js';
import { buildProductionSessionLocator } from '../../session/execution-scope.js';
import { KorevgVerbBuilder, type TtsVerbOptions, type VerbResponse } from './verb-builder.js';
import { MAX_KOREVG_QUEUE_SIZE, WS_MESSAGE_TIMEOUT_MS } from '../../channel/constants.js';
import {
  buildErrorOutcome,
  buildOutcomeTraceEvent,
  type ChannelOutcome,
} from '../../channel/outcome.js';
import type { ResponseMessageMetadata } from '../../channel/response-provenance.js';
import { getChannelAdapterRegistry } from '../../channel/channel-adapter.js';
import { recordSyntheticTraceEvent } from '../../channel-trace-utils.js';
import { resolveConversationBehaviorVoiceRuntimeConfig } from '../../execution/conversation-behavior-resolver.js';
import {
  startVoiceTurn,
  completeSTTPhase,
  startLLMPhase,
  completeLLMPhase,
  startTTSPhase,
  recordTTSFirstChunk,
  completeTTSPhase,
  completeVoiceTurn,
  failVoiceTurn,
} from '../../../observability/voice-trace.js';
import {
  createTraceAccumulator,
  accumulateTraceEvent,
} from '../../../channels/pipeline/message-pipeline.js';
import { persistMessage, persistTurnMetrics } from '../../message-persistence-queue.js';
import { buildPersistedMessageStructuredContent } from '../../session/persisted-message-content.js';
import { getTraceStore } from '../../trace-store.js';
import { addScrubbedVoiceTraceEvent } from './voice-trace-scrubbing.js';
import { randomUUID } from 'crypto';
import { getRuntimeEventBus } from '../../event-bus/runtime-bus-accessor.js';
import { emitVoiceSessionEnded } from './voice-session-event.js';
import {
  linkResolvedContactToSession,
  resolveContactIdFromChannelIdentity,
} from '../../identity/channel-contact-linking.js';
import {
  VoiceQualityAnalyzer,
  type ASRTurnData,
} from '../../../observability/voice-quality-analyzer.js';
import {
  ASRCascadeDetector,
  type CascadeTurnData,
} from '../../../observability/asr-cascade-detector.js';
import type {
  OOBFlags,
  VoiceToolResult,
  VoiceToolGatherResult,
  VoiceToolTransferResult,
  VoiceToolDeflectResult,
  DialAgentOptions,
  PlayMessageOptions,
  GatherDTMFOptions,
  VoiceCallData,
} from '@agent-platform/agent-transfer';
import type { RuntimeSession } from '../../execution/types.js';
import type { CallerContext } from '@agent-platform/shared-auth';
import { ORPHEUS_DEFAULT_MODEL, ORPHEUS_DEFAULT_VOICE } from '../orpheus-tts.js';
import {
  coerceSessionMetadata,
  isSessionMetadataValidationError,
  mergeAndValidateSessionMetadata,
  updateSessionMetadata,
} from '../../session-metadata.js';
import { executeVoiceTurn } from '../voice-turn-coordinator.js';
import { normalizeSpeechLanguageCode } from '../voice-language.js';
import {
  resolveTtsLanguageForVoiceTurn,
  type TtsLanguageResolution,
} from '../tts-language-resolver.js';

const log = createLogger('korevg-session');
const TTS_RECONNECT_TIMEOUT_MS = 1500;
const FILLER_PLAYBACK_MIN_WAIT_MS = 1500;
const FILLER_PLAYBACK_WORD_MS = 360;
const FILLER_PLAYBACK_BUFFER_MS = 700;
const FILLER_PLAYBACK_MAX_WAIT_MS = 12000;

// Type mapping for voice events: trace format (underscores) → EventStore format (dots)
const VOICE_EVENT_TYPE_MAP: Record<string, string> = {
  voice_session_start: 'voice.session.started',
  voice_session_end: 'voice.session.ended',
  voice_turn: 'voice.turn.completed',
  voice_stt: 'voice.stt.completed',
  voice_tts: 'voice.tts.completed',
  voice_barge_in: 'voice.barge_in.detected',
  voice_asr_quality: 'voice.asr_quality.analyzed',
  voice_tts_quality: 'voice.tts_quality.measured',
  voice_asr_cascade: 'voice.asr_cascade.detected',
  voice_config_resolved: 'agent.voice.config_resolved',
};

type RuntimeExecutor = ReturnType<typeof getRuntimeExecutor>;

function recordOutcomeTrace(params: {
  sessionId: string;
  session?: Pick<RuntimeSession, 'tracer'> | undefined;
  outcome: ChannelOutcome;
  onTraceEvent?: (event: { type: string; data: Record<string, unknown> }) => void;
}): void {
  if (params.outcome.status === 'ok') {
    return;
  }

  const event = buildOutcomeTraceEvent(params.outcome);
  if (!event) {
    return;
  }

  params.onTraceEvent?.(event);
  recordSyntheticTraceEvent({
    sessionId: params.sessionId,
    session: params.session,
    event,
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// Call Phase Detection Patterns (Metric 207)
// ═══════════════════════════════════════════════════════════════════════════
// These patterns detect call phases based on agent names. The transfer phase
// is optional - if no matching agent is found, calls stay in 'conversation' phase.

const CALL_PHASE_PATTERNS = {
  transfer: [
    'live_agent_transfer',
    'escalate',
    'transfer',
    'handoff_to_human',
    'human_handoff',
    'agent_transfer',
  ],
  farewell: [
    'farewell',
    'goodbye',
    'bye',
    'end_conversation',
    'closing',
    'end_call',
    'goodbye_agent',
  ],
} as const;

/**
 * Detect call phase from agent name using pattern matching.
 * Returns 'transfer', 'farewell', or null (defaults to 'conversation')
 */
function detectPhaseFromAgent(agentName: string): 'transfer' | 'farewell' | null {
  const normalized = agentName.toLowerCase().replace(/[_-]/g, '');

  // Check transfer patterns
  for (const pattern of CALL_PHASE_PATTERNS.transfer) {
    const normalizedPattern = pattern.toLowerCase().replace(/[_-]/g, '');
    if (normalized.includes(normalizedPattern)) {
      return 'transfer';
    }
  }

  // Check farewell patterns
  for (const pattern of CALL_PHASE_PATTERNS.farewell) {
    const normalizedPattern = pattern.toLowerCase().replace(/[_-]/g, '');
    if (normalized.includes(normalizedPattern)) {
      return 'farewell';
    }
  }

  return null; // Default to 'conversation' phase
}

// ═══════════════════════════════════════════════════════════════════════════
// TTS Proxy MOS Scoring (Metric 202 - Dimension 1)
// ═══════════════════════════════════════════════════════════════════════════
// Computes a synthetic TTS quality score (1.0-4.5) from application-level signals
// that correlate with user-perceived quality. This complements network MOS from RTCP.

interface TtsProxyInputs {
  ttfbMs: number | undefined; // TTS TTFB = session_open_time + first_audio_chunk_latency (total user-perceived delay)
  connectionMs: number | undefined; // TTS provider connection/session open time
  chunkCount: number; // Number of TTS chunks delivered
  streaming: boolean; // Streaming vs non-streaming mode
  hasError: boolean; // TTS error occurred during this turn
  bargeInOnAgent: boolean; // User interrupted agent speech (quality signal)
}

/**
 * Compute TTS proxy MOS score (1.0–4.5) from application quality signals.
 *
 * Scoring factors:
 * 1. TTFB (Time To First Byte) - Lower is better
 *    < 300ms: Excellent (no perceptible delay)
 *    300-800ms: Good (slight delay, acceptable)
 *    > 800ms: Poor (audible gap, user frustration)
 *
 * 2. Connection latency - Provider connection issues
 *    < 200ms: Excellent
 *    200-500ms: Good
 *    > 500ms: Poor
 *
 * 3. Chunk consistency - Streaming delivery quality
 *    > 5 chunks: Good continuous streaming
 *    1-5 chunks: Acceptable
 *    0 chunks: Error or very short response
 *
 * 4. Error penalty - TTS failures degrade quality
 *
 * 5. Barge-in signal - Frequent interruptions may indicate poor quality
 *    (applied at session level, not per-turn)
 */
function computeTtsProxyMos(inputs: TtsProxyInputs): number {
  let score = 4.5; // Start with perfect score

  // Factor 1: TTFB penalty (most significant)
  if (inputs.ttfbMs !== undefined) {
    if (inputs.ttfbMs < 300) {
      score -= 0.0; // Excellent
    } else if (inputs.ttfbMs < 800) {
      // Linear penalty from 0 to 0.8 (300-800ms range)
      score -= ((inputs.ttfbMs - 300) / 500) * 0.8;
    } else {
      // Severe penalty for high latency
      score -= 0.8 + Math.min((inputs.ttfbMs - 800) / 1000, 1.0);
    }
  }

  // Factor 2: Connection latency penalty
  if (inputs.connectionMs !== undefined) {
    if (inputs.connectionMs < 200) {
      score -= 0.0; // Excellent
    } else if (inputs.connectionMs < 500) {
      score -= ((inputs.connectionMs - 200) / 300) * 0.3;
    } else {
      score -= 0.3 + Math.min((inputs.connectionMs - 500) / 1000, 0.5);
    }
  }

  // Factor 3: Chunk consistency (streaming mode only)
  if (inputs.streaming) {
    if (inputs.chunkCount === 0) {
      score -= 1.5; // Severe penalty - no audio delivered
    } else if (inputs.chunkCount < 3) {
      score -= 0.4; // Small penalty - chunky delivery
    }
    // >= 3 chunks is good, no penalty
  }

  // Factor 4: Error penalty
  if (inputs.hasError) {
    score -= 1.0; // Severe penalty for failures
  }

  // Factor 5: Barge-in signal (mild penalty, quality indicator)
  if (inputs.bargeInOnAgent) {
    score -= 0.2; // Slight penalty - could indicate poor quality
  }

  // Clamp to MOS range [1.0, 4.5]
  return Math.max(1.0, Math.min(4.5, score));
}

/**
 * Combine proxy MOS (application quality) with network MOS (delivery quality)
 * into a unified TTS quality score.
 *
 * Weight: 60% proxy (application quality) + 40% network (delivery quality)
 * This weighting prioritizes application-level issues while still accounting
 * for network degradation.
 */
function computeCombinedTtsMos(proxyMos: number, networkMos: number | null): number {
  if (networkMos === null) {
    // No network MOS available - use proxy MOS only
    return proxyMos;
  }

  // Weighted combination: 60% proxy + 40% network
  const combined = 0.6 * proxyMos + 0.4 * networkMos;
  return Math.max(1.0, Math.min(4.5, combined));
}

export interface KorevgSessionConfig {
  projectId: string;
  agentId: string;
  deploymentId: string;
  sessionId: string;
  callSid: string;
  streamId: string; // For constructing WebSocket actionHook path
  caller?: string;
  called?: string;
  ttsVendor?: string;
  ttsVoice?: string;
  ttsLanguage?: string;
  ttsOptions?: Record<string, unknown>;
  sttVendor?: string;
  sttLanguage?: string;
  sttAlternativeLanguages?: string[];
  sttModel?: string;
  tenantId?: string;
  agentName?: string;
  welcomeMessage?: string | null;
  callInfo?: Record<string, unknown>; // SIP call metadata from session:new
  callerContext?: CallerContext;
  sessionMetadata?: Record<string, unknown>;
  orpheusWsStreamingEnabled?: boolean;
  bargeIn?: boolean;
  pauseTimeoutMs?: number;
  onSessionNewReceived?: (msg: IncomingMessage) => void;

  // S2S mode configuration
  voiceMode?: 'pipeline' | 'realtime';
  s2sProvider?: string;
  s2sConfig?: {
    model?: string;
    voice?: string;
    temperature?: number;
    threshold?: number;
    turnDetection?: string;
    silenceDuration?: number;
    prefixPadding?: number;
    agentId?: string;
    conversationId?: string;
  };
  s2sCredentials?: {
    apiKey: string;
    endpoint?: string;
  };
}

export interface IncomingMessage {
  type:
    | 'session:new'
    | 'verb:hook'
    | 'verb:status'
    | 'call:status'
    | 'jambonz:error'
    | 'tts:streaming-event'
    | 'tts:tokens-result'
    | 'tts:user_interrupt'
    | 'llm:event'; // S2S realtime mode events
  msgid: string;
  call_sid: string;
  hook?: string;
  data?: Record<string, unknown>;
}

type HookTransport = 'websocket' | 'http';
type BridgedTranscriptParticipant = 'user' | 'human_agent';
type BridgedTranscriptClassificationSource = 'explicit_identity' | 'channel_tag';

interface BridgedTranscriptClassification {
  participant: BridgedTranscriptParticipant;
  source: BridgedTranscriptClassificationSource;
}

interface RecentBridgedTranscriptEntry {
  observedAtMs: number;
  participant: BridgedTranscriptParticipant;
  source: BridgedTranscriptClassificationSource;
}

const BRIDGED_TRANSCRIPT_DUPLICATE_WINDOW_MS = 750;
const MAX_RECENT_BRIDGED_TRANSCRIPTS = 256;

export class KorevgSession {
  private ws: WebSocket;
  private config: KorevgSessionConfig;
  private executor: RuntimeExecutor | null; // Optional for S2S mode
  private verbBuilder: KorevgVerbBuilder;
  private isActive = true;
  private isS2SMode: boolean;
  private wsPath: string; // WebSocket path for actionHook - tells Jambonz where to send verb:hook
  private activeHookTransport: HookTransport = 'websocket';
  private bufferedHttpHookResponse: VerbResponse[] | null = null;
  private messageQueue: Array<{ msg: IncomingMessage; data: Buffer }> = [];
  private isProcessing = false;
  // TTS Streaming state
  private ttsStreamOpen = false;
  private ttsBuffer: string[] = []; // Buffer chunks before stream opens
  private ttsTokenId = 0; // Unique ID for each token send
  private ttsConnectionRequestTime?: number; // When we requested TTS stream connection
  private ttsConnectionMs?: number; // How long the TTS stream took to connect
  private ttsFirstTokenSent = false; // Track if we've sent first token in current turn
  private turnTtsConnectionMs?: number; // Connection time for current turn (if reconnection happened)
  private dropStreamingTokensUntilNextTurn = false; // Stop sending stale tokens after user interrupt
  private ttsReconnectAttempt = 0; // Incremented each time Jambonz reports stream closed
  private ttsReconnectTimer?: ReturnType<typeof setTimeout>; // Warn/fallback if reopen never arrives
  private lastTtsClosePayload?: Record<string, unknown>; // Latest close payload for diagnostics
  // Tracing / persistence state
  private dbSessionId?: string; // Linked DB session for message persistence
  private dbSessionCreationPromise?: Promise<void>;
  private turnCount = 0; // Sequential turn counter for this call
  // Streaming mode: resolved once at call start from entry agent's config
  private useStreaming = true;
  // Non-streaming TTS TTFB: time from say command to start-playback verb:status
  private saySentTime?: number; // When we sent the say command
  private lastTtsSynthElapsedMs?: number;
  private ttsSynthResolve?: (elapsedMs: number) => void;
  private ttsPlaybackResolve?: (event: 'stop-playback' | 'kill-playback' | 'timeout') => void;
  // ── Metric 203: E2E Voice Response Latency ────────────────────────────────
  // Measures user speech end (verb:hook arrival) → agent audio starts
  //   Streaming:     verb:hook → first tts:tokens sent (approximate)
  //   Non-streaming: verb:hook → start-playback verb:status (exact)
  private verbHookArrivalTime?: number; // When verb:hook was received
  private lastE2eLatencyMs?: number; // Computed E2E for current turn
  private e2eTotalMs = 0; // Cumulative E2E for session average
  private e2eCount = 0; // Number of turns with E2E measurement
  // ── Metric 204: Barge-in Detection ────────────────────────────────────────
  // Detected via verb:status speech-bargein-detected / dtmf-bargein-detected
  // emitted by Jambonz background gather when user interrupts agent playback
  private bargeInCount = 0; // Total barge-ins in session
  private lastBargeInDetected = false; // Flag set by verb:status, consumed by next verb:hook
  private agentSpeakingStartTime?: number; // When agent audio began (for speaking duration)
  // ── Metric 209: DTMF Fallback Rate ─────────────────────────────────────
  // Tracks how often callers use keypad (DTMF) instead of speech
  private dtmfTurnCount = 0; // Turns where input was DTMF digits
  private lastInputMethod: 'speech' | 'dtmf' = 'speech'; // Input method for current turn
  /** One-shot resolver for CSAT DTMF gather — set by gatherDTMF(), consumed by handleVerbHook() */
  private csatGatherResolve?: ((digits: string | null) => void) | undefined;
  // ── Metric 205: Silence Duration as % of Call ─────────────────────────────
  // Silence is measured directly from event-based gaps:
  //   waitingSilence:    gap between agent done (TTS flush/stop-playback) and user
  //                      starting to speak, estimated as (verbHook − lastTtsActivity − userEstimate)
  //   processingSilence: E2E latency (verb:hook → first audio) — caller hears nothing
  // Agent speaking is derived as residual: callDuration − silence − userSpeaking
  private voiceSessionStartEmitted = false;
  private callStartTime?: number; // Set at first greeting
  private callEndTime?: number; // Actual call end time (before Homer delay)
  private lastTtsActivityTime?: number; // When TTS tokens were last flushed/stopped
  private silenceAccumulatedMs = 0; // Directly accumulated silence (waiting + processing)
  private processingTotalMs = 0; // Subset of silence: cumulative E2E latency
  private userSpeakingTotalMs = 0; // Estimated user speech time (word-count based)
  // ── Metric 206: Voice Containment Rate ────────────────────────────────────
  // Tracks whether the call was contained (resolved by AI) or escalated (transferred to human)
  private sessionOutcome: 'pending' | 'completed' | 'escalated' | 'abandoned' = 'pending';
  // ── Metric 207: Call Phase Tracking ───────────────────────────────────────
  // Tracks which phase of the call the user is in for abandonment analysis
  private callPhase: 'greeting' | 'conversation' | 'transfer' | 'farewell' = 'greeting';
  private hasUserSpoken = false; // Track first user speech to end greeting phase
  private currentAgentName: string | null = null; // Track active agent for phase detection
  private voiceTransferInitiated = false;
  private dialActive = false; // True while a dial verb is bridging caller to agent
  private recentBridgedTranscripts = new Map<string, RecentBridgedTranscriptEntry>();

  // ── Metric 202: TTS Proxy MOS Tracking ────────────────────────────────────
  // Tracks TTS quality signals for computing proxy MOS score
  private ttsProxyMosTotal = 0; // Sum of per-turn proxy MOS scores
  private ttsProxyMosCount = 0; // Number of turns with TTS (for averaging)
  private ttsErrorCount = 0; // Total TTS errors in session
  private ttsTotalTtfbMs = 0; // Sum of TTFB for averaging
  private ttsTtfbCount = 0; // Count of turns with TTFB measurement

  // ── Metric 201: ASR Quality Tracking (Multi-signal WER proxy) ──────────────
  // Tracks per-turn ASR data for session-level quality analysis
  private asrTurns: ASRTurnData[] = []; // Collected turn data for quality analysis
  private voiceQualityAnalyzer = new VoiceQualityAnalyzer(); // Quality analyzer instance
  private overallAsrScore: number | null = null; // Session-level ASR quality score (0-100)

  // ── Metric 210: ASR Cascade Detection ───────────────────────────────────────
  // Detects cascade failures: bad network → bad audio → wrong ASR → wrong intent
  private cascadeDetector = new ASRCascadeDetector(); // Cascade risk analyzer
  private cascadeRiskTurns = 0; // Count of turns with medium or high cascade risk
  private inboundNetworkMos: number | null = null; // Inbound network MOS from Homer (updated at session end)
  private currentTurnTtsLanguage?: string;
  private activeStreamingTtsLanguage?: string;

  constructor(ws: WebSocket, config: KorevgSessionConfig, executor?: RuntimeExecutor) {
    log.info(
      `Initializing session: call_sid=${config.callSid}, mode=${config.voiceMode || 'pipeline'}`,
    );

    this.ws = ws;
    this.config = config;
    this.executor = executor || null;
    this.isS2SMode = config.voiceMode === 'realtime';
    this.wsPath = `/ws/korevg/${config.streamId}`;
    // ElevenLabs turbo/multilingual models use ISO 639-1 codes (e.g. 'en'),
    // NOT locale codes like 'en-US' which causes WebSocket rejection.
    this.verbBuilder = new KorevgVerbBuilder({
      ttsVendor: config.ttsVendor || 'elevenlabs',
      ttsVoice: config.ttsVoice || 'EXAVITQu4vr4xnSDxMaL',
      ttsLabel:
        config.tenantId &&
        (config.ttsVendor === 'cartesia' || config.ttsVendor?.startsWith('custom:'))
          ? `t:${config.tenantId}`
          : undefined,
      ttsLanguage: config.ttsLanguage || 'en',
      ttsOptions: config.ttsOptions,
      sttVendor: config.sttVendor || 'deepgram',
      sttLanguage: config.sttLanguage || 'en-US',
      sttAlternativeLanguages: config.sttAlternativeLanguages,
      sttModel: config.sttModel,
      streamingEnabled: true,
      bargeIn: config.bargeIn,
      pauseTimeoutMs: config.pauseTimeoutMs,
    });

    this.setupEventHandlers();

    // Register in the voice session registry so the message bridge can find us
    registerVoiceSession(config.sessionId, this);
    registerVoiceSession(config.callSid, this);
  }

  private applyConversationBehaviorVoiceRuntimeConfig(
    runtimeSession: RuntimeSession | undefined,
  ): void {
    const behaviorVoiceConfig = resolveConversationBehaviorVoiceRuntimeConfig(
      runtimeSession?._effectiveConfig?.conversationBehavior,
    );
    if (behaviorVoiceConfig.bargeIn !== undefined) {
      this.config.bargeIn = behaviorVoiceConfig.bargeIn;
      this.verbBuilder.setBargeInEnabled(behaviorVoiceConfig.bargeIn);
    }
    if (behaviorVoiceConfig.pauseTimeoutMs !== undefined) {
      this.config.pauseTimeoutMs = behaviorVoiceConfig.pauseTimeoutMs;
      this.verbBuilder.setPauseTimeoutMs(behaviorVoiceConfig.pauseTimeoutMs);
    }
  }

  private forceNonStreamingWhenBargeInDisabled(context: string): void {
    if (this.config.bargeIn !== false || !this.useStreaming) {
      return;
    }

    this.useStreaming = false;
    this.clearTtsReconnectWatch();
    this.ttsConnectionRequestTime = undefined;
    log.info('[STREAMING-RESOLVE] Forced non-streaming because barge-in is disabled', {
      context,
    });
  }

  private resolveGreeting(initResultResponse?: string, streamedChunks: string[] = []): string {
    if (typeof this.config.welcomeMessage === 'string') {
      return this.config.welcomeMessage;
    }
    return initResultResponse || streamedChunks.join('') || 'Hello! How can I help you today?';
  }

  private resolveOrpheusTestOverrideText(): string | null {
    const raw = process.env.ORPHEUS_TTS_TEST_OVERRIDE_TEXT?.trim();
    return raw && raw.length > 0 ? raw : null;
  }

  private getConfiguredTtsLanguage(): string {
    return this.config.ttsLanguage || 'en';
  }

  private getEffectiveTurnTtsLanguage(): string {
    return this.currentTurnTtsLanguage || this.getConfiguredTtsLanguage();
  }

  private getCurrentTurnTtsOptions(): TtsVerbOptions {
    const effectiveLanguage = this.currentTurnTtsLanguage;
    return effectiveLanguage ? { ttsLanguage: effectiveLanguage } : {};
  }

  private buildBufferedSpeechVerbs(text: string, actionHook = this.wsPath): VerbResponse[] {
    const ttsOptions = this.getCurrentTurnTtsOptions();
    if (this.config.bargeIn === false) {
      return [
        this.verbBuilder.say(text, { streaming: false, ...ttsOptions }),
        this.verbBuilder.gather({
          actionHook,
          timeout: 0,
          bargein: false,
          listenDuringPrompt: false,
        }),
      ];
    }

    return [
      this.verbBuilder.say(text, { streaming: false, ...ttsOptions }),
      this.verbBuilder.buildStreamingConfig(actionHook, { streaming: false }),
    ];
  }

  private buildListeningVerb(
    actionHook = this.wsPath,
    options?: { streaming?: boolean },
  ): VerbResponse {
    if (this.config.bargeIn === false) {
      return this.verbBuilder.gather({
        actionHook,
        timeout: 0,
        bargein: false,
        listenDuringPrompt: false,
      });
    }

    return this.verbBuilder.buildStreamingConfig(actionHook, options);
  }

  private buildInitialGreetingVerbs(greeting: string): VerbResponse[] {
    if (this.config.bargeIn === false) {
      const verbs: VerbResponse[] = [];
      if (greeting.trim()) {
        verbs.push(this.verbBuilder.say(greeting, { streaming: false }));
      }
      verbs.push(
        this.verbBuilder.gather({
          actionHook: this.wsPath,
          timeout: 0,
          bargein: false,
          listenDuringPrompt: false,
        }),
      );
      return verbs;
    }

    if (this.useStreaming) {
      return [this.verbBuilder.buildStreamingConfig(this.wsPath, { streaming: true })];
    }

    const verbs: VerbResponse[] = [
      this.verbBuilder.buildStreamingConfig(this.wsPath, { streaming: false }),
    ];
    if (greeting.trim()) {
      verbs.push(this.verbBuilder.say(greeting, { streaming: false }));
    }
    return verbs;
  }

  /**
   * Emit a voice-specific trace event to TraceStore + ClickHouse.
   * These events are NOT emitted by the agent executor — they capture
   * voice pipeline phases (STT, TTS, turn timing) that are specific
   * to the voice channel.
   */
  private emitVoiceTraceEvent(type: string, data: Record<string, unknown>, durationMs?: number) {
    const traceEvent = {
      id: randomUUID(),
      sessionId: this.config.sessionId,
      type,
      timestamp: new Date(),
      data: { ...data, tenantId: this.config.tenantId },
      agentName: this.config.agentName,
    };

    const runtimeSession = this.executor?.getSession?.(this.config.sessionId);
    let scrubbedTraceEvent = traceEvent;

    // 1. Store in in-memory TraceStore (visible in Studio session detail)
    try {
      scrubbedTraceEvent = addScrubbedVoiceTraceEvent(
        this.config.sessionId,
        traceEvent,
        runtimeSession,
      );
    } catch {
      /* TraceStore not available */
    }

    // 2. Emit to EventStore → platform_events table (for Voice tab in Studio)
    if (this.config.tenantId && this.config.projectId) {
      Promise.all([import('../../eventstore-singleton.js'), import('@abl/eventstore/migration')])
        .then(([{ getEventStore }, { emitTraceEventAsAnalytics }]) => {
          const eventStore = getEventStore();
          if (!eventStore) return;
          emitTraceEventAsAnalytics(
            eventStore.emitter,
            {
              type: type,
              sessionId: this.config.sessionId,
              tenantId: this.config.tenantId!,
              projectId: this.config.projectId!,
              agentName: this.config.agentName || 'unknown',
              timestamp: scrubbedTraceEvent.timestamp,
              durationMs: durationMs || 0,
              data: scrubbedTraceEvent.data,
            },
            {
              typeMap: VOICE_EVENT_TYPE_MAP,
            },
          );
        })
        .catch((err) => {
          log.warn(`[PIPELINE] EventStore ${type} emission failed`, {
            err: err instanceof Error ? err.message : String(err),
          });
        });
    }
  }

  private emitVoiceSessionStartOnce(): void {
    if (this.voiceSessionStartEmitted) {
      return;
    }

    this.voiceSessionStartEmitted = true;
    this.callStartTime = Date.now(); // Metric 205: call duration baseline

    const ci = this.config.callInfo || {};
    this.emitVoiceTraceEvent('voice_session_start', {
      callSid: (ci.callSid as string) || this.config.callSid,
      caller: (ci.from as string) || this.config.caller || '',
      called: (ci.to as string) || this.config.called || '',
      callId: ci.callId,
      sbcCallId: ci.sbcCallId,
      direction: ci.direction,
      traceId: ci.traceId,
      originatingSipIp: ci.originatingSipIp,
      callerName: ci.callerName,
      userAgent: ci.userAgent,
      accountSid: ci.accountSid,
      voipCarrierSid: ci.voipCarrierSid,
      applicationSid: ci.applicationSid,
      uri: ci.uri,
      originatingSipTrunkName: ci.originatingSipTrunkName,
      synthesizer: ci.synthesizer,
      recognizer: ci.recognizer,
      ttsVendor: this.config.ttsVendor || 'elevenlabs',
      ttsVoice: this.config.ttsVoice,
      sttVendor: this.config.sttVendor || 'deepgram',
      channel: 'voice',
    });
  }

  private emitTtsLanguageResolutionTrace(turnId: string, resolution: TtsLanguageResolution): void {
    this.emitVoiceTraceEvent('voice_config_resolved', {
      turnId,
      turn: this.turnCount,
      scope: 'tts_language',
      vendor: resolution.vendor,
      configuredTtsLanguage: resolution.configuredLanguage,
      configuredTtsVoice: resolution.configuredVoice,
      effectiveTtsLanguage: resolution.effectiveLanguage,
      requestedLanguage: resolution.requestedLanguage,
      requestedLocale: resolution.requestedLocale,
      reason: resolution.reason,
      diagnosticCode: resolution.diagnosticCode,
      severity:
        resolution.reason === 'unsupported' || resolution.reason === 'lookup_unavailable'
          ? 'warning'
          : 'info',
    });
  }

  private setupEventHandlers() {
    this.ws.on('message', (data: Buffer) => {
      this.handleMessage(data);
    });
    this.ws.on('close', () => {
      this.handleClose().catch((err) => {
        log.warn('[SESSION] Close handler failed', {
          sessionId: this.config.sessionId,
          callSid: this.config.callSid,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    });
    this.ws.on('error', (err: Error) => this.handleError(err));
  }

  private closeForInvalidSessionMetadata(error: unknown): boolean {
    if (!isSessionMetadataValidationError(error)) {
      return false;
    }

    log.warn('[SESSION] Rejecting Korevg message with invalid session metadata', {
      sessionId: this.config.sessionId,
      callSid: this.config.callSid,
      error: error.message,
    });
    this.ws.close(1008, 'Invalid session metadata');
    return true;
  }

  private async handleMessage(data: Buffer) {
    try {
      const rawString = data.toString().trim();

      if (!rawString) {
        return;
      }

      const msg: IncomingMessage = JSON.parse(rawString);

      switch (msg.type) {
        case 'session:new':
          await this.handleSessionNew(msg);
          break;
        case 'llm:event':
          // S2S realtime mode events (OpenAI Realtime API)
          // S2S sessions use S2SSessionBridge, not KorevgSession
          // This case should never be reached
          log.warn('Received llm:event in KorevgSession (should use S2SSessionBridge instead)');
          break;
        case 'verb:hook':
          // Queue verb:hook messages for sequential processing
          if (this.messageQueue.length >= MAX_KOREVG_QUEUE_SIZE) {
            log.warn(`Message queue full, dropping oldest message`);
            this.messageQueue.shift();
          }
          this.messageQueue.push({ msg, data });
          this.processMessageQueue().catch((err) => {
            log.error(`Error in message queue processing: ${err}`);
          });
          break;
        case 'jambonz:error':
          log.error(`Jambonz error: ${JSON.stringify(msg.data)}`);
          break;
        case 'tts:streaming-event':
          await this.handleTtsStreamingEvent(msg);
          break;
        case 'tts:tokens-result':
          this.handleTtsTokensResult(msg);
          break;
        case 'tts:user_interrupt':
          this.handleTtsUserInterrupt(msg);
          break;
        case 'verb:status':
          this.handleVerbStatus(msg);
          break;
        default:
          break;
      }
    } catch (err) {
      if (this.closeForInvalidSessionMetadata(err)) {
        return;
      }
      log.error(`Error handling message: ${err}`);
    }
  }

  async replayBufferedMessage(data: Buffer): Promise<void> {
    await this.handleMessage(data);
  }

  /**
   * Process queued messages sequentially to avoid race conditions
   */
  private async processMessageQueue() {
    if (this.isProcessing) {
      return;
    }

    this.isProcessing = true;

    try {
      while (this.messageQueue.length > 0) {
        const item = this.messageQueue.shift();
        if (!item) break;

        await this.handleVerbHook(item.msg);
      }
    } finally {
      this.isProcessing = false;
    }
  }

  /**
   * Handle session:new event - new call started
   */
  private async handleSessionNew(msg: IncomingMessage) {
    this.config.onSessionNewReceived?.(msg);
    log.info(
      `New call session started: call_sid=${msg.call_sid} project=${this.config.projectId} agent=${this.config.agentId}`,
    );

    // Extract call info from session:new for tracing metadata (non-early-ack path)
    if (!this.config.callInfo && msg.data) {
      const d = msg.data;
      const sipHeaders =
        ((d.sip as Record<string, unknown>)?.headers as Record<string, string>) || {};
      this.config.callInfo = {
        callSid: msg.call_sid || d.call_sid,
        from: d.from,
        to: d.to,
        callId: sipHeaders['call-id'] || d.call_id,
        // sbc_callid is the original caller→SBC SIP Call-ID (used by Homer for correlation)
        sbcCallId: d.sbc_callid,
        accountSid: sipHeaders['X-Account-Sid'] || d.account_sid,
        voipCarrierSid: sipHeaders['X-Voip-Carrier-Sid'],
        applicationSid: sipHeaders['X-Application-Sid'] || d.application_sid,
        uri: (d.sip as Record<string, unknown>)?.uri,
        direction: d.direction,
        traceId: d.trace_id,
        originatingSipIp: d.originating_sip_ip,
        callerName: d.caller_name,
        originatingSipTrunkName: d.originating_sip_trunk_name,
        userAgent: sipHeaders['user-agent'],
        synthesizer: (d.defaults as Record<string, unknown>)?.synthesizer,
        recognizer: (d.defaults as Record<string, unknown>)?.recognizer,
      };
    }

    this.emitVoiceSessionStartOnce();

    const inboundSessionMetadata =
      coerceSessionMetadata(msg.data?.sessionMetadata) ??
      coerceSessionMetadata(msg.data?.session_metadata);
    if (inboundSessionMetadata) {
      const mergedConfigSessionMetadata = mergeAndValidateSessionMetadata(
        this.config.sessionMetadata,
        inboundSessionMetadata,
      );
      if (mergedConfigSessionMetadata) {
        this.config.sessionMetadata = mergedConfigSessionMetadata;
      }

      const runtimeSession = this.executor?.getSession?.(this.config.sessionId);
      if (runtimeSession) {
        updateSessionMetadata(runtimeSession.data, inboundSessionMetadata);
      }
    }

    // Create DB session for message persistence without blocking the greeting.
    const dbSessionReady = this.ensureDBSession();

    // S2S mode: initialization is handled by llm verb, no greeting needed
    if (this.isS2SMode) {
      log.info('[S2S] Session initialized, waiting for llm:event messages');
      return;
    }

    // Pipeline mode: Initialize session and trigger ON_START to get greeting
    if (!this.executor) {
      log.error('[PIPELINE] Executor not provided for pipeline mode');
      return;
    }

    this.sendAck(msg.msgid, [this.verbBuilder.answer()]);

    try {
      await this.resolveStreamingMode();
      log.info(`[SESSION] Session:new resolved streaming mode useStreaming=${this.useStreaming}`);

      // Initialize session and trigger ON_START to get greeting
      const chunks: string[] = [];

      // onTraceEvent for greeting — centralized handler in RuntimeExecutor
      // will store to TraceStore + ClickHouse automatically
      const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
        log.debug(`[TRACE] init trace: ${event.type}`);
      };

      const initResult = await this.executor!.initializeSession(
        this.config!.sessionId,
        (chunk: string) => {
          chunks.push(chunk);
        },
        onTraceEvent,
      );

      const greeting = this.resolveGreeting(initResult?.response, chunks);

      // Metric 205: Set call start time
      if (!this.callStartTime) this.callStartTime = Date.now();

      // Persist greeting as assistant message
      if (greeting) {
        void dbSessionReady
          .then(() => {
            if (!this.dbSessionId) {
              return;
            }

            return persistMessage(
              this.dbSessionId,
              'assistant',
              greeting,
              'voice',
              this.config.tenantId,
              undefined,
              undefined,
              this.config.projectId,
              undefined,
              buildPersistedMessageStructuredContent({
                richContent: initResult?.richContent,
                actions: initResult?.actions,
                voiceConfig: initResult?.voiceConfig,
                localization: initResult?.localization,
              }),
              initResult?.responseMetadata,
            );
          })
          .catch((err: unknown) =>
            log.warn('[PERSIST] Greeting persist failed', {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
      }

      const verbs = this.buildInitialGreetingVerbs(greeting);
      if (this.useStreaming && this.config.bargeIn !== false && greeting.trim()) {
        this.ttsBuffer.push(greeting);
      }

      this.sendCommand('redirect', verbs);
      log.info(
        `[SESSION] Session initialized with streaming config (useStreaming=${this.useStreaming})`,
      );
    } catch (err) {
      log.error(`[SESSION] Error initializing: ${err}`);
      const fallbackGreeting = 'Hello! How can I help you today?';
      const fallbackVerbs = this.buildInitialGreetingVerbs(fallbackGreeting);
      if (this.useStreaming && this.config.bargeIn !== false) {
        this.ttsBuffer.push(fallbackGreeting);
      }
      this.sendCommand('redirect', fallbackVerbs);
    }
  }

  /**
   * Send greeting after session is initialized
   * Called when session:new was already acked with just answer verb
   */
  async sendGreeting(): Promise<void> {
    log.info('[SESSION] sendGreeting() called, initializing session...');

    // Create DB session for message persistence without blocking the greeting.
    const dbSessionReady = this.ensureDBSession();

    // ── Voice trace: Session start ─────────────────────────────────────────
    this.emitVoiceSessionStartOnce();

    try {
      // Initialize session and trigger ON_START to get greeting
      const chunks: string[] = [];

      // onTraceEvent for greeting — centralized handler in RuntimeExecutor
      // will store to TraceStore + ClickHouse automatically
      const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
        log.debug(`[TRACE] init trace: ${event.type}`);
      };

      const initResult = await this.executor!.initializeSession(
        this.config!.sessionId,
        (chunk: string) => {
          chunks.push(chunk);
        },
        onTraceEvent,
      );

      const greeting = this.resolveGreeting(initResult?.response, chunks);

      // Persist greeting as assistant message
      if (greeting) {
        void dbSessionReady
          .then(() => {
            if (!this.dbSessionId) {
              return;
            }

            return persistMessage(
              this.dbSessionId,
              'assistant',
              greeting,
              'voice',
              this.config.tenantId,
              undefined,
              undefined,
              this.config.projectId,
              undefined,
              buildPersistedMessageStructuredContent({
                richContent: initResult?.richContent,
                actions: initResult?.actions,
                voiceConfig: initResult?.voiceConfig,
                localization: initResult?.localization,
              }),
              initResult?.responseMetadata,
            );
          })
          .catch((err: unknown) =>
            log.warn('[PERSIST] Greeting persist failed', {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
      }

      // Resolve streaming mode from DB using the entry agent's slug
      await this.resolveStreamingMode();
      log.info(
        `[SESSION] Got greeting (${greeting.length} chars), useStreaming=${this.useStreaming}`,
      );

      if (!greeting.trim()) {
        this.ttsConnectionRequestTime = Date.now();
        this.sendCommand('redirect', [this.buildListeningVerb(this.wsPath)]);
        log.info('[SESSION] Greeting suppressed, config sent without opening prompt');
      } else if (this.useStreaming) {
        // Streaming: open TTS stream, buffer greeting for tts:tokens delivery
        this.ttsConnectionRequestTime = Date.now();
        if (this.config.bargeIn === false) {
          const greetingVerbs = this.buildBufferedSpeechVerbs(greeting);
          this.sendCommand('redirect', greetingVerbs);
          log.info('[SESSION] Greeting sent with post-prompt gather because barge-in is disabled');
        } else {
          this.sendCommand('redirect', [this.verbBuilder.buildStreamingConfig(this.wsPath)]);
          this.ttsBuffer.push(greeting);
          log.info('[SESSION] Config sent, greeting buffered for tts:tokens');
        }
      } else {
        // Non-streaming: send config, then greeting via say verb
        this.ttsConnectionRequestTime = Date.now();
        this.lastTtsSynthElapsedMs = undefined;
        this.saySentTime = Date.now();
        const greetingVerbs = this.buildBufferedSpeechVerbs(greeting);
        this.sendCommand('redirect', greetingVerbs);
        log.info('[SESSION] Greeting sent via buffered voice verb (non-streaming)');

        // Wait for start-playback verb:status to measure real TTS TTFB
        const greetingTtfb = await this.waitForTtsSynthEvent(10000);
        log.info(`[SESSION] Greeting TTS TTFB from Jambonz: ${greetingTtfb ?? 'timeout'}ms`);

        // Emit greeting TTS trace event for non-streaming
        this.emitVoiceTraceEvent('voice_tts', {
          turn: 0,
          provider: this.config.ttsVendor || 'elevenlabs',
          voice: this.config.ttsVoice,
          firstChunkMs: greetingTtfb || undefined,
          streaming: false,
          text: greeting.substring(0, 500),
          isGreeting: true,
        });
        this.lastTtsSynthElapsedMs = undefined;
      }
    } catch (err) {
      log.error(`[SESSION] Error sending greeting: ${err}`);
      // Send fallback greeting via command
      this.ttsConnectionRequestTime = Date.now();
      const fallbackGreeting = 'Hello! How can I help you today?';
      if (this.config.bargeIn === false) {
        this.sendCommand('redirect', this.buildBufferedSpeechVerbs(fallbackGreeting));
      } else {
        this.sendCommand('redirect', [this.verbBuilder.buildStreamingConfig(this.wsPath)]);
        this.ttsBuffer.push(fallbackGreeting);
      }
    }
  }

  /**
   * Handle tts:streaming-event messages from Jambonz
   *
   * IMPORTANT: These events are processed OUTSIDE the verb:hook queue,
   * so they can interleave with handleVerbHook during its async awaits.
   * This handler is the sole authority for managing ttsStreamOpen state.
   */
  private async handleTtsStreamingEvent(msg: IncomingMessage) {
    const eventType = msg.data?.event_type as string;

    if (eventType === 'stream_open') {
      this.ttsStreamOpen = true;
      this.ttsReconnectAttempt = 0;
      this.clearTtsReconnectWatch();
      // Compute TTS connection time (from streaming config request to stream_open)
      if (this.ttsConnectionRequestTime) {
        const connectionTime = Date.now() - this.ttsConnectionRequestTime;
        this.ttsConnectionMs = connectionTime;

        // If there are buffered chunks, this reconnection is for the current turn
        if (this.ttsBuffer.length > 0) {
          this.turnTtsConnectionMs = connectionTime;
          log.info(
            `[TTS-STREAM] Stream reopened in ${connectionTime}ms - attributing to current turn (buffered: ${this.ttsBuffer.length} chunks)`,
          );
        } else {
          log.info(
            `[TTS-STREAM] Stream opened in ${connectionTime}ms (buffered: ${this.ttsBuffer.length} chunks)`,
          );
        }
        this.ttsConnectionRequestTime = undefined;
      } else {
        log.info(`[TTS-STREAM] Stream opened (buffered: ${this.ttsBuffer.length} chunks)`);
      }
      // Flush buffered chunks that arrived before stream opened (greeting)
      if (this.ttsBuffer.length > 0) {
        const greetingText = this.ttsBuffer.join(' ');
        log.info(`[TTS-STREAM] Flushing ${this.ttsBuffer.length} buffered chunks`);
        for (const chunk of this.ttsBuffer) {
          await this.sendTtsTokens(chunk);
        }
        this.ttsBuffer = [];
        // Signal Jambonz to synthesize the buffered text
        this.sendTtsFlush();
        // Agent starts speaking (greeting) — track for barge-in duration
        this.agentSpeakingStartTime = Date.now();
        // Metric 205: Mark TTS activity for silence gap tracking
        this.lastTtsActivityTime = Date.now();

        // Emit a voice_tts event for the greeting so the connection time
        // is attributed to the greeting, not the first user turn.
        this.emitVoiceTraceEvent('voice_tts', {
          turn: 0,
          provider: this.config.ttsVendor || 'elevenlabs',
          voice: this.config.ttsVoice,
          connectionMs: this.ttsConnectionMs || undefined,
          streaming: true,
          text: greetingText.substring(0, 500),
          isGreeting: true,
        });
        // NOTE: Keep ttsConnectionMs for TTFB calculation in subsequent turns
        // (it represents the amortized connection setup cost)
      }
    } else if (eventType === 'stream_close' || eventType === 'stream_closed') {
      this.ttsStreamOpen = false;
      this.ttsReconnectAttempt += 1;
      this.lastTtsClosePayload = msg.data ?? {};
      log.info(
        `[TTS-STREAM] Stream closed (attempt=${this.ttsReconnectAttempt}, buffered=${this.ttsBuffer.length} chunks)`,
      );
      // Do not eagerly redirect on every close. KoreVG re-opens delivery from
      // the next config redirect, so wait until there is buffered speech.
      if (this.ttsBuffer.length > 0) {
        this.ensureStreamingTtsReady('stream_closed_with_buffer');
      }
    }

    this.sendAck(msg.msgid);
  }

  private handleTtsTokensResult(msg: IncomingMessage) {
    const result = msg.data ?? {};
    const ok = result.success ?? result.ok;
    if (ok === false) {
      log.error(`[TTS-TOKENS] Result: ${JSON.stringify(result)}`);
      return;
    }
    log.debug(`[TTS-TOKENS] Result: ${JSON.stringify(result)}`);
  }

  private handleTtsUserInterrupt(msg: IncomingMessage) {
    const payload = msg.data ?? {};
    this.dropStreamingTokensUntilNextTurn = true;
    this.clearTtsReconnectWatch();
    this.ttsConnectionRequestTime = undefined;
    this.ttsStreamOpen = false;
    this.agentSpeakingStartTime = undefined;
    this.lastTtsActivityTime = Date.now();

    if (this.ttsBuffer.length > 0) {
      log.warn(
        `[TTS-STREAM] User interrupt dropped ${this.ttsBuffer.length} buffered chunks before next turn`,
      );
      this.ttsBuffer = [];
    }

    this.sendTtsClear();
    this.sendAck(msg.msgid);
  }

  /**
   * Send text tokens to Jambonz TTS streaming
   */
  private async sendTtsTokens(tokens: string) {
    const id = ++this.ttsTokenId;
    const cmd = {
      type: 'command',
      command: 'tts:tokens',
      queueCommand: false,
      data: {
        id,
        tokens,
      },
    };
    this.ws.send(JSON.stringify(cmd));
  }

  /**
   * Flush TTS stream (tells Jambonz to synthesize remaining buffered text)
   */
  private sendTtsFlush() {
    const cmd = {
      type: 'command',
      command: 'tts:flush',
      queueCommand: false,
    };
    this.ws.send(JSON.stringify(cmd));
  }

  private sendTtsClear() {
    const cmd = {
      type: 'command',
      command: 'tts:clear',
      queueCommand: false,
    };
    this.ws.send(JSON.stringify(cmd));
  }

  private clearTtsReconnectWatch() {
    if (this.ttsReconnectTimer) {
      clearTimeout(this.ttsReconnectTimer);
      this.ttsReconnectTimer = undefined;
    }
  }

  private scheduleTtsReconnectWatch(reason: string, timeoutMs = TTS_RECONNECT_TIMEOUT_MS) {
    if (!this.useStreaming || this.ttsStreamOpen || !this.isActive) {
      return;
    }

    this.clearTtsReconnectWatch();
    log.warn(
      `[TTS-STREAM] Waiting for reconnect: reason=${reason}, attempt=${this.ttsReconnectAttempt}, buffered=${this.ttsBuffer.length}, timeoutMs=${timeoutMs}`,
    );

    this.ttsReconnectTimer = setTimeout(() => {
      this.ttsReconnectTimer = undefined;
      if (!this.isActive || this.ttsStreamOpen || !this.useStreaming) {
        return;
      }

      log.error(
        `[TTS-STREAM] Reconnect timeout: attempt=${this.ttsReconnectAttempt}, buffered=${this.ttsBuffer.length}, lastClose=${JSON.stringify(this.lastTtsClosePayload ?? {})}`,
      );

      if (this.ttsBuffer.length > 0) {
        this.degradeToNonStreamingTts('reconnect_timeout');
      }
    }, timeoutMs);
  }

  private degradeToNonStreamingTts(reason: string) {
    if (!this.useStreaming) {
      return;
    }

    const bufferedText = this.ttsBuffer.join('');
    this.ttsBuffer = [];
    this.useStreaming = false;
    this.ttsStreamOpen = false;
    this.clearTtsReconnectWatch();
    this.ttsConnectionRequestTime = undefined;

    log.warn(
      `[TTS-STREAM] Degrading session to non-streaming TTS: reason=${reason}, bufferedChars=${bufferedText.length}, attempt=${this.ttsReconnectAttempt}`,
    );

    if (bufferedText.trim()) {
      this.sendCommand('redirect', this.buildBufferedSpeechVerbs(bufferedText));
      return;
    }

    this.sendCommand('redirect', [this.buildListeningVerb(this.wsPath, { streaming: false })]);
  }

  private ensureStreamingTtsReady(reason: string) {
    if (!this.useStreaming || !this.isActive) {
      return;
    }

    const effectiveLanguage = this.getEffectiveTurnTtsLanguage();
    const needsLanguageReconfigure =
      this.currentTurnTtsLanguage !== undefined &&
      this.ttsStreamOpen &&
      this.activeStreamingTtsLanguage !== effectiveLanguage;
    if (this.ttsStreamOpen && !needsLanguageReconfigure) {
      return;
    }

    if (needsLanguageReconfigure) {
      this.ttsStreamOpen = false;
      this.ttsConnectionRequestTime = undefined;
      this.clearTtsReconnectWatch();
      log.info('[TTS-STREAM] Reconfiguring streaming TTS language', {
        reason,
        previousLanguage: this.activeStreamingTtsLanguage,
        effectiveLanguage,
      });
    }

    if (this.ttsConnectionRequestTime) {
      this.scheduleTtsReconnectWatch(reason);
      return;
    }

    this.ttsConnectionRequestTime = Date.now();
    log.info(
      `[TTS-STREAM] Opening streaming config: reason=${reason}, buffered=${this.ttsBuffer.length}, attempt=${this.ttsReconnectAttempt}`,
    );
    this.sendCommand('redirect', [
      this.verbBuilder.buildStreamingConfig(this.wsPath, { ttsLanguage: effectiveLanguage }),
    ]);
    this.activeStreamingTtsLanguage = effectiveLanguage;
    this.scheduleTtsReconnectWatch(reason);
  }

  /**
   * Handle verb:status events from Jambonz.
   * Captures TTS synthesis metrics, E2E latency (203), and barge-in detection (204).
   *
   * Events handled:
   *   start-playback          — non-streaming only: audio starts playing to caller
   *   stop-playback           — non-streaming only: audio finished or killed
   *   kill-playback           — non-streaming only: audio forcefully stopped
   *   synthesized-audio       — non-streaming only: TTS TTFB from Jambonz
   *   speech-bargein-detected — both modes: user spoke during agent playback (barge-in)
   *   dtmf-bargein-detected   — both modes: user pressed key during agent playback
   */
  private handleVerbStatus(msg: IncomingMessage) {
    const data = msg.data || {};
    const event = data.event as string;

    if (event === 'start-playback') {
      // ── Agent starts speaking (non-streaming only) ──────────────────────
      this.agentSpeakingStartTime = Date.now();

      // E2E latency for non-streaming: verb:hook arrival → audio starts playing
      if (this.verbHookArrivalTime) {
        this.lastE2eLatencyMs = Date.now() - this.verbHookArrivalTime;
        // Metric 205: Processing silence = E2E gap (caller hears nothing)
        this.silenceAccumulatedMs += this.lastE2eLatencyMs;
        this.processingTotalMs += this.lastE2eLatencyMs;
        log.info(`[E2E] Non-streaming E2E latency: ${this.lastE2eLatencyMs}ms`);
      }

      // TTS TTFB measurement (existing logic)
      if (this.saySentTime) {
        const ttfb = Date.now() - this.saySentTime;
        this.lastTtsSynthElapsedMs = ttfb;
        this.saySentTime = undefined;
        log.info(`[VERB-STATUS] start-playback: TTS TTFB=${ttfb}ms`);
        if (this.ttsSynthResolve) {
          this.ttsSynthResolve(ttfb);
          this.ttsSynthResolve = undefined;
        }
      }
    } else if (event === 'synthesized-audio') {
      const elapsedTime = data.elapsedTime as number;
      if (elapsedTime) {
        this.lastTtsSynthElapsedMs = elapsedTime;
        log.info(
          `[VERB-STATUS] synthesized-audio: vendor=${data.vendor}, chars=${data.characters}, TTFB=${elapsedTime}ms, cached=${data.servedFromCache}`,
        );
        if (this.ttsSynthResolve) {
          this.ttsSynthResolve(elapsedTime);
          this.ttsSynthResolve = undefined;
        }
      }
    } else if (event === 'speech-bargein-detected' || event === 'dtmf-bargein-detected') {
      // ── Barge-in detected (Metric 204) ──────────────────────────────────
      // Jambonz background gather fires this when user speaks/presses key
      // while agent audio is playing. Works for both streaming and non-streaming.
      this.bargeInCount++;
      this.lastBargeInDetected = true;
      this.dropStreamingTokensUntilNextTurn = true;
      const agentSpeakingDurationMs = this.agentSpeakingStartTime
        ? Date.now() - this.agentSpeakingStartTime
        : undefined;

      this.emitVoiceTraceEvent('voice_barge_in', {
        turn: this.turnCount + 1, // The interrupted turn (next verb:hook)
        type: event === 'speech-bargein-detected' ? 'speech' : 'dtmf',
        agentSpeakingDurationMs,
        bargeInCount: this.bargeInCount,
      });

      this.agentSpeakingStartTime = undefined;
      // Metric 205: Agent audio stopped on barge-in — mark for silence gap tracking
      this.lastTtsActivityTime = Date.now();
      if (this.useStreaming) {
        this.sendTtsClear();
      }
      log.info(
        `[BARGE-IN] ${event}: count=${this.bargeInCount}, agentSpeakingMs=${agentSpeakingDurationMs}`,
      );
    } else if (event === 'stop-playback' || event === 'kill-playback') {
      // Non-streaming: audio stopped (normal completion or kill)
      this.agentSpeakingStartTime = undefined;
      // Metric 205: Agent audio ended — mark for silence gap tracking
      this.lastTtsActivityTime = Date.now();
      this.ttsPlaybackResolve?.(event);
      this.ttsPlaybackResolve = undefined;
      log.debug(`[VERB-STATUS] ${event}`);
    } else if (
      event === 'starting' ||
      event === 'ringing' ||
      event === 'answered' ||
      event === 'failed' ||
      event === 'finished'
    ) {
      // Dial verb lifecycle events — log at INFO for debugging transfer issues
      log.info(`[VERB-STATUS] dial ${event}`, {
        callSid: this.config.callSid,
        event,
        dialCallStatus: data.dial_call_status,
        dialSipStatus: data.dial_sip_status,
        fullData: JSON.stringify(data),
      });
    } else {
      log.debug(`[VERB-STATUS] ${event}`);
    }
  }

  /**
   * Wait for the verb:status synthesized-audio event from Jambonz (non-streaming TTS TTFB).
   * Times out after the given ms to avoid blocking indefinitely.
   */
  private waitForTtsSynthEvent(timeoutMs = 10000): Promise<number | undefined> {
    // If we already have it (e.g. from cache event), return immediately
    if (this.lastTtsSynthElapsedMs !== undefined) {
      const val = this.lastTtsSynthElapsedMs;
      return Promise.resolve(val);
    }
    return new Promise<number | undefined>((resolve) => {
      const timer = setTimeout(() => {
        this.ttsSynthResolve = undefined;
        resolve(undefined);
      }, timeoutMs);
      this.ttsSynthResolve = (elapsedMs: number) => {
        clearTimeout(timer);
        resolve(elapsedMs);
      };
    });
  }

  /**
   * Wait until Jambonz reports that a non-streaming filler prompt finished.
   * The timeout is intentionally bounded so a missing verb:status cannot stall a call turn.
   */
  private waitForTtsPlaybackStopEvent(
    timeoutMs: number,
  ): Promise<'stop-playback' | 'kill-playback' | 'timeout'> {
    return new Promise<'stop-playback' | 'kill-playback' | 'timeout'>((resolve) => {
      const timer = setTimeout(() => {
        this.ttsPlaybackResolve = undefined;
        resolve('timeout');
      }, timeoutMs);

      this.ttsPlaybackResolve = (event) => {
        clearTimeout(timer);
        resolve(event);
      };
    });
  }

  private estimateFillerPlaybackWaitMs(text: string): number {
    const words = text.trim().split(/\s+/).filter(Boolean).length;
    const estimatedMs = words * FILLER_PLAYBACK_WORD_MS + FILLER_PLAYBACK_BUFFER_MS;
    return Math.max(
      FILLER_PLAYBACK_MIN_WAIT_MS,
      Math.min(FILLER_PLAYBACK_MAX_WAIT_MS, estimatedMs),
    );
  }

  /**
   * Handle verb:hook event - sticky gather detected speech
   *
   * Tracing: Each verb:hook is a complete voice turn. We instrument it with:
   * 1. OTEL spans (voice_turn → voice_stt → voice_llm → voice_tts)
   * 2. Trace events forwarded to TraceStore + ClickHouse via onTraceEvent
   * 3. Message persistence (user + assistant) to the DB session
   * 4. Turn metrics (tokens, latency) for analytics
   */
  private async handleVerbHook(msg: IncomingMessage) {
    const hookStartTime = Date.now();
    this.verbHookArrivalTime = hookStartTime; // E2E start marker (Metric 203)
    const wasBargeIn = this.lastBargeInDetected; // Consume barge-in flag (Metric 204)
    this.lastBargeInDetected = false;
    this.dropStreamingTokensUntilNextTurn = false;

    const data = msg.data || {};

    // ── CSAT DTMF gather intercept ─────────────────────────────────────────
    // If a CSAT gather is pending, route this verb:hook to its resolver
    // instead of the normal LLM turn pipeline.
    if (this.csatGatherResolve) {
      const resolver = this.csatGatherResolve;
      this.csatGatherResolve = undefined;
      const digits = (data.digits as string | undefined) ?? null;
      this.sendAck(msg.msgid);
      resolver(digits);
      return;
    }

    // ── Dial actionHook result (from /agent-dial-status) ───────────────────
    // When a dial verb completes (success or failure), jambonz delivers the
    // result as a verb:hook with dial_call_status / dial_sip_status fields.
    // Detect this before the speech/digits check so we don't discard SIP status.
    const dialCallStatus = data.dial_call_status as string | undefined;
    if (dialCallStatus) {
      const dialSipStatus = data.dial_sip_status as number | undefined;
      this.dialActive = false;

      log.info('[DIAL-RESULT] Agent dial actionHook received', {
        callSid: this.config.callSid,
        dialCallStatus,
        dialSipStatus,
        dialCallSid: data.dial_call_sid,
        hook: msg.hook || data.hook,
        fullData: JSON.stringify(data),
      });

      // Dial completed successfully — mark session as escalated
      if (dialCallStatus === 'completed') {
        this.sessionOutcome = 'escalated';
      }

      this.sendAck(msg.msgid);

      if (dialCallStatus !== 'completed') {
        // Dial failed — clear transfer flag and resume bot conversation
        this.voiceTransferInitiated = false;
        log.warn('[DIAL-RESULT] Agent dial failed, resuming bot session', {
          callSid: this.config.callSid,
          dialCallStatus,
          dialSipStatus,
        });
        this.sendCommand('redirect', [
          this.buildListeningVerb(this.wsPath, { streaming: this.useStreaming }),
        ]);
      } else {
        // Dial completed — play a brief hold message WITHOUT barge-in config
        // so no spurious speech verb:hooks can interfere with CSAT's csatGatherResolve.
        this.sendCommand('redirect', [
          this.verbBuilder.say('Please hold for a moment.', { streaming: false }),
        ]);
      }
      return;
    }

    // ── Metric 209: Detect input method (speech vs DTMF) ────────────────────
    // Jambonz sends `data.digits` for DTMF input and `data.speech` for speech input.
    const digits = data.digits as string | undefined;
    const speech = data.speech as {
      alternatives?: Array<{ transcript: string; confidence?: number }>;
      language_code?: string;
    };

    let userInput: string;
    let confidence: number | undefined;
    let inputMethod: 'speech' | 'dtmf';

    if (digits) {
      // DTMF input — user pressed keypad digits instead of speaking
      userInput = digits.trim();
      confidence = 1.0; // DTMF is always 100% accurate
      inputMethod = 'dtmf';
      this.dtmfTurnCount++;
      log.info(`DTMF input: "${userInput}" (dtmfTurns: ${this.dtmfTurnCount})`);
    } else {
      // Speech input — extract transcript from alternatives array
      const transcript = speech?.alternatives?.[0]?.transcript;
      confidence = speech?.alternatives?.[0]?.confidence;

      if (!speech || !transcript) {
        log.warn(`No transcript or digits in verb hook for msgid=${msg.msgid}`);
        // Just ACK - sticky gather auto-restarts
        this.sendAck(msg.msgid);
        return;
      }

      userInput = transcript.trim();
      inputMethod = 'speech';
      log.info(`Transcript: "${userInput.substring(0, 80)}..." (confidence: ${confidence})`);
    }
    const reportedSpeechLanguage =
      inputMethod === 'speech' ? normalizeSpeechLanguageCode(speech?.language_code) : undefined;

    this.lastInputMethod = inputMethod;

    if (this.voiceTransferInitiated) {
      log.info('[TRANSFER-GUARD] Suppressing voice turn during transfer phase', {
        sessionId: this.config.sessionId,
        userInput: userInput.substring(0, 80),
        hookTransport: this.activeHookTransport,
      });
      const holdMsg = 'Please continue to hold. An agent will be with you shortly.';
      const holdVerbs = this.buildBufferedSpeechVerbs(holdMsg);
      if (this.config.bargeIn !== false) {
        holdVerbs.push(this.verbBuilder.buildStreamingConfig(this.wsPath, { streaming: false }));
      }

      this.sendAck(msg.msgid);
      this.sendCommand('redirect', holdVerbs);
      return;
    }

    // ── Jambonz STT Latency (Silero VAD reference clock) ─────────────────────
    // When notifySttLatency is enabled, Jambonz sends real STT latency measured as
    // the gap between VAD stop_talking_time and transcription receipt time.
    // stt_latency_ms is a comma-separated string (one value per final transcript in the gather).
    const sttLatencyMs = parseSttLatencyMs(data.stt_latency_ms as string | undefined);

    // ── Flux/STT Turn Detection Timing ─────────────────────────────────────────
    // Measures gap from agent done speaking to verb:hook arrival.
    // With Flux: ~500-900ms turn detection. With Nova + timers: ~600-1500ms.
    const sttModel = this.config.sttModel || 'default';
    const turnDetectionGapMs = this.lastTtsActivityTime
      ? hookStartTime - this.lastTtsActivityTime
      : undefined;
    log.debug(
      `[STT-TIMING] model=${sttModel}, turn=${this.turnCount + 1}, ` +
        `sttLatencyMs=${sttLatencyMs ?? 'n/a'}, ` +
        `turnDetectionGap=${turnDetectionGapMs ?? 'n/a'}ms, ` +
        `confidence=${confidence ?? 'n/a'}`,
    );

    // ── Metric 207: Track first user speech to end greeting phase ───────────────
    if (!this.hasUserSpoken) {
      this.hasUserSpoken = true;
      if (this.callPhase === 'greeting') {
        this.callPhase = 'conversation';
        log.info('[PHASE] Greeting → Conversation (first user input)');
      }
    }

    // ── Metric 205: Compute waiting silence (gap between agent done → user speech end) ──
    // The gap between the last TTS activity (flush/stop-playback/barge-in) and this
    // verb:hook arrival includes: remaining TTS playback + user think time + user speaking
    // + STT processing. Subtract estimated user speaking to isolate waiting silence.
    if (this.lastTtsActivityTime) {
      const gapMs = hookStartTime - this.lastTtsActivityTime;
      const userWords = userInput.split(/\s+/).filter(Boolean).length;
      const userSpeakingEstimate = Math.min(gapMs, userWords * 400); // Cap at actual gap
      const waitingSilence = Math.max(0, gapMs - userSpeakingEstimate);
      this.silenceAccumulatedMs += waitingSilence;
      this.userSpeakingTotalMs += userSpeakingEstimate;
      log.info(
        `[SILENCE] Waiting gap: ${gapMs}ms, userEst: ${userSpeakingEstimate}ms, silence: ${waitingSilence}ms (total: ${this.silenceAccumulatedMs}ms)`,
      );
    }

    // ── OTEL: Start voice turn ──────────────────────────────────────────────
    this.turnCount++;
    const turnCtx = startVoiceTurn(this.config.sessionId, userInput);

    // STT phase: already complete by the time verb:hook fires (Jambonz did it).
    // sttLatencyMs is the real Jambonz-measured latency (VAD stop → transcript received).
    // Set sttStartTime so calculateTimingBreakdown computes sttLatency correctly.
    if (sttLatencyMs) {
      turnCtx.sttStartTime = Date.now() - sttLatencyMs;
    }
    completeSTTPhase(turnCtx, {
      transcript: userInput,
      confidence: confidence ?? 0,
      durationMs: sttLatencyMs ?? 0,
    });

    // ── Voice trace: STT complete ─────────────────────────────────────────────
    this.emitVoiceTraceEvent('voice_stt', {
      turnId: turnCtx.turnId,
      turn: this.turnCount,
      transcript: userInput.substring(0, 500),
      confidence: confidence ?? 0,
      provider: inputMethod === 'dtmf' ? 'dtmf' : this.config.sttVendor || 'deepgram',
      language: speech?.language_code,
      normalizedLanguage: reportedSpeechLanguage?.language,
      normalizedLocale: reportedSpeechLanguage?.locale,
      inputMethod, // Metric 209: 'speech' or 'dtmf'
      sttLatencyMs,
      sttModel,
    });

    // Send immediate ACK to keep msgid alive
    this.sendAck(msg.msgid);
    const dbSessionReady = this.ensureDBSession();

    // ── Trace accumulator for token/cost tracking ───────────────────────────
    const acc = createTraceAccumulator();
    let inFlightFillerPlayback: Promise<void> = Promise.resolve();

    // onTraceEvent: accumulate locally + forward to centralized handler
    const onTraceEvent = (event: { type: string; data: Record<string, unknown> }) => {
      accumulateTraceEvent(acc, event);

      if (event.type === 'status_update' && typeof event.data.text === 'string') {
        const fillerText = event.data.text;
        // A barge-in stops the previous agent audio before this verb:hook is processed.
        // The filler belongs to the new processing window, so it should still play.
        inFlightFillerPlayback = inFlightFillerPlayback
          .then(() =>
            this.sendAgentMessage(fillerText, {
              waitForPlayback: !this.useStreaming,
            }),
          )
          .catch((err) => {
            log.warn('[FILLER] Failed to wait for filler playback', {
              callSid: this.config.callSid,
              err: err instanceof Error ? err.message : String(err),
            });
          });
      }

      // ── Metric 207: Monitor agent_enter events for phase detection ────────────
      if (event.type === 'agent_enter' && event.data.agentName) {
        const agentName = event.data.agentName as string;
        this.currentAgentName = agentName;

        const detectedPhase = detectPhaseFromAgent(agentName);
        if (detectedPhase) {
          const oldPhase = this.callPhase;
          this.callPhase = detectedPhase;
          log.info(`[PHASE] ${oldPhase} → ${detectedPhase} (agent: ${agentName})`);
        }
      }
    };

    try {
      // Clear any stale buffer from previous response, but DO NOT reset ttsStreamOpen.
      // The ttsStreamOpen state is managed solely by handleTtsStreamingEvent.
      // If the TTS stream is still open from greeting/previous response, we send
      // chunks directly. If it closed (ElevenLabs idle timeout), handleTtsStreamingEvent
      // will have set ttsStreamOpen=false and re-established the connection.
      this.ttsBuffer = [];
      // Reset per-turn connection time (will be set if reconnection happens during this turn)
      this.turnTtsConnectionMs = undefined;

      const executor = this.executor;
      let runtimeSession: RuntimeSession | undefined;
      const sessionLocator = buildProductionSessionLocator({
        tenantId: this.config.tenantId,
        projectId: this.config.projectId,
        sessionId: this.config.sessionId,
      });
      if (executor) {
        runtimeSession =
          executor.getSession(this.config.sessionId) ??
          (await executor.rehydrateSession(
            this.config.sessionId,
            sessionLocator ? { locator: sessionLocator } : undefined,
          )) ??
          undefined;
        this.applyConversationBehaviorVoiceRuntimeConfig(runtimeSession);
        this.forceNonStreamingWhenBargeInDisabled('voice_turn_start');
      } else {
        log.warn('Runtime executor unavailable during KoreVG voice turn', {
          sessionId: this.config.sessionId,
        });
      }
      const ttsLanguageResolution = await resolveTtsLanguageForVoiceTurn({
        ttsVendor: this.config.ttsVendor,
        ttsVoice: this.config.ttsVoice,
        configuredLanguage: this.getConfiguredTtsLanguage(),
        tenantId: this.config.tenantId,
        reportedLanguage: reportedSpeechLanguage,
      });
      this.currentTurnTtsLanguage = ttsLanguageResolution.languageChanged
        ? ttsLanguageResolution.effectiveLanguage
        : undefined;
      this.emitTtsLanguageResolutionTrace(turnCtx.turnId, ttsLanguageResolution);

      log.info(
        `[VOICE-TURN] Starting LLM call, ttsStreamOpen=${this.ttsStreamOpen}, streaming=${this.useStreaming}`,
      );

      // Ensure TTS stream is ready before LLM starts generating chunks
      this.ensureStreamingTtsReady('turn_start');

      // ── OTEL: Start LLM phase ──────────────────────────────────────────────
      startLLMPhase(turnCtx);

      let responseText = '';
      const startTime = Date.now();
      let chunkCount = 0;
      let directSentCount = 0;
      let firstChunkTime: number | null = null;

      // Only pass onChunk when streaming — this controls BOTH:
      // 1. LLM client: streamText() vs generateText()
      // 2. Flow executor: RESPOND text delivery via chunks vs result.response
      const onChunk = this.useStreaming
        ? (chunk: string) => {
            if (this.dropStreamingTokensUntilNextTurn) {
              log.debug(`[TTS-TOKENS] Dropping chunk after user interrupt: ${chunk.length} chars`);
              return;
            }
            chunkCount++;
            responseText += chunk;

            if (!firstChunkTime) {
              firstChunkTime = Date.now() - startTime;

              // ── E2E latency (streaming): verb:hook → first TTS tokens sent ──
              if (this.verbHookArrivalTime) {
                this.lastE2eLatencyMs = Date.now() - this.verbHookArrivalTime;
                // Metric 205: Processing silence = E2E gap (caller hears nothing)
                this.silenceAccumulatedMs += this.lastE2eLatencyMs;
                this.processingTotalMs += this.lastE2eLatencyMs;
              }
              // Agent starts speaking (approximately) when first tokens are sent
              this.agentSpeakingStartTime = Date.now();

              log.info(
                `[STREAMING] First LLM chunk at ${firstChunkTime}ms, E2E=${this.lastE2eLatencyMs}ms`,
              );

              completeLLMPhase(turnCtx, {
                response: chunk,
                durationMs: firstChunkTime,
              });

              startTTSPhase(turnCtx, this.config.ttsVendor || 'elevenlabs');
              // Reset first token flag for this turn's TTS phase
              this.ttsFirstTokenSent = false;
            }

            // Record first TTS chunk only when we actually send the first token
            if (this.ttsStreamOpen && !this.ttsFirstTokenSent) {
              this.ttsFirstTokenSent = true;
              recordTTSFirstChunk(turnCtx, chunk.length);
              directSentCount++;
              this.sendTtsTokens(chunk).catch((err: Error) =>
                log.error('Error sending TTS tokens', {
                  sessionId: this.config.sessionId,
                  error: err.message,
                }),
              );
            } else if (this.ttsStreamOpen) {
              directSentCount++;
              this.sendTtsTokens(chunk).catch((err: Error) =>
                log.error('Error sending TTS tokens', {
                  sessionId: this.config.sessionId,
                  error: err.message,
                }),
              );
            } else {
              this.ttsBuffer.push(chunk);
              this.ensureStreamingTtsReady('llm_chunk_buffered');
            }
          }
        : undefined;

      let result:
        | {
            response?: string;
            action: { type: string };
            stateUpdates?: unknown;
            voiceConfig?: unknown;
            richContent?: unknown;
            actions?: unknown;
            responseMetadata?: ResponseMessageMetadata;
          }
        | undefined;

      const coordinatorResult = executor
        ? await executeVoiceTurn({
            channelType: 'korevg',
            executor,
            sessionId: this.config.sessionId,
            utterance: userInput,
            timeoutMs: WS_MESSAGE_TIMEOUT_MS,
            promptProfile: 'pipeline',
            onChunk,
            onTraceEvent,
            executeOptions: {
              ...(sessionLocator ? { sessionLocator } : {}),
              ...(reportedSpeechLanguage ? { interactionContextHint: reportedSpeechLanguage } : {}),
              channelMetadata: {
                channel: 'voice',
                contentLength: userInput.length,
              },
            },
          })
        : {
            outcome: buildErrorOutcome({
              channelType: 'korevg',
              error: new Error('Voice runtime session is no longer available.'),
            }),
            runtimeSession,
            executionResult: undefined,
            diagnostics: [],
          };

      const outcome = coordinatorResult.outcome;
      const resolvedRuntimeSession =
        coordinatorResult.runtimeSession ??
        executor?.getSession(this.config.sessionId) ??
        runtimeSession;
      this.applyConversationBehaviorVoiceRuntimeConfig(resolvedRuntimeSession);
      recordOutcomeTrace({
        sessionId: this.config.sessionId,
        session: resolvedRuntimeSession ?? undefined,
        outcome,
        onTraceEvent,
      });

      result = coordinatorResult.executionResult;

      if (!outcome) {
        throw new Error('Voice outcome was not produced for the KoreVG turn.');
      }

      if (!result) {
        result = {
          response: outcome.responseText,
          action: { type: 'continue' },
          stateUpdates: undefined,
          voiceConfig: outcome.voiceConfig,
          richContent: outcome.richContent,
          actions: outcome.actions,
        };
      }

      const rawFinalResponse = outcome.responseText || responseText || result.response || '';
      const resolvedVoiceText = getChannelAdapterRegistry().resolve(
        { text: rawFinalResponse, voiceConfig: outcome.voiceConfig },
        { channelType: 'korevg' },
      );

      if (this.useStreaming && chunkCount === 0 && resolvedVoiceText) {
        onChunk?.(resolvedVoiceText);
      }

      const totalTime = Date.now() - startTime;
      const finalResponse =
        chunkCount > 0 ? responseText || rawFinalResponse : resolvedVoiceText || rawFinalResponse;

      // ── Metric 207: Extract agent name from result if available ───────────────
      const stateUpdates = (result as any).stateUpdates;

      // ── Metric 207: Detect transfer phase from handoff context ────────────
      // Check if we're in a transfer flow by looking at handoff context
      if (stateUpdates && stateUpdates.context) {
        const context = stateUpdates.context as Record<string, unknown>;
        const handoffFrom = context.handoff_from as string | undefined;
        const handoffSummary = context._handoff_summary as string | undefined;

        // If there's a handoff happening, transition to transfer phase
        if (handoffFrom && this.callPhase !== 'transfer') {
          const oldPhase = this.callPhase;
          this.callPhase = 'transfer';
          log.info(`[PHASE] ${oldPhase} → transfer (handoff detected from: ${handoffFrom})`);
          log.debug('KoreVG handoff summary detected', {
            sessionId: this.config.sessionId,
            handoffSummary,
          });
        }
      }

      // Try to extract agent name from stateUpdates.currentAgent
      if (stateUpdates && stateUpdates.currentAgent) {
        const agentName = stateUpdates.currentAgent;
        if (agentName && agentName !== this.currentAgentName) {
          this.currentAgentName = agentName;
          const detectedPhase = detectPhaseFromAgent(agentName);
          if (detectedPhase) {
            const oldPhase = this.callPhase;
            this.callPhase = detectedPhase;
            log.info(`[PHASE] ${oldPhase} → ${detectedPhase} (agent: ${agentName})`);
          }
        }
      }

      log.info(
        `[VOICE-TURN] Complete: ${totalTime}ms, streaming=${this.useStreaming}, chunks=${chunkCount}`,
      );

      // ── Voice Tool Result Dispatch ────────────────────────────────────────
      // If a voice tool (IVR menu, call transfer, etc.) ran, its VoiceToolResult
      // must be translated into Jambonz verbs (gather, dial, refer, hangup).
      const voiceToolResult = this.extractVoiceToolResult(result as any);
      if (voiceToolResult) {
        const consumed = await this.handleVoiceToolResult(voiceToolResult);
        if (consumed) {
          completeVoiceTurn(turnCtx);
          return;
        }
      }

      // ── OOB Flag Routing ──────────────────────────────────────────────────
      const oobFlags = this.extractOOBFlags(result as any);
      if (oobFlags) {
        const consumed = this.handleOOBFlags(oobFlags);
        if (consumed) {
          // OOB handler sent its own verbs (e.g., hangup) — skip normal TTS
          completeVoiceTurn(turnCtx);
          return;
        }
      }

      await inFlightFillerPlayback;

      // ── TTS delivery ──────────────────────────────────────────────────────
      if (this.useStreaming) {
        // Complete LLM phase tracing
        if (chunkCount === 0) {
          completeLLMPhase(turnCtx, {
            response: finalResponse,
            tokensIn: acc.tokensIn,
            tokensOut: acc.tokensOut,
            durationMs: totalTime,
          });
        } else {
          turnCtx.llmTokensIn = acc.tokensIn;
          turnCtx.llmTokensOut = acc.tokensOut;
        }

        log.info(
          `[STREAMING] Complete: ${totalTime}ms, ${chunkCount} chunks (${directSentCount} direct, ${this.ttsBuffer.length} buffered), LLM first token: ${firstChunkTime || 'N/A'}ms, TTS connection: ${this.ttsConnectionMs ?? 'N/A'}ms`,
        );

        // Flush any remaining buffered chunks
        if (this.ttsBuffer.length > 0) {
          if (this.ttsStreamOpen) {
            log.info(`[STREAMING] Flushing ${this.ttsBuffer.length} buffered chunks (stream open)`);
            for (let i = 0; i < this.ttsBuffer.length; i++) {
              const chunk = this.ttsBuffer[i];
              // Record first TTS chunk when sending the first buffered chunk
              if (i === 0 && !this.ttsFirstTokenSent) {
                this.ttsFirstTokenSent = true;
                recordTTSFirstChunk(turnCtx, chunk.length);
              }
              await this.sendTtsTokens(chunk);
            }
            this.ttsBuffer = [];
            this.sendTtsFlush();
            // Metric 205: Mark TTS activity for silence gap tracking
            this.lastTtsActivityTime = Date.now();
          } else {
            log.info(`[STREAMING] ${this.ttsBuffer.length} chunks waiting for stream reconnect`);
            this.ensureStreamingTtsReady('turn_complete_with_buffer');
          }
        } else if (chunkCount > 0) {
          this.sendTtsFlush();
          // Metric 205: Mark TTS activity for silence gap tracking
          this.lastTtsActivityTime = Date.now();
        }
      } else {
        // Non-streaming: LLM phase = entire executeMessage duration
        completeLLMPhase(turnCtx, {
          response: finalResponse,
          tokensIn: acc.tokensIn,
          tokensOut: acc.tokensOut,
          durationMs: totalTime,
        });

        log.info(
          `[NON-STREAMING] Complete: ${totalTime}ms, response: ${finalResponse.length} chars`,
        );

        startTTSPhase(turnCtx, this.config.ttsVendor || 'elevenlabs');

        if (finalResponse) {
          // Reset before sending so we capture the new event, not a stale one
          this.lastTtsSynthElapsedMs = undefined;
          this.saySentTime = Date.now();

          const bufferedSpeechVerbs = this.buildBufferedSpeechVerbs(finalResponse);
          this.sendCommand('redirect', bufferedSpeechVerbs);

          // Wait for Jambonz verb:status synthesized-audio event to get real TTS TTFB
          const ttfbMs = await this.waitForTtsSynthEvent(10000);
          log.info(`[NON-STREAMING] TTS TTFB from Jambonz: ${ttfbMs ?? 'timeout'}ms`);
        } else {
          log.error(`[NON-STREAMING] No response text available`);
          this.sendCommand(
            'redirect',
            this.buildBufferedSpeechVerbs(
              "I'm sorry, I didn't get a response. Could you try again?",
            ),
          );
          completeVoiceTurn(turnCtx);
          return;
        }
      }

      // ── OTEL: Complete TTS phase ────────────────────────────────────────────
      completeTTSPhase(turnCtx);

      // ── Voice trace: TTS complete ──────────────────────────────────────────
      const ttsElapsed =
        turnCtx.ttsEndTime && turnCtx.ttsStartTime ? turnCtx.ttsEndTime - turnCtx.ttsStartTime : 0;
      // Use per-turn connection time if reconnection happened during this turn,
      // otherwise use the initial/cached connection time
      const turnConnectionMs = this.turnTtsConnectionMs ?? this.ttsConnectionMs;
      this.emitVoiceTraceEvent(
        'voice_tts',
        {
          turnId: turnCtx.turnId,
          turn: this.turnCount,
          provider: this.config.ttsVendor || 'elevenlabs',
          voice: this.config.ttsVoice,
          language: ttsLanguageResolution.effectiveLanguage,
          configuredLanguage: ttsLanguageResolution.configuredLanguage,
          languageResolutionReason: ttsLanguageResolution.reason,
          chunks: chunkCount,
          directSent: directSentCount,
          buffered: this.ttsBuffer.length,
          firstChunkMs: this.useStreaming
            ? firstChunkTime
            : this.lastTtsSynthElapsedMs || undefined,
          connectionMs: this.useStreaming ? turnConnectionMs || undefined : undefined,
          durationMs: this.useStreaming ? ttsElapsed : totalTime,
          streaming: this.useStreaming,
          responseLength: finalResponse.length,
          text: finalResponse.substring(0, 500),
        },
        this.useStreaming ? ttsElapsed : totalTime,
      );

      // Reset TTS synth elapsed time (non-streaming only)
      // Keep ttsConnectionMs for subsequent turns (amortized connection cost)
      this.lastTtsSynthElapsedMs = undefined;

      // ── OTEL: Complete voice turn with timing breakdown ───────────────────
      const breakdown = completeVoiceTurn(turnCtx);

      // ── Metric 202: Compute TTS Proxy MOS Score ───────────────────────────
      // TTS TTFB calculation (TTS-specific delays only, LLM latency tracked separately):
      //   Streaming: TTS connection time (if reconnection happened during turn)
      //   Non-streaming: Actual TTS audio synthesis latency from start-playback event
      const ttsFirstChunkMs = this.useStreaming
        ? 0 // Streaming: No measurable TTS chunk latency (Jambonz synthesizes server-side)
        : breakdown.ttsFirstChunkLatency; // Non-streaming: TTS audio latency
      const ttsConnectionMs = this.useStreaming ? turnConnectionMs || 0 : 0;
      const ttsTotalTtfb = ttsFirstChunkMs + ttsConnectionMs;

      const proxyMosInputs: TtsProxyInputs = {
        ttfbMs: ttsTotalTtfb || undefined,
        connectionMs: ttsConnectionMs || undefined,
        chunkCount,
        streaming: this.useStreaming,
        hasError: false, // TODO: Track TTS errors
        bargeInOnAgent: wasBargeIn, // Current turn had barge-in
      };

      const proxyMos = computeTtsProxyMos(proxyMosInputs);

      // Log proxy MOS for debugging
      log.info('[TTS-QUALITY] Proxy MOS computed', {
        turnId: turnCtx.turnId,
        proxyMos: +proxyMos.toFixed(2),
        ttsTotalTtfb,
        ttsFirstChunkMs,
        ttsConnectionMs,
        llmFirstChunkMs: firstChunkTime,
        chunkCount,
        streaming: this.useStreaming,
      });

      // Track for session-level aggregation
      this.ttsProxyMosTotal += proxyMos;
      this.ttsProxyMosCount++;
      if (ttsTotalTtfb) {
        this.ttsTotalTtfbMs += ttsTotalTtfb;
        this.ttsTtfbCount++;
      }

      // Emit TTS quality trace event (Metric 202)
      this.emitVoiceTraceEvent('voice_tts_quality', {
        turnId: turnCtx.turnId,
        turn: this.turnCount,
        proxyMos: +proxyMos.toFixed(2),
        ttsTotalTtfb: ttsTotalTtfb || null,
        ttsFirstChunkMs: ttsFirstChunkMs || null,
        ttsConnectionMs: ttsConnectionMs || null,
        llmFirstChunkMs: firstChunkTime || null,
        chunkCount,
        streaming: this.useStreaming,
        hasError: false,
        bargeInOnTurn: wasBargeIn,
      });
      log.info(`[TRACE] Voice turn complete`, {
        turnId: turnCtx.turnId,
        sttModel,
        totalLatency: breakdown.totalLatency,
        sttLatency: breakdown.sttLatency,
        llmLatency: breakdown.llmLatency,
        ttsLatency: breakdown.ttsLatency,
        tokensIn: acc.tokensIn,
        tokensOut: acc.tokensOut,
      });

      // ── Voice trace: Turn summary ──────────────────────────────────────────
      this.emitVoiceTraceEvent(
        'voice_turn',
        {
          turnId: turnCtx.turnId,
          turn: this.turnCount,
          utterance: userInput.substring(0, 500),
          response: finalResponse.substring(0, 500),
          timing: {
            total: breakdown.totalLatency,
            serverProcessing: breakdown.serverProcessingTime,
            stt: breakdown.sttLatency,
            llm: breakdown.llmLatency,
            tts: breakdown.ttsLatency,
            ttsFirstChunk: breakdown.ttsFirstChunkLatency,
            ttsConnection: turnConnectionMs || undefined,
            overhead: breakdown.overhead,
            e2e: this.lastE2eLatencyMs || undefined, // Metric 203
          },
          tokens: { in: acc.tokensIn, out: acc.tokensOut },
          cost: acc.cost,
          chunkCount,
          streaming: this.useStreaming,
          bargeIn: wasBargeIn || undefined, // Metric 204: this turn was triggered by barge-in
          inputMethod, // Metric 209: 'speech' or 'dtmf'
          channel: 'voice',
          sttModel,
        },
        breakdown.totalLatency,
      );

      // ── Accumulate E2E stats for session-level average ──────────────────
      if (this.lastE2eLatencyMs) {
        this.e2eTotalMs += this.lastE2eLatencyMs;
        this.e2eCount++;
        // Note: processing silence already accumulated at first-chunk/start-playback
      }
      this.lastE2eLatencyMs = undefined;
      this.verbHookArrivalTime = undefined;
      // Note: user speaking already accumulated at verb:hook start; agent speaking
      // is derived as residual in session end (avoids word-count overestimation)

      // ── Metric 207: Query TraceStore for agent_enter events to update call phase ──
      try {
        const traceStore = getTraceStore();
        if (traceStore) {
          const eventsOrPromise = traceStore.getEvents(this.config.sessionId);
          const events =
            eventsOrPromise instanceof Promise ? await eventsOrPromise : eventsOrPromise;
          log.debug('KoreVG TraceStore event count', {
            sessionId: this.config.sessionId,
            eventCount: events.length,
          });

          // Find the most recent agent_enter event
          const agentEnterEvents = events.filter((e: any) => e.type === 'agent_enter').reverse();
          log.debug('KoreVG agent_enter event count', {
            sessionId: this.config.sessionId,
            agentEnterCount: agentEnterEvents.length,
          });

          if (agentEnterEvents.length > 0) {
            const latestAgent = agentEnterEvents[0];
            log.debug('KoreVG latest agent_enter event', {
              sessionId: this.config.sessionId,
              agentName: latestAgent.agentName,
              dataAgentName: (latestAgent.data as any)?.agentName,
              type: latestAgent.type,
            });

            const agentName = latestAgent.agentName || (latestAgent.data as any)?.agentName;
            if (agentName && agentName !== this.currentAgentName) {
              this.currentAgentName = agentName;
              const detectedPhase = detectPhaseFromAgent(agentName);
              log.debug('KoreVG detected phase from agent', {
                sessionId: this.config.sessionId,
                agentName,
                detectedPhase,
              });

              if (detectedPhase) {
                const oldPhase = this.callPhase;
                this.callPhase = detectedPhase;
                log.info(`[PHASE] ${oldPhase} → ${detectedPhase} (agent: ${agentName})`);
              }
            } else {
              log.debug('KoreVG agent phase unchanged', {
                sessionId: this.config.sessionId,
                currentAgentName: this.currentAgentName,
                nextAgentName: agentName,
              });
            }
          }
        }
      } catch (err) {
        log.warn('[PHASE] Failed to query TraceStore for agent info', { error: err });
      }

      // ── Persist messages & turn metrics ───────────────────────────────────
      const assistantResponseMetadata = outcome.responseMetadata ?? result?.responseMetadata;
      void dbSessionReady
        .then(() => {
          if (!this.dbSessionId) {
            return;
          }

          persistMessage(
            this.dbSessionId,
            'user',
            userInput,
            'voice',
            this.config.tenantId,
            undefined,
            undefined,
            this.config.projectId,
          ).catch((err: unknown) =>
            log.warn('[PERSIST] User message persist failed', {
              err: err instanceof Error ? err.message : String(err),
            }),
          );

          if (finalResponse) {
            persistMessage(
              this.dbSessionId,
              'assistant',
              finalResponse,
              'voice',
              this.config.tenantId,
              undefined,
              undefined,
              this.config.projectId,
              undefined,
              buildPersistedMessageStructuredContent({
                richContent: outcome.richContent,
                actions: outcome.actions,
                voiceConfig: outcome.voiceConfig,
                localization: outcome.localization,
              }),
              assistantResponseMetadata,
            ).catch((err: unknown) =>
              log.warn('[PERSIST] Assistant message persist failed', {
                err: err instanceof Error ? err.message : String(err),
              }),
            );
          }

          persistTurnMetrics({
            dbSessionId: this.dbSessionId,
            tenantId: this.config.tenantId,
            tokensIn: acc.tokensIn,
            tokensOut: acc.tokensOut,
            cost: acc.cost,
            traceEventCount: acc.traceCount,
            errorCount: acc.errorCount,
            handoffCount: acc.handoffCount,
          }).catch((err: unknown) =>
            log.warn('[PERSIST] Turn metrics persist failed', {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
        })
        .catch((err: unknown) =>
          log.warn('[PERSIST] Voice turn persistence setup failed', {
            err: err instanceof Error ? err.message : String(err),
          }),
        );

      // ── Metric 201: Collect ASR turn data for quality analysis ────────────
      // Note: We use successful response as a proxy for intent matched
      // In the future, extract actual NLU results if available
      const asrTurnData: ASRTurnData = {
        transcript: userInput,
        confidence: inputMethod === 'dtmf' ? 1.0 : confidence,
        intentMatched: !!finalResponse && finalResponse.length > 0, // Proxy: agent responded
        slotsFilled: 0, // TODO: Extract from NLU results when available
        totalSlots: 0, // TODO: Extract from NLU results when available
      };
      this.asrTurns.push(asrTurnData);

      // ── Metric 210: ASR Cascade Detection ──────────────────────────────────
      // Detect cascade failures: bad network → bad audio → wrong ASR → wrong intent
      if (inputMethod !== 'dtmf') {
        // Only analyze voice input, not DTMF
        const cascadeTurnData: CascadeTurnData = {
          transcript: userInput,
          confidence: confidence,
          inboundNetworkMos: this.inboundNetworkMos ?? undefined, // From Homer RTCP data (convert null to undefined)
          wordCount: userInput
            .trim()
            .split(/\s+/)
            .filter((w) => w.length > 0).length,
          agentResponseLength: finalResponse
            ? finalResponse
                .trim()
                .split(/\s+/)
                .filter((w) => w.length > 0).length
            : 0, // Count words, not characters
          agentAskedForClarification: this.detectClarificationRequest(finalResponse || ''),
        };

        const cascadeRisk = this.cascadeDetector.detectCascadeRisk(cascadeTurnData);

        // Emit trace event only for medium/high risk turns
        if (cascadeRisk.risk !== 'low') {
          this.cascadeRiskTurns++;
          this.emitVoiceTraceEvent('voice_asr_cascade', {
            turnIndex: this.turnCount,
            cascadeRisk: cascadeRisk.risk,
            riskScore: cascadeRisk.score,
            contributingFactors: cascadeRisk.factors,
            networkQuality: cascadeRisk.networkQuality,
            rootCause: cascadeRisk.rootCause,
            recommendation: cascadeRisk.recommendation,
            transcript: userInput,
            agentResponse: finalResponse ? finalResponse.substring(0, 200) : '', // First 200 chars
            confidence: confidence,
            inboundNetworkMos: this.inboundNetworkMos,
          });

          log.info(
            `[CASCADE] ${cascadeRisk.risk.toUpperCase()} risk detected on turn ${this.turnCount}`,
            {
              score: cascadeRisk.score,
              factors: cascadeRisk.factors,
              rootCause: cascadeRisk.rootCause,
              networkQuality: cascadeRisk.networkQuality,
            },
          );
        }
      }

      // ── Metric 206: Detect session outcome (containment tracking) ─────────
      // ── Metric 207: Infer call phase from action type ──────────────────────
      if (result.action.type === 'complete') {
        log.info(`[SESSION] Conversation complete - contained`);
        this.sessionOutcome = 'completed'; // ✅ Contained: AI resolved the issue

        // Heuristic: complete action typically indicates farewell phase
        if (this.callPhase !== 'farewell') {
          const oldPhase = this.callPhase;
          this.callPhase = 'farewell';
          log.info(`[PHASE] ${oldPhase} → farewell (complete action detected)`);
        }

        this.sendCommand('redirect', [this.verbBuilder.hangup()]);
      } else if (result.action.type === 'escalate') {
        log.info(`[SESSION] Initiating escalation to human agent`, {
          reason: (result.action as any).reason,
          priority: (result.action as any).priority,
        });
        // Don't set outcome yet - will be determined in handleClose() based on disconnect initiator
        // If transfer completes → 'escalated', if user hangs up → 'abandoned'

        // Metric 207: Escalation indicates transfer phase
        if (this.callPhase !== 'transfer') {
          const oldPhase = this.callPhase;
          this.callPhase = 'transfer';
          log.info(`[PHASE] ${oldPhase} → transfer (escalate action detected)`);
          log.debug('KoreVG transfer phase assigned from escalate action', {
            sessionId: this.config.sessionId,
            callPhase: this.callPhase,
            sessionOutcome: this.sessionOutcome,
          });
        }

        this.voiceTransferInitiated = true;

        const escalateMsg =
          "I'll transfer you to a live agent who can better assist you. Please hold.";
        const escalateVerbs = this.buildBufferedSpeechVerbs(escalateMsg);
        if (this.config.bargeIn !== false) {
          escalateVerbs.push(
            this.verbBuilder.buildStreamingConfig(this.wsPath, { streaming: false }),
          );
        }
        this.sendCommand('redirect', escalateVerbs);
      }

      log.info(`[TIMING] Total: ${Date.now() - hookStartTime}ms`);
    } catch (err) {
      log.error('KoreVG voice turn processing failed', {
        sessionId: this.config.sessionId,
        elapsedMs: Date.now() - hookStartTime,
        error: err instanceof Error ? err.message : String(err),
      });

      // ── OTEL: Mark turn as failed ───────────────────────────────────────────
      failVoiceTurn(turnCtx, err instanceof Error ? err : String(err));

      const errorOutcome = buildErrorOutcome({
        channelType: 'voice',
        error: err,
        session: this.executor?.getSession(this.config.sessionId),
      });
      recordOutcomeTrace({
        sessionId: this.config.sessionId,
        session: this.executor?.getSession(this.config.sessionId),
        outcome: errorOutcome,
        onTraceEvent,
      });
      this.sendCommand('redirect', this.buildBufferedSpeechVerbs(errorOutcome.responseText));
    } finally {
      this.currentTurnTtsLanguage = undefined;
    }
  }

  /**
   * Send ack response to Jambonz
   */
  private sendAck(msgid: string, verbs?: VerbResponse[] | Record<string, unknown>) {
    if (this.activeHookTransport === 'http') {
      if (verbs) {
        this.bufferHttpHookVerbs(verbs);
      }
      return;
    }

    const response: { type: string; msgid: string; data?: unknown } = {
      type: 'ack',
      msgid,
    };

    if (verbs) {
      response.data = Array.isArray(verbs) ? verbs : [verbs];
    }

    try {
      this.ws.send(JSON.stringify(response));
    } catch (err) {
      log.error(`Error sending ack: ${err}`);
    }
  }

  /**
   * Send command to Jambonz (for mid-call updates)
   */
  private sendCommand(command: string, payload: VerbResponse[] | Record<string, unknown>) {
    if (this.activeHookTransport === 'http') {
      this.bufferHttpHookVerbs(payload);
      log.info(`[SEND-HOOK] ${command} with ${Array.isArray(payload) ? payload.length : 1} verbs`, {
        callSid: this.config.callSid,
        sessionId: this.config.sessionId,
      });
      return;
    }

    const msg = {
      type: 'command',
      command,
      queueCommand: false,
      data: Array.isArray(payload) ? payload : [payload],
    };

    try {
      if (this.ws.readyState !== 1) {
        log.error(`Cannot send command - WebSocket not open (readyState: ${this.ws.readyState})`);
        return;
      }
      log.info(
        `[SEND-CMD] ${command} with ${msg.data.length} verbs: ${JSON.stringify(msg.data).substring(0, 500)}`,
      );
      this.ws.send(JSON.stringify(msg));
    } catch (err) {
      log.error(`Error sending command ${command}: ${err}`);
    }
  }

  private bufferHttpHookVerbs(payload: VerbResponse[] | Record<string, unknown>): void {
    if (!this.bufferedHttpHookResponse) {
      this.bufferedHttpHookResponse = [];
    }

    const verbs = Array.isArray(payload) ? payload : [payload];
    this.bufferedHttpHookResponse.push(...(verbs as VerbResponse[]));
  }

  private getRuntimePublicBaseUrl(): string | null {
    const value = process.env.RUNTIME_PUBLIC_BASE_URL || process.env.RUNTIME_BASE_URL;
    if (!value || value.trim().length === 0) {
      return null;
    }
    return value.replace(/\/+$/, '');
  }

  private buildHttpHookUrl(hookName?: string): string | null {
    const baseUrl = this.getRuntimePublicBaseUrl();
    if (!baseUrl) {
      return null;
    }

    const suffix = hookName ? `/${hookName.replace(/^\/+/, '')}` : '';
    return `${baseUrl}/api/v1/voice/korevg/hook/${this.config.sessionId}${suffix}`;
  }

  public async handleHttpHook(
    data: Record<string, unknown>,
    hookName?: string,
  ): Promise<VerbResponse[]> {
    const normalizedHookName = hookName?.replace(/^\/+/, '');
    const speechPayload =
      data.speech && typeof data.speech === 'object' && !Array.isArray(data.speech)
        ? (data.speech as {
            alternatives?: Array<{ transcript?: string; confidence?: number }>;
            is_final?: boolean;
            language_code?: string;
          })
        : undefined;
    const transcriptPreview = speechPayload?.alternatives?.[0]?.transcript?.trim();
    const msg: IncomingMessage = {
      type: 'verb:hook',
      msgid: `http-hook-${randomUUID()}`,
      call_sid: this.config.callSid,
      hook: hookName ? `/${hookName.replace(/^\/+/, '')}` : undefined,
      data,
    };

    if (normalizedHookName === 'call-transcriptions') {
      await this.handleBridgedCallTranscriptionHook(data);
      return [];
    }

    log.info('[HTTP-HOOK] Processing KoreVG hook through voice session', {
      sessionId: this.config.sessionId,
      callSid: this.config.callSid,
      hook: msg.hook || '(root)',
      hasSpeech: Boolean(transcriptPreview),
      transcriptPreview: transcriptPreview ? transcriptPreview.substring(0, 80) : undefined,
      hasDigits: typeof data.digits === 'string' && data.digits.length > 0,
      hasDialStatus: typeof data.dial_call_status === 'string',
      bodyKeys: Object.keys(data),
    });

    this.activeHookTransport = 'http';
    this.bufferedHttpHookResponse = [];
    try {
      await this.handleVerbHook(msg);
      return this.bufferedHttpHookResponse ?? [];
    } finally {
      this.activeHookTransport = 'websocket';
      this.bufferedHttpHookResponse = null;
    }
  }

  private extractHookTranscriptContent(data: Record<string, unknown>): string | null {
    const speechPayload =
      data.speech && typeof data.speech === 'object' && !Array.isArray(data.speech)
        ? (data.speech as {
            alternatives?: Array<{ transcript?: string }>;
            transcript?: string;
          })
        : undefined;

    const transcriptCandidate =
      speechPayload?.alternatives?.[0]?.transcript ??
      speechPayload?.transcript ??
      (typeof data.transcript === 'string' ? data.transcript : undefined);
    const transcript = transcriptCandidate?.trim();

    return transcript && transcript.length > 0 ? transcript : null;
  }

  private parseHookMessageTimestamp(data: Record<string, unknown>): number | undefined {
    const candidates = [
      data.timestamp,
      data.ts,
      data.createdAt,
      data.updatedAt,
      data.time,
      data.eventTime,
      data.speech &&
      typeof data.speech === 'object' &&
      !Array.isArray(data.speech) &&
      'timestamp' in data.speech
        ? (data.speech as Record<string, unknown>).timestamp
        : undefined,
    ];

    for (const candidate of candidates) {
      if (typeof candidate !== 'string') {
        continue;
      }

      const parsed = Date.parse(candidate);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return undefined;
  }

  private buildVoiceTranscriptAgentInfo(data: Record<string, unknown>): Record<string, unknown> {
    const info: Record<string, unknown> = {};

    if (typeof data.memberId === 'string' && data.memberId.trim().length > 0) {
      info.memberId = data.memberId;
    }
    if (typeof data.memberUserId === 'string' && data.memberUserId.trim().length > 0) {
      info.memberUserId = data.memberUserId;
    }
    if (typeof data.member_name === 'string' && data.member_name.trim().length > 0) {
      info.memberName = data.member_name;
    }

    return info;
  }

  private classifyBridgedTranscriptParticipant(
    data: Record<string, unknown>,
    transferSession: import('@agent-platform/agent-transfer').TransferSessionData,
  ): BridgedTranscriptClassification | null {
    const memberName =
      typeof data.member_name === 'string' && data.member_name.trim().length > 0
        ? data.member_name.trim()
        : undefined;
    if (memberName === 'externalAgent') {
      return {
        participant: 'human_agent',
        source: 'explicit_identity',
      };
    }

    const memberUserId =
      typeof data.memberUserId === 'string' && data.memberUserId.trim().length > 0
        ? data.memberUserId.trim()
        : undefined;
    const syntheticUserId =
      typeof transferSession.providerData?.syntheticUserId === 'string' &&
      transferSession.providerData.syntheticUserId.trim().length > 0
        ? transferSession.providerData.syntheticUserId.trim()
        : undefined;

    if (memberUserId) {
      if (memberUserId === transferSession.contactId || memberUserId === syntheticUserId) {
        return {
          participant: 'user',
          source: 'explicit_identity',
        };
      }
      return {
        participant: 'human_agent',
        source: 'explicit_identity',
      };
    }

    const speechPayload =
      data.speech && typeof data.speech === 'object' && !Array.isArray(data.speech)
        ? (data.speech as Record<string, unknown>)
        : undefined;
    const channelTagValue = speechPayload?.channel_tag;
    const channelTag =
      typeof channelTagValue === 'number'
        ? channelTagValue
        : typeof channelTagValue === 'string'
          ? Number(channelTagValue)
          : NaN;

    if (Number.isFinite(channelTag)) {
      return {
        participant: channelTag === 2 ? 'human_agent' : 'user',
        source: 'channel_tag',
      };
    }

    return null;
  }

  private buildBridgedTranscriptKey(transferSessionId: string, content: string): string {
    return `${transferSessionId}:${content.trim().replace(/\s+/g, ' ').toLowerCase()}`;
  }

  private pruneRecentBridgedTranscriptCache(now: number): void {
    for (const [key, entry] of this.recentBridgedTranscripts.entries()) {
      if (now - entry.observedAtMs > BRIDGED_TRANSCRIPT_DUPLICATE_WINDOW_MS) {
        this.recentBridgedTranscripts.delete(key);
      }
    }

    while (this.recentBridgedTranscripts.size > MAX_RECENT_BRIDGED_TRANSCRIPTS) {
      const oldestKey = this.recentBridgedTranscripts.keys().next().value;
      if (!oldestKey) {
        break;
      }
      this.recentBridgedTranscripts.delete(oldestKey);
    }
  }

  private shouldSuppressRecentBridgedTranscript(params: {
    transferSessionId: string;
    content: string;
    classification: BridgedTranscriptClassification;
  }): boolean {
    const now = Date.now();
    this.pruneRecentBridgedTranscriptCache(now);

    const key = this.buildBridgedTranscriptKey(params.transferSessionId, params.content);
    const previous = this.recentBridgedTranscripts.get(key);
    this.recentBridgedTranscripts.set(key, {
      observedAtMs: now,
      participant: params.classification.participant,
      source: params.classification.source,
    });

    if (!previous) {
      return false;
    }

    if (now - previous.observedAtMs > BRIDGED_TRANSCRIPT_DUPLICATE_WINDOW_MS) {
      return false;
    }

    return true;
  }

  private async loadTransferSessionForVoiceTranscript(): Promise<{
    transferSessionId: string;
    transferSession: import('@agent-platform/agent-transfer').TransferSessionData;
  } | null> {
    try {
      const [{ getTransferSessionStore }, at] = await Promise.all([
        import('../../agent-transfer/index.js'),
        import('@agent-platform/agent-transfer'),
      ]);

      const store = getTransferSessionStore();
      if (!store || !this.config.tenantId) {
        return null;
      }

      const transferSessionId = at.sessionKey(this.config.tenantId, this.config.sessionId, 'voice');
      const transferSession = await store.get(transferSessionId);
      if (!transferSession) {
        log.warn('Skipping voice transcript persistence without transfer session', {
          sessionId: this.config.sessionId,
          transferSessionId,
          callSid: this.config.callSid,
        });
        return null;
      }

      return {
        transferSessionId,
        transferSession:
          transferSession as unknown as import('@agent-platform/agent-transfer').TransferSessionData,
      };
    } catch (err) {
      log.warn('Failed to load transfer session for voice transcript persistence', {
        sessionId: this.config.sessionId,
        callSid: this.config.callSid,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private async handleBridgedCallTranscriptionHook(data: Record<string, unknown>): Promise<void> {
    const content = this.extractHookTranscriptContent(data);
    if (!content) {
      log.warn('Ignoring bridged call transcription hook without transcript content', {
        sessionId: this.config.sessionId,
        callSid: this.config.callSid,
        bodyKeys: Object.keys(data),
      });
      return;
    }

    const transferContext = await this.loadTransferSessionForVoiceTranscript();
    if (!transferContext) {
      return;
    }

    const classification = this.classifyBridgedTranscriptParticipant(
      data,
      transferContext.transferSession,
    );
    if (!classification) {
      log.warn('Skipping bridged call transcription with unknown participant', {
        sessionId: this.config.sessionId,
        transferSessionId: transferContext.transferSessionId,
        callSid: this.config.callSid,
        bodyKeys: Object.keys(data),
      });
      return;
    }

    if (
      this.shouldSuppressRecentBridgedTranscript({
        transferSessionId: transferContext.transferSessionId,
        content,
        classification,
      })
    ) {
      log.info('Skipping duplicate bridged voice call transcription', {
        sessionId: this.config.sessionId,
        transferSessionId: transferContext.transferSessionId,
        callSid: this.config.callSid,
        participant: classification.participant,
        classificationSource: classification.source,
        contentPreview: content.substring(0, 80),
      });
      return;
    }

    const [{ getAgentTransferTranscriptPersistenceService }] = await Promise.all([
      import('../../agent-transfer/transcript-persistence.js'),
    ]);
    const transcriptService = getAgentTransferTranscriptPersistenceService();
    const messageTimestamp = this.parseHookMessageTimestamp(data);

    if (classification.participant === 'user') {
      await transcriptService.persistForwardedUserMessage({
        transferSessionId: transferContext.transferSessionId,
        transferSession: transferContext.transferSession,
        content,
        messageTimestamp,
      });
    } else {
      await transcriptService.persistObservedAgentTranscript({
        transferSessionId: transferContext.transferSessionId,
        transferSession: transferContext.transferSession,
        content,
        messageTimestamp,
        agentInfo: this.buildVoiceTranscriptAgentInfo(data),
      });
    }

    log.info('Persisted bridged voice call transcription', {
      sessionId: this.config.sessionId,
      transferSessionId: transferContext.transferSessionId,
      callSid: this.config.callSid,
      participant: classification.participant,
      classificationSource: classification.source,
      contentPreview: content.substring(0, 80),
    });
  }

  /**
   * Create a DB session for message persistence.
   * Links the runtime session to a conversation store record so that
   * user/assistant messages and turn metrics can be persisted.
   */
  private ensureDBSession(): Promise<void> {
    if (this.dbSessionId) {
      return Promise.resolve();
    }

    if (!this.dbSessionCreationPromise) {
      this.dbSessionCreationPromise = this.createDBSession().finally(() => {
        this.dbSessionCreationPromise = undefined;
      });
    }

    return this.dbSessionCreationPromise;
  }

  private async createDBSession(): Promise<void> {
    try {
      const { createAndLinkDBSession } =
        await import('../../../channels/pipeline/session-factory.js');
      const contactId =
        this.config.tenantId && this.config.caller
          ? await resolveContactIdFromChannelIdentity({
              tenantId: this.config.tenantId,
              channelType: 'korevg',
              rawArtifact: this.config.caller,
              artifactType: this.config.callerContext?.channelArtifactType,
              verificationMethod: this.config.callerContext?.verificationMethod,
              identityTier: this.config.callerContext?.identityTier,
            })
          : undefined;
      if (contactId && this.config.callerContext) {
        this.config.callerContext = { ...this.config.callerContext, contactId };
      }
      const runtimeSess = getRuntimeExecutor().getSession(this.config.sessionId);
      const { dbSessionId } = await createAndLinkDBSession({
        channel: 'voice',
        agentName: this.config.agentName || this.config.agentId || 'unknown',
        agentVersion: '1.0',
        environment: 'production' as any,
        projectId: this.config.projectId,
        tenantId: this.config.tenantId,
        sessionId: this.config.sessionId,
        anonymousId: this.config.callerContext?.anonymousId,
        contactId,
        channelArtifact: this.config.callerContext?.channelArtifact,
        channelArtifactType: this.config.callerContext?.channelArtifactType,
        identityTier: this.config.callerContext?.identityTier,
        verificationMethod: this.config.callerContext?.verificationMethod,
        channelId: this.config.callerContext?.channelId,
        callerNumber: this.config.caller,
        experimentId: runtimeSess?.experimentId,
        experimentGroup: runtimeSess?.experimentGroup,
        metadata: {
          callSid: this.config.callSid,
          called: this.config.called,
          ttsVendor: this.config.ttsVendor,
          sttVendor: this.config.sttVendor,
        },
      });
      this.dbSessionId = dbSessionId;
      if (contactId && this.config.tenantId) {
        await linkResolvedContactToSession({
          tenantId: this.config.tenantId,
          channelType: 'korevg',
          channelId: this.config.callerContext?.channelId || this.config.streamId,
          sessionId: this.config.sessionId,
          contactId,
        });
      }
      log.info(`[TRACE] DB session created: ${dbSessionId}`);
    } catch (err) {
      log.warn(`[TRACE] DB session creation failed (persistence disabled): ${err}`);
    }
  }

  /**
   * Extract a VoiceToolResult from executor result metadata.
   * Voice tools (IVR menu, digit input, call transfer, deflect) return
   * { success, data: { voiceResult } } which the executor surfaces in
   * result.metadata.voiceToolResult or result.toolResults[].
   */
  private extractVoiceToolResult(result: Record<string, unknown>): VoiceToolResult | null {
    // Check metadata.voiceToolResult (set by tool executor pipeline)
    const meta = result.metadata as Record<string, unknown> | undefined;
    if (meta?.voiceToolResult) {
      return meta.voiceToolResult as VoiceToolResult;
    }

    // Check tool results array for voice tool output
    const toolResults = (result.toolResults ?? meta?.toolResults) as
      | Array<{
          name: string;
          result?: { success?: boolean; data?: { voiceResult?: VoiceToolResult } };
        }>
      | undefined;
    if (toolResults) {
      for (const tr of toolResults) {
        if (tr.result?.success && tr.result.data?.voiceResult) {
          return tr.result.data.voiceResult;
        }
      }
    }

    return null;
  }

  /**
   * Dispatch a VoiceToolResult to the appropriate Jambonz verb(s).
   * Returns true if the result was consumed (caller should skip normal TTS).
   */
  private async handleVoiceToolResult(voiceResult: VoiceToolResult): Promise<boolean> {
    switch (voiceResult.type) {
      case 'gather': {
        const gr = voiceResult as VoiceToolGatherResult;
        log.info('[VOICE-TOOL] Dispatching gather verb', {
          inputModes: gr.input,
          maxDigits: gr.maxDigits,
          callSid: this.config.callSid,
        });
        const gatherVerb = this.verbBuilder.gather({
          prompt: gr.prompt,
          input: gr.input,
          bargein: gr.bargeIn,
          timeout: gr.timeout ? gr.timeout * 1000 : undefined,
          maxDigits: gr.maxDigits,
          finishOnKey: gr.finishOnKey,
          interDigitTimeout: gr.interDigitTimeout,
        });
        this.sendCommand('redirect', [gatherVerb]);
        return true;
      }

      case 'transfer': {
        const tr = voiceResult as VoiceToolTransferResult;
        log.info('[VOICE-TOOL] Dispatching call transfer', {
          transferType: tr.transferType,
          target: tr.target,
          callSid: this.config.callSid,
        });
        this.emitVoiceTraceEvent('voice_call_transfer', {
          callSid: this.config.callSid,
          transferType: tr.transferType,
          target: tr.target,
        });
        if (tr.transferType === 'sip') {
          const referVerb = this.verbBuilder.refer({
            referTo: tr.target,
            headers: tr.headers,
          });
          this.sendCommand('redirect', [referVerb]);
        } else {
          const dialVerb = this.verbBuilder.dial({
            number: tr.target,
            headers: tr.headers,
          });
          this.sendCommand('redirect', [dialVerb]);
        }
        return true;
      }

      case 'deflect': {
        const dr = voiceResult as VoiceToolDeflectResult;
        log.info('[VOICE-TOOL] Dispatching deflection', {
          targetChannel: dr.targetChannel,
          callSid: this.config.callSid,
        });
        this.emitVoiceTraceEvent('voice_deflection', {
          callSid: this.config.callSid,
          targetChannel: dr.targetChannel,
          metadata: dr.metadata,
        });
        // Play a goodbye message then hang up — the chat session
        // is initiated on the platform side via the deflection metadata
        const farewell =
          'You will receive a message to continue this conversation via chat. Goodbye.';
        this.sendCommand('redirect', [
          ...this.buildBufferedSpeechVerbs(farewell),
          this.verbBuilder.hangup(),
        ]);
        return true;
      }

      case 'hangup': {
        log.info('[VOICE-TOOL] Dispatching hangup', {
          reason: voiceResult.reason,
          callSid: this.config.callSid,
        });
        this.sendCommand('redirect', [this.verbBuilder.hangup()]);
        return true;
      }

      default:
        log.warn('[VOICE-TOOL] Unknown voice tool result type', {
          type: (voiceResult as VoiceToolResult).type,
        });
        return false;
    }
  }

  /**
   * Extract OOB flags from executor result metadata.
   * These flags signal agent transfer, deflection, or conversation end
   * and originate from the agent's tool calls or flow transitions.
   */
  private extractOOBFlags(result: { metadata?: Record<string, unknown> }): OOBFlags | null {
    const meta = result.metadata;
    if (!meta) return null;

    const oob = (meta.oobFlags ?? meta.oob) as OOBFlags | undefined;
    if (!oob) return null;

    // Only return if at least one flag is set
    if (
      oob.isAgentTransfer ||
      oob.agentTransfer ||
      oob.isDeflection ||
      oob.isDeflectionAutomation ||
      oob.isDeflectionAgentTransfer ||
      oob.isOfferChatOptions ||
      oob.endDialog
    ) {
      return oob;
    }
    return null;
  }

  /**
   * Handle OOB flags from the executor result.
   * Routes to agent transfer, deflection, or hangup as appropriate.
   * Returns true if OOB handling consumed the response (caller should skip normal TTS).
   */
  private handleOOBFlags(oob: OOBFlags): boolean {
    if (oob.isAgentTransfer || oob.agentTransfer || oob.isDeflectionAgentTransfer) {
      log.info('[OOB] Agent transfer requested', {
        callSid: this.config.callSid,
        intent: oob.detectedIntentName,
      });
      this.emitVoiceTraceEvent('voice_oob_agent_transfer', {
        callSid: this.config.callSid,
        intent: oob.detectedIntentName,
        dialogRefId: oob.dialogRefId,
      });
      // Agent transfer is handled by the TransferToolExecutor at the tool level.
      // The OOB flag here is informational — the actual transfer (dial/refer)
      // is executed when the transfer_to_agent tool result is processed.
      return false;
    }

    if (oob.isDeflection) {
      log.info('[OOB] Deflection requested', {
        callSid: this.config.callSid,
        intent: oob.detectedIntentName,
      });
      this.emitVoiceTraceEvent('voice_oob_deflection', {
        callSid: this.config.callSid,
        intent: oob.detectedIntentName,
      });
      // Deflection to chat is handled by the deflect_to_chat tool.
      return false;
    }

    if (oob.isDeflectionAutomation) {
      log.info('[OOB] Deflection automation requested — invoke sub-agent dialog', {
        callSid: this.config.callSid,
        intent: oob.detectedIntentName,
        dialogId: oob.dialogId,
      });
      this.emitVoiceTraceEvent('voice_oob_deflection_automation', {
        callSid: this.config.callSid,
        intent: oob.detectedIntentName,
        dialogId: oob.dialogId,
      });
      // Deflection automation maps to ABL's DELEGATE construct.
      // The actual sub-agent invocation is handled at the ABL flow level.
      return false;
    }

    if (oob.isOfferChatOptions) {
      log.info('[OOB] Offer chat options requested — present channel options to caller', {
        callSid: this.config.callSid,
        intent: oob.detectedIntentName,
      });
      this.emitVoiceTraceEvent('voice_oob_offer_chat_options', {
        callSid: this.config.callSid,
        intent: oob.detectedIntentName,
      });
      // Offer chat options signals that the voice agent should present
      // alternative channel options (e.g., "Press 1 for SMS, 2 for web chat").
      // The actual option presentation is handled by the IVR menu tool in the flow.
      return false;
    }

    if (oob.endDialog) {
      log.info('[OOB] End dialog requested', {
        callSid: this.config.callSid,
        reason: oob.endReason,
      });
      this.emitVoiceTraceEvent('voice_oob_end_dialog', {
        callSid: this.config.callSid,
        reason: oob.endReason,
      });
      // Hang up the call
      this.sendCommand('redirect', [this.verbBuilder.hangup()]);
      return true;
    }

    return false;
  }

  private async flushTransferTranscriptQueueOnClose(): Promise<void> {
    const { getAgentTransferTranscriptPersistenceService } =
      await import('../../agent-transfer/transcript-persistence.js');
    await getAgentTransferTranscriptPersistenceService().flushRuntimeSessionTransferTranscript({
      runtimeSessionId: this.config.sessionId,
      tenantId: this.config.tenantId,
      channelType: this.config.callerContext?.channel ?? 'voice',
      parentConversationSessionId: this.dbSessionId ?? this.config.sessionId,
      reason: 'voice_session_close',
    });
  }

  private async handleClose(): Promise<void> {
    if (this.isActive) {
      log.info(`WebSocket closed: call_sid=${this.config.callSid}, turns=${this.turnCount}`);
      this.isActive = false;
      this.callEndTime = Date.now(); // Metric 205: save actual call end time

      // ── Homer: Fetch post-call quality data (fire-and-forget) ────────────
      // Two Call-IDs are needed because the SBC (B2BUA) rewrites Call-IDs:
      //   sipCallId  = SBC→FS leg Call-ID (for SIP transaction/disconnect queries)
      //   rtpCallId  = Caller→SBC original Call-ID (for RTCP/QoS queries)
      //               The SBC passes this to rtpengine as the session tag.
      const sipCallId = (this.config.callInfo?.callId as string) || '';
      const rtpCallId = (this.config.callInfo?.sbcCallId as string) || '';

      this.fetchHomerQualityAndEmitSessionEnd(sipCallId, rtpCallId).catch((err) =>
        log.warn('[HOMER] Post-call quality fetch failed', {
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      // Unregister from the voice session registry
      unregisterVoiceSession(this.config.sessionId);
      unregisterVoiceSession(this.config.callSid);

      await this.flushTransferTranscriptQueueOnClose().catch((err) => {
        log.warn('[PERSIST] Agent transfer transcript queue flush failed on voice close', {
          sessionId: this.config.sessionId,
          callSid: this.config.callSid,
          err: err instanceof Error ? err.message : String(err),
        });
      });

      // ── Voice trace: Session end is emitted in fetchHomerQualityAndEmitSessionEnd() ──
      // DO NOT emit here - it will be emitted with full MOS data after Homer fetch

      // Persist call-end event if DB session exists
      if (this.dbSessionId) {
        import('../../message-persistence-queue.js')
          .then(({ persistTurnMetrics }) =>
            persistTurnMetrics({
              dbSessionId: this.dbSessionId!,
              tenantId: this.config.tenantId,
              tokensIn: 0,
              tokensOut: 0,
              cost: 0,
              traceEventCount: 0,
              errorCount: 0,
              handoffCount: 0,
            }),
          )
          .catch((err) =>
            log.warn('[PERSIST] End-of-call metrics failed', {
              err: err instanceof Error ? err.message : String(err),
            }),
          );
      }
    }
  }

  /**
   * Fetch Homer quality data at session end and emit enriched voice_session_end trace.
   * Runs asynchronously so it doesn't block WebSocket teardown.
   */
  private async fetchHomerQualityAndEmitSessionEnd(
    sipCallId: string,
    rtpCallId?: string,
  ): Promise<void> {
    let homerData: import('./homer-client.js').HomerCallQuality | undefined;

    try {
      // Wait briefly for Homer to ingest the final SIP messages (BYE/200).
      // The BYE reaches Homer via heplify-server ~50-200ms after the call ends,
      // but Homer's indexing pipeline needs additional time to make it queryable.
      // Increased to 5s to ensure BYE message is indexed before query.
      await new Promise((resolve) => setTimeout(resolve, 5000));

      const { getCallQuality } = await import('./homer-client.js');
      homerData = await getCallQuality(sipCallId, rtpCallId || undefined);

      // ── Metric 210: Store inbound network MOS for cascade detection ────────
      // Make it available for per-turn cascade analysis
      if (homerData?.mos.inbound !== undefined) {
        this.inboundNetworkMos = homerData.mos.inbound;
      }
    } catch (err) {
      log.warn('[HOMER] Import or query failed, emitting session_end without Homer data', {
        err: err instanceof Error ? err.message : String(err),
      });
    }

    // ── Metric 205: Finalize call activity durations ────────────────────────
    // Use saved call end time (before 3s Homer delay) for accurate duration
    const effectiveEndTime = this.callEndTime || Date.now();
    const callDurationMs = this.callStartTime ? effectiveEndTime - this.callStartTime : 0;

    // Add trailing silence: gap from last TTS activity to call end
    // (only if agent wasn't mid-speech — i.e. lastTtsActivityTime is after any active TTS)
    if (this.lastTtsActivityTime && effectiveEndTime > this.lastTtsActivityTime) {
      const trailingGap = effectiveEndTime - this.lastTtsActivityTime;
      // Only count if significant (>500ms) to avoid noise from near-simultaneous events
      if (trailingGap > 500) {
        this.silenceAccumulatedMs += trailingGap;
      }
    }

    // Cap silence at call duration
    const silenceMs = Math.min(this.silenceAccumulatedMs, callDurationMs);
    const silencePercent =
      callDurationMs > 0 ? +((silenceMs / callDurationMs) * 100).toFixed(1) : 0;
    // Agent speaking = residual (avoids word-count overestimation for TTS)
    const agentSpeakingMs = Math.max(0, callDurationMs - silenceMs - this.userSpeakingTotalMs);

    log.info('[SILENCE] Final breakdown', {
      callDurationMs,
      silenceMs,
      silencePercent,
      processingMs: this.processingTotalMs,
      userSpeakingMs: this.userSpeakingTotalMs,
      agentSpeakingMs,
    });

    // ── Metric 206 & 207: Finalize session outcome for containment tracking ─────
    // Determine outcome based on call phase and disconnect initiator
    if (this.sessionOutcome === 'pending') {
      const disconnectInitiator = homerData?.disconnect.initiator ?? 'unknown';

      // Special handling for transfer phase (escalate action was initiated)
      if (this.callPhase === 'transfer') {
        if (disconnectInitiator === 'caller') {
          // Option A: User hung up during transfer attempt → abandoned
          this.sessionOutcome = 'abandoned';
          log.info('[CONTAINMENT] Session abandoned - caller hung up during transfer');
        } else if (disconnectInitiator === 'platform') {
          // Platform completed the transfer handoff → escalated
          this.sessionOutcome = 'escalated';
          log.info('[CONTAINMENT] Session escalated - transfer completed');
        } else {
          // Unknown disconnect during transfer → abandoned
          this.sessionOutcome = 'abandoned';
          log.warn('[CONTAINMENT] Session abandoned - unknown disconnect during transfer');
        }
      } else {
        // Standard flow (not in transfer phase)
        if (disconnectInitiator === 'caller') {
          this.sessionOutcome = 'abandoned'; // ❌ NOT Contained: User hung up
          log.info('[CONTAINMENT] Session abandoned - caller hung up');
        } else if (disconnectInitiator === 'platform') {
          // Platform-initiated disconnect without explicit complete/escalate
          // Could be timeout, error, or implicit completion
          this.sessionOutcome = 'completed'; // Treat as completed by default
          log.info('[CONTAINMENT] Session completed - platform ended call');
        } else {
          this.sessionOutcome = 'abandoned'; // Unknown disconnect = abandoned
          log.warn('[CONTAINMENT] Session abandoned - unknown disconnect initiator');
        }
      }
    }

    const isContained = this.sessionOutcome === 'completed';
    log.info('[CONTAINMENT] Final outcome', {
      sessionOutcome: this.sessionOutcome,
      isContained,
      turnCount: this.turnCount,
    });

    // ── Metric 201: Analyze ASR Quality (Multi-signal WER proxy) ───────────
    // IMPORTANT: Run this BEFORE emitting voice_session_end so the score is included
    if (this.asrTurns.length > 0) {
      try {
        const asrQualityResult = await this.voiceQualityAnalyzer.analyzeQuality(
          this.asrTurns,
          this.config.sttLanguage,
        );

        // Store ASR score for session end event
        this.overallAsrScore = asrQualityResult.overallScore;

        log.info('[ASR-QUALITY] Session analysis complete', {
          callSid: this.config.callSid,
          overallScore: asrQualityResult.overallScore,
          totalTurns: asrQualityResult.metadata.totalTurns,
          signals: {
            repetition: +asrQualityResult.signals.repetition.toFixed(2),
            hesitation: +asrQualityResult.signals.hesitation.toFixed(2),
            correction: +asrQualityResult.signals.correction.toFixed(2),
            clarity: +asrQualityResult.signals.clarity.toFixed(2),
            confidence: +asrQualityResult.signals.confidence.toFixed(2),
          },
          issues: asrQualityResult.issues.map((i) => `${i.type}:${i.severity}`),
          detectorType: asrQualityResult.metadata.detectorType,
        });

        // Emit trace event for ASR quality
        this.emitVoiceTraceEvent('voice_asr_quality', {
          overallScore: asrQualityResult.overallScore,
          signals: {
            repetition: +asrQualityResult.signals.repetition.toFixed(3),
            hesitation: +asrQualityResult.signals.hesitation.toFixed(3),
            correction: +asrQualityResult.signals.correction.toFixed(3),
            clarity: +asrQualityResult.signals.clarity.toFixed(3),
            confidence: +asrQualityResult.signals.confidence.toFixed(3),
          },
          issues: asrQualityResult.issues,
          totalTurns: asrQualityResult.metadata.totalTurns,
          avgTranscriptLength: Math.round(asrQualityResult.metadata.averageTranscriptLength),
          detectorType: asrQualityResult.metadata.detectorType,
          language: this.config.sttLanguage,
          sttProvider: this.config.sttVendor || 'deepgram',
        });
      } catch (err) {
        log.warn('[ASR-QUALITY] Analysis failed', {
          error: err instanceof Error ? err.message : String(err),
          turnCount: this.asrTurns.length,
        });
      }
    } else {
      log.info('[ASR-QUALITY] No ASR turns collected for analysis');
    }

    // ── Metric 207: Debug call phase state at emission time ───────────────
    log.info('[PHASE-EMIT] Emitting voice_session_end with state', {
      callPhase: this.callPhase,
      sessionOutcome: this.sessionOutcome,
      currentAgent: this.currentAgentName,
      abandonedDuringTransfer: this.sessionOutcome === 'abandoned' && this.callPhase === 'transfer',
    });

    // ── Voice trace: Session end (enriched with Homer data) ───────────────
    this.emitVoiceTraceEvent('voice_session_end', {
      callSid: this.config.callSid,
      totalTurns: this.turnCount,
      channel: 'voice',
      // Metric 203: E2E latency summary
      avgE2eLatencyMs: this.e2eCount > 0 ? Math.round(this.e2eTotalMs / this.e2eCount) : null,
      e2eMeasuredTurns: this.e2eCount,
      // Metric 204: Barge-in summary
      bargeInCount: this.bargeInCount,
      bargeInRate:
        this.turnCount > 0 ? +((this.bargeInCount / this.turnCount) * 100).toFixed(1) : 0,
      // Metric 209: DTMF fallback summary
      dtmfTurnCount: this.dtmfTurnCount,
      dtmfFallbackRate:
        this.turnCount > 0 ? +((this.dtmfTurnCount / this.turnCount) * 100).toFixed(1) : 0,
      // Metric 205: Call activity breakdown
      callDurationMs,
      agentSpeakingMs,
      processingMs: this.processingTotalMs,
      userSpeakingMs: this.userSpeakingTotalMs,
      silenceMs,
      silencePercent,
      // Metric 206: Containment tracking
      sessionOutcome: this.sessionOutcome,
      isContained,
      // Metric 207: Call phase tracking
      callPhase: this.callPhase,
      currentAgent: this.currentAgentName ?? null,
      abandonedDuringGreeting: this.sessionOutcome === 'abandoned' && this.callPhase === 'greeting',
      abandonedDuringConversation:
        this.sessionOutcome === 'abandoned' && this.callPhase === 'conversation',
      abandonedDuringTransfer: this.sessionOutcome === 'abandoned' && this.callPhase === 'transfer',
      // Homer quality data (all null if Homer unavailable)
      homerAvailable: homerData?.homerAvailable ?? false,
      homerError: homerData?.homerError,
      // Network MOS from RTCP
      inboundNetworkMos: homerData?.mos.inbound ?? null,
      outboundNetworkMos: homerData?.mos.outbound ?? null,
      inboundRFactor: homerData?.mos.inboundRFactor ?? null,
      outboundRFactor: homerData?.mos.outboundRFactor ?? null,
      // RTCP QoS details
      inboundJitterMs: homerData?.qos?.inbound?.jitterMs ?? null,
      inboundPacketLossRate: homerData?.qos?.inbound?.packetLossRate ?? null,
      outboundJitterMs: homerData?.qos?.outbound?.jitterMs ?? null,
      outboundPacketLossRate: homerData?.qos?.outbound?.packetLossRate ?? null,
      rtcpReportCount:
        (homerData?.qos?.inbound?.reportCount ?? 0) + (homerData?.qos?.outbound?.reportCount ?? 0),
      // Metric 202: TTS Quality (Proxy MOS + Network MOS)
      avgProxyMos:
        this.ttsProxyMosCount > 0
          ? +(this.ttsProxyMosTotal / this.ttsProxyMosCount).toFixed(2)
          : null,
      avgTtfbMs: this.ttsTtfbCount > 0 ? Math.round(this.ttsTotalTtfbMs / this.ttsTtfbCount) : null,
      avgCombinedTtsMos:
        this.ttsProxyMosCount > 0
          ? +computeCombinedTtsMos(
              this.ttsProxyMosTotal / this.ttsProxyMosCount,
              homerData?.mos.outbound ?? null,
            ).toFixed(2)
          : null,
      ttsErrorCount: this.ttsErrorCount,
      ttsQualityTurns: this.ttsProxyMosCount,
      // Metric 201: ASR Quality Score (0-100 scale)
      overallAsrScore: this.overallAsrScore,
      // Metric 210: ASR Cascade Detection
      cascadeRiskTurns: this.cascadeRiskTurns,
      // SIP disconnect attribution
      sipDisconnectInitiator: homerData?.disconnect.initiator ?? 'unknown',
      sipStatusCode: homerData?.disconnect.statusCode ?? null,
      sipDisconnectMethod: homerData?.disconnect.method ?? null,
      sipDisconnectReason: homerData?.disconnect.reason ?? null,
    });

    if (homerData?.homerAvailable) {
      log.info('[SESSION-END] Enriched with Homer data', {
        callSid: this.config.callSid,
        inboundMos: homerData.mos.inbound,
        outboundMos: homerData.mos.outbound,
        disconnectBy: homerData.disconnect.initiator,
      });
    }

    log.info('[VOICE-PIPELINE] Final call summary', {
      callSid: this.config.callSid,
      sessionId: this.config.sessionId,
      dbSessionId: this.dbSessionId ?? null,
      streamId: this.config.streamId,
      totalTurns: this.turnCount,
      callDurationMs,
      sessionOutcome: this.sessionOutcome,
      isContained,
      callPhase: this.callPhase,
      currentAgent: this.currentAgentName ?? null,
      avgE2eLatencyMs: this.e2eCount > 0 ? Math.round(this.e2eTotalMs / this.e2eCount) : null,
      avgTtfbMs: this.ttsTtfbCount > 0 ? Math.round(this.ttsTotalTtfbMs / this.ttsTtfbCount) : null,
      overallAsrScore: this.overallAsrScore,
      homerAvailable: homerData?.homerAvailable ?? false,
      sipDisconnectInitiator: homerData?.disconnect.initiator ?? 'unknown',
      sipStatusCode: homerData?.disconnect.statusCode ?? null,
      sipDisconnectMethod: homerData?.disconnect.method ?? null,
      sipDisconnectReason: homerData?.disconnect.reason ?? null,
    });

    // Metric 202: Log TTS quality summary
    if (this.ttsProxyMosCount > 0) {
      const avgProxyMos = this.ttsProxyMosTotal / this.ttsProxyMosCount;
      const avgCombinedMos = computeCombinedTtsMos(avgProxyMos, homerData?.mos.outbound ?? null);
      log.info('[TTS-QUALITY] Session summary', {
        callSid: this.config.callSid,
        avgProxyMos: +avgProxyMos.toFixed(2),
        avgCombinedMos: +avgCombinedMos.toFixed(2),
        outboundNetworkMos: homerData?.mos.outbound ?? null,
        ttsQualityTurns: this.ttsProxyMosCount,
        avgTtfbMs:
          this.ttsTtfbCount > 0 ? Math.round(this.ttsTotalTtfbMs / this.ttsTtfbCount) : null,
      });
    }

    // End the runtime session after Homer data is fetched and events are emitted (pipeline mode only)
    if (this.executor) {
      this.executor.endSession(this.config.sessionId);
    }

    // End the DB session if it exists - use session repo directly to avoid tenant context issues
    if (this.dbSessionId && this.config.tenantId && this.config.projectId) {
      try {
        // Flush buffered messages before ending session so read-conversation
        // finds the complete transcript when the pipeline triggers
        const { flushMessageQueue } = await import('../../message-persistence-queue.js');
        await flushMessageQueue(this.dbSessionId);

        const { updateSession } = await import('../../../repos/session-repo.js');
        const disposition =
          this.sessionOutcome === 'completed' || this.sessionOutcome === 'escalated'
            ? 'completed'
            : 'abandoned';
        await updateSession(
          this.dbSessionId,
          {
            status: 'ended',
            disposition,
            endedAt: new Date(),
            lastActivityAt: new Date(),
          },
          this.config.tenantId,
        );
        log.info('[SESSION-END] DB session ended successfully', {
          dbSessionId: this.dbSessionId,
          disposition,
        });

        // Emit session.ended to trigger analytics pipelines (mirrors text/chat path)
        const bus = getRuntimeEventBus();
        if (bus) {
          emitVoiceSessionEnded(bus, {
            tenantId: this.config.tenantId,
            projectId: this.config.projectId,
            sessionId: this.config.sessionId,
            agentName: this.config.agentName ?? 'unknown',
            sessionOutcome: this.sessionOutcome,
            durationMs: callDurationMs,
            turnCount: this.turnCount,
          });
        }
      } catch (err) {
        log.warn('[SESSION-END] Failed to end DB session', {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  /**
   * Detect if agent response contains clarification requests
   * Used for cascade detection (Metric 210)
   */
  private detectClarificationRequest(agentResponse: string): boolean {
    if (!agentResponse) return false;

    const clarificationPatterns = [
      /\b(could you repeat|can you repeat|say that again|didn't catch|didn't understand)\b/i,
      /\b(did you mean|do you mean|are you asking|are you saying)\b/i,
      /\b(sorry|pardon|excuse me|what was that|come again)\b/i,
      /\b(can you clarify|could you clarify|please clarify)\b/i,
      /\b(I'm not sure|not clear|unclear|confused)\b/i,
    ];

    return clarificationPatterns.some((pattern) => pattern.test(agentResponse));
  }

  private handleError(err: Error) {
    log.error(`WebSocket error call_sid=${this.config.callSid}: ${err}`);
  }

  /**
   * Resolve streaming mode from DB at call start.
   * Looks up the entry agent's model config using the agent slug.
   * Called once in sendGreeting() — the result is used for the entire call.
   */
  /**
   * Send a text message to the caller via TTS (say verb).
   * Used by the message bridge to deliver agent desktop messages during transfer.
   */
  async sendAgentMessage(text: string, options: { waitForPlayback?: boolean } = {}): Promise<void> {
    if (!this.isActive || this.ws.readyState !== 1) {
      log.warn('[AGENT-MSG] Cannot send — session inactive or WS closed', {
        callSid: this.config.callSid,
      });
      return;
    }

    // Suppress TTS during active dial — sending a redirect would kill the
    // bridged call. Messages will be delivered after the dial completes.
    if (this.dialActive) {
      log.info('[AGENT-MSG] Suppressed during active dial', {
        callSid: this.config.callSid,
        textLength: text.length,
      });
      return;
    }

    if (this.useStreaming && this.ttsStreamOpen) {
      // Streaming: send via TTS tokens
      this.sendTtsTokens(text).catch((err) =>
        log.error('[AGENT-MSG] TTS tokens send failed', {
          err: err instanceof Error ? err.message : String(err),
        }),
      );
      this.sendTtsFlush();
    } else {
      // Non-streaming: send say verb via redirect
      this.sendCommand('redirect', this.buildBufferedSpeechVerbs(text));
      if (options.waitForPlayback) {
        const playbackWaitMs = this.estimateFillerPlaybackWaitMs(text);
        const playbackEvent = await this.waitForTtsPlaybackStopEvent(playbackWaitMs);
        log.info('[AGENT-MSG] Filler playback completed before final response', {
          callSid: this.config.callSid,
          textLength: text.length,
          playbackEvent,
          playbackWaitMs,
        });
      }
    }

    log.info('[AGENT-MSG] Delivered agent message via voice', {
      callSid: this.config.callSid,
      textLength: text.length,
    });
  }

  hangup(reason?: string): void {
    if (!this.isActive || this.ws.readyState !== 1) {
      return;
    }

    log.info('[VOICE-HANGUP] Ending voice call', {
      callSid: this.config.callSid,
      reason,
    });
    this.sendCommand('redirect', [this.verbBuilder.hangup()]);
  }

  async dialAgent(sipUri: string, options?: DialAgentOptions): Promise<void> {
    if (!this.isActive || this.ws.readyState !== 1) {
      throw new Error('Voice gateway WebSocket not connected');
    }

    // KoreServer dials the agent as a jambonz registered user.
    // The name is the SIP URI with the "sip:" scheme stripped and port removed:
    //   "sip:support_production_a-xxx@uxo-savg-siprealm.kore.ai:5060"
    //     → "support_production_a-xxx@uxo-savg-siprealm.kore.ai"
    const agentName = sipUri.replace(/^sips?:/, '').replace(/:\d+$/, '');
    if (!agentName || !agentName.includes('@')) {
      throw new Error('Cannot extract agent name from SIP URI');
    }

    // KoreServer includes callerId (caller's phone number) in the dial payload.
    // Without it, jambonz may not present caller info to the agent side.
    const callerId = this.config.caller || undefined;
    const actionHook = '/agent-dial-status';
    const transcriptionHook = this.buildHttpHookUrl('call-transcriptions') || undefined;
    const dialVerb = this.verbBuilder.dialUser({
      name: agentName,
      callerId,
      actionHook,
      transcriptionHook,
    });

    // Add dial headers if provided
    if (options?.dialHeaders && Object.keys(options.dialHeaders).length > 0) {
      (dialVerb as Record<string, unknown>).headers = options.dialHeaders;
    }

    // Split agentName to bypass PII email-pattern redaction in logger
    // (the sanitizer treats user@domain as an email address)
    const [agentUser, agentDomain] = agentName.split('@');
    // Stringify verb with the name field masked to avoid PII redaction,
    // then log the real parts separately so nothing is lost.
    const verbForLog = JSON.stringify(dialVerb).replace(
      agentName,
      `${agentUser}__at__${agentDomain}`,
    );
    log.info('[DIAL-AGENT] Bridging caller to agent via registered user', {
      callSid: this.config.callSid,
      callerId,
      agentUser,
      agentDomain,
      targetType: 'user',
      answerOnBridge: false,
      timeout: dialVerb.timeout,
      actionHook: dialVerb.actionHook,
      hasHeaders: !!(dialVerb as Record<string, unknown>).headers,
      verbRaw: verbForLog,
    });

    // Disable barge-in before dialing. The sticky gather's background STT
    // is still active — if the agent speaks during the bridged call, Deepgram
    // transcribes it, barge-in fires (minBargeinWordCount=1), and jambonz
    // kills the dial verb, tearing down the audio bridge.
    // Sending config with bargeIn.enable=false first prevents this.
    const disableBargeIn: VerbResponse = {
      verb: 'config',
      bargeIn: { enable: false },
    };

    this.dialActive = true;
    this.sendCommand('redirect', [disableBargeIn, dialVerb]);
  }

  playMessage(text: string, _options?: PlayMessageOptions): void {
    if (!this.isActive || this.ws.readyState !== 1) return;

    log.info('[PLAY-MSG] Playing message to caller', {
      callSid: this.config.callSid,
      textLength: text.length,
    });

    this.sendCommand('redirect', this.buildBufferedSpeechVerbs(text));
  }

  async playThenHangup(text: string, reason = 'completed'): Promise<void> {
    if (!this.isActive || this.ws.readyState !== 1) {
      return;
    }

    log.info('[PLAY-THEN-HANGUP] Playing final message before hangup', {
      callSid: this.config.callSid,
      textLength: text.length,
      reason,
    });

    this.sendCommand('redirect', [
      ...this.buildBufferedSpeechVerbs(text),
      this.verbBuilder.hangup(),
    ]);
  }

  /**
   * Play a TTS prompt and collect DTMF input from the caller.
   * Used by the CSAT flow after agent disconnect to gather a rating (1–5).
   *
   * Implementation: installs a one-shot resolver on csatGatherResolve,
   * sends a Jambonz gather verb via redirect, and the next verb:hook
   * is intercepted at the top of handleVerbHook() instead of going
   * through the normal LLM turn pipeline.
   */
  gatherDTMF(prompt: string, options?: GatherDTMFOptions): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.isActive || this.ws.readyState !== 1) {
        resolve(null);
        return;
      }

      const timeoutMs = (options?.timeout ?? 10) * 1000;
      const numDigits = options?.numDigits ?? 1;

      // Jambonz gather timeout is in SECONDS and counts from gather START (not
      // post-prompt). Estimate prompt speaking time (~2.5 words/sec for ElevenLabs)
      // so Jambonz keeps the gather open for the full prompt + user response window.
      const estimatedPromptMs = Math.ceil(prompt.split(/\s+/).length / 2.5) * 1000;
      const jambonzTimeoutSec = Math.ceil((estimatedPromptMs + timeoutMs) / 1000);
      // Node.js fallback fires 2s after Jambonz's expected total timeout.
      // Jambonz does not always send a verb:hook for gather-timeout-with-no-input,
      // so this fallback is the primary mechanism for the no-digit path.
      const fallbackMs = estimatedPromptMs + timeoutMs + 2000;

      // Timeout fallback — resolve null if no verb:hook arrives in time
      const timer = setTimeout(() => {
        if (this.csatGatherResolve === localResolve) {
          this.csatGatherResolve = undefined;
        }
        log.info('[CSAT-GATHER] Timed out waiting for DTMF', {
          callSid: this.config.callSid,
          timeoutMs,
        });
        resolve(null);
      }, fallbackMs);

      const localResolve = (digits: string | null) => {
        clearTimeout(timer);
        resolve(digits);
      };

      this.csatGatherResolve = localResolve;

      // Build the gather verb — DTMF-only (no speech recognition).
      // actionHook must be set so Jambonz sends the verb:hook when a digit
      // is received (without it Jambonz stays silent and only the fallback fires).
      const gatherVerb = this.verbBuilder.gather({
        prompt,
        numDigits,
        timeout: jambonzTimeoutSec,
        bargein: false,
        actionHook: this.wsPath,
      });
      // Override to DTMF-only input (verb builder defaults to ['speech', 'digits'])
      gatherVerb.input = ['digits'];

      this.sendCommand('redirect', [gatherVerb]);

      log.info('[CSAT-GATHER] Dispatched DTMF gather', {
        callSid: this.config.callSid,
        numDigits,
        timeoutMs,
      });
    });
  }

  /** Get the runtime session ID for this voice session. */
  getSessionId(): string {
    return this.config.sessionId;
  }

  getVoiceTransferData(): VoiceCallData {
    const callInfo = this.config.callInfo as Record<string, unknown> | undefined;
    return {
      callSid: this.config.callSid,
      caller: this.config.caller || (callInfo?.from as string) || '',
      called: this.config.called || (callInfo?.to as string) || '',
      sipCallId: callInfo?.callId as string | undefined,
      sipFrom: callInfo?.from as string | undefined,
      sipTo: callInfo?.to as string | undefined,
      originatingSipIp: callInfo?.originatingSipIp as string | undefined,
      direction: callInfo?.direction as string | undefined,
      callerName: callInfo?.callerName as string | undefined,
    };
  }

  private async resolveStreamingMode(): Promise<void> {
    try {
      if (this.config.bargeIn === false) {
        this.forceNonStreamingWhenBargeInDisabled('resolve_streaming_mode');
        return;
      }

      const humeStreamingEnabled = process.env.HUME_TTS_ENABLE_STREAMING === 'true';
      if (this.config.ttsVendor === 'custom:orpheus') {
        const orpheusWsStreamingEnabled =
          this.config.orpheusWsStreamingEnabled === true &&
          process.env.ORPHEUS_TTS_ENABLE_WS_STREAMING === 'true' &&
          process.env.ORPHEUS_TTS_WS_VALIDATED === 'true';
        this.useStreaming = orpheusWsStreamingEnabled;
        log.info('[STREAMING-RESOLVE] Resolved Orpheus streaming mode', {
          vendor: this.config.ttsVendor,
          connectionOptIn: this.config.orpheusWsStreamingEnabled === true,
          runtimeEnabled: process.env.ORPHEUS_TTS_ENABLE_WS_STREAMING === 'true',
          wsValidated: process.env.ORPHEUS_TTS_WS_VALIDATED === 'true',
          useStreaming: this.useStreaming,
        });
        return;
      }
      if (this.config.ttsVendor === 'custom:hume' && !humeStreamingEnabled) {
        this.useStreaming = false;
        log.info('[STREAMING-RESOLVE] Forced non-streaming for custom provider TTS', {
          vendor: this.config.ttsVendor,
        });
        return;
      }
      if (this.config.ttsVendor === 'custom:hume' && humeStreamingEnabled) {
        this.useStreaming = true;
        log.info('[STREAMING-RESOLVE] Enabled streaming for custom Hume TTS');
        return;
      }

      const agentSlug = this.config.agentName;
      if (!agentSlug || !this.config.projectId) {
        log.info('[STREAMING-RESOLVE] No agent slug or projectId, defaulting to streaming');
        return;
      }
      if (!this.config.tenantId) {
        log.warn('[STREAMING-RESOLVE] No tenantId, skipping agent streaming config lookup');
        return;
      }
      const { findAgentModelConfig } = await import('../../../repos/llm-resolution-repo.js');
      const config = await findAgentModelConfig(
        this.config.projectId,
        agentSlug,
        this.config.tenantId,
      );
      if (config?.useStreaming === false) {
        this.useStreaming = false;
        log.info(`[STREAMING-RESOLVE] Agent "${agentSlug}" configured for non-streaming`);
      } else {
        log.info(
          `[STREAMING-RESOLVE] Agent "${agentSlug}" configured for streaming (useStreaming=${config?.useStreaming})`,
        );
      }
    } catch (err) {
      log.warn(
        `[STREAMING-RESOLVE] Failed to resolve streaming mode, defaulting to streaming: ${err}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Voice Session Registry
// ---------------------------------------------------------------------------
// Maps runtime session IDs to active KorevgSession instances.
// Used by the message bridge to deliver agent messages during voice transfers.

const MAX_VOICE_SESSIONS = 10_000;
const VOICE_SESSION_TTL_MS = 4 * 60 * 60 * 1000; // 4 hours max call duration
const voiceSessionRegistry = new Map<string, KorevgSession>();
const voiceSessionTimestamps = new Map<string, number>();

/** Register a voice session so the message bridge can find it. */
export function registerVoiceSession(sessionId: string, session: KorevgSession): void {
  if (voiceSessionRegistry.size >= MAX_VOICE_SESSIONS) {
    evictStaleVoiceSessions();
  }
  // If still at capacity after eviction, drop oldest
  if (voiceSessionRegistry.size >= MAX_VOICE_SESSIONS) {
    const firstKey = voiceSessionRegistry.keys().next().value;
    if (firstKey) {
      voiceSessionRegistry.delete(firstKey);
      voiceSessionTimestamps.delete(firstKey);
    }
  }
  voiceSessionRegistry.set(sessionId, session);
  voiceSessionTimestamps.set(sessionId, Date.now());
}

/** Unregister a voice session on call close. */
export function unregisterVoiceSession(sessionId: string): void {
  voiceSessionRegistry.delete(sessionId);
  voiceSessionTimestamps.delete(sessionId);
}

/** Get a voice session by runtime session ID. */
export function getVoiceSession(sessionId: string): KorevgSession | undefined {
  const session = voiceSessionRegistry.get(sessionId);
  if (!session) return undefined;

  // Check TTL
  const ts = voiceSessionTimestamps.get(sessionId);
  if (ts && Date.now() - ts > VOICE_SESSION_TTL_MS) {
    voiceSessionRegistry.delete(sessionId);
    voiceSessionTimestamps.delete(sessionId);
    return undefined;
  }

  return session;
}

/**
 * Parse Jambonz stt_latency_ms field (comma-separated string of per-transcript latencies)
 * and return the average as a single rounded number.
 * Returns undefined if the input is empty or not provided.
 */
export function parseSttLatencyMs(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const values = raw.split(',').filter(Boolean).map(Number);
  if (values.length === 0) return undefined;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function evictStaleVoiceSessions(): void {
  const now = Date.now();
  for (const [id, ts] of voiceSessionTimestamps) {
    if (now - ts > VOICE_SESSION_TTL_MS) {
      voiceSessionRegistry.delete(id);
      voiceSessionTimestamps.delete(id);
    }
  }
}
