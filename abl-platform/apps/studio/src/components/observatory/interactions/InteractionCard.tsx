/**
 * InteractionCard — Full interaction card with collapsible header and step list.
 *
 * Shows: interaction number, active agent, mode, status dot, duration.
 * Click to expand/collapse the step timeline.
 */

import { Fragment, useState, useMemo } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import { InteractionStep } from './InteractionStep';
import { TokenBadge } from './TokenBadge';
import { FlowBreadcrumb } from './FlowBreadcrumb';
import { LifecycleBannerComponent } from './LifecycleBanner';
import { formatDuration, truncate } from './format-utils';
import type {
  Interaction,
  InteractionStep as InteractionStepData,
  LifecycleBanner,
  ToolCallStepItem,
} from './types';

interface InteractionCardProps {
  interaction: Interaction;
  /** Initial expansion state for uncontrolled usage */
  defaultExpanded?: boolean;
  /** Controlled expansion state for accordion-style parents */
  expanded?: boolean;
  /** Notified whenever the card expansion changes */
  onExpandedChange?: (expanded: boolean) => void;
}

export function InteractionCard({
  interaction,
  defaultExpanded = false,
  expanded,
  onExpandedChange,
}: InteractionCardProps) {
  const [uncontrolledExpanded, setUncontrolledExpanded] = useState(defaultExpanded);
  const isExpanded = expanded ?? uncontrolledExpanded;
  const summarySegments = useMemo(
    () => buildStorylineSegments(interaction.steps),
    [interaction.steps],
  );

  const handleExpandedChange = (nextExpanded: boolean) => {
    if (expanded === undefined) {
      setUncontrolledExpanded(nextExpanded);
    }
    onExpandedChange?.(nextExpanded);
  };

  const durationStr = useMemo(
    () => formatDuration(interaction.durationMs),
    [interaction.durationMs],
  );

  const statusColor =
    interaction.status === 'error'
      ? 'bg-error'
      : interaction.status === 'warning'
        ? 'bg-warning'
        : 'bg-success';

  const statusBorderColor =
    interaction.status === 'error'
      ? 'border-error/20'
      : interaction.status === 'warning'
        ? 'border-warning/20'
        : 'border-border-muted';

  return (
    <div className={clsx('rounded-md border overflow-hidden', statusBorderColor)}>
      {/* Header — always visible, clickable */}
      <button
        onClick={() => handleExpandedChange(!isExpanded)}
        aria-expanded={isExpanded}
        aria-label={`Interaction ${interaction.index} with ${interaction.agentName}, ${isExpanded ? 'collapse' : 'expand'} to ${isExpanded ? 'hide' : 'show'} ${interaction.steps.length} steps`}
        className={clsx(
          'w-full px-3 py-2 text-left',
          'bg-background-muted hover:bg-background-elevated transition-colors',
        )}
      >
        <div className="flex items-start gap-2">
          <div className="flex shrink-0 items-center gap-2 pt-0.5">
            {/* Expand/collapse chevron */}
            {isExpanded ? (
              <ChevronDown className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
            ) : (
              <ChevronRight className="w-3.5 h-3.5 text-foreground-muted shrink-0" />
            )}

            {/* Status dot */}
            <div className={clsx('w-2 h-2 rounded-full shrink-0', statusColor)} />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <span className="shrink-0 text-[10px] font-semibold text-foreground-subtle">
                {interaction.index}
              </span>

              {/* Duration moved left with the interaction identity */}
              <span className="shrink-0 text-[9px] font-mono text-foreground-subtle">
                {durationStr}
              </span>

              {/* Agent name */}
              <span className="max-w-[140px] shrink-0 truncate text-xs font-semibold text-foreground">
                {interaction.agentName}
              </span>

              {/* Mode badge */}
              <span className="text-[9px] text-foreground-subtle bg-background-elevated px-1.5 py-0.5 rounded shrink-0">
                {interaction.agentMode}
              </span>

              <div className="flex-1" />

              {/* Step count */}
              <span className="text-[9px] text-foreground-subtle shrink-0">
                {interaction.steps.length} step{interaction.steps.length !== 1 ? 's' : ''}
              </span>

              {/* Token badge */}
              <TokenBadge steps={interaction.steps} />
            </div>

            <InteractionStoryline segments={summarySegments} />
          </div>
        </div>
      </button>

      {/* Expandable step timeline */}
      <AnimatePresence>
        {isExpanded && (
          <motion.div
            role="region"
            aria-label={`Steps for interaction ${interaction.index}`}
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.35, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="px-3 pt-2 pb-1 bg-background">
              {/* Flow breadcrumb for scripted agents */}
              {interaction.agentMode === 'scripted' && <FlowBreadcrumb steps={interaction.steps} />}

              <TimelineItems interaction={interaction} />
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

type StorySegmentTone = 'user' | 'llm' | 'response' | 'tool' | 'decision' | 'error' | 'generic';

interface StorySegment {
  key: string;
  label: string;
  value: string;
  tone: StorySegmentTone;
}

function InteractionStoryline({ segments }: { segments: StorySegment[] }) {
  return (
    <div className="mt-1 min-w-0 flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
      {segments.map((segment, index) => (
        <Fragment key={segment.key}>
          {index > 0 && <span className="shrink-0 text-[10px] text-foreground-muted">→</span>}
          <div className="flex min-w-0 items-center gap-1 overflow-hidden">
            <span
              className={clsx(
                'shrink-0 text-[9px] font-semibold uppercase',
                STORY_LABEL_STYLES[segment.tone],
              )}
            >
              {segment.label}
            </span>
            <span
              className={clsx(
                'truncate text-[10px]',
                segment.tone === 'response' ? 'text-foreground' : 'text-foreground-subtle',
              )}
            >
              {segment.value}
            </span>
          </div>
        </Fragment>
      ))}
    </div>
  );
}

const STORY_LABEL_STYLES: Record<StorySegmentTone, string> = {
  user: 'text-info',
  llm: 'text-accent',
  response: 'text-success',
  tool: 'text-warning',
  decision: 'text-foreground-subtle',
  error: 'text-error',
  generic: 'text-foreground-subtle',
};

function buildStorylineSegments(steps: InteractionStepData[]): StorySegment[] {
  const segments: StorySegment[] = [];
  const seenKeys = new Set<string>();

  for (const step of steps) {
    const segment = buildStorySegment(step);
    if (!segment || seenKeys.has(segment.key)) {
      continue;
    }

    segments.push(segment);
    seenKeys.add(segment.key);

    if (segments.length >= 3) {
      break;
    }
  }

  if (segments.length > 0) {
    return segments;
  }

  return [
    {
      key: 'generic:fallback',
      label: 'TRACE',
      value: `${steps.length} step${steps.length === 1 ? '' : 's'}`,
      tone: 'generic',
    },
  ];
}

function buildStorySegment(step: InteractionStepData): StorySegment | null {
  switch (step.type) {
    case 'user_input': {
      const value = summarizeFreeText(step.data.content, 40);
      return value
        ? {
            key: 'user',
            label: 'USER',
            value,
            tone: 'user',
          }
        : null;
    }

    case 'llm_call': {
      const model = summarizeModelName(step.data.model);
      return model
        ? {
            key: `llm:${model}`,
            label: 'LLM',
            value: model,
            tone: 'llm',
          }
        : null;
    }

    case 'tool_call': {
      const toolCalls = Array.isArray(step.data.toolCalls)
        ? (step.data.toolCalls as ToolCallStepItem[])
        : [];
      const primaryTool =
        toolCalls.length > 0
          ? summarizeInlineValue(toolCalls[0]?.tool, 24)
          : summarizeInlineValue(step.data.tool, 24);
      const tool =
        toolCalls.length > 1 && primaryTool
          ? `${primaryTool} +${toolCalls.length - 1}`
          : primaryTool;
      return tool
        ? {
            key: `tool:${tool}`,
            label: 'TOOL',
            value: tool,
            tone: 'tool',
          }
        : null;
    }

    case 'agent_response': {
      const value = summarizeFreeText(step.data.content, 44);
      return value
        ? {
            key: 'response',
            label: 'RESP',
            value,
            tone: 'response',
          }
        : null;
    }

    case 'decision': {
      const target = summarizeInlineValue(step.data.target, 18);
      const decisionType = summarizeInlineValue(step.data.decisionType, 18);
      const value = target ? `${decisionType || 'decision'} ${target}` : decisionType;
      return value
        ? {
            key: `decision:${value}`,
            label: 'DEC',
            value,
            tone: 'decision',
          }
        : null;
    }

    case 'error': {
      const value = summarizeFreeText(step.data.message, 36);
      return value
        ? {
            key: `error:${value}`,
            label: 'ERROR',
            value,
            tone: 'error',
          }
        : null;
    }

    default:
      return null;
  }
}

function summarizeModelName(value: unknown): string | null {
  const normalized = normalizeInlineText(value);
  if (!normalized) {
    return null;
  }

  const lastPathSegment = normalized.split('/').pop() ?? normalized;
  const withoutDateSuffix = lastPathSegment.replace(/-\d{4}-\d{2}-\d{2}$/, '');
  return truncate(withoutDateSuffix, 20);
}

function summarizeFreeText(value: unknown, maxLength: number): string | null {
  const normalized = normalizeInlineText(value);
  return normalized ? truncate(normalized, maxLength) : null;
}

function summarizeInlineValue(value: unknown, maxLength: number): string | null {
  const normalized = normalizeInlineText(value);
  return normalized ? truncate(normalized, maxLength) : null;
}

function normalizeInlineText(value: unknown): string {
  if (typeof value !== 'string') {
    return '';
  }

  return value.replace(/\s+/g, ' ').trim();
}

type TimelineItem =
  | { kind: 'step'; step: Interaction['steps'][0]; index: number }
  | { kind: 'banner'; banner: LifecycleBanner };

function TimelineItems({ interaction }: { interaction: Interaction }) {
  const items = useMemo(() => {
    const filteredSteps = interaction.steps.filter((s) => {
      if (s.type === 'flow_transition' && !s.data.fromStep && !s.data.toStep) {
        return false;
      }
      return true;
    });

    const merged: TimelineItem[] = [
      ...filteredSteps.map((step, index) => ({
        kind: 'step' as const,
        step,
        index,
      })),
      ...interaction.banners.map((banner) => ({
        kind: 'banner' as const,
        banner,
      })),
    ].sort((a, b) => {
      const tsA = a.kind === 'step' ? a.step.timestamp.getTime() : a.banner.timestamp.getTime();
      const tsB = b.kind === 'step' ? b.step.timestamp.getTime() : b.banner.timestamp.getTime();
      return tsA - tsB;
    });

    return merged;
  }, [interaction.steps, interaction.banners]);

  const lastStepId = useMemo(() => {
    for (let j = items.length - 1; j >= 0; j--) {
      if (items[j].kind === 'step') return (items[j] as TimelineItem & { kind: 'step' }).step.id;
    }
    return null;
  }, [items]);

  return (
    <>
      {items.map((item, i) => {
        if (item.kind === 'banner') {
          return <LifecycleBannerComponent key={item.banner.id} banner={item.banner} />;
        }

        const isLastStep = item.step.id === lastStepId;

        return (
          <motion.div
            key={item.step.id}
            initial={{ opacity: 0, y: 16, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              duration: 0.5,
              // M2: Cap animation delay to prevent 6+ second delays with many steps
              delay: Math.min(0.15 + i * 0.12, 1.5),
              ease: [0.16, 1, 0.3, 1],
            }}
          >
            <InteractionStep step={item.step} isLast={isLastStep} allSteps={interaction.steps} />
          </motion.div>
        );
      })}
    </>
  );
}
