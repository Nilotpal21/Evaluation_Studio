/**
 * SessionDetail Component
 *
 * Slide-over panel showing conversation timeline for a selected session.
 * Displays messages (user/assistant), tool calls, handoffs, and errors
 * with a metadata panel showing session info.
 */

import { useState, useEffect, useCallback } from 'react';
import { clsx } from 'clsx';
import {
  X,
  Loader2,
  MessageSquare,
  Bot,
  Wrench,
  ArrowRightLeft,
  AlertCircle,
  Clock,
  DollarSign,
  Hash,
  Radio,
  ChevronDown,
  ChevronRight,
  User,
} from 'lucide-react';
import { apiFetch } from '../../lib/api-client';
import { formatDuration, formatCost, formatTimestamp } from '../analytics/shared';
import { Badge } from '../ui/Badge';

// =============================================================================
// TYPES
// =============================================================================

interface SessionDetailProps {
  sessionId: string;
  projectId: string | null;
  onClose: () => void;
}

interface SessionInfo {
  id: string;
  agentName: string;
  status: string;
  channel?: string;
  durationMs: number;
  estimatedCost: number;
  messageCount: number;
  errorCount: number;
  createdAt: string;
}

interface TimelineEvent {
  id: string;
  type: string;
  timestamp: string;
  agentName?: string;
  durationMs?: number;
  hasError?: boolean;
  data: Record<string, unknown>;
}

// =============================================================================
// HELPERS
// =============================================================================

function getEventIcon(type: string) {
  switch (type) {
    case 'user_message':
      return <User className="w-3.5 h-3.5" />;
    case 'llm_call':
    case 'llm.call.completed':
      return <Bot className="w-3.5 h-3.5" />;
    case 'tool_call':
    case 'tool.call.completed':
    case 'tool.call.failed':
      return <Wrench className="w-3.5 h-3.5" />;
    case 'handoff':
    case 'agent_enter':
    case 'agent_exit':
      return <ArrowRightLeft className="w-3.5 h-3.5" />;
    case 'error':
      return <AlertCircle className="w-3.5 h-3.5" />;
    default:
      return <MessageSquare className="w-3.5 h-3.5" />;
  }
}

function getEventColor(type: string, hasError?: boolean) {
  if (hasError) return { bg: 'bg-error-subtle', text: 'text-error' };

  switch (type) {
    case 'user_message':
      return { bg: 'bg-background-muted', text: 'text-foreground' };
    case 'llm_call':
    case 'llm.call.completed':
      return { bg: 'bg-accent-subtle', text: 'text-accent' };
    case 'tool_call':
    case 'tool.call.completed':
      return { bg: 'bg-warning-subtle', text: 'text-warning' };
    case 'tool.call.failed':
      return { bg: 'bg-error-subtle', text: 'text-error' };
    case 'handoff':
    case 'agent_enter':
    case 'agent_exit':
      return { bg: 'bg-purple-subtle', text: 'text-purple' };
    case 'error':
      return { bg: 'bg-error-subtle', text: 'text-error' };
    default:
      return { bg: 'bg-background-subtle', text: 'text-muted' };
  }
}

function getEventLabel(type: string): string {
  const labels: Record<string, string> = {
    user_message: 'User Message',
    llm_call: 'LLM Call',
    'llm.call.completed': 'LLM Response',
    tool_call: 'Tool Call',
    'tool.call.completed': 'Tool Result',
    'tool.call.failed': 'Tool Error',
    handoff: 'Handoff',
    agent_enter: 'Agent Enter',
    agent_exit: 'Agent Exit',
    error: 'Error',
    decision: 'Decision',
  };
  return labels[type] || type.replace(/[._]/g, ' ');
}

// =============================================================================
// COMPONENT
// =============================================================================

