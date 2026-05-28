'use client';

import { useMemo } from 'react';
import {
  AlertCircle,
  Bot,
  ClipboardList,
  GitBranch,
  Hammer,
  Loader2,
  MessageSquare,
  User,
  Wrench,
  Zap,
  type LucideIcon,
} from 'lucide-react';
import { useSessionInspectorStore } from '@/store/session-inspector-store';
import { formatDuration, formatCost } from '@/components/analytics/shared';
import type { SessionTreeEvent } from '@/lib/arch-inspector-reader';

const CATEGORY_ICON: Record<string, LucideIcon> = {
  phase_transition: GitBranch,
  system_event: Zap,
  llm_call: Bot,
  tool_execution: Wrench,
  build_event: Hammer,
  error: AlertCircle,
  user_action: User,
};

const SEVERITY_STYLE: Record<string, string> = {
  info: 'border-l-muted-foreground/30',
  warning: 'border-l-warning',
  error: 'border-l-error',
  critical: 'border-l-error',
};

function EventCard({ event }: { event: SessionTreeEvent }) {
  const Icon = CATEGORY_ICON[event.category] ?? ClipboardList;
  const borderStyle = SEVERITY_STYLE[event.severity] ?? SEVERITY_STYLE.info;
  const detail = event.detail ?? {};

  return (
    <div className={`border-l-2 ${borderStyle} pl-3 py-2`}>
      <div className="flex items-start gap-2">
        <Icon className="h-3.5 w-3.5 flex-shrink-0 text-muted-foreground" />
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-xs font-medium text-foreground">{event.summary}</span>
            {event.durationMs != null && event.durationMs > 0 && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {formatDuration(event.durationMs)}
              </span>
            )}
            {event.tokens && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {event.tokens.total} tok
              </span>
            )}
            {event.tokens && event.tokens.estimatedCost > 0 && (
              <span className="text-[10px] text-muted-foreground bg-muted px-1.5 py-0.5 rounded">
                {formatCost(event.tokens.estimatedCost)}
              </span>
            )}
          </div>

          {event.category === 'phase_transition' && (
            <div className="mt-1 text-xs text-muted-foreground">
              {String(detail.from ?? '')} →{' '}
              <span className="font-medium text-foreground">{String(detail.to ?? '')}</span>
            </div>
          )}

          {event.category === 'llm_call' && (
            <div className="mt-1 text-xs text-muted-foreground space-y-0.5">
              <div>
                Model:{' '}
                <span className="font-mono text-foreground">{String(detail.model ?? '')}</span>
                {' · '}Finish: {String(detail.finishReason ?? '')}
                {detail.stepCount ? ` · ${String(detail.stepCount)} steps` : ''}
              </div>
            </div>
          )}

          {event.category === 'tool_execution' && (
            <div className="mt-1 space-y-1">
              {typeof detail.toolName === 'string' && (
                <div className="text-xs text-muted-foreground">
                  Tool: <span className="font-mono text-foreground">{detail.toolName}</span>
                  {typeof detail.resultStatus === 'string' && (
                    <span
                      className={detail.resultStatus === 'error' ? ' text-error' : ' text-success'}
                    >
                      {' '}
                      · {detail.resultStatus}
                    </span>
                  )}
                </div>
              )}
              {Array.isArray(detail.inputKeys) && (
                <div className="text-xs text-muted-foreground">
                  Input keys:{' '}
                  <span className="font-mono">{(detail.inputKeys as string[]).join(', ')}</span>
                </div>
              )}
            </div>
          )}

          {event.category === 'system_event' && typeof detail.specialist === 'string' && (
            <div className="mt-1 text-xs text-muted-foreground">
              Specialist: <span className="text-foreground">{detail.specialist}</span>
            </div>
          )}

          {event.category === 'error' && (
            <div className="mt-1 text-xs text-error">
              {String(detail.message ?? '')}
              {typeof detail.errorCode === 'string' && (
                <span className="font-mono ml-1">({detail.errorCode})</span>
              )}
            </div>
          )}

          {event.category === 'build_event' && typeof detail.agentName === 'string' && (
            <div className="mt-1 text-xs text-muted-foreground">
              Agent: <span className="font-mono text-foreground">{detail.agentName}</span>
              {typeof detail.status === 'string' ? ` · ${detail.status}` : ''}
            </div>
          )}

          <div className="mt-0.5 text-[10px] text-muted-foreground/70">
            {new Date(event.timestamp).toLocaleTimeString()}
            {event.phase && ` · ${event.phase}`}
            {event.specialist && ` · ${event.specialist}`}
          </div>
        </div>
      </div>
    </div>
  );
}

function PhaseHeader({ event }: { event: SessionTreeEvent }) {
  const detail = event.detail ?? {};
  return (
    <div className="bg-muted/50 rounded-md px-3 py-2 my-2">
      <div className="flex items-center gap-2">
        <GitBranch className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-semibold text-foreground uppercase tracking-wide">
          {String(detail.to ?? event.phaseLabel ?? 'Phase Change')}
        </span>
        <span className="text-[10px] text-muted-foreground">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </div>
      {typeof detail.from === 'string' && (
        <div className="text-[10px] text-muted-foreground mt-0.5 ml-6">from {detail.from}</div>
      )}
    </div>
  );
}

function TurnHeader({ event }: { event: SessionTreeEvent }) {
  const detail = event.detail ?? {};
  return (
    <div className="bg-accent/5 border border-border/50 rounded-md px-3 py-2 my-2">
      <div className="flex items-center gap-2">
        <MessageSquare className="h-3.5 w-3.5 text-muted-foreground" />
        <span className="text-xs font-medium text-foreground">Turn</span>
        {typeof detail.specialist === 'string' && (
          <span className="text-[10px] text-muted-foreground">({detail.specialist})</span>
        )}
        <span className="text-[10px] text-muted-foreground ml-auto">
          {new Date(event.timestamp).toLocaleTimeString()}
        </span>
      </div>
    </div>
  );
}

export function CallStackTree() {
  const { treeEvents, treeLoading, selectedSessionId } = useSessionInspectorStore();

  const sortedEvents = useMemo(
    () =>
      [...treeEvents]
        .filter((e) => e.summary.length > 0 || e.category === 'phase_transition')
        .sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime()),
    [treeEvents],
  );

  if (!selectedSessionId) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        Select a session to view the full execution flow
      </div>
    );
  }

  if (treeLoading) {
    return (
      <div className="flex h-full items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (sortedEvents.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-muted-foreground">
        No events found for this session
      </div>
    );
  }

  return (
    <div className="h-full overflow-y-auto px-4 py-3 space-y-0.5">
      <div className="text-xs text-muted-foreground mb-3">
        {sortedEvents.length} events · {new Date(sortedEvents[0].timestamp).toLocaleDateString()}
      </div>
      {sortedEvents.map((event) => {
        if (event.category === 'phase_transition') {
          return <PhaseHeader key={event.eventId} event={event} />;
        }
        if (
          event.spanKind === 'turn' ||
          (event.category === 'system_event' && event.summary.includes('Turn'))
        ) {
          return <TurnHeader key={event.eventId} event={event} />;
        }
        return <EventCard key={event.eventId} event={event} />;
      })}
    </div>
  );
}
