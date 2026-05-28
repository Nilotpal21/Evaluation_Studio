/**
 * TraceDetail Component
 *
 * Slide-over panel showing full event payload with JSON viewer,
 * timing info, parent span link, and LLM call details.
 */

import { clsx } from 'clsx';
import { X, Clock, Hash, Bot, Zap, Link2, DollarSign, FileText, Copy, Check } from 'lucide-react';
import { useState } from 'react';
import { formatDuration, formatCost, formatTimestamp } from '../analytics/shared';
import { Badge } from '../ui/Badge';

// =============================================================================
// TYPES
// =============================================================================

interface TraceEvent {
  id: string;
  eventType: string;
  timestamp: string;
  agentName: string;
  sessionId: string;
  durationMs: number;
  hasError: boolean;
  spanId?: string;
  parentSpanId?: string;
  data: Record<string, unknown>;
}

interface TraceDetailProps {
  event: TraceEvent;
  onClose: () => void;
}

// =============================================================================
// COMPONENT
// =============================================================================

export function TraceDetail({ event, onClose }: TraceDetailProps) {
  const [copied, setCopied] = useState(false);

  const handleCopyPayload = () => {
    navigator.clipboard.writeText(JSON.stringify(event.data, null, 2));
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const isLLMCall = event.eventType.includes('llm') || event.eventType === 'llm_call';
  const isToolCall = event.eventType.includes('tool') || event.eventType === 'tool_call';

  return (
    <div className="fixed inset-y-0 right-0 w-full sm:w-[520px] bg-background-elevated border-l border-default shadow-2xl z-50 flex flex-col">
      {/* Header */}
      <div className="flex items-center justify-between px-5 py-4 border-b border-default shrink-0">
        <div className="min-w-0">
          <h2 className="text-sm font-semibold text-foreground">Trace Detail</h2>
          <div className="flex items-center gap-2 mt-0.5">
            <Badge
              variant={
                event.hasError ? 'error' : isLLMCall ? 'accent' : isToolCall ? 'warning' : 'default'
              }
            >
              {event.eventType}
            </Badge>
            {event.hasError && (
              <Badge variant="error" dot>
                Error
              </Badge>
            )}
          </div>
        </div>
        <button
          onClick={onClose}
          className="p-1.5 text-muted hover:text-foreground rounded-lg transition-default hover:bg-background-muted shrink-0"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto divide-y divide-default">
        {/* Timing & Metadata */}
        <div className="px-5 py-4 space-y-3">
          <h3 className="text-xs font-medium text-muted uppercase tracking-wider">Event Info</h3>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <MetaRow
              icon={<Clock className="w-3 h-3" />}
              label="Timestamp"
              value={formatTimestamp(event.timestamp)}
            />
            {event.durationMs > 0 && (
              <MetaRow
                icon={<Zap className="w-3 h-3" />}
                label="Duration"
                value={formatDuration(event.durationMs)}
              />
            )}
            {event.agentName && (
              <MetaRow icon={<Bot className="w-3 h-3" />} label="Agent" value={event.agentName} />
            )}
            {event.sessionId && (
              <MetaRow
                icon={<Hash className="w-3 h-3" />}
                label="Session"
                value={event.sessionId}
                mono
              />
            )}
            {event.spanId && (
              <MetaRow
                icon={<Link2 className="w-3 h-3" />}
                label="Span ID"
                value={event.spanId}
                mono
              />
            )}
            {event.parentSpanId && (
              <MetaRow
                icon={<Link2 className="w-3 h-3" />}
                label="Parent Span"
                value={event.parentSpanId}
                mono
              />
            )}
          </div>
        </div>

        {/* LLM Call Details */}
        {isLLMCall && (
          <div className="px-5 py-4 space-y-3">
            <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
              LLM Call Details
            </h3>
            <div className="grid grid-cols-2 gap-3 text-xs">
              {event.data.model ? (
                <MetaRow
                  icon={<Bot className="w-3 h-3" />}
                  label="Model"
                  value={String(event.data.model)}
                />
              ) : null}
              {event.data.provider ? (
                <MetaRow
                  icon={<FileText className="w-3 h-3" />}
                  label="Provider"
                  value={String(event.data.provider)}
                />
              ) : null}
              {event.data.input_tokens != null ? (
                <MetaRow
                  icon={<Zap className="w-3 h-3" />}
                  label="Input Tokens"
                  value={String(event.data.input_tokens)}
                />
              ) : null}
              {event.data.output_tokens != null ? (
                <MetaRow
                  icon={<Zap className="w-3 h-3" />}
                  label="Output Tokens"
                  value={String(event.data.output_tokens)}
                />
              ) : null}
              {event.data.estimated_cost != null ? (
                <MetaRow
                  icon={<DollarSign className="w-3 h-3" />}
                  label="Cost"
                  value={formatCost(Number(event.data.estimated_cost))}
                />
              ) : null}
            </div>

            {/* Prompt preview */}
            {event.data.prompt ? (
              <div className="space-y-1">
                <span className="text-xs text-muted uppercase tracking-wider">Prompt</span>
                <pre className="text-xs font-mono bg-background-muted rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto text-foreground whitespace-pre-wrap break-words">
                  {typeof event.data.prompt === 'string'
                    ? String(event.data.prompt)
                    : JSON.stringify(event.data.prompt, null, 2)}
                </pre>
              </div>
            ) : null}

            {/* Response preview */}
            {event.data.response ? (
              <div className="space-y-1">
                <span className="text-xs text-muted uppercase tracking-wider">Response</span>
                <pre className="text-xs font-mono bg-background-muted rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto text-foreground whitespace-pre-wrap break-words">
                  {typeof event.data.response === 'string'
                    ? String(event.data.response)
                    : JSON.stringify(event.data.response, null, 2)}
                </pre>
              </div>
            ) : null}

            {/* Content (alternative field name) */}
            {event.data.content && !event.data.prompt ? (
              <div className="space-y-1">
                <span className="text-xs text-muted uppercase tracking-wider">Content</span>
                <pre className="text-xs font-mono bg-background-muted rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto text-foreground whitespace-pre-wrap break-words">
                  {String(event.data.content)}
                </pre>
              </div>
            ) : null}
          </div>
        )}

        {/* Tool Call Details */}
        {isToolCall && (
          <div className="px-5 py-4 space-y-3">
            <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
              Tool Call Details
            </h3>
            {event.data.tool_name ? (
              <div className="text-xs">
                <span className="text-muted">Tool: </span>
                <span className="text-foreground font-mono font-medium">
                  {String(event.data.tool_name)}
                </span>
              </div>
            ) : null}
            {event.data.arguments ? (
              <div className="space-y-1">
                <span className="text-xs text-muted uppercase tracking-wider">Arguments</span>
                <pre className="text-xs font-mono bg-background-muted rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto text-foreground">
                  {typeof event.data.arguments === 'string'
                    ? String(event.data.arguments)
                    : JSON.stringify(event.data.arguments, null, 2)}
                </pre>
              </div>
            ) : null}
            {event.data.result ? (
              <div className="space-y-1">
                <span className="text-xs text-muted uppercase tracking-wider">Result</span>
                <pre className="text-xs font-mono bg-background-muted rounded-lg p-3 overflow-x-auto max-h-48 overflow-y-auto text-foreground">
                  {typeof event.data.result === 'string'
                    ? String(event.data.result)
                    : JSON.stringify(event.data.result, null, 2)}
                </pre>
              </div>
            ) : null}
          </div>
        )}

        {/* Full Payload (JSON viewer) */}
        <div className="px-5 py-4 space-y-3">
          <div className="flex items-center justify-between">
            <h3 className="text-xs font-medium text-muted uppercase tracking-wider">
              Full Payload
            </h3>
            <button
              onClick={handleCopyPayload}
              className="flex items-center gap-1 px-2 py-1 text-xs text-muted hover:text-foreground transition-default rounded-md"
            >
              {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
              {copied ? 'Copied' : 'Copy'}
            </button>
          </div>
          <pre className="text-xs font-mono bg-background-muted rounded-lg p-3 overflow-x-auto max-h-[400px] overflow-y-auto text-foreground leading-relaxed">
            {JSON.stringify(event.data, null, 2) || '{}'}
          </pre>
        </div>
      </div>
    </div>
  );
}

// =============================================================================
// SUB-COMPONENTS
// =============================================================================

function MetaRow({
  icon,
  label,
  value,
  mono,
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex items-start gap-2">
      <span className="text-muted mt-0.5 shrink-0">{icon}</span>
      <div className="min-w-0">
        <span className="text-muted">{label}</span>
        <p
          className={clsx(
            'text-foreground font-medium mt-0.5 truncate',
            mono && 'font-mono text-xs',
          )}
          title={value}
        >
          {value}
        </p>
      </div>
    </div>
  );
}
