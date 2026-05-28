/**
 * SwimLaneTimeline — Parallel tool execution visualization.
 *
 * Design spec Section 9.2.2. Shows each parallel tool as a horizontal
 * bar on a shared timeline with a time ruler.
 */

import { useMemo, useState } from 'react';
import { getIntentStyles } from '@agent-platform/design-tokens';
import { ChevronDown, ChevronRight } from 'lucide-react';
import clsx from 'clsx';
import type { ExtendedTraceEvent } from '../../../types';
import { normalizeEventType } from '../../../lib/event-types';
import type { InteractionStep } from './types';

// =============================================================================
// EXPORTED TYPES + LOGIC (testable)
// =============================================================================

export interface ParallelLane {
  tool: string;
  startMs: number;
  durationMs: number;
  status: 'success' | 'failed';
  event: ExtendedTraceEvent;
}

export interface ParallelResult {
  isParallel: boolean;
  lanes: ParallelLane[];
  totalMs: number;
  sequentialMs: number;
  parallelMs: number;
  savedMs: number;
}

/**
 * Detect parallel tool calls and compute swim lane visualization data.
 *
 * Analyzes tool call events to determine if they executed in parallel
 * (overlapping time ranges) and calculates time savings from parallelization.
 *
 * @param events - Array of trace events to analyze (will filter for tool_call types)
 * @returns Parallel execution analysis with lanes, timing, and savings calculation
 *
 * @remarks
 * - Tool calls are parallel if their time ranges overlap (startB < endA)
 * - Sequential time = sum of all durations
 * - Parallel time = max(endTime) - min(startTime)
 * - Time savings = sequential - parallel
 * - Pure function - no side effects, suitable for unit testing
 *
 * @example
 * ```ts
 * const result = detectParallelTools(step.events);
 * if (result.isParallel) {
 *   console.log(`Saved ${result.savedMs}ms by running ${result.lanes.length} tools in parallel`);
 * }
 * ```
 */
export function detectParallelTools(events: ExtendedTraceEvent[]): ParallelResult {
  // L8: Include tool.call.failed to show failed parallel tools in swim lane
  const toolEvents = events.filter((e) => normalizeEventType(e.type) === 'tool_call');

  const lanes = toolEvents.length > 0 ? buildToolCallLanes(toolEvents) : buildFanOutLanes(events);

  if (lanes.length === 0) {
    return {
      isParallel: false,
      lanes: [],
      totalMs: 0,
      sequentialMs: 0,
      parallelMs: 0,
      savedMs: 0,
    };
  }

  // H5: Optimized overlap detection — O(n log n) instead of O(n²)
  // Sort lanes by start time, then check each lane against still-active previous lanes
  const sortedLanes = [...lanes].sort((a, b) => a.startMs - b.startMs);
  let isParallel = false;

  for (let i = 1; i < sortedLanes.length && !isParallel; i++) {
    const current = sortedLanes[i];
    // Check if current overlaps with any previous lane that hasn't ended yet
    for (let j = i - 1; j >= 0; j--) {
      const prev = sortedLanes[j];
      const prevEnd = prev.startMs + prev.durationMs;
      // If previous lane ended before current started, no need to check earlier lanes
      // (since lanes are sorted by startMs, all earlier lanes also ended before)
      if (prevEnd <= current.startMs) break;
      // Found overlap
      if (current.startMs < prevEnd) {
        isParallel = true;
        break;
      }
    }
  }

  const sequentialMs = lanes.reduce((sum, l) => sum + l.durationMs, 0);
  const parallelMs = lanes.length > 0 ? Math.max(...lanes.map((l) => l.startMs + l.durationMs)) : 0;
  const savedMs = Math.max(0, sequentialMs - parallelMs);

  return { isParallel, lanes, totalMs: parallelMs, sequentialMs, parallelMs, savedMs };
}

function buildToolCallLanes(toolEvents: ExtendedTraceEvent[]): ParallelLane[] {
  const minStart = Math.min(...toolEvents.map((e) => e.timestamp.getTime()));

  return toolEvents.map((e) => ({
    tool: String(e.data.tool ?? e.data.toolName ?? e.data.name ?? 'unknown'),
    startMs: e.timestamp.getTime() - minStart,
    durationMs: e.durationMs ?? 0,
    status: e.data.error ? 'failed' : 'success',
    event: e,
  }));
}

function buildFanOutLanes(events: ExtendedTraceEvent[]): ParallelLane[] {
  const taskStarts = events.filter((e) => e.type === 'fan_out_task_start');
  if (taskStarts.length === 0) {
    return [];
  }

  const minStart = Math.min(...taskStarts.map((e) => e.timestamp.getTime()));
  const taskCompletes = events.filter(
    (e) => e.type === 'fan_out_task_complete' || e.type === 'fan_out_child_completed',
  );

  return taskStarts.map((start) => {
    const tool = String(start.data.target ?? start.data.tool ?? start.data.toolName ?? 'unknown');
    const complete = taskCompletes.find((event) => {
      const target = String(event.data.target ?? event.data.tool ?? event.data.toolName ?? '');
      return target === tool && event.timestamp.getTime() >= start.timestamp.getTime();
    });
    const explicitDuration = readNumber(complete?.data.durationMs, complete?.durationMs);
    const measuredDuration = complete
      ? complete.timestamp.getTime() - start.timestamp.getTime()
      : (start.durationMs ?? 0);

    return {
      tool,
      startMs: start.timestamp.getTime() - minStart,
      durationMs: explicitDuration ?? measuredDuration,
      status: complete?.data.error || complete?.data.status === 'error' ? 'failed' : 'success',
      event: complete ?? start,
    };
  });
}

