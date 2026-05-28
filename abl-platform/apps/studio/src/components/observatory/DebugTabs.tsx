/**
 * DebugTabs Component
 *
 * Tabbed debug panel with Context, History, IR, and Logs tabs.
 * Features smooth animations and micro-interactions.
 */

import { useState, useRef, useEffect, useMemo, useCallback, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import {
  Database,
  Code2,
  Trash2,
  Download,
  Maximize2,
  Activity,
  Gauge,
  MessageSquare,
  LayoutDashboard,
  Mic,
  AlertTriangle,
  MessageCircle,
} from 'lucide-react';
import { useTranslations } from 'next-intl';
import { useObservatoryStore, type DebugTab } from '../../store/observatory-store';
import { OverviewTab } from '../session/OverviewTab';
import { PIIRevealControls, usePIIRevealPermission } from '../session/PIIRevealControls';
import { VoiceMetricsTab, type VoiceEventsData } from '../session/VoiceMetricsTab';
import { GatherProgressPanel } from './GatherProgressPanel';
import { LLMCallsTab } from './LLMCallsTab';
import { WaterfallPanel } from './WaterfallPanel';
import { SpanTree } from './SpanTree';
import { NodeDetailPanel } from './NodeDetailPanel';
import { ErrorsTab, useErrorCount } from './ErrorsTab';
import { InteractionsTab, useInteractionCount } from './interactions';
import { COMPLETED_TOOL_CALL_EVENT_TYPES, EVENT_TO_STEP } from './interactions/constants';
import { TestContextPanel } from '../test-context/TestContextPanel';
import { useSessionStore } from '../../store/session-store';
import { JsonViewer, CollapsibleSection } from '../ui/JsonViewer';
import { springs } from '../../lib/animation';
import { normalizeEventType } from '../../lib/event-types';
import clsx from 'clsx';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { selectSelectedSpan, selectSpanSummaries } from '../../features/observatory/selectors';
import type { WaterfallMode } from './WaterfallPanel';
import { formatAbsoluteTime } from './format-time';
import type {
  AgentDetails,
  AgentState,
  ExtendedTraceEvent,
  SessionMessage,
  Span,
  TraceEvent,
} from '../../types';

const DOWNLOAD_URL_REVOKE_DELAY_MS = 30_000;

interface DebugTabsProps {
  className?: string;
  tracesMode?: WaterfallMode;
  /** Session data forwarded to OverviewTab */
  traceEvents?: TraceEvent[];
  tree?: import('../../hooks/useSessionDetail').TreeNode[];
  sessionId?: string;
  projectId?: string;
  agentName?: string;
  messageCount?: number;
  createdAt?: string;
  finishedAt?: string;
}

interface DebugTraceExportInput {
  sessionId?: string | null;
  projectId?: string;
  agentName?: string;
  messageCount?: number;
  createdAt?: string;
  finishedAt?: string;
  traceEvents?: TraceEvent[];
  events: ExtendedTraceEvent[];
  spans: Map<string, Span>;
  messages: SessionMessage[];
  state: AgentState | null;
  agent: AgentDetails | null;
  logs: Array<{ timestamp: Date; level: 'info' | 'warn' | 'error'; message: string }>;
}

interface DebugTraceExportPayload {
  schemaVersion: 1;
  exportedAt: string;
  session: {
    sessionId: string | null;
    projectId: string | null;
    agentName: string | null;
    messageCount: number;
    createdAt: string | null;
    finishedAt: string | null;
  };
  trace: {
    events: Array<TraceEvent | ExtendedTraceEvent>;
    liveEvents: ExtendedTraceEvent[];
    historicalEvents: TraceEvent[];
    spans: Span[];
    liveEventCount: number;
    historicalEventCount: number;
  };
  conversation: {
    messages: SessionMessage[];
  };
  debug: {
    state: AgentState | null;
    agent: AgentDetails | null;
    logs: Array<{ timestamp: Date; level: 'info' | 'warn' | 'error'; message: string }>;
  };
}

export function buildDebugTraceExport(input: DebugTraceExportInput): {
  filename: string;
  data: DebugTraceExportPayload;
} {
  const sessionId = input.sessionId ?? null;
  const exportedAt = new Date().toISOString();
  const historicalEvents = input.traceEvents ?? [];
  const events = mergeTraceEvents(historicalEvents, input.events);
  const filenameSession = sanitizeFilenamePart(sessionId ?? 'session');

  return {
    filename: `debug-trace-${filenameSession}-${exportedAt.replace(/[:.]/g, '-')}.json`,
    data: {
      schemaVersion: 1,
      exportedAt,
      session: {
        sessionId,
        projectId: input.projectId ?? null,
        agentName: input.agentName ?? input.agent?.name ?? null,
        messageCount: input.messageCount ?? input.messages.length,
        createdAt: input.createdAt ?? null,
        finishedAt: input.finishedAt ?? null,
      },
      trace: {
        events,
        liveEvents: input.events,
        historicalEvents,
        spans: Array.from(input.spans.values()),
        liveEventCount: input.events.length,
        historicalEventCount: historicalEvents.length,
      },
      conversation: {
        messages: input.messages,
      },
      debug: {
        state: input.state,
        agent: input.agent,
        logs: input.logs,
      },
    },
  };
}

function mergeTraceEvents(
  historicalEvents: TraceEvent[],
  liveEvents: ExtendedTraceEvent[],
): Array<TraceEvent | ExtendedTraceEvent> {
  const eventIndexByKey = new Map<string, number>();
  const merged: Array<TraceEvent | ExtendedTraceEvent> = [];

  for (const event of [...historicalEvents, ...liveEvents]) {
    const key = getTraceEventExportKey(event);
    const existingIndex = eventIndexByKey.get(key);
    if (existingIndex !== undefined) {
      merged[existingIndex] = mergeTraceEventRecords(merged[existingIndex], event);
      continue;
    }
    eventIndexByKey.set(key, merged.length);
    merged.push(event);
  }

  return merged;
}

function mergeTraceEventRecords(
  existing: TraceEvent | ExtendedTraceEvent,
  incoming: TraceEvent | ExtendedTraceEvent,
): TraceEvent | ExtendedTraceEvent {
  return {
    ...existing,
    ...incoming,
    data: {
      ...(existing.data ?? {}),
      ...(incoming.data ?? {}),
    },
  } as TraceEvent | ExtendedTraceEvent;
}

function getTraceEventExportKey(event: TraceEvent | ExtendedTraceEvent): string {
  if (event.id) {
    return `id:${event.id}`;
  }

  return [
    'fallback',
    event.traceId ?? '',
    event.spanId ?? '',
    event.sessionId ?? '',
    event.type ?? '',
    String(event.timestamp ?? ''),
  ].join(':');
}

function sanitizeFilenamePart(value: string): string {
  const sanitized = value.replace(/[^a-zA-Z0-9_-]/g, '-').replace(/-+/g, '-');
  return sanitized.replace(/^-|-$/g, '') || 'session';
}

function downloadJson(filename: string, data: DebugTraceExportPayload): void {
  const blob = new Blob([safeStringifyJson(data)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.style.display = 'none';

  try {
    document.body.appendChild(anchor);
    anchor.click();
  } finally {
    anchor.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), DOWNLOAD_URL_REVOKE_DELAY_MS);
  }
}

function safeStringifyJson(value: unknown): string {
  return JSON.stringify(toJsonSafe(value), null, 2);
}

function toJsonSafe(value: unknown, ancestors = new WeakSet<object>()): unknown {
  if (typeof value === 'bigint') {
    return value.toString();
  }

  if (typeof value === 'undefined') {
    return '[Undefined]';
  }

  if (typeof value === 'function') {
    return value.name ? `[Function: ${value.name}]` : '[Function]';
  }

  if (typeof value === 'symbol') {
    return value.description ? `[Symbol: ${value.description}]` : '[Symbol]';
  }

  if (value === null || typeof value !== 'object') {
    return value;
  }

  if (ancestors.has(value)) {
    return '[Circular]';
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (value instanceof Error) {
    ancestors.add(value);
    try {
      return {
        name: value.name,
        message: value.message,
        stack: value.stack,
        cause: toJsonSafe(value.cause, ancestors),
      };
    } finally {
      ancestors.delete(value);
    }
  }

  if (value instanceof RegExp) {
    return {
      type: 'RegExp',
      source: value.source,
      flags: value.flags,
    };
  }

  if (typeof URL === 'function' && value instanceof URL) {
    return value.toString();
  }

  if (typeof URLSearchParams === 'function' && value instanceof URLSearchParams) {
    return Array.from(value.entries(), ([key, paramValue]) => ({ key, value: paramValue }));
  }

  if (typeof File !== 'undefined' && value instanceof File) {
    return {
      type: 'File',
      name: value.name,
      size: value.size,
      mimeType: value.type,
      lastModified: value.lastModified,
    };
  }

  if (typeof Blob !== 'undefined' && value instanceof Blob) {
    return {
      type: 'Blob',
      size: value.size,
      mimeType: value.type,
    };
  }

  if (value instanceof ArrayBuffer) {
    return {
      type: 'ArrayBuffer',
      byteLength: value.byteLength,
      values: Array.from(new Uint8Array(value)),
    };
  }

  if (ArrayBuffer.isView(value)) {
    return serializeArrayBufferView(value);
  }

  ancestors.add(value);
  try {
    if (value instanceof Map) {
      return Array.from(value.entries(), ([key, mapValue]) => ({
        key: toJsonSafe(key, ancestors),
        value: toJsonSafe(mapValue, ancestors),
      }));
    }

    if (value instanceof Set) {
      return Array.from(value.values(), (item) => toJsonSafe(item, ancestors));
    }

    if (Array.isArray(value)) {
      return value.map((item) => toJsonSafe(item, ancestors));
    }

    return serializePlainObject(value, ancestors);
  } finally {
    ancestors.delete(value);
  }
}

function serializeArrayBufferView(value: ArrayBufferView): unknown {
  if (value instanceof DataView) {
    return {
      type: 'DataView',
      byteLength: value.byteLength,
    };
  }

  return {
    type: value.constructor.name,
    values: Array.from(value as unknown as ArrayLike<number>),
  };
}

function serializePlainObject(value: object, ancestors: WeakSet<object>): Record<string, unknown> {
  const output: Record<string, unknown> = {};

  for (const key of Reflect.ownKeys(value)) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);
    if (!descriptor?.enumerable) {
      continue;
    }

    const outputKey = typeof key === 'symbol' ? key.toString() : key;
    try {
      if ('value' in descriptor) {
        output[outputKey] = toJsonSafe(descriptor.value, ancestors);
      } else if (descriptor.get) {
        output[outputKey] = toJsonSafe(descriptor.get.call(value), ancestors);
      }
    } catch (error) {
      output[outputKey] = `[Unreadable: ${formatThrownValue(error)}]`;
    }
  }

  return output;
}

