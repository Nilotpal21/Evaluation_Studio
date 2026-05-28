/**
 * ActivityEmitter — helper for emitting structured activity SSE events.
 *
 * B05: Live Thinking Visibility
 * Design doc: docs/arch/design/2026-04-05-live-thinking-visibility-design.md §10.2
 *
 * Usage:
 *   const activity = new ActivityEmitter(emit);
 *   const turnId = activity.nextTurn();
 *   activity.start(turnId, 'Thinking...');
 *   activity.done(turnId, 'Response ready');
 */

import type { ArchSSEEvent } from '../types/sse-events.js';

export type SSEEmitFn = (event: ArchSSEEvent) => void;

export interface ActivityOpts {
  group?: string;
  groupLabel?: string;
  detail?: string;
}

export class ActivityEmitter {
  private turnIndex = 0;

  constructor(private emit: SSEEmitFn) {}

  /** Start a new turn. Returns the turn ID for use in start/done pairs. */
  nextTurn(): string {
    this.turnIndex++;
    return `turn-${this.turnIndex}`;
  }

  start(id: string, label: string, opts?: ActivityOpts): void {
    this.emit({
      type: 'activity',
      id,
      status: 'active',
      label,
      group: opts?.group,
      groupLabel: opts?.groupLabel,
      detail: opts?.detail,
      timestamp: new Date().toISOString(),
    });
  }

  done(id: string, label: string, opts?: ActivityOpts): void {
    this.emit({
      type: 'activity',
      id,
      status: 'done',
      label,
      group: opts?.group,
      groupLabel: opts?.groupLabel,
      detail: opts?.detail,
      timestamp: new Date().toISOString(),
    });
  }

  error(id: string, label: string, opts?: ActivityOpts): void {
    this.emit({
      type: 'activity',
      id,
      status: 'error',
      label,
      group: opts?.group,
      groupLabel: opts?.groupLabel,
      detail: opts?.detail,
      timestamp: new Date().toISOString(),
    });
  }

  warning(id: string, label: string, opts?: ActivityOpts): void {
    this.emit({
      type: 'activity',
      id,
      status: 'warning',
      label,
      group: opts?.group,
      groupLabel: opts?.groupLabel,
      detail: opts?.detail,
      timestamp: new Date().toISOString(),
    });
  }

  info(id: string, label: string, opts?: ActivityOpts): void {
    this.emit({
      type: 'activity',
      id,
      status: 'info',
      label,
      group: opts?.group,
      groupLabel: opts?.groupLabel,
      detail: opts?.detail,
      timestamp: new Date().toISOString(),
    });
  }

  step(
    id: string,
    opts: {
      label: string;
      status: 'active' | 'done' | 'error' | 'warning' | 'info';
      detail?: string;
    },
  ): void {
    this.emit({
      type: 'activity',
      id,
      status: opts.status,
      label: opts.label,
      detail: opts.detail,
      timestamp: new Date().toISOString(),
    });
  }
}
