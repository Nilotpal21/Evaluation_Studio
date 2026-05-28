import { useState } from 'react';
import {
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CornerDownLeft,
  GitBranch,
  LogIn,
  LogOut,
  RotateCcw,
  Split,
} from 'lucide-react';
import { EVENT_LABELS } from './constants';
import { formatDuration } from './format-utils';
import { RawEventBlock } from './RawEventBlock';
import type { LifecycleBanner as LifecycleBannerData } from './types';

interface LifecycleBannerProps {
  banner: LifecycleBannerData;
}

const BANNER_CONFIG: Record<
  LifecycleBannerData['kind'],
  { Icon: typeof LogIn; intent: 'info' | 'warning' | 'success' }
> = {
  agent_enter: { Icon: LogIn, intent: 'info' },
  agent_exit: { Icon: LogOut, intent: 'success' },
  delegate_start: { Icon: Split, intent: 'warning' },
  delegate_complete: { Icon: CheckCircle2, intent: 'success' },
  handoff_return_handler: { Icon: GitBranch, intent: 'info' },
  resume_intent: { Icon: RotateCcw, intent: 'info' },
  thread_resume: { Icon: RotateCcw, intent: 'info' },
  return_to_parent: { Icon: CornerDownLeft, intent: 'info' },
  thread_return: { Icon: CornerDownLeft, intent: 'info' },
};

function getBannerText(banner: LifecycleBannerData): string {
  const label = EVENT_LABELS[banner.kind] ?? banner.kind;
  switch (banner.kind) {
    case 'agent_enter':
      return `${label} \u2014 ${banner.agentName}`;
    case 'agent_exit':
      return `${label} \u2014 ${banner.agentName}`;
    case 'delegate_start':
      return banner.targetAgent ? `${label} \u2014 ${banner.targetAgent}` : label;
    case 'delegate_complete':
      return banner.targetAgent ? `${label} \u2014 ${banner.targetAgent}` : label;
    case 'handoff_return_handler':
      return banner.targetAgent ? `${label} \u2014 ${banner.targetAgent}` : label;
    case 'resume_intent':
    case 'thread_resume':
      return `${label} \u2014 ${banner.agentName}`;
    case 'return_to_parent':
      if (banner.parentAgent && banner.targetAgent) {
        return `${label} \u2014 ${banner.parentAgent} \u2192 ${banner.targetAgent}`;
      }
      return banner.targetAgent
        ? `${label} \u2014 ${banner.targetAgent}`
        : banner.parentAgent
          ? `${label} \u2014 ${banner.parentAgent}`
          : label;
    case 'thread_return':
      if (banner.parentAgent && banner.targetAgent) {
        return `${label} \u2014 ${banner.parentAgent} \u2192 ${banner.targetAgent}`;
      }
      return banner.targetAgent
        ? `${label} \u2014 ${banner.targetAgent}`
        : banner.parentAgent
          ? `${label} \u2014 ${banner.parentAgent}`
          : label;
  }
}

const INTENT_CLASSES: Record<string, string> = {
  info: 'border-info/30 bg-info/5 text-info',
  warning: 'border-warning/30 bg-warning/5 text-warning',
  success: 'border-success/30 bg-success/5 text-success',
};

const INTENT_TEXT_CLASSES: Record<string, string> = {
  info: 'text-info',
  warning: 'text-warning',
  success: 'text-success',
};

