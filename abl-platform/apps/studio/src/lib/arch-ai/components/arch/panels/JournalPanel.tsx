'use client';

import { useEffect, useState } from 'react';
import { clsx } from 'clsx';
import { authHeaders } from '@/lib/api-client';
import { useArchAIStore } from '@/lib/arch-ai/store/arch-ai-store';

interface JournalEntry {
  type: string;
  summary: string;
  description?: string;
  phase?: string;
}

interface JournalPanelProps {
  sessionId: string | null;
  projectId?: string;
}

const PHASE_DOT: Record<string, string> = {
  INTERVIEW: 'bg-accent',
  BLUEPRINT: 'bg-info',
  BUILD: 'bg-success',
  CREATE: 'bg-warning',
  IN_PROJECT: 'bg-info',
};

const PHASE_FILL: Record<string, string> = {
  INTERVIEW: 'bg-accent/70',
  BLUEPRINT: 'bg-info/70',
  BUILD: 'bg-success/70',
  CREATE: 'bg-warning/70',
  IN_PROJECT: 'bg-info/70',
};

const TYPE_LABELS: Record<string, string> = {
  decision: 'Decision',
  consultation: 'Consultation',
  mutation: 'Update',
  validation: 'Validation',
  analysis: 'Analysis',
};

function extractDisplay(entry: { type: string; content?: Record<string, unknown> }): {
  summary: string;
  description?: string;
} {
  const c = entry.content;
  if (!c) return { summary: entry.type };

  const summary =
    (c.summary as string) ??
    (c.what as string) ??
    (c.target ? `${c.target}: ${c.result ?? ''}` : null) ??
    entry.type;

  const description =
    (c.to as string) ?? (c.rationale as string) ?? (c.reason as string) ?? undefined;

  return { summary, description };
}

/**
 * JournalPanel — vertical stepper grouped by phase.
 * Loads from API on mount, then subscribes to store for live SSE updates.
 */
