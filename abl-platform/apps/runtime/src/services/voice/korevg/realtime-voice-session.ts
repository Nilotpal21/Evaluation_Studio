import { createLogger } from '@abl/compiler/platform';
import type {
  VoiceCallData,
  GatherDTMFOptions,
  PlayMessageOptions,
} from '@agent-platform/agent-transfer';
import {
  getVoiceGatewayRegistry,
  type VoiceGateway,
  type VoiceGatewaySession,
  type DialAgentOptions,
} from '@agent-platform/agent-transfer';

const log = createLogger('realtime-voice-session');

const MAX_REALTIME_SESSIONS = 5_000;
const REALTIME_SESSION_TTL_MS = 4 * 60 * 60 * 1000;

const BRIDGED_TRANSCRIPT_DEDUP_WINDOW_MS = 750;
const MAX_BRIDGED_TRANSCRIPT_CACHE = 256;

// Keyed by both runtimeSessionId and callSid for fast lookup
const realtimeSessionMap = new Map<string, RealtimeVoiceGatewaySession>();
const realtimeSessionTimestamps = new Map<string, number>();
// Track sessionId → callSid so both keys are cleaned up together
const sessionIdToCallSid = new Map<string, string>();

type JambonzWebSocket = { readyState: number; send(data: string): void };

/** verb:hook path used for CSAT DTMF gather in the S2S realtime path */
export const CSAT_GATHER_HOOK = '/csat-gather';

export class RealtimeVoiceGatewaySession implements VoiceGatewaySession {
  readonly sessionId: string;
  readonly tenantId: string;
  private readonly callData: VoiceCallData;
  private readonly ws: JambonzWebSocket;
  private readonly sttVendor: string;
  private readonly sttLanguage: string;
  private readonly recentTranscripts = new Map<string, number>();

  /** One-shot resolver for CSAT DTMF gather — set by gatherDTMF(), consumed by the S2S router verb:hook handler */
  csatGatherResolve?: (digits: string | null) => void;

  constructor(params: {
    sessionId: string;
    tenantId: string;
    sttVendor?: string;
    sttLanguage?: string;
    ws: JambonzWebSocket;
    callData: VoiceCallData;
  }) {
    this.sessionId = params.sessionId;
    this.tenantId = params.tenantId;
    this.sttVendor = params.sttVendor ?? 'deepgram';
    this.sttLanguage = params.sttLanguage ?? 'en-US';
    this.callData = params.callData;
    this.ws = params.ws;
  }

  getVoiceCallData(): VoiceCallData {
    return this.callData;
  }

  isActive(): boolean {
    return this.ws.readyState === 1;
  }

  private buildTranscriptionHookUrl(): string | null {
    const base = process.env.RUNTIME_PUBLIC_BASE_URL ?? process.env.RUNTIME_BASE_URL;
    if (!base || base.trim().length === 0) return null;
    return `${base.replace(/\/+$/, '')}/api/v1/voice/korevg/hook/${this.sessionId}/call-transcriptions`;
  }

  /**
   * Send a TTS message to the caller via Jambonz's own TTS engine.
   * Called for agent:message events during the transfer phase. Uses tts:tokens
   * so the message is injected into the current llm verb without breaking call flow.
   */
  sendAgentMessage(text: string): void {
    if (!this.isActive()) return;
    this.ws.send(JSON.stringify({ type: 'command', command: 'tts:tokens', data: { token: text } }));
    this.ws.send(JSON.stringify({ type: 'command', command: 'tts:flush' }));
  }

  /**
   * Play a waiting/hold message to the caller via Jambonz's TTS engine.
   * Called for agent:waiting_message events (e.g. "Please hold while we connect you").
   */
  playMessage(text: string, _options?: PlayMessageOptions): void {
    if (!this.isActive()) return;
    this.ws.send(JSON.stringify({ type: 'command', command: 'tts:tokens', data: { token: text } }));
    this.ws.send(JSON.stringify({ type: 'command', command: 'tts:flush' }));
    log.info('[REALTIME-TTS] Playing message to caller', {
      sessionId: this.sessionId,
      textLength: text.length,
    });
  }

