/**
 * VoiceMetricsTab
 *
 * Voice-related components for the session detail view.
 * Contains VoicePreview (per-node), VoiceMetricsTab (aggregate metrics),
 * and supporting sub-components (MetricCard, MosGauge, MiniMetric).
 */

'use client';

import { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  Phone,
  PhoneOff,
  Mic,
  Volume2,
  VolumeX,
  Activity,
  ArrowDown,
  ArrowUp,
  Signal,
  AlertTriangle,
  Shield,
  Timer,
  BarChart3,
  Gauge,
  Hash,
  Route,
  Maximize2,
  X,
  Clock,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { JsonViewer } from '../ui/JsonViewer';
import { MetricInfoIcon } from './MetricInfoIcon';
import type { TreeNode } from '../../hooks/useSessionDetail';
import type { TraceEvent } from '../../types';

// ── Voice preview ───────────────────────────────────────────────────────────

const VOICE_NODE_TYPES = new Set([
  'voice_session_start',
  'voice_session_end',
  'voice_turn',
  'voice_stt',
  'voice_tts',
]);

export function isVoiceNode(type: string): boolean {
  return VOICE_NODE_TYPES.has(type);
}

function ParamRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center gap-2 px-3 py-2 bg-background-muted rounded-lg text-sm">
      <span className="text-muted font-medium">{label}:</span>
      <span className="text-foreground">{value}</span>
    </div>
  );
}

export function VoicePreview({ node }: { node: TreeNode }) {
  const d = (node.data || {}) as Record<string, unknown>;

  switch (node.type) {
    case 'voice_stt': {
      const confidence = (d.confidence as number) ?? 0;
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              Speech-to-Text
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <ParamRow label="Provider" value={(d.provider as string) || '--'} />
              <ParamRow label="Confidence" value={`${(confidence * 100).toFixed(1)}%`} />
              <ParamRow label="Language" value={(d.language as string) || '--'} />
              <ParamRow label="Turn" value={String(d.turn_number ?? '--')} />
            </div>
          </div>
          {!!d.transcript && (
            <div>
              <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                Transcript
              </h3>
              <div className="bg-background-muted rounded-lg p-4">
                <p className="text-sm text-foreground leading-relaxed">{d.transcript as string}</p>
              </div>
            </div>
          )}
        </div>
      );
    }

    case 'voice_tts': {
      const durationMs = (d.duration_ms as number) || 0;
      const connectionMs = (d.connection_ms as number) || 0;
      const firstChunkMs = (d.first_chunk_ms as number) || 0;
      const isStreaming = !!d.streaming;
      const spokenText = (d.text as string) || '';
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              Text-to-Speech
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <ParamRow label="Provider" value={(d.provider as string) || '--'} />
              <ParamRow label="Voice" value={(d.voice as string) || '--'} />
              <ParamRow label="Duration" value={durationMs ? `${durationMs}ms` : '--'} />
              {isStreaming && connectionMs > 0 && (
                <ParamRow label="Connection" value={`${connectionMs}ms`} />
              )}
              {!isStreaming && firstChunkMs > 0 && (
                <ParamRow label="TTFB" value={`${firstChunkMs}ms`} />
              )}
              <ParamRow label="Chunks" value={String(d.chunks ?? 0)} />
              <ParamRow label="Streaming" value={isStreaming ? 'Yes' : 'No'} />
              <ParamRow label="Turn" value={String(d.turn_number ?? '--')} />
            </div>
          </div>
          {spokenText && (
            <div>
              <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                Spoken Text
              </h3>
              <div className="bg-background-muted rounded-lg p-4">
                <p className="text-sm text-foreground whitespace-pre-wrap leading-relaxed">
                  {spokenText}
                </p>
              </div>
            </div>
          )}
        </div>
      );
    }

    case 'voice_turn': {
      const timing = d.timing as Record<string, number> | undefined;
      const tokens = d.tokens as Record<string, number> | undefined;
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              Voice Turn #{String(d.turn_number ?? '')}
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <ParamRow label="Total Latency" value={timing?.total ? `${timing.total}ms` : '--'} />
              <ParamRow
                label="STT Latency"
                value={timing?.stt != null ? `${timing.stt}ms` : '--'}
              />
              <ParamRow label="LLM Latency" value={timing?.llm ? `${timing.llm}ms` : '--'} />
              <ParamRow label="TTS Latency" value={timing?.tts ? `${timing.tts}ms` : '--'} />
              {timing?.ttsConnection ? (
                <ParamRow label="TTS Connection" value={`${timing.ttsConnection}ms`} />
              ) : null}
              <ParamRow
                label="Overhead"
                value={timing?.overhead != null ? `${timing.overhead}ms` : '--'}
              />
            </div>
          </div>
          {tokens && (
            <div>
              <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                Token Usage
              </h3>
              <div className="grid grid-cols-2 gap-3">
                <ParamRow label="Input Tokens" value={String(tokens.in ?? 0)} />
                <ParamRow label="Output Tokens" value={String(tokens.out ?? 0)} />
              </div>
            </div>
          )}
          {!!(d.utterance || d.response) && (
            <div>
              <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                Conversation
              </h3>
              <div className="space-y-3">
                {!!d.utterance && (
                  <div className="bg-background-muted rounded-lg p-4">
                    <h4 className="text-xs font-medium text-muted mb-2">User</h4>
                    <p className="text-sm text-foreground leading-relaxed">
                      {d.utterance as string}
                    </p>
                  </div>
                )}
                {!!d.response && (
                  <div className="bg-background-muted rounded-lg p-4">
                    <h4 className="text-xs font-medium text-muted mb-2">Assistant</h4>
                    <p className="text-sm text-foreground leading-relaxed">
                      {d.response as string}
                    </p>
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      );
    }

    case 'voice_session_start':
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              Call Info
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <ParamRow label="Call SID" value={(d.call_sid as string) || '--'} />
              <ParamRow label="Call ID" value={(d.callId as string) || '--'} />
              <ParamRow label="Caller" value={(d.caller as string) || '--'} />
              <ParamRow label="Called" value={(d.called as string) || '--'} />
              {!!d.caller_name && <ParamRow label="Caller Name" value={d.caller_name as string} />}
              <ParamRow label="Direction" value={(d.direction as string) || '--'} />
              {!!d.uri && <ParamRow label="SIP URI" value={d.uri as string} />}
              {!!d.originatingSipIp && (
                <ParamRow label="Originating IP" value={d.originatingSipIp as string} />
              )}
              {!!d.originatingSipTrunkName && (
                <ParamRow label="SIP Trunk" value={d.originatingSipTrunkName as string} />
              )}
              {!!d.userAgent && <ParamRow label="User Agent" value={d.userAgent as string} />}
            </div>
          </div>
          <div>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              Media Config
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <ParamRow label="STT Provider" value={(d.stt_vendor as string) || '--'} />
              <ParamRow label="TTS Provider" value={(d.tts_vendor as string) || '--'} />
              <ParamRow label="TTS Voice" value={(d.tts_voice as string) || '--'} />
              <ParamRow label="Channel" value={(d.channel as string) || 'voice'} />
            </div>
          </div>
          {!!(d.accountSid || d.voipCarrierSid || d.applicationSid) && (
            <div>
              <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
                Platform IDs
              </h3>
              <div className="grid grid-cols-1 gap-3">
                {!!d.accountSid && <ParamRow label="Account SID" value={d.accountSid as string} />}
                {!!d.voipCarrierSid && (
                  <ParamRow label="VoIP Carrier SID" value={d.voipCarrierSid as string} />
                )}
                {!!d.applicationSid && (
                  <ParamRow label="Application SID" value={d.applicationSid as string} />
                )}
              </div>
            </div>
          )}
        </div>
      );

    case 'voice_session_end':
      return (
        <div className="space-y-4">
          <div>
            <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">
              Call Summary
            </h3>
            <div className="grid grid-cols-2 gap-3">
              <ParamRow label="Call SID" value={(d.call_sid as string) || '--'} />
              <ParamRow label="Total Turns" value={String(d.total_turns ?? 0)} />
              <ParamRow label="Channel" value={(d.channel as string) || 'voice'} />
            </div>
          </div>
        </div>
      );

    default:
      return (
        <div>
          <h3 className="text-xs font-medium text-muted uppercase tracking-wide mb-3">Node Data</h3>
          <JsonViewer data={d} maxDepth={6} copyable />
        </div>
      );
  }
}

// ── Voice Metrics Tab ────────────────────────────────────────────────────────

