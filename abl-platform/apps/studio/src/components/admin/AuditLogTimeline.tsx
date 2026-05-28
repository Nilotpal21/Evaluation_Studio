'use client';

import {
  X,
  Brain,
  Wrench,
  ArrowRight,
  User,
  Hammer,
  AlertTriangle,
  Settings,
  PenTool,
} from 'lucide-react';
import { useArchAuditStore } from '@/lib/arch-ai/store/arch-audit-store';
import type { AuditLogCategory } from '@agent-platform/arch-ai';

const CATEGORY_ICONS: Record<AuditLogCategory, React.ReactNode> = {
  llm_call: <Brain className="h-3 w-3 text-purple" />,
  tool_execution: <Wrench className="h-3 w-3 text-info" />,
  phase_transition: <ArrowRight className="h-3 w-3 text-teal" />,
  user_action: <User className="h-3 w-3 text-success" />,
  build_event: <Hammer className="h-3 w-3 text-warning" />,
  editor_mode_event: <PenTool className="h-3 w-3 text-info" />,
  error: <AlertTriangle className="h-3 w-3 text-error" />,
  system_event: <Settings className="h-3 w-3 text-foreground-muted" />,
};

function formatTime(ts: string): string {
  try {
    return new Date(ts).toLocaleTimeString('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
    });
  } catch {
    return ts;
  }
}

export function AuditLogTimeline() {
  const sessionId = useArchAuditStore((s) => s.timelineSessionId);
  const entries = useArchAuditStore((s) => s.timelineEntries);
  const loading = useArchAuditStore((s) => s.timelineLoading);
  const closeTimeline = useArchAuditStore((s) => s.closeTimeline);

  if (!sessionId) return null;

  return (
    <div className="rounded-lg border border-info/30 bg-info/5 p-4">
      <div className="flex items-center justify-between mb-3">
        <div>
          <div className="text-xs font-semibold text-foreground">Session Timeline</div>
          <div className="text-[10px] text-foreground-muted font-mono">{sessionId}</div>
        </div>
        <button
          onClick={closeTimeline}
          className="rounded-md p-1 text-foreground-muted hover:bg-background-muted"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-6 text-xs text-foreground-muted">
          Loading timeline...
        </div>
      ) : entries.length === 0 ? (
        <div className="flex items-center justify-center py-6 text-xs text-foreground-muted">
          No events found for this session
        </div>
      ) : (
        <div className="space-y-0.5">
          {entries.map((entry, i) => (
            <div
              key={entry._id ?? i}
              className="flex items-start gap-2 rounded px-2 py-1.5 hover:bg-background-muted/50"
            >
              <span className="mt-0.5 shrink-0">
                {CATEGORY_ICONS[entry.category as AuditLogCategory] ?? CATEGORY_ICONS.system_event}
              </span>
              <div className="min-w-0 flex-1">
                <div className="text-[11px] text-foreground leading-snug">{entry.summary}</div>
                {entry.phase && (
                  <span className="text-[9px] text-foreground-subtle">{entry.phase}</span>
                )}
              </div>
              <span className="shrink-0 text-[10px] tabular-nums text-foreground-subtle">
                {formatTime(entry.timestamp)}
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
