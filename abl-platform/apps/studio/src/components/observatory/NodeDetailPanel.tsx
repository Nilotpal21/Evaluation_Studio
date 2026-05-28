'use client';

/**
 * NodeDetailPanel Component
 *
 * Bottom panel showing span detail when a span is selected in the traces tab.
 * Two tabs:
 *   - Events: chronological event list with expandable payloads
 *   - Raw: full JSON of the span object
 */

import { useState, useCallback, useMemo, useEffect, useRef, lazy, Suspense, memo } from 'react';
import {
  X,
  Copy,
  Check,
  Clock,
  DollarSign,
  Zap,
  Calendar,
  GitBranch,
  ChevronRight,
  ChevronDown,
  FileJson,
  List,
} from 'lucide-react';
import { motion } from 'framer-motion';
import { useTranslations } from 'next-intl';
import clsx from 'clsx';
import type { Span, ExtendedTraceEvent } from '../../types';
import { Badge } from '../ui/Badge';
import { formatDuration, formatCost } from '../analytics/shared';
import { EVENT_DOT_COLORS } from './event-colors';
import { getSpanLlmMetrics } from '../../features/observatory/metrics';
import { formatAbsoluteTime } from './format-time';
import {
  getObservatoryEventSummary,
  getObservatoryEventTypeLabel,
} from '../../utils/observatory-event-presentation';
import { TraceCausalChips } from '../trace/TraceCausality';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface NodeDetailPanelProps {
  span: Span;
  onClose: () => void;
  className?: string;
}

type DetailTab = 'events' | 'raw';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Lazy JSON viewer
// ---------------------------------------------------------------------------

const LazyJsonViewer = lazy(() =>
  import('../ui/JsonViewer').then((mod) => ({ default: mod.JsonViewer })),
);

// ---------------------------------------------------------------------------
// Main Component
// ---------------------------------------------------------------------------

export function NodeDetailPanel({ span, onClose, className }: NodeDetailPanelProps) {
  const t = useTranslations('observability');
  const [activeTab, setActiveTab] = useState<DetailTab>('events');
  const [copiedId, setCopiedId] = useState(false);
  const copyTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const llmMetrics = useMemo(() => getSpanLlmMetrics(span), [span]);
  const decisionCount = useMemo(
    () => span.events.filter((e) => e.type === 'decision').length,
    [span],
  );

  useEffect(() => {
    return () => {
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
    };
  }, []);

  const handleCopyId = useCallback(async () => {
    try {
      await navigator.clipboard.writeText(span.spanId);
      setCopiedId(true);
      if (copyTimerRef.current) clearTimeout(copyTimerRef.current);
      copyTimerRef.current = setTimeout(() => setCopiedId(false), 1500);
    } catch {
      // clipboard unavailable
    }
  }, [span.spanId]);

  return (
    <motion.aside
      initial={{ y: '100%', opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: '100%', opacity: 0 }}
      transition={{ type: 'spring', damping: 26, stiffness: 300 }}
      className={clsx('flex flex-col h-full bg-background', className)}
    >
      {/* ── Header bar ── */}
      <div className="flex items-center gap-3 px-4 py-2 border-b border-default bg-background-subtle shrink-0">
        {/* Agent name + status */}
        <span className="text-sm font-semibold text-foreground truncate">{span.agentName}</span>
        <Badge
          variant={
            span.status === 'error' ? 'error' : span.status === 'completed' ? 'success' : 'info'
          }
        >
          {span.status}
        </Badge>

        {/* Compact metrics */}
        <div className="flex items-center gap-3 ml-auto text-xs text-muted">
          {llmMetrics && (
            <>
              <span className="flex items-center gap-1">
                <DollarSign className="w-3 h-3" />
                {formatCost(llmMetrics.cost)}
              </span>
              <span className="flex items-center gap-1">
                <Zap className="w-3 h-3" />
                {llmMetrics.totalTokens.toLocaleString()}
              </span>
            </>
          )}
          <span className="flex items-center gap-1">
            <Clock className="w-3 h-3" />
            {span.durationMs != null ? formatDuration(span.durationMs) : 'running'}
          </span>
          <span className="flex items-center gap-1">
            <Calendar className="w-3 h-3" />
            {formatAbsoluteTime(span.startTime)}
          </span>
          {decisionCount > 0 && (
            <span className="flex items-center gap-1 text-purple">
              <GitBranch className="w-3 h-3" />
              {decisionCount}
            </span>
          )}
          <span className="text-subtle">{span.events.length} events</span>
        </div>

        {/* Actions */}
        <button
          onClick={handleCopyId}
          className="p-1 rounded text-muted hover:text-foreground transition-default"
          title={t('copyId')}
          aria-label={t('copyId')}
        >
          {copiedId ? (
            <Check className="w-3.5 h-3.5 text-success" />
          ) : (
            <Copy className="w-3.5 h-3.5" />
          )}
        </button>
        <button
          onClick={onClose}
          className="p-1 rounded text-muted hover:text-foreground transition-default"
          aria-label="Close"
        >
          <X className="w-3.5 h-3.5" />
        </button>
      </div>

      {/* ── Tabs + Content ── */}
      <div className="flex flex-1 min-h-0">
        {/* Vertical tab rail */}
        <div className="flex flex-col border-r border-default shrink-0 bg-background-subtle">
          <TabButton
            icon={<List className="w-3.5 h-3.5" />}
            label="Events"
            active={activeTab === 'events'}
            onClick={() => setActiveTab('events')}
          />
          <TabButton
            icon={<FileJson className="w-3.5 h-3.5" />}
            label="Raw"
            active={activeTab === 'raw'}
            onClick={() => setActiveTab('raw')}
          />
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto min-w-0">
          {activeTab === 'events' && <EventsTab span={span} />}
          {activeTab === 'raw' && <RawTab span={span} />}
        </div>
      </div>
    </motion.aside>
  );
}

