/**
 * RawEventBlock — Renders a single raw trace event with copy button.
 *
 * Shared between InteractionStep (RawEventsPanel) and DecisionContent (expanded details).
 */

import { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { EVENT_LABELS } from './constants';
import { formatDuration } from './format-utils';

interface RawEventBlockProps {
  type: string;
  agent?: string;
  durationMs?: number;
  data: Record<string, unknown>;
}

export function RawEventBlock({ type, agent, durationMs, data }: RawEventBlockProps) {
  const [copied, setCopied] = useState(false);
  const json = formatEventData(data);

  const handleCopy = () => {
    navigator.clipboard.writeText(json);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  return (
    <div>
      <div className="flex items-center gap-1.5 text-[9px] text-foreground-muted font-medium mb-0.5">
        <span>{EVENT_LABELS[type] ?? type}</span>
        {agent && <span className="text-foreground-subtle">({agent})</span>}
        {durationMs != null && durationMs > 0 && (
          <span className="text-foreground-subtle font-mono">{formatDuration(durationMs)}</span>
        )}
        <div className="flex-1" />
        <button
          onClick={handleCopy}
          className="text-foreground-muted hover:text-foreground transition-colors"
          title={copied ? 'Copied!' : 'Copy JSON'}
        >
          {copied ? <Check className="w-3 h-3 text-success" /> : <Copy className="w-3 h-3" />}
        </button>
      </div>
      <div className="bg-background-elevated rounded p-2 text-[10px] font-mono text-foreground-subtle whitespace-pre-wrap break-words max-h-32 overflow-y-auto">
        {json}
      </div>
    </div>
  );
}

function formatEventData(data: Record<string, unknown>): string {
  try {
    return JSON.stringify(data, null, 2);
  } catch {
    return String(data);
  }
}