export function JournalPanel({ sessionId, projectId }: JournalPanelProps) {
  const [apiEntries, setApiEntries] = useState<JournalEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const sseEntries = useArchAIStore((s) => s.journalEntries);

  useEffect(() => {
    if (!sessionId && !projectId) return;

    async function loadJournal() {
      setLoading(true);
      setLoadError(null);
      const journalUrl = projectId
        ? `/api/arch-ai/projects/${encodeURIComponent(projectId)}/journal`
        : `/api/arch-ai/sessions/${sessionId}/journal`;
      try {
        const res = await fetch(journalUrl, { headers: authHeaders() });
        if (!res.ok) {
          let errMsg = `Journal request failed (${res.status})`;
          try {
            const errBody = (await res.json()) as { error?: { message?: string } };
            if (errBody?.error?.message) errMsg = errBody.error.message;
          } catch {
            // not JSON
          }
          setLoadError(errMsg);
          return;
        }
        const data = (await res.json()) as {
          success?: boolean;
          entries?: Array<{ type: string; content?: Record<string, unknown>; phase?: string }>;
          error?: { message?: string };
        };
        if (data.success && Array.isArray(data.entries)) {
          setApiEntries(
            data.entries.map((e) => {
              const display = extractDisplay(e);
              return {
                type: e.type,
                summary: display.summary,
                description: display.description,
                phase: e.phase,
              };
            }),
          );
        } else if (data.error?.message) {
          setLoadError(data.error.message);
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        setLoadError(`Journal failed to load: ${msg}`);
      } finally {
        setLoading(false);
      }
    }

    loadJournal();
  }, [sessionId, projectId]);

  // Merge API entries + live SSE entries (dedup by summary)
  const allEntries = [...apiEntries];
  for (const sse of sseEntries) {
    if (!allEntries.some((e) => e.summary === sse.summary && e.type === sse.type)) {
      allEntries.push(sse);
    }
  }

  if (loading) {
    return (
      <div className="px-5 py-4">
        {/* Skeleton phase label */}
        <div className="mb-3 flex items-center gap-2">
          <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-foreground/10" />
          <span className="h-2.5 w-16 animate-pulse rounded bg-foreground/8" />
        </div>
        {/* Skeleton stepper rows */}
        {[80, 120, 96, 140, 72].map((w, i) => (
          <div key={i} className="flex gap-3">
            <div className="flex flex-shrink-0 flex-col items-center" style={{ width: 12 }}>
              <span className="mt-0.5 h-3 w-3 animate-pulse rounded-full bg-foreground/10" />
              {i < 4 && <span className="mt-1 w-px flex-1 animate-pulse bg-border/40" />}
            </div>
            <div className={clsx('min-w-0 flex-1', i < 4 ? 'pb-4' : 'pb-1')}>
              <div className="h-2 w-10 animate-pulse rounded bg-foreground/8" />
              <div
                className="mt-1.5 h-2.5 animate-pulse rounded bg-foreground/10"
                style={{ width: w }}
              />
              {i % 2 === 0 && (
                <div
                  className="mt-1 h-2 animate-pulse rounded bg-foreground/6"
                  style={{ width: w * 0.75 }}
                />
              )}
            </div>
          </div>
        ))}
      </div>
    );
  }

  if (loadError && allEntries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <div>
          <p className="text-sm text-error">Couldn't load the journal</p>
          <p className="mt-1 text-xs text-foreground-subtle">{loadError}</p>
        </div>
      </div>
    );
  }

  if (allEntries.length === 0) {
    return (
      <div className="flex h-full items-center justify-center p-4 text-center">
        <div>
          <p className="text-sm text-foreground-muted">No entries yet</p>
          <p className="mt-1 text-xs text-foreground-subtle">
            Decisions are recorded as you progress
          </p>
        </div>
      </div>
    );
  }

  // Group by phase (preserve insertion order)
  const grouped = new Map<string, JournalEntry[]>();
  for (const entry of allEntries) {
    const phase = entry.phase ?? 'UNKNOWN';
    if (!grouped.has(phase)) grouped.set(phase, []);
    grouped.get(phase)!.push(entry);
  }

  return (
    <div className="px-5 py-4">
      {Array.from(grouped.entries()).map(([phase, phaseEntries], groupIdx) => (
        <div key={phase} className={clsx(groupIdx > 0 && 'mt-6')}>
          {/* Phase label */}
          <div className="mb-3 flex items-center gap-2">
            <span
              className={clsx(
                'h-1.5 w-1.5 rounded-full flex-shrink-0',
                PHASE_DOT[phase] ?? 'bg-foreground-muted',
              )}
            />
            <span className="text-[10px] font-semibold uppercase tracking-widest text-foreground-muted">
              {phase}
            </span>
          </div>

          {/* Stepper entries */}
          {phaseEntries.map((entry, i) => {
            const isLast = i === phaseEntries.length - 1;
            return (
              <div key={`${phase}-${i}`} className="flex gap-3">
                {/* Left rail — node + connector */}
                <div className="flex flex-col items-center flex-shrink-0" style={{ width: 12 }}>
                  <span
                    className={clsx(
                      'h-3 w-3 rounded-full border-2 border-background flex-shrink-0 mt-0.5',
                      PHASE_FILL[phase] ?? 'bg-foreground-muted/60',
                    )}
                  />
                  {!isLast && <span className="mt-1 w-px flex-1 bg-border/50" />}
                </div>

                {/* Content */}
                <div className={clsx('min-w-0 flex-1', !isLast ? 'pb-4' : 'pb-1')}>
                  <div className="text-[9px] font-medium uppercase tracking-wider text-foreground-subtle">
                    {TYPE_LABELS[entry.type] ?? entry.type.replace(/_/g, ' ')}
                  </div>
                  <div className="mt-0.5 text-[11px] font-medium leading-snug text-foreground/90">
                    {entry.summary}
                  </div>
                  {entry.description && (
                    <div className="mt-0.5 text-[10px] leading-relaxed text-foreground-muted">
                      {entry.description}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      ))}
    </div>
  );
}
