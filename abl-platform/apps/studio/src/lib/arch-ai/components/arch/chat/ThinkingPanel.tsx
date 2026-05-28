'use client';

/**
 * ThinkingPanel — unified compact thinking + activity panel.
 *
 * Replaces separate ThinkingBlock + ActivitySteps with a single
 * fixed-height scrollable container. One toggle, one auto-collapse,
 * no orphaned steps.
 *
 * B05v2: Live Thinking v2
 */

import { memo, useState, useCallback, useEffect, useRef, useMemo } from 'react';
import { clsx } from 'clsx';
import type { ActivityGroup, ActivityStep } from '@/lib/arch-ai/ui/hook';
import { StepIcon, StepRow, getStepLabel } from './ActivitySteps';

interface ThinkingPanelProps {
  thinkingText?: string;
  thinkingElapsed?: number;
  activityGroups?: ActivityGroup[];
  isStreaming: boolean;
  defaultExpanded: boolean;
}

/** Live elapsed counter (ms precision, renders as seconds). */
function LiveElapsed({ startTime }: { startTime: number }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const interval = setInterval(() => {
      setElapsed(Math.round((Date.now() - startTime) / 100) / 10);
    }, 100);
    return () => clearInterval(interval);
  }, [startTime]);
  return <span className="text-xs text-foreground-muted/50">{elapsed.toFixed(1)}s</span>;
}

export const ThinkingPanel = memo(function ThinkingPanel({
  thinkingText,
  thinkingElapsed,
  activityGroups,
  isStreaming,
  defaultExpanded,
}: ThinkingPanelProps) {
  const hasThinking = Boolean(thinkingText);
  const groups = activityGroups ?? [];
  const hasSteps = groups.some((g) => g.steps.length > 0);
  const hasContent = hasThinking || hasSteps;

  const [expanded, setExpanded] = useState(defaultExpanded);
  const [streamStartTime] = useState(() => Date.now());
  const scrollAnchorRef = useRef<HTMLDivElement>(null);
  const hadContentRef = useRef(hasContent);

  // Keep hook order stable even when content appears after an empty render.
  useEffect(() => {
    if (hasContent && !hadContentRef.current) {
      hadContentRef.current = true;
      setExpanded(defaultExpanded);
      return;
    }
    if (hasContent) {
      hadContentRef.current = true;
    }
  }, [hasContent, defaultExpanded]);

  // Auto-collapse once, 3s after streaming ends. Skip for historical messages.
  const wasStreamingAtMount = useRef(isStreaming);
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (!wasStreamingAtMount.current) return;
    if (!isStreaming && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      const timer = setTimeout(() => setExpanded(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]);

  // Auto-scroll to bottom when new content arrives
  useEffect(() => {
    if (expanded && isStreaming) {
      scrollAnchorRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [thinkingText, activityGroups, expanded, isStreaming]);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  // Compute summary for collapsed state
  const toolCount = useMemo(() => {
    return groups.reduce((sum, g) => sum + g.steps.filter((s) => s.status !== 'info').length, 0);
  }, [groups]);

  const totalDurationMs = thinkingElapsed ?? 0;

  const summaryText = useMemo(() => {
    const parts: string[] = [];
    if (hasThinking) {
      parts.push(`Thought for ${(totalDurationMs / 1000).toFixed(1)}s`);
    }
    if (toolCount > 0) {
      parts.push(`${toolCount} tool${toolCount !== 1 ? 's' : ''}`);
    }
    if (!hasThinking && toolCount > 0 && totalDurationMs > 0) {
      parts.push(`${(totalDurationMs / 1000).toFixed(1)}s`);
    }
    return parts.join(' \u00B7 ');
  }, [hasThinking, toolCount, totalDurationMs]);

  const isMultiGroup = groups.length > 1 || (groups[0] && groups[0].id !== '__default__');

  // Nothing to show
  if (!hasContent) return null;

  return (
    <div className="mb-1.5">
      {/* Toggle header */}
      <button
        type="button"
        onClick={toggle}
        className={clsx(
          'flex w-full items-center gap-1.5 py-0.5 text-left text-sm transition-colors',
          isStreaming
            ? 'text-foreground-muted hover:text-foreground'
            : 'text-foreground-muted/60 hover:text-foreground-muted',
        )}
        aria-expanded={expanded}
        aria-label={isStreaming ? 'Thinking in progress' : summaryText}
      >
        <span className="text-[10px]">{expanded ? '\u25BE' : '\u25B8'}</span>
        {isStreaming && (
          <span className="flex h-3.5 w-3.5 items-center justify-center">
            <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-accent/30 border-t-accent" />
          </span>
        )}
        {isStreaming ? (
          <>
            <span>Thinking</span>
            <LiveElapsed startTime={streamStartTime} />
          </>
        ) : (
          <span>{summaryText}</span>
        )}
      </button>

      {/* Scrollable content */}
      {expanded && (
        <div
          className="max-h-[140px] overflow-y-auto pl-5 pt-0.5 pb-1 animate-in fade-in duration-150"
          style={{ scrollBehavior: 'smooth' }}
          aria-live="polite"
          aria-atomic={false}
        >
          {/* Thinking text section */}
          {hasThinking && (
            <div
              className={clsx(
                'font-mono text-[12px] leading-relaxed whitespace-pre-wrap break-words',
                isStreaming ? 'text-foreground-muted/70' : 'text-foreground-muted/50',
              )}
            >
              {thinkingText}
              {isStreaming && !hasSteps && (
                <span className="inline-block w-[2px] h-3.5 ml-0.5 bg-accent/60 animate-pulse" />
              )}
            </div>
          )}

          {/* Separator between thinking text and steps */}
          {hasThinking && hasSteps && (
            <div className="my-1.5 border-t border-foreground-muted/10" />
          )}

          {/* Activity steps section — flat, no nested group toggles */}
          {hasSteps &&
            groups.map((group) => {
              if (group.status === 'pending') return null;
              const firstStep = group.steps[0];
              const showGroupHeader =
                isMultiGroup &&
                !(group.steps.length === 1 && firstStep && getStepLabel(firstStep) === group.label);
              return (
                <div key={group.id}>
                  {/* Group header (only for multi-group, non-interactive) */}
                  {showGroupHeader && (
                    <div className="flex items-center gap-1.5 py-0.5 text-xs font-medium text-foreground-muted/70">
                      <StepIcon
                        status={
                          group.status === 'active'
                            ? 'active'
                            : group.status === 'error'
                              ? 'error'
                              : 'done'
                        }
                      />
                      <span>{group.label}</span>
                    </div>
                  )}
                  {/* Steps */}
                  {group.steps.map((step) => (
                    <StepRow key={step.id} step={step} />
                  ))}
                </div>
              );
            })}

          {/* Auto-scroll anchor */}
          <div ref={scrollAnchorRef} />
        </div>
      )}
    </div>
  );
});