  /**
   * Hang up the call. Sends a Jambonz redirect+hangup verb.
   */
  hangup(_reason?: string): void {
    if (!this.isActive()) return;
    this.ws.send(
      JSON.stringify({
        type: 'command',
        command: 'redirect',
        queueCommand: false,
        data: [{ verb: 'hangup' }],
      }),
    );
  }

  /**
   * Play a TTS prompt and collect DTMF input from the caller for CSAT.
   * Sends a Jambonz gather verb via redirect and stores a resolver that the
   * S2S router's verb:hook handler resolves when Jambonz reports the digits.
   */
  gatherDTMF(prompt: string, options?: GatherDTMFOptions): Promise<string | null> {
    return new Promise((resolve) => {
      if (!this.isActive()) {
        resolve(null);
        return;
      }

      const timeoutSec = options?.timeout ?? 10;
      const numDigits = options?.numDigits ?? 1;

      // Estimate speaking time for the prompt so Jambonz's gather timeout covers prompt + input window.
      const estimatedPromptSec = Math.ceil(prompt.split(/\s+/).length / 2.5);
      const jambonzTimeoutSec = estimatedPromptSec + timeoutSec;
      // Node.js fallback fires 2s after Jambonz's expected timeout.
      const fallbackMs = (jambonzTimeoutSec + 2) * 1000;

      const timer = setTimeout(() => {
        if (this.csatGatherResolve === localResolve) {
          this.csatGatherResolve = undefined;
        }
        log.info('[REALTIME-CSAT] Timed out waiting for DTMF', {
          sessionId: this.sessionId,
        });
        resolve(null);
      }, fallbackMs);

      const localResolve = (digits: string | null) => {
        clearTimeout(timer);
        resolve(digits);
      };

      this.csatGatherResolve = localResolve;

      this.ws.send(
        JSON.stringify({
          type: 'command',
          command: 'redirect',
          queueCommand: false,
          data: [
            {
              verb: 'gather',
              input: ['digits'],
              numDigits,
              timeout: jambonzTimeoutSec,
              bargein: false,
              actionHook: CSAT_GATHER_HOOK,
              say: { text: prompt },
            },
          ],
        }),
      );

      log.info('[REALTIME-CSAT] Dispatched DTMF gather', {
        sessionId: this.sessionId,
        numDigits,
        timeoutSec,
      });
    });
  }

  /**
   * Play a TTS message then hang up atomically via Jambonz's say+hangup verb sequence.
   * Jambonz executes redirect verbs sequentially, so hangup fires only after say completes.
   * We also await an estimated speaking duration so the caller hears the full message.
   */
  async playThenHangup(text: string, _reason?: string): Promise<void> {
    if (!this.isActive()) return;

    this.ws.send(
      JSON.stringify({
        type: 'command',
        command: 'redirect',
        queueCommand: false,
        data: [{ verb: 'say', text }, { verb: 'hangup' }],
      }),
    );

    log.info('[REALTIME-TTS] Playing final message then hanging up', {
      sessionId: this.sessionId,
      textLength: text.length,
    });

    // Await estimated speaking time (words / 2.5 wps) + 1.5 s buffer so the caller
    // hears the message before the Promise resolves and voice-csat returns.
    const estimatedMs = Math.ceil(text.split(/\s+/).length / 2.5) * 1000 + 1500;
    await new Promise<void>((resolve) => setTimeout(resolve, estimatedMs));
  }

  async dialAgent(sipUri: string, _options?: DialAgentOptions): Promise<void> {
    if (!this.isActive()) {
      throw new Error('Realtime voice WebSocket not connected');
    }

    const agentName = sipUri.replace(/^sips?:/, '').replace(/:\d+$/, '');
    if (!agentName || !agentName.includes('@')) {
      throw new Error(`Cannot extract agent name from SIP URI: ${sipUri}`);
    }

    const transcriptionHookUrl = this.buildTranscriptionHookUrl();
    const dialVerb: Record<string, unknown> = {
      verb: 'dial',
      target: [{ type: 'user', name: agentName }],
      callerId: this.callData.caller || undefined,
      answerOnBridge: false,
      timeout: 30,
      actionHook: '/agent-dial-status',
      ...(transcriptionHookUrl
        ? {
            transcribe: {
              transcriptionHook: transcriptionHookUrl,
              recognizer: {
                vendor: this.sttVendor,
                language: this.sttLanguage,
                interim: false,
                dualChannel: true,
                separateRecognitionPerChannel: true,
                diarization: true,
                diarizationMinSpeakers: 1,
                diarizationMaxSpeakers: 2,
              },
            },
          }
        : {}),
    };

    const command = {
      type: 'command',
      command: 'redirect',
      queueCommand: false,
      data: [{ verb: 'config', bargeIn: { enable: false } }, dialVerb],
    };

    const [agentUser, agentDomain] = agentName.split('@');
    log.info('[REALTIME-DIAL] Bridging realtime caller to agent', {
      sessionId: this.sessionId,
      callSid: this.callData.callSid,
      agentUser,
      agentDomain,
      hasTranscriptionHook: !!transcriptionHookUrl,
    });

    this.ws.send(JSON.stringify(command));
  }

