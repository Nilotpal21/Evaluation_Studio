'use client';

/**
 * ThinkingBlock — collapsible Claude Code style thinking block.
 *
 * B05v2: Live Thinking v2
 * Design: docs/arch/design/2026-04-09-live-thinking-v2-claude-style-design.md
 *
 * Shows pre-tool LLM narrative in a collapsible block above ActivitySteps.
 * Expanded for first message in conversation, collapsed for subsequent.
 * Auto-collapses 3s after streaming ends.
 */

import { memo, useState, useCallback, useEffect, useRef } from 'react';
import { clsx } from 'clsx';

interface ThinkingBlockProps {
  text: string;
  elapsed: number; // ms from ChatMessage.thinkingElapsed
  isStreaming: boolean;
  defaultExpanded: boolean;
}

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

function StaticElapsed({ ms }: { ms: number }) {
  const seconds = (ms / 1000).toFixed(1);
  return <span className="text-xs text-foreground-muted/50">{seconds}s</span>;
}

export const ThinkingBlock = memo(function ThinkingBlock({
  text,
  elapsed,
  isStreaming,
  defaultExpanded,
}: ThinkingBlockProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [streamStartTime] = useState(() => Date.now());

  // Auto-collapse once, 3s after streaming ends. Does not re-arm on user toggle.
  // Skip for historical messages (not streaming at mount) to avoid collapsing on session restore.
  const wasStreamingAtMount = useRef(isStreaming);
  const autoCollapsedRef = useRef(false);
  useEffect(() => {
    if (!wasStreamingAtMount.current) return; // historical — never auto-collapse
    if (!isStreaming && !autoCollapsedRef.current) {
      autoCollapsedRef.current = true;
      const timer = setTimeout(() => setExpanded(false), 3000);
      return () => clearTimeout(timer);
    }
  }, [isStreaming]);

  const toggle = useCallback(() => setExpanded((e) => !e), []);

  const label = isStreaming ? 'Thinking' : 'Thought for';

  return (
    <div className="mb-1.5">
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
        aria-label={
          isStreaming
            ? 'Thinking in progress — click to toggle details'
            : `Thought for ${(elapsed / 1000).toFixed(1)} seconds — click to toggle details`
        }
      >
        <span className="text-[10px]">{expanded ? '\u25BE' : '\u25B8'}</span>
        {isStreaming && (
          <span className="flex h-3.5 w-3.5 items-center justify-center">
            <span className="h-2.5 w-2.5 animate-spin rounded-full border-[1.5px] border-accent/30 border-t-accent" />
          </span>
        )}
        <span>{label}</span>
        {isStreaming ? <LiveElapsed startTime={streamStartTime} /> : <StaticElapsed ms={elapsed} />}
      </button>

      {expanded && (
        <div
          className={clsx(
            'pl-5 pt-0.5 pb-1 font-mono text-[12px] leading-relaxed animate-in fade-in duration-150',
            isStreaming ? 'text-foreground-muted/70' : 'text-foreground-muted/50',
          )}
        >
          <div className="whitespace-pre-wrap break-words">
            {text}
            {isStreaming && (
              <span className="inline-block w-[2px] h-3.5 ml-0.5 bg-accent/60 animate-pulse" />
            )}
          </div>
        </div>
      )}
    </div>
  );
});
