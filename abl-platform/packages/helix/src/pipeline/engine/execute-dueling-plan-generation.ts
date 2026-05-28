/**
 * Dueling-plan-generation orchestrator.
 *
 * Fans out two independent planners (Claude Opus via claude-code, GPT-5 via
 * openai-api) in parallel, classifies outcomes via Promise.allSettled, then
 * synthesizes a convergent Plan C through codex-cli with tool-use disabled.
 *
 * Supports checkpoint resume: if a prior run persisted planA/planB/planC on
 * the session, only the missing stages are re-executed.
 *
 * Error classes (ClaudeSdkError, OpenAiApiError, CodexCliError) are
 * instantiated HERE — never inside the executor .execute() methods, which
 * honor the error-as-data contract (ExecutorResult.error string).
 */
import * as fs from 'node:fs';
import * as path from 'node:path';

import { ClaudeSdkError, CodexCliError, OpenAiApiError } from '../../models/executor-errors.js';
import type { ModelRouter } from '../../models/model-router.js';
import type { SessionManager } from '../../session/session-manager.js';
import type {
  ExecutorResult,
  HelixConfig,
  JournalEntry,
  ModelAssignment,
  PlanArtifact,
  ProgressEvent,
  ProgressReporter,
  Session,
  StageDefinition,
  StageResult,
  StreamEvent,
} from '../../types.js';
import { accumulateProviderCost } from '../cost-accumulator.js';
import { buildDuelingSynthesisPrompt } from './dueling-plan-synthesis-prompt.js';
import { failStageDueToTimeout } from './fail-stage-due-to-timeout.js';
import {
  createStageStreamHandler,
  getRemainingTimeoutMs,
  makeResult,
  now,
} from '../stage-execution-shared.js';
import { buildStagePrompt } from '../stage-runner.js';
import { parsePlanCWithDivergenceOutput } from '../stage-output-parsers.js';

// ─── Public contract ─────────────────────────────────────────────

export interface DuelingPlanGenerationDeps {
  config: HelixConfig;
  modelRouter: ModelRouter;
  sessionManager: SessionManager;
  journal: (session: Session, entry: JournalEntry) => Promise<void>;
  emitProgress: (event: ProgressEvent) => void;
  reporter: ProgressReporter;
}

// ─── Constants ───────────────────────────────────────────────────

/**
 * Per-planner budget mirrors the existing plan-generation stage constants in
 * holistic-audit.ts (maxTurns: 25, maxBudgetUsd: 15) — exploration allowed
 * because planners need room to survey the codebase.
 */
const PLANNER_MAX_TURNS = 25;
const PLANNER_MAX_BUDGET_USD = 15;
const PLANNER_EFFICIENCY_BUDGET = {
  targetTurns: 20,
  explorationTurns: 5,
  hardTurnCap: 25,
};

/**
 * Codex synthesis budget — tight, no exploration, no tool use. The synthesis
 * is pure reasoning over two plan candidates. $10 is generous for a 12-turn
 * structured-output call with gpt-5.5.
 */
const SYNTHESIS_MAX_BUDGET_USD = 10;

// ─── Advisory tracking ───────────────────────────────────────────

/** Lightweight advisory record used for the dueling summary and error context. */
interface AdvisoryEntry {
  class: string;
  message: string;
}

function formatAdvisories(entries: AdvisoryEntry[]): string {
  return entries.map((e) => `[${e.class}] ${e.message}`).join('; ');
}

// ─── Orchestrator ────────────────────────────────────────────────