  /**
   * Handle a Jambonz call-transcriptions HTTP hook for the bridged call.
   * Classifies the speaker (user vs human_agent) and persists the transcript
   * via the same persistence service used by the voice pipeline channel.
   */
  async handleBridgedCallTranscription(data: Record<string, unknown>): Promise<void> {
    const speechPayload =
      data.speech && typeof data.speech === 'object' && !Array.isArray(data.speech)
        ? (data.speech as {
            alternatives?: Array<{ transcript?: string }>;
            transcript?: string;
            channel_tag?: number | string;
          })
        : undefined;

    const content = (
      speechPayload?.alternatives?.[0]?.transcript ??
      speechPayload?.transcript ??
      (typeof data.transcript === 'string' ? data.transcript : undefined)
    )?.trim();

    if (!content) return;

    // Dedup within a 750 ms window — Jambonz sometimes delivers duplicate final segments.
    const now = Date.now();
    const dedupKey = content.toLowerCase().replace(/\s+/g, ' ');
    const lastSeen = this.recentTranscripts.get(dedupKey);
    if (lastSeen !== undefined && now - lastSeen < BRIDGED_TRANSCRIPT_DEDUP_WINDOW_MS) return;
    if (this.recentTranscripts.size >= MAX_BRIDGED_TRANSCRIPT_CACHE) {
      const oldest = this.recentTranscripts.keys().next().value;
      if (oldest) this.recentTranscripts.delete(oldest);
    }
    this.recentTranscripts.set(dedupKey, now);

    // Classify speaker: explicit member_name wins; otherwise fall back to channel_tag (2 = agent).
    const memberName = typeof data.member_name === 'string' ? data.member_name.trim() : undefined;
    const channelTagRaw = speechPayload?.channel_tag;
    const channelTag =
      typeof channelTagRaw === 'number'
        ? channelTagRaw
        : typeof channelTagRaw === 'string'
          ? Number(channelTagRaw)
          : NaN;
    const participant: 'user' | 'human_agent' =
      memberName === 'externalAgent'
        ? 'human_agent'
        : Number.isFinite(channelTag)
          ? channelTag === 2
            ? 'human_agent'
            : 'user'
          : 'user';

    try {
      const [{ getTransferSessionStore }, at, { getAgentTransferTranscriptPersistenceService }] =
        await Promise.all([
          import('../../agent-transfer/index.js'),
          import('@agent-platform/agent-transfer'),
          import('../../agent-transfer/transcript-persistence.js'),
        ]);

      const store = getTransferSessionStore();
      if (!store) return;

      const transferSessionId = at.sessionKey(this.tenantId, this.sessionId, 'voice');
      const transferSession = await store.get(transferSessionId);
      if (!transferSession) {
        log.warn('[REALTIME-TRANSCRIPT] No transfer session found, skipping transcript', {
          sessionId: this.sessionId,
          transferSessionId,
        });
        return;
      }

      const service = getAgentTransferTranscriptPersistenceService();

      if (participant === 'user') {
        await service.persistForwardedUserMessage({
          transferSessionId,
          transferSession:
            transferSession as import('@agent-platform/agent-transfer').TransferSessionData,
          content,
        });
      } else {
        await service.persistObservedAgentTranscript({
          transferSessionId,
          transferSession:
            transferSession as import('@agent-platform/agent-transfer').TransferSessionData,
          content,
          agentInfo: memberName && memberName !== 'externalAgent' ? { memberName } : undefined,
        });
      }

      log.info('[REALTIME-TRANSCRIPT] Persisted bridged voice transcript', {
        sessionId: this.sessionId,
        transferSessionId,
        participant,
        contentPreview: content.substring(0, 80),
      });
    } catch (err) {
      log.warn('[REALTIME-TRANSCRIPT] Failed to persist bridged voice transcript', {
        sessionId: this.sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  async flushTransferTranscriptQueueOnClose(): Promise<void> {
    const { getAgentTransferTranscriptPersistenceService } =
      await import('../../agent-transfer/transcript-persistence.js');
    await getAgentTransferTranscriptPersistenceService().flushRuntimeSessionTransferTranscript({
      runtimeSessionId: this.sessionId,
      tenantId: this.tenantId,
      channelType: 'voice_realtime',
      parentConversationSessionId: this.sessionId,
      reason: 'realtime_voice_session_close',
    });
  }
}

class RealtimeVoiceGateway implements VoiceGateway {
  readonly name = 'korevg_realtime';
  readonly supportedChannels: ReadonlySet<string> = new Set(['voice_realtime']);

  getSession(key: string): RealtimeVoiceGatewaySession | undefined {
    const session = realtimeSessionMap.get(key);
    if (!session) return undefined;
    const ts = realtimeSessionTimestamps.get(key);
    if (ts !== undefined && Date.now() - ts > REALTIME_SESSION_TTL_MS) {
      realtimeSessionMap.delete(key);
      realtimeSessionTimestamps.delete(key);
      return undefined;
    }
    return session;
  }

  isAvailable(): boolean {
    return true;
  }
}

let gatewayRegistered = false;
const realtimeGateway = new RealtimeVoiceGateway();

function ensureGatewayRegistered(): void {
  if (!gatewayRegistered) {
    getVoiceGatewayRegistry().register(realtimeGateway);
    gatewayRegistered = true;
  }
}

export function registerRealtimeVoiceSession(
  runtimeSessionId: string,
  callSid: string,
  session: RealtimeVoiceGatewaySession,
): void {
  ensureGatewayRegistered();

  if (realtimeSessionMap.size >= MAX_REALTIME_SESSIONS) {
    const firstKey = realtimeSessionMap.keys().next().value;
    if (firstKey) {
      realtimeSessionMap.delete(firstKey);
      realtimeSessionTimestamps.delete(firstKey);
    }
  }

  const now = Date.now();
  realtimeSessionMap.set(runtimeSessionId, session);
  realtimeSessionTimestamps.set(runtimeSessionId, now);
  if (callSid && callSid !== runtimeSessionId) {
    realtimeSessionMap.set(callSid, session);
    realtimeSessionTimestamps.set(callSid, now);
  }
  sessionIdToCallSid.set(runtimeSessionId, callSid);

  log.info('[REALTIME-SESSION] Registered voice session', {
    sessionId: runtimeSessionId,
    callSid,
  });
}

export function unregisterRealtimeVoiceSession(runtimeSessionId: string): void {
  const session = realtimeSessionMap.get(runtimeSessionId);
  const callSid = sessionIdToCallSid.get(runtimeSessionId);

  if (session) {
    session.flushTransferTranscriptQueueOnClose().catch((err) => {
      log.warn('[REALTIME-SESSION] Agent transfer transcript queue flush failed on unregister', {
        sessionId: runtimeSessionId,
        callSid,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  }

  realtimeSessionMap.delete(runtimeSessionId);
  realtimeSessionTimestamps.delete(runtimeSessionId);
  sessionIdToCallSid.delete(runtimeSessionId);
  if (callSid && callSid !== runtimeSessionId) {
    realtimeSessionMap.delete(callSid);
    realtimeSessionTimestamps.delete(callSid);
  }

  log.info('[REALTIME-SESSION] Unregistered voice session', {
    sessionId: runtimeSessionId,
    callSid,
  });
}

export function getRealtimeVoiceCallData(key: string): VoiceCallData | undefined {
  return realtimeGateway.getSession(key)?.getVoiceCallData();
}

/** Returns the full session object for a given key (used by S2S router for CSAT gather and transcript hooks). */
export function getRealtimeVoiceSession(key: string): RealtimeVoiceGatewaySession | undefined {
  return realtimeGateway.getSession(key);
}
