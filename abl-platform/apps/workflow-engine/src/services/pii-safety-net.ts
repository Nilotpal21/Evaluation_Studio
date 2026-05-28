/**
 * Workflow PII Safety Net (F-7 / ABLP-535)
 *
 * Lightweight PII presence scanner for workflow tool dispatch params.
 * Detection only — no redaction. Emits a structured trace event when
 * PII patterns are detected so compliance dashboards can flag
 * unprotected dispatches.
 *
 * DFA-L1: Emits `workflow_unprotected_pii_dispatched` as a structured
 * trace event shape (matching the trace-event-registry entry) alongside
 * the structured log warning. The workflow engine does not currently have
 * a real TraceStore sink — when one is wired, the `onTraceEvent` callback
 * can be swapped from the logger-backed implementation to the real store.
 *
 * DFA-M2: Extracted from index.ts to enable direct unit testing without
 * mocking the ToolExecutionClient closure.
 */
import { detectPII } from '@abl/compiler/platform/security';
import { createLogger } from '@abl/compiler/platform/logger.js';

const log = createLogger('workflow-pii-safety-net');

export interface PIISafetyNetInput {
  toolName: string;
  params: Record<string, unknown>;
  tenantId: string;
  projectId: string;
}

export interface PIISafetyNetResult {
  hasPII: boolean;
  piiTypesDetected: string[];
}

export type TraceEventSink = (event: { type: string; data: Record<string, unknown> }) => void;

/**
 * Scan tool dispatch params for PII and emit a structured trace event
 * if detected. Best-effort: never throws, never blocks tool dispatch.
 *
 * @returns The detection result, or `{ hasPII: false }` if scanning fails.
 */
export function scanToolParamsForPII(
  input: PIISafetyNetInput,
  onTraceEvent?: TraceEventSink,
): PIISafetyNetResult {
  try {
    const paramsText = JSON.stringify(input.params ?? {});
    const piiResult = detectPII(paramsText);

    if (piiResult.hasPII) {
      const piiTypesDetected = [...new Set(piiResult.detections.map((d) => d.type))];

      // DFA-L1: Emit as a structured trace event shape so compliance dashboards
      // consuming trace events (not just structured logs) can see the signal.
      // The event shape matches the trace-event-registry entry for
      // 'workflow_unprotected_pii_dispatched'.
      const traceEventData: Record<string, unknown> = {
        toolName: input.toolName,
        tenantId: input.tenantId,
        projectId: input.projectId,
        piiTypesDetected,
      };

      onTraceEvent?.({
        type: 'workflow_unprotected_pii_dispatched',
        data: traceEventData,
      });

      // Retain the structured log warning for operators and log aggregation.
      log.warn('workflow-unprotected-pii-dispatched', traceEventData);

      return { hasPII: true, piiTypesDetected };
    }

    return { hasPII: false, piiTypesDetected: [] };
  } catch (err) {
    // Detection is best-effort — never block tool dispatch
    log.warn('workflow-pii-scan-failed', {
      toolName: input.toolName,
      error: err instanceof Error ? err.message : String(err),
    });
    return { hasPII: false, piiTypesDetected: [] };
  }
}

/**
 * Create a logger-backed trace event sink for the workflow engine.
 *
 * Until the workflow engine wires a real TraceStore, this routes trace
 * events through structured logging so compliance dashboards that parse
 * structured logs can consume them. The shape mirrors what a real
 * TraceStore emitter would produce.
 */
export function createLoggerTraceEventSink(): TraceEventSink {
  return (event) => {
    log.info('workflow-trace-event', {
      eventType: event.type,
      ...event.data,
    });
  };
}
