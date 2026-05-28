/**
 * Reproduction artifact enforcer.
 *
 * Extracted verbatim from `pipeline-engine.ts`. Validates that a `reproduce`
 * stage produced structured `parseReproductionOutput(...)` with a valid,
 * scope-allowed test file, and that the declared test file was actually
 * modified during the stage — either relative to the pre-stage snapshot
 * (when present) or in the current workspace. Every failure path journals
 * and emits an `error` progress event; the success path journals and emits
 * a `stage-progress` confirmation.
 *
 *   - `enforceReproductionArtifact(workDir, session, stage, output, reproductionOutput, scopedTestTargets, scopedTestSnapshots, sideEffects)`
 *     returns `{ ok: true }` when the declared test file exists, is a test path,
 *     sits inside the scoped targets when a non-empty scope was declared, and
 *     shows changes since the snapshot (or ongoing modification). Returns
 *     `{ ok: false, reason }` otherwise. Matches the original
 *     `PipelineEngine#enforceReproductionArtifact` semantics exactly.
 *
 * No engine state; both side-effect callbacks are supplied by the caller.
 * Used by `PipelineEngine` (2 call sites).
 */
import type { JournalEntry, ProgressEvent, Session, StageDefinition } from '../../types.js';
import { now } from '../stage-execution-shared.js';
import { parseReproductionOutput } from '../stage-output-parsers.js';
import {
  findModifiedWorkspacePaths,
  hasWorkspacePathChangedSinceSnapshot,
  isTestFilePath,
  isWorkspacePathModified,
  scopeEntryToWorkspaceTarget,
  type WorkspaceFileSnapshot,
} from '../workspace-status.js';

export interface StageSideEffects {
  emitProgress: (event: ProgressEvent) => void;
  journal: (session: Session, entry: JournalEntry) => Promise<void>;
}

export async function enforceReproductionArtifact(
  workDir: string,
  session: Session,
  stage: StageDefinition,
  output: string,
  reproductionOutput: ReturnType<typeof parseReproductionOutput>,
  scopedTestTargets: string[],
  scopedTestSnapshots: Map<string, WorkspaceFileSnapshot>,
  sideEffects: StageSideEffects,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  if (!reproductionOutput) {
    const reason =
      'Reproduce stage must return structured reproduction output with a non-empty `testFile`.';
    await sideEffects.journal(session, {
      timestamp: now(),
      type: 'error',
      stage: stage.name,
      message: reason,
    });
    sideEffects.emitProgress({
      type: 'error',
      timestamp: now(),
      stage: stage.name,
      message: reason,
    });
    return { ok: false, reason };
  }

  const testFile = reproductionOutput.testFile.trim();
  if (!isTestFilePath(testFile)) {
    const fallbackTestFile = await findChangedScopedReproductionTest(
      workDir,
      session,
      scopedTestTargets,
      scopedTestSnapshots,
    );
    if (fallbackTestFile) {
      await acceptRecoveredReproductionTest(
        session,
        stage,
        reproductionOutput,
        testFile,
        fallbackTestFile,
        sideEffects,
      );
      return { ok: true };
    }

    const reason = `Reproduce stage declared an invalid test file: ${testFile}`;
    await sideEffects.journal(session, {
      timestamp: now(),
      type: 'error',
      stage: stage.name,
      message: reason,
    });
    sideEffects.emitProgress({
      type: 'error',
      timestamp: now(),
      stage: stage.name,
      message: reason,
    });
    return { ok: false, reason };
  }

  if (scopedTestTargets.length > 0 && !scopedTestTargets.includes(testFile)) {
    const fallbackTestFile = await findChangedScopedReproductionTest(
      workDir,
      session,
      scopedTestTargets,
      scopedTestSnapshots,
    );
    if (fallbackTestFile) {
      await acceptRecoveredReproductionTest(
        session,
        stage,
        reproductionOutput,
        testFile,
        fallbackTestFile,
        sideEffects,
      );
      return { ok: true };
    }

    const reason = `Reproduce stage must modify one of the scoped test files: ${scopedTestTargets.join(', ')}`;
    await sideEffects.journal(session, {
      timestamp: now(),
      type: 'error',
      stage: stage.name,
      message: reason,
    });
    sideEffects.emitProgress({
      type: 'error',
      timestamp: now(),
      stage: stage.name,
      message: reason,
    });
    return { ok: false, reason };
  }

  const changedSinceSnapshot = scopedTestSnapshots.has(testFile)
    ? await hasWorkspacePathChangedSinceSnapshot(
        workDir,
        testFile,
        scopedTestSnapshots.get(testFile),
      )
    : await isWorkspacePathModified(workDir, testFile);

  if (!changedSinceSnapshot) {
    const fallbackTestFile = await findChangedScopedReproductionTest(
      workDir,
      session,
      scopedTestTargets,
      scopedTestSnapshots,
    );
    if (fallbackTestFile) {
      await acceptRecoveredReproductionTest(
        session,
        stage,
        reproductionOutput,
        testFile,
        fallbackTestFile,
        sideEffects,
      );
      return { ok: true };
    }

    const reason = `Declared reproduction test file was not modified during the stage: ${testFile}`;
    await sideEffects.journal(session, {
      timestamp: now(),
      type: 'error',
      stage: stage.name,
      message: reason,
      details: {
        testFile,
        declaredSummary: reproductionOutput.summary,
        reproductionSteps: reproductionOutput.reproductionSteps,
        output,
      },
    });
    sideEffects.emitProgress({
      type: 'error',
      timestamp: now(),
      stage: stage.name,
      message: reason,
    });
    return { ok: false, reason };
  }

  await sideEffects.journal(session, {
    timestamp: now(),
    type: 'progress',
    stage: stage.name,
    message: `Verified reproduction test artifact: ${testFile}`,
  });
  sideEffects.emitProgress({
    type: 'stage-progress',
    timestamp: now(),
    stage: stage.name,
    message: `Verified reproduction test artifact: ${testFile}`,
  });

  return { ok: true };
}

