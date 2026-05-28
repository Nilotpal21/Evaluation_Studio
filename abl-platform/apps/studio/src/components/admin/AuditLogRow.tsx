'use client';

import {
  AlertTriangle,
  ArrowRight,
  Brain,
  Hammer,
  PenTool,
  Settings,
  User,
  Wrench,
} from 'lucide-react';
import type { AuditLogCategory } from '@agent-platform/arch-ai';
import type { ArchAuditLogEntry } from '@/lib/arch-ai/store/arch-audit-store';

const CATEGORY_ICONS: Record<AuditLogCategory, React.ReactNode> = {
  llm_call: <Brain className="h-3.5 w-3.5 text-purple" />,
  tool_execution: <Wrench className="h-3.5 w-3.5 text-info" />,
  phase_transition: <ArrowRight className="h-3.5 w-3.5 text-teal" />,
  user_action: <User className="h-3.5 w-3.5 text-success" />,
  build_event: <Hammer className="h-3.5 w-3.5 text-warning" />,
  editor_mode_event: <PenTool className="h-3.5 w-3.5 text-info" />,
  error: <AlertTriangle className="h-3.5 w-3.5 text-error" />,
  system_event: <Settings className="h-3.5 w-3.5 text-foreground-muted" />,
};

const SEVERITY_CLASS: Record<string, string> = {
  critical: 'text-error',
  error: 'text-error',
  warning: 'text-warning',
  info: 'text-foreground-muted',
};

interface AuditLogRowProps {
  entry: ArchAuditLogEntry;
  onSessionClick: (sessionId: string) => void;
}

function formatTimestamp(timestamp: string): string {
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return timestamp;
  }
}

function formatTokens(entry: ArchAuditLogEntry): string | null {
  if (!entry.tokens || entry.tokens.total <= 0) {
    return null;
  }
  return `${entry.tokens.total.toLocaleString()} tokens`;
}

export function AuditLogRow({ entry, onSessionClick }: AuditLogRowProps) {
  const categoryIcon =
    CATEGORY_ICONS[entry.category as AuditLogCategory] ?? CATEGORY_ICONS.system_event;
  const severityClass = SEVERITY_CLASS[entry.severity] ?? 'text-foreground-muted';
  const tokenText = formatTokens(entry);

  return (
    <div className="grid grid-cols-[auto_minmax(0,1fr)_auto] gap-3 border-b border-border/40 px-4 py-3 last:border-b-0">
      <div className="mt-0.5 flex h-7 w-7 items-center justify-center rounded-md bg-background-muted">
        {categoryIcon}
      </div>

      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-sm font-medium text-foreground">{entry.summary}</span>
          <span className={`text-[10px] font-medium uppercase tracking-normal ${severityClass}`}>
            {entry.severity}
          </span>
          {entry.phase && (
            <span className="rounded bg-background-muted px-1.5 py-0.5 text-[10px] text-foreground-muted">
              {entry.phase}
            </span>
          )}
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2 text-[10px] text-foreground-subtle">
          <button
            type="button"
            onClick={() => onSessionClick(entry.sessionId)}
            className="font-mono hover:text-foreground"
          >
            {entry.sessionId}
          </button>
          {entry.specialist && <span>{entry.specialist}</span>}
          {entry.durationMs !== undefined && <span>{entry.durationMs} ms</span>}
          {tokenText && <span>{tokenText}</span>}
        </div>
      </div>

      <div className="whitespace-nowrap text-right text-[10px] text-foreground-subtle">
        {formatTimestamp(entry.timestamp)}
      </div>
    </div>
  );
}
