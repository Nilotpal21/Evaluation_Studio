/**
 * Flow Step Traversal Executor
 *
 * Pure function that resolves the next step in a flow given the current step
 * and flow definition. Handles THEN transitions, GOTO (via THEN targets),
 * COMPLETE detection, loop detection, and terminal step identification.
 *
 * This is a pure function of (FlowConfig, stepName, visitedSteps) — no side effects.
 * The runtime is responsible for acting on the result (setting session.currentFlowStep,
 * emitting traces, handling GATHER pauses, etc.).
 */

import type { FlowConfig, FlowStep } from '../../ir/schema.js';

// =============================================================================
// TYPES
// =============================================================================

/** Result of resolving the next step in a flow */
export interface FlowStepResolution {
  /** The next step name (undefined if terminal) */
  nextStep: string | undefined;
  /** Whether the current step has no THEN (terminal) */
  isTerminal: boolean;
  /** Whether the next step was already visited (loop-back) */
  loopDetected: boolean;
  /** Whether the next step is COMPLETE */
  isComplete: boolean;
  /** Source of the THEN target: 'step', 'on_success', 'on_failure', 'branch' */
  source: 'step' | 'on_success' | 'on_failure' | 'branch';
}

/** Options for resolving the next step */
export interface FlowResolveOptions {
  /** Whether the CALL succeeded (for on_success/on_failure branching) */
  callSuccess?: boolean;
  /** Condition evaluator for branch conditions */
  evaluateCondition?: (condition: string, context: Record<string, unknown>) => boolean;
  /** Context values for evaluating branch conditions */
  context?: Record<string, unknown>;
}

// =============================================================================
// FLOW EXECUTOR
// =============================================================================

export class FlowExecutor {
  /**
   * Resolve the next step from the current step in a flow definition.
   *
   * Reads the step's `then`, `on_success`, `on_failure`, and branch conditions
   * to determine where the flow should go next. Does NOT execute any side effects.
   *
   * @param currentStepName - Name of the current step
   * @param flowDef - The flow configuration from AgentIR
   * @param visitedSteps - Set of steps already visited in this chain (for loop detection)
   * @param options - Optional: callSuccess, evaluateCondition, context
   */
  resolveNextStep(
    currentStepName: string,
    flowDef: FlowConfig,
    visitedSteps?: Set<string>,
    options?: FlowResolveOptions,
  ): FlowStepResolution {
    // Handle COMPLETE as a step name
    if (currentStepName === 'COMPLETE' || currentStepName.toLowerCase() === 'complete') {
      return {
        nextStep: undefined,
        isTerminal: true,
        loopDetected: false,
        isComplete: true,
        source: 'step',
      };
    }

    const step = flowDef.definitions[currentStepName];
    if (!step) {
      return {
        nextStep: undefined,
        isTerminal: true,
        loopDetected: false,
        isComplete: false,
        source: 'step',
      };
    }

    const nextStep = this.extractNextStep(step, options);
    const visited = visitedSteps ?? new Set<string>();

    if (nextStep === undefined) {
      // No THEN — terminal step
      return {
        nextStep: undefined,
        isTerminal: true,
        loopDetected: false,
        isComplete: false,
        source: this.determineSource(step, options),
      };
    }

    const isComplete = nextStep === 'COMPLETE' || nextStep.toLowerCase() === 'complete';
    const isSelfLoop = nextStep === currentStepName;
    const loopDetected = isSelfLoop || visited.has(nextStep);

    return {
      nextStep,
      isTerminal: false,
      loopDetected,
      isComplete,
      source: this.determineSource(step, options),
    };
  }

  /**
   * Determine the entry point for a flow.
   * Returns the explicit entry_point or the first step in the steps array.
   */
  resolveEntryPoint(flowDef: FlowConfig): string | undefined {
    return flowDef.entry_point ?? flowDef.steps[0];
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  private extractNextStep(step: FlowStep, options?: FlowResolveOptions): string | undefined {
    // CALL steps with ON_SUCCESS / ON_FAILURE branching
    if (step.call && (step.on_success || step.on_failure)) {
      const block = options?.callSuccess ? step.on_success : step.on_failure;
      if (!block) return step.then;

      // Conditional branches
      if (block.branches && block.branches.length > 0) {
        const evaluate = options?.evaluateCondition;
        const ctx = options?.context ?? {};

        for (const branch of block.branches) {
          if (!branch.condition) {
            // ELSE branch — always matches
            return branch.then;
          }
          if (evaluate && evaluate(branch.condition, ctx)) {
            return branch.then;
          }
        }
        // No branch matched — fall through to block.then or step.then
        return block.then ?? step.then;
      }

      // Simple form: single respond + then
      return block.then ?? step.then;
    }

    // Default: step.then
    return step.then;
  }

  private determineSource(
    step: FlowStep,
    options?: FlowResolveOptions,
  ): FlowStepResolution['source'] {
    if (step.call && (step.on_success || step.on_failure)) {
      const block = options?.callSuccess ? step.on_success : step.on_failure;
      if (block?.branches && block.branches.length > 0) {
        return 'branch';
      }
      return options?.callSuccess ? 'on_success' : 'on_failure';
    }
    return 'step';
  }
}