export function SessionDetail({ sessionId, projectId, onClose }: SessionDetailProps) {
  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [events, setEvents] = useState<TimelineEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [expandedEvents, setExpandedEvents] = useState<Set<string>>(new Set());

  const fetchSessionData = useCallback(async () => {
    if (!projectId || !sessionId) return;
    setIsLoading(true);
    try {
      // Fetch session info directly instead of loading the whole session list first.
      const sessionRes = await apiFetch(
        `/api/runtime/sessions/${encodeURIComponent(sessionId)}?projectId=${encodeURIComponent(projectId)}&includeTraces=false`,
      );
      if (sessionRes.ok) {
        const sessionJson = await sessionRes.json();
        const found =
          (sessionJson.session as Record<string, unknown> | undefined) ||
          (sessionJson.data as Record<string, unknown> | undefined) ||
          (sessionJson as Record<string, unknown>);
        if (found?.id || found?._id) {
          setSessionInfo({
            id: String(found.id || found._id || ''),
            agentName: String(found.agentName || 'Unknown'),
            status: String(found.status || 'unknown'),
            channel: found.channel ? String(found.channel) : undefined,
            durationMs: Number(found.durationMs || 0),
            estimatedCost: Number(found.estimatedCost || 0),
            messageCount: Number(found.messageCount || 0),
            errorCount: Number(found.errorCount || 0),
            createdAt: String(found.createdAt || ''),
          });
        }
      }

      // Fetch trace events for the session
      const tracesRes = await apiFetch(
        `/api/runtime/sessions/${encodeURIComponent(sessionId)}/traces?projectId=${encodeURIComponent(projectId)}&limit=200`,
      );
      if (tracesRes.ok) {
        const tracesJson = await tracesRes.json();
        const rawTraces = tracesJson.data?.traces || tracesJson.traces || [];
        setEvents(
          rawTraces.map((t: Record<string, unknown>) => ({
            id: String(t.id || ''),
            type: String(t.event_type || t.type || 'unknown'),
            timestamp: String(t.timestamp || ''),
            agentName: t.agent_name
              ? String(t.agent_name)
              : t.agentName
                ? String(t.agentName)
                : undefined,
            durationMs: t.duration_ms
              ? Number(t.duration_ms)
              : t.durationMs
                ? Number(t.durationMs)
                : undefined,
            hasError: Boolean(t.has_error),
            data: (t.data as Record<string, unknown>) || {},
          })),
        );
      }
    } catch {
      // Silently handle errors
    } finally {
      setIsLoading(false);
    }
  }, [sessionId, projectId]);

  useEffect(() => {
    fetchSessionData();
  }, [fetchSessionData]);

  const toggleEvent = (id: string) => {
    setExpandedEvents((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[480px] bg-background-elevated border-l border-default shadow-2xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-default shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Session Detail</h2>
          <p className="text-xs text-muted font-mono truncate mt-0.5">{sessionId}</p>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default hover:bg-background-muted shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto">
        {isLoading ? (
          <div className="flex items-center justify-center py-20">
            <Loader2 className="w-5 h-5 text-muted animate-spin" />
          </div>
        ) : (
          <div className="divide-y divide-default">
            {/* Metadata panel */}
            {sessionInfo && (
              <div className="px-5 py-4 space-y-3">
                <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
                  Metadata
                </h3>
                <div className="grid grid-cols-2 gap-3 text-xs">
                  <MetaItem
                    icon={<Bot className="w-3 h-3" />}
                    label="Agent"
                    value={sessionInfo.agentName}
                  />
                  <MetaItem
                    icon={<Hash className="w-3 h-3" />}
                    label="Status"
                    value={
                      <Badge
                        variant={
                          sessionInfo.status === 'active'
                            ? 'accent'
                            : sessionInfo.status === 'completed'
                              ? 'success'
                              : sessionInfo.status === 'failed'
                                ? 'error'
                                : 'default'
                        }
                      >
                        {sessionInfo.status}
                      </Badge>
                    }
                  />
                  {sessionInfo.channel && (
                    <MetaItem
                      icon={<Radio className="w-3 h-3" />}
                      label="Channel"
                      value={sessionInfo.channel}
                    />
                  )}
                  <MetaItem
                    icon={<Clock className="w-3 h-3" />}
                    label="Duration"
                    value={formatDuration(sessionInfo.durationMs)}
                  />
                  <MetaItem
                    icon={<MessageSquare className="w-3 h-3" />}
                    label="Messages"
                    value={String(sessionInfo.messageCount)}
                  />
                  <MetaItem
                    icon={<DollarSign className="w-3 h-3" />}
                    label="Cost"
                    value={formatCost(sessionInfo.estimatedCost)}
                  />
                  {sessionInfo.errorCount > 0 && (
                    <MetaItem
                      icon={<AlertCircle className="w-3 h-3" />}
                      label="Errors"
                      value={
                        <span className="text-error font-medium">{sessionInfo.errorCount}</span>
                      }
                    />
                  )}
                  <MetaItem
                    icon={<Clock className="w-3 h-3" />}
                    label="Started"
                    value={formatTimestamp(sessionInfo.createdAt)}
                  />
                </div>
              </div>
            )}

            {/* Timeline */}
            <div className="px-5 py-4">
              <h3 className="text-xs font-medium text-muted uppercase tracking-wider mb-4">
                Conversation Timeline
              </h3>

              {events.length === 0 ? (
                <p className="text-xs text-muted py-8 text-center">
                  No trace events found for this session
                </p>
              ) : (
                <div className="space-y-2">
                  {events.map((event) => {
                    const color = getEventColor(event.type, event.hasError);
                    const isExpanded = expandedEvents.has(event.id);
                    const isUserMessage = event.type === 'user_message';
                    const isAssistantMessage =
                      event.type === 'llm_call' || event.type === 'llm.call.completed';
                    const isToolCall =
                      event.type === 'tool_call' || event.type.includes('tool.call');
                    const isHandoff =
                      event.type === 'handoff' ||
                      event.type === 'agent_enter' ||
                      event.type === 'agent_exit';
                    const isError = event.hasError || event.type === 'error';

                    return (
                      <div
                        key={event.id}
                        className={clsx(
                          'rounded-lg border transition-default',
                          isError
                            ? 'border-error/30'
                            : isHandoff
                              ? 'border-purple/30'
                              : 'border-default',
                        )}
                      >
                        {/* Event header */}
                        <button
                          onClick={() => toggleEvent(event.id)}
                          className="w-full flex items-center gap-2 px-3 py-2 text-left"
                        >
                          <div
                            className={clsx(
                              'w-6 h-6 rounded-md flex items-center justify-center shrink-0',
                              color.bg,
                              color.text,
                            )}
                          >
                            {getEventIcon(event.type)}
                          </div>
                          <div className="flex-1 min-w-0">
                            <div className="flex items-center gap-2">
                              <span className="text-xs font-medium text-foreground">
                                {getEventLabel(event.type)}
                              </span>
                              {event.agentName && (
                                <span className="text-xs text-muted">{event.agentName}</span>
                              )}
                            </div>
                            {/* Preview content */}
                            {event.data.content ? (
                              <p className="text-xs text-muted truncate mt-0.5">
                                {String(event.data.content).slice(0, 80)}
                                {String(event.data.content).length > 80 ? '...' : ''}
                              </p>
                            ) : null}
                            {event.data.tool_name ? (
                              <p className="text-xs text-muted mt-0.5 font-mono">
                                {String(event.data.tool_name)}
                              </p>
                            ) : null}
                          </div>
                          <div className="flex items-center gap-2 shrink-0">
                            {event.durationMs != null && (
                              <span className="text-xs text-muted">
                                {formatDuration(event.durationMs)}
                              </span>
                            )}
                            {isExpanded ? (
                              <ChevronDown className="w-3 h-3 text-muted" />
                            ) : (
                              <ChevronRight className="w-3 h-3 text-muted" />
                            )}
                          </div>
                        </button>

                        {/* Expanded content */}
                        {isExpanded && (
                          <div className="px-3 pb-3 border-t border-default">
                            <div className="mt-2 space-y-2">
                              {/* Timestamp */}
                              <div className="text-xs text-muted">
                                {formatTimestamp(event.timestamp)}
                              </div>

                              {/* Message content */}
                              {event.data.content ? (
                                <div
                                  className={clsx(
                                    'rounded-lg px-3 py-2 text-xs',
                                    isUserMessage
                                      ? 'bg-background-muted text-foreground'
                                      : isAssistantMessage
                                        ? 'bg-accent-subtle text-foreground'
                                        : 'bg-background-subtle text-foreground',
                                  )}
                                >
                                  <p className="whitespace-pre-wrap break-words">
                                    {String(event.data.content)}
                                  </p>
                                </div>
                              ) : null}

                              {/* Tool call details */}
                              {isToolCall && event.data.arguments ? (
                                <div className="space-y-1">
                                  <span className="text-xs text-muted">Arguments:</span>
                                  <pre className="text-xs font-mono bg-background-muted rounded-md p-2 overflow-x-auto max-h-40 overflow-y-auto text-foreground">
                                    {typeof event.data.arguments === 'string'
                                      ? String(event.data.arguments)
                                      : JSON.stringify(event.data.arguments, null, 2)}
                                  </pre>
                                </div>
                              ) : null}
                              {isToolCall && event.data.result ? (
                                <div className="space-y-1">
                                  <span className="text-xs text-muted">Result:</span>
                                  <pre className="text-xs font-mono bg-background-muted rounded-md p-2 overflow-x-auto max-h-40 overflow-y-auto text-foreground">
                                    {typeof event.data.result === 'string'
                                      ? String(event.data.result)
                                      : JSON.stringify(event.data.result, null, 2)}
                                  </pre>
                                </div>
                              ) : null}

                              {/* Error content */}
                              {isError && event.data.error ? (
                                <div className="bg-error-subtle rounded-lg px-3 py-2 text-xs text-error">
                                  {typeof event.data.error === 'string'
                                    ? String(event.data.error)
                                    : JSON.stringify(event.data.error)}
                                </div>
                              ) : null}

                              {/* Handoff details */}
                              {isHandoff ? (
                                <div className="bg-purple-subtle rounded-lg px-3 py-2 text-xs text-purple">
                                  {event.data.from_agent ? (
                                    <span>From: {String(event.data.from_agent)}</span>
                                  ) : null}
                                  {event.data.to_agent ? (
                                    <span className="ml-3">To: {String(event.data.to_agent)}</span>
                                  ) : null}
                                  {event.data.reason ? (
                                    <p className="mt-1 text-muted">{String(event.data.reason)}</p>
                                  ) : null}
                                </div>
                              ) : null}

                              {/* LLM details */}
                              {isAssistantMessage && (event.data.model || event.data.tokens) ? (
                                <div className="flex flex-wrap gap-2 text-xs text-muted">
                                  {event.data.model ? (
                                    <span className="px-1.5 py-0.5 bg-background-muted rounded">
                                      {String(event.data.model)}
                                    </span>
                                  ) : null}
                                  {event.data.input_tokens ? (
                                    <span>In: {String(event.data.input_tokens)}</span>
                                  ) : null}
                                  {event.data.output_tokens ? (
                                    <span>Out: {String(event.data.output_tokens)}</span>
                                  ) : null}
                                  {event.data.estimated_cost ? (
                                    <span>
                                      Cost: {formatCost(Number(event.data.estimated_cost))}
                                    </span>
                                  ) : null}
                                </div>
                              ) : null}

                              {/* Raw data (fallback) */}
                              {!event.data.content &&
                                !isToolCall &&
                                !isHandoff &&
                                !isError &&
                                Object.keys(event.data).length > 0 && (
                                  <pre className="text-xs font-mono bg-background-muted rounded-md p-2 overflow-x-auto max-h-40 overflow-y-auto text-muted">
                                    {JSON.stringify(event.data, null, 2)}
                                  </pre>
                                )}
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function MetaItem({
  icon,
  label,
  value,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <span className="text-muted">{label}</span>
        <div className="text-foreground font-medium mt-0.5">
          {typeof value === 'string' ? <span className="truncate block">{value}</span> : value}
        </div>
      </div>
    </div>
  );
}
