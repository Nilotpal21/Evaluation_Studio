import { createLogger } from '@abl/compiler/platform';
import type { WorkflowContextData } from '../context/step-context-schema.js';
import type { WorkflowStep } from '../handlers/step-dispatcher.js';
import { MAX_PARALLEL_BRANCHES } from '../constants.js';
import { StepErrorCode, WorkflowStepError } from '../errors/step-errors.js';

const log = createLogger('workflow-engine:dag-executor');

const DAG_SKIPPED_STEP_IDS = Symbol('workflowEngine.dagSkippedStepIds');

export type StepOutcome =
  | { status: 'completed'; activatedSuccessors: string[] }
  | { status: 'terminal_no_successors' }
  | { status: 'failed' }
  | { status: 'workflow_terminated'; result: unknown };

export function getDagSkippedStepIds(ctx: WorkflowContextData): Set<string> {
  const holder = ctx as WorkflowContextData & { [DAG_SKIPPED_STEP_IDS]?: Set<string> };
  if (!holder[DAG_SKIPPED_STEP_IDS]) {
    Object.defineProperty(holder, DAG_SKIPPED_STEP_IDS, {
      value: new Set<string>(),
      enumerable: false,
      configurable: false,
    });
  }
  return holder[DAG_SKIPPED_STEP_IDS]!;
}

export interface DagExecutorParams {
  stepIndex: Map<string, WorkflowStep>;
  inDegreeMap: Record<string, number>;
  rootStepIds: string[];
  executeStep: (step: WorkflowStep) => Promise<StepOutcome>;
  ctx: WorkflowContextData;
}

/** Thrown when a step signals workflow_terminated. Carries the final result. */
export class WorkflowTerminatedError extends Error {
  readonly result: unknown;
  constructor(result: unknown) {
    super('workflow_terminated');
    this.name = 'WorkflowTerminatedError';
    this.result = result;
  }
}

/**
 * Return ALL successor step IDs from a step across every edge type:
 * on_success, on_failure, on_reject, and condition branches.
 * Used by both notifyTerminal (to find non-activated successors) and
 * skipPropagate (to cascade the skip signal downstream).
 */
function getAllSuccessorIds(step: WorkflowStep): string[] {
  const all = new Set<string>();
  for (const id of step.onSuccessSteps ?? []) all.add(id);
  for (const id of step.onFailureSteps ?? []) all.add(id);
  for (const id of (step as { onRejectSteps?: string[] }).onRejectSteps ?? []) all.add(id);
  const cs = step as {
    thenSteps?: string[];
    elseSteps?: string[];
    conditions?: Array<{ targetSteps?: string[] }>;
  };
  for (const t of cs.thenSteps ?? []) all.add(t);
  for (const t of cs.elseSteps ?? []) all.add(t);
  for (const branch of cs.conditions ?? []) {
    for (const t of branch.targetSteps ?? []) all.add(t);
  }
  return [...all];
}

/**
 * Execute a workflow DAG in topological order, dispatching parallel branches
 * as their predecessors complete.
 *
 * Barrier model:
 *   terminalCount[id] counts every predecessor that has settled (arrived or signalled-skip).
 *   When count reaches the step's in-degree, evaluateAndDispatch fires.
 *
 * Skip-cascade model (mirrors processai EdgeStatusTracker):
 *   notifyTerminal does NOT immediately skip non-activated successors. It signals
 *   them via signalSkipped, which increments skippedCount + barrier. Only when ALL
 *   of the successor's predecessors have terminated does evaluateAndDispatch decide:
 *     • all predecessors signalled-skip → skipPropagate (cascade silently)
 *     • at least one predecessor arrived → dispatch via executeStep
 *   This means a merge node correctly waits for every incoming path before deciding.
 *
 * Required predecessor enforcement is intentionally NOT done here — it lives in
 * executeStepWithSuspension (workflow-handler.ts) so it can fail the node, persist
 * the error, and route via on_failure when configured.
 *
 * Throws WorkflowTerminatedError when a step signals workflow_terminated.
 */
