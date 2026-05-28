/**
 * Stage timeout terminator.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Builds the `StageResult` that
 * represents a stage which exceeded its execution deadline — stamps a
 * `stage`-scoped timeout event, emits an error progress event, and writes a
 * matching journal entry before returning the failed result.
 *
 *   - `failStageDueToTimeout(session, stage, output, findings, decisions, startTime, iterations, options?, sideEffects)`
 *     appends a fresh `createTimeoutEvent(...)` to `options.timeoutEvents ?? []`,
 *     invokes `sideEffects.emitProgress` with the `error`-typed event,
 *     awaits `sideEffects.journal(session, entry)` with the same error
 *     message, and returns the `makeResult(...)` envelope carrying the merged
 *     quality gate, timeout events, and execution summary. Matches the
 *     original `PipelineEngine#failStageDueToTimeout` method semantics exactly.
 *
 * No engine state; both side-effect callbacks are supplied by the caller.
 * Used by `PipelineEngine` (7 call sites) and `SpecialStageExecutor`.
 */
import type {
  Decision,
  Finding,
  JournalEntry,
  ProgressEvent,
  QualityGateResult,
  Session,
  StageDefinition,
  StageExecutionSummary,
  StageResult,
  TimeoutEvent,
} from '../../types.js';
import { makeResult, now } from '../stage-execution-shared.js';
import { createTimeoutEvent } from './quality-gate-timeout.js';

export interface StageTimeoutSideEffects {
  emitProgress: (event: ProgressEvent) => void;
  journal: (session: Session, entry: JournalEntry) => Promise<void>;
}

export async function failStageDueToTimeout(
  session: Session,
  stage: StageDefinition,
  output: string,
  findings: Finding[],
  decisions: Decision[],
  startTime: number,
  iterations: number,
  options: {
    qualityGate?: QualityGateResult;
    timeoutEvents?: TimeoutEvent[];
    timeoutMs?: number;
    executionSummary?: StageExecutionSummary;
  } = {},
  sideEffects: StageTimeoutSideEffects,
): Promise<StageResult> {
  const error = `${stage.name} exceeded its execution deadline`;
  const timeoutEvents = [...(options.timeoutEvents ?? [])];
  timeoutEvents.push(
    createTimeoutEvent(
      'stage',
      stage.name,
      error,
      options.timeoutMs ?? stage.timeoutMs,
      Date.now() - startTime,
    ),
  );

  sideEffects.emitProgress({
    type: 'error',
    timestamp: now(),
    stage: stage.name,
    message: error,
  });

  await sideEffects.journal(session, {
    timestamp: now(),
    type: 'error',
    stage: stage.name,
    message: error,
  });

  return makeResult(
    stage,
    'failed',
    output,
    findings,
    decisions,
    startTime,
    iterations,
    error,
    undefined,
    {
      qualityGate: options.qualityGate,
      timeoutEvents,
      executionSummary: options.executionSummary,
    },
  );
}
