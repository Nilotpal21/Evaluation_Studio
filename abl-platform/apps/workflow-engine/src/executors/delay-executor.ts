/**
 * Delay Step Executor
 *
 * Parses a delay duration and returns the resolved millisecond value.
 * The actual sleep/wait is handled by the workflow handler (via Restate ctx.sleep()).
 * This executor only resolves the duration — it does NOT block.
 */

import { resolveExpression } from '../context/expression-resolver.js';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import {
  MAX_DELAY_MS,
  MS_PER_DAY,
  MS_PER_HOUR,
  MS_PER_MINUTE,
  MS_PER_SECOND,
} from '../constants.js';

export interface DelayStep {
  id: string;
  type: 'delay';
  /** Duration as ISO 8601 duration (PT30S, PT5M, PT1H) or raw milliseconds string */
  duration: string;
}

export interface DelayResult {
  durationMs: number;
}

/**
 * Parse an ISO 8601 duration string to milliseconds.
 * Supports: PTnS, PTnM, PTnH, PnD and combinations (PT1H30M).
 */
function parseISO8601Duration(iso: string): number | null {
  const match = /^P(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i.exec(iso.trim());
  if (!match) return null;

  const days = parseInt(match[1] || '0', 10);
  const hours = parseInt(match[2] || '0', 10);
  const minutes = parseInt(match[3] || '0', 10);
  const seconds = parseFloat(match[4] || '0');

  return (
    days * MS_PER_DAY +
    hours * MS_PER_HOUR +
    minutes * MS_PER_MINUTE +
    Math.round(seconds * MS_PER_SECOND)
  );
}

/**
 * Resolve the delay duration from a step definition.
 * Supports:
 * - ISO 8601 durations: "PT30S", "PT5M", "PT1H30M", "P1D"
 * - Raw milliseconds: "5000"
 * - Expression: "{{vars.delayMs}}"
 */
export function resolveDelay(step: DelayStep, ctx: WorkflowContextData): DelayResult {
  const resolved = resolveExpression(step.duration, ctx);

  // Try ISO 8601 first
  const iso = parseISO8601Duration(resolved);
  if (iso !== null) {
    if (iso < 0 || iso > MAX_DELAY_MS) {
      throw new Error(`Delay duration out of range: ${iso}ms (max ${MAX_DELAY_MS}ms)`);
    }
    return { durationMs: iso };
  }

  // Try raw number (milliseconds)
  const numeric = Number(resolved);
  if (!Number.isNaN(numeric) && Number.isFinite(numeric)) {
    if (numeric < 0 || numeric > MAX_DELAY_MS) {
      throw new Error(`Delay duration out of range: ${numeric}ms (max ${MAX_DELAY_MS}ms)`);
    }
    return { durationMs: Math.round(numeric) };
  }

  throw new Error(`Invalid delay duration: "${resolved}"`);
}