export async function executeDag(params: DagExecutorParams): Promise<void> {
  const { stepIndex, inDegreeMap, rootStepIds, executeStep, ctx } = params;

  // Step A: build effective in-degree map.
  // If the caller supplied an empty map (legacy workflow), compute it on-the-fly
  // from the step graph and restrict to first root (preserves sequential order).
  const effectiveInDegreeMap: Record<string, number> = { ...inDegreeMap };
  let effectiveRootStepIds = rootStepIds;
  if (Object.keys(effectiveInDegreeMap).length === 0 && stepIndex.size > 0) {
    for (const step of stepIndex.values()) {
      if (!(step.id in effectiveInDegreeMap)) effectiveInDegreeMap[step.id] = 0;
      for (const sucId of getAllSuccessorIds(step)) {
        effectiveInDegreeMap[sucId] = (effectiveInDegreeMap[sucId] ?? 0) + 1;
      }
    }
    const roots = Object.entries(effectiveInDegreeMap)
      .filter(([, deg]) => deg === 0)
      .map(([id]) => id);
    effectiveRootStepIds = roots.slice(0, 1);
  }

  // Step B: initialize state for this execution.
  const terminalCount = new Map<string, number>();
  // skippedCount tracks predecessors that signalled-skip (vs those that arrived).
  // evaluateAndDispatch uses this to decide skip-cascade vs dispatch.
  const skippedCount = new Map<string, number>();
  const settled = new Set<string>();
  let firstError: Error | undefined;
  const dispatched: Promise<void>[] = [];
  let prev = 0;

  log.info('dag-executor: starting', { rootStepIds: effectiveRootStepIds });

  // Step D (part 1): settle a step as skipped and signal all its successors.
  // Called only from evaluateAndDispatch (skip-cascade) — NOT from notifyTerminal.
  // notifyTerminal calls signalSkipped instead, deferring the skip/dispatch decision.
  function skipPropagate(stepId: string): void {
    if (settled.has(stepId)) return;
    settled.add(stepId);
    const step = stepIndex.get(stepId);
    getDagSkippedStepIds(ctx).add(stepId);
    log.debug('dag-executor: skip propagating', { stepId });
    const allSuccessors = step ? getAllSuccessorIds(step) : [];
    for (const sucId of allSuccessors) {
      signalSkipped(sucId);
    }
  }

  // Step D (part 1b): signal that a predecessor was skipped without immediately
  // settling the successor. The successor waits for all its predecessors before
  // evaluateAndDispatch decides what to do.
  function signalSkipped(sucId: string): void {
    skippedCount.set(sucId, (skippedCount.get(sucId) ?? 0) + 1);
    incrementBarrier(sucId);
  }

  // Step D (part 2): increment terminal count for a successor. When count reaches
  // the step's in-degree, evaluate whether to dispatch or skip it.
  function incrementBarrier(sucId: string): void {
    const count = (terminalCount.get(sucId) ?? 0) + 1;
    terminalCount.set(sucId, count);
    const needed = effectiveInDegreeMap[sucId] ?? 1;
    if (count === needed) {
      evaluateAndDispatch(sucId);
    }
  }

  // Step E: all predecessors have terminated — decide whether to skip or dispatch.
  function evaluateAndDispatch(stepId: string): void {
    if (settled.has(stepId)) return;
    const step = stepIndex.get(stepId);
    if (!step) return;

    const inDeg = effectiveInDegreeMap[stepId] ?? 0;
    const skipped = skippedCount.get(stepId) ?? 0;

    // Skip-cascade: if the node has predecessors and ALL of them signalled-skip
    // (no edge actually arrived), skip this node and propagate downstream.
    // Mirrors processai EdgeStatusTracker: a node only executes when at least
    // one inbound edge ARRIVED.
    if (inDeg > 0 && skipped >= inDeg) {
      log.debug('dag-executor: all predecessors skipped, cascading skip', { stepId });
      skipPropagate(stepId);
      return;
    }

    // Fan-out cap: guard against runaway branching from this step's outgoing edges.
    const allSuccessors = getAllSuccessorIds(step);
    if (allSuccessors.length > MAX_PARALLEL_BRANCHES) {
      log.warn('dag-executor: fan-out cap exceeded', { stepId, count: allSuccessors.length });
      if (!firstError) {
        firstError = new WorkflowStepError(StepErrorCode.STEP_FAILED, 'MAX_FAN_OUT_EXCEEDED');
      }
      return;
    }

    // At least one predecessor arrived — dispatch the step.
    // Required predecessor validation happens inside executeStep (executeStepWithSuspension)
    // so it can fail the node, persist the error, and route via on_failure if configured.
    log.info('dag-executor: dispatching', { stepId });
    trackDispatch(runStep(step));
  }

  // Step C: record that stepId completed with the given activated successors.
  // Non-activated successors receive a signalSkipped (not an immediate skipPropagate)
  // so they wait for all their other predecessors before making a decision.
  function notifyTerminal(stepId: string, activatedSuccessors: string[]): void {
    if (settled.has(stepId)) return;
    settled.add(stepId);
    log.info('dag-executor: step terminal', { stepId, activatedSuccessors });

    const step = stepIndex.get(stepId);
    const allSuccessors = step ? getAllSuccessorIds(step) : [];

    // Non-activated branches: signal skip so the successor's barrier counts them
    // but defers the skip/dispatch decision until all its predecessors settle.
    const activatedSet = new Set(activatedSuccessors);
    for (const sucId of allSuccessors) {
      if (!activatedSet.has(sucId)) signalSkipped(sucId);
    }

    // Activated successors: increment their barrier as an "arrived" signal.
    for (const sucId of activatedSuccessors) {
      incrementBarrier(sucId);
    }
  }

  // Step F: execute a single step and process its outcome.
  async function runStep(step: WorkflowStep): Promise<void> {
    if (settled.has(step.id)) return;
    const outcome = await executeStep(step);
    switch (outcome.status) {
      case 'completed':
        notifyTerminal(step.id, outcome.activatedSuccessors);
        break;
      case 'terminal_no_successors':
        settled.add(step.id);
        break;
      case 'failed':
        // A normal branch-step failure is nonfatal for the DAG. The failed
        // node has already been persisted/published by the workflow handler;
        // here we only signal that none of its outgoing paths arrived.
        notifyTerminal(step.id, []);
        break;
      case 'workflow_terminated':
        throw new WorkflowTerminatedError(outcome.result);
    }
  }

  // Wrap dispatched promises so Promise.all in the drain-wait loop never rejects.
  // Errors are recorded in firstError and re-thrown after all waves drain.
  function trackDispatch(p: Promise<void>): void {
    dispatched.push(
      p.then(undefined, (err: unknown) => {
        if (!firstError) {
          firstError = err instanceof Error ? err : new Error(String(err));
        }
      }),
    );
  }

  // Dispatch root steps directly (no predecessors to wait for).
  for (const rootId of effectiveRootStepIds) {
    evaluateAndDispatch(rootId);
  }

  // Drain-wait: evaluateAndDispatch pushes new promises dynamically as barriers
  // satisfy. Re-await in waves until no new promises are added.
  while (dispatched.length > prev) {
    const slice = dispatched.slice(prev);
    prev = dispatched.length;
    await Promise.all(slice);
  }

  if (firstError) throw firstError;
}
