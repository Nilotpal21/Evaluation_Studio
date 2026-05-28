'use client';

import { memo } from 'react';
import { clsx } from 'clsx';
import type { SearchResultsCardEvent } from '@agent-platform/arch-ai';

interface SearchResultsCardProps {
  event: SearchResultsCardEvent;
}

function scoreColor(score: number): string {
  if (score >= 0.8) return 'text-success';
  if (score >= 0.5) return 'text-warning';
  return 'text-foreground-muted';
}

function SearchResultsCardImpl({ event }: SearchResultsCardProps) {
  return (
    <div className="w-full rounded-lg border border-border bg-card p-4 animate-fade-in-up">
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-primary/10 text-primary text-xs">
            🔍
          </span>
          <div>
            <h3 className="text-sm font-semibold text-foreground">Search Results</h3>
            <p className="text-xs text-foreground-muted truncate max-w-[200px]">
              &ldquo;{event.query}&rdquo;
            </p>
          </div>
        </div>
        <div className="text-right text-xs text-foreground-muted">
          <div>
            {event.resultCount} result{event.resultCount !== 1 ? 's' : ''}
          </div>
          <div>{event.latencyMs}ms</div>
        </div>
      </div>

      <div className="space-y-1.5 mb-3 max-h-60 overflow-y-auto">
        {event.results.map((r, i) => (
          <div key={i} className="rounded-md bg-muted/50 px-2.5 py-2">
            <div className="flex items-center justify-between mb-0.5">
              <span className="text-xs font-medium text-foreground truncate max-w-[70%]">
                {r.title}
              </span>
              <span className={clsx('text-[10px] font-mono', scoreColor(r.score))}>
                {(r.score * 100).toFixed(0)}%
              </span>
            </div>
            {r.content && (
              <p className="text-[11px] text-foreground-muted line-clamp-2">{r.content}</p>
            )}
            {r.source && (
              <span className="text-[10px] text-foreground-muted/60">
                {r.sourceType ?? r.source}
              </span>
            )}
          </div>
        ))}
      </div>

      {event.actions.length > 0 && (
        <div className="flex gap-2 border-t border-border pt-2">
          {event.actions.map((a) => (
            <button
              key={a.action}
              className={clsx(
                'rounded-md px-2.5 py-1 text-xs transition-colors',
                a.variant === 'primary'
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-foreground hover:bg-muted/80',
              )}
            >
              {a.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

export const SearchResultsCard = memo(SearchResultsCardImpl);