export async function executeDuelingPlanGeneration(
  session: Session,
  stage: StageDefinition,
  startTime: number,
  stageDeadlineAt: number | undefined,
  deps: DuelingPlanGenerationDeps,
): Promise<StageResult> {
  // Step 1 — Timeout guard
  const remainingMs = getRemainingTimeoutMs(stageDeadlineAt);
  if (remainingMs != null && remainingMs <= 0) {
    return failStageDueToTimeout(session, stage, '', [], [], startTime, 1, {}, deps);
  }

  // Step 2 — Checkpoint resolution
  const checkpoint = session.duelingPlanState ?? {};
  const advisories: AdvisoryEntry[] = [];

  if (checkpoint.planA && checkpoint.planB && checkpoint.planC) {
    return makeResult(
      stage,
      'passed',
      checkpoint.planC.output,
      [],
      [],
      startTime,
      checkpoint.planC.turnsUsed,
    );
  }

  let candidateA: PlanArtifact | undefined = checkpoint.planA;
  let candidateB: PlanArtifact | undefined = checkpoint.planB;

  // Determine which planners need to launch
  const descriptor = {
    launchA: !checkpoint.planA,
    launchB: !checkpoint.planB,
  };

  // If both planA and planB exist from checkpoint, skip to Step 5 (synthesis)
  if (!(candidateA && candidateB)) {
    // Step 3 — Parallel fan-out
    const plannerPrompt = buildStagePrompt(stage, session, '', 1);
    const onStreamA = createStageStreamHandler((event) => deps.emitProgress(event), stage.name);
    const onStreamB = createStageStreamHandler((event) => deps.emitProgress(event), stage.name);

    const plannerTimeoutMs = getRemainingTimeoutMs(stageDeadlineAt);

    const plannerAAssignment: ModelAssignment = {
      primary: {
        engine: 'claude-code',
        model: 'claude-opus-4-7',
        maxTurns: PLANNER_MAX_TURNS,
        maxBudgetUsd: PLANNER_MAX_BUDGET_USD,
        efficiencyBudget: PLANNER_EFFICIENCY_BUDGET,
      },
    };

    const plannerBAssignment: ModelAssignment = {
      primary: {
        engine: 'openai-api',
        model: deps.config.openaiModel ?? 'gpt-5',
        maxTurns: PLANNER_MAX_TURNS,
        maxBudgetUsd: PLANNER_MAX_BUDGET_USD,
        efficiencyBudget: PLANNER_EFFICIENCY_BUDGET,
      },
    };

    const sessionDir = path.join(deps.config.sessionDir, session.id);

    const makePlannerTask = (
      label: 'A' | 'B',
      assignment: ModelAssignment,
      onStream: (event: StreamEvent) => void,
    ): (() => Promise<PlanArtifact>) => {
      return async () => {
        const result: ExecutorResult = await deps.modelRouter.execute(
          plannerPrompt,
          assignment,
          undefined,
          onStream,
          undefined,
          plannerTimeoutMs,
        );
        accumulateProviderCost(session, result);

        if (result.error) {
          if (label === 'A') {
            throw new ClaudeSdkError('planner-error', result.error);
          } else {
            throw new OpenAiApiError('planner-error', undefined, result.error);
          }
        }

        const artifact: PlanArtifact = {
          output: result.output,
          costUsd: result.costUsd,
          engine: assignment.primary.engine,
          model: result.model,
          capturedAt: new Date().toISOString(),
          durationMs: result.durationMs,
          turnsUsed: result.turnsUsed,
        };

        session.duelingPlanState = {
          ...(session.duelingPlanState ?? {}),
          ...(label === 'A' ? { planA: artifact } : { planB: artifact }),
        };
        await deps.sessionManager.persist(session);

        const filename = label === 'A' ? 'plan-a.md' : 'plan-b.md';
        await fs.promises.writeFile(path.join(sessionDir, filename), artifact.output, 'utf8');

        return artifact;
      };
    };

    const tasks: Array<Promise<PlanArtifact>> = [];
    if (descriptor.launchA) {
      tasks.push(makePlannerTask('A', plannerAAssignment, onStreamA)());
    }
    if (descriptor.launchB) {
      tasks.push(makePlannerTask('B', plannerBAssignment, onStreamB)());
    }

    const settled = await Promise.allSettled(tasks);

    // Step 4 — Classify
    const fulfilled: Array<{ label: 'A' | 'B'; artifact: PlanArtifact }> = [];
    const rejected: Array<{ label: 'A' | 'B'; reason: string }> = [];

    // Map settled results back to their planner labels
    let taskIndex = 0;
    if (descriptor.launchA) {
      const entry = settled[taskIndex];
      if (entry.status === 'fulfilled') {
        fulfilled.push({ label: 'A', artifact: entry.value });
      } else {
        rejected.push({
          label: 'A',
          reason: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
      }
      taskIndex++;
    }
    if (descriptor.launchB) {
      const entry = settled[taskIndex];
      if (entry.status === 'fulfilled') {
        fulfilled.push({ label: 'B', artifact: entry.value });
      } else {
        rejected.push({
          label: 'B',
          reason: entry.reason instanceof Error ? entry.reason.message : String(entry.reason),
        });
      }
    }

    // Incorporate checkpoint artifacts not launched in this fan-out (resume path)
    if (!descriptor.launchA && checkpoint.planA) {
      fulfilled.push({ label: 'A', artifact: checkpoint.planA });
    }
    if (!descriptor.launchB && checkpoint.planB) {
      fulfilled.push({ label: 'B', artifact: checkpoint.planB });
    }

    const totalFulfilled = fulfilled.length;

    if (totalFulfilled === 0) {
      // Both planners failed — hard abort (FR-8). Skip Codex entirely.
      for (const r of rejected) {
        advisories.push({
          class: 'planner-failure',
          message: `Planner ${r.label} failed: ${r.reason}`,
        });
      }
      return makeResult(stage, 'failed', '', [], [], startTime, 1, formatAdvisories(advisories));
    }

    // Assign candidates from fulfilled results
    for (const f of fulfilled) {
      if (f.label === 'A') candidateA = f.artifact;
      if (f.label === 'B') candidateB = f.artifact;
    }

    if (totalFulfilled === 1 || rejected.length > 0) {
      // Solo-pass: mark the surviving artifact and record failure advisories
      const survivingLabel = fulfilled[0].label;
      const survivingArtifact = survivingLabel === 'A' ? candidateA : candidateB;
      if (survivingArtifact) {
        survivingArtifact.soloPass = true;
        session.duelingPlanState = {
          ...(session.duelingPlanState ?? {}),
          ...(survivingLabel === 'A' ? { planA: survivingArtifact } : { planB: survivingArtifact }),
        };
        await deps.sessionManager.persist(session);
      }

      for (const r of rejected) {
        advisories.push({
          class: 'planner-failure',
          message: `Planner ${r.label} failed: ${r.reason}`,
        });
      }
    }
  }

  // Step 5 — Synthesis prompt
  // featureContext derived from the session work item (title + description)
  const featureContext = [session.workItem.title, session.workItem.description]
    .filter(Boolean)
    .join('\n\n');

  // Guard: at least one candidate must be present for synthesis
  if (!candidateA && !candidateB) {
    return makeResult(
      stage,
      'failed',
      '',
      [],
      [],
      startTime,
      1,
      'No planner candidates available for synthesis',
    );
  }

  // On solo-pass where only B survived, pass B as candidateA for synthesis
  const synthesisCandidateA: PlanArtifact = (candidateA ?? candidateB)!;
  const synthesisCandidateB: PlanArtifact | undefined = candidateA ? candidateB : undefined;

  const synthesisPrompt = buildDuelingSynthesisPrompt({
    candidateA: synthesisCandidateA,
    candidateB: synthesisCandidateB,
    featureContext,
  });

  // Step 6 — Codex synthesis
  const onStreamSynthesis = createStageStreamHandler(
    (event) => deps.emitProgress(event),
    stage.name,
  );

  const synthesisTimeoutMs = getRemainingTimeoutMs(stageDeadlineAt);

  const synthesisSpec: ModelAssignment = {
    primary: {
      engine: 'codex-cli',
      model: 'gpt-5.5',
      maxTurns: 12,
      maxBudgetUsd: SYNTHESIS_MAX_BUDGET_USD,
      efficiencyBudget: {
        disableToolUse: true,
        explorationTurns: 0,
        targetTurns: 8,
        hardTurnCap: 12,
      },
    },
  };

  const codexResult = await deps.modelRouter.execute(
    synthesisPrompt,
    synthesisSpec,
    undefined,
    onStreamSynthesis,
    { id: 'plan-c-with-divergence' },
    synthesisTimeoutMs,
  );
  accumulateProviderCost(session, codexResult);

  if (codexResult.error) {
    const wrapped = new CodexCliError('codex-synthesis-failure', undefined, codexResult.error);
    advisories.push({
      class: 'codex-synthesis-failure',
      message: wrapped.message,
    });
    return makeResult(stage, 'failed', '', [], [], startTime, 1, formatAdvisories(advisories));
  }

  // Step 7 — Parse Plan C
  let parsed: { plan: string; divergenceNotes?: string };
  try {
    parsed = parsePlanCWithDivergenceOutput(codexResult.output);
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : String(e);
    advisories.push({ class: 'structured-output-parse-error', message });
    return makeResult(stage, 'failed', '', [], [], startTime, 1, formatAdvisories(advisories));
  }

  // Step 8 — Construct Plan C artifact + persist
  const planCArtifact: PlanArtifact = {
    output: parsed.plan,
    costUsd: codexResult.costUsd,
    engine: 'codex-cli',
    model: 'gpt-5.5',
    capturedAt: new Date().toISOString(),
    durationMs: codexResult.durationMs,
    turnsUsed: codexResult.turnsUsed,
  };

  session.duelingPlanState = {
    ...(session.duelingPlanState ?? {}),
    planC: planCArtifact,
    divergenceNotes: parsed.divergenceNotes,
  };
  await deps.sessionManager.persist(session);

  // Step 9 — Write plan-c.md + divergence-notes.md
  const sessionDir = path.join(deps.config.sessionDir, session.id);
  await fs.promises.writeFile(path.join(sessionDir, 'plan-c.md'), planCArtifact.output, 'utf8');
  await fs.promises.writeFile(
    path.join(sessionDir, 'divergence-notes.md'),
    parsed.divergenceNotes ?? '',
    'utf8',
  );

  // Step 10 — Journal entry
  // Divergence count heuristic: count lines starting with "- " in divergenceNotes
  const divergenceCount = parsed.divergenceNotes
    ? parsed.divergenceNotes.split('\n').filter((line) => /^\s*-\s/.test(line)).length
    : 0;

  const candA = synthesisCandidateA;
  const candB = synthesisCandidateB;
  const failedPlannerMsg =
    advisories.find((a) => a.class === 'planner-failure')?.message ?? 'unknown';

  const journalMessage = candB
    ? `Dueling plans: Candidate A (${candA.engine}/${candA.model}, $${candA.costUsd?.toFixed(4) ?? '0.0000'}), ` +
      `Candidate B (${candB.engine}/${candB.model}, $${candB.costUsd?.toFixed(4) ?? '0.0000'}), ` +
      `synthesized via codex-cli/gpt-5.5 ($${planCArtifact.costUsd?.toFixed(4) ?? '0.0000'}). Divergences: ${divergenceCount}.`
    : `Dueling plans: Candidate A only (${candA.engine}/${candA.model}, $${candA.costUsd?.toFixed(4) ?? '0.0000'}), ` +
      `Planner B failed: ${failedPlannerMsg}, ` +
      `synthesized via codex-cli/gpt-5.5 ($${planCArtifact.costUsd?.toFixed(4) ?? '0.0000'}).`;

  await deps.journal(session, {
    timestamp: now(),
    type: 'stage-complete',
    stage: stage.name,
    message: journalMessage,
  });

  // Step 11 — Return success
  const totalTurnsUsed = candA.turnsUsed + (candB?.turnsUsed ?? 0) + planCArtifact.turnsUsed;

  return makeResult(stage, 'passed', planCArtifact.output, [], [], startTime, totalTurnsUsed);
}