// ---------------------------------------------------------------------------
// TabButton
// ---------------------------------------------------------------------------

function TabButton({
  icon,
  label,
  active,
  onClick,
}: {
  icon: React.ReactNode;
  label: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={clsx(
        'flex items-center gap-1.5 px-3 py-2 text-xs font-medium whitespace-nowrap transition-colors',
        active ? 'text-accent bg-background' : 'text-muted hover:text-foreground',
      )}
    >
      {icon}
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// EventsTab — chronological event list with expandable payloads
// ---------------------------------------------------------------------------

/** Group consecutive events of the same type */
type EventGroup =
  | { kind: 'single'; event: ExtendedTraceEvent }
  | { kind: 'group'; type: string; events: ExtendedTraceEvent[] };

function groupConsecutiveEvents(events: ExtendedTraceEvent[]): EventGroup[] {
  const GROUPABLE_TYPES = new Set(['constraint_check', 'guardrail_check', 'completion_check']);
  const groups: EventGroup[] = [];

  let i = 0;
  while (i < events.length) {
    const event = events[i];
    if (GROUPABLE_TYPES.has(event.type)) {
      const batch: ExtendedTraceEvent[] = [event];
      let j = i + 1;
      while (j < events.length && events[j].type === event.type) {
        batch.push(events[j]);
        j++;
      }
      if (batch.length > 1) {
        groups.push({ kind: 'group', type: event.type, events: batch });
      } else {
        groups.push({ kind: 'single', event });
      }
      i = j;
    } else {
      groups.push({ kind: 'single', event });
      i++;
    }
  }
  return groups;
}

function EventsTab({ span }: { span: Span }) {
  if (span.events.length === 0) {
    return (
      <div className="flex items-center justify-center h-32 text-muted text-xs">
        No events recorded in this span.
      </div>
    );
  }

  const groups = groupConsecutiveEvents(span.events);

  return (
    <div className="divide-y divide-default">
      {groups.map((group) =>
        group.kind === 'single' ? (
          <EventRow key={group.event.id} event={group.event} />
        ) : (
          <EventGroupRow key={group.events[0].id} type={group.type} events={group.events} />
        ),
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// EventRow — single event with expand/collapse
// ---------------------------------------------------------------------------

const EventRow = memo(function EventRow({ event }: { event: ExtendedTraceEvent }) {
  const [expanded, setExpanded] = useState(false);
  const summary = useMemo(() => getObservatoryEventSummary(event), [event]);
  const hasData = event.data && Object.keys(event.data).length > 0;

  return (
    <div className="text-xs">
      <button
        onClick={() => hasData && setExpanded((prev) => !prev)}
        className={clsx(
          'flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors',
          hasData ? 'hover:bg-background-muted cursor-pointer' : 'cursor-default',
          expanded && 'bg-background-muted',
        )}
      >
        {/* Expand chevron */}
        {hasData ? (
          expanded ? (
            <ChevronDown className="w-3 h-3 text-muted shrink-0" />
          ) : (
            <ChevronRight className="w-3 h-3 text-muted shrink-0" />
          )
        ) : (
          <div className="w-3 shrink-0" />
        )}

        {/* Event type dot */}
        <div
          className={clsx(
            'w-2 h-2 rounded-full shrink-0',
            EVENT_DOT_COLORS[event.type] || 'bg-background-muted',
          )}
        />

        {/* Type label */}
        <span className="text-accent font-medium shrink-0">
          {getObservatoryEventTypeLabel(event.type)}
        </span>

        {/* Summary */}
        {summary && <span className="text-foreground truncate flex-1">{summary}</span>}

        <TraceCausalChips event={event} compact className="hidden xl:flex flex-wrap gap-1" />

        {/* Timestamp */}
        <span className="text-subtle shrink-0 ml-2">{formatAbsoluteTime(event.timestamp)}</span>
      </button>

      {/* Expanded payload */}
      {expanded && hasData && (
        <div className="px-3 py-2 pl-10 bg-background-subtle border-t border-default">
          <TraceCausalChips event={event} className="mb-2 flex flex-wrap gap-1.5" />
          <Suspense fallback={<div className="text-muted text-xs py-2">Loading...</div>}>
            <LazyJsonViewer data={event.data} copyable maxDepth={4} />
          </Suspense>
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// EventGroupRow — collapsible group of consecutive same-type events
// ---------------------------------------------------------------------------

const EventGroupRow = memo(function EventGroupRow({
  type,
  events,
}: {
  type: string;
  events: ExtendedTraceEvent[];
}) {
  const [expanded, setExpanded] = useState(false);
  const passedCount = events.filter((e) => e.data?.passed).length;
  const failedCount = events.length - passedCount;

  return (
    <div className="text-xs">
      <button
        onClick={() => setExpanded((prev) => !prev)}
        className={clsx(
          'flex items-center gap-2 w-full px-3 py-1.5 text-left transition-colors hover:bg-background-muted cursor-pointer',
          expanded && 'bg-background-muted',
        )}
      >
        {expanded ? (
          <ChevronDown className="w-3 h-3 text-muted shrink-0" />
        ) : (
          <ChevronRight className="w-3 h-3 text-muted shrink-0" />
        )}
        <div
          className={clsx(
            'w-2 h-2 rounded-full shrink-0',
            EVENT_DOT_COLORS[type] || 'bg-background-muted',
          )}
        />
        <span className="text-accent font-medium shrink-0">
          {getObservatoryEventTypeLabel(type)}
        </span>
        <span className="text-foreground">
          {events.length} checks
          {passedCount > 0 && <span className="text-success ml-1">{passedCount} passed</span>}
          {failedCount > 0 && <span className="text-error ml-1">{failedCount} failed</span>}
        </span>
      </button>

      {expanded && (
        <div className="pl-4 border-l-2 border-default ml-5">
          {events.map((event) => (
            <EventRow key={event.id} event={event} />
          ))}
        </div>
      )}
    </div>
  );
});

// ---------------------------------------------------------------------------
// RawTab — full JSON of the span
// ---------------------------------------------------------------------------

function RawTab({ span }: { span: Span }) {
  const rawData = useMemo(
    () => ({
      spanId: span.spanId,
      traceId: span.traceId,
      parentSpanId: span.parentSpanId,
      name: span.name,
      agentName: span.agentName,
      status: span.status,
      startTime: span.startTime,
      endTime: span.endTime,
      durationMs: span.durationMs,
      eventCount: span.events.length,
      events: span.events.map((e) => ({
        id: e.id,
        type: e.type,
        timestamp: e.timestamp,
        agentName: e.agentName,
        turnId: e.turnId,
        executionId: e.executionId,
        parentExecutionId: e.parentExecutionId,
        agentRunId: e.agentRunId,
        decisionId: e.decisionId,
        parentDecisionId: e.parentDecisionId,
        causeEventId: e.causeEventId,
        phase: e.phase,
        reasonCode: e.reasonCode,
        data: e.data,
      })),
      attributes: span.attributes,
    }),
    [span],
  );

  return (
    <div className="p-3">
      <Suspense fallback={<div className="text-muted text-xs py-4">Loading...</div>}>
        <LazyJsonViewer data={rawData} copyable maxDepth={6} />
      </Suspense>
    </div>
  );
}
