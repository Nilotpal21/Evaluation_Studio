'use client';

/**
 * PromptComparePanel
 *
 * Displays 2–5 test pane results side by side. Each column shows the model /
 * version label, response text, latency badge, and token counts. Failed panes
 * surface an inline error message.
 */

import { useTranslations } from 'next-intl';
import { Copy, Clock, Hash, AlertTriangle } from 'lucide-react';
import { toast } from 'sonner';
import type { TestPaneResult } from '../../api/prompt-library';

interface PaneHeader {
  label: string;
  sublabel?: string;
}

interface PromptComparePanelProps {
  results: TestPaneResult[];
  headers: PaneHeader[];
  isLoading?: boolean;
}

function LatencyBadge({ ms }: { ms: number }) {
  const color =
    ms < 1000
      ? 'text-status-success bg-status-success/10'
      : ms < 3000
        ? 'text-status-warning bg-status-warning/10'
        : 'text-status-error bg-status-error/10';

  return (
    <span
      className={`inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium ${color}`}
    >
      <Clock className="h-3 w-3" />
      {ms < 1000 ? `${ms}ms` : `${(ms / 1000).toFixed(1)}s`}
    </span>
  );
}

function TokenBadge({ input, output }: { input: number; output: number }) {
  return (
    <span className="inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-xs font-medium text-foreground-muted bg-background-muted">
      <Hash className="h-3 w-3" />
      {input + output}
    </span>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-2 animate-pulse">
      <div className="h-4 w-3/4 rounded bg-background-muted" />
      <div className="h-4 w-full rounded bg-background-muted" />
      <div className="h-4 w-5/6 rounded bg-background-muted" />
      <div className="h-4 w-2/3 rounded bg-background-muted" />
    </div>
  );
}

export function PromptComparePanel({
  results,
  headers,
  isLoading = false,
}: PromptComparePanelProps) {
  const t = useTranslations('prompt_library.compare');

  const colCount = Math.max(results.length, headers.length);
  if (colCount === 0) return null;

  const gridCols =
    colCount === 2
      ? 'grid-cols-2'
      : colCount === 3
        ? 'grid-cols-3'
        : colCount === 4
          ? 'grid-cols-4'
          : 'grid-cols-5';

  return (
    <div className={`grid ${gridCols} gap-3`}>
      {Array.from({ length: colCount }).map((_, i) => {
        const header = headers[i];
        const result = results[i];

        return (
          <div
            key={i}
            className="flex flex-col gap-2 rounded-lg border border-default bg-background-elevated p-4"
          >
            {/* Column header */}
            <div className="border-b border-default pb-2">
              <p className="text-sm font-medium text-foreground truncate">
                {header?.label ?? `Pane ${i + 1}`}
              </p>
              {header?.sublabel && (
                <p className="text-xs text-foreground-muted truncate">{header.sublabel}</p>
              )}
            </div>

            {/* Content */}
            {isLoading && !result?.output && !result?.streaming ? (
              <LoadingSkeleton />
            ) : result?.error ? (
              <div className="flex items-start gap-2 text-status-error">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <p className="text-sm">{result.error.message}</p>
              </div>
            ) : result?.output || result?.streaming ? (
              <>
                <pre className="flex-1 whitespace-pre-wrap text-sm text-foreground leading-relaxed overflow-auto max-h-64 font-sans">
                  {result.output}
                  {result.streaming && (
                    <span className="inline-block w-0.5 h-3.5 bg-foreground animate-pulse ml-0.5 align-middle" />
                  )}
                </pre>

                {!result.streaming && (
                  <div className="flex items-center justify-between pt-2 border-t border-default">
                    <div className="flex items-center gap-2">
                      {result.latencyMs !== undefined && <LatencyBadge ms={result.latencyMs} />}
                      {result.inputTokens !== undefined && result.outputTokens !== undefined && (
                        <TokenBadge input={result.inputTokens} output={result.outputTokens} />
                      )}
                    </div>
                    <button
                      type="button"
                      title={t('copy_response')}
                      onClick={() => {
                        void navigator.clipboard.writeText(result.output ?? '');
                        toast.success(t('copy_response'));
                      }}
                      className="rounded p-1 text-foreground-muted hover:text-foreground hover:bg-background-muted transition-colors"
                    >
                      <Copy className="h-3.5 w-3.5" />
                    </button>
                  </div>
                )}
              </>
            ) : (
              <p className="text-sm text-foreground-muted italic">—</p>
            )}
          </div>
        );
      })}
    </div>
  );
}
