/**
 * Flow State Analyzer
 *
 * Inspects the live session's flow execution state to detect:
 * - Stalled steps (no activity for too long)
 * - Excessive backtracking (possible infinite loops)
 */

import { createLogger } from '@abl/compiler/platform';
import type { Analyzer, DiagnosticContext, DiagnosticFinding } from '../types.js';
import type { RuntimeSession } from '../../execution/types.js';

const log = createLogger('diag-flow-state');

/** Threshold in milliseconds for considering a step stalled (5 minutes) */
const STALL_THRESHOLD_MS = 5 * 60 * 1000;

/** Maximum backtrack count before flagging a potential loop */
const MAX_BACKTRACK_COUNT = 5;

export class FlowStateAnalyzer implements Analyzer {
  name = 'flow-state';
  category = 'execution' as const;

  async analyze(context: DiagnosticContext): Promise<DiagnosticFinding[]> {
    const findings: DiagnosticFinding[] = [];
    const { sessionId } = context;

    if (!sessionId) {
      return findings;
    }

    let session: RuntimeSession | undefined;
    try {
      const { getRuntimeExecutor } = await import('../../runtime-executor.js');
      session = getRuntimeExecutor()?.getSession(sessionId);
    } catch (err) {
      log.warn('Failed to access runtime executor', {
        error: err instanceof Error ? err.message : String(err),
      });
      return findings;
    }

    if (!session) {
      return findings;
    }

    // Only analyze sessions with flow-based execution
    if (!session.agentIR?.flow || !session.currentFlowStep) {
      return findings;
    }

    // Check for stalled step — no activity for too long
    const now = Date.now();
    const lastActivity = session.lastActivityAt?.getTime?.() ?? now;
    const idleMs = now - lastActivity;

    if (idleMs > STALL_THRESHOLD_MS) {
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        code: 'FLOW_STEP_STALLED',
        title: `Flow step "${session.currentFlowStep}" appears stalled`,
        detail: `The session has been on step "${session.currentFlowStep}" with no activity for ${Math.round(idleMs / 1000)}s (threshold: ${STALL_THRESHOLD_MS / 1000}s).`,
        suggestion:
          'The user may have abandoned the session, or the step may be waiting for input that was never provided. Check if the step requires user input or an external callback.',
        evidence: [
          {
            type: 'execution',
            label: 'Flow state',
            data: {
              sessionId,
              currentStep: session.currentFlowStep,
              idleMs,
              lastActivityAt: session.lastActivityAt?.toISOString?.() ?? 'unknown',
              waitingForInput: session.waitingForInput ?? [],
            },
          },
        ],
      });
    }

    // Check for excessive backtracking — possible infinite loop
    if (session.backtrackCounts) {
      for (const [stepName, count] of Object.entries(session.backtrackCounts)) {
        if (count > MAX_BACKTRACK_COUNT) {
          findings.push({
            analyzer: this.name,
            severity: 'error',
            code: 'FLOW_STEP_LOOP',
            title: `Excessive backtracking on step "${stepName}"`,
            detail: `Step "${stepName}" has been backtracked to ${count} times, exceeding the threshold of ${MAX_BACKTRACK_COUNT}. This may indicate an infinite loop between constraint violations and retries.`,
            suggestion:
              'Review the constraints on this step. Ensure that the constraint condition can actually be satisfied by the gathered data. Consider adding a max_retries or escalation fallback.',
            evidence: [
              {
                type: 'execution',
                label: 'Backtrack counts',
                data: {
                  sessionId,
                  stepName,
                  backtrackCount: count,
                  threshold: MAX_BACKTRACK_COUNT,
                  allCounts: session.backtrackCounts,
                },
              },
            ],
          });
        }
      }
    }

    return findings;
  }
}
