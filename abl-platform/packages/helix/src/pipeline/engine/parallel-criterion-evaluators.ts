/**
 * Parallel criterion evaluators.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Runs a scoped typecheck or lint
 * quality gate and returns the `ParallelCriterionEvaluation` payload consumed
 * by `precomputeParallelVerificationCriteria`. The typecheck variant also runs
 * the harness-defect recorder and applies the verification-bootstrap baseline
 * noise normalization; the lint variant is a straight gate-and-summarize.
 *
 *   - `evaluateTypecheckCriterion(workDir, params, emitProgress)` resolves the
 *     typecheck gate for `typecheckScopeEntries`, normalizes any baseline-noise
 *     matches into a passing gate with a merged detail string, stamps a
 *     harness-defect summary when applicable, and builds the `cachedCriterion`
 *     reuse-key entry on success.
 *   - `evaluateLintCriterion(workDir, params)` resolves the prettier lint gate
 *     for `scopeEntries` and builds the matching reuse-key entry on success.
 *
 * No engine state; `emitProgress` is supplied by the caller for the
 * harness-defect recorder. Matches the original `PipelineEngine` method
 * semantics exactly.
 */
import type {
  ExitCriterion,
  ProgressEvent,
  QualityGateResult,
  Session,
  SliceVerificationCriterionCheckpoint,
  StageDefinition,
} from '../../types.js';
import { runQualityGate } from '../quality-gate.js';
import { matchVerificationBootstrapBaseline } from '../verification-bootstrap.js';
import { now } from '../stage-execution-shared.js';
import { summarizeQualityGateEvidence } from './gate-evidence.js';
import { buildVerificationReuseKey } from './verification-reuse.js';
import { maybeRecordDeterministicGateHarnessDefect } from './harness-defect.js';

export interface ParallelCriterionEvaluation {
  gate: QualityGateResult;
  detail: string;
  checkpointDiffHash: string;
  cachedCriterion?: SliceVerificationCriterionCheckpoint;
}

export async function evaluateTypecheckCriterion(
  workDir: string,
  params: {
    session: Session;
    stage: StageDefinition;
    criterion: ExitCriterion;
    typecheckScopeEntries: string[];
    verificationDiffHash: string;
    typecheckVerificationDiffHash: string;
    typecheckCommand: string;
  },
  emitProgress: (event: ProgressEvent) => void,
): Promise<ParallelCriterionEvaluation> {
  const {
    session,
    stage,
    criterion,
    typecheckScopeEntries,
    verificationDiffHash,
    typecheckVerificationDiffHash,
    typecheckCommand,
  } = params;
  const gate = await runQualityGate(
    {
      name: 'TypeCheck',
      checks: [{ name: 'tsc', type: 'typecheck' }],
      passThreshold: 1.0,
      failAction: 'loop',
    },
    workDir,
    session,
    stage.name,
    { scopeEntries: typecheckScopeEntries },
  );
  const baselineNoise = gate.passed
    ? { matches: false, matchedSignatures: [] }
    : matchVerificationBootstrapBaseline(session.verificationBootstrap, 'typecheck', gate);
  const normalizedGate =
    baselineNoise.matches && !gate.passed
      ? {
          ...gate,
          passed: true,
          checks: gate.checks.map((check) => ({
            ...check,
            passed: true,
            output: [
              check.output,
              `Matched verification bootstrap baseline signature(s): ${baselineNoise.matchedSignatures.join(' | ')}`,
            ]
              .filter(Boolean)
              .join('\n\n'),
          })),
          feedback: [
            gate.feedback,
            `Matched verification bootstrap baseline signature(s): ${baselineNoise.matchedSignatures.join(' | ')}`,
          ]
            .filter(Boolean)
            .join('\n\n'),
        }
      : gate;
  const detail = summarizeQualityGateEvidence(normalizedGate);
  const harnessDefect = normalizedGate.passed
    ? undefined
    : maybeRecordDeterministicGateHarnessDefect(
        session,
        stage.name,
        criterion.id,
        normalizedGate,
        emitProgress,
      );
  const baselineDetail = baselineNoise.matches
    ? `Matched verification bootstrap baseline signature(s): ${baselineNoise.matchedSignatures.join(' | ')}`
    : undefined;
  const mergedDetail = [detail, baselineDetail, harnessDefect].filter(Boolean).join('. ');

  return {
    gate: normalizedGate,
    detail: mergedDetail,
    checkpointDiffHash: verificationDiffHash,
    cachedCriterion: normalizedGate.passed
      ? {
          criterionId: criterion.id,
          criterionType: criterion.type,
          reuseKey: buildVerificationReuseKey({
            criterionId: criterion.id,
            criterionType: criterion.type,
            diffHash: typecheckVerificationDiffHash,
            command: typecheckCommand,
            scopeEntries: typecheckScopeEntries,
          }),
          detail: [detail, baselineDetail].filter(Boolean).join('. '),
          qualityGate: normalizedGate,
          capturedAt: now(),
        }
      : undefined,
  };
}

export async function evaluateLintCriterion(
  workDir: string,
  params: {
    session: Session;
    stage: StageDefinition;
    criterion: ExitCriterion;
    scopeEntries: string[];
    verificationDiffHash: string;
    lintCommand: string;
  },
): Promise<ParallelCriterionEvaluation> {
  const { session, stage, criterion, scopeEntries, verificationDiffHash, lintCommand } = params;
  const gate = await runQualityGate(
    {
      name: 'Lint',
      checks: [{ name: 'prettier', type: 'lint' }],
      passThreshold: 1.0,
      failAction: 'loop',
    },
    workDir,
    session,
    stage.name,
    {
      scopeEntries,
    },
  );
  const detail = summarizeQualityGateEvidence(gate);

  return {
    gate,
    detail,
    checkpointDiffHash: verificationDiffHash,
    cachedCriterion: gate.passed
      ? {
          criterionId: criterion.id,
          criterionType: criterion.type,
          reuseKey: buildVerificationReuseKey({
            criterionId: criterion.id,
            criterionType: criterion.type,
            diffHash: verificationDiffHash,
            command: lintCommand,
            scopeEntries,
          }),
          detail,
          qualityGate: gate,
          capturedAt: now(),
        }
      : undefined,
  };
}