export interface VoiceEventsData {
  sessionStart: TraceEvent | null;
  sessionEnd: TraceEvent | null;
  ttsEvents: TraceEvent[];
  sttEvents: TraceEvent[];
  turnEvents: TraceEvent[];
  bargeInEvents: TraceEvent[];
  ttsQualityEvent: TraceEvent | null;
  asrQualityEvent: TraceEvent | null;
  cascadeEvents: TraceEvent[];
}

export function VoiceMetricsTab({ voiceEvents }: { voiceEvents: VoiceEventsData }) {
  const tv = useTranslations('sessions.voice');
  const [isMaximized, setIsMaximized] = useState(false);
  const { sessionStart, sessionEnd, ttsEvents, sttEvents, turnEvents, bargeInEvents } = voiceEvents;
  const startData = (sessionStart?.data || {}) as Record<string, unknown>;
  const endData = (sessionEnd?.data || {}) as Record<string, unknown>;

  // Compute aggregate metrics
  const totalTurns = (endData.totalTurns as number) || turnEvents.length || 0;

  // Compute call duration from timestamps
  const callDurationMs =
    sessionStart && sessionEnd
      ? new Date(sessionEnd.timestamp).getTime() - new Date(sessionStart.timestamp).getTime()
      : 0;

  // ── E2E Latency stats (Metric 203) ──────────────────────────────────────
  const e2eStats = useMemo(() => {
    const e2eValues: { turn: number; e2eMs: number; bargeIn?: boolean }[] = [];
    for (const evt of turnEvents) {
      const d = evt.data as Record<string, unknown>;
      const timing = d.timing as Record<string, unknown> | undefined;
      const e2e = (timing?.e2e as number) || 0;
      if (e2e > 0) {
        e2eValues.push({
          turn: (d.turn_number as number) || e2eValues.length + 1,
          e2eMs: e2e,
          bargeIn: (d.bargeIn as boolean) || undefined,
        });
      }
    }
    const avgE2e =
      (endData.avgE2eLatencyMs as number) ||
      (e2eValues.length > 0
        ? Math.round(e2eValues.reduce((s, v) => s + v.e2eMs, 0) / e2eValues.length)
        : null);
    return { perTurn: e2eValues, avgE2eMs: avgE2e };
  }, [turnEvents, endData]);

  // ── Barge-in stats (Metric 204) ─────────────────────────────────────────
  const bargeInStats = useMemo(() => {
    const count = (endData.bargeInCount as number) ?? bargeInEvents.length;
    const rate =
      (endData.bargeInRate as number) ??
      (totalTurns > 0 ? +((bargeInEvents.length / totalTurns) * 100).toFixed(1) : 0);
    const events = bargeInEvents.map((evt) => {
      const d = evt.data as Record<string, unknown>;
      return {
        turn: d.turn_number as number,
        type: (d.type as string) || 'speech',
        agentSpeakingDurationMs: (d.agent_speaking_duration_ms as number) || undefined,
      };
    });
    return { count, rate, events };
  }, [endData, bargeInEvents, totalTurns]);

  // ── DTMF Fallback stats (Metric 209) ──────────────────────────────────
  const dtmfStats = useMemo(() => {
    const dtmfCount = (endData.dtmfTurnCount as number) ?? 0;
    const dtmfRate =
      (endData.dtmfFallbackRate as number) ??
      (totalTurns > 0 ? +((dtmfCount / totalTurns) * 100).toFixed(1) : 0);
    // Collect per-turn DTMF details from turn events
    const dtmfTurns: { turn: number; input: string }[] = [];
    for (const evt of turnEvents) {
      const d = evt.data as Record<string, unknown>;
      if (d.input_method === 'dtmf') {
        dtmfTurns.push({
          turn: (d.turn_number as number) || dtmfTurns.length + 1,
          input: ((d.utterance as string) || '').substring(0, 20),
        });
      }
    }
    return { count: dtmfCount, rate: dtmfRate, turns: dtmfTurns };
  }, [endData, turnEvents, totalTurns]);

  // ── Containment stats (Metric 206) ─────────────────────────────────────
  const containmentStats = useMemo(() => {
    const outcome = (endData.sessionOutcome as string) || 'pending';
    const isContained = (endData.isContained as boolean) ?? outcome === 'completed';
    return {
      outcome, // 'completed' | 'escalated' | 'abandoned' | 'pending'
      isContained,
      label:
        outcome === 'completed'
          ? 'Contained'
          : outcome === 'escalated'
            ? 'Escalated'
            : outcome === 'abandoned'
              ? 'Abandoned'
              : 'In Progress',
      color:
        outcome === 'completed'
          ? 'green'
          : outcome === 'escalated'
            ? 'amber'
            : outcome === 'abandoned'
              ? 'red'
              : 'blue',
    };
  }, [endData]);

  // ── Call Phase stats (Metric 207) ──────────────────────────────────────
  const callPhaseStats = useMemo(() => {
    const phase = (endData.callPhase as string) || 'conversation';
    const currentAgent = (endData.currentAgent as string) || null;
    const wasAbandoned = containmentStats.outcome === 'abandoned';

    return {
      phase, // 'greeting' | 'conversation' | 'transfer' | 'farewell'
      currentAgent,
      label:
        phase === 'greeting'
          ? 'Greeting'
          : phase === 'transfer'
            ? 'Transfer'
            : phase === 'farewell'
              ? 'Farewell'
              : 'Conversation',
      // Color-code abandonment by phase
      color: wasAbandoned
        ? phase === 'greeting'
          ? 'red' // Abandoned before engaging
          : phase === 'transfer'
            ? 'amber' // Abandoned while waiting for human
            : 'amber'
        : 'blue',
      showWarning: wasAbandoned,
      abandonmentContext: wasAbandoned
        ? phase === 'greeting'
          ? 'User hung up before first interaction'
          : phase === 'transfer'
            ? 'User hung up waiting for human agent'
            : phase === 'farewell'
              ? 'User hung up during goodbye'
              : 'User hung up mid-conversation'
        : null,
    };
  }, [endData, containmentStats.outcome]);

  // ── Call Activity / Silence stats (Metric 205) ─────────────────────────
  const activityStats = useMemo(() => {
    const agentMs = (endData.agentSpeakingMs as number) || 0;
    const processingMs = (endData.processingMs as number) || 0;
    const userMs = (endData.userSpeakingMs as number) || 0;
    const silMs = (endData.silenceMs as number) || 0;
    const silPct = (endData.silencePercent as number) ?? 0;
    const durMs = (endData.callDurationMs as number) || callDurationMs || 0;
    const total = agentMs + userMs + silMs;
    const waitingMs = Math.max(0, silMs - processingMs);
    return {
      callDurationMs: durMs,
      agentMs,
      processingMs,
      waitingMs,
      userMs,
      silenceMs: silMs,
      silencePercent: silPct,
      agentPct: total > 0 ? +((agentMs / total) * 100).toFixed(1) : 0,
      userPct: total > 0 ? +((userMs / total) * 100).toFixed(1) : 0,
      silencePct: total > 0 ? +((silMs / total) * 100).toFixed(1) : 0,
      processingPct: total > 0 ? +((processingMs / total) * 100).toFixed(1) : 0,
      waitingPct: total > 0 ? +((waitingMs / total) * 100).toFixed(1) : 0,
      hasData: total > 0,
    };
  }, [endData, callDurationMs]);

  // TTS aggregate stats
  const ttsStats = useMemo(() => {
    let totalDuration = 0;
    let totalChunks = 0;
    let streamingCount = 0;
    let nonStreamingCount = 0;
    let totalTtfb = 0;
    let ttfbCount = 0;
    let totalConnectionMs = 0;
    let connectionCount = 0;

    for (const evt of ttsEvents) {
      const d = evt.data as Record<string, unknown>;
      const dur = (d.duration_ms as number) || 0;
      totalDuration += dur;
      totalChunks += (d.chunks as number) || 0;
      if (d.streaming) {
        streamingCount++;
        const conn = (d.connection_ms as number) || 0;
        if (conn > 0) {
          totalConnectionMs += conn;
          connectionCount++;
        }
      } else {
        nonStreamingCount++;
        const ttfb = (d.first_chunk_ms as number) || 0;
        if (ttfb > 0) {
          totalTtfb += ttfb;
          ttfbCount++;
        }
      }
    }

    return {
      count: ttsEvents.length,
      totalDuration,
      totalChunks,
      streamingCount,
      nonStreamingCount,
      avgTtfb: ttfbCount > 0 ? Math.round(totalTtfb / ttfbCount) : null,
      avgConnectionMs: connectionCount > 0 ? Math.round(totalConnectionMs / connectionCount) : null,
    };
  }, [ttsEvents]);

  // STT aggregate stats (excludes DTMF turns from confidence average)
  const sttStats = useMemo(() => {
    let totalConfidence = 0;
    let confCount = 0;
    let speechCount = 0;
    let dtmfCount = 0;

    for (const evt of sttEvents) {
      const d = evt.data as Record<string, unknown>;
      const im = d.input_method as string;
      if (im === 'dtmf') {
        dtmfCount++;
        continue;
      }
      speechCount++;
      const conf = (d.confidence as number) ?? 0;
      if (conf > 0) {
        totalConfidence += conf;
        confCount++;
      }
    }

    return {
      count: sttEvents.length,
      speechCount,
      dtmfCount,
      avgConfidence: confCount > 0 ? totalConfidence / confCount : null,
    };
  }, [sttEvents]);

  // ── TTS Quality stats (Metric 202) ─────────────────────────────────────
  const ttsQualityStats = useMemo(() => {
    const avgProxyMos = (endData.avgProxyMos as number) ?? null;
    const avgCombinedMos = (endData.avgCombinedTtsMos as number) ?? null;
    const avgTtfbMs = (endData.avgTtfbMs as number) ?? null;
    const errorCount = (endData.ttsErrorCount as number) ?? 0;
    const qualityTurns = (endData.ttsQualityTurns as number) ?? 0;

    return {
      avgProxyMos,
      avgCombinedMos,
      avgTtfbMs,
      errorCount,
      qualityTurns,
      hasData: avgProxyMos != null || avgCombinedMos != null,
    };
  }, [endData]);

  // ── ASR Quality stats (Metric 201) ─────────────────────────────────────
  const asrQualityStats = useMemo(() => {
    if (!voiceEvents.asrQualityEvent) {
      return {
        overallScore: null,
        signals: null,
        displayMetrics: null,
        issues: [],
        totalTurns: 0,
        detectorType: null,
        hasData: false,
      };
    }

    const data = voiceEvents.asrQualityEvent.data as Record<string, unknown>;
    const overallScore = (data.overallScore as number) ?? null;
    const signals = (data.signals as Record<string, number>) ?? null;
    const issues =
      (data.issues as Array<{ type: string; severity: string; description: string }>) ?? [];
    const totalTurns = (data.totalTurns as number) ?? 0;
    const detectorType = (data.detectorType as string) ?? null;

    const displayMetrics = signals
      ? {
          confidence: Math.round(signals.confidence * 100),
          clarity: Math.round(signals.clarity * 100),
          repetitionRate: Math.round(signals.repetition * 100),
          hesitationRate: Math.round(signals.hesitation * 100),
          correctionRate: Math.round(signals.correction * 100),
        }
      : null;

    return {
      overallScore,
      signals,
      displayMetrics,
      issues,
      totalTurns,
      detectorType,
      hasData: overallScore != null,
    };
  }, [voiceEvents.asrQualityEvent]);

  // ── ASR Cascade Detection stats (Metric 210) ───────────────────────────
  const cascadeStats = useMemo(() => {
    if (!voiceEvents.cascadeEvents || voiceEvents.cascadeEvents.length === 0) {
      return {
        hasData: false,
        totalEvents: 0,
        highRiskCount: 0,
        mediumRiskCount: 0,
        events: [],
      };
    }

    const events = voiceEvents.cascadeEvents.map((event) => {
      const data = event.data as Record<string, unknown>;
      return {
        turnIndex: (data.turnIndex as number) ?? 0,
        risk: (data.cascadeRisk as string) ?? 'low',
        score: (data.riskScore as number) ?? 0,
        factors: (data.contributingFactors as string[]) ?? [],
        networkQuality: (data.networkQuality as string) ?? 'unknown',
        rootCause: (data.rootCause as string) ?? 'unknown',
        recommendation: (data.recommendation as string) ?? '',
        transcript: (data.transcript as string) ?? '',
        confidence: (data.confidence as number) ?? 1.0,
      };
    });

    const highRiskCount = events.filter((e) => e.risk === 'high').length;
    const mediumRiskCount = events.filter((e) => e.risk === 'medium').length;

    return {
      hasData: true,
      totalEvents: events.length,
      highRiskCount,
      mediumRiskCount,
      events,
    };
  }, [voiceEvents.cascadeEvents]);

  // Homer / Network Quality data (stored as snake_case in ClickHouse)
  const homerAvailable = !!(endData.homerAvailable || endData.homer_available);
  const inboundMos = (endData.inboundNetworkMos || endData.inbound_network_mos) as number | null;
  const outboundMos = (endData.outboundNetworkMos || endData.outbound_network_mos) as number | null;
  const inboundRFactor = (endData.inboundRFactor || endData.inbound_r_factor) as number | null;
  const outboundRFactor = (endData.outboundRFactor || endData.outbound_r_factor) as number | null;
  const inboundJitter = (endData.inboundJitterMs || endData.inbound_jitter_ms) as number | null;
  const outboundJitter = (endData.outboundJitterMs || endData.outbound_jitter_ms) as number | null;
  const inboundPacketLoss = (endData.inboundPacketLoss || endData.inbound_packet_loss) as
    | number
    | null;
  const outboundPacketLoss = (endData.outboundPacketLoss || endData.outbound_packet_loss) as
    | number
    | null;
  const disconnectInitiator = (endData.sipDisconnectInitiator ||
    endData.sip_disconnect_initiator ||
    endData.disconnect_initiator) as string | null;
  const disconnectMethod = endData.sipDisconnectMethod as string | null;
  const disconnectReason = endData.sipDisconnectReason as string | null;
  const sipStatusCode = endData.sipStatusCode as number | null;

  // Metrics content component
  const metricsContent = (
    <>
      {/* Maximize/Restore button */}
      <div
        className={`flex justify-end mb-3 ${isMaximized ? 'sticky top-0 z-10 bg-background/95 backdrop-blur-sm pb-2' : ''}`}
      >
        <button
          onClick={() => setIsMaximized(!isMaximized)}
          className="flex items-center gap-1.5 px-3 py-1.5 text-xs text-muted hover:text-foreground bg-background-subtle hover:bg-background-muted border border-default rounded-lg transition-default"
          aria-label={isMaximized ? 'Restore metrics view' : 'Maximize metrics view'}
        >
          {isMaximized ? (
            <>
              <X className="w-3.5 h-3.5" />
              <span>Close</span>
            </>
          ) : (
            <>
              <Maximize2 className="w-3.5 h-3.5" />
              <span>Maximize</span>
            </>
          )}
        </button>
      </div>

      <div className="space-y-6">
        {/* ── Call Overview Card ──────────────────────────────────────────── */}
        <div className="rounded-xl border border-default bg-background-subtle p-5">
          <div className="flex items-center gap-2 mb-4">
            <Phone className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-semibold text-foreground">{tv('call_overview.title')}</h3>
            <MetricInfoIcon metricKey="call_overview" />
          </div>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <MetricCard
              label={tv('call_overview.duration')}
              value={callDurationMs > 0 ? formatDurationHuman(callDurationMs) : '--'}
              icon={<Timer className="w-3.5 h-3.5" />}
              color="blue"
            />
            <MetricCard
              label={tv('call_overview.turns', { count: totalTurns })}
              value={String(totalTurns)}
              icon={<Activity className="w-3.5 h-3.5" />}
              color="purple"
            />
            <MetricCard
              label="Caller"
              value={(startData.caller as string) || (startData.from as string) || '--'}
              icon={<Phone className="w-3.5 h-3.5" />}
              color="green"
              small
            />
            <MetricCard
              label="Disconnect"
              value={
                disconnectInitiator && disconnectInitiator !== 'unknown'
                  ? `${disconnectInitiator}${sipStatusCode ? ` (${sipStatusCode})` : ''}`
                  : sessionEnd
                    ? 'Completed'
                    : 'Active'
              }
              icon={<PhoneOff className="w-3.5 h-3.5" />}
              color={disconnectInitiator === 'caller' ? 'amber' : 'green'}
            />
            <MetricCard
              label="Avg E2E"
              value={e2eStats.avgE2eMs != null ? `${e2eStats.avgE2eMs}ms` : '--'}
              icon={<Gauge className="w-3.5 h-3.5" />}
              subtitle="Response latency"
              color={
                e2eStats.avgE2eMs == null
                  ? 'blue'
                  : e2eStats.avgE2eMs < 800
                    ? 'green'
                    : e2eStats.avgE2eMs < 1500
                      ? 'amber'
                      : 'red'
              }
            />
            <MetricCard
              label="Barge-ins"
              value={bargeInStats.count > 0 ? `${bargeInStats.count} (${bargeInStats.rate}%)` : '0'}
              icon={<VolumeX className="w-3.5 h-3.5" />}
              color={bargeInStats.count > 0 ? 'amber' : 'green'}
              subtitle={bargeInStats.count > 0 ? `${bargeInStats.rate}% of turns` : undefined}
            />
            <MetricCard
              label="DTMF Input"
              value={dtmfStats.count > 0 ? `${dtmfStats.count} (${dtmfStats.rate}%)` : '0'}
              icon={<Hash className="w-3.5 h-3.5" />}
              color={dtmfStats.count > 0 ? 'amber' : 'green'}
              subtitle={dtmfStats.count > 0 ? `${dtmfStats.rate}% of turns` : undefined}
            />
            <MetricCard
              label="Containment"
              value={containmentStats.label}
              icon={<Shield className="w-3.5 h-3.5" />}
              color={containmentStats.color as keyof typeof METRIC_COLORS}
              subtitle={
                containmentStats.isContained
                  ? 'AI resolved'
                  : containmentStats.outcome === 'escalated'
                    ? 'Human transfer'
                    : 'User hung up'
              }
            />
            <MetricCard
              label="Call Phase"
              value={callPhaseStats.label}
              icon={<Route className="w-3.5 h-3.5" />}
              color={callPhaseStats.color as 'blue' | 'amber' | 'red'}
              subtitle={
                callPhaseStats.showWarning
                  ? callPhaseStats.abandonmentContext || undefined
                  : callPhaseStats.currentAgent
                    ? `Agent: ${callPhaseStats.currentAgent}`
                    : undefined
              }
            />
          </div>
        </div>

        {/* ── Network Quality (MOS) Card ─────────────────────────────────── */}
        <div className="rounded-xl border border-default bg-background-subtle p-5">
          <div className="flex items-center gap-2 mb-4">
            <Signal className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-semibold text-foreground">{tv('network_quality.title')}</h3>
            <MetricInfoIcon metricKey="network_quality" />
            {!homerAvailable && (
              <span className="ml-auto flex items-center gap-1 text-xs text-muted">
                <AlertTriangle className="w-3 h-3 text-warning" />
                Homer data unavailable
              </span>
            )}
          </div>
          {homerAvailable && (inboundMos != null || outboundMos != null) ? (
            <div className="grid grid-cols-2 gap-6">
              {/* Inbound (Caller → Platform) */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-muted font-medium uppercase tracking-wide">
                  <ArrowDown className="w-3 h-3 text-info" />
                  Inbound (Caller → Platform)
                </div>
                <MosGauge value={inboundMos} label="MOS" />
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <MiniMetric
                    label="R-Factor"
                    value={inboundRFactor != null ? String(inboundRFactor) : '--'}
                  />
                  <MiniMetric
                    label="Jitter"
                    value={inboundJitter != null ? `${inboundJitter}ms` : '--'}
                  />
                  <MiniMetric
                    label="Packet Loss"
                    value={
                      inboundPacketLoss != null ? `${(inboundPacketLoss * 100).toFixed(2)}%` : '--'
                    }
                  />
                </div>
              </div>
              {/* Outbound (Platform → Caller) */}
              <div className="space-y-3">
                <div className="flex items-center gap-2 text-xs text-muted font-medium uppercase tracking-wide">
                  <ArrowUp className="w-3 h-3 text-success" />
                  Outbound (Platform → Caller)
                </div>
                <MosGauge value={outboundMos} label="MOS" />
                <div className="grid grid-cols-2 gap-2 text-xs">
                  <MiniMetric
                    label="R-Factor"
                    value={outboundRFactor != null ? String(outboundRFactor) : '--'}
                  />
                  <MiniMetric
                    label="Jitter"
                    value={outboundJitter != null ? `${outboundJitter}ms` : '--'}
                  />
                  <MiniMetric
                    label="Packet Loss"
                    value={
                      outboundPacketLoss != null
                        ? `${(outboundPacketLoss * 100).toFixed(2)}%`
                        : '--'
                    }
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center h-24 gap-2 px-4">
              {homerAvailable ? (
                <>
                  <AlertTriangle className="w-5 h-5 text-warning" />
                  <p className="text-sm text-muted text-center">
                    No network quality data captured for this call
                  </p>
                </>
              ) : (
                <>
                  <AlertTriangle className="w-5 h-5 text-warning" />
                  <p className="text-sm text-muted text-center">
                    Network quality metrics unavailable
                  </p>
                </>
              )}
            </div>
          )}
        </div>

        {/* ── TTS Quality Card (Metric 202) ─────────────────────────────── */}
        {ttsQualityStats.hasData && (
          <div className="rounded-xl border border-default bg-background-subtle p-5">
            <div className="flex items-center gap-2 mb-4">
              <Volume2 className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-foreground">{tv('tts_quality.title')}</h3>
              <MetricInfoIcon metricKey="tts_quality" />
              <span className="ml-auto text-xs text-muted">
                {tv('network_quality.turns_measured', { count: ttsQualityStats.qualityTurns })}
              </span>
            </div>
            <p className="text-xs text-muted mb-4">
              Combined TTS quality score from application metrics (proxy MOS) and network data (RTCP
              MOS).
            </p>
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <MetricCard
                label="Combined MOS"
                value={
                  ttsQualityStats.avgCombinedMos != null
                    ? ttsQualityStats.avgCombinedMos.toFixed(2)
                    : '--'
                }
                subtitle="Proxy + Network"
                icon={<Gauge className="w-3.5 h-3.5" />}
                color={
                  ttsQualityStats.avgCombinedMos == null
                    ? 'blue'
                    : ttsQualityStats.avgCombinedMos >= 4.0
                      ? 'green'
                      : ttsQualityStats.avgCombinedMos >= 3.5
                        ? 'amber'
                        : 'red'
                }
              />
              <MetricCard
                label="Proxy MOS"
                value={
                  ttsQualityStats.avgProxyMos != null
                    ? ttsQualityStats.avgProxyMos.toFixed(2)
                    : '--'
                }
                subtitle="App-level quality"
                icon={<BarChart3 className="w-3.5 h-3.5" />}
                color={
                  ttsQualityStats.avgProxyMos == null
                    ? 'blue'
                    : ttsQualityStats.avgProxyMos >= 4.0
                      ? 'green'
                      : ttsQualityStats.avgProxyMos >= 3.5
                        ? 'amber'
                        : 'red'
                }
              />
              <MetricCard
                label="Network MOS"
                value={outboundMos != null ? outboundMos.toFixed(2) : '--'}
                subtitle="RTCP data"
                icon={<Signal className="w-3.5 h-3.5" />}
                color={
                  outboundMos == null
                    ? 'blue'
                    : outboundMos >= 4.0
                      ? 'green'
                      : outboundMos >= 3.5
                        ? 'amber'
                        : 'red'
                }
              />
              <MetricCard
                label="Avg TTFB"
                value={ttsQualityStats.avgTtfbMs != null ? `${ttsQualityStats.avgTtfbMs}ms` : '--'}
                subtitle="Time to first byte"
                icon={<Timer className="w-3.5 h-3.5" />}
                color={
                  ttsQualityStats.avgTtfbMs == null
                    ? 'blue'
                    : ttsQualityStats.avgTtfbMs < 300
                      ? 'green'
                      : ttsQualityStats.avgTtfbMs < 800
                        ? 'amber'
                        : 'red'
                }
              />
            </div>
            {ttsQualityStats.errorCount > 0 && (
              <div className="mt-4 flex items-center gap-2 text-xs text-warning">
                <AlertTriangle className="w-3.5 h-3.5" />
                <span>
                  {ttsQualityStats.errorCount} TTS error
                  {ttsQualityStats.errorCount !== 1 ? 's' : ''} occurred during this session
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── ASR Quality Card (Metric 201) ─────────────────────────────── */}
        {asrQualityStats.hasData && (
          <div className="rounded-xl border border-default bg-background-subtle p-5">
            <div className="flex items-center gap-2 mb-4">
              <Mic className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-foreground">{tv('asr_quality.title')}</h3>
              <MetricInfoIcon metricKey="asr_quality" />
              <span className="ml-auto text-xs text-muted">
                {tv('asr_quality.turns_analyzed', { count: asrQualityStats.totalTurns })}
              </span>
            </div>
            <p className="text-xs text-muted mb-4">
              Multi-signal ASR quality analysis. Quality metrics (confidence & clarity) show how
              well the ASR performed. Issue detection (repetition, hesitation, correction)
              identifies potential recognition problems.
            </p>

            {/* Overall Score */}
            <div className="mb-4">
              <MetricCard
                label="Overall Quality Score"
                value={
                  asrQualityStats.overallScore != null
                    ? asrQualityStats.overallScore.toString()
                    : '--'
                }
                subtitle="0-100 scale"
                icon={<Gauge className="w-3.5 h-3.5" />}
                color={
                  asrQualityStats.overallScore == null
                    ? 'blue'
                    : asrQualityStats.overallScore >= 85
                      ? 'green'
                      : asrQualityStats.overallScore >= 70
                        ? 'amber'
                        : 'red'
                }
              />
            </div>

            {/* Quality Metrics & Issue Detection */}
            {asrQualityStats.displayMetrics && (
              <div className="space-y-4">
                {/* Quality Metrics (Higher = Better) */}
                <div className="space-y-3">
                  <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
                    <span className="text-success">✓</span> Quality Metrics (higher = better)
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted">ASR Confidence</span>
                        <span className="text-foreground font-medium">
                          {asrQualityStats.displayMetrics.confidence}%
                        </span>
                      </div>
                      <div className="w-full bg-background-hover rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${
                            asrQualityStats.displayMetrics.confidence >= 95
                              ? 'bg-success'
                              : asrQualityStats.displayMetrics.confidence >= 85
                                ? 'bg-warning'
                                : 'bg-error'
                          }`}
                          style={{ width: `${asrQualityStats.displayMetrics.confidence}%` }}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted">Speech Clarity</span>
                        <span className="text-foreground font-medium">
                          {asrQualityStats.displayMetrics.clarity}%
                        </span>
                      </div>
                      <div className="w-full bg-background-hover rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${
                            asrQualityStats.displayMetrics.clarity >= 70
                              ? 'bg-success'
                              : asrQualityStats.displayMetrics.clarity >= 40
                                ? 'bg-warning'
                                : 'bg-error'
                          }`}
                          style={{ width: `${asrQualityStats.displayMetrics.clarity}%` }}
                        />
                      </div>
                    </div>
                  </div>
                </div>

                {/* Issue Detection (Lower = Better) */}
                <div className="space-y-3">
                  <h4 className="text-xs font-medium text-foreground flex items-center gap-1.5">
                    <span className="text-warning">⚠</span> Issue Detection (lower = better)
                  </h4>
                  <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted">Repetition</span>
                        <span className="text-foreground font-medium">
                          {asrQualityStats.displayMetrics.repetitionRate}%
                        </span>
                      </div>
                      <div className="w-full bg-background-hover rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${
                            asrQualityStats.displayMetrics.repetitionRate < 30
                              ? 'bg-success'
                              : asrQualityStats.displayMetrics.repetitionRate < 60
                                ? 'bg-warning'
                                : 'bg-error'
                          }`}
                          style={{
                            width: `${asrQualityStats.displayMetrics.repetitionRate}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted">Hesitation</span>
                        <span className="text-foreground font-medium">
                          {asrQualityStats.displayMetrics.hesitationRate}%
                        </span>
                      </div>
                      <div className="w-full bg-background-hover rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${
                            asrQualityStats.displayMetrics.hesitationRate < 30
                              ? 'bg-success'
                              : asrQualityStats.displayMetrics.hesitationRate < 60
                                ? 'bg-warning'
                                : 'bg-error'
                          }`}
                          style={{
                            width: `${asrQualityStats.displayMetrics.hesitationRate}%`,
                          }}
                        />
                      </div>
                    </div>
                    <div className="space-y-1">
                      <div className="flex items-center justify-between text-xs">
                        <span className="text-muted">Correction</span>
                        <span className="text-foreground font-medium">
                          {asrQualityStats.displayMetrics.correctionRate}%
                        </span>
                      </div>
                      <div className="w-full bg-background-hover rounded-full h-1.5">
                        <div
                          className={`h-1.5 rounded-full ${
                            asrQualityStats.displayMetrics.correctionRate < 30
                              ? 'bg-success'
                              : asrQualityStats.displayMetrics.correctionRate < 60
                                ? 'bg-warning'
                                : 'bg-error'
                          }`}
                          style={{
                            width: `${asrQualityStats.displayMetrics.correctionRate}%`,
                          }}
                        />
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            )}

            {/* Issues Detected */}
            {asrQualityStats.issues.length > 0 && (
              <div className="mt-4 space-y-2">
                <h4 className="text-xs font-medium text-foreground">Issues Detected</h4>
                <div className="space-y-1.5">
                  {asrQualityStats.issues.map((issue, idx) => (
                    <div
                      key={idx}
                      className="flex items-start gap-2 text-xs bg-background-hover rounded-lg p-2"
                    >
                      <AlertTriangle
                        className={`w-3.5 h-3.5 mt-0.5 flex-shrink-0 ${
                          issue.severity === 'high'
                            ? 'text-error'
                            : issue.severity === 'medium'
                              ? 'text-warning'
                              : 'text-accent'
                        }`}
                      />
                      <div className="flex-1">
                        <div className="flex items-center gap-2">
                          <span className="font-medium text-foreground capitalize">
                            {issue.type}
                          </span>
                          <span
                            className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                              issue.severity === 'high'
                                ? 'bg-error/10 text-error'
                                : issue.severity === 'medium'
                                  ? 'bg-warning/10 text-warning'
                                  : 'bg-accent/10 text-accent'
                            }`}
                          >
                            {issue.severity}
                          </span>
                        </div>
                        <p className="text-muted mt-0.5">{issue.description}</p>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Detector Info */}
            {asrQualityStats.detectorType && (
              <div className="mt-4 flex items-center gap-2 text-xs text-muted">
                <Shield className="w-3.5 h-3.5" />
                <span>
                  Detection method:{' '}
                  <span className="font-medium">{asrQualityStats.detectorType}</span>
                </span>
              </div>
            )}
          </div>
        )}

        {/* ── ASR Cascade Detection Card (Metric 210) ─────────────────────── */}
        {cascadeStats.hasData && (
          <div className="rounded-xl border border-default bg-background-subtle p-5">
            <div className="flex items-center gap-2 mb-4">
              <AlertTriangle className="w-4 h-4 text-warning" />
              <h3 className="text-sm font-semibold text-foreground">{tv('asr_cascade.title')}</h3>
              <MetricInfoIcon metricKey="asr_cascade" />
              <span className="ml-auto text-xs text-muted">
                {tv('asr_cascade.issues_detected', {
                  count: cascadeStats.highRiskCount + cascadeStats.mediumRiskCount,
                })}
              </span>
            </div>
            <p className="text-xs text-muted mb-4">
              Detected cascade failures where bad network → bad audio → wrong ASR → wrong intent →
              wrong response. Analysis based on ASR confidence, user repetition, clarification
              patterns, and response quality.
            </p>

            {/* Risk Summary */}
            <div className="grid grid-cols-2 gap-3 mb-4">
              <MetricCard
                label="High Risk Turns"
                value={cascadeStats.highRiskCount.toString()}
                subtitle="Score ≥ 0.7"
                icon={<AlertTriangle className="w-3.5 h-3.5" />}
                color={cascadeStats.highRiskCount > 0 ? 'red' : 'green'}
              />
              <MetricCard
                label="Medium Risk Turns"
                value={cascadeStats.mediumRiskCount.toString()}
                subtitle="Score 0.4-0.7"
                icon={<AlertTriangle className="w-3.5 h-3.5" />}
                color={cascadeStats.mediumRiskCount > 0 ? 'amber' : 'green'}
              />
            </div>

            {/* Cascade Events List - Only Medium/High Risk */}
            {(cascadeStats.highRiskCount > 0 || cascadeStats.mediumRiskCount > 0) && (
              <div className="space-y-3">
                <h4 className="text-xs font-medium text-foreground">
                  Problematic Turns ({cascadeStats.highRiskCount + cascadeStats.mediumRiskCount})
                </h4>
                <div className="space-y-2">
                  {cascadeStats.events
                    .filter((event) => event.risk !== 'low')
                    .map((event, idx) => (
                      <div
                        key={idx}
                        className={`rounded-lg p-3 border ${
                          event.risk === 'high'
                            ? 'border-error/30 bg-error/5'
                            : event.risk === 'medium'
                              ? 'border-warning/30 bg-warning/5'
                              : 'border-default bg-background-subtle'
                        }`}
                      >
                        <div className="flex items-center justify-between mb-2">
                          <div className="flex items-center gap-2">
                            <span className="text-xs font-medium text-foreground">
                              Turn {event.turnIndex}
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded text-[10px] font-medium uppercase ${
                                event.risk === 'high'
                                  ? 'bg-error/20 text-error'
                                  : event.risk === 'medium'
                                    ? 'bg-warning/20 text-warning'
                                    : 'bg-success/20 text-success'
                              }`}
                            >
                              {event.risk} risk
                            </span>
                            <span className="text-xs text-muted">
                              Score: {event.score.toFixed(2)}
                            </span>
                          </div>
                        </div>
                        {event.factors.length > 0 ? (
                          <div className="mb-2">
                            <div className="flex flex-wrap gap-1.5">
                              {event.factors.map((factor, fidx) => (
                                <span
                                  key={fidx}
                                  className="px-2 py-0.5 rounded-full text-[10px] bg-background-hover text-muted font-medium"
                                >
                                  {factor.replace(/_/g, ' ')}
                                </span>
                              ))}
                            </div>
                          </div>
                        ) : (
                          <div className="mb-2 text-xs text-success">
                            ✓ No cascade risk factors detected
                          </div>
                        )}
                        <div className="flex items-center gap-4 text-xs mb-2">
                          <div className="flex items-center gap-1.5">
                            <Route className="w-3 h-3 text-muted" />
                            <span className="text-muted">Root Cause:</span>
                            <span className="font-medium text-foreground capitalize">
                              {event.rootCause === 'unknown' && event.risk === 'low'
                                ? 'None'
                                : event.rootCause}
                            </span>
                          </div>
                        </div>
                        {event.transcript && (
                          <div className="mb-2 text-xs">
                            <span className="text-muted">User: </span>
                            <span className="text-foreground italic">"{event.transcript}"</span>
                            {event.confidence < 0.7 && (
                              <span className="ml-2 text-warning text-[10px]">
                                (confidence: {(event.confidence * 100).toFixed(0)}%)
                              </span>
                            )}
                          </div>
                        )}
                        {event.risk !== 'low' && event.recommendation && (
                          <div className="mt-2 pt-2 border-t border-default/50">
                            <div className="flex items-start gap-2 text-xs">
                              <Shield className="w-3 h-3 text-accent mt-0.5 flex-shrink-0" />
                              <p className="text-muted leading-relaxed">{event.recommendation}</p>
                            </div>
                          </div>
                        )}
                      </div>
                    ))}
                </div>
              </div>
            )}
          </div>
        )}

        {/* ── E2E Response Latency Card (Metric 203) ───────────────────── */}
        {e2eStats.perTurn.length > 0 && (
          <div className="rounded-xl border border-default bg-background-subtle p-5">
            <div className="flex items-center gap-2 mb-4">
              <Gauge className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-foreground">{tv('e2e_latency.title')}</h3>
              <MetricInfoIcon metricKey="e2e_latency" />
              <span className="ml-auto text-xs text-muted">
                {tv('e2e_latency.turns_measured', { count: e2eStats.perTurn.length })}
              </span>
            </div>
            <p className="text-xs text-muted mb-3">
              End-to-end latency: user finishes speaking → agent audio begins playing.
            </p>
            <div className="flex items-center gap-4 text-xs text-muted mb-3">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-success inline-block" />
                &lt;800ms
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-warning inline-block" />
                &lt;1500ms
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-error inline-block" />
                ≥1500ms
              </span>
            </div>
            <div className="space-y-1.5">
              {(() => {
                const maxE2e = e2eStats.perTurn.reduce((max, e) => Math.max(max, e.e2eMs), 1);
                return e2eStats.perTurn.map((entry, idx) => {
                  const pct = Math.round((entry.e2eMs / maxE2e) * 100);
                  const color =
                    entry.e2eMs < 800
                      ? 'bg-success'
                      : entry.e2eMs < 1500
                        ? 'bg-warning'
                        : 'bg-error';
                  return (
                    <div key={idx} className="flex items-center gap-2 text-xs">
                      <span className="w-4 text-muted text-right">{entry.turn}</span>
                      <div className="flex-1 bg-background-muted rounded-full h-2 overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${color}`}
                          style={{ width: `${pct}%` }}
                        />
                      </div>
                      <span className="w-16 text-right text-muted">{entry.e2eMs}ms</span>
                      {entry.bargeIn && (
                        <span className="text-[10px] text-warning font-medium">BARGE</span>
                      )}
                    </div>
                  );
                });
              })()}
            </div>
          </div>
        )}

        {/* ── Barge-in Detection Card (Metric 204) ────────────────────── */}
        {bargeInStats.count > 0 && (
          <div className="rounded-xl border border-default bg-background-subtle p-5">
            <div className="flex items-center gap-2 mb-4">
              <VolumeX className="w-4 h-4 text-warning" />
              <h3 className="text-sm font-semibold text-foreground">{tv('barge_in.title')}</h3>
              <MetricInfoIcon metricKey="barge_in" />
              <span className="ml-auto text-xs text-muted">
                {bargeInStats.count} interruption{bargeInStats.count !== 1 ? 's' : ''}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <MetricCard
                label="Total"
                value={String(bargeInStats.count)}
                icon={<VolumeX className="w-3.5 h-3.5" />}
                color="amber"
              />
              <MetricCard
                label="Rate"
                value={`${bargeInStats.rate}%`}
                icon={<BarChart3 className="w-3.5 h-3.5" />}
                color={bargeInStats.rate > 50 ? 'red' : bargeInStats.rate > 20 ? 'amber' : 'green'}
                subtitle="of turns"
              />
              <MetricCard
                label="Turns"
                value={String(totalTurns)}
                icon={<Activity className="w-3.5 h-3.5" />}
                color="blue"
              />
            </div>
            {bargeInStats.events.length > 0 && bargeInStats.events.length <= 20 && (
              <div className="space-y-2">
                <h4 className="text-xs text-muted font-medium">Event Details</h4>
                {bargeInStats.events.map((evt, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-3 px-3 py-2 bg-background-muted rounded-lg text-xs"
                  >
                    <span className="w-14 text-muted">Turn {evt.turn}</span>
                    <span
                      className={`px-1.5 py-0.5 rounded text-[10px] font-medium ${
                        evt.type === 'speech'
                          ? 'bg-warning-subtle text-warning'
                          : 'bg-info-subtle text-info'
                      }`}
                    >
                      {evt.type.toUpperCase()}
                    </span>
                    {evt.agentSpeakingDurationMs != null && (
                      <span className="text-muted ml-auto">
                        Agent spoke {(evt.agentSpeakingDurationMs / 1000).toFixed(1)}s before
                        interrupt
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── DTMF Fallback Card (Metric 209) ───────────────────────────── */}
        {dtmfStats.count > 0 && (
          <div className="rounded-xl border border-default bg-background-subtle p-5">
            <div className="flex items-center gap-2 mb-4">
              <Hash className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-foreground">{tv('dtmf_fallback.title')}</h3>
              <MetricInfoIcon metricKey="dtmf_fallback" />
              <span className="ml-auto text-xs text-muted">
                {dtmfStats.count} DTMF turn{dtmfStats.count !== 1 ? 's' : ''} ({dtmfStats.rate}% of
                total)
              </span>
            </div>
            <div className="grid grid-cols-3 gap-4 mb-4">
              <MetricCard
                label="DTMF Turns"
                value={String(dtmfStats.count)}
                icon={<Hash className="w-3.5 h-3.5" />}
                color="amber"
              />
              <MetricCard
                label="Fallback Rate"
                value={`${dtmfStats.rate}%`}
                icon={<BarChart3 className="w-3.5 h-3.5" />}
                color={dtmfStats.rate > 50 ? 'red' : dtmfStats.rate > 20 ? 'amber' : 'green'}
                subtitle="of turns"
              />
              <MetricCard
                label="Speech Turns"
                value={String(totalTurns - dtmfStats.count)}
                icon={<Mic className="w-3.5 h-3.5" />}
                color="green"
              />
            </div>
            {dtmfStats.turns.length > 0 && dtmfStats.turns.length <= 20 && (
              <div className="space-y-2">
                <h4 className="text-xs text-muted font-medium">DTMF Inputs</h4>
                {dtmfStats.turns.map((evt, idx) => (
                  <div
                    key={idx}
                    className="flex items-center gap-3 px-3 py-2 bg-background-muted rounded-lg text-xs"
                  >
                    <span className="w-14 text-muted">Turn {evt.turn}</span>
                    <span className="px-1.5 py-0.5 rounded text-[10px] font-medium bg-warning-subtle text-warning">
                      DTMF
                    </span>
                    <span className="font-mono text-foreground ml-auto">{evt.input}</span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Call Activity / Silence Card (Metric 205) ───────────────────── */}
        {activityStats.hasData && (
          <div className="rounded-xl border border-default bg-background-subtle p-5">
            <div className="flex items-center gap-2 mb-4">
              <Clock className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-foreground">{tv('call_activity.title')}</h3>
              <MetricInfoIcon metricKey="call_activity" />
              <span className="ml-auto text-xs text-muted">
                Silence: {activityStats.silencePercent}%
                {activityStats.silencePercent > 3 && (
                  <span className="text-warning ml-1">⚠ above 3% target</span>
                )}
              </span>
            </div>

            {/* Stacked activity bar */}
            <div
              className="w-full rounded-full h-4 overflow-hidden flex mb-3"
              title="Call activity breakdown"
            >
              {activityStats.agentPct > 0 && (
                <div
                  className="bg-info h-full transition-all"
                  style={{ width: `${activityStats.agentPct}%` }}
                  title={`Agent speaking: ${activityStats.agentPct}%`}
                />
              )}
              {activityStats.userPct > 0 && (
                <div
                  className="bg-success h-full transition-all"
                  style={{ width: `${activityStats.userPct}%` }}
                  title={`User speaking: ${activityStats.userPct}%`}
                />
              )}
              {activityStats.processingPct > 0 && (
                <div
                  className="bg-warning h-full transition-all"
                  style={{ width: `${activityStats.processingPct}%` }}
                  title={`Processing (E2E): ${activityStats.processingPct}%`}
                />
              )}
              {activityStats.waitingPct > 0 && (
                <div
                  className="bg-background-muted h-full transition-all"
                  style={{ width: `${activityStats.waitingPct}%` }}
                  title={`Dead air: ${activityStats.waitingPct}%`}
                />
              )}
            </div>

            {/* Legend */}
            <div className="flex flex-wrap items-center gap-4 text-xs text-muted mb-4">
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-info inline-block" />
                Agent {activityStats.agentPct}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-success inline-block" />
                User {activityStats.userPct}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-warning inline-block" />
                Processing {activityStats.processingPct}%
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full bg-background-muted inline-block" />
                Dead Air {activityStats.waitingPct}%
              </span>
            </div>

            {/* Primary breakdown */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4 mb-3">
              <MetricCard
                label="Agent Speaking"
                value={
                  activityStats.agentMs > 0 ? `${(activityStats.agentMs / 1000).toFixed(1)}s` : '--'
                }
                icon={<Volume2 className="w-3.5 h-3.5" />}
                color="blue"
                subtitle={`${activityStats.agentPct}%`}
              />
              <MetricCard
                label="User Speaking"
                value={
                  activityStats.userMs > 0 ? `${(activityStats.userMs / 1000).toFixed(1)}s` : '--'
                }
                icon={<Mic className="w-3.5 h-3.5" />}
                color="green"
                subtitle={`${activityStats.userPct}%`}
              />
              <MetricCard
                label="Silence"
                value={
                  activityStats.silenceMs > 0
                    ? `${(activityStats.silenceMs / 1000).toFixed(1)}s`
                    : '--'
                }
                icon={<Timer className="w-3.5 h-3.5" />}
                color={activityStats.silencePercent > 3 ? 'red' : 'green'}
                subtitle={`${activityStats.silencePercent}% of call`}
              />
              <MetricCard
                label="Call Duration"
                value={
                  activityStats.callDurationMs > 0
                    ? `${(activityStats.callDurationMs / 1000).toFixed(1)}s`
                    : '--'
                }
                icon={<Clock className="w-3.5 h-3.5" />}
                color="purple"
              />
            </div>

            {/* Silence breakdown */}
            {activityStats.silenceMs > 0 &&
              (() => {
                const silenceDisplay = +(activityStats.silenceMs / 1000).toFixed(1);
                const processingDisplay = +(activityStats.processingMs / 1000).toFixed(1);
                const deadAirDisplay = +(silenceDisplay - processingDisplay).toFixed(1);
                return (
                  <div className="rounded-lg border border-default bg-background p-3">
                    <div className="text-[11px] text-muted font-medium uppercase tracking-wide mb-2">
                      Silence Breakdown ({silenceDisplay}s)
                    </div>
                    <div className="grid grid-cols-2 gap-3">
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-warning inline-block flex-shrink-0" />
                        <div>
                          <div className="text-sm font-semibold text-foreground">
                            {processingDisplay > 0 ? `${processingDisplay}s` : '--'}
                          </div>
                          <div className="text-[10px] text-muted">
                            Processing (E2E) — LLM think time
                          </div>
                        </div>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className="w-2.5 h-2.5 rounded-full bg-background-muted inline-block flex-shrink-0" />
                        <div>
                          <div className="text-sm font-semibold text-foreground">
                            {deadAirDisplay > 0 ? `${deadAirDisplay}s` : '--'}
                          </div>
                          <div className="text-[10px] text-muted">Dead Air — waiting gaps</div>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })()}
          </div>
        )}

        {/* ── STT Performance Card ───────────────────────────────────────── */}
        <div className="rounded-xl border border-default bg-background-subtle p-5">
          <div className="flex items-center gap-2 mb-4">
            <Mic className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-semibold text-foreground">{tv('speech_to_text.title')}</h3>
            <MetricInfoIcon metricKey="speech_to_text" />
            <span className="ml-auto text-xs text-muted">
              {sttStats.speechCount} speech
              {sttStats.dtmfCount > 0 ? `, ${sttStats.dtmfCount} DTMF` : ''}
            </span>
          </div>
          {sttStats.count > 0 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-3 gap-4">
                <MetricCard
                  label="Avg Confidence"
                  value={
                    sttStats.avgConfidence != null
                      ? `${(sttStats.avgConfidence * 100).toFixed(1)}%`
                      : '--'
                  }
                  icon={<BarChart3 className="w-3.5 h-3.5" />}
                  color="blue"
                />
                <MetricCard
                  label={tv('speech_to_text.provider')}
                  value={(startData.sttVendor as string) || '--'}
                  icon={<Shield className="w-3.5 h-3.5" />}
                  color="purple"
                  small
                />
                <MetricCard
                  label="Language"
                  value={
                    (sttEvents[0]?.data?.language as string) ||
                    (startData.language as string) ||
                    '--'
                  }
                  icon={<Mic className="w-3.5 h-3.5" />}
                  color="green"
                  small
                />
              </div>
              {sttStats.count <= 20 && (
                <div className="space-y-1.5">
                  <h4 className="text-xs text-muted font-medium">Per-Utterance Confidence</h4>
                  {sttEvents.map((evt, idx) => {
                    const d = evt.data as Record<string, unknown>;
                    const isDtmfUtterance = d.input_method === 'dtmf';
                    const conf = (d.confidence as number) ?? 0;
                    const pct = Math.round(conf * 100);
                    return (
                      <div key={evt.id} className="flex items-center gap-2 text-xs">
                        <span className="w-4 text-muted text-right">{idx + 1}</span>
                        {isDtmfUtterance ? (
                          <>
                            <div className="flex-1 bg-warning-subtle rounded-full h-2 overflow-hidden">
                              <div
                                className="h-full rounded-full bg-warning"
                                style={{ width: '100%' }}
                              />
                            </div>
                            <span className="w-16 text-right text-warning font-mono text-[10px]">
                              DTMF: {(d.transcript as string) || ''}
                            </span>
                          </>
                        ) : (
                          <>
                            <div className="flex-1 bg-background-muted rounded-full h-2 overflow-hidden">
                              <div
                                className={`h-full rounded-full transition-all ${
                                  pct >= 90 ? 'bg-success' : pct >= 70 ? 'bg-warning' : 'bg-error'
                                }`}
                                style={{ width: `${pct}%` }}
                              />
                            </div>
                            <span className="w-10 text-right text-muted">{pct}%</span>
                          </>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-16 text-sm text-muted">
              No STT events recorded
            </div>
          )}
        </div>

        {/* ── TTS Performance Card ───────────────────────────────────────── */}
        <div className="rounded-xl border border-default bg-background-subtle p-5">
          <div className="flex items-center gap-2 mb-4">
            <Volume2 className="w-4 h-4 text-accent" />
            <h3 className="text-sm font-semibold text-foreground">{tv('text_to_speech.title')}</h3>
            <MetricInfoIcon metricKey="text_to_speech" />
            <span className="ml-auto text-xs text-muted">
              {tv('text_to_speech.syntheses', { count: ttsStats.count })}
            </span>
          </div>
          {ttsStats.count > 0 ? (
            <div className="space-y-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <MetricCard
                  label="Total Audio"
                  value={
                    ttsStats.totalDuration > 0
                      ? `${(ttsStats.totalDuration / 1000).toFixed(1)}s`
                      : '--'
                  }
                  icon={<Clock className="w-3.5 h-3.5" />}
                  color="blue"
                />
                <MetricCard
                  label="Avg TTFB"
                  value={ttsStats.avgTtfb != null ? `${ttsStats.avgTtfb}ms` : '--'}
                  icon={<Timer className="w-3.5 h-3.5" />}
                  color="amber"
                  subtitle="Non-streaming"
                />
                <MetricCard
                  label="Avg Connection"
                  value={ttsStats.avgConnectionMs != null ? `${ttsStats.avgConnectionMs}ms` : '--'}
                  icon={<Signal className="w-3.5 h-3.5" />}
                  color="green"
                  subtitle="Streaming"
                />
                <MetricCard
                  label={tv('text_to_speech.provider')}
                  value={(startData.ttsVendor as string) || '--'}
                  icon={<Shield className="w-3.5 h-3.5" />}
                  color="purple"
                  small
                />
              </div>
              <div className="flex items-center gap-4 text-xs">
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-accent" />
                  <span className="text-muted">Streaming: {ttsStats.streamingCount}</span>
                </div>
                <div className="flex items-center gap-2">
                  <div className="w-2.5 h-2.5 rounded-full bg-warning" />
                  <span className="text-muted">Non-streaming: {ttsStats.nonStreamingCount}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="text-muted">Total Chunks: {ttsStats.totalChunks}</span>
                </div>
              </div>
              {ttsStats.count <= 20 && (
                <div className="space-y-1.5">
                  <h4 className="text-xs text-muted font-medium">Per-Synthesis Latency</h4>
                  {(() => {
                    const maxDur = ttsEvents.reduce(
                      (max, e) =>
                        Math.max(
                          max,
                          ((e.data as Record<string, unknown>).durationMs as number) || 0,
                        ),
                      1,
                    );
                    return ttsEvents.map((evt, idx) => {
                      const d = evt.data as Record<string, unknown>;
                      const dur = (d.duration_ms as number) || 0;
                      const isStreaming = !!d.streaming;
                      const isGreeting = !!d.is_greeting;
                      const pct = Math.round((dur / maxDur) * 100);
                      return (
                        <div key={evt.id} className="flex items-center gap-2 text-xs">
                          <span className="w-4 text-muted text-right">{idx + 1}</span>
                          <div className="flex-1 bg-background-muted rounded-full h-2 overflow-hidden">
                            <div
                              className={`h-full rounded-full transition-all ${isStreaming ? 'bg-accent' : 'bg-warning'}`}
                              style={{ width: `${pct}%` }}
                            />
                          </div>
                          <span className="w-16 text-right text-muted">
                            {dur}ms{isGreeting ? ' 🎤' : ''}
                          </span>
                          <span className="w-10 text-xs text-muted">
                            {isStreaming ? 'S' : 'NS'}
                          </span>
                        </div>
                      );
                    });
                  })()}
                </div>
              )}
            </div>
          ) : (
            <div className="flex items-center justify-center h-16 text-sm text-muted">
              No TTS events recorded
            </div>
          )}
        </div>

        {/* ── SIP / Disconnect Card ──────────────────────────────────────── */}
        {sessionEnd && (
          <div className="rounded-xl border border-default bg-background-subtle p-5">
            <div className="flex items-center gap-2 mb-4">
              <PhoneOff className="w-4 h-4 text-accent" />
              <h3 className="text-sm font-semibold text-foreground">
                {tv('call_termination.title')}
              </h3>
              <MetricInfoIcon metricKey="call_termination" />
            </div>
            <div className="grid grid-cols-2 gap-3">
              <ParamRow label="Disconnect By" value={disconnectInitiator || 'unknown'} />
              {disconnectMethod && <ParamRow label="SIP Method" value={disconnectMethod} />}
              {sipStatusCode != null && sipStatusCode > 0 && (
                <ParamRow label="SIP Status" value={String(sipStatusCode)} />
              )}
              {disconnectReason && <ParamRow label="Reason" value={disconnectReason} />}
              <ParamRow label="Homer Data" value={homerAvailable ? 'Available' : 'Not available'} />
            </div>
          </div>
        )}
      </div>
    </>
  );

  // Render maximized view in a portal for true fullscreen
  if (isMaximized && typeof window !== 'undefined') {
    return createPortal(
      <>
        {/* Backdrop */}
        <div
          className="fixed inset-0 bg-overlay backdrop-blur-sm z-[9998]"
          onClick={() => setIsMaximized(false)}
        />
        {/* Fullscreen metrics panel */}
        <div className="fixed inset-0 z-[9999] flex items-center justify-center p-4">
          <div className="bg-background w-full h-full max-w-[1800px] rounded-2xl border border-default shadow-2xl overflow-auto p-6">
            {metricsContent}
          </div>
        </div>
      </>,
      document.body,
    );
  }

  // Normal view
  return <div className="relative">{metricsContent}</div>;
}

// ── Voice Metric Sub-Components ──────────────────────────────────────────────

const METRIC_COLORS = {
  blue: 'text-info',
  purple: 'text-purple',
  green: 'text-success',
  amber: 'text-warning',
  red: 'text-error',
} as const;

function MetricCard({
  label,
  value,
  icon,
  color = 'blue',
  subtitle,
  small,
}: {
  label: string;
  value: string;
  icon: React.ReactNode;
  color?: keyof typeof METRIC_COLORS;
  subtitle?: string;
  small?: boolean;
}) {
  return (
    <div className="rounded-lg border border-default bg-background p-3">
      <div className="flex items-center gap-1.5 mb-1.5">
        <span className={METRIC_COLORS[color]}>{icon}</span>
        <span className="text-xs text-muted font-medium">{label}</span>
      </div>
      <div className={`font-semibold text-foreground ${small ? 'text-sm truncate' : 'text-lg'}`}>
        {value}
      </div>
      {subtitle && <div className="text-[10px] text-muted mt-0.5">{subtitle}</div>}
    </div>
  );
}

function MosGauge({ value, label }: { value: number | null; label: string }) {
  if (value == null) {
    return <div className="flex items-center justify-center h-16 text-sm text-muted">No data</div>;
  }

  // MOS ranges: 4.0–4.5 = Excellent, 3.5–4.0 = Good, 3.0–3.5 = Fair, <3.0 = Poor
  const pct = Math.min(100, Math.max(0, ((value - 1) / 3.5) * 100));
  const quality =
    value >= 4.0
      ? { text: 'Excellent', color: 'text-success', barColor: 'bg-success' }
      : value >= 3.5
        ? { text: 'Good', color: 'text-success', barColor: 'bg-success' }
        : value >= 3.0
          ? { text: 'Fair', color: 'text-warning', barColor: 'bg-warning' }
          : { text: 'Poor', color: 'text-error', barColor: 'bg-error' };

  return (
    <div className="space-y-1.5">
      <div className="flex items-baseline gap-2">
        <span className={`text-2xl font-bold ${quality.color}`}>{value.toFixed(2)}</span>
        <span className={`text-xs font-medium ${quality.color}`}>{quality.text}</span>
      </div>
      <div className="w-full bg-background-muted rounded-full h-2 overflow-hidden">
        <div
          className={`h-full rounded-full transition-all ${quality.barColor}`}
          style={{ width: `${pct}%` }}
        />
      </div>
      <div className="flex justify-between text-[10px] text-muted">
        <span>1.0</span>
        <span>2.5</span>
        <span>3.5</span>
        <span>4.5</span>
      </div>
    </div>
  );
}

function MiniMetric({ label, value }: { label: string; value: string }) {
  return (
    <div className="px-2 py-1.5 rounded bg-background text-xs">
      <div className="text-muted text-[10px] font-medium">{label}</div>
      <div className="text-foreground font-medium">{value}</div>
    </div>
  );
}

function formatDurationHuman(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainSec = seconds % 60;
  return `${minutes}m ${remainSec}s`;
}
