/**
 * Empty Response Analyzer
 *
 * Investigates why a session may produce empty or blank responses.
 * Checks LLM wiring failures, missing reasoning zones, and other
 * behavioral indicators from session health and agent IR.
 */

import { createLogger } from '@abl/compiler/platform';
import type { Analyzer, DiagnosticContext, DiagnosticFinding } from '../types.js';
import type { RuntimeSession, SessionHealthEntry } from '../../execution/types.js';

const log = createLogger('diag-empty-response');

export class EmptyResponseAnalyzer implements Analyzer {
  name = 'empty-response';
  category = 'behavioral' as const;

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

    // Check session health for LLM_WIRING_FAILED
    const llmWiringFailed = session.sessionHealth?.some(
      (entry: SessionHealthEntry) => entry.code === 'LLM_WIRING_FAILED',
    );

    if (llmWiringFailed) {
      const wiringEntry = session.sessionHealth?.find(
        (entry: SessionHealthEntry) => entry.code === 'LLM_WIRING_FAILED',
      );
      findings.push({
        analyzer: this.name,
        severity: 'error',
        code: 'EMPTY_RESPONSE_LLM_FAILED',
        title: 'Empty responses caused by LLM wiring failure',
        detail:
          'The LLM client failed to initialize during session setup. All LLM-dependent responses will be empty.',
        suggestion:
          'Check LLM credentials and model configuration. Ensure the configured provider is reachable.',
        evidence: [
          {
            type: 'execution',
            label: 'LLM wiring failure',
            data: {
              sessionId,
              code: wiringEntry?.code ?? 'LLM_WIRING_FAILED',
              message: wiringEntry?.message ?? 'Unknown',
            },
          },
        ],
      });
      return findings;
    }

    // Check if agent has all reasoning disabled (no reasoning zones in flow steps)
    const agentIR = session.agentIR;
    if (agentIR?.flow) {
      const flowDefs = agentIR.flow.definitions ?? {};
      const hasAnyReasoning = Object.values(flowDefs).some((step) => step.reasoning_zone != null);

      if (!hasAnyReasoning) {
        // In scripted mode with no reasoning zones, check if there are respond steps
        const hasAnyRespond = Object.values(flowDefs).some((step) => step.respond != null);
        if (!hasAnyRespond) {
          findings.push({
            analyzer: this.name,
            severity: 'warning',
            code: 'EMPTY_RESPONSE_NO_REASONING',
            title: 'No reasoning zones or respond steps in flow',
            detail:
              'The agent flow has no reasoning zones and no respond steps. The agent cannot generate dynamic responses.',
            suggestion:
              'Add REASONING: true to at least one flow step, or add RESPOND: templates to provide static responses.',
            evidence: [
              {
                type: 'ir_node',
                label: 'Flow analysis',
                data: {
                  agentName: agentIR.metadata.name,
                  stepCount: agentIR.flow?.steps?.length ?? 0,
                  hasReasoning: false,
                  hasRespond: false,
                },
              },
            ],
          });
          return findings;
        }
      }
    }

    // If no LLM client and no specific cause found
    if (!session.llmClient && !llmWiringFailed) {
      findings.push({
        analyzer: this.name,
        severity: 'warning',
        code: 'EMPTY_RESPONSE_UNKNOWN',
        title: 'Possible empty response — no LLM client and no clear cause',
        detail:
          'The session has no LLM client but no explicit wiring failure was recorded. Responses may be empty for unknown reasons.',
        suggestion:
          'Re-run diagnostics at "deep" depth. Check if the session was recently created and LLM wiring is still pending.',
        evidence: [
          {
            type: 'execution',
            label: 'Session state',
            data: {
              sessionId,
              llmClientPresent: false,
              healthEntryCount: session.sessionHealth?.length ?? 0,
            },
          },
        ],
      });
    }

    return findings;
  }
}