export function LifecycleBannerComponent({ banner }: LifecycleBannerProps) {
  const config = BANNER_CONFIG[banner.kind];
  const Icon = config.Icon;
  const text = getBannerText(banner);
  const [expanded, setExpanded] = useState(false);
  const details = buildDetails(banner);

  if (
    banner.kind === 'agent_enter' ||
    banner.kind === 'agent_exit' ||
    banner.kind === 'thread_return'
  ) {
    return (
      <div className="my-3">
        <div className="grid grid-cols-[minmax(2rem,1fr)_auto_minmax(0,auto)_auto_minmax(2rem,1fr)] items-start gap-x-2 text-[11px] text-foreground-muted">
          <div className="mt-2.5 h-px min-w-8 bg-border-muted" />
          <Icon className={`mt-0.5 h-3.5 w-3.5 shrink-0 ${INTENT_TEXT_CLASSES[config.intent]}`} />
          <div className="min-w-0 max-w-[42ch]">
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-medium text-foreground-subtle">{text}</span>
              {banner.durationMs != null && (
                <span className="font-mono text-[10px] text-foreground-subtle">
                  {formatDuration(banner.durationMs)}
                </span>
              )}
            </div>
            {banner.reason && (
              <div className="mt-0.5 max-w-[48ch] truncate text-[9px] leading-tight text-foreground-muted">
                Reason: {banner.reason}
              </div>
            )}
          </div>
          <button
            type="button"
            onClick={() => setExpanded((next) => !next)}
            className="mt-0.5 shrink-0 text-[11px] font-medium leading-none text-info hover:underline focus:outline-none focus:ring-2 focus:ring-info/30"
            aria-expanded={expanded}
          >
            {expanded ? 'Close details' : 'Open details'}
          </button>
          <div className="mt-2.5 h-px min-w-8 bg-border-muted" />
        </div>

        {expanded && (
          <div className="ml-4 mt-2 border-l border-border-muted pl-3">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[10px]">
              {details.map((detail) => (
                <div key={detail.label} className="min-w-0">
                  <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
                    {detail.label}
                  </div>
                  <div className="truncate font-mono text-foreground-muted">{detail.value}</div>
                </div>
              ))}
            </div>

            {banner.causeLabel && (
              <div className="mt-2 flex items-center gap-1.5 text-[10px] text-foreground-muted">
                <GitBranch className="w-3 h-3 text-foreground-subtle" />
                <span>Triggered by: {banner.causeLabel}</span>
              </div>
            )}

            <div className="mt-2">
              <RawEventBlock
                type={banner.event.type}
                agent={banner.agentName}
                durationMs={banner.durationMs}
                data={banner.event.data ?? {}}
              />
            </div>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="my-2">
      <button
        type="button"
        onClick={() => setExpanded((next) => !next)}
        className={`w-full border rounded-md px-3 py-2 text-left transition-colors hover:bg-background-elevated ${INTENT_CLASSES[config.intent]}`}
        aria-expanded={expanded}
      >
        <div className="flex items-start gap-2">
          <Icon className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-[11px] font-semibold text-foreground">{text}</span>
              {banner.durationMs != null && (
                <span className="text-[10px] font-mono text-foreground-subtle">
                  {formatDuration(banner.durationMs)}
                </span>
              )}
              {banner.reasonCode && (
                <span className="rounded border border-border-muted bg-background px-1.5 py-0.5 text-[9px] font-mono text-foreground-muted">
                  {banner.reasonCode}
                </span>
              )}
            </div>
            <div className="mt-1 text-[10px] text-foreground-muted">
              <span className="font-medium text-foreground-subtle">Why:</span> {banner.reason}
            </div>
          </div>
          {expanded ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 text-foreground-subtle" />
          ) : (
            <ChevronRight className="w-3.5 h-3.5 shrink-0 text-foreground-subtle" />
          )}
        </div>
      </button>

      {expanded && (
        <div className="ml-4 mt-2 border-l border-border-muted pl-3">
          <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-[10px]">
            {details.map((detail) => (
              <div key={detail.label} className="min-w-0">
                <div className="text-[9px] uppercase tracking-wide text-foreground-subtle">
                  {detail.label}
                </div>
                <div className="truncate font-mono text-foreground-muted">{detail.value}</div>
              </div>
            ))}
          </div>

          {banner.causeLabel && (
            <div className="mt-2 flex items-center gap-1.5 text-[10px] text-foreground-muted">
              <GitBranch className="w-3 h-3 text-foreground-subtle" />
              <span>Triggered by: {banner.causeLabel}</span>
            </div>
          )}

          <div className="mt-2">
            <RawEventBlock
              type={banner.event.type}
              agent={banner.agentName}
              durationMs={banner.durationMs}
              data={banner.event.data ?? {}}
            />
          </div>
        </div>
      )}
    </div>
  );
}

function buildDetails(banner: LifecycleBannerData): Array<{ label: string; value: string }> {
  return [
    { label: 'event', value: EVENT_LABELS[banner.kind] ?? banner.kind },
    { label: 'agent', value: banner.agentName },
    banner.parentAgent ? { label: 'from', value: banner.parentAgent } : undefined,
    banner.targetAgent ? { label: 'to', value: banner.targetAgent } : undefined,
    banner.trigger ? { label: 'trigger', value: banner.trigger } : undefined,
    banner.result ? { label: 'result', value: banner.result } : undefined,
    banner.status ? { label: 'status', value: banner.status } : undefined,
    banner.phase ? { label: 'phase', value: banner.phase } : undefined,
  ].filter((detail): detail is { label: string; value: string } => Boolean(detail));
}