async function acceptRecoveredReproductionTest(
  session: Session,
  stage: StageDefinition,
  reproductionOutput: NonNullable<ReturnType<typeof parseReproductionOutput>>,
  declaredTestFile: string,
  recoveredTestFile: string,
  sideEffects: StageSideEffects,
): Promise<void> {
  reproductionOutput.testFile = recoveredTestFile;
  await sideEffects.journal(session, {
    timestamp: now(),
    type: 'progress',
    stage: stage.name,
    message: `Verified reproduction test artifact: ${recoveredTestFile}`,
    details: {
      declaredTestFile,
      recoveredTestFile,
    },
  });
  sideEffects.emitProgress({
    type: 'stage-progress',
    timestamp: now(),
    stage: stage.name,
    message: `Verified reproduction test artifact: ${recoveredTestFile}`,
  });
}

async function findChangedScopedReproductionTest(
  workDir: string,
  session: Session,
  scopedTestTargets: string[],
  scopedTestSnapshots: Map<string, WorkspaceFileSnapshot>,
): Promise<string | null> {
  const explicitTargets = scopedTestTargets.filter(isTestFilePath);
  const scopeTargets =
    explicitTargets.length > 0
      ? explicitTargets
      : [...new Set(session.workItem.scope.map(scopeEntryToWorkspaceTarget))];

  if (scopeTargets.length === 0) {
    return null;
  }

  const modifiedTests = (await findModifiedWorkspacePaths(workDir, scopeTargets)).filter(
    isTestFilePath,
  );
  const changedTests: string[] = [];

  for (const modifiedTest of modifiedTests) {
    const changed = scopedTestSnapshots.has(modifiedTest)
      ? await hasWorkspacePathChangedSinceSnapshot(
          workDir,
          modifiedTest,
          scopedTestSnapshots.get(modifiedTest),
        )
      : await isWorkspacePathModified(workDir, modifiedTest);
    if (changed) {
      changedTests.push(modifiedTest);
    }
  }

  return changedTests.length === 1 ? (changedTests[0] ?? null) : null;
}