function formatThrownValue(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function DebugTabs({
  className,
  tracesMode = 'live',
  traceEvents,
  tree,
  sessionId,
  projectId,
  agentName,
  messageCount,
  createdAt,
  finishedAt,
}: DebugTabsProps) {
  const t = useTranslations('observatory.debug_tabs');
  const debugPanelTab = useObservatoryStore((s) => s.debugPanelTab);
  const setDebugPanelTab = useObservatoryStore((s) => s.setDebugPanelTab);
  const debugPanelMode = useObservatoryStore((s) => s.debugPanelMode);
  const setDebugPanelMode = useObservatoryStore((s) => s.setDebugPanelMode);
  const logs = useObservatoryStore((s) => s.logs);
  const clearLogs = useObservatoryStore((s) => s.clearLogs);
  const events = useObservatoryStore((s) => s.events);
  const spans = useObservatoryStore((s) => s.spans);
  const currentSessionId = useSessionStore((s) => s.sessionId);
  const agent = useSessionStore((s) => s.agent);
  const messages = useSessionStore((s) => s.messages);
  const state = useSessionStore((s) => s.state);
  const tabsRef = useRef<Map<string, HTMLButtonElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);
  const [indicatorStyle, setIndicatorStyle] = useState({ left: 0, width: 0 });

  const errorCount = useErrorCount();
  const interactionCount = useInteractionCount();
  const exportEventCount = (traceEvents?.length ?? 0) + events.length;
  const exportTraceDisabled = exportEventCount === 0 && spans.size === 0;
  const handleExportTrace = useCallback(() => {
    const payload = buildDebugTraceExport({
      sessionId: sessionId ?? currentSessionId,
      projectId,
      agentName,
      messageCount,
      createdAt,
      finishedAt,
      traceEvents,
      events,
      spans,
      messages,
      state,
      agent,
      logs,
    });
    downloadJson(payload.filename, payload.data);
  }, [
    agent,
    agentName,
    createdAt,
    currentSessionId,
    events,
    finishedAt,
    logs,
    messageCount,
    messages,
    projectId,
    sessionId,
    spans,
    state,
    traceEvents,
  ]);

  // Detect voice session from observatory events
  const isVoiceSession = useMemo(
    () => events.some((e) => e.type === 'voice_session_start'),
    [events],
  );

  // Extract voice event data for VoiceMetricsTab
  const voiceEvents: VoiceEventsData = useMemo(() => {
    if (!isVoiceSession)
      return {
        sessionStart: null,
        sessionEnd: null,
        ttsEvents: [],
        sttEvents: [],
        turnEvents: [],
        bargeInEvents: [],
        ttsQualityEvent: null,
        asrQualityEvent: null,
        cascadeEvents: [],
      };
    return {
      sessionStart: events.find((e) => e.type === 'voice_session_start') || null,
      sessionEnd: events.find((e) => e.type === 'voice_session_end') || null,
      ttsEvents: events.filter((e) => e.type === 'voice_tts'),
      sttEvents: events.filter((e) => e.type === 'voice_stt'),
      turnEvents: events.filter((e) => e.type === 'voice_turn'),
      bargeInEvents: events.filter((e) => e.type === 'voice_barge_in'),
      ttsQualityEvent: events.find((e) => e.type === 'voice_tts_quality') || null,
      asrQualityEvent: events.find((e) => e.type === 'voice_asr_quality') || null,
      cascadeEvents: events.filter((e) => e.type === 'voice_asr_cascade'),
    };
  }, [events, isVoiceSession]);

  const tabs: Array<{
    id: DebugTab;
    label: string;
    icon: React.ElementType;
    badge?: number;
    deprecated?: boolean;
  }> = useMemo(
    () => [
      { id: 'overview', label: t('tab_overview') || 'Overview', icon: LayoutDashboard },
      {
        id: 'interactions',
        label: t('tab_traces_new') || 'Traces',
        icon: Activity,
        badge: interactionCount > 0 ? interactionCount : undefined,
      },
      {
        id: 'errors',
        label: t('tab_errors') || 'Errors',
        icon: AlertTriangle,
        badge: errorCount,
      },
      { id: 'data', label: t('tab_data'), icon: Database },
      { id: 'conversation', label: t('tab_conversation'), icon: MessageSquare },
      { id: 'performance', label: t('tab_performance'), icon: Gauge },
      { id: 'ir', label: t('tab_ir'), icon: Code2 },
      ...(isVoiceSession
        ? [{ id: 'voice' as DebugTab, label: t('tab_voice') || 'Voice', icon: Mic }]
        : []),
      {
        id: 'traces',
        label: t('tab_traces') || 'Traces',
        icon: Activity,
        deprecated: true,
      },
    ],
    [t, isVoiceSession, errorCount, interactionCount],
  );

  // Shared helper to recalculate indicator position
  const updateIndicator = useCallback(() => {
    const activeTab = tabsRef.current.get(debugPanelTab);
    const container = containerRef.current;
    if (activeTab && container) {
      const containerRect = container.getBoundingClientRect();
      const tabRect = activeTab.getBoundingClientRect();
      setIndicatorStyle({
        left: tabRect.left - containerRect.left + container.scrollLeft,
        width: tabRect.width,
      });
    }
  }, [debugPanelTab]);

  // Update indicator position when tab changes — also scroll active tab into view
  useEffect(() => {
    const activeTab = tabsRef.current.get(debugPanelTab);
    if (activeTab) {
      activeTab.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
    }
    updateIndicator();
  }, [debugPanelTab, updateIndicator]);

  // Also update on resize and scroll
  useEffect(() => {
    const container = containerRef.current;
    window.addEventListener('resize', updateIndicator);
    container?.addEventListener('scroll', updateIndicator);
    // Initial update after mount
    const timer = setTimeout(updateIndicator, 50);
    return () => {
      window.removeEventListener('resize', updateIndicator);
      container?.removeEventListener('scroll', updateIndicator);
      clearTimeout(timer);
    };
  }, [updateIndicator]);

  return (
    <div className={clsx('flex flex-col h-full bg-background', className)}>
      {/* Tab bar */}
      <div className="relative flex border-b border-default">
        {/* Scrollable tab container */}
        <div ref={containerRef} className="relative flex overflow-x-auto scrollbar-hide flex-1">
          {/* Animated indicator */}
          <motion.div
            className="absolute bottom-0 h-0.5 bg-accent z-10"
            initial={false}
            animate={{
              left: indicatorStyle.left,
              width: indicatorStyle.width,
            }}
            transition={springs.snappy}
          />

          {tabs.map((tab) => (
            <motion.button
              key={tab.id}
              ref={(el) => {
                if (el) tabsRef.current.set(tab.id, el);
              }}
              onClick={() => setDebugPanelTab(tab.id)}
              whileHover={{ backgroundColor: 'hsl(var(--background-muted))' }}
              whileTap={{ scale: 0.97, backgroundColor: 'hsl(var(--accent-subtle))' }}
              className={clsx(
                'relative flex items-center justify-center gap-1.5 px-3 py-2.5 text-xs font-medium transition-colors whitespace-nowrap flex-shrink-0',
                debugPanelTab === tab.id ? 'text-accent' : 'text-muted hover:text-foreground',
              )}
            >
              <tab.icon className="w-3.5 h-3.5" />
              <span>{tab.label}</span>
              {tab.badge != null && tab.badge > 0 && (
                <span className="ml-0.5 px-1.5 py-0.5 text-[10px] leading-none font-semibold bg-error text-error-foreground rounded-full">
                  {tab.badge > 99 ? '99+' : tab.badge}
                </span>
              )}
              {tab.deprecated && (
                <span className="ml-0.5 px-1.5 py-0.5 text-[10px] leading-none font-medium bg-warning/20 text-warning border border-warning/30 rounded">
                  deprecated
                </span>
              )}
            </motion.button>
          ))}
        </div>

        {/* Pop-out / dock toggle */}
        <button
          onClick={handleExportTrace}
          disabled={exportTraceDisabled}
          className="px-2 py-2.5 text-subtle hover:text-foreground transition-colors shrink-0 border-l border-default disabled:cursor-not-allowed disabled:opacity-40"
          title={t('export_trace')}
          aria-label={t('export_trace')}
        >
          <Download className="w-3.5 h-3.5" />
        </button>
        {debugPanelMode === 'docked' && (
          <button
            onClick={() => setDebugPanelMode('floating')}
            className="px-2 py-2.5 text-subtle hover:text-foreground transition-colors shrink-0 border-l border-default"
            title={t('pop_out')}
          >
            <Maximize2 className="w-3.5 h-3.5" />
          </button>
        )}
      </div>

      {/* Tab content with animation */}
      <div className="flex-1 overflow-hidden">
        <AnimatePresence mode="wait">
          <motion.div
            key={debugPanelTab}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ duration: 0.15 }}
            className="h-full"
          >
            {debugPanelTab === 'overview' && (
              <OverviewTab
                traceEvents={traceEvents}
                tree={tree}
                sessionId={sessionId}
                agentName={agentName}
                messageCount={messageCount}
                createdAt={createdAt}
                finishedAt={finishedAt}
              />
            )}
            {debugPanelTab === 'traces' && <TracesTab mode={tracesMode} />}
            {debugPanelTab === 'errors' && <ErrorsTab />}
            {debugPanelTab === 'interactions' && <InteractionsTab mode={tracesMode} />}
            {debugPanelTab === 'data' && <DataTab />}
            {debugPanelTab === 'conversation' && (
              <HistoryTab sessionId={sessionId} projectId={projectId} />
            )}
            {debugPanelTab === 'performance' && (
              <PerformanceTab logs={logs} onClearLogs={clearLogs} />
            )}
            {debugPanelTab === 'ir' && <AgentIRTab />}
            {debugPanelTab === 'voice' && isVoiceSession && (
              <VoiceMetricsTab voiceEvents={voiceEvents} />
            )}
          </motion.div>
        </AnimatePresence>
      </div>
    </div>
  );
}

