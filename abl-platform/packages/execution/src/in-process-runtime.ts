import type {
  ExecutionRuntime,
  ExecutionPlan,
  ExecutionUnit,
  ExecutionUnitResult,
} from './types.js';

/**
 * In-process execution runtime using Promise.allSettled for parallel execution.
 *
 * Phase 1 implementation — executes all units concurrently within the
 * current Node.js process. Phase 3 will introduce RestateExecutionRuntime
 * for durable, distributed execution.
 */
export class InProcessExecutionRuntime implements ExecutionRuntime {
  async execute(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    parentSignal: AbortSignal,
  ): Promise<ExecutionUnitResult[]> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), plan.timeout);

    // Propagate parent abort to child controller
    const onParentAbort = () => controller.abort();
    parentSignal.addEventListener('abort', onParentAbort, { once: true });

    try {
      if (plan.type === 'single' && plan.units.length === 1) {
        const result = await this.executeWithUnitTimeout(plan.units[0], executeUnit, controller);
        return [result];
      }

      if (plan.type === 'sequential') {
        return await this.executeSequential(plan, executeUnit, controller);
      }

      // Default: parallel execution
      return await this.executeParallel(plan, executeUnit, controller);
    } finally {
      clearTimeout(timeout);
      parentSignal.removeEventListener('abort', onParentAbort);
    }
  }

  /**
   * Execute a single unit with its own per-unit timeout.
   * Returns a timeout result if the unit exceeds its timeout.
   */
  private async executeWithUnitTimeout(
    unit: ExecutionUnit,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    parentController: AbortController,
  ): Promise<ExecutionUnitResult> {
    const unitController = new AbortController();
    const unitTimeout = setTimeout(() => unitController.abort(), unit.timeout);

    // Propagate parent abort to unit controller
    const onParentAbort = () => unitController.abort();
    parentController.signal.addEventListener('abort', onParentAbort, { once: true });

    try {
      const result = await executeUnit(unit, unitController.signal);
      return result;
    } catch (error) {
      if (unitController.signal.aborted && !parentController.signal.aborted) {
        return {
          agentName: unit.agentName,
          status: 'timeout',
          error: `Unit timed out after ${unit.timeout}ms`,
          durationMs: unit.timeout,
        };
      }
      if (parentController.signal.aborted) {
        return {
          agentName: unit.agentName,
          status: 'cancelled',
          durationMs: 0,
        };
      }
      return {
        agentName: unit.agentName,
        status: 'error',
        error: error instanceof Error ? error.message : String(error),
        durationMs: 0,
      };
    } finally {
      clearTimeout(unitTimeout);
      parentController.signal.removeEventListener('abort', onParentAbort);
    }
  }

  private async executeParallel(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    controller: AbortController,
  ): Promise<ExecutionUnitResult[]> {
    const results: ExecutionUnitResult[] = new Array(plan.units.length);

    await Promise.allSettled(
      plan.units.map(async (unit, i) => {
        // Per-unit AbortController so we can distinguish timeout vs cancellation
        const unitController = new AbortController();
        const timeoutId = setTimeout(() => unitController.abort('timeout'), unit.timeout);

        // Propagate plan-level abort to the unit (carries the plan abort reason)
        const onPlanAbort = () => unitController.abort(controller.signal.reason);
        controller.signal.addEventListener('abort', onPlanAbort, { once: true });

        try {
          const result = await executeUnit(unit, unitController.signal);
          results[i] = result;

          // Abort siblings immediately on first error when strategy demands it
          if (result.status === 'error' && plan.onPartialFailure === 'cancel-remaining') {
            controller.abort('cancel-remaining');
          }
        } catch (error) {
          // Distinguish timeout / cancellation / plain error
          let status: ExecutionUnitResult['status'] = 'error';
          if (unitController.signal.aborted) {
            status = unitController.signal.reason === 'timeout' ? 'timeout' : 'cancelled';
          }

          results[i] = {
            agentName: unit.agentName,
            status,
            error:
              status === 'error'
                ? error instanceof Error
                  ? error.message
                  : String(error)
                : undefined,
            durationMs: 0,
          };

          // Abort siblings on first error when strategy demands it
          if (status === 'error' && plan.onPartialFailure === 'cancel-remaining') {
            controller.abort('cancel-remaining');
          }
        } finally {
          clearTimeout(timeoutId);
          controller.signal.removeEventListener('abort', onPlanAbort);
        }
      }),
    );

    return results;
  }

  private async executeSequential(
    plan: ExecutionPlan,
    executeUnit: (unit: ExecutionUnit, signal: AbortSignal) => Promise<ExecutionUnitResult>,
    controller: AbortController,
  ): Promise<ExecutionUnitResult[]> {
    const results: ExecutionUnitResult[] = [];

    for (const unit of plan.units) {
      if (controller.signal.aborted) {
        break;
      }

      try {
        const result = await executeUnit(unit, controller.signal);
        results.push(result);

        if (result.status === 'error' && plan.onPartialFailure === 'fail-all') {
          controller.abort();
          break;
        }
      } catch (error) {
        results.push({
          agentName: unit.agentName,
          status: 'error',
          error: error instanceof Error ? error.message : String(error),
          durationMs: 0,
        });

        if (plan.onPartialFailure === 'fail-all') {
          controller.abort();
          break;
        }
      }
    }

    return results;
  }
}
