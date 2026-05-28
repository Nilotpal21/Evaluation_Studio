/**
 * Execution Status Analyzer
 *
 * Inspects the live RuntimeSession to detect execution-level issues:
 * health errors, missing LLM client, and failed last execution.
 */

import { createLogger } from '@abl/compiler/platform';
import type { Analyzer, DiagnosticContext, DiagnosticFinding } from '../types.js';
import type { RuntimeSession, SessionHealthEntry } from '../../execution/types.js';

const log = createLogger('diag-execution-status');

export class ExecutionStatusAnalyzer implements Analyzer {
  name = 'execution-status';
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
      findings.push({
        analyzer: this.name,
        severity: 'info',
        code: 'SESSION_NOT_FOUND',
        title: 'Session not found in memory',
        detail: `Session ${sessionId} is not currently loaded in the runtime executor.`,
        suggestion:
          'The session may have been evicted or never created. Check the session ID and try again.',
        evidence: [{ type: 'config', label: 'sessionId', data: { sessionId } }],
      });
      return findings;
    }

    // Check session health for error-severity entries
    if (session.sessionHealth && session.sessionHealth.length > 0) {
      const errorEntries = session.sessionHealth.filter(
        (entry: SessionHealthEntry) => entry.severity === 'error',
      );
      for (const entry of errorEntries) {
        findings.push({
          analyzer: this.name,
          severity: 'error',
          code: 'SESSION_HEALTH_ERROR',
          title: `Session health error: ${entry.code}`,
          detail: entry.message,
          suggestion: `Address the ${entry.category} subsystem issue reported during session initialization.`,
          evidence: [
            {
              type: 'execution',
              label: `Health entry (${entry.category})`,
              data: {
                category: entry.category,
                code: entry.code,
                message: entry.message,
                timestamp: entry.timestamp,
              },
            },
          ],
        });
      }
    }

    // Check if session has an LLM client configured
    if (!session.llmClient) {
      findings.push({
        analyzer: this.name,
        severity: 'error',
        code: 'NO_LLM_CLIENT',
        title: 'No LLM client wired for session',
        detail:
          'The session does not have an LLM client configured. LLM-based reasoning and responses will fail.',
        suggestion:
          'Ensure a valid LLM credential is configured at the project or tenant level and that model resolution succeeds.',
        evidence: [
          {
            type: 'execution',
            label: 'LLM client status',
            data: { sessionId, llmClientPresent: false },
          },
        ],
      });
    }

    // Check if session is in a failed state (escalated or complete with escalation reason)
    if (session.isEscalated && session.escalationReason) {
      findings.push({
        analyzer: this.name,
        severity: 'error',
        code: 'LAST_EXECUTION_FAILED',
        title: 'Session escalated due to failure',
        detail: `The session was escalated: ${session.escalationReason}`,
        suggestion:
          'Review the escalation reason. This may indicate a tool failure, constraint violation, or unrecoverable error.',
        evidence: [
          {
            type: 'execution',
            label: 'Escalation details',
            data: {
              sessionId,
              isEscalated: true,
              escalationReason: session.escalationReason,
            },
          },
        ],
      });
    }

    return findings;
  }
}