function ContextSection() {
  const t = useTranslations('observatory.debug_tabs');
  const state = useSessionStore((s) => s.state);

  if (!state) {
    return (
      <div className="flex items-center justify-center h-full text-subtle text-sm">
        {t('no_session_active')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-3 space-y-3">
      {/* Current Phase */}
      <div className="bg-background-subtle rounded p-2">
        <div className="text-xs text-subtle mb-1">{t('phase')}</div>
        <div className="text-sm text-foreground">{state.conversationPhase || 'start'}</div>
      </div>

      {/* Gathered Data */}
      {Object.keys(state.gatherProgress || {}).length > 0 && (
        <CollapsibleSection title={t('collected_data')} defaultOpen>
          <JsonViewer data={state.gatherProgress} />
        </CollapsibleSection>
      )}

      {/* Context Variables */}
      {Object.keys(state.context || {}).length > 0 && (
        <CollapsibleSection title={t('context')} defaultOpen>
          <JsonViewer data={state.context} />
        </CollapsibleSection>
      )}

      {/* Flow State */}
      {state.flowState && (
        <CollapsibleSection title={t('flow_state')}>
          <div className="space-y-2">
            <div className="flex justify-between text-sm">
              <span className="text-muted">{t('current_step')}</span>
              <span className="text-foreground">{state.flowState.currentStep}</span>
            </div>
            <div className="flex justify-between text-sm">
              <span className="text-muted">{t('complete')}</span>
              <span className={state.flowState.isComplete ? 'text-success' : 'text-foreground'}>
                {state.flowState.isComplete ? 'Yes' : 'No'}
              </span>
            </div>
            {state.flowState.stepHistory.length > 0 && (
              <div>
                <span className="text-xs text-subtle">{t('step_history')}</span>
                <div className="flex flex-wrap gap-1 mt-1">
                  {state.flowState.stepHistory.map((step, i) => (
                    <span
                      key={i}
                      className="text-xs px-1.5 py-0.5 bg-background-elevated text-muted rounded"
                    >
                      {step}
                    </span>
                  ))}
                </div>
              </div>
            )}
          </div>
        </CollapsibleSection>
      )}

      {/* Constraint Results */}
      {Object.keys(state.constraintResults || {}).length > 0 && (
        <CollapsibleSection title={t('constraints')}>
          <div className="space-y-1">
            {Object.entries(state.constraintResults).map(([name, passed]) => (
              <div key={name} className="flex items-center gap-2 text-sm">
                <span className={passed ? 'text-success' : 'text-error'}>{passed ? '✓' : '✗'}</span>
                <span className="text-muted">{name}</span>
              </div>
            ))}
          </div>
        </CollapsibleSection>
      )}

      {/* Memory */}
      {state.memory && Object.keys(state.memory.session || {}).length > 0 && (
        <CollapsibleSection title={t('session_memory')}>
          <JsonViewer data={state.memory.session} />
        </CollapsibleSection>
      )}
    </div>
  );
}

function HistoryTab({ sessionId, projectId }: { sessionId?: string; projectId?: string }) {
  const t = useTranslations('observatory.debug_tabs');
  const messages = useSessionStore((s) => s.messages);
  const canRevealPII = usePIIRevealPermission(projectId);

  if (messages.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-subtle text-sm">
        {t('no_conversation_history')}
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto p-2 space-y-2">
      {messages.map((msg) => (
        <div
          key={msg.id}
          className={clsx(
            'p-2 rounded text-sm',
            msg.role === 'user' && 'bg-accent-subtle border-l-2 border-accent',
            msg.role === 'assistant' && 'bg-background-subtle border-l-2 border-default',
            msg.role === 'system' && 'bg-purple-subtle border-l-2 border-purple',
          )}
        >
          <div className="mb-1 flex items-center justify-between gap-2">
            <span
              className={clsx(
                'text-xs font-medium',
                msg.role === 'user' && 'text-accent',
                msg.role === 'assistant' && 'text-muted',
                msg.role === 'system' && 'text-purple',
              )}
            >
              {msg.role}
            </span>
            <div className="flex shrink-0 items-center gap-1.5">
              <PIIRevealControls
                projectId={projectId}
                sessionId={sessionId}
                messageId={msg.id}
                messageContent={msg.content}
                canRevealPII={canRevealPII}
              />
              <span className="text-xs text-subtle">{formatAbsoluteTime(msg.timestamp)}</span>
            </div>
          </div>
          <div
            className={clsx(
              'break-words text-xs max-w-none overflow-x-auto',
              'prose prose-xs dark:prose-invert',
              // Spacing
              'prose-p:my-1 prose-ul:my-1 prose-ol:my-1 prose-li:my-0 prose-img:my-1',
              // Text colors — all inherit from foreground for theme safety
              'text-foreground prose-headings:text-foreground prose-headings:my-1',
              'prose-strong:text-foreground prose-em:text-foreground',
              'prose-li:text-foreground',
              // Code — visible in both themes
              'prose-code:text-foreground prose-code:bg-foreground/10 prose-code:px-1 prose-code:py-0.5 prose-code:rounded prose-code:text-[0.85em]',
              'prose-pre:bg-foreground/5 prose-pre:text-foreground prose-pre:rounded-md prose-pre:my-1',
              // Links
              'prose-a:text-accent prose-a:underline',
              // Blockquote
              'prose-blockquote:text-foreground/80 prose-blockquote:border-accent/40 prose-blockquote:not-italic',
              // Tables — borders visible in both themes
              'prose-th:text-foreground prose-th:border-foreground/20 prose-th:px-2 prose-th:py-1',
              'prose-td:text-foreground prose-td:border-foreground/20 prose-td:px-2 prose-td:py-1',
              'prose-thead:bg-foreground/5',
            )}
          >
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{msg.content}</ReactMarkdown>
          </div>
        </div>
      ))}
    </div>
  );
}

/**
 * TracesTab - Renders a master-detail waterfall of spans with a detail drawer.
 */
function TracesTab({ mode }: { mode: WaterfallMode }) {
  const spans = useObservatoryStore((s) => s.spans);
  const selectedSpanId = useObservatoryStore((s) => s.selection.spanId);
  const selectSpan = useObservatoryStore((s) => s.selectSpan);

  const selectedSpan = useMemo(
    () => selectSelectedSpan(spans, selectedSpanId),
    [spans, selectedSpanId],
  );
  const spanSummaries = useMemo(() => selectSpanSummaries(spans), [spans]);

  return (
    <div className="flex flex-col h-full">
      {/* Top: waterfall */}
      <div className={clsx('overflow-hidden', selectedSpan ? 'h-[45%] shrink-0' : 'flex-1')}>
        <WaterfallPanel spans={spanSummaries} mode={mode}>
          <SpanTree className="h-full" />
        </WaterfallPanel>
      </div>

      {/* Bottom: detail panel */}
      <AnimatePresence>
        {selectedSpan && (
          <div className="flex-1 min-h-0 border-t border-default">
            <NodeDetailPanel span={selectedSpan} onClose={() => selectSpan(null)} />
          </div>
        )}
      </AnimatePresence>
    </div>
  );
}

/**
 * DataTab - Composes GatherProgressPanel + ContextSection
 */
function DataTab() {
  return (
    <div className="h-full overflow-y-auto">
      <GatherProgressPanel />
      <div className="border-t border-default">
        <ContextSection />
      </div>
    </div>
  );
}

/**
 * PerformanceTab - Composes LLMCallsTab + LogsSection
 */
interface PerformanceTabProps {
  logs: Array<{ timestamp: Date; level: 'info' | 'warn' | 'error'; message: string }>;
  onClearLogs: () => void;
}

function PerformanceTab({ logs, onClearLogs }: PerformanceTabProps) {
  const t = useTranslations('observatory.debug_tabs');
  const [section, setSection] = useState<'calls' | 'logs'>('calls');

  return (
    <div className="flex flex-col h-full">
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-default bg-background-muted">
        <button
          onClick={() => setSection('calls')}
          className={clsx(
            'px-2 py-0.5 text-xs rounded',
            section === 'calls'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted hover:bg-background-elevated',
          )}
        >
          LLM &amp; Tools
        </button>
        <button
          onClick={() => setSection('logs')}
          className={clsx(
            'px-2 py-0.5 text-xs rounded',
            section === 'logs'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted hover:bg-background-elevated',
          )}
        >
          {t('section_logs')}
          {logs.length > 0 && (
            <span className="ml-1 px-1.5 py-0.5 text-xs bg-accent-subtle text-accent rounded-full">
              {logs.length}
            </span>
          )}
        </button>
      </div>
      <div className="flex-1 overflow-hidden">
        {section === 'calls' ? <CallsTab /> : <LogsSection logs={logs} onClear={onClearLogs} />}
      </div>
    </div>
  );
}

/**
 * CallsTab - Combined LLM calls and tool calls, color-coded
 */
function CallsTab() {
  const events = useObservatoryStore((s) => s.events);

  const { llmCalls, toolCalls } = useMemo(() => {
    const llm: Array<{
      id: string;
      timestamp: Date;
      model: string;
      agent: string;
      tokensIn: number;
      tokensOut: number;
      latencyMs: number;
      cost: number;
    }> = [];
    const tools: Array<{
      id: string;
      timestamp: Date;
      tool: string;
      agent: string;
      latencyMs: number;
      result?: string;
    }> = [];

    for (const event of events) {
      const eventType = normalizeEventType(event.type);
      const stepType = EVENT_TO_STEP[eventType] ?? eventType;

      if (stepType === 'llm_call') {
        const d = event.data as any;
        llm.push({
          id: event.id,
          timestamp: event.timestamp,
          model: d?.model || 'unknown',
          agent: event.agentName || 'unknown',
          tokensIn: d?.usage?.inputTokens || d?.tokensIn || d?.promptTokens || 0,
          tokensOut: d?.usage?.outputTokens || d?.tokensOut || d?.completionTokens || 0,
          latencyMs: d?.durationMs || d?.latencyMs || 0,
          cost: d?.cost || 0,
        });
      } else if (stepType === 'tool_call' && COMPLETED_TOOL_CALL_EVENT_TYPES.has(eventType)) {
        const d = event.data as any;
        tools.push({
          id: event.id,
          timestamp: event.timestamp,
          tool: d?.tool || d?.toolName || d?.name || 'unknown',
          agent: event.agentName || 'unknown',
          latencyMs: d?.durationMs || d?.latencyMs || 0,
          result: d?.result ? String(d.result).substring(0, 80) : undefined,
        });
      }
    }
    return { llmCalls: llm, toolCalls: tools };
  }, [events]);

  // Interleave by timestamp, newest first
  const allCalls = useMemo(() => {
    const merged: Array<
      { kind: 'llm'; data: (typeof llmCalls)[0] } | { kind: 'tool'; data: (typeof toolCalls)[0] }
    > = [
      ...llmCalls.map((d) => ({ kind: 'llm' as const, data: d })),
      ...toolCalls.map((d) => ({ kind: 'tool' as const, data: d })),
    ];
    merged.sort((a, b) => b.data.timestamp.getTime() - a.data.timestamp.getTime());
    return merged;
  }, [llmCalls, toolCalls]);

  if (allCalls.length === 0) {
    return (
      <div className="flex items-center justify-center h-full text-subtle text-xs">
        No LLM or tool calls recorded yet.
      </div>
    );
  }

  const totalLlmTokens = llmCalls.reduce((s, c) => s + c.tokensIn + c.tokensOut, 0);
  const totalCost = llmCalls.reduce((s, c) => s + c.cost, 0);

  return (
    <div className="flex flex-col h-full">
      {/* Summary strip */}
      <div className="flex items-center gap-3 px-3 py-1.5 border-b border-default bg-background-muted text-xs text-muted">
        <span>
          <span className="font-semibold text-accent">{llmCalls.length}</span> LLM
        </span>
        <span>
          <span className="font-semibold text-orange">{toolCalls.length}</span> Tools
        </span>
        <span>
          <span className="font-semibold text-info">{totalLlmTokens.toLocaleString()}</span> tokens
        </span>
        {totalCost > 0 && (
          <span>
            <span className="font-semibold text-success">${totalCost.toFixed(4)}</span>
          </span>
        )}
      </div>

      {/* Call list */}
      <div className="flex-1 overflow-y-auto divide-y divide-default">
        {allCalls.map((call) =>
          call.kind === 'llm' ? (
            <div key={call.data.id} className="px-3 py-1.5 text-xs flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-accent shrink-0" />
              <span className="text-accent font-medium shrink-0">LLM</span>
              <span className="text-foreground truncate flex-1">{call.data.model}</span>
              <span className="text-muted shrink-0">
                {call.data.tokensIn + call.data.tokensOut} tok
              </span>
              {call.data.latencyMs > 0 && (
                <span className="text-warning shrink-0">{Math.round(call.data.latencyMs)}ms</span>
              )}
              <span className="text-subtle shrink-0">
                {formatAbsoluteTime(call.data.timestamp)}
              </span>
            </div>
          ) : (
            <div key={call.data.id} className="px-3 py-1.5 text-xs flex items-center gap-2">
              <div className="w-2 h-2 rounded-full bg-orange shrink-0" />
              <span className="text-orange font-medium shrink-0">Tool</span>
              <span className="text-foreground truncate flex-1">{call.data.tool}</span>
              {call.data.latencyMs > 0 && (
                <span className="text-warning shrink-0">{Math.round(call.data.latencyMs)}ms</span>
              )}
              <span className="text-subtle shrink-0">
                {formatAbsoluteTime(call.data.timestamp)}
              </span>
            </div>
          ),
        )}
      </div>
    </div>
  );
}

/**
 * AgentIRTab - Composes IR source/JSON view + TestContextPanel
 */
function AgentIRTab() {
  const t = useTranslations('observatory.debug_tabs');
  const agent = useSessionStore((s) => s.agent);
  const [viewMode, setViewMode] = useState<'dsl' | 'ir' | 'test-context'>('dsl');

  if (!agent?.dsl && !agent?.ir) {
    return (
      <div className="flex items-center justify-center h-full text-subtle text-sm">
        {t('no_agent_loaded')}
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Toggle bar */}
      <div className="flex items-center gap-1 px-2 py-1.5 border-b border-default bg-background-muted">
        <button
          onClick={() => setViewMode('dsl')}
          className={clsx(
            'px-2 py-0.5 text-xs rounded',
            viewMode === 'dsl'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted hover:bg-background-elevated',
          )}
        >
          {t('abl_source')}
        </button>
        <button
          onClick={() => setViewMode('ir')}
          className={clsx(
            'px-2 py-0.5 text-xs rounded',
            viewMode === 'ir'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted hover:bg-background-elevated',
          )}
        >
          {t('ir_json')}
        </button>
        <button
          onClick={() => setViewMode('test-context')}
          className={clsx(
            'px-2 py-0.5 text-xs rounded',
            viewMode === 'test-context'
              ? 'bg-accent text-accent-foreground'
              : 'text-muted hover:bg-background-elevated',
          )}
        >
          {t('section_test_context')}
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto p-2">
        {viewMode === 'dsl' ? (
          agent?.dsl ? (
            <ABLSourceView source={agent.dsl} />
          ) : (
            <div className="text-subtle text-sm text-center mt-4">{t('no_abl_source')}</div>
          )
        ) : viewMode === 'ir' ? (
          agent?.ir ? (
            <JsonViewer data={agent.ir} maxDepth={6} />
          ) : (
            <div className="text-subtle text-sm text-center mt-4">{t('no_ir_available')}</div>
          )
        ) : (
          <TestContextPanel />
        )}
      </div>
    </div>
  );
}

/** ABL keywords for syntax highlighting */
const ABL_KEYWORDS = [
  'AGENT',
  'SUPERVISOR',
  'MODE',
  'FLOW',
  'STEP',
  'GATHER',
  'COLLECT',
  'RESPOND',
  'PROMPT',
  'TOOL',
  'CONSTRAINT',
  'HANDOFF',
  'TRANSITIONS',
  'WHEN',
  'GOTO',
  'TO',
  'RETURN',
  'FIELD',
  'TYPE',
  'REQUIRED',
  'DESCRIPTION',
  'VALIDATE',
  'EXTRACT_FROM',
  'PERSONA',
  'GOAL',
  'INSTRUCTIONS',
  'GUARDRAILS',
  'GREETING',
  'CONTEXT',
  'SET',
  'ON_INPUT',
  'CALL',
  'INPUT',
  'OUTPUT',
  'DELEGATE',
  'MODEL',
  'TEMPERATURE',
  'MAX_TOKENS',
  'TOOLS',
  'CONSTRAINTS',
  'CONDITION',
  'ON_FAIL',
  'ON_HIT',
];

const ABL_VALUES = ['true', 'false', 'null', 'scripted', 'reasoning'];

function ABLSourceView({ source }: { source: string }) {
  return (
    <pre className="text-xs font-mono leading-relaxed whitespace-pre-wrap break-words">
      {source.split('\n').map((line, i) => (
        <div key={i} className="flex hover:bg-background-muted">
          <span className="select-none text-subtle w-8 text-right pr-2 flex-shrink-0">{i + 1}</span>
          <span>
            <ABLHighlightedLine line={line} />
          </span>
        </div>
      ))}
    </pre>
  );
}

function ABLHighlightedLine({ line }: { line: string }) {
  // Handle comment lines
  if (line.trimStart().startsWith('#') || line.trimStart().startsWith('//')) {
    return <span className="text-subtle italic">{line}</span>;
  }

  // Handle string values (quoted)
  // Tokenize: split by quotes and keywords
  const parts: Array<{
    text: string;
    type: 'keyword' | 'value' | 'string' | 'comment' | 'normal';
  }> = [];
  let remaining = line;

  while (remaining.length > 0) {
    // Check for quoted strings
    const quoteMatch = remaining.match(/^(.*?)(["'])(.*?)\2(.*)/s);
    if (quoteMatch) {
      const before = quoteMatch[1];
      const quote = quoteMatch[2];
      const content = quoteMatch[3];
      if (before) {
        tokenizeKeywords(before, parts);
      }
      parts.push({ text: `${quote}${content}${quote}`, type: 'string' });
      remaining = quoteMatch[4];
      continue;
    }

    // Check for inline comments
    const commentIdx = remaining.indexOf('#');
    if (commentIdx >= 0) {
      const before = remaining.slice(0, commentIdx);
      if (before) {
        tokenizeKeywords(before, parts);
      }
      parts.push({ text: remaining.slice(commentIdx), type: 'comment' });
      remaining = '';
      continue;
    }

    // No special tokens found, tokenize keywords in rest
    tokenizeKeywords(remaining, parts);
    remaining = '';
  }

  return (
    <>
      {parts.map((part, i) => {
        switch (part.type) {
          case 'keyword':
            return (
              <span key={i} className="text-purple font-semibold">
                {part.text}
              </span>
            );
          case 'value':
            return (
              <span key={i} className="text-accent">
                {part.text}
              </span>
            );
          case 'string':
            return (
              <span key={i} className="text-success">
                {part.text}
              </span>
            );
          case 'comment':
            return (
              <span key={i} className="text-subtle italic">
                {part.text}
              </span>
            );
          default:
            return (
              <span key={i} className="text-muted">
                {part.text}
              </span>
            );
        }
      })}
    </>
  );
}

function tokenizeKeywords(
  text: string,
  parts: Array<{ text: string; type: 'keyword' | 'value' | 'string' | 'comment' | 'normal' }>,
) {
  // Build a regex that matches keywords or values as whole words
  const keywordPattern = new RegExp(
    `\\b(${ABL_KEYWORDS.join('|')})\\b|\\b(${ABL_VALUES.join('|')})\\b`,
    'g',
  );

  let lastIndex = 0;
  let match: RegExpExecArray | null;

  while ((match = keywordPattern.exec(text)) !== null) {
    // Add text before match
    if (match.index > lastIndex) {
      parts.push({ text: text.slice(lastIndex, match.index), type: 'normal' });
    }
    // Add keyword or value
    if (match[1]) {
      parts.push({ text: match[0], type: 'keyword' });
    } else {
      parts.push({ text: match[0], type: 'value' });
    }
    lastIndex = keywordPattern.lastIndex;
  }

  // Add remaining text
  if (lastIndex < text.length) {
    parts.push({ text: text.slice(lastIndex), type: 'normal' });
  }
}

interface LogsSectionProps {
  logs: Array<{ timestamp: Date; level: 'info' | 'warn' | 'error'; message: string }>;
  onClear: () => void;
}

function LogsSection({ logs, onClear }: LogsSectionProps) {
  const t = useTranslations('observatory.debug_tabs');
  const [levelFilter, setLevelFilter] = useState<'all' | 'info' | 'warn' | 'error'>('all');

  const filteredLogs = useMemo(
    () => logs.filter((log) => levelFilter === 'all' || log.level === levelFilter),
    [logs, levelFilter],
  );

  return (
    <div className="flex flex-col h-full">
      {/* Filter bar */}
      <div className="flex items-center justify-between px-2 py-1.5 border-b border-default bg-background-muted">
        <div className="flex gap-1">
          {(['all', 'info', 'warn', 'error'] as const).map((level) => (
            <button
              key={level}
              onClick={() => setLevelFilter(level)}
              className={clsx(
                'px-2 py-0.5 text-xs rounded',
                levelFilter === level
                  ? 'bg-accent text-accent-foreground'
                  : 'text-muted hover:bg-background-elevated',
              )}
            >
              {level}
            </button>
          ))}
        </div>
        <button
          onClick={onClear}
          className="p-1 text-muted hover:text-foreground hover:bg-background-elevated rounded"
          title={t('clear_logs')}
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* Logs list */}
      <div className="flex-1 overflow-y-auto font-mono text-xs">
        {filteredLogs.length === 0 ? (
          <div className="flex items-center justify-center h-full text-subtle">{t('no_logs')}</div>
        ) : (
          filteredLogs.map((log, i) => (
            <div
              key={i}
              className={clsx(
                'px-2 py-1 border-b border-default',
                log.level === 'error' && 'bg-error-subtle',
                log.level === 'warn' && 'bg-warning-subtle',
              )}
            >
              <span className="text-subtle">{formatAbsoluteTime(log.timestamp)}</span>
              <span
                className={clsx(
                  'mx-2',
                  log.level === 'info' && 'text-info',
                  log.level === 'warn' && 'text-warning',
                  log.level === 'error' && 'text-error',
                )}
              >
                [{log.level.toUpperCase()}]
              </span>
              <span className="text-muted">{log.message}</span>
            </div>
          ))
        )}
      </div>
    </div>
  );
}

export default DebugTabs;
