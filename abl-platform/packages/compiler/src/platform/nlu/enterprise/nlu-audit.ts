/**
 * NLU Audit Logger
 *
 * Pipeline hook that logs NLU predictions for compliance and debugging.
 * Non-blocking (fire-and-forget with catch).
 */

import type { NLUContext, NLUTask } from '../types.js';
import type { NLUConfig } from '../config.js';
import type { NLUAuditPort, NLUAuditEvent } from './interfaces.js';
import { createLogger } from '../../logger.js';

const log = createLogger('nlu-audit');

/**
 * Create an afterExecute hook that logs NLU predictions to an audit port.
 */
export function createAuditHook(
  config: NLUConfig,
  auditPort: NLUAuditPort,
  tenantId: string,
  configVersion?: string,
): (ctx: NLUContext, task: NLUTask, result: unknown, latencyMs: number) => Promise<void> {
  if (!config.audit.enabled || !config.audit.logPredictions) {
    return async () => {};
  }

  return async (
    ctx: NLUContext,
    task: NLUTask,
    result: unknown,
    latencyMs: number,
  ): Promise<void> => {
    const r = result as Record<string, unknown>;

    const event: NLUAuditEvent = {
      timestamp: new Date(),
      tenantId,
      task,
      layer: (r.source as string) || 'unknown',
      model: 'unknown',
      input: ctx.userMessage,
      prediction: result,
      confidence: typeof r.confidence === 'number' ? r.confidence : 0,
      latencyMs,
      configVersion,
    };

    // Fire-and-forget — never block the pipeline
    auditPort.logPrediction(event).catch((err) =>
      log.warn('NLU audit log failed', {
        task,
        tenantId,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  };
}
