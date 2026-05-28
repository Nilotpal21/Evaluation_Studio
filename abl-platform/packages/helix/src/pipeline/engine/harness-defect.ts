/**
 * Harness-defect recorder.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Classifies whether a failed
 * deterministic quality-gate result represents a recurring harness defect
 * (gate timed out or the TS6307 compiler bug pattern appears in its feedback
 * sample) and, when it has been seen at least twice, records it on the
 * session via `upsertHarnessDefect` and emits a progress event describing
 * the recurrence. Session-state mutation and progress emission are
 * preserved — the caller supplies the emit callback.
 *
 *   - `maybeRecordDeterministicGateHarnessDefect(session, stageName, actor, gate, emitProgress)`
 *     returns the human-readable defect summary when the harness-defect
 *     threshold has been reached; returns `undefined` otherwise. The summary
 *     is intended to be merged into the gate's detail string at the call site.
 *
 * No I/O. Matches the original method's control flow exactly.
 */
import type { ProgressEvent, QualityGateResult, Session } from '../../types.js';
import { buildQualityGateFailureSignature, upsertHarnessDefect } from '../control-plane-state.js';
import { now } from '../stage-execution-shared.js';

export function maybeRecordDeterministicGateHarnessDefect(
  session: Session,
  stageName: string,
  actor: string,
  gate: QualityGateResult,
  emitProgress: (event: ProgressEvent) => void,
): string | undefined {
  const sample = [
    gate.feedback,
    ...gate.checks.map((check) => check.output?.trim() ?? '').filter(Boolean),
  ]
    .join('\n\n')
    .trim();

  if (!gate.timedOut && !/\bTS6307\b/i.test(sample)) {
    return undefined;
  }

  const defect = upsertHarnessDefect(session, {
    kind: 'quality-gate',
    stageName,
    actor,
    signature: buildQualityGateFailureSignature(actor, sample),
    sample,
  });

  if (defect.occurrences < 2) {
    return undefined;
  }

  const summary = `Known recurring harness defect (${defect.occurrences}x): ${defect.signature}`;
  emitProgress({
    type: 'stage-progress',
    timestamp: now(),
    stage: stageName,
    message: summary,
    details: {
      defectId: defect.id,
      actor,
    },
  });
  return summary;
}