function readNumber(...values: unknown[]): number | undefined {
  for (const value of values) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
  }
  return undefined;
}

// =============================================================================
// REACT COMPONENT
// =============================================================================

interface SwimLaneTimelineProps {
  step: InteractionStep;
}

export function SwimLaneTimeline({ step }: SwimLaneTimelineProps) {
  const [expandedLane, setExpandedLane] = useState<string | null>(null);
  const styles = getIntentStyles('info');

  const result = useMemo(() => detectParallelTools(step.events), [step.events]);

  if (result.lanes.length === 0) {
    return (
      <div className={clsx('rounded-md border px-3 py-2 text-xs', styles.border, styles.bgSubtle)}>
        <span className="text-foreground-muted">No parallel tool data</span>
      </div>
    );
  }

  return (
    <div
      className={clsx('rounded-md border text-xs overflow-hidden', styles.border, styles.bgSubtle)}
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border-muted">
        <span className={clsx('font-medium', styles.text)}>
          Parallel Execution · {result.lanes.length} tasks
        </span>
      </div>

      {/* Swim lanes */}
      <div className="px-3 py-2 space-y-1.5">
        {/* Time ruler */}
        {result.totalMs > 0 && (
          <div className="flex items-center text-[8px] text-foreground-subtle font-mono mb-1">
            <span>0ms</span>
            <div className="flex-1" />
            <span>{Math.round(result.totalMs / 2)}ms</span>
            <div className="flex-1" />
            <span>{Math.round(result.totalMs)}ms</span>
          </div>
        )}

        {/* Lanes */}
        {result.lanes.map((lane, i) => {
          const leftPct = result.totalMs > 0 ? (lane.startMs / result.totalMs) * 100 : 0;
          const widthPct = result.totalMs > 0 ? (lane.durationMs / result.totalMs) * 100 : 100;
          const isExpanded = expandedLane === `${lane.tool}-${i}`;

          return (
            <div key={`${lane.tool}-${i}`}>
              <div className="flex items-center gap-2">
                {/* Tool name */}
                <span className="w-28 truncate text-foreground-muted shrink-0">{lane.tool}</span>

                {/* Bar track */}
                <div className="flex-1 h-4 bg-background-elevated rounded relative overflow-hidden">
                  <div
                    className={clsx(
                      'absolute h-full rounded',
                      lane.status === 'failed' ? 'bg-error' : 'bg-success',
                    )}
                    style={{ left: `${leftPct}%`, width: `${Math.max(widthPct, 2)}%` }}
                  />
                </div>

                {/* Status + duration */}
                <span
                  className={clsx(
                    'shrink-0 font-mono',
                    lane.status === 'failed' ? 'text-error' : 'text-success',
                  )}
                >
                  {lane.status === 'failed' ? '✗' : '✓'} {Math.round(lane.durationMs)}ms
                </span>

                {/* Expand toggle */}
                <button
                  onClick={() => setExpandedLane(isExpanded ? null : `${lane.tool}-${i}`)}
                  className="text-foreground-muted hover:text-foreground shrink-0"
                >
                  {isExpanded ? (
                    <ChevronDown className="w-3 h-3" />
                  ) : (
                    <ChevronRight className="w-3 h-3" />
                  )}
                </button>
              </div>

              {/* Expanded tool details */}
              {isExpanded && (
                <div className="mt-1 pl-[7.5rem] space-y-1">
                  {lane.event.data.input != null && (
                    <div className="bg-background-elevated rounded p-1.5 text-[9px] font-mono text-foreground-subtle max-h-20 overflow-y-auto">
                      <span className="text-foreground-muted">Input: </span>
                      {JSON.stringify(lane.event.data.input, null, 2)}
                    </div>
                  )}
                  {(lane.event.data.result ?? lane.event.data.output) != null && (
                    <div className="bg-background-elevated rounded p-1.5 text-[9px] font-mono text-foreground-subtle max-h-20 overflow-y-auto">
                      <span className="text-foreground-muted">Output: </span>
                      {JSON.stringify(lane.event.data.result ?? lane.event.data.output, null, 2)}
                    </div>
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Time savings footer */}
      {result.isParallel && result.savedMs > 0 && (
        <div className="px-3 py-1.5 border-t border-border-muted text-[9px] text-foreground-subtle">
          ✓ Sequential: {Math.round(result.sequentialMs)}ms → Parallel:{' '}
          {Math.round(result.parallelMs)}ms{' · '}
          <span className="text-success font-medium">
            Saved {Math.round(result.savedMs)}ms (
            {Math.round((result.savedMs / result.sequentialMs) * 100)}% faster)
          </span>
        </div>
      )}
    </div>
  );
}
